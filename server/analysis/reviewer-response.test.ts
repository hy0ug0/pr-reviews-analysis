import { describe, expect, test } from "bun:test";
import type {
  PRComment,
  PRReview,
  PullRequest,
  ReviewRequestEvent,
  ReviewState,
} from "../../shared/types.ts";
import { toParticipantRules, type ParticipantOptions } from "./participants.ts";
import {
  collectReviewerResponses,
  summarizeReviewerResponses,
  type ReviewerResponseSample,
} from "./reviewer-response.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function requested(createdAt: string, reviewer: string): ReviewRequestEvent {
  return { kind: "requested", createdAt, reviewer: toReviewer(reviewer) };
}

function removed(createdAt: string, reviewer: string): ReviewRequestEvent {
  return { kind: "removed", createdAt, reviewer: toReviewer(reviewer) };
}

// "team:org/slug", "bot:login" or a user login.
function toReviewer(reviewer: string): ReviewRequestEvent["reviewer"] {
  if (reviewer.startsWith("team:")) return { kind: "team", slug: reviewer.slice(5) };
  if (reviewer.startsWith("bot:")) return { kind: "bot", login: reviewer.slice(4) };
  return { kind: "user", login: reviewer };
}

function review(submittedAt: string, by: string, state: ReviewState = "COMMENTED"): PRReview {
  return {
    author: { login: by, __typename: by.endsWith("[bot]") ? "Bot" : "User" },
    state,
    submittedAt,
  };
}

function comment(createdAt: string, by: string): PRComment {
  return {
    author: { login: by, __typename: by.endsWith("[bot]") ? "Bot" : "User" },
    createdAt,
  };
}

function makePR({
  author = "erin",
  state = "MERGED",
  createdAt = "2026-03-02T09:00:00Z",
  closedAt = state === "OPEN" ? null : "2026-03-20T09:00:00Z",
  isDraft = false,
  readyForReviewAt = null,
  events = [],
  moreEvents = false,
  reviews = [],
  comments = [],
  moreComments = false,
}: {
  author?: string;
  state?: PullRequest["state"];
  createdAt?: string;
  closedAt?: string | null;
  isDraft?: boolean;
  readyForReviewAt?: string | null;
  events?: ReviewRequestEvent[];
  // Whether GitHub has review request events past the fetched page.
  moreEvents?: boolean;
  reviews?: PRReview[];
  comments?: PRComment[];
  moreComments?: boolean;
}): PullRequest {
  return {
    repo: "acme/widgets",
    number: 1,
    title: "Widget change",
    state,
    url: "https://github.com/acme/widgets/pull/1",
    createdAt,
    updatedAt: closedAt ?? createdAt,
    mergedAt: state === "MERGED" ? closedAt : null,
    closedAt,
    isDraft,
    readyForReviewAt,
    author: { login: author, __typename: "User" },
    reviews: { nodes: reviews },
    comments: { pageInfo: { hasNextPage: moreComments }, nodes: comments },
    reviewRequests: { pageInfo: { hasNextPage: moreEvents }, nodes: events },
  };
}

function collect(pr: PullRequest, options: ParticipantOptions = {}): ReviewerResponseSample[] {
  return collectReviewerResponses({ pr, ...toParticipantRules(options) });
}

// [login, duration] pairs, in response order.
function durations(pr: PullRequest, options: ParticipantOptions = {}): Array<[string, number]> {
  return collect(pr, options).map((sample) => [sample.login, sample.durationMs]);
}

