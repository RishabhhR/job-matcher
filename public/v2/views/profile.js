// Profile view. STUB from TASK-054 - TASK-057 (antigravity) replaces this file.
// Spec: design/ui-redesign/README.md section 3.2 + "Codex design review" amendments.
// Contract: see js/router.js. Styles go in css/profile.css.
// Privacy: never render ctx.store.get().cvText by default (raw CV has phone/email).
export const title = "Profile";

export async function render(root, { store, ui }) {
  const p = store.get().profile || {};
  root.innerHTML = ui.html`
    <div class="page"><div class="stack narrow">
      <section class="card card-pad">
        <h1 class="page-title">Profile</h1>
        <p class="text-2">${p.targetDesignation || "No target role yet"}${p.preferredCity ? ` · ${p.preferredCity}` : ""}</p>
        <p class="muted" style="margin-top:8px">The new Profile page is being built.</p>
      </section>
    </div></div>`;
}
