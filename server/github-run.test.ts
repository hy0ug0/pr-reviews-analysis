import { describe, expect, test } from "bun:test";
import type { AnalysisProgress } from "../shared/types.ts";
import { createGitHubRun } from "./github-run.ts";

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

const listing = {
  phase: "listing",
  repos: [
    { repo: "honojs/hono", listed: 100, matching: 300, page: 1, windowsDone: 0, windowsTotal: 1 },
    { repo: "oven-sh/bun", listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1 },
  ],
} satisfies AnalysisProgress;

const fetching = {
  phase: "fetching",
  repos: [
    {
      repo: "honojs/hono",
      prsDone: 25,
      prsTotal: 300,
      batchesDone: 1,
      batchesTotal: 12,
      reviewPRsDone: 0,
      reviewPRsTotal: null,
    },
  ],
} satisfies AnalysisProgress;

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function recordingRun() {
  const published: AnalysisProgress[] = [];
  const run = createGitHubRun((progress) => published.push(progress));
  return { run, published };
}

describe("createGitHubRun", () => {
  test("a wait republishes the last snapshot with its end, and its end clears it", () => {
    const { run, published } = recordingRun();
    run.report(fetching);

    const endWait = run.rateLimited(T0 + 30_000);
    endWait();

    expect(published).toEqual([
      fetching,
      { ...fetching, rateLimitedUntil: iso(T0 + 30_000) },
      fetching,
    ]);
  });

  test("overlapping waits show the latest end and clear only once both have ended", () => {
    const { run, published } = recordingRun();
    run.report(listing);

    const endFirst = run.rateLimited(T0 + 20_000);
    const endSecond = run.rateLimited(T0 + 45_000);
    endFirst();
    endSecond();

    expect(published).toEqual([
      listing,
      { ...listing, rateLimitedUntil: iso(T0 + 20_000) },
      { ...listing, rateLimitedUntil: iso(T0 + 45_000) },
      listing,
    ]);
  });

  test("ending the wait with the latest end falls back to the other one still running", () => {
    const { run, published } = recordingRun();
    run.report(fetching);

    const endFirst = run.rateLimited(T0 + 20_000);
    const endSecond = run.rateLimited(T0 + 45_000);
    endSecond();
    endFirst();

    expect(
      published.map((progress) => progress.phase === "fetching" && progress.rateLimitedUntil),
    ).toEqual([undefined, iso(T0 + 20_000), iso(T0 + 45_000), iso(T0 + 20_000), undefined]);
  });

  test("two waits with the same end count as two", () => {
    const { run, published } = recordingRun();
    run.report(fetching);

    const endFirst = run.rateLimited(T0 + 20_000);
    const endSecond = run.rateLimited(T0 + 20_000);
    endFirst();
    endFirst();
    expect(published.at(-1)).toEqual({ ...fetching, rateLimitedUntil: iso(T0 + 20_000) });

    endSecond();
    expect(published.at(-1)).toEqual(fetching);
    expect(published).toHaveLength(3);
  });

  test("snapshots reported during a wait carry its end", () => {
    const { run, published } = recordingRun();
    run.report(fetching);
    const endWait = run.rateLimited(T0 + 30_000);

    const next = { ...fetching, prsDone: 50, repoPRsDone: 50, batchesDone: 2 };
    run.report(next);
    endWait();

    expect(published.slice(-2)).toEqual([{ ...next, rateLimitedUntil: iso(T0 + 30_000) }, next]);
  });

  test("a wait before any snapshot publishes nothing, but the next listing shows it", () => {
    const { run, published } = recordingRun();

    const endWait = run.rateLimited(T0 + 30_000);
    expect(published).toEqual([]);

    run.report(listing);
    endWait();
    expect(published).toEqual([{ ...listing, rateLimitedUntil: iso(T0 + 30_000) }, listing]);
  });

  test("a wait after a snapshot of another phase publishes nothing", () => {
    const { run, published } = recordingRun();
    run.report({ phase: "pr-cache", prs: 12 });

    run.rateLimited(T0 + 30_000)();

    expect(published).toEqual([{ phase: "pr-cache", prs: 12 }]);
  });
});
