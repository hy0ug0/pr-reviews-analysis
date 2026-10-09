import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config.ts";

const CWD = "/srv/app";

describe("parseConfig", () => {
  test("uses the defaults when nothing is set", () => {
    expect(parseConfig({}, CWD)).toEqual({
      port: 3000,
      defaultRepos: [],
      defaultLabel: "",
      defaultTeam: [],
      cacheDir: "/srv/app/.cache/pr-reviews-analysis",
      cacheTtlHours: 6,
      prCacheTtlDays: 30,
      analyzeIdleTimeoutSeconds: 0,
    });
  });

  test("reads every variable", () => {
    expect(
      parseConfig(
        {
          PORT: "3115",
          DEFAULT_REPOS: "acme/widgets, acme/gadgets,",
          DEFAULT_LABEL: " bug ",
          DEFAULT_TEAM: "alice,,bob",
          CACHE_DIR: "tmp/cache",
          CACHE_TTL_HOURS: "12",
          PR_CACHE_TTL_DAYS: "7",
          ANALYZE_IDLE_TIMEOUT_SECONDS: "255",
        },
        CWD,
      ),
    ).toEqual({
      port: 3115,
      defaultRepos: ["acme/widgets", "acme/gadgets"],
      defaultLabel: "bug",
      defaultTeam: ["alice", "bob"],
      cacheDir: "/srv/app/tmp/cache",
      cacheTtlHours: 12,
      prCacheTtlDays: 7,
      analyzeIdleTimeoutSeconds: 255,
    });
  });

  test("keeps an absolute CACHE_DIR", () => {
    expect(parseConfig({ CACHE_DIR: "/var/cache/prs" }, CWD).cacheDir).toBe("/var/cache/prs");
  });

  test("falls back to the default for an invalid number", () => {
    const config = parseConfig(
      {
        PORT: "http",
        CACHE_TTL_HOURS: "0",
        PR_CACHE_TTL_DAYS: "1.5",
        ANALYZE_IDLE_TIMEOUT_SECONDS: "256",
      },
      CWD,
    );
    expect(config).toMatchObject({
      port: 3000,
      cacheTtlHours: 6,
      prCacheTtlDays: 30,
      analyzeIdleTimeoutSeconds: 0,
    });
  });
});
