import { expect, test } from "bun:test";
import { readAnalysisStream } from "./analysisStream";
import type { AnalysisProgress, AnalysisResult } from "./types";

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

const result: AnalysisResult = {
  countedPRs: 0,
  matchingPRs: 0,
  analyzedPRs: 0,
  isComplete: true,
  partialReasons: [],
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
  timeRange: { since: "2026-09-01", until: "2026-09-30" },
  excludedBots: null,
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
