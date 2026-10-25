import "dotenv/config";
import { randomUUID } from "node:crypto";
import { client, ensureMigrated, getActiveCvText, getUserProfileRow } from "./db.js";
import { PATIENT_RETRY, scoreAll, type Profile, type ScoredMatch } from "./match.js";
import type { RawPosting } from "./scrapers.js";

interface CohortRow {
  user_id: string;
  job_posting_id: string;
  python_score: number;
  reasoning_text: string;
  source: string;
  source_job_id: string | null;
  company_name: string;
  title: string;
  location: string;
  description_text: string;
  apply_url: string;
  posted_at: string | null;
  matched_at: string;
  profile_updated_at: string;
  cv_created_at: string | null;
}

interface PairResult {
  python: number;
  llm: number;
  jobId: string;
}

function sqlTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Cohort timestamps must be valid ISO date/time values.");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function rank(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) ranks[sorted[i].index] = averageRank;
    start = end;
  }
  return ranks;
}

function spearman(pythonScores: number[], llmScores: number[]): number | null {
  if (pythonScores.length < 2) return null;
  const x = rank(pythonScores);
  const y = rank(llmScores);
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator === 0 ? null : covariance / denominator;
}

function summarize(pairs: PairResult[]) {
  const pythonScores = pairs.map((pair) => pair.python);
  const llmScores = pairs.map((pair) => pair.llm);
  const mae = pairs.reduce((sum, pair) => sum + Math.abs(pair.python - pair.llm), 0) / Math.max(1, pairs.length);
  const topN = Math.min(10, pairs.length);
  const pythonTop = new Set([...pairs].sort((a, b) => b.python - a.python || a.jobId.localeCompare(b.jobId)).slice(0, topN).map((pair) => pair.jobId));
  const llmTop = new Set([...pairs].sort((a, b) => b.llm - a.llm || a.jobId.localeCompare(b.jobId)).slice(0, topN).map((pair) => pair.jobId));
  const topOverlap = [...pythonTop].filter((id) => llmTop.has(id)).length;
  return {
    pairs: pairs.length,
    python_average: Number((pythonScores.reduce((sum, score) => sum + score, 0) / Math.max(1, pythonScores.length)).toFixed(1)),
    llm_average: Number((llmScores.reduce((sum, score) => sum + score, 0) / Math.max(1, llmScores.length)).toFixed(1)),
    mean_absolute_score_difference: Number(mae.toFixed(1)),
    exact_score_agreement_percent: Number((pairs.filter((pair) => pair.python === pair.llm).length * 100 / Math.max(1, pairs.length)).toFixed(1)),
    spearman_rank_correlation: spearman(pythonScores, llmScores) === null ? null : Number(spearman(pythonScores, llmScores)!.toFixed(3)),
    top_10_overlap: `${topOverlap}/${topN}`,
  };
}

function postingFromRow(row: CohortRow): RawPosting {
  return {
    source: row.source as RawPosting["source"],
    sourceJobId: row.source_job_id ?? "",
    company: row.company_name,
    title: row.title,
    location: row.location ?? "",
    descriptionText: row.description_text ?? "",
    applyUrl: row.apply_url,
    ...(row.posted_at ? { postedAt: row.posted_at } : {}),
  };
}

