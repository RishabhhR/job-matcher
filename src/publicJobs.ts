/** Public job pages use posting fields only. Never pass user matches or CV data here. */
export interface PublicPosting {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  description: string;
  applyUrl: string;
  postedAt: string | null;
  scrapedAt: string;
}

const SITE = "https://job-matcher-ecru.vercel.app";
const SCHEMA_DATE_SOURCES = new Set(["lever", "ashby"]);
const CITY_NAMES: [RegExp, string][] = [
  [/\b(?:bengaluru|bangalore)\b/i, "Bengaluru"],
  [/\bhyderabad\b/i, "Hyderabad"],
  [/\bpune\b/i, "Pune"],
  [/\bmumbai\b/i, "Mumbai"],
  [/\b(?:new delhi|delhi)\b/i, "Delhi"],
  [/\b(?:gurugram|gurgaon)\b/i, "Gurugram"],
  [/\bchennai\b/i, "Chennai"],
  [/\bnoida\b/i, "Noida"],
  [/\bkolkata\b/i, "Kolkata"],
  [/\bahmedabad\b/i, "Ahmedabad"],
];
const US_CITY_NAMES: [RegExp, string][] = [
  [/\bnew york\b/i, "New York"],
  [/\bsan francisco\b/i, "San Francisco"],
  [/\bseattle\b/i, "Seattle"],
  [/\baustin\b/i, "Austin"],
  [/\bboston\b/i, "Boston"],
  [/\bchicago\b/i, "Chicago"],
  [/\blos angeles\b/i, "Los Angeles"],
];

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

export function safeApplyUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceName(source: string): string {
  return ({ greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", linkedin: "LinkedIn", naukri: "Naukri" } as Record<string, string>)[source] || "Job board";
}

function documentHtml(title: string, description: string, canonical: string, body: string, jsonLd?: object): string {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · JobMatcher</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/v2/css/tokens.css"><link rel="stylesheet" href="/v2/css/base.css"><link rel="stylesheet" href="/v2/css/landing.css"><script src="/analytics.js"></script><script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};</script><script defer src="/_vercel/insights/script.js"></script>${ld}</head><body><a class="skip-link" href="#public-content">Skip to content</a><main id="public-content" class="public-jobs"><header class="public-jobs-head"><a class="landing-brand" href="/"><span class="landing-brand-mark" aria-hidden="true">✦</span>JobMatcher</a><nav aria-label="Public job navigation"><a href="/jobs">Browse jobs</a><a href="/">How JobMatcher works</a></nav></header>${body}</main></body></html>`;
}

function locationAddress(location: string): { city: string; country: string } | null {
  const indianCity = CITY_NAMES.find(([pattern]) => pattern.test(location))?.[1];
  if (indianCity) return { city: indianCity, country: "IN" };
  const usCity = US_CITY_NAMES.find(([pattern]) => pattern.test(location))?.[1];
  if (usCity) return { city: usCity, country: "US" };
  return null;
}

export function jobPostingSchema(job: PublicPosting): object | null {
  // Greenhouse exposes an update timestamp, not the original publication date.
  // LinkedIn and Naukri can expose relative/partial dates. Do not invent a date.
  if (!SCHEMA_DATE_SOURCES.has(job.source)) return null;
  const applyUrl = safeApplyUrl(job.applyUrl);
  const description = job.description.trim();
  const address = locationAddress(job.location);
  const posted = job.postedAt ? new Date(job.postedAt) : null;
  if (!applyUrl || !address || description.length < 120 || description.length > 25_000 || !posted || Number.isNaN(posted.getTime()) || posted.getTime() > Date.now() + 86_400_000) return null;
  return {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: `<p>${escapeHtml(description)}</p>`,
    datePosted: posted.toISOString(),
    hiringOrganization: { "@type": "Organization", name: job.company },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: address.city, addressCountry: address.country } },
    url: `${SITE}/jobs/${encodeURIComponent(job.id)}`,
  };
}

