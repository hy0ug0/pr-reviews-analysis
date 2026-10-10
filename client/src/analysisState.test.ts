import { describe, expect, test } from "bun:test";
import {
  analysisReducer,
  CACHE_ONLY_PROGRESS_PANEL_DELAY_MS,
  createAnalysisRunner,
  initialAnalysisState,
  PROGRESS_PANEL_DELAY_MS,
  progressPanelDueAt,
  type AnalysisEvent,
  type AnalysisState,
  type StreamAnalysis,
} from "./analysisState";
import type { AnalysisProgress, AnalysisResult, AnalyzeFormValues } from "./types";

function formValues(repo: string, team = ""): AnalyzeFormValues {
  return {
    repo,
    label: "",
    timeRange: "month",
    since: "",
    until: "",
    team,
    includeBots: false,
    skipCache: false,
  };
}

// The reducer stores results without reading them, so any object stands in.
const resultA = { matchingPRs: 1 } as unknown as AnalysisResult;
const resultB = { matchingPRs: 2 } as unknown as AnalysisResult;
const started: AnalysisEvent = { kind: "started", at: 1000 };

function run(...events: AnalysisEvent[]) {
  return events.reduce(analysisReducer, initialAnalysisState);
}

function fetching(
  prsDone: number,
  prsTotal: number,
): Extract<AnalysisProgress, { phase: "fetching" }> {
  return {
    phase: "fetching",
    repo: "acme/a",
    repoIndex: 0,
    repoCount: 1,
    prsDone,
    prsTotal,
    repoPRsDone: prsDone,
    repoPRsTotal: prsTotal,
    batchesDone: 0,
    batchesTotal: 1,
    reviewPRsDone: 0,
    reviewPRsTotal: null,
  };
}

describe("analysisReducer", () => {
  test("a successful run stores its result with the values and team it ran with", () => {
    const values = formValues("acme/a", "alice, bob");

    const state = run(started, { kind: "succeeded", values, result: resultA });

    expect(state).toEqual({
      shown: { result: resultA, values, team: ["alice", "bob"] },
      loading: false,
      error: null,
      progress: null,
      startedAt: null,
      sawGitHubWork: false,
    });
  });

  test("a failed run keeps the shown analysis and its values, so Refresh reruns A", () => {
    const valuesA = formValues("acme/a");

    const state = run(started, { kind: "succeeded", values: valuesA, result: resultA }, started, {
      kind: "failed",
      message: "acme/b not found",
    });

    expect(state.shown?.values).toBe(valuesA);
    expect(state.shown?.result).toBe(resultA);
    expect(state.error).toBe("acme/b not found");
    expect(state.loading).toBe(false);
  });

  test("starting a run clears the error and the previous run's progress", () => {
    const state = run(
      started,
      { kind: "progressed", progress: fetching(5, 10) },
      { kind: "failed", message: "boom" },
      { kind: "started", at: 2000 },
    );

    expect(state).toMatchObject({ loading: true, error: null, progress: null, startedAt: 2000 });
  });

  test("progress is indeterminate until a total is known, then determinate", () => {
    const listingStarted = run(started, {
      kind: "progressed",
      progress: {
        phase: "listing",
        repo: "acme/a",
        repoIndex: 0,
        repoCount: 1,
        listed: 0,
        matching: null,
        page: 0,
        windowsDone: 0,
        windowsTotal: 1,
      },
    });
    const halfFetched = analysisReducer(listingStarted, {
      kind: "progressed",
      progress: fetching(5, 10),
    });

    expect(listingStarted.progress).toMatchObject({ indeterminate: true, percent: 0 });
    expect(halfFetched.progress).toMatchObject({ indeterminate: false });
    expect(halfFetched.progress?.view.label).toBe("Fetching PR details");
  });

  test("the bar never goes back within a run", () => {
    const ahead = run(started, { kind: "progressed", progress: fetching(8, 10) });
    // A snapshot that maps lower on the bar than the one before it.
    const behind = analysisReducer(ahead, {
      kind: "progressed",
      progress: { phase: "pr-cache", prs: 10 },
    });

    expect(behind.progress?.percent).toBe(ahead.progress?.percent ?? -1);
    expect(behind.progress?.view.label).toBe("Checking the cache");
  });

  test("a rate-limit wait reaches the view and leaves the bar where it was", () => {
    const before = run(started, { kind: "progressed", progress: fetching(5, 10) });
    const until = "2026-10-10T12:00:30.000Z";
    const waiting = analysisReducer(before, {
      kind: "progressed",
      progress: { ...fetching(5, 10), rateLimitedUntil: until },
    });
    const resumed = analysisReducer(waiting, { kind: "progressed", progress: fetching(5, 10) });

    expect(waiting.progress?.view.rateLimitedUntil).toBe(Date.parse(until));
    expect(waiting.progress?.percent).toBe(before.progress?.percent ?? -1);
    expect(resumed.progress?.view.rateLimitedUntil).toBeNull();
  });

  test("ignores progress when no run is going", () => {
    const idle: AnalysisState = initialAnalysisState;

    expect(analysisReducer(idle, { kind: "progressed", progress: fetching(1, 2) })).toBe(idle);
  });
});

