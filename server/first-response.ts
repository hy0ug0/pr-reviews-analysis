import type {
  Actor,
  DurationBucket,
  FirstResponseSummary,
  PullRequest,
  WeeklyFirstResponse,
} from "../shared/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const HISTOGRAM_BUCKETS: ReadonlyArray<Omit<DurationBucket, "count">> = [
  { label: "< 1h", minMs: 0, maxMs: HOUR_MS },
  { label: "1–4h", minMs: HOUR_MS, maxMs: 4 * HOUR_MS },
  { label: "4–24h", minMs: 4 * HOUR_MS, maxMs: DAY_MS },
  { label: "1–2d", minMs: DAY_MS, maxMs: 2 * DAY_MS },
  { label: "2–7d", minMs: 2 * DAY_MS, maxMs: WEEK_MS },
  { label: "> 7d", minMs: WEEK_MS, maxMs: null },
];

// Times are epoch milliseconds.
export type FirstResponseOutcome =
  | { kind: "draft" }
  | { kind: "responded"; startedAt: number; respondedAt: number }
  | { kind: "waiting"; startedAt: number }
  | { kind: "closedWithoutResponse"; startedAt: number }
  // More comments exist than were fetched, none of the fetched ones is a response,
  // and no review came before the last fetched comment: an unseen comment may be
  // the first response.
  | { kind: "undetermined"; startedAt: number };

// Lowercased logins; null means no team filter.
export type TeamFilter = ReadonlySet<string> | null;

export function toTeamFilter(teamMembers: readonly string[] | undefined): TeamFilter {
  // GitHub logins are case-insensitive; the API returns the canonical casing.
  return teamMembers?.length ? new Set(teamMembers.map((member) => member.toLowerCase())) : null;
}

export function isBot(actor: Actor): boolean {
  return actor.__typename === "Bot" || actor.login.toLowerCase().endsWith("[bot]");
}

// The later of creation and the first ready-for-review event, so time spent as a
// draft doesn't count as waiting.
export function responseStart(pr: Pick<PullRequest, "createdAt" | "readyForReviewAt">): number {
  const createdAt = Date.parse(pr.createdAt);
  if (pr.readyForReviewAt === null) return createdAt;
  return Math.max(createdAt, Date.parse(pr.readyForReviewAt));
}

function earliest(times: number[]): number | null {
  return times.length > 0 ? Math.min(...times) : null;
}

// A response is the first submitted review (any state but PENDING; a DISMISSED review
// still shows someone responded) or conversation comment by someone who is not the PR
// author, not a bot, and on the team when a team filter is set. It must land between
// the start and the PR's closing: feedback on a draft isn't a response to the review
// request, and a comment after an unreviewed merge isn't a review. Actors GitHub
// can't resolve (deleted accounts) don't count, as in analyze().
export function classifyFirstResponse({
  pr,
  team,
}: {
  pr: PullRequest;
  team: TeamFilter;
}): FirstResponseOutcome {
  // Still a draft, or closed before ever leaving draft.
  if (pr.isDraft) return { kind: "draft" };

  const startedAt = responseStart(pr);
  const closedAt = pr.state === "OPEN" || pr.closedAt === null ? null : Date.parse(pr.closedAt);
  const prAuthor = pr.author?.login.toLowerCase();

  const isResponder = (actor: Actor | null): actor is Actor => {
    if (actor === null || isBot(actor)) return false;
    const login = actor.login.toLowerCase();
    return login !== prAuthor && (team === null || team.has(login));
  };
  const isInWindow = (time: number) => time >= startedAt && (closedAt === null || time <= closedAt);

  const reviewAt = earliest(
    pr.reviews.nodes.flatMap((review) => {
      if (review.state === "PENDING" || review.submittedAt === null) return [];
      if (!isResponder(review.author)) return [];
      const time = Date.parse(review.submittedAt);
      return isInWindow(time) ? [time] : [];
    }),
  );
  const commentTimes = pr.comments.nodes.map((comment) => Date.parse(comment.createdAt));
  const commentAt = earliest(
    pr.comments.nodes.flatMap((comment, index) =>
      isResponder(comment.author) && isInWindow(commentTimes[index]) ? [commentTimes[index]] : [],
    ),
  );

  // Comments past the fetched page are all at or after the last fetched one, so they
  // can only matter when no fetched comment qualified, no review came first and the
  // PR was still open at that point (inclusive, like isInWindow).
  if (commentAt === null && pr.comments.pageInfo.hasNextPage && commentTimes.length > 0) {
    const lastFetchedCommentAt = Math.max(...commentTimes);
    const unseenCanCount = closedAt === null || lastFetchedCommentAt <= closedAt;
    if (unseenCanCount && (reviewAt === null || reviewAt > lastFetchedCommentAt)) {
      return { kind: "undetermined", startedAt };
    }
  }

  const respondedAt = earliest([reviewAt, commentAt].filter((time) => time !== null));
  if (respondedAt !== null) return { kind: "responded", startedAt, respondedAt };
  return pr.state === "OPEN"
    ? { kind: "waiting", startedAt }
    : { kind: "closedWithoutResponse", startedAt };
}

