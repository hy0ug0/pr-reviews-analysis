import { describe, expect, test } from "bun:test";
import type { PRReview, PullRequest, ReviewMatrixCell, ReviewState } from "../../shared/types.ts";
import { analyze } from "./analyzer.ts";
import { summarizeReviewMatrix } from "./review-matrix.ts";

const REPO = "acme/widgets";

function makeReview({
  by,
  type = "User",
  state = "APPROVED",
  submittedAt = "2026-03-15T12:00:00Z",
}: {
  by: string | null;
  type?: string;
  state?: ReviewState;
  submittedAt?: string | null;
}): PRReview {
  return {
    author: by === null ? null : { login: by, __typename: type },
    state,
    submittedAt,
  };
}

let nextNumber = 1;

function makePR({
  author = "alice",
  authorType = "User",
  reviews = [],
}: {
  author?: string | null;
  authorType?: string;
  reviews?: PRReview[];
}): PullRequest {
  const number = nextNumber++;
  return {
    repo: REPO,
    number,
    title: `Widget change #${number}`,
    state: "MERGED",
    url: `https://github.com/${REPO}/pull/${number}`,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-03-20T09:00:00Z",
    mergedAt: "2026-03-20T09:00:00Z",
    closedAt: "2026-03-20T09:00:00Z",
    isDraft: false,
    readyForReviewAt: null,
    author: author === null ? null : { login: author, __typename: authorType },
    reviews: { pageInfo: { hasNextPage: false }, nodes: reviews },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function cell(author: string | null, reviewer: string, reviews: number, prs: number) {
  return { author, reviewer, reviews, prs } satisfies ReviewMatrixCell;
}

describe("summarizeReviewMatrix", () => {
  test("counts reviews and distinct PRs per author and reviewer", () => {
    const matrix = summarizeReviewMatrix({
      prs: [
        makePR({
          author: "alice",
          reviews: [
            makeReview({ by: "bob", state: "COMMENTED" }),
            makeReview({ by: "bob", state: "COMMENTED" }),
            makeReview({ by: "bob" }),
            makeReview({ by: "carol" }),
          ],
        }),
        makePR({ author: "alice", reviews: [makeReview({ by: "bob" })] }),
        makePR({ author: "bob", reviews: [makeReview({ by: "alice" })] }),
      ],
    });

    expect(matrix).toEqual([
      cell("alice", "bob", 4, 2),
      cell("alice", "carol", 1, 1),
      cell("bob", "alice", 1, 1),
    ]);
  });

  test("skips DISMISSED and PENDING reviews and those outside the date range", () => {
    const matrix = summarizeReviewMatrix({
      prs: [
        makePR({
          reviews: [
            makeReview({ by: "bob", state: "DISMISSED" }),
            makeReview({ by: "bob", state: "PENDING" }),
            makeReview({ by: "bob", submittedAt: "2026-02-28T23:59:59Z" }),
            makeReview({ by: "bob", submittedAt: "2026-04-01T00:00:00Z" }),
            makeReview({ by: "bob", submittedAt: "2026-03-01T00:00:00Z" }),
            makeReview({ by: "bob", submittedAt: "2026-03-31T23:59:59Z" }),
            makeReview({ by: "bob", submittedAt: null }),
          ],
        }),
      ],
      since: "2026-03-01",
      until: "2026-03-31",
    });

    expect(matrix).toEqual([cell("alice", "bob", 3, 1)]);
  });

  test("applies the participant rules: no bots, no self-review, no deleted reviewers", () => {
    const matrix = summarizeReviewMatrix({
      prs: [
        makePR({
          reviews: [
            makeReview({ by: "copilot", type: "Bot" }),
            makeReview({ by: "renovate[bot]" }),
            makeReview({ by: "ci-user" }),
            makeReview({ by: "Alice" }),
            makeReview({ by: null }),
            makeReview({ by: "bob" }),
          ],
        }),
      ],
      botLogins: ["ci-user"],
    });

    expect(matrix).toEqual([cell("alice", "bob", 1, 1)]);
  });

  test("with bots included, counts their reviews like anyone else's", () => {
    const matrix = summarizeReviewMatrix({
      prs: [makePR({ reviews: [makeReview({ by: "copilot", type: "Bot" })] })],
      includeBots: true,
    });

    expect(matrix).toEqual([cell("alice", "copilot", 1, 1)]);
  });

  test("with a team filter, counts team reviewers on anyone's PRs", () => {
    const matrix = summarizeReviewMatrix({
      prs: [
        makePR({ author: "outsider", reviews: [makeReview({ by: "Bob" })] }),
        makePR({ author: "bob", reviews: [makeReview({ by: "carol" })] }),
      ],
      teamMembers: ["bob"],
    });

    expect(matrix).toEqual([cell("outsider", "Bob", 1, 1)]);
  });

  test("keeps the reviews on a PR whose author was deleted, under a null author", () => {
    const matrix = summarizeReviewMatrix({
      prs: [makePR({ author: null, reviews: [makeReview({ by: "bob" })] })],
    });

    expect(matrix).toEqual([cell(null, "bob", 1, 1)]);
  });

  test("orders cells by reviews, then author and reviewer", () => {
    const matrix = summarizeReviewMatrix({
      prs: [
        makePR({ author: "dave", reviews: [makeReview({ by: "bob" })] }),
        makePR({ author: "carol", reviews: [makeReview({ by: "erin" })] }),
        makePR({ author: "carol", reviews: [makeReview({ by: "bob" })] }),
        makePR({ author: "erin", reviews: [makeReview({ by: "bob" }), makeReview({ by: "bob" })] }),
      ],
    });

    expect(matrix.map(({ author, reviewer }) => `${author}<-${reviewer}`)).toEqual([
      "erin<-bob",
      "carol<-bob",
      "carol<-erin",
      "dave<-bob",
    ]);
  });

  test("is empty without counted reviews", () => {
    expect(summarizeReviewMatrix({ prs: [makePR({})] })).toEqual([]);
  });
});

describe("agreement with the reviewer table", () => {
  test("each reviewer's cells add up to their totalReviews and prsReviewed", () => {
    const prs = [
      makePR({ author: "renovate[bot]", reviews: [makeReview({ by: "bob" })] }),
      makePR({
        author: "alice",
        reviews: [
          makeReview({ by: "bob", state: "COMMENTED" }),
          makeReview({ by: "bob", state: "CHANGES_REQUESTED" }),
          makeReview({ by: "carol", state: "DISMISSED" }),
          makeReview({ by: "carol", submittedAt: "2026-02-01T00:00:00Z" }),
          makeReview({ by: "copilot", type: "Bot" }),
        ],
      }),
      makePR({ author: null, reviews: [makeReview({ by: "carol" }), makeReview({ by: "bob" })] }),
      makePR({
        author: "carol",
        reviews: [makeReview({ by: "alice" }), makeReview({ by: "bob" })],
      }),
    ];

    const result = analyze(prs, { repos: [REPO], since: "2026-03-01", until: "2026-03-31" });
    const byReviewer = new Map<string, { reviews: number; prs: number }>();
    for (const { reviewer, ...counts } of result.reviewMatrix) {
      const sums = byReviewer.get(reviewer) ?? { reviews: 0, prs: 0 };
      byReviewer.set(reviewer, {
        reviews: sums.reviews + counts.reviews,
        prs: sums.prs + counts.prs,
      });
    }

    expect(Object.fromEntries(byReviewer)).toEqual(
      Object.fromEntries(
        result.reviewerStats.map((stats) => [
          stats.login,
          { reviews: stats.totalReviews, prs: stats.prsReviewed },
        ]),
      ),
    );
    expect(result.reviewMatrix.reduce((sum, { reviews }) => sum + reviews, 0)).toBe(
      result.totalReviews,
    );
    // The bot's PR is left out, as everywhere else.
    expect(result.reviewMatrix.some(({ author }) => author === "renovate[bot]")).toBe(false);
  });
});
