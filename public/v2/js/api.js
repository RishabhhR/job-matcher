// API client (TASK-054). Views get this as ctx.api. Contract: README section 5 and
// the TASK-055 done note on the coordo ledger.
import { getToken } from "./auth.js";

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.status = status;
    this.data = data;
    this.code = (data && data.error) || "";
  }
}

function notifyQueueStatus(detail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("jobmatcher:queue-status", { detail }));
  }
}

async function authFetch(url, options = {}) {
  const { timeoutMs = 0, maxRetries = 2, ...fetchOptions } = options;
  const headers = { "Content-Type": "application/json", ...(fetchOptions.headers || {}) };

  let attempt = 0;
  while (true) {
    const controller = timeoutMs ? new AbortController() : null;
    let timer;
    const fetchRequest = getToken().then((token) => {
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(url, { ...fetchOptions, headers, ...(controller ? { signal: controller.signal } : {}) });
    });

    try {
      let res;
      if (timeoutMs) {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ApiError("Loading your account took too long. Check your connection and try again.", 408));
          }, timeoutMs);
        });
        res = await Promise.race([fetchRequest, timeout]);
      } else {
        res = await fetchRequest;
      }

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < maxRetries) {
        attempt++;
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const waitMs = (retryAfterSec && retryAfterSec > 0 && retryAfterSec <= 10)
          ? retryAfterSec * 1000
          : 1200 * attempt + Math.floor(Math.random() * 500);

        notifyQueueStatus({ active: true, waitMs, attempt, maxRetries });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (attempt > 0) {
        notifyQueueStatus({ active: false });
      }
      return res;
    } catch (err) {
      if (attempt > 0) notifyQueueStatus({ active: false });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function json(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    const message = (body && (body.message || body.error)) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body;
}

const post = (url, data, options = {}) => authFetch(url, { ...options, method: "POST", body: JSON.stringify(data) }).then(json);
const get = (url) => authFetch(url).then(json);

/** Create or load the signed-in account: { userId, profile, cvText, companies, digestSettings }. */
export const initUser = () => post("/api/user/init", { visitorId: window.JobMatcherAnalytics?.visitorId?.() || null }, { timeoutMs: 15000 });

/** Totals and per-tab counts: { totalScored, newSinceLastDigest, newCount, savedCount, appliedCount, dismissedCount, allCount, ... }. */
export const getStats = (userId) => get(`/api/user/stats?userId=${encodeURIComponent(userId)}`);

/** Header/rail data: { lastScanAt, lastScoredAt, lastDigestSentAt, nextDigestAt, digestEnabled, digestHour, timezone, sources[{source,count24h,healthy,statusText}] }. */
export const getStatus = (userId) => get(`/api/status?userId=${encodeURIComponent(userId)}`);

/**
 * One page of the feed.
 * @param {{userId:string, page?:number, limit?:number, filter?:'new'|'saved'|'applied'|'dismissed'|'all', sort?:'best'|'newest', minScore?:number, source?:string}} opts
 * @returns {Promise<{results: Array<{posting, matchId, status, userAction, emailedAt, fitScore, compFitLabel, reasoningText}>, total:number}>}
 */
export const getMatches = ({ userId, page = 1, limit = 10, filter = "new", sort = "best", minScore, source }) =>
  post("/api/match/page", { userId, page, limit, filter, sort, minScore, source });

/** Score a small background batch of pending candidates without blocking feed reads. */
export const hydrateMatches = (userId, limit = 4) =>
  post("/api/match/hydrate", { userId, limit }, { timeoutMs: 20000 });

/** Send a privacy-filtered product event; telemetry must never affect the user flow. */
export function trackEvent(event, properties = {}) {
  return post("/api/events", { event, properties }).catch(() => null);
}

/** Save / Applied / Not relevant. action = 'saved' | 'applied' | 'dismissed', or null to undo. */
export const setMatchAction = (userId, matchId, action) =>
  post(`/api/matches/${encodeURIComponent(matchId)}/action`, { userId, action });

/** Digest on/off and hour (0-23, the user's local time). */
export const saveDigestSettings = (userId, { enabled, hour }) =>
  post("/api/user/settings", { userId, digestEnabled: enabled, digestHour: hour });

/**
 * Save without running a scan (TASK-063): any of { cvText, profile, companies }.
 * profile is a partial patch merged over the saved one, e.g. { preferredCity: "Pune" };
 * "" or null clears an optional field. Resolves to { profile, companies, hasCv } as saved.
 * Use this for Profile and Settings; onboarding uses runScan so the first scan starts.
 */
/** Referral code and count for Settings (TASK-089): { code, referredCount }. */
export const getReferral = (userId) => get(`/api/referral?userId=${encodeURIComponent(userId)}`);

/** Claim a referral code for a newly created account; resolves to { result }. */
export const claimReferral = (userId, code) => post("/api/referral/claim", { userId, code });

export const saveProfile = (userId, { cvText, profile, companies } = {}) =>
  post("/api/user/profile", { userId, cvText, profile, companies });

/** Upload a CV file (PDF/DOCX/TXT). Resolves to { text } extracted by the server - it does NOT save; follow with saveProfile({ cvText }). */
export function uploadCv(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1];
      post("/api/upload-cv", { fileName: file.name, fileType: file.type, fileData: base64 }, { timeoutMs: 25000 }).then(resolve, reject);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Save profile/preferences and run a scan (POST /api/match, server-sent events).
 * payload: { cvText, profile:{targetDesignation, currentEmployer, currentTitle, currentSalaryFixedLPA,
 *   currentSalaryEsopLPA, currentSalaryCurrency, preferredCountry?, preferredCity?, careerStartDate?},
 *   companies:{greenhouse[], lever[], ashby[]}, linkedin:{location, maxResults}, digestEnabled, digestHour }
 * onEvent(type, data) receives every 'progress' event ({status, message}). Resolves with the 'done' data.
 */
export async function runScan(payload, onEvent = () => {}) {
  const res = await authFetch("/api/match", { method: "POST", body: JSON.stringify(payload) });
  if (!res.ok) await json(res); // throws ApiError with the server's message
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = null;
  while (true) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let type = "";
      let data = {};
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try { data = JSON.parse(line.slice(5).trim()); } catch { /* ignore malformed event */ }
        }
      }
      if (type === "error") throw new ApiError(data.message || "The scan failed.", 500);
      if (type === "done") done = data;
      onEvent(type, data);
    }
  }
  if (!done) throw new ApiError("The scan ended without results.", 500);
  return done;
}
