import { describe, expect, test } from "bun:test";
import type { PRReview } from "../shared/types.ts";
import {
  mergeReviewPages,
  toPullRequest,
  type ReviewConnection,
  type SearchPullRequestNode,
} from "./review-pages.ts";

function makeReview(by: string, submittedAt: string): PRReview {
  return { author: { login: by }, state: "COMMENTED", submittedAt, body: "" };
}

function makeConnection(nodes: PRReview[], endCursor: string | null): ReviewConnection {
  return { pageInfo: { hasNextPage: true, endCursor }, nodes };
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
    const node: SearchPullRequestNode = {
      number: 7,
      title: "Widget change #7",
      state: "MERGED",
      url: "https://github.com/acme/widgets/pull/7",
      createdAt: "2026-03-01T09:00:00Z",
      mergedAt: "2026-03-05T09:00:00Z",
      closedAt: "2026-03-05T09:00:00Z",
      author: { login: "erin" },
      reviews: makeConnection(inline, "cursor-2"),
    };

    const pullRequest = toPullRequest(node, [...inline, ...remaining]);

    expect(Object.keys(pullRequest)).toEqual([
      "number",
      "title",
      "state",
      "url",
      "createdAt",
      "mergedAt",
      "closedAt",
      "author",
      "reviews",
    ]);
    expect(pullRequest.reviews).toEqual({ nodes: [...inline, ...remaining] });
  });
});
