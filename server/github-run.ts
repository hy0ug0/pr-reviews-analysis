import type { AnalysisProgress } from "../shared/types.ts";

// One analysis run's use of the GitHub API. loadPullRequests creates one per load and passes
// it down to every GitHub request, so concurrent runs and the suggestion endpoints, which
// pass none, never mix their numbers. Nothing here is cached.
export interface GitHubRun {
  // HTTP requests sent so far, retries included. Reading the token from gh is not one.
  requests: number;
  // Receives a snapshot each time the listing or the detail fetch moves forward.
  report: (progress: AnalysisProgress) => void;
}

export function createGitHubRun(report: GitHubRun["report"] = () => {}): GitHubRun {
  return { requests: 0, report };
}
