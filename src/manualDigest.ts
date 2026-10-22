// Manual digest for one user (TASK-083): scrape + score first, then email the top
// matches. The hourly cron emails stored matches before it scrapes, so a brand-new
// user's first email would otherwise only arrive the next day.
//
// Usage: MANUAL_USER_ID=<jm_users.id or a unique prefix> npm run manual-digest
// Takes an id, never an email address: workflow inputs are visible in this public repo.
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  client, ensureMigrated, getActiveCvText, getUserProfileRow, getUserCompanies, getRecentlyScoredPostingHashes,
  getTopMatchesForUser, claimEmailSend, logEmailSend, markMatchesAsSent,
} from "./db.js";
import { runJobMatcher } from "./runner.js";
import { saveScoredMatches } from "./saveMatches.js";
import { sendDigestEmail } from "./mailer.js";

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

async function main() {
  const idArg = (process.env.MANUAL_USER_ID || "").trim();
  if (!/^[0-9a-f-]{8,36}$/i.test(idArg)) throw new Error("Set MANUAL_USER_ID to a jm_users.id (or a unique prefix of at least 8 characters).");
  await ensureMigrated();

  const found = await client.execute({ sql: "SELECT id, email, timezone FROM jm_users WHERE id LIKE ?", args: [`${idArg}%`] });
  if (found.rows.length !== 1) throw new Error(`Expected exactly one user for id ${idArg}, found ${found.rows.length}.`);
  const userId = String(found.rows[0].id);
  const email = String(found.rows[0].email);
  const timezone = String(found.rows[0].timezone || "Asia/Kolkata");
  const logId = userId.slice(0, 8);

  const [cvText, profile, savedCompanies, alreadyScored] = await Promise.all([
    getActiveCvText(userId), getUserProfileRow(userId), getUserCompanies(userId), getRecentlyScoredPostingHashes(userId),
  ]);
  if (!cvText || !cvText.trim()) throw new Error(`User ${logId} has no CV saved - matching needs one. Ask them to upload or paste it first.`);
  if (!profile) throw new Error(`User ${logId} has no profile saved.`);
  const companiesPath = path.join(dataDir, "companies.json");
  const companies = savedCompanies ?? (existsSync(companiesPath) ? JSON.parse(readFileSync(companiesPath, "utf-8")) : { greenhouse: [], lever: [], ashby: [] });

  console.log(`[manual-digest] Scraping and scoring for user ${logId}...`);
  const scored = await runJobMatcher({
    userId, cvText, profile: profile as any, companies, linkedin: { maxResults: 100 }, patient: true, alreadyScored,
    onProgress: (status, message) => console.log(`[${logId}][${status.toUpperCase()}] ${message}`),
  });
  await saveScoredMatches(userId, scored);
  console.log(`[manual-digest] Saved ${scored.length} newly scored matches.`);

  const topMatches = await getTopMatchesForUser(userId, 15);
  if (topMatches.length === 0) {
    console.log(`[manual-digest] No matches to send for user ${logId}.`);
    return;
  }
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const slot = "manual";
  if (!(await claimEmailSend(userId, localDate, slot))) {
    console.log(`[manual-digest] A manual digest was already sent to user ${logId} today (${localDate}); not sending again.`);
    return;
  }
  try {
    const messageId = await sendDigestEmail(email, topMatches as any, localHour < 12 ? "am" : "pm", `job-matcher/${userId}/${localDate}/${slot}`);
    await logEmailSend(userId, localDate, slot, "sent", messageId);
    await markMatchesAsSent(topMatches.map((m: any) => m.match_id as string));
    console.log(`[manual-digest] Emailed ${topMatches.length} matches to user ${logId}.`);
  } catch (err) {
    await logEmailSend(userId, localDate, slot, "failed", undefined, (err as Error).message).catch(() => {});
    throw err;
  }
}

main()
  .catch((error) => {
    console.error("[manual-digest] Failed:", (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => client.close());
