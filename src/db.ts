import { createClient } from "@libsql/client";
import { randomBytes, randomUUID } from "node:crypto";
import { captureTelemetryEvent } from "./telemetry.js";

let _client: any;
export const client = new Proxy({} as any, {
  get(target, prop) {
    if (!_client) {
      if (!process.env.TURSO_DATABASE_URL) {
        throw new Error("TURSO_DATABASE_URL environment variable is missing. Database access is disabled.");
      }
      _client = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    }
    const value = _client[prop];
    if (typeof value === "function") {
      return value.bind(_client);
    }
    return value;
  }
});

// Tables are prefixed jm_ since this database is shared with the fittrack project.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jm_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    digest_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES jm_users(id),
    target_designation TEXT NOT NULL,
    current_employer TEXT,
    current_title TEXT,
    current_salary_fixed_lpa REAL,
    current_salary_esop_lpa REAL,
    current_salary_currency TEXT DEFAULT 'INR',
    career_start_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_cvs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    extracted_text TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_job_postings (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_job_id TEXT,
    company_name TEXT,
    title TEXT,
    location TEXT,
    description_text TEXT,
    source_metadata TEXT,
    apply_url TEXT,
    dedup_hash TEXT UNIQUE NOT NULL,
    posted_at TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_job_posting_requirements (
    job_posting_id TEXT PRIMARY KEY REFERENCES jm_job_postings(id),
    application_url TEXT,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS jm_user_job_matches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    job_posting_id TEXT NOT NULL REFERENCES jm_job_postings(id),
    fit_score INTEGER NOT NULL,
    comp_fit_label TEXT NOT NULL,
    reasoning_text TEXT,
    matched_at TEXT NOT NULL DEFAULT (datetime('now')),
    score_claim_token TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    UNIQUE(user_id, job_posting_id)
  )`,
  `CREATE TABLE IF NOT EXISTS jm_scrape_runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    postings_found INTEGER,
    postings_new INTEGER,
    error_text TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS jm_scrape_source_status (
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    source TEXT NOT NULL,
    last_attempt_at TEXT NOT NULL,
    last_success_at TEXT,
    last_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    PRIMARY KEY (user_id, source)
  )`,
  // Python shadow scores (TASK-102): every Python result from scheduled runs, with the
  // LLM score for the same posting when the LLM scored it. Never shown to users.
  `CREATE TABLE IF NOT EXISTS jm_python_shadow_scores (
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    posting_hash TEXT NOT NULL,
    source TEXT,
    python_score INTEGER NOT NULL,
    signal_coverage REAL,
    caps TEXT,
    llm_score INTEGER,
    llm_provider TEXT,
    used_as_fallback INTEGER NOT NULL DEFAULT 0,
    scored_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, posting_hash)
  )`,
  // Referrals (TASK-089): one row per referred account; reward logic is decided later.
  `CREATE TABLE IF NOT EXISTS jm_user_referrals (
    referred_user_id TEXT PRIMARY KEY REFERENCES jm_users(id),
    referrer_user_id TEXT NOT NULL REFERENCES jm_users(id),
    code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // Small key/value store for operational state, e.g. the cron heartbeat (TASK-086).
  `CREATE TABLE IF NOT EXISTS jm_app_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_email_send_log (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    send_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    sent_at TEXT,
    error_text TEXT,
    UNIQUE(user_id, send_date, slot)
  )`,
  // Paired scorer evaluation (TASK-099): keep comparison scores out of the
  // production match row so an evaluation can never alter a user's feed.
  `CREATE TABLE IF NOT EXISTS jm_score_comparison_runs (
    id TEXT PRIMARY KEY,
    cohort_start TEXT NOT NULL,
    cohort_end TEXT NOT NULL,
    status TEXT NOT NULL,
    pair_count INTEGER NOT NULL DEFAULT 0,
    completed_pair_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    error_code TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS jm_score_comparisons (
    run_id TEXT NOT NULL REFERENCES jm_score_comparison_runs(id),
    user_id TEXT NOT NULL REFERENCES jm_users(id),
    job_posting_id TEXT NOT NULL REFERENCES jm_job_postings(id),
    python_score INTEGER NOT NULL,
    python_signal_coverage REAL,
    llm_score INTEGER,
    llm_comp_fit_label TEXT,
    llm_provider TEXT,
    scored_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, user_id, job_posting_id)
  )`,
  `CREATE TABLE IF NOT EXISTS jm_user_companies (
    user_id TEXT PRIMARY KEY REFERENCES jm_users(id),
    greenhouse_json TEXT NOT NULL,
    lever_json TEXT NOT NULL,
    ashby_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS jm_daily_visitors (
    visit_date TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '/',
    referrer TEXT,
    hits INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (visit_date, visitor_hash, path)
  )`,
];

export async function migrate() {
  // Cold-start cost matters (TASK-066): every statement is a network round trip,
  // so the idempotent CREATE TABLEs go in one batch, existing columns are read in
  // one batch, and only genuinely missing columns are added.
  await client.batch(SCHEMA, "write");

  // Patch schema additions separately for existing tables
  const addColumns = [
    "ALTER TABLE jm_user_profiles ADD COLUMN career_start_date TEXT",
    "ALTER TABLE jm_user_profiles ADD COLUMN preferred_country TEXT",
    "ALTER TABLE jm_user_profiles ADD COLUMN preferred_city TEXT",
    "ALTER TABLE jm_job_postings ADD COLUMN posted_at TEXT",
    "ALTER TABLE jm_job_postings ADD COLUMN source_metadata TEXT",
    // Tracks when a match was last included in a sent digest, so the digest can
    // lead with never-emailed matches (see getTopMatchesForUser). Deliberately a
    // separate column, NOT the `status` field, which has its own pending/scored
    // lifecycle that getUserStats and the scoring pipeline depend on.
    "ALTER TABLE jm_user_job_matches ADD COLUMN emailed_at TEXT",
    // The user's own action on a match from the UI: 'saved' | 'applied' | 'dismissed'.
    // Separate from `status` for the same reason as emailed_at above.
    "ALTER TABLE jm_user_job_matches ADD COLUMN user_action TEXT",
    "ALTER TABLE jm_user_job_matches ADD COLUMN score_claim_token TEXT",
    "ALTER TABLE jm_users ADD COLUMN clerk_id TEXT",
    "ALTER TABLE jm_users ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 9",
    "ALTER TABLE jm_user_profiles ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jm_users ADD COLUMN referral_code TEXT",
  ];
  const finalStatements = [
    "CREATE UNIQUE INDEX IF NOT EXISTS jm_users_clerk_id_idx ON jm_users(clerk_id)",
    "CREATE INDEX IF NOT EXISTS jm_daily_visitors_date_idx ON jm_daily_visitors(visit_date)",
    "CREATE UNIQUE INDEX IF NOT EXISTS jm_users_referral_code_idx ON jm_users(referral_code)",
    "CREATE INDEX IF NOT EXISTS jm_user_referrals_referrer_idx ON jm_user_referrals(referrer_user_id)",
  ];

  for (let attempt = 0; ; attempt++) {
    const parsed = addColumns.map((sql) => {
      const m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(sql)!;
      return { sql, table: m[1], column: m[2] };
    });
    const tables = [...new Set(parsed.map((p) => p.table))];
    const infos = await client.batch(tables.map((t) => `PRAGMA table_info(${t})`), "read");
    const existing = new Set(
      (infos as Array<{ rows: Array<Record<string, unknown>> }>).flatMap((info, i) =>
        info.rows.map((row) => `${tables[i]}.${String(row.name)}`)
      )
    );
    const missing = parsed.filter((p) => !existing.has(`${p.table}.${p.column}`)).map((p) => p.sql);
    try {
      await client.batch([...missing, ...finalStatements], "write");
      break;
    } catch (err) {
      // Another cold instance added the same column first; re-check once.
      if (attempt === 0 && /duplicate column|already exists/i.test((err as Error).message)) continue;
      throw err;
    }
  }
}

