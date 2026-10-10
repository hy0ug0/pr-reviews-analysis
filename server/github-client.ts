import { z } from "zod";
import type { GitHubRun } from "./github-run.ts";
import { githubToken, type TokenProvider } from "./github-token.ts";
import { createSemaphore } from "./lib/concurrency.ts";
import { createLogger } from "./logger.ts";
import type { GraphqlError } from "./pull-request-details.ts";

// The GitHub GraphQL client: one POST per attempt with fetch, retries, rate-limit waits and
// token refresh. The other github-*.ts modules send their queries through `github`.

const log = createLogger("fetch");

const GRAPHQL_MAX_ATTEMPTS = 3;

export type GraphqlVariable = boolean | number | string | null | undefined;
type GraphqlVariables = Record<string, GraphqlVariable>;

export interface GraphqlResponse<T> {
  data: T;
  errors?: GraphqlError[];
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_DEADLINE_MS = 30_000;
// A secondary rate limit answers without a reset time; GitHub's docs say to wait a minute.
const SECONDARY_RATE_LIMIT_WAIT_MS = 60_000;
// Longer waits fail at once: the user is better told when the limit resets.
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const TOKEN_REJECTED_MESSAGE = "GitHub rejected the token. Run: gh auth login";
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);
// HTTP requests in flight at once across the whole process: every run, repo and suggestion
// endpoint shares them. GitHub's secondary limits cap concurrent requests and points per
// minute, so the client stays well under them.
export const MAX_CONCURRENT_REQUESTS = 8;

// What GitHub sends back, before `data` is trusted as the query's type.
const graphqlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        type: z.string().optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .optional(),
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  fetch?: FetchLike;
  tokenProvider?: TokenProvider;
  sleep?: (ms: number) => Promise<void>;
  // Epoch milliseconds, for rate-limit reset headers.
  now?: () => number;
  deadlineMs?: number;
  maxConcurrentRequests?: number;
}

export interface GitHubClient {
  // Resolves with the query's data; any GraphQL error rejects.
  query<T>(query: string, variables?: GraphqlVariables, run?: GitHubRun): Promise<T>;
  // Resolves with whatever data came back and its errors, as a batch query can answer
  // some aliases and fail others. Rejects only when there is no data at all.
  queryPartial<T>(
    query: string,
    variables: GraphqlVariables,
    run?: GitHubRun,
  ): Promise<GraphqlResponse<T>>;
}

// What one HTTP attempt came to. "retry" is a transient failure: a network error, the
// deadline, a 5xx, a rate limit (with the wait GitHub asks for) or a GraphQL timeout.
type AttemptOutcome<T> =
  | { kind: "ok"; response: GraphqlResponse<T> }
  | { kind: "retry"; error: Error; waitMs?: number }
  | { kind: "unauthorized" }
  | { kind: "fail"; error: Error };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Unset variables are left out, so GraphQL sees them as null; numbers and booleans stay typed.
function buildBody(query: string, variables: GraphqlVariables): string {
  const defined = Object.fromEntries(
    Object.entries(variables).filter(([, value]) => value !== undefined && value !== null),
  );
  return JSON.stringify({ query, variables: defined });
}

// 429 always is; 403 only with a rate-limit header, as it is also GitHub's permission error.
function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return (
    status === 403 && (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0")
  );
}

// Retry-After is either a number of seconds or an HTTP date (RFC 9110).
function retryAfterMs(value: string, nowMs: number): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function rateLimitWaitMs(headers: Headers, nowMs: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const waitMs = retryAfterMs(retryAfter, nowMs);
    if (waitMs !== null) return waitMs;
  }
  // Every response carries x-ratelimit-reset, so on its own it says nothing about a limit:
  // a secondary limit with remaining > 0 would turn a one-minute wait into a failure.
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - nowMs);
  }
  return SECONDARY_RATE_LIMIT_WAIT_MS;
}

function rateLimitOutcome<T>(headers: Headers, nowMs: number): AttemptOutcome<T> {
  const waitMs = rateLimitWaitMs(headers, nowMs);
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    return {
      kind: "fail",
      error: new Error(`GitHub rate limit reached, resets at ${formatLocalTime(nowMs + waitMs)}`),
    };
  }
  return { kind: "retry", error: new Error("GitHub rate limit reached"), waitMs };
}

