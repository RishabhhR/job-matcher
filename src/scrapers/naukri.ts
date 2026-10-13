import * as cheerio from "cheerio";
import type { RawPosting } from "../scrapers.js";

export interface NaukriSearchInput {
  /** One or more public Naukri search-result URLs. */
  startUrls?: string[];
  keyword?: string;
  location?: string;
  experience?: string;
  companyName?: string;
  jobAge?: 1 | 3 | 7 | 15 | 30;
  sort?: "relevance" | "date";
  ctcFilter?: string;
  jobTypeFilter?: "P" | "C" | "V" | "T" | "I";
  maxResultsPerQuery?: number;
}

const DEFAULT_MAX_RESULTS = 15;
const MAX_RESULTS = 15;
const MAX_QUERIES = 2;
const MAX_PAGES = 3;
const REQUEST_DELAY_MS = 2500;
// Naukri's public search pages can respond more slowly than the ATS APIs.
// Keep each request bounded while allowing a slower page to finish.
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "job-matcher/0.1 (+https://github.com/RishabhhR/job-matcher)";

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateSearchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Naukri startUrls must contain valid URLs.");
  }
  if (url.protocol !== "https:" || !/(^|\.)naukri\.com$/i.test(url.hostname)) {
    throw new Error("Naukri startUrls must use HTTPS and a naukri.com host.");
  }
  return url;
}

function buildSearchUrl(input: NaukriSearchInput): URL {
  const keyword = input.keyword?.trim();
  if (!keyword) throw new Error("Naukri search needs a keyword or at least one startUrl.");
  const location = input.location?.trim();
  const path = `${slug(keyword)}-jobs${location ? `-in-${slug(location)}` : "-in-india"}`;
  const url = new URL(`https://www.naukri.com/${path}`);
  url.searchParams.set("k", keyword);
  if (location) url.searchParams.set("l", location);
  if (input.experience) url.searchParams.set("experience", input.experience);
  if (input.companyName) url.searchParams.set("companyName", input.companyName);
  if (input.jobAge) url.searchParams.set("jobAge", String(input.jobAge));
  if (input.sort) url.searchParams.set("sort", input.sort);
  if (input.ctcFilter) url.searchParams.set("ctcFilter", input.ctcFilter);
  if (input.jobTypeFilter) url.searchParams.set("jobTypeFilter", input.jobTypeFilter);
  return url;
}

function pageUrl(base: URL, page: number): URL {
  if (page === 1) return new URL(base.toString());
  const url = new URL(base.toString());
  const cleanPath = url.pathname.replace(/-\d+\/?$/, "").replace(/\/$/, "");
  url.pathname = `${cleanPath}-${page}`;
  return url;
}