/**
 * Repair historical model outputs that violated the seniority cap now enforced in
 * match.ts. Full-table UPDATE, so it runs from the cron (src/cron.ts), not on every
 * serverless cold start (TASK-066).
 */
export async function repairSeniorityCaps(): Promise<void> {
  // Repair historical model outputs that violated the seniority cap now
  // enforced in match.ts. This is idempotent: capped rows are no longer >20,
  // and the marker prevents duplicate reasoning text if a partial run retries.
  const normalizedTitle = `lower(' ' || replace(replace(replace(replace(replace(replace(replace(replace(coalesce(jp.title, ''), '-', ' '), '/', ' '), ',', ' '), '.', ' '), ':', ' '), '(', ' '), ')', ' '), '&', ' ') || ' ')`;
  const seniorityTerms = ["senior", "staff", "lead", "principal", "group", "director", "vp", "head"]
    .map((term) => `instr(${normalizedTitle}, ' ${term} ') > 0`)
    .join(" OR ");
  await client.execute({
    sql: `UPDATE jm_user_job_matches AS m
          SET fit_score = 20,
              reasoning_text = CASE
                WHEN instr(lower(coalesce(m.reasoning_text, '')), '[seniority cap applied]') > 0 THEN m.reasoning_text
                ELSE trim(coalesce(m.reasoning_text, '') || ' [Seniority cap applied] This senior-level title is a poor fit for an early-career profile.')
              END
          WHERE m.fit_score > 20
            AND m.status IN ('new', 'scored')
            AND EXISTS (
              SELECT 1
              FROM jm_user_profiles AS up
              JOIN jm_job_postings AS jp ON jp.id = m.job_posting_id
              WHERE up.user_id = m.user_id
                AND up.career_start_date IS NOT NULL
                AND (julianday('now') - julianday(up.career_start_date)) / 365.25 >= 0
                AND (julianday('now') - julianday(up.career_start_date)) / 365.25 < 3
                AND (${seniorityTerms})
            )`,
  });
}

let migrationPromise: Promise<void> | null = null;
export function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrate().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }
  return migrationPromise;
}

export async function upsertUser(
  email: string,
  name: string,
  clerkId?: string,
  timezone = "Asia/Kolkata"
): Promise<string> {
  if (clerkId) {
    const existing = await client.execute({ sql: "SELECT id, email FROM jm_users WHERE clerk_id = ?", args: [clerkId] });
    if (existing.rows.length > 0) {
      const id = existing.rows[0].id as string;
      const emailOwner = await client.execute({ sql: "SELECT id, clerk_id FROM jm_users WHERE email = ?", args: [email] });
      if (emailOwner.rows.length > 0 && emailOwner.rows[0].id !== id && emailOwner.rows[0].clerk_id) {
        throw new Error("This verified email is already linked to another account.");
      }
      await client.execute({
        sql: "UPDATE jm_users SET name = ?, email = ?, timezone = ?, updated_at = datetime('now') WHERE id = ?",
        args: [name, email, timezone, id],
      });
      return id;
    }
  }

  const existingEmail = await client.execute({ sql: "SELECT id, clerk_id FROM jm_users WHERE email = ?", args: [email] });
  if (existingEmail.rows.length > 0) {
    const id = existingEmail.rows[0].id as string;
    const existingClerkId = existingEmail.rows[0].clerk_id as string | null;
    if (existingClerkId && existingClerkId !== clerkId) {
      throw new Error("This email is already linked to a different account.");
    }
    await client.execute({
      sql: "UPDATE jm_users SET name = ?, clerk_id = COALESCE(clerk_id, ?), timezone = ?, updated_at = datetime('now') WHERE id = ?",
      args: [name, clerkId || null, timezone, id],
    });
    return id;
  }

  const id = randomUUID();
  await client.execute({
    sql: "INSERT INTO jm_users (id, email, name, clerk_id, timezone) VALUES (?, ?, ?, ?, ?)",
    args: [id, email, name, clerkId || null, timezone],
  });
  return id;
}

export interface CompanySources {
  greenhouse: string[];
  lever: string[];
  ashby: string[];
}

export async function getUserCompanies(userId: string): Promise<CompanySources | null> {
  const result = await client.execute({
    sql: "SELECT greenhouse_json, lever_json, ashby_json FROM jm_user_companies WHERE user_id = ?",
    args: [userId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    greenhouse: JSON.parse(row.greenhouse_json as string),
    lever: JSON.parse(row.lever_json as string),
    ashby: JSON.parse(row.ashby_json as string),
  };
}

export async function upsertUserCompanies(userId: string, companies: CompanySources): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_user_companies (user_id, greenhouse_json, lever_json, ashby_json, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET greenhouse_json = excluded.greenhouse_json,
        lever_json = excluded.lever_json, ashby_json = excluded.ashby_json,
        updated_at = datetime('now')`,
    args: [userId, JSON.stringify(companies.greenhouse), JSON.stringify(companies.lever), JSON.stringify(companies.ashby)],
  });
}

export async function getUserClerkId(userId: string): Promise<string | null> {
  const result = await client.execute({ sql: "SELECT clerk_id FROM jm_users WHERE id = ?", args: [userId] });
  if (result.rows.length === 0) return null;
  return (result.rows[0].clerk_id as string) ?? null;
}

export async function updateUserDigestSettings(userId: string, enabled: boolean, hour: number): Promise<void> {
  await client.execute({
    sql: "UPDATE jm_users SET digest_enabled = ?, digest_hour = ?, updated_at = datetime('now') WHERE id = ?",
    args: [enabled ? 1 : 0, hour, userId],
  });
}

export interface UserDigestSettings {
  digestEnabled: boolean;
  digestHour: number;
}

export async function getUserDigestSettings(userId: string): Promise<UserDigestSettings | null> {
  const result = await client.execute({
    sql: "SELECT digest_enabled, digest_hour FROM jm_users WHERE id = ?",
    args: [userId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    digestEnabled: row.digest_enabled === 1,
    digestHour: row.digest_hour as number,
  };
}

export interface DbProfile {
  targetDesignation: string;
  currentEmployer: string;
  currentTitle: string;
  currentSalaryFixedLPA: number;
  currentSalaryEsopLPA: number;
  currentSalaryCurrency: string;
  careerStartDate?: string;
  preferredCountry?: string;
  preferredCity?: string;
  skills?: string[];
}

export async function upsertUserProfile(userId: string, profile: DbProfile): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_user_profiles
      (user_id, target_designation, current_employer, current_title, current_salary_fixed_lpa, current_salary_esop_lpa, current_salary_currency, career_start_date, preferred_country, preferred_city, skills_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        target_designation = excluded.target_designation,
        current_employer = excluded.current_employer,
        current_title = excluded.current_title,
        current_salary_fixed_lpa = excluded.current_salary_fixed_lpa,
        current_salary_esop_lpa = excluded.current_salary_esop_lpa,
        current_salary_currency = excluded.current_salary_currency,
        career_start_date = excluded.career_start_date,
        preferred_country = excluded.preferred_country,
        preferred_city = excluded.preferred_city,
        skills_json = excluded.skills_json,
        updated_at = datetime('now')`,
    args: [
      userId,
      // libSQL rejects undefined, and onboarding leaves pay and employer blank.
      profile.targetDesignation ?? "",
      profile.currentEmployer ?? null,
      profile.currentTitle ?? null,
      profile.currentSalaryFixedLPA ?? null,
      profile.currentSalaryEsopLPA ?? null,
      profile.currentSalaryCurrency ?? "INR",
      profile.careerStartDate ?? null,
      profile.preferredCountry ?? null,
      profile.preferredCity ?? null,
      JSON.stringify(profile.skills ?? []),
    ],
  });
}

