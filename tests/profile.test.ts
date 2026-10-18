import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseProfilePatch } from "../src/inputValidation.js";

let db: typeof import("../src/db.js");
let tempDir: string;
let userId: string;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-profile-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
  userId = await db.upsertUser("profile@example.com", "Profile User", "user_profile_1");
});

after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("parseProfilePatch whitelists fields and rejects bad types (TASK-063)", () => {
  assert.deepEqual(parseProfilePatch({ preferredCity: " Pune ", isAdmin: true }), { preferredCity: "Pune" });
  assert.deepEqual(parseProfilePatch({ currentSalaryFixedLPA: "18.5", careerStartDate: "2023-07" }), {
    currentSalaryFixedLPA: 18.5,
    careerStartDate: "2023-07",
  });
  assert.deepEqual(parseProfilePatch({ currentSalaryEsopLPA: "", preferredCountry: null }), {
    currentSalaryEsopLPA: null,
    preferredCountry: null,
  });
  assert.equal(parseProfilePatch({ currentSalaryFixedLPA: -1 }), null);
  assert.equal(parseProfilePatch({ currentSalaryFixedLPA: true }), null);
  assert.equal(parseProfilePatch({ targetDesignation: 42 }), null);
  assert.equal(parseProfilePatch({ targetDesignation: null }), null);
  assert.equal(parseProfilePatch({ careerStartDate: "last year" }), null);
  assert.equal(parseProfilePatch({ currentSalaryCurrency: "rupees" }), null);
  assert.equal(parseProfilePatch({ preferredCity: "x".repeat(201) }), null);
  assert.equal(parseProfilePatch(["preferredCity"]), null);
  assert.equal(parseProfilePatch(null), null);
});

test("saveUserProfileData saves without a scan and merges partial profile patches", async () => {
  const first = await db.saveUserProfileData(userId, {
    cvText: "Associate PM at Acme",
    profile: {
      targetDesignation: "Product Manager",
      currentEmployer: "Acme",
      currentTitle: "Associate PM",
      currentSalaryFixedLPA: 18,
      careerStartDate: "2023-07-01",
      preferredCountry: "India",
      preferredCity: "Bengaluru",
    },
    companies: { greenhouse: ["stripe"], lever: [], ashby: [] },
  });
  assert.equal(first.hasCv, true);
  assert.equal(first.profile?.targetDesignation, "Product Manager");
  assert.equal(first.profile?.currentSalaryEsopLPA, null); // not provided stays null, not 0
  assert.deepEqual(first.companies, { greenhouse: ["stripe"], lever: [], ashby: [] });

  // Settings-style patch: only the city changes, everything else is kept.
  const second = await db.saveUserProfileData(userId, { profile: { preferredCity: "Pune" } });
  assert.equal(second.profile?.preferredCity, "Pune");
  assert.equal(second.profile?.targetDesignation, "Product Manager");
  assert.equal(second.profile?.currentSalaryFixedLPA, 18);
  assert.deepEqual(second.companies, { greenhouse: ["stripe"], lever: [], ashby: [] });

  // null clears an optional field.
  const third = await db.saveUserProfileData(userId, { profile: { preferredCity: null } });
  assert.equal(third.profile?.preferredCity ?? null, null);

  // Replacing the CV keeps exactly one active version.
  await db.saveUserProfileData(userId, { cvText: "Product Manager at Acme" });
  assert.equal(await db.getActiveCvText(userId), "Product Manager at Acme");
  const active = await db.client.execute({
    sql: "SELECT COUNT(*) AS n FROM jm_cvs WHERE user_id = ? AND is_active = 1",
    args: [userId],
  });
  assert.equal(Number(active.rows[0].n), 1);
});
