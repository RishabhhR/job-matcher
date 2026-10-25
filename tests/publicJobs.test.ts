import assert from "node:assert/strict";
import { test } from "node:test";
import { jobPostingSchema, renderJobDetail, renderJobsIndex, safeApplyUrl, type PublicPosting } from "../src/publicJobs.js";

const job: PublicPosting = {
  id: "a346f2ec-ae2d-4071-b084-67f73fbe1381",
  source: "lever",
  company: "Example Co",
  title: "Product Manager",
  location: "Bengaluru, India",
  description: "Build a roadmap with engineering and design, gather feedback from customers, define launch milestones, and measure product results. This is a full role description.",
  applyUrl: "https://jobs.example.com/product-manager",
  postedAt: "2026-10-23T09:00:00Z",
  scrapedAt: "2026-10-24 03:00:00",
};

test("individual job page has one matching, valid JobPosting JSON-LD", () => {
  const page = renderJobDetail(job);
  const json = page.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
  assert.ok(json);
  const schema = JSON.parse(json);
  assert.equal(schema["@type"], "JobPosting");
  assert.equal(schema.title, job.title);
  assert.equal(schema.datePosted, "2026-10-23T09:00:00.000Z");
  assert.equal(schema.hiringOrganization.name, job.company);
  assert.equal(schema.jobLocation.address.addressCountry, "IN");
  assert.ok(page.includes(job.description));
  assert.ok(page.includes(job.applyUrl));
});

test("index page has crawlable links without JobPosting markup", () => {
  const page = renderJobsIndex([job]);
  assert.ok(page.includes(`<h2><a href="/jobs/${job.id}">Product Manager</a></h2>`));
  assert.ok(!page.includes('"@type":"JobPosting"'));
  assert.ok(page.includes('<link rel="canonical" href="https://job-matcher-ecru.vercel.app/jobs">'));
});

test("unreliable dates and locations do not get job markup", () => {
  assert.equal(jobPostingSchema({ ...job, source: "greenhouse" }), null);
  assert.equal(jobPostingSchema({ ...job, postedAt: null }), null);
  assert.equal(jobPostingSchema({ ...job, location: "Remote" }), null);
});

test("US locations use the correct country in job markup", () => {
  const schema = jobPostingSchema({ ...job, location: "San Francisco, California" }) as any;
  assert.equal(schema.jobLocation.address.addressLocality, "San Francisco");
  assert.equal(schema.jobLocation.address.addressCountry, "US");
});

test("public pages escape untrusted text and reject unsafe links", () => {
  const malicious = { ...job, title: '</title><script>alert(1)</script>', description: '</script><img src=x onerror=alert(1)>', applyUrl: "javascript:alert(1)" };
  const page = renderJobDetail(malicious);
  assert.ok(!page.includes("<script>alert(1)</script>"));
  assert.ok(!page.includes("<img src=x"));
  assert.ok(!page.includes('type="application/ld+json"'));
  assert.equal(safeApplyUrl("javascript:alert(1)"), null);
});

test("public jobs and job detail pages include prominent CV matching CTAs (TASK-095)", () => {
  const index = renderJobsIndex([job]);
  assert.ok(index.includes('href="/?signin=1"'));
  assert.ok(index.includes("Match your CV"));
  assert.ok(index.includes("Upload CV &amp; Create Digest"));

  const detail = renderJobDetail(job);
  assert.ok(detail.includes('href="/?signin=1"'));
  assert.ok(detail.includes("Check My CV Fit"));
});