export async function upsertCv(userId: string, extractedText: string): Promise<void> {
  await client.execute({ sql: "UPDATE jm_cvs SET is_active = 0 WHERE user_id = ?", args: [userId] });
  await client.execute({
    sql: "INSERT INTO jm_cvs (id, user_id, extracted_text, is_active) VALUES (?, ?, ?, 1)",
    args: [randomUUID(), userId, extractedText],
  });
}

export interface DbPosting {
  source: string;
  sourceJobId: string;
  company: string;
  title: string;
  location: string;
  applyUrl: string;
  descriptionText: string;
  dedupHash: string;
  postedAt?: string;
}

export async function upsertJobPosting(posting: DbPosting): Promise<string> {
  const existing = await client.execute({
    sql: "SELECT id FROM jm_job_postings WHERE dedup_hash = ?",
    args: [posting.dedupHash],
  });
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id as string;
    await client.execute({
      sql: "UPDATE jm_job_postings SET posted_at = COALESCE(?, posted_at), scraped_at = datetime('now') WHERE id = ?",
      args: [posting.postedAt ?? null, id],
    });
    return id;
  }

  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO jm_job_postings
      (id, source, source_job_id, company_name, title, location, description_text, apply_url, dedup_hash, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      posting.source,
      posting.sourceJobId,
      posting.company,
      posting.title,
      posting.location,
      posting.descriptionText,
      posting.applyUrl,
      posting.dedupHash,
      posting.postedAt ?? null,
    ],
  });
  return id;
}

export async function upsertUserMatch(
  userId: string,
  jobPostingId: string,
  fitScore: number,
  compFitLabel: string,
  reasoningText: string
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_user_job_matches (id, user_id, job_posting_id, fit_score, comp_fit_label, reasoning_text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, job_posting_id) DO UPDATE SET
        fit_score = excluded.fit_score,
        comp_fit_label = excluded.comp_fit_label,
        reasoning_text = excluded.reasoning_text,
        -- A row that was pending (unscored) becomes visible once it has a real score;
        -- before TASK-102 it stayed 'pending' and was hidden from feed and digests.
        status = CASE WHEN jm_user_job_matches.status = 'pending' THEN 'new' ELSE jm_user_job_matches.status END,
        matched_at = datetime('now')`,
    args: [randomUUID(), userId, jobPostingId, fitScore, compFitLabel, reasoningText],
  });
}

export async function getTopMatchesForUser(userId: string, limit = 20) {
  // A job is eligible for a digest only until it has been included in a sent
  // email. Do not backfill previously emailed matches: that made the digest
  // repeat old listings whenever there were fewer than `limit` new matches.
  const result = await client.execute({
    sql: `SELECT m.id AS match_id, m.emailed_at,
                 jp.title, jp.company_name, jp.location, jp.apply_url, jp.source,
                 m.fit_score, m.comp_fit_label, m.reasoning_text
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE m.user_id = ?
            AND m.emailed_at IS NULL
            -- Only scored rows: pending (fit_score -1) rows must never reach a digest (TASK-102).
            AND m.status IN ('new', 'scored')
            AND m.fit_score >= 0
          ORDER BY m.fit_score DESC
          LIMIT ?`,
    args: [userId, limit],
  });
  return result.rows;
}

// Stamp emailed_at on the given match rows so they drop below never-emailed
// matches in the next digest (see getTopMatchesForUser). Call only after the
// email actually sent. Does NOT touch `status` (pending/scored/new lifecycle).
export async function markMatchesAsSent(matchIds: string[]): Promise<void> {
  if (matchIds.length === 0) return;
  const placeholders = matchIds.map(() => "?").join(", ");
  await client.execute({
    sql: `UPDATE jm_user_job_matches SET emailed_at = datetime('now') WHERE id IN (${placeholders})`,
    args: matchIds,
  });
}

// Mark the exact postings included by a manual scoring review email. The score
// run can upsert existing match rows, so match IDs should be resolved from the
// stable posting hashes rather than relying on IDs returned by the insert path.
export async function markUserPostingsAsSent(userId: string, dedupHashes: string[]): Promise<void> {
  const hashes = [...new Set(dedupHashes.filter(Boolean))];
  if (hashes.length === 0) return;
  const placeholders = hashes.map(() => "?").join(", ");
  await client.execute({
    sql: `UPDATE jm_user_job_matches SET emailed_at = datetime('now')
          WHERE user_id = ? AND job_posting_id IN (
            SELECT id FROM jm_job_postings WHERE dedup_hash IN (${placeholders})
          )`,
    args: [userId, ...hashes],
  });
}

// slot is a free-form dedup key: "am"/"pm" for the original fixed-time cron,
// "hour-N" for the per-user hourly cron (src/cron.ts) - any mechanism sharing
// this table dedupes against the others as long as slot values don't collide.
export async function hasEmailBeenSent(userId: string, sendDate: string, slot: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT id FROM jm_email_send_log WHERE user_id = ? AND send_date = ? AND slot = ? AND status = 'sent'",
    args: [userId, sendDate, slot],
  });
  return result.rows.length > 0;
}

export async function hasEmailBeenAttempted(userId: string, sendDate: string, slot: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT id FROM jm_email_send_log WHERE user_id = ? AND send_date = ? AND slot = ?
      AND status IN ('processing', 'sent', 'empty')`,
    args: [userId, sendDate, slot],
  });
  return result.rows.length > 0;
}

// An atomic claim prevents overlapping hourly workers from scraping/sending the
// same user's daily digest twice. Failed work can retry; empty and sent attempts
// are terminal for that user's local day. A stale processing claim can be taken
// over after four hours if a runner died without recording a result.
export async function claimEmailSend(userId: string, sendDate: string, slot: string): Promise<boolean> {
  const result = await client.execute({
    sql: `INSERT INTO jm_email_send_log (id, user_id, send_date, slot, status, sent_at)
      VALUES (?, ?, ?, ?, 'processing', datetime('now'))
      ON CONFLICT(user_id, send_date, slot) DO UPDATE SET
        status = 'processing', provider_message_id = NULL, sent_at = datetime('now'), error_text = NULL
      WHERE jm_email_send_log.status = 'failed'
        OR jm_email_send_log.status = 'blocked'
        OR (jm_email_send_log.status = 'processing' AND jm_email_send_log.sent_at < datetime('now', '-4 hours'))`,
    args: [randomUUID(), userId, sendDate, slot],
  });
  return result.rowsAffected === 1;
}

