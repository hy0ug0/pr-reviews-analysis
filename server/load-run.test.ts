import { expect, test } from "bun:test";
import type { AnalysisProgress } from "../shared/types.ts";
import { startLoadRun, type ProgressListener } from "./load-run.ts";

// A load the test drives by hand: publish progress, then settle it.
function manualRun() {
  let publish: ProgressListener = () => {};
  let resolve: (value: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const run = startLoadRun<string>({ phase: "listing-cache" }, (publishProgress) => {
    publish = publishProgress;
    return new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return { run, publish: (p: AnalysisProgress) => publish(p), resolve, reject };
}

const prCache: AnalysisProgress = { phase: "pr-cache", prs: 3 };
const analyzing: AnalysisProgress = { phase: "analyzing", prs: 3 };

test("a subscriber gets the current snapshot, then each new one", () => {
  const { run, publish } = manualRun();
  const seen: AnalysisProgress[] = [];

  run.subscribe((progress) => seen.push(progress));
  publish(prCache);

  expect(seen).toEqual([{ phase: "listing-cache" }, prCache]);
});

test("a late joiner gets the latest snapshot right away", () => {
  const { run, publish } = manualRun();
  publish(prCache);
  const seen: AnalysisProgress[] = [];

  run.subscribe((progress) => seen.push(progress));

  expect(seen).toEqual([prCache]);
  expect(run.progress()).toEqual(prCache);
});

test("an aborted subscriber stops getting progress, and the load goes on for the others", async () => {
  const { run, publish, resolve } = manualRun();
  const leaving = new AbortController();
  const left: AnalysisProgress[] = [];
  const stayed: AnalysisProgress[] = [];
  run.subscribe((progress) => left.push(progress), leaving.signal);
  run.subscribe((progress) => stayed.push(progress));

  leaving.abort();
  publish(prCache);
  resolve("result");

  expect(left).toEqual([{ phase: "listing-cache" }]);
  expect(stayed).toEqual([{ phase: "listing-cache" }, prCache]);
  expect(await run.promise).toBe("result");
});

test("a subscriber whose signal is already aborted is never called", () => {
  const { run } = manualRun();
  const aborted = AbortSignal.abort();
  const seen: AnalysisProgress[] = [];

  run.subscribe((progress) => seen.push(progress), aborted);

  expect(seen).toEqual([]);
});

test("every request that shares the run gets the same result", async () => {
  const { run, resolve } = manualRun();
  const first = run.promise;
  const joined = run.promise;

  resolve("result");

  expect(await Promise.all([first, joined])).toEqual(["result", "result"]);
});

test("a failed load rejects for every request", async () => {
  const { run, reject } = manualRun();

  reject(new Error("rate limited"));

  expect(await run.promise.catch((error: unknown) => error)).toEqual(new Error("rate limited"));
});

test("a throwing subscriber does not stop the others or the load", async () => {
  const { run, publish, resolve } = manualRun();
  const seen: AnalysisProgress[] = [];
  run.subscribe((progress) => {
    if (progress.phase === "analyzing") throw new Error("listener bug");
  });
  run.subscribe((progress) => seen.push(progress));

  publish(analyzing);
  resolve("result");

  expect(seen).toEqual([{ phase: "listing-cache" }, analyzing]);
  expect(await run.promise).toBe("result");
});
