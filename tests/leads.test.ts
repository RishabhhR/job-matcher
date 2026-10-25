import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanLeadEmail, cleanRole, leadFormHtml, renderLeadEmail, roleKeywords, runLeadEmails, type LeadJob } from "../src/leads.js";

const job = (title: string): LeadJob => ({ title, company: "Acme", location: "Bengaluru", source: "greenhouse", applyUrl: "https://boards.example.com/1" });

test("roles are cleaned and turned into title keywords (TASK-105)", () => {
  assert.equal(cleanRole("  Product   Manager <script>"), "Product Manager script");
  assert.equal(cleanRole(""), "Product Manager");
  assert.deepEqual(roleKeywords("Senior Product Manager for Fintech"), ["senior", "product", "manager", "fintech"]);
  assert.deepEqual(roleKeywords("Data Analyst roles"), ["data", "analyst"]);
  assert.equal(cleanLeadEmail(" A@Example.com "), "a@example.com");
  assert.equal(cleanLeadEmail("nope"), null);
});

test("the email escapes job text and carries the unsubscribe link", () => {
  const { subject, html } = renderLeadEmail("Product Manager", [job("<b>PM</b>")], "tok123");
  assert.equal(subject, "1 new Product Manager opening this week");
  assert.match(html, /&lt;b&gt;PM&lt;\/b&gt;/);
  assert.match(html, /api\/leads\/unsubscribe\?token=tok123/);
  assert.match(leadFormHtml("jobs_index"), /data-lead-form/);
});

test("lead runs skip empty weeks, isolate failures and never throw", async () => {
  const sent: string[] = [];
  const marked: string[] = [];
  const summary = await runLeadEmails({
    getDueEmailLeads: async () => [
      { email: "a@example.com", role: "Product Manager", token: "t1", lastSentAt: null },
      { email: "b@example.com", role: "Astronaut", token: "t2", lastSentAt: null },
      { email: "c@example.com", role: "Product Manager", token: "t3", lastSentAt: null },
    ],
    getRecentJobsForKeywords: async (keywords) => (keywords.includes("astronaut") ? [] : [job("Product Manager")]),
    markEmailLeadSent: async (email) => { marked.push(email); },
    send: async (to) => { if (to === "c@example.com") throw new Error("smtp down"); sent.push(to); return "id"; },
  });
  assert.deepEqual(summary, { due: 3, sent: 1, empty: 1, failed: 1 });
  assert.deepEqual(sent, ["a@example.com"]);
  assert.deepEqual(marked, ["a@example.com"]);

  const broken = await runLeadEmails({
    getDueEmailLeads: async () => { throw new Error("db down"); },
    getRecentJobsForKeywords: async () => [], markEmailLeadSent: async () => {}, send: async () => "id",
  });
  assert.deepEqual(broken, { due: 0, sent: 0, empty: 0, failed: 0 });
});

let db: typeof import("../src/db.js");
let tempDir: string;
before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-leads-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
});
after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("leads are due until sent, re-subscribe on sign-up again, and stop after unsubscribing", async () => {
  await db.upsertEmailLead({ email: "lead@example.com", role: "Product Manager", visitorId: null, sourcePath: "landing", consentText: "consent" });
  let due = await db.getDueEmailLeads(7);
  assert.equal(due.length, 1);
  const token = due[0].token;
  assert.ok(token.length >= 24);

  await db.markEmailLeadSent("lead@example.com");
  assert.equal((await db.getDueEmailLeads(7)).length, 0);

  assert.equal(await db.unsubscribeEmailLead("wrong-token"), false);
  assert.equal(await db.unsubscribeEmailLead(token), true);
  await db.client.execute("UPDATE jm_email_leads SET last_sent_at = datetime('now', '-8 days')");
  assert.equal((await db.getDueEmailLeads(7)).length, 0, "unsubscribed leads are never due");

  // Signing up again keeps the same token and clears the unsubscribe.
  await db.upsertEmailLead({ email: "lead@example.com", role: "Data Analyst", visitorId: null, sourcePath: "jobs_index", consentText: "consent" });
  due = await db.getDueEmailLeads(7);
  assert.deepEqual([due.length, due[0].role, due[0].token], [1, "Data Analyst", token]);

  await db.client.execute({ sql: `INSERT INTO jm_job_postings (id, source, source_job_id, company_name, title, location, apply_url, description_text, dedup_hash)
    VALUES ('p1', 'lever', 'x1', 'Acme', 'Senior Data Analyst', 'Pune', 'https://jobs.lever.co/acme/1', 'd', 'h1')`, args: [] });
  const jobs = await db.getRecentJobsForKeywords(["data", "analyst"], "2000-01-01 00:00:00", 10);
  assert.deepEqual(jobs.map((j) => j.title), ["Senior Data Analyst"]);
  assert.equal((await db.getRecentJobsForKeywords(["astronaut"], "2000-01-01 00:00:00", 10)).length, 0);
});
