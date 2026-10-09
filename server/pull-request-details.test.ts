import { describe, expect, test } from "bun:test";
import type { PRReview } from "../shared/types.ts";
import {
  batchAlias,
  fetchPullRequestsInBatches,
  pullRequestKey,
  readPullRequestBatch,
  type BatchEntry,
  type FetchPullRequestBatch,
  type PullRequestBatchResponse,
} from "./pull-request-details.ts";
import type { FetchReviewContinuation, PullRequestNode } from "./review-pages.ts";

const REPO = "acme/widgets";

function makeReview(by: string): PRReview {
  return {
    author: { login: by, __typename: "User" },
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
    isDraft: false,
    author: { login: "erin" },
    timelineItems: { nodes: [] },
    reviews: {
      pageInfo: { hasNextPage: hasMoreReviews, endCursor: `cursor-${number}` },
      nodes: [makeReview("alice")],
    },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

const noContinuation: FetchReviewContinuation = async () => {
  throw new Error("unexpected continuation");
};

// What GitHub returns for a batch query when the given nodes exist: data for those aliases,
// and a NOT_FOUND error with the alias in its path for every other number.
function makeBatchResponse(numbers: number[], nodes: PullRequestNode[]): PullRequestBatchResponse {
  const byNumber = new Map(nodes.map((node) => [node.number, node]));
  const repository: Record<string, PullRequestNode | null> = {};
  const errors: NonNullable<PullRequestBatchResponse["errors"]> = [];
  for (const number of numbers) {
    const node = byNumber.get(number) ?? null;
    repository[batchAlias(number)] = node;
    if (!node) {
      errors.push({
        message: `Could not resolve to a PullRequest with the number of ${number}.`,
        path: ["repository", batchAlias(number)],
      });
    }
  }
  return errors.length > 0 ? { data: { repository }, errors } : { data: { repository } };
}

function fetchBatchFrom(nodes: PullRequestNode[]): {
  fetchBatch: FetchPullRequestBatch;
  batches: number[][];
} {
  const batches: number[][] = [];
  return {
    batches,
    fetchBatch: async (numbers) => {
      batches.push(numbers);
      return readPullRequestBatch({
        repo: REPO,
        numbers,
        response: makeBatchResponse(numbers, nodes),
      });
    },
  };
}

function found(node: PullRequestNode): BatchEntry {
  return { kind: "node", node };
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

    const { timelineItems: _timeline, ...node } = makeNode(1);
    expect(item).toEqual({
      kind: "complete",
      pullRequest: { ...node, readyForReviewAt: null, reviews: { nodes: [makeReview("alice")] } },
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
        return readPullRequestBatch({
          repo: REPO,
          numbers,
          response: makeBatchResponse(
            numbers,
            numbers.filter((number) => number !== 2).map((number) => makeNode(number)),
          ),
        });
      },
      fetchContinuation: noContinuation,
    });

    expect(result).toEqual([
      { kind: "complete", pullRequest: expect.objectContaining({ number: 1 }) },
      {
        kind: "failed",
        number: 2,
        reason: `Failed to fetch ${REPO}#2: Could not resolve to a PullRequest with the number of 2.`,
      },
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
        return numbers.map((number) => found(makeNode(number)));
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

describe("readPullRequestBatch", () => {
  const numbers = Array.from({ length: 50 }, (_, index) => index + 1);

  test("keeps the 49 resolved PRs and fails only the one with an error", () => {
    const response = makeBatchResponse(
      numbers,
      numbers.filter((number) => number !== 17).map((number) => makeNode(number)),
    );

    const entries = readPullRequestBatch({ repo: REPO, numbers, response });

    expect(entries.filter((entry) => entry.kind === "node")).toHaveLength(49);
    expect(entries[16]).toEqual({
      kind: "failed",
      reason: `Failed to fetch ${REPO}#17: Could not resolve to a PullRequest with the number of 17.`,
    });
    expect(entries[0]).toEqual(found(makeNode(1)));
    expect(entries[49]).toEqual(found(makeNode(50)));
  });

  test("fails a PR whose alias has data but also an error under it", () => {
    const response: PullRequestBatchResponse = {
      data: { repository: { [batchAlias(1)]: makeNode(1), [batchAlias(2)]: makeNode(2) } },
      errors: [{ message: "Something went wrong", path: ["repository", batchAlias(2), "reviews"] }],
    };

    expect(readPullRequestBatch({ repo: REPO, numbers: [1, 2], response })).toEqual([
      found(makeNode(1)),
      { kind: "failed", reason: `Failed to fetch ${REPO}#2: Something went wrong` },
    ]);
  });

  test("reports an error without an alias on PRs that have no data", () => {
    const response: PullRequestBatchResponse = {
      data: { repository: { [batchAlias(1)]: makeNode(1), [batchAlias(2)]: null } },
      errors: [{ message: "Timeout" }],
    };

    expect(readPullRequestBatch({ repo: REPO, numbers: [1, 2], response })).toEqual([
      found(makeNode(1)),
      { kind: "failed", reason: `Failed to fetch ${REPO}#2: Timeout` },
    ]);
  });

  test("reports a PR missing without any error as not found", () => {
    const response: PullRequestBatchResponse = {
      data: { repository: { [batchAlias(1)]: null } },
    };

    expect(readPullRequestBatch({ repo: REPO, numbers: [1], response })).toEqual([
      { kind: "failed", reason: `Pull request ${REPO}#1 was not found.` },
    ]);
  });

  test("throws when the repository itself did not resolve", () => {
    const response: PullRequestBatchResponse = {
      data: { repository: null },
      errors: [{ message: "Could not resolve to a Repository", path: ["repository"] }],
    };

    expect(() => readPullRequestBatch({ repo: REPO, numbers: [1], response })).toThrow(
      "Could not resolve to a Repository",
    );
  });
});
