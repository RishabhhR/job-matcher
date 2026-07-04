import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runJobMatcher } from "./runner.js";
import { type Profile } from "./match.js";
import { canonicalizeUrl } from "./normalize.js";
import {
  migrate,
  upsertUser,
  upsertUserProfile,
  upsertCv,
  upsertJobPosting,
  upsertUserMatch,
  getTopMatchesForUser,
  hasEmailBeenSent,
  logEmailSend,
  startScrapeRun,
  finishScrapeRun,
} from "./db.js";
import { sendDigestEmail } from "./mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

function resolveSlot(): "am" | "pm" {
  const explicit = process.env.DIGEST_SLOT;
  if (explicit === "am" || explicit === "pm") return explicit;
  // Fallback for local/manual runs: before noon UTC-relative-to-IST counts as "am".
  const istHour = new Date().getUTCHours() + 5.5;
  return istHour % 24 < 12 ? "am" : "pm";
}

export async function runDigest(options?: { slot?: "am" | "pm" }) {
  const slot = options?.slot || resolveSlot();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[digest] Running ${slot} digest for ${today}`);
  await migrate();

  const cvText = readFileSync(path.join(dataDir, "cv.txt"), "utf-8");
  const profile: Profile = JSON.parse(readFileSync(path.join(dataDir, "profile.json"), "utf-8"));
  const companies = JSON.parse(readFileSync(path.join(dataDir, "companies.json"), "utf-8"));

  if (!profile.notifyEmail) {
    throw new Error("profile.json is missing notifyEmail - nowhere to send the digest.");
  }

  const userId = await upsertUser(profile.notifyEmail, profile.currentTitle, "Asia/Kolkata");
  await upsertUserProfile(userId, profile);
  await upsertCv(userId, cvText);

  if (await hasEmailBeenSent(userId, today, slot)) {
    console.log(`[digest] Already sent ${slot} digest for ${today}, skipping.`);
    return { skipped: true, count: 0 };
  }

  const scrapeRunId = await startScrapeRun();
  let scored;
  try {
    scored = await runJobMatcher({
      cvText,
      profile,
      companies,
      linkedin: { location: "India", maxResults: 25 },
      onProgress: (status, message) => console.log(`[${status.toUpperCase()}] ${message}`),
    });
  } catch (err) {
    await finishScrapeRun(scrapeRunId, 0, 0, (err as Error).message);
    throw err;
  }

  let newCount = 0;
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
    newCount++;
  }
  await finishScrapeRun(scrapeRunId, scored.length, newCount);

  const topMatches = await getTopMatchesForUser(userId, 15);

  if (topMatches.length === 0) {
    console.log("[digest] No matches to send, skipping email.");
    await logEmailSend(userId, today, slot, "sent", "no-matches");
    return { skipped: false, count: 0, sent: false };
  }

  try {
    const messageId = await sendDigestEmail(profile.notifyEmail, topMatches as any, slot);
    await logEmailSend(userId, today, slot, "sent", messageId);
    console.log(`[digest] Sent ${slot} digest to ${profile.notifyEmail} (${topMatches.length} matches, message ${messageId})`);
    return { skipped: false, count: topMatches.length, sent: true, messageId };
  } catch (err) {
    await logEmailSend(userId, today, slot, "failed", undefined, (err as Error).message);
    throw err;
  }
}

// Detect if run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("digest.ts") || 
  process.argv[1].endsWith("digest.js")
);

if (isMain) {
  runDigest().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
