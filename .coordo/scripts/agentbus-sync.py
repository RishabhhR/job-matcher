#!/usr/bin/env python3
import asyncio
import os
import re
import subprocess
from pathlib import Path

from agentbus.daemon.server import build_runtime_config
from agentbus.runtime.engine import Runtime
from agentbus.schema import EventRecord, utcnow
from agentbus.sdk.base import BaseAgent


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
agentbus_inbox_dir = root / ".coordo" / "agentbus" / "inbox"
agentbus_log_path = root / ".coordo" / "agentbus" / "handoff.log"
MAX_CLAUDE_CHUNKS_PER_RUN = 1


def read_ledger_content():
    if not ledger_path.exists():
        return ""
    return ledger_path.read_text(encoding="utf-8")


def read_digest(agent):
    return run_command_capture("coordo", ["digest", "--as", agent])


def digest_has_changes(digest_text):
    return "✅ No new commits since last checkpoint." not in digest_text


def run_command_capture(command, args):
    try:
        result = subprocess.run(
            [command, *args],
            cwd=str(root),
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError as err:
        return f"({command} unavailable: {err})"
    return (result.stdout + result.stderr).strip()


def run_command_live(command, args, input_text=None):
    try:
        kwargs = {
            "cwd": str(root),
            "text": True,
            "check": False,
        }
        if input_text is not None:
            kwargs["input"] = input_text
        result = subprocess.run([command, *args], **kwargs)
    except FileNotFoundError as err:
        raise RuntimeError(f"{command} unavailable: {err}") from err

    if result.returncode != 0:
        raise RuntimeError(f"{command} exited with {result.returncode}")


def parse_ledger_items(agent):
    content = read_ledger_content()
    if not content:
        return []

    lines = content.splitlines()
    items = []
    current_item = None
    current_section = "intro"
    actionable_statuses = {"open", "in-progress"}

    def flush():
        nonlocal current_item
        if current_item and current_item["status"] in actionable_statuses and current_item["to"] == agent:
            items.append(current_item)
        current_item = None

    for line in lines:
        if line.startswith("## "):
            flush()
            current_section = line.strip()
            continue

        if line.startswith("### "):
            flush()
            match = re.match(r"^###\s+\[([A-Z]+-\d+)\]\s+(.+)$", line)
            if not match:
                continue

            metadata = {}
            for token in match.group(2).split():
                colon_idx = token.find(":")
                if colon_idx != -1:
                    metadata[token[:colon_idx]] = token[colon_idx + 1 :]

            current_item = {
                "id": match.group(1),
                "header": line.strip(),
                "body": [],
                "section": current_section,
                "status": metadata.get("status", "open"),
                "from": metadata.get("from", "default"),
                "to": metadata.get("to", "default"),
                "opened": metadata.get("opened", ""),
            }
            continue

        if current_item:
            current_item["body"].append(line)

    flush()
    return items


def summarize_items(items):
    if not items:
        return "None."

    rendered = []
    for item in items:
        body = "\n".join(item["body"]).strip()
        body_text = body if body else "(no details)"
        title = re.sub(r"^###\s+\[[^\]]+\]\s+", "", item["header"])
        rendered.append(f"- [{item['id']}] {title}\n{body_text}")
    return "\n\n".join(rendered)


def build_agent_brief(agent, status_text=None, digest_text=None, items=None, trigger_reasons=None):
    status = status_text if status_text is not None else run_command_capture("coordo", ["status"])
    digest = digest_text if digest_text is not None else read_digest(agent)
    items = items if items is not None else parse_ledger_items(agent)
    trigger_reasons = trigger_reasons or []
    trigger_block = "\n".join(f"- {reason}" for reason in trigger_reasons) if trigger_reasons else "- none"

    return f"""# Agent Brief: {agent}

Generated: {utcnow().isoformat()}

## Ledger Status
{status or "No status available."}

## Trigger Reasons
{trigger_block}

## Digest Since Last Checkpoint
{digest or "No digest available."}

## Open Items Assigned To You
{summarize_items(items)}

## Operating Rules
- Treat this brief as the source of truth for the current turn.
- Work the assigned items without waiting for the human unless you are blocked by access, ambiguity, or an external dependency.
- Update .coordo/ledger.md with progress, then run `coordo checkpoint --as {agent}` when the work is done.
- If you cannot make progress, record the blocker in the ledger and stop cleanly.
"""


def write_agent_brief(agent, brief):
    agentbus_inbox_dir.mkdir(parents=True, exist_ok=True)
    brief_path = agentbus_inbox_dir / f"{agent}.md"
    brief_path.write_text(brief, encoding="utf-8")
    return brief_path


def append_handoff_log(line):
    agentbus_log_path.parent.mkdir(parents=True, exist_ok=True)
    with agentbus_log_path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def checkpoint_agent(agent):
    print(f"🧭 [AgentBus] Forcing checkpoint for {agent}")
    append_handoff_log(f"[{utcnow().isoformat()}] checkpoint {agent}")
    try:
        run_command_live("coordo", ["checkpoint", "--as", agent])
        return True
    except Exception as err:
        print(f"❌ [AgentBus] Checkpoint for {agent} failed: {err}")
        return False


def has_open_tasks_for(agent):
    return bool(parse_ledger_items(agent))


class ClaudeAgent(BaseAgent):
    name = "claude"
    capabilities = ["code", "design"]

    def subscriptions(self):
        return ["TASK.claude", "DECISION.claude"]

    def handle_event(self, event: EventRecord) -> None:
        print(f"\n🤖 [AgentBus] ClaudeAgent handling event: {event.event_type}")
        claude_items = parse_ledger_items("claude")
        claude_reason = f"Open work assigned to claude in the coordo ledger ({len(claude_items)} item{'s' if len(claude_items) != 1 else ''})."
        brief = build_agent_brief(
            "claude",
            digest_text=read_digest("claude"),
            items=claude_items,
            trigger_reasons=[claude_reason],
        )
        brief_path = write_agent_brief("claude", brief)
        print(f"🟦 Claude trigger: {claude_reason}")
        append_handoff_log(f"[{utcnow().isoformat()}] dispatch claude {brief_path}")
        prompt = (
            f"Open {brief_path}. Resolve the assigned work, update .coordo/ledger.md, "
            "checkpoint, and exit. If blocked, record the blocker and stop."
        )
        print("🤖 [AgentBus] Executing Claude Code in autonomous mode...")
        try:
            run_command_live("claude", ["-p", prompt, "--permission-mode", "acceptEdits"])
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
        antigravity_items = parse_ledger_items("antigravity")
        antigravity_digest = read_digest("antigravity")
        trigger_reasons = []
        if antigravity_items:
            trigger_reasons.append("Open work assigned to antigravity in the coordo ledger.")
        if digest_has_changes(antigravity_digest):
            trigger_reasons.append("Claude or another agent landed new commits since antigravity's last checkpoint.")

        brief = build_agent_brief(
            "antigravity",
            digest_text=antigravity_digest,
            items=antigravity_items,
            trigger_reasons=trigger_reasons,
        )
        brief_path = write_agent_brief("antigravity", brief)
        prompt = (
            f"Open {brief_path}. {' '.join(trigger_reasons)} Resolve the assigned work, update .coordo/ledger.md, "
            "checkpoint, and exit. If blocked, record the blocker and stop."
        )

        antigravity_bin = os.environ.get("AGENTBUS_ANTIGRAVITY_BIN")
        if not antigravity_bin:
            print(f"💡 No Antigravity CLI hook configured. Wrote handoff brief at {brief_path} and continuing.")
            append_handoff_log(
                f"[{utcnow().isoformat()}] queued antigravity {brief_path} (no launcher configured)"
            )
            return

        print(f"🟪 Antigravity trigger: {' | '.join(trigger_reasons) if trigger_reasons else 'no explicit reason'}")
        print(f"💡 [AgentBus] Dispatching Antigravity with brief {brief_path}")
        append_handoff_log(
            f"[{utcnow().isoformat()}] dispatch antigravity {brief_path} :: {' '.join(trigger_reasons) if trigger_reasons else 'no explicit reason'}"
        )
        try:
            run_command_live(antigravity_bin, [], prompt)
            print("💡 [AgentBus] Antigravity task completed successfully!")
        except Exception as err:
            print(f"❌ [AgentBus] Antigravity failed: {err}")


async def main():
    print("🔄 Starting AgentBus Coordo Sync Runtime...")

    config = build_runtime_config(root)
    runtime = Runtime(config)

    runtime.register_agent(ClaudeAgent())
    runtime.register_agent(AntigravityAgent())

    for iteration in range(1, 9):
        print(f"\n--- AgentBus Loop Iteration {iteration} ---")

        before = read_ledger_content()
        claude_work = has_open_tasks_for("claude")
        antigravity_work = has_open_tasks_for("antigravity")

        if not claude_work and not antigravity_work:
            if digest_has_changes(read_digest("antigravity")):
                antigravity_work = True
            else:
                print("✅ No open tasks in coordo ledger and no reviewable Claude changes. Sync complete!")
                break

        handled_any = False
        claude_chunks_run = 0

        if claude_work and claude_chunks_run < MAX_CLAUDE_CHUNKS_PER_RUN:
            event = EventRecord(
                event_id=f"evt-{utcnow().timestamp()}",
                project_id=config.project_id,
                session_id=f"{config.project_id}:sync",
                sender="system",
                receiver="claude",
                event_type="TASK.claude",
                payload={"action": "resolve_ledger_items"},
            )
            runtime.publish(event)
            await runtime.dispatch(event)
            if not checkpoint_agent("claude"):
                print("⚠️ [AgentBus] Stopping sync because claude checkpoint failed.")
                break
            claude_chunks_run += 1
            handled_any = True

        refreshed_antigravity_work = has_open_tasks_for("antigravity")
        antigravity_digest = read_digest("antigravity")
        antigravity_digest_changed = digest_has_changes(antigravity_digest)
        if refreshed_antigravity_work or antigravity_digest_changed:
            event = EventRecord(
                event_id=f"evt-{utcnow().timestamp()}",
                project_id=config.project_id,
                session_id=f"{config.project_id}:sync",
                sender="system",
                receiver="antigravity",
                event_type="TASK.antigravity",
                payload={"action": "resolve_ledger_items"},
            )
            runtime.publish(event)
            await runtime.dispatch(event)
            handled_any = True

        after = read_ledger_content()
        if not handled_any or after == before:
            print("⚠️ No ledger progress detected in this cycle. Stopping to avoid a tight loop.")
            break

        await asyncio.sleep(1)


if __name__ == "__main__":
    asyncio.run(main())