// GitHub reports a query it gave up on as an untyped error in a 200 response: "Something
// went wrong while executing your query. This may be the result of a timeout, ..." or "Query
// timed out". The phrase has to end the clause, so a field or argument named `timeout` in a
// validation message ("Field 'timeout' doesn't exist") does not count.
const TIMEOUT_REPORT = /\btimed out\b|\btimeout(?=[.,;:!]|$)/i;

// Typed errors (NOT_FOUND, FORBIDDEN, ...) are never transient, except RATE_LIMITED.
function isTransientGraphqlError(error: GraphqlError): boolean {
  if (error.type !== undefined) return error.type === "RATE_LIMITED";
  return TIMEOUT_REPORT.test(error.message);
}

// Retried only when every error is transient: a mixed answer has a real failure in it.
function graphqlErrorsOutcome<T>(
  errors: GraphqlError[],
  headers: Headers,
  nowMs: number,
): AttemptOutcome<T> {
  const message = errors.map((error) => error.message).join(", ");
  if (!errors.every(isTransientGraphqlError)) return { kind: "fail", error: new Error(message) };
  if (errors.some((error) => error.type === "RATE_LIMITED")) {
    return rateLimitOutcome(headers, nowMs);
  }
  return { kind: "retry", error: new Error(message) };
}

