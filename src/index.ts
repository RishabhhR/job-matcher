import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runJobMatcher } from "./runner.js";
import { type Profile } from "./match.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

async function main() {
  const cvText = readFileSync(path.join(dataDir, "cv.txt"), "utf-8");
  const profile: Profile = JSON.parse(readFileSync(path.join(dataDir, "profile.json"), "utf-8"));
  const companies = JSON.parse(readFileSync(path.join(dataDir, "companies.json"), "utf-8"));

  console.log("Starting local Job Matcher runner...");
  
  const scored = await runJobMatcher({
    cvText,
    profile,
    companies,
    linkedin: {
      location: "India",
      maxResults: 25
    },
    onProgress: (status, message) => {
      console.log(`[${status.toUpperCase()}] ${message}`);
    }
  });

  console.log("\n=== Top Job Matches ===\n");
  const top = scored.slice(0, 20);
  for (const m of top) {
    console.log(
      `[${m.fitScore}] ${m.posting.title} @ ${m.posting.company} (${m.posting.location}) — comp: ${m.compFitLabel}`
    );
    console.log(`   ${m.reasoningText}`);
    console.log(`   Apply: ${m.posting.applyUrl}`);
    console.log("");
  }

  writeResultsMarkdown(top, profile);
}

function writeResultsMarkdown(matches: any[], profile: Profile) {
  const resultsDir = path.join(__dirname, "..", "results");
  mkdirSync(resultsDir, { recursive: true });

  const lines = [
    `# Job Matches — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Target designation: **${profile.targetDesignation}** | Current: ${profile.currentTitle} @ ${profile.currentEmployer} (₹${profile.currentSalaryFixedLPA}L fixed + ₹${profile.currentSalaryEsopLPA}L ESOPs)`,
    "",
  ];

  for (const m of matches) {
    lines.push(`## [${m.fitScore}] ${m.posting.title} — ${m.posting.company}`);
    lines.push(`- Location: ${m.posting.location}`);
    lines.push(`- Comp fit: ${m.compFitLabel}`);
    lines.push(`- Source: ${m.posting.source}`);
    lines.push(`- ${m.reasoningText}`);
    lines.push(`- [Apply](${m.posting.applyUrl})`);
    lines.push("");
  }

  writeFileSync(path.join(resultsDir, "latest.md"), lines.join("\n"), "utf-8");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