// Timelines from real PRs, trimmed to the review requests, responses and bots that matter.
// Names and dates are changed on all but the public nodejs/node ones; intervals are kept.
describe("collectReviewerResponses on real timelines", () => {
  // A team and three people requested at creation; one of them re-requested twice.
  const teamPlusThree = makePR({
    author: "erin",
    createdAt: "2026-01-05T09:00:00Z",
    closedAt: "2026-01-09T10:29:16Z",
    events: [
      requested("2026-01-05T09:00:01Z", "team:acme/frontend"),
      requested("2026-01-05T09:00:23Z", "carol"),
      requested("2026-01-05T09:00:24Z", "alice"),
      requested("2026-01-05T09:00:24Z", "dave"),
      requested("2026-01-05T09:25:54Z", "alice"),
      requested("2026-01-06T01:15:00Z", "alice"),
    ],
    reviews: [
      review("2026-01-05T09:04:20Z", "alice", "CHANGES_REQUESTED"),
      review("2026-01-05T09:41:21Z", "alice", "APPROVED"),
      review("2026-01-09T03:32:27Z", "alice", "APPROVED"),
      review("2026-01-09T03:57:14Z", "bob", "APPROVED"),
    ],
    comments: [comment("2026-01-06T06:14:28Z", "erin")],
  });

  test("team plus three people, one re-requested twice: each re-request is a round, and the team goes to the member who answered it", () => {
    expect(durations(teamPlusThree)).toEqual([
      ["alice", 3 * MINUTE + 56 * SECOND],
      ["alice", 15 * MINUTE + 27 * SECOND],
      ["alice", 3 * DAY + 2 * HOUR + 17 * MINUTE + 27 * SECOND],
      // alice answered her own requests, so the team request waits for bob (≈ 91 h).
      ["bob", 3 * DAY + 18 * HOUR + 57 * MINUTE + 13 * SECOND],
    ]);
  });

  // The team was asked during the draft, people after it.
  const teamAskedInDraft = makePR({
    author: "erin",
    createdAt: "2026-01-12T09:00:00Z",
    readyForReviewAt: "2026-02-06T00:32:07Z",
    closedAt: "2026-02-06T05:48:13Z",
    events: [
      requested("2026-01-13T00:26:39Z", "team:acme/billing"),
      requested("2026-02-06T03:46:38Z", "alice"),
      requested("2026-02-06T03:46:39Z", "bob"),
      requested("2026-02-06T05:44:48Z", "alice"),
    ],
    reviews: [
      review("2026-02-06T00:38:48Z", "review-assistant[bot]"),
      review("2026-02-06T00:40:51Z", "alice", "DISMISSED"),
      review("2026-02-06T00:42:50Z", "bob"),
      review("2026-02-06T01:23:59Z", "alice"),
      review("2026-02-06T01:37:53Z", "erin"),
      review("2026-02-06T03:57:26Z", "alice", "DISMISSED"),
      review("2026-02-06T04:26:41Z", "review-assistant[bot]"),
      review("2026-02-06T05:46:10Z", "alice", "APPROVED"),
    ],
    comments: [
      comment("2026-01-15T22:15:35Z", "alice"),
      comment("2026-01-15T22:16:04Z", "erin"),
      comment("2026-01-15T23:23:09Z", "alice"),
      comment("2026-02-06T00:33:21Z", "github-actions[bot]"),
      comment("2026-02-06T05:45:25Z", "alice"),
    ],
  });

  test("team asked during the draft: the request starts when the PR is ready", () => {
    expect(durations(teamAskedInDraft)).toEqual([
      // 9 minutes from ready for review, not 24 days from the request; draft comments don't
      // answer it. The DISMISSED review counts.
      ["alice", 8 * MINUTE + 44 * SECOND],
      // Re-requested after responding: two more rounds. bob reviewed before being
      // asked and never after, so his request gives no sample.
      ["alice", 10 * MINUTE + 48 * SECOND],
      ["alice", 37 * SECOND],
    ]);
  });

  // A team asked during the draft, then one of its members.
  const memberAskedAfterTeam = makePR({
    author: "erin",
    createdAt: "2026-01-19T09:00:00Z",
    readyForReviewAt: "2026-01-20T00:47:56Z",
    closedAt: "2026-01-20T08:00:45Z",
    events: [
      requested("2026-01-19T09:00:04Z", "team:acme/frontend"),
      requested("2026-01-20T02:43:23Z", "alice"),
    ],
    reviews: [
      review("2026-01-20T00:41:43Z", "alice", "DISMISSED"),
      review("2026-01-20T00:53:42Z", "review-assistant[bot]"),
      review("2026-01-20T07:45:59Z", "alice", "APPROVED"),
    ],
  });

  test("team asked during the draft, then a member: the member's own request takes precedence over the team's", () => {
    // The draft review answers nothing, the approval answers alice's own request, and the
    // team request stays unanswered.
    expect(durations(memberAskedAfterTeam)).toEqual([
      ["alice", 5 * HOUR + 2 * MINUTE + 36 * SECOND],
    ]);
  });

  test("a later review by someone who passed on the team request doesn't answer it", () => {
    const pr = {
      ...memberAskedAfterTeam,
      state: "OPEN" as const,
      closedAt: null,
      reviews: {
        nodes: [
          ...memberAskedAfterTeam.reviews.nodes,
          review("2026-01-21T03:08:16Z", "alice", "COMMENTED"),
          review("2026-01-21T04:08:16Z", "bob", "APPROVED"),
        ],
      },
    };

    expect(durations(pr)).toEqual([
      ["alice", 5 * HOUR + 2 * MINUTE + 36 * SECOND],
      // From ready for review to the first response by a member who hadn't responded yet.
      ["bob", 1 * DAY + 3 * HOUR + 20 * MINUTE + 20 * SECOND],
    ]);
  });

  // The team request was removed 29 s after it was made.
  const teamRemoved = makePR({
    author: "erin",
    state: "OPEN",
    createdAt: "2026-01-26T09:00:00Z",
    events: [
      requested("2026-01-31T23:18:50Z", "team:acme/platform"),
      requested("2026-01-31T23:19:12Z", "carol"),
      requested("2026-01-31T23:19:12Z", "dave"),
      removed("2026-01-31T23:19:19Z", "team:acme/platform"),
    ],
    reviews: [
      review("2026-01-26T09:00:24Z", "renovate-approve[bot]", "DISMISSED"),
      review("2026-02-23T07:08:16Z", "renovate-approve[bot]", "APPROVED"),
    ],
    comments: [comment("2026-02-15T07:32:26Z", "ci-runner[bot]")],
  });

  test("a team request removed seconds after it was made credits nobody, and bots answer nothing", () => {
    expect(durations(teamRemoved)).toEqual([]);

    const withMemberReview = {
      ...teamRemoved,
      reviews: { nodes: [review("2026-02-01T19:29:42Z", "bob", "APPROVED")] },
    };
    expect(durations(withMemberReview)).toEqual([]);
  });

  // nodejs/node#66298: 16 comments, 10 fetched; the last fetched one is at 09-27 16:46:08.
  const node66298 = makePR({
    author: "jasnell",
    createdAt: "2026-09-25T19:02:26Z",
    closedAt: "2026-09-28T04:22:58Z",
    events: [
      requested("2026-09-25T19:02:26Z", "mcollina"),
      requested("2026-09-25T19:02:26Z", "ronag"),
      requested("2026-09-25T19:02:26Z", "trivikr"),
      requested("2026-09-25T19:28:13Z", "aduh95"),
      requested("2026-09-25T19:37:43Z", "Renegade334"),
      requested("2026-09-26T23:23:28Z", "addaleax"),
      requested("2026-09-27T11:15:20Z", "Renegade334"),
      requested("2026-09-27T11:15:22Z", "panva"),
    ],
    reviews: [
      review("2026-09-25T19:29:00Z", "Renegade334"),
      review("2026-09-25T19:33:03Z", "jasnell"),
      review("2026-09-25T19:40:32Z", "Renegade334", "APPROVED"),
      review("2026-09-25T19:46:25Z", "panva", "APPROVED"),
      review("2026-09-25T19:46:46Z", "Renegade334", "APPROVED"),
      review("2026-09-26T21:05:04Z", "addaleax", "CHANGES_REQUESTED"),
      review("2026-09-27T08:19:06Z", "panva"),
      review("2026-09-27T11:17:56Z", "panva", "APPROVED"),
      review("2026-09-27T11:32:30Z", "ronag", "APPROVED"),
      review("2026-09-27T21:02:40Z", "addaleax", "APPROVED"),
    ],
    comments: [
      comment("2026-09-25T19:02:31Z", "nodejs-github-bot"),
      comment("2026-09-25T19:08:14Z", "aduh95"),
      comment("2026-09-25T19:09:12Z", "jasnell"),
      comment("2026-09-25T19:43:02Z", "nodejs-github-bot"),
      comment("2026-09-25T21:47:53Z", "codecov[bot]"),
      comment("2026-09-26T21:11:34Z", "jasnell"),
      comment("2026-09-26T21:49:52Z", "addaleax"),
      comment("2026-09-26T22:45:49Z", "jasnell"),
      comment("2026-09-27T11:14:44Z", "jasnell"),
      comment("2026-09-27T16:46:08Z", "nodejs-github-bot"),
    ],
    moreComments: true,
  });

  test("node#66298: responses before a request answer nothing; responses past the comment page are dropped", () => {
    expect(durations(node66298)).toEqual([
      // Renegade334's 19:29 review came before he was asked.
      ["Renegade334", 2 * MINUTE + 49 * SECOND],
      ["panva", 2 * MINUTE + 34 * SECOND],
      ["ronag", 1 * DAY + 16 * HOUR + 30 * MINUTE + 4 * SECOND],
      // addaleax's approval at 21:02 is past the last fetched comment: an unseen comment by
      // her may have come first. aduh95 commented before being asked and never after.
    ]);
  });

  // nodejs/node#65986: requested, removed and requested again within 14 s.
  const node65986 = makePR({
    author: "mcollina",
    createdAt: "2026-09-11T15:37:23Z",
    closedAt: "2026-09-18T05:37:19Z",
    events: [
      requested("2026-09-11T15:37:59Z", "ronag"),
      removed("2026-09-11T15:38:09Z", "ronag"),
      requested("2026-09-11T15:38:13Z", "ronag"),
    ],
    reviews: [
      review("2026-09-11T16:06:00Z", "ronag", "APPROVED"),
      review("2026-09-11T18:34:18Z", "jasnell", "APPROVED"),
    ],
    comments: [comment("2026-09-11T16:47:57Z", "trevnorris")],
  });

  test("node#65986: a removal closes the clock and the new request starts another", () => {
    expect(durations(node65986)).toEqual([["ronag", 27 * MINUTE + 47 * SECOND]]);
  });
});

