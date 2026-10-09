import { parseList } from "../../shared/schemas";
import type { AnalysisResult, AnalyzeFormValues } from "./types";

// The analysis on screen, with the form values and team list it was computed with rather
// than the form's current ones. Refresh reruns `values`.
export interface ShownAnalysis {
  result: AnalysisResult;
  values: AnalyzeFormValues;
  team: string[];
}

export interface AnalysisState {
  shown: ShownAnalysis | null;
  loading: boolean;
  error: string | null;
}

export type AnalysisEvent =
  | { kind: "started" }
  | { kind: "succeeded"; values: AnalyzeFormValues; result: AnalysisResult }
  | { kind: "failed"; message: string };

export const initialAnalysisState: AnalysisState = { shown: null, loading: false, error: null };

// A failed run keeps the previous analysis, values included, so Refresh never reruns a query
// whose result is not the one on screen.
export function analysisReducer(state: AnalysisState, event: AnalysisEvent): AnalysisState {
  switch (event.kind) {
    case "started":
      return { ...state, loading: true, error: null };
    case "succeeded":
      return {
        shown: { result: event.result, values: event.values, team: parseList(event.values.team) },
        loading: false,
        error: null,
      };
    case "failed":
      return { ...state, loading: false, error: event.message };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
