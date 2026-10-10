import { beforeEach, describe, expect, test } from "bun:test";
import { consola, type LogObject } from "consola";
import type { GitHubClientOptions } from "./github-client.ts";
import { createGitHubRun, type GitHubRun } from "./github-run.ts";
import type { TokenProvider } from "./github-token.ts";

// The client's logger copies the reporter list when github-client.ts creates it, so the capture
// is installed first. consola logs only warnings under test by default.
const logs: string[] = [];
consola.level = 3;
consola.options.reporters.splice(0, consola.options.reporters.length, {
  log: (entry: LogObject) => logs.push(entry.args.map(String).join(" ")),
});
const { createGitHubClient } = await import("./github-client.ts");

beforeEach(() => {
  logs.length = 0;
});

const TOKEN = "gho_first_token_000000000000000000000000";
const REFRESHED_TOKEN = "gho_second_token_00000000000000000000000";
const QUERY = "query { viewer { login } }";
const DATA = { viewer: { login: "octocat" } };
type Data = typeof DATA;
// Fixed clock, so rate-limit reset headers are relative to a known instant.
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

interface Call {
  url: string;
  init: RequestInit;
}

type Respond = (call: Call, index: number) => Response | Promise<Response>;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function ok(): Response {
  return json({ data: DATA });
}

// The responders in order; the last one answers every later request.
function sequence(...responders: Respond[]): Respond {
  return (call, index) => responders[Math.min(index, responders.length - 1)](call, index);
}

// Never answers; settles only when the client's deadline aborts the request.
function hang({ init }: Call): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

function networkError(): Promise<Response> {
  return Promise.reject(new TypeError("Unable to connect"));
}

// Headers at once, then a body that never ends until the client's deadline aborts it.
function pendingBody(init: ResponseInit = { status: 200 }): Respond {
  return ({ init: request }) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        request.signal?.addEventListener("abort", () => controller.error(request.signal?.reason));
      },
    });
    return new Response(stream, init);
  };
}

// Headers at once, then a body read that fails.
function brokenBody(init: ResponseInit): Respond {
  return () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    return new Response(stream, init);
  };
}

// A GitHub whose answers the test scripts. The token provider hands out TOKEN, then
// REFRESHED_TOKEN after a refresh. Sleeps return at once and record the wait.
function fakeGitHub(respond: Respond, options: Pick<GitHubClientOptions, "deadlineMs"> = {}) {
  const calls: Call[] = [];
  const waits: number[] = [];
  let refreshes = 0;
  const tokenProvider: TokenProvider = {
    get: () => Promise.resolve(refreshes === 0 ? TOKEN : REFRESHED_TOKEN),
    refresh: () => {
      refreshes++;
      return Promise.resolve(REFRESHED_TOKEN);
    },
  };
  const client = createGitHubClient({
    fetch: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return Promise.resolve(respond(call, calls.length - 1));
    },
    tokenProvider,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => NOW,
    ...options,
  });
  return { client, calls, waits, refreshes: () => refreshes };
}

function bodyOf({ init }: Call): string {
  if (typeof init.body !== "string") throw new Error("Expected a string body");
  return init.body;
}

function authorization(call: Call): string | undefined {
  return new Headers(call.init.headers).get("authorization") ?? undefined;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the request to fail");
}

function localTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

