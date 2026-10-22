// Persist a scoring run's results for one user. Shared by the hourly cron and the
// manual digest so both store postings and matches identically.
import { upsertJobPosting, upsertUserMatch } from "./db.js";
import { canonicalizeUrl } from "./normalize.js";
import type { ScoredMatch } from "./match.js";

export async function saveScoredMatches(userId: string, scored: ScoredMatch[]): Promise<void> {
  for (const match of scored) {
    const jobPostingId = await upsertJobPosting({
      source: match.posting.source,
      sourceJobId: match.posting.sourceJobId,
      company: match.posting.company,
      title: match.posting.title,
      location: match.posting.location,
      applyUrl: match.posting.applyUrl,
      descriptionText: match.posting.descriptionText,
      dedupHash: canonicalizeUrl(match.posting.applyUrl),
      postedAt: match.posting.postedAt,
    });
    await upsertUserMatch(userId, jobPostingId, match.fitScore, match.compFitLabel, match.reasoningText);
  }
}
