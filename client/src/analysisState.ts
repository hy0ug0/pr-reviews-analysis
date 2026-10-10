import { describeProgress, type ProgressView } from "../../shared/progress";
import { parseList } from "../../shared/schemas";
import type { AnalysisProgress, AnalysisResult, AnalyzeFormValues } from "./types";

// The analysis on screen, with the form values and team list it was computed with rather
// than the form's current ones. Refresh reruns `values`.
export interface ShownAnalysis {
  result: AnalysisResult;
  values: AnalyzeFormValues;
  team: string[];
  // The byRepo entry the results show; null for all repositories.
  repo: string | null;
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
  // Whether the running analysis has listed or fetched on GitHub, rather than only read the
  // cache. Decides how soon the progress panel shows.
  sawGitHubWork: boolean;
}

export type AnalysisEvent =
  | { kind: "started"; at: number }
  | { kind: "progressed"; progress: AnalysisProgress }
  | { kind: "succeeded"; values: AnalyzeFormValues; result: AnalysisResult }
  | { kind: "failed"; message: string }
  | { kind: "repo-selected"; repo: string | null };

export const initialAnalysisState: AnalysisState = {
  shown: null,
  loading: false,
  error: null,
  progress: null,
  startedAt: null,
  sawGitHubWork: false,
};

// The progress panel shows once a run has done GitHub work for this long. A run that only
// reads the cache usually ends within it, so the panel would flash; such a run gets the
// longer delay, which still gives feedback when a big cache read takes a while.
export const PROGRESS_PANEL_DELAY_MS = 300;
export const CACHE_ONLY_PROGRESS_PANEL_DELAY_MS = 1500;

// When the progress panel should appear, in epoch ms; null when no run is going.
export function progressPanelDueAt(state: AnalysisState): number | null {
  if (!state.loading || state.startedAt === null) return null;
  return (
    state.startedAt +
    (state.sawGitHubWork ? PROGRESS_PANEL_DELAY_MS : CACHE_ONLY_PROGRESS_PANEL_DELAY_MS)
  );
}

function advance(previous: RunProgress | null, progress: AnalysisProgress): RunProgress {
  const view = describeProgress(progress);
  const reached = view.fraction ?? view.floor;
  return {
    view,
    percent: Math.max(previous?.percent ?? 0, Math.round(reached * 100)),
    indeterminate: view.fraction === null,
  };
}

// Whether two runs asked the same question; skipCache only changes where the data comes from.
function isSameQuery(a: AnalyzeFormValues, b: AnalyzeFormValues): boolean {
  return JSON.stringify({ ...a, skipCache: false }) === JSON.stringify({ ...b, skipCache: false });
}

// A new query starts on all repositories. Rerunning the same one, as Refresh does, keeps the
// repo on screen while the new result still has it.
function repoAfterRun(
  shown: ShownAnalysis | null,
  values: AnalyzeFormValues,
  result: AnalysisResult,
): string | null {
  if (shown === null || shown.repo === null || !isSameQuery(shown.values, values)) return null;
  const { repo } = shown;
  return result.byRepo.some((entry) => entry.repo === repo) ? repo : null;
}

// The result as the page shows it: with a repo selected, that repo's metrics over the
// query's coverage and data source. Every metric field comes from the repo's entry, so a
// section that reads the result shows the selected repo without knowing about the switcher.
export function shownResult(shown: ShownAnalysis): AnalysisResult {
  const entry = shown.result.byRepo.find(({ repo }) => repo === shown.repo);
  return entry ? { ...shown.result, ...entry.metrics } : shown.result;
}

// A failed run keeps the previous analysis, values included, so Refresh never reruns a query
// whose result is not the one on screen.
export function analysisReducer(state: AnalysisState, event: AnalysisEvent): AnalysisState {
  switch (event.kind) {
    case "started":
      return {
        ...state,
        loading: true,
        error: null,
        progress: null,
        startedAt: event.at,
        sawGitHubWork: false,
      };
    case "progressed":
      if (!state.loading) return state;
      return {
        ...state,
        progress: advance(state.progress, event.progress),
        sawGitHubWork:
          state.sawGitHubWork ||
          event.progress.phase === "listing" ||
          event.progress.phase === "fetching",
      };
    case "succeeded":
      return {
        shown: {
          result: event.result,
          values: event.values,
          team: parseList(event.values.team),
          repo: repoAfterRun(state.shown, event.values, event.result),
        },
        loading: false,
        error: null,
        progress: null,
        startedAt: null,
        sawGitHubWork: false,
      };
    case "failed":
      return {
        ...state,
        loading: false,
        error: event.message,
        progress: null,
        startedAt: null,
        sawGitHubWork: false,
      };
    case "repo-selected":
      if (state.shown === null) return state;
      return { ...state, shown: { ...state.shown, repo: event.repo } };
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