async function main() {
  const cohortStart = sqlTimestamp(process.env.SCORE_COMPARISON_SINCE || "");
  const cohortEnd = sqlTimestamp(process.env.SCORE_COMPARISON_UNTIL || "");
  if (cohortStart >= cohortEnd) throw new Error("Cohort end must be later than cohort start.");
  const expectedPairs = Number(process.env.SCORE_COMPARISON_EXPECTED_PAIRS || 0);
  if (!Number.isInteger(expectedPairs) || expectedPairs < 1) throw new Error("Set SCORE_COMPARISON_EXPECTED_PAIRS to the expected Python-scored pair count.");

  await ensureMigrated();
  const result = await client.execute({
    sql: `SELECT m.user_id, m.job_posting_id, m.fit_score AS python_score, m.reasoning_text,
                 jp.source, jp.source_job_id, jp.company_name, jp.title, jp.location,
                 jp.description_text, jp.apply_url, jp.posted_at, m.matched_at,
                 up.updated_at AS profile_updated_at,
                 (SELECT MAX(cv.created_at) FROM jm_cvs cv WHERE cv.user_id = m.user_id AND cv.is_active = 1) AS cv_created_at
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          JOIN jm_user_profiles up ON up.user_id = m.user_id
          WHERE m.matched_at >= ? AND m.matched_at < ?
            AND m.reasoning_text LIKE 'Rule-based match;%'
          ORDER BY m.user_id, m.job_posting_id`,
    args: [cohortStart, cohortEnd],
  });
  const rows = result.rows as unknown as CohortRow[];
  if (rows.length !== expectedPairs) {
    throw new Error(`Expected ${expectedPairs} intact Python-scored pairs in the requested cohort; found ${rows.length}. No LLM scoring was started.`);
  }

  const groups = new Map<string, CohortRow[]>();
  for (const row of rows) groups.set(row.user_id, [...(groups.get(row.user_id) ?? []), row]);
  const userIds = [...groups.keys()];
  const inputs = await Promise.all(userIds.map(async (userId) => {
    const userRows = groups.get(userId)!;
    const [cvText, profile] = await Promise.all([getActiveCvText(userId), getUserProfileRow(userId)]);
    if (!cvText?.trim() || !profile) throw new Error("A cohort user no longer has the CV/profile required for a paired score.");
    const firstScoredAt = userRows.reduce((earliest, row) => row.matched_at < earliest ? row.matched_at : earliest, userRows[0].matched_at);
    if (userRows.some((row) => row.profile_updated_at > firstScoredAt || (row.cv_created_at && row.cv_created_at > firstScoredAt))) {
      throw new Error("A cohort CV/profile changed after the Python scores were created; refusing a mismatched comparison.");
    }
    return { userId, cvText, profile: profile as Profile, rows: userRows };
  }));

  const runId = randomUUID();
  await client.execute({
    sql: `INSERT INTO jm_score_comparison_runs (id, cohort_start, cohort_end, status, pair_count)
          VALUES (?, ?, ?, 'running', ?)`,
    args: [runId, cohortStart, cohortEnd, rows.length],
  });
  console.log(`[score-comparison] Starting paired scoring run ${runId} for ${rows.length} same-profile job pairs across ${groups.size} profiles.`);

  const pairResults = new Map<string, PairResult[]>();
  let completedPairs = 0;
  let incomplete = false;
  try {
    for (let userIndex = 0; userIndex < inputs.length; userIndex++) {
      const input = inputs[userIndex];
      const pairs: PairResult[] = [];
      for (let offset = 0; offset < input.rows.length; offset += 4) {
        const cohortBatch = input.rows.slice(offset, offset + 4);
        const postings = cohortBatch.map(postingFromRow);
        const scored = await scoreAll(input.cvText, input.profile, postings, postings.length, PATIENT_RETRY);
        const byPosting = new Map(scored.results.map((match) => [match.posting, match]));
        const completedBatch: Array<{ row: CohortRow; llm: ScoredMatch }> = [];
        for (let i = 0; i < cohortBatch.length; i++) {
          const llm = byPosting.get(postings[i]);
          if (llm) completedBatch.push({ row: cohortBatch[i], llm });
        }
        if (completedBatch.length > 0) {
          await client.batch(completedBatch.map(({ row, llm }) => ({
            sql: `INSERT INTO jm_score_comparisons
                    (run_id, user_id, job_posting_id, python_score, python_signal_coverage, llm_score, llm_comp_fit_label, llm_provider)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              runId,
              input.userId,
              row.job_posting_id,
              row.python_score,
              Number(row.reasoning_text.match(/signal coverage\s+(\d+(?:\.\d+)?)%/i)?.[1] ?? 0) / 100,
              llm.fitScore,
              llm.compFitLabel,
              scored.provider,
            ],
          })), "write");
          for (const { row, llm } of completedBatch) pairs.push({ python: row.python_score, llm: llm.fitScore, jobId: row.job_posting_id });
          completedPairs += completedBatch.length;
          await client.execute({
            sql: "UPDATE jm_score_comparison_runs SET completed_pair_count = ? WHERE id = ?",
            args: [completedPairs, runId],
          });
        }
        console.log(`[score-comparison] Profile ${userIndex + 1}/${inputs.length}: completed ${offset + completedBatch.length}/${input.rows.length} pairs with provider ${scored.provider}.`);
        if (completedBatch.length !== cohortBatch.length) {
          incomplete = true;
          break;
        }
      }
      pairResults.set(input.userId, pairs);
      if (incomplete) break;
      console.log(`[score-comparison] Profile ${userIndex + 1}/${inputs.length} metrics: ${JSON.stringify(summarize(pairs))}`);
    }

    const status = incomplete || completedPairs !== rows.length ? "partial" : "complete";
    await client.execute({
      sql: `UPDATE jm_score_comparison_runs SET status = ?, completed_at = datetime('now'), error_code = ? WHERE id = ?`,
      args: [status, status === "complete" ? null : "LLM_SCORING_INCOMPLETE", runId],
    });
    if (status !== "complete") throw new Error(`Paired scoring stopped after ${completedPairs}/${rows.length} pairs; run ${runId} is marked partial.`);

    const allPairs = [...pairResults.values()].flat();
    console.log(`[score-comparison] Overall metrics: ${JSON.stringify(summarize(allPairs))}`);
    console.log(`[score-comparison] Completed run ${runId}; ${completedPairs} pairs persisted. Production match scores and emails were not changed.`);
  } catch (error) {
    await client.execute({
      sql: `UPDATE jm_score_comparison_runs SET status = 'failed', completed_at = datetime('now'), error_code = 'COMPARISON_RUN_FAILED' WHERE id = ? AND status = 'running'`,
      args: [runId],
    }).catch(() => {});
    throw error;
  }
}

main()
  .catch((error) => {
    console.error("[score-comparison] Failed:", (error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => client.close());
