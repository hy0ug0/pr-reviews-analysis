import { beforeEach, expect, mock, test } from "bun:test";
import { createSseParser, type ServerSentEvent } from "../shared/sse.ts";
import type { DataSource } from "../shared/types.ts";
import type { ProgressListener } from "./load-run.ts";
import type { LoadedPullRequests } from "./pull-requests.ts";

const dataSource: DataSource = {
  listing: "github",
  listedAt: "2026-10-09T10:00:00.000Z",
  fetchedPRs: 0,
  reusedPRs: 0,
  oldestReusedCachedAt: null,
  githubRequests: 1,
  fetchDurationMs: 400,
  skippedCache: false,
};

const loaded: LoadedPullRequests = {
  fetchResult: { prs: [], matchingPRs: 0, analyzedPRs: 0, isComplete: true, partialReasons: [] },
  dataSource,
};

// What the fake load does with the request's progress listener before it settles.
let behavior: (onProgress: ProgressListener | undefined) => Promise<LoadedPullRequests>;
const loadMock = mock(
  (_query: unknown, options: { onProgress?: ProgressListener; signal?: AbortSignal }) =>
    behavior(options.onProgress),
);
await mock.module("./pull-requests.ts", () => ({ loadPullRequests: loadMock }));
const { app } = await import("./server.ts");

beforeEach(() => {
  loadMock.mockClear();
  behavior = async (onProgress) => {
    onProgress?.({ phase: "listing-cache" });
    onProgress?.({ phase: "pr-cache", prs: 0 });
    return loaded;
  };
});

const QUERY = "repo=acme/widgets&since=2026-09-01&until=2026-09-30";

async function readEvents(response: Response): Promise<ServerSentEvent[]> {
  const parse = createSseParser();
  return parse(await response.text());
}

function streamRequest(query = QUERY) {
  return app.request(`/api/analyze?${query}`, { headers: { Accept: "text/event-stream" } });
}

test("streams progress, then the result, as server-sent events", async () => {
  const response = await streamRequest();
  const events = await readEvents(response);

  expect(response.headers.get("content-type")).toStartWith("text/event-stream");
  // The first snapshot goes out at once; the ones right behind it are coalesced into the
  // latest, which the result then supersedes.
  expect(events.map((event) => event.event)).toEqual(["progress", "result"]);
  expect(JSON.parse(events[0].data)).toEqual({ phase: "listing-cache" });
  expect(JSON.parse(events[1].data)).toMatchObject({ matchingPRs: 0, dataSource });
});

test("sends a slow load's later snapshots too", async () => {
  behavior = async (onProgress) => {
    onProgress?.({ phase: "listing-cache" });
    await Bun.sleep(150);
    onProgress?.({ phase: "pr-cache", prs: 0 });
    await Bun.sleep(150);
    return loaded;
  };

  const events = await readEvents(await streamRequest());

  expect(events.map((event) => [event.event, JSON.parse(event.data).phase])).toEqual([
    ["progress", "listing-cache"],
    ["progress", "pr-cache"],
    ["progress", "analyzing"],
    ["result", undefined],
  ]);
});

test("ends with an error event when the load fails", async () => {
  behavior = async () => {
    throw new Error("rate limited");
  };

  const events = await readEvents(await streamRequest());

  expect(events.at(-1)).toEqual({
    event: "error",
    data: JSON.stringify({ message: "rate limited" }),
  });
});

test("answers an invalid query with a JSON 400, before any stream starts", async () => {
  const response = await streamRequest("repo=widgets");

  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toStartWith("application/json");
  expect(await response.json()).toEqual({
    error: "repo: Each repository must match the owner/repo format",
  });
  expect(loadMock).not.toHaveBeenCalled();
});

test("still answers plain JSON without the event-stream Accept header", async () => {
  const response = await app.request(`/api/analyze?${QUERY}`);

  expect(response.headers.get("content-type")).toStartWith("application/json");
  expect(await response.json()).toMatchObject({ matchingPRs: 0, dataSource });
});

test("passes an abort signal that fires when the client leaves, without waiting for the load", async () => {
  let signal: AbortSignal | undefined;
  let finish: () => void = () => {};
  loadMock.mockImplementationOnce((_query, options) => {
    signal = options.signal;
    options.onProgress?.({ phase: "listing-cache" });
    return new Promise<LoadedPullRequests>((resolve) => {
      finish = () => resolve(loaded);
    });
  });

  const response = await streamRequest();
  const reader = response.body?.getReader();
  await reader?.read();
  await reader?.cancel();
  await Bun.sleep(10);

  expect(signal?.aborted).toBe(true);
  finish();
});
