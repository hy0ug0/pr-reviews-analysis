const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// One format for every duration on the page: minutes under an hour, hours and minutes
// under a day, then days with one decimal ("2.4d") up to ten days.
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = ms / DAY_MS;
  if (days >= 10) return `${Math.round(days)}d`;
  return `${Number(days.toFixed(1))}d`;
}

// "2026-09-07" -> "Sep 7"; the date is a UTC calendar day.
export function formatShortDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatLongDate(dateOnly: string): string {
  return new Date(`${dateOnly}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// "just now", "5 min ago", "2 h ago", "3 d ago": how long ago something was cached or listed.
export function formatTimeAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / MINUTE_MS);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// "0.4 s", "14 s", "2 min 5 s": how long a GitHub fetch took. Tenths only under ten
// seconds, where they still mean something.
export function formatFetchTime(ms: number): string {
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return rest === 0 ? `${seconds / 60} min` : `${Math.floor(seconds / 60)} min ${rest} s`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