export async function logEmailSend(
  userId: string,
  sendDate: string,
  slot: string,
  status: "processing" | "sent" | "empty" | "blocked" | "failed",
  providerMessageId?: string,
  errorText?: string
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_email_send_log (id, user_id, send_date, slot, status, provider_message_id, sent_at, error_text)
      VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END, ?)
      ON CONFLICT(user_id, send_date, slot) DO UPDATE SET
        status = excluded.status,
        provider_message_id = excluded.provider_message_id,
        sent_at = excluded.sent_at,
        error_text = excluded.error_text`,
    args: [randomUUID(), userId, sendDate, slot, status, providerMessageId ?? null, status, errorText ?? null],
  });
}

export async function startScrapeRun(): Promise<string> {
  const id = randomUUID();
  await client.execute({
    sql: "INSERT INTO jm_scrape_runs (id, status, started_at) VALUES (?, 'running', datetime('now'))",
    args: [id],
  });
  return id;
}

export async function finishScrapeRun(
  id: string,
  postingsFound: number,
  postingsNew: number,
  errorText?: string
): Promise<void> {
  await client.execute({
    sql: `UPDATE jm_scrape_runs SET status = ?, finished_at = datetime('now'), postings_found = ?, postings_new = ?, error_text = ?
      WHERE id = ?`,
    args: [errorText ? "failed" : "complete", postingsFound, postingsNew, errorText ?? null, id],
  });
}

export async function upsertScrapeSourceStatuses(
  userId: string,
  statuses: Array<{ source: string; count: number; ok: boolean; errorCode?: string }>
): Promise<void> {
  if (!statuses.length) return;
  await client.batch(statuses.map(({ source, count, ok, errorCode }) => ({
    sql: `INSERT INTO jm_scrape_source_status (user_id, source, last_attempt_at, last_success_at, last_count, last_error_code)
          VALUES (?, ?, datetime('now'), CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?)
          ON CONFLICT(user_id, source) DO UPDATE SET
            last_attempt_at = datetime('now'),
            last_success_at = CASE WHEN ? = 1 THEN datetime('now') ELSE jm_scrape_source_status.last_success_at END,
            last_count = ?,
            last_error_code = ?`,
    args: [userId, source, ok ? 1 : 0, count, errorCode ?? null, ok ? 1 : 0, count, errorCode ?? null],
  })), "write");
}

// Read-path used when local data/cv.txt + profile.json aren't available (e.g. the
// Vercel deployment, which never has the gitignored data files) - lets a deployment
// with only Turso credentials configured still run the digest end-to-end.
export interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const result = await client.execute({ sql: "SELECT id, email, name FROM jm_users WHERE email = ?", args: [email] });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id as string, email: row.email as string, name: row.name as string | null };
}

export async function getActiveCvText(userId: string): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT extracted_text FROM jm_cvs WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1",
    args: [userId],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].extracted_text as string;
}

export async function getUserProfileRow(userId: string): Promise<DbProfile | null> {
  const result = await client.execute({
    sql: `SELECT target_designation, current_employer, current_title, current_salary_fixed_lpa,
                 current_salary_esop_lpa, current_salary_currency, career_start_date,
                 preferred_country, preferred_city, skills_json
          FROM jm_user_profiles WHERE user_id = ?`,
    args: [userId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    targetDesignation: row.target_designation as string,
    currentEmployer: row.current_employer as string,
    currentTitle: row.current_title as string,
    currentSalaryFixedLPA: row.current_salary_fixed_lpa as number,
    currentSalaryEsopLPA: row.current_salary_esop_lpa as number,
    currentSalaryCurrency: row.current_salary_currency as string,
    careerStartDate: (row.career_start_date as string) ?? undefined,
    preferredCountry: (row.preferred_country as string) ?? undefined,
    preferredCity: (row.preferred_city as string) ?? undefined,
    skills: (() => { try { return JSON.parse(String(row.skills_json || "[]")); } catch { return []; } })(),
  };
}

/**
 * Save profile/CV/companies without running a scan (TASK-063, POST /api/user/profile).
 * The profile patch is merged over the saved row so callers can update one field
 * (e.g. Settings changing only the city) without wiping the rest.
 */
export async function saveUserProfileData(
  userId: string,
  update: { cvText?: string; profile?: import("./inputValidation.js").ProfilePatch; companies?: CompanySources }
): Promise<{ profile: DbProfile | null; companies: CompanySources | null; hasCv: boolean }> {
  if (update.profile) {
    const existing = await getUserProfileRow(userId);
    const merged = { ...(existing ?? {}), ...update.profile };
    await upsertUserProfile(userId, {
      targetDesignation: merged.targetDesignation ?? "",
      currentEmployer: merged.currentEmployer ?? "",
      currentTitle: merged.currentTitle ?? "",
      // libSQL rejects undefined args; null keeps "not provided" distinct from 0.
      currentSalaryFixedLPA: (merged.currentSalaryFixedLPA ?? null) as number,
      currentSalaryEsopLPA: (merged.currentSalaryEsopLPA ?? null) as number,
      currentSalaryCurrency: merged.currentSalaryCurrency ?? "INR",
      careerStartDate: merged.careerStartDate ?? undefined,
      preferredCountry: merged.preferredCountry ?? undefined,
      preferredCity: merged.preferredCity ?? undefined,
      skills: merged.skills ?? [],
    });
  }
  if (update.cvText !== undefined) await upsertCv(userId, update.cvText);
  if (update.companies) await upsertUserCompanies(userId, update.companies);
  const [profile, companies, cvText] = await Promise.all([
    getUserProfileRow(userId),
    getUserCompanies(userId),
    getActiveCvText(userId),
  ]);
  return { profile, companies, hasCv: Boolean(cvText && cvText.trim()) };
}

/**
 * Postings (dedup_hash) already scored for this user since their CV and profile last
 * changed, within the last `maxAgeDays` (TASK-073). Scheduled runs skip these instead
 * of re-scoring the same postings every day; older scores are refreshed eventually.
 */
export async function getRecentlyScoredPostingHashes(userId: string, maxAgeDays = 14): Promise<Set<string>> {
  const result = await client.execute({
    sql: `SELECT p.dedup_hash AS h
          FROM jm_user_job_matches m JOIN jm_job_postings p ON p.id = m.job_posting_id
          WHERE m.user_id = ?
            AND m.status IN ('new', 'scored')
            -- Rule-based (Python) scores are provisional: the LLM should still get them (TASK-102).
            AND coalesce(m.reasoning_text, '') NOT LIKE 'Rule-based match%'
            AND coalesce(m.reasoning_text, '') NOT LIKE 'Estimated by rules%'
            AND m.matched_at >= datetime('now', ?)
            AND m.matched_at >= COALESCE((SELECT MAX(updated_at) FROM jm_user_profiles WHERE user_id = ?), '')
            AND m.matched_at >= COALESCE((SELECT MAX(created_at) FROM jm_cvs WHERE user_id = ? AND is_active = 1), '')`,
    args: [userId, `-${Math.max(1, Math.floor(maxAgeDays))} days`, userId, userId],
  });
  return new Set(result.rows.map((row: any) => String(row.h)));
}

/** Heartbeat written at the end of every non-fatal cron run (TASK-086). */
export async function recordCronHeartbeat(summary: Record<string, number>): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_app_status (key, value, updated_at) VALUES ('cron_last_success', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [JSON.stringify(summary)],
  });
}

/** Last successful cron run, or null if none has been recorded yet. */
export async function getCronHeartbeat(): Promise<{ lastSuccessAt: string; summary: Record<string, number> } | null> {
  const result = await client.execute("SELECT value, updated_at FROM jm_app_status WHERE key = 'cron_last_success'");
  const row: any = result.rows[0];
  if (!row) return null;
  let summary: Record<string, number> = {};
  try { summary = JSON.parse(String(row.value ?? "{}")); } catch { /* keep empty */ }
  return { lastSuccessAt: `${String(row.updated_at).replace(" ", "T")}Z`, summary };
}

// ---- Referrals (TASK-089) -------------------------------------------------
// Codes are random (not derived from the user id) so a shared link reveals nothing
// about the account. Reward logic is intentionally absent until it is decided.
const REFERRAL_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i
export const REFERRAL_ATTRIBUTION_WINDOW_DAYS = 7;

function newReferralCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => REFERRAL_ALPHABET[b % REFERRAL_ALPHABET.length]).join("");
}

/** The user's referral code, created on first use. */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await client.execute({ sql: "SELECT referral_code FROM jm_users WHERE id = ?", args: [userId] });
  if (existing.rows.length === 0) throw new Error("User not found.");
  const current = existing.rows[0].referral_code;
  if (current) return String(current);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Only set it while still empty, so concurrent first requests agree on one code.
      await client.execute({ sql: "UPDATE jm_users SET referral_code = ? WHERE id = ? AND referral_code IS NULL", args: [newReferralCode(), userId] });
      const row = await client.execute({ sql: "SELECT referral_code FROM jm_users WHERE id = ?", args: [userId] });
      return String(row.rows[0].referral_code);
    } catch (err) {
      if (!/unique|constraint/i.test((err as Error).message)) throw err; // code collision: try another
    }
  }
  throw new Error("Could not allocate a referral code.");
}

export type ReferralClaimResult = "recorded" | "already_referred" | "invalid_code" | "self_referral" | "too_old";

/**
 * Attribute a new account to the owner of `code`. Only accounts created within the
 * attribution window can be claimed, an account is referred at most once, never by itself.
 */
export async function claimReferral(referredUserId: string, code: string): Promise<ReferralClaimResult> {
  const normalized = code.trim().toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(normalized)) return "invalid_code";
  const owner = await client.execute({ sql: "SELECT id FROM jm_users WHERE referral_code = ?", args: [normalized] });
  if (owner.rows.length === 0) return "invalid_code";
  const referrerId = String(owner.rows[0].id);
  if (referrerId === referredUserId) return "self_referral";
  const referred = await client.execute({
    sql: "SELECT created_at >= datetime('now', ?) AS recent FROM jm_users WHERE id = ?",
    args: [`-${REFERRAL_ATTRIBUTION_WINDOW_DAYS} days`, referredUserId],
  });
  if (referred.rows.length === 0 || Number(referred.rows[0].recent) !== 1) return "too_old";
  const inserted = await client.execute({
    sql: "INSERT INTO jm_user_referrals (referred_user_id, referrer_user_id, code) VALUES (?, ?, ?) ON CONFLICT(referred_user_id) DO NOTHING",
    args: [referredUserId, referrerId, normalized],
  });
  return inserted.rowsAffected > 0 ? "recorded" : "already_referred";
}

/** Code plus how many accounts it brought in. */
export async function getReferralSummary(userId: string): Promise<{ code: string; referredCount: number }> {
  const code = await getOrCreateReferralCode(userId);
  const count = await client.execute({ sql: "SELECT COUNT(*) AS n FROM jm_user_referrals WHERE referrer_user_id = ?", args: [userId] });
  return { code, referredCount: Number(count.rows[0]?.n ?? 0) };
}

export interface PythonShadowRow {
  postingHash: string;
  source: string;
  pythonScore: number;
  signalCoverage: number;
  caps: string[];
  llmScore: number | null;
  llmProvider: string | null;
  usedAsFallback: boolean;
}

/** Upsert one scheduled run's Python results for a user (TASK-102); latest scoring wins. */
export async function recordPythonShadowScores(userId: string, rows: PythonShadowRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO jm_python_shadow_scores (user_id, posting_hash, source, python_score, signal_coverage, caps, llm_score, llm_provider, used_as_fallback, scored_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id, posting_hash) DO UPDATE SET
            source = excluded.source, python_score = excluded.python_score, signal_coverage = excluded.signal_coverage,
            caps = excluded.caps, llm_score = excluded.llm_score, llm_provider = excluded.llm_provider,
            used_as_fallback = excluded.used_as_fallback, scored_at = excluded.scored_at`,
    args: [userId, r.postingHash, r.source, Math.round(r.pythonScore), r.signalCoverage, r.caps.join(",") || null,
      r.llmScore === null ? null : Math.round(r.llmScore), r.llmProvider, r.usedAsFallback ? 1 : 0],
  }));
  for (let i = 0; i < stmts.length; i += 100) await client.batch(stmts.slice(i, i + 100), "write");
}

