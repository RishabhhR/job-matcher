import { fetchAllPostings } from "./scrapers.js";
import { fetchLinkedInPublic } from "./scrapers/linkedin.js";
import { dedupePostings } from "./normalize.js";
import { keywordPrefilter, scoreAll, PATIENT_RETRY, type Profile, type ScoredMatch, type RetryOptions } from "./match.js";

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
  onProgress?: (status: string, message: string) => void;
  // Scheduled scrape-only crons have a whole hour before the separate email cron
  // fires, so it's worth riding out rate limits with long waits instead of giving
  // up fast - interactive/SSE callers (the web UI) should leave this off.
  patient?: boolean;
}

export async function runJobMatcher(options: RunnerOptions): Promise<ScoredMatch[]> {
  const { cvText, profile, companies, linkedin, onProgress = () => {}, patient = false } = options;
  const retryOptions: RetryOptions = patient ? PATIENT_RETRY : {};

  onProgress("scraping_ats", `Scraping ATS boards for companies: ${[...companies.greenhouse, ...companies.lever, ...companies.ashby].join(", ")}`);
  const atsPostings = await fetchAllPostings(companies);
  onProgress("scraping_ats_complete", `Fetched ${atsPostings.length} ATS postings from job boards.`);

  const linkedinKeywords = profile.targetDesignation;
  const linkedinLocation = linkedin?.location || "India";
  const linkedinMaxResults = linkedin?.maxResults || 25;

  onProgress("scraping_linkedin", `Scraping LinkedIn for "${linkedinKeywords}" in ${linkedinLocation} (max ${linkedinMaxResults} results)...`);
  const linkedinPostings = await fetchLinkedInPublic({
    keywords: linkedinKeywords,
    location: linkedinLocation,
    maxResults: linkedinMaxResults,
  });
  onProgress("scraping_linkedin_complete", `Fetched ${linkedinPostings.length} LinkedIn postings.`);

  const rawPostings = [...atsPostings, ...linkedinPostings];
  onProgress("processing", `Total raw postings collected: ${rawPostings.length}. Running deduplication...`);

  const deduped = dedupePostings(rawPostings);
  onProgress("processing", `Deduplication complete. Retained ${deduped.length} unique postings.`);

  const shortlisted = keywordPrefilter(deduped, profile.targetDesignation);
  onProgress("processing", `Filtered down to ${shortlisted.length} postings matching target designation "${profile.targetDesignation}".`);

  if (shortlisted.length === 0) {
    onProgress("complete", "No postings matched the target designation.");
    return [];
  }

  onProgress("scoring", `Scoring ${shortlisted.length} postings against CV via AI fallback chain (Groq -> Gemini -> OpenRouter)...`);
  
  // Custom progress for scoring
  const batchSize = 6;
  const totalPostings = shortlisted.length;
  const totalBatches = Math.ceil(totalPostings / batchSize);
  const scoredMatches: ScoredMatch[] = [];

  for (let i = 0; i < totalPostings; i += batchSize) {
    const currentBatchNum = Math.floor(i / batchSize) + 1;
    const batch = shortlisted.slice(i, i + batchSize);
    onProgress("scoring", `Scoring batch ${currentBatchNum}/${totalBatches} (${batch.length} postings)...`);
    
    const { results: batchResults, provider } = await scoreAll(cvText, profile, batch, batch.length, retryOptions);
    scoredMatches.push(...batchResults);

    if (i + batchSize < totalPostings) {
      const baseSleep = provider === "gemini" ? 8000 : 4000;
      const sleepTime = patient ? baseSleep * 2 : baseSleep;
      onProgress("scoring", `Sleeping ${sleepTime / 1000}s to respect LLM rate limits (active provider: ${provider})...`);
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  // Sort matches by descending fit score
  scoredMatches.sort((a, b) => b.fitScore - a.fitScore);
  
  onProgress("complete", `Scoring complete! Processed ${scoredMatches.length} postings.`);
  return scoredMatches;
}
