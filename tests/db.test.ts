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

test("source posting dates persist in Turso-compatible storage", async () => {
  const postedAt = "2026-10-13T08:30:00.000Z";
  const postingId = await db.upsertJobPosting({
    source: "lever",
    sourceJobId: "date-test",
    company: "Date Example",
    title: "Product Manager",
    location: "Bengaluru",
    applyUrl: "https://jobs.example.com/date-test",
    descriptionText: "",
    dedupHash: "date-test-posting",
    postedAt,
  });
  const result = await db.client.execute({
    sql: "SELECT posted_at FROM jm_job_postings WHERE id = ?",
    args: [postingId],
  });
  assert.equal(result.rows[0]?.posted_at, postedAt);
});

test("verified identities cannot take over an email already linked elsewhere", async () => {
  await db.upsertUser("other@example.com", "Other", "user_other_456");
  await assert.rejects(
    db.upsertUser("other@example.com", "Test User", "user_test_123"),
    /already linked to another account/
  );
});

test("daily visitor tracking aggregates unique visitors, hits, and top paths accurately", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const hash1 = "visitor_hash_1";
  const hash2 = "visitor_hash_2";

  // Hash 1 visits '/' twice and '/jobs' once
  await db.recordDailyVisit(today, hash1, "/", "https://google.com");
  await db.recordDailyVisit(today, hash1, "/", "https://google.com");
  await db.recordDailyVisit(today, hash1, "/jobs", null);

  // Hash 2 visits '/' once
  await db.recordDailyVisit(today, hash2, "/", "https://twitter.com");

  const stats = await db.getDailyVisitorStats(7);
  assert.equal(stats.summary.today_visitors, 2, "Expected 2 unique visitors today");
  assert.equal(stats.summary.total_period_views, 4, "Expected 4 total views across 2 visitors");

  const todayRecord = stats.daily.find((d) => d.visit_date === today);
  assert.ok(todayRecord);
  assert.equal(todayRecord.unique_visitors, 2);
  assert.equal(todayRecord.total_views, 4);

  const homePath = stats.top_paths.find((p) => p.path === "/");
  assert.ok(homePath);
  assert.equal(homePath.views, 3);

  const jobsPath = stats.top_paths.find((p) => p.path === "/jobs");
  assert.ok(jobsPath);
  assert.equal(jobsPath.views, 1);
});

