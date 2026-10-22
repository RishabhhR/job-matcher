import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nextDigestAt } from "../src/digestSchedule.js";

// UI v2 backend (TASK-055): feed tabs, tab counts, match actions and status.
let db: typeof import("../src/db.js");
let tempDir: string;
let userId: string;
let otherUserId: string;
const matchIds: Record<string, string> = {};

async function seedMatch(key: string, score: number, status: "new" | "scored" | "pending") {
  const postingId = await db.upsertJobPosting({
    source: "linkedin",
    sourceJobId: key,
    company: `Co ${key}`,
    title: `PM ${key}`,
    location: "Bengaluru",
    applyUrl: `https://jobs.example.com/${key}`,
    descriptionText: "",
    dedupHash: `feed-test/${key}`,
  });
  await db.upsertUserMatch(userId, postingId, score, "lateral", `reason ${key}`);
  await db.client.execute({
    sql: "UPDATE jm_user_job_matches SET status = ? WHERE user_id = ? AND job_posting_id = ?",
    args: [status, userId, postingId],
  });
  const row = await db.client.execute({
    sql: "SELECT id FROM jm_user_job_matches WHERE user_id = ? AND job_posting_id = ?",
    args: [userId, postingId],
  });
  matchIds[key] = row.rows[0].id as string;
}

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-feed-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
  userId = await db.upsertUser("feed@example.com", "Feed User", "user_feed_1");
  otherUserId = await db.upsertUser("intruder@example.com", "Intruder", "user_feed_2");
  await seedMatch("A", 90, "new"); // cron-scored
  await seedMatch("B", 70, "scored"); // UI-scored
  await seedMatch("C", -1, "pending"); // not scored yet
  await seedMatch("D", 50, "new"); // will be dismissed
  await db.setMatchUserAction(userId, matchIds.A, "saved");
  await db.setMatchUserAction(userId, matchIds.D, "dismissed");
});

after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("stats count cron-scored ('new') matches, not just 'scored' (TASK-053)", async () => {
  const stats = await db.getUserStats(userId);
  assert.equal(stats.totalScored, 3); // A, B, D - pending C excluded
  assert.equal(stats.highMatchCount, 1); // A (90)
});

test("every tab count equals the rows that tab returns", async () => {
  const stats = await db.getUserStats(userId);
  const expected: Record<string, number> = {
    new: stats.newCount,
    saved: stats.savedCount,
    applied: stats.appliedCount,
    dismissed: stats.dismissedCount,
    all: stats.allCount,
  };
  for (const [filter, count] of Object.entries(expected)) {
    const opts = { filter: filter as any };
    const rows = await db.getPaginatedMatchesForUser(userId, 0, 50, opts);
    assert.equal(rows.length, count, `rows for ${filter}`);
    assert.equal(await db.getTotalMatchCountForUser(userId, opts), count, `total for ${filter}`);
  }
  assert.deepEqual(
    { new: stats.newCount, saved: stats.savedCount, dismissed: stats.dismissedCount, all: stats.allCount },
    { new: 1, saved: 1, dismissed: 1, all: 2 }
  );
});

test("tabs hide pending rows and dismissed rows; legacy (no filter) keeps everything", async () => {
  const all = await db.getPaginatedMatchesForUser(userId, 0, 50, { filter: "all", sort: "best" });
  assert.deepEqual(all.map((r: any) => r.title), ["PM A", "PM B"]); // best-first, no C, no D
  const legacy = await db.getPaginatedMatchesForUser(userId, 0, 50);
  assert.equal(legacy.length, 4);
  const minScore = await db.getPaginatedMatchesForUser(userId, 0, 50, { filter: "all", minScore: 80 });
  assert.deepEqual(minScore.map((r: any) => r.title), ["PM A"]);
});

test("match actions are owner-scoped, idempotent and undoable", async () => {
  // Another user cannot act on this user's match.
  assert.equal(await db.setMatchUserAction(otherUserId, matchIds.B, "dismissed"), false);
  // Repeating an action is a no-op success.
  assert.equal(await db.setMatchUserAction(userId, matchIds.B, "applied"), true);
  assert.equal(await db.setMatchUserAction(userId, matchIds.B, "applied"), true);
  assert.equal((await db.getUserStats(userId)).appliedCount, 1);
  // Undo clears it back into New.
  assert.equal(await db.setMatchUserAction(userId, matchIds.B, null), true);
  const stats = await db.getUserStats(userId);
  assert.equal(stats.appliedCount, 0);
  assert.equal(stats.newCount, 1);
});

test("status reports every known source with readable text, not color alone", async () => {
  const status = await db.getUserStatus(userId);
  assert.deepEqual(status.sources.map((s) => s.source), ["linkedin", "naukri", "greenhouse", "lever", "ashby"]);
  const linkedin = status.sources.find((s) => s.source === "linkedin")!;
  assert.equal(linkedin.healthy, true);
  assert.match(linkedin.statusText, /in the last 24 hours/);
  // No scrape check recorded and no jobs: unhealthy, explained in words (TASK-070 wording).
  const naukri = status.sources.find((s) => s.source === "naukri")!;
  assert.equal(naukri.healthy, false);
  assert.match(naukri.statusText, /No recent source check/);
  assert.ok(status.lastScanAt);
});

test("source health follows the latest per-user scrape check (TASK-070)", async () => {
  await db.upsertScrapeSourceStatuses(userId, [
    { source: "greenhouse", count: 0, ok: false, errorCode: "HTTP_503" },
    { source: "lever", count: 0, ok: true },
  ]);
  const status = await db.getUserStatus(userId);
  const greenhouse = status.sources.find((s) => s.source === "greenhouse")!;
  assert.equal(greenhouse.healthy, false);
  assert.match(greenhouse.statusText, /latest source check failed/);
  const lever = status.sources.find((s) => s.source === "lever")!;
  assert.equal(lever.healthy, true); // checked fine, just returned nothing
  assert.match(lever.statusText, /Checked successfully/);
  // Every source still carries text, never colour alone (DEC-007).
  for (const s of status.sources) assert.ok(s.statusText.length > 0);
});

test("nextDigestAt rolls to the next local occurrence of the hour", () => {
  // 2026-10-18 10:00 UTC = 15:30 IST. A 9 AM IST digest is next tomorrow at 03:30 UTC.
  assert.equal(nextDigestAt(9, "Asia/Kolkata", new Date("2026-10-18T10:00:00Z")), "2026-10-19T03:30:00.000Z");
  // A 9 PM IST digest is still ahead today, at 15:30 UTC.
  assert.equal(nextDigestAt(21, "Asia/Kolkata", new Date("2026-10-18T10:00:00Z")), "2026-10-18T15:30:00.000Z");
  assert.equal(nextDigestAt(9, "Not/AZone"), null);
});
