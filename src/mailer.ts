import { Resend } from "resend";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Row } from "@libsql/client";

// Gmail SMTP (TASK-071) is used when GMAIL_USER + GMAIL_APP_PASSWORD are set: free,
// no domain to verify, and it delivers to any recipient (Resend's test sender only
// reaches the Resend account owner). Resend remains the fallback when they are not set.
export function mailProvider(env: NodeJS.ProcessEnv = process.env): "gmail" | "resend" {
  return env.GMAIL_USER?.trim() && env.GMAIL_APP_PASSWORD?.trim() ? "gmail" : "resend";
}

let _gmail: Transporter | null = null;
function getGmail(): Transporter {
  if (!_gmail) {
    _gmail = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER!.trim(),
        // Google shows app passwords in groups of four; spaces are not part of it.
        pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s+/g, ""),
      },
    });
  }
  return _gmail;
}

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY environment variable is missing.");
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

export interface DigestMatchRow {
  title: string;
  company_name: string;
  location: string;
  apply_url: string;
  source: string;
  fit_score: number;
  comp_fit_label: string;
  reasoning_text: string;
}

export function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
}

export function safeApplyUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? escapeHtml(url.toString()) : "#";
  } catch {
    return "#";
  }
}

function safeGmailError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e?.code === "EAUTH" || e?.responseCode === 535) {
    return "Gmail rejected the login. GMAIL_APP_PASSWORD must be a Google app password (2-Step Verification on), not the account password.";
  }
  return String(e?.message ?? err).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]");
}

function safeResendError(message: string): string {
  if (/only send testing emails to your own email address/i.test(message)) {
    return "Resend is in test mode and cannot send to this recipient. Verify a sending domain in Resend and configure RESEND_FROM_EMAIL.";
  }
  return message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]");
}

function renderHtml(matches: (Row | DigestMatchRow)[], slot: "am" | "pm"): string {
  const rows = matches
    .map((m: any) => {
      const badgeColor = m.comp_fit_label === "upgrade" ? "#16a34a" : m.comp_fit_label === "downgrade" ? "#dc2626" : "#6b7280";
      const applyUrl = safeApplyUrl(m.apply_url);
      return `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
            <div style="font-weight:600;font-size:15px;color:#111827;">[${escapeHtml(m.fit_score)}] ${escapeHtml(m.title)} — ${escapeHtml(m.company_name)}</div>
            <div style="font-size:13px;color:#6b7280;margin-top:2px;">${escapeHtml(m.location)} · <span style="color:${badgeColor};font-weight:600;">${escapeHtml(m.comp_fit_label)}</span> · via ${escapeHtml(m.source)}</div>
            <div style="font-size:13px;color:#374151;margin-top:6px;">${escapeHtml(m.reasoning_text)}</div>
            <a href="${applyUrl}" style="font-size:13px;color:#2563eb;">Apply →</a>
          </td>
        </tr>`;
    })
    .join("");

  const slotLabel = slot === "am" ? "Morning" : "Evening";
  return `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#111827;">${slotLabel} Job Matches</h2>
      <p style="color:#6b7280;font-size:14px;">Your top ranked job matches for today.</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
    </div>`;
}

export async function sendDigestEmail(
  toEmail: string,
  matches: (Row | DigestMatchRow)[],
  slot: "am" | "pm",
  idempotencyKey?: string
): Promise<string> {
  const slotLabel = slot === "am" ? "Morning" : "Evening";
  const subject = `${slotLabel} Job Matches — ${matches.length} roles ranked`;
  const html = renderHtml(matches, slot);

  if (mailProvider() === "gmail") {
    try {
      const info = await getGmail().sendMail({
        from: { name: "JobMatcher", address: process.env.GMAIL_USER!.trim() },
        to: toEmail,
        subject,
        html,
        // Duplicate sends are already prevented by the DB claim (claimEmailSend);
        // this header just lets mail clients thread/dedupe retries.
        headers: idempotencyKey ? { "X-Entity-Ref-ID": idempotencyKey } : undefined,
      });
      return info.messageId || "unknown";
    } catch (err) {
      throw new Error(`Gmail send failed: ${safeGmailError(err)}`);
    }
  }

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL?.trim() || "Job Matcher <onboarding@resend.dev>",
    to: toEmail,
    subject,
    html,
  }, idempotencyKey ? { idempotencyKey } : undefined);

  if (error) throw new Error(`Resend send failed: ${safeResendError(error.message)}`);
  return data?.id ?? "unknown";
}

