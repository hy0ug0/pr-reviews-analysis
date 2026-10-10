import { describe, expect, test } from "bun:test";
import { describeProgress, progressSentence, rateLimitNotice } from "./progress.ts";
import type { AnalysisProgress } from "./types.ts";

function plain(details: string[]): string[] {
  return details.map((detail) => detail.replaceAll(" ", " "));
}

type Listing = Extract<AnalysisProgress, { phase: "listing" }>;
type Fetching = Extract<AnalysisProgress, { phase: "fetching" }>;
type ListingRepo = Listing["repos"][number];
type FetchingRepo = Fetching["repos"][number];

function listingRepo(repo: string, counts: Partial<ListingRepo> = {}): ListingRepo {
  return { repo, listed: 0, matching: null, page: 0, windowsDone: 0, windowsTotal: 1, ...counts };
}

function fetchingRepo(repo: string, counts: Partial<FetchingRepo> = {}): FetchingRepo {
  return {
    repo,
    prsDone: 0,
    prsTotal: 100,
    batchesDone: 0,
    batchesTotal: 4,
    reviewPRsDone: 0,
    reviewPRsTotal: null,
    ...counts,
  };
}

function listing(...repos: ListingRepo[]): Listing {
  return { phase: "listing", repos };
}

function fetching(...repos: FetchingRepo[]): Fetching {
  return { phase: "fetching", repos };
}

const vite = fetchingRepo("vitejs/vite", {
  prsDone: 150,
  prsTotal: 412,
  batchesDone: 6,
  batchesTotal: 17,
});

describe("describeProgress with one repo", () => {
  test("listing is indeterminate until the first page gives the total", () => {
    const view = describeProgress(listing(listingRepo("vitejs/vite")));

    expect(view).toMatchObject({ step: 0, fraction: null, floor: 0, label: "Listing PRs" });
    expect(plain(view.details)).toEqual(["vitejs/vite"]);
    expect(view.repos).toEqual([]);
  });

  test("listing with a total is determinate and names the page and window", () => {
    const view = describeProgress(
      listing(
        listingRepo("vitejs/vite", {
          listed: 300,
          matching: 1200,
          page: 3,
          windowsDone: 1,
          windowsTotal: 3,
        }),
      ),
    );

    expect(view.fraction).toBeCloseTo(0.15 * 0.25);
    expect(plain(view.details)).toEqual([
      "vitejs/vite",
      "300 of 1,200 PRs (page 3, window 2 of 3)",
    ]);
  });

  test("a listed repo fills the step, even short of its total past the Search limit", () => {
    const view = describeProgress(
      listing(
        listingRepo("vitejs/vite", {
          listed: 1000,
          matching: 1200,
          page: 10,
          windowsDone: 2,
          windowsTotal: 2,
        }),
      ),
    );

    expect(view.fraction).toBeCloseTo(0.15);
    expect(plain(view.details)).toEqual(["vitejs/vite", "1,000 of 1,200 PRs"]);
  });

  test("fetching counts PRs and batches", () => {
    const view = describeProgress(fetching(vite));

    // Batches fill 85% of the fetch span; the extra review pages get the rest.
    expect(view.fraction).toBeCloseTo(0.2 + 0.75 * 0.85 * (150 / 412));
    expect(progressSentence(view)).toBe(
      "Fetching PR details: vitejs/vite, 150 of 412 PRs (6 of 17 batches)",
    );
    expect(view.repos).toEqual([]);
  });

  const batchesDone = { ...vite, prsDone: 412, batchesDone: 17 };

  test("after the batches, the extra review pages move the bar on", () => {
    const at = (reviewPRsDone: number) =>
      describeProgress(fetching({ ...batchesDone, reviewPRsDone, reviewPRsTotal: 100 }));

    expect(at(0).label).toBe("Fetching more reviews");
    expect(plain(at(3).details)).toEqual(["vitejs/vite", "3 of 100 PRs"]);
    expect(at(0).fraction).toBeCloseTo(0.2 + 0.75 * 0.85);
    expect(at(50).fraction).toBeCloseTo(0.2 + 0.75 * (0.85 + 0.15 * 0.5));
    expect(at(100).fraction).toBeCloseTo(0.95);
  });

  test("until the count of PRs needing more pages is known, that part is indeterminate", () => {
    const view = describeProgress(fetching({ ...batchesDone, reviewPRsTotal: null }));

    expect(view).toMatchObject({ label: "Fetching more reviews", fraction: null });
    expect(view.floor).toBeCloseTo(0.2 + 0.75 * 0.85);
    expect(plain(view.details)).toEqual(["vitejs/vite"]);
  });

  test("a repo with no extra review pages ends its share", () => {
    const view = describeProgress(fetching({ ...batchesDone, reviewPRsTotal: 0 }));

    expect(view.label).toBe("Fetching PR details");
    expect(view.fraction).toBeCloseTo(0.95);
  });
});

