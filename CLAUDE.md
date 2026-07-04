# job-matcher — context for future sessions

## What this is

A personal (Phase 1 of a planned multi-tenant) job-matching product: scrapes job postings daily, scores them against Rishabh's CV using an LLM (factoring in current employer/salary), and outputs a ranked list with apply links. Full multi-phase architecture (auth, email digest, multi-tenant SaaS) is designed but not yet built — see the plan file at `/Users/rishabhraj/.claude/plans/graceful-whistling-penguin.md` for the complete Phase 1–4 roadmap.

**Current status: Phase 1 is built, deployed, and running daily for free.** Nothing beyond Phase 1 (no auth, no email, no multi-tenant DB) exists yet.

## Where everything lives (this product spans several locations)

| What | Where |
|---|---|
| Full architecture plan (Phases 1–4) | `/Users/rishabhraj/.claude/plans/graceful-whistling-penguin.md` |
| This code (Phase 1 pipeline) | `/Users/rishabhraj/Claude Code/job-matcher/` (this directory) |
| Remote repo (private) | [github.com/RishabhhR/job-matcher](https://github.com/RishabhhR/job-matcher) — holds the 4 encrypted Action secrets below, and is where the daily workflow actually executes |
| Persistent cross-session memory about this project | `/Users/rishabhraj/.claude/projects/-Users-rishabhraj-Claude-Code/memory/project_job_matcher.md` (indexed in that folder's `MEMORY.md`) |
| Sibling reference project the LLM code was copied from | `/Users/rishabhraj/Claude Code/contextual-labs/lib/ai.ts` (Groq→Gemini→OpenRouter fallback chain, reused verbatim as `src/ai.ts` here) |
| Sibling reference project for the Vercel+Turso pattern | `/Users/rishabhraj/Claude Code/fittrack` — **not used in this project**, kept only as prior-art reference |

## Code layout (in this directory)

- `src/index.ts` — orchestrator: reads `data/cv.txt` + `data/profile.json` + `data/companies.json`, runs scrape → dedup → prefilter → score, writes `results/latest.md`
- `src/scrapers.ts` — Greenhouse/Lever/Ashby public JSON API fetchers (ATS boards, fully ToS-compliant)
- `src/scrapers/linkedin.ts` — LinkedIn scraper via LinkedIn's own **logged-out "guest" job-search endpoint** (`linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`) + public job-view pages for descriptions. Plain HTTP + cheerio, **no headless browser, no login, no LinkedIn account involved at all**
- `src/normalize.ts` — URL-based dedup across sources
- `src/match.ts` — keyword prefilter + batched LLM scoring (with retry/backoff since Groq's free tier hits a 12,000 TPM rate limit under load)
- `src/ai.ts` — Groq→Gemini→OpenRouter fallback chain (copied from `contextual-labs/lib/ai.ts`)
- `data/companies.json` — seed list of verified ATS board tokens (tracked in git)
- `data/cv.txt`, `data/profile.json` — **gitignored, never committed**. Locally present for `npm start`; in CI these are reconstructed from GitHub secrets and deleted after the run
- `.github/workflows/daily-scrape.yml` — the cron automation (03:30 UTC = 9am IST daily, plus manual `workflow_dispatch`)
- `.env` — local-only `GROQ_API_KEY`/`GEMINI_API_KEY` (gitignored)

## Key decisions — don't relitigate these without new information

- **LLM provider**: user explicitly rejected the Anthropic API for this project. Use the existing Groq/Gemini/OpenRouter chain only.
- **LinkedIn access**: user is an individual, not an org. Proxycurl (a paid LinkedIn data API) is **dead** — LinkedIn sued them in Jan 2025 for fake-account scraping, shut down under injunction mid-2025. We solved LinkedIn access via the logged-out guest endpoint instead (see above) — no account, no login, no ban risk. User initially offered to log into a secondary/burner LinkedIn account to shield their main one from bans; that was declined (ban-evasion pattern, and the logged-out endpoint made it unnecessary anyway). If the guest endpoint ever gets IP-blocked, the next fallback is an Apify LinkedIn Jobs Scraper actor (self-serve, pay-per-result, no business verification) — not an account-based scraper.
- **Hosting**: GitHub Actions, not Vercel — Vercel serverless doesn't fit long-running/browser-style scraping well (though this scraper turned out not to need a browser at all). GitHub Actions is free, scheduled, and needs no server to stay up.
- **Secrets discipline**: CV text and salary/employer data are stored ONLY as GitHub Action secrets (`CV_TEXT`, `PROFILE_JSON`, `GROQ_API_KEY`, `GEMINI_API_KEY`), never committed to git, even though the repo is private. Keep this pattern for any new personal data added later.

## How to operate it

- Trigger a run manually: `gh workflow run daily-scrape.yml` (from this directory, or after `cd` into it)
- Check the latest run: `gh run list --workflow=daily-scrape.yml --limit 3`
- Latest ranked matches: `results/latest.md` in the repo (updated daily by the Action, or `git pull` locally)
- Rotate/update a secret: `gh secret set <NAME>` (e.g. re-run `gh secret set PROFILE_JSON < data/profile.json` after editing salary/designation)
- Run locally: `npm start` (needs `.env` with `GROQ_API_KEY`/`GEMINI_API_KEY`, and `data/cv.txt` + `data/profile.json` present)

## Known rough edges

- Groq free tier (12,000 TPM) gets rate-limited under the daily batch scoring load; Gemini fallback catches it automatically, but this is worth revisiting if scoring quality/latency ever becomes a problem.
- LinkedIn guest-endpoint scraping currently only targets India + the profile's `targetDesignation` as a single keyword — no multi-location or multi-title fan-out yet.
- ATS seed company list (`data/companies.json`) is a small, manually verified set — extend it if match variety feels thin.

## Not built yet (see the plan file for full detail)

Phase 2 (deploy web app + single daily email), Phase 3 (multi-tenant auth, CV upload UI, twice-daily per-timezone digest), Phase 4 (hardening). Currently this is still a single-user, no-auth, no-email pipeline — just automated and free.