export async function deletePendingMatches(userId: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM jm_user_job_matches WHERE user_id = ? AND status = 'pending'",
    args: [userId],
  });
}

export async function bulkInsertPostingsAndPendingMatches(userId: string, postings: any[]): Promise<void> {
  const batchStatements = [];
  for (const p of postings) {
    const postingId = randomUUID();
    const matchId = randomUUID();
    const dedupHash = `${p.company.toLowerCase()}:${p.title.toLowerCase()}:${(p.location || "").toLowerCase()}`;
    
    batchStatements.push({
      sql: `INSERT INTO jm_job_postings (id, source, source_job_id, company_name, title, location, description_text, source_metadata, apply_url, dedup_hash, posted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedup_hash) DO UPDATE SET
              posted_at = COALESCE(excluded.posted_at, jm_job_postings.posted_at),
              source_metadata = COALESCE(excluded.source_metadata, jm_job_postings.source_metadata),
              scraped_at = datetime('now')`,
      args: [postingId, p.source, p.sourceJobId || null, p.company, p.title, p.location || null, p.descriptionText || "", p.sourceMetadata ? JSON.stringify(p.sourceMetadata) : null, p.applyUrl, dedupHash, p.postedAt || null],
    });

    batchStatements.push({
      sql: `INSERT INTO jm_user_job_matches (id, user_id, job_posting_id, fit_score, comp_fit_label, reasoning_text, status)
            SELECT ?, ?, id, -1, 'unknown', 'Pending evaluation', 'pending'
            FROM jm_job_postings WHERE dedup_hash = ?
            ON CONFLICT(user_id, job_posting_id) DO UPDATE SET
              status = CASE WHEN status = 'scored' THEN 'scored' ELSE 'pending' END`,
      args: [matchId, userId, dedupHash],
    });
  }

  if (batchStatements.length > 0) {
    await client.batch(batchStatements);
  }
}

