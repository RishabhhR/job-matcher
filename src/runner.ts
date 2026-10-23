import { fetchAshby, fetchGreenhouse, fetchLever, type RawPosting } from "./scrapers.js";
import { fetchLinkedInPublic, fetchLinkedInDescriptions } from "./scrapers/linkedin.js";
import { fetchNaukri, type NaukriSearchInput } from "./scrapers/naukri.js";
import { dedupePostings } from "./normalize.js";
import { keywordPrefilter, scoreAll, computeYearsOfExperience, PATIENT_RETRY, type Profile, type ScoredMatch, type RetryOptions } from "./match.js";
import { postingHash, selectScheduledCandidates } from "./candidates.js";
import { locationPatterns, placesLabel, primaryPlace, splitPlaces } from "./location.js";
import { upsertScrapeSourceStatuses } from "./db.js";
import { captureTelemetryEvent, captureTelemetryError } from "./telemetry.js";

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
  userId?: string;
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
  /** Scheduled runs: dedup hashes of postings already scored for this user since their CV/profile changed (TASK-073). */
  alreadyScored?: Set<string>;
  // Scheduled scrape-only crons have a whole hour before the separate email cron
  // fires, so it's worth riding out rate limits with long waits instead of giving
  // up fast - interactive/SSE callers (the web UI) should leave this off.
  patient?: boolean;
}

