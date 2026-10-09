// One analysis run's use of the GitHub API. loadPullRequests creates one per load and passes
// it down to every gh call, so concurrent runs and the suggestion endpoints, which pass none,
// never mix their numbers. Nothing here is cached.
export interface GitHubRun {
  // gh calls spawned so far, retries included.
  requests: number;
}

export function createGitHubRun(): GitHubRun {
  return { requests: 0 };
}
