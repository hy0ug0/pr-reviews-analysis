import { describe, expect, test } from "bun:test";
import type { PRReview, PullRequest, ReviewState } from "../../shared/types.ts";
import { toParticipantRules } from "./participants.ts";
import {
  classifyApproval,
  classifyMerge,
  classifyRounds,
  summarizeReviewCycle,
  type ApprovalOutcome,
  type RoundsOutcome,
} from "./review-cycle.ts";

const HOUR = 60 * 60 * 1000;
const CREATED_AT = "2026-03-02T09:00:00Z";

function at(iso: string): number {
  return Date.parse(iso);
}

function review({
  by,
  submittedAt,
  state = "COMMENTED",
  type = "User",
}: {
  by: string | null;
  submittedAt: string | null;
  state?: ReviewState;
  type?: string;
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
  state = "MERGED",
  createdAt = CREATED_AT,
  closedAt = "2026-03-06T09:00:00Z",
  isDraft = false,
  readyForReviewAt = null,
  reviews = [],
  moreReviews = false,
}: {
  number?: number;
  author?: string;
  state?: PullRequest["state"];
  createdAt?: string;
  // Also the merge time for a merged PR.
  closedAt?: string | null;
  isDraft?: boolean;
  readyForReviewAt?: string | null;
  reviews?: PRReview[];
  // Whether GitHub has reviews that weren't fetched (the continuation failed).
  moreReviews?: boolean;
}): PullRequest {
  const closed = state === "OPEN" ? null : closedAt;
  return {
    repo: "acme/widgets",
    number,
    title: `Widget change #${number}`,
    state,
    url: `https://github.com/acme/widgets/pull/${number}`,
    createdAt,
    updatedAt: closed ?? createdAt,
    mergedAt: state === "MERGED" ? closed : null,
    closedAt: closed,
    isDraft,
    readyForReviewAt,
    author: { login: author, __typename: "User" },
    reviews: { pageInfo: { hasNextPage: moreReviews }, nodes: reviews },
    comments: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
  };
}

function approval(pr: PullRequest, teamMembers?: string[]): ApprovalOutcome {
  return classifyApproval({ pr, ...toParticipantRules({ teamMembers }) });
}

function approvedAfter(outcome: ApprovalOutcome): number | null {
  return outcome.kind === "approved" ? outcome.approvedAt - outcome.firstReviewAt : null;
}

function rounds(pr: PullRequest, teamMembers?: string[]): RoundsOutcome {
  return classifyRounds({ pr, ...toParticipantRules({ teamMembers }) });
}

describe("classifyMerge", () => {
  test("measures from creation to the merge", () => {
    const outcome = classifyMerge(makePR({ closedAt: "2026-03-02T15:00:00Z" }));

    expect(outcome).toEqual({
      kind: "merged",
      startedAt: at(CREATED_AT),
      mergedAt: at("2026-03-02T15:00:00Z"),
    });
  });

  test("starts at the ready-for-review event, like first response", () => {
    const outcome = classifyMerge(
      makePR({ readyForReviewAt: "2026-03-04T09:00:00Z", closedAt: "2026-03-04T11:00:00Z" }),
    );

    expect(outcome).toMatchObject({ kind: "merged", startedAt: at("2026-03-04T09:00:00Z") });
  });

  test("counts a PR merged without any review", () => {
    expect(classifyMerge(makePR({ reviews: [] })).kind).toBe("merged");
  });

  test("gives open and closed-unmerged PRs no duration", () => {
    expect(classifyMerge(makePR({ state: "OPEN" }))).toEqual({ kind: "open" });
    expect(classifyMerge(makePR({ state: "OPEN", isDraft: true }))).toEqual({ kind: "open" });
    expect(classifyMerge(makePR({ state: "CLOSED" }))).toEqual({ kind: "closedUnmerged" });
  });
});

