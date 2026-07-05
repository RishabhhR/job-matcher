import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { client, getActiveCvText, getUserProfileRow, upsertJobPosting, upsertUserMatch, getTopMatchesForUser } from "./db.js";
import { runJobMatcher } from "./runner.js";
import { sendDigestEmail } from "./mailer.js";
import { canonicalizeUrl } from "./normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

async function runHourlyCron() {
  console.log("[cron-hourly] Starting hourly cron execution...");
  
  // Get all users who have daily digests enabled
  const usersRes = await client.execute(
    "SELECT id, email, name, timezone, digest_hour FROM jm_users WHERE digest_enabled = 1"
  );
  
  const users = usersRes.rows;
  console.log(`[cron-hourly] Found ${users.length} users with daily digest enabled.`);

  const now = new Date();
  
  // Baseline companies list from local companies.json
  const companiesPath = path.join(dataDir, "companies.json");
  const companies = existsSync(companiesPath)
    ? JSON.parse(readFileSync(companiesPath, "utf-8"))
    : { greenhouse: [], lever: [], ashby: [] };

  for (const user of users) {
    const userId = user.id as string;
    const email = user.email as string;
    const name = user.name as string || "User";
    const timezone = user.timezone as string || "Asia/Kolkata";
    const digestHour = user.digest_hour as number;

    // Check if the current time matches the user's preferred hour in their local timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour")?.value;
    const localHour = hourPart ? parseInt(hourPart, 10) : 9;

    console.log(`[cron-hourly] User ${email}: local hour in ${timezone} is ${localHour} (preferred: ${digestHour}).`);

    if (localHour === digestHour) {
      console.log(`[cron-hourly] Time matches for user ${email}. Running match and send pipeline...`);
      try {
        const cvText = await getActiveCvText(userId);
        const dbProfile = await getUserProfileRow(userId);
        
        if (!cvText || !dbProfile) {
          console.warn(`[cron-hourly] User ${email} is missing CV or profile in database, skipping.`);
          continue;
        }

        const profile = { ...dbProfile, notifyEmail: email };

        // 1. Run Scraper & Scoring (up to 1000 LinkedIn results)
        console.log(`[cron-hourly] Scraping and scoring jobs for ${email}...`);
        const scored = await runJobMatcher({
          cvText,
          profile: profile as any,
          companies,
          linkedin: { maxResults: 1000 },
          onProgress: (status, message) => console.log(`[${email}][${status.toUpperCase()}] ${message}`),
          patient: true, // Allow waiting out rate limits
        });

        // 2. Save matches to the database
        console.log(`[cron-hourly] Saving matches for user ${email}...`);
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
          const slot = localHour < 12 ? "am" : "pm";
          console.log(`[cron-hourly] Sending email digest to ${email} with ${topMatches.length} matches...`);
          const messageId = await sendDigestEmail(email, topMatches as any, slot);
          console.log(`[cron-hourly] Email sent successfully to ${email} (messageId: ${messageId})`);
        } else {
          console.log(`[cron-hourly] No matches found for user ${email}, skipped email.`);
        }
      } catch (err) {
        console.error(`[cron-hourly] Pipeline failed for user ${email}:`, err);
      }
    }
  }

  console.log("[cron-hourly] Hourly cron execution complete.");
}

runHourlyCron().catch(console.error);
