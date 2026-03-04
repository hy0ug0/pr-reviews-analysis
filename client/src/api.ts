import { analysisResultSchema } from "../../shared/schemas";
import type { AnalysisResult, AnalyzeFormValues, AppDefaults, TimeRangePreset } from "./types";

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
  if (!response.ok) throw new Error("Failed to load defaults");
  const data: unknown = await response.json();
  if (!isAppDefaults(data)) throw new Error("Invalid defaults payload");
  return data;
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

  const response = await fetch(`/api/analyze?${params}`);
  const data: unknown = await response.json();
  if (!response.ok) {
    const msg =
      isObjectRecord(data) && typeof data.error === "string" ? data.error : "Failed to analyze";
    throw new Error(msg);
  }
  const parsed = analysisResultSchema.safeParse(data);
  if (!parsed.success) throw new Error("Unexpected response format from server");
  return parsed.data;
}
