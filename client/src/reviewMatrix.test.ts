import { describe, expect, test } from "bun:test";
import {
  buildMatrixView,
  describeCell,
  SHADE_LEVELS,
  shadeLevel,
  shadeRanges,
  toCsv,
  type MatrixEntry,
} from "./reviewMatrix";
import type { ReviewMatrixCell } from "./types";

function cell(author: string | null, reviewer: string, reviews: number, prs = reviews) {
  return { author, reviewer, reviews, prs } satisfies ReviewMatrixCell;
}

function names(entries: MatrixEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "person" ? (entry.login ?? "(deleted)") : `${entry.count} others`,
  );
}

const CELLS = [
  cell("alice", "bob", 5, 1),
  cell("alice", "carol", 2, 2),
  cell("bob", "alice", 3, 3),
  cell("dave", "bob", 1),
  cell(null, "carol", 1),
];

describe("buildMatrixView", () => {
  test("orders authors and reviewers by their total for the metric", () => {
    const byReviews = buildMatrixView({ cells: CELLS, metric: "reviews", limit: null });
    const byPRs = buildMatrixView({ cells: CELLS, metric: "prs", limit: null });

    expect(names(byReviews.rows)).toEqual(["alice", "bob", "dave", "(deleted)"]);
    expect(names(byReviews.columns)).toEqual(["bob", "alice", "carol"]);
    expect(names(byPRs.rows)).toEqual(["alice", "bob", "dave", "(deleted)"]);
    expect(names(byPRs.columns)).toEqual(["alice", "carol", "bob"]);
  });

  test("fills every cell, zeros included, and sums rows, columns and the whole", () => {
    const view = buildMatrixView({ cells: CELLS, metric: "reviews", limit: null });

    expect(view.counts.map((row) => row.map((counts) => counts.reviews))).toEqual([
      [5, 0, 2],
      [0, 3, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    expect(view.rows.map((row) => row.totals.reviews)).toEqual([7, 3, 1, 1]);
    expect(view.columns.map((column) => column.totals.reviews)).toEqual([6, 3, 3]);
    expect(view.totals).toEqual({ reviews: 12, prs: 8 });
    expect(view.max).toBe(5);
    expect(view.authorCount).toBe(4);
    expect(view.reviewerCount).toBe(3);
  });

  test("folds the authors and reviewers past the cap into one row and column", () => {
    const cells = [
      cell("a1", "r1", 9),
      cell("a2", "r2", 8),
      cell("a3", "r3", 7),
      cell("a4", "r1", 6),
    ];

    const view = buildMatrixView({ cells, metric: "reviews", limit: 1 });

    expect(names(view.rows)).toEqual(["a1", "3 others"]);
    expect(names(view.columns)).toEqual(["r1", "2 others"]);
    expect(view.counts.map((row) => row.map((counts) => counts.reviews))).toEqual([
      [9, 0],
      [6, 15],
    ]);
    expect(view.rows[1].totals.reviews).toBe(21);
    // Folded pairs still set the top of the scale.
    expect(view.max).toBe(9);
  });

  test("doesn't fold a single person", () => {
    const cells = [cell("a1", "r1", 2), cell("a2", "r1", 1)];

    expect(names(buildMatrixView({ cells, metric: "reviews", limit: 1 }).rows)).toEqual([
      "a1",
      "a2",
    ]);
  });

  test("is empty without cells", () => {
    const view = buildMatrixView({ cells: [], metric: "reviews", limit: 15 });

    expect(view).toEqual({
      rows: [],
      columns: [],
      counts: [],
      totals: { reviews: 0, prs: 0 },
      authorCount: 0,
      reviewerCount: 0,
      max: 0,
    });
  });
});

describe("shades", () => {
  test("no review has no shade and the largest count the darkest", () => {
    expect(shadeLevel(0, 40)).toBe(0);
    expect(shadeLevel(1, 40)).toBe(1);
    expect(shadeLevel(40, 40)).toBe(SHADE_LEVELS);
  });

  test("the scale is square-root, so mid counts reach the middle shades", () => {
    expect(shadeLevel(10, 40)).toBe(3);
  });

  test("the legend ranges cover every count once, in order", () => {
    expect(shadeRanges(25)).toEqual([
      { level: 1, min: 1, max: 1 },
      { level: 2, min: 2, max: 4 },
      { level: 3, min: 5, max: 9 },
      { level: 4, min: 10, max: 16 },
      { level: 5, min: 17, max: 25 },
    ]);
  });

  test("a small max leaves unused shades out of the legend", () => {
    expect(shadeRanges(2)).toEqual([
      { level: 4, min: 1, max: 1 },
      { level: 5, min: 2, max: 2 },
    ]);
  });
});

function person(login: string | null): MatrixEntry {
  return { kind: "person", login, totals: { reviews: 0, prs: 0 } };
}

function others(count: number): MatrixEntry {
  return { kind: "others", count, totals: { reviews: 0, prs: 0 } };
}

describe("describeCell", () => {
  test("says who reviewed whose PRs, in the metric shown", () => {
    const pair = {
      author: person("bob"),
      reviewer: person("alice"),
      counts: { reviews: 7, prs: 3 },
    };

    expect(describeCell({ ...pair, metric: "reviews" })).toBe("alice reviewed bob's PRs 7 times");
    expect(describeCell({ ...pair, metric: "prs" })).toBe("alice reviewed 3 of bob's PRs");
  });

  test("reads naturally for one or two reviews and for none", () => {
    const pair = { author: person("bob"), reviewer: person("alice"), metric: "reviews" as const };

    expect(describeCell({ ...pair, counts: { reviews: 1, prs: 1 } })).toBe(
      "alice reviewed bob's PRs once",
    );
    expect(describeCell({ ...pair, counts: { reviews: 2, prs: 1 } })).toBe(
      "alice reviewed bob's PRs twice",
    );
    expect(describeCell({ ...pair, counts: { reviews: 0, prs: 0 } })).toBe(
      "alice didn't review bob's PRs",
    );
  });

  test("names folded people, deleted authors and someone's own PRs", () => {
    const counts = { reviews: 4, prs: 2 };

    expect(
      describeCell({ author: others(3), reviewer: person("alice"), counts, metric: "reviews" }),
    ).toBe("alice reviewed PRs by 3 other authors 4 times");
    expect(describeCell({ author: person(null), reviewer: others(2), counts, metric: "prs" })).toBe(
      "2 other reviewers reviewed 2 of a deleted account's PRs",
    );
    expect(
      describeCell({
        author: person("alice"),
        reviewer: person("Alice"),
        counts: { reviews: 0, prs: 0 },
        metric: "reviews",
      }),
    ).toBe("Authors can't review their own PRs");
  });
});

describe("toCsv", () => {
  test("writes the whole matrix with totals for the metric", () => {
    expect(toCsv(CELLS, "prs").split("\n")).toEqual([
      "Author \\ Reviewer,alice,carol,bob,Total",
      "alice,0,2,1,3",
      "bob,3,0,0,3",
      "dave,0,0,1,1",
      "(deleted account),0,1,0,1",
      "Total,3,3,2,8",
    ]);
  });
});
