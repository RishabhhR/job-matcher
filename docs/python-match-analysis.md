# Python match analysis shadow mode

The hourly GitHub Actions worker runs `scripts/match_analysis.py` on the same
fresh candidate set that the TypeScript LLM scorer receives. TypeScript keeps
ownership of scraping, filtering, scheduling, persistence, and user-facing
scores. Python results are comparison-only and are never written to Turso or
shown to users while shadow mode is active.

The worker reads a JSON request from stdin and writes a versioned JSON response
to stdout. CV/profile/job content is passed through a local process pipe; the
worker does not make network requests, create files, or log content. The
TypeScript adapter enforces an 8-second timeout, validates the response, and
continues the existing scoring flow if Python is unavailable.

The initial score is explainable and rule-based:

- role family and target-title match: up to 35 points
- overlap between candidate skills and skills mentioned in the posting: up to 40
- experience requirement and seniority fit: up to 20
- location preference fit: up to 5

The worker also returns confidence, component scores, matched skills, unmatched
skills mentioned in each posting, and short reason strings. Mentioned skills are
not treated as confirmed requirements. The cron logs only aggregate comparison measures: paired score
count, Spearman rank correlation, top-10 overlap, and mean absolute score
difference. These measures help decide whether the rules rank jobs similarly
to the current scorer; they do not establish that either ranking predicts
application success. Weight changes should be evaluated against user outcomes
such as saved and applied jobs before Python scores replace LLM scores.

The worker can be run locally with:

```sh
printf '%s' '{"profile":{"targetDesignation":"Software Engineer"},"jobs":[]}' | python3 scripts/match_analysis.py
```
