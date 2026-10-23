import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let db: typeof import("../src/db.js");
let tempDir: string;
before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-referral-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
});
after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("referral codes are random, stable per user and unique (TASK-089)", async () => {
  const a = await db.upsertUser("ref-a@example.com", "A", "user_ref_a");
  const b = await db.upsertUser("ref-b@example.com", "B", "user_ref_b");
  const codeA = await db.getOrCreateReferralCode(a);
  assert.match(codeA, /^[a-z0-9]{8}$/);
  assert.ok(!a.startsWith(codeA) && !codeA.includes(a.slice(0, 4)), "code must not derive from the user id");
  assert.equal(await db.getOrCreateReferralCode(a), codeA); // stable
  assert.notEqual(await db.getOrCreateReferralCode(b), codeA);
});

test("claims: new accounts once, never self, never old accounts, bad codes rejected", async () => {
  const referrer = await db.upsertUser("ref-r@example.com", "R", "user_ref_r");
  const code = await db.getOrCreateReferralCode(referrer);
  const newbie = await db.upsertUser("ref-n@example.com", "N", "user_ref_n");

  assert.equal(await db.claimReferral(newbie, "nope!!"), "invalid_code");
  assert.equal(await db.claimReferral(newbie, "zzzzzzzz"), "invalid_code");
  assert.equal(await db.claimReferral(referrer, code), "self_referral");
  assert.equal(await db.claimReferral(newbie, code.toUpperCase()), "recorded");
  assert.equal(await db.claimReferral(newbie, code), "already_referred");
  assert.equal((await db.getReferralSummary(referrer)).referredCount, 1);

  const veteran = await db.upsertUser("ref-v@example.com", "V", "user_ref_v");
  await db.client.execute({ sql: "UPDATE jm_users SET created_at = datetime('now', '-30 days') WHERE id = ?", args: [veteran] });
  assert.equal(await db.claimReferral(veteran, code), "too_old");
  assert.equal((await db.getReferralSummary(referrer)).referredCount, 1);
});
