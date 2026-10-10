import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pluralize } from "../../../shared/format";
import {
  buildMatrixView,
  describeCell,
  isSelf,
  shadeLevel,
  shadeRanges,
  toCsv,
  type MatrixCounts,
  type MatrixEntry,
  type MatrixMetric,
  type MatrixView,
} from "../reviewMatrix";
import type { ReviewMatrixCell } from "../types";

interface ReviewMatrixSectionProps {
  cells: ReviewMatrixCell[];
  teamMembers: string[];
  // Whether the result counted bots, which changes whose reviews count.
  includeBots: boolean;
}

// Enough to read at 1280 px without scrolling sideways; the rest fold into "others".
const DEFAULT_LIMIT = 15;

const cardClass =
  "bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-gray-200 dark:border-slate-800";

// One indigo ramp, lightest to darkest, as Tailwind classes by shade level (1 to 5). On the
// dark surface the ramp runs the other way, from near the surface to bright. The text flips
// between indigo-950 and white so it clears 4.5:1 on every shade in both modes.
const SHADE_CLASSES = [
  "",
  "bg-indigo-100 text-indigo-950 dark:bg-indigo-900 dark:text-indigo-50",
  "bg-indigo-200 text-indigo-950 dark:bg-indigo-700 dark:text-white",
  "bg-indigo-300 text-indigo-950 dark:bg-indigo-500 dark:text-white",
  "bg-indigo-500 text-white dark:bg-indigo-400 dark:text-indigo-950",
  "bg-indigo-700 text-white dark:bg-indigo-300 dark:text-indigo-950",
];

const EMPTY_CELL_CLASS = "bg-gray-50 text-gray-500 dark:bg-slate-800/40 dark:text-slate-400";
// The band across the hovered cell's row and column: their headers, and the cells without a
// shade. Its text is darker (lighter on dark) than elsewhere, to keep 4.5:1 on the band.
const CROSSHAIR_HEADER_CLASS = "bg-slate-200 dark:bg-slate-700";
const CROSSHAIR_CLASS = "bg-slate-200 text-gray-700 dark:bg-slate-700 dark:text-slate-200";
// Secondary labels and values: "others", deleted accounts, folded counts. Clear 4.5:1 on the
// surface and on the band.
const MUTED_TEXT_CLASS = "text-gray-600 dark:text-slate-300";

const METRICS: { value: MatrixMetric; label: string }[] = [
  { value: "reviews", label: "Reviews" },
  { value: "prs", label: "PRs" },
];

function personKey(entry: MatrixEntry): string {
  return entry.kind === "others" ? "\u0000others" : (entry.login ?? "\u0000deleted");
}

