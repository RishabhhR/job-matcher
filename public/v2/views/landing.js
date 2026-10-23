// Progressive enhancement for the public, server-visible landing HTML.
let ready = false;

export function initLanding({ onSignIn }) {
  if (ready) return;
  ready = true;
  document.querySelectorAll("[data-landing-signin]").forEach((button) => {
    button.addEventListener("click", () => onSignIn());
  });
  document.getElementById("landing-signin-close")?.addEventListener("click", () => {
    document.getElementById("sign-in").hidden = true;
    document.getElementById("landing-title")?.scrollIntoView({ block: "start" });
    document.querySelector("[data-landing-signin]")?.focus();
  });

  // Show a measured count; never substitute an invented marketing number.
  fetch("/api/public/jobs/summary", { credentials: "omit" })
    .then((response) => response.ok ? response.json() : null)
    .then((data) => {
      if (!data || !Number.isSafeInteger(data.recentCount) || data.recentCount < 0) return;
      document.getElementById("landing-job-count").textContent = data.recentCount.toLocaleString();
    })
    .catch(() => { /* The landing page remains useful if the database is unavailable. */ });
}

export function showLandingStatus(message) {
  const status = document.getElementById("landing-auth-status");
  status.textContent = message;
  status.hidden = !message;
}

export function hideLanding() {
  document.getElementById("landing-root").hidden = true;
  document.getElementById("sign-in").hidden = true;
}
