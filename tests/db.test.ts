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

test("seedCandidateMatchesFromPool matches existing postings by title/location and ignores duplicates", async () => {
  const seedUser = await db.upsertUser("seedtest@example.com", "Seed User", "user_seed_99");
  
  await db.upsertJobPosting({
    source: "greenhouse",
    sourceJobId: "pm-bengaluru",
    company: "Meta",
    title: "Senior Product Manager",
    location: "Bengaluru, India",
    applyUrl: "https://jobs.example.com/pm1",
    descriptionText: "PM role in Bengaluru",
    dedupHash: "seed-test/pm1",
  });
  await db.upsertJobPosting({
    source: "greenhouse",
    sourceJobId: "designer-london",
    company: "Figma",
    title: "Lead Product Designer",
    location: "London, UK",
    applyUrl: "https://jobs.example.com/pd1",
    descriptionText: "Designer role in London",
    dedupHash: "seed-test/pd1",
  });

  const seededCount = await db.seedCandidateMatchesFromPool(seedUser, "Product Manager", [/bengaluru/i]);
  assert.ok(seededCount >= 1, "Should seed at least 1 match");

  const matches = await db.getPaginatedMatchesForUser(seedUser, 0, 10);
  const found = matches.find((m: any) => m.title === "Senior Product Manager");
  assert.ok(found, "Expected Senior Product Manager to be seeded");
  assert.equal(found.status, "pending");

  const seededAgain = await db.seedCandidateMatchesFromPool(seedUser, "Product Manager", [/bengaluru/i]);
  assert.equal(seededAgain, 0, "Should not re-seed existing candidate matches");
});

test("isRoleTitleMatch accurately matches roles and does not cross PM with Engineer", () => {
  // PM target
  assert.equal(db.isRoleTitleMatch("Senior Product Manager", "Product Manager"), true);
  assert.equal(db.isRoleTitleMatch("Associate Product Manager", "Product Manager"), true);
  assert.equal(db.isRoleTitleMatch("Technical Product Manager", "Product Manager"), true);
  assert.equal(db.isRoleTitleMatch("Group Product Manager", "APM"), true);
  assert.equal(db.isRoleTitleMatch("Software Engineer", "Product Manager"), false);
  assert.equal(db.isRoleTitleMatch("Frontend Developer", "Product Manager"), false);
  assert.equal(db.isRoleTitleMatch("Data Scientist", "Product Manager"), false);

  // Engineer target
  assert.equal(db.isRoleTitleMatch("Senior Software Engineer", "Software Engineer"), true);
  assert.equal(db.isRoleTitleMatch("Staff Backend Developer", "Backend Engineer"), true);
  assert.equal(db.isRoleTitleMatch("Senior Product Manager", "Software Engineer"), false);
  assert.equal(db.isRoleTitleMatch("Product Marketing Manager", "Software Engineer"), false);
});

test("getPendingMatchesForUser and getPendingMatchCountForUser manage pending queue progressively", async () => {
  const pendingUser = await db.upsertUser("pendingtest@example.com", "Pending User", "user_pending_1");
  const p1 = await db.upsertJobPosting({
    source: "greenhouse",
    sourceJobId: "pend-1",
    company: "Company A",
    title: "Product Manager 1",
    location: "Bengaluru",
    applyUrl: "https://example.com/p1",
    descriptionText: "desc 1",
    dedupHash: "pend/1",
  });
  const p2 = await db.upsertJobPosting({
    source: "greenhouse",
    sourceJobId: "pend-2",
    company: "Company B",
    title: "Product Manager 2",
    location: "Bengaluru",
    applyUrl: "https://example.com/p2",
    descriptionText: "desc 2",
    dedupHash: "pend/2",
  });

  await db.upsertUserMatch(pendingUser, p1, -1, "pending", "Waiting for score");
  await db.upsertUserMatch(pendingUser, p2, -1, "pending", "Waiting for score");
  await db.client.execute({
    sql: "UPDATE jm_user_job_matches SET status = 'pending' WHERE user_id = ?",
    args: [pendingUser],
  });

  const countBefore = await db.getPendingMatchCountForUser(pendingUser);
  assert.equal(countBefore, 2);

  const batch1 = await db.getPendingMatchesForUser(pendingUser, 1);
  assert.equal(batch1.length, 1);
  assert.equal(batch1[0].status, "scoring");

  // Score the first match
  await db.updateMatchScore(pendingUser, batch1[0].posting_id, 85, "upgrade", "Strong fit", undefined, batch1[0].claimToken);

  const countAfter1 = await db.getPendingMatchCountForUser(pendingUser);
  assert.equal(countAfter1, 1);

  // Next batch should return the remaining unscored match
  const batch2 = await db.getPendingMatchesForUser(pendingUser, 1);
  assert.equal(batch2.length, 1);
  assert.notEqual(batch2[0].posting_id, batch1[0].posting_id);

  // Score the second match
  await db.updateMatchScore(pendingUser, batch2[0].posting_id, 75, "lateral", "Good fit", undefined, batch2[0].claimToken);

  const countAfter2 = await db.getPendingMatchCountForUser(pendingUser);
  assert.equal(countAfter2, 0);

  const batch3 = await db.getPendingMatchesForUser(pendingUser, 1);
  assert.equal(batch3.length, 0);
});

test("pending match scoring claims are exclusive and stale owners cannot release a newer lease", async () => {
  const claimUser = await db.upsertUser("claimtest@example.com", "Claim User", "user_claim_1");
  const postingId = await db.upsertJobPosting({
    source: "greenhouse", sourceJobId: "claim-1", company: "Claim Co", title: "Product Manager",
    location: "Remote", applyUrl: "https://example.com/claim", descriptionText: "desc", dedupHash: "claim/1",
  });
  await db.upsertUserMatch(claimUser, postingId, -1, "unknown", "Pending",);
  await db.client.execute({
    sql: "UPDATE jm_user_job_matches SET status = 'pending' WHERE user_id = ? AND job_posting_id = ?",
    args: [claimUser, postingId],
  });

  const [first, second] = await Promise.all([
    db.getPendingMatchesForUser(claimUser, 1),
    db.getPendingMatchesForUser(claimUser, 1),
  ]);
  assert.equal(first.length + second.length, 1);
  const firstClaim = first[0] || second[0];
  assert.equal(firstClaim.status, "scoring");
  assert.ok(firstClaim.claimToken);

  await db.client.execute({
    sql: "UPDATE jm_user_job_matches SET matched_at = datetime('now', '-6 minutes') WHERE id = ?",
    args: [firstClaim.match_id],
  });
  const reclaimed = await db.getPendingMatchesForUser(claimUser, 1);
  assert.equal(reclaimed.length, 1);
  assert.notEqual(reclaimed[0].claimToken, firstClaim.claimToken);

  await db.releasePendingMatchClaims(claimUser, [firstClaim.match_id], firstClaim.claimToken);
  assert.equal((await db.getPendingMatchesForUser(claimUser, 1)).length, 0);
  await db.releasePendingMatchClaims(claimUser, [reclaimed[0].match_id], reclaimed[0].claimToken);
  assert.equal((await db.getPendingMatchesForUser(claimUser, 1)).length, 1);
});


