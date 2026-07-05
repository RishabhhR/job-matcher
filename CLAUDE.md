
<!-- coordo:start -->
## Multi-Agent Coordination (coordo)
This project is coordinated with Google Antigravity via a shared ledger at `.coordo/ledger.md`.

At the start of a session:
1. Run `coordo status` — leads with any open decisions blocking work.
2. Run `coordo digest --as claude` — shows what changed since you last checked.

Read or edit `.coordo/ledger.md` directly, or use `coordo task` / `coordo decision`.
Before ending a session (or after a handoff-worthy change), record any new decisions/tasks and run `coordo checkpoint --as claude`.
<!-- coordo:end -->
