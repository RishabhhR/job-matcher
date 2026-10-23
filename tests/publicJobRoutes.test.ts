import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

let tempDir: string;
let base: string;
let server: Server;
let db: typeof import("../src/db.js");
let postingId: string;

before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "jm-public-jobs-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1";
  db = await import("../src/db.js");
  await db.ensureMigrated();
  postingId = await db.upsertJobPosting({
    source: "lever", sourceJobId: "test-job", company: "Example Co", title: "Product Manager",
    location: "Bengaluru, India", applyUrl: "https://jobs.example.com/product-manager",
    descriptionText: "Build a roadmap with engineering and design, gather feedback from customers, define launch milestones, and measure product results. This is a full role description.",
    dedupHash: "public-jobs-test-job", postedAt: new Date().toISOString(),
  });
  const { default: app } = await import("../src/server.js");
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (db) await db.client.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test("public jobs index and detail are server-rendered and crawlable", async () => {
  const index = await fetch(`${base}/jobs`);
  assert.equal(index.status, 200);
  const listHtml = await index.text();
  assert.ok(listHtml.includes(`<a href="/jobs/${postingId}">Product Manager</a>`));
  assert.ok(!listHtml.includes('"@type":"JobPosting"'));

  const detail = await fetch(`${base}/jobs/${postingId}`);
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.ok(detailHtml.includes('"@type":"JobPosting"'));
  assert.ok(detailHtml.includes("Open original listing"));

  const summary = await fetch(`${base}/api/public/jobs/summary`);
  assert.equal(summary.status, 200);
  assert.deepEqual(await summary.json(), { recentCount: 1 });
});

test("pre-login landing content is present in the initial HTML response", async () => {
  const response = await fetch(`${base}/v2/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('<h1 id="landing-title">Jobs that fit your experience, gathered in one place.</h1>'));
  assert.ok(html.includes('id="landing-faq-title"'));
  assert.ok(html.includes("Greenhouse"));
  assert.ok(html.includes('href="/jobs"'));
});

test("unknown jobs return a real 404 with noindex", async () => {
  const response = await fetch(`${base}/jobs/invalid-id`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes('name="robots" content="noindex"'));
});
