import { describe, expect, test } from "bun:test";
import type { AnalysisMetrics, PRReview, PullRequest, ReviewState } from "../../shared/types.ts";
import { analyze, type AnalyzeOptions } from "./analyzer.ts";

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
  authorType = "User",
  reviews = [],
}: {
  number?: number;
  author?: string | null;
  authorType?: string;
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
    author: author === null ? null : { login: author, __typename: authorType },
    reviews: { pageInfo: { hasNextPage: false }, nodes: reviews },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function run(prs: PullRequest[], params: Partial<AnalyzeOptions> = {}): AnalysisMetrics {
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
        responseP50Ms: null,
        responseP90Ms: null,
        responseSamples: 0,
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
      countedPRs: 0,
      totalReviews: 0,
      uniqueReviewers: 0,
      avgReviewsPerPR: 0,
      reviewerStats: [],
      firstResponse: expect.objectContaining({ respondedPRs: 0, p50Ms: null, weekly: [] }),
      reviewCycle: {
        timeToMerge: expect.objectContaining({ mergedPRs: 0, p50Ms: null }),
        timeToApproval: expect.objectContaining({ approvedPRs: 0, p50Ms: null }),
        reviewRounds: expect.objectContaining({ reviewedMergedPRs: 0, p50: null }),
      },
      excludedBots: { prs: 0, reviews: 0 },
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

describe("bots", () => {
  const humanPR = makePR({
    number: 1,
    reviews: [
      makeReview({ by: "bob" }),
      makeReview({ by: "copilot-pull-request-reviewer", type: "Bot" }),
      makeReview({ by: "ci-user" }),
    ],
  });
  const renovatePR = makePR({
    number: 2,
    author: "renovate",
    authorType: "Bot",
    reviews: [makeReview({ by: "carol" })],
  });
  const dependabotPR = makePR({
    number: 3,
    author: "dependabot[bot]",
    reviews: [makeReview({ by: "carol" })],
  });
  const prs = [humanPR, renovatePR, dependabotPR];

  test("by default, drops bot PRs from reviewer stats and first response", () => {
    const result = run(prs);

    expect(logins(result)).toEqual(["bob", "ci-user"]);
    expect(result.totalReviews).toBe(2);
    expect(result.avgReviewsPerPR).toBe(2);
    expect(result.firstResponse.respondedPRs).toBe(1);
  });

  test("by default, drops bot PRs from the review cycle and bot reviews from approvals", () => {
    const botApproved = makePR({
      number: 4,
      reviews: [makeReview({ by: "copilot-pull-request-reviewer", type: "Bot" })],
    });

    const excluded = run([...prs, botApproved]).reviewCycle;
    expect(excluded.timeToMerge.mergedPRs).toBe(2);
    expect(excluded.timeToApproval).toMatchObject({ approvedPRs: 1, unreviewedPRs: 1 });
    expect(excluded.reviewRounds).toMatchObject({
      reviewedMergedPRs: 1,
      mergedWithoutReviewPRs: 1,
    });

    const included = run([...prs, botApproved], { includeBots: true }).reviewCycle;
    expect(included.timeToMerge.mergedPRs).toBe(4);
    expect(included.timeToApproval.approvedPRs).toBe(4);
  });

  test("countedPRs, the Total PRs card, counts the same PRs as the other metrics", () => {
    const humanAndBot = [
      makePR({ number: 1, reviews: [makeReview({ by: "bob" })] }),
      makePR({ number: 2, author: "renovate", authorType: "Bot" }),
    ];

    const excluded = run(humanAndBot);
    expect(excluded.countedPRs).toBe(1);
    expect(excluded.avgReviewsPerPR).toBe(1);
    expect(excluded.firstResponse.respondedPRs).toBe(1);
    expect(excluded.firstResponse.closedWithoutResponsePRs).toBe(0);

    const included = run(humanAndBot, { includeBots: true });
    expect(included.countedPRs).toBe(2);
    expect(included.avgReviewsPerPR).toBe(0.5);
    expect(included.firstResponse.closedWithoutResponsePRs).toBe(1);
  });

  test("by default, reports the bot PRs and bot reviews it left out", () => {
    expect(run(prs, { botLogins: ["CI-User"] }).excludedBots).toEqual({ prs: 2, reviews: 2 });
  });

  test("treats a configured login as a bot, case-insensitively", () => {
    const result = run(prs, { botLogins: ["CI-User"] });

    expect(logins(result)).toEqual(["bob"]);
    expect(result.totalReviews).toBe(1);
  });

  test("drops a PR opened by a configured bot login", () => {
    const result = run([makePR({ author: "Release-Bot", reviews: [makeReview({ by: "bob" })] })], {
      botLogins: ["release-bot"],
    });

    expect(result.reviewerStats).toEqual([]);
    expect(result.excludedBots).toEqual({ prs: 1, reviews: 0 });
  });

  test("with bots included, keeps bot PRs and counts bot reviews", () => {
    const result = run(prs, { includeBots: true, botLogins: ["ci-user"] });

    expect(logins(result)).toEqual(["carol", "bob", "copilot-pull-request-reviewer", "ci-user"]);
    expect(result.totalReviews).toBe(5);
    expect(result.firstResponse.respondedPRs).toBe(3);
    expect(result.excludedBots).toBeNull();
  });

  test("counts only bot reviews that would count with bots included", () => {
    const result = run(
      [
        makePR({
          reviews: [
            makeReview({ by: "renovate[bot]", state: "DISMISSED" }),
            makeReview({ by: "renovate[bot]", submittedAt: "2026-02-01T12:00:00Z" }),
            makeReview({ by: "renovate[bot]" }),
          ],
        }),
      ],
      { since: "2026-03-01" },
    );

    expect(result.excludedBots).toEqual({ prs: 0, reviews: 1 });
  });

  test("with a team filter, does not report bot reviews the filter skips anyway", () => {
    expect(run(prs, { teamMembers: ["bob"] }).excludedBots).toEqual({ prs: 2, reviews: 0 });
  });
});

describe("analyze reviewer response time", () => {
  const requestedAt = "2026-03-15T10:00:00Z";
  const pr: PullRequest = {
    ...makePR({ reviews: [makeReview({ by: "Bob", submittedAt: "2026-03-15T12:00:00Z" })] }),
    reviewRequests: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { kind: "requested", createdAt: requestedAt, reviewer: { kind: "user", login: "bob" } },
        { kind: "requested", createdAt: requestedAt, reviewer: { kind: "user", login: "carol" } },
      ],
    },
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { author: { login: "carol", __typename: "User" }, createdAt: "2026-03-15T11:00:00Z" },
      ],
    },
  };

  test("adds each reviewer's response percentiles to their row", () => {
    expect(run([pr]).reviewerStats).toEqual([
      expect.objectContaining({
        login: "Bob",
        responseP50Ms: 2 * 60 * 60 * 1000,
        responseP90Ms: 2 * 60 * 60 * 1000,
        responseSamples: 1,
      }),
    ]);
  });

  test("gives no row to someone who only answered by comment", () => {
    expect(logins(run([pr]))).toEqual(["Bob"]);
  });
});
