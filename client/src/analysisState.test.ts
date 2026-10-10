import { describe, expect, test } from "bun:test";
import {
  analysisReducer,
  CACHE_ONLY_PROGRESS_PANEL_DELAY_MS,
  createAnalysisRunner,
  initialAnalysisState,
  PROGRESS_PANEL_DELAY_MS,
  progressPanelDueAt,
  shownResult,
  type AnalysisEvent,
  type AnalysisState,
  type StreamAnalysis,
} from "./analysisState";
import type { AnalysisMetrics, AnalysisProgress, AnalysisResult, AnalyzeFormValues } from "./types";

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
    repos: [
      {
        repo: "acme/a",
        prsDone,
        prsTotal,
        batchesDone: 0,
        batchesTotal: 1,
        reviewPRsDone: 0,
        reviewPRsTotal: null,
      },
    ],
  };
}

describe("analysisReducer", () => {
  test("a successful run stores its result with the values and team it ran with", () => {
    const values = formValues("acme/a", "alice, bob");

    const state = run(started, { kind: "succeeded", values, result: resultA });

    expect(state).toEqual({
      shown: { result: resultA, values, team: ["alice", "bob"], repo: null },
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
        repos: [
          { repo: "acme/a", listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1 },
        ],
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

function metrics(countedPRs: number, totalReviews: number): AnalysisMetrics {
  return {
    countedPRs,
    excludedBots: null,
    totalReviews,
    uniqueReviewers: 1,
    avgReviewsPerPR: countedPRs > 0 ? totalReviews / countedPRs : 0,
    reviewerStats: [],
    firstResponse: {
      respondedPRs: 0,
      waitingPRs: 0,
      closedWithoutResponsePRs: countedPRs,
      draftPRs: 0,
      undeterminedPRs: 0,
      p50Ms: null,
      p75Ms: null,
      p90Ms: null,
      histogram: [],
      weekly: [],
    },
    reviewCycle: {
      timeToMerge: {
        mergedPRs: countedPRs,
        openPRs: 0,
        closedUnmergedPRs: 0,
        p50Ms: null,
        p90Ms: null,
        histogram: [],
      },
      timeToApproval: {
        approvedPRs: 0,
        approvedAtFirstReviewPRs: 0,
        notApprovedPRs: 0,
        unreviewedPRs: countedPRs,
        draftPRs: 0,
        undeterminedPRs: 0,
        p50Ms: null,
        p90Ms: null,
        histogram: [],
      },
      reviewRounds: {
        reviewedMergedPRs: 0,
        mergedWithoutReviewPRs: countedPRs,
        undeterminedPRs: 0,
        p50: null,
        p90: null,
        distribution: [],
      },
    },
    timeRange: { since: "2026-09-01", until: "2026-09-30" },
  };
}

describe("repo selection", () => {
  const twoRepos: AnalysisResult = {
    ...metrics(3, 6),
    matchingPRs: 4,
    analyzedPRs: 3,
    isComplete: false,
    partialReasons: ["acme/b#7 could not be fetched."],
    byRepo: [
      { repo: "acme/a", metrics: metrics(2, 5) },
      { repo: "acme/b", metrics: metrics(1, 1) },
    ],
  };
  const values = formValues("acme/a,acme/b");
  const shownB = run(
    started,
    { kind: "succeeded", values, result: twoRepos },
    { kind: "repo-selected", repo: "acme/b" },
  );

  test("a result starts on all repositories, which shows the result as it came", () => {
    const state = run(started, { kind: "succeeded", values, result: twoRepos });

    expect(state.shown?.repo).toBeNull();
    expect(state.shown && shownResult(state.shown)).toBe(twoRepos);
  });

  test("a selected repo shows its own metrics over the query's coverage", () => {
    const shown = shownResult(shownB.shown!);

    expect(shown).toMatchObject({ countedPRs: 1, totalReviews: 1, avgReviewsPerPR: 1 });
    expect(shown).toMatchObject({ matchingPRs: 4, analyzedPRs: 3, isComplete: false });
    expect(shown.byRepo).toBe(twoRepos.byRepo);
  });

  test("selecting all repositories again shows the whole result", () => {
    const state = analysisReducer(shownB, { kind: "repo-selected", repo: null });

    expect(state.shown && shownResult(state.shown)).toBe(twoRepos);
  });

  test("a new query starts over on all repositories", () => {
    const state = analysisReducer(analysisReducer(shownB, started), {
      kind: "succeeded",
      values: { ...values, timeRange: "quarter" },
      result: twoRepos,
    });

    expect(state.shown?.repo).toBeNull();
  });

  test("rerunning the same query, as Refresh does, keeps the selected repo", () => {
    const state = analysisReducer(analysisReducer(shownB, started), {
      kind: "succeeded",
      values: { ...values, skipCache: true },
      result: twoRepos,
    });

    expect(state.shown?.repo).toBe("acme/b");
  });

  test("a failed run keeps the selected repo with the analysis it belongs to", () => {
    const state = analysisReducer(analysisReducer(shownB, started), {
      kind: "failed",
      message: "rate limited",
    });

    expect(state.shown?.repo).toBe("acme/b");
  });

  test("ignores a selection when no analysis is shown", () => {
    expect(analysisReducer(initialAnalysisState, { kind: "repo-selected", repo: "acme/a" })).toBe(
      initialAnalysisState,
    );
  });
});

describe("progressPanelDueAt", () => {
  const listingOnGitHub: AnalysisProgress = {
    phase: "listing",
    repos: [
      { repo: "acme/a", listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1 },
    ],
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
