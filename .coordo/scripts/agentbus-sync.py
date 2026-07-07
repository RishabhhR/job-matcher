#!/usr/bin/env python3
import asyncio
import os
import sys
import subprocess
from pathlib import Path
from agentbus.sdk.base import BaseAgent
from agentbus.schema import EventRecord, EventStatus, RuntimeConfig, EventQuery, utcnow
from agentbus.runtime.engine import Runtime
from agentbus.daemon.server import build_runtime_config

# Helper to find project root
def find_project_root():
    curr = Path(__file__).resolve().parent
    while True:
        if (curr / ".git").exists() or (curr / ".coordo").exists():
            return curr
        parent = curr.parent
        if parent == curr:
            return Path(os.getcwd())
        curr = parent

root = find_project_root()
ledger_path = root / ".coordo" / "ledger.md"

class ClaudeAgent(BaseAgent):
    name = "claude"
    capabilities = ["code", "design"]

    def subscriptions(self):
        return ["TASK.claude", "DECISION.claude"]

    def handle_event(self, event: EventRecord) -> None:
        print(f"\n🤖 [AgentBus] ClaudeAgent handling event: {event.event_type}")
        prompt = (
            "Review .coordo/ledger.md. If there are any open tasks or decisions assigned to you (claude), "
            "or if a decision has been answered, address them, write the code/mockups, update the ledger, "
            "checkpoint, and exit. If there are no open items, reply 'No items' and exit."
        )
        print("🤖 [AgentBus] Executing Claude Code in print mode...")
        try:
            # Run Claude CLI non-interactively
            subprocess.run(
                ["claude", "-p", prompt, "--permission-mode", "acceptEdits"],
                cwd=str(root),
                stdin=subprocess.DEVNULL,
                check=True
            )
            print("🤖 [AgentBus] Claude Code completed successfully!")
        except Exception as err:
            print(f"❌ [AgentBus] Claude Code failed: {err}")

class AntigravityAgent(BaseAgent):
    name = "antigravity"
    capabilities = ["code", "reasoning"]

    def subscriptions(self):
        return ["TASK.antigravity", "DECISION.antigravity"]

    def handle_event(self, event: EventRecord) -> None:
        print(f"\n💡 [AgentBus] AntigravityAgent handling event: {event.event_type}")
        print("👉 Open task/decision detected for 'antigravity' in coordo ledger.")
        print("👉 Please open the Antigravity TUI or desktop panel and process your assigned tasks.")
        input("👉 Once complete, mark the task as done, and press [Enter] here to continue...")
        print("💡 [AgentBus] Antigravity task marked as complete.")

def has_open_tasks_for(agent: str) -> bool:
    if not ledger_path.exists():
        return False
    content = ledger_path.read_text(encoding="utf-8")
    sections = content.split("## Resolved / Log")[0]
    lines = sections.split("\n")
    for line in lines:
        if line.startswith("### [") and "status:open" in line and f"to:{agent}" in line:
            return True
    return False

async def main():
    print("🔄 Starting AgentBus Coordo Sync Runtime...")
    
    # Build configuration for current project directory
    config = build_runtime_config(root)
    runtime = Runtime(config)
    
    # Register agents
    runtime.register_agent(ClaudeAgent())
    runtime.register_agent(AntigravityAgent())
    
    # Run loop
    for iteration in range(1, 6):
        print(f"\n--- AgentBus Loop Iteration {iteration} ---")
        
        claude_work = has_open_tasks_for("claude")
        antigravity_work = has_open_tasks_for("antigravity")
        
        if not claude_work and not antigravity_work:
            print("✅ No open tasks in coordo ledger. Sync complete!")
            break
            
        if claude_work:
            event = EventRecord(
                event_id=f"evt-{utcnow().timestamp()}",
                project_id=config.project_id,
                session_id=f"{config.project_id}:sync",
                sender="system",
                receiver="claude",
                event_type="TASK.claude",
                payload={"action": "resolve_ledger_items"}
            )
            runtime.publish(event)
            await runtime.dispatch(event)
            
        elif antigravity_work:
            event = EventRecord(
                event_id=f"evt-{utcnow().timestamp()}",
                project_id=config.project_id,
                session_id=f"{config.project_id}:sync",
                sender="system",
                receiver="antigravity",
                event_type="TASK.antigravity",
                payload={"action": "resolve_ledger_items"}
            )
            runtime.publish(event)
            await runtime.dispatch(event)
            
        # Yield to allow event loop processing
        await asyncio.sleep(1)

if __name__ == "__main__":
    asyncio.run(main())
