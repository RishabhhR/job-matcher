import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPythonMatchAnalysis, shadowAgreement } from "../src/pythonMatchAnalysis.js";
import type { RawPosting } from "../src/scrapers.js";

const desc = "Own the product roadmap, run experimentation and SQL analysis, and work cross-functional with engineering and design. ".repeat(3);
const posting = (title: string, i: number): RawPosting => ({
  source: "greenhouse", sourceJobId: String(i), company: "Acme", title, location: "Bengaluru, India",
  applyUrl: `https://jobs.example.com/${i}`, descriptionText: desc,
});
const profile = (careerStartDate: string) => ({
  targetDesignation: "Product Manager", currentEmployer: "Acme", currentTitle: "Product Manager",
  currentSalaryFixedLPA: 0, currentSalaryEsopLPA: 0, currentSalaryCurrency: "INR", careerStartDate, preferredCity: "Bengaluru",
}) as any;

test("Python caps senior titles for early careers, incl. 'Sr.' (TASK-102)", async () => {
  const titles = ["Senior Product Manager", "Sr. Product Manager, Digital Services AI", "Product Manager"];
  const out = await runPythonMatchAnalysis("Product manager. SQL, experimentation, roadmap.", profile("2024-07-01"), titles.map(posting));
  assert.equal(out[0].score, 20);
  assert.ok(out[0].caps?.includes("early_career_senior"));
  assert.equal(out[1].score, 20, "'Sr.' must count as senior");
  assert.ok(out[2].score > 20);
  // An experienced profile is not capped.
  const senior = await runPythonMatchAnalysis("Product manager. SQL, experimentation, roadmap.", profile("2015-01-01"), [posting("Senior Product Manager", 0)]);
  assert.ok(senior[0].score > 20 && !(senior[0].caps ?? []).length);
});

test("Python caps internships for experienced profiles and other role families", async () => {
  const out = await runPythonMatchAnalysis("Product manager. SQL, experimentation, roadmap.", profile("2022-01-01"),
    [posting("Associate Product Manager Intern", 0), posting("Software Engineer", 1)]);
  assert.equal(out[0].score, 35);
  assert.ok(out[0].caps?.includes("overqualified_intern"));
  assert.ok(out[1].score <= 30);
  assert.ok(out[1].caps?.includes("other_role_family"));
  // Someone without experience yet is not penalised for an internship.
  const fresh = await runPythonMatchAnalysis("Product manager. SQL, experimentation, roadmap.", profile(new Date().toISOString().slice(0, 7)), [posting("Product Manager Intern", 0)]);
  assert.ok(!(fresh[0].caps ?? []).includes("overqualified_intern"));
});

test("shadowAgreement: identical, reversed and tiny inputs", () => {
  const same = shadowAgreement([{ python: 90, llm: 90 }, { python: 50, llm: 50 }, { python: 20, llm: 20 }]);
  assert.equal(same.spearman, 1);
  assert.equal(same.topOverlap, "3/3");
  assert.equal(same.meanAbsoluteDifference, 0);
  assert.equal(same.sameGoodCall, "3/3");
  const rev = shadowAgreement([{ python: 90, llm: 10 }, { python: 50, llm: 50 }, { python: 10, llm: 90 }]);
  assert.equal(rev.spearman, -1);
  assert.equal(rev.sameGoodCall, "1/3");
  assert.equal(shadowAgreement([]).pairs, 0);
});

