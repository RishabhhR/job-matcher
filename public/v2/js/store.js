// App state (TASK-054). Views get this as ctx.store.
// Rule (TASK-053): anything shown as "your data" renders from this store, which is
// filled from the API - never from whatever is typed into a form field.
import * as api from "./api.js";

const state = {
  user: null,        // { name, email, initials } from Clerk
  userId: null,      // internal DB id from /api/user/init
  profile: null,     // saved profile or null
  cvText: "",        // extracted CV text (private: never render by default)
  hasCv: false,
  companies: { greenhouse: [], lever: [], ashby: [] },
  digest: { enabled: true, hour: 9 },
  stats: null,       // /api/user/stats
  status: null,      // /api/status
};
const listeners = new Set();

export function get() {
  return state;
}

export function set(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

/** Subscribe to changes; returns an unsubscribe function (call it in a view's unmount). */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Load the account after sign-in. */
export async function loadAccount(clerkUser) {
  const name = clerkUser.fullName || clerkUser.firstName || "";
  const email = clerkUser.primaryEmailAddress ? clerkUser.primaryEmailAddress.emailAddress : "";
  const data = await api.initUser();
  set({
    user: { name, email },
    userId: data.userId,
    profile: data.profile || null,
    cvText: data.cvText || "",
    hasCv: Boolean(data.cvText && data.cvText.trim()),
    companies: data.companies || state.companies,
    digest: {
      enabled: data.digestSettings ? data.digestSettings.digestEnabled : true,
      hour: data.digestSettings ? data.digestSettings.digestHour : 9,
    },
  });
}

/** Refresh stats and status together (e.g. after a scan or an action). Failures leave old values. */
export async function refresh() {
  if (!state.userId) return;
  const [stats, status] = await Promise.allSettled([api.getStats(state.userId), api.getStatus(state.userId)]);
  set({
    stats: stats.status === "fulfilled" ? stats.value : state.stats,
    status: status.status === "fulfilled" ? status.value : state.status,
  });
}