/** Weekly opt-in email (TASK-105); carries one-click unsubscribe headers. */
export async function sendLeadEmail(toEmail: string, subject: string, html: string, unsubscribeUrl: string): Promise<string> {
  const headers = { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  if (mailProvider() === "gmail") {
    try {
      const info = await getGmail().sendMail({ from: { name: "JobMatcher", address: process.env.GMAIL_USER!.trim() }, to: toEmail, subject, html, headers });
      return info.messageId || "unknown";
    } catch (err) {
      throw new Error(`Gmail send failed: ${safeGmailError(err)}`);
    }
  }
  const { data, error } = await getResend().emails.send({
    from: process.env.RESEND_FROM_EMAIL?.trim() || "Job Matcher <onboarding@resend.dev>",
    to: toEmail, subject, html, headers,
  });
  if (error) throw new Error(`Resend send failed: ${safeResendError(error.message)}`);
  return data?.id ?? "unknown";
}

export async function sendServiceUpdateEmail(
  toEmail: string,
  userName: string,
  matches: (Row | DigestMatchRow)[],
  hasProfile: boolean
): Promise<string> {
  const subject = hasProfile && matches.length > 0
    ? `JobMatcher Service Update: Systems are live — ${matches.length} scored roles for you`
    : `JobMatcher Service Update: All systems operational`;

  const rows = matches
    .map((m: any) => {
      const badgeColor = m.comp_fit_label === "upgrade" ? "#16a34a" : m.comp_fit_label === "downgrade" ? "#dc2626" : "#6b7280";
      const applyUrl = safeApplyUrl(m.apply_url);
      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e5e7eb;">
            <div style="font-weight:600;font-size:15px;color:#111827;">
              <span style="display:inline-block;background:#0d9488;color:#ffffff;font-size:12px;font-weight:700;padding:2px 8px;border-radius:12px;margin-right:6px;">Fit ${escapeHtml(m.fit_score)}</span>
              ${escapeHtml(m.title)} — <span style="color:#4b5563;">${escapeHtml(m.company_name)}</span>
            </div>
            <div style="font-size:13px;color:#6b7280;margin-top:4px;">
              📍 ${escapeHtml(m.location)} · <span style="color:${badgeColor};font-weight:600;">${escapeHtml(m.comp_fit_label)}</span> · via ${escapeHtml(m.source)}
            </div>
            <div style="font-size:13px;color:#374151;margin-top:6px;line-height:1.4;">${escapeHtml(m.reasoning_text)}</div>
            <div style="margin-top:8px;">
              <a href="${applyUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-size:12px;font-weight:600;padding:6px 14px;border-radius:6px;text-decoration:none;">Apply Now →</a>
            </div>
          </td>
        </tr>`;
    })
    .join("");

  const contentHtml = hasProfile && matches.length > 0
    ? `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;">
        <div style="font-weight:700;color:#166534;font-size:16px;">🟢 All Services Up & Operational</div>
        <p style="margin:6px 0 0;color:#15803d;font-size:14px;line-height:1.5;">
          Our background job matching engine, scrapers (LinkedIn, Greenhouse, Ashby, Lever, Naukri), and scoring pipelines have been fully restored with expanded model fallbacks and token optimizations.
        </p>
      </div>
      <p style="color:#374151;font-size:14px;line-height:1.5;">
        Hi ${escapeHtml(userName || "there")},<br><br>
        Here are your current top scored job postings evaluated directly against your CV and profile preferences:
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px;">${rows}</table>
      <div style="text-align:center;margin-top:28px;padding-top:20px;border-top:1px solid #e5e7eb;">
        <a href="https://job-matcher-ecru.vercel.app/#/matches" style="display:inline-block;background:#0d9488;color:#ffffff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          View All Your Matches on JobMatcher →
        </a>
      </div>
    `
    : `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;">
        <div style="font-weight:700;color:#166534;font-size:16px;">🟢 All Services Up & Operational</div>
        <p style="margin:6px 0 0;color:#15803d;font-size:14px;line-height:1.5;">
          JobMatcher's scrapers and AI scoring pipelines are running at full health.
        </p>
      </div>
      <p style="color:#374151;font-size:14px;line-height:1.5;">
        Hi ${escapeHtml(userName || "there")},<br><br>
        Your account is active, but we don't have your CV on file yet to score personalized job matches.
      </p>
      <div style="text-align:center;margin-top:24px;">
        <a href="https://job-matcher-ecru.vercel.app/#/onboarding" style="display:inline-block;background:#0d9488;color:#ffffff;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          Upload Your CV & Start Finding Matches →
        </a>
      </div>
    `;

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;padding:20px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <div style="border-bottom:1px solid #e5e7eb;padding-bottom:16px;margin-bottom:20px;">
        <span style="font-size:20px;font-weight:800;color:#0d9488;letter-spacing:-0.5px;">JobMatcher</span>
      </div>
      ${contentHtml}
      <div style="margin-top:30px;padding-top:16px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px;text-align:center;">
        JobMatcher · Automated intelligent job search & ranking
      </div>
    </div>
  `;

  if (mailProvider() === "gmail") {
    try {
      const info = await getGmail().sendMail({
        from: { name: "JobMatcher", address: process.env.GMAIL_USER!.trim() },
        to: toEmail,
        subject,
        html,
      });
      return info.messageId || "unknown";
    } catch (err) {
      throw new Error(`Gmail send failed: ${safeGmailError(err)}`);
    }
  }

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL?.trim() || "Job Matcher <onboarding@resend.dev>",
    to: toEmail,
    subject,
    html,
  });

  if (error) throw new Error(`Resend send failed: ${safeResendError(error.message)}`);
  return data?.id ?? "unknown";
}