let db: typeof import("../src/db.js");
let tempDir: string;
before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-hybrid-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
});
after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("shadow scores are stored per user+posting and updated in place", async () => {
  const userId = await db.upsertUser("shadow@example.com", "S", "user_shadow_1");
  const row = { postingHash: "https://jobs.example.com/1", source: "greenhouse", pythonScore: 55, signalCoverage: 0.85, caps: [], llmScore: 30, llmProvider: null, usedAsFallback: false };
  await db.recordPythonShadowScores(userId, [row, { ...row, postingHash: "https://jobs.example.com/2", llmScore: null, usedAsFallback: true, caps: ["early_career_senior"], pythonScore: 20 }]);
  await db.recordPythonShadowScores(userId, [{ ...row, pythonScore: 60, llmScore: 65 }]);
  const rows = (await db.client.execute({ sql: "SELECT posting_hash, python_score, llm_score, used_as_fallback, caps FROM jm_python_shadow_scores WHERE user_id = ? ORDER BY posting_hash", args: [userId] })).rows as any[];
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].python_score, rows[0].llm_score, rows[0].used_as_fallback], [60, 65, 0]);
  assert.deepEqual([rows[1].python_score, rows[1].llm_score, rows[1].used_as_fallback, rows[1].caps], [20, null, 1, "early_career_senior"]);
});

test("digests skip pending rows; Python-only scores stay eligible for the LLM", async () => {
  const userId = await db.upsertUser("digest-filter@example.com", "D", "user_digest_filter_1");
  await db.saveUserProfileData(userId, { cvText: "PM CV", profile: { targetDesignation: "Product Manager" } });
  await new Promise((r) => setTimeout(r, 1100));
  const mk = async (key: string, score: number, reasoning: string, status: string) => {
    const id = await db.upsertJobPosting({ source: "greenhouse", sourceJobId: key, company: "Co", title: `PM ${key}`, location: "Bengaluru",
      applyUrl: `https://jobs.example.com/df-${key}`, descriptionText: "", dedupHash: `https://jobs.example.com/df-${key}` });
    await db.upsertUserMatch(userId, id, score, "lateral", reasoning);
    await db.client.execute({ sql: "UPDATE jm_user_job_matches SET status = ? WHERE user_id = ? AND job_posting_id = ?", args: [status, userId, id] });
  };
  await mk("llm", 70, "LLM reasoning", "new");
  await mk("py", 80, "Rule-based match; signal coverage 85%.", "new");
  await mk("pending", -1, "", "pending");
  const digest = (await db.getTopMatchesForUser(userId, 15)) as any[];
  assert.deepEqual(digest.map((r) => r.title).sort(), ["PM llm", "PM py"]);
  const skip = await db.getRecentlyScoredPostingHashes(userId);
  assert.ok(skip.has("https://jobs.example.com/df-llm"));
  assert.ok(!skip.has("https://jobs.example.com/df-py"), "Python-only scores must not block LLM scoring");
});

test("re-scoring a pending match makes it visible again", async () => {
  const userId = await db.upsertUser("pending-rescore@example.com", "P", "user_pending_rescore_1");
  const id = await db.upsertJobPosting({ source: "greenhouse", sourceJobId: "pr", company: "Co", title: "PM pr", location: "Bengaluru",
    applyUrl: "https://jobs.example.com/pr", descriptionText: "", dedupHash: "https://jobs.example.com/pr" });
  await db.upsertUserMatch(userId, id, 55, "unknown", "Rule-based match; signal coverage 85%.");
  await db.client.execute({ sql: "UPDATE jm_user_job_matches SET status = 'pending', fit_score = -1 WHERE user_id = ?", args: [userId] });
  await db.upsertUserMatch(userId, id, 72, "lateral", "LLM reasoning");
  const row = (await db.client.execute({ sql: "SELECT status, fit_score FROM jm_user_job_matches WHERE user_id = ?", args: [userId] })).rows[0] as any;
  assert.deepEqual([row.status, row.fit_score], ["new", 72]);
  // A user-facing status like 'scored' is left alone.
  await db.client.execute({ sql: "UPDATE jm_user_job_matches SET status = 'scored' WHERE user_id = ?", args: [userId] });
  await db.upsertUserMatch(userId, id, 60, "lateral", "LLM again");
  assert.equal(((await db.client.execute({ sql: "SELECT status FROM jm_user_job_matches WHERE user_id = ?", args: [userId] })).rows[0] as any).status, "scored");
});
