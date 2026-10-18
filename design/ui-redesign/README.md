# JobMatcher UI redesign (v2)

Status: **DRAFT for design review** (coordo DEC-007, codex reviews with its design skill before any build task starts).
Mockup: [`mockup.html`](mockup.html) (static, open in a browser; four views: Matches, Profile, Settings, and First-run onboarding via the link at bottom-right).
Visual language: keeps the agreed "Liquid Light" system (DEC-004): warm `#f4f2ee` page, white surfaces, single LinkedIn-blue accent, Inter. This redesign is mostly about **information architecture and hierarchy**, not a new brand.

---

## 1. Critique of the current UI

### Overall impression
The page looks tidy, but a returning user lands on a **setup form**. The thing they came for, their matches, is not visible anywhere on the first screen, and the numbers that are visible are wrong ("0 matches").

### Usability
| Finding | Severity | Recommendation |
|---|---|---|
| Returning users land on wizard step 1 (Profile). Matches are step 3 of a wizard, below the fold. | 🔴 Critical | Make **Matches** the home screen. The wizard becomes a first-run onboarding only. |
| Left card shows **0 matches / 0 searches** for an account with ~780 matches. `getUserStats` counts only `status='scored'`; cron-scored matches are `status='new'`. | 🔴 Critical | Count all scored statuses (`new`, `scored`); show "new since last digest". Bug, see TASK-053. |
| Right rail shows **"Location: Not specified"** while the profile has Bengaluru. It reads the wizard's input field, not saved data. | 🔴 Critical | Render rail cards from the `/api/user/init` profile payload. Bug, see TASK-053. |
| The raw CV text (including **phone number and email**) is shown in an editable textarea on the main screen. | 🟡 Moderate (privacy) | Show a parsed summary of the CV; raw text only behind "View text". |
| Two CV inputs at once (drop zone and paste box). | 🟡 Moderate | One primary action (upload); paste is a small secondary link. |
| Settings live in three places: right rail, Settings & Stats tab, wizard step 2. | 🟡 Moderate | One Settings page; the rail shows read-only summaries with an Edit link. |
| "Start a new search…" looks like a search box but is a collapse toggle, and the nav has a second real search box. | 🟡 Moderate | Remove the pill. Filtering lives in the Matches toolbar. |
| "Recent Activity" (Job searching…, Target boards list) and the footer links (About, Help Center, Privacy) are placeholders. | 🟢 Minor | Remove until real. Replace with real "last scan" status. |
| The compensation section shows field labels while collapsed (inputs hidden, labels visible). | 🟢 Minor | Hide the whole section body when collapsed. |

### Visual hierarchy
- **What draws the eye first:** the "Your Profile" heading and the large blue Continue button. That's wrong for a returning user; it should be the newest, best-scoring matches.
- **Reading flow:** three narrow columns compete. The center column is a long form, and the side rails are mostly empty states.
- **Emphasis:** the brightest numbers on screen are the two blue "0"s. The interface highlights its own emptiness.

### Consistency
| Element | Issue | Recommendation |
|---|---|---|
| Section titles | "Your Profile" has a blue bar and a large size; card titles are small and bold. | One heading scale (section 4.2). |
| Cards | Profile card has a cover banner; the other cards don't. | One card style; no decorative banners. |
| Muted text | `#8a97a3` on white is about 2.9:1 contrast. | `#5f6b78` or darker (4.5:1 or better). |

### Accessibility
- **Contrast:** helper text and rail captions fail WCAG AA.
- **Targets:** chevron toggles and "browse a file" are below 44×44px.
- **Text:** 12–13px labels in the rails; the base text size should be 15px.

### What works well
- A calm, light palette with a single accent. Keep it.
- The career-start-date helper text explains *why* the field is asked for. Do more of that.
- The digest status card is a useful summary.

---

## 2. Information architecture

```
Top nav:  [JobMatcher]   Matches   Profile   Settings          [avatar ▾]
                                                                 └ Sign out
First visit (no CV)  ──►  Onboarding (full page, 3 steps)  ──►  Matches
Returning visit      ──►  Matches (home)
```