describe("classifyApproval", () => {
  test("measures from the first review, of any state, to the first approval", () => {
    const outcome = approval(
      makePR({
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "COMMENTED" }),
          review({ by: "carol", submittedAt: "2026-03-03T12:00:00Z", state: "CHANGES_REQUESTED" }),
          review({ by: "carol", submittedAt: "2026-03-04T09:00:00Z", state: "APPROVED" }),
          review({ by: "bob", submittedAt: "2026-03-05T09:00:00Z", state: "APPROVED" }),
        ],
      }),
    );

    expect(outcome).toEqual({
      kind: "approved",
      firstReviewAt: at("2026-03-03T09:00:00Z"),
      approvedAt: at("2026-03-04T09:00:00Z"),
    });
  });

  test("takes 0 when the first review is the approval", () => {
    const outcome = approval(
      makePR({
        reviews: [review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "APPROVED" })],
      }),
    );

    expect(approvedAfter(outcome)).toBe(0);
  });

  test("skips a dismissed approval but still starts the clock at it", () => {
    const outcome = approval(
      makePR({
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "DISMISSED" }),
          review({ by: "bob", submittedAt: "2026-03-03T13:00:00Z", state: "APPROVED" }),
        ],
      }),
    );

    expect(approvedAfter(outcome)).toBe(4 * HOUR);
  });

  test("reports a PR whose only approval was dismissed as not approved", () => {
    const outcome = approval(
      makePR({
        reviews: [review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "DISMISSED" })],
      }),
    );

    expect(outcome).toEqual({ kind: "notApproved" });
  });

  test("ignores reviews by the author, bots, deleted accounts and pending reviews", () => {
    const outcome = approval(
      makePR({
        author: "alice",
        reviews: [
          review({ by: "Alice", submittedAt: "2026-03-02T10:00:00Z" }),
          review({ by: "renovate[bot]", submittedAt: "2026-03-02T11:00:00Z", state: "APPROVED" }),
          review({ by: null, submittedAt: "2026-03-02T12:00:00Z" }),
          review({ by: "bob", submittedAt: null, state: "PENDING" }),
          review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" }),
          review({ by: "bob", submittedAt: "2026-03-03T10:00:00Z", state: "APPROVED" }),
        ],
      }),
    );

    expect(approvedAfter(outcome)).toBe(HOUR);
  });

  test("with a team filter, starts and ends only on team members' reviews", () => {
    const pr = makePR({
      reviews: [
        review({ by: "dave", submittedAt: "2026-03-03T09:00:00Z" }),
        review({ by: "bob", submittedAt: "2026-03-03T11:00:00Z" }),
        review({ by: "dave", submittedAt: "2026-03-03T12:00:00Z", state: "APPROVED" }),
        review({ by: "Bob", submittedAt: "2026-03-03T14:00:00Z", state: "APPROVED" }),
      ],
    });

    expect(approvedAfter(approval(pr))).toBe(3 * HOUR);
    expect(approvedAfter(approval(pr, ["bob"]))).toBe(3 * HOUR);
    expect(approval(pr, ["erin"])).toEqual({ kind: "unreviewed" });
  });

  test("ignores reviews of the draft and reviews after the PR closed", () => {
    const pr = makePR({
      readyForReviewAt: "2026-03-04T09:00:00Z",
      closedAt: "2026-03-05T09:00:00Z",
      reviews: [
        review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" }),
        review({ by: "bob", submittedAt: "2026-03-04T10:00:00Z" }),
        review({ by: "bob", submittedAt: "2026-03-06T09:00:00Z", state: "APPROVED" }),
      ],
    });

    expect(approval(pr)).toEqual({ kind: "notApproved" });
  });

  test("leaves drafts out and reports PRs without a review", () => {
    expect(approval(makePR({ state: "OPEN", isDraft: true }))).toEqual({ kind: "draft" });
    expect(approval(makePR({ reviews: [] }))).toEqual({ kind: "unreviewed" });
  });

  test("with unfetched reviews, is undetermined unless a fetched review approved", () => {
    const commented = review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" });
    const approved = review({ by: "bob", submittedAt: "2026-03-03T10:00:00Z", state: "APPROVED" });

    expect(approval(makePR({ reviews: [commented], moreReviews: true }))).toEqual({
      kind: "undetermined",
    });
    expect(
      approvedAfter(approval(makePR({ reviews: [commented, approved], moreReviews: true }))),
    ).toBe(HOUR);
  });

  test("with unfetched reviews after the PR closed, reports what was fetched", () => {
    const pr = makePR({
      closedAt: "2026-03-03T08:00:00Z",
      reviews: [
        review({ by: "bob", submittedAt: "2026-03-02T10:00:00Z" }),
        review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "APPROVED" }),
      ],
      moreReviews: true,
    });

    expect(approval(pr)).toEqual({ kind: "notApproved" });
  });
});

