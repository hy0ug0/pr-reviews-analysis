import { expect, mock, test } from "bun:test";
import { consola, type LogObject } from "consola";
import type { DataSource } from "../shared/types.ts";
import { normalizeRepos, type LoadedPullRequests } from "./pull-requests.ts";

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

// Every request joins the same load, as identical queries with different teams do.
let release: () => void = () => {};
const sharedLoad = new Promise<LoadedPullRequests>((resolve) => {
  release = () =>
    resolve({
      fetchResult: {
        prs: [],
        matchingPRs: 0,
        analyzedPRs: 0,
        isComplete: true,
        partialReasons: [],
      },
      dataSource,
    });
});
const loadMock = mock(() => sharedLoad);
await mock.module("./pull-requests.ts", () => ({ loadPullRequests: loadMock, normalizeRepos }));

// Loggers copy the level and share the reporter list when server.ts creates them, so set
// both before importing it. consola logs only warnings under test by default.
const logs: string[] = [];
consola.level = 3;
consola.options.reporters.splice(0, consola.options.reporters.length, {
  log: (entry: LogObject) => logs.push(entry.args.map(String).join(" ")),
});
const { app } = await import("./server.ts");

test("logs one cache usage line per successful request, also when requests share a load", async () => {
  // app.request may return a Response or a Promise; async makes it always a Promise.
  const get = async (team: string) =>
    app.request(`/api/analyze?repo=acme/widgets&since=2026-09-01&until=2026-09-30&team=${team}`);
  const requests = [get("alice"), get("bob")];
  release();
  const responses = await Promise.all(requests);

  expect(loadMock).toHaveBeenCalledTimes(2);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(logs.filter((line) => line.startsWith("Cache usage:"))).toEqual([
    "Cache usage: 0/0 PRs from cache, 0 fetched, 1 GitHub request in 0.4 s, listing from GitHub",
    "Cache usage: 0/0 PRs from cache, 0 fetched, 1 GitHub request in 0.4 s, listing from GitHub",
  ]);
});
