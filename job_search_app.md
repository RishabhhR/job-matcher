# job-matcher — project context (updated 2026-07-05)

## What this is

A personal job-matching product: scrapes job postings, scores them against Rishabh's CV via an LLM (factoring in current employer/title/salary), and surfaces ranked matches with apply links. Originally scoped as a phased multi-tenant SaaS (full plan at `/Users/rishabhraj/.claude/plans/original_plan_job_search.md`), but has organically grown past the original "Phase 1 CLI script" into a real web app with CV upload, faster than the plan's phase order — see "Current shape" below.

**Heads up for future sessions**: something in this repo auto-commits and auto-pushes changes (conventional-commit-style messages appear in `git log` that neither the user nor a Claude session explicitly requested — e.g. `fix: use dynamic imports for pdf-parse...`). Don't be surprised if `git status` is already clean after an edit, or if the working tree has drifted since you last looked — always re-read a file before editing it, and check `git log` for recent activity before assuming you know the current state.

## Current shape (not just the original Phase 1 CLI)

- **Web app**: Express server (`src/server.ts`) serving a frontend (`public/`) with CV upload (PDF/DOCX/TXT via `pdf-parse`/`mammoth`, dynamically imported inside the request handler — see "Fixed bugs" below), a config form, and SSE-streamed progress (`/api/match`) while the scrape+score pipeline runs.
- **CLI entrypoint** (`src/index.ts`) still exists and still works — reads `data/cv.txt`/`data/profile.json`/`data/companies.json`, runs the same pipeline via `src/runner.ts`, writes `results/latest.md`.
- **Shared pipeline logic** lives in `src/runner.ts` (orchestrator with progress callbacks), used by both the CLI and the server's SSE endpoint.
- **GitHub Actions cron** is now two workflows (`scrape-and-score.yml` at 8am/8pm IST, `send-digest.yml` at 9am/9pm IST — see the dedicated section below) — independent of the new web app.
- **Vercel deployment** is live (`vercel` CLI added as a devDependency, `vercel.json` exists) — the web app is hosted there, and it also has a native cron for the email phase only (see below).

## Where everything lives (spans several locations)

