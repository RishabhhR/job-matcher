import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

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
  `CREATE TABLE IF NOT EXISTS jm_user_companies (
    user_id TEXT PRIMARY KEY REFERENCES jm_users(id),
    greenhouse_json TEXT NOT NULL,
    lever_json TEXT NOT NULL,
    ashby_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

export async function migrate() {
  for (const stmt of SCHEMA) {
    await client.execute(stmt);
  }
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
  ];
  for (const sql of addColumns) {
    try {
      await client.execute(sql);
    } catch (err) {
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }

  const addColumnsUsers = [
    "ALTER TABLE jm_users ADD COLUMN clerk_id TEXT",
    "ALTER TABLE jm_users ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 9",
  ];
  for (const sql of addColumnsUsers) {
    try {
      await client.execute(sql);
    } catch (err) {
      if (!/duplicate column|already exists/i.test((err as Error).message)) throw err;
    }
  }

  try {
    await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS jm_users_clerk_id_idx ON jm_users(clerk_id)");
  } catch (err) {
    if (!/already exists|duplicate/i.test((err as Error).message)) throw err;
  }

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
}

export async function upsertUserProfile(userId: string, profile: DbProfile): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_user_profiles
      (user_id, target_designation, current_employer, current_title, current_salary_fixed_lpa, current_salary_esop_lpa, current_salary_currency, career_start_date, preferred_country, preferred_city, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        updated_at = datetime('now')`,
    args: [
      userId,
      profile.targetDesignation,
      profile.currentEmployer,
      profile.currentTitle,
      profile.currentSalaryFixedLPA,
      profile.currentSalaryEsopLPA,
      profile.currentSalaryCurrency,
      profile.careerStartDate ?? null,
      profile.preferredCountry ?? null,
      profile.preferredCity ?? null,
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
                 preferred_country, preferred_city
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
  return result.rows.map((row: any) => ({
    ...row,
    sourceMetadata: typeof row.sourceMetadata === "string" ? JSON.parse(row.sourceMetadata) : undefined,
  }));
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
  descriptionText?: string
): Promise<void> {
  if (descriptionText !== undefined) {
    await client.execute({
      sql: "UPDATE jm_job_postings SET description_text = ? WHERE id = ?",
      args: [descriptionText, postingId],
    });
  }
  await client.execute({
    sql: "UPDATE jm_user_job_matches SET fit_score = ?, comp_fit_label = ?, reasoning_text = ?, status = 'scored', matched_at = datetime('now') WHERE user_id = ? AND job_posting_id = ?",
    args: [fitScore, compFitLabel, reasoningText, userId, postingId],
  });
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
  const totalRes = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ?",
    args: [userId],
  });
  const totalScraped = Number(totalRes.rows[0]?.cnt || 0);

  const scoredRes = await client.execute({
    sql: "SELECT COUNT(*) as cnt, AVG(fit_score) as avg_score FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored')",
    args: [userId],
  });
  const totalScored = Number(scoredRes.rows[0]?.cnt || 0);
  const averageFitScore = Math.round(Number(scoredRes.rows[0]?.avg_score || 0));

  const highRes = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score >= 80",
    args: [userId],
  });
  const highMatchCount = Number(highRes.rows[0]?.cnt || 0);

  const mediumRes = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score >= 60 AND fit_score < 80",
    args: [userId],
  });
  const mediumMatchCount = Number(mediumRes.rows[0]?.cnt || 0);

  const lowRes = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored') AND fit_score < 60",
    args: [userId],
  });
  const lowMatchCount = Number(lowRes.rows[0]?.cnt || 0);

  const companyRes = await client.execute({
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
  });

  const companyDistribution = companyRes.rows.map((row: any) => ({
    company: String(row.company_name || "Unknown"),
    count: Number(row.cnt || 0),
  }));

  // Mirrors matchFeedWhere's v2 predicates so tab counts equal the rows each tab shows.
  const actionRes = await client.execute({
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
  });
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
  const [scan, scored, digest, user, sources] = await Promise.all([
    client.execute("SELECT MAX(scraped_at) AS t FROM jm_job_postings"),
    client.execute({ sql: "SELECT MAX(matched_at) AS t FROM jm_user_job_matches WHERE user_id = ? AND status IN ('new', 'scored')", args: [userId] }),
    client.execute({ sql: "SELECT MAX(sent_at) AS t FROM jm_email_send_log WHERE user_id = ? AND status = 'sent'", args: [userId] }),
    client.execute({ sql: "SELECT digest_enabled, digest_hour, timezone FROM jm_users WHERE id = ?", args: [userId] }),
    client.execute("SELECT source, COUNT(*) AS n FROM jm_job_postings WHERE scraped_at >= datetime('now', '-1 day') GROUP BY source"),
  ]);
  const counts = new Map<string, number>(sources.rows.map((r: any) => [String(r.source), Number(r.n)]));
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
      return {
        source: s,
        count24h,
        healthy: count24h > 0,
        statusText: count24h > 0
          ? `${count24h} ${count24h === 1 ? "job" : "jobs"} in the last 24 hours`
          : "No jobs in the last 24 hours. This source may be blocked or temporarily down.",
      };
    }),
  };
}
