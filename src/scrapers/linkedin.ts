import * as cheerio from "cheerio";
import type { RawPosting } from "../scrapers.js";

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (baseMs: number) => baseMs + Math.floor(Math.random() * baseMs * 0.5);

function extractJobId(url: string): string {
  const match = url.match(/-(\d+)(\?|$)/);
  return match ? match[1] : url;
}

async function fetchSearchPage(keywords: string, location: string, start: number): Promise<string | null> {
  const url = `${SEARCH_URL}?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&start=${start}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchDescription(jobUrl: string): Promise<string> {
  try {
    const res = await fetch(jobUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return "";
    const html = await res.text();
    const $ = cheerio.load(html);
    return $(".show-more-less-html__markup").first().text().replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

interface LinkedInSearchOptions {
  keywords: string;
  location?: string;
  maxResults?: number;
  fetchDescriptions?: boolean;
  requestDelayMs?: number;
}

export async function fetchLinkedInPublic(options: LinkedInSearchOptions): Promise<RawPosting[]> {
  const { keywords, location = "India", maxResults = 25, fetchDescriptions = true, requestDelayMs = 1500 } = options;

  const postings: RawPosting[] = [];
  let start = 0;
  const pageSize = 25;

  while (postings.length < maxResults) {
    const html = await fetchSearchPage(keywords, location, start);
    if (!html) break;

    const $ = cheerio.load(html);
    const cards = $("li > div.job-search-card, div.job-search-card");
    if (cards.length === 0) break;

    cards.each((_, el) => {
      const card = $(el);
      const urn = card.attr("data-entity-urn") || "";
      const applyUrl = card.find("a.base-card__full-link").attr("href")?.split("?")[0] || "";
      const title = card.find("h3.base-search-card__title").text().trim();
      const company = card.find("h4.base-search-card__subtitle a").text().trim();
      const jobLocation = card.find("span.job-search-card__location").text().trim();

      if (!applyUrl || !title) return;

      postings.push({
        source: "linkedin",
        sourceJobId: urn.split(":").pop() || extractJobId(applyUrl),
        company: company || "Unknown",
        title,
        location: jobLocation,
        applyUrl,
        descriptionText: "",
      });
    });

    start += pageSize;
    await sleep(jitter(requestDelayMs));

    // Guest endpoint stops returning cards once results are exhausted.
    if (cards.length < pageSize) break;
  }

  const trimmed = postings.slice(0, maxResults);

  if (fetchDescriptions) {
    const batchSize = 3;
    for (let i = 0; i < trimmed.length; i += batchSize) {
      const batch = trimmed.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (posting) => {
          posting.descriptionText = await fetchDescription(posting.applyUrl);
        })
      );
      if (i + batchSize < trimmed.length) {
        await sleep(jitter(requestDelayMs));
      }
    }
  }

  return trimmed;
}
