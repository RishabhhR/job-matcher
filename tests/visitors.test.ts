import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanVisitorId, parseUserAgent, referrerOrigin, visitorPingFrom } from "../src/visitors.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("user agents are reduced to device, browser and OS (TASK-104)", () => {
  assert.deepEqual(parseUserAgent(IPHONE), { device: "mobile", browser: "Safari", os: "iOS", isBot: false });
  assert.deepEqual(parseUserAgent(MAC_CHROME), { device: "desktop", browser: "Chrome", os: "macOS", isBot: false });
  assert.equal(parseUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").isBot, true);
  assert.equal(parseUserAgent("").device, "unknown");
});

test("visitor ids and emails are validated", () => {
  assert.equal(cleanVisitorId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(cleanVisitorId("short"), null);
  assert.equal(cleanVisitorId("x'; DROP TABLE jm_users; --"), null);
  assert.equal(cleanEmail("  Someone@Example.COM "), "someone@example.com");
  assert.equal(cleanEmail("not-an-email"), null);
  assert.equal(cleanEmail("<a>@b.com"), null);
});

test("pings carry Vercel geo headers and first-touch UTM tags", () => {
  const ping = visitorPingFrom(
    { visitorId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", utm: { source: "reddit", campaign: "launch<script>" }, language: "en-IN", timezone: "Asia/Kolkata" },
    { "user-agent": IPHONE, "x-vercel-ip-country": "IN", "x-vercel-ip-country-region": "KA", "x-vercel-ip-city": "Bengaluru%20Urban" },
    "/jobs", "https://www.reddit.com",
  );
  assert.ok(ping);
  assert.equal(ping!.city, "Bengaluru Urban");
  assert.equal(ping!.utmCampaign, "launchscript");
  assert.equal(ping!.device, "mobile");
  assert.equal(visitorPingFrom({}, {}, "/", null), null);
});

let db: typeof import("../src/db.js");
let tempDir: string;
before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "job-matcher-visitors-test-"));
  process.env.TURSO_DATABASE_URL = `file:${path.join(tempDir, "test.sqlite")}`;
  db = await import("../src/db.js");
  await db.ensureMigrated();
});
after(async () => {
  await db.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("visitor rows keep first-touch data, count views, and take email only for known visitors", async () => {
  const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const base = visitorPingFrom({ visitorId: id, utm: { source: "reddit" } }, { "user-agent": IPHONE, "x-vercel-ip-country": "IN" }, "/", "https://www.reddit.com")!;
  await db.upsertVisitor(base);
  await db.upsertVisitor({ ...base, path: "/jobs", referrer: "https://google.com", utmSource: "x", country: null });
  const row = (await db.client.execute({ sql: "SELECT * FROM jm_visitors WHERE visitor_id = ?", args: [id] })).rows[0] as any;
  assert.equal(row.pageviews, 2);
  assert.equal(row.visits, 1);
  assert.equal(row.landing_path, "/");
  assert.equal(row.first_referrer, "https://www.reddit.com");
  assert.equal(row.utm_source, "reddit");
  assert.equal(row.country, "IN");

  assert.equal(await db.recordVisitorEmail("00000000-0000-0000-0000-000000000000", "a@b.com", "sign_in_started"), false);
  assert.equal(await db.recordVisitorEmail(id, "lead@example.com", "sign_in_started"), true);
  const userId = await db.upsertUser("lead@example.com", "Lead", "user_lead_1");
  await db.linkVisitorToUser(id, userId);
  const linked = (await db.client.execute({ sql: "SELECT email, email_source, user_id FROM jm_visitors WHERE visitor_id = ?", args: [id] })).rows[0] as any;
  assert.deepEqual([linked.email, linked.email_source, linked.user_id], ["lead@example.com", "sign_in_started", userId]);
});
