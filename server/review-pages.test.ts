import { describe, expect, test } from "bun:test";
import type { PRReview } from "../shared/types.ts";
import {
  mergeReviewPages,
  resolveReviews,
  toPullRequest,
  type FetchReviewContinuation,
  type ReviewConnection,
  type PullRequestNode,
} from "./review-pages.ts";

const REPO = "acme/widgets";

function makeReview(by: string, submittedAt: string): PRReview {
  return { author: { login: by, __typename: "User" }, state: "COMMENTED", submittedAt, body: "" };
}

function makeConnection(
  nodes: PRReview[],
  endCursor: string | null,
  hasNextPage = true,
): ReviewConnection {
  return { pageInfo: { hasNextPage, endCursor }, nodes };
}

const comments = {
  nodes: [{ author: { login: "frank", __typename: "User" }, createdAt: "2026-03-01T11:00:00Z" }],
};

function makeNode(
  number: number,
  reviews: ReviewConnection,
  readyForReviewEvents: Array<{ createdAt: string }> = [],
): PullRequestNode {
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
    timelineItems: { nodes: readyForReviewEvents },
    reviews,
    comments,
  };
}

const inline = [
  makeReview("alice", "2026-03-01T10:00:00Z"),
  makeReview("bob", "2026-03-02T10:00:00Z"),
];
const remaining = [
  makeReview("carol", "2026-03-03T10:00:00Z"),
  makeReview("dave", "2026-03-04T10:00:00Z"),
];

describe("mergeReviewPages", () => {
  test("appends continuation pages after the inline page, in order", () => {
    expect(mergeReviewPages(makeConnection(inline, "cursor-2"), remaining)).toEqual([
      ...inline,
      ...remaining,
    ]);
  });

  test("uses only the continuation when it restarted without a cursor", () => {
    expect(mergeReviewPages(makeConnection(inline, null), [...inline, ...remaining])).toEqual([
      ...inline,
      ...remaining,
    ]);
  });
});

describe("toPullRequest", () => {
  test("keeps the shared PullRequest shape and drops the nested pageInfo", () => {
    const pullRequest = toPullRequest(makeNode(7, makeConnection(inline, "cursor-2")), [
      ...inline,
      ...remaining,
    ]);

    expect(Object.keys(pullRequest)).toEqual([
      "number",
      "title",
      "state",
      "url",
      "createdAt",
      "updatedAt",
      "mergedAt",
      "closedAt",
      "isDraft",
      "author",
      "readyForReviewAt",
      "reviews",
      "comments",
    ]);
    expect(pullRequest.reviews).toEqual({ nodes: [...inline, ...remaining] });
    expect(pullRequest.comments).toEqual(comments);
  });

  test("takes readyForReviewAt from the first ready-for-review event", () => {
    const node = makeNode(7, makeConnection(inline, null, false), [
      { createdAt: "2026-03-02T08:00:00Z" },
    ]);

    expect(toPullRequest(node, inline).readyForReviewAt).toBe("2026-03-02T08:00:00Z");
  });

  test("sets readyForReviewAt to null when the PR was never a draft", () => {
    const node = makeNode(7, makeConnection(inline, null, false));

    expect(toPullRequest(node, inline).readyForReviewAt).toBeNull();
  });
});

describe("resolveReviews", () => {
  const complete = makeNode(1, makeConnection(inline, "cursor-1", false));
  const overflowA = makeNode(2, makeConnection(inline, "cursor-2"));
  const overflowB = makeNode(3, makeConnection(inline, "cursor-3"));

  test("fetches continuations only for PRs with more reviews and keeps PR order", async () => {
    const fetchedCursors: Array<string | null> = [];
    const fetchContinuation: FetchReviewContinuation = async (pr) => {
      fetchedCursors.push(pr.reviews.pageInfo.endCursor);
      return remaining;
    };

    const result = await resolveReviews({
      repo: REPO,
      prNodes: [overflowA, complete, overflowB],
      fetchContinuation,
      concurrency: 5,
    });

    expect(fetchedCursors).toHaveLength(2);
    expect(fetchedCursors).toEqual(expect.arrayContaining(["cursor-2", "cursor-3"]));
    expect(result.map((item) => item.kind)).toEqual(["complete", "complete", "complete"]);
    expect(result.map((item) => item.pullRequest.number)).toEqual([2, 1, 3]);
    expect(result.map((item) => item.pullRequest.reviews.nodes.length)).toEqual([4, 2, 4]);
    expect(result[0].pullRequest.reviews.nodes).toEqual([...inline, ...remaining]);
  });

  test("keeps inline reviews and marks only that PR partial when a continuation fails", async () => {
    const fetchContinuation: FetchReviewContinuation = async (pr) => {
      if (pr.number === 2) throw new Error("boom");
      return remaining;
    };

    const result = await resolveReviews({
      repo: REPO,
      prNodes: [complete, overflowA, overflowB],
      fetchContinuation,
      concurrency: 5,
    });

    expect(result.map((item) => item.pullRequest.number)).toEqual([1, 2, 3]);
    expect(result.map((item) => item.kind)).toEqual(["complete", "partial", "complete"]);
    expect(result[1]).toEqual({
      kind: "partial",
      pullRequest: toPullRequest(overflowA, inline),
      reason: `Failed to fetch complete reviews for ${REPO}#2: boom`,
    });
    expect(result[2].pullRequest.reviews.nodes).toEqual([...inline, ...remaining]);
  });

  test("runs at most `concurrency` continuations at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchContinuation: FetchReviewContinuation = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return [];
    };
    const prNodes = Array.from({ length: 6 }, (_, index) =>
      makeNode(index + 1, makeConnection(inline, `cursor-${index + 1}`)),
    );

    await resolveReviews({ repo: REPO, prNodes, fetchContinuation, concurrency: 2 });

    expect(maxInFlight).toBe(2);
  });
});
