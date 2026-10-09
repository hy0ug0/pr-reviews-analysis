import { describe, expect, test } from "bun:test";
import type {
  AnalysisMetrics,
  AnalyzeParams,
  PRReview,
  PullRequest,
  ReviewState,
} from "../../shared/types.ts";
import { analyze } from "./analyzer.ts";

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

function makePR({
  number = 1,
  author = "alice",
  reviews = [],
}: {
  number?: number;
  author?: string | null;
  reviews?: PRReview[];
}): PullRequest {
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
    author: author === null ? null : { login: author },
    reviews: { nodes: reviews },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function run(prs: PullRequest[], params: Partial<AnalyzeParams> = {}): AnalysisMetrics {
  return analyze(prs, { repos: [REPO], ...params });
}

function logins(result: AnalysisMetrics): string[] {
  return result.reviewerStats.map((stats) => stats.login);
}

describe("review filtering", () => {
  test("ignores reviews without an author", () => {
    const result = run([
      makePR({ reviews: [makeReview({ by: null }), makeReview({ by: "bob" })] }),
    ]);

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["bob"]);
  });

  test("ignores reviews by the PR author, whatever the casing", () => {
    const result = run([
      makePR({
        author: "alice",
        reviews: [
          makeReview({ by: "alice" }),
          makeReview({ by: "Alice" }),
          makeReview({ by: "bob" }),
        ],
      }),
    ]);

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["bob"]);
  });

  test("ignores bots by __typename and by the [bot] login suffix", () => {
    const result = run([
      makePR({
        reviews: [
          makeReview({ by: "copilot-pull-request-reviewer", type: "Bot" }),
          makeReview({ by: "renovate[bot]" }),
          makeReview({ by: "bob" }),
        ],
      }),
    ]);

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["bob"]);
  });

  test("counts reviews on a PR without an author", () => {
    const result = run([makePR({ author: null, reviews: [makeReview({ by: "bob" })] })]);

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["bob"]);
  });

  test("ignores DISMISSED and PENDING reviews", () => {
    const result = run([
      makePR({
        reviews: [
          makeReview({ by: "bob", state: "DISMISSED" }),
          makeReview({ by: "bob", state: "PENDING" }),
          makeReview({ by: "carol", state: "APPROVED" }),
        ],
      }),
    ]);

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["carol"]);
  });
});

describe("team filter", () => {
  test("counts only reviews by team members", () => {
    const result = run(
      [makePR({ reviews: [makeReview({ by: "bob" }), makeReview({ by: "carol" })] })],
      { teamMembers: ["bob"] },
    );

    expect(result.totalReviews).toBe(1);
    expect(logins(result)).toEqual(["bob"]);
  });

  test("matches logins case-insensitively and keeps the review's casing", () => {
    const result = run([makePR({ reviews: [makeReview({ by: "Bob" })] })], {
      teamMembers: ["bOB"],
    });

    expect(logins(result)).toEqual(["Bob"]);
  });

  test("is off when teamMembers is undefined or empty", () => {
    const prs = [
      makePR({
        reviews: [
          makeReview({ by: "bob" }),
          makeReview({ by: "bob" }),
          makeReview({ by: "carol" }),
        ],
      }),
    ];

    expect(logins(run(prs, { teamMembers: undefined }))).toEqual(["bob", "carol"]);
    expect(logins(run(prs, { teamMembers: [] }))).toEqual(["bob", "carol"]);
  });

  test("applies to reviewers only, not PR authors", () => {
    const result = run([makePR({ author: "carol", reviews: [makeReview({ by: "bob" })] })], {
      teamMembers: ["bob"],
    });

    expect(logins(result)).toEqual(["bob"]);
  });
});

describe("date range", () => {
  test("since includes reviews from midnight UTC that day and excludes the day before", () => {
    const result = run(
      [
        makePR({
          reviews: [
            makeReview({ by: "bob", submittedAt: "2026-03-10T00:00:00Z" }),
            makeReview({ by: "carol", submittedAt: "2026-03-09T23:59:59Z" }),
          ],
        }),
      ],
      { since: "2026-03-10" },
    );

    expect(logins(result)).toEqual(["bob"]);
  });

  test("until includes reviews up to 23:59:59 UTC that day and excludes the next day", () => {
    const result = run(
      [
        makePR({
          reviews: [
            makeReview({ by: "bob", submittedAt: "2026-03-20T23:59:59Z" }),
            makeReview({ by: "carol", submittedAt: "2026-03-21T00:00:00Z" }),
          ],
        }),
      ],
      { until: "2026-03-20" },
    );

    expect(logins(result)).toEqual(["bob"]);
  });

  test("keeps reviews without submittedAt when a range is set", () => {
    // Pins current behavior: a review with no timestamp skips both date checks.
    const result = run([makePR({ reviews: [makeReview({ by: "bob", submittedAt: null })] })], {
      since: "2026-03-10",
      until: "2026-03-20",
    });

    expect(logins(result)).toEqual(["bob"]);
  });
});