| View | Purpose | Replaces |
|---|---|---|
| **Matches** (home) | See new, high-fit jobs and act on them | Wizard step 3, results grid, left rail |
| **Profile** | What the AI knows about you: CV summary, target role, tags, experience, comp | Wizard step 1, raw CV textarea |
| **Settings** | Digest schedule, sources and companies, account | Wizard step 2, Settings & Stats tab, right rail controls |
| **Onboarding** | First-run only: upload CV, confirm details, set preferences | The 3-step wizard |

Removed: "Match Wizard" naming, left profile rail with banner, fake Recent Activity, placeholder footer, "Start a new search" pill, the nav search box (moves into the Matches toolbar).

---

## 3. Screens

### 3.1 Matches (home)
```
┌──────────────────────────────────────────────────────────────┬─────────────────────┐
│ Good evening, Rishabh                                        │ YOUR SEARCH         │
│ 18 new matches since your 9:00 AM digest                     │ Product Manager     │
│ ● Last scan 42 min ago · 5 sources healthy · Next digest 9 PM│ Bengaluru · Remote  │
├──────────────────────────────────────────────────────────────┤ ~2 yrs experience   │
│ [New 18] [Saved 4] [Applied 2] [All]   Score ≥ 70 ▾  Source ▾│ Edit →              │
│ 🔍 Filter by title or company                    Sort: Best ▾├─────────────────────┤
├──────────────────────────────────────────────────────────────┤ DAILY DIGEST    [on]│
│ ┌──────────────────────────────────────────────────────────┐ │ 9:00 AM · 9:00 PM   │
│ │ [M] Product Manager, Growth           ● NEW   ┌────────┐ │ │ Next: tonight 9 PM  │
│ │     Meesho · Bengaluru · LinkedIn · 3h ago    │  92    │ │ ├─────────────────────┤
│ │                                               │ strong │ │ │ SOURCES             │
│ │ Why it fits: 2 yrs consumer PM at Zepto maps  └────────┘ │ │ ● LinkedIn   100    │
│ │ to their growth loop; comp likely +25%.   [Upgrade]      │ │ ● Naukri      15    │
│ │ [growth] [consumer] [experimentation]                    │ │ ● Greenhouse 1.7k   │
│ │                       [Not relevant] [Save] [Apply ↗]    │ │ ...                 │
│ └──────────────────────────────────────────────────────────┘ │                     │
│ ...more cards...                         [ Load more ]       │                     │
└──────────────────────────────────────────────────────────────┴─────────────────────┘
```
- **Header summary** answers "is this thing working?": new-since-digest count, last scan time, source health, next digest time.
- **Tabs:** New (not yet seen), Saved, Applied, All. Filters: minimum score, source, comp label. Free-text filter. Sort: Best fit / Newest.
- **Match card:** company initial, title, company · location · source · posted ago, score badge (number plus word: strong 80+, good 60–79, weak below 60), comp pill (Upgrade, Lateral, Downgrade), one-to-two-line "Why it fits", up to 3 matched tags, actions **Apply** (primary, opens apply URL and marks Applied), **Save**, **Not relevant** (hides it; feeds future ranking).
- **States:** loading (skeleton cards); scan in progress (thin progress bar in the header plus live text, `aria-live=polite`); caught up ("No new matches since 9:00 AM. Next scan at 8:30 PM."); no CV (redirect to Onboarding); source down (amber dot plus tooltip with the error).

### 3.2 Profile
- **CV card:** file name, uploaded date, parsed summary (current role, company, years, top skills). Actions: Replace CV, View text (disclosure). The raw text is never shown by default.
- **Target role & tags:** target title; editable chips in two groups, **Looking for** (drives search) and **From your CV** (drives scoring). This is the slot for the CV-tags feature.
- **Experience & compensation:** career start date (with the "why" helper), current title and employer, fixed, ESOP and currency, plus an explainer that comp is used only to label Upgrade/Lateral/Downgrade.

### 3.3 Settings
- **Digest:** on/off, two time slots (9 AM / 9 PM default), timezone, "Send me a test digest".
- **Sources:** toggles for LinkedIn, Naukri, Greenhouse, Lever and Ashby; company lists for the ATS boards; preferred location chips plus a Remote toggle.
- **Account:** email, sign out, delete my data.

