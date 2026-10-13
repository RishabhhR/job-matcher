import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let db: typeof import("../src/db.js");
let tempDir: string;
let userId: string;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-db-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
  userId = await db.upsertUser("tester@example.com", "Test User", "user_test_123");
});

after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("digest claim is atomic and failed/blocked attempts can retry", async () => {
  const concurrentClaims = await Promise.all([
    db.claimEmailSend(userId, "2026-10-14", "hour-9"),
    db.claimEmailSend(userId, "2026-10-14", "hour-9"),
  ]);
  assert.equal(concurrentClaims.filter(Boolean).length, 1);

  await db.logEmailSend(userId, "2026-10-14", "hour-9", "failed", undefined, "temporary failure");
  assert.equal(await db.claimEmailSend(userId, "2026-10-14", "hour-9"), true);
  await db.logEmailSend(userId, "2026-10-14", "hour-9", "blocked", undefined, "missing profile");
  assert.equal(await db.claimEmailSend(userId, "2026-10-14", "hour-9"), true);
  await db.logEmailSend(userId, "2026-10-14", "hour-9", "empty");
  assert.equal(await db.claimEmailSend(userId, "2026-10-14", "hour-9"), false);
});

test("digest selection never re-includes jobs already emailed", async () => {
  const base = {
    source: "test",
    sourceJobId: "",
    company: "Example Co",
    title: "Product Manager",
    location: "Remote",
    applyUrl: "https://jobs.example.com/",
    descriptionText: "",
  };
  const emailedPostingId = await db.upsertJobPosting({ ...base, dedupHash: "jobs.example.com/emailed" });
  const newPostingId = await db.upsertJobPosting({
    ...base,
    applyUrl: "https://jobs.example.com/new",
    dedupHash: "jobs.example.com/new",
  });
  await db.upsertUserMatch(userId, emailedPostingId, 99, "lateral", "Previously emailed.");
  await db.upsertUserMatch(userId, newPostingId, 90, "lateral", "Not emailed yet.");

  const mailed = await db.client.execute({
    sql: "SELECT id FROM jm_user_job_matches WHERE user_id = ? AND job_posting_id = ?",
    args: [userId, emailedPostingId],
  });
  await db.markMatchesAsSent([mailed.rows[0].id as string]);

  const selected = await db.getTopMatchesForUser(userId, 15);
  assert.deepEqual(selected.map((match) => match.apply_url), ["https://jobs.example.com/new"]);
});

test("per-user ATS company sources persist independently", async () => {
  const companies = { greenhouse: ["acme"], lever: ["globex"], ashby: ["initech"] };
  await db.upsertUserCompanies(userId, companies);
  assert.deepEqual(await db.getUserCompanies(userId), companies);
});

test("verified identities cannot take over an email already linked elsewhere", async () => {
  await db.upsertUser("other@example.com", "Other", "user_other_456");
  await assert.rejects(
    db.upsertUser("other@example.com", "Test User", "user_test_123"),
    /already linked to another account/
  );
});
