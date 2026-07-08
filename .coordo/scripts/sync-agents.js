#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot() {
  let curr = __dirname;
  while (true) {
    if (existsSync(path.join(curr, ".git")) || existsSync(path.join(curr, ".coordo"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) return process.cwd();
    curr = parent;
  }
}

const root = findProjectRoot();
const ledgerPath = path.join(root, ".coordo", "ledger.md");
const agentbusInboxDir = path.join(root, ".coordo", "agentbus", "inbox");
const agentbusLogPath = path.join(root, ".coordo", "agentbus", "handoff.log");

function readLedgerContent() {
  if (!existsSync(ledgerPath)) return "";
  return readFileSync(ledgerPath, "utf-8");
}

function readDigest(agent) {
  return runCommandCapture("coordo", ["digest", "--as", agent]);
}

function digestHasChanges(digestText) {
  return !digestText.includes("✅ No new commits since last checkpoint.");
}

function runCommandCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    return `(${command} unavailable: ${result.error.message})`;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return `${stdout}${stderr}`.trim();
}

function runCommandLive(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    input,
    stdio: ["pipe", "inherit", "inherit"]
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "unknown status"}`);
  }
}

function parseLedgerItems(agent) {
  const content = readLedgerContent();
  if (!content) return [];

  const lines = content.split(/\r?\n/);
  const items = [];
  let currentItem = null;
  let currentSection = "intro";

  const isActionable = (status) => status === "open" || status === "in-progress";

  const flush = () => {
    if (!currentItem) return;
    if (isActionable(currentItem.status) && currentItem.to === agent) {
      items.push(currentItem);
    }
    currentItem = null;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      currentSection = line.trim();
      continue;
    }

    if (line.startsWith("### ")) {
      flush();
      const match = line.match(/^###\s+\[([A-Z]+-\d+)\]\s+(.+)$/);
      if (!match) continue;

      const metadata = {};
      for (const token of match[2].split(/\s+/)) {
        const colonIdx = token.indexOf(":");
        if (colonIdx !== -1) {
          metadata[token.slice(0, colonIdx)] = token.slice(colonIdx + 1);
        }
      }

      currentItem = {
        id: match[1],
        header: line.trim(),
        body: [],
        section: currentSection,
        status: metadata.status || "open",
        from: metadata.from || "default",
        to: metadata.to || "default",
        opened: metadata.opened || ""
      };
      continue;
    }

    if (currentItem) {
      currentItem.body.push(line);
    }
  }

  flush();
  return items;
}

function summarizeItems(items) {
  if (items.length === 0) {
    return "None.";
  }

  return items
    .map((item) => {
      const body = item.body.join("\n").trim();
      const bodyText = body || "(no details)";
      return `- [${item.id}] ${item.header.replace(/^###\s+\[[^\]]+\]\s+/, "")}\n${bodyText}`;
    })
    .join("\n\n");
}

function buildAgentBrief(agent, options = {}) {
  const status = options.statusText ?? runCommandCapture("coordo", ["status"]);
  const digest = options.digestText ?? readDigest(agent);
  const items = options.items ?? parseLedgerItems(agent);
  const triggerReasons = options.triggerReasons ?? [];
  const triggerBlock = triggerReasons.length > 0
    ? triggerReasons.map((reason) => `- ${reason}`).join("\n")
    : "- none";

  return `# Agent Brief: ${agent}

Generated: ${new Date().toISOString()}

## Ledger Status
${status || "No status available."}

## Trigger Reasons
${triggerBlock}

## Digest Since Last Checkpoint
${digest || "No digest available."}

## Open Items Assigned To You
${summarizeItems(items)}

${agent === "claude" ? `## Claude Role
- You are the verification and release gate.
- Verify, test, and deploy the current implementation instead of building new features.
- If a test fails or a release blocker appears, make only the minimum fix needed to complete verification, then checkpoint and exit.
` : ""}

## Operating Rules
- Treat this brief as the source of truth for the current turn.
- Work the assigned items without waiting for the human unless you are blocked by access, ambiguity, or an external dependency.
- Update .coordo/ledger.md with progress, then run \`coordo checkpoint --as ${agent}\` when the work is done.
- If you cannot make progress, record the blocker in the ledger and stop cleanly.
`;
}

function writeAgentBrief(agent, brief) {
  mkdirSync(agentbusInboxDir, { recursive: true });
  const briefPath = path.join(agentbusInboxDir, `${agent}.md`);
  writeFileSync(briefPath, brief, "utf-8");
  return briefPath;
}

function appendHandoffLog(line) {
  mkdirSync(path.dirname(agentbusLogPath), { recursive: true });
  writeFileSync(agentbusLogPath, `${line}\n`, { flag: "a" });
}

