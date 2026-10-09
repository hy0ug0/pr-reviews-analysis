import { z } from "zod";
// Extensionless, unlike other server imports: the client typecheck reaches this file through
// shared/types.ts and does not allow .ts extensions.
import { COMMENTS_PAGE_SIZE } from "../shared/types";

// The pull request data model: what the GraphQL fragment selects, the schema GitHub's answer
// is parsed with, the PullRequest the analysis reads, and the normalizer between the two.
// A new field goes in the fragment and in one of the schemas below, with a
// PULL_REQUEST_CACHE_VERSION bump. Keep this module free of server-only imports:
// shared/types.ts re-exports its types for the client.

// Bump whenever PullRequest changes shape, so PR cache entries written in the old shape are
// never read. Version 2 PRs had no draft, timeline or comment fields; version 3 had no repo
// and kept review bodies; version 4 had no author __typename; version 5 had no review
// request events.
export const PULL_REQUEST_CACHE_VERSION = 6;

export const INLINE_REVIEW_PAGE_SIZE = 50;

// Review requests and removals per PR. The busiest of about 1,250 sampled PRs, including
// nodejs/node and microsoft/vscode ones, had 32, and the page size changes neither the query
// cost nor its time. A PR with more is marked partial, never cached.
// The connection's totalCount ignores itemTypes, so only hasNextPage tells.
export const REVIEW_REQUEST_EVENTS_PAGE_SIZE = 50;

// The review fields every query that returns reviews selects.
export const REVIEW_FIELDS = `
fragment ReviewFields on PullRequestReview {
  author { login __typename }
  state
  submittedAt
}`;

// Who a review request event targets: a person or a team. The requester (the event's
// actor) is not selected; no metric uses it.
const REQUESTED_REVIEWER_FIELDS = `
fragment RequestedReviewerFields on RequestedReviewer {
  __typename
  ... on User { login }
  ... on Bot { login }
  ... on Mannequin { login }
  ... on Team { combinedSlug }
  ... on EnterpriseTeam { combinedSlug }
}`;

// The PR fields every query that returns pull request data selects.
export const PULL_REQUEST_FIELDS = `
fragment PullRequestFields on PullRequest {
  number
  title
  state
  url
  createdAt
  updatedAt
  mergedAt
  closedAt
  isDraft
  author { login __typename }
  timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], first: 1) {
    nodes {
      ... on ReadyForReviewEvent { createdAt }
    }
  }
  reviewRequestEvents: timelineItems(
    itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]
    first: ${REVIEW_REQUEST_EVENTS_PAGE_SIZE}
  ) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ReviewRequestedEvent { createdAt requestedReviewer { ...RequestedReviewerFields } }
      ... on ReviewRequestRemovedEvent { createdAt requestedReviewer { ...RequestedReviewerFields } }
    }
  }
  reviews(first: ${INLINE_REVIEW_PAGE_SIZE}) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes { ...ReviewFields }
  }
  comments(first: ${COMMENTS_PAGE_SIZE}) {
    pageInfo { hasNextPage }
    nodes {
      author { login __typename }
      createdAt
    }
  }
}
${REVIEW_FIELDS}
${REQUESTED_REVIEWER_FIELDS}`;

// GitHub types connection items as nullable. None has been seen null, but one would fail
// the whole PR, so nulls are dropped instead.
function connectionNodes<T extends z.ZodType>(item: T) {
  return z
    .array(item.nullable())
    .transform((nodes) => nodes.filter((node): node is NonNullable<typeof node> => node !== null));
}

// `__typename` is "User" for people and "Bot" for GitHub Apps; GitHub also returns
// "Mannequin", "Organization" and "EnterpriseUserAccount" in rare cases. Null for deleted
// accounts.
const actorSchema = z.object({ login: z.string(), __typename: z.string() }).nullable();

const reviewSchema = z.object({
  author: actorSchema,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submittedAt: z.string().nullable(),
});

// A conversation comment on the PR (not an inline review comment).
const commentSchema = z.object({ author: actorSchema, createdAt: z.string() });

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

export const reviewConnectionSchema = z.object({
  pageInfo: pageInfoSchema,
  nodes: connectionNodes(reviewSchema),
});

// A requested reviewer as GitHub returns it. Mannequins stand in for users of imported repos.
const requestedReviewerNodeSchema = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.enum(["User", "Bot", "Mannequin"]), login: z.string() }),
  z.object({ __typename: z.enum(["Team", "EnterpriseTeam"]), combinedSlug: z.string() }),
]);

const reviewRequestEventNodeSchema = z.object({
  __typename: z.enum(["ReviewRequestedEvent", "ReviewRequestRemovedEvent"]),
  createdAt: z.string(),
  // Null when the token can't see the reviewer, typically a team on a public repo.
  requestedReviewer: requestedReviewerNodeSchema.nullable(),
});

