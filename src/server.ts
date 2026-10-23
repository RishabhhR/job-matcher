import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { runJobMatcher } from "./runner.js";
import { runDigest } from "./digest.js";
import { getVerifiedClerkIdentity } from "./clerkAuth.js";
import {
  ensureMigrated,
  upsertUser,
  upsertUserProfile,
  upsertCv,
  deletePendingMatches,
  bulkInsertPostingsAndPendingMatches,
  getPaginatedMatchesForUser,
  getTotalMatchCountForUser,
  updateUserDigestSettings,
  getUserDigestSettings,
  getUserClerkId,
  updateMatchScore,
  getActiveCvText,
  getUserProfileRow,
  getUserStats,
  getUserCompanies,
  upsertUserCompanies,
  setMatchUserAction,
  getUserStatus,
  getCronHeartbeat,
  getReferralSummary,
  claimReferral,
  saveUserProfileData,
  upsertScrapeSourceStatuses,
  recordDailyVisit,
  getDailyVisitorStats,
  type MatchFeedOptions,
  type MatchUserAction,
} from "./db.js";
import { fetchAshby, fetchGreenhouse, fetchLever } from "./scrapers.js";
import { fetchLinkedInPublic, fetchLinkedInDescriptions } from "./scrapers/linkedin.js";
import { fetchNaukri } from "./scrapers/naukri.js";
import { dedupePostings } from "./normalize.js";
import { keywordPrefilter, scoreAll, type ScoredMatch } from "./match.js";
import { nextDigestAt } from "./digestSchedule.js";
import { locationPatterns, primaryPlace, splitPlaces } from "./location.js";
import { captureTelemetryEvent, captureTelemetryError } from "./telemetry.js";
import { parseCvFile } from "./cvParser.js";

// scoreAll returns results SORTED BY SCORE and omits postings whose batch failed,
// so results must be matched back to their postings by object identity - never by
// array index (index matching wrote one job's score onto another, and crashed on
// undefined when a batch failed). A missing entry means "leave it pending".
function scoresByPosting(results: ScoredMatch[]): Map<unknown, ScoredMatch> {
  return new Map(results.map((r) => [r.posting, r]));
}

const FEED_FILTERS = new Set(["new", "saved", "applied", "dismissed", "all"]);
const FEED_SORTS = new Set(["best", "newest"]);
const MATCH_ACTIONS = new Set(["saved", "applied", "dismissed"]);

// Parses the optional v2 feed query fields, whitelisting every value.
function parseFeedOptions(body: any): MatchFeedOptions {
  const opts: MatchFeedOptions = {};
  if (FEED_FILTERS.has(body?.filter)) opts.filter = body.filter;
  if (FEED_SORTS.has(body?.sort)) opts.sort = body.sort;
  const minScore = Number(body?.minScore);
  if (body?.minScore !== undefined && Number.isFinite(minScore)) opts.minScore = Math.max(0, Math.min(100, minScore));
  if (typeof body?.source === "string" && /^[a-z]{2,20}$/.test(body.source)) opts.source = body.source;
  return opts;
}

import { attachVerifiedClerkUser } from "./clerkAuth.js";
import { parseCompanySources, parseProfilePatch } from "./inputValidation.js";

