import { callLLM, parseJSON, type Message } from "./ai.js";
import type { RawPosting } from "./scrapers.js";

export interface Profile {
  notifyEmail?: string;
  targetDesignation: string;
  currentEmployer: string;
  currentTitle: string;
  currentSalaryFixedLPA: number;
  currentSalaryEsopLPA: number;
  currentSalaryCurrency: string;
  // ISO date (YYYY-MM-DD) the candidate started their first professional role.
  // Used to compute years of experience deterministically rather than relying on
  // the LLM to parse dates out of CV prose, which is what caused postings requiring
  // e.g. 8 years to get scored as good fits for a ~2-year-experience candidate.
  careerStartDate?: string;
  // Location preferences for filtering job postings (e.g. "India", "Bengaluru").
  // If omitted, no location filtering is applied.
  preferredCountry?: string;
  preferredCity?: string;
}

export function computeYearsOfExperience(careerStartDate: string | undefined): number | null {
  if (!careerStartDate) return null;
  const start = new Date(careerStartDate);
  if (isNaN(start.getTime())) return null;
  const years = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return Math.round(years * 10) / 10;
}

export interface ScoredMatch {
  posting: RawPosting;
  fitScore: number;
  compFitLabel: "upgrade" | "lateral" | "downgrade" | "unknown";
  reasoningText: string;
}

const TITLE_KEYWORDS = ["product manager", "pm ", "apm", "product owner"];

