import { describe, expect, test } from "bun:test";
import type { PRReview, PullRequest } from "../../shared/types.ts";
import { analyze, type AnalyzeOptions } from "./analyzer.ts";
import { analyzeByRepo } from "./by-repo.ts";

function makeReview(by: string, type = "User"): PRReview {
  return {
    author: { login: by, __typename: type },
    state: "APPROVED",
    submittedAt: "2026-03-15T12:00:00Z",
  };
}

function makePR({
  repo,
  number,
  author = "alice",
  authorType = "User",
  reviewers = [],
}: {
  repo: string;
  number: number;
  author?: string;
  authorType?: string;
  reviewers?: string[];
}): PullRequest {
  return {
    repo,
    number,
    title: `Change #${number}`,
    state: "MERGED",
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-03-01T09:00:00Z",
    updatedAt: "2026-03-20T09:00:00Z",
    mergedAt: "2026-03-20T09:00:00Z",
    closedAt: "2026-03-20T09:00:00Z",
    isDraft: false,
    readyForReviewAt: null,
    author: { login: author, __typename: authorType },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: reviewers.map((reviewer) => makeReview(reviewer)),
    },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

const REPOS = ["acme/gadgets", "acme/widgets", "acme/empty"];

const prs = [
  makePR({ repo: "acme/widgets", number: 1, reviewers: ["bob", "bob"] }),
  makePR({ repo: "acme/gadgets", number: 1, reviewers: ["bob", "carol"] }),
  makePR({ repo: "acme/widgets", number: 2, reviewers: ["carol"] }),
  makePR({ repo: "acme/widgets", number: 3, author: "renovate", authorType: "Bot" }),
];

function run(params: Partial<AnalyzeOptions> = {}) {
  return analyzeByRepo(prs, { repos: REPOS, ...params });
}

describe("analyzeByRepo", () => {
  test("gives every queried repo an entry, in query order, an empty one included", () => {
    const byRepo = run();

    expect(byRepo.map(({ repo, metrics }) => [repo, metrics.countedPRs])).toEqual([
      ["acme/gadgets", 1],
      ["acme/widgets", 2],
      ["acme/empty", 0],
    ]);
    expect(byRepo[2].metrics).toMatchObject({
      totalReviews: 0,
      uniqueReviewers: 0,
      avgReviewsPerPR: 0,
      reviewerStats: [],
      excludedBots: { prs: 0, reviews: 0 },
    });
  });

  test("computes each repo's metrics from that repo's PRs alone", () => {
    const widgets = run()[1].metrics;

    expect(widgets).toMatchObject({ totalReviews: 3, uniqueReviewers: 2, avgReviewsPerPR: 1.5 });
    expect(widgets.reviewerStats.map((stats) => [stats.login, stats.totalReviews])).toEqual([
      ["bob", 2],
      ["carol", 1],
    ]);
    expect(widgets).toEqual(
      analyze(
        prs.filter((pr) => pr.repo === "acme/widgets"),
        { repos: ["acme/widgets"] },
      ),
    );
  });

  test("entries add up to the whole, except reviewers active in several repos", () => {
    const whole = analyze(prs, { repos: REPOS });
    const byRepo = run().map((entry) => entry.metrics);
    const sum = (pick: (metrics: (typeof byRepo)[number]) => number) =>
      byRepo.reduce((total, metrics) => total + pick(metrics), 0);

    expect(sum((m) => m.countedPRs)).toBe(whole.countedPRs);
    expect(sum((m) => m.totalReviews)).toBe(whole.totalReviews);
    expect(sum((m) => m.excludedBots?.prs ?? 0)).toBe(1);
    expect(sum((m) => m.firstResponse.respondedPRs)).toBe(whole.firstResponse.respondedPRs);
    // Review cycle came after the split and has no per-repo code of its own.
    expect(sum((m) => m.reviewCycle.timeToMerge.mergedPRs)).toBe(3);
    expect(whole.reviewCycle.timeToMerge.mergedPRs).toBe(3);
    // bob and carol review in both repos: two reviewers overall, four repo-reviewer pairs.
    expect(whole.uniqueReviewers).toBe(2);
    expect(sum((m) => m.uniqueReviewers)).toBe(4);
  });

  test("applies the team filter and the bot setting in every repo", () => {
    const byRepo = run({ teamMembers: ["carol"], includeBots: true });

    expect(byRepo.map(({ metrics }) => [metrics.countedPRs, metrics.totalReviews])).toEqual([
      [1, 1],
      [3, 1],
      [0, 0],
    ]);
    expect(byRepo.every(({ metrics }) => metrics.excludedBots === null)).toBe(true);
  });

  test("gives a PR of a repo outside the list an entry after the others", () => {
    const byRepo = analyzeByRepo([...prs, makePR({ repo: "acme/stray", number: 9 })], {
      repos: REPOS,
    });

    expect(byRepo.map(({ repo, metrics }) => [repo, metrics.countedPRs])).toEqual([
      ["acme/gadgets", 1],
      ["acme/widgets", 2],
      ["acme/empty", 0],
      ["acme/stray", 1],
    ]);
  });
});
