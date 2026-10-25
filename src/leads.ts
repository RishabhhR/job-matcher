// Opt-in job emails for signed-out visitors (TASK-105). A visitor leaves an email
// and an optional role; the cron run sends them new matching openings once a week.
// Consent is explicit (DEC-008): nothing here reads the sign-in form.
import { escapeHtml, safeApplyUrl } from "./mailer.js";

export const SITE = "https://job-matcher-ecru.vercel.app";
export const DEFAULT_LEAD_ROLE = "Product Manager";
// Stored with each sign-up so we can show what the visitor agreed to.
export const LEAD_CONSENT_TEXT = "One email a week with new openings for your role. Unsubscribe in one click.";
export const LEAD_SEND_INTERVAL_DAYS = 7;
export const LEAD_MAX_JOBS = 10;

export interface LeadJob {
  title: string;
  company: string;
  location: string;
  source: string;
  applyUrl: string;
}

export function cleanLeadEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(email) ? email : null;
}

export function cleanRole(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LEAD_ROLE;
  const role = value.replace(/[^\p{L}\p{N}\s&+/.,-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return role || DEFAULT_LEAD_ROLE;
}

const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "for", "in", "at", "to", "or", "role", "roles", "job", "jobs"]);

/** Words that must all appear in a job title for it to count as this role. */
export function roleKeywords(role: string): string[] {
  const words = role.toLowerCase().split(/[^\p{L}\p{N}+]+/u).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 4);
}

export function unsubscribeUrl(token: string): string {
  return `${SITE}/api/leads/unsubscribe?token=${encodeURIComponent(token)}`;
}

export function renderLeadEmail(role: string, jobs: LeadJob[], token: string): { subject: string; html: string } {
  const subject = `${jobs.length} new ${role} ${jobs.length === 1 ? "opening" : "openings"} this week`;
  const rows = jobs.map((job) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
      <div style="font-weight:600;font-size:15px;color:#111827;">${escapeHtml(job.title)} — <span style="color:#4b5563;">${escapeHtml(job.company)}</span></div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">${job.location ? `${escapeHtml(job.location)} · ` : ""}via ${escapeHtml(job.source)}</div>
      <div style="margin-top:8px;"><a href="${safeApplyUrl(job.applyUrl)}" style="color:#2563eb;font-size:13px;font-weight:600;text-decoration:none;">View the listing →</a></div>
    </td></tr>`).join("");
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#111827;">New ${escapeHtml(role)} openings</h2>
      <p style="color:#6b7280;font-size:14px;">Roles JobMatcher found in the past week. Check each listing for current availability before applying.</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="margin-top:24px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">
        <strong style="color:#111827;">Want only the roles that fit you?</strong>
        <p style="color:#4b5563;font-size:14px;margin:6px 0 12px;">Upload your CV and JobMatcher scores every new opening against it, with a reason for each.</p>
        <a href="${SITE}/?signin=1&utm_source=lead_email&utm_medium=email" style="display:inline-block;background:#2563eb;color:#ffffff;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px;text-decoration:none;">Match my CV →</a>
      </div>
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;">You asked JobMatcher to email you new ${escapeHtml(role)} openings. <a href="${unsubscribeUrl(token)}" style="color:#6b7280;">Unsubscribe</a></p>
    </div>`;
  return { subject, html };
}

/** Server-rendered form for the public /jobs pages; public/leads.js submits it. */
export function leadFormHtml(source: string): string {
  return `<form class="lead-form" data-lead-form data-lead-source="${escapeHtml(source)}" novalidate><div class="lead-form-copy"><strong>Not ready to upload a CV?</strong><p>${escapeHtml(LEAD_CONSENT_TEXT)}</p></div><div class="lead-form-fields"><label class="sr-only" for="lead-email-${escapeHtml(source)}">Email</label><input id="lead-email-${escapeHtml(source)}" name="email" type="email" autocomplete="email" placeholder="you@example.com" required><label class="sr-only" for="lead-role-${escapeHtml(source)}">Role</label><input id="lead-role-${escapeHtml(source)}" name="role" type="text" placeholder="Role, e.g. Product Manager" maxlength="60"><input name="website" type="text" tabindex="-1" autocomplete="off" class="lead-form-trap" aria-hidden="true"><button class="btn btn-primary" type="submit" data-analytics-id="lead_submit_${escapeHtml(source)}">Email me new jobs</button></div><p class="lead-form-status" role="status" hidden></p></form><script src="/leads.js" defer></script>`;
}

const sqliteTime = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

/**
 * Sends the weekly email to every due lead. Called at the end of the cron run;
 * it never throws, so a mail or database problem here cannot fail the digest run.
 */
export async function runLeadEmails(deps: {
  getDueEmailLeads: (intervalDays: number) => Promise<Array<{ email: string; role: string; token: string; lastSentAt: string | null }>>;
  getRecentJobsForKeywords: (keywords: string[], since: string, limit: number) => Promise<LeadJob[]>;
  markEmailLeadSent: (email: string) => Promise<void>;
  send: (to: string, subject: string, html: string, unsubscribeUrl: string) => Promise<string>;
  now?: Date;
}): Promise<{ due: number; sent: number; empty: number; failed: number }> {
  const summary = { due: 0, sent: 0, empty: 0, failed: 0 };
  try {
    const leads = await deps.getDueEmailLeads(LEAD_SEND_INTERVAL_DAYS);
    summary.due = leads.length;
    const weekAgo = sqliteTime(new Date((deps.now ?? new Date()).getTime() - LEAD_SEND_INTERVAL_DAYS * 86_400_000));
    for (const lead of leads) {
      try {
        const since = lead.lastSentAt && lead.lastSentAt > weekAgo ? lead.lastSentAt : weekAgo;
        const jobs = await deps.getRecentJobsForKeywords(roleKeywords(lead.role), since, LEAD_MAX_JOBS);
        // Nothing new: try again on the next run rather than sending an empty email.
        if (jobs.length === 0) { summary.empty++; continue; }
        const { subject, html } = renderLeadEmail(lead.role, jobs, lead.token);
        await deps.send(lead.email, subject, html, unsubscribeUrl(lead.token));
        await deps.markEmailLeadSent(lead.email);
        summary.sent++;
      } catch (error) {
        summary.failed++;
        console.error("[lead-emails] Send failed for one lead:", (error as Error).message);
      }
    }
  } catch (error) {
    console.error("[lead-emails] Skipped this run:", (error as Error).message);
  }
  return summary;
}
