import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Profile } from "./match.js";
import type { RawPosting } from "./scrapers.js";

export interface PythonMatchAnalysis {
  index: number;
  score: number;
  signalCoverage: number;
  components: Record<string, number>;
  matchedSkills: string[];
  unmatchedMentionedSkills: string[];
  reasons: string[];
  /** Rules that capped the score, e.g. "early_career_senior" (TASK-102). */
  caps?: string[];
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
  return (async () => {
    const results: PythonMatchAnalysis[] = [];
    const chunkSize = 50;
    for (let start = 0; start < postings.length; start += chunkSize) {
      const chunkResults = await runPythonMatchAnalysisChunk(
        cvText,
        profile,
        postings.slice(start, start + chunkSize),
        timeoutMs,
      );
      results.push(...chunkResults.map((result) => ({ ...result, index: result.index + start })));
    }
    return results;
  })();
}

function runPythonMatchAnalysisChunk(
  cvText: string,
  profile: Profile,
  postings: RawPosting[],
  timeoutMs: number,
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
          Number.isFinite(result.signalCoverage) && result.signalCoverage >= 0 && result.signalCoverage <= 1 &&
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

export interface ShadowAgreement {
  pairs: number;
  spearman: number | null;
  topOverlap: string;
  meanAbsoluteDifference: number | null;
  sameGoodCall: string;
}

function averageRanks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    for (let i = start; i < end; i++) ranks[sorted[i].index] = (start + 1 + end) / 2;
    start = end;
  }
  return ranks;
}

/**
 * How closely Python agrees with the LLM on the postings both scored (TASK-102): rank
 * correlation, top-10 overlap, mean absolute score gap, and how often both make the
 * same "good" (>= 60) call. Logged each scheduled run; aggregates only, no content.
 */
export function shadowAgreement(pairs: Array<{ python: number; llm: number }>, goodAt = 60): ShadowAgreement {
  const n = pairs.length;
  const sameGood = pairs.filter((p) => (p.python >= goodAt) === (p.llm >= goodAt)).length;
  if (n < 2) return { pairs: n, spearman: null, topOverlap: "n/a", meanAbsoluteDifference: n ? Math.abs(pairs[0].python - pairs[0].llm) : null, sameGoodCall: `${sameGood}/${n}` };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rp = averageRanks(pairs.map((p) => p.python));
  const rl = averageRanks(pairs.map((p) => p.llm));
  const mp = mean(rp), ml = mean(rl);
  const cov = mean(rp.map((r, i) => (r - mp) * (rl[i] - ml)));
  const sp = Math.sqrt(mean(rp.map((r) => (r - mp) ** 2)));
  const sl = Math.sqrt(mean(rl.map((r) => (r - ml) ** 2)));
  const k = Math.min(10, n);
  const top = (key: "python" | "llm") => new Set(pairs.map((p, i) => ({ s: p[key], i })).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.i));
  const tp = top("python"), tl = top("llm");
  return {
    pairs: n,
    spearman: sp && sl ? Number((cov / (sp * sl)).toFixed(3)) : null,
    topOverlap: `${[...tp].filter((i) => tl.has(i)).length}/${k}`,
    meanAbsoluteDifference: Number(mean(pairs.map((p) => Math.abs(p.python - p.llm))).toFixed(1)),
    sameGoodCall: `${sameGood}/${n}`,
  };
}
