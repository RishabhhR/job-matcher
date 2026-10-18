import { fetchAshby, fetchGreenhouse, fetchLever, type RawPosting } from "./scrapers.js";
import { fetchLinkedInPublic, fetchLinkedInDescriptions } from "./scrapers/linkedin.js";
import { fetchNaukri, type NaukriSearchInput } from "./scrapers/naukri.js";
import { dedupePostings } from "./normalize.js";
import { keywordPrefilter, scoreAll, PATIENT_RETRY, type Profile, type ScoredMatch, type RetryOptions } from "./match.js";
import { locationPatterns, placesLabel, primaryPlace, splitPlaces } from "./location.js";

// Build location filter patterns from a user's profile preferences.
// Always includes remote/hybrid/anywhere. If no country or city is set, returns
// null to skip filtering entirely (keeps all postings).
function buildLocationPatterns(profile: Profile): RegExp[] | null {
  return locationPatterns(profile);
}

function filterByLocation(postings: RawPosting[], profile: Profile): RawPosting[] {
  const patterns = buildLocationPatterns(profile);
  if (!patterns) return postings; // no location prefs → keep everything
  return postings.filter((p) => {
    const loc = p.location || "";
    // If location is empty (some ATS boards don't set it), keep the posting
    if (!loc) return true;
    return patterns.some((re) => re.test(loc));
  });
}

export interface RunnerOptions {
  cvText: string;
  profile: Profile;
  companies: {
    greenhouse: string[];
    lever: string[];
    ashby: string[];
  };
  linkedin?: {
    location?: string;
    maxResults?: number;
  };
  naukri?: NaukriSearchInput;
  onProgress?: (status: string, message: string) => void;
  // Scheduled scrape-only crons have a whole hour before the separate email cron
  // fires, so it's worth riding out rate limits with long waits instead of giving
  // up fast - interactive/SSE callers (the web UI) should leave this off.
  patient?: boolean;
}

