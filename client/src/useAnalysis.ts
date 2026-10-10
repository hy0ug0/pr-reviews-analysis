import { useEffect, useReducer, useState } from "react";
import { streamAnalysis } from "./api";
import {
  analysisReducer,
  createAnalysisRunner,
  initialAnalysisState,
  progressPanelDueAt,
} from "./analysisState";
import type { AnalyzeFormValues } from "./types";

// Runs analyses and holds what the page shows: the current result and the values behind it,
// the running analysis's progress, and the last error. Leaving the page closes the stream.
export function useAnalysis() {
  const [state, dispatch] = useReducer(analysisReducer, initialAnalysisState);
  // dispatch is stable, so one runner serves the component's whole life.
  const [runner] = useState(() => createAnalysisRunner({ stream: streamAnalysis, dispatch }));

  useEffect(() => () => runner.dispose(), [runner]);

  const analyze = (values: AnalyzeFormValues) => runner.run(values);

  // Reruns the shown analysis without the cache. The form, and its "Refresh from GitHub"
  // checkbox, stay as they are.
  const refresh = () => {
    if (state.shown) void runner.run({ ...state.shown.values, skipCache: true });
  };

  // Null shows all repositories.
  const selectRepo = (repo: string | null) => dispatch({ kind: "repo-selected", repo });

  return {
    ...state,
    progressPanelDueAt: progressPanelDueAt(state),
    analyze,
    refresh,
    selectRepo,
  };
}
