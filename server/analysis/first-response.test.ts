import { describe, expect, test } from "bun:test";
import {
  COMMENTS_PAGE_SIZE,
  type PRComment,
  type PRReview,
  type PullRequest,
  type ReviewState,
} from "../../shared/types.ts";
import {
  classifyFirstResponse,
  responseStart,
  summarizeFirstResponse,
  type FirstResponseOutcome,
} from "./first-response.ts";
import { toParticipantRules } from "./participants.ts";
import { percentile, weekStart } from "./stats.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

function comment({
  by,
  createdAt,
  type = "User",
}: {
  by: string | null;
  createdAt: string;
  type?: string;
}): PRComment {
  return { author: by === null ? null : { login: by, __typename: type }, createdAt };
}

function makePR({
  number = 1,
  author = "alice",
  state = "OPEN",
  createdAt = CREATED_AT,
  closedAt = null,
  isDraft = false,
  readyForReviewAt = null,
  reviews = [],
  comments = [],
  moreComments = false,
}: {
  number?: number;
  author?: string;
  state?: PullRequest["state"];
  createdAt?: string;
  closedAt?: string | null;
  isDraft?: boolean;
  readyForReviewAt?: string | null;
  reviews?: PRReview[];
  comments?: PRComment[];
  // Whether GitHub has comments past the fetched page.
  moreComments?: boolean;
}): PullRequest {
  return {
    repo: "acme/widgets",
    number,
    title: `Widget change #${number}`,
    state,
    url: `https://github.com/acme/widgets/pull/${number}`,
    createdAt,
    updatedAt: closedAt ?? createdAt,
    mergedAt: state === "MERGED" ? closedAt : null,
    closedAt,
    isDraft,
    readyForReviewAt,
    author: { login: author, __typename: "User" },
    reviews: { nodes: reviews },
    comments: { pageInfo: { hasNextPage: moreComments }, nodes: comments },
  };
}

function classify(pr: PullRequest, teamMembers?: string[]): FirstResponseOutcome {
  return classifyFirstResponse({ pr, ...toParticipantRules({ teamMembers }) });
}

function respondedAfter(outcome: FirstResponseOutcome): number | null {
  return outcome.kind === "responded" ? outcome.respondedAt - outcome.startedAt : null;
}

// A PR created at `createdAt` that got its only response `ms` later.
function respondedPR(createdAt: string, ms: number, number = 1): PullRequest {
  return makePR({
    number,
    createdAt,
    reviews: [review({ by: "bob", submittedAt: new Date(at(createdAt) + ms).toISOString() })],
  });
}

describe("responseStart", () => {
  test("is createdAt when the PR has no ready-for-review event", () => {
    expect(responseStart(makePR({ readyForReviewAt: null }))).toBe(at(CREATED_AT));
  });

  test("is the ready-for-review event when the PR started as a draft", () => {
    expect(responseStart(makePR({ readyForReviewAt: "2026-03-04T09:00:00Z" }))).toBe(
      at("2026-03-04T09:00:00Z"),
    );
  });

  test("never goes before createdAt", () => {
    expect(responseStart(makePR({ readyForReviewAt: "2026-03-01T09:00:00Z" }))).toBe(
      at(CREATED_AT),
    );
  });
});