### 3.4 Onboarding (first run only)
Full-page, centered, 560px column, progress "Step 1 of 3".
1. **Upload your CV.** A single large drop zone; "Paste text instead" as a link.
2. **Check what we found.** Auto-extracted target role, years of experience, current title and company, and skill chips, all editable. Compensation is optional and collapsed.
3. **Where and when.** Location chips, Remote toggle, digest times. CTA: **Find my matches**, which lands on Matches with the scan-in-progress state.

---

## 4. Design tokens and components

### 4.1 Color
| Token | Value | Use |
|---|---|---|
| `--bg` | `#f4f2ee` | Page |
| `--surface` | `#ffffff` | Cards |
| `--border` | `rgba(0,0,0,.08)` | Card and input borders |
| `--text` | `#1a2226` | Body |
| `--text-2` | `#4b5b6b` | Secondary (≥ 7:1 on white) |
| `--text-3` | `#5f6b78` | Captions (≥ 4.5:1 on white, replaces `#8a97a3`) |
| `--accent` | `#0a66c2` | Primary actions, links, active nav |
| `--good` / `--mid` / `--weak` | `#047857` / `#b45309` / `#5f6b78` | Score badges |
| `--new` | `#0a66c2` | New-match dot |

### 4.2 Type (Inter)
Page title 22/28 600 · Section 17/24 600 · Card title 16/22 600 · Body 15/23 400 · Meta 13/18 500 (`--text-3`) · Badge numbers 20/24 700, tabular.

### 4.3 Layout and spacing
4px base scale (4, 8, 12, 16, 24, 32). Max width 1080px. Desktop: main column plus a 300px rail. Below 900px: single column; the rail cards move under the header summary. Below 600px: bottom tab bar (Matches, Profile, Settings). Card radius 12; input and button radius 8; pills fully round.

### 4.4 Components
`AppShell`, `NavTabs`, `SummaryHeader`, `FilterBar` (tabs, chips, select, text filter), `MatchCard`, `ScoreBadge`, `CompPill`, `TagChip` (static or editable), `RailCard`, `SourceHealthList`, `EmptyState`, `Skeleton`, `Toast`, `Stepper` (onboarding only), `Disclosure`.

### 4.5 Accessibility requirements (acceptance criteria)
- All text meets WCAG AA contrast; focus ring `2px solid --accent` with a 2px offset on every interactive element.
- Interactive targets are at least 44×44px; icon-only buttons have `aria-label`.
- Tabs and chips are keyboard operable (arrow keys in tablists).
- Scan progress and toasts use `aria-live="polite"`. `prefers-reduced-motion` disables skeleton shimmer and transitions.

---

## 5. Backend changes the design needs
1. **Fix stats** (`getUserStats`, `db.ts:651`): count `status IN ('new','scored')`; add `new_since_last_digest` (matches with `emailed_at IS NULL`, plus scored after the last `jm_email_send_log.sent_at`).
2. **User actions on matches:** new column `jm_user_job_matches.user_action` (`saved` | `applied` | `dismissed` | NULL) and `POST /api/matches/:id/action`. **Do not reuse `status`**: it carries the pending/scored scoring lifecycle (same lesson as `emailed_at`, TASK-025).
3. **Health endpoint:** `GET /api/status` returning the last scrape run time, per-source counts and errors (`scrape_health` is already logged; persist it in `jm_scrape_runs`), and the next digest time.
4. **Profile payload:** rail and Profile render from the saved profile (`/api/user/init`), never from form inputs.

---

## 6. Build plan (after DEC-007 is answered)

All UI currently lives in three large files (`index.html` 546 lines, `app.js` 971, `style.css` 1904). Three agents editing them at once caused collisions before (TASK-011/012). So **one foundation task lands first** and splits the UI into per-view modules; the view tasks then touch disjoint files in parallel.