describe("collectReviewerResponses rules", () => {
  const CREATED = "2026-03-02T09:00:00Z";

  test("gives no sample for a draft", () => {
    const pr = makePR({
      state: "OPEN",
      isDraft: true,
      events: [requested(CREATED, "bob")],
      reviews: [review("2026-03-02T10:00:00Z", "bob")],
    });

    expect(collect(pr)).toEqual([]);
  });

  test("counts a conversation comment as a response and returns its time", () => {
    const pr = makePR({
      events: [requested(CREATED, "bob")],
      comments: [comment("2026-03-02T09:30:00Z", "bob")],
    });

    expect(collect(pr)).toEqual([
      { login: "bob", durationMs: 30 * MINUTE, respondedAt: Date.parse("2026-03-02T09:30:00Z") },
    ]);
  });

  test("ignores pending reviews and responses after the PR closed", () => {
    const pr = makePR({
      closedAt: "2026-03-03T09:00:00Z",
      events: [requested(CREATED, "bob"), requested(CREATED, "carol")],
      reviews: [
        { author: { login: "bob", __typename: "User" }, state: "PENDING", submittedAt: null },
        review("2026-03-04T09:00:00Z", "carol"),
      ],
    });

    expect(collect(pr)).toEqual([]);
  });

  test("answers a request with a response at the same second", () => {
    const pr = makePR({
      events: [requested("2026-03-02T10:00:00Z", "bob")],
      reviews: [review("2026-03-02T10:00:00Z", "bob")],
    });

    expect(durations(pr)).toEqual([["bob", 0]]);
  });

  test("keeps the first request while it is pending", () => {
    const pr = makePR({
      events: [requested("2026-03-02T10:00:00Z", "bob"), requested("2026-03-02T12:00:00Z", "bob")],
      reviews: [review("2026-03-02T13:00:00Z", "bob")],
    });

    expect(durations(pr)).toEqual([["bob", 3 * HOUR]]);
  });

  test("gives no sample for a removed request, even if the reviewer responds later", () => {
    const pr = makePR({
      events: [requested("2026-03-02T10:00:00Z", "bob"), removed("2026-03-02T11:00:00Z", "bob")],
      reviews: [review("2026-03-02T12:00:00Z", "bob")],
    });

    expect(collect(pr)).toEqual([]);
  });

  test("credits a team request once, to the first member to respond", () => {
    const pr = makePR({
      events: [requested("2026-03-02T10:00:00Z", "team:acme/core")],
      reviews: [review("2026-03-02T11:00:00Z", "bob"), review("2026-03-02T12:00:00Z", "carol")],
    });

    expect(durations(pr)).toEqual([["bob", HOUR]]);
  });

  test("answers the earliest open team request first, and a member answers only one", () => {
    const pr = makePR({
      events: [
        requested("2026-03-02T10:00:00Z", "team:acme/core"),
        requested("2026-03-02T10:30:00Z", "team:acme/docs"),
      ],
      reviews: [
        review("2026-03-02T11:00:00Z", "bob"),
        review("2026-03-02T12:00:00Z", "bob"),
        review("2026-03-02T13:00:00Z", "carol"),
      ],
    });

    expect(durations(pr)).toEqual([
      ["bob", HOUR],
      ["carol", 2 * HOUR + 30 * MINUTE],
    ]);
  });

  test("opens a new team clock when the team is requested again after an answer", () => {
    const pr = makePR({
      events: [
        requested("2026-03-02T10:00:00Z", "team:acme/core"),
        requested("2026-03-02T14:00:00Z", "team:acme/core"),
      ],
      reviews: [review("2026-03-02T11:00:00Z", "bob"), review("2026-03-02T15:00:00Z", "bob")],
    });

    expect(durations(pr)).toEqual([
      ["bob", HOUR],
      ["bob", HOUR],
    ]);
  });

  test("matches team slugs and logins case-insensitively", () => {
    const pr = makePR({
      events: [
        requested("2026-03-02T10:00:00Z", "team:Acme/Core"),
        removed("2026-03-02T10:01:00Z", "team:acme/core"),
        requested("2026-03-02T10:02:00Z", "Bob"),
      ],
      reviews: [review("2026-03-02T11:00:00Z", "bob"), review("2026-03-02T12:00:00Z", "carol")],
    });

    expect(durations(pr)).toEqual([["bob", 58 * MINUTE]]);
  });

  test("skips requests to the author, to hidden reviewers and to bots unless bots are included", () => {
    const pr = makePR({
      author: "erin",
      events: [
        requested("2026-03-02T10:00:00Z", "Erin"),
        { kind: "requested", createdAt: "2026-03-02T10:00:00Z", reviewer: null },
        requested("2026-03-02T10:00:00Z", "bot:copilot-pull-request-reviewer"),
      ],
      reviews: [
        review("2026-03-02T11:00:00Z", "erin"),
        {
          author: { login: "copilot-pull-request-reviewer", __typename: "Bot" },
          state: "COMMENTED",
          submittedAt: "2026-03-02T10:05:00Z",
        },
      ],
    });

    expect(durations(pr)).toEqual([]);
    expect(durations(pr, { includeBots: true })).toEqual([
      ["copilot-pull-request-reviewer", 5 * MINUTE],
    ]);
  });

  test("with a team filter, skips requests to and responses by people outside it", () => {
    const pr = makePR({
      events: [
        requested("2026-03-02T10:00:00Z", "bob"),
        requested("2026-03-02T10:00:00Z", "team:acme/core"),
      ],
      reviews: [review("2026-03-02T11:00:00Z", "bob"), review("2026-03-02T12:00:00Z", "carol")],
    });

    expect(durations(pr, { teamMembers: ["Carol"] })).toEqual([["carol", 2 * HOUR]]);
  });

  test("drops responses after the last fetched event when more events exist", () => {
    const pr = makePR({
      events: [
        requested("2026-03-02T10:00:00Z", "bob"),
        requested("2026-03-02T10:00:00Z", "carol"),
      ],
      moreEvents: true,
      reviews: [review("2026-03-02T10:00:00Z", "bob"), review("2026-03-02T11:00:00Z", "carol")],
    });

    expect(durations(pr)).toEqual([["bob", 0]]);
  });
});

describe("summarizeReviewerResponses", () => {
  test("takes p50 and p90 over every sample of a reviewer, keyed by lowercased login", () => {
    const prs = [1, 2, 3, 4].map((hours) =>
      makePR({
        events: [requested("2026-03-02T10:00:00Z", "Bob")],
        reviews: [
          review(new Date(Date.parse("2026-03-02T10:00:00Z") + hours * HOUR).toISOString(), "Bob"),
        ],
      }),
    );

    expect(summarizeReviewerResponses({ prs })).toEqual(
      new Map([
        ["bob", { responseP50Ms: 2.5 * HOUR, responseP90Ms: 3.7 * HOUR, responseSamples: 4 }],
      ]),
    );
  });
});