function Avatar({ login, size }: { login: string; size: number }) {
  return (
    <img
      src={`https://avatars.githubusercontent.com/${login}?s=${size * 2}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-full bg-gray-100 dark:bg-slate-800"
      style={{ width: size, height: size }}
    />
  );
}

function downloadCsv(cells: readonly ReviewMatrixCell[], metric: MatrixMetric) {
  const blob = new Blob([toCsv(cells, metric)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `review-matrix-${metric}-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function MetricToggle({
  metric,
  onChange,
}: {
  metric: MatrixMetric;
  onChange: (metric: MatrixMetric) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Count in each cell"
      className="inline-flex rounded-lg bg-gray-100 p-0.5 dark:bg-slate-800"
    >
      {METRICS.map(({ value, label }) => {
        const isOn = value === metric;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={isOn}
            onClick={() => onChange(value)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 ${
              isOn
                ? "bg-white text-gray-900 shadow-sm dark:bg-slate-600 dark:text-slate-50"
                : "text-gray-500 hover:text-gray-900 dark:text-slate-400 dark:hover:text-slate-100"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// The counts each shade stands for, lightest first. Narrow enough for a 375 px screen with all
// five shades; it wraps rather than widen the page.
function Legend({ max, metric }: { max: number; metric: MatrixMetric }) {
  const ranges = shadeRanges(max);
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-slate-400">
      <span className="pb-0.5">{metric === "reviews" ? "Reviews per cell" : "PRs per cell"}</span>
      <ul className="flex gap-0.5" aria-label="Shade scale">
        {ranges.map((range) => (
          <li key={range.level} className="flex min-w-9 flex-col items-center gap-1 sm:min-w-12">
            <span className={`h-3 w-full rounded-sm ${SHADE_CLASSES[range.level]}`} />
            <span className="px-0.5 whitespace-nowrap tabular-nums">
              {range.min === range.max ? range.min : `${range.min}–${range.max}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ hasTeamFilter }: { hasTeamFilter: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center dark:border-slate-700">
      <p className="text-sm font-medium text-gray-900 dark:text-slate-100">
        No counted reviews in this range.
      </p>
      <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">
        {hasTeamFilter
          ? "Only team members' reviews count. Clear the team filter or pick a longer range to see more."
          : "Pick a longer time range to see more."}
      </p>
    </div>
  );
}

function onlyLogin(entries: MatrixEntry[]): string | null {
  const [first] = entries;
  return first?.kind === "person" ? first.login : null;
}

// Says when one person is all there is, so a one-column matrix doesn't look broken.
function singlePersonNote(view: MatrixView): string | null {
  const reviewer = view.reviewerCount === 1 ? onlyLogin(view.columns) : null;
  const author = view.authorCount === 1 ? onlyLogin(view.rows) : null;
  const authorPRs = author === null ? "a deleted account's PRs" : `${author}'s PRs`;
  if (reviewer !== null && view.authorCount === 1) {
    return `Every counted review is ${reviewer}'s, on ${authorPRs}.`;
  }
  if (reviewer !== null) return `Every counted review is ${reviewer}'s.`;
  if (view.authorCount === 1) return `Every counted review is on ${authorPRs}.`;
  return null;
}

function RowHeader({ entry, isHighlighted }: { entry: MatrixEntry; isHighlighted: boolean }) {
  const base = `sticky left-0 z-10 max-w-28 px-2 py-1 text-left text-sm font-normal whitespace-nowrap sm:max-w-48 sm:pl-0 ${
    isHighlighted ? CROSSHAIR_HEADER_CLASS : "bg-white dark:bg-slate-900"
  }`;
  if (entry.kind === "others") {
    return (
      <th scope="row" className={`${base} ${MUTED_TEXT_CLASS}`}>
        {pluralize(entry.count, "other author")}
      </th>
    );
  }
  if (entry.login === null) {
    return (
      <th
        scope="row"
        className={`${base} italic ${MUTED_TEXT_CLASS}`}
        title="GitHub can't resolve this author, most likely a deleted account."
      >
        Deleted account
      </th>
    );
  }
  return (
    <th scope="row" className={base}>
      <span className="flex min-w-0 items-center gap-2">
        <Avatar login={entry.login} size={20} />
        <a
          href={`https://github.com/${entry.login}`}
          target="_blank"
          rel="noopener noreferrer"
          title={entry.login}
          className="truncate font-medium text-gray-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
        >
          {entry.login}
        </a>
      </span>
    </th>
  );
}

function ColumnHeader({ entry, isHighlighted }: { entry: MatrixEntry; isHighlighted: boolean }) {
  const label = entry.kind === "others" ? pluralize(entry.count, "other") : (entry.login ?? "");
  return (
    <th
      scope="col"
      title={entry.kind === "others" ? pluralize(entry.count, "other reviewer") : label}
      className={`sticky top-0 z-10 rounded-t-md px-0 pt-2 pb-1.5 align-bottom ${
        isHighlighted ? CROSSHAIR_HEADER_CLASS : "bg-white dark:bg-slate-900"
      }`}
    >
      {/* Text running bottom to top keeps columns narrow; long logins are cut at the top. */}
      <span className="flex flex-col items-center gap-1.5">
        <span
          className={`max-h-28 rotate-180 truncate text-xs [writing-mode:vertical-rl] ${
            entry.kind === "others"
              ? `font-normal ${MUTED_TEXT_CLASS}`
              : "font-medium text-gray-900 dark:text-slate-100"
          }`}
        >
          {label}
        </span>
        {entry.kind === "person" && entry.login !== null && (
          <Avatar login={entry.login} size={16} />
        )}
      </span>
    </th>
  );
}

interface Hover {
  row: number;
  column: number;
  // The hovered cell, in viewport coordinates.
  rect: Pick<DOMRect, "top" | "bottom" | "left" | "right">;
}

// 14rem, the tooltip's width.
const TOOLTIP_WIDTH = 224;

// How far the tooltip overlaps the cell's corner, so the pointer can move straight onto it
// without crossing another cell.
const TOOLTIP_OVERLAP = 4;

// Off a corner of the cell, so it covers neither the cell's row nor its column: below and to
// the right, flipping left or up where the viewport runs out. On a phone too narrow for either
// side, it sits under the cell, clamped to the screen.
function tooltipStyle({ rect }: Hover): React.CSSProperties {
  const margin = 8;
  const fitsBelow = rect.bottom + 80 <= window.innerHeight;
  const vertical = fitsBelow
    ? { top: rect.bottom - TOOLTIP_OVERLAP, translateY: "0" }
    : { top: rect.top + TOOLTIP_OVERLAP, translateY: "-100%" };
  let left: number;
  let translateX = "0";
  if (rect.right + TOOLTIP_WIDTH + margin <= window.innerWidth) {
    left = rect.right - TOOLTIP_OVERLAP;
  } else if (rect.left - TOOLTIP_WIDTH - margin >= 0) {
    left = rect.left + TOOLTIP_OVERLAP;
    translateX = "-100%";
  } else {
    left = Math.min(Math.max(margin, rect.left), window.innerWidth - TOOLTIP_WIDTH - margin);
  }
  return {
    left,
    top: vertical.top,
    transform: `translate(${translateX}, ${vertical.translateY})`,
  };
}

function Tooltip({
  hover,
  text,
  detail,
  onPointerEnter,
  onPointerLeave,
}: {
  hover: Hover;
  text: string;
  detail: string | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  // Stays while the pointer is on it, so it can be read under a screen magnifier.
  return (
    <div
      aria-hidden="true"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className="fixed z-50 w-56 rounded-lg bg-gray-900 px-3 py-2 text-left text-xs leading-relaxed text-white shadow-lg dark:bg-slate-700"
      style={tooltipStyle(hover)}
    >
      <p className="font-semibold">{text}</p>
      {detail && <p className="text-gray-300 dark:text-slate-300">{detail}</p>}
    </div>
  );
}

function countsDetail(counts: MatrixCounts): string | null {
  if (counts.reviews === 0) return null;
  return `${pluralize(counts.reviews, "review")} on ${pluralize(counts.prs, "PR")}`;
}

// Reads a cell's position from the data attributes set on every body cell.
function cellAt(target: EventTarget): Hover | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest<HTMLElement>("td[data-row]");
  if (!cell) return null;
  return {
    row: Number(cell.dataset.row),
    column: Number(cell.dataset.column),
    rect: cell.getBoundingClientRect(),
  };
}

// How long the tooltip waits after the pointer leaves the cells, so it can reach the tooltip.
const TOOLTIP_LEAVE_DELAY_MS = 120;

function MatrixTable({ view, metric }: { view: MatrixView; metric: MatrixMetric }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = useCallback(() => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  }, []);
  const hoverCell = useCallback(
    (cell: Hover | null) => {
      cancelLeave();
      setHover(cell);
    },
    [cancelLeave],
  );
  const leaveSoon = useCallback(() => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => setHover(null), TOOLTIP_LEAVE_DELAY_MS);
  }, [cancelLeave]);

  // Escape dismisses the tooltip and the highlight wherever focus is. Removing the tooltip
  // puts a cell under a still pointer, and the browser reports that as a new hover, so hovers
  // stay off until the pointer moves.
  const pointer = useRef({ x: 0, y: 0 });
  const dismissedAt = useRef<{ x: number; y: number } | null>(null);
  const isHovering = hover !== null;
  useEffect(() => {
    if (!isHovering) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissedAt.current = pointer.current;
      hoverCell(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHovering, hoverCell]);
  useEffect(() => cancelLeave, [cancelLeave]);

  const onPointer = (event: React.PointerEvent) => {
    const dismissed = dismissedAt.current;
    if (dismissed !== null) {
      if (dismissed.x === event.clientX && dismissed.y === event.clientY) return;
      dismissedAt.current = null;
    }
    hoverCell(cellAt(event.target));
  };

  const hovered =
    hover === null
      ? null
      : {
          author: view.rows[hover.row],
          reviewer: view.columns[hover.column],
          counts: view.counts[hover.row]?.[hover.column],
        };

  const totalCellClass =
    "px-2 py-1 text-right text-xs font-semibold tabular-nums text-gray-900 dark:text-slate-100";

  return (
    <div
      role="region"
      aria-labelledby="review-matrix-heading"
      // Focusable so keyboard users can scroll it.
      tabIndex={0}
      onScroll={() => hoverCell(null)}
      // Over the cells and the tooltip alike, for the Escape dismissal.
      onPointerMove={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
      // Relative, so the screen-reader-only text in cells (absolutely positioned) is clipped
      // here instead of widening the page.
      className="relative max-h-[80vh] overflow-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400"
    >
      <table className="border-separate border-spacing-0.5">
        <caption className="sr-only">
          {metric === "reviews" ? "Reviews" : "PRs reviewed"} by each reviewer (columns) on each
          author's PRs (rows), with totals.
        </caption>
        <thead>
          <tr>
            <td className="sticky top-0 left-0 z-20 bg-white px-2 pb-1.5 align-bottom text-xs text-gray-500 sm:pl-0 dark:bg-slate-900 dark:text-slate-400">
              <span aria-hidden="true" className="flex flex-col gap-1">
                <span className="text-right">Reviewer →</span>
                <span>Author ↓</span>
              </span>
            </td>
            {view.columns.map((column, i) => (
              <ColumnHeader
                key={personKey(column)}
                entry={column}
                isHighlighted={hover?.column === i}
              />
            ))}
            <th
              scope="col"
              className="sticky top-0 z-10 bg-white px-2 pb-1.5 align-bottom text-right text-xs font-medium text-gray-500 dark:bg-slate-900 dark:text-slate-400"
            >
              Total
            </th>
          </tr>
        </thead>
        <tbody
          onPointerOver={onPointer}
          // Only to lift a dismissal; a move within the same cell changes nothing.
          onPointerMove={(event) => {
            if (dismissedAt.current !== null) onPointer(event);
          }}
          onPointerLeave={leaveSoon}
        >
          {view.rows.map((row, r) => (
            <tr key={personKey(row)}>
              <RowHeader entry={row} isHighlighted={hover?.row === r} />
              {view.columns.map((column, c) => {
                const counts = view.counts[r][c];
                const value = counts[metric];
                const isAggregate = row.kind === "others" || column.kind === "others";
                const isCrosshair = hover !== null && (hover.row === r || hover.column === c);
                const isHovered = hover?.row === r && hover.column === c;
                // Folded cells sum many pairs, so a shade would overstate them on a scale
                // set by single pairs.
                const level = isAggregate ? 0 : shadeLevel(value, view.max);
                const fill =
                  level > 0
                    ? SHADE_CLASSES[level]
                    : isCrosshair
                      ? CROSSHAIR_CLASS
                      : isAggregate && value > 0
                        ? "bg-white text-gray-600 dark:bg-slate-900 dark:text-slate-300"
                        : EMPTY_CELL_CLASS;
                return (
                  <td
                    key={personKey(column)}
                    data-row={r}
                    data-column={c}
                    className={`h-8 min-w-8 rounded-sm px-1 text-center text-xs font-medium tabular-nums ${fill} ${
                      isHovered ? "ring-2 ring-gray-900 ring-inset dark:ring-white" : ""
                    }`}
                  >
                    {isSelf(row, column) ? (
                      <>
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">own PRs</span>
                      </>
                    ) : value > 0 ? (
                      value.toLocaleString()
                    ) : (
                      <span className="sr-only">0</span>
                    )}
                  </td>
                );
              })}
              <td className={totalCellClass}>{row.totals[metric].toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th
              scope="row"
              className="sticky bottom-0 left-0 z-20 bg-white px-2 py-1 text-left text-xs font-medium text-gray-500 sm:pl-0 dark:bg-slate-900 dark:text-slate-400"
            >
              Total
            </th>
            {view.columns.map((column) => (
              <td
                key={personKey(column)}
                className={`sticky bottom-0 z-10 bg-white text-center dark:bg-slate-900 ${totalCellClass}`}
              >
                {column.totals[metric].toLocaleString()}
              </td>
            ))}
            <td className={`sticky bottom-0 z-10 bg-white dark:bg-slate-900 ${totalCellClass}`}>
              {view.totals[metric].toLocaleString()}
            </td>
          </tr>
        </tfoot>
      </table>
      {hovered?.author && hovered.reviewer && hovered.counts && hover && (
        <Tooltip
          hover={hover}
          text={describeCell({
            author: hovered.author,
            reviewer: hovered.reviewer,
            counts: hovered.counts,
            metric,
          })}
          detail={isSelf(hovered.author, hovered.reviewer) ? null : countsDetail(hovered.counts)}
          onPointerEnter={cancelLeave}
          onPointerLeave={leaveSoon}
        />
      )}
    </div>
  );
}

// An author-to-reviewer heatmap: who reviews whose PRs, to show uneven load and groups that
// only review each other.
export function ReviewMatrixSection({ cells, teamMembers, includeBots }: ReviewMatrixSectionProps) {
  const [metric, setMetric] = useState<MatrixMetric>("reviews");
  const [showAll, setShowAll] = useState(false);
  const view = useMemo(
    () => buildMatrixView({ cells, metric, limit: showAll ? null : DEFAULT_LIMIT }),
    [cells, metric, showAll],
  );
  const hasTeamFilter = teamMembers.length > 0;
  const isCapped = view.rows.length < view.authorCount || view.columns.length < view.reviewerCount;
  const canCollapse =
    showAll && (view.authorCount > DEFAULT_LIMIT + 1 || view.reviewerCount > DEFAULT_LIMIT + 1);
  const note = singlePersonNote(view);

  return (
    <section aria-labelledby="review-matrix-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-slate-800">
        <h3
          id="review-matrix-heading"
          className="text-sm font-semibold text-gray-900 dark:text-slate-100"
        >
          Who reviews whom
        </h3>
        {cells.length > 0 && (
          <div className="flex items-center gap-2">
            <MetricToggle metric={metric} onChange={setMetric} />
            <button
              type="button"
              onClick={() => downloadCsv(cells, metric)}
              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
            >
              <svg
                className="w-3.5 h-3.5 mr-1.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
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
        )}
      </div>

      <div className="space-y-4 p-6">
        <div className="max-w-3xl space-y-1 text-sm text-gray-500 dark:text-slate-400">
          <p>
            Each row is a PR author and each column a reviewer.{" "}
            {metric === "reviews"
              ? "A cell counts the reviews that reviewer left on the author's PRs."
              : "A cell counts the author's PRs that reviewer reviewed, however many reviews they left on each."}{" "}
            A stronger shade means more.
          </p>
          <p>
            A column far stronger than the rest means one person carries much of the load. A block
            of people who review each other and few others is a silo.
          </p>
        </div>
        {cells.length > 0 && <Legend max={view.max} metric={metric} />}
        {hasTeamFilter && (
          <p className="inline-flex rounded-lg bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
            Team filter on: only reviews by the{" "}
            {teamMembers.length === 1
              ? "listed team member"
              : `${teamMembers.length} listed team members`}{" "}
            count, on anyone's PRs.
          </p>
        )}
        {note && <p className="text-sm text-gray-600 dark:text-slate-300">{note}</p>}

        {cells.length === 0 ? (
          <EmptyState hasTeamFilter={hasTeamFilter} />
        ) : (
          <>
            <MatrixTable view={view} metric={metric} />
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500 dark:text-slate-400">
              <p>
                Counts the reviews in the breakdown below: dismissed reviews
                {includeBots ? "" : ", bots"} and self-reviews are left out.
                {metric === "prs" && " A PR reviewed by two people counts once in each column."}
              </p>
              {(isCapped || canCollapse) && (
                <button
                  type="button"
                  onClick={() => setShowAll(!showAll)}
                  className="rounded-sm font-medium text-indigo-600 hover:text-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  {showAll
                    ? `Show the top ${DEFAULT_LIMIT}`
                    : `Show all ${pluralize(view.authorCount, "author")} and ${pluralize(view.reviewerCount, "reviewer")}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