describe("classifyFirstResponse", () => {
  test("measures from the ready-for-review event, not creation", () => {
    const outcome = classify(
      makePR({
        readyForReviewAt: "2026-03-05T09:00:00Z",
        reviews: [review({ by: "bob", submittedAt: "2026-03-05T11:00:00Z" })],
      }),
    );

    expect(outcome).toEqual({
      kind: "responded",
      startedAt: at("2026-03-05T09:00:00Z"),
      respondedAt: at("2026-03-05T11:00:00Z"),
    });
  });

  test("reports PRs still in draft as drafts, even with reviews", () => {
    const outcome = classify(
      makePR({
        isDraft: true,
        reviews: [review({ by: "bob", submittedAt: "2026-03-02T10:00:00Z" })],
      }),
    );

    expect(outcome).toEqual({ kind: "draft" });
  });

  test("ignores reviews and comments by the PR author, whatever the casing", () => {
    const outcome = classify(
      makePR({
        author: "alice",
        reviews: [review({ by: "Alice", submittedAt: "2026-03-02T10:00:00Z" })],
        comments: [comment({ by: "alice", createdAt: "2026-03-02T10:30:00Z" })],
      }),
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("ignores bots by __typename and by the [bot] login suffix", () => {
    const outcome = classify(
      makePR({
        reviews: [
          review({
            by: "copilot-pull-request-reviewer",
            type: "Bot",
            submittedAt: "2026-03-02T09:10:00Z",
          }),
        ],
        comments: [
          comment({ by: "changeset-bot", type: "Bot", createdAt: "2026-03-02T09:01:00Z" }),
          comment({ by: "renovate[bot]", createdAt: "2026-03-02T09:02:00Z" }),
          comment({ by: "bob", createdAt: "2026-03-02T12:00:00Z" }),
        ],
      }),
    );

    expect(respondedAfter(outcome)).toBe(3 * HOUR);
  });

  test("counts bots as responders when bots are included", () => {
    const outcome = classifyFirstResponse({
      pr: makePR({
        comments: [comment({ by: "renovate[bot]", createdAt: "2026-03-02T09:02:00Z" })],
      }),
      ...toParticipantRules({ includeBots: true }),
    });

    expect(respondedAfter(outcome)).toBe(2 * 60 * 1000);
  });

  test("ignores users on the configured bot list", () => {
    const outcome = classifyFirstResponse({
      pr: makePR({
        comments: [
          comment({ by: "CI-User", createdAt: "2026-03-02T09:02:00Z" }),
          comment({ by: "bob", createdAt: "2026-03-02T10:00:00Z" }),
        ],
      }),
      ...toParticipantRules({ botLogins: ["ci-user"] }),
    });

    expect(respondedAfter(outcome)).toBe(HOUR);
  });

  test("ignores reviews and comments whose author GitHub can't resolve", () => {
    const outcome = classify(
      makePR({
        reviews: [review({ by: null, submittedAt: "2026-03-02T10:00:00Z" })],
        comments: [comment({ by: null, createdAt: "2026-03-02T10:00:00Z" })],
      }),
    );

    expect(outcome.kind).toBe("waiting");
  });

  test("takes a comment when it comes before the first review", () => {
    const outcome = classify(
      makePR({
        reviews: [review({ by: "bob", submittedAt: "2026-03-02T15:00:00Z" })],
        comments: [comment({ by: "carol", createdAt: "2026-03-02T11:00:00Z" })],
      }),
    );

    expect(respondedAfter(outcome)).toBe(2 * HOUR);
  });

  test("takes a review when it comes before the first comment", () => {
    const outcome = classify(
      makePR({
        reviews: [review({ by: "bob", submittedAt: "2026-03-02T10:00:00Z" })],
        comments: [comment({ by: "carol", createdAt: "2026-03-02T11:00:00Z" })],
      }),
    );

    expect(respondedAfter(outcome)).toBe(HOUR);
  });

  test("uses the earliest review even when reviews are out of order", () => {
    const outcome = classify(
      makePR({
        reviews: [
          review({ by: "bob", submittedAt: "2026-03-02T15:00:00Z" }),
          review({ by: "carol", submittedAt: "2026-03-02T13:00:00Z" }),
        ],
      }),
    );

    expect(respondedAfter(outcome)).toBe(4 * HOUR);
  });

  test("ignores responses given before the start, while the PR was a draft", () => {
    const pr = makePR({
      readyForReviewAt: "2026-03-05T09:00:00Z",
      reviews: [review({ by: "bob", submittedAt: "2026-03-03T09:00:00Z" })],
      comments: [comment({ by: "carol", createdAt: "2026-03-04T09:00:00Z" })],
    });

    expect(classify(pr).kind).toBe("waiting");
    expect(
      respondedAfter(
        classify({
          ...pr,
          comments: {
            ...pr.comments,
            nodes: [
              ...pr.comments.nodes,
              comment({ by: "dave", createdAt: "2026-03-05T10:00:00Z" }),
            ],
          },
        }),
      ),
    ).toBe(HOUR);
  });

  test("ignores PENDING reviews and counts DISMISSED ones", () => {
    const pending = classify(
      makePR({ reviews: [review({ by: "bob", state: "PENDING", submittedAt: null })] }),
    );
    const dismissed = classify(
      makePR({
        reviews: [review({ by: "bob", state: "DISMISSED", submittedAt: "2026-03-02T10:00:00Z" })],
      }),
    );

    expect(pending.kind).toBe("waiting");
    expect(respondedAfter(dismissed)).toBe(HOUR);
  });

  test("counts only team members when a team filter is set, matching case-insensitively", () => {
    const pr = makePR({
      reviews: [
        review({ by: "outsider", submittedAt: "2026-03-02T10:00:00Z" }),
        review({ by: "Bob", submittedAt: "2026-03-02T12:00:00Z" }),
      ],
      comments: [comment({ by: "another-outsider", createdAt: "2026-03-02T09:30:00Z" })],
    });

    expect(respondedAfter(classify(pr, ["bOB"]))).toBe(3 * HOUR);
    expect(classify(pr, ["carol"]).kind).toBe("waiting");
    expect(respondedAfter(classify(pr, []))).toBe(HOUR / 2);
  });

  test("splits PRs without a response into still waiting and closed", () => {
    expect(classify(makePR({ state: "OPEN" })).kind).toBe("waiting");
    expect(classify(makePR({ state: "MERGED", closedAt: "2026-03-03T09:00:00Z" })).kind).toBe(
      "closedWithoutResponse",
    );
    expect(classify(makePR({ state: "CLOSED", closedAt: "2026-03-03T09:00:00Z" })).kind).toBe(
      "closedWithoutResponse",
    );
  });

  test("ignores responses after the PR closed", () => {
    const outcome = classify(
      makePR({
        state: "MERGED",
        closedAt: "2026-03-03T09:00:00Z",
        comments: [comment({ by: "bob", createdAt: "2026-03-04T09:00:00Z" })],
      }),
    );

    expect(outcome.kind).toBe("closedWithoutResponse");
  });

  describe("when GitHub has more comments than were fetched", () => {
    const botComments = Array.from({ length: COMMENTS_PAGE_SIZE }, (_, index) =>
      comment({
        by: "vercel",
        type: "Bot",
        createdAt: new Date(at(CREATED_AT) + (index + 1) * HOUR).toISOString(),
      }),
    );
    const lastFetchedCommentAt = at(CREATED_AT) + COMMENTS_PAGE_SIZE * HOUR;

    test("is undetermined when no fetched comment qualifies and nothing came first", () => {
      expect(classify(makePR({ comments: botComments, moreComments: true })).kind).toBe(
        "undetermined",
      );
    });

    test("is undetermined when the only review comes after the last fetched comment", () => {
      const outcome = classify(
        makePR({
          comments: botComments,
          moreComments: true,
          reviews: [
            review({
              by: "bob",
              submittedAt: new Date(lastFetchedCommentAt + HOUR).toISOString(),
            }),
          ],
        }),
      );

      expect(outcome.kind).toBe("undetermined");
    });

    test("uses a review that comes before the last fetched comment", () => {
      const outcome = classify(
        makePR({
          comments: botComments,
          moreComments: true,
          reviews: [review({ by: "bob", submittedAt: "2026-03-02T11:30:00Z" })],
        }),
      );

      expect(respondedAfter(outcome)).toBe(2.5 * HOUR);
    });

    test("is closed without response when the PR closed before the last fetched comment", () => {
      const outcome = classify(
        makePR({
          state: "CLOSED",
          closedAt: new Date(lastFetchedCommentAt - HOUR).toISOString(),
          comments: botComments,
          moreComments: true,
        }),
      );

      expect(outcome.kind).toBe("closedWithoutResponse");
    });

    test("is undetermined when the PR closed at the exact time of the last fetched comment", () => {
      // An unseen comment at that same instant would still count, as isInWindow is inclusive.
      const outcome = classify(
        makePR({
          state: "CLOSED",
          closedAt: new Date(lastFetchedCommentAt).toISOString(),
          comments: botComments,
          moreComments: true,
        }),
      );

      expect(outcome.kind).toBe("undetermined");
    });

    test("is never undetermined when the full page holds every comment", () => {
      const outcome = classify(
        makePR({
          comments: botComments,
          moreComments: false,
          reviews: [
            review({
              by: "bob",
              submittedAt: new Date(lastFetchedCommentAt + HOUR).toISOString(),
            }),
          ],
        }),
      );

      expect(respondedAfter(outcome)).toBe((COMMENTS_PAGE_SIZE + 1) * HOUR);
      expect(classify(makePR({ comments: botComments, moreComments: false })).kind).toBe("waiting");
    });
  });
});

describe("percentile", () => {
  test("returns null for no values", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  test("returns the only value for every p", () => {
    expect([0, 0.5, 0.9, 1].map((p) => percentile([7], p))).toEqual([7, 7, 7, 7]);
  });

  test("interpolates between closest ranks", () => {
    const values = [1, 2, 3, 4];

    expect(percentile(values, 0.5)).toBe(2.5);
    expect(percentile(values, 0.75)).toBe(3.25);
    expect(percentile(values, 0.9)).toBeCloseTo(3.7, 10);
  });

  test("returns the middle value for an odd count and the extremes at 0 and 1", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];

    expect(percentile(values, 0.5)).toBe(60);
    expect(percentile(values, 0.9)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 1)).toBe(110);
  });
});

describe("weekStart", () => {
  test("puts Sunday 23:59 and the next Monday 00:00 UTC in different weeks", () => {
    expect(weekStart(at("2026-03-08T23:59:59Z"))).toBe(at("2026-03-02T00:00:00Z"));
    expect(weekStart(at("2026-03-09T00:00:00Z"))).toBe(at("2026-03-09T00:00:00Z"));
  });
});

describe("summarizeFirstResponse", () => {
  test("returns zero counts, null percentiles and empty buckets for no PRs", () => {
    const summary = summarizeFirstResponse({ prs: [] });

    expect(summary).toMatchObject({
      respondedPRs: 0,
      waitingPRs: 0,
      closedWithoutResponsePRs: 0,
      draftPRs: 0,
      undeterminedPRs: 0,
      p50Ms: null,
      p75Ms: null,
      p90Ms: null,
      weekly: [],
    });
    expect(summary.histogram.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test("counts each outcome and computes percentiles over responded PRs only", () => {
    const summary = summarizeFirstResponse({
      prs: [
        respondedPR(CREATED_AT, 1 * HOUR, 1),
        respondedPR(CREATED_AT, 2 * HOUR, 2),
        respondedPR(CREATED_AT, 3 * HOUR, 3),
        respondedPR(CREATED_AT, 4 * HOUR, 4),
        makePR({ number: 5, state: "OPEN" }),
        makePR({ number: 6, state: "CLOSED", closedAt: "2026-03-03T09:00:00Z" }),
        makePR({ number: 7, isDraft: true }),
      ],
    });

    expect(summary).toMatchObject({
      respondedPRs: 4,
      waitingPRs: 1,
      closedWithoutResponsePRs: 1,
      draftPRs: 1,
      undeterminedPRs: 0,
      p50Ms: 2.5 * HOUR,
      p75Ms: 3.25 * HOUR,
      p90Ms: 3.7 * HOUR,
    });
  });

  test("puts each duration in the bucket whose lower bound it reaches", () => {
    const durations = [0, HOUR - 1, HOUR, 4 * HOUR, DAY, 2 * DAY, 7 * DAY - 1, 7 * DAY, 30 * DAY];
    const summary = summarizeFirstResponse({
      prs: durations.map((ms, index) => respondedPR(CREATED_AT, ms, index + 1)),
    });

    expect(summary.histogram).toEqual([
      { label: "< 1h", minMs: 0, maxMs: HOUR, count: 2 },
      { label: "1–4h", minMs: HOUR, maxMs: 4 * HOUR, count: 1 },
      { label: "4–24h", minMs: 4 * HOUR, maxMs: DAY, count: 1 },
      { label: "1–2d", minMs: DAY, maxMs: 2 * DAY, count: 1 },
      { label: "2–7d", minMs: 2 * DAY, maxMs: 7 * DAY, count: 2 },
      { label: "> 7d", minMs: 7 * DAY, maxMs: null, count: 2 },
    ]);
  });

  test("buckets PRs by the Monday UTC of their start and leaves empty weeks as gaps", () => {
    const summary = summarizeFirstResponse({
      prs: [
        // Sunday night: week of 2026-03-02.
        respondedPR("2026-03-08T23:00:00Z", 2 * HOUR, 1),
        respondedPR("2026-03-03T09:00:00Z", 4 * HOUR, 2),
        // Monday midnight: week of 2026-03-09.
        respondedPR("2026-03-09T00:00:00Z", 1 * HOUR, 3),
        // Nothing in the week of 2026-03-16.
        respondedPR("2026-03-25T09:00:00Z", 6 * HOUR, 4),
      ],
    });

    expect(summary.weekly).toEqual([
      { weekStart: "2026-03-02", p50Ms: 3 * HOUR, count: 2 },
      { weekStart: "2026-03-09", p50Ms: 1 * HOUR, count: 1 },
      { weekStart: "2026-03-16", p50Ms: null, count: 0 },
      { weekStart: "2026-03-23", p50Ms: 6 * HOUR, count: 1 },
    ]);
  });

  test("extends the weeks to cover the selected range", () => {
    const summary = summarizeFirstResponse({
      prs: [respondedPR("2026-03-10T09:00:00Z", HOUR)],
      since: "2026-03-01",
      until: "2026-03-17",
    });

    expect(summary.weekly.map((week) => [week.weekStart, week.count])).toEqual([
      ["2026-02-23", 0],
      ["2026-03-02", 0],
      ["2026-03-09", 1],
      ["2026-03-16", 0],
    ]);
  });

  test("applies the team filter", () => {
    const pr = makePR({
      reviews: [
        review({ by: "outsider", submittedAt: "2026-03-02T10:00:00Z" }),
        review({ by: "bob", submittedAt: "2026-03-02T11:00:00Z" }),
      ],
    });

    expect(summarizeFirstResponse({ prs: [pr] }).p50Ms).toBe(HOUR);
    expect(summarizeFirstResponse({ prs: [pr], teamMembers: ["bob"] }).p50Ms).toBe(2 * HOUR);
    expect(summarizeFirstResponse({ prs: [pr], teamMembers: ["carol"] })).toMatchObject({
      respondedPRs: 0,
      waitingPRs: 1,
    });
  });
});