// The body's `message`, as GitHub's HTTP errors carry one. Never the token.
function describeHttpError(status: number, body: string): string {
  let detail = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
      detail = typeof parsed.message === "string" ? parsed.message : "";
    }
  } catch {
    // Not JSON; the status is enough.
  }
  return `GitHub responded with HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

// A 401 or a header-signalled rate limit never gets here: attempt() answers those from the
// headers alone. A RATE_LIMITED GraphQL error does, since it is in the body.
function classifyResponse<T>({
  status,
  headers,
  body,
  nowMs,
  acceptPartial,
}: {
  status: number;
  headers: Headers;
  body: string;
  nowMs: number;
  acceptPartial: boolean;
}): AttemptOutcome<T> {
  if (TRANSIENT_HTTP_STATUSES.has(status)) {
    return { kind: "retry", error: new Error(describeHttpError(status, body)) };
  }
  if (status < 200 || status >= 300) {
    return { kind: "fail", error: new Error(describeHttpError(status, body)) };
  }

  let envelope: z.infer<typeof graphqlEnvelopeSchema>;
  try {
    envelope = graphqlEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    return { kind: "fail", error: new Error("Failed to parse GitHub API response") };
  }

  const errors = envelope.errors ?? [];
  if (envelope.data !== null && envelope.data !== undefined) {
    // The caller's type is a promise about the query, not something a schema can check here.
    const data = envelope.data as T;
    if (errors.length === 0) return { kind: "ok", response: { data } };
    if (acceptPartial) return { kind: "ok", response: { data, errors } };
  }
  if (errors.length === 0) {
    return { kind: "fail", error: new Error("GitHub API response has no data") };
  }
  return graphqlErrorsOutcome(errors, headers, nowMs);
}

// Defence in depth: a fetch error can quote the request headers, token included.
function redactToken(message: string, token: string): string {
  return message.split(token).join("***");
}

function redactOutcome<T>(outcome: AttemptOutcome<T>, token: string): AttemptOutcome<T> {
  if (outcome.kind !== "retry" && outcome.kind !== "fail") return outcome;
  return { ...outcome, error: new Error(redactToken(outcome.error.message, token)) };
}

// One POST to the GraphQL endpoint, with `fetch`. The suggestion endpoints pass no run.
// Tests inject a fake fetch, token, clock and sleep, so no test needs the network or timers.
export function createGitHubClient({
  fetch: fetchImpl = fetch,
  tokenProvider = githubToken,
  sleep = delay,
  now = Date.now,
  deadlineMs = REQUEST_DEADLINE_MS,
  maxConcurrentRequests = MAX_CONCURRENT_REQUESTS,
}: GitHubClientOptions = {}): GitHubClient {
  const slots = createSemaphore(maxConcurrentRequests);

  // Every HTTP attempt goes through here, so a run counts each one, retries included.
  // The attempt holds a slot for the HTTP exchange only: request() sleeps for backoff and
  // rate limits after the slot is freed, so a waiting request never holds one.
  function attempt<T>(
    body: string,
    token: string,
    run: GitHubRun | undefined,
    acceptPartial: boolean,
  ): Promise<AttemptOutcome<T>> {
    if (run) run.requests++;
    return slots.run(() => exchange<T>(body, token, acceptPartial));
  }

  async function exchange<T>(
    body: string,
    token: string,
    acceptPartial: boolean,
  ): Promise<AttemptOutcome<T>> {
    // One deadline for the whole exchange, body read included. It starts once the slot is
    // free, so time spent queued behind other requests does not count against it.
    const signal = AbortSignal.timeout(deadlineMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "pr-reviews-analysis",
        },
        body,
        signal,
      });
      // Decided on the headers alone, so a body that stalls or resets cannot turn a 401
      // into a transient retry, or a known reset time into blind backoff.
      if (response.status === 401) {
        response.body?.cancel().catch(() => {});
        return { kind: "unauthorized" };
      }
      if (isRateLimited(response.status, response.headers)) {
        response.body?.cancel().catch(() => {});
        return redactOutcome(rateLimitOutcome(response.headers, now()), token);
      }
      text = await response.text();
    } catch (error: unknown) {
      const message = signal.aborted
        ? `GitHub request timed out after ${deadlineMs / 1000} s`
        : `GitHub request failed: ${describeError(error)}`;
      return redactOutcome({ kind: "retry", error: new Error(message) }, token);
    }
    return redactOutcome(
      classifyResponse({
        status: response.status,
        headers: response.headers,
        body: text,
        nowMs: now(),
        acceptPartial,
      }),
      token,
    );
  }

  // Up to GRAPHQL_MAX_ATTEMPTS attempts on transient failures. A 401 refreshes the token
  // and tries once more without using up an attempt; a second 401 means the login is bad.
  async function request<T>(
    query: string,
    variables: GraphqlVariables,
    run: GitHubRun | undefined,
    acceptPartial: boolean,
  ): Promise<GraphqlResponse<T>> {
    const body = buildBody(query, variables);
    let token = await tokenProvider.get();
    let tokenRefreshed = false;
    let failures = 0;

    while (true) {
      const outcome = await attempt<T>(body, token, run, acceptPartial);
      switch (outcome.kind) {
        case "ok":
          return outcome.response;
        case "fail":
          throw outcome.error;
        case "unauthorized":
          if (tokenRefreshed) throw new Error(TOKEN_REJECTED_MESSAGE);
          log.warn("GitHub rejected the token; reading it again from gh");
          tokenRefreshed = true;
          token = await tokenProvider.refresh();
          break;
        case "retry": {
          failures++;
          log.warn(
            `GraphQL request failed (attempt ${failures}/${GRAPHQL_MAX_ATTEMPTS}): ${outcome.error.message}`,
          );
          if (failures >= GRAPHQL_MAX_ATTEMPTS) throw outcome.error;
          if (outcome.waitMs === undefined) {
            const backoffMs = 200 * 2 ** (failures - 1);
            log.warn(`Retrying GraphQL request in ${backoffMs}ms`);
            await sleep(backoffMs);
          } else {
            log.warn(`Waiting ${Math.ceil(outcome.waitMs / 1000)} s for the GitHub rate limit`);
            // The run shows the wait in its progress; plain backoff is too short to mention.
            const endWait = run?.rateLimited(now() + outcome.waitMs);
            try {
              await sleep(outcome.waitMs);
            } finally {
              endWait?.();
            }
          }
          break;
        }
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`Unexpected outcome ${String(_exhaustive)}`);
        }
      }
    }
  }

  return {
    async query<T>(query: string, variables: GraphqlVariables = {}, run?: GitHubRun) {
      const response = await request<T>(query, variables, run, false);
      return response.data;
    },
    queryPartial: <T>(query: string, variables: GraphqlVariables, run?: GitHubRun) =>
      request<T>(query, variables, run, true),
  };
}

export const github = createGitHubClient();