describe("describeProgress with several repos", () => {
  test("listing shows the repo count and one line per repo, indeterminate until every total is known", () => {
    const view = describeProgress(
      listing(
        listingRepo("colinhacks/zod", { listed: 100, matching: 286, page: 1 }),
        listingRepo("honojs/hono"),
      ),
    );

    expect(view).toMatchObject({ fraction: null, floor: 0 });
    expect(plain(view.details)).toEqual(["2 repos"]);
    expect(view.repos.map((line) => ({ ...line, detail: plain([line.detail])[0] }))).toEqual([
      { repo: "colinhacks/zod", detail: "100 of 286 PRs", done: false },
      { repo: "honojs/hono", detail: "", done: false },
    ]);
  });

  test("listing totals sum the repos, and a listed repo counts in full", () => {
    const view = describeProgress(
      listing(
        // Listed, but 50 short of its total past the Search limit.
        listingRepo("colinhacks/zod", { listed: 250, matching: 300, page: 3, windowsDone: 1 }),
        listingRepo("honojs/hono", { listed: 100, matching: 400, page: 1 }),
        listingRepo("oven-sh/bun", {
          listed: 500,
          matching: 2300,
          page: 5,
          windowsDone: 1,
          windowsTotal: 3,
        }),
      ),
    );

    expect(view.fraction).toBeCloseTo(0.15 * ((300 + 100 + 500) / 3000));
    expect(progressSentence(view)).toBe("Listing PRs: 3 repos, 850 of 3,000 PRs");
    expect(view.repos.map((line) => [line.repo, plain([line.detail])[0], line.done])).toEqual([
      ["colinhacks/zod", "250 PRs", true],
      ["honojs/hono", "100 of 400 PRs", false],
      ["oven-sh/bun", "500 of 2,300 PRs (window 2 of 3)", false],
    ]);
  });

  test("fetching sums PRs and batches; each repo weighs its PR count", () => {
    // 100 PRs fetching their extra reviews, 300 still in batches.
    const view = describeProgress(
      fetching(
        fetchingRepo("colinhacks/zod", {
          prsDone: 100,
          batchesDone: 4,
          reviewPRsDone: 1,
          reviewPRsTotal: 4,
        }),
        fetchingRepo("honojs/hono", {
          prsDone: 75,
          prsTotal: 300,
          batchesDone: 3,
          batchesTotal: 12,
        }),
      ),
    );

    expect(view.label).toBe("Fetching PR details");
    expect(view.fraction).toBeCloseTo(
      0.2 + 0.75 * ((100 * (0.85 + 0.15 * 0.25) + 300 * 0.85 * 0.25) / 400),
    );
    expect(progressSentence(view)).toBe(
      "Fetching PR details: 2 repos, 175 of 400 PRs (7 of 16 batches)",
    );
    expect(view.repos.map((line) => [line.repo, plain([line.detail])[0], line.done])).toEqual([
      ["colinhacks/zod", "more reviews, 1 of 4 PRs", false],
      ["honojs/hono", "75 of 300 PRs", false],
    ]);
  });

  test("once every batch is done, the extra review pages are summed", () => {
    const view = describeProgress(
      fetching(
        fetchingRepo("colinhacks/zod", { prsDone: 100, batchesDone: 4, reviewPRsTotal: 0 }),
        fetchingRepo("honojs/hono", {
          prsDone: 100,
          batchesDone: 4,
          reviewPRsDone: 3,
          reviewPRsTotal: 10,
        }),
      ),
    );

    expect(progressSentence(view)).toBe("Fetching more reviews: 2 repos, 3 of 10 PRs");
    expect(view.repos.map((line) => [plain([line.detail])[0], line.done])).toEqual([
      ["100 PRs", true],
      ["more reviews, 3 of 10 PRs", false],
    ]);
  });

  test("a repo between its batches and its review count makes the bar indeterminate from the known shares", () => {
    const before = describeProgress(
      fetching(
        fetchingRepo("colinhacks/zod", { prsDone: 75, batchesDone: 3 }),
        fetchingRepo("honojs/hono", { prsDone: 50, batchesDone: 2 }),
      ),
    );
    const between = describeProgress(
      fetching(
        fetchingRepo("colinhacks/zod", { prsDone: 100, batchesDone: 4 }),
        fetchingRepo("honojs/hono", { prsDone: 50, batchesDone: 2 }),
      ),
    );

    expect(between.fraction).toBeNull();
    expect(between.floor).toBeCloseTo(0.2 + 0.75 * ((100 * 0.85 + 100 * 0.85 * 0.5) / 200));
    expect(between.floor).toBeGreaterThan(before.fraction ?? 1);
  });

  test("the bar only grows as repos move on in any order", () => {
    const zod = (prsDone: number) =>
      fetchingRepo("colinhacks/zod", { prsDone, batchesDone: prsDone / 25 });
    const hono = (prsDone: number) =>
      fetchingRepo("honojs/hono", {
        prsDone,
        prsTotal: 300,
        batchesTotal: 12,
        batchesDone: prsDone / 25,
      });
    const snapshots = [
      fetching(zod(0), hono(0)),
      fetching(zod(0), hono(25)),
      fetching(zod(25), hono(25)),
      fetching(zod(25), hono(150)),
      fetching(zod(100), hono(150)),
      fetching({ ...zod(100), reviewPRsTotal: 2 }, hono(150)),
      fetching({ ...zod(100), reviewPRsTotal: 2, reviewPRsDone: 2 }, hono(300)),
    ];

    const reached = snapshots.map((snapshot) => {
      const view = describeProgress(snapshot);
      return view.fraction ?? view.floor;
    });

    expect(reached).toEqual([...reached].sort((a, b) => a - b));
  });
});

