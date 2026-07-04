import type { RawPosting } from "./scrapers.js";

function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase();
  }
}

export function dedupePostings(postings: RawPosting[]): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const p of postings) {
    const key = canonicalizeUrl(p.applyUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