export function keywordPrefilter(postings: RawPosting[], targetDesignation: string): RawPosting[] {
  const target = targetDesignation.toLowerCase();
  return postings.filter((p) => {
    const title = p.title.toLowerCase();
    return title.includes(target) || TITLE_KEYWORDS.some((k) => title.includes(k));
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface LLMScoreItem {
  job_index: number;
  fit_score: number;
  comp_fit_label: "upgrade" | "lateral" | "downgrade" | "unknown";
  reasoning_text: string;
}

export async function scoreBatch(
  cvText: string,
  profile: Profile,
  postings: RawPosting[]
): Promise<{ results: LLMScoreItem[]; provider: string; warning?: string }> {
  const jobsBlock = postings
    .map(
      (p, i) =>
        `[${i}] Title: ${p.title}\nCompany: ${p.company}\nLocation: ${p.location}\nDescription: ${p.descriptionText.slice(0, 600)}`
    )
    .join("\n\n---\n\n");

  const yearsOfExperience = computeYearsOfExperience(profile.careerStartDate);

  const system = `You are a career-matching assistant. Score how well a candidate's CV fits each job posting, considering their current employer, title, and salary.

Apply these experience matching rules:
- The candidate's total years of professional experience (YoE) is given explicitly below as a computed number - use that number, don't re-derive it from CV prose (CVs often list multiple roles/projects with overlapping or ambiguous dates, which is unreliable to parse).
- Identify the minimum years of experience required by each job posting in its description.
- If a job posting explicitly requires a minimum years of experience (e.g. 5+ years, 8+ years) and the candidate's given YoE is significantly lower (e.g. candidate has 2 years, job requires 5+ or 8+), you MUST penalize the fit_score heavily (cap fit_score at 30 or lower) and state the experience gap explicitly in the reasoning_text (e.g. "requires 8+ years, candidate has ~2").
- Do not match senior/lead/staff/principal roles requiring high experience to junior or mid-level candidates, even if the title itself matches the target designation.
- If YoE is not provided (null) or a posting doesn't state an experience requirement, don't penalize for this.

Apply these rules when deciding comp_fit_label (estimate the posting's likely compensation from its title, seniority, company, and location if salary isn't stated explicitly):
- "downgrade": estimated total comp is more than ~10% below the candidate's current total comp (fixed + ESOPs), OR the role is a clear step down in seniority/title with no offsetting comp increase.
- "lateral": estimated total comp is within roughly -10% to +20% of current, OR the move is a same-level title switch without a strong (30%+) comp jump.
- "upgrade": estimated total comp is 20%+ above current (30-40%+ is a strong/typical "good move" benchmark in Indian tech/product hiring; 40-60%+ is exceptional), OR the role is one level above the candidate's current title (e.g. APM -> PM, PM -> Senior PM) even at a roughly similar comp band.
- Flag role jumps of two or more levels above the candidate's current title (e.g. APM -> Senior/Group PM) as a stretch in the reasoning text, even if you still label it "upgrade" - don't treat it as a routine next step.
- ESOP-heavy offers should be discounted versus fixed cash when estimating comp, since equity is illiquid and vesting-dependent - don't treat quoted ESOP value at full face value unless the company is late-stage/pre-IPO.

Respond ONLY with a JSON object: {"results": [{"job_index": number, "fit_score": number (0-100), "comp_fit_label": "upgrade"|"lateral"|"downgrade"|"unknown", "reasoning_text": string (1-2 sentences, note explicitly if this is a level-up, lateral, or stretch move)}]}. Include one entry per job index provided.`;

  const user = `CANDIDATE CV:\n${cvText}\n\nCANDIDATE CONTEXT:\nCurrent employer: ${profile.currentEmployer}\nCurrent title: ${profile.currentTitle}\nCurrent salary: ${profile.currentSalaryFixedLPA} LPA fixed + ${profile.currentSalaryEsopLPA} LPA ESOPs (${profile.currentSalaryCurrency})\nTarget designation: ${profile.targetDesignation}\nTotal years of professional experience: ${yearsOfExperience !== null ? `${yearsOfExperience} years (career started ${profile.careerStartDate})` : "not provided - don't penalize on experience"}\n\nJOB POSTINGS:\n${jobsBlock}`;

  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const { content, provider, warning } = await callLLM(messages);
  const parsed = parseJSON<{ results: LLMScoreItem[] }>(content, { results: [] });
  return { results: parsed.results || [], provider, warning };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const FAST_RETRY: Required<RetryOptions> = { retries: 3, baseBackoffMs: 5000, maxBackoffMs: 20000 };
// "Patient" mode is for the scheduled scrape-and-score cron, which has a whole hour
// before the separate email-send cron fires - worth riding out rate limits with long
// waits instead of giving up fast, since nothing is blocking on this in real time.
export const PATIENT_RETRY: Required<RetryOptions> = { retries: 8, baseBackoffMs: 10000, maxBackoffMs: 120000 };

async function scoreBatchWithRetry(
  cvText: string,
  profile: Profile,
  batch: RawPosting[],
  retryOptions: RetryOptions = {}
): Promise<{ results: LLMScoreItem[]; provider: string; warning?: string }> {
  const { retries, baseBackoffMs, maxBackoffMs } = { ...FAST_RETRY, ...retryOptions };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await scoreBatch(cvText, profile, batch);
    } catch (err) {
      if (attempt === retries) {
        console.warn(`[match] batch failed after ${retries} retries, skipping: ${(err as Error).message}`);
        return { results: [], provider: "none" };
      }
      const backoffMs = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
      console.warn(`[match] all providers failed/rate-limited, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})...`);
      await sleep(backoffMs);
    }
  }
  return { results: [], provider: "none" };
}

export async function scoreAll(
  cvText: string,
  profile: Profile,
  postings: RawPosting[],
  batchSize = 6,
  retryOptions: RetryOptions = {}
): Promise<{ results: ScoredMatch[]; provider: string }> {
  const batches = chunk(postings, batchSize);
  const matches: ScoredMatch[] = [];
  let lastProvider = "none";

  for (const batch of batches) {
    const { results, provider, warning } = await scoreBatchWithRetry(cvText, profile, batch, retryOptions);
    lastProvider = provider;
    if (warning) console.warn(`[match] provider=${provider} warning=${warning}`);
    for (const r of results) {
      const posting = batch[r.job_index];
      if (!posting) continue;
      matches.push({
        posting,
        fitScore: r.fit_score,
        compFitLabel: r.comp_fit_label,
        reasoningText: r.reasoning_text,
      });
    }
    const sleepMs = provider === "gemini" ? 4000 : 1500;
    await sleep(sleepMs);
  }

  return {
    results: matches.sort((a, b) => b.fitScore - a.fitScore),
    provider: lastProvider
  };
}
