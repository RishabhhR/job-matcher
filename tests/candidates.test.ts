import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { postingHash, selectScheduledCandidates } from "../src/candidates.js";
import type { RawPosting } from "../src/scrapers.js";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const posting = (id: string, source: RawPosting["source"], title: string, postedAt?: string): RawPosting => ({
  source, sourceJobId: id, company: `Co ${id}`, title, location: "Bengaluru",
  applyUrl: `https://jobs.example.com/${id}`, descriptionText: "x", postedAt,
});

test("undated postings (LinkedIn) count as just scraped, not oldest (TASK-073)", () => {
  const pool = [
    posting("gh1", "greenhouse", "Product Manager", "2026-10-21T00:00:00Z"),
    posting("li1", "linkedin", "Product Manager"),
    posting("gh2", "greenhouse", "Product Manager", "2026-10-20T00:00:00Z"),
  ];
  const { candidates } = selectScheduledCandidates(pool, { yearsOfExperience: null, limit: 2, now: NOW });
  assert.deepEqual(candidates.map((p) => p.sourceJobId), ["li1", "gh1"]);
});

test("already-scored postings are skipped so the budget goes to new ones", () => {
  const pool = [posting("a", "greenhouse", "Product Manager", "2026-10-21T00:00:00Z"), posting("b", "linkedin", "APM")];
  const sel = selectScheduledCandidates(pool, { alreadyScored: new Set([postingHash(pool[0])]), yearsOfExperience: null, limit: 30, now: NOW });
  assert.deepEqual(sel.candidates.map((p) => p.sourceJobId), ["b"]);
  assert.equal(sel.skippedAlreadyScored, 1);
});

test("early-career profiles get senior titles last; unknown experience is not penalised", () => {
  const pool = [
    posting("s", "greenhouse", "Senior Product Manager", "2026-10-22T00:00:00Z"),
    posting("j", "greenhouse", "Associate Product Manager", "2026-10-01T00:00:00Z"),
  ];
  const early = selectScheduledCandidates(pool, { yearsOfExperience: 2, limit: 1, now: NOW });
  assert.deepEqual(early.candidates.map((p) => p.sourceJobId), ["j"]);
  assert.equal(early.deferred, 1);
  const unknown = selectScheduledCandidates(pool, { yearsOfExperience: null, limit: 1, now: NOW });
  assert.deepEqual(unknown.candidates.map((p) => p.sourceJobId), ["s"]); // newest wins
  const senior = selectScheduledCandidates(pool, { yearsOfExperience: 8, limit: 1, now: NOW });
  assert.deepEqual(senior.candidates.map((p) => p.sourceJobId), ["s"]);
});

let db: typeof import("../src/db.js");
let tempDir: string;
before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-candidates-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
});
after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("recently scored postings are remembered until the CV/profile changes", async () => {
  const userId = await db.upsertUser("cand@example.com", "Cand", "user_cand_1");
  await db.saveUserProfileData(userId, { cvText: "PM CV", profile: { targetDesignation: "Product Manager" } });
  // Let the clock move past the profile/CV timestamps (second resolution).
  await new Promise((r) => setTimeout(r, 1100));
  const p = posting("scored1", "linkedin", "Product Manager");
  const postingId = await db.upsertJobPosting({ source: p.source, sourceJobId: p.sourceJobId, company: p.company, title: p.title,
    location: p.location, applyUrl: p.applyUrl, descriptionText: "", dedupHash: postingHash(p) });
  await db.upsertUserMatch(userId, postingId, 72, "lateral", "fits");
  assert.ok((await db.getRecentlyScoredPostingHashes(userId)).has(postingHash(p)));

  // Editing the profile makes every posting eligible for re-scoring.
  await new Promise((r) => setTimeout(r, 1100));
  await db.saveUserProfileData(userId, { profile: { preferredCity: "Pune" } });
  assert.equal((await db.getRecentlyScoredPostingHashes(userId)).size, 0);
});
