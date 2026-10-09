import type { TimeRangePreset } from "../../shared/types";

export type {
  AppSuggestion,
  ReviewerStats,
  AnalysisResult,
  DurationBucket,
  FirstResponseSummary,
  WeeklyFirstResponse,
  AppDefaults,
  DataSource,
  ExcludedBots,
  TimeRangePreset,
} from "../../shared/types";

export interface AnalyzeFormValues {
  repo: string;
  label: string;
  timeRange: TimeRangePreset;
  since: string;
  until: string;
  team: string;
  skipCache: boolean;
  includeBots: boolean;
}