describe("progressPanelDueAt", () => {
  const listingOnGitHub: AnalysisProgress = {
    phase: "listing",
    repo: "acme/a",
    repoIndex: 0,
    repoCount: 1,
    listed: 0,
    matching: null,
    page: 0,
    windowsDone: 0,
    windowsTotal: 1,
  };

  test("a full cache hit that ends at 310 ms never reaches the panel", () => {
    // Started at 1000; only cache steps reported before the result.
    const cacheOnly = run(
      started,
      { kind: "progressed", progress: { phase: "listing-cache" } },
      { kind: "progressed", progress: { phase: "pr-cache", prs: 592 } },
    );
    const dueAt = progressPanelDueAt(cacheOnly) ?? 0;

    expect(dueAt > 1310).toBe(true);
    expect(dueAt).toBe(1000 + CACHE_ONLY_PROGRESS_PANEL_DELAY_MS);
    expect(
      progressPanelDueAt(
        analysisReducer(cacheOnly, {
          kind: "succeeded",
          values: formValues("acme/a"),
          result: resultA,
        }),
      ),
    ).toBeNull();
  });

  test("GitHub work brings the panel in after the short delay", () => {
    const listing = run(started, { kind: "progressed", progress: listingOnGitHub });

    expect(progressPanelDueAt(listing)).toBe(1000 + PROGRESS_PANEL_DELAY_MS);
  });

  test("once GitHub work is seen, later cache steps keep the short delay", () => {
    const state = run(
      started,
      { kind: "progressed", progress: listingOnGitHub },
      { kind: "progressed", progress: { phase: "pr-cache", prs: 3 } },
    );

    expect(state.sawGitHubWork).toBe(true);
  });

  test("a new run starts over from the long delay", () => {
    const state = run(
      started,
      { kind: "progressed", progress: listingOnGitHub },
      { kind: "started", at: 5000 },
    );

    expect(progressPanelDueAt(state)).toBe(5000 + CACHE_ONLY_PROGRESS_PANEL_DELAY_MS);
  });
});

// A fake stream the test settles by hand.
function controllableStream() {
  const calls: Array<{
    values: AnalyzeFormValues;
    signal: AbortSignal;
    onProgress: (progress: AnalysisProgress) => void;
    resolve: (result: AnalysisResult) => void;
    reject: (error: Error) => void;
  }> = [];
  const stream: StreamAnalysis = (values, { signal, onProgress }) =>
    new Promise((resolve, reject) => {
      calls.push({ values, signal, onProgress, resolve, reject });
    });
  return { stream, calls };
}

describe("createAnalysisRunner", () => {
  test("a new run aborts the previous stream and ignores whatever it sends after", async () => {
    const { stream, calls } = controllableStream();
    let state = initialAnalysisState;
    const runner = createAnalysisRunner({
      stream,
      dispatch: (event) => {
        state = analysisReducer(state, event);
      },
    });

    const first = runner.run(formValues("acme/a"));
    const second = runner.run(formValues("acme/b"));
    calls[0].onProgress(fetching(9, 10));
    calls[0].resolve(resultA);
    calls[1].onProgress(fetching(1, 10));
    calls[1].resolve(resultB);
    await Promise.all([first, second]);

    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);
    expect(state.shown?.result).toBe(resultB);
    expect(state.shown?.values.repo).toBe("acme/b");
  });

  test("an aborted run's failure is not reported", async () => {
    const { stream, calls } = controllableStream();
    const events: AnalysisEvent[] = [];
    const runner = createAnalysisRunner({ stream, dispatch: (event) => events.push(event) });

    const first = runner.run(formValues("acme/a"));
    runner.dispose();
    calls[0].reject(new Error("The operation was aborted."));
    await first;

    expect(events.map((event) => event.kind)).toEqual(["started"]);
  });

  test("passes progress through, then the result", async () => {
    const { stream, calls } = controllableStream();
    const events: AnalysisEvent[] = [];
    const runner = createAnalysisRunner({ stream, dispatch: (event) => events.push(event) });

    const running = runner.run(formValues("acme/a"));
    calls[0].onProgress(fetching(1, 2));
    calls[0].resolve(resultA);
    await running;

    expect(events.map((event) => event.kind)).toEqual(["started", "progressed", "succeeded"]);
  });
});
