import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { client, ensureMigrated, repairSeniorityCaps, recordCronHeartbeat, getRecentlyScoredPostingHashes, getActiveCvText, getUserProfileRow, getUserCompanies, getTopMatchesForUser, markMatchesAsSent, markUserPostingsAsSent, claimEmailSend, logEmailSend } from "./db.js";
import { runJobMatcher } from "./runner.js";
import { saveScoredMatches } from "./saveMatches.js";
import { sendDigestEmail } from "./mailer.js";
import { canonicalizeUrl } from "./normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

async function runHourlyCron() {
  console.log("[cron-hourly] Starting hourly cron execution...");
  const pythonReviewRun = process.env.PYTHON_REVIEW_RUN === "true";
  if (pythonReviewRun) console.log("[cron-hourly] Manual Python scoring review mode enabled.");
  await ensureMigrated();
  await repairSeniorityCaps();

  // Get all users who have daily digests enabled
  const usersRes = await client.execute(
    "SELECT id, email, name, timezone, digest_hour FROM jm_users WHERE digest_enabled = 1 AND clerk_id IS NOT NULL"
  );
  
  const users = usersRes.rows;
  console.log(`[cron-hourly] Found ${users.length} users with daily digest enabled.`);

  const now = new Date();
  let totalDue = 0;
  let successfulSends = 0;
  let emptySends = 0;
  let sendFailures = 0;
  let scrapeSuccesses = 0;
  let scrapeFailures = 0;

  // Baseline companies list from local companies.json
  const companiesPath = path.join(dataDir, "companies.json");
  const companies = existsSync(companiesPath)
    ? JSON.parse(readFileSync(companiesPath, "utf-8"))
    : { greenhouse: [], lever: [], ashby: [] };

  const dueUsers: Array<{
    userId: string;
    userLogId: string;
    email: string;
    localHour: number;
    localDate: string;
    slot: string;
    cvText: string;
    profile: Awaited<ReturnType<typeof getUserProfileRow>>;
  }> = [];

  // Send from the most recently stored match set first. Scraping and LLM scoring
  // can take several minutes (or longer during provider rate limits), so doing
  // that work before sending made the user's configured delivery time depend on
  // the entire matching pipeline. All due users get their mail attempt before
  // any user's scrape starts.
  for (const user of users) {
    const userId = user.id as string;
    const userLogId = userId.slice(-8);
    const email = user.email as string;
    const timezone = user.timezone as string || "Asia/Kolkata";
    const digestHour = user.digest_hour as number;

    // Check the current time against the user's preferred hour in their local timezone.
    // Compute both the hour and the calendar date via the same timezone-aware formatter -
    // the previous code compared a local-timezone hour against a UTC calendar date, which
    // matters once catch-up logic (below) can fire anywhere from digestHour through
    // end-of-day rather than only in one exact hour.
    let parts: Intl.DateTimeFormatPart[];
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      });
      parts = formatter.formatToParts(now);
    } catch (error) {
      console.warn(`[cron-hourly] User ${userLogId} has an invalid timezone; skipping this run.`);
      continue;
    }
    const partValue = (type: string) => parts.find((p) => p.type === type)?.value;
    const localHour = partValue("hour") ? parseInt(partValue("hour")!, 10) : 9;
    const localDate = `${partValue("year")}-${partValue("month")}-${partValue("day")}`;

    console.log(`[cron-hourly] User ${userLogId}: local time in ${timezone} is ${localDate} hour ${localHour} (preferred: ${digestHour}).`);

    // Catch-up match: fire any time from the preferred hour through the rest of the user's
    // local day, not just an exact-hour match. GitHub Actions' schedule timing drifts
    // (observed gaps of 3-4+ hours between runs), so an exact match can skip a user's window
    // entirely for the whole day. The per-day dedup below still guarantees at most one send
    // per user per local day.
    if (pythonReviewRun || (localHour >= digestHour && digestHour >= 0 && digestHour <= 23)) {
      // Disabled/test accounts can have digests enabled without ever completing setup.
      // Check readiness before claiming the daily slot or attempting delivery so these
      // rows do not turn every hourly workflow into a failed run.
      let cvText: string | null;
      let dbProfile: Awaited<ReturnType<typeof getUserProfileRow>>;
      try {
        [cvText, dbProfile] = await Promise.all([
          getActiveCvText(userId),
          getUserProfileRow(userId),
        ]);
      } catch (err) {
        console.warn(`[cron-hourly] Could not load profile data for user ${userLogId}; skipping this run.`);
        continue;
      }
      if (!cvText || !dbProfile) {
        console.warn(`[cron-hourly] User ${userLogId} is missing a saved CV or profile; skipping digest and scrape.`);
        continue;
      }

      // The atomic database claim also protects manual reruns and future
      // scheduler changes from sending duplicate daily digests.
      // sendDate now uses the user's own local calendar date (see above) so the
      // catch-up window and the "already sent today" check agree on what "today" means.
      const sendDate = localDate;
      const slot = pythonReviewRun ? "python-review" : `hour-${digestHour}`;
      if (!(await claimEmailSend(userId, sendDate, slot))) {
        console.log(`[cron-hourly] Already attempted today's digest for user ${userLogId}, skipping.`);
        continue;
      }

      dueUsers.push({ userId, userLogId, email, localHour, localDate, slot, cvText, profile: dbProfile });
      if (pythonReviewRun) {
        console.log(`[cron-hourly] User ${userLogId} queued for scoring review email.`);
        continue;
      }
      try {
        console.log(`[cron-hourly] Time matches for user ${userLogId}. Sending from stored matches...`);
        const topMatches = await getTopMatchesForUser(userId, 15);
        if (topMatches.length > 0) {
          const displaySlot = localHour < 12 ? "am" : "pm";
          console.log(`[cron-hourly] Sending email digest to user ${userLogId} with ${topMatches.length} matches...`);
          const messageId = await sendDigestEmail(email, topMatches as any, displaySlot, `job-matcher/${userId}/${sendDate}/${slot}`);
          await logEmailSend(userId, sendDate, slot, "sent", messageId);
          // Stamp only after the sent record is persisted. If the database write
          // fails after Resend accepted the email, the same idempotency key makes
          // a retry safe and the matches remain eligible until the stamp succeeds.
          await markMatchesAsSent(topMatches.map((m: any) => m.match_id as string));
          console.log(`[cron-hourly] Email sent successfully to user ${userLogId} (messageId: ${messageId})`);
          successfulSends++;
        } else {
          console.log(`[cron-hourly] No matches found for user ${userLogId}, skipped email.`);
          await logEmailSend(userId, sendDate, slot, "empty", undefined, "No matches were available for this digest attempt.");
          emptySends++;
        }
      } catch (err) {
        sendFailures++;
        console.error(`[cron-hourly] Digest send failed for user ${userLogId}:`, err);
        // Failed attempts remain retryable on the next hourly tick. The
        // scraping phase still runs so fresh matches are ready for that retry.
        await logEmailSend(userId, sendDate, slot, "failed", undefined, (err as Error).message).catch(() => {});
      }
    }
  }

  // Refresh the match set only after all due users have had their send attempt.
  // A scrape failure is reported independently; it must not overwrite a digest
  // that was already sent successfully.
  for (const due of dueUsers) {
    try {
      const profile = { ...due.profile, notifyEmail: due.email };
      const userCompanies = await getUserCompanies(due.userId) ?? companies;
      console.log(`[cron-hourly] Scraping and scoring jobs for user ${due.userLogId}...`);
      const alreadyScored = pythonReviewRun ? new Set<string>() : await getRecentlyScoredPostingHashes(due.userId);
      const scored = await runJobMatcher({
        userId: due.userId,
        cvText: due.cvText,
        profile: profile as any,
        companies: userCompanies,
        linkedin: { maxResults: 100 },
        onProgress: (status, message) => console.log(`[${due.userLogId}][${status.toUpperCase()}] ${message}`),
        patient: true,
        alreadyScored,
      });

      console.log(`[cron-hourly] Saving matches for user ${due.userLogId}...`);
      await saveScoredMatches(due.userId, scored);
      scrapeSuccesses++;
      if (pythonReviewRun) {
        const reviewMatches = scored.slice(0, 15).map((match) => ({
          title: match.posting.title,
          company_name: match.posting.company,
          location: match.posting.location,
          apply_url: match.posting.applyUrl,
          source: match.posting.source,
          fit_score: match.fitScore,
          comp_fit_label: match.compFitLabel,
          reasoning_text: match.reasoningText,
        }));
        const pythonCount = reviewMatches.filter((match) => match.reasoning_text.startsWith("Rule-based match;")).length;
        console.log(`[cron-hourly] Scoring review for user ${due.userLogId}: ${scored.length} total scores, ${pythonCount} Python-only scores, ${scored.length - pythonCount} LLM-reviewed scores.`);
        if (reviewMatches.length === 0) {
          await logEmailSend(due.userId, due.localDate, due.slot, "empty", undefined, "No current scored jobs were available for the Python scoring review.");
          emptySends++;
          continue;
        }
        const displaySlot = due.localHour < 12 ? "am" : "pm";
        const messageId = await sendDigestEmail(
          due.email,
          reviewMatches,
          displaySlot,
          `job-matcher/${due.userId}/${due.localDate}/python-review`,
        );
        await logEmailSend(due.userId, due.localDate, due.slot, "sent", messageId);
        await markUserPostingsAsSent(due.userId, reviewMatches.map((match) => canonicalizeUrl(match.apply_url)));
        console.log(`[cron-hourly] Python scoring review email sent to user ${due.userLogId} (messageId: ${messageId}).`);
        successfulSends++;
      }
    } catch (err) {
      scrapeFailures++;
      console.error(`[cron-hourly] ${pythonReviewRun ? "Scoring review" : "Post-digest scrape"} failed for user ${due.userLogId}:`, err);
      if (pythonReviewRun) {
        sendFailures++;
        await logEmailSend(due.userId, due.localDate, due.slot, "failed", undefined, (err as Error).message).catch(() => {});
      }
    }
  }

  console.log(
    `[cron-hourly] Hourly cron execution complete. Due: ${dueUsers.length}, Sent: ${successfulSends}, Empty: ${emptySends}, Send failures: ${sendFailures}, Scrape successes: ${scrapeSuccesses}, Scrape failures: ${scrapeFailures}.`
  );

  // If every due user failed sending, treat it as a systemic failure (e.g. SMTP down).
  // Otherwise, individual recipient/board errors are recorded in the DB send log and do not abort the workflow.
  if (dueUsers.length > 0 && successfulSends === 0 && emptySends === 0 && sendFailures === dueUsers.length) {
    throw new Error(`All ${sendFailures} due user digest send(s) failed.`);
  }

  // Heartbeat for GET /api/health/cron (TASK-086): an external monitor alerts when this
  // goes stale, whatever stopped the runs (scheduler disabled, token expired, crash).
  await recordCronHeartbeat({ due: dueUsers.length, sent: successfulSends, empty: emptySends, sendFailures, scrapeSuccesses, scrapeFailures });
}

runHourlyCron().catch((error) => {
  console.error("[cron-hourly] Fatal run failure:", error);
  process.exitCode = 1;
});