// Set DOMMatrix polyfill for pdf-parse (needed in Node environment)
if (typeof (global as any).DOMMatrix === "undefined") {
  (global as any).DOMMatrix = class DOMMatrix {};
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const publicDir = path.join(__dirname, "..", "public");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(attachVerifiedClerkUser);
app.use(express.static(publicDir));

// The PostHog project token is a public browser identifier, unlike an API key.
// Serving it from the configured environment keeps the static pages in sync with
// server-side telemetry without committing a project-specific token to Git.
app.get("/api/analytics-config", (_req, res) => {
  const token = process.env.POSTHOG_PROJECT_TOKEN || "";
  const configuredHost = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  const host = /^https:\/\/[a-z0-9.-]+\.posthog\.com$/i.test(configuredHost)
    ? configuredHost
    : "https://us.i.posthog.com";
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({ token: /^phc_[A-Za-z0-9]+$/.test(token) ? token : "", host });
});

// Narrow client-event endpoint. It accepts only a fixed event/property allowlist,
// uses a service-level distinct ID, and never stores user IDs, CV text, job text,
// email addresses, URLs, or request bodies in PostHog.
const CLIENT_EVENTS = new Set([
  "cv_upload_success", "cv_upload_error", "profile_save_success", "profile_save_error",
  "match_feed_load_success", "match_feed_load_error", "scan_started", "scan_completed",
  "scan_error", "match_action_success", "match_action_error",
]);
const CLIENT_EVENT_PROPERTIES = new Set([
  "file_type", "text_length", "duration_ms", "result_count", "status_code", "error_type", "action",
]);
app.post("/api/events", async (req, res) => {
  if (isProduction && !req.verifiedClerkUserId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const { event, properties } = req.body ?? {};
  if (typeof event !== "string" || !CLIENT_EVENTS.has(event) || !properties || typeof properties !== "object" || Array.isArray(properties)) {
    res.status(400).json({ error: "Unsupported event." });
    return;
  }
  const safeProperties: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!CLIENT_EVENT_PROPERTIES.has(key)) continue;
    if (key === "error_type") {
      safeProperties[key] = typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : "Error";
    } else if (key === "file_type" || key === "action") {
      if (typeof value === "string" && /^[A-Za-z0-9.+_-]{1,30}$/.test(value)) safeProperties[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safeProperties[key] = Math.max(0, Math.min(1_000_000, value));
    }
  }
  const propertiesForCapture = { ...safeProperties, surface: "web-v2" };
  if (event.endsWith("_error")) {
    const clientError = new Error("Client operation failed");
    clientError.name = String(safeProperties.error_type || "Error");
    await captureTelemetryError(event, clientError, propertiesForCapture);
  } else {
    await captureTelemetryEvent(event, propertiesForCapture);
  }
  res.status(204).end();
});

app.use("/api", async (_req, res, next) => {
  try {
    await ensureMigrated();
    next();
  } catch (error) {
    console.error("Database schema initialization failed:", error);
    res.status(503).json({ error: "Database is temporarily unavailable." });
  }
});

// Daily visitor tracking and analytics (TASK-087)
app.post("/api/analytics/visit", async (req, res) => {
  try {
    const rawPath = typeof req.body?.path === "string" ? req.body.path : "/";
    const cleanPath = rawPath.replace(/[^\w\-\/\#\.\?=&]/g, "").slice(0, 100) || "/";
    const rawReferrer = typeof req.body?.referrer === "string" ? req.body.referrer : null;
    const cleanReferrer = rawReferrer ? rawReferrer.slice(0, 200) : null;

    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" ? forwarded.split(",")[0] : req.socket.remoteAddress) || "127.0.0.1";
    const userAgent = req.headers["user-agent"] || "";

    // Privacy-preserving visitor hash (never stores IP address or raw User-Agent)
    const salt = process.env.COOKIE_SECRET || process.env.JWT_SECRET || "jm-visitor-salt";
    const visitorHash = createHash("sha256")
      .update(`${ip.trim()}:${userAgent.trim()}:${salt}`)
      .digest("hex")
      .slice(0, 32);

    const today = new Date().toISOString().slice(0, 10);
    await recordDailyVisit(today, visitorHash, cleanPath, cleanReferrer);
    res.status(204).end();
  } catch {
    // Visitor pings must never throw or disrupt page loads
    res.status(204).end();
  }
});

app.get("/api/analytics/daily-visitors", async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const stats = await getDailyVisitorStats(days);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ok: true, ...stats });
  } catch (error) {
    console.error("Failed to query visitor stats:", error);
    res.status(500).json({ error: "Failed to load visitor statistics." });
  }
});

const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

async function userOwnsAccount(req: express.Request, userId: string): Promise<boolean> {
  const ownerClerkId = await getUserClerkId(userId);
  if (isProduction) return Boolean(ownerClerkId && req.verifiedClerkUserId === ownerClerkId);
  return !ownerClerkId || req.verifiedClerkUserId === ownerClerkId;
}

// Initial data endpoint to prefill the UI forms
app.get("/api/initial-data", (req, res) => {
  try {
    const cvPath = path.join(dataDir, "cv.txt");
    const profilePath = path.join(dataDir, "profile.json");
    const companiesPath = path.join(dataDir, "companies.json");

    // Personal files are only used for local development. A production request
    // must never receive them, even if a CLI deployment accidentally includes them.
    const localPersonalFilesAllowed = !isProduction;
    const cvText = localPersonalFilesAllowed && existsSync(cvPath) ? readFileSync(cvPath, "utf-8") : "";
    const profile = localPersonalFilesAllowed && existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf-8")) : null;
    const companies = existsSync(companiesPath) ? JSON.parse(readFileSync(companiesPath, "utf-8")) : null;

    res.json({ cvText, profile, companies });
  } catch (error) {
    res.status(500).json({ error: "Failed to read initial config files: " + (error as Error).message });
  }
});

app.post("/api/user/init", async (req, res) => {
  if (!req.verifiedClerkUserId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    // Resolve the account email from Clerk's backend API. Never bind an account
    // to the caller-supplied email, which could point at another user's record.
    const identity = await getVerifiedClerkIdentity(req.verifiedClerkUserId);
    const userId = await upsertUser(identity.email, identity.name, identity.clerkId);
    // Independent reads - run together so the page waits for one DB round trip, not four.
    const [profile, cvText, digestSettings, savedCompanies] = await Promise.all([
      getUserProfileRow(userId),
      getActiveCvText(userId),
      getUserDigestSettings(userId),
      getUserCompanies(userId),
    ]);
    const companies = savedCompanies ?? JSON.parse(readFileSync(path.join(dataDir, "companies.json"), "utf-8"));

    res.json({
      success: true,
      userId,
      profile: profile || null,
      cvText: cvText || "",
      companies,
      digestSettings: digestSettings || { digestEnabled: true, digestHour: 9 }
    });
  } catch (error) {
    console.error("Error in /api/user/init:", error);
    res.status(500).json({ error: "Could not initialize the account." });
  }
});