| Ledger | Owner | Task | Files | Depends on |
|---|---|---|---|---|
| DEC-007 | codex | Design review: Product Design `audit` + `ideate`, answer YES or amendments | this folder | — |
| TASK-053 | claude | Bug: wrong stats (0 matches) and "Location: Not specified" | fixed inside TASK-054/055 | — |
| TASK-054 | claude | Foundation: tokens, base CSS, `AppShell`, nav, view router, onboarding gate, empty view stubs | `public/index.html`, `public/app.js` (shell), `public/css/tokens.css`, `public/css/base.css`, `public/views/*.js` stubs | DEC-007 |
| TASK-055 | claude | Backend for the design: stats fix, `user_action` column and endpoint, `/api/status`, feed filters | `src/db.ts`, `src/server.ts` | DEC-007 |
| TASK-056 | codex | Matches view: summary header, filter bar, match cards, all states (`image-to-code`, `design-qa`) | `public/views/matches.js`, `public/css/matches.css` | 054, 055 |
| TASK-057 | antigravity | Onboarding (first run) and Profile views | `public/views/onboarding.js`, `public/views/profile.js`, `public/css/profile.css` | 054 |
| TASK-058 | antigravity | Settings view (digest, sources, account) | `public/views/settings.js`, `public/css/settings.css` | 054 |
| TASK-059 | claude | Verify: accessibility audit, desktop + 375px browser checks of every state, deploy | none (review only) | 056, 057, 058 |

**Definition of done for every view task:** matches the mockup's structure; every state in section 3 implemented; section 4.5 accessibility criteria met; no edits outside the task's listed files; typecheck clean; closed with `coordo task done` including a verification note.

## Codex design review (DEC-007)

### Verdict

**YES with amendments.** Keep the Matches-first information architecture, the single-column feed with a compact right rail, and the separate Profile, Settings, and first-run Onboarding views. The source-level review of `public/index.html`, `public/app.js`, `public/style.css`, and the four mockup views supports the core change: returning users currently enter a required CV/profile wizard, while the feed is only populated after a manual run; the proposed Matches home makes the primary task immediately visible and removes duplicated preference controls. The current UI also derives some rail values from editable wizard inputs and includes placeholder activity/footer content. The proposed card hierarchy is scannable, but trust, state semantics, and touch/keyboard details need tightening before implementation.

This was a source review, not a rendered browser audit: this headless dispatch did not capture screenshots or exercise the UI with keyboard or assistive technology. Findings about spacing, actual contrast, responsive behavior, focus order, and interaction behavior are therefore design/code risks to verify in TASK-059. The mockup is static; its controls are not evidence that the production flows work. I did not run `ideate`: the proposed Matches layout and card are already a clear improvement over the current wizard-first flow, and I found no clearly better direction that would justify generating alternatives.

### Review notes and amendments