export function renderJobsIndex(jobs: PublicPosting[]): string {
  const cards = jobs.map((job) => `<article class="public-job-card"><div><span class="public-job-source">${escapeHtml(sourceName(job.source))}</span><h2><a href="/jobs/${encodeURIComponent(job.id)}">${escapeHtml(job.title)}</a></h2><p>${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}</p></div><a class="btn btn-ghost" href="/jobs/${encodeURIComponent(job.id)}" aria-label="View ${escapeHtml(job.title)} at ${escapeHtml(job.company)}">View job</a></article>`).join("");
  const body = `<section class="public-jobs-intro"><p class="landing-kicker">Public job preview</p><h1>Recently indexed jobs</h1><p>Browse a sample of openings found in the last three days. Check the original employer listing for current availability before applying.</p></section><section aria-label="Recent job listings" class="public-job-list">${cards || `<div class="public-job-empty"><h2>No recent jobs to show right now</h2><p>New public listings appear here as sources are checked.</p></div>`}</section><p class="public-job-foot">Want matches tailored to your CV? <a href="/">Try JobMatcher</a>.</p>`;
  return documentHtml("Recent jobs", "Browse recent public job listings found by JobMatcher across supported sources.", `${SITE}/jobs`, body);
}

export function renderJobDetail(job: PublicPosting): string {
  const safeUrl = safeApplyUrl(job.applyUrl);
  const description = job.description.trim().slice(0, 25_000);
  const date = job.postedAt && !Number.isNaN(Date.parse(job.postedAt)) ? new Date(job.postedAt).toISOString().slice(0, 10) : null;
  const dateLabel = job.source === "greenhouse" ? "Updated" : SCHEMA_DATE_SOURCES.has(job.source) ? "Posted" : "Listed";
  const body = `<article class="public-job-detail"><p class="landing-kicker">${escapeHtml(sourceName(job.source))} listing</p><h1>${escapeHtml(job.title)}</h1><p class="public-job-meta">${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}${date ? ` · ${dateLabel} ${escapeHtml(date)}` : ""}</p><div class="public-job-description"><h2>About this role</h2><p>${escapeHtml(description)}</p></div><div class="public-job-actions">${safeUrl ? `<a class="btn btn-primary" href="${escapeHtml(safeUrl)}" rel="noopener noreferrer">Open original listing <span aria-hidden="true">↗</span></a>` : ""}<a class="btn btn-ghost" href="/jobs">More recent jobs</a></div><p class="public-job-note">This preview was last seen ${escapeHtml(job.scrapedAt.slice(0, 10))}. The original publisher controls availability and applications.</p></article>`;
  return documentHtml(`${job.title} at ${job.company}`, `${job.title} at ${job.company}${job.location ? ` in ${job.location}` : ""}. View the original listing to apply.`, `${SITE}/jobs/${encodeURIComponent(job.id)}`, body, jobPostingSchema(job) || undefined);
}

export function renderJobNotFound(): string {
  return documentHtml("Job not found", "This job preview is no longer available.", `${SITE}/jobs`, `<section class="public-jobs-intro"><h1>This preview is no longer available</h1><p>It may have aged out of our recent listings. Check the current job index instead.</p><a class="btn btn-primary" href="/jobs">Browse recent jobs</a></section>`).replace("</head>", `<meta name="robots" content="noindex"></head>`);
}

export function renderJobsUnavailable(): string {
  return documentHtml("Jobs temporarily unavailable", "Recent jobs are temporarily unavailable.", `${SITE}/jobs`, `<section class="public-jobs-intro"><h1>Recent jobs are temporarily unavailable</h1><p>Please try again shortly. Your saved matches are unaffected.</p><a class="btn btn-primary" href="/jobs">Try again</a></section>`).replace("</head>", `<meta name="robots" content="noindex"></head>`);
}
