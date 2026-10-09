import { expect, test } from "bun:test";
import { analysisReducer, initialAnalysisState, type AnalysisEvent } from "./analysisState";
import type { AnalysisResult, AnalyzeFormValues } from "./types";

function formValues(repo: string, team = ""): AnalyzeFormValues {
  return {
    repo,
    label: "",
    timeRange: "month",
    since: "",
    until: "",
    team,
    includeBots: false,
    skipCache: false,
  };
}

// The reducer stores the result without reading it, so any object stands in.
const resultA = { matchingPRs: 1 } as unknown as AnalysisResult;

function run(...events: AnalysisEvent[]) {
  return events.reduce(analysisReducer, initialAnalysisState);
}

test("a successful run stores its result with the values and team it ran with", () => {
  const values = formValues("acme/a", "alice, bob");

  const state = run({ kind: "started" }, { kind: "succeeded", values, result: resultA });

  expect(state).toEqual({
    shown: { result: resultA, values, team: ["alice", "bob"] },
    loading: false,
    error: null,
  });
});

test("a failed run keeps the shown analysis and its values, so Refresh reruns A", () => {
  const valuesA = formValues("acme/a");

  const state = run(
    { kind: "started" },
    { kind: "succeeded", values: valuesA, result: resultA },
    { kind: "started" },
    { kind: "failed", message: "acme/b not found" },
  );

  expect(state.shown?.values).toBe(valuesA);
  expect(state.shown?.result).toBe(resultA);
  expect(state.error).toBe("acme/b not found");
  expect(state.loading).toBe(false);
});

test("starting a run clears the previous error and keeps the shown analysis", () => {
  const valuesA = formValues("acme/a");

  const state = run(
    { kind: "succeeded", values: valuesA, result: resultA },
    { kind: "failed", message: "boom" },
    { kind: "started" },
  );

  expect(state).toMatchObject({ loading: true, error: null, shown: { values: valuesA } });
});
