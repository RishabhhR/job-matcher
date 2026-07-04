import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";

let _client: any;
const client = new Proxy({} as any, {
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
    apply_url TEXT,
    dedup_hash TEXT UNIQUE NOT NULL,
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
];

export async function migrate() {
  for (const stmt of SCHEMA) {
    await client.execute(stmt);
  }
}

export async function upsertUser(email: string, name: string, timezone = "Asia/Kolkata"): Promise<string> {
  const existing = await client.execute({ sql: "SELECT id FROM jm_users WHERE email = ?", args: [email] });
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id as string;
    await client.execute({
      sql: "UPDATE jm_users SET name = ?, timezone = ?, updated_at = datetime('now') WHERE id = ?",
      args: [name, timezone, id],
    });
    return id;
  }
  const id = randomUUID();
  await client.execute({
    sql: "INSERT INTO jm_users (id, email, name, timezone) VALUES (?, ?, ?, ?)",
    args: [id, email, name, timezone],
  });
  return id;
}

export interface DbProfile {
  targetDesignation: string;
  currentEmployer: string;
  currentTitle: string;
  currentSalaryFixedLPA: number;
  currentSalaryEsopLPA: number;
  currentSalaryCurrency: string;
}

export async function upsertUserProfile(userId: string, profile: DbProfile): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_user_profiles
      (user_id, target_designation, current_employer, current_title, current_salary_fixed_lpa, current_salary_esop_lpa, current_salary_currency, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        target_designation = excluded.target_designation,
        current_employer = excluded.current_employer,
        current_title = excluded.current_title,
        current_salary_fixed_lpa = excluded.current_salary_fixed_lpa,
        current_salary_esop_lpa = excluded.current_salary_esop_lpa,
        current_salary_currency = excluded.current_salary_currency,
        updated_at = datetime('now')`,
    args: [
      userId,
      profile.targetDesignation,
      profile.currentEmployer,
      profile.currentTitle,
      profile.currentSalaryFixedLPA,
      profile.currentSalaryEsopLPA,
      profile.currentSalaryCurrency,
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
}

export async function upsertJobPosting(posting: DbPosting): Promise<string> {
  const existing = await client.execute({
    sql: "SELECT id FROM jm_job_postings WHERE dedup_hash = ?",
    args: [posting.dedupHash],
  });
  if (existing.rows.length > 0) return existing.rows[0].id as string;

  const id = randomUUID();
  await client.execute({
    sql: `INSERT INTO jm_job_postings
      (id, source, source_job_id, company_name, title, location, description_text, apply_url, dedup_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const result = await client.execute({
    sql: `SELECT jp.title, jp.company_name, jp.location, jp.apply_url, jp.source,
                 m.fit_score, m.comp_fit_label, m.reasoning_text
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE m.user_id = ?
          ORDER BY m.fit_score DESC
          LIMIT ?`,
    args: [userId, limit],
  });
  return result.rows;
}

export async function hasEmailBeenSent(userId: string, sendDate: string, slot: "am" | "pm"): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT id FROM jm_email_send_log WHERE user_id = ? AND send_date = ? AND slot = ? AND status = 'sent'",
    args: [userId, sendDate, slot],
  });
  return result.rows.length > 0;
}

export async function logEmailSend(
  userId: string,
  sendDate: string,
  slot: "am" | "pm",
  status: "sent" | "failed",
  providerMessageId?: string,
  errorText?: string
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO jm_email_send_log (id, user_id, send_date, slot, status, provider_message_id, sent_at, error_text)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(user_id, send_date, slot) DO UPDATE SET
        status = excluded.status,
        provider_message_id = excluded.provider_message_id,
        sent_at = datetime('now'),
        error_text = excluded.error_text`,
    args: [randomUUID(), userId, sendDate, slot, status, providerMessageId ?? null, errorText ?? null],
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