export async function runJobMatcher(options: RunnerOptions): Promise<ScoredMatch[]> {
  const { cvText, profile, companies, linkedin, naukri, onProgress = () => {}, patient = false } = options;
  const retryOptions: RetryOptions = patient ? PATIENT_RETRY : {};

  const locationLabel = placesLabel(profile) || "all locations";

  // Per-source failure isolation: each source's scrape is wrapped so a throw/block
  // in one (for example, LinkedIn throttling or an unavailable board API) never
  // aborts the whole run and discards the other sources' already-fetched postings.
  // `sourceHealth` records raw count per source (0 = returned nothing, e.g. a silent
  // block) or an error, so "no new jobs" can be distinguished from "source is down".
  const sourceHealth: Record<string, { count: number; ok: boolean; error?: string }> = {};
  async function safeScrape(source: string, fn: () => Promise<RawPosting[]>): Promise<RawPosting[]> {
    try {
      const postings = await fn();
      sourceHealth[source] = { count: postings.length, ok: true };
      return postings;
    } catch (err) {
      const message = (err as Error).message || String(err);
      sourceHealth[source] = { count: 0, ok: false, error: message };
      onProgress("source_error", `Source "${source}" failed and was skipped (other sources continue): ${message}`);
      return [];
    }
  }

  const boardSources = [
    { source: "greenhouse", companies: companies.greenhouse, fetch: fetchGreenhouse },
    { source: "lever", companies: companies.lever, fetch: fetchLever },
    { source: "ashby", companies: companies.ashby, fetch: fetchAshby },
  ] as const;
  const boardResults = await Promise.all(boardSources.map(async ({ source, companies: boards, fetch }) => {
    onProgress(`scraping_${source}`, `Scraping ${source} boards for ${boards.length} companies...`);
    const raw = await safeScrape(source, async () => {
      const settled = await Promise.allSettled(boards.map((company) => fetch(company)));
      const failed = settled.filter((result) => result.status === "rejected").length;
      if (failed > 0) onProgress("source_warning", `${source}: ${failed}/${boards.length} company boards failed; successful boards are retained.`);
      if (boards.length > 0 && failed === boards.length) {
        throw new Error(`All ${source} company boards failed (${failed}/${boards.length}).`);
      }
      return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    });
    const filtered = filterByLocation(raw, profile);
    onProgress(`scraping_${source}_complete`, `Fetched ${raw.length} ${source} postings, ${filtered.length} matched ${locationLabel} location filter.`);
    return filtered;
  }));
  const atsPostings = boardResults.flat();

  const linkedinKeywords = profile.targetDesignation;
  // Build LinkedIn location from profile prefs, falling back to explicit option or worldwide
  const defaultLinkedinLocation = [primaryPlace({ preferredCity: profile.preferredCity }), splitPlaces(profile.preferredCountry)[0]].filter(Boolean).join(", ") || "worldwide";
  const linkedinLocation = linkedin?.location || defaultLinkedinLocation;
  const linkedinMaxResults = linkedin?.maxResults || 25;

  onProgress("scraping_linkedin", `Scraping LinkedIn for "${linkedinKeywords}" in ${linkedinLocation} (max ${linkedinMaxResults} results)...`);
  const linkedinPostingsRaw = await safeScrape("linkedin", () => fetchLinkedInPublic({
    keywords: linkedinKeywords,
    location: linkedinLocation,
    maxResults: linkedinMaxResults,
    fetchDescriptions: false,
  }));
  // The location string above is only a loose search hint to LinkedIn's own guest
  // endpoint - it doesn't reliably restrict results, so apply the same explicit
  // regex filter used for ATS postings to keep filtering consistent across sources.
  const linkedinPostings = filterByLocation(linkedinPostingsRaw, profile);
  onProgress("scraping_linkedin_complete", `Fetched ${linkedinPostingsRaw.length} LinkedIn postings, ${linkedinPostings.length} matched ${locationLabel} location filter.`);

  const naukriInput: NaukriSearchInput = naukri || {
    keyword: profile.targetDesignation,
    location: primaryPlace(profile) || "India",
    maxResultsPerQuery: 15,
  };
  onProgress("scraping_naukri", `Scraping Naukri for "${naukriInput.keyword || "search URL"}" (max ${naukriInput.maxResultsPerQuery || 15} results)...`);
  const naukriRaw = await safeScrape("naukri", () => fetchNaukri(naukriInput));
  const naukriPostings = filterByLocation(naukriRaw, profile);
  onProgress("scraping_naukri_complete", `Fetched ${naukriRaw.length} Naukri postings, ${naukriPostings.length} matched ${locationLabel} location filter.`);

  const rawPostings = [...atsPostings, ...linkedinPostings, ...naukriPostings];

  // Scrape-health summary: surfaces per-source counts so a silent block (count 0 / ok:false)
  // is visible in the run log rather than looking like "no new jobs today".
  const healthSummary = Object.entries(sourceHealth)
    .map(([s, h]) => `${s}=${h.ok ? h.count : `ERR(${h.error?.slice(0, 60)})`}`)
    .join(", ");
  onProgress("scrape_health", `Per-source scrape results: ${healthSummary}`);

  onProgress("processing", `Total raw postings collected: ${rawPostings.length}. Running deduplication...`);

  const deduped = dedupePostings(rawPostings);
  onProgress("processing", `Deduplication complete. Retained ${deduped.length} unique postings.`);

  const shortlisted = keywordPrefilter(deduped, profile.targetDesignation);
  onProgress("processing", `Filtered down to ${shortlisted.length} postings matching target designation "${profile.targetDesignation}".`);

  if (shortlisted.length === 0) {
    onProgress("complete", "No postings matched the target designation.");
    return [];
  }

  // Fetch descriptions only for the matching/filtered subset of LinkedIn jobs (cap at 40 to prevent Vercel timeout)
  const allLinkedinToFetch = shortlisted.filter((p) => p.source === "linkedin" && !p.descriptionText);
  const linkedinToFetch = allLinkedinToFetch.slice(0, 40);

  if (linkedinToFetch.length > 0) {
    onProgress("scraping_linkedin_descriptions", `Fetching descriptions for top ${linkedinToFetch.length} of ${allLinkedinToFetch.length} shortlisted LinkedIn jobs...`);
    await fetchLinkedInDescriptions(linkedinToFetch);
  }

  // Only keep postings that actually have descriptions (ATS boards + successfully fetched LinkedIn)
  const finalShortlist = shortlisted.filter((p) => {
    if (p.source === "linkedin") {
      return p.descriptionText && p.descriptionText.length > 0;
    }
    return true; // ATS boards already have descriptions
  });

  if (finalShortlist.length === 0) {
    onProgress("complete", "No postings with descriptions matched the target designation.");
    return [];
  }

  // Scheduled runs share provider quotas across every due user. Score a bounded,
  // freshness-first slice so one hourly tick cannot consume the whole account's
  // free-tier budget; interactive searches retain the complete shortlist.
  const scheduledScoreLimit = 30;
  const scoreCandidates = patient
    ? finalShortlist
        .map((posting, index) => ({ posting, index, timestamp: posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN }))
        .sort((a, b) => {
          const aTime = Number.isFinite(a.timestamp) ? a.timestamp : Number.NEGATIVE_INFINITY;
          const bTime = Number.isFinite(b.timestamp) ? b.timestamp : Number.NEGATIVE_INFINITY;
          return bTime - aTime || a.index - b.index;
        })
        .slice(0, scheduledScoreLimit)
        .map(({ posting }) => posting)
    : finalShortlist;
  if (scoreCandidates.length < finalShortlist.length) {
    onProgress("scoring_limit", `Scheduled run capped scoring to the ${scoreCandidates.length} freshest postings; ${finalShortlist.length - scoreCandidates.length} remain eligible for later runs.`);
  }
  onProgress("scoring", `Scoring ${scoreCandidates.length} postings against CV via AI fallback chain (Groq -> Gemini -> Cerebras -> Mistral -> OpenRouter)...`);
  
  // Custom progress for scoring
  const batchSize = 6;
  const totalPostings = scoreCandidates.length;
  const totalBatches = Math.ceil(totalPostings / batchSize);
  const scoredMatches: ScoredMatch[] = [];
  let failedBatches = 0;

  for (let i = 0; i < totalPostings; i += batchSize) {
    const currentBatchNum = Math.floor(i / batchSize) + 1;
    const batch = scoreCandidates.slice(i, i + batchSize);
    onProgress("scoring", `Scoring batch ${currentBatchNum}/${totalBatches} (${batch.length} postings)...`);

    let provider = "none";
    try {
      const scored = await scoreAll(cvText, profile, batch, batch.length, retryOptions);
      provider = scored.provider;
      scoredMatches.push(...scored.results);
    } catch (err) {
      failedBatches++;
      const message = (err as Error).message || String(err);
      onProgress("scoring_error", `Scoring batch ${currentBatchNum}/${totalBatches} failed: ${message}`);
      // Scheduled sends already ran from stored matches. Keep successful batches
      // and finish green with an explicit warning rather than red-failing the
      // whole workflow after a quota outage. Interactive requests still surface it.
      if (!patient) throw err;
      break; // the provider circuit breakers are open; later batches cannot recover this run
    }

    if (!failedBatches && i + batchSize < totalPostings) {
      const baseSleep = provider === "gemini" ? 8000 : 4000;
      const sleepTime = patient ? baseSleep * 2 : baseSleep;
      onProgress("scoring", `Sleeping ${sleepTime / 1000}s to respect LLM rate limits (active provider: ${provider})...`);
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  // Sort matches by descending fit score
  scoredMatches.sort((a, b) => b.fitScore - a.fitScore);
  
  if (failedBatches) {
    onProgress("scoring_partial", `Scoring stopped after provider capacity was exhausted. Saved ${scoredMatches.length} of ${totalPostings} attempted postings; existing matches remain available for digests.`);
  }
  onProgress("complete", failedBatches
    ? `Scoring completed with a quota warning: ${scoredMatches.length} postings saved.`
    : `Scoring complete! Processed ${scoredMatches.length} postings.`);
  return scoredMatches;
}
