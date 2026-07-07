
<!-- coordo:start -->
## Multi-Agent Coordination (coordo)
This project is coordinated with Claude Code via a shared ledger at `.coordo/ledger.md`.

At the start of a session:
1. Run `coordo status` — leads with any open decisions blocking work.
2. Run `coordo digest --as antigravity` — shows what changed since you last checked.

Read or edit `.coordo/ledger.md` directly, or use `coordo task` / `coordo decision`.
Before ending a session (or after a handoff-worthy change), record any new decisions/tasks and run `coordo checkpoint --as antigravity`.
<!-- coordo:end -->

## Multi-Agent Development Workflow Rules
- **Before Picking Any Development**:
  1. Always run `coordo status` and read the ledger first to identify what other agents are working on.
  2. Before changing any code, log a new task in `coordo` claiming the piece (e.g., `coordo task add "..." --from antigravity --to antigravity`) to declare your ownership.
  3. Ensure the task is doable and does not overlap with ongoing work.
- **After Completing Development**:
  1. Register the completion details by marking your task as done in `coordo` (e.g., `coordo task done TASK-NNN --note "..."`).
  2. Set your checkpoint (e.g., `coordo checkpoint --as antigravity`) and commit/push your changes.
  3. Review the other agent's done notes and code approaches before starting the next cycle.
