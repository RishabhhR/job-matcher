import type { CompanySources } from "./db.js";

export function parseCompanySources(value: unknown): CompanySources | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const out: CompanySources = { greenhouse: [], lever: [], ashby: [] };
  for (const source of ["greenhouse", "lever", "ashby"] as const) {
    const entries = input[source];
    if (!Array.isArray(entries) || entries.length > 300) return null;
    const cleaned: string[] = [];
    for (const item of entries) {
      if (typeof item !== "string") return null;
      const slug = item.trim();
      if (!/^[a-z0-9_-]{1,80}$/i.test(slug)) return null;
      cleaned.push(slug);
    }
    out[source] = [...new Set(cleaned)];
  }
  return out;
}
