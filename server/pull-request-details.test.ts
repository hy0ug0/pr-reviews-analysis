import { describe, expect, test } from "bun:test";
import type { PRReview } from "../shared/types.ts";
import {
  fetchPullRequestsInBatches,
  pullRequestKey,
  type FetchPullRequestBatch,
} from "./pull-request-details.ts";
import type { FetchReviewContinuation, PullRequestNode } from "./review-pages.ts";

const REPO = "acme/widgets";

function makeReview(by: string): PRReview {
  return {
    author: { login: by },
    state: "APPROVED",
    submittedAt: "2026-03-02T10:00:00Z",
    body: "",
  };
}

function makeNode(number: number, hasMoreReviews = false): PullRequestNode {
  return {
    number,
    title: `Widget change #${number}`,
    state: "MERGED",
    url: `https://github.com/${REPO}/pull/${number}`,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-03-05T09:00:00Z",
    mergedAt: "2026-03-05T09:00:00Z",
    closedAt: "2026-03-05T09:00:00Z",
    author: { login: "erin" },
    reviews: {
      pageInfo: { hasNextPage: hasMoreReviews, endCursor: `cursor-${number}` },
      nodes: [makeReview("alice")],
    },
  };
}

const noContinuation: FetchReviewContinuation = async () => {
  throw new Error("unexpected continuation");
};

function fetchBatchFrom(nodes: PullRequestNode[]): {
  fetchBatch: FetchPullRequestBatch;
  batches: number[][];
} {
  const byNumber = new Map(nodes.map((node) => [node.number, node]));
  const batches: number[][] = [];
  return {
    batches,
    fetchBatch: async (numbers) => {
      batches.push(numbers);
      return numbers.map((number) => byNumber.get(number) ?? null);
    },
  };
}

describe("pullRequestKey", () => {
  test("joins repo and number", () => {
    expect(pullRequestKey({ repo: REPO, number: 7 })).toBe("acme/widgets#7");
  });
});

describe("fetchPullRequestsInBatches", () => {
  test("splits the numbers into batches and keeps their order", async () => {
    const numbers = [5, 3, 9, 1, 7];
    const { fetchBatch, batches } = fetchBatchFrom(numbers.map((number) => makeNode(number)));

    const result = await fetchPullRequestsInBatches({
      repo: REPO,
      numbers,
      batchSize: 2,
      concurrency: 5,
      fetchBatch,
      fetchContinuation: noContinuation,
    });

    expect(batches).toHaveLength(3);
    expect(batches.flat().sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9]);
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    expect(result.map((item) => item.kind)).toEqual(Array(5).fill("complete"));
    expect(
      result.map((item) => (item.kind === "failed" ? item.number : item.pullRequest.number)),
    ).toEqual(numbers);
  });

  test("returns the shared PullRequest shape without the nested pageInfo", async () => {
    const { fetchBatch } = fetchBatchFrom([makeNode(1)]);

    const [item] = await fetchPullRequestsInBatches({
      repo: REPO,
      numbers: [1],
      batchSize: 50,
      concurrency: 5,
      fetchBatch,
      fetchContinuation: noContinuation,
    });

    expect(item).toEqual({
      kind: "complete",
      pullRequest: { ...makeNode(1), reviews: { nodes: [makeReview("alice")] } },
    });
  });

  test("fails only the PRs of a failed batch and of PRs GitHub did not return", async () => {
    const result = await fetchPullRequestsInBatches({
      repo: REPO,
      numbers: [1, 2, 3, 4],
      batchSize: 2,
      concurrency: 1,
      fetchBatch: async (numbers) => {
        if (numbers.includes(3)) throw new Error("rate limited");
        return numbers.map((number) => (number === 2 ? null : makeNode(number)));
      },
      fetchContinuation: noContinuation,
    });

    expect(result).toEqual([
      { kind: "complete", pullRequest: expect.objectContaining({ number: 1 }) },
      { kind: "failed", number: 2, reason: `Pull request ${REPO}#2 was not found.` },
      { kind: "failed", number: 3, reason: `Failed to fetch ${REPO}#3: rate limited` },
      { kind: "failed", number: 4, reason: `Failed to fetch ${REPO}#4: rate limited` },
    ]);
  });

  test("completes PRs with more than one review page, and marks a failed one partial", async () => {
    const { fetchBatch } = fetchBatchFrom([makeNode(1, true), makeNode(2), makeNode(3, true)]);
    const continuedCursors: Array<string | null> = [];

    const result = await fetchPullRequestsInBatches({
      repo: REPO,
      numbers: [1, 2, 3],
      batchSize: 50,
      concurrency: 5,
      fetchBatch,
      fetchContinuation: async (pr) => {
        continuedCursors.push(pr.reviews.pageInfo.endCursor);
        if (pr.number === 3) throw new Error("boom");
        return [makeReview("bob")];
      },
    });

    expect(continuedCursors).toEqual(expect.arrayContaining(["cursor-1", "cursor-3"]));
    expect(continuedCursors).toHaveLength(2);
    expect(result.map((item) => item.kind)).toEqual(["complete", "complete", "partial"]);
    expect(result[0].kind === "complete" && result[0].pullRequest.reviews.nodes).toEqual([
      makeReview("alice"),
      makeReview("bob"),
    ]);
    expect(result[2]).toEqual({
      kind: "partial",
      pullRequest: expect.objectContaining({
        number: 3,
        reviews: { nodes: [makeReview("alice")] },
      }),
      reason: `Failed to fetch complete reviews for ${REPO}#3: boom`,
    });
  });

  test("runs at most `concurrency` batches at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await fetchPullRequestsInBatches({
      repo: REPO,
      numbers: Array.from({ length: 10 }, (_, index) => index + 1),
      batchSize: 1,
      concurrency: 3,
      fetchBatch: async (numbers) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return numbers.map((number) => makeNode(number));
      },
      fetchContinuation: noContinuation,
    });

    expect(maxInFlight).toBe(3);
  });

  test("makes no call for an empty list", async () => {
    const { fetchBatch, batches } = fetchBatchFrom([]);

    const result = await fetchPullRequestsInBatches({
      repo: REPO,
      numbers: [],
      batchSize: 50,
      concurrency: 5,
      fetchBatch,
      fetchContinuation: noContinuation,
    });

    expect(result).toEqual([]);
    expect(batches).toEqual([]);
  });
});
