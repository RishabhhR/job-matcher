// Next occurrence of `hour`:00 local time in `timeZone`, returned as a UTC ISO string.
// Returns null for an unknown timezone instead of throwing, so a bad stored value
// degrades to "next digest unknown" in the UI rather than a failed request.
export function nextDigestAt(hour: number, timeZone: string, now: Date = new Date()): string | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(now)
        .map((p) => [p.type, p.value])
    );
    // Wall-clock "now" in the target zone, expressed as if it were UTC.
    const localNow = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const nowUtcMinute = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes());
    const offsetMs = localNow - nowUtcMinute;
    let target = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, 0);
    if (target <= localNow) target += 24 * 60 * 60 * 1000;
    return new Date(target - offsetMs).toISOString();
  } catch {
    return null;
  }
}
