// API client (TASK-054). Views get this as ctx.api. Contract: README section 5 and
// the TASK-055 done note on the coordo ledger.
import { getToken } from "./auth.js";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function authFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

async function json(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) throw new ApiError((body && body.error) || `Request failed (${res.status})`, res.status);
  return body;
}

const post = (url, data) => authFetch(url, { method: "POST", body: JSON.stringify(data) }).then(json);
const get = (url) => authFetch(url).then(json);

/** Create or load the signed-in account: { userId, profile, cvText, companies, digestSettings }. */
export const initUser = () => post("/api/user/init", {});

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

/** Save / Applied / Not relevant. action = 'saved' | 'applied' | 'dismissed', or null to undo. */
export const setMatchAction = (userId, matchId, action) =>
  post(`/api/matches/${encodeURIComponent(matchId)}/action`, { userId, action });

/** Digest on/off and hour (0-23, the user's local time). */
export const saveDigestSettings = (userId, { enabled, hour }) =>
  post("/api/user/settings", { userId, digestEnabled: enabled, digestHour: hour });

/** Upload a CV file (PDF/DOCX/TXT). Resolves to { text } extracted by the server. */
export function uploadCv(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1];
      post("/api/upload-cv", { fileName: file.name, fileType: file.type, fileData: base64 }).then(resolve, reject);
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
