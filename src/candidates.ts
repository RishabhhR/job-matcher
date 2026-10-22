// Which postings a scheduled run spends its LLM budget on (TASK-073).
//
// Measured on the main account before this change: runs re-scored postings they had
// already scored (Greenhouse's postedAt is its updated_at, so the same jobs stayed
// "freshest"), and LinkedIn postings - the best source, 39% scored >= 60 - have no
// postedAt, so a newest-first sort put them last and they were almost never scored.
// Local embeddings were evaluated as a pre-ranker and did no better than random, so
// selection uses these deterministic rules instead.
import type { RawPosting } from "./scrapers.js";
import { canonicalizeUrl } from "./normalize.js";

const SENIORITY_TITLE_TERMS = new Set(["senior", "sr", "staff", "lead", "principal", "group", "director", "vp", "head"]);
const EARLY_CAREER_YOE_LIMIT = 3;

/** Stable identity of a posting across runs; matches jm_job_postings.dedup_hash. */
export function postingHash(posting: Pick<RawPosting, "applyUrl">): string {
  return canonicalizeUrl(posting.applyUrl);
}

/** True when an early-career profile meets a senior title (match.ts caps those at 20 anyway). */
export function isOutOfReachSeniority(title: string, yearsOfExperience: number | null): boolean {
  if (yearsOfExperience === null || yearsOfExperience < 0 || yearsOfExperience >= EARLY_CAREER_YOE_LIMIT) return false;
  const words = title.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((w) => SENIORITY_TITLE_TERMS.has(w));
}

export interface ScheduledSelection {
  candidates: RawPosting[];
  skippedAlreadyScored: number;
  deferred: number;
}

/**
 * Order: postings not yet scored for this user only; reachable titles before
 * out-of-reach senior titles; then newest first, where a missing date counts as
 * "just scraped" rather than "oldest".
 */
export function selectScheduledCandidates(
  postings: RawPosting[],
  opts: { alreadyScored?: Set<string>; yearsOfExperience: number | null; limit: number; now?: number }
): ScheduledSelection {
  const now = opts.now ?? Date.now();
  const fresh = opts.alreadyScored ? postings.filter((p) => !opts.alreadyScored!.has(postingHash(p))) : postings;
  const ordered = fresh
    .map((posting, index) => {
      const parsed = posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN;
      return {
        posting,
        index,
        reachable: isOutOfReachSeniority(posting.title, opts.yearsOfExperience) ? 0 : 1,
        timestamp: Number.isFinite(parsed) ? parsed : now,
      };
    })
    .sort((a, b) => b.reachable - a.reachable || b.timestamp - a.timestamp || a.index - b.index)
    .map(({ posting }) => posting);
  const candidates = ordered.slice(0, opts.limit);
  return {
    candidates,
    skippedAlreadyScored: postings.length - fresh.length,
    deferred: ordered.length - candidates.length,
  };
}