describe("aggregation", () => {
  test("counts each review state and adds every counted review to totalReviews", () => {
    const result = run([
      makePR({
        reviews: [
          makeReview({ by: "bob", state: "APPROVED" }),
          makeReview({ by: "bob", state: "CHANGES_REQUESTED" }),
          makeReview({ by: "bob", state: "COMMENTED" }),
          makeReview({ by: "bob", state: "COMMENTED" }),
        ],
      }),
    ]);

    expect(result.reviewerStats).toEqual([
      {
        login: "bob",
        totalReviews: 4,
        approvals: 1,
        changesRequested: 1,
        comments: 2,
        prsReviewed: 1,
      },
    ]);
  });

  test("prsReviewed counts a reviewer once per PR", () => {
    const result = run([
      makePR({ number: 1, reviews: [makeReview({ by: "bob" }), makeReview({ by: "bob" })] }),
      makePR({ number: 2, reviews: [makeReview({ by: "bob" })] }),
    ]);

    expect(result.reviewerStats[0]).toMatchObject({
      login: "bob",
      totalReviews: 3,
      prsReviewed: 2,
    });
  });

  test("totalReviews sums all reviewers and uniqueReviewers counts them", () => {
    const result = run([
      makePR({
        reviews: [
          makeReview({ by: "bob" }),
          makeReview({ by: "bob" }),
          makeReview({ by: "carol" }),
        ],
      }),
    ]);

    expect(result.totalReviews).toBe(3);
    expect(result.uniqueReviewers).toBe(2);
    expect(result.uniqueReviewers).toBe(result.reviewerStats.length);
  });

  test("avgReviewsPerPR divides by every input PR and rounds to one decimal", () => {
    const result = run([
      makePR({ number: 1, reviews: [makeReview({ by: "bob" })] }),
      makePR({ number: 2, reviews: [makeReview({ by: "carol" })] }),
      makePR({ number: 3 }),
    ]);

    expect(result.avgReviewsPerPR).toBe(0.7);
  });

  test("sorts reviewerStats by totalReviews, highest first", () => {
    const result = run([
      makePR({
        number: 1,
        author: "alice",
        reviews: [
          makeReview({ by: "carol" }),
          makeReview({ by: "bob" }),
          makeReview({ by: "bob" }),
          makeReview({ by: "bob" }),
        ],
      }),
      makePR({
        number: 2,
        author: "carol",
        reviews: [makeReview({ by: "alice" }), makeReview({ by: "alice" })],
      }),
    ]);

    expect(logins(result)).toEqual(["bob", "alice", "carol"]);
  });
});

describe("output shape", () => {
  test("returns zero counts and no coverage fields for empty input", () => {
    expect(run([])).toEqual({
      totalReviews: 0,
      uniqueReviewers: 0,
      avgReviewsPerPR: 0,
      reviewerStats: [],
      firstResponse: expect.objectContaining({ respondedPRs: 0, p50Ms: null, weekly: [] }),
      timeRange: { since: "", until: "" },
    });
  });

  test("timeRange echoes since and until", () => {
    const result = run([], { since: "2026-03-10", until: "2026-03-20" });

    expect(result.timeRange).toEqual({ since: "2026-03-10", until: "2026-03-20" });
  });

  test("timeRange uses empty strings when since and until are omitted", () => {
    expect(run([]).timeRange).toEqual({ since: "", until: "" });
  });
});

describe("participants shared with first response", () => {
  test("a bot review counts in neither reviewer stats nor first response", () => {
    const result = run([
      makePR({ reviews: [makeReview({ by: "copilot-pull-request-reviewer", type: "Bot" })] }),
    ]);

    expect(result.reviewerStats).toEqual([]);
    expect(result.firstResponse).toMatchObject({ respondedPRs: 0, closedWithoutResponsePRs: 1 });
  });

  test("the author reviewing their own PR under another casing counts in neither", () => {
    const result = run([makePR({ author: "alice", reviews: [makeReview({ by: "ALICE" })] })]);

    expect(result.reviewerStats).toEqual([]);
    expect(result.firstResponse).toMatchObject({ respondedPRs: 0, closedWithoutResponsePRs: 1 });
  });
});
