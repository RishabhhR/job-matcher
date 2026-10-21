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

export type ProfilePatch = {
  targetDesignation?: string;
  currentEmployer?: string;
  currentTitle?: string;
  currentSalaryFixedLPA?: number | null;
  currentSalaryEsopLPA?: number | null;
  currentSalaryCurrency?: string;
  careerStartDate?: string | null;
  preferredCountry?: string | null;
  preferredCity?: string | null;
  skills?: string[];
};

const PROFILE_TEXT_FIELDS = ["targetDesignation", "currentEmployer", "currentTitle", "preferredCountry", "preferredCity"] as const;
const PROFILE_SALARY_FIELDS = ["currentSalaryFixedLPA", "currentSalaryEsopLPA"] as const;

// Whitelists a partial profile update (TASK-063). Unknown keys are ignored; a known key
// with the wrong type rejects the whole patch. "" / null clear optional fields.
export function parseProfilePatch(value: unknown): ProfilePatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const out: ProfilePatch = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === null && key !== "targetDesignation" && key !== "currentEmployer" && key !== "currentTitle") { out[key] = null; continue; }
    if (typeof v !== "string" || v.length > 200) return null;
    out[key] = v.trim();
  }
  for (const key of PROFILE_SALARY_FIELDS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === null || v === "") { out[key] = null; continue; }
    const n = Number(v);
    if (typeof v === "boolean" || !Number.isFinite(n) || n < 0 || n > 100_000) return null;
    out[key] = n;
  }
  if ("currentSalaryCurrency" in input) {
    const v = input.currentSalaryCurrency;
    if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) return null;
    out.currentSalaryCurrency = v;
  }
  if ("careerStartDate" in input) {
    const v = input.careerStartDate;
    if (v === null || v === "") out.careerStartDate = null;
    else if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) out.careerStartDate = v;
    else return null;
  }
  if ("skills" in input) {
    const value = input.skills;
    if (!Array.isArray(value) || value.length > 40 || value.some((item) => typeof item !== "string" || item.trim().length < 1 || item.trim().length > 50)) return null;
    out.skills = [...new Set(value.map((item) => (item as string).trim()))];
  }
  return out;
}
