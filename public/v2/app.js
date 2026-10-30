// JobMatcher v2 entry (TASK-054): sign-in -> load account -> router.
import { initAuth, mountSignIn, signOut } from "./js/auth.js";
import * as store from "./js/store.js";
import { startRouter } from "./js/router.js";
import { initials, maskEmail, emptyState } from "./js/ui.js";
import { initLanding, showLandingStatus, hideLanding } from "./views/landing.js";
import { captureReferralFromUrl, claimPendingReferral } from "./js/referral.js";

const boot = document.getElementById("boot");
const bootMessage = document.getElementById("boot-message");
const bootRetry = document.getElementById("boot-retry");
let bootSlowTimer = null;

bootRetry.addEventListener("click", () => location.reload());

function wireThemeToggle() {
  const button = document.getElementById("theme-toggle");
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    const nextLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-label", nextLabel);
    button.title = nextLabel;
  };
  applyTheme(document.documentElement.dataset.theme || "light");
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem("jobmatcher-theme", next); } catch { /* Theme remains active for this page. */ }
  });
}

function wireAccountMenu() {
  const btn = document.getElementById("account-btn");
  const menu = document.getElementById("account-menu");
  const signout = document.getElementById("signout-btn");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); signout.focus(); };
  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); btn.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
  });
  signout.addEventListener("click", () => signOut());
}

function renderAccount() {
  const { user } = store.get();
  document.getElementById("avatar-initials").textContent = initials(user.name || user.email);
  // Masked: the full address is visible in Settings > Account, not in the header.
  document.getElementById("account-email").textContent = maskEmail(user.email);
}

function wireQueueIndicator() {
  let banner = null;
  let countdownTimer = null;

  window.addEventListener("jobmatcher:queue-status", (e) => {
    const detail = e.detail || {};
    if (detail.active) {
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "traffic-queue-banner";
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        document.body.appendChild(banner);
      }
      let remainingSec = Math.ceil((detail.waitMs || 1500) / 1000);
      banner.innerHTML = `<span class="queue-spinner" aria-hidden="true"></span><span>High traffic surge: You are in line. Connecting in <strong>${remainingSec}s</strong>…</span>`;
      clearInterval(countdownTimer);
      countdownTimer = setInterval(() => {
        remainingSec--;
        if (remainingSec > 0 && banner) {
          banner.innerHTML = `<span class="queue-spinner" aria-hidden="true"></span><span>High traffic surge: You are in line. Connecting in <strong>${remainingSec}s</strong>…</span>`;
        } else {
          clearInterval(countdownTimer);
        }
      }, 1000);
    } else {
      clearInterval(countdownTimer);
      if (banner) {
        banner.remove();
        banner = null;
      }
    }
  });
}

async function main() {
  wireQueueIndicator();
  captureReferralFromUrl();
  const authPromise = initAuth();
  const triggerSignIn = async () => {
    showLandingStatus("Connecting to sign-in…");
    try {
      const user = await authPromise;
      if (user) return;
      showLandingStatus("");
      const section = document.getElementById("sign-in");
      section.hidden = false;
      mountSignIn(document.getElementById("auth-root"));
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      showLandingStatus("Sign-in is temporarily unavailable. Reload the page to try again.");
    }
  };

  initLanding({
    onSignIn: triggerSignIn,
  });

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("signin") === "1" || window.location.hash === "#signin") {
    triggerSignIn();
  }
  window.JobMatcherAnalytics?.trackPage("landing");

  let clerkUser;
  try {
    clerkUser = await authPromise;
  } catch (err) {
    showLandingStatus("Sign-in is temporarily unavailable. Reload the page to try again.");
    return;
  }

  if (!clerkUser) {
    return;
  }

  hideLanding();
  boot.hidden = false;
  bootSlowTimer = setTimeout(() => boot.classList.add("is-slow"), 4000);
  bootMessage.textContent = "Loading your saved profile and preferences…";
  try {
    await store.loadAccount(clerkUser);
  } catch (err) {
    window.JobMatcherAnalytics?.trackPage("account_error");
    console.error("Account load failed:", err);
    clearTimeout(bootSlowTimer);
    boot.setAttribute("aria-busy", "false");
    boot.hidden = true;
    document.getElementById("view-root").replaceChildren(
      emptyState({
        title: "We couldn't load your account",
        body: "This is usually temporary. Check your connection and try again.",
        actionLabel: "Try again",
        onAction: () => location.reload(),
      })
    );
    return;
  }

  clearTimeout(bootSlowTimer);
  boot.setAttribute("aria-busy", "false");
  boot.hidden = true;
  wireThemeToggle();
  renderAccount();
  wireAccountMenu();
  // Stats/status load in the background; views subscribe and update when they arrive.
  store.refresh();
  claimPendingReferral(store.get().userId);
  await startRouter();
}

main();
