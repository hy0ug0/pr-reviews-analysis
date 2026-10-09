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
    reviewRequestEvents: { pageInfo: { hasNextPage: false }, nodes: [] },
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

  test("rejects an unknown requested reviewer type rather than guessing", () => {
    const reviewRequestEvents = {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          __typename: "ReviewRequestedEvent",
          createdAt: "2026-03-01T10:00:00Z",
          requestedReviewer: { __typename: "Organization", login: "acme" },
        },
      ],
    };

    expect(pullRequestNodeSchema.safeParse(rawNode({ reviewRequestEvents })).success).toBe(false);
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
      "reviewRequests",
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

  test("normalizes review request events, keeping hidden reviewers as null", () => {
    const node = parseNode({
      reviewRequestEvents: {
        pageInfo: { hasNextPage: true },
        nodes: [
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-01T10:00:00Z",
            requestedReviewer: { __typename: "User", login: "alice" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-01T10:00:01Z",
            requestedReviewer: { __typename: "Mannequin", login: "old-alice" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-01T10:00:02Z",
            requestedReviewer: { __typename: "Bot", login: "copilot" },
          },
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-01T10:00:03Z",
            requestedReviewer: { __typename: "Team", combinedSlug: "acme/core" },
          },
          {
            __typename: "ReviewRequestRemovedEvent",
            createdAt: "2026-03-01T10:00:04Z",
            requestedReviewer: { __typename: "EnterpriseTeam", combinedSlug: "acme-ent/ops" },
          },
          null,
          {
            __typename: "ReviewRequestedEvent",
            createdAt: "2026-03-01T10:00:05Z",
            requestedReviewer: null,
          },
        ],
      },
    });

    expect(toPullRequest({ repo: REPO, node, reviews: [] }).reviewRequests).toEqual({
      pageInfo: { hasNextPage: true },
      nodes: [
        {
          kind: "requested",
          createdAt: "2026-03-01T10:00:00Z",
          reviewer: { kind: "user", login: "alice" },
        },
        {
          kind: "requested",
          createdAt: "2026-03-01T10:00:01Z",
          reviewer: { kind: "user", login: "old-alice" },
        },
        {
          kind: "requested",
          createdAt: "2026-03-01T10:00:02Z",
          reviewer: { kind: "bot", login: "copilot" },
        },
        {
          kind: "requested",
          createdAt: "2026-03-01T10:00:03Z",
          reviewer: { kind: "team", slug: "acme/core" },
        },
        {
          kind: "removed",
          createdAt: "2026-03-01T10:00:04Z",
          reviewer: { kind: "team", slug: "acme-ent/ops" },
        },
        { kind: "requested", createdAt: "2026-03-01T10:00:05Z", reviewer: null },
      ],
    });
  });

  test("sets readyForReviewAt to null when the PR was never a draft", () => {
    expect(
      toPullRequest({ repo: REPO, node: parseNode(), reviews: [] }).readyForReviewAt,
    ).toBeNull();
  });
});
