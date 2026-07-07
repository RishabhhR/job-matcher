#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function hasOpenTasksFor(agent) {
  if (!existsSync(ledgerPath)) return false;
  const content = readFileSync(ledgerPath, "utf-8");
  const sections = content.split("## Resolved / Log")[0];
  const lines = sections.split("\n");
  for (const line of lines) {
    if (line.startsWith("### [") && line.includes("status:open") && line.includes(`to:${agent}`)) {
      return true;
    }
  }
  return false;
}

function runClaude() {
  console.log("\n🤖 [Sync] Executing Claude Code in print mode...");
  const prompt = `Review .coordo/ledger.md. If there are any open tasks or decisions assigned to you (claude), or if a decision has been answered, address them, write the code/mockups, update the ledger, checkpoint, and exit. If there are no open items, reply 'No items' and exit.`;
  
  try {
    execSync(`claude -p "${prompt}" --permission-mode acceptEdits < /dev/null`, {
      cwd: root,
      stdio: "inherit"
    });
  } catch (err) {
    console.error("\n❌ Claude Code execution finished or hit limits:", err.message);
  }
}

function runLoop() {
  console.log("🔄 Starting Coordo Autonomous Agent Sync Loop...");
  
  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`\n--- Iteration ${iterations} ---`);
    
    const claudeHasWork = hasOpenTasksFor("claude");
    const antigravityHasWork = hasOpenTasksFor("antigravity");
    
    if (!claudeHasWork && !antigravityHasWork) {
      console.log("✅ No open tasks or decisions in the ledger. Sync complete!");
      break;
    }
    
    if (claudeHasWork) {
      runClaude();
      execSync("sleep 1");
    } else if (antigravityHasWork) {
      console.log("\n💡 [Sync] Open task/decision detected for 'antigravity'.");
      console.log("👉 Please open the Antigravity TUI or desktop panel and process your assigned tasks.");
      console.log("👉 Once complete, mark the task as done, and re-run this script.");
      break;
    }
  }
}

runLoop();
