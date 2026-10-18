// Matches view (home). STUB from TASK-054 - TASK-056 (codex) replaces this file.
// Spec: design/ui-redesign/README.md section 3.1 + "Codex design review" amendments.
// Contract: see js/router.js. Styles go in css/matches.css.
export const title = "Matches";

let unsubscribe = null;

export async function render(root, { store, ui }) {
  const draw = (s) => {
    const name = (s.user && s.user.name ? s.user.name.split(" ")[0] : "") || "there";
    const stats = s.stats;
    root.innerHTML = ui.html`
      <div class="page">
        <section class="card card-pad">
          <h1 class="page-title">Hi, ${name}</h1>
          <p class="text-2">${stats ? `${stats.newSinceLastDigest} new since your last digest · ${stats.totalScored} scored matches` : "Loading your matches…"}</p>
          <p class="muted" style="margin-top:8px">The new Matches feed is being built.</p>
        </section>
      </div>`;
  };
  draw(store.get());
  unsubscribe = store.subscribe(draw);
}

export function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}
