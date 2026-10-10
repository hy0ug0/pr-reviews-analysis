import { expect, test } from "bun:test";
import { readAnalysisStream } from "./analysisStream";
import type { AnalysisMetrics, AnalysisProgress, AnalysisResult } from "./types";

// A body that arrives in the given chunks, split wherever the test likes.
function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const metrics: AnalysisMetrics = {
  countedPRs: 0,
  totalReviews: 0,
  uniqueReviewers: 0,
  avgReviewsPerPR: 0,
  reviewerStats: [],
  firstResponse: {
    respondedPRs: 0,
    waitingPRs: 0,
    closedWithoutResponsePRs: 0,
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
      mergedPRs: 0,
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
      unreviewedPRs: 0,
      draftPRs: 0,
      undeterminedPRs: 0,
      p50Ms: null,
      p90Ms: null,
      histogram: [],
    },
    reviewRounds: {
      reviewedMergedPRs: 0,
      mergedWithoutReviewPRs: 0,
      undeterminedPRs: 0,
      p50: null,
      p90: null,
      distribution: [],
    },
  },
  timeRange: { since: "2026-09-01", until: "2026-09-30" },
  excludedBots: null,
};

const result: AnalysisResult = {
  ...metrics,
  matchingPRs: 0,
  analyzedPRs: 0,
  isComplete: true,
  partialReasons: [],
  byRepo: [{ repo: "acme/a", metrics }],
};

test("hands progress over and resolves with the result, across split chunks", async () => {
  const progress: AnalysisProgress[] = [];
  const stream = body(
    ": ping\n\n",
    'event: progress\ndata: {"phase":"pr-',
    'cache","prs":3}\n\nevent: result\n',
    `data: ${JSON.stringify(result)}\n\n`,
  );

  const received = await readAnalysisStream(stream, (snapshot) => progress.push(snapshot));

  expect(progress).toEqual([{ phase: "pr-cache", prs: 3 }]);
  expect(received.timeRange).toEqual(result.timeRange);
  expect(received.byRepo).toEqual(result.byRepo);
});

test("skips a progress snapshot it cannot read", async () => {
  const progress: AnalysisProgress[] = [];
  const stream = body(
    'event: progress\ndata: {"phase":"teleporting"}\n\n',
    `event: result\ndata: ${JSON.stringify(result)}\n\n`,
  );

  await readAnalysisStream(stream, (snapshot) => progress.push(snapshot));

  expect(progress).toEqual([]);
});

test("rejects with the error event's message", async () => {
  const stream = body('event: error\ndata: {"message":"rate limited"}\n\n');

  const error = await readAnalysisStream(stream, () => {}).catch((caught: unknown) => caught);
  expect(error instanceof Error && error.message).toContain("rate limited");
});

test("rejects when the stream ends without a result", async () => {
  const stream = body('event: progress\ndata: {"phase":"listing-cache"}\n\n');

  const error = await readAnalysisStream(stream, () => {}).catch((caught: unknown) => caught);
  expect(error instanceof Error && error.message).toContain("closed before the analysis");
});
