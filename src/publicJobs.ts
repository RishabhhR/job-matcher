import { leadFormHtml } from "./leads.js";
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

const OG_IMAGE = `${SITE}/og-image.png`;

/** Keep page titles near the ~60 characters search results show (TASK-094). */
export function clipTitle(text: string, max = 52): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const atSpace = cut.lastIndexOf(" ");
  return `${(atSpace > max * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

function socialMeta(title: string, description: string, canonical: string): string {
  const t = escapeHtml(`${title} · JobMatcher`);
  const d = escapeHtml(description);
  const u = escapeHtml(canonical);
  return `<meta property="og:type" content="website"><meta property="og:site_name" content="JobMatcher"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${u}"><meta property="og:image" content="${OG_IMAGE}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><meta name="twitter:image" content="${OG_IMAGE}"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
}

function documentHtml(title: string, description: string, canonical: string, body: string, jsonLd?: object): string {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · JobMatcher</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(canonical)}"><meta name="google-site-verification" content="f4fVedQZIRY6Ds-9YLOASgsaSkYm0Y-3STOHTMCldR8">${socialMeta(title, description, canonical)}<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/v2/css/tokens.css"><link rel="stylesheet" href="/v2/css/base.css"><link rel="stylesheet" href="/v2/css/landing.css"><script src="/analytics.js"></script><script>window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};</script><script defer src="/_vercel/insights/script.js"></script><script>window.si=window.si||function(){(window.siq=window.siq||[]).push(arguments);};window.speedInsightsBeforeSend=function(d){try{var u=new URL(d.url);u.search="";d.url=u.toString();}catch(e){}return d;};</script><script defer src="/_vercel/speed-insights/script.js"></script>${ld}</head><body><a class="skip-link" href="#public-content">Skip to content</a><main id="public-content" class="public-jobs"><header class="public-jobs-head"><a class="landing-brand" href="/"><span class="landing-brand-mark" aria-hidden="true">✦</span>JobMatcher</a><nav aria-label="Public job navigation"><a href="/jobs">Browse jobs</a><a href="/#how-it-works">How it works</a><a class="btn btn-primary btn-sm" href="/?signin=1">Match your CV &rarr;</a></nav></header>${body}</main></body></html>`;
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
    // Applications happen on the original listing, not on this page (TASK-094).
    directApply: false,
  };
}

/**
 * sitemap.xml (TASK-094): the landing page, the job index and every job preview the
 * public routes currently serve (same freshness filter), so crawlers find /jobs/:id.
 */
export function renderSitemap(jobs: Array<{ id: string; scrapedAt: string }>, now = new Date()): string {
  const day = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z")) : NaN;
    return (Number.isNaN(t) ? now : new Date(t)).toISOString().slice(0, 10);
  };
  const newest = jobs[0]?.scrapedAt;
  const entry = (loc: string, lastmod: string) => `<url><loc>${escapeHtml(loc)}</loc><lastmod>${lastmod}</lastmod></url>`;
  const urls = [
    entry(`${SITE}/`, day(undefined)),
    entry(`${SITE}/jobs`, day(newest)),
    ...jobs.map((job) => entry(`${SITE}/jobs/${encodeURIComponent(job.id)}`, day(job.scrapedAt))),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>\n`;
}

export function renderJobsIndex(jobs: PublicPosting[]): string {
  const cards = jobs.map((job) => `<article class="public-job-card"><div><span class="public-job-source">${escapeHtml(sourceName(job.source))}</span><h2><a href="/jobs/${encodeURIComponent(job.id)}">${escapeHtml(job.title)}</a></h2><p>${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}</p></div><a class="btn btn-ghost" href="/jobs/${encodeURIComponent(job.id)}" aria-label="View ${escapeHtml(job.title)} at ${escapeHtml(job.company)}">View job</a></article>`).join("");
  const itemListSchema = jobs.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": "Recently Indexed Tech Jobs",
    "itemListElement": jobs.slice(0, 30).map((job, idx) => ({
      "@type": "ListItem",
      "position": idx + 1,
      "name": `${job.title} at ${job.company}`,
      "url": `${SITE}/jobs/${encodeURIComponent(job.id)}`,
    })),
  } : undefined;
  const body = `<section class="public-jobs-intro"><p class="landing-kicker">AI Tech Job Directory · Product &amp; Engineering</p><h1>Recently indexed jobs</h1><p>Browse verified Product Manager, Software Engineer, and Remote Tech job openings from Greenhouse, Lever, Ashby, LinkedIn, and Naukri found in the last three days. Check the original employer listing for current availability before applying.</p><nav class="public-jobs-filters" aria-label="Popular job searches"><span class="public-jobs-filter-label">Top Searches:</span><a class="public-filter-pill" href="/jobs">All Roles</a><a class="public-filter-pill" href="/jobs">Product Manager</a><a class="public-filter-pill" href="/jobs">Software Engineer</a><a class="public-filter-pill" href="/jobs">Remote Jobs</a><a class="public-filter-pill" href="/jobs">Bengaluru</a><a class="public-filter-pill" href="/jobs">Full Stack</a><a class="public-filter-pill" href="/jobs">Greenhouse</a><a class="public-filter-pill" href="/jobs">Ashby</a><a class="public-filter-pill" href="/jobs">Lever</a></nav><div class="public-jobs-cta"><div class="public-jobs-cta-text"><strong>Get matched with jobs tailored to your CV</strong><p>Upload your resume to calculate AI fit scores across LinkedIn, Greenhouse, Lever, and Ashby, and get a daily digest delivered to your inbox.</p></div><a class="btn btn-primary" href="/?signin=1">Upload CV &amp; Create Digest &rarr;</a></div></section>${leadFormHtml("jobs_index")}<section aria-label="Recent job listings" class="public-job-list">${cards || `<div class="public-job-empty"><h2>No recent jobs to show right now</h2><p>New public listings appear here as sources are checked.</p></div>`}</section><section class="public-jobs-directory" aria-label="Explore tech job categories"><h2>Explore Tech Jobs by Role, Location &amp; Source</h2><div class="public-jobs-directory-grid"><div><h3>Top Tech Roles</h3><p>Product Manager Jobs · Associate Product Manager (APM) · Senior PM · Software Engineer · Frontend Developer · Backend Engineer · Full Stack Engineer · AI &amp; Machine Learning</p></div><div><h3>Key Tech Hubs</h3><p>Remote Jobs (Worldwide) · Tech Jobs in Bengaluru (Bangalore) · Tech Jobs in Hyderabad · Tech Jobs in Pune · Tech Jobs in Delhi-NCR (Gurugram, Noida) · Tech Jobs in San Francisco</p></div><div><h3>Connected ATS Portals</h3><p>Greenhouse Startup Jobs · Ashby Careers · Lever Tech Jobs · LinkedIn Verified Openings · Naukri Tech Listings</p></div></div></section><section class="public-job-foot-card"><div class="public-job-foot-content"><p class="landing-kicker">Automate your job search</p><h2>Never miss an opening that fits your profile</h2><p>Bring your CV. JobMatcher scans new openings daily and scores them against your experience so you only spend time applying to high-fit roles.</p><a class="btn btn-primary" href="/?signin=1">Match My CV &amp; Start Free &rarr;</a></div></section>`;
  return documentHtml("Product Manager & Software Engineer Jobs — Recent Openings", "Browse verified Product Manager, Software Engineer, and Remote Tech job openings from Greenhouse, Lever, Ashby, LinkedIn, and Naukri. Scored daily by AI.", `${SITE}/jobs`, body, itemListSchema);
}