describe("describeProgress for steps without repos", () => {
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
      repos: [],
    });
  });

  test("keeps each number with its unit", () => {
    expect(describeProgress({ phase: "pr-cache", prs: 592 }).details).toEqual(["592 PRs"]);
  });
});

describe("rate-limit waits", () => {
  const until = "2026-10-10T12:00:30.000Z";
  const untilMs = Date.parse(until);

  test("listing and fetching carry the wait's end, and the bar is unchanged", () => {
    const listed = listing(listingRepo("vitejs/vite"), listingRepo("honojs/hono"));
    expect(describeProgress({ ...listed, rateLimitedUntil: until }).rateLimitedUntil).toBe(untilMs);
    const waiting = describeProgress({ ...fetching(vite), rateLimitedUntil: until });
    expect(waiting).toEqual({ ...describeProgress(fetching(vite)), rateLimitedUntil: untilMs });
  });

  test("no wait is null", () => {
    expect(describeProgress(fetching(vite)).rateLimitedUntil).toBeNull();
    expect(describeProgress({ phase: "analyzing", prs: 3 }).rateLimitedUntil).toBeNull();
  });

  test("the sentence names the wait without a countdown", () => {
    expect(progressSentence(describeProgress({ ...fetching(vite), rateLimitedUntil: until }))).toBe(
      "Fetching PR details: vitejs/vite, 150 of 412 PRs (6 of 17 batches). Waiting for GitHub rate limit",
    );
  });

  test("the notice counts down in whole seconds and stops at zero", () => {
    expect(plain([rateLimitNotice(untilMs, untilMs - 37_000)])).toEqual([
      "Waiting for GitHub rate limit, resuming in 37 s",
    ]);
    expect(plain([rateLimitNotice(untilMs, untilMs - 36_200)])).toEqual([
      "Waiting for GitHub rate limit, resuming in 37 s",
    ]);
    expect(plain([rateLimitNotice(untilMs, untilMs - 400)])).toEqual([
      "Waiting for GitHub rate limit, resuming in 1 s",
    ]);
    expect(rateLimitNotice(untilMs, untilMs)).toBe("Waiting for GitHub rate limit, resuming…");
    expect(rateLimitNotice(untilMs, untilMs + 5000)).toBe(
      "Waiting for GitHub rate limit, resuming…",
    );
  });
});
