// Shared, privacy-safe browser analytics for the legacy and v2 applications.
// PostHog's public project token is fetched from the server configuration.
(function () {
  "use strict";

  const surface = location.pathname.startsWith("/v2") ? "v2" : "legacy";
  const environment = location.hostname === "job-matcher-ecru.vercel.app"
    ? "production"
    : /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "development" : "preview";
  const allowedRoutes = new Set([
    "sign_in", "auth_error", "account_error", "matches", "profile", "settings",
    "onboarding", "legacy_wizard", "legacy_settings",
  ]);
  const safeName = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(value) ? value : null;
  let client = null;
  let page = null;
  let pageStarted = 0;
  let visibleStarted = document.visibilityState === "visible" ? performance.now() : 0;
  let activeMs = 0;
  let pageClosed = false;
  const queue = [];
  const seenSections = new Set();
  const observed = new WeakSet();

  function pageUrl(name) {
    const path = surface === "v2" ? "/v2/" : "/";
    return `${location.origin}${path}${surface === "v2" && ["matches", "profile", "settings", "onboarding"].includes(name) ? `#/${name}` : ""}`;
  }

  function capture(event, properties, unload = false) {
    const payload = { ...properties, app: "job-matcher", surface, environment };
    if (!client) {
      if (queue.length < 100) queue.push([event, payload, unload]);
      return;
    }
    client.capture(event, payload, unload ? { transport: "sendBeacon", send_instantly: true } : undefined);
  }

  function leavePage(unload = false) {
    if (!page || pageClosed) return;
    pageClosed = true;
    const now = performance.now();
    if (visibleStarted) activeMs += now - visibleStarted;
    visibleStarted = 0;
    const properties = {
      page_name: page,
      $current_url: pageUrl(page),
      duration_ms: Math.max(0, Math.round(now - pageStarted)),
      active_duration_ms: Math.max(0, Math.round(activeMs)),
    };
    capture("page_leave", properties, unload);
    capture("$pageleave", properties, unload);
  }

  function trackPage(name) {
    if (!allowedRoutes.has(name) || (page === name && !pageClosed)) return;
    leavePage();
    page = name;
    pageClosed = false;
    pageStarted = performance.now();
    activeMs = 0;
    visibleStarted = document.visibilityState === "visible" ? pageStarted : 0;
    seenSections.clear();
    const properties = { page_name: name, $current_url: pageUrl(name) };
    capture("$pageview", properties);
    capture("page_load", properties);
    scheduleSections();
  }

  function controlName(element) {
    const explicit = safeName(element.dataset.analyticsId);
    if (explicit) return explicit;
    const id = safeName(element.id);
    if (id) return id;
    const action = safeName(element.dataset.action);
    if (action && ["apply", "saved", "unsave", "dismissed"].includes(action)) return `match_${action}`;
    const tab = safeName(element.dataset.tab);
    if (tab && ["new", "saved", "applied", "all"].includes(tab)) return `tab_${tab}`;
    const route = safeName(element.dataset.route);
    if (route && allowedRoutes.has(route)) return `nav_${route}`;
    const href = element.getAttribute("href") || "";
    const hashRoute = href.match(/^#\/(matches|profile|settings|onboarding)$/);
    if (hashRoute) return `nav_${hashRoute[1]}`;
    // Class names are app-authored and contain no CV, job, or account content.
    const className = [...element.classList].find((value) => safeName(value) && !/^(btn|active|is-|text-|card)/.test(value));
    return className || (element.tagName === "A" ? "external_link" : "button");
  }

  function sectionName(element) {
    const explicit = safeName(element.dataset.analyticsSection);
    if (explicit) return explicit;
    const headingId = safeName(element.getAttribute("aria-labelledby"));
    if (headingId) return headingId;
    const label = element.getAttribute("aria-label");
    if (label === "Job matches") return "match_feed";
    return null;
  }

  const sectionObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !page || pageClosed) continue;
      const section = sectionName(entry.target);
      const key = `${page}:${section}`;
      if (section && !seenSections.has(key)) {
        seenSections.add(key);
        capture("section_viewed", { page_name: page, section_name: section });
      }
    }
  }, { threshold: 0.25 }) : null;

  function scanSections() {
    if (!sectionObserver || !page) return;
    document.querySelectorAll("[data-analytics-section], section[aria-labelledby], section[aria-label]").forEach((element) => {
      if (!observed.has(element) && sectionName(element)) {
        observed.add(element);
        sectionObserver.observe(element);
      }
    });
  }

  let scanScheduled = false;
  function scheduleSections() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => { scanScheduled = false; scanSections(); });
  }

  function installSdk(token, host) {
    // PostHog's official HTML snippet queues captures until its SDK loads.
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    window.posthog.init(token, {
      api_host: host,
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: { dom_event_allowlist: ["click"], element_allowlist: ["a", "button"] },
      enable_heatmaps: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_session_recording: true,
      disable_surveys: true,
      before_send: (event) => {
        const properties = event?.properties;
        if (!properties) return event;
        // URLs and referrers can contain identifiers or tokens. Route names are fixed.
        properties.$current_url = pageUrl(safeName(properties.page_name) || page || "");
        delete properties.$referrer;
        delete properties.$el_text;
        delete properties.$set;
        delete properties.$set_once;
        return event;
      },
    });
    client = window.posthog;
    client.register({ app: "job-matcher", surface, environment });
    while (queue.length) {
      const [event, properties, unload] = queue.shift();
      capture(event, properties, unload);
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button, a, [role='button'], [id$='-btn']") : null;
    if (!target || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;
    capture("cta_click", { page_name: page || "unresolved", control_id: controlName(target), control_type: target.tagName.toLowerCase() });
  }, true);

  document.addEventListener("visibilitychange", () => {
    if (!page || pageClosed) return;
    if (document.visibilityState === "hidden" && visibleStarted) {
      activeMs += performance.now() - visibleStarted;
      visibleStarted = 0;
    } else if (document.visibilityState === "visible" && !visibleStarted) {
      visibleStarted = performance.now();
    }
  });
  window.addEventListener("pagehide", () => leavePage(true));
  document.addEventListener("DOMContentLoaded", () => {
    const root = document.getElementById("view-root") || document.getElementById("app-container") || document.body;
    new MutationObserver(scheduleSections).observe(root, { childList: true, subtree: true });
    scheduleSections();
  });

  window.JobMatcherAnalytics = { trackPage, capture: (event, properties = {}) => capture(event, properties) };
  fetch("/api/analytics-config", { credentials: "omit" })
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
      if (config && /^phc_[A-Za-z0-9]+$/.test(config.token) && /^https:\/\/[a-z0-9.-]+\.posthog\.com$/i.test(config.host)) {
        installSdk(config.token, config.host);
      }
    })
    .catch(() => { /* Analytics must never block the application. */ });
})();
