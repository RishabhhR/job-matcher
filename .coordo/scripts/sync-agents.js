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

  const flush = () => {
    if (!currentItem) return;
    if (currentItem.status === "open" && currentItem.to === agent) {
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

function runClaude(briefPath) {
  console.log("\n🤖 [Sync] Executing Claude Code in print mode...");
  const prompt = `Open ${briefPath}. Resolve the assigned work, update .coordo/ledger.md, checkpoint, and exit. If blocked, record the blocker and stop.`;

  try {
    runCommandLive("claude", ["-p", prompt, "--permission-mode", "acceptEdits"]);
  } catch (err) {
    console.error("\n❌ Claude Code execution finished or hit limits:", err.message);
  }
}

function runAntigravity(briefPath, reasonText) {
  const antigravityBin = process.env.AGENTBUS_ANTIGRAVITY_BIN;
  const prompt = `Open ${briefPath}. ${reasonText ? `Primary trigger: ${reasonText}. ` : ""}Resolve the assigned work, update .coordo/ledger.md, checkpoint, and exit. If blocked, record the blocker and stop.`;

  if (!antigravityBin) {
    console.log(`💡 No Antigravity CLI hook configured. Wrote handoff brief at ${briefPath} and continuing.`);
    return false;
  }

  console.log("\n💡 [Sync] Executing Antigravity in autonomous mode...");
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
    const claudeItems = parseLedgerItems("claude");
    const antigravityItems = parseLedgerItems("antigravity");

    if (claudeItems.length === 0 && antigravityItems.length === 0) {
      console.log("✅ No open tasks or decisions in the ledger. Sync complete!");
      break;
    }

    let handledAny = false;

    if (claudeItems.length > 0) {
      const claudeDigestBefore = readDigest("claude");
      const brief = buildAgentBrief("claude", {
        digestText: claudeDigestBefore,
        items: claudeItems,
        triggerReasons: ["Open work assigned to claude in the coordo ledger."]
      });
      const briefPath = writeAgentBrief("claude", brief);
      runClaude(briefPath);
      handledAny = true;
    }

    const antigravityItemsAfterClaude = parseLedgerItems("antigravity");
    const antigravityDigest = readDigest("antigravity");
    const antigravityDigestChanged = digestHasChanges(antigravityDigest);
    const antigravityReasons = [];
    if (antigravityItemsAfterClaude.length > 0) {
      antigravityReasons.push("Open work assigned to antigravity in the coordo ledger.");
    }
    if (antigravityDigestChanged) {
      antigravityReasons.push("Claude or another agent landed new commits since antigravity's last checkpoint.");
    }

    if (antigravityReasons.length > 0) {
      const brief = buildAgentBrief("antigravity", {
        digestText: antigravityDigest,
        items: antigravityItemsAfterClaude,
        triggerReasons: antigravityReasons
      });
      const briefPath = writeAgentBrief("antigravity", brief);
      const antigravityRan = runAntigravity(briefPath, antigravityReasons.join(" "));
      handledAny = handledAny || antigravityRan || !process.env.AGENTBUS_ANTIGRAVITY_BIN;
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