app.get("/api/user/stats", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "Missing userId query parameter" });
    return;
  }

  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }

  try {
    const stats = await getUserStats(userId);
    res.json(stats);
  } catch (error) {
    console.error("Error in /api/user/stats:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Save / Applied / Not relevant on a match card. Idempotent: repeating the same
// action is a no-op success. `action: null` clears it (the "Undo" in DEC-007).
// Ownership is enforced twice: the session must own userId, and the UPDATE is
// scoped to that user_id so another user's match id changes nothing (-> 404).
app.post("/api/matches/:matchId/action", async (req, res) => {
  const { userId, action } = req.body ?? {};
  const { matchId } = req.params;
  if (!userId || !matchId) {
    res.status(400).json({ error: "Missing userId or matchId" });
    return;
  }
  if (action !== null && !MATCH_ACTIONS.has(action)) {
    res.status(400).json({ error: "action must be one of saved, applied, dismissed, or null" });
    return;
  }
  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }
  try {
    const changed = await setMatchUserAction(userId, matchId, action as MatchUserAction | null);
    if (!changed) {
      res.status(404).json({ error: "Match not found" });
      return;
    }
    res.json({ success: true, matchId, userAction: action });
  } catch (error) {
    console.error("Error in /api/matches/:matchId/action:", error);
    res.status(500).json({ error: "Could not update the match." });
  }
});

// Data for the Matches header and rail: last scan, per-source health with a
// readable reason, last digest and the next scheduled one. Deliberately no progress
// percentage - the backend has no live progress to report (DEC-007).
// Public cron watchdog (TASK-086), polled by an external monitor: 503 when the last
// successful cron run is older than CRON_STALE_MINUTES (default 150; runs are scheduled
// three times an hour). Exposes only timestamps and counts - no user data.
app.get("/api/health/cron", async (_req, res) => {
  try {
    const staleMinutes = Number(process.env.CRON_STALE_MINUTES) || 150;
    const beat = await getCronHeartbeat();
    const ageMinutes = beat ? Math.round((Date.now() - Date.parse(beat.lastSuccessAt)) / 60000) : null;
    const ok = ageMinutes !== null && ageMinutes <= staleMinutes;
    res.set("Cache-Control", "no-store");
    res.status(ok ? 200 : 503).json({ ok, lastSuccessAt: beat?.lastSuccessAt ?? null, ageMinutes, staleAfterMinutes: staleMinutes, lastRun: beat?.summary ?? null });
  } catch (error) {
    console.error("Error in /api/health/cron:", error);
    res.status(503).json({ ok: false, error: "Health check could not read the database." });
  }
});

// Referrals (TASK-089). The link carries a random code, never an account id; the
// frontend builds it as <origin>/join?ref=<code>. Rewards are not implemented yet.
app.get("/api/referral", async (req, res) => {
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  if (!userId) {
    res.status(400).json({ error: "Missing userId" });
    return;
  }
  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }
  try {
    res.json({ success: true, ...(await getReferralSummary(userId)) });
  } catch (error) {
    console.error("Error in /api/referral:", error);
    res.status(500).json({ error: "Could not load your referral link." });
  }
});

// Called once after sign-in when the visitor arrived through /join?ref=<code>.
app.post("/api/referral/claim", async (req, res) => {
  const { userId, code } = req.body ?? {};
  if (!userId || typeof code !== "string") {
    res.status(400).json({ error: "Missing userId or code" });
    return;
  }
  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }
  try {
    res.json({ success: true, result: await claimReferral(userId, code) });
  } catch (error) {
    console.error("Error in /api/referral/claim:", error);
    res.status(500).json({ error: "Could not record the referral." });
  }
});

app.get("/api/status", async (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) {
    res.status(400).json({ error: "Missing userId query parameter" });
    return;
  }
  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }
  try {
    const status = await getUserStatus(userId);
    res.json({
      ...status,
      nextDigestAt: status.digestEnabled && status.digestHour !== null ? nextDigestAt(status.digestHour, status.timezone) : null,
    });
  } catch (error) {
    console.error("Error in /api/status:", error);
    res.status(500).json({ error: "Could not load status." });
  }
});

