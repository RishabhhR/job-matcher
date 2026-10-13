export interface RawPosting {
  source: "greenhouse" | "lever" | "ashby" | "linkedin" | "naukri";
  sourceJobId: string;
  company: string;
  title: string;
  location: string;
  applyUrl: string;
  descriptionText: string;
  /** Source-provided posting/update date in ISO format when available. */
  postedAt?: string;
  /** Optional source-specific public fields preserved for display and downstream use. */
  sourceMetadata?: Record<string, unknown>;
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: { "User-Agent": "job-matcher-phase1/0.1" } });
  if (!res.ok) throw new Error(`Board returned HTTP ${res.status}`);
  return await res.json();
}

export async function fetchGreenhouse(company: string): Promise<RawPosting[]> {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`);
  if (!data?.jobs) return [];
  return data.jobs.map((j: any) => ({
    source: "greenhouse" as const,
    sourceJobId: String(j.id),
    company,
    title: j.title,
    location: j.location?.name || "",
    applyUrl: j.absolute_url,
    descriptionText: stripHtml(j.content || ""),
    postedAt: toIsoDate(j.updated_at),
  }));
}

export async function fetchLever(company: string): Promise<RawPosting[]> {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${company}?mode=json`);
  if (!Array.isArray(data)) return [];
  return data.map((j: any) => ({
    source: "lever" as const,
    sourceJobId: String(j.id),
    company,
    title: j.text,
    location: j.categories?.location || "",
    applyUrl: j.hostedUrl,
    descriptionText: stripHtml(j.descriptionPlain || j.description || ""),
    postedAt: toIsoDate(j.createdAt),
  }));
}

export async function fetchAshby(company: string): Promise<RawPosting[]> {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${company}`);
  if (!data?.jobs) return [];
  return data.jobs.map((j: any) => ({
    source: "ashby" as const,
    sourceJobId: String(j.id),
    company,
    title: j.title,
    location: j.location || "",
    applyUrl: j.jobUrl || j.applyUrl,
    descriptionText: stripHtml(j.descriptionPlain || j.description || ""),
    postedAt: toIsoDate(j.publishedAt),
  }));
}

export async function fetchAllPostings(companies: {
  greenhouse: string[];
  lever: string[];
  ashby: string[];
}): Promise<RawPosting[]> {
  const results: RawPosting[] = [];

  const tasks: Promise<RawPosting[]>[] = [
    ...companies.greenhouse.map((c) => fetchGreenhouse(c)),
    ...companies.lever.map((c) => fetchLever(c)),
    ...companies.ashby.map((c) => fetchAshby(c)),
  ];

  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value);
  }
  return results;
}
