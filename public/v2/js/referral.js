// Referral attribution (TASK-089). A visitor arriving via /join?ref=<code> keeps the code
// in this browser until they sign in, then it is claimed once for their account. The
// server only attributes accounts created in the last 7 days, once each, never to self.
import * as api from "./api.js";

const KEY = "jm_ref";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODE = /^[a-z0-9]{6,16}$/i;

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && CODE.test(raw.code) && Date.now() - raw.at < MAX_AGE_MS) return raw.code;
  } catch { /* storage blocked or corrupt */ }
  return null;
}

function forget() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Store ?ref= from the URL (if any) and tidy the address bar. Call once on load. */
export function captureReferralFromUrl() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("ref");
  if (code && CODE.test(code)) {
    try { localStorage.setItem(KEY, JSON.stringify({ code: code.toLowerCase(), at: Date.now() })); } catch { /* ignore */ }
  }
  if (code !== null || url.pathname === "/join") {
    url.searchParams.delete("ref");
    const path = url.pathname === "/join" ? "/" : url.pathname;
    history.replaceState(null, "", `${path}${url.search}${url.hash}`);
  }
}

/** After sign-in: claim a stored code for this account. Network errors keep it for next time. */
export async function claimPendingReferral(userId) {
  const code = read();
  if (!code || !userId) return;
  try {
    await api.claimReferral(userId, code);
    forget(); // recorded, already referred, too old or invalid: nothing more to do
  } catch (err) {
    if (err && err.status && err.status < 500) forget();
  }
}