export function isRoleTitleMatch(title: string, targetDesignation: string): boolean {
  const normTitle = (title || "").toLowerCase();
  const normTarget = (targetDesignation || "").toLowerCase().trim();
  if (!normTarget || !normTitle) return false;

  // Direct substring match
  if (normTitle.includes(normTarget)) return true;

  // Check if target is a Product Management role
  const isPmTarget = /(product\s*manager|\bapm\b|\bpm\b|product\s*owner)/i.test(normTarget);
  if (isPmTarget) {
    const pmPatterns = [
      /\bproduct\s*manager\b/i,
      /\bapm\b/i,
      /\bassociate\s*product\s*manager\b/i,
      /\btechnical\s*product\s*manager\b/i,
      /\bproduct\s*owner\b/i,
      /\bgroup\s*product\s*manager\b/i,
      /\bprincipal\s*product\s*manager\b/i,
      /\blead\s*product\s*manager\b/i,
      /\bsr\.?\s*product\s*manager\b/i,
      /\bsenior\s*product\s*manager\b/i,
    ];
    return pmPatterns.some((re) => re.test(normTitle));
  }

  // General token extraction (excluding seniority and stop words)
  const stopWords = new Set(["senior", "lead", "staff", "junior", "principal", "intern", "associate", "the", "in", "at", "and", "of", "level", "ii", "iii", "iv", "sr", "jr"]);
  const targetTokens = normTarget
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  if (targetTokens.length === 0) return false;

  const synonyms: Record<string, string[]> = {
    engineer: ["developer", "programmer", "swe", "sde"],
    developer: ["engineer", "programmer", "swe", "sde"],
    backend: ["back-end", "server"],
    frontend: ["front-end", "ui", "web"],
    fullstack: ["full-stack", "full stack"],
  };

  return targetTokens.every((token) => {
    if (normTitle.includes(token)) return true;
    const syns = synonyms[token];
    return syns && syns.some((syn) => normTitle.includes(syn));
  });
}

/**
 * Instantly seeds fresh pending candidate matches for a user from the shared central pool of indexed postings
 * (jm_job_postings). Enforces role relevance (no unrelated jobs) and a 30-day freshness window.
 */
export async function seedCandidateMatchesFromPool(
  userId: string,
  targetDesignation: string,
  locationPatternsRegexes?: RegExp[] | null,
  limit = 50
): Promise<number> {
  const result = await client.execute({
    sql: `SELECT id, title, location
          FROM jm_job_postings
          WHERE id NOT IN (SELECT job_posting_id FROM jm_user_job_matches WHERE user_id = ?)
            AND (posted_at >= datetime('now', '-30 days') OR scraped_at >= datetime('now', '-14 days'))
          ORDER BY COALESCE(posted_at, scraped_at) DESC
          LIMIT 1000`,
    args: [userId],
  });

  const matchedPostings = (result.rows as Array<{ id: string; title: string; location: string | null }>).filter((row) => {
    const title = String(row.title || "");
    if (!isRoleTitleMatch(title, targetDesignation)) return false;

    if (locationPatternsRegexes && locationPatternsRegexes.length > 0) {
      const loc = String(row.location || "");
      if (!loc) return true; // remote or unspecified location included
      return locationPatternsRegexes.some((re) => re.test(loc));
    }
    return true;
  }).slice(0, limit);

  if (matchedPostings.length === 0) return 0;

  const batch = matchedPostings.map((p) => ({
    sql: `INSERT INTO jm_user_job_matches (id, user_id, job_posting_id, fit_score, comp_fit_label, reasoning_text, status)
          VALUES (?, ?, ?, -1, 'unknown', 'Pending evaluation', 'pending')
          ON CONFLICT(user_id, job_posting_id) DO NOTHING`,
    args: [randomUUID(), userId, p.id],
  }));

  await client.batch(batch, "write");
  return matchedPostings.length;
}

const MATCH_SCORE_LEASE_MINUTES = 5;

/** Atomically leases pending rows so concurrent page loads cannot spend twice on the same jobs.
 * A crashed function's lease becomes claimable again after five minutes. */
export async function getPendingMatchesForUser(userId: string, limit = 4) {
  const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit) || 4));
  const claimToken = randomUUID();
  const candidates = await client.execute({
    sql: `SELECT m.id AS match_id
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE m.user_id = ?
            AND (m.status = 'pending' OR (m.status = 'scoring' AND m.matched_at < datetime('now', ?)))
          ORDER BY COALESCE(jp.posted_at, jp.scraped_at) DESC, m.id ASC
          LIMIT ?`,
    args: [userId, `-${MATCH_SCORE_LEASE_MINUTES} minutes`, boundedLimit],
  });
  const ids: string[] = candidates.rows.map((row: any) => String(row.match_id));
  if (!ids.length) return [];

  const claimed = await client.batch(ids.map((id) => ({
    sql: `UPDATE jm_user_job_matches
          SET status = 'scoring', matched_at = datetime('now'), score_claim_token = ?
          WHERE id = ? AND user_id = ?
            AND (status = 'pending' OR (status = 'scoring' AND matched_at < datetime('now', ?)))`,
    args: [claimToken, id, userId, `-${MATCH_SCORE_LEASE_MINUTES} minutes`],
  })), "write");
  const claimedIds = ids.filter((_, index) => claimed[index]?.rowsAffected > 0);
  if (!claimedIds.length) return [];

  const placeholders = claimedIds.map(() => "?").join(",");
  const result = await client.execute({
    sql: `SELECT jp.id as posting_id, jp.source, jp.source_job_id as sourceJobId, jp.company_name as company,
                 jp.title, jp.location, jp.description_text as descriptionText, jp.source_metadata as sourceMetadata,
                 jp.apply_url as applyUrl, jp.dedup_hash as dedupHash, jp.posted_at as postedAt, jp.scraped_at as scrapedAt,
                 m.id as match_id, m.score_claim_token as claimToken, m.fit_score as fitScore, m.comp_fit_label as compFitLabel, m.reasoning_text as reasoningText, m.status,
                 m.user_action as userAction, m.matched_at as matchedAt
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE m.user_id = ? AND m.status = 'scoring' AND m.score_claim_token = ? AND m.id IN (${placeholders})`,
    args: [userId, claimToken, ...claimedIds],
  });
  return result.rows as any[];
}

export async function releasePendingMatchClaims(userId: string, matchIds: string[], claimToken: string): Promise<void> {
  if (!matchIds.length || !claimToken) return;
  const placeholders = matchIds.map(() => "?").join(",");
  await client.execute({
    sql: `UPDATE jm_user_job_matches SET status = 'pending', score_claim_token = NULL
          WHERE user_id = ? AND status = 'scoring' AND score_claim_token = ? AND id IN (${placeholders})`,
    args: [userId, claimToken, ...matchIds],
  });
}

export async function getPendingMatchCountForUser(userId: string): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) as count FROM jm_user_job_matches WHERE user_id = ? AND status IN ('pending', 'scoring')",
    args: [userId],
  });
  return Number(result.rows[0]?.count || 0);
}

export type MatchFeedFilter = "new" | "saved" | "applied" | "dismissed" | "all";
export type MatchFeedSort = "best" | "newest";
export interface MatchFeedOptions {
  /** Omitted = legacy behaviour (every match, newest first), used by the pre-v2 UI. */
  filter?: MatchFeedFilter;
  minScore?: number;
  source?: string;
  sort?: MatchFeedSort;
}
export type MatchUserAction = "saved" | "applied" | "dismissed";

// Builds the WHERE clause shared by the feed query and its count, so pagination
// totals always agree with the rows shown. Values are bound, never interpolated.
function matchFeedWhere(userId: string, opts: MatchFeedOptions = {}): { where: string; args: (string | number)[] } {
  const clauses = ["m.user_id = ?"];
  const args: (string | number)[] = [userId];
  // v2 feed tabs (any explicit filter) show scored matches only; unscored 'pending'
  // rows (fit_score -1) belong to the legacy lazy-scoring path. Tab semantics follow
  // the DEC-007 review: New = no user action yet (independent of whether it was
  // emailed); "new since last digest" is a separate header count in getUserStats.
  if (opts.filter) clauses.push("m.status IN ('new', 'scored')");
  switch (opts.filter) {
    case "new":
      clauses.push("m.user_action IS NULL");
      break;
    case "saved":
    case "applied":
    case "dismissed":
      clauses.push("m.user_action = ?");
      args.push(opts.filter);
      break;
    case "all":
      clauses.push("(m.user_action IS NULL OR m.user_action != 'dismissed')");
      break;
  }
  if (typeof opts.minScore === "number" && Number.isFinite(opts.minScore)) {
    clauses.push("m.fit_score >= ?");
    args.push(opts.minScore);
  }
  if (opts.source) {
    clauses.push("jp.source = ?");
    args.push(opts.source);
  }
  return { where: clauses.join(" AND "), args };
}

