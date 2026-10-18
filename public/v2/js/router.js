// Hash router + onboarding gate (TASK-054).
//
// VIEW CONTRACT - every file in views/ exports:
//   export const title = "Matches";                 // document title + route announcement
//   export async function render(root, ctx) { ... } // root: empty <div>, ctx below
//   export function unmount() { ... }               // optional cleanup (timers, subscriptions)
// ctx = { store, api, ui, navigate(route) }. Views only touch their own root element.
import * as store from "./store.js";
import * as api from "./api.js";
import * as ui from "./ui.js";

const ROUTES = {
  matches: () => import("../views/matches.js"),
  profile: () => import("../views/profile.js"),
  settings: () => import("../views/settings.js"),
  onboarding: () => import("../views/onboarding.js"),
};
const APP_ROUTES = ["matches", "profile", "settings"];

let current = null;   // { name, module }
let renderToken = 0;  // guards against a slow render finishing after a newer one

export function navigate(route) {
  if (location.hash === `#/${route}`) return showRoute();
  location.hash = `#/${route}`;
}

function requestedRoute() {
  const name = location.hash.replace(/^#\/?/, "").split("?")[0];
  return ROUTES[name] ? name : "matches";
}

// No CV -> onboarding only, with main navigation hidden (DEC-007 amendment 5).
function resolveRoute(name) {
  const { hasCv } = store.get();
  if (!hasCv) return "onboarding";
  return name;
}

function updateChrome(name) {
  const inApp = APP_ROUTES.includes(name);
  document.getElementById("topnav").hidden = false;
  document.querySelector(".topnav-links").hidden = !inApp;
  document.getElementById("bottomnav").hidden = !inApp;
  document.querySelectorAll("[data-route]").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

export async function showRoute() {
  const token = ++renderToken;
  const name = resolveRoute(requestedRoute());
  // Normalise redirects and unknown routes (e.g. #/nope -> #/matches) so the URL matches the view.
  if (location.hash !== `#/${name}`) history.replaceState(null, "", `#/${name}`);

  if (current && current.module.unmount) {
    try { current.module.unmount(); } catch (err) { console.error(err); }
  }
  updateChrome(name);

  const root = document.getElementById("view-root");
  root.replaceChildren();
  const viewRoot = document.createElement("div");
  root.appendChild(viewRoot);

  try {
    const module = await ROUTES[name]();
    if (token !== renderToken) return;
    current = { name, module };
    document.title = `${module.title || name} · JobMatcher`;
    await module.render(viewRoot, { store, api, ui, navigate });
    if (token !== renderToken) return;
    // Move focus to the view's heading so keyboard and screen-reader users land at the top.
    const heading = viewRoot.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    } else {
      root.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
    ui.announce(`${module.title || name} page`);
  } catch (err) {
    console.error(`Failed to render ${name}:`, err);
    if (token !== renderToken) return;
    viewRoot.replaceChildren(
      ui.emptyState({
        title: "Something went wrong loading this page",
        body: "Check your connection and try again.",
        actionLabel: "Try again",
        onAction: () => showRoute(),
      })
    );
  }
}

export function startRouter() {
  window.addEventListener("hashchange", showRoute);
  return showRoute();
}
