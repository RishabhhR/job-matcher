// Matches feed (TASK-056). View contract: public/v2/js/router.js.
export const title = "Matches";

let unsubscribe = null;
let rootNode = null;
let context = null;
let state = null;
let requestId = 0;
const PAGE_SIZE = 10;

const dateLabel = (value, ui) => value ? ui.timeAgo(value) : "";
const profileValue = (profile, ...keys) => {
  for (const key of keys) if (profile && profile[key] != null && profile[key] !== "") return profile[key];
  return "";
};
const formatClock = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
const humanize = (value) => String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function activeFilters() {
  return { filter: state.tab, sort: state.sort, minScore: state.minScore ? Number(state.minScore) : undefined, source: state.source || undefined };
}

async function loadPage({ reset = false } = {}) {
  if (!state.userId) return;
  const id = ++requestId;
  if (reset) { state.page = 1; state.results = []; state.total = 0; }
  state.loading = true;
  state.error = "";
  draw();
  try {
    const data = await context.api.getMatches({ userId: state.userId, page: state.page, limit: PAGE_SIZE, ...activeFilters() });
    if (id !== requestId) return;
    state.results = reset ? (data.results || []) : [...state.results, ...(data.results || [])];
    state.total = Number(data.total || 0);
    state.loading = false;
  } catch (error) {
    if (id !== requestId) return;
    state.loading = false;
    state.error = error?.message || "We couldn't load your matches.";
  }
  draw();
}

function shownResults() {
  const term = state.query.trim().toLocaleLowerCase();
  return state.results.filter(({ posting = {} }) => {
    const text = [posting.title, posting.company, posting.location, posting.source].join(" ").toLocaleLowerCase();
    return !term || text.includes(term);
  });
}

function greetingWord() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function scoreWord(score) {
  if (score >= 80) return "Strong";
  if (score >= 60) return "Good";
  return "Weak";
}

function cardMarkup(match) {
  const p = match.posting || {};
  const titleText = p.title || "Untitled role";
  const company = p.company || "Company not listed";
  const score = Number(match.fitScore || 0);
  const band = score >= 80 ? "strong" : score >= 60 ? "good" : "weak";
  const tags = (Array.isArray(match.matchedSkills) ? match.matchedSkills : Array.isArray(p.matchedSkills) ? p.matchedSkills : []).slice(0, 3);
  const postedAt = p.postedAt || p.posted_at || p.updatedAt || p.updated_at || p.createdAt || p.created_at;
  const postedLabel = p.postedAt || p.posted_at ? "Posted" : p.updatedAt || p.updated_at ? "Updated" : "Found";
  const userAction = match.userAction || "";
  const comp = match.compFitLabel;
  const compText = !comp || /unknown|unavailable|not listed/i.test(comp) ? "Compensation not listed" : humanize(comp);
  const compClass = /upgrade/i.test(comp || "") ? "chip-good" : /down/i.test(comp || "") ? "chip-warn" : "";
  return context.ui.html`
    <article class="card-pad-sm match-card" data-match-id="${match.matchId}">
      <div class="match-card-top">
        <div class="company-mark" aria-hidden="true">${company.trim().charAt(0).toUpperCase() || "?"}</div>
        <div class="match-heading">
          <h2 class="card-title">${titleText}</h2>
          <p class="match-meta">${company}${p.location ? ` · ${p.location}` : ""}${p.source ? ` · ${humanize(p.source)}` : ""}${postedAt ? ` · ${postedLabel} ${dateLabel(postedAt, context.ui)}` : ""}</p>
        </div>
        <div class="score-badge score-${band}" aria-label="Estimated fit score ${score} out of 100, ${scoreWord(score)}">
          <strong>${score}</strong><span>${scoreWord(score)}</span>
        </div>
      </div>
      <p class="score-note">Estimated fit based on your profile and this role; not a hiring probability.</p>
      ${match.reasoningText ? context.ui.html`<p class="match-reason"><strong>Why it fits</strong> ${match.reasoningText}</p>` : ""}
      <div class="match-chips"><span class="chip ${compClass}">${compText}</span>${tags.map((tag) => context.ui.html`<span class="chip">${tag}</span>`)}</div>
      <div class="match-actions">
        <button type="button" class="btn btn-text dismiss-action" data-action="dismissed">Not relevant</button>
        <button type="button" class="btn btn-ghost save-action" data-action="${userAction === "saved" ? "unsave" : "saved"}" aria-pressed="${userAction === "saved"}">${userAction === "saved" ? "Saved" : "Save"}</button>
        <button type="button" class="btn btn-primary apply-action" data-action="apply">Apply <span aria-hidden="true">↗</span></button>
      </div>
    </article>`;
}

