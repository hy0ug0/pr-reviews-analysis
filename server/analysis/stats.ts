import type { DurationBucket, WeeklyFirstResponse } from "../../shared/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const HISTOGRAM_BUCKETS: ReadonlyArray<Omit<DurationBucket, "count">> = [
  { label: "< 1h", minMs: 0, maxMs: HOUR_MS },
  { label: "1–4h", minMs: HOUR_MS, maxMs: 4 * HOUR_MS },
  { label: "4–24h", minMs: 4 * HOUR_MS, maxMs: DAY_MS },
  { label: "1–2d", minMs: DAY_MS, maxMs: 2 * DAY_MS },
  { label: "2–7d", minMs: 2 * DAY_MS, maxMs: WEEK_MS },
  { label: "> 7d", minMs: WEEK_MS, maxMs: null },
];

// Linear interpolation between closest ranks (Hyndman and Fan type 7, the default in
// NumPy, R and Excel's PERCENTILE.INC): with the n values sorted ascending and
// h = (n - 1) * p, the result is x[floor(h)] + (h - floor(h)) * (x[ceil(h)] - x[floor(h)]).
// p50 is the usual median, and p is a fraction from 0 to 1.
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}

export function roundedPercentile(sorted: readonly number[], p: number): number | null {
  const value = percentile(sorted, p);
  return value === null ? null : Math.round(value);
}

// Monday 00:00 UTC of the week containing `time`.
export function weekStart(time: number): number {
  const date = new Date(time);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

function formatDateOnly(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function buildHistogram(durations: readonly number[]): DurationBucket[] {
  return HISTOGRAM_BUCKETS.map((bucket) => ({
    ...bucket,
    count: durations.filter(
      (duration) => duration >= bucket.minMs && (bucket.maxMs === null || duration < bucket.maxMs),
    ).length,
  }));
}

// One entry per week from the earliest to the latest week among the responses and the
// selected range, so weeks without responses show up as gaps instead of disappearing.
export function buildWeekly({
  responses,
  since,
  until,
}: {
  responses: ReadonlyArray<{ startedAt: number; durationMs: number }>;
  since?: string;
  until?: string;
}): WeeklyFirstResponse[] {
  if (responses.length === 0) return [];

  const durationsByWeek = new Map<number, number[]>();
  for (const { startedAt, durationMs } of responses) {
    const week = weekStart(startedAt);
    const durations = durationsByWeek.get(week) ?? [];
    durations.push(durationMs);
    durationsByWeek.set(week, durations);
  }

  const bounds = [...durationsByWeek.keys()];
  if (since) bounds.push(weekStart(Date.parse(`${since}T00:00:00Z`)));
  if (until) bounds.push(weekStart(Date.parse(`${until}T00:00:00Z`)));
  const first = Math.min(...bounds);
  const last = Math.max(...bounds);

  const weekly: WeeklyFirstResponse[] = [];
  for (let week = first; week <= last; week += WEEK_MS) {
    const durations = (durationsByWeek.get(week) ?? []).sort((a, b) => a - b);
    weekly.push({
      weekStart: formatDateOnly(week),
      p50Ms: roundedPercentile(durations, 0.5),
      count: durations.length,
    });
  }
  return weekly;
}