export async function getPaginatedMatchesForUser(userId: string, offset: number, limit: number, opts: MatchFeedOptions = {}) {
  const { where, args } = matchFeedWhere(userId, opts);
  // Pending (unscored, fit_score -1) rows sort last under "best" naturally.
  const orderBy = opts.sort === "best"
    ? "m.fit_score DESC, COALESCE(jp.posted_at, jp.scraped_at) DESC, jp.id ASC"
    : "COALESCE(jp.posted_at, jp.scraped_at) DESC, jp.id ASC";
  const result = await client.execute({
    sql: `SELECT jp.id as posting_id, jp.source, jp.source_job_id as sourceJobId, jp.company_name as company, jp.title, jp.location, jp.description_text as descriptionText, jp.source_metadata as sourceMetadata, jp.apply_url as applyUrl, jp.dedup_hash as dedupHash, jp.posted_at as postedAt, jp.scraped_at as scrapedAt,
                 m.id as matchId, m.status, m.fit_score as fitScore, m.comp_fit_label as compFitLabel, m.reasoning_text as reasoningText,
                 m.user_action as userAction, m.emailed_at as emailedAt
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });
  let invalidMetadataRows = 0;
  const rows = result.rows.map((row: any) => {
    let sourceMetadata: unknown;
    if (typeof row.sourceMetadata === "string" && row.sourceMetadata) {
      try {
        sourceMetadata = JSON.parse(row.sourceMetadata);
      } catch {
        invalidMetadataRows++;
      }
    }
    return { ...row, sourceMetadata };
  });
  if (invalidMetadataRows) await captureTelemetryEvent("feed_metadata_invalid", { row_count: invalidMetadataRows });
  return rows;
}

export async function getTotalMatchCountForUser(userId: string, opts: MatchFeedOptions = {}): Promise<number> {
  const { where, args } = matchFeedWhere(userId, opts);
  const result = await client.execute({
    sql: `SELECT COUNT(*) as count
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE ${where}`,
    args,
  });
  return Number(result.rows[0]?.count || 0);
}

// Records the user's action on one of THEIR matches. The user_id predicate is the
// ownership check: a match id belonging to someone else updates zero rows.
// Pass null to clear (e.g. undo "Not relevant"). Returns whether a row changed.
export async function setMatchUserAction(userId: string, matchId: string, action: MatchUserAction | null): Promise<boolean> {
  const result = await client.execute({
    sql: "UPDATE jm_user_job_matches SET user_action = ? WHERE id = ? AND user_id = ?",
    args: [action, matchId, userId],
  });
  return result.rowsAffected > 0;
}

export async function updateMatchScore(
  userId: string,
  postingId: string,
  fitScore: number,
  compFitLabel: string,
  reasoningText: string,
  descriptionText?: string,
  claimToken?: string
): Promise<void> {
  const result = await client.execute({
    sql: "UPDATE jm_user_job_matches SET fit_score = ?, comp_fit_label = ?, reasoning_text = ?, status = 'scored', matched_at = datetime('now'), score_claim_token = NULL WHERE user_id = ? AND job_posting_id = ? AND (? IS NULL OR score_claim_token = ?)",
    args: [fitScore, compFitLabel, reasoningText, userId, postingId, claimToken ?? null, claimToken ?? null],
  });
  if (!result.rowsAffected) return;
  if (descriptionText !== undefined) {
    await client.execute({
      sql: "UPDATE jm_job_postings SET description_text = ? WHERE id = ?",
      args: [descriptionText, postingId],
    });
  }
}

export interface UserStats {
  totalScraped: number;
  totalScored: number;
  averageFitScore: number;
  highMatchCount: number;
  mediumMatchCount: number;
  lowMatchCount: number;
  companyDistribution: { company: string; count: number }[];
  /** Header count: scored after the last sent digest (all scored, if no digest sent yet). */
  newSinceLastDigest: number;
  /** Tab counts - each uses exactly the same predicate as its feed filter. */
  newCount: number;
  savedCount: number;
  appliedCount: number;
  dismissedCount: number;
  allCount: number;
}

// "Scored" means status 'new' (scored by the hourly cron via upsertUserMatch) or
// 'scored' (scored lazily by the UI page route). Counting only 'scored' is what made
// the old UI show "0 matches" for accounts with hundreds of cron-scored matches (TASK-053).
export async function getUserStats(userId: string): Promise<UserStats> {
  // Independent queries - run together (one DB round trip instead of seven).
  const [totalRes, scoredRes, highRes, mediumRes, lowRes, companyRes, actionRes] = await Promise.all([
    client.execute({
      sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ?",
      args: [userId],
    }),
    client.execute({
      sql: "SELECT COUNT(*) as cnt, AVG(fit_score) as avg_score FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored')",
      args: [userId],
    }),
    client.execute({
      sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score >= 80",
      args: [userId],
    }),
    client.execute({
      sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score >= 60 AND fit_score < 80",
      args: [userId],
    }),
    client.execute({
      sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score < 60",
      args: [userId],
    }),
    client.execute({
      sql: `
        SELECT p.company_name, COUNT(*) as cnt
        FROM jm_user_job_matches m
        JOIN jm_job_postings p ON m.job_posting_id = p.id
        WHERE m.user_id = ?
        GROUP BY p.company_name
        ORDER BY cnt DESC
        LIMIT 5
      `,
      args: [userId],
    }),
    client.execute({
      sql: `SELECT
              SUM(CASE WHEN user_action IS NULL THEN 1 ELSE 0 END) AS new_cnt,
              SUM(CASE WHEN user_action = 'saved' THEN 1 ELSE 0 END) AS saved_cnt,
              SUM(CASE WHEN user_action = 'applied' THEN 1 ELSE 0 END) AS applied_cnt,
              SUM(CASE WHEN user_action = 'dismissed' THEN 1 ELSE 0 END) AS dismissed_cnt,
              SUM(CASE WHEN user_action IS NULL OR user_action != 'dismissed' THEN 1 ELSE 0 END) AS all_cnt,
              SUM(CASE WHEN matched_at > COALESCE(
                    (SELECT MAX(sent_at) FROM jm_email_send_log l WHERE l.user_id = ? AND l.status = 'sent'),
                    '0000') THEN 1 ELSE 0 END) AS since_digest_cnt
            FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored')`,
      args: [userId, userId],
    }),
  ]);
  const totalScraped = Number(totalRes.rows[0]?.cnt || 0);
  const totalScored = Number(scoredRes.rows[0]?.cnt || 0);
  const averageFitScore = Math.round(Number(scoredRes.rows[0]?.avg_score || 0));
  const highMatchCount = Number(highRes.rows[0]?.cnt || 0);
  const mediumMatchCount = Number(mediumRes.rows[0]?.cnt || 0);
  const lowMatchCount = Number(lowRes.rows[0]?.cnt || 0);

  const companyDistribution = companyRes.rows.map((row: any) => ({
    company: String(row.company_name || "Unknown"),
    count: Number(row.cnt || 0),
  }));

  // actionRes mirrors matchFeedWhere's v2 predicates so tab counts equal the rows each tab shows.
  const actionRow: any = actionRes.rows[0] ?? {};

  return {
    totalScraped,
    totalScored,
    averageFitScore,
    highMatchCount,
    mediumMatchCount,
    lowMatchCount,
    companyDistribution,
    newSinceLastDigest: Number(actionRow.since_digest_cnt || 0),
    newCount: Number(actionRow.new_cnt || 0),
    savedCount: Number(actionRow.saved_cnt || 0),
    appliedCount: Number(actionRow.applied_cnt || 0),
    dismissedCount: Number(actionRow.dismissed_cnt || 0),
    allCount: Number(actionRow.all_cnt || 0),
  };
}

