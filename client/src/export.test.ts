import { describe, expect, test } from "bun:test";
import type { ShownAnalysis } from "./analysisState";
import { exportFilename, toExportJson } from "./export";
import type { AnalysisResult, AnalyzeFormValues } from "./types";

function shownAnalysis(
  values: Partial<AnalyzeFormValues>,
  timeRange = { since: "2026-10-01", until: "2026-11-09" },
): ShownAnalysis {
  // The exports only read the time range off the result and copy the rest whole.
  const result = { matchingPRs: 3, timeRange, byRepo: [] } as unknown as AnalysisResult;
  return {
    result,
    values: {
      repo: "acme/widgets",
      label: "",
      timeRange: "custom",
      since: "",
      until: "",
      team: "",
      includeBots: false,
      skipCache: false,
      ...values,
    },
    team: [],
    repo: null,
  };
}

describe("exportFilename", () => {
  test("names the repository and the resolved range", () => {
    expect(exportFilename(shownAnalysis({}), "json")).toBe(
      "pr-reviews-acme-widgets-2026-10-01-2026-11-09.json",
    );
  });

  test("joins a few repositories with +", () => {
    expect(exportFilename(shownAnalysis({ repo: "acme/a, acme/b" }), "png")).toBe(
      "pr-reviews-acme-a+acme-b-2026-10-01-2026-11-09.png",
    );
  });

  test("counts the repositories past three instead of naming them", () => {
    expect(exportFilename(shownAnalysis({ repo: "acme/a, acme/b, acme/c, acme/d" }), "png")).toBe(
      "pr-reviews-4-repos-2026-10-01-2026-11-09.png",
    );
  });

  test("names the open ends of an all-time range", () => {
    expect(exportFilename(shownAnalysis({}, { since: "", until: "" }), "json")).toBe(
      "pr-reviews-acme-widgets-start-today.json",
    );
  });
});

describe("toExportJson", () => {
  test("puts the query it answers before the whole result", () => {
    const shown = shownAnalysis({
      repo: "acme/a, acme/b",
      label: "backend",
      team: "alice, bob",
      includeBots: true,
    });

    const json = toExportJson(shown, new Date("2026-11-09T10:00:00Z"));

    expect(JSON.parse(json)).toEqual({
      exportedAt: "2026-11-09T10:00:00.000Z",
      query: {
        repos: ["acme/a", "acme/b"],
        label: "backend",
        team: ["alice", "bob"],
        timeRange: { since: "2026-10-01", until: "2026-11-09" },
        includeBots: true,
      },
      result: {
        matchingPRs: 3,
        timeRange: { since: "2026-10-01", until: "2026-11-09" },
        byRepo: [],
      },
    });
    expect(json).toStartWith('{\n  "exportedAt"');
  });

  test("an unset label and open range ends come out as null", () => {
    const json = toExportJson(
      shownAnalysis({}, { since: "", until: "" }),
      new Date("2026-11-09T10:00:00Z"),
    );

    expect(JSON.parse(json).query).toEqual({
      repos: ["acme/widgets"],
      label: null,
      team: [],
      timeRange: { since: null, until: null },
      includeBots: false,
    });
  });
});
