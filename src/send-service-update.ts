import "dotenv/config";
import { client, ensureMigrated, getActiveCvText, getUserProfileRow, getTopMatchesForUser } from "./db.js";
import { sendServiceUpdateEmail } from "./mailer.js";

async function main() {
  console.log("[send-service-update] Initializing service restoration broadcast...");
  await ensureMigrated();

  // Find registered users with clerk_id (filter by TARGET_EMAIL if set)
  const targetEmail = process.env.TARGET_EMAIL?.trim().toLowerCase();
  const usersRes = targetEmail
    ? await client.execute({
        sql: "SELECT id, email, name, timezone FROM jm_users WHERE clerk_id IS NOT NULL AND lower(email) = ?",
        args: [targetEmail],
      })
    : await client.execute(
        "SELECT id, email, name, timezone FROM jm_users WHERE clerk_id IS NOT NULL"
      );
  const users = usersRes.rows;
  console.log(`[send-service-update] Found ${users.length} target registered user(s).`);

  let successCount = 0;
  let errorCount = 0;

  for (const user of users) {
    const userId = user.id as string;
    const email = user.email as string;
    const name = (user.name as string) || "there";

    console.log(`\n[send-service-update] Processing user ${name} <${email}> (${userId.slice(-8)})...`);
    try {
      const cvText = await getActiveCvText(userId);
      const profile = await getUserProfileRow(userId);
      const hasProfile = Boolean(cvText && profile);

      let matches: any[] = [];
      if (hasProfile) {
        // Query top 10 scored matches for this user
        matches = await getTopMatchesForUser(userId, 10);
        // If all scored matches were previously emailed, grab the top 10 overall scored matches
        if (matches.length === 0) {
          const fallbackMatches = await client.execute({
            sql: `SELECT m.id AS match_id, m.emailed_at,
                         jp.title, jp.company_name, jp.location, jp.apply_url, jp.source,
                         m.fit_score, m.comp_fit_label, m.reasoning_text
                  FROM jm_user_job_matches m
                  JOIN jm_job_postings jp ON jp.id = m.job_posting_id
                  WHERE m.user_id = ? AND m.fit_score IS NOT NULL
                  ORDER BY m.fit_score DESC
                  LIMIT 10`,
            args: [userId],
          });
          matches = fallbackMatches.rows;
        }
      }

      console.log(`[send-service-update] Sending email (hasProfile: ${hasProfile}, matches: ${matches.length})...`);
      const messageId = await sendServiceUpdateEmail(email, name, matches, hasProfile);
      console.log(`[send-service-update] ✅ Email sent to ${email} (Message ID: ${messageId})`);
      successCount++;
    } catch (err) {
      errorCount++;
      console.error(`[send-service-update] ❌ Failed to send email to ${email}:`, err);
    }
  }

  console.log(`\n[send-service-update] Finished: ${successCount} sent, ${errorCount} failed.`);
  if (errorCount > 0 && successCount === 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[send-service-update] Fatal error:", err);
  process.exitCode = 1;
});
