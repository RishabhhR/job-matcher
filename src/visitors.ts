// Visitor profiles for signed-out traffic (TASK-104). Everything here is derived
// per request and kept coarse: no raw IP address or raw User-Agent is returned.

export type VisitorDevice = { device: "mobile" | "tablet" | "desktop" | "unknown"; browser: string | null; os: string | null; isBot: boolean };

export type VisitorPing = {
  visitorId: string;
  path: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  language: string | null;
  timezone: string | null;
} & VisitorDevice;

const BOT_PATTERN = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|go-http|vercel-screenshot|preview/i;

// Ids are generated in the browser with crypto.randomUUID (or a random fallback).
export function cleanVisitorId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{16,40}$/i.test(value) ? value.toLowerCase() : null;
}

// Only the referrer's origin is kept, never the full URL.
export function referrerOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

// Browsers holding an older analytics.js still send a full URL as the path.
export function visitPath(value: unknown): string {
  let path = typeof value === "string" ? value : "/";
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      path = url.pathname + url.hash;
    } catch {
      path = "/";
    }
  }
  return path.replace(/[^\w\-\/\#\.\?=&]/g, "").slice(0, 100) || "/";
}

// Each deploy gets its own *.vercel.app host; only the public site counts as traffic.
export function isSiteHost(headers: Record<string, unknown>, site: string): boolean {
  const host = headers["x-forwarded-host"] || headers.host;
  return typeof host === "string" && host.split(",")[0].trim().toLowerCase() === new URL(site).host;
}

function cleanShort(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\p{L}\p{N}\s_\-+.,:/@]/gu, "").trim().slice(0, max);
  return text || null;
}

export function parseUserAgent(userAgent: string): VisitorDevice {
  const ua = userAgent || "";
  if (!ua) return { device: "unknown", browser: null, os: null, isBot: false };
  const isBot = BOT_PATTERN.test(ua);
  const device = /ipad|tablet|(android(?!.*mobile))/i.test(ua) ? "tablet" : /mobi|iphone|ipod|android/i.test(ua) ? "mobile" : "desktop";
  const browser = /edg\//i.test(ua) ? "Edge"
    : /opr\/|opera/i.test(ua) ? "Opera"
    : /samsungbrowser/i.test(ua) ? "Samsung Internet"
    : /firefox|fxios/i.test(ua) ? "Firefox"
    : /chrome|crios/i.test(ua) ? "Chrome"
    : /safari/i.test(ua) ? "Safari"
    : null;
  const os = /windows/i.test(ua) ? "Windows"
    : /iphone|ipad|ipod/i.test(ua) ? "iOS"
    : /android/i.test(ua) ? "Android"
    : /mac os x|macintosh/i.test(ua) ? "macOS"
    : /cros/i.test(ua) ? "ChromeOS"
    : /linux/i.test(ua) ? "Linux"
    : null;
  return { device, browser, os, isBot };
}

const header = (headers: Record<string, unknown>, name: string): string | null => {
  const value = headers[name];
  if (typeof value !== "string" || !value) return null;
  try { return decodeURIComponent(value); } catch { return value; }
};

/** Builds a visitor ping from the request body and headers, or null when the id is missing. */
export function visitorPingFrom(body: any, headers: Record<string, unknown>, path: string, referrer: string | null): VisitorPing | null {
  const visitorId = cleanVisitorId(body?.visitorId);
  if (!visitorId) return null;
  const utm = body?.utm && typeof body.utm === "object" ? body.utm : {};
  return {
    visitorId,
    path,
    referrer: referrerOrigin(referrer),
    utmSource: cleanShort(utm.source),
    utmMedium: cleanShort(utm.medium),
    utmCampaign: cleanShort(utm.campaign),
    // Vercel adds these geo headers at the edge; they are absent locally.
    country: cleanShort(header(headers, "x-vercel-ip-country"), 8),
    region: cleanShort(header(headers, "x-vercel-ip-country-region"), 16),
    city: cleanShort(header(headers, "x-vercel-ip-city"), 60),
    language: cleanShort(body?.language, 20),
    timezone: cleanShort(body?.timezone, 50),
    ...parseUserAgent(String(headers["user-agent"] || "")),
  };
}
