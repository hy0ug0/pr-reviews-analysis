import { analysisResultSchema } from "../../shared/schemas";
import type {
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

export async function fetchAnalysis(values: AnalyzeFormValues): Promise<AnalysisResult> {
  const params = new URLSearchParams();
  params.set("repo", values.repo);
  if (values.label) params.set("label", values.label);
  if (values.team) params.set("team", values.team);
  if (values.skipCache) params.set("skipCache", "1");

  if (values.timeRange === "custom") {
    if (values.since) params.set("since", values.since);
    if (values.until) params.set("until", values.until);
  } else if (values.timeRange !== "all") {
    const range = getDateRange(values.timeRange);
    params.set("since", range.since);
    params.set("until", range.until);
  }

  let response: Response;
  try {
    response = await fetch(`/api/analyze?${params}`);
  } catch {
    throw new Error(
      "The analysis request was interrupted before the server returned a response. Large GitHub fetches can take several minutes; try again or narrow the date range.",
    );
  }

  const data = await readJsonResponse(response, "Failed to analyze");
  const parsed = analysisResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Unexpected response format from server");
  return parsed.data;
}
