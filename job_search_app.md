# job-matcher — project context (updated 2026-07-05)

## What this is

A personal job-matching product: scrapes job postings, scores them against Rishabh's CV via an LLM (factoring in current employer/title/salary), and surfaces ranked matches with apply links. Originally scoped as a phased multi-tenant SaaS (full plan at `/Users/rishabhraj/.claude/plans/original_plan_job_search.md`), but has organically grown past the original "Phase 1 CLI script" into a real web app with CV upload, faster than the plan's phase order — see "Current shape" below.

**Heads up for future sessions**: something in this repo auto-commits and auto-pushes changes (conventional-commit-style messages appear in `git log` that neither the user nor a Claude session explicitly requested — e.g. `fix: use dynamic imports for pdf-parse...`). Don't be surprised if `git status` is already clean after an edit, or if the working tree has drifted since you last looked — always re-read a file before editing it, and check `git log` for recent activity before assuming you know the current state.

## Current shape (not just the original Phase 1 CLI)

- **Web app**: Express server (`src/server.ts`) serving a frontend (`public/`) with CV upload (PDF/DOCX/TXT via `pdf-parse`/`mammoth`, dynamically imported inside the request handler — see "Fixed bugs" below), a config form, and SSE-streamed progress (`/api/match`) while the scrape+score pipeline runs.
- **CLI entrypoint** (`src/index.ts`) still exists and still works — reads `data/cv.txt`/`data/profile.json`/`data/companies.json`, runs the same pipeline via `src/runner.ts`, writes `results/latest.md`.
- **Shared pipeline logic** lives in `src/runner.ts` (orchestrator with progress callbacks), used by both the CLI and the server's SSE endpoint.
- **GitHub Actions cron** (`.github/workflows/daily-scrape.yml`) still runs the CLI path daily (9am IST) — independent of the new web app.
- **Vercel deployment** is now also in progress (`vercel` CLI added as a devDependency, `vercel.json` exists) — the user is trying to host the web app there in addition to/instead of relying solely on GitHub Actions.

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
- `.github/workflows/daily-scrape.yml` — cron automation (03:30 UTC = 9am IST daily, plus manual `workflow_dispatch`)
- `.env` — local-only `GROQ_API_KEY`/`GEMINI_API_KEY` (gitignored)
- `vercel.json` — Vercel build config (includes `public/` static assets per a recent fix commit)

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

- Trigger a GitHub Actions run manually: `gh workflow run daily-scrape.yml` (from this directory)
- Check the latest Actions run: `gh run list --workflow=daily-scrape.yml --limit 3`
- Rotate/update a GitHub secret: `gh secret set <NAME>` (e.g. `gh secret set PROFILE_JSON < data/profile.json` after editing salary/designation)
- Run the CLI locally: `npm start` (writes `results/latest.md`, no DB/email involved — needs `.env` with `GROQ_API_KEY`/`GEMINI_API_KEY`, and `data/cv.txt` + `data/profile.json` present)
- Run the full digest locally (DB + email): `npm run digest` (or `DIGEST_SLOT=am npm run digest` / `DIGEST_SLOT=pm npm run digest` to force a slot) — needs the same env vars plus `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`/`RESEND_API_KEY`
- Run the web app locally: `npm run dev` (same env requirements; serves on port 3000)
- Preview in Claude Code: use the `job-matcher-web` entry in the root `launch.json` (see table above) rather than a fresh Bash server — needed for `preview_*` tool verification

## Mailer + Turso DB + twice-daily cron (built 2026-07-05)

Implemented per the user's ask to "move to mailer at 9am/9pm, DB in Turso, and crons." **Verified working end-to-end**: a real test run wrote 1 user/profile/6 postings/6 matches to Turso and Resend returned a real message ID for a sent email.

- **DB**: `src/db.ts` — full multi-tenant schema (`jm_users`, `jm_user_profiles`, `jm_cvs`, `jm_job_postings`, `jm_job_posting_requirements`, `jm_user_job_matches`, `jm_scrape_runs`, `jm_email_send_log`), `jm_`-prefixed since **this reuses the same Turso database as fittrack** (per the user's explicit instruction — same `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`, not a separate DB). `jm_email_send_log` has a `UNIQUE(user_id, send_date, slot)` constraint that makes re-running the same slot/day a no-op (idempotent).
- **Mailer**: `src/mailer.ts` — Resend SDK, sends from `onboarding@resend.dev` (no domain verification needed for personal use), simple inline-HTML digest template.
- **Orchestrator**: `src/digest.ts` — exports `runDigest({ slot? })`, also runnable directly via `npm run digest`. Migrates the DB, upserts user/profile/CV, checks `jm_email_send_log` for idempotency, runs the scrape+match pipeline, persists postings/matches, sends the email, logs the result.
- **Cron**: `.github/workflows/daily-scrape.yml` is the **single active** twice-daily trigger (03:30 UTC/9am IST and 15:30 UTC/9pm IST), running `npm run digest` directly inside GitHub Actions with all secrets reconstructed at runtime.

### Why there's a disabled second workflow (`.github/workflows/cron.yml`)

A parallel Gemini session (same repo, run by the user directly) built an alternate architecture: a thin GH Actions job that pings a Vercel-hosted `/api/cron-match` endpoint (in `src/server.ts`), which itself calls `runDigest()`. Both workflows ended up scheduled for the same times, which caused two real problems discovered during verification:
1. It roughly doubles Groq/Gemini free-tier quota consumption — this is what caused a test run to hit Groq's 100k-token daily cap and Gemini's own quota mid-run, only scoring 6 of ~63 shortlisted postings that time.
2. The Vercel path doesn't actually work yet: `vercel env ls` shows Vercel has `RESEND_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY` but **no `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`**, and `data/cv.txt`/`profile.json` are gitignored so they don't exist in the Vercel deployment either — hitting that endpoint today would 500.

Resolution: kept `daily-scrape.yml` (proven working) as the sole scheduled trigger; `cron.yml`'s `schedule:` block was removed (left as `workflow_dispatch`-only, not deleted) so it can be fixed and re-enabled later if the Vercel-hosted path is ever wanted instead. If resuming that path: add the two Turso env vars to Vercel, and either commit CV/profile into the DB-only flow (already possible — `runDigest()` could be changed to read CV/profile from `jm_cvs`/`jm_user_profiles` once seeded, instead of local files, making the Vercel endpoint fully self-sufficient) — don't run both schedules at once again.

## Known rough edges

- Groq free tier (12,000 TPM *and* 100k tokens/day) gets rate-limited under batch scoring load, worse when multiple sessions/workflows test concurrently (see above) — Gemini fallback catches per-minute limits automatically, but both providers hitting their daily cap simultaneously means some batches just get skipped (logged, not fatal, but fewer matches that run).
- LinkedIn guest-endpoint scraping currently only targets India + the profile's `targetDesignation` as a single keyword — no multi-location or multi-title fan-out yet.
- ATS seed company list (`data/companies.json`) is a small, manually verified set — extend it if match variety feels thin.
- `results/latest.md` (from the old `npm start` CLI path) is no longer updated by the cron — the DB + email are now the source of truth. The CLI script and that file still exist for local ad-hoc runs.

## Not built yet

No multi-tenant auth/CV-upload-per-user wiring the DB schema was built for (schema supports it, but only one `jm_users` row exists — the app itself doesn't yet let a second person sign up and use it). No hosted dashboard reading from Turso (data's there, but only queryable via script/CLI right now). See the original plan file for the full Phase 3–4 roadmap if resuming that track.
