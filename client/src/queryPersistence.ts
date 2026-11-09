import { timeRangePresets } from "../../shared/schemas";
import type { AnalyzeFormValues, TimeRangePreset } from "./types";

// The analyze form's query lives in the URL, so a link shares it, and in localStorage, so the
// next visit starts from it. Both hold the same query string, read by one parser. The
// "Refresh from GitHub" choice stays out: a shared link or a remembered query must not force
// a refetch.

const STORAGE_KEY = "pr-reviews-analysis:last-query";
const PARAMS = ["repo", "label", "range", "since", "until", "team", "includeBots"];

const timeRangeSet: ReadonlySet<string> = new Set(timeRangePresets);

export function isTimeRangePreset(value: string): value is TimeRangePreset {
  return timeRangeSet.has(value);
}

export function serializeQuery(values: AnalyzeFormValues): string {
  const params = new URLSearchParams();
  const custom = values.timeRange === "custom";
  const entries: [string, string][] = [
    ["repo", values.repo],
    ["label", values.label],
    ["range", values.timeRange],
    ["since", custom ? values.since : ""],
    ["until", custom ? values.until : ""],
    ["team", values.team],
    ["includeBots", values.includeBots ? "1" : ""],
  ];
  for (const [key, value] of entries) if (value) params.set(key, value);
  return params.toString();
}

// The query string comes from a link or from storage, so anything in it may be off. Unknown
// ranges fall back to the form's default; the form's schema still validates on submit. Null
// means the string carries no query at all.
export function parseQuery(search: string): AnalyzeFormValues | null {
  const params = new URLSearchParams(search);
  if (!PARAMS.some((key) => params.has(key))) return null;
  const range = params.get("range") ?? "";
  const timeRange = isTimeRangePreset(range) ? range : "month";
  // Dates belong to a custom range only, as when written, so a preset never carries stale
  // ones into the form.
  const custom = timeRange === "custom";
  return {
    repo: params.get("repo") ?? "",
    label: params.get("label") ?? "",
    timeRange,
    since: custom ? (params.get("since") ?? "") : "",
    until: custom ? (params.get("until") ?? "") : "",
    team: params.get("team") ?? "",
    skipCache: false,
    includeBots: params.get("includeBots") === "1",
  };
}

// Storage can be missing or throw (private windows, blocked site data); either way nothing
// is remembered.
export function rememberedQuery(): AnalyzeFormValues | null {
  try {
    return parseQuery(localStorage.getItem(STORAGE_KEY) ?? "");
  } catch {
    return null;
  }
}

// Puts the query in the URL without adding a history entry, and remembers it.
export function saveQuery(values: AnalyzeFormValues): void {
  const query = serializeQuery(values);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  try {
    localStorage.setItem(STORAGE_KEY, query);
  } catch {
    // Not remembered; the URL still carries the query.
  }
}