describe("request shape", () => {
  test("posts the query and its set variables with the token", async () => {
    const { client, calls } = fakeGitHub(sequence(ok));

    const data = await client.query<Data>(QUERY, {
      first: 12,
      flag: true,
      after: null,
      q: undefined,
    });

    expect(data).toEqual(DATA);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(calls[0].init.method).toBe("POST");
    expect(Object.fromEntries(new Headers(calls[0].init.headers))).toEqual({
      authorization: `bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "pr-reviews-analysis",
    });
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({
      query: QUERY,
      variables: { first: 12, flag: true },
    });
  });
});

describe("deadline", () => {
  test("a hanging request fails at the deadline and is retried", async () => {
    const { client, waits } = fakeGitHub(sequence(hang, ok), { deadlineMs: 20 });
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(run.requests).toBe(2);
    expect(waits).toEqual([200]);
  });

  test("a body that never ends is bounded by the same deadline", async () => {
    const { client, waits } = fakeGitHub(sequence(pendingBody(), ok), { deadlineMs: 20 });
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(run.requests).toBe(2);
    expect(waits).toEqual([200]);
    expect(logs[0]).toBe(
      "GraphQL request failed (attempt 1/3): GitHub request timed out after 0.02 s",
    );
  });

  test("a request that hangs every time fails with the deadline", async () => {
    const { client } = fakeGitHub(hang, { deadlineMs: 20 });
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub request timed out after 0.02 s",
    );
    expect(run.requests).toBe(3);
  });
});

describe("rate limits", () => {
  test("waits for retry-after when it is a minute or less", async () => {
    const { client, waits } = fakeGitHub(
      sequence(
        () => json({ message: "slow down" }, { status: 429, headers: { "retry-after": "7" } }),
        ok,
      ),
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(waits).toEqual([7000]);
    expect(run.requests).toBe(2);
  });

  test("waits for a retry-after HTTP date within the cap", async () => {
    const date = new Date(NOW + 30_000).toUTCString();
    const { client, waits } = fakeGitHub(
      sequence(() => json({}, { status: 429, headers: { "retry-after": date } }), ok),
    );

    expect(await client.query<Data>(QUERY)).toEqual(DATA);
    expect(waits).toEqual([30_000]);
  });

  test("fails at once with the reset time for a retry-after HTTP date an hour ahead", async () => {
    const date = new Date(NOW + 3600_000).toUTCString();
    const { client, waits } = fakeGitHub(
      sequence(() => json({}, { status: 429, headers: { "retry-after": date } })),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      `GitHub rate limit reached, resets at ${localTime(NOW + 3600_000)}`,
    );
    expect(run.requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a 403 with the primary limit exhausted waits until x-ratelimit-reset", async () => {
    const reset = NOW / 1000 + 45;
    const { client, waits } = fakeGitHub(
      sequence(
        () =>
          json(
            { message: "API rate limit exceeded" },
            {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            },
          ),
        ok,
      ),
    );

    expect(await client.query<Data>(QUERY)).toEqual(DATA);
    expect(waits).toEqual([45_000]);
  });

  test("fails at once with the reset time when the wait is longer than a minute", async () => {
    const reset = NOW / 1000 + 3600;
    const { client, waits } = fakeGitHub(
      sequence(() =>
        json(
          { message: "API rate limit exceeded" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
          },
        ),
      ),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      `GitHub rate limit reached, resets at ${localTime(NOW + 3600_000)}`,
    );
    expect(run.requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a RATE_LIMITED GraphQL error without headers waits a minute", async () => {
    const { client, waits } = fakeGitHub(
      sequence(
        () => json({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
        ok,
      ),
    );

    expect(await client.query<Data>(QUERY)).toEqual(DATA);
    expect(waits).toEqual([60_000]);
  });

  test("a 429 with an unreadable body still waits for retry-after", async () => {
    const { client, waits, calls } = fakeGitHub(
      sequence(brokenBody({ status: 429, headers: { "retry-after": "7" } }), ok),
      { deadlineMs: 20 },
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(waits).toEqual([7000]);
    expect(run.requests).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("a 429 with a stalled body and a long retry-after fails at once with the reset time", async () => {
    const { client, waits } = fakeGitHub(
      pendingBody({ status: 429, headers: { "retry-after": "3600" } }),
      { deadlineMs: 20 },
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      `GitHub rate limit reached, resets at ${localTime(NOW + 3600_000)}`,
    );
    expect(run.requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a rate-limited 403 with a stalled body waits until x-ratelimit-reset", async () => {
    const reset = String(NOW / 1000 + 45);
    const { client, waits } = fakeGitHub(
      sequence(
        pendingBody({
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
        }),
        ok,
      ),
      { deadlineMs: 20 },
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(waits).toEqual([45_000]);
    expect(run.requests).toBe(2);
  });

  test("a rate-limited 403 with an unreadable body and a far reset fails at once", async () => {
    const reset = String(NOW / 1000 + 3600);
    const { client, waits } = fakeGitHub(
      brokenBody({
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      }),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      `GitHub rate limit reached, resets at ${localTime(NOW + 3600_000)}`,
    );
    expect(run.requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a 403 without rate-limit headers is a permission error and is not retried", async () => {
    const { client } = fakeGitHub(
      sequence(() => json({ message: "Resource not accessible by integration" }, { status: 403 })),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub responded with HTTP 403: Resource not accessible by integration",
    );
    expect(run.requests).toBe(1);
  });
});

describe("permanent failures", () => {
  test("a GraphQL validation error fails on the first attempt", async () => {
    const { client, waits } = fakeGitHub(
      sequence(() => json({ errors: [{ message: "Field 'nope' doesn't exist on type 'Query'" }] })),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "Field 'nope' doesn't exist on type 'Query'",
    );
    expect(run.requests).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a 404 fails on the first attempt", async () => {
    const { client } = fakeGitHub(sequence(() => json({ message: "Not Found" }, { status: 404 })));
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub responded with HTTP 404: Not Found",
    );
    expect(run.requests).toBe(1);
  });
});

describe("transient failures", () => {
  test("a 5xx is retried up to 3 attempts with exponential backoff", async () => {
    const { client, waits } = fakeGitHub(
      sequence(() => new Response("Bad Gateway", { status: 502 })),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub responded with HTTP 502",
    );
    expect(run.requests).toBe(3);
    expect(waits).toEqual([200, 400]);
  });

  test("a network error is retried and the request succeeds on a later attempt", async () => {
    const { client } = fakeGitHub(sequence(networkError, networkError, ok));
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(run.requests).toBe(3);
  });

  test("a 'Query timed out' GraphQL error is retried", async () => {
    const { client } = fakeGitHub(
      sequence(() => json({ data: null, errors: [{ message: "Query timed out" }] }), ok),
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(run.requests).toBe(2);
  });

  test("a validation error about a field named timeout is not retried", async () => {
    const { client } = fakeGitHub(
      sequence(() =>
        json({ errors: [{ message: "Field 'timeout' doesn't exist on type 'Query'" }] }),
      ),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "Field 'timeout' doesn't exist on type 'Query'",
    );
    expect(run.requests).toBe(1);
  });

  test("a timeout mixed with a typed error is not retried", async () => {
    const { client } = fakeGitHub(
      sequence(() =>
        json({
          data: null,
          errors: [
            { message: "Query timed out" },
            { type: "NOT_FOUND", message: "Could not resolve to a Repository" },
          ],
        }),
      ),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "Query timed out, Could not resolve to a Repository",
    );
    expect(run.requests).toBe(1);
  });

  test("a GraphQL error reporting a timeout is retried", async () => {
    const { client } = fakeGitHub(
      sequence(
        () =>
          json({
            data: null,
            errors: [
              {
                message:
                  "Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.",
              },
            ],
          }),
        ok,
      ),
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(run.requests).toBe(2);
  });
});

describe("401", () => {
  test("refreshes the token and retries once", async () => {
    const { client, calls, refreshes } = fakeGitHub(
      sequence(() => json({ message: "Bad credentials" }, { status: 401 }), ok),
    );
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(refreshes()).toBe(1);
    expect(calls.map(authorization)).toEqual([`bearer ${TOKEN}`, `bearer ${REFRESHED_TOKEN}`]);
    expect(run.requests).toBe(2);
  });

  test("a second 401 fails with the login message", async () => {
    const { client } = fakeGitHub(
      sequence(() => json({ message: "Bad credentials" }, { status: 401 })),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub rejected the token. Run: gh auth login",
    );
    expect(run.requests).toBe(2);
  });

  test("a 401 whose body cannot be read still refreshes the token", async () => {
    const { client, calls, refreshes } = fakeGitHub(sequence(brokenBody({ status: 401 }), ok));
    const run = createGitHubRun();

    expect(await client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(refreshes()).toBe(1);
    expect(calls.map(authorization)).toEqual([`bearer ${TOKEN}`, `bearer ${REFRESHED_TOKEN}`]);
    expect(run.requests).toBe(2);
  });

  test("a second 401 with an unreadable body fails with the login message", async () => {
    const { client } = fakeGitHub(sequence(brokenBody({ status: 401 })));
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub rejected the token. Run: gh auth login",
    );
    expect(run.requests).toBe(2);
  });

  test("the post-401 retry does not use up a transient attempt", async () => {
    const { client } = fakeGitHub(
      sequence(
        () => json({ message: "Bad credentials" }, { status: 401 }),
        () => new Response("", { status: 503 }),
      ),
    );
    const run = createGitHubRun();

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub responded with HTTP 503",
    );
    expect(run.requests).toBe(4);
  });
});

describe("partial mode", () => {
  test("returns data and errors without retry", async () => {
    const errors = [{ message: "Could not resolve to a PullRequest", path: ["repository", "pr7"] }];
    const data = { repository: { pr5: { number: 5 }, pr7: null } };
    const { client } = fakeGitHub(sequence(() => json({ data, errors })));
    const run = createGitHubRun();

    expect(await client.queryPartial(QUERY, {}, run)).toEqual({ data, errors });
    expect(run.requests).toBe(1);
  });

  test("the same response rejects in normal mode", async () => {
    const { client } = fakeGitHub(
      sequence(() =>
        json({ data: { repository: {} }, errors: [{ message: "Could not resolve" }] }),
      ),
    );

    expect(await rejection(client.query<Data>(QUERY))).toBe("Could not resolve");
  });

  test("a response with no data is still retried on a transient error", async () => {
    const { client } = fakeGitHub(
      sequence(
        () => new Response("", { status: 504 }),
        () => json({ data: { repository: {} } }),
      ),
    );
    const run = createGitHubRun();

    expect(await client.queryPartial(QUERY, {}, run)).toEqual({ data: { repository: {} } });
    expect(run.requests).toBe(2);
  });
});

describe("runs", () => {
  test("two concurrent runs each count their own requests, retries included", async () => {
    const { client } = fakeGitHub((call) =>
      bodyOf(call).includes("repo-a")
        ? new Response("", { status: 503 })
        : json({ data: { repo: "b" } }),
    );
    const runA = createGitHubRun();
    const runB = createGitHubRun();

    const [a, b] = await Promise.allSettled([
      client.query<{ repo: string }>("query { repo-a }", {}, runA),
      client.query<{ repo: string }>("query { repo-b }", {}, runB),
    ]);

    expect(a.status).toBe("rejected");
    expect(b).toEqual({ status: "fulfilled", value: { repo: "b" } });
    expect(runA.requests).toBe(3);
    expect(runB.requests).toBe(1);
  });
});

describe("rate-limit waits in the run", () => {
  // A run that notes when each wait starts and ends, against the sleeps and requests so far.
  function recordingRun({ calls, waits }: { calls: Call[]; waits: number[] }) {
    const events: string[] = [];
    const run: GitHubRun = {
      requests: 0,
      report: () => {},
      rateLimited: (untilMs) => {
        events.push(`wait until +${untilMs - NOW} ms, after ${waits.length} sleeps`);
        return () => events.push(`end after ${waits.length} sleeps, ${calls.length} requests`);
      },
    };
    return { run, events };
  }

  const tooMany = () => json({}, { status: 429, headers: { "retry-after": "7" } });

  test("signals the wait with its end before sleeping and ends it before the retry", async () => {
    const github = fakeGitHub(sequence(tooMany, ok));
    const { run, events } = recordingRun(github);

    expect(await github.client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(events).toEqual([
      "wait until +7000 ms, after 0 sleeps",
      "end after 1 sleeps, 1 requests",
    ]);
    expect(github.calls).toHaveLength(2);
  });

  test("ends the wait when the retry then fails", async () => {
    const github = fakeGitHub(
      sequence(tooMany, () => json({ message: "Not Found" }, { status: 404 })),
    );
    const { run, events } = recordingRun(github);

    expect(await rejection(github.client.query<Data>(QUERY, {}, run))).toBe(
      "GitHub responded with HTTP 404: Not Found",
    );
    expect(events).toEqual([
      "wait until +7000 ms, after 0 sleeps",
      "end after 1 sleeps, 1 requests",
    ]);
  });

  test("ends the wait when the sleep throws", async () => {
    const { run, events } = recordingRun({ calls: [], waits: [] });
    const client = createGitHubClient({
      fetch: () => Promise.resolve(tooMany()),
      tokenProvider: { get: () => Promise.resolve(TOKEN), refresh: () => Promise.resolve(TOKEN) },
      sleep: () => Promise.reject(new Error("interrupted")),
      now: () => NOW,
    });

    expect(await rejection(client.query<Data>(QUERY, {}, run))).toBe("interrupted");
    expect(events).toEqual([
      "wait until +7000 ms, after 0 sleeps",
      "end after 0 sleeps, 0 requests",
    ]);
  });

  test("ordinary backoff is not a rate-limit wait", async () => {
    const github = fakeGitHub(sequence(() => new Response("", { status: 502 }), ok));
    const { run, events } = recordingRun(github);

    expect(await github.client.query<Data>(QUERY, {}, run)).toEqual(DATA);
    expect(github.waits).toEqual([200]);
    expect(events).toEqual([]);
  });
});

describe("secrets", () => {
  test("a fetch error quoting the Authorization header is redacted in the error and the logs", async () => {
    const { client } = fakeGitHub(() =>
      Promise.reject(new TypeError(`Invalid header value: "bearer ${TOKEN}"`)),
    );

    const message = await rejection(client.query<Data>(QUERY));

    expect(message).toBe('GitHub request failed: Invalid header value: "bearer ***"');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("bearer ***");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  test("the token is sent to GitHub but never appears in an error message", async () => {
    const scenarios: Array<[string, Respond]> = [
      ["network error", networkError],
      ["404", sequence(() => json({ message: "Not Found" }, { status: 404 }))],
      ["401 twice", sequence(() => json({ message: "Bad credentials" }, { status: 401 }))],
      ["deadline", hang],
      ["unparseable body", sequence(() => new Response("<html>", { status: 200 }))],
    ];

    for (const [name, respond] of scenarios) {
      const { client, calls } = fakeGitHub(respond, { deadlineMs: 20 });
      const message = await rejection(client.query<Data>(QUERY));
      expect(calls.map(authorization)).toContain(`bearer ${TOKEN}`);
      expect(message, name).not.toContain(TOKEN);
      expect(message, name).not.toContain(REFRESHED_TOKEN);
    }
  });
});