export function renderJobDetail(job: PublicPosting): string {
  const safeUrl = safeApplyUrl(job.applyUrl);
  const description = job.description.trim().slice(0, 25_000);
  const date = job.postedAt && !Number.isNaN(Date.parse(job.postedAt)) ? new Date(job.postedAt).toISOString().slice(0, 10) : null;
  const dateLabel = job.source === "greenhouse" ? "Updated" : SCHEMA_DATE_SOURCES.has(job.source) ? "Posted" : "Listed";
  const body = `<article class="public-job-detail"><nav class="public-job-breadcrumbs" aria-label="Breadcrumb navigation"><a href="/">Home</a> &rsaquo; <a href="/jobs">Jobs</a> &rsaquo; <span>${escapeHtml(clipTitle(job.title, 32))}</span></nav><p class="landing-kicker">${escapeHtml(sourceName(job.source))} listing</p><h1>${escapeHtml(job.title)}</h1><p class="public-job-meta">${escapeHtml(job.company)}${job.location ? ` · ${escapeHtml(job.location)}` : ""}${date ? ` · ${dateLabel} ${escapeHtml(date)}` : ""}</p><div class="public-job-detail-cta"><div class="public-job-detail-cta-copy"><strong>Want to know how well your background fits this role?</strong><p>Upload your CV to see your match score, qualification breakdown, and receive automated daily alerts for similar roles.</p></div><a class="btn btn-primary" href="/?signin=1">Check My CV Fit &rarr;</a></div><div class="public-job-description"><h2>About this role</h2><p>${escapeHtml(description)}</p></div><div class="public-job-actions">${safeUrl ? `<a class="btn btn-primary" href="${escapeHtml(safeUrl)}" rel="noopener noreferrer">Open original listing <span aria-hidden="true">↗</span></a>` : ""}<a class="btn btn-ghost" href="/jobs">More recent jobs</a><a class="btn btn-ghost" href="/?signin=1">Match your CV</a></div><p class="public-job-note">This preview was last seen ${escapeHtml(job.scrapedAt.slice(0, 10))}. The original publisher controls availability and applications.</p></article>${leadFormHtml("job_detail")}`;
  return documentHtml(clipTitle(`${job.title} at ${job.company}`), `${job.title} at ${job.company}${job.location ? ` in ${job.location}` : ""}. View the original listing to apply.`, `${SITE}/jobs/${encodeURIComponent(job.id)}`, body, jobPostingSchema(job) || undefined);
}

export function renderJobNotFound(): string {
  return documentHtml("Job not found", "This job preview is no longer available.", `${SITE}/jobs`, `<section class="public-jobs-intro"><h1>This preview is no longer available</h1><p>It may have aged out of our recent listings. Check the current job index instead.</p><a class="btn btn-primary" href="/jobs">Browse recent jobs</a></section>`).replace("</head>", `<meta name="robots" content="noindex"></head>`);
}

export function renderJobsUnavailable(): string {
  return documentHtml("Jobs temporarily unavailable", "Recent jobs are temporarily unavailable.", `${SITE}/jobs`, `<section class="public-jobs-intro"><h1>Recent jobs are temporarily unavailable</h1><p>Please try again shortly. Your saved matches are unaffected.</p><a class="btn btn-primary" href="/jobs">Try again</a></section>`).replace("</head>", `<meta name="robots" content="noindex"></head>`);
}
