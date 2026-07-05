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
  // Patch schema additions separately for existing tables
  const addColumns = [
    "ALTER TABLE jm_user_profiles ADD COLUMN career_start_date TEXT",
    "ALTER TABLE jm_user_profiles ADD COLUMN preferred_country TEXT",
    "ALTER TABLE jm_user_profiles ADD COLUMN preferred_city TEXT",
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
}

export async function upsertUser(
  email: string,
  name: string,
  clerkId?: string,
  timezone = "Asia/Kolkata"
): Promise<string> {
  if (clerkId) {
    const existing = await client.execute({ sql: "SELECT id FROM jm_users WHERE clerk_id = ?", args: [clerkId] });
    if (existing.rows.length > 0) {
      const id = existing.rows[0].id as string;
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

export async function logEmailSend(
  userId: string,
  sendDate: string,
  slot: string,
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
      sql: `INSERT INTO jm_job_postings (id, source, source_job_id, company_name, title, location, description_text, apply_url, dedup_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedup_hash) DO UPDATE SET title = title`,
      args: [postingId, p.source, p.sourceJobId || null, p.company, p.title, p.location || null, p.descriptionText || "", p.applyUrl, dedupHash],
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

export async function getPaginatedMatchesForUser(userId: string, offset: number, limit: number) {
  const result = await client.execute({
    sql: `SELECT jp.id as posting_id, jp.source, jp.source_job_id as sourceJobId, jp.company_name as company, jp.title, jp.location, jp.description_text as descriptionText, jp.apply_url as applyUrl, jp.dedup_hash as dedupHash,
                 m.status, m.fit_score as fitScore, m.comp_fit_label as compFitLabel, m.reasoning_text as reasoningText
          FROM jm_user_job_matches m
          JOIN jm_job_postings jp ON jp.id = m.job_posting_id
          WHERE m.user_id = ?
          ORDER BY jp.scraped_at DESC, jp.id ASC
          LIMIT ? OFFSET ?`,
    args: [userId, limit, offset],
  });
  return result.rows;
}

export async function getTotalMatchCountForUser(userId: string): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) as count FROM jm_user_job_matches WHERE user_id = ?",
    args: [userId],
  });
  return (result.rows[0]?.count as number) || 0;
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
