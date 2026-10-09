import { describe, expect, test } from "bun:test";
import { analyzeFormSchema, analyzeQuerySchema, parseList } from "./schemas.ts";

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
    });
  });

  test("defaults team to an empty list", () => {
    expect(analyzeQuerySchema.parse({ repo: "acme/widgets" }).team).toEqual([]);
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

  test("checks the order only when both dates are set", () => {
    expect(
      analyzeQuerySchema.safeParse({ repo: "acme/widgets", since: "2999-01-01" }).success,
    ).toBe(true);
    expect(
      analyzeQuerySchema.safeParse({ repo: "acme/widgets", until: "2000-01-01" }).success,
    ).toBe(true);
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
});
