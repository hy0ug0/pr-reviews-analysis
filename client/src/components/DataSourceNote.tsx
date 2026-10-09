import { describeDataSource } from "../../../shared/data-source";
import type { DataSource } from "../types";

interface DataSourceNoteProps {
  dataSource: DataSource;
  matchingPRs: number;
  loading: boolean;
  onRefresh: () => void;
}

// Every item carries its own leading "·" in its left padding. The list is shifted left by
// that width inside a clipping box, so the separator of whichever item starts a line is cut
// off and a wrapped line never begins with "·". Flex wrapping moves whole items to the next
// line; an item wraps inside itself only when it is wider than a full line, and its text
// then stays clear of the clipped padding. Breaking inside a word ("anywhere") is the very
// last resort, for a line narrower than "12,592 PRs", as on a 320 px phone at 200% zoom.
const itemClass =
  "relative pl-4 [overflow-wrap:anywhere] before:absolute before:left-0 before:w-4 before:text-center before:text-slate-300 before:content-['·'] dark:before:text-slate-600";

// Where the results came from: cache or GitHub, the GitHub requests the run made, and how old
// the cached part is. Informational, so slate rather than the warning's amber.
export function DataSourceNote({
  dataSource,
  matchingPRs,
  loading,
  onRefresh,
}: DataSourceNoteProps) {
  const line = describeDataSource({ dataSource, matchingPRs, now: Date.now() });

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-800 px-4 py-2.5">
      <div className="flex items-start gap-2.5 text-sm text-slate-500 dark:text-slate-400">
        <svg
          className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
          />
        </svg>
        <div className="min-w-0 flex-1 overflow-hidden">
          <ul className="-ml-4 flex flex-wrap">
            {line.items.map((item) => (
              <li key={item.text} className={itemClass}>
                {item.title === null ? (
                  item.text
                ) : (
                  <span
                    title={item.title}
                    className="underline decoration-slate-300 decoration-dotted underline-offset-4 dark:decoration-slate-600"
                  >
                    {item.text}
                  </span>
                )}
              </li>
            ))}
            {line.canRefresh && (
              <li className={itemClass}>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  aria-label="Refresh from GitHub"
                  title="Search the PR list on GitHub again and fetch the PRs that changed"
                  className="rounded px-1 font-medium text-indigo-600 hover:text-indigo-700 hover:underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  Refresh
                </button>
              </li>
            )}
          </ul>
        </div>
      </div>
      {line.split && (
        // Spans the strip's full inner width, so the proportion reads against the same
        // baseline whatever the text length.
        <div className="mt-2 flex h-1 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
          <div
            className="min-w-0.5 rounded-full bg-slate-300 dark:bg-slate-600"
            style={{ flexGrow: line.split.cached }}
          />
          <div
            className="min-w-0.5 rounded-full bg-indigo-500 dark:bg-indigo-400"
            style={{ flexGrow: line.split.fetched }}
          />
        </div>
      )}
    </div>
  );
}
