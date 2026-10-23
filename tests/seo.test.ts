import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTitle, jobPostingSchema, renderJobDetail, renderJobsIndex, renderSitemap, type PublicPosting } from "../src/publicJobs.js";

const SITE = "https://job-matcher-ecru.vercel.app";
const job = (over: Partial<PublicPosting> = {}): PublicPosting => ({
  id: "job-1", source: "ashby", company: "Acme", title: "Product Manager", location: "Bengaluru, India",
  applyUrl: "https://jobs.ashbyhq.com/acme/1", description: "x".repeat(400),
  postedAt: new Date(Date.now() - 86_400_000).toISOString(), scrapedAt: "2026-10-23 10:00:00", ...over,
} as PublicPosting);

test("sitemap lists landing, /jobs and each job, never /v2/ (TASK-094)", () => {
  const xml = renderSitemap([{ id: "a b", scrapedAt: "2026-10-23 10:00:00" }, { id: "c", scrapedAt: "2026-10-22 09:00:00" }], new Date("2026-10-24T00:00:00Z"));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes(`<loc>${SITE}/</loc><lastmod>2026-10-24</lastmod>`));
  assert.ok(xml.includes(`<loc>${SITE}/jobs</loc><lastmod>2026-10-23</lastmod>`));
  assert.ok(xml.includes(`<loc>${SITE}/jobs/a%20b</loc><lastmod>2026-10-23</lastmod>`));
  assert.ok(xml.includes(`<loc>${SITE}/jobs/c</loc><lastmod>2026-10-22</lastmod>`));
  assert.ok(!xml.includes("/v2/"));
  assert.equal(renderSitemap([]).match(/<url>/g)?.length, 2); // DB down: core pages still listed
});

test("job pages carry a PNG share image, social tags and a short title", () => {
  const long = job({ title: "Technical Product Manager - Platform and Risk Decisioning (HCM)", company: "Trusting Social" });
  const page = renderJobDetail(long);
  const title = page.match(/<title>([^<]*)<\/title>/)![1].replace(" · JobMatcher", "");
  assert.ok(title.length <= 52, `title too long: ${title.length}`);
  assert.ok(title.endsWith("…"));
  for (const tag of ['property="og:image" content="https://job-matcher-ecru.vercel.app/og-image.png"', 'name="twitter:card" content="summary_large_image"', 'property="og:url"', 'rel="apple-touch-icon"']) {
    assert.ok(page.includes(tag), `missing ${tag}`);
  }
  assert.ok(renderJobsIndex([job()]).includes('property="og:image"'));
});

test("JobPosting says applications happen on the original listing", () => {
  const schema = jobPostingSchema(job()) as Record<string, unknown>;
  assert.equal(schema.directApply, false);
});

test("clipTitle keeps short titles and cuts long ones at a word", () => {
  assert.equal(clipTitle("PM at Acme"), "PM at Acme");
  assert.equal(clipTitle("one two three four five six seven eight nine ten eleven twelve", 30), "one two three four five six…");
});
