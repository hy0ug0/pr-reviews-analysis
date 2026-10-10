import { useState, useMemo, useCallback, useId } from "react";
import { formatDuration, pluralize } from "../../../shared/format";
import type { ReviewerStats } from "../types";
import { MIN_SAMPLES_FOR_P90 } from "./sampleSize";

interface ReviewerTableProps {
  stats: ReviewerStats[];
}

type SortKey = keyof ReviewerStats;

const RESPONSE_TOOLTIP =
  "Time from a review request, to the reviewer or one of their teams, until their next review or comment. Draft time doesn't count, and each re-request is a new round. n is the number of answered requests.";

const columns: { key: SortKey; label: string; align: "left" | "right"; tooltip?: string }[] = [
  { key: "login", label: "Reviewer", align: "left" },
  {
    key: "totalReviews",
    label: "Total",
    align: "right",
    tooltip:
      "Total number of individual review events (approvals, change requests, comments). A reviewer can submit multiple reviews on the same PR.",
  },
  {
    key: "prsReviewed",
    label: "PRs",
    align: "right",
    tooltip:
      "Number of distinct pull requests this reviewer participated in, regardless of how many review events they submitted per PR.",
  },
  {
    key: "approvals",
    label: "Approved",
    align: "right",
    tooltip: "Number of reviews submitted with an Approved state.",
  },
  {
    key: "changesRequested",
    label: "Changes",
    align: "right",
    tooltip: "Number of reviews submitted with a Changes Requested state.",
  },
  {
    key: "comments",
    label: "Comments",
    align: "right",
    tooltip: "Number of reviews submitted as a comment only (no approval or change request).",
  },
  {
    key: "responseP50Ms",
    label: "Response p50",
    align: "right",
    tooltip: `Median response time. ${RESPONSE_TOOLTIP}`,
  },
  {
    key: "responseP90Ms",
    label: "p90",
    align: "right",
    tooltip: `90th percentile response time: 9 in 10 requests were answered faster. Dimmed with fewer than ${MIN_SAMPLES_FOR_P90} answered requests, where it is mostly the slowest one.`,
  },
];

function cellColor(key: SortKey) {
  switch (key) {
    case "totalReviews":
      return "font-semibold text-gray-900 dark:text-slate-100";
    case "approvals":
      return "font-medium text-emerald-600 dark:text-emerald-400";
    case "changesRequested":
      return "font-medium text-amber-600 dark:text-amber-400";
    case "comments":
      return "font-medium text-sky-600 dark:text-sky-400";
    // Darker than the counts, so a dimmed p90 stands apart at a readable contrast.
    case "responseP50Ms":
    case "responseP90Ms":
      return "text-gray-900 dark:text-slate-100";
    default:
      return "text-gray-600 dark:text-slate-300";
  }
}

// Nulls (no response sample) sort last in both directions.
function compareStats(
  a: ReviewerStats[SortKey],
  b: ReviewerStats[SortKey],
  sortAsc: boolean,
): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  if (typeof a === "string" && typeof b === "string") {
    return sortAsc ? a.localeCompare(b) : b.localeCompare(a);
  }
  if (typeof a === "number" && typeof b === "number") {
    return sortAsc ? a - b : b - a;
  }
  return 0;
}

// Minutes with one decimal; empty without a sample.
function toCsvMinutes(ms: number | null): string {
  return ms === null ? "" : (ms / 60_000).toFixed(1);
}

type ResponseKey = "responseP50Ms" | "responseP90Ms";

function isResponseKey(key: SortKey): key is ResponseKey {
  return key === "responseP50Ms" || key === "responseP90Ms";
}

function ResponseCell({ stats, column }: { stats: ReviewerStats; column: ResponseKey }) {
  const value = stats[column];
  if (value === null) {
    return (
      <span className="text-gray-400 dark:text-slate-500" title="No answered review request">
        –
      </span>
    );
  }
  const answered = pluralize(stats.responseSamples, "answered request");
  if (column === "responseP90Ms") {
    const isNoisy = stats.responseSamples < MIN_SAMPLES_FOR_P90;
    return (
      <span
        className={isNoisy ? "text-gray-500 dark:text-slate-400" : undefined}
        title={isNoisy ? `Only ${answered}: too few for a stable p90` : answered}
      >
        {formatDuration(value)}
      </span>
    );
  }
  return (
    <span title={answered}>
      <span className="mr-2 text-xs text-gray-500 dark:text-slate-400">
        n={stats.responseSamples}
      </span>
      {formatDuration(value)}
    </span>
  );
}

