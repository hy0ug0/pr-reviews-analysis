import type { AnalysisProgress } from "../shared/types.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("pull-requests");

export type ProgressListener = (progress: AnalysisProgress) => void;

// A load that every identical request in flight shares: its result, its latest progress, and
// the requests listening for more. A listener that leaves (its request was aborted) stops
// getting progress, but the load goes on: other requests and the cache still need it.
export interface LoadRun<T> {
  promise: Promise<T>;
  progress(): AnalysisProgress;
  // Sends the latest snapshot right away, so a request that joins late is not left blank,
  // then each new one until the load settles or `signal` aborts.
  subscribe(listener: ProgressListener, signal?: AbortSignal): void;
}

// Starts `load` with a `publish` function for its progress.
export function startLoadRun<T>(
  initial: AnalysisProgress,
  load: (publish: ProgressListener) => Promise<T>,
): LoadRun<T> {
  let latest = initial;
  const listeners = new Set<ProgressListener>();

  function notify(listener: ProgressListener, progress: AnalysisProgress) {
    // One broken listener must not fail the load or starve the others.
    try {
      listener(progress);
    } catch (error: unknown) {
      log.warn(
        `Progress listener failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const publish: ProgressListener = (progress) => {
    latest = progress;
    for (const listener of listeners) notify(listener, progress);
  };

  const promise = load(publish).finally(() => listeners.clear());

  return {
    promise,
    progress: () => latest,
    subscribe(listener, signal) {
      if (signal?.aborted) return;
      listeners.add(listener);
      signal?.addEventListener("abort", () => listeners.delete(listener), { once: true });
      notify(listener, latest);
    },
  };
}
