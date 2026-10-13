import type { RawPosting } from "./scrapers.js";

export function canonicalizeUrl(url: string | null | undefined): string {
  if (!url || typeof url !== "string") {
    return "";
  }
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase();
  }
}

export function dedupePostings(postings: (RawPosting | null | undefined)[]): RawPosting[] {
  const seen = new Set<string>();
  const out: RawPosting[] = [];
  for (const p of postings) {
    if (!p || typeof p !== "object") continue;

    const applyUrl = typeof p.applyUrl === "string" ? p.applyUrl.trim() : "";
    const title = typeof p.title === "string" ? p.title.trim() : "";

    if (!applyUrl || !title) continue;

    const key = canonicalizeUrl(applyUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    out.push({
      source: p.source || "unknown",
      sourceJobId: p.sourceJobId || "",
      company: typeof p.company === "string" ? p.company : "Unknown Company",
      title,
      location: typeof p.location === "string" ? p.location : "Remote / Unspecified",
      applyUrl,
      descriptionText: typeof p.descriptionText === "string" ? p.descriptionText : "",
      ...(typeof p.postedAt === "string" ? { postedAt: p.postedAt } : {}),
    });
  }
  return out;
}