function exportCsv(stats: ReviewerStats[]) {
  const headers = [
    "Reviewer",
    "Total Reviews",
    "PRs Reviewed",
    "Approvals",
    "Changes Requested",
    "Comments",
    "Response p50 (min)",
    "Response p90 (min)",
    "Answered Requests",
  ];
  const rows = stats.map((s) => [
    s.login,
    s.totalReviews,
    s.prsReviewed,
    s.approvals,
    s.changesRequested,
    s.comments,
    toCsvMinutes(s.responseP50Ms),
    toCsvMinutes(s.responseP90Ms),
    s.responseSamples,
  ]);
  const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pr-reviews-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface TooltipState {
  text: string;
  x: number;
  y: number;
}

// A focusable info button: the tooltip shows on hover and on keyboard focus, and screen
// readers get the text as the button's description.
export function TooltipIcon({ text, label }: { text: string; label: string }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const descriptionId = useId();

  const show = useCallback(
    (e: React.MouseEvent | React.FocusEvent) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top });
    },
    [text],
  );

  const hide = useCallback(() => setTooltip(null), []);

  return (
    <>
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={descriptionId}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === "Escape") hide();
        }}
        className="relative z-10 shrink-0 rounded-full cursor-default text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400"
      >
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {/* Hidden, so it stays out of the column header's name; aria-describedby still reads it. */}
      <span id={descriptionId} hidden>
        {text}
      </span>
      {tooltip && (
        <div
          aria-hidden="true"
          className="fixed z-50 w-56 rounded-lg bg-gray-900 dark:bg-slate-700 px-3 py-2 text-xs font-normal text-white normal-case tracking-normal leading-relaxed shadow-lg pointer-events-none text-left whitespace-normal"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: "translate(-50%, -100%)" }}
        >
          {tooltip.text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-gray-900 dark:border-t-slate-700" />
        </div>
      )}
    </>
  );
}

export function ReviewerTable({ stats }: ReviewerTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("totalReviews");
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = useMemo(() => {
    return [...stats].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      return compareStats(va, vb, sortAsc);
    });
  }, [stats, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const ariaSort = (key: SortKey) => {
    if (key !== sortKey) return "none";
    return sortAsc ? "ascending" : "descending";
  };

  // Decorative: aria-sort on the header says the same to screen readers.
  const sortIndicator = (key: SortKey) => {
    if (key !== sortKey) {
      return (
        <span aria-hidden="true" className="ml-1 opacity-30 text-[10px]">
          ⇅
        </span>
      );
    }
    return (
      <span aria-hidden="true" className="ml-1 text-[10px]">
        {sortAsc ? "↑" : "↓"}
      </span>
    );
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">
          Detailed Breakdown
        </h3>
        <button
          onClick={() => exportCsv(stats)}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
        >
          <svg
            className="w-3.5 h-3.5 mr-1.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-slate-800">
          <thead className="bg-gray-50 dark:bg-slate-800/50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  // Names the column without the info button's "About …" label.
                  aria-label={col.label}
                  aria-sort={ariaSort(col.key)}
                  className={`relative px-6 py-3 whitespace-nowrap text-xs font-medium text-gray-500 dark:text-slate-400 uppercase tracking-wider select-none hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors ${
                    col.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  <span className="inline-flex items-center gap-1 justify-end w-full">
                    {/* The ::after layer makes the whole header cell the click target; the
                        info button sits above it. */}
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className="inline-flex items-center gap-1 rounded-sm uppercase tracking-wider cursor-pointer after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400"
                    >
                      {col.label}
                      {sortIndicator(col.key)}
                    </button>
                    {col.tooltip && <TooltipIcon text={col.tooltip} label={col.label} />}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-slate-800">
            {sorted.map((s, i) => (
              <tr
                key={s.login}
                className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <td className="px-6 py-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className="w-4 shrink-0 text-right text-xs font-medium text-gray-400 tabular-nums dark:text-slate-500">
                      {i + 1}
                    </span>
                    <img
                      src={`https://avatars.githubusercontent.com/${s.login}?s=32`}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      className="h-6 w-6 shrink-0 rounded-full bg-gray-100 dark:bg-slate-800"
                    />
                    <a
                      href={`https://github.com/${s.login}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-gray-900 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                    >
                      {s.login}
                    </a>
                  </div>
                </td>
                {columns.slice(1).map((col) => (
                  <td
                    key={col.key}
                    className={`px-6 py-3 whitespace-nowrap text-right text-sm tabular-nums ${cellColor(col.key)}`}
                  >
                    {isResponseKey(col.key) ? (
                      <ResponseCell stats={s} column={col.key} />
                    ) : (
                      s[col.key]
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
