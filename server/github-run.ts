import type { AnalysisProgress } from "../shared/types.ts";

// One analysis run's use of the GitHub API. loadPullRequests creates one per load and passes
// it down to every GitHub request, so concurrent runs and the suggestion endpoints, which
// pass none, never mix their numbers. Nothing here is cached.
export interface GitHubRun {
  // HTTP requests sent so far, retries included. Reading the token from gh is not one.
  requests: number;
  // Receives a snapshot each time the listing or the detail fetch moves forward.
  report: (progress: AnalysisProgress) => void;
  // Called by a request that starts waiting for the rate limit until `untilMs` (epoch ms).
  // The returned function ends that wait; calling it again does nothing.
  rateLimited: (untilMs: number) => () => void;
}

// The snapshot as the client sees it: listing and fetching carry the end of the rate-limit
// wait under way, if any. Other phases send no GitHub requests, so they never wait.
function withWait(progress: AnalysisProgress, untilMs: number | null): AnalysisProgress {
  if (progress.phase !== "listing" && progress.phase !== "fetching") return progress;
  if (untilMs === null) return progress;
  return { ...progress, rateLimitedUntil: new Date(untilMs).toISOString() };
}

// The transport knows the run but not the phase, so the run republishes its last snapshot
// when a wait starts or ends. Several requests can wait at once: the snapshot shows the
// latest end among them, and the wait clears once none is left.
export function createGitHubRun(publish: GitHubRun["report"] = () => {}): GitHubRun {
  // Last snapshot as reported, without the wait.
  let last: AnalysisProgress | null = null;
  // One entry per waiting request, so two waits ending at the same time stay distinct.
  const waits = new Set<{ untilMs: number }>();

  function waitingUntil(): number | null {
    let latest: number | null = null;
    for (const { untilMs } of waits) latest = Math.max(latest ?? untilMs, untilMs);
    return latest;
  }

  // Republishes the last snapshot when the wait it should show has changed.
  function changeWaits(change: () => void) {
    const before = waitingUntil();
    change();
    const after = waitingUntil();
    if (after === before || last === null) return;
    if (last.phase !== "listing" && last.phase !== "fetching") return;
    publish(withWait(last, after));
  }

  return {
    requests: 0,
    report(progress) {
      last = progress;
      publish(withWait(progress, waitingUntil()));
    },
    rateLimited(untilMs) {
      const wait = { untilMs };
      changeWaits(() => waits.add(wait));
      return () => changeWaits(() => waits.delete(wait));
    },
  };
}
