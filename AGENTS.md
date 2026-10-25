
<!-- coordo:start -->
## Multi-Agent Coordination (coordo)
This project is coordinated with Claude Code via a shared ledger at `.coordo/ledger.md`.

At the start of a session:
1. Run `coordo status` — leads with any open decisions blocking work.
2. Run `coordo digest --as antigravity` — shows what changed since you last checked.

Read or edit `.coordo/ledger.md` directly, or use `coordo task` / `coordo decision`.

**Development protocol (ledger-first, always):**
1. **Before writing any code**, add a `coordo task` describing the piece you intend to build, which files it touches, and your approach — after first checking it is actually doable (read the relevant code). If `coordo status` shows the other agent already claimed an overlapping task, pick something else or raise a `coordo decision` instead of duplicating.
2. Commit the ledger claim to git **before** starting the code change, so the other agent sees it even mid-flight.
3. Do the work; commit the code referencing the task id (e.g. "TASK-007: ...").
4. Mark it `coordo task done <id> --note "..."` with what changed, which files, and how it was verified.
5. **Review the other agent's completed work**: when `coordo digest --as antigravity` shows their commits, read the diff, and record the review outcome as a note or a new task/decision if you find problems. Don't silently rewrite their code — raise a decision first.

Claude's default lane in this project is verification and release: verify, test, and deploy Antigravity's implementation changes. If something needs implementation to complete a release, keep the fix minimal and treat the result as a verification step rather than a new feature sprint.

Before ending a session (or after a handoff-worthy change), run `coordo checkpoint --as antigravity`.
<!-- coordo:end -->

## Production deployment guardrail

Read [DEPLOYMENT_POLICY.md](DEPLOYMENT_POLICY.md) before any deployment work. Production deploys require a clear user request; commits, verification, and routine agent work do not authorize a deploy.

## Multi-Agent Development Workflow Rules
- **Before Picking Any Development**:
  1. Always run `coordo status` and read the ledger first to identify what other agents are working on.
  2. Before changing any code, log a new task in `coordo` claiming the piece (e.g., `coordo task add "..." --from antigravity --to antigravity`) to declare your ownership.
  3. Ensure the task is doable and does not overlap with ongoing work.
- **After Completing Development**:
  1. Register the completion details by marking your task as done in `coordo` (e.g., `coordo task done TASK-NNN --note "..."`).
  2. Set your checkpoint (e.g., `coordo checkpoint --as antigravity`) and commit/push your changes.
  3. Review the other agent's done notes and code approaches before starting the next cycle.

Default role split:
- Antigravity owns implementation work.
- Claude owns verification, testing, and deploy validation.
