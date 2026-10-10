import { pluralize } from "../../shared/format";
import type { ReviewMatrixCell } from "./types";

// What a matrix cell shows: the reviews a reviewer left on an author's PRs, or how many of
// those PRs they reviewed. A reviewer who leaves five comment reviews on one PR counts 5
// reviews but 1 PR.
export type MatrixMetric = "reviews" | "prs";

export interface MatrixCounts {
  reviews: number;
  prs: number;
}

// A row (an author) or a column (a reviewer): one person, or the people past the cap folded
// together. A null login is a deleted account, which only authors can be.
export type MatrixEntry =
  | { kind: "person"; login: string | null; totals: MatrixCounts }
  | { kind: "others"; count: number; totals: MatrixCounts };

export interface MatrixView {
  // Authors, then reviewers, each ordered by their total for the metric, highest first.
  rows: MatrixEntry[];
  columns: MatrixEntry[];
  // counts[row][column].
  counts: MatrixCounts[][];
  totals: MatrixCounts;
  authorCount: number;
  reviewerCount: number;
  // The largest count of one author and reviewer pair, over every pair, shown or folded:
  // the top of the shade scale, so showing all doesn't change the shades.
  max: number;
}

const NONE: MatrixCounts = { reviews: 0, prs: 0 };

function add(a: MatrixCounts, b: MatrixCounts): MatrixCounts {
  return { reviews: a.reviews + b.reviews, prs: a.prs + b.prs };
}

// Highest total first, then by login, with deleted authors last.
function rank(totals: Map<string | null, MatrixCounts>, metric: MatrixMetric): (string | null)[] {
  return [...totals]
    .sort(([loginA, a], [loginB, b]) => {
      if (a[metric] !== b[metric]) return b[metric] - a[metric];
      if (loginA === null || loginB === null)
        return (loginA === null ? 1 : 0) - (loginB === null ? 1 : 0);
      return loginA.localeCompare(loginB);
    })
    .map(([login]) => login);
}

interface Capped {
  shown: (string | null)[];
  folded: (string | null)[];
}

// Folding a single person into "1 other" hides them for nothing, so the cap only folds two
// or more.
function capped(logins: (string | null)[], limit: number | null): Capped {
  if (limit === null || logins.length <= limit + 1) return { shown: logins, folded: [] };
  return { shown: logins.slice(0, limit), folded: logins.slice(limit) };
}

// Each row or column as the logins it covers: one person, or everyone folded.
function loginGroups({ shown, folded }: Capped): (string | null)[][] {
  return [...shown.map((login) => [login]), ...(folded.length > 0 ? [folded] : [])];
}

function toEntries(
  { shown, folded }: Capped,
  totalsOf: ReadonlyMap<string | null, MatrixCounts>,
): MatrixEntry[] {
  const totalOf = (login: string | null) => totalsOf.get(login) ?? NONE;
  const people = shown.map((login): MatrixEntry => ({
    kind: "person",
    login,
    totals: totalOf(login),
  }));
  if (folded.length === 0) return people;
  const others: MatrixEntry = {
    kind: "others",
    count: folded.length,
    totals: folded.reduce((sum, login) => add(sum, totalOf(login)), NONE),
  };
  return [...people, others];
}

export function buildMatrixView({
  cells,
  metric,
  limit,
}: {
  cells: readonly ReviewMatrixCell[];
  metric: MatrixMetric;
  // How many authors and how many reviewers to show; null shows everyone.
  limit: number | null;
}): MatrixView {
  const authorTotals = new Map<string | null, MatrixCounts>();
  // Reviewers always have a login; the key type is the authors' so both rank the same way.
  const reviewerTotals = new Map<string | null, MatrixCounts>();
  const byPair = new Map<string | null, Map<string, MatrixCounts>>();
  let totals = NONE;
  let max = 0;
  for (const { author, reviewer, reviews, prs } of cells) {
    const counts = { reviews, prs };
    authorTotals.set(author, add(authorTotals.get(author) ?? NONE, counts));
    reviewerTotals.set(reviewer, add(reviewerTotals.get(reviewer) ?? NONE, counts));
    const row = byPair.get(author) ?? new Map<string, MatrixCounts>();
    byPair.set(author, row);
    row.set(reviewer, counts);
    totals = add(totals, counts);
    max = Math.max(max, counts[metric]);
  }

  const authors = capped(rank(authorTotals, metric), limit);
  const reviewers = capped(rank(reviewerTotals, metric), limit);
  const rowGroups = loginGroups(authors);
  const columnGroups = loginGroups(reviewers);

  const sumPairs = (rowAuthors: (string | null)[], columnReviewers: (string | null)[]) => {
    let sum = NONE;
    for (const author of rowAuthors) {
      const row = byPair.get(author);
      for (const reviewer of columnReviewers) {
        sum = add(sum, (reviewer !== null && row?.get(reviewer)) || NONE);
      }
    }
    return sum;
  };

  return {
    rows: toEntries(authors, authorTotals),
    columns: toEntries(reviewers, reviewerTotals),
    counts: rowGroups.map((rowAuthors) =>
      columnGroups.map((columnReviewers) => sumPairs(rowAuthors, columnReviewers)),
    ),
    totals,
    authorCount: authorTotals.size,
    reviewerCount: reviewerTotals.size,
    max,
  };
}

