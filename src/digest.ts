import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
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
  getUserByEmail,
  getActiveCvText,
  getUserProfileRow,
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

function resolveMode(): "scrape" | "email" | "all" {
  const explicit = process.env.DIGEST_MODE;
  if (explicit === "scrape" || explicit === "email" || explicit === "all") return explicit;
  return "all";
}

export async function runDigest(options?: { slot?: "am" | "pm"; mode?: "scrape" | "email" | "all" }) {
  const slot = options?.slot || resolveSlot();
  const mode = options?.mode || resolveMode();
  const today = new Date().toISOString().slice(0, 10);

  console.log(`[digest] Running ${slot} digest for ${today} in mode: ${mode}`);
  await migrate();

  const cvPath = path.join(dataDir, "cv.txt");
  const profilePath = path.join(dataDir, "profile.json");
  const companies = JSON.parse(readFileSync(path.join(dataDir, "companies.json"), "utf-8"));

  let cvText: string;
  let profile: Profile;
  let userId: string;

  if (existsSync(cvPath) && existsSync(profilePath)) {
    // Local dev, or CI where GitHub secrets were reconstructed into data/ before this ran.
    cvText = readFileSync(cvPath, "utf-8");
    profile = JSON.parse(readFileSync(profilePath, "utf-8"));

    if (!profile.notifyEmail) {
      throw new Error("profile.json is missing notifyEmail - nowhere to send the digest.");
    }

    userId = await upsertUser(profile.notifyEmail, profile.currentTitle, "Asia/Kolkata");
    await upsertUserProfile(userId, profile);
    await upsertCv(userId, cvText);
  } else {
    // No local data files (e.g. Vercel, which never has the gitignored data/ files) -
    // read everything already-seeded from a previous local/CI run instead.
    const email = process.env.DIGEST_USER_EMAIL;
    if (!email) {
      throw new Error(
        "No local data/cv.txt + profile.json, and DIGEST_USER_EMAIL is not set - can't resolve which user to run the digest for."
      );
    }
    const userRow = await getUserByEmail(email);
    if (!userRow) throw new Error(`No jm_users row for DIGEST_USER_EMAIL=${email}. Run the digest locally/via CI once first to seed it.`);

    const dbProfile = await getUserProfileRow(userRow.id);
    const dbCvText = await getActiveCvText(userRow.id);
    if (!dbProfile || !dbCvText) {
      throw new Error(`User ${email} exists but has no profile/CV persisted yet - run the digest locally/via CI once first.`);
    }

    userId = userRow.id;
    cvText = dbCvText;
    profile = { ...dbProfile, notifyEmail: userRow.email };
  }

  const notifyEmail = profile.notifyEmail as string;

  if (await hasEmailBeenSent(userId, today, slot)) {
    console.log(`[digest] Already sent ${slot} digest for ${today}, skipping.`);
    return { skipped: true, count: 0 };
  }

  let scoredCount = 0;
  if (mode === "all" || mode === "scrape") {
    const scrapeRunId = await startScrapeRun();
    let scored;
    try {
      scored = await runJobMatcher({
        cvText,
        profile,
        companies,
        linkedin: { location: "Bengaluru, India", maxResults: 25 },
        onProgress: (status, message) => console.log(`[${status.toUpperCase()}] ${message}`),
        // Scheduled scrape runs have a full hour before the separate email cron
        // fires, so it's worth patiently riding out rate limits (see match.ts's
        // PATIENT_RETRY) instead of giving up after a few quick retries.
        patient: mode === "scrape",
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
    scoredCount = scored.length;
  }

  if (mode === "scrape") {
    return { success: true, mode, count: scoredCount };
  }

  const topMatches = await getTopMatchesForUser(userId, 15);

  if (topMatches.length === 0) {
    console.log("[digest] No matches to send, skipping email.");
    await logEmailSend(userId, today, slot, "sent", "no-matches");
    return { skipped: false, count: 0, sent: false };
  }

  try {
    const messageId = await sendDigestEmail(notifyEmail, topMatches as any, slot);
    await logEmailSend(userId, today, slot, "sent", messageId);
    console.log(`[digest] Sent ${slot} digest to ${notifyEmail} (${topMatches.length} matches, message ${messageId})`);
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
