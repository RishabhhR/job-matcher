# Job Matcher: current implementation and follow-up criteria

Last reconciled: 2026-10-14.

## Current architecture

- Clerk identifies production users. The API verifies the session token, resolves the Clerk user server-side, and uses only that user's verified primary email to associate the Turso account.
- Turso/libSQL remains the system of record for users, profile/CV, job postings, matches, digest attempts, and per-user ATS company selections. Tables use the `jm_` prefix because this database is shared with another project.
- Express serves the API and `public/` serves the dashboard. Interactive matching and CV upload require an authenticated Clerk session in production.
- `.github/workflows/cron-hourly.yml` is the only scheduled digest workflow. It evaluates each user's configured local hour, records an atomic per-user/day claim, and uses a stable Resend idempotency key. The legacy fixed-time workflows and Vercel cron schedule have been removed.
- `.github/workflows/ci.yml` runs TypeScript typechecking and unit tests on pushes to `main` and pull requests.
- LLM scoring validates complete, unique, in-range results. Exhausted scoring batches fail the run instead of appearing as a successful partial result.
- Digest email HTML escapes scraped and generated content and only includes HTTPS apply links.

## Production configuration

Keep credentials in GitHub Actions, Vercel, and local ignored `.env` files. Required values are `CLERK_SECRET_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, LLM provider keys, and `RESEND_API_KEY`. `CRON_SECRET` is needed only if the protected legacy `/api/cron-match` route is intentionally used. Do not put personal CV/profile data in the repository or workflow logs.

## Database decision

Do not migrate to MongoDB at this stage. The current schema is relational and uses SQL joins, uniqueness constraints, and atomic conditional writes for identity binding and digest claims. MongoDB would require rewriting queries, migrations, indexes, and transactional workflows without a demonstrated workload or product requirement that benefits from document storage. Revisit only with measured Turso limits or a concrete document-oriented requirement.

## Follow-up criteria

- Add integration tests against a disposable Turso-compatible database for account ownership and concurrent digest claims.
- Add monitoring for scrape-source failures and provider usage so empty results can be distinguished from upstream outages.
- Reassess database choice if measured latency, write volume, or relational scaling becomes a product constraint.
