# Python match analysis in scheduled matching

The scheduled GitHub Actions worker runs `scripts/match_analysis.py` for each
due user's saved CV/profile and every new shortlisted posting. TypeScript keeps
ownership of scraping, filtering, scheduling, persistence, and user-facing
results. The Python score is saved through the existing match persistence path.
Only low signal-coverage cases are sent to the LLM for review; those LLM results
replace the Python score when available. If the Python worker fails, a bounded
LLM fallback scores up to 30 candidates so the cron can still make progress.
Interactive matching continues to use the existing LLM scoring path.

The worker reads a JSON request from stdin and writes a versioned JSON response
to stdout. CV/profile/job content is passed through a local process pipe; the
worker does not make network requests, create files, or log content. The
TypeScript adapter processes postings in chunks of 50, enforces an 8-second
timeout per chunk, and validates each response.

The initial score is explainable and rule-based:

- role family and target-title match: up to 35 points
- overlap between candidate skills and skills mentioned in the posting: up to 40
- experience requirement and seniority fit: up to 20
- location preference fit: up to 5

The worker also returns a signal-coverage estimate, component scores, matched
skills, unmatched skills mentioned in each posting, and short reason strings.
Signal coverage measures available input signals; it is not a calibrated
probability that a match is correct. Mentioned skills are not treated as
confirmed requirements. LLM fallback defaults to signal coverage below 0.65,
with a limit of 10 candidates per user/run. Override these limits with
`PYTHON_MATCH_LLM_FALLBACK_COVERAGE` and `PYTHON_MATCH_LLM_FALLBACK_LIMIT`.
If Python is unavailable, `PYTHON_MATCH_FAILURE_FALLBACK_LIMIT` controls the
bounded fallback and defaults to 30.

## Paired scorer evaluation

The manual `Paired Python vs LLM Score Comparison` GitHub Actions workflow
evaluates the same persisted Python-scored user/job pairs with the LLM scorer.
It writes comparison rows to `jm_score_comparisons`, keyed by a run ID, without
changing `jm_user_job_matches` or sending email. The run stores only numeric
scores, Python signal coverage, and the LLM provider; it does not store CV text,
job descriptions, or LLM reasoning. Aggregate output includes mean absolute
score difference, exact score agreement, Spearman rank correlation, and top-10
ranking overlap per profile. Signal coverage describes input completeness, not
score accuracy.

The worker can be run locally with:

```sh
printf '%s' '{"profile":{"targetDesignation":"Software Engineer"},"jobs":[]}' | python3 scripts/match_analysis.py
```
