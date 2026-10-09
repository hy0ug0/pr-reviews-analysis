import { describe, expect, test } from "bun:test";
import {
  PULL_REQUEST_FIELDS,
  pullRequestNodeSchema,
  pullRequestSchema,
  toPullRequest,
  type PRReview,
} from "./pull-request-model.ts";

const REPO = "acme/widgets";

const review: PRReview = {
  author: { login: "alice", __typename: "User" },
  state: "APPROVED",
  submittedAt: "2026-03-02T10:00:00Z",
};

const comments = {
  pageInfo: { hasNextPage: false },
  nodes: [{ author: { login: "frank", __typename: "User" }, createdAt: "2026-03-01T11:00:00Z" }],
};

// A node as GitHub returns it for the PullRequestFields fragment.
function rawNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Widget change #7",
    state: "MERGED",
    url: `https://github.com/${REPO}/pull/7`,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-03-05T09:00:00Z",
    mergedAt: "2026-03-05T09:00:00Z",
    closedAt: "2026-03-05T09:00:00Z",
    isDraft: false,
    author: { login: "erin", __typename: "User" },
    timelineItems: { nodes: [] },
    reviews: { pageInfo: { hasNextPage: false, endCursor: "cursor-1" }, nodes: [review] },
    comments,
    ...overrides,
  };
}

function parseNode(overrides: Record<string, unknown> = {}) {
  return pullRequestNodeSchema.parse(rawNode(overrides));
}

describe("PULL_REQUEST_FIELDS", () => {
  test("selects every field of the node schema", () => {
    for (const field of Object.keys(pullRequestNodeSchema.shape)) {
      expect(PULL_REQUEST_FIELDS).toMatch(new RegExp(`^\\s+${field}\\b`, "m"));
    }
  });

  test("does not select review bodies", () => {
    expect(PULL_REQUEST_FIELDS).not.toMatch(/\bbody\b/);
  });
});

describe("pullRequestNodeSchema", () => {
  test("accepts deleted accounts, unsubmitted reviews and empty timeline items", () => {
    const node = parseNode({
      author: null,
      timelineItems: { nodes: [{}] },
      reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ author: null, state: "PENDING", submittedAt: null }],
      },
      comments: { pageInfo: { hasNextPage: true }, nodes: [{ author: null, createdAt: "x" }] },
    });

    expect(node.author).toBeNull();
    expect(node.reviews.nodes).toEqual([{ author: null, state: "PENDING", submittedAt: null }]);
  });

  test("keeps the PR author's __typename, so bot PRs can be told apart", () => {
    const author = { login: "renovate", __typename: "Bot" };

    expect(parseNode({ author }).author).toEqual(author);
    expect(pullRequestNodeSchema.safeParse(rawNode({ author: { login: "erin" } })).success).toBe(
      false,
    );
  });

  test("drops null connection items", () => {
    const node = parseNode({
      timelineItems: { nodes: [null] },
      reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [null, review] },
      comments: { pageInfo: { hasNextPage: false }, nodes: [null] },
    });

    expect(node.timelineItems.nodes).toEqual([]);
    expect(node.reviews.nodes).toEqual([review]);
    expect(node.comments.nodes).toEqual([]);
  });

  test("rejects a node with a missing or mistyped field", () => {
    expect(pullRequestNodeSchema.safeParse(rawNode({ updatedAt: undefined })).success).toBe(false);
    expect(pullRequestNodeSchema.safeParse(rawNode({ state: "DRAFT" })).success).toBe(false);
  });
});

describe("toPullRequest", () => {
  test("sets repo, flattens the connections and matches pullRequestSchema", () => {
    const pullRequest = toPullRequest({ repo: REPO, node: parseNode(), reviews: [review] });

    expect(Object.keys(pullRequest)).toEqual([
      "repo",
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
    expect(pullRequest.repo).toBe(REPO);
    expect(pullRequest.reviews).toEqual({ nodes: [review] });
    expect(pullRequest.comments).toEqual(comments);
    expect(pullRequestSchema.parse(pullRequest)).toEqual(pullRequest);
  });

  test("drops fields the schema does not know, such as a review body", () => {
    const node = parseNode({
      reviews: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ ...review, body: "LGTM" }],
      },
    });

    const pullRequest = toPullRequest({ repo: REPO, node, reviews: node.reviews.nodes });

    expect(pullRequest.reviews.nodes).toEqual([review]);
  });

  test("takes readyForReviewAt from the first ready-for-review event", () => {
    const node = parseNode({ timelineItems: { nodes: [{ createdAt: "2026-03-02T08:00:00Z" }] } });

    expect(toPullRequest({ repo: REPO, node, reviews: [] }).readyForReviewAt).toBe(
      "2026-03-02T08:00:00Z",
    );
  });

  test("sets readyForReviewAt to null when the PR was never a draft", () => {
    expect(
      toPullRequest({ repo: REPO, node: parseNode(), reviews: [] }).readyForReviewAt,
    ).toBeNull();
  });
});