function runClaude(briefPath) {
  console.log(`\n🤖 [Sync] Dispatching Claude with brief ${briefPath}`);
  appendHandoffLog(`[${new Date().toISOString()}] dispatch claude ${briefPath}`);
  const prompt = `Open ${briefPath}. Your role is to verify, test, and deploy the current changes. Do not build new features unless required to fix a failing test or release blocker. Update .coordo/ledger.md with the verification result, checkpoint, and exit. If blocked, record the blocker and stop.`;

  try {
    runCommandLive("claude", ["-p", prompt, "--permission-mode", "acceptEdits"]);
  } catch (err) {
    console.error("\n❌ Claude Code execution finished or hit limits:", err.message);
  }
}

function checkpointAgent(agent) {
  console.log(`🧭 [Sync] Forcing checkpoint for ${agent}`);
  appendHandoffLog(`[${new Date().toISOString()}] checkpoint ${agent}`);
  try {
    runCommandLive("coordo", ["checkpoint", "--as", agent]);
    return true;
  } catch (err) {
    console.error(`❌ Checkpoint for ${agent} failed: ${err.message}`);
    return false;
  }
}

function runAntigravity(briefPath, reasonText) {
  const antigravityBin = process.env.AGENTBUS_ANTIGRAVITY_BIN;
  const prompt = `Open ${briefPath}. ${reasonText ? `Primary trigger: ${reasonText}. ` : ""}Resolve the assigned work, update .coordo/ledger.md, checkpoint, and exit. If blocked, record the blocker and stop.`;

  if (!antigravityBin) {
    console.log(`💡 No Antigravity CLI hook configured. Wrote handoff brief at ${briefPath} and continuing.`);
    appendHandoffLog(`[${new Date().toISOString()}] queued antigravity ${briefPath} (no launcher configured)`);
    return false;
  }

  console.log(`\n💡 [Sync] Dispatching Antigravity with brief ${briefPath}`);
  appendHandoffLog(`[${new Date().toISOString()}] dispatch antigravity ${briefPath} :: ${reasonText || "no explicit reason"}`);
  try {
    runCommandLive(antigravityBin, [], prompt);
    return true;
  } catch (err) {
    console.error("\n❌ Antigravity execution finished or hit limits:", err.message);
    return false;
  }
}

async function runLoop() {
  console.log("🔄 Starting Coordo Autonomous Agent Sync Loop...");

  let iterations = 0;
  const maxIterations = 8;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`\n--- Iteration ${iterations} ---`);

    const before = readLedgerContent();
    const antigravityItems = parseLedgerItems("antigravity");
    const claudeItems = parseLedgerItems("claude");
    const antigravityDigest = readDigest("antigravity");
    const claudeDigest = readDigest("claude");
    const antigravityDigestChanged = digestHasChanges(antigravityDigest);
    const claudeDigestChanged = digestHasChanges(claudeDigest);

    if (
      claudeItems.length === 0 &&
      antigravityItems.length === 0 &&
      !claudeDigestChanged &&
      !antigravityDigestChanged
    ) {
      console.log("✅ No open tasks or decisions in the ledger. Sync complete!");
      break;
    }

    let handledAny = false;
    const antigravityReasons = [];
    if (antigravityItems.length > 0) {
      antigravityReasons.push("Open work assigned to antigravity in the coordo ledger.");
    }
    if (antigravityDigestChanged) {
      antigravityReasons.push("Claude or another agent landed new commits since antigravity's last checkpoint.");
    }

    if (antigravityReasons.length > 0) {
      const brief = buildAgentBrief("antigravity", {
        digestText: antigravityDigest,
        items: antigravityItems,
        triggerReasons: antigravityReasons
      });
      const briefPath = writeAgentBrief("antigravity", brief);
      console.log(`🟪 Antigravity trigger: ${antigravityReasons.join(" | ")}`);
      const antigravityRan = runAntigravity(briefPath, antigravityReasons.join(" "));
      handledAny = handledAny || antigravityRan || !process.env.AGENTBUS_ANTIGRAVITY_BIN;
    }

    const refreshedClaudeItems = parseLedgerItems("claude");
    const refreshedClaudeDigest = readDigest("claude");
    const refreshedClaudeDigestChanged = digestHasChanges(refreshedClaudeDigest);
    const claudeReasons = [];
    if (refreshedClaudeItems.length > 0) {
      claudeReasons.push("Verification work assigned to claude in the coordo ledger.");
    }
    if (refreshedClaudeDigestChanged) {
      claudeReasons.push("New commits landed since Claude's last checkpoint; verify, test, and prepare deployment.");
    }

    if (claudeReasons.length > 0) {
      const brief = buildAgentBrief("claude", {
        digestText: refreshedClaudeDigest,
        items: refreshedClaudeItems,
        triggerReasons: claudeReasons
      });
      const briefPath = writeAgentBrief("claude", brief);
      console.log(`🟦 Claude trigger: ${claudeReasons.join(" | ")}`);
      runClaude(briefPath);
      if (!checkpointAgent("claude")) {
        console.log("⚠️ Stopping sync because claude checkpoint failed.");
        break;
      }
      handledAny = true;
    }

    const after = readLedgerContent();
    if (!handledAny || after === before) {
      console.log("⚠️ No ledger progress detected in this cycle. Stopping to avoid a tight loop.");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

runLoop();