export async function runJobMatcher(options: RunnerOptions): Promise<ScoredMatch[]> {
  const { cvText, profile, companies, linkedin, naukri, onProgress = () => {}, patient = false, alreadyScored } = options;
  const retryOptions: RetryOptions = patient ? PATIENT_RETRY : {};

  const locationLabel = placesLabel(profile) || "all locations";

  // Per-source failure isolation: each source's scrape is wrapped so a throw/block
  // in one (for example, LinkedIn throttling or an unavailable board API) never
  // aborts the whole run and discards the other sources' already-fetched postings.
  // `sourceHealth` records raw count per source (0 = returned nothing, e.g. a silent
  // block) or an error, so "no new jobs" can be distinguished from "source is down".
  const sourceHealth: Record<string, { count: number; ok: boolean; error?: string }> = {};
  async function safeScrape(source: string, fn: (signal?: AbortSignal) => Promise<RawPosting[]>, timeoutMs = 15000): Promise<RawPosting[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const postings = await Promise.race([
        fn(controller.signal),
        new Promise<RawPosting[]>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error(`Timed out after ${timeoutMs}ms`)));
        }),
      ]);
      sourceHealth[source] = { count: postings.length, ok: true };
      return postings;
    } catch (err) {
      const message = (err as Error).message || String(err);
      sourceHealth[source] = { count: 0, ok: false, error: message };
      void captureTelemetryError("scrape_source", err, { source });
      onProgress("source_error", `Source "${source}" failed and was skipped (other sources continue): ${message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  const boardSources = [
    { source: "greenhouse", companies: companies.greenhouse, fetch: fetchGreenhouse },
    { source: "lever", companies: companies.lever, fetch: fetchLever },
    { source: "ashby", companies: companies.ashby, fetch: fetchAshby },
  ] as const;
  const boardResults = await Promise.all(boardSources.map(async ({ source, companies: boards, fetch }) => {
    onProgress(`scraping_${source}`, `Scraping ${source} boards for ${boards.length} companies...`);
    const raw = await safeScrape(source, async (signal) => {
      const settled = await Promise.allSettled(boards.map((company) => fetch(company, signal)));
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
  const linkedinPostingsRaw = await safeScrape("linkedin", (signal) => fetchLinkedInPublic({
    keywords: linkedinKeywords,
    location: linkedinLocation,
    maxResults: linkedinMaxResults,
    fetchDescriptions: false,
    signal,
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
  const naukriRaw = await safeScrape("naukri", (signal) => fetchNaukri({ ...naukriInput, signal }));
  const naukriPostings = filterByLocation(naukriRaw, profile);
  onProgress("scraping_naukri_complete", `Fetched ${naukriRaw.length} Naukri postings, ${naukriPostings.length} matched ${locationLabel} location filter.`);

  const rawPostings = [...atsPostings, ...linkedinPostings, ...naukriPostings];

  // Scrape-health summary: surfaces per-source counts so a silent block (count 0 / ok:false)
  // is visible in the run log rather than looking like "no new jobs today".
  const healthSummary = Object.entries(sourceHealth)
    .map(([s, h]) => `${s}=${h.ok ? h.count : `ERR(${h.error?.slice(0, 60)})`}`)
    .join(", ");
  if (options.userId) {
    try {
      await upsertScrapeSourceStatuses(options.userId, Object.entries(sourceHealth).map(([source, health]) => ({
        source,
        count: health.count,
        ok: health.ok,
        errorCode: health.ok ? undefined : "SCRAPE_FAILED",
      })));
    } catch (error) {
      void captureTelemetryError("persist_scrape_health", error);
      onProgress("source_warning", "Scrape health could not be saved; continuing with matching.");
    }
  }
  for (const [source, health] of Object.entries(sourceHealth)) {
    void captureTelemetryEvent("scrape_source_result", { source, posting_count: health.count, success: health.ok });
  }
  void captureTelemetryEvent("scrape_completed", {
    source_count: Object.keys(sourceHealth).length,
    failed_source_count: Object.values(sourceHealth).filter((health) => !health.ok).length,
    raw_posting_count: rawPostings.length,
  });
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

  // Scheduled runs skip postings already scored since the CV/profile last changed, so the
  // LLM budget (and the 40 LinkedIn description fetches below) go to new postings (TASK-073).
  const unscored = patient && alreadyScored ? shortlisted.filter((p) => !alreadyScored.has(postingHash(p))) : shortlisted;
  if (unscored.length < shortlisted.length) {
    onProgress("processing", `Skipping ${shortlisted.length - unscored.length} postings already scored since the CV/profile last changed; ${unscored.length} are new.`);
  }
  if (unscored.length === 0) {
    onProgress("complete", "No new postings since the last scan.");
    return [];
  }

  // Fetch descriptions only for the matching/filtered subset of LinkedIn jobs (cap at 40 to prevent Vercel timeout)
  const allLinkedinToFetch = unscored.filter((p) => p.source === "linkedin" && !p.descriptionText);
  const linkedinToFetch = allLinkedinToFetch.slice(0, 40);

  if (linkedinToFetch.length > 0) {
    onProgress("scraping_linkedin_descriptions", `Fetching descriptions for top ${linkedinToFetch.length} of ${allLinkedinToFetch.length} shortlisted LinkedIn jobs...`);
    await fetchLinkedInDescriptions(linkedinToFetch);
  }

  // Only keep postings that actually have descriptions (ATS boards + successfully fetched LinkedIn)
  const finalShortlist = unscored.filter((p) => {
    if (p.source === "linkedin") {
      return p.descriptionText && p.descriptionText.length > 0;
    }
    return true; // ATS boards already have descriptions
  });

  if (finalShortlist.length === 0) {
    onProgress("complete", "No postings with descriptions matched the target designation.");
    return [];
  }

  // Scheduled runs share provider quotas across every due user, so they score a bounded
  // slice: reachable titles first, then newest, undated postings counted as just scraped
  // (candidates.ts). Interactive searches retain the complete shortlist.
  const scheduledScoreLimit = 30;
  const selection = patient
    ? selectScheduledCandidates(finalShortlist, {
        yearsOfExperience: computeYearsOfExperience(profile.careerStartDate),
        limit: scheduledScoreLimit,
      })
    : null;
  const scoreCandidates = selection ? selection.candidates : finalShortlist;
  if (selection && selection.deferred > 0) {
    onProgress("scoring_limit", `Scheduled run capped scoring to ${scoreCandidates.length} postings; ${selection.deferred} remain eligible for later runs.`);
  }
  if (selection) {
    const mix = scoreCandidates.reduce<Record<string, number>>((acc, p) => ((acc[p.source] = (acc[p.source] ?? 0) + 1), acc), {});
    onProgress("scoring_mix", `Scoring by source: ${Object.entries(mix).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  onProgress("scoring", `Scoring ${scoreCandidates.length} postings against CV via AI fallback chain (Groq -> Mistral -> Gemini -> GitHub Models -> OpenRouter -> Cerebras)...`);
  
  // Custom progress for scoring
  const batchSize = Number(process.env.SCORE_BATCH_SIZE) || 4;
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
