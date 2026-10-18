// Location preferences (TASK-065). preferredCity may hold several places joined by
// commas ("Bengaluru, Pune") - the v2 Settings page stores a list that way - so it is
// split, and every place is regex-escaped: user text must never become a raw RegExp.

export interface LocationPrefs {
  preferredCity?: string | null;
  preferredCountry?: string | null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "Bengaluru, Pune, Remote" -> ["Bengaluru", "Pune"]. Remote is always included separately. */
export function splitPlaces(value?: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const place = raw.trim();
    const key = place.toLowerCase();
    if (!place || key === "remote" || seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  return out;
}

/**
 * Patterns a posting's location must match. Always includes remote/hybrid/anywhere.
 * Returns null when no city or country is set, meaning "don't filter".
 */
export function locationPatterns(prefs: LocationPrefs): RegExp[] | null {
  const places = [...splitPlaces(prefs.preferredCountry), ...splitPlaces(prefs.preferredCity)];
  if (places.length === 0) return null;
  return [/remote/i, /\bhybrid\b/i, /anywhere/i, ...places.map((p) => new RegExp(escapeRegExp(p), "i"))];
}

/** The one place to pass to single-location searches (LinkedIn, Naukri): first city, else country. */
export function primaryPlace(prefs: LocationPrefs): string {
  return splitPlaces(prefs.preferredCity)[0] || splitPlaces(prefs.preferredCountry)[0] || "";
}

/** Human label for progress messages: "Bengaluru, Pune". */
export function placesLabel(prefs: LocationPrefs): string {
  return splitPlaces(prefs.preferredCity).join(", ") || splitPlaces(prefs.preferredCountry).join(", ");
}
