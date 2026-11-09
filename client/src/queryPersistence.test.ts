import { afterEach, describe, expect, test } from "bun:test";
import { parseQuery, rememberedQuery, serializeQuery } from "./queryPersistence";
import type { AnalyzeFormValues } from "./types";

function formValues(overrides: Partial<AnalyzeFormValues> = {}): AnalyzeFormValues {
  return {
    repo: "",
    label: "",
    timeRange: "month",
    since: "",
    until: "",
    team: "",
    skipCache: false,
    includeBots: false,
    ...overrides,
  };
}

describe("serializeQuery", () => {
  test("writes every set field under its parameter name", () => {
    const values = formValues({
      repo: "acme/api,acme/web",
      label: "bug",
      timeRange: "custom",
      since: "2026-01-01",
      until: "2026-03-31",
      team: "alice, bob",
      includeBots: true,
    });
    expect(serializeQuery(values)).toBe(
      "repo=acme%2Fapi%2Cacme%2Fweb&label=bug&range=custom&since=2026-01-01&until=2026-03-31&team=alice%2C+bob&includeBots=1",
    );
  });

  test("omits empty fields, bots off and the refresh choice", () => {
    expect(serializeQuery(formValues({ repo: "acme/api", skipCache: true }))).toBe(
      "repo=acme%2Fapi&range=month",
    );
  });

  test("drops dates unless the range is custom", () => {
    const values = formValues({ repo: "acme/api", since: "2026-01-01", until: "2026-03-31" });
    expect(serializeQuery(values)).toBe("repo=acme%2Fapi&range=month");
  });
});

describe("parseQuery", () => {
  test("round-trips a serialized query", () => {
    const values = formValues({
      repo: "acme/api,acme/web",
      label: "bug",
      timeRange: "custom",
      since: "2026-01-01",
      until: "2026-03-31",
      team: "alice, bob",
      includeBots: true,
    });
    expect(parseQuery(serializeQuery(values))).toEqual(values);
  });

  test("never turns the refresh choice on", () => {
    expect(parseQuery(serializeQuery(formValues({ repo: "acme/api", skipCache: true })))).toEqual(
      formValues({ repo: "acme/api" }),
    );
  });

  test("returns null when the string carries no query", () => {
    expect(parseQuery("")).toBeNull();
    expect(parseQuery("?utm_source=chat")).toBeNull();
  });

  test("falls back to the defaults for an unknown range and missing fields", () => {
    expect(parseQuery("?range=decade&team=alice")).toEqual(formValues({ team: "alice" }));
  });

  test("drops dates unless the range is custom, as when written", () => {
    expect(parseQuery("?repo=acme%2Fapi&range=week&since=2020-01-01&until=2020-02-01")).toEqual(
      formValues({ repo: "acme/api", timeRange: "week" }),
    );
  });

  test("reads includeBots only when it is 1", () => {
    expect(parseQuery("?includeBots=yes")).toEqual(formValues());
  });
});

describe("rememberedQuery", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("returns null when storage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(rememberedQuery()).toBeNull();
  });

  test("reads the remembered query string", () => {
    const stored = new Map([["pr-reviews-analysis:last-query", "repo=acme%2Fapi&range=week"]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key: string) => stored.get(key) ?? null },
    });
    expect(rememberedQuery()).toEqual(formValues({ repo: "acme/api", timeRange: "week" }));
  });
});
