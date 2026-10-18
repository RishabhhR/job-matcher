// First-run onboarding (shown only while the user has no CV). STUB from TASK-054 -
// TASK-057 (antigravity) replaces this file. Spec: README section 3.4 + amendments.
// Contract: see js/router.js. Styles go in css/onboarding.css.
// On completion: store.set({ hasCv: true, cvText, profile, ... }) then navigate("matches").
export const title = "Get started";

export async function render(root, { ui }) {
  root.innerHTML = ui.html`
    <div class="page"><div class="center-col">
      <h1 class="page-title">Let's find jobs that fit you</h1>
      <p class="text-2" style="margin-top:8px">Onboarding is being built. Until then, set up your CV in the current app.</p>
      <p style="margin-top:16px"><a class="btn btn-primary" href="/">Open the current app</a></p>
    </div></div>`;
}
