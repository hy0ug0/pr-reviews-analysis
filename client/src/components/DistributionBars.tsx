import { pluralize } from "../../../shared/format";

export interface DistributionRow {
  label: string;
  count: number;
}

interface DistributionBarsProps {
  rows: DistributionRow[];
  // What the bars count, for the shares and the accessible summary, e.g. "merged PRs".
  of: string;
  // Names the chart for screen readers, e.g. "Time to merge".
  name: string;
}

// A compact horizontal histogram: one row per bucket, bars scaled to the largest bucket, with
// each count and its share written out so the shape reads without hovering.
export function DistributionBars({ rows, of, name }: DistributionBarsProps) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const max = Math.max(0, ...rows.map((row) => row.count));
  const share = (count: number) => (total > 0 ? Math.round((count / total) * 100) : 0);

  return (
    <ul
      role="img"
      aria-label={`${name}, ${of} per bucket: ${rows
        .map((row) => `${row.label}: ${row.count.toLocaleString()}`)
        .join(", ")}.`}
      className="space-y-1.5"
    >
      {rows.map((row) => (
        <li
          key={row.label}
          title={`${pluralize(row.count, "PR")}, ${share(row.count)}% of ${of}`}
          className="grid grid-cols-[3.25rem_1fr_4.5rem] items-center gap-3 text-xs"
        >
          <span className="text-right tabular-nums text-gray-500 dark:text-slate-400">
            {row.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            {row.count > 0 && (
              <span
                className="block h-full min-w-1 rounded-full bg-indigo-600 dark:bg-indigo-500"
                style={{ width: `${(row.count / max) * 100}%` }}
              />
            )}
          </span>
          <span className="tabular-nums">
            <span className="font-semibold text-gray-900 dark:text-slate-100">
              {row.count.toLocaleString()}
            </span>
            <span className="ml-1.5 text-gray-500 dark:text-slate-400">{share(row.count)}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
