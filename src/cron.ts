import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { client, ensureMigrated, getActiveCvText, getUserProfileRow, getUserCompanies, upsertJobPosting, upsertUserMatch, getTopMatchesForUser, markMatchesAsSent, claimEmailSend, logEmailSend } from "./db.js";
import { runJobMatcher } from "./runner.js";
import { sendDigestEmail } from "./mailer.js";
import { canonicalizeUrl } from "./normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

async function runHourlyCron() {
  console.log("[cron-hourly] Starting hourly cron execution...");
  await ensureMigrated();
  
  // Get all users who have daily digests enabled
  const usersRes = await client.execute(
    "SELECT id, email, name, timezone, digest_hour FROM jm_users WHERE digest_enabled = 1"
  );
  
  const users = usersRes.rows;
  console.log(`[cron-hourly] Found ${users.length} users with daily digest enabled.`);

  const now = new Date();
  let failureCount = 0;
  
  // Baseline companies list from local companies.json
  const companiesPath = path.join(dataDir, "companies.json");
  const companies = existsSync(companiesPath)
    ? JSON.parse(readFileSync(companiesPath, "utf-8"))
    : { greenhouse: [], lever: [], ashby: [] };

  for (const user of users) {
    const userId = user.id as string;
    const userLogId = userId.slice(-8);
    const email = user.email as string;
    const name = user.name as string || "User";
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
      failureCount++;
      console.error(`[cron-hourly] User ${userLogId} has an invalid timezone; skipping this run.`);
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
    if (localHour >= digestHour && digestHour >= 0 && digestHour <= 23) {
      // The atomic database claim also protects manual reruns and future
      // scheduler changes from sending duplicate daily digests.
      // sendDate now uses the user's own local calendar date (see above) so the
      // catch-up window and the "already sent today" check agree on what "today" means.
      const sendDate = localDate;
      const slot = `hour-${digestHour}`;
      if (!(await claimEmailSend(userId, sendDate, slot))) {
        console.log(`[cron-hourly] Already attempted today's digest for user ${userLogId}, skipping.`);
        continue;
      }

      console.log(`[cron-hourly] Time matches for user ${userLogId}. Running match and send pipeline...`);
      try {
        const cvText = await getActiveCvText(userId);
        const dbProfile = await getUserProfileRow(userId);
        
        if (!cvText || !dbProfile) {
          console.warn(`[cron-hourly] User ${userLogId} is missing CV or profile in database, skipping.`);
          await logEmailSend(userId, sendDate, slot, "blocked", undefined, "Missing CV or profile.");
          continue;
        }

        const profile = { ...dbProfile, notifyEmail: email };
        const userCompanies = await getUserCompanies(userId) ?? companies;

        // 1. Run Scraper & Scoring (up to 1000 LinkedIn results)
        console.log(`[cron-hourly] Scraping and scoring jobs for user ${userLogId}...`);
        const scored = await runJobMatcher({
          cvText,
          profile: profile as any,
          companies: userCompanies,
          linkedin: { maxResults: 1000 },
          onProgress: (status, message) => console.log(`[${userLogId}][${status.toUpperCase()}] ${message}`),
          patient: true, // Allow waiting out rate limits
        });

        // 2. Save matches to the database
        console.log(`[cron-hourly] Saving matches for user ${userLogId}...`);
        for (const match of scored) {
          const dedupHash = canonicalizeUrl(match.posting.applyUrl);
          const jobPostingId = await upsertJobPosting({
            source: match.posting.source,
            sourceJobId: match.posting.sourceJobId,
            company: match.posting.company,
            title: match.posting.title,
            location: match.posting.location,
            applyUrl: match.posting.applyUrl,
            descriptionText: match.posting.descriptionText,
            dedupHash,
          });
          await upsertUserMatch(userId, jobPostingId, match.fitScore, match.compFitLabel, match.reasoningText);
        }

        // 3. Fetch top matches and send email
        const topMatches = await getTopMatchesForUser(userId, 15);
        if (topMatches.length > 0) {
          const displaySlot = localHour < 12 ? "am" : "pm";
          console.log(`[cron-hourly] Sending email digest to user ${userLogId} with ${topMatches.length} matches...`);
          const messageId = await sendDigestEmail(email, topMatches as any, displaySlot, `job-matcher/${userId}/${sendDate}/${slot}`);
          await logEmailSend(userId, sendDate, slot, "sent", messageId);
          // Mark these matches sent so they backfill (not lead) the next digest.
          await markMatchesAsSent(topMatches.map((m: any) => m.match_id as string));
          console.log(`[cron-hourly] Email sent successfully to user ${userLogId} (messageId: ${messageId})`);
        } else {
          console.log(`[cron-hourly] No matches found for user ${userLogId}, skipped email.`);
          await logEmailSend(userId, sendDate, slot, "empty", undefined, "No matches were available for this digest attempt.");
        }
      } catch (err) {
        failureCount++;
        console.error(`[cron-hourly] Pipeline failed for user ${userLogId}:`, err);
        // Failed attempts remain retryable on the next hourly tick.
        await logEmailSend(userId, sendDate, slot, "failed", undefined, (err as Error).message).catch(() => {});
      }
    }
  }

  console.log("[cron-hourly] Hourly cron execution complete.");
  if (failureCount > 0) throw new Error(`${failureCount} user digest pipeline(s) failed.`);
}

runHourlyCron().catch((error) => {
  console.error("[cron-hourly] Fatal run failure:", error);
  process.exitCode = 1;
});
