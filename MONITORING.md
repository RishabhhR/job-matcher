# Monitoring and parsing diagnostics

JobMatcher can send server-side errors and a small set of product events to PostHog. Telemetry is disabled when `POSTHOG_PROJECT_TOKEN` is unset.

## Configure PostHog

1. Create a PostHog project and copy its **project API key** (`phc_...`). Do not use a personal API key (`phx_...`).
2. Add `POSTHOG_PROJECT_TOKEN` to the Vercel project for Production and Preview, then redeploy.
3. Add the same project key as the GitHub Actions secret `POSTHOG_PROJECT_TOKEN` so scheduled scrape failures are reported.
4. Set `POSTHOG_HOST` only if the project is hosted outside the US cloud. For EU cloud use `https://eu.i.posthog.com` in both places.
5. In PostHog, enable Error Tracking and configure an alert for new `$exception` issues. Use `app=job-matcher` to filter the project.

Client events are authenticated and allowlisted by `/api/events`. Error events include a generic operation name, error type, status code and duration when available. CV text, extracted fields, job descriptions, email addresses, internal user IDs, URLs, and request bodies are not sent. Browser autocapture and session replay are not enabled.

## Events

- CV parsing: `cv_parse_completed`, `$exception` for parser failures, and `cv_upload_success` / `cv_upload_error` from the interface.
- Profile persistence: `profile_save_success` / `profile_save_error`.
- Matches: `match_feed_loaded`, `$exception` for feed failures, and `match_feed_load_success` / `match_feed_load_error` from the interface.
- Match actions: `match_action_success` / `match_action_error` for save, unsave, apply, dismiss, and undo actions.
- Scraping: `scrape_completed` and one `scrape_source_result` per source, including a success flag and posting count.
- Onboarding: `scan_started`, `scan_completed`, and `scan_error`.
- Other diagnostics: `$exception` for parser, scan, scraper, and unhandled request errors; `feed_metadata_invalid` only when malformed feed metadata is found.

Events appear in the project schema after the first occurrence. Events with no matching user action or failure remain absent until that condition happens.

The Matches source panel now reads scrape success separately from posting volume. A healthy scrape that returns zero jobs is labeled as a successful empty result; a failed scrape is labeled as a failed source check. This prevents quiet job boards from being reported as blocked.
