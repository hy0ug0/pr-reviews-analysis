import { describe, expect, test } from "bun:test";
import { describeProgress, progressSentence } from "./progress.ts";
import type { AnalysisProgress } from "./types.ts";

function plain(details: string[]): string[] {
  return details.map((detail) => detail.replaceAll(" ", " "));
}

const listing = {
  phase: "listing",
  repo: "vitejs/vite",
  repoIndex: 0,
  repoCount: 1,
  listed: 0,
  matching: null,
  page: 0,
  windowsDone: 0,
  windowsTotal: 1,
} satisfies AnalysisProgress;

const fetching = {
  phase: "fetching",
  repo: "vitejs/vite",
  repoIndex: 0,
  repoCount: 1,
  prsDone: 150,
  prsTotal: 412,
  batchesDone: 6,
  batchesTotal: 17,
  reviewPRsDone: 0,
  reviewPRsTotal: null,
} satisfies AnalysisProgress;

describe("describeProgress", () => {
  test("listing is indeterminate until the first page gives the total", () => {
    const view = describeProgress(listing);

    expect(view).toMatchObject({ step: 0, fraction: null, floor: 0, label: "Listing PRs" });
    expect(plain(view.details)).toEqual(["vitejs/vite"]);
  });

  test("listing with a total is determinate and names the page and window", () => {
    const view = describeProgress({
      ...listing,
      listed: 300,
      matching: 1200,
      page: 3,
      windowsDone: 1,
      windowsTotal: 3,
    });

    expect(view.fraction).toBeCloseTo(0.15 * 0.25);
    expect(plain(view.details)).toEqual([
      "vitejs/vite",
      "300 of 1,200 PRs (page 3, window 2 of 3)",
    ]);
  });

  test("the second of two repos starts halfway through the listing step", () => {
    const view = describeProgress({ ...listing, repoIndex: 1, repoCount: 2 });

    expect(view.floor).toBeCloseTo(0.075);
    expect(plain(view.details)).toEqual(["vitejs/vite", "repo 2 of 2"]);
  });

  test("fetching counts PRs and batches", () => {
    const view = describeProgress(fetching);

    expect(view.fraction).toBeCloseTo(0.2 + 0.75 * (150 / 412));
    expect(progressSentence(view)).toBe(
      "Fetching PR details: vitejs/vite, 150 of 412 PRs (6 of 17 batches)",
    );
  });

  test("after the batches, fetching names the extra review pages", () => {
    const view = describeProgress({
      ...fetching,
      prsDone: 412,
      batchesDone: 17,
      reviewPRsDone: 3,
      reviewPRsTotal: 7,
    });

    expect(view.label).toBe("Fetching more reviews");
    expect(plain(view.details)).toEqual(["vitejs/vite", "3 of 7 PRs"]);
    expect(view.fraction).toBeCloseTo(0.95);
  });

  test("steps without counts are indeterminate from their start", () => {
    expect(describeProgress({ phase: "listing-cache" })).toMatchObject({ step: 0, fraction: null });
    expect(describeProgress({ phase: "pr-cache", prs: 592 })).toMatchObject({
      step: 1,
      fraction: null,
      floor: 0.15,
    });
    expect(describeProgress({ phase: "analyzing", prs: 592 })).toMatchObject({
      step: 3,
      fraction: null,
      floor: 0.95,
    });
  });

  test("keeps each number with its unit", () => {
    expect(describeProgress({ phase: "pr-cache", prs: 592 }).details).toEqual(["592 PRs"]);
  });
});
