import { callLLM, parseJSON, type Message } from "./ai.js";
import type { RawPosting } from "./scrapers.js";

export interface Profile {
  targetDesignation: string;
  currentEmployer: string;
  currentTitle: string;
  currentSalaryFixedLPA: number;
  currentSalaryEsopLPA: number;
  currentSalaryCurrency: string;
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

  const system = `You are a career-matching assistant. Score how well a candidate's CV fits each job posting, considering their current employer and salary (to judge whether a move would be a comp upgrade, lateral, or downgrade). Respond ONLY with a JSON object: {"results": [{"job_index": number, "fit_score": number (0-100), "comp_fit_label": "upgrade"|"lateral"|"downgrade"|"unknown", "reasoning_text": string (1-2 sentences)}]}. Include one entry per job index provided.`;

  const user = `CANDIDATE CV:\n${cvText}\n\nCANDIDATE CONTEXT:\nCurrent employer: ${profile.currentEmployer}\nCurrent title: ${profile.currentTitle}\nCurrent salary: ${profile.currentSalaryFixedLPA} LPA fixed + ${profile.currentSalaryEsopLPA} LPA ESOPs (${profile.currentSalaryCurrency})\nTarget designation: ${profile.targetDesignation}\n\nJOB POSTINGS:\n${jobsBlock}`;

  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const { content, provider, warning } = await callLLM(messages);
  const parsed = parseJSON<{ results: LLMScoreItem[] }>(content, { results: [] });
  return { results: parsed.results || [], provider, warning };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scoreBatchWithRetry(
  cvText: string,
  profile: Profile,
  batch: RawPosting[],
  retries = 3
): Promise<{ results: LLMScoreItem[]; provider: string; warning?: string }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await scoreBatch(cvText, profile, batch);
    } catch (err) {
      if (attempt === retries) {
        console.warn(`[match] batch failed after ${retries} retries, skipping: ${(err as Error).message}`);
        return { results: [], provider: "none" };
      }
      const backoffMs = 2000 * 2 ** attempt;
      console.warn(`[match] all providers failed, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(backoffMs);
    }
  }
  return { results: [], provider: "none" };
}

export async function scoreAll(
  cvText: string,
  profile: Profile,
  postings: RawPosting[],
  batchSize = 6
): Promise<ScoredMatch[]> {
  const batches = chunk(postings, batchSize);
  const matches: ScoredMatch[] = [];

  for (const batch of batches) {
    const { results, provider, warning } = await scoreBatchWithRetry(cvText, profile, batch);
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
    await sleep(1500);
  }

  return matches.sort((a, b) => b.fitScore - a.fitScore);
}
