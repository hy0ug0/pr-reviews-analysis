import { useEffect, useState } from "react";
import { formatFetchTime } from "../../../shared/format";
import {
  ANALYSIS_STEPS,
  progressSentence,
  rateLimitNotice,
  type ProgressView,
  type RepoLine,
} from "../../../shared/progress";
import type { RunProgress } from "../analysisState";

interface AnalysisProgressPanelProps {
  progress: RunProgress | null;
  startedAt: number;
}

// Before the server's first snapshot: the run has started, nothing is known yet.
const STARTING: RunProgress = {
  view: {
    step: 0,
    fraction: null,
    floor: 0,
    label: "Starting the analysis",
    details: [],
    repos: [],
    rateLimitedUntil: null,
  },
  percent: 0,
  indeterminate: true,
};

// Screen readers hear a step change at once, and progress within a step at most this often.
const ANNOUNCE_INTERVAL_MS = 10_000;

const itemClass =
  "relative pl-4 [overflow-wrap:anywhere] before:absolute before:left-0 before:w-4 before:text-center before:text-slate-300 before:content-['·'] dark:before:text-slate-600";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// The text for the polite live region: a new step, or a rate-limit wait starting or ending,
// is announced right away; counts within a step only every ANNOUNCE_INTERVAL_MS, so the
// region does not chatter on every batch.
function useAnnouncement(view: ProgressView, now: number): string {
  const sentence = progressSentence(view);
  const waiting = view.rateLimitedUntil !== null;
  const [announced, setAnnounced] = useState({ sentence, step: view.step, waiting, at: now });
  const due =
    view.step !== announced.step ||
    waiting !== announced.waiting ||
    now - announced.at >= ANNOUNCE_INTERVAL_MS;
  if (due && sentence !== announced.sentence) {
    setAnnounced({ sentence, step: view.step, waiting, at: now });
  }
  return announced.sentence;
}

function StepMarker({ state }: { state: "done" | "current" | "todo" }) {
  switch (state) {
    case "done":
      return (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-600 dark:bg-indigo-500">
          <svg
            className="h-2.5 w-2.5 text-white"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M2.5 6.5 5 9l4.5-6"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      );
    case "current":
      return (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-2 ring-indigo-600 ring-inset dark:ring-indigo-400">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-600 motion-safe:animate-pulse dark:bg-indigo-400" />
        </span>
      );
    case "todo":
      return (
        <span className="h-4 w-4 shrink-0 rounded-full ring-1 ring-slate-300 ring-inset dark:ring-slate-600" />
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// One line per repo under the totals when the step covers several. The live region reads the
// totals only, so this list is there to look at and to browse, never announced.
function RepoList({ lines }: { lines: RepoLine[] }) {
  return (
    <ul
      aria-label="Repositories"
      className="mt-2 grid w-fit max-w-full grid-cols-[auto_minmax(0,max-content)_auto] items-baseline gap-x-2 text-xs text-slate-500 tabular-nums dark:text-slate-400"
    >
      {lines.map(({ repo, detail, done }) => (
        <li key={repo} className="col-span-3 grid grid-cols-subgrid">
          <span className="w-3 text-center text-indigo-600 dark:text-indigo-400">
            {done && (
              <svg
                className="inline h-2.5 w-2.5"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M2.5 6.5 5 9l4.5-6"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="truncate">{repo}</span>
          <span>
            {detail}
            {done && <span className="sr-only"> (done)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Replaces the spinner while an analysis runs: what the server is doing, on which repos, how
// far along, and the four steps of a run. The bar is determinate only once the current step
// knows its total; before that a sweep runs over the part still to do.
export function AnalysisProgressPanel({ progress, startedAt }: AnalysisProgressPanelProps) {
  const { view, percent, indeterminate } = progress ?? STARTING;
  const now = useNow(1000);
  const announcement = useAnnouncement(view, now);
  // Whole seconds, so the timer does not flicker through tenths.
  const elapsed = formatFetchTime(Math.floor(Math.max(0, now - startedAt) / 1000) * 1000);

  return (
    <section
      aria-label="Analysis progress"
      className="mb-8 rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-slate-100">{view.label}</h2>
        <p className="shrink-0 text-xs text-slate-500 tabular-nums dark:text-slate-400">
          <span className="sr-only">Elapsed: </span>
          {elapsed}
        </p>
      </div>

      <div className="mt-1 min-h-5 overflow-hidden text-sm text-slate-500 dark:text-slate-400">
        {view.details.length > 0 && (
          <ul className="-ml-4 flex flex-wrap tabular-nums">
            {view.details.map((detail) => (
              <li key={detail} className={itemClass}>
                {detail}
              </li>
            ))}
          </ul>
        )}
      </div>

      {view.repos.length > 0 && <RepoList lines={view.repos} />}

      {/* The countdown ticks with the elapsed timer; the live region names the wait once. */}
      {view.rateLimitedUntil !== null && (
        <p className="mt-1 text-sm text-amber-700 tabular-nums dark:text-amber-400">
          {rateLimitNotice(view.rateLimitedUntil, now)}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Analysis progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : percent}
          className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-indigo-600 transition-[width] duration-500 ease-out motion-reduce:transition-none dark:bg-indigo-500"
            style={{ width: `${percent}%` }}
          />
          {indeterminate && (
            // Sweeps over the part not done yet; hidden for reduced motion, where the label
            // alone says the step is under way.
            <div
              className="absolute inset-y-0 right-0 overflow-hidden motion-reduce:hidden"
              style={{ left: `${percent}%` }}
            >
              <div className="h-full w-1/3 animate-progress-sweep rounded-full bg-indigo-400/50 dark:bg-indigo-400/40" />
            </div>
          )}
        </div>
        <span
          className="w-9 shrink-0 text-right text-xs text-slate-500 tabular-nums dark:text-slate-400"
          aria-hidden="true"
        >
          {indeterminate ? "" : `${percent}%`}
        </span>
      </div>

      {/* Steps size to their content and share the rest of the row through their
          connectors, so the current step's label always shows in full. Below sm, the other
          labels are left to screen readers. */}
      <ol className="mt-5 flex items-center gap-2">
        {ANALYSIS_STEPS.map((step, index) => {
          const state = index < view.step ? "done" : index === view.step ? "current" : "todo";
          const isLast = index === ANALYSIS_STEPS.length - 1;
          return (
            <li
              key={step}
              className={`flex min-w-0 items-center gap-2 text-xs ${isLast ? "flex-none" : "flex-auto"}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <StepMarker state={state} />
              <span
                className={
                  state === "current"
                    ? "font-medium whitespace-nowrap text-gray-900 dark:text-slate-100"
                    : "truncate text-slate-500 max-sm:sr-only dark:text-slate-400"
                }
              >
                {step}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </span>
              {!isLast && (
                <span
                  className={`h-px min-w-3 flex-1 ${index < view.step ? "bg-indigo-300 dark:bg-indigo-700" : "bg-slate-200 dark:bg-slate-700"}`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