| What | Where |
|---|---|
| Full original architecture plan (Phases 1–4) | `/Users/rishabhraj/.claude/plans/original_plan_job_search.md` |
| This code | `/Users/rishabhraj/Claude Code/job-matcher/` (this directory) |
| Remote repo (private) | [github.com/RishabhhR/job-matcher](https://github.com/RishabhhR/job-matcher) — holds 4 encrypted Action secrets (`CV_TEXT`, `PROFILE_JSON`, `GROQ_API_KEY`, `GEMINI_API_KEY`) for the GitHub Actions cron path |
| Vercel project | Team "Rishabh's projects" (`rishabhs-projects-8310fc71`), project `job-matcher` — deployment via `vercel` CLI, separate from the GitHub Actions path and its secrets (Vercel needs its own env vars configured in its dashboard/CLI — not yet confirmed done) |
| Cross-session memory about this project | `/Users/rishabhraj/.claude/projects/-Users-rishabhraj-Claude-Code/memory/project_job_matcher.md` |
| Sibling project the LLM fallback code was copied from | `/Users/rishabhraj/Claude Code/contextual-labs/lib/ai.ts` → reused as `src/ai.ts` here |
| Local dev launch config (for Claude Code's browser preview tooling) | `/Users/rishabhraj/Claude Code/.claude/launch.json` — entry `job-matcher-web` runs `npm run dev` on port 3000 (note: this is a **workspace-root-level** file shared across all sibling projects, not a per-project one) |

## Code layout (in this directory)

- `src/server.ts` — Express app: `/api/initial-data` (prefill form from local `data/` files), `/api/upload-cv` (parse PDF/DOCX/TXT), `/api/match` (SSE-streamed scrape+score run), static frontend serving
- `src/index.ts` — CLI entrypoint, same pipeline via `runJobMatcher`, writes `results/latest.md`
- `src/runner.ts` — shared orchestrator (scrape ATS boards + LinkedIn → dedup → prefilter → score), used by both `index.ts` and `server.ts`
- `src/scrapers.ts` — Greenhouse/Lever/Ashby public JSON API fetchers (ATS boards, fully ToS-compliant)
- `src/scrapers/linkedin.ts` — LinkedIn via LinkedIn's own **logged-out "guest" job-search endpoint** (`linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`) + public job-view pages for descriptions. Plain HTTP + cheerio, **no headless browser, no login, no LinkedIn account involved**
- `src/normalize.ts` — URL-based dedup across sources
- `src/match.ts` — keyword prefilter + batched LLM scoring, retry/backoff (Groq free tier hits a 12,000 TPM limit under load). **The scoring system prompt now encodes an explicit hike-% and role-level rule** (added 2026-07-05, see below) instead of leaving `comp_fit_label` to the LLM's unstated judgment
- `src/ai.ts` — Groq→Gemini→OpenRouter fallback chain (copied from `contextual-labs/lib/ai.ts`)
- `public/` — frontend (glassmorphic UI per recent commits)
- `data/companies.json` — seed list of verified ATS board tokens (tracked in git)
- `data/cv.txt`, `data/profile.json` — **gitignored, never committed**. Present locally for `npm start`/`npm run dev`; in GitHub Actions CI these are reconstructed from secrets and deleted after the run
- `.github/workflows/scrape-and-score.yml` + `send-digest.yml` — the two-phase cron automation, see dedicated section below
- `.env` — local-only `GROQ_API_KEY`/`GEMINI_API_KEY`/etc. (gitignored)
- `vercel.json` — Vercel build config + a native cron for the email phase only (`/api/cron-match?mode=email`, once daily at 03:30 UTC/9am IST — Hobby plan limit)

## The comp/hike rule now encoded in the matching prompt (2026-07-05)

User asked for the general market rule for judging `comp_fit_label`; this is now baked into `src/match.ts`'s system prompt so scoring is consistent run-to-run instead of vibes-based:

- **downgrade**: estimated total comp >10% below current, or a clear seniority step-down with no offsetting comp increase
- **lateral**: estimated comp within roughly -10% to +20% of current, or same-level title switch without a strong (30%+) jump
- **upgrade**: comp 20%+ above current (30–40%+ is the typical "good move" benchmark in Indian tech/product hiring, 40–60%+ is exceptional), OR one level above current title (e.g. APM → PM) even at similar comp
- Two-or-more-level jumps (e.g. APM → Senior/Group PM) get flagged as a "stretch" in the reasoning text, not treated as routine
- ESOP-heavy offers are discounted vs. fixed cash (illiquid, vesting-dependent) unless the company is late-stage/pre-IPO

## Key decisions — don't relitigate these without new information

- **LLM provider**: user explicitly rejected the Anthropic API for this project. Groq/Gemini/OpenRouter chain only.
- **LinkedIn access**: individual, not an org. Proxycurl is dead (LinkedIn sued them in 2025, shut down under injunction). Solved via the logged-out guest endpoint instead — no account, no login, no ban risk. User initially offered to log into a secondary/burner LinkedIn account to shield their main one; **declined** — that's a ban-evasion pattern, and turned out to be unnecessary once the guest-endpoint approach worked. If the guest endpoint ever gets IP-blocked, the fallback is an Apify LinkedIn Jobs Scraper actor (self-serve, pay-per-result), not an account-based scraper.
- **Hosting**: originally recommended GitHub Actions over Vercel (better fit for scraping workloads). User is now also pursuing a Vercel deployment for the web-app UI layer — both can coexist (Actions for the daily unattended cron, Vercel for an on-demand interactive tool), just note they need separate env var/secret configuration.
- **Secrets discipline**: CV text and salary/employer data live only as GitHub Action secrets, never committed, even in this private repo. Keep this pattern for any new personal data added later (e.g. if Vercel env vars are set up, don't commit `data/cv.txt`/`data/profile.json` there either).

## Fixed bugs (this session, 2026-07-05)

1. **Vercel deploy failure**: `rishabhraj@Rishabhs-MacBook-Air.local attempted to deploy... not a member of the team`. Root cause: git had no `user.name`/`user.email` configured locally, so commits carried git's auto-generated fallback identity (`username@hostname`), which Vercel's Git-integration deploy check couldn't match to any real team member — nothing to do with which Vercel account the CLI was logged into. Fixed via `git config --global user.name "Rishabh Raj"` and `git config --global user.email "rishabh.raj.2002.rr@gmail.com"`. **Caveat**: verify that email actually matches what's listed for this account in the Vercel team's Members page — if Vercel/GitHub login uses a different address (e.g. a GitHub noreply email), this needs adjusting. Commits made before this fix still carry the broken author identity; only rewrite that history if it turns out to still cause problems.
2. **pdf-parse ESM crash on cold start**: `pdf-parse`'s `pdfjs-dist` dependency touches `DOMMatrix` at module top-level scope. An earlier version of `src/server.ts` set a `DOMMatrix` polyfill via an inline `if` block placed textually before a *static* `import * as pdfParseModule from "pdf-parse"` — but ES module imports are hoisted above all other code regardless of source position, so the polyfill ran too late and the import crashed. This was already fixed (by the time this was investigated) by switching to a **dynamic** `await import("pdf-parse")` inside the `/api/upload-cv` handler, which is lazy and correctly runs after the top-level polyfill. Verified via browser preview: server now boots clean with no crash, CV text pre-fills correctly, no console errors.

## How to operate it

- Trigger a scrape+score run manually: `gh workflow run scrape-and-score.yml` (from this directory)
- Trigger an email-send run manually: `gh workflow run send-digest.yml`
- Check recent runs: `gh run list --workflow=scrape-and-score.yml --limit 3` (or `send-digest.yml`)
- Rotate/update a GitHub secret: `gh secret set <NAME>` (e.g. `gh secret set PROFILE_JSON < data/profile.json` after editing salary/designation)
- Run the CLI locally: `npm start` (writes `results/latest.md`, no DB/email involved — needs `.env` with `GROQ_API_KEY`/`GEMINI_API_KEY`, and `data/cv.txt` + `data/profile.json` present)
- Run the full digest locally (DB + email, both phases at once): `npm run digest` (or `DIGEST_MODE=scrape npm run digest`, `DIGEST_MODE=email npm run digest` to test one phase; `DIGEST_SLOT=am`/`pm` to force a slot) — needs the same env vars plus `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`/`RESEND_API_KEY`
- Run the web app locally: `npm run dev` (same env requirements; serves on port 3000)
- Preview in Claude Code: use the `job-matcher-web` entry in the root `launch.json` (see table above) rather than a fresh Bash server — needed for `preview_*` tool verification

## Mailer + Turso DB + twice-daily cron (built 2026-07-05)

Implemented per the user's ask to "move to mailer at 9am/9pm, DB in Turso, and crons." **Verified working end-to-end**: a real test run wrote 1 user/profile/6 postings/6 matches to Turso and Resend returned a real message ID for a sent email.

- **DB**: `src/db.ts` — full multi-tenant schema (`jm_users`, `jm_user_profiles`, `jm_cvs`, `jm_job_postings`, `jm_job_posting_requirements`, `jm_user_job_matches`, `jm_scrape_runs`, `jm_email_send_log`), `jm_`-prefixed since **this reuses the same Turso database as fittrack** (per the user's explicit instruction — same `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, not a separate DB). `jm_email_send_log` has a `UNIQUE(user_id, send_date, slot)` constraint that makes re-running the same slot/day a no-op (idempotent).
- **Mailer**: `src/mailer.ts` — Resend SDK, sends from `onboarding@resend.dev` (no domain verification needed for personal use), simple inline-HTML digest template.
- **Orchestrator**: `src/digest.ts` — exports `runDigest({ slot?, mode? })`, also runnable directly via `npm run digest` (reads `DIGEST_SLOT`/`DIGEST_MODE` env vars if no options passed). Migrates the DB, resolves user/profile/CV (from local files or, if absent, from Turso via `DIGEST_USER_EMAIL`), checks `jm_email_send_log` for idempotency, then branches on `mode`.

### Split into two crons with a "patience window" (2026-07-05, per user's request to avoid rate limits)

Rather than one script doing scrape+score+email in a single run against a tight time budget, the pipeline is now split into two independent phases an hour apart, so the scoring phase can patiently ride out rate limits instead of racing the clock:

- **`DIGEST_MODE=scrape`** (`.github/workflows/scrape-and-score.yml`, 8am/8pm IST i.e. 02:30/14:30 UTC) — scrapes + scores + persists postings/matches to Turso, does **not** send email. Runs with `patient: true` passed to `runJobMatcher` (`src/runner.ts`), which switches `src/match.ts`'s retry behavior from `FAST_RETRY` (3 retries, capped at 20s backoff) to `PATIENT_RETRY` (8 retries, backoff capped at 2 minutes) — since this phase has a full hour before anything actually gets sent, it's worth waiting out rate limits rather than giving up and skipping batches.
- **`DIGEST_MODE=email`** (`.github/workflows/send-digest.yml`, 9am/9pm IST i.e. 03:30/15:30 UTC) — no scraping/LLM calls at all, just reads whatever's currently in `jm_user_job_matches` for the user and sends the digest. Cheap and fast regardless of how the scrape phase went.
- Both workflows independently reconstruct `data/cv.txt`/`profile.json` from GitHub secrets and resolve their own slot (am/pm) from `github.event.schedule`, same pattern as before.
- `patient` only applies when `mode === "scrape"` — the interactive web UI's `/api/match` (SSE) and manual `mode=all` runs stay on the fast/interactive retry settings, since nothing should hang for minutes on a live user-facing request.

### Multiple triggers exist for the email phase — this is intentional and safe now

Earlier in this project there were multiple *scrape-mode* triggers overlapping (my GH Actions path, a Gemini-built Vercel-hosted `/api/cron-match` path, and a native Vercel cron), which was a real problem: scraping calls the LLM, so redundant scrape triggers roughly doubled Groq/Gemini quota use — this is what caused a test run to hit Groq's 100k-token daily cap and Gemini's own quota mid-run, only scoring 6 of ~63 shortlisted postings that time.

After the scrape/email split, this is much less risky: **only `scrape-and-score.yml` calls the LLM.** `vercel.json` still has a native cron hitting `/api/cron-match?mode=email` once daily (Hobby plan limit) at 03:30 UTC/9am IST, which overlaps with `send-digest.yml`'s "am" run — but `mode=email` is just a cheap DB read + Resend send, gated by `jm_email_send_log`'s `UNIQUE(user_id, send_date, slot)` constraint, so whichever fires first sends the email and the other harmlessly no-ops. Two other things worth knowing if touching this again:

- **Vercel Deployment Protection (SSO wall) blocks external calls to `/api/cron-match`** — confirmed by curling the live production URL directly: an unauthenticated request gets a `302` redirect to `vercel.com/sso-api`. Vercel's *own* native cron invocations bypass this (trusted internal caller), but any external ping (e.g. a GH Actions curl step) would not — that path would need either Deployment Protection disabled for Production, or a "Protection Bypass for Automation" secret passed from the caller. Dashboard-only, not doable via the `vercel` CLI.
- **Vercel's `includeFiles: ["data/**"]` doesn't rescue gitignored files** — confirmed deploys are git-integration-triggered (`Cloning github.com/RishabhhR/job-matcher` in build logs), so `data/cv.txt`/`profile.json` never exist in the build source regardless of `includeFiles`. That trick only works for local CLI-uploaded deploys. This is why `runDigest()` has the Turso DB-fallback path (`getUserByEmail`/`getActiveCvText`/`getUserProfileRow` in `src/db.ts`, gated on `DIGEST_USER_EMAIL`) — it's the actual fix, already wired up with the right env vars on Vercel.

## Known rough edges

- Groq free tier (12,000 TPM *and* 100k tokens/day) gets rate-limited under batch scoring load, worse when multiple sessions/workflows test concurrently (see above) — Gemini fallback catches per-minute limits automatically, but both providers hitting their daily cap simultaneously means some batches just get skipped (logged, not fatal, but fewer matches that run).
- LinkedIn guest-endpoint scraping currently only targets India + the profile's `targetDesignation` as a single keyword — no multi-location or multi-title fan-out yet.
- ATS seed company list (`data/companies.json`) is a small, manually verified set — extend it if match variety feels thin.
- `results/latest.md` (from the old `npm start` CLI path) is no longer updated by the cron — the DB + email are now the source of truth. The CLI script and that file still exist for local ad-hoc runs.

## Not built yet

No multi-tenant auth/CV-upload-per-user wiring the DB schema was built for (schema supports it, but only one `jm_users` row exists — the app itself doesn't yet let a second person sign up and use it). No hosted dashboard reading from Turso (data's there, but only queryable via script/CLI right now). See the original plan file for the full Phase 3–4 roadmap if resuming that track.

## Confirmed: both Vercel's native cron and GitHub Actions cron running is fine (2026-07-05)

User explicitly confirmed running both is acceptable, not a bug to fix further. Recap of why it's safe: Vercel's native cron (`vercel.json`, `mode=email`, once daily at 9am IST) and GitHub's `send-digest.yml` (9am **and** 9pm IST) can both fire for the "am" slot — but `mode=email` never calls the LLM, it's just a DB read + Resend send gated by `jm_email_send_log`'s unique constraint on `(user_id, send_date, slot)`. Whichever fires first sends; the other sees "already sent" and no-ops. No wasted quota, no duplicate email. **Do not re-flag this as redundant/needs-fixing in future sessions** — it's a deliberately accepted final state, not leftover cleanup.

## Session log (running notes, kept up to date so context can be cleared)

Per user's request, this file is being kept current as a substitute for conversation history — read this section plus the rest of the file before assuming anything about current state, rather than relying on chat scrollback.

- **2026-07-04**: Phase 1 built (scrape + match CLI), deployed via GitHub Actions cron. LinkedIn solved via logged-out guest endpoint (no login/account risk). Groq/Gemini fallback chain reused from `contextual-labs` per user's explicit rejection of Anthropic API.
- **2026-07-05 early**: User + a parallel Gemini session (same repo) independently built a full web app (Express + CV upload + Vercel deploy) on top of Phase 1. Found and fixed a git-identity bug breaking Vercel deploys, and confirmed an ESM import-hoisting bug in PDF parsing was already fixed by the time it was checked.
- **2026-07-05 midday**: Built Turso DB (multi-tenant schema, `jm_`-prefixed, shares fittrack's database per user's instruction), Resend mailer, and twice-daily cron. Found and resolved a triple-redundant-cron situation (mine + Gemini's GH-Actions-pings-Vercel + a native Vercel cron), fixed Vercel's missing DB/CV access (DB-fallback read path + env vars), and documented (unresolved by design, not by me) Vercel's Deployment Protection blocking external pings.
- **2026-07-05 later**: User asked to avoid rate limits by splitting into two crons an hour apart ("8am scrape, wait, 9am send"). Found the parallel Gemini session had already built exactly this split (`scrape-and-score.yml` + `send-digest.yml`, `DIGEST_MODE` env var) — added the missing piece, actual patient-retry logic (`PATIENT_RETRY` in `match.ts`: 8 retries/2min-capped-backoff vs. the fast path's 3 retries/20s). User then confirmed running both Vercel's native cron and GitHub's cron simultaneously is fine (see section above) — not something to consolidate further.
- **2026-07-05 evening**: User reported a real quality bug from an actual received email — postings requiring e.g. 8 years of experience were scoring well for a candidate with ~2 years. Root cause: the scoring prompt only asked the LLM to infer years-of-experience (YoE) from unstructured CV prose, which is unreliable. Fix: added `profile.careerStartDate` (`"2024-07-01"`), compute YoE deterministically in code (`computeYearsOfExperience` in `match.ts`), and pass the number explicitly into the prompt with an instruction to cap `fit_score` at 30 or lower when a posting's stated requirement clearly exceeds it. Added `career_start_date` column to `jm_user_profiles` via an `ALTER TABLE` migration (table already existed in the live DB). Parallel Gemini session had independently already added a (weaker, LLM-inference-based) version of this same rule, plus a separate, complementary feature: configurable location preferences (`preferredCountry`/`preferredCity` in profile + DB schema) replacing a hardcoded India/Bengaluru filter — both merged in cleanly. `data/profile.json` now has `careerStartDate: "2024-07-01"`, `preferredCountry: "India"`, `preferredCity: "Bengaluru"`; `PROFILE_JSON` GitHub secret re-synced to match.
- **Found mid-fix**: local `.env` got wiped to all-empty values (Turso/Groq/Gemini/Resend keys, `DIGEST_USER_EMAIL`) — likely an accidental `vercel env pull` overwrite, since Vercel can't retrieve "Sensitive"-type env vars back down (they pull as empty strings). Restored by re-copying from the original sources (`contextual-labs/.env.local` for Groq/Gemini, `fittrack/.env` for Turso). This only affects local dev convenience — GitHub Actions secrets and Vercel's own env vars were unaffected. If `.env` looks empty again later, this is why.
- **Live verification blocked**: both Groq (100k/day token cap) and Gemini (own quota) were still exhausted from today's combined testing (this session + the parallel Gemini session) when trying to verify the experience-scoring fix with an isolated test script. Code is typechecked and logically sound but not yet confirmed against a real LLM response as of this note — retry once Groq's daily quota resets (was ~30-40 min out) or check tonight's actual 8pm scrape run's results for postings with explicit YoE requirements.
- **2026-07-05 evening (2)**: User asked to filter searches to India/Bengaluru across all platforms. Found this was already half-built by the parallel Gemini session (`preferredCountry`/`preferredCity` in `Profile`, `filterByLocation()` in `runner.ts`) but only applied to ATS postings — LinkedIn results bypassed the filter entirely, relying only on a loose location-string search hint that doesn't reliably restrict results. Fixed by applying `filterByLocation()` to LinkedIn postings too. Verified without burning LLM quota (pure scrape+filter, no scoring involved): a Bengaluru-targeted LinkedIn search kept 10/10 results, a US-targeted search correctly dropped 10/10. `data/profile.json` has `preferredCountry: "India"`, `preferredCity: "Bengaluru"` (secret re-synced).
- **2026-07-05 evening (3) — five-item final check requested by user**:
  1. Both crons confirmed active and correctly scheduled: `scrape-and-score.yml` (8am/8pm IST), `send-digest.yml` (9am/9pm IST) — `gh workflow list` shows both `active`.
  2. Two-phase patient/fast split confirmed correct (8am scrape patiently → 9am send whatever's ready), no changes needed.
  3. LinkedIn result cap raised from 25 → 100 everywhere (was already done in `digest.ts` by the parallel session; extended to `index.ts`, `server.ts`'s legacy fallback, `scrapers/linkedin.ts`'s own default, and the web UI's form default).
  4. More free LLM fallbacks: parallel session added Cerebras + Mistral call functions to `src/ai.ts` and wired `CEREBRAS_API_KEY`/`MISTRAL_API_KEY` into both workflows' env — but **neither secret actually exists yet** (`gh secret list` confirms), so those tiers are currently silent no-ops. Added a real, zero-signup win instead: Groq tracks quota **per model**, so `callLLM` now tries `llama-3.3-70b-versatile` first, then falls back to `llama-3.1-8b-instant` on the *same* API key (14,400 req/day & 500K tokens/day vs. the 70b model's 1K req/day & 100K tokens/day) before moving to Gemini/Cerebras/Mistral/OpenRouter. Verified live: with the 70b model still mid-rate-limit, a real call succeeded via `groq-8b`. Cerebras (1M tokens/day free, no card) and OpenRouter (28+ `:free` models, no card, ~50 req/day free-tier cap) are the strongest remaining candidates if the user wants to actually activate those tiers — needs the user to sign up, not resolvable by me.
  5. Added Preferred Country / Preferred City fields to the web UI (`public/index.html` + `app.js`), wired through prefill and submission. Verified via browser preview.
- **2026-07-05 evening (4)**: User provided `MISTRAL_API_KEY` and `CEREBRAS_API_KEY` (signed up for both). Stored in local `.env`, GitHub secrets, and Vercel production env (Vercel already had them from the parallel session). Testing revealed the Cerebras call was hardcoded to model `"llama-3.3-70b"`, which doesn't exist on this account — `GET /v1/models` showed the real available models are `gpt-oss-120b`, `zai-glm-4.7`, `gemma-4-31b`. Fixed to use `gpt-oss-120b` (matches Cerebras's documented 1M tokens/day free tier, strongest of the three). Both Cerebras and Mistral now verified working with real API calls. **Fallback chain is now, in priority order: Groq (llama-3.3-70b-versatile) → Groq (llama-3.1-8b-instant, same key) → Gemini → Cerebras (gpt-oss-120b) → Mistral (mistral-small-latest) → OpenRouter (no key set, still a no-op).**
- **2026-07-05 evening (5)**: User hit "Failed to parse file: Class constructor PDFParse cannot be invoked without 'new'" uploading a PDF in the live web app. Root cause: `pdf-parse` v2.4.5 changed its API from v1 — it now exports a class (`PDFParse`) instead of a callable function, but `src/server.ts`'s `/api/upload-cv` handler still called it the v1 way. Fixed to `new PDFParse({ data: buffer })` then `.getText()`. Verified locally against a real running server with the actual CV PDF (3608 chars extracted successfully). Pushed → new Vercel deployment went live (confirmed via `vercel ls`). Could not verify the *production* URL directly — my curl requests get the same Deployment Protection 302-to-SSO redirect documented earlier for `/api/cron-match` (this only blocks non-browser requests; the user's own logged-in browser isn't affected) — asked the user to retry in-browser and confirm.
- **Open/unresolved**: Vercel Deployment Protection still blocks any *external*/non-browser request to any API route (`/api/cron-match`, `/api/upload-cv`, confirmed twice now) — would matter if `cron.yml`'s schedule is ever re-enabled, and means I can't directly curl-test the production deployment myself, only verify locally + ask the user to confirm in-browser. Needs a manual dashboard change by the user, not resolvable via CLI or code. No multi-tenant auth/dashboard built yet (Phase 3+ of the original plan). Experience-aware scoring fix (earlier log entry) still awaiting live LLM confirmation once Groq's 70b-model daily quota resets (a scheduled check-in is pending for this).
