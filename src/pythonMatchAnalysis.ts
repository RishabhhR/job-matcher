import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Profile } from "./match.js";
import type { RawPosting } from "./scrapers.js";

export interface PythonMatchAnalysis {
  index: number;
  score: number;
  confidence: number;
  components: Record<string, number>;
  matchedSkills: string[];
  unmatchedMentionedSkills: string[];
  reasons: string[];
}

interface PythonWorkerOutput {
  version: number;
  results: PythonMatchAnalysis[];
}

const scriptPath = fileURLToPath(new URL("../scripts/match_analysis.py", import.meta.url));

/** Runs the local deterministic scorer over JSON pipes; it never writes input or output to disk. */
export function runPythonMatchAnalysis(
  cvText: string,
  profile: Profile,
  postings: RawPosting[],
  timeoutMs = 8_000,
): Promise<PythonMatchAnalysis[]> {
  if (postings.length === 0) return Promise.resolve([]);

  const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  const payload = JSON.stringify({
    cvText,
    profile: {
      targetDesignation: profile.targetDesignation,
      currentTitle: profile.currentTitle,
      careerStartDate: profile.careerStartDate,
      preferredCountry: profile.preferredCountry,
      preferredCity: profile.preferredCity,
      skills: profile.skills ?? [],
    },
    jobs: postings.map((posting, index) => ({
      index,
      title: posting.title,
      location: posting.location,
      descriptionText: posting.descriptionText,
    })),
  });

  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, results: PythonMatchAnalysis[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(results);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Python match-analysis worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(new Error("Python match-analysis worker returned oversized output"));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on("error", (error) => finish(new Error(`Could not start Python match-analysis worker: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Python match-analysis worker exited with code ${code}${stderr ? ` (${stderr.trim()})` : ""}`));
        return;
      }
      try {
        const output = JSON.parse(stdout) as PythonWorkerOutput;
        if (output.version !== 1 || !Array.isArray(output.results) || output.results.length !== postings.length) {
          throw new Error("worker response shape mismatch");
        }
        const valid = output.results.every((result, index) =>
          result && result.index === index && Number.isFinite(result.score) && result.score >= 0 && result.score <= 100 &&
          Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1 &&
          result.components && typeof result.components === "object" &&
          Array.isArray(result.matchedSkills) && Array.isArray(result.unmatchedMentionedSkills) && Array.isArray(result.reasons));
        if (!valid) throw new Error("worker returned invalid score fields");
        finish(undefined, output.results);
      } catch (error) {
        finish(new Error(`Invalid Python match-analysis response: ${(error as Error).message}`));
      }
    });
    child.stdin.on("error", (error) => finish(new Error(`Could not send input to Python match-analysis worker: ${error.message}`)));
    child.stdin.end(payload);
  });
}
