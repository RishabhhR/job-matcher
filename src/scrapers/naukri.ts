import { existsSync } from "node:fs";
import * as cheerio from "cheerio";
import serverlessChromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Page } from "playwright-core";
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
const NAVIGATION_TIMEOUT_MS = 20_000;
const CARD_TIMEOUT_MS = 8_000;

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
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe").remove();
  const visibleText = $("body").text().replace(/\s+/g, " ");
  return /captcha|recaptcha|verify (that )?you are human|access denied|unusual traffic/i.test(visibleText);
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

function localChromiumPath(): string | undefined {
  const candidates = [
    process.env.NAUKRI_CHROMIUM_PATH,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

async function launchBrowser() {
  const executablePath = localChromiumPath();
  if (executablePath) {
    return playwrightChromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }

  if (process.platform !== "linux") {
    throw new Error("Naukri browser scraper needs Chrome; set NAUKRI_CHROMIUM_PATH to its executable.");
  }
  return playwrightChromium.launch({
    args: serverlessChromium.args,
    executablePath: await serverlessChromium.executablePath(),
    headless: true,
  });
}

async function fetchPage(page: Page, url: URL): Promise<RawPosting[]> {
  let response;
  try {
    response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      throw new Error(`Naukri browser navigation timed out after ${NAVIGATION_TIMEOUT_MS / 1000}s for ${url.pathname}.`);
    }
    throw error;
  }

  const status = response?.status();
  if (status === 403 || status === 406 || status === 429) {
    throw new Error(`Naukri returned HTTP ${status}; the public page is unavailable to this request.`);
  }
  if (status && status >= 400) throw new Error(`Naukri returned HTTP ${status}.`);

  try {
    await page.locator(".srp-jobtuple-wrapper").first().waitFor({ state: "attached", timeout: CARD_TIMEOUT_MS });
  } catch {
    // Challenge pages often load successfully at HTTP level but contain no job cards.
  }
  const html = await page.content();
  if (hasChallenge(html)) {
    throw new Error("Naukri returned an access or CAPTCHA challenge; scraper stopped without retrying around it.");
  }
  const postings = parseCards(html, url);
  if (postings.length === 0) {
    throw new Error("Naukri returned no recognizable public job cards; page markup may have changed or jobs may be client-rendered.");
  }
  return postings;
}

function browserUserAgent(version: string): string {
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
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

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      locale: "en-IN",
      viewport: { width: 1365, height: 900 },
      userAgent: browserUserAgent(browser.version()),
    });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") await route.abort();
      else await route.continue();
    });

    for (const [queryIndex, base] of bases.entries()) {
      let queryCount = 0;
      for (let pageNumber = 1; pageNumber <= MAX_PAGES && queryCount < maxResults; pageNumber += 1) {
        if (pageNumber > 1 || queryIndex > 0) await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
        const pagePostings = await fetchPage(page, pageUrl(base, pageNumber));
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
    await context.close();
  } finally {
    await browser.close();
  }
  return results;
}
