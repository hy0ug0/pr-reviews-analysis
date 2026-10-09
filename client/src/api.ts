import { readAnalysisStream } from "./analysisStream";
import type {
  AnalysisProgress,
  AnalysisResult,
  AnalyzeFormValues,
  AppDefaults,
  AppSuggestion,
  TimeRangePreset,
} from "./types";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAppDefaults(value: unknown): value is AppDefaults {
  return (
    isObjectRecord(value) &&
    typeof value.repos === "string" &&
    typeof value.label === "string" &&
    typeof value.team === "string"
  );
}

function isAppSuggestion(value: unknown): value is AppSuggestion {
  return (
    isObjectRecord(value) &&
    typeof value.value === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.isPrivate === undefined || typeof value.isPrivate === "boolean")
  );
}

function isSuggestionsPayload(value: unknown): value is { suggestions: AppSuggestion[] } {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.suggestions) &&
    value.suggestions.every(isAppSuggestion)
  );
}

async function readJsonResponse(response: Response, fallbackMessage: string): Promise<unknown> {
  const body = await response.text();
  let data: unknown = null;

  if (body.trim()) {
    try {
      data = JSON.parse(body);
    } catch {
      if (!response.ok) {
        throw new Error(body.trim() || fallbackMessage);
      }
      throw new Error("Unexpected non-JSON response from server");
    }
  }

  if (!response.ok) {
    const message =
      isObjectRecord(data) && typeof data.error === "string" ? data.error : fallbackMessage;
    throw new Error(message);
  }

  return data;
}

function getDateRange(preset: TimeRangePreset): { since: string; until: string } {
  const now = new Date();
  const until = now.toISOString().split("T")[0];
  let since = "";

  switch (preset) {
    case "week": {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      since = d.toISOString().split("T")[0];
      break;
    }
    case "month": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      since = d.toISOString().split("T")[0];
      break;
    }
    case "quarter": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      since = d.toISOString().split("T")[0];
      break;
    }
    case "year": {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      since = d.toISOString().split("T")[0];
      break;
    }
  }

  return { since, until };
}

export async function fetchDefaults(): Promise<AppDefaults> {
  const response = await fetch("/api/defaults");
  const data = await readJsonResponse(response, "Failed to load defaults");
  if (!isAppDefaults(data)) throw new Error("Invalid defaults payload");
  return data;
}

export async function fetchSuggestions(
  kind: "repos" | "labels" | "users",
  values: { query: string; repo?: string },
  signal?: AbortSignal,
): Promise<AppSuggestion[]> {
  const params = new URLSearchParams();
  if (values.query) params.set("q", values.query);
  if (values.repo) params.set("repo", values.repo);

  const response = await fetch(`/api/suggestions/${kind}?${params}`, { signal });
  const data = await readJsonResponse(response, "Failed to load suggestions");
  if (!isSuggestionsPayload(data)) throw new Error("Invalid suggestions payload");
  return data.suggestions;
}

// The query string for /api/analyze, with the preset ranges resolved to dates.
function analyzeParams(values: AnalyzeFormValues): URLSearchParams {
  const params = new URLSearchParams();
  params.set("repo", values.repo);
  if (values.label) params.set("label", values.label);
  if (values.team) params.set("team", values.team);
  if (values.skipCache) params.set("skipCache", "1");
  if (values.includeBots) params.set("includeBots", "1");

  if (values.timeRange === "custom") {
    if (values.since) params.set("since", values.since);
    if (values.until) params.set("until", values.until);
  } else if (values.timeRange !== "all") {
    const range = getDateRange(values.timeRange);
    params.set("since", range.since);
    params.set("until", range.until);
  }
  return params;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Runs an analysis as a server-sent event stream, so a long GitHub fetch reports its
// progress instead of leaving a request open in silence. Aborting `signal` closes this
// stream only; the server keeps any load other requests share. A rejected query comes back
// as a JSON 400 before any stream starts.
export async function streamAnalysis(
  values: AnalyzeFormValues,
  { signal, onProgress }: { signal: AbortSignal; onProgress: (progress: AnalysisProgress) => void },
): Promise<AnalysisResult> {
  try {
    const response = await fetch(`/api/analyze?${analyzeParams(values)}`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    const isStream = response.headers.get("content-type")?.startsWith("text/event-stream");
    if (!response.ok || !isStream || !response.body) {
      await readJsonResponse(response, "Failed to analyze");
      throw new Error("Unexpected response format from server");
    }
    return await readAnalysisStream(response.body, onProgress);
  } catch (error: unknown) {
    if (isAbortError(error) || !(error instanceof TypeError)) throw error;
    // fetch and stream reads throw TypeError when the network drops.
    throw new Error(
      "Lost the connection to the server during the analysis. Check that the server is running, then try again.",
      { cause: error },
    );
  }
}
