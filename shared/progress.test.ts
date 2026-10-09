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
  repoPRsDone: 150,
  repoPRsTotal: 412,
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

    // Batches fill 85% of the fetch span; the extra review pages get the rest.
    expect(view.fraction).toBeCloseTo(0.2 + 0.75 * 0.85 * (150 / 412));
    expect(progressSentence(view)).toBe(
      "Fetching PR details: vitejs/vite, 150 of 412 PRs (6 of 17 batches)",
    );
  });

  const batchesDone = { ...fetching, prsDone: 412, repoPRsDone: 412, batchesDone: 17 };

  test("after the batches, the extra review pages move the bar on", () => {
    const at = (reviewPRsDone: number) =>
      describeProgress({ ...batchesDone, reviewPRsDone, reviewPRsTotal: 100 });

    expect(at(0).label).toBe("Fetching more reviews");
    expect(plain(at(3).details)).toEqual(["vitejs/vite", "3 of 100 PRs"]);
    expect(at(0).fraction).toBeCloseTo(0.2 + 0.75 * 0.85);
    expect(at(50).fraction).toBeCloseTo(0.2 + 0.75 * (0.85 + 0.15 * 0.5));
    expect(at(100).fraction).toBeCloseTo(0.95);
  });

  test("until the count of PRs needing more pages is known, that part is indeterminate", () => {
    const view = describeProgress({ ...batchesDone, reviewPRsTotal: null });

    expect(view).toMatchObject({ label: "Fetching more reviews", fraction: null });
    expect(view.floor).toBeCloseTo(0.2 + 0.75 * 0.85);
  });

  test("a repo with no extra review pages ends its share", () => {
    const view = describeProgress({ ...batchesDone, reviewPRsTotal: 0 });

    expect(view.label).toBe("Fetching PR details");
    expect(view.fraction).toBeCloseTo(0.95);
  });

  test("each repo weighs its PR count, and the next repo starts where the last ended", () => {
    // 100 PRs in the first repo, 300 in the second.
    const firstDone = describeProgress({
      ...fetching,
      repoIndex: 0,
      repoCount: 2,
      prsDone: 100,
      prsTotal: 400,
      repoPRsDone: 100,
      repoPRsTotal: 100,
      batchesDone: 4,
      batchesTotal: 4,
      reviewPRsDone: 2,
      reviewPRsTotal: 2,
    });
    const secondStarted = describeProgress({
      ...fetching,
      repoIndex: 1,
      repoCount: 2,
      prsDone: 100,
      prsTotal: 400,
      repoPRsDone: 0,
      repoPRsTotal: 300,
      batchesDone: 0,
      batchesTotal: 12,
    });

    expect(firstDone.fraction).toBeCloseTo(0.2 + 0.75 * 0.25);
    expect(secondStarted.fraction).toBeCloseTo(firstDone.fraction ?? -1);
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