export const KNOWN_SOURCES = ["linkedin", "naukri", "greenhouse", "lever", "ashby"] as const;

export interface UserStatus {
  /** Most recent time any posting was scraped or re-seen (shared across users). */
  lastScanAt: string | null;
  /** Most recent time a match was scored for this user. */
  lastScoredAt: string | null;
  lastDigestSentAt: string | null;
  digestEnabled: boolean;
  digestHour: number | null;
  timezone: string;
  /** Postings seen per source in the last 24h, with a readable status (DEC-007: never color alone). */
  sources: { source: string; count24h: number; healthy: boolean; statusText: string }[];
}

// Derived from real data rather than the in-memory scrape_health log, so it works
// for every pipeline (hourly cron and UI) without touching the runner.
export async function getUserStatus(userId: string): Promise<UserStatus> {
  const [scan, scored, digest, user, sources, checks] = await Promise.all([
    client.execute("SELECT MAX(scraped_at) AS t FROM jm_job_postings"),
    client.execute({ sql: "SELECT MAX(matched_at) AS t FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored')", args: [userId] }),
    client.execute({ sql: "SELECT MAX(sent_at) AS t FROM jm_email_send_log WHERE user_id = ? AND status = 'sent'", args: [userId] }),
    client.execute({ sql: "SELECT digest_enabled, digest_hour, timezone FROM jm_users WHERE id = ?", args: [userId] }),
    client.execute("SELECT source, COUNT(*) AS n FROM jm_job_postings WHERE scraped_at >= datetime('now', '-1 day') GROUP BY source"),
    client.execute({ sql: "SELECT source, last_attempt_at, last_success_at, last_count, last_error_code FROM jm_scrape_source_status WHERE user_id = ?", args: [userId] }),
  ]);
  const counts = new Map<string, number>(sources.rows.map((r: any) => [String(r.source), Number(r.n)]));
  const sourceChecks = new Map<string, any>(checks.rows.map((r: any) => [String(r.source), r]));
  const u: any = user.rows[0] ?? {};
  return {
    lastScanAt: (scan.rows[0]?.t as string) ?? null,
    lastScoredAt: (scored.rows[0]?.t as string) ?? null,
    lastDigestSentAt: (digest.rows[0]?.t as string) ?? null,
    digestEnabled: u.digest_enabled === 1,
    digestHour: u.digest_hour ?? null,
    timezone: (u.timezone as string) || "Asia/Kolkata",
    sources: KNOWN_SOURCES.map((s) => {
      const count24h = counts.get(s) ?? 0;
      const check = sourceChecks.get(s);
      const recentlyChecked = Boolean(check?.last_attempt_at && Date.parse(String(check.last_attempt_at).replace(" ", "T") + "Z") >= Date.now() - 24 * 60 * 60 * 1000);
      const hasError = Boolean(check?.last_error_code);
      const healthy = recentlyChecked ? !hasError : count24h > 0;
      return {
        source: s,
        count24h,
        healthy,
        statusText: recentlyChecked && hasError
          ? "The latest source check failed. Other sources can still return jobs."
          : recentlyChecked && Number(check?.last_count || 0) === 0
            ? "Checked successfully; no postings were returned in the latest scrape."
            : recentlyChecked && count24h === 0
              ? `The latest scrape returned ${Number(check?.last_count || 0)} postings; results have not appeared in the feed yet.`
            : count24h > 0
              ? `${count24h} ${count24h === 1 ? "job" : "jobs"} in the last 24 hours`
              : "No recent source check is available.",
      };
    }),
  };
}

export async function recordDailyVisit(
  visitDate: string,
  visitorHash: string,
  path: string = "/",
  referrer?: string | null
): Promise<void> {
  const safePath = (path || "/").slice(0, 100);
  const safeReferrer = referrer ? referrer.slice(0, 200) : null;
  await client.execute({
    sql: `INSERT INTO jm_daily_visitors (visit_date, visitor_hash, path, referrer, hits, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
          ON CONFLICT(visit_date, visitor_hash, path) DO UPDATE SET
            hits = jm_daily_visitors.hits + 1,
            last_seen_at = datetime('now'),
            referrer = coalesce(excluded.referrer, jm_daily_visitors.referrer)`,
    args: [visitDate, visitorHash, safePath, safeReferrer],
  });
}

export async function getDailyVisitorStats(days: number = 30): Promise<{
  summary: {
    today_visitors: number;
    yesterday_visitors: number;
    total_period_visitors: number;
    total_period_views: number;
  };
  daily: Array<{ visit_date: string; unique_visitors: number; total_views: number }>;
  top_paths: Array<{ path: string; views: number }>;
}> {
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const [dailyResult, pathsResult, uniqueVisitorSetResult] = await client.batch([
    {
      sql: `SELECT visit_date, COUNT(DISTINCT visitor_hash) AS unique_visitors, SUM(hits) AS total_views
            FROM jm_daily_visitors
            WHERE visit_date >= ?
            GROUP BY visit_date
            ORDER BY visit_date DESC`,
      args: [cutoffDate],
    },
    {
      sql: `SELECT path, SUM(hits) AS views
            FROM jm_daily_visitors
            WHERE visit_date >= ?
            GROUP BY path
            ORDER BY views DESC
            LIMIT 10`,
      args: [cutoffDate],
    },
    {
      sql: `SELECT COUNT(DISTINCT visitor_hash) AS total_unique, SUM(hits) AS total_views
            FROM jm_daily_visitors
            WHERE visit_date >= ?`,
      args: [cutoffDate],
    },
  ], "read");

  const daily = (dailyResult.rows as Array<{ visit_date: string; unique_visitors: number; total_views: number }>).map((r) => ({
    visit_date: String(r.visit_date),
    unique_visitors: Number(r.unique_visitors || 0),
    total_views: Number(r.total_views || 0),
  }));

  const top_paths = (pathsResult.rows as Array<{ path: string; views: number }>).map((r) => ({
    path: String(r.path),
    views: Number(r.views || 0),
  }));

  const todayRow = daily.find((d) => d.visit_date === today);
  const yesterdayRow = daily.find((d) => d.visit_date === yesterday);
  const totalPeriodVisitors = Number(uniqueVisitorSetResult.rows[0]?.total_unique || 0);
  const totalPeriodViews = Number(uniqueVisitorSetResult.rows[0]?.total_views || 0);

  return {
    summary: {
      today_visitors: todayRow?.unique_visitors || 0,
      yesterday_visitors: yesterdayRow?.unique_visitors || 0,
      total_period_visitors: totalPeriodVisitors,
      total_period_views: totalPeriodViews,
    },
    daily,
    top_paths,
  };
}

