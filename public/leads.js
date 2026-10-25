// "Email me new jobs" forms (TASK-105) on the landing and public /jobs pages.
// The email goes only to our API, never to analytics.
(function () {
  "use strict";
  function setStatus(form, message, isError) {
    const status = form.querySelector(".lead-form-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("is-error", !!isError);
  }

  function enhance(form) {
    if (form.dataset.leadReady) return;
    form.dataset.leadReady = "1";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = form.elements.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
        setStatus(form, "Enter a valid email address.", true);
        form.elements.email.focus();
        return;
      }
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      setStatus(form, "Saving…", false);
      try {
        const response = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({
            email,
            role: form.elements.role ? form.elements.role.value.trim() : "",
            website: form.elements.website ? form.elements.website.value : "",
            source: form.dataset.leadSource || "",
            visitorId: window.JobMatcherAnalytics && window.JobMatcherAnalytics.visitorId ? window.JobMatcherAnalytics.visitorId() : null,
          }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error((data && data.error) || "Could not save your email. Please try again.");
        form.querySelector(".lead-form-fields").hidden = true;
        setStatus(form, "You're in. New openings will arrive by email within a week.", false);
      } catch (error) {
        button.disabled = false;
        setStatus(form, error.message || "Could not save your email. Please try again.", true);
      }
    });
  }

  function init() { document.querySelectorAll("form[data-lead-form]").forEach(enhance); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
