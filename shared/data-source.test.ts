import { describe, expect, test } from "bun:test";
import { cachedPercent, describeCacheUsage, describeDataSource } from "./data-source.ts";
import type { DataSource } from "./types.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const TWO_HOURS_AGO = "2026-10-09T10:00:00.000Z";

function dataSource(overrides: Partial<DataSource>): DataSource {
  return {
    listing: "cache",
    listedAt: TWO_HOURS_AGO,
    fetchedPRs: 0,
    reusedPRs: 592,
    oldestReusedCachedAt: TWO_HOURS_AGO,
    githubRequests: 0,
    fetchDurationMs: null,
    skippedCache: false,
    ...overrides,
  };
}

function lineText(source: DataSource, matchingPRs = 592): string {
  return describeDataSource({ dataSource: source, matchingPRs, now: NOW })
    .items.map((item) => item.text.replaceAll("\u00A0", " "))
    .join(" · ");
}

describe("describeDataSource", () => {
  test("full hit", () => {
    const line = describeDataSource({ dataSource: dataSource({}), matchingPRs: 592, now: NOW });

    expect(lineText(dataSource({}))).toBe(
      "All 592 PRs from cache · cached 2 h ago · 0 GitHub requests",
    );
    expect(line.canRefresh).toBe(true);
    expect(line.split).toBeNull();
    expect(line.items[1].title).toContain("Oldest reused PR cached");
  });

  test("full miss", () => {
    const source = dataSource({
      listing: "github",
      listedAt: new Date(NOW).toISOString(),
      fetchedPRs: 592,
      reusedPRs: 0,
      oldestReusedCachedAt: null,
      githubRequests: 9,
      fetchDurationMs: 14_200,
    });

    expect(lineText(source)).toBe("592 PRs fetched from GitHub in 14 s · 9 requests");
    expect(describeDataSource({ dataSource: source, matchingPRs: 592, now: NOW }).canRefresh).toBe(
      false,
    );
  });

  test("skip cache with nothing reused", () => {
    const source = dataSource({
      listing: "github",
      fetchedPRs: 592,
      reusedPRs: 0,
      oldestReusedCachedAt: null,
      githubRequests: 9,
      fetchDurationMs: 14_200,
      skippedCache: true,
    });

    expect(lineText(source)).toBe(
      "Cache skipped · 592 PRs fetched from GitHub in 14 s · 9 requests",
    );
  });

  test("partial, with the list from the cache", () => {
    const source = dataSource({ fetchedPRs: 52, reusedPRs: 540, githubRequests: 2 });
    const line = describeDataSource({ dataSource: source, matchingPRs: 592, now: NOW });

    expect(lineText(source)).toBe(
      "540 of 592 PRs from cache (91%) · 52 refetched · 2 requests · oldest data 2 h ago",
    );
    expect(line.split).toEqual({ cached: 540, fetched: 52 });
    expect(line.canRefresh).toBe(true);
  });

  test("partial after a skip cache", () => {
    const source = dataSource({
      listing: "github",
      fetchedPRs: 52,
      reusedPRs: 540,
      githubRequests: 4,
      fetchDurationMs: 3100,
      skippedCache: true,
    });

    expect(lineText(source)).toBe(
      "540 of 592 PRs from cache (91%) · 52 refetched · PR list refreshed · 4 requests · oldest data 2 h ago",
    );
  });

  test("every PR reused after the list expired", () => {
    const source = dataSource({ listing: "github", githubRequests: 1, fetchDurationMs: 800 });
    const line = describeDataSource({ dataSource: source, matchingPRs: 592, now: NOW });

    expect(lineText(source)).toBe(
      "All 592 PRs from cache · cached 2 h ago · PR list from GitHub · 1 request",
    );
    expect(line.items[3].title).toBe("0.8 s on GitHub");
    // The list was just checked on GitHub, so a refresh would change nothing.
    expect(line.canRefresh).toBe(false);
  });

  test("no matching PRs", () => {
    const source = dataSource({
      listing: "github",
      reusedPRs: 0,
      oldestReusedCachedAt: null,
      githubRequests: 1,
      fetchDurationMs: 400,
    });

    expect(lineText(source, 0)).toBe("No PRs matched, cache not used · 1 request");
  });

  test("no matching PRs in a cached list", () => {
    const source = dataSource({ reusedPRs: 0, oldestReusedCachedAt: null });
    const line = describeDataSource({ dataSource: source, matchingPRs: 0, now: NOW });

    expect(lineText(source, 0)).toBe("No PRs matched · list cached 2 h ago · 0 GitHub requests");
    expect(line.canRefresh).toBe(true);
  });
});

test("cachedPercent never rounds a mixed run to 0% or 100%", () => {
  expect(cachedPercent(dataSource({ reusedPRs: 999, fetchedPRs: 1 }))).toBe(99);
  expect(cachedPercent(dataSource({ reusedPRs: 1, fetchedPRs: 999 }))).toBe(1);
  expect(cachedPercent(dataSource({ reusedPRs: 0, fetchedPRs: 0 }))).toBe(0);
});

test("describeCacheUsage sums up a run in one line", () => {
  const source = dataSource({
    listing: "github",
    fetchedPRs: 52,
    reusedPRs: 540,
    githubRequests: 4,
    fetchDurationMs: 3100,
  });

  expect(describeCacheUsage(source, NOW)).toBe(
    "Cache usage: 540/592 PRs from cache (91%), 52 fetched, 4 GitHub requests in 3.1 s, listing from GitHub, oldest cached 2 h ago",
  );
  expect(describeCacheUsage(dataSource({ skippedCache: true }), NOW)).toBe(
    "Cache usage: 592/592 PRs from cache (100%), 0 fetched, 0 GitHub requests, listing from cache, oldest cached 2 h ago, cache skipped",
  );
});

test("keeps each number with the word after it", () => {
  const source = dataSource({ fetchedPRs: 52, reusedPRs: 540, githubRequests: 2 });
  const [first] = describeDataSource({ dataSource: source, matchingPRs: 592, now: NOW }).items;

  expect(first.text).toBe("540\u00A0of 592\u00A0PRs from cache (91%)");
});
