import { describeProgress, type ProgressView } from "../../shared/progress";
import { parseList } from "../../shared/schemas";
import type { AnalysisProgress, AnalysisResult, AnalyzeFormValues } from "./types";

// The analysis on screen, with the form values and team list it was computed with rather
// than the form's current ones. Refresh reruns `values`.
export interface ShownAnalysis {
  result: AnalysisResult;
  values: AnalyzeFormValues;
  team: string[];
}

// The running analysis's latest progress. `percent` only grows within a run, so the bar
// never moves back when a step's total turns out larger than first known.
export interface RunProgress {
  view: ProgressView;
  percent: number;
  indeterminate: boolean;
}

export interface AnalysisState {
  shown: ShownAnalysis | null;
  loading: boolean;
  error: string | null;
  // Null until the server sends a first snapshot, and when no run is going.
  progress: RunProgress | null;
  // When the running analysis started, in epoch ms; null when none is running.
  startedAt: number | null;
}

export type AnalysisEvent =
  | { kind: "started"; at: number }
  | { kind: "progressed"; progress: AnalysisProgress }
  | { kind: "succeeded"; values: AnalyzeFormValues; result: AnalysisResult }
  | { kind: "failed"; message: string };

export const initialAnalysisState: AnalysisState = {
  shown: null,
  loading: false,
  error: null,
  progress: null,
  startedAt: null,
};

function advance(previous: RunProgress | null, progress: AnalysisProgress): RunProgress {
  const view = describeProgress(progress);
  const reached = view.fraction ?? view.floor;
  return {
    view,
    percent: Math.max(previous?.percent ?? 0, Math.round(reached * 100)),
    indeterminate: view.fraction === null,
  };
}

// A failed run keeps the previous analysis, values included, so Refresh never reruns a query
// whose result is not the one on screen.
export function analysisReducer(state: AnalysisState, event: AnalysisEvent): AnalysisState {
  switch (event.kind) {
    case "started":
      return { ...state, loading: true, error: null, progress: null, startedAt: event.at };
    case "progressed":
      if (!state.loading) return state;
      return { ...state, progress: advance(state.progress, event.progress) };
    case "succeeded":
      return {
        shown: { result: event.result, values: event.values, team: parseList(event.values.team) },
        loading: false,
        error: null,
        progress: null,
        startedAt: null,
      };
    case "failed":
      return { ...state, loading: false, error: event.message, progress: null, startedAt: null };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export type StreamAnalysis = (
  values: AnalyzeFormValues,
  options: { signal: AbortSignal; onProgress: (progress: AnalysisProgress) => void },
) => Promise<AnalysisResult>;

// Starts analyses one at a time: a new run aborts the previous one's stream (client side
// only; the server keeps any shared load), and nothing from an aborted run reaches the state.
export function createAnalysisRunner({
  stream,
  dispatch,
}: {
  stream: StreamAnalysis;
  dispatch: (event: AnalysisEvent) => void;
}) {
  let current: AbortController | null = null;

  return {
    async run(values: AnalyzeFormValues): Promise<void> {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const { signal } = controller;
      dispatch({ kind: "started", at: Date.now() });
      try {
        const result = await stream(values, {
          signal,
          onProgress: (progress) => {
            if (!signal.aborted) dispatch({ kind: "progressed", progress });
          },
        });
        if (!signal.aborted) dispatch({ kind: "succeeded", values, result });
      } catch (error: unknown) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : "An error occurred";
        dispatch({ kind: "failed", message });
      } finally {
        if (current === controller) current = null;
      }
    },
    dispose() {
      current?.abort();
      current = null;
    },
  };
}