describe("classifyRounds", () => {
  test("counts change requests, one per review, whoever made them", () => {
    const outcome = rounds(
      makePR({
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "CHANGES_REQUESTED" }),
          review({ by: "carol", submittedAt: "2026-03-03T09:30:00Z", state: "CHANGES_REQUESTED" }),
          review({ by: "bob", submittedAt: "2026-03-04T09:00:00Z", state: "CHANGES_REQUESTED" }),
          review({ by: "bob", submittedAt: "2026-03-05T09:00:00Z", state: "APPROVED" }),
        ],
      }),
    );

    expect(outcome).toEqual({ kind: "counted", rounds: 3 });
  });

  test("gives 0 rounds to a PR approved without change requests", () => {
    const outcome = rounds(
      makePR({
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" }),
          review({ by: "bob", submittedAt: "2026-03-04T09:00:00Z", state: "APPROVED" }),
        ],
      }),
    );

    expect(outcome).toEqual({ kind: "counted", rounds: 0 });
  });

  test("doesn't count a dismissed change request, the author's, a bot's or a draft's", () => {
    const outcome = rounds(
      makePR({
        author: "alice",
        readyForReviewAt: "2026-03-03T09:00:00Z",
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-02T12:00:00Z", state: "CHANGES_REQUESTED" }),
          review({ by: "bob", submittedAt: "2026-03-03T10:00:00Z", state: "DISMISSED" }),
          review({ by: "alice", submittedAt: "2026-03-03T11:00:00Z", state: "CHANGES_REQUESTED" }),
          review({
            by: "coderabbitai",
            type: "Bot",
            submittedAt: "2026-03-03T12:00:00Z",
            state: "CHANGES_REQUESTED",
          }),
        ],
      }),
    );

    expect(outcome).toEqual({ kind: "counted", rounds: 0 });
  });

  test("with a team filter, counts only team members' change requests", () => {
    const pr = makePR({
      reviews: [
        review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "CHANGES_REQUESTED" }),
        review({ by: "dave", submittedAt: "2026-03-03T10:00:00Z", state: "CHANGES_REQUESTED" }),
      ],
    });

    expect(rounds(pr, ["bob"])).toEqual({ kind: "counted", rounds: 1 });
    expect(rounds(pr, ["erin"])).toEqual({ kind: "mergedWithoutReview" });
  });

  test("covers merged PRs only", () => {
    const changes = [
      review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "CHANGES_REQUESTED" }),
    ];

    expect(rounds(makePR({ state: "OPEN", reviews: changes }))).toEqual({ kind: "notMerged" });
    expect(rounds(makePR({ state: "CLOSED", reviews: changes }))).toEqual({ kind: "notMerged" });
  });

  test("reports a merged PR with only reviews after the merge as merged without review", () => {
    const pr = makePR({
      closedAt: "2026-03-03T09:00:00Z",
      reviews: [review({ by: "bob", submittedAt: "2026-03-04T09:00:00Z", state: "APPROVED" })],
    });

    expect(rounds(pr)).toEqual({ kind: "mergedWithoutReview" });
  });

  test("is undetermined when reviews before the merge may be missing", () => {
    const reviews = [
      review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z", state: "CHANGES_REQUESTED" }),
    ];

    expect(rounds(makePR({ reviews, moreReviews: true }))).toEqual({ kind: "undetermined" });
    expect(
      rounds(makePR({ closedAt: "2026-03-03T08:00:00Z", reviews, moreReviews: true })),
    ).toEqual({ kind: "mergedWithoutReview" });
  });
});

// Merged unless `state` says otherwise: bob comments first, carol requests changes
// `changesRequested` times at that moment, then bob approves.
function approvedPR({
  number,
  firstReviewAt,
  approvedAt,
  changesRequested = 0,
  state = "MERGED",
}: {
  number: number;
  firstReviewAt: string;
  approvedAt: string;
  changesRequested?: number;
  state?: PullRequest["state"];
}): PullRequest {
  const changes = Array.from({ length: changesRequested }, () =>
    review({ by: "carol", submittedAt: firstReviewAt, state: "CHANGES_REQUESTED" }),
  );
  return makePR({
    number,
    state,
    reviews: [
      review({ by: "bob", submittedAt: firstReviewAt }),
      ...changes,
      review({ by: "bob", submittedAt: approvedAt, state: "APPROVED" }),
    ],
  });
}