// Shades for counts above zero, lightest first. The scale is square-root: review counts are
// skewed, and on a linear one nearly every cell would get the lightest shade.
export const SHADE_LEVELS = 5;

// 0 for no review, else 1 to SHADE_LEVELS: the smallest level with
// sqrt(count / max) <= level / SHADE_LEVELS, compared in integers so no rounding moves a count
// across a boundary.
export function shadeLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  for (let level = 1; level < SHADE_LEVELS; level++) {
    if (count * SHADE_LEVELS ** 2 <= max * level ** 2) return level;
  }
  return SHADE_LEVELS;
}

// The counts each shade covers, for the legend. A small max leaves some shades unused; they
// are left out.
export function shadeRanges(max: number): { level: number; min: number; max: number }[] {
  const ranges: { level: number; min: number; max: number }[] = [];
  for (let count = 1; count <= max; count++) {
    const level = shadeLevel(count, max);
    const last = ranges.at(-1);
    if (last?.level === level) last.max = count;
    else ranges.push({ level, min: count, max: count });
  }
  return ranges;
}

function possessive(author: MatrixEntry): string {
  if (author.kind === "others") return `PRs by ${pluralize(author.count, "other author")}`;
  if (author.login === null) return "a deleted account's PRs";
  return `${author.login}'s PRs`;
}

function subject(reviewer: MatrixEntry): string {
  if (reviewer.kind === "others") return pluralize(reviewer.count, "other reviewer");
  return reviewer.login ?? "";
}

function times(count: number): string {
  if (count === 1) return "once";
  if (count === 2) return "twice";
  return `${count.toLocaleString()} times`;
}

// The sentence a cell's tooltip leads with, for the metric shown: "alice reviewed bob's
// PRs 7 times", or "alice reviewed 3 of bob's PRs".
export function describeCell({
  author,
  reviewer,
  counts,
  metric,
}: {
  author: MatrixEntry;
  reviewer: MatrixEntry;
  counts: MatrixCounts;
  metric: MatrixMetric;
}): string {
  if (isSelf(author, reviewer)) return "Authors can't review their own PRs";
  const who = subject(reviewer);
  const whose = possessive(author);
  if (counts.reviews === 0) {
    return reviewer.kind === "others"
      ? `No other reviewer reviewed ${whose}`
      : `${who} didn't review ${whose}`;
  }
  if (metric === "reviews") return `${who} reviewed ${whose} ${times(counts.reviews)}`;
  return `${who} reviewed ${counts.prs.toLocaleString()} of ${whose}`;
}

// Whether the cell is someone's own PRs: always empty, since self-reviews don't count.
export function isSelf(author: MatrixEntry, reviewer: MatrixEntry): boolean {
  return (
    author.kind === "person" &&
    reviewer.kind === "person" &&
    author.login !== null &&
    author.login.toLowerCase() === reviewer.login?.toLowerCase()
  );
}

function csvName(entry: MatrixEntry): string {
  return entry.kind === "person" ? (entry.login ?? "(deleted account)") : "";
}

// Every author and reviewer, uncapped, with totals: the matrix as a spreadsheet would hold it.
export function toCsv(cells: readonly ReviewMatrixCell[], metric: MatrixMetric): string {
  const { rows, columns, counts, totals } = buildMatrixView({ cells, metric, limit: null });
  const header = ["Author \\ Reviewer", ...columns.map(csvName), "Total"];
  const body = rows.map((row, i) => [
    csvName(row),
    ...counts[i].map((count) => count[metric]),
    row.totals[metric],
  ]);
  const footer = ["Total", ...columns.map((column) => column.totals[metric]), totals[metric]];
  return [header, ...body, footer].map((line) => line.join(",")).join("\n");
}