1. **Matches layout and status:** Keep the summary above the feed and the rail to the right on desktop; collapse the rail beneath the summary on small screens. Show a progress bar only while a real scan/scoring operation reports progress. Do not combine a stale “new matches since digest” count with a progress state that implies those same matches are still being scored. Use a caught-up state when no work is active, and show the last successful scan and per-source status when available. When a source is down, expose a short text status and a readable explanation, not color or a hover-only tooltip alone.
2. **Define feed tabs and counts:** “New” currently mixes “not yet seen,” “new since last digest,” and job lifecycle states across the screen and backend plan. Define these separately in the UI and API contract before wiring filters: the header count is new since the last digest; the New tab should mean matches with no user action yet; Saved and Applied reflect `user_action`; All includes all scored matches except dismissed by default (or make dismissed discoverable through an explicit filter). Make counts follow the visible tab’s actual filter. Keep `status` reserved for the scoring lifecycle as specified in section 5.
3. **Match card anatomy and trust:** Keep title, company, location, source, and posting age together; keep the numeric score with its text band; place compensation fit and up to three relevant tags below the explanation; and keep Apply, Save, and Not relevant grouped at the card end. Do not show a percentage compensation increase or a fit label unless the corresponding salary data supports it. Replace the sample “likely a ~25% comp step up” with a sourced range or neutral “Compensation not listed” copy when data is absent. Label the score as an estimate and give a short explanation of what it measures; avoid presenting it as a probability of getting hired. Preserve the posting’s actual title and show “Posted,” “Updated,” or “Found” according to the timestamp being used.
4. **Actions and feedback:** Apply should open the verified posting URL in a new tab with safe link attributes and mark Applied only when the user activates Apply. Save should toggle to a clear Saved state. Not relevant should dismiss the card and offer a time-limited Undo action. Confirm success or failure inline or with an accessible polite announcement; do not rely on an `alert()` or silent disappearance. These actions must be idempotent and use the ownership-checked endpoint in TASK-055.
5. **Empty, error, and first-run flows:** Keep the no-CV gate to onboarding. Add a no-matches state with a plain explanation and a useful next step (review search preferences or wait for the next scan), distinct from caught-up (“No new matches”) and load/error states. Show a retry path when a feed request fails. Keep onboarding focused on the three stated steps; omit the persistent Matches/Profile/Settings navigation while a user has no CV, or make it clear that onboarding must be completed before those destinations are available. After “Find my matches,” land on Matches and announce the real scanning state.
6. **Profile, privacy, and copy:** Keep raw extracted CV text behind an explicit disclosure, closed by default, with contact details redacted in that view as well as absent from the summary. Make “Looking for” versus “From your CV” labels explainable and visually distinct; provide a way to correct extracted tags, including removal/addition. Change “Edit search” to “Edit profile” or “Edit job preferences” according to the destination so it does not imply a separate search object. Treat the profile file name as private user data and avoid putting it into logs or announcements.
7. **Accessibility and responsive behavior:** Raise all actions, tab controls, switch hit areas, and chip remove/add targets to at least 44×44 CSS pixels; the mockup currently defines 40px buttons and 22px chip remove buttons, and hides desktop navigation at 600px. If the navigation uses `role="tablist"`, implement roving focus, arrow-key movement, and correct `aria-controls`/tabpanel relationships; otherwise use ordinary navigation links with `aria-current` and avoid tab semantics. Provide persistent visible focus, descriptive labels for score and source status, an accessible progress value/text only when known, polite announcements for scan/action updates, and reduced-motion behavior for loading skeletons and transitions. Verify 200% zoom and narrow reflow without horizontal scrolling.

### Build-plan changes

- **TASK-054:** Keep the foundation scope. Ensure onboarding is a distinct route/state that omits or disables main-app navigation until onboarding completes. Use semantic navigation links or implement the full tab keyboard contract; include shared accessible focus, live-region, and reduced-motion primitives in the foundation.
- **TASK-055:** Amend the API contract before implementation to distinguish `new_since_last_digest` from matches with no `user_action`. Define whether dismissed matches appear under All and how tab counts are computed. Return source status text/reason and a truthful progress state only if the backend can provide one; do not manufacture a percentage from scan timestamps. Preserve the scoring `status` lifecycle and enforce ownership/idempotency for actions.
- **TASK-056:** Keep the Matches view and planned states, and add explicit no-results, request-error/retry, and action-undo/confirmation states. Render compensation only when supported by posting/profile data; avoid inferred salary percentages. Use real apply URLs, score explanations, and source health copy. Meet 44px targets and card action semantics above; don't show progress for scheduled work unless actual progress is returned.
- **TASK-057:** Keep onboarding and Profile view scopes. Include CV PII redaction in the explicit extracted-text disclosure, explain and edit both tag groups, make compensation optional, and preserve keyboard-accessible upload/paste and disclosure behavior.
- **TASK-058:** Keep Settings scope, but ensure the digest/source controls are the authoritative editable controls and the Matches rail is read-only with an Edit link. Ensure destructive data deletion has a clear confirmation step and status feedback.
- **TASK-059:** Keep verification as the release gate; explicitly capture the signed-in returning-user Matches state, all feed states (including no CV, caught up, no matches, source down, load failure, and action feedback), Profile, Settings, and each onboarding step at desktop and 375px. Verify keyboard-only navigation, visible focus, screen-reader names/live updates, actual contrast, 44px targets, reduced motion, and 200% zoom. Compare the built views against the mockup, while treating the amendments above as acceptance criteria; verify real API data and absence of raw CV contact details before release.