describe("summarizeReviewCycle", () => {
  test("summarizes time to merge over merged PRs", () => {
    const { timeToMerge } = summarizeReviewCycle({
      prs: [
        makePR({ number: 1, closedAt: "2026-03-02T09:30:00Z" }),
        makePR({ number: 2, closedAt: "2026-03-02T12:00:00Z" }),
        makePR({ number: 3, closedAt: "2026-03-05T09:00:00Z" }),
        makePR({ number: 4, state: "OPEN" }),
        makePR({ number: 5, state: "CLOSED" }),
      ],
    });

    expect(timeToMerge).toMatchObject({
      mergedPRs: 3,
      openPRs: 1,
      closedUnmergedPRs: 1,
      p50Ms: 3 * HOUR,
      // Type 7 between 3h and 72h, at 0.8 of the way.
      p90Ms: 3 * HOUR + 0.8 * 69 * HOUR,
    });
    expect(timeToMerge.histogram.map((bucket) => bucket.count)).toEqual([1, 1, 0, 0, 1, 0]);
  });

  test("summarizes time to approval and counts approvals at the first review", () => {
    const { timeToApproval } = summarizeReviewCycle({
      prs: [
        approvedPR({
          number: 1,
          firstReviewAt: "2026-03-03T09:00:00Z",
          approvedAt: "2026-03-03T09:00:00Z",
        }),
        approvedPR({
          number: 2,
          firstReviewAt: "2026-03-03T09:00:00Z",
          approvedAt: "2026-03-03T11:00:00Z",
          state: "OPEN",
        }),
        makePR({
          number: 3,
          reviews: [review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" })],
        }),
        makePR({ number: 4 }),
        makePR({ number: 5, state: "OPEN", isDraft: true }),
      ],
    });

    expect(timeToApproval).toMatchObject({
      approvedPRs: 2,
      approvedAtFirstReviewPRs: 1,
      notApprovedPRs: 1,
      unreviewedPRs: 1,
      draftPRs: 1,
      undeterminedPRs: 0,
      p50Ms: HOUR,
      p90Ms: 1.8 * HOUR,
    });
  });

  test("buckets rounds as 0, 1, 2 and 3+, with percentiles to one decimal", () => {
    const prs = [0, 0, 1, 2, 4].map((changesRequested, index) =>
      approvedPR({
        number: index + 1,
        firstReviewAt: "2026-03-03T09:00:00Z",
        approvedAt: "2026-03-04T09:00:00Z",
        changesRequested,
      }),
    );
    prs.push(makePR({ number: 6 }), makePR({ number: 7, state: "OPEN" }));

    const { reviewRounds } = summarizeReviewCycle({ prs });

    expect(reviewRounds).toEqual({
      reviewedMergedPRs: 5,
      mergedWithoutReviewPRs: 1,
      undeterminedPRs: 0,
      p50: 1,
      // Type 7: 2 + 0.6 * (4 - 2).
      p90: 3.2,
      distribution: [
        { label: "0", rounds: 0, orMore: false, count: 2 },
        { label: "1", rounds: 1, orMore: false, count: 1 },
        { label: "2", rounds: 2, orMore: false, count: 1 },
        { label: "3+", rounds: 3, orMore: true, count: 1 },
      ],
    });
  });

  test("reports no percentiles and empty buckets without samples", () => {
    const summary = summarizeReviewCycle({ prs: [] });

    expect(summary.timeToMerge).toMatchObject({ mergedPRs: 0, p50Ms: null, p90Ms: null });
    expect(summary.timeToApproval).toMatchObject({ approvedPRs: 0, p50Ms: null, p90Ms: null });
    expect(summary.reviewRounds).toMatchObject({ reviewedMergedPRs: 0, p50: null, p90: null });
    expect(summary.reviewRounds.distribution.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0]);
  });
});