function draw() {
  if (!rootNode || !state) return;
  const s = state.storeState;
  const stats = s.stats || {};
  const status = s.status || {};
  const sources = Array.isArray(status.sources) ? status.sources : [];
  const healthyCount = sources.filter((source) => source.healthy).length;
  const downSources = sources.filter((source) => !source.healthy);
  const profile = s.profile || {};
  const role = profileValue(profile, "targetDesignation", "target_designation", "targetRole") || "Your target role";
  const city = profileValue(profile, "preferredCity", "preferred_city");
  const country = profileValue(profile, "preferredCountry", "preferred_country");
  const careerStart = profileValue(profile, "careerStartDate", "career_start_date");
  const years = profileValue(profile, "yearsExperience", "years_experience") || (careerStart ? Math.max(0, Math.floor((Date.now() - new Date(careerStart).getTime()) / (365.25 * 24 * 60 * 60 * 1000))) : "");
  const digest = status.nextDigestAt ? formatClock(status.nextDigestAt) : s.digest?.enabled === false ? "Paused" : "Not scheduled";
  const countFor = { new: stats.newCount, saved: stats.savedCount, applied: stats.appliedCount, all: stats.allCount };
  const results = shownResults();
  const greeting = s.user?.name ? s.user.name.trim().split(/\s+/)[0] : "there";
  const scanDate = status.lastScanAt ? `Last scan ${context.ui.timeAgo(status.lastScanAt)}` : "Waiting for the first scan";
  const header = context.ui.html`
    <section class="matches-summary card card-pad" aria-labelledby="matches-title">
      <div class="summary-copy"><h1 id="matches-title" class="page-title">${greetingWord()}, ${greeting}</h1>
        <p class="summary-count">${Number(stats.newSinceLastDigest || 0)} new ${Number(stats.newSinceLastDigest || 0) === 1 ? "match" : "matches"} since your last digest</p>
        <p class="summary-meta">${scanDate} · ${sources.length ? `${healthyCount} of ${sources.length} sources healthy` : "Source health unavailable"} · Next digest ${digest}</p>
      </div>
      <div class="summary-status" aria-live="polite"><span class="status-indicator ${downSources.length ? "status-warning" : ""}" aria-hidden="true"></span><span>${downSources.length ? `${downSources.length} source${downSources.length === 1 ? "" : "s"} need attention` : "Your search is up to date"}</span></div>
    </section>
    ${downSources.length ? context.ui.html`<p class="source-down-note" role="status">${downSources.map((x) => `${humanize(x.source)}: ${x.statusText || "temporarily unavailable"}`).join(" · ")}</p>` : ""}`;

  const tabs = ["new", "saved", "applied", "all"];
  const filter = context.ui.html`
    <div class="filter-panel card card-pad-sm">
      <nav class="match-tabs" aria-label="Filter matches">${tabs.map((tab) => context.ui.html`<button type="button" class="match-tab ${state.tab === tab ? "is-active" : ""}" data-tab="${tab}" aria-current="${state.tab === tab ? "page" : "false"}">${humanize(tab)} <span>${Number(countFor[tab] || 0)}</span></button>`)}</nav>
      <div class="filter-controls">
        <label class="sr-only" for="match-search">Filter by title or company</label><input id="match-search" class="input match-search" type="search" placeholder="Filter by title or company" value="${state.query}" />
        <label class="sr-only" for="minimum-score">Minimum score</label><select class="select" id="minimum-score"><option value="">Any score</option><option value="60" ${state.minScore === "60" ? "selected" : ""}>Score 60+</option><option value="70" ${state.minScore === "70" ? "selected" : ""}>Score 70+</option><option value="80" ${state.minScore === "80" ? "selected" : ""}>Score 80+</option></select>
        <label class="sr-only" for="match-source">Source</label><select class="select" id="match-source"><option value="">All sources</option>${sources.map((x) => context.ui.html`<option value="${x.source}" ${state.source === x.source ? "selected" : ""}>${humanize(x.source)}</option>`)}</select>
        <label class="sr-only" for="match-sort">Sort matches</label><select class="select" id="match-sort"><option value="best" ${state.sort === "best" ? "selected" : ""}>Best fit</option><option value="newest" ${state.sort === "newest" ? "selected" : ""}>Newest</option></select>
      </div>
    </div>`;

  const rail = context.ui.html`
    <aside class="rail matches-rail" aria-label="Search and source information">
      <section class="card card-pad-sm rail-card"><p class="eyebrow">Your search</p><h2 class="rail-title">${role}</h2><div class="chip-row">${city || country ? context.ui.html`<span class="chip">${city}${city && country ? ", " : ""}${country}</span>` : ""}${years ? context.ui.html`<span class="chip">~${years} yrs experience</span>` : ""}</div><a class="link-btn" href="#/profile">Edit profile <span aria-hidden="true">→</span></a></section>
      <section class="card card-pad-sm rail-card"><div class="row"><p class="eyebrow">Daily digest</p><span class="chip ${s.digest?.enabled === false ? "" : "chip-good"}">${s.digest?.enabled === false ? "Off" : "On"}</span></div><p class="rail-detail">${s.digest?.enabled === false ? "Digest emails are paused" : `Next: ${digest}`}</p><a class="link-btn" href="#/settings">Digest settings <span aria-hidden="true">→</span></a></section>
      <section class="card card-pad-sm rail-card"><p class="eyebrow">Sources</p>${sources.length ? sources.map((source) => context.ui.html`<div class="source-row"><span><span class="dot ${source.healthy ? "" : "dot-warn"}" aria-hidden="true"></span>${humanize(source.source)}</span><span class="source-count">${Number(source.count24h || 0).toLocaleString()} jobs</span></div>${!source.healthy ? context.ui.html`<p class="source-status">${source.statusText || "Temporarily unavailable"}</p>` : ""}`) : context.ui.html`<p class="rail-detail">Source health is not available yet.</p>`}</section>
    </aside>`;

  let feedContent;
  if (state.loading && !state.results.length) {
    feedContent = `<div class="stack" aria-label="Loading matches"><div class="card skeleton match-skeleton"></div><div class="card skeleton match-skeleton"></div></div>`;
  } else if (state.error) {
    feedContent = `<div class="card empty-state"><h2 class="section-title">We couldn't load your matches</h2><p class="text-2">Please check your connection and try again.</p><div class="actions"><button class="btn btn-primary retry-action" type="button">Try again</button></div></div>`;
  } else if (!state.total && state.tab === "new" && (stats.totalScored || 0) > 0) {
    feedContent = `<div class="card empty-state caught-up"><h2 class="section-title">You’re all caught up</h2><p class="text-2">No new matches since your last digest. We’ll show new roles here after the next scan.</p></div>`;
  } else if (!state.total) {
    feedContent = `<div class="card empty-state"><h2 class="section-title">No matches yet</h2><p class="text-2">We’ll show roles that fit your search here. Check back after the next scan, or review your job preferences.</p><div class="actions"><a class="btn btn-ghost" href="#/profile">Review profile</a></div></div>`;
  } else if (!results.length) {
    feedContent = `<div class="card empty-state"><h2 class="section-title">No matches for this filter</h2><p class="text-2">Try a different title, company, or filter.</p></div>`;
  } else {
    feedContent = results.map(cardMarkup).join("");
    if (state.results.length < state.total) feedContent += `<button class="btn btn-ghost load-more" type="button" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading…" : "Load more matches"}</button>`;
    if (state.loading) feedContent += `<div class="card skeleton match-skeleton" aria-label="Loading more matches"></div>`;
  }
  // header/filter/rail/cards have already been built with ui.html (all API values escaped).
  rootNode.innerHTML = `${header}${context.ui.html`<div class="layout-rail matches-layout"><main class="matches-main"></main></div>`}`;
  const layout = rootNode.querySelector(".matches-layout");
  layout.querySelector(".matches-main").innerHTML = `${filter}<section class="match-list stack" aria-label="Job matches" aria-live="polite">${feedContent}</section>`;
  layout.appendChild(document.createRange().createContextualFragment(String(rail)));
  bindEvents();
}

