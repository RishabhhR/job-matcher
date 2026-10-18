// Settings view. STUB from TASK-054 - TASK-058 (antigravity) replaces this file.
// Spec: design/ui-redesign/README.md section 3.3 + "Codex design review" amendments.
// Contract: see js/router.js. Styles go in css/settings.css.
export const title = "Settings";

export async function render(root, { store, ui }) {
  const { digest } = store.get();
  root.innerHTML = ui.html`
    <div class="page"><div class="stack narrow">
      <section class="card card-pad">
        <h1 class="page-title">Settings</h1>
        <p class="text-2">Daily digest: ${digest.enabled ? `on, ${digest.hour}:00` : "off"}</p>
        <p class="muted" style="margin-top:8px">The new Settings page is being built.</p>
      </section>
    </div></div>`;
}
