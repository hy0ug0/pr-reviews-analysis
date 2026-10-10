import { keepNumbersWithUnits, pluralize } from "./format";
import type { AnalysisProgress } from "./types";

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
  // Repo and counts, shown after the label with "·" between them.
  details: string[];
  // When a GitHub rate-limit wait ends, in epoch ms; null when no request is waiting.
  rateLimitedUntil: number | null;
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

// How far the fetch step is. Each repo weighs its PR count. Within a repo, batches fill
// BATCHES_SHARE, then the extra review pages the rest. Between the last batch and the count
// of PRs needing more pages, the share is null (indeterminate) from where the batches ended.
function fetchShare(progress: Extract<AnalysisProgress, { phase: "fetching" }>): {
  share: number | null;
  floorShare: number;
} {
  const { prsDone, prsTotal, repoPRsDone, repoPRsTotal, reviewPRsDone, reviewPRsTotal } = progress;
  if (prsTotal === 0) return { share: 1, floorShare: 1 };
  const prsBefore = prsDone - repoPRsDone;
  const overall = (repoShare: number) => (prsBefore + repoPRsTotal * repoShare) / prsTotal;
  const batchesShare = BATCHES_SHARE * ratio(repoPRsDone, repoPRsTotal);
  if (repoPRsDone < repoPRsTotal) {
    return { share: overall(batchesShare), floorShare: overall(batchesShare) };
  }
  if (reviewPRsTotal === null) return { share: null, floorShare: overall(BATCHES_SHARE) };
  const reviewsShare = (1 - BATCHES_SHARE) * ratio(reviewPRsDone, reviewPRsTotal);
  return {
    share: overall(BATCHES_SHARE + reviewsShare),
    floorShare: overall(BATCHES_SHARE + reviewsShare),
  };
}

function repoDetails(progress: { repo: string; repoIndex: number; repoCount: number }) {
  const { repo, repoIndex, repoCount } = progress;
  return repoCount > 1 ? [repo, `repo ${repoIndex + 1} of ${repoCount}`] : [repo];
}

function view(
  step: number,
  share: number | null,
  label: string,
  details: string[],
  floorShare: number = share ?? 0,
): PhaseView {
  const { fraction } = position(step, share);
  return {
    step,
    fraction,
    floor: position(step, floorShare).floor,
    label,
    details: details.map(keepNumbersWithUnits),
  };
}

function rateLimitEnd(progress: AnalysisProgress): number | null {
  if (progress.phase !== "listing" && progress.phase !== "fetching") return null;
  if (progress.rateLimitedUntil === undefined) return null;
  const until = Date.parse(progress.rateLimitedUntil);
  return Number.isNaN(until) ? null : until;
}

// What the progress panel shows for a snapshot. The bar is determinate only once the step
// knows its total (the listing after its first page, the fetch from the start).
export function describeProgress(progress: AnalysisProgress): ProgressView {
  return { ...describePhase(progress), rateLimitedUntil: rateLimitEnd(progress) };
}

function describePhase(progress: AnalysisProgress): PhaseView {
  switch (progress.phase) {
    case "listing-cache":
      return view(0, null, "Looking up the PR list", []);
    case "listing": {
      const { repoIndex, repoCount, listed, matching, page, windowsDone, windowsTotal } = progress;
      const repoShare = matching === null ? null : ratio(listed, matching);
      const share = repoShare === null ? null : (repoIndex + repoShare) / repoCount;
      const where: string[] = [];
      if (page > 0) where.push(`page ${page}`);
      if (windowsTotal > 1) where.push(`window ${windowsDone + 1} of ${windowsTotal}`);
      const counts =
        matching === null
          ? where
          : [
              `${listed.toLocaleString()} of ${pluralize(matching, "PR")}${where.length > 0 ? ` (${where.join(", ")})` : ""}`,
            ];
      return view(
        0,
        share,
        "Listing PRs",
        [...repoDetails(progress), ...counts],
        repoIndex / repoCount,
      );
    }
    case "pr-cache":
      return view(1, null, "Checking the cache", [pluralize(progress.prs, "PR")]);
    case "fetching": {
      const { prsDone, prsTotal, batchesDone, batchesTotal, reviewPRsDone, reviewPRsTotal } =
        progress;
      const { share, floorShare } = fetchShare(progress);
      if (batchesDone === batchesTotal && reviewPRsTotal !== 0) {
        const counts =
          reviewPRsTotal === null
            ? []
            : [`${reviewPRsDone.toLocaleString()} of ${pluralize(reviewPRsTotal, "PR")}`];
        return view(
          2,
          share,
          "Fetching more reviews",
          [...repoDetails(progress), ...counts],
          floorShare,
        );
      }
      return view(2, share, "Fetching PR details", [
        ...repoDetails(progress),
        `${prsDone.toLocaleString()} of ${pluralize(prsTotal, "PR")} (${batchesDone} of ${pluralize(batchesTotal, "batch", "batches")})`,
      ]);
    }
    case "analyzing":
      return view(3, null, "Analyzing", [pluralize(progress.prs, "PR")]);
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
