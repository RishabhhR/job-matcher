
<!-- coordo:start -->
## Multi-Agent Coordination (coordo)
This project is coordinated with Google Antigravity via a shared ledger at `.coordo/ledger.md`.

At the start of a session:
1. Run `coordo status` — leads with any open decisions blocking work.
2. Run `coordo digest --as claude` — shows what changed since you last checked.

Read or edit `.coordo/ledger.md` directly, or use `coordo task` / `coordo decision`.

**Development protocol (ledger-first, always):**
1. **Before writing any code**, add a `coordo task` describing the piece you intend to build, which files it touches, and your approach — after first checking it is actually doable (read the relevant code). If `coordo status` shows the other agent already claimed an overlapping task, pick something else or raise a `coordo decision` instead of duplicating.
2. Commit the ledger claim to git **before** starting the code change, so the other agent sees it even mid-flight.
3. Do the work; commit the code referencing the task id (e.g. "TASK-007: ...").
4. Mark it `coordo task done <id> --note "..."` with what changed, which files, and how it was verified.
5. **Review the other agent's completed work**: when `coordo digest --as claude` shows their commits, read the diff, and record the review outcome as a note or a new task/decision if you find problems. Don't silently rewrite their code — raise a decision first.

Claude's default lane in this project is verification and release: verify, test, and deploy Antigravity's implementation changes. If something needs implementation to complete a release, keep the fix minimal and treat the result as a verification step rather than a new feature sprint.

Before ending a session (or after a handoff-worthy change), run `coordo checkpoint --as claude`.
<!-- coordo:end -->