app.post("/api/user/settings", async (req, res) => {
  const { userId, digestEnabled, digestHour } = req.body;
  if (!userId) {
    res.status(400).json({ error: "Missing userId" });
    return;
  }

  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }

  const parsedHour = Number(digestHour);
  if (typeof digestEnabled !== "boolean" || !Number.isInteger(parsedHour) || parsedHour < 0 || parsedHour > 23) {
    res.status(400).json({ error: "digestEnabled must be boolean and digestHour must be an integer from 0 to 23." });
    return;
  }

  try {
    await updateUserDigestSettings(userId, digestEnabled, parsedHour);
    res.json({ success: true, message: "Settings updated successfully." });
  } catch (error) {
    console.error("Error in /api/user/settings:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// Save CV / profile / companies WITHOUT running a scan (TASK-063). Used by the v2
// Profile and Settings pages; onboarding still goes through /api/match so the
// first scan runs. Every field is optional, but at least one must be present.
app.post("/api/user/profile", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "Missing userId" });
    return;
  }

  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }

  const update: Parameters<typeof saveUserProfileData>[1] = {};
  if (req.body.cvText !== undefined) {
    const cvText = req.body.cvText;
    if (typeof cvText !== "string" || !cvText.trim() || cvText.length > 250_000) {
      res.status(400).json({ error: "cvText must be non-empty text under 250,000 characters." });
      return;
    }
    update.cvText = cvText;
  }
  if (req.body.profile !== undefined) {
    const profile = parseProfilePatch(req.body.profile);
    if (!profile) {
      res.status(400).json({ error: "profile has an invalid field." });
      return;
    }
    update.profile = profile;
  }
  if (req.body.companies !== undefined) {
    const companies = parseCompanySources(req.body.companies);
    if (!companies) {
      res.status(400).json({ error: "companies must list greenhouse, lever and ashby board slugs." });
      return;
    }
    update.companies = companies;
  }
  if (!update.cvText && !update.profile && !update.companies) {
    res.status(400).json({ error: "Nothing to save: send cvText, profile or companies." });
    return;
  }

  try {
    const saved = await saveUserProfileData(userId, update);
    res.json({ success: true, ...saved });
  } catch (error) {
    console.error("Error in /api/user/profile:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// CV parsing endpoint to handle PDF, DOCX, and TXT files
app.post("/api/upload-cv", async (req, res) => {
  if (isProduction && !req.verifiedClerkUserId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const { fileName, fileType, fileData } = req.body ?? {};
    if (typeof fileData !== "string" || !fileData || typeof fileName !== "string") {
      res.status(400).json({ error: "Missing file data" });
      return;
    }
    if (fileData.length > 9_500_000) {
      res.status(413).json({ error: "That file is too large to parse. Please upload a file under 7 MB." });
      return;
    }
    const lowerFileName = fileName.toLowerCase();

    const buffer = Buffer.from(fileData, "base64");
    try {
      const { text, sourceType, method } = await parseCvFile(fileName, fileType || "", buffer);
      void captureTelemetryEvent("cv_parse_completed", {
        file_type: sourceType,
        parse_method: method,
        text_length: text.length,
      });
      res.json({ text });
    } catch (parseError: any) {
      if (parseError.message === "unsupported_file_type") {
        res.status(400).json({ error: "Unsupported file type. Please upload a PDF, DOCX, or TXT file." });
        return;
      }
      if (parseError.message === "insufficient_extracted_text") {
        await captureTelemetryError("cv_parse_quality", parseError, {
          file_type: lowerFileName.endsWith(".pdf") ? "pdf" : lowerFileName.endsWith(".docx") ? "docx" : "txt"
        });
        res.status(422).json({ error: "We couldn't read enough text from this file. Try a text-based PDF, DOCX, or paste your resume text." });
        return;
      }
      throw parseError;
    }
  } catch (error) {
    await captureTelemetryError("cv_parse", error, {
      file_type: typeof req.body?.fileName === "string" && req.body.fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "other"
    });
    res.status(500).json({ error: "We couldn't parse that file. Try a text-based PDF, DOCX, or paste your resume text." });
  }
});

// Cron endpoint to run the matcher periodically and email results
app.get("/api/cron-match", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (isProduction) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      res.status(503).json({ error: "CRON_SECRET is not configured." });
      return;
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  try {
    if (process.env.TURSO_DATABASE_URL) {
      console.log("[cron] TURSO_DATABASE_URL is defined. Running database-backed runDigest workflow...");
      const slotParam = req.query.slot as "am" | "pm" | undefined;
      const modeParam = req.query.mode as "scrape" | "email" | "all" | undefined;
      const result = await runDigest({
        slot: slotParam,
        mode: modeParam
      });
      res.json({ success: true, database: true, ...result });
      return;
    }

    const cvPath = path.join(dataDir, "cv.txt");
    const profilePath = path.join(dataDir, "profile.json");
    const companiesPath = path.join(dataDir, "companies.json");

    if (!existsSync(cvPath) || !existsSync(profilePath) || !existsSync(companiesPath)) {
      throw new Error("Configuration files (cv.txt, profile.json, companies.json) are missing from the data folder.");
    }

    const cvText = readFileSync(cvPath, "utf-8");
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));

    console.log("[cron] Starting job matching pipeline...");
    const logs: string[] = [];
    const onProgress = (status: string, message: string) => {
      logs.push(`[${status}] ${message}`);
      console.log(`[cron] ${status}: ${message}`);
    };

    const scoredMatches = await runJobMatcher({
      cvText,
      profile,
      companies,
      linkedin: {
        location: "India",
        maxResults: 1000
      },
      onProgress
    });

    console.log(`[cron] Matcher complete. Found ${scoredMatches.length} scored matches.`);

    // Generate HTML digest
    let htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
        <div style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); padding: 24px; border-radius: 8px 8px 0 0; color: #ffffff; text-align: center;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 700;">Job Match Digest</h1>
          <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">Ranked match openings for target title: <strong>${profile.targetDesignation}</strong></p>
        </div>
        <div style="padding: 24px; background: #fafafa; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    `;

    if (scoredMatches.length === 0) {
      htmlContent += `
        <div style="padding: 20px; text-align: center; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; color: #6b7280;">
          <p style="margin: 0; font-size: 16px;">No new matching jobs found in this run.</p>
        </div>
      `;
    } else {
      scoredMatches.forEach((match) => {
        const scoreColor = match.fitScore >= 80 ? "#10b981" : match.fitScore >= 60 ? "#f59e0b" : "#ef4444";
        const scoreBg = match.fitScore >= 80 ? "#ecfdf5" : match.fitScore >= 60 ? "#fffbeb" : "#fef2f2";
        const fitLabel = match.compFitLabel.toUpperCase();
        
        htmlContent += `
          <div style="margin-bottom: 20px; padding: 20px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
              <div style="flex: 1; padding-right: 12px;">
                <h3 style="margin: 0 0 4px 0; font-size: 18px; color: #111827; font-weight: 600;">${match.posting.title}</h3>
                <div style="font-size: 14px; color: #4b5563; font-weight: 500;">
                  ${match.posting.company} &bull; ${match.posting.location}
                </div>
              </div>
              <div style="background: ${scoreBg}; color: ${scoreColor}; padding: 6px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; text-align: center; min-width: 60px;">
                ${match.fitScore}% Fit
              </div>
            </div>
            <div style="margin-bottom: 12px; font-size: 13px;">
              <span style="background: #f3f4f6; color: #374151; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase;">
                Comp Fit: ${fitLabel}
              </span>
            </div>
            <p style="margin: 0 0 16px 0; font-size: 14px; color: #4b5563;">${match.reasoningText}</p>
            <a href="${match.posting.applyUrl}" target="_blank" style="display: inline-block; background: #7c3aed; color: #ffffff; padding: 8px 16px; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 14px; transition: background 0.2s;">
              Apply on ${match.posting.source}
            </a>
          </div>
        `;
      });
    }

    htmlContent += `
          <div style="margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #9ca3af; text-align: center;">
            <p style="margin: 0 0 4px 0;">This digest was compiled and sent to you automatically.</p>
            <p style="margin: 0;">Timezone: Asia/Kolkata (IST). Run frequency: Daily at 9:00 AM and 9:00 PM.</p>
          </div>
        </div>
      </div>
    `;

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Job Matcher <onboarding@resend.dev>",
          to: [profile.notifyEmail || process.env.DIGEST_USER_EMAIL || "admin@jobmatcher.dev"],
          subject: `Job Match Digest: ${scoredMatches.length} Matches Found`,
          html: htmlContent
        })
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error("[cron] Failed to send email via Resend API:", errText);
        logs.push(`[email_error] ${errText}`);
      } else {
        console.log("[cron] Digest email sent successfully via Resend API.");
        logs.push(`[email] Sent successfully to ${profile.notifyEmail || process.env.DIGEST_USER_EMAIL || "admin@jobmatcher.dev"}`);
      }
    } else {
      console.log("[cron] RESEND_API_KEY env is not configured, skipped email dispatch.");
      logs.push("[email_skipped] RESEND_API_KEY not configured");
    }

    res.json({ success: true, count: scoredMatches.length, logs });
  } catch (error) {
    console.error("[cron] Cron execution failure:", error);
    res.status(500).json({ error: (error as Error).message });
  }
});

