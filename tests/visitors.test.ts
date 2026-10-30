import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanVisitorId, isSiteHost, parseUserAgent, referrerOrigin, visitPath, visitorPingFrom } from "../src/visitors.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("user agents are reduced to device, browser and OS (TASK-104)", () => {
  assert.deepEqual(parseUserAgent(IPHONE), { device: "mobile", browser: "Safari", os: "iOS", isBot: false });
  assert.deepEqual(parseUserAgent(MAC_CHROME), { device: "desktop", browser: "Chrome", os: "macOS", isBot: false });
  assert.equal(parseUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)").isBot, true);
  assert.equal(parseUserAgent("").device, "unknown");
});

test("visitor ids are validated and referrers reduced to their origin", () => {
  assert.equal(cleanVisitorId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(cleanVisitorId("short"), null);
  assert.equal(cleanVisitorId("x'; DROP TABLE jm_users; --"), null);
  assert.equal(referrerOrigin("https://www.google.com/search?q=jobs+for+me"), "https://www.google.com");
  assert.equal(referrerOrigin("javascript:alert(1)"), null);
  assert.equal(referrerOrigin("not a url"), null);
});

test("visit paths drop the origin and unsafe characters (TASK-107)", () => {
  assert.equal(visitPath("/jobs"), "/jobs");
  assert.equal(visitPath("/#/matches"), "/#/matches");
  assert.equal(visitPath("https://job-matcher-ecru.vercel.app/"), "/");
  assert.equal(visitPath("https://job-matcher-ecru.vercel.app/v2/#/settings"), "/v2/#/settings");
  assert.equal(visitPath("/<script>"), "/script");
  assert.equal(visitPath(undefined), "/");
});

test("only the public site host counts as traffic (TASK-107)", () => {
  const site = "https://job-matcher-ecru.vercel.app";
  assert.equal(isSiteHost({ host: "job-matcher-ecru.vercel.app" }, site), true);
  assert.equal(isSiteHost({ "x-forwarded-host": "JOB-MATCHER-ECRU.vercel.app", host: "internal" }, site), true);
  assert.equal(isSiteHost({ "x-forwarded-host": "job-matcher-abc123-rishabhs-projects.vercel.app" }, site), false);
  assert.equal(isSiteHost({}, site), false);
});

test("deploy screenshot bots are recognised (TASK-107)", () => {
  assert.equal(parseUserAgent("Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36 vercel-screenshot/1.0").isBot, true);
});

// DEC-008 data contract: no email is sent or stored from an unverified sign-in attempt,
// the account link happens only in /api/user/init after Clerk verification, and
// PostHog never receives jm_vid.
test("no visitor email capture exists anywhere (DEC-008)", async () => {
  const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const [server, analytics, auth, html] = await Promise.all([
    read("src/server.ts"), read("public/analytics.js"), read("public/v2/js/auth.js"), read("public/v2/index.html"),
  ]);
  assert.doesNotMatch(server, /visitor-email|recordVisitorEmail/);
  assert.doesNotMatch(analytics, /recordEmail|visitor-email/);
  assert.doesNotMatch(auth, /watchSignInEmail|recordEmail/);
  assert.doesNotMatch(html, /save the email/i);
  assert.match(html, /links this browser's visit history to your account/);

  // jm_vid only goes to our own endpoints, never into a PostHog capture/identify/register call.
  assert.doesNotMatch(analytics, /posthog\.(capture|identify|register|setPersonProperties)\([^)]*visitorId/);
  const captureBody = analytics.slice(analytics.indexOf("function capture("), analytics.indexOf("function leavePage"));
  assert.doesNotMatch(captureBody, /visitorId|jm_vid/);

  // The only caller of linkVisitorToUser is /api/user/init, after getVerifiedClerkIdentity.
  const linkCalls = [...server.matchAll(/linkVisitorToUser\(/g)];
  assert.equal(linkCalls.length, 1);
  const init = server.slice(server.indexOf('app.post("/api/user/init"'));
  const linkAt = init.indexOf("linkVisitorToUser(");
  assert.ok(linkAt > init.indexOf("getVerifiedClerkIdentity("), "link must follow Clerk verification");
  assert.ok(linkAt < init.indexOf("\napp."), "link must stay inside /api/user/init");
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

test("visitor rows keep first-touch data, count views, store no email, and link to a user", async () => {
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

  assert.equal(row.user_id, null);

  const columns = (await db.client.execute("PRAGMA table_info(jm_visitors)")).rows.map((c: any) => String(c.name));
  assert.deepEqual(columns.filter((name) => /email|ip|user_agent|^ua$|referrer_url/i.test(name)), []);
  assert.equal("recordVisitorEmail" in db, false);

  const userId = await db.upsertUser("lead@example.com", "Lead", "user_lead_1");
  await db.linkVisitorToUser(id, userId);
  await db.linkVisitorToUser("00000000-0000-0000-0000-000000000000", userId);
  const linked = (await db.client.execute({ sql: "SELECT user_id, linked_at FROM jm_visitors WHERE visitor_id = ?", args: [id] })).rows[0] as any;
  assert.equal(linked.user_id, userId);
  assert.ok(linked.linked_at);
  const count = (await db.client.execute("SELECT count(*) AS n FROM jm_visitors")).rows[0] as any;
  assert.equal(Number(count.n), 1, "linking an unknown id must not create a row");
});
