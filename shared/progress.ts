import { keepNumbersWithUnits, pluralize } from "./format";
import type { AnalysisProgress, RepoFetchProgress, RepoListingProgress } from "./types";

export const ANALYSIS_STEPS = ["List PRs", "Check cache", "Fetch details", "Analyze"] as const;

// Each step's share of the overall bar. Fetching details is nearly all of a cold run's
// time; listing is the next longest; the cache check and the analysis take moments.
const STEP_SPANS: Record<(typeof ANALYSIS_STEPS)[number], [number, number]> = {
  "List PRs": [0, 0.15],
  "Check cache": [0.15, 0.2],
  "Fetch details": [0.2, 0.95],
  Analyze: [0.95, 1],
};

export interface ProgressView {
  // Index into ANALYSIS_STEPS.
  step: number;
  // Overall share done, from 0 to 1. Null while the current step has no known total: the
  // bar is then indeterminate, starting at `floor`.
  fraction: number | null;
  // Where the current step's known progress starts on the overall bar.
  floor: number;
  label: string;
  // Repo and counts, shown after the label with "·" between them. With several repos, the
  // repo count and the totals across them.
  details: string[];
  // One line per repo when the step covers several; empty otherwise.
  repos: RepoLine[];
  // When a GitHub rate-limit wait ends, in epoch ms; null when no request is waiting.
  rateLimitedUntil: number | null;
}

export interface RepoLine {
  repo: string;
  // That repo's own count, such as "150 of 412 PRs".
  detail: string;
  done: boolean;
}

// A view before the wait is added; only describeProgress adds it.
type PhaseView = Omit<ProgressView, "rateLimitedUntil">;

function position(step: number, share: number | null): Pick<ProgressView, "fraction" | "floor"> {
  const [start, end] = STEP_SPANS[ANALYSIS_STEPS[step]];
  const span = end - start;
  return {
    fraction: share === null ? null : start + span * Math.min(1, Math.max(0, share)),
    floor: start + span * Math.min(1, Math.max(0, share ?? 0)),
  };
}

function ratio(done: number, total: number): number {
  return total === 0 ? 1 : done / total;
}

// Within one repo's fetch, the batches' share; the extra review pages that follow them get
// the rest. Measured on nodejs/node, review continuations are a few percent of the calls.
const BATCHES_SHARE = 0.85;