// SSE endpoint to run the initial scraper and stream progress updates, returning the first page of matches
app.post("/api/match", async (req, res) => {
  const { cvText, profile, linkedin, naukri, digestEnabled, digestHour } = req.body;
  const companies = parseCompanySources(req.body.companies);

  if (typeof cvText !== "string" || cvText.length === 0 || cvText.length > 250_000 || !profile || !companies) {
    res.status(400).json({ error: "CV text, profile, or valid company sources are missing or invalid." });
    return;
  }

  if (isProduction && !req.verifiedClerkUserId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  let identity: { clerkId: string; email: string; name: string } | null = null;
  if (req.verifiedClerkUserId) {
    try {
      identity = await getVerifiedClerkIdentity(req.verifiedClerkUserId);
    } catch (error) {
      console.error("Could not resolve authenticated Clerk identity:", error);
      res.status(401).json({ error: "Could not verify the account email." });
      return;
    }
  } else if (req.body.clerkId) {
    res.status(401).json({ error: "A Clerk identity cannot be claimed without a verified session." });
    return;
  }

  if (digestEnabled !== undefined || digestHour !== undefined) {
    const hour = Number(digestHour);
    if (typeof digestEnabled !== "boolean" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      res.status(400).json({ error: "digestEnabled must be boolean and digestHour must be an integer from 0 to 23." });
      return;
    }
  }

  // Setup Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const sourceHealth: Record<string, { count: number; ok: boolean; error?: string }> = {};
  async function safeScrape<T>(source: string, fn: () => Promise<T[]>): Promise<T[]> {
    try {
      const rows = await fn();
      sourceHealth[source] = { count: rows.length, ok: true };
      return rows;
    } catch (error) {
      const message = (error as Error).message || String(error);
      sourceHealth[source] = { count: 0, ok: false, error: message };
      sendEvent("source_error", { source, message: `Source failed and was skipped: ${message}` });
      return [];
    }
  }

  try {
    const userEmail = identity?.email || "anonymous@jobmatcher.dev";
    const userName = identity?.name || "Anonymous User";
    
    sendEvent("progress", { status: "system", message: "Connecting to database..." });
    const userId = await upsertUser(userEmail, userName, identity?.clerkId);
    await upsertUserProfile(userId, profile);
    await upsertCv(userId, cvText);
    await upsertUserCompanies(userId, companies);

    // Save user digest settings
    if (digestEnabled !== undefined && digestHour !== undefined) {
      await updateUserDigestSettings(userId, digestEnabled, Number(digestHour));
    }

    // Filter ATS by location
    const patterns = locationPatterns(profile);

    const filterByLoc = (postings: any[]) => {
      if (!patterns) return postings;
      return postings.filter(p => {
        const loc = p.location || "";
        if (!loc) return true;
        return patterns.some(re => re.test(loc));
      });
    };

    const boardSources = [
      { source: "greenhouse", companies: companies.greenhouse, fetch: fetchGreenhouse },
      { source: "lever", companies: companies.lever, fetch: fetchLever },
      { source: "ashby", companies: companies.ashby, fetch: fetchAshby },
    ] as const;
    const atsPostings = (await Promise.all(boardSources.map(async ({ source, companies: boards, fetch }) => {
      sendEvent("progress", { status: `scraping_${source}`, message: `Scraping ${source} boards for ${boards.length} companies...` });
      const rows = await safeScrape(source, async () => {
        const settled = await Promise.allSettled(boards.map((company) => fetch(company)));
        const failed = settled.filter((result) => result.status === "rejected").length;
        if (failed > 0) sendEvent("source_warning", { source, message: `${failed}/${boards.length} company boards failed; successful boards are retained.` });
        if (boards.length > 0 && failed === boards.length) {
          throw new Error(`All ${source} company boards failed (${failed}/${boards.length}).`);
        }
        return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      });
      const filtered = filterByLoc(rows);
      sendEvent("progress", { status: `scraping_${source}_complete`, message: `Fetched ${rows.length} ${source} postings, ${filtered.length} matched location filter.` });
      return filtered;
    }))).flat();

    const linkedinKeywords = profile.targetDesignation;
    const defaultLinkedinLocation = [primaryPlace({ preferredCity: profile.preferredCity }), splitPlaces(profile.preferredCountry)[0]].filter(Boolean).join(", ") || "worldwide";
    const linkedinLocation = linkedin?.location || defaultLinkedinLocation;
    // Clamped to 100: this handler still runs the LinkedIn search/scrape step
    // synchronously (only per-job scoring got paginated), and Vercel's function
    // has a 60s hard cap (vercel.json) - a 1000-result search alone can exceed
    // that just from its own pagination delays, before any scoring even starts.
    const linkedinMaxResults = Math.min(linkedin?.maxResults || 100, 100);

    sendEvent("progress", { status: "scraping_linkedin", message: `Scraping LinkedIn for "${linkedinKeywords}" in ${linkedinLocation} (max ${linkedinMaxResults} results)...` });
    const linkedinPostingsRaw = await safeScrape("linkedin", () => fetchLinkedInPublic({
      keywords: linkedinKeywords,
      location: linkedinLocation,
      maxResults: linkedinMaxResults,
      fetchDescriptions: false,
    }));
    
    const linkedinPostings = filterByLoc(linkedinPostingsRaw);
    sendEvent("progress", { status: "scraping_linkedin_complete", message: `Fetched ${linkedinPostingsRaw.length} LinkedIn postings, ${linkedinPostings.length} matched location filter.` });

    const naukriInput = naukri && typeof naukri === "object" && !Array.isArray(naukri) ? naukri : {
      keyword: profile.targetDesignation,
      location: primaryPlace(profile) || "India",
      maxResultsPerQuery: 15,
    };
    sendEvent("progress", { status: "scraping_naukri", message: `Scraping Naukri for "${naukriInput.keyword}" (max ${naukriInput.maxResultsPerQuery} results)...` });
    const naukriRaw = await safeScrape("naukri", () => fetchNaukri(naukriInput));
    const naukriPostings = filterByLoc(naukriRaw);
    sendEvent("progress", { status: "scraping_naukri_complete", message: `Fetched ${naukriRaw.length} Naukri postings, ${naukriPostings.length} matched location filter.` });

    try {
    try {
      await upsertScrapeSourceStatuses(userId, Object.entries(sourceHealth).map(([source, health]) => ({
        source,
        count: health.count,
        ok: health.ok,
        errorCode: health.ok ? undefined : "SCRAPE_FAILED",
      })));
    } catch (error) {
      void captureTelemetryError("persist_scrape_health", error);
    }
    } catch (error) {
      void captureTelemetryError("persist_scrape_health", error);
      sendEvent("progress", { status: "source_warning", message: "Scrape health could not be saved; continuing with matching." });
    }
    for (const [source, health] of Object.entries(sourceHealth)) {
      void captureTelemetryEvent("scrape_source_result", { source, posting_count: health.count, success: health.ok });
    }
    void captureTelemetryEvent("scrape_completed", {
      source_count: Object.keys(sourceHealth).length,
      failed_source_count: Object.values(sourceHealth).filter((health) => !health.ok).length,
      raw_posting_count: atsPostings.length + linkedinPostings.length + naukriPostings.length,
    });
    sendEvent("progress", { status: "scrape_health", message: Object.entries(sourceHealth).map(([source, health]) => `${source}=${health.ok ? health.count : `ERR(${health.error?.slice(0, 60)})`}`).join(", ") });
    const rawPostings = [...atsPostings, ...linkedinPostings, ...naukriPostings];
    sendEvent("progress", { status: "processing", message: `Total raw postings collected: ${rawPostings.length}. Running deduplication...` });
    const deduped = dedupePostings(rawPostings);
    sendEvent("progress", { status: "processing", message: `Deduplication complete. Retained ${deduped.length} unique postings.` });
    const shortlisted = keywordPrefilter(deduped, profile.targetDesignation);

    sendEvent("progress", { status: "processing", message: `Filtered down to ${shortlisted.length} matching target designation "${profile.targetDesignation}". Saving to database...` });
    
    // Clear old pending matches and save new ones
    await deletePendingMatches(userId);
    await bulkInsertPostingsAndPendingMatches(userId, shortlisted);

    const totalMatches = await getTotalMatchCountForUser(userId);
    sendEvent("progress", { status: "processing", message: `Saved ${totalMatches} matching postings to database. Preparing Page 1...` });

    // Fetch and score Page 1 immediately (first 10 jobs)
    const page1Jobs = await getPaginatedMatchesForUser(userId, 0, 10);
    const pendingPage1 = page1Jobs.filter((j: any) => j.status === "pending");

    if (pendingPage1.length > 0) {
      // ATS postings already have full descriptions from the original scrape
      // (bulkInsertPostingsAndPendingMatches persisted them) - only LinkedIn
      // postings genuinely need fetching here, since fetchLinkedInPublic was
      // called with fetchDescriptions: false during the initial search. Blindly
      // re-fetching every posting (regardless of source) via a LinkedIn-only
      // HTML scraper wastes a full page load per job AND overwrites already-good
      // ATS descriptions with empty text (the CSS selector never matches on a
      // non-LinkedIn page).
      const postingsToFetch = pendingPage1.map((j: any) => ({
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        applyUrl: j.applyUrl,
        descriptionText: j.descriptionText || "",
      }));
      const linkedinNeedingFetch = postingsToFetch.filter((p: any) => p.source === "linkedin" && !p.descriptionText);

      if (linkedinNeedingFetch.length > 0) {
        sendEvent("progress", { status: "scraping_linkedin_descriptions", message: `Fetching descriptions for ${linkedinNeedingFetch.length} LinkedIn jobs on Page 1...` });
        await fetchLinkedInDescriptions(linkedinNeedingFetch, 0, 10);
      }

      sendEvent("progress", { status: "scoring", message: `Scoring ${pendingPage1.length} new jobs on Page 1 against CV via AI fallback chain...` });
      const { results: scoredResults } = await scoreAll(cvText, profile, postingsToFetch, postingsToFetch.length);
      const scoredByPosting = scoresByPosting(scoredResults);

      for (let i = 0; i < pendingPage1.length; i++) {
        const job = pendingPage1[i];
        const scored = scoredByPosting.get(postingsToFetch[i]);
        if (!scored) continue; // batch failed: stays pending, rescored on next load
        const description = postingsToFetch[i].descriptionText;
        await updateMatchScore(userId, job.posting_id, scored.fitScore, scored.compFitLabel, scored.reasoningText, description);
      }
    }

    // Query fully updated page 1 scored matches
    const finalPage1 = await getPaginatedMatchesForUser(userId, 0, 10);
    
    // Transform rows to ScoredMatch format
    const results = finalPage1.map((j: any) => ({
      posting: {
        id: j.posting_id,
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        postedAt: j.postedAt,
        scrapedAt: j.scrapedAt,
        descriptionText: j.descriptionText || "",
        sourceMetadata: j.sourceMetadata,
        applyUrl: j.applyUrl,
      },
      fitScore: j.fitScore,
      compFitLabel: j.compFitLabel,
      reasoningText: j.reasoningText,
    }));

    sendEvent("done", { userId, totalMatches, results });
  } catch (error) {
    console.error("Match error:", error);
    await captureTelemetryError("initial_match_scan", error);
    sendEvent("error", { message: "The scan couldn't finish. Please try again; your profile and saved matches are still available." });
  } finally {
    res.end();
  }
});

// Fetch and score a specific page of matches (dynamic/lazy descriptions & scores)
app.post("/api/match/page", async (req, res) => {
  const { userId, page, limit = 10 } = req.body;
  // Optional v2 feed fields (filter/sort/minScore/source); omitted = legacy behaviour.
  const feedOptions = parseFeedOptions(req.body);

  if (!userId || !page) {
    res.status(400).json({ error: "Missing required fields (userId or page)" });
    return;
  }

  // userId here is our internal DB id, not directly a Clerk id, so it can't be
  // checked the same way as /api/match's clerkId. Instead, confirm the caller's
  // verified session (if any) actually owns this userId - if the target account
  // has a clerk_id on file, a verified session is required and must match;
  // pre-Clerk/anonymous rows (clerk_id is null) stay accessible without a
  // session, matching current behavior.
  if (!(await userOwnsAccount(req, userId))) {
    res.status(401).json({ error: "Unauthorized: session token missing, invalid, or doesn't own this account" });
    return;
  }

  try {
    const offset = (page - 1) * limit;
    // Independent reads in one round trip (TASK-066). The v2 feed never returns
    // pending rows, so for it this is the whole request - no scoring, no re-query.
    const [cvText, profile, pageJobs, firstTotal] = await Promise.all([
      getActiveCvText(userId),
      getUserProfileRow(userId),
      getPaginatedMatchesForUser(userId, offset, limit, feedOptions),
      getTotalMatchCountForUser(userId, feedOptions),
    ]);

    if (!cvText) {
      res.status(409).json({ error: "cv_missing", message: "Active CV not found for this user." });
      return;
    }
    if (!profile) {
      res.status(409).json({ error: "profile_missing", message: "Active profile not found for this user." });
      return;
    }

    const pendingJobs = pageJobs.filter((j: any) => j.status === "pending");

    if (pendingJobs.length > 0) {
      // Same fix as /api/match's Page 1 handling: ATS postings already have full
      // descriptions from the original scrape, only LinkedIn postings need
      // fetching. Re-fetching every posting regardless of source wastes a full
      // page load per job and overwrites already-good ATS descriptions with
      // empty text (the LinkedIn-only CSS selector never matches elsewhere).
      const postingsToFetch = pendingJobs.map((j: any) => ({
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        applyUrl: j.applyUrl,
        descriptionText: j.descriptionText || "",
      }));
      const linkedinNeedingFetch = postingsToFetch.filter((p: any) => p.source === "linkedin" && !p.descriptionText);

      if (linkedinNeedingFetch.length > 0) {
        await fetchLinkedInDescriptions(linkedinNeedingFetch, 0, 10);
      }
      const { results: scoredResults } = await scoreAll(cvText, profile as any, postingsToFetch, postingsToFetch.length);
      const scoredByPosting = scoresByPosting(scoredResults);

      for (let i = 0; i < pendingJobs.length; i++) {
        const job = pendingJobs[i];
        const scored = scoredByPosting.get(postingsToFetch[i]);
        if (!scored) continue; // batch failed: stays pending, rescored on next load
        const description = postingsToFetch[i].descriptionText;
        await updateMatchScore(userId, job.posting_id, scored.fitScore, scored.compFitLabel, scored.reasoningText, description);
      }
    }

    // Re-query only if something was just scored (legacy UI path).
    const [finalPageJobs, total] = pendingJobs.length > 0
      ? await Promise.all([
          getPaginatedMatchesForUser(userId, offset, limit, feedOptions),
          getTotalMatchCountForUser(userId, feedOptions),
        ])
      : [pageJobs, firstTotal];
    const results = finalPageJobs.map((j: any) => ({
      posting: {
        id: j.posting_id,
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        postedAt: j.postedAt,
        scrapedAt: j.scrapedAt,
        descriptionText: j.descriptionText || "",
        sourceMetadata: j.sourceMetadata,
        applyUrl: j.applyUrl,
      },
      matchId: j.matchId,
      status: j.status,
      userAction: j.userAction ?? null,
      emailedAt: j.emailedAt ?? null,
      fitScore: j.fitScore,
      compFitLabel: j.compFitLabel,
      reasoningText: j.reasoningText,
    }));

    res.json({ success: true, results, total, page, limit });
    void captureTelemetryEvent("match_feed_loaded", { result_count: results.length, total_count: total });
  } catch (error) {
    console.error("Match page error:", error);
    await captureTelemetryError("match_feed_load", error, { page: Number.isInteger(page) ? Number(page) : 0 });
    res.status(500).json({ error: "We couldn't load your matches. Please try again." });
  }
});

// Capture failures that escape a route's local recovery path, including ownership
// lookups and auth middleware. Do not serialize backend diagnostics to the client.
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  void captureTelemetryError("http_unhandled", error, { method: req.method });
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "The request could not be completed. Please try again." });
});

// Unknown API paths are 404s, never the HTML page: a monitor polling a renamed or
// removed endpoint (e.g. /api/health/cron, TASK-086) must not read "200 OK".
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Catch-all route to serve the frontend
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

export default app;