// Who a review request targets, as PullRequest keeps it. Bots stay apart from users so the
// participant rules can decide on them.
const requestedReviewerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), login: z.string() }),
  z.object({ kind: z.literal("bot"), login: z.string() }),
  // `org/team-slug`.
  z.object({ kind: z.literal("team"), slug: z.string() }),
]);

const reviewRequestEventSchema = z.object({
  kind: z.enum(["requested", "removed"]),
  createdAt: z.string(),
  // Null when GitHub hides the reviewer.
  reviewer: requestedReviewerSchema.nullable(),
});

// Fields GitHub returns in the shape PullRequest keeps them.
const pullRequestFields = {
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  isDraft: z.boolean(),
  author: actorSchema,
};

// A PR node selected with the PullRequestFields fragment, carrying the first page of its
// reviews and its first ready-for-review event, if any.
export const pullRequestNodeSchema = z.object({
  ...pullRequestFields,
  // Items of other types come back as {}; the filter only returns ReadyForReviewEvent.
  timelineItems: z.object({
    nodes: connectionNodes(z.object({ createdAt: z.string().optional() })),
  }),
  reviews: reviewConnectionSchema,
  comments: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: connectionNodes(commentSchema),
  }),
  reviewRequestEvents: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: connectionNodes(reviewRequestEventNodeSchema),
  }),
});

// The one schema for a PullRequest, used to validate PR cache entries.
export const pullRequestSchema = z.object({
  // Normalized to lowercase, as listed.
  repo: z.string(),
  ...pullRequestFields,
  // When the PR first left draft; null if it never was a draft.
  readyForReviewAt: z.string().nullable(),
  // Every review, unless fetching the pages after the inline one failed: then hasNextPage is
  // true and only the inline reviews are here. Such a PR is never cached.
  reviews: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(reviewSchema),
  }),
  // The oldest COMMENTS_PAGE_SIZE comments at most; hasNextPage says whether more exist.
  comments: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(commentSchema),
  }),
  // Review requests and removals, oldest first: the first REVIEW_REQUEST_EVENTS_PAGE_SIZE at
  // most; hasNextPage says whether more exist.
  reviewRequests: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    nodes: z.array(reviewRequestEventSchema),
  }),
});

export type Actor = NonNullable<z.infer<typeof actorSchema>>;
export type ReviewState = z.infer<typeof reviewSchema>["state"];
export type PRReview = z.infer<typeof reviewSchema>;
export type PRComment = z.infer<typeof commentSchema>;
export type PageInfo = z.infer<typeof pageInfoSchema>;
export type RequestedReviewer = z.infer<typeof requestedReviewerSchema>;
export type ReviewRequestEvent = z.infer<typeof reviewRequestEventSchema>;
export type ReviewConnection = z.infer<typeof reviewConnectionSchema>;
export type PullRequestNode = z.infer<typeof pullRequestNodeSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;

// One line per issue, for partial reasons and logs.
export function describeSchemaError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

type RequestedReviewerNode = z.infer<typeof requestedReviewerNodeSchema>;
type ReviewRequestEventNode = z.infer<typeof reviewRequestEventNodeSchema>;

function toRequestedReviewer(node: RequestedReviewerNode): RequestedReviewer {
  switch (node.__typename) {
    case "User":
    case "Mannequin":
      return { kind: "user", login: node.login };
    case "Bot":
      return { kind: "bot", login: node.login };
    case "Team":
    case "EnterpriseTeam":
      return { kind: "team", slug: node.combinedSlug };
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function toReviewRequestEvent(node: ReviewRequestEventNode): ReviewRequestEvent {
  return {
    kind: node.__typename === "ReviewRequestedEvent" ? "requested" : "removed",
    createdAt: node.createdAt,
    reviewer: node.requestedReviewer === null ? null : toRequestedReviewer(node.requestedReviewer),
  };
}

// Drops the review cursor, flattens the ready-for-review event and normalizes the review
// request events so the result matches PullRequest. `repo` comes from the listing, since the
// fragment does not select it.
export function toPullRequest({
  repo,
  node,
  reviews,
  hasMoreReviews,
}: {
  repo: string;
  node: PullRequestNode;
  reviews: PRReview[];
  // Whether GitHub has reviews that `reviews` lacks.
  hasMoreReviews: boolean;
}): PullRequest {
  const { reviews: _connection, timelineItems, comments, reviewRequestEvents, ...fields } = node;
  return {
    repo,
    ...fields,
    readyForReviewAt: timelineItems.nodes.find((item) => item.createdAt)?.createdAt ?? null,
    reviews: { pageInfo: { hasNextPage: hasMoreReviews }, nodes: reviews },
    comments,
    reviewRequests: {
      pageInfo: reviewRequestEvents.pageInfo,
      nodes: reviewRequestEvents.nodes.map(toReviewRequestEvent),
    },
  };
}
