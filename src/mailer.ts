import { Resend } from "resend";
import type { Row } from "@libsql/client";

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
  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: "Job Matcher <onboarding@resend.dev>",
    to: toEmail,
    subject: `${slotLabel} Job Matches — ${matches.length} roles ranked`,
    html: renderHtml(matches, slot),
  }, idempotencyKey ? { idempotencyKey } : undefined);

  if (error) throw new Error(`Resend send failed: ${error.message}`);
  return data?.id ?? "unknown";
}