interface StepShare {
  // Null while the step is indeterminate.
  share: number | null;
  floorShare: number;
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function isListed({ windowsDone, windowsTotal }: RepoListingProgress): boolean {
  return windowsDone === windowsTotal;
}

// The listing totals across repos. `matching` is null until every repo knows its own.
function listingTotals(repos: RepoListingProgress[]): { listed: number; matching: number | null } {
  const listed = sum(repos, (repo) => repo.listed);
  if (repos.some((repo) => repo.matching === null)) return { listed, matching: null };
  return { listed, matching: sum(repos, (repo) => repo.matching ?? 0) };
}

// How far the listing step is: the PRs listed out of those matching, across repos. It is
// indeterminate until every repo's first page gives its total, which with the repos listed
// side by side takes about one request. A listed repo counts in full, as a window past the
// Search limit leaves it short of its total for good.
function listingShare(repos: RepoListingProgress[]): StepShare {
  const total = listingTotals(repos).matching;
  if (total === null) return { share: null, floorShare: 0 };
  const done = sum(repos, (repo) => {
    const repoTotal = repo.matching ?? 0;
    return isListed(repo) ? repoTotal : Math.min(repo.listed, repoTotal);
  });
  const share = ratio(done, total);
  return { share, floorShare: share };
}

function listingCounts({
  listed,
  matching,
  where,
}: {
  listed: number;
  matching: number | null;
  where: string[];
}): string[] {
  if (matching === null) return where;
  const suffix = where.length > 0 ? ` (${where.join(", ")})` : "";
  return [`${listed.toLocaleString()} of ${pluralize(matching, "PR")}${suffix}`];
}

function windowWhere({ windowsDone, windowsTotal }: RepoListingProgress): string[] {
  return windowsTotal > 1 ? [`window ${windowsDone + 1} of ${windowsTotal}`] : [];
}

// Where one repo's listing is: its page and date window, until it is listed.
function listingWhere(repo: RepoListingProgress): string[] {
  if (isListed(repo)) return [];
  return [...(repo.page > 0 ? [`page ${repo.page}`] : []), ...windowWhere(repo)];
}

// A repo's line leaves the page out: it changes too often to read across several lines.
function listingLine(repo: RepoListingProgress): RepoLine {
  if (isListed(repo)) return { repo: repo.repo, detail: pluralize(repo.listed, "PR"), done: true };
  const [detail = ""] = listingCounts({ ...repo, where: windowWhere(repo) });
  return { repo: repo.repo, detail, done: false };
}

function isFetched(repo: RepoFetchProgress): boolean {
  return (
    repo.batchesDone === repo.batchesTotal &&
    repo.reviewPRsTotal !== null &&
    repo.reviewPRsDone === repo.reviewPRsTotal
  );
}

// How far one repo's fetch is: batches fill BATCHES_SHARE, then the extra review pages the
// rest. Between the last batch and the count of PRs needing more pages, the share is null
// (indeterminate) from where the batches ended.
function repoFetchShare(repo: RepoFetchProgress): StepShare {
  const { prsDone, prsTotal, reviewPRsDone, reviewPRsTotal } = repo;
  if (prsDone < prsTotal) {
    const share = BATCHES_SHARE * ratio(prsDone, prsTotal);
    return { share, floorShare: share };
  }
  if (reviewPRsTotal === null) return { share: null, floorShare: BATCHES_SHARE };
  const share = BATCHES_SHARE + (1 - BATCHES_SHARE) * ratio(reviewPRsDone, reviewPRsTotal);
  return { share, floorShare: share };
}

// How far the fetch step is: each repo's share, weighted by its PR count. Indeterminate while
// any repo is, from where the shares known so far put it.
function fetchShare(repos: RepoFetchProgress[]): StepShare {
  const total = sum(repos, (repo) => repo.prsTotal);
  if (total === 0) return { share: 1, floorShare: 1 };
  const shares = repos.map((repo) => ({ weight: repo.prsTotal, ...repoFetchShare(repo) }));
  const floorShare = sum(shares, ({ weight, floorShare }) => weight * floorShare) / total;
  if (shares.some(({ share }) => share === null)) return { share: null, floorShare };
  return { share: sum(shares, ({ weight, share }) => weight * (share ?? 0)) / total, floorShare };
}

function fetchingLine(repo: RepoFetchProgress): RepoLine {
  const { prsDone, prsTotal, batchesDone, batchesTotal, reviewPRsDone, reviewPRsTotal } = repo;
  if (isFetched(repo)) return { repo: repo.repo, detail: pluralize(prsTotal, "PR"), done: true };
  const detail =
    batchesDone === batchesTotal && reviewPRsTotal !== null
      ? `more reviews, ${reviewPRsDone.toLocaleString()} of ${pluralize(reviewPRsTotal, "PR")}`
      : `${prsDone.toLocaleString()} of ${pluralize(prsTotal, "PR")}`;
  return { repo: repo.repo, detail, done: false };
}

// The details' first item: the repo when there is one, the repo count when there are more.
function repoSummary(repos: Array<{ repo: string }>): string[] {
  if (repos.length === 1) return [repos[0].repo];
  return [pluralize(repos.length, "repo")];
}

function view({
  step,
  share,
  label,
  details,
  floorShare = share ?? 0,
  repos = [],
}: {
  step: number;
  share: number | null;
  label: string;
  details: string[];
  floorShare?: number;
  repos?: RepoLine[];
}): PhaseView {
  const { fraction } = position(step, share);
  return {
    step,
    fraction,
    floor: position(step, floorShare).floor,
    label,
    details: details.map(keepNumbersWithUnits),
    repos: repos.map((line) => ({ ...line, detail: keepNumbersWithUnits(line.detail) })),
  };
}

function rateLimitEnd(progress: AnalysisProgress): number | null {
  if (progress.phase !== "listing" && progress.phase !== "fetching") return null;
  if (progress.rateLimitedUntil === undefined) return null;
  const until = Date.parse(progress.rateLimitedUntil);
  return Number.isNaN(until) ? null : until;
}

// What the progress panel shows for a snapshot. The bar is determinate only once the step
// knows its total (the listing after every repo's first page, the fetch from the start).
export function describeProgress(progress: AnalysisProgress): ProgressView {
  return { ...describePhase(progress), rateLimitedUntil: rateLimitEnd(progress) };
}

function describePhase(progress: AnalysisProgress): PhaseView {
  switch (progress.phase) {
    case "listing-cache":
      return view({ step: 0, share: null, label: "Looking up the PR list", details: [] });
    case "listing": {
      const { repos } = progress;
      const { share, floorShare } = listingShare(repos);
      const counts =
        repos.length === 1
          ? listingCounts({ ...repos[0], where: listingWhere(repos[0]) })
          : listingCounts({ ...listingTotals(repos), where: [] });
      return view({
        step: 0,
        share,
        label: "Listing PRs",
        details: [...repoSummary(repos), ...counts],
        floorShare,
        repos: repos.length > 1 ? repos.map(listingLine) : [],
      });
    }
    case "pr-cache":
      return view({
        step: 1,
        share: null,
        label: "Checking the cache",
        details: [pluralize(progress.prs, "PR")],
      });
    case "fetching": {
      const { repos } = progress;
      const { share, floorShare } = fetchShare(repos);
      const lines = repos.length > 1 ? repos.map(fetchingLine) : [];
      const batchesDone = sum(repos, (repo) => repo.batchesDone);
      const batchesTotal = sum(repos, (repo) => repo.batchesTotal);
      const reviewPRsTotal = repos.some((repo) => repo.reviewPRsTotal === null)
        ? null
        : sum(repos, (repo) => repo.reviewPRsTotal ?? 0);
      if (batchesDone === batchesTotal && reviewPRsTotal !== 0) {
        const reviewPRsDone = sum(repos, (repo) => repo.reviewPRsDone);
        const counts =
          reviewPRsTotal === null
            ? []
            : [`${reviewPRsDone.toLocaleString()} of ${pluralize(reviewPRsTotal, "PR")}`];
        return view({
          step: 2,
          share,
          label: "Fetching more reviews",
          details: [...repoSummary(repos), ...counts],
          floorShare,
          repos: lines,
        });
      }
      const prsDone = sum(repos, (repo) => repo.prsDone);
      const prsTotal = sum(repos, (repo) => repo.prsTotal);
      return view({
        step: 2,
        share,
        label: "Fetching PR details",
        details: [
          ...repoSummary(repos),
          `${prsDone.toLocaleString()} of ${pluralize(prsTotal, "PR")} (${batchesDone} of ${pluralize(batchesTotal, "batch", "batches")})`,
        ],
        floorShare,
        repos: lines,
      });
    }
    case "analyzing":
      return view({
        step: 3,
        share: null,
        label: "Analyzing",
        details: [pluralize(progress.prs, "PR")],
      });
    default: {
      const _exhaustive: never = progress;
      return _exhaustive;
    }
  }
}

export const RATE_LIMIT_WAIT_LABEL = "Waiting for GitHub rate limit";

// The panel's line while a request waits for the rate limit, counted down in whole seconds.
// The server clears the wait once it ends; until that snapshot arrives the line says so.
export function rateLimitNotice(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return seconds === 0
    ? `${RATE_LIMIT_WAIT_LABEL}, resuming…`
    : `${RATE_LIMIT_WAIT_LABEL}, resuming in ${keepNumbersWithUnits(`${seconds} s`)}`;
}

// One line for screen readers and logs: "Fetching PR details: vitejs/vite, 150 of 412 PRs".
// A rate-limit wait is named without its countdown, which would change every second.
export function progressSentence(view: ProgressView): string {
  const details = view.details.map((detail) => detail.replaceAll(" ", " "));
  const sentence = details.length === 0 ? view.label : `${view.label}: ${details.join(", ")}`;
  return view.rateLimitedUntil === null ? sentence : `${sentence}. ${RATE_LIMIT_WAIT_LABEL}`;
}
