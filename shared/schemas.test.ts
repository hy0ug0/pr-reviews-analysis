import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  analysisProgressSchema,
  analyzeFormSchema,
  analyzeQuerySchema,
  parseList,
} from "./schemas.ts";
import type { AnalysisProgress } from "./types.ts";

// Late on 2026-10-09 in UTC, so a local-time "today" in a timezone ahead of UTC would differ.
beforeEach(() => setSystemTime(new Date("2026-10-09T23:30:00Z")));
afterEach(() => setSystemTime());

function issues(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return result.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) ?? [];
}

describe("parseList", () => {
  test("splits on commas, trims and drops blank entries", () => {
    expect(parseList(" a/b, ,c/d,")).toEqual(["a/b", "c/d"]);
    expect(parseList(",")).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("analyzeQuerySchema", () => {
  test("outputs lists and treats empty values as absent", () => {
    expect(
      analyzeQuerySchema.parse({
        repo: "acme/widgets, acme/gadgets",
        label: " ",
        since: "",
        until: "",
        team: "alice, bob,",
      }),
    ).toEqual({
      repos: ["acme/widgets", "acme/gadgets"],
      label: undefined,
      since: undefined,
      until: undefined,
      team: ["alice", "bob"],
      skipCache: false,
      includeBots: false,
    });
  });

  test("defaults team to an empty list", () => {
    expect(analyzeQuerySchema.parse({ repo: "acme/widgets" }).team).toEqual([]);
  });

  test("includes bots only when includeBots is 1", () => {
    const includeBots = (value?: string) =>
      analyzeQuerySchema.parse({ repo: "acme/widgets", includeBots: value }).includeBots;

    expect(includeBots("1")).toBe(true);
    expect(includeBots(undefined)).toBe(false);
    expect(includeBots("0")).toBe(false);
    expect(includeBots("true")).toBe(false);
  });

  test("accepts a leap day and a same-day range", () => {
    expect(
      analyzeQuerySchema.safeParse({
        repo: "acme/widgets",
        since: "2024-02-29",
        until: "2024-02-29",
      }).success,
    ).toBe(true);
  });

  test("rejects a day that does not exist", () => {
    for (const since of ["2026-02-29", "2026-04-31", "2026-13-01", "26-01-01"]) {
      expect(analyzeQuerySchema.safeParse({ repo: "acme/widgets", since }).success).toBe(false);
    }
  });

  test("checks since against until, or against today when until is missing", () => {
    const query = (range: { since?: string; until?: string }) =>
      issues(analyzeQuerySchema.safeParse({ repo: "acme/widgets", ...range }));

    expect(query({ since: "2026-10-09" })).toEqual([]);
    expect(query({ since: "2026-10-10" })).toEqual(["since: Must be on or before today"]);
    expect(query({ since: "2026-10-10", until: "2026-12-31" })).toEqual([]);
    expect(query({ since: "2026-10-02", until: "2026-10-01" })).toEqual([
      "since: Must be on or before until",
    ]);
  });

  test("rejects an until before GitHub existed", () => {
    const query = (range: { since?: string; until?: string }) =>
      issues(analyzeQuerySchema.safeParse({ repo: "acme/widgets", ...range }));

    expect(query({ until: "2008-01-01" })).toEqual([]);
    expect(query({ until: "2007-12-31" })).toEqual(["until: Must be on or after 2008-01-01"]);
    expect(query({ since: "2007-01-01", until: "2007-12-31" })).toEqual([
      "until: Must be on or after 2008-01-01",
    ]);
  });
});

describe("analyzeFormSchema", () => {
  const form = { repo: "acme/widgets", timeRange: "month" } as const;

  test("applies the same repository rule as the query", () => {
    expect(analyzeFormSchema.safeParse(form).success).toBe(true);
    expect(analyzeFormSchema.safeParse({ ...form, repo: "," }).error?.issues[0]?.message).toBe(
      "At least one repository is required",
    );
    expect(
      analyzeFormSchema.safeParse({ ...form, repo: "widgets" }).error?.issues[0]?.message,
    ).toBe("Each repository must match the owner/repo format");
  });

  test("checks a custom range with the query's rules", () => {
    const custom = { ...form, timeRange: "custom" } as const;
    expect(issues(analyzeFormSchema.safeParse({ ...custom, since: "", until: "" }))).toEqual([]);
    expect(
      issues(analyzeFormSchema.safeParse({ ...custom, since: "2026-10-02", until: "2026-10-01" })),
    ).toEqual(["since: Must be on or before until"]);
    expect(issues(analyzeFormSchema.safeParse({ ...custom, since: "2026-10-10" }))).toEqual([
      "since: Must be on or before today",
    ]);
  });

  test("leaves bots out unless the form includes them", () => {
    expect(analyzeFormSchema.parse(form).includeBots).toBe(false);
    expect(analyzeFormSchema.parse({ ...form, includeBots: true }).includeBots).toBe(true);
  });

  test("ignores leftover dates when a preset is selected", () => {
    expect(
      analyzeFormSchema.safeParse({ ...form, since: "2026-10-02", until: "2026-10-01" }).success,
    ).toBe(true);
  });
});

describe("analysisProgressSchema", () => {
  const fetching = {
    phase: "fetching",
    repos: [
      {
        repo: "honojs/hono",
        prsDone: 25,
        prsTotal: 300,
        batchesDone: 1,
        batchesTotal: 12,
        reviewPRsDone: 0,
        reviewPRsTotal: null,
      },
      {
        repo: "oven-sh/bun",
        prsDone: 50,
        prsTotal: 50,
        batchesDone: 2,
        batchesTotal: 2,
        reviewPRsDone: 1,
        reviewPRsTotal: 3,
      },
    ],
  } satisfies AnalysisProgress;
  const listing = {
    phase: "listing",
    repos: [
      { repo: "honojs/hono", listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1 },
    ],
  } satisfies AnalysisProgress;
  const until = "2026-10-10T12:00:30.000Z";

  test("listing and fetching keep a rate-limit wait's end, and do without one", () => {
    expect(analysisProgressSchema.parse({ ...fetching, rateLimitedUntil: until })).toEqual({
      ...fetching,
      rateLimitedUntil: until,
    });
    expect(analysisProgressSchema.parse({ ...listing, rateLimitedUntil: until })).toEqual({
      ...listing,
      rateLimitedUntil: until,
    });
    expect(analysisProgressSchema.parse(fetching)).toEqual(fetching);
  });

  test("keeps every repo entry, in order", () => {
    expect(analysisProgressSchema.parse(fetching)).toEqual(fetching);
    expect(analysisProgressSchema.parse(listing)).toEqual(listing);
  });

  test("rejects a snapshot in the old one-repo shape", () => {
    const { repos: _repos, ...withoutRepos } = fetching;
    expect(
      analysisProgressSchema.safeParse({ ...withoutRepos, repo: "honojs/hono", repoIndex: 0 })
        .success,
    ).toBe(false);
  });

  test("rejects a wait's end that is not an ISO time", () => {
    for (const rateLimitedUntil of ["in 30 s", "2026-10-10", 1_791_633_630_000, null]) {
      expect(analysisProgressSchema.safeParse({ ...fetching, rateLimitedUntil }).success).toBe(
        false,
      );
    }
  });
});
