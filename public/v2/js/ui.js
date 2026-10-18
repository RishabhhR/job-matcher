// Shared UI + accessibility helpers (TASK-054). Views get these as ctx.ui.

/** Escape untrusted text (job titles, company names, CV text) before using it in HTML. */
export function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Markup produced by html``. Extends String so it works anywhere a string does (innerHTML, +, `${}`). */
class SafeHTML extends String {}

function interpolate(value) {
  if (value instanceof SafeHTML) return String(value);
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHTML(value);
}

/**
 * Tagged template that escapes every interpolated value: html`<p>${title}</p>`.
 * Nested html`` results and arrays of them are inserted as markup, so compose with
 *   html`<ul>${items.map((x) => html`<li>${x}</li>`)}</ul>`   (pass the array - don't .join() it,
 * a joined plain string is treated as text and escaped).
 */
export function html(strings, ...values) {
  return new SafeHTML(strings.reduce((out, str, i) => out + str + (i < values.length ? interpolate(values[i]) : ""), ""));
}

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const pick = parts.length === 1 ? parts[0][0] : parts[0][0] + parts[parts.length - 1][0];
  return pick.toUpperCase();
}

/** Mask an email for display: "rishabh@x.com" -> "ris•••@x.com". */
export function maskEmail(email) {
  return String(email || "").replace(/^(.{3}).*(@.*)$/, "$1•••$2");
}

/** Polite screen-reader announcement (route changes, scan progress, action results). */
export function announce(message) {
  const live = document.getElementById("live");
  if (!live) return;
  live.textContent = "";
  // Re-set after a tick so repeating the same message is still announced
  // (setTimeout, not rAF: rAF never fires in background tabs).
  setTimeout(() => { live.textContent = message; }, 50);
}

/**
 * Show a toast. Use for action feedback, e.g. the "Not relevant" Undo (DEC-007):
 *   toast({ message: "Hidden", actionLabel: "Undo", onAction: () => ... })
 * Also announces the message. Returns a function that dismisses the toast early.
 */
export function toast({ message, actionLabel, onAction, timeoutMs = 6000, tone = "default" }) {
  const host = document.getElementById("toasts");
  if (!host) return () => {};
  const el = document.createElement("div");
  el.className = tone === "error" ? "toast toast-error" : "toast";
  el.setAttribute("role", tone === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  let timer;
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { dismiss(); onAction(); });
    el.appendChild(btn);
  }
  host.appendChild(el);
  if (tone !== "error") announce(message);
  timer = setTimeout(dismiss, timeoutMs);
  return dismiss;
}

/** Relative time for timestamps from the API ("2026-10-18 06:22:22" is UTC). */
export function timeAgo(value, now = Date.now()) {
  if (!value) return "";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1 day ago" : `${day} days ago`;
}

/** Local clock time for an ISO timestamp, e.g. "9:00 PM". */
export function clockTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Standard empty/error state block. Views may use it or render their own. */
export function emptyState({ title, body = "", actionLabel, onAction }) {
  const wrap = document.createElement("div");
  wrap.className = "card empty-state";
  wrap.innerHTML = html`<h2 class="section-title">${title}</h2><p class="text-2">${body}</p>`;
  if (actionLabel && onAction) {
    const actions = document.createElement("div");
    actions.className = "actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary";
    btn.textContent = actionLabel;
    btn.addEventListener("click", onAction);
    actions.appendChild(btn);
    wrap.appendChild(actions);
  }
  return wrap;
}