// Linear interpolation between closest ranks (Hyndman and Fan type 7, the default in
// NumPy, R and Excel's PERCENTILE.INC): with the n values sorted ascending and
// h = (n - 1) * p, the result is x[floor(h)] + (h - floor(h)) * (x[ceil(h)] - x[floor(h)]).
// p50 is the usual median, and p is a fraction from 0 to 1.
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}

function roundedPercentile(sorted: readonly number[], p: number): number | null {
  const value = percentile(sorted, p);
  return value === null ? null : Math.round(value);
}

// Monday 00:00 UTC of the week containing `time`.
export function weekStart(time: number): number {
  const date = new Date(time);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

function formatDateOnly(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function buildHistogram(durations: readonly number[]): DurationBucket[] {
  return HISTOGRAM_BUCKETS.map((bucket) => ({
    ...bucket,
    count: durations.filter(
      (duration) => duration >= bucket.minMs && (bucket.maxMs === null || duration < bucket.maxMs),
    ).length,
  }));
}

// One entry per week from the earliest to the latest week among the responses and the
// selected range, so weeks without responses show up as gaps instead of disappearing.
function buildWeekly({
  responses,
  since,
  until,
}: {
  responses: ReadonlyArray<{ startedAt: number; durationMs: number }>;
  since?: string;
  until?: string;
}): WeeklyFirstResponse[] {
  if (responses.length === 0) return [];

  const durationsByWeek = new Map<number, number[]>();
  for (const { startedAt, durationMs } of responses) {
    const week = weekStart(startedAt);
    const durations = durationsByWeek.get(week) ?? [];
    durations.push(durationMs);
    durationsByWeek.set(week, durations);
  }

  const bounds = [...durationsByWeek.keys()];
  if (since) bounds.push(weekStart(Date.parse(`${since}T00:00:00Z`)));
  if (until) bounds.push(weekStart(Date.parse(`${until}T00:00:00Z`)));
  const first = Math.min(...bounds);
  const last = Math.max(...bounds);

  const weekly: WeeklyFirstResponse[] = [];
  for (let week = first; week <= last; week += WEEK_MS) {
    const durations = (durationsByWeek.get(week) ?? []).sort((a, b) => a - b);
    weekly.push({
      weekStart: formatDateOnly(week),
      p50Ms: roundedPercentile(durations, 0.5),
      count: durations.length,
    });
  }
  return weekly;
}

export function summarizeFirstResponse({
  prs,
  teamMembers,
  since,
  until,
}: {
  prs: readonly PullRequest[];
  teamMembers?: readonly string[];
  since?: string;
  until?: string;
}): FirstResponseSummary {
  const team = toTeamFilter(teamMembers);
  const responses: Array<{ startedAt: number; durationMs: number }> = [];
  const counts = { waiting: 0, closedWithoutResponse: 0, draft: 0, undetermined: 0 };

  for (const pr of prs) {
    const outcome = classifyFirstResponse({ pr, team });
    switch (outcome.kind) {
      case "responded":
        responses.push({
          startedAt: outcome.startedAt,
          durationMs: outcome.respondedAt - outcome.startedAt,
        });
        break;
      case "waiting":
      case "closedWithoutResponse":
      case "draft":
      case "undetermined":
        counts[outcome.kind]++;
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  const durations = responses.map((response) => response.durationMs).sort((a, b) => a - b);
  return {
    respondedPRs: responses.length,
    waitingPRs: counts.waiting,
    closedWithoutResponsePRs: counts.closedWithoutResponse,
    draftPRs: counts.draft,
    undeterminedPRs: counts.undetermined,
    p50Ms: roundedPercentile(durations, 0.5),
    p75Ms: roundedPercentile(durations, 0.75),
    p90Ms: roundedPercentile(durations, 0.9),
    histogram: buildHistogram(durations),
    weekly: buildWeekly({ responses, since, until }),
  };
}