function firstText($card: cheerio.Cheerio<any>, selectors: string[]): string {
  for (const selector of selectors) {
    const text = $card.find(selector).first().text().replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

function toPostedAt(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  const absolute = new Date(value);
  if (!Number.isNaN(absolute.getTime())) return absolute.toISOString();

  const match = text.match(/(\d+)\s*(minute|min|hour|hr|day|week|month)s?\s*ago/);
  if (!match) {
    if (/just now|today|few hours? ago/.test(text)) return new Date().toISOString();
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const milliseconds = unit.startsWith("min") ? 60_000
    : unit.startsWith("hour") || unit.startsWith("hr") ? 3_600_000
      : unit.startsWith("day") ? 86_400_000
        : unit.startsWith("week") ? 604_800_000
          : 2_629_746_000;
  return new Date(Date.now() - amount * milliseconds).toISOString();
}

function hasChallenge(html: string): boolean {
  return /captcha|recaptcha|verify (that )?you are human|access denied|unusual traffic/i.test(html);
}

function parseCards(html: string, sourceUrl: URL): RawPosting[] {
  const $ = cheerio.load(html);
  const cards = $(".srp-jobtuple-wrapper");
  const postings: RawPosting[] = [];

  cards.each((_index, element) => {
    const card = $(element);
    const titleLink = card.find("a.title, .row1 a").first();
    const title = titleLink.text().replace(/\s+/g, " ").trim();
    const href = titleLink.attr("href");
    const applyUrl = href ? new URL(href, sourceUrl).toString() : "";
    const company = firstText(card, [".comp-name", ".row2 span a", ".row2 a"]) || "Unknown Company";
    const location = firstText(card, [".loc-wrap span span", ".locWdth", ".loc-wrap"]);
    const experience = firstText(card, [".exp-wrap span span", ".expwdth", ".exp-wrap"]);
    const salary = firstText(card, [".sal-wrap span span", ".sal-wrap", ".salary"]);
    const summary = firstText(card, [".job-desc", ".job-description", ".row4 span", ".row4"]);
    const rating = firstText(card, [".main-2", ".rating"]);
    const reviewText = firstText(card, [".review", ".reviews", ".review-count"]);
    const skills = card.find(".tag-li, .tags-gt li, .chips li")
      .map((_i, skill) => $(skill).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    const postedText = firstText(card, [".job-post-day", ".job-post-day span", "time"]);
    const jobId = applyUrl.match(/-(\d{8,})\/?(?:\?.*)?$/)?.[1]
      || card.attr("data-job-id")
      || "";

    if (!title || !applyUrl) return;
    const details = [
      summary,
      experience ? `Experience: ${experience}` : "",
      salary ? `Salary: ${salary}` : "",
      skills.length ? `Skills: ${skills.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    const postedAt = toPostedAt(postedText);

    postings.push({
      source: "naukri",
      sourceJobId: jobId,
      company,
      title,
      location,
      applyUrl,
      descriptionText: details,
      postedAt,
      sourceMetadata: {
        jobId: jobId || null,
        companyName: company,
        jdURL: applyUrl,
        tagsAndSkills: skills,
        jobDescription: summary || null,
        experienceLabel: experience || null,
        salaryLabel: salary || null,
        salaryCurrency: salary ? "INR" : null,
        hideSalary: !salary || /not disclosed/i.test(salary),
        locationLabel: location || null,
        postedAtLabel: postedText || null,
        createdDate: postedAt ? Date.parse(postedAt) : null,
        walkinJob: /walk[ -]?in/i.test(`${title} ${summary}`),
        ambitionBoxRating: rating || null,
        ambitionBoxReviews: reviewText ? Number(reviewText.replace(/\D/g, "")) || null : null,
        searchUrl: sourceUrl.toString(),
      },
    });
  });
  return postings;
}

async function fetchPage(url: URL): Promise<RawPosting[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      throw new Error(`Naukri request timed out for ${url.pathname}.`);
    }
    throw error;
  }

  if (response.status === 403 || response.status === 406 || response.status === 429) {
    throw new Error(`Naukri returned HTTP ${response.status}; the public page is unavailable to this request.`);
  }
  if (!response.ok) throw new Error(`Naukri returned HTTP ${response.status}.`);

  const html = await response.text();
  if (hasChallenge(html)) {
    throw new Error("Naukri returned an access or CAPTCHA challenge; scraper stopped without retrying around it.");
  }
  const postings = parseCards(html, url);
  if (postings.length === 0) {
    throw new Error("Naukri returned no recognizable public job cards; page markup may have changed or jobs may be client-rendered.");
  }
  return postings;
}

export async function fetchNaukri(input: NaukriSearchInput): Promise<RawPosting[]> {
  if (input.startUrls !== undefined && (!Array.isArray(input.startUrls) || input.startUrls.length > MAX_QUERIES)) {
    throw new Error(`Naukri accepts at most ${MAX_QUERIES} search URLs per run.`);
  }
  const requestedMax = input.maxResultsPerQuery ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(requestedMax) || requestedMax < 1) {
    throw new Error("Naukri maxResultsPerQuery must be a positive integer.");
  }
  const maxResults = Math.min(requestedMax, MAX_RESULTS);
  const bases = input.startUrls?.length
    ? input.startUrls.map((url) => {
        if (typeof url !== "string") throw new Error("Naukri startUrls must contain strings.");
        return validateSearchUrl(url);
      })
    : [buildSearchUrl(input)];
  const results: RawPosting[] = [];
  const seen = new Set<string>();

  for (const [queryIndex, base] of bases.entries()) {
    let queryCount = 0;
    for (let page = 1; page <= MAX_PAGES && queryCount < maxResults; page += 1) {
      if (page > 1 || queryIndex > 0) await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
      const pagePostings = await fetchPage(pageUrl(base, page));
      for (const posting of pagePostings) {
        const key = posting.sourceJobId || posting.applyUrl;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(posting);
          queryCount += 1;
          if (queryCount >= maxResults) break;
        }
      }
      if (pagePostings.length < 10) break;
    }
  }
  return results;
}