function bindEvents() {
  rootNode.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => { state.tab = button.dataset.tab; loadPage({ reset: true }); }));
  const search = rootNode.querySelector(".match-search");
  search?.addEventListener("input", () => { state.query = search.value; draw(); const next = rootNode.querySelector(".match-search"); next?.focus(); next?.setSelectionRange(state.query.length, state.query.length); });
  for (const [selector, key] of [["#minimum-score", "minScore"], ["#match-source", "source"], ["#match-sort", "sort"]]) {
    rootNode.querySelector(selector)?.addEventListener("change", (event) => { state[key] = event.target.value; loadPage({ reset: true }); });
  }
  rootNode.querySelector(".retry-action")?.addEventListener("click", () => loadPage({ reset: true }));
  rootNode.querySelector(".load-more")?.addEventListener("click", () => { state.page += 1; loadPage(); });
  rootNode.querySelectorAll(".match-card").forEach((card) => card.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => performAction(card, button));
  }));
}

async function performAction(card, button) {
  const matchId = card.dataset.matchId;
  const match = state.results.find((item) => String(item.matchId) === String(matchId));
  if (!match || button.disabled) return;
  const operation = button.dataset.action;
  if (operation === "apply") {
    const url = match.posting?.url || match.posting?.applyUrl || match.posting?.apply_url;
    if (!safeHttpUrl(url)) { context.ui.toast({ message: "This posting doesn’t have a valid application link.", tone: "error" }); return; }
    window.open(url, "_blank", "noopener,noreferrer");
    await saveAction(match, "applied", { hide: false, message: "Marked as applied" });
    return;
  }
  if (operation === "saved") await saveAction(match, "saved", { hide: false, message: "Match saved" });
  if (operation === "unsave") await saveAction(match, null, { hide: false, message: "Removed from saved matches" });
  if (operation === "dismissed") await saveAction(match, "dismissed", { hide: true, message: "Match hidden", undo: true });
}

function safeHttpUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; }
}

async function saveAction(match, action, { hide, message, undo = false }) {
  const previous = match.userAction || null;
  const wasVisible = state.results.includes(match);
  const removeFromCurrentTab = hide || (state.tab === "new" && Boolean(action)) || (state.tab === "saved" && action !== "saved") || (state.tab === "applied" && action !== "applied");
  match.userAction = action;
  if (removeFromCurrentTab && wasVisible) { match.__dismissed = Boolean(hide); state.results = state.results.filter((item) => item !== match); state.total = Math.max(0, state.total - 1); }
  else if (match.__dismissed) { match.__dismissed = false; state.results.unshift(match); state.total += 1; }
  draw();
  try {
    await context.api.setMatchAction(state.userId, match.matchId, action);
    await context.store.refresh();
    context.ui.toast({ message, actionLabel: undo ? "Undo" : undefined, onAction: undo ? () => saveAction(match, previous, { hide: false, message: "Dismissal undone" }) : undefined });
  } catch (error) {
    match.userAction = previous;
    if (removeFromCurrentTab && wasVisible) { match.__dismissed = false; state.results.unshift(match); state.total += 1; }
    draw();
    context.ui.toast({ message: error?.message || "We couldn't update that match. Try again.", tone: "error" });
  }
}

export async function render(root, ctx) {
  rootNode = root;
  context = ctx;
  const initial = ctx.store.get();
  state = { storeState: initial, userId: initial.userId, tab: "new", sort: "best", minScore: "", source: "", query: "", page: 1, results: [], total: 0, loading: true, error: "" };
  draw();
  unsubscribe = ctx.store.subscribe((next) => { state.storeState = next; draw(); });
  await loadPage({ reset: true });
}

export function unmount() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  requestId += 1;
  rootNode = null;
  context = null;
  state = null;
}
