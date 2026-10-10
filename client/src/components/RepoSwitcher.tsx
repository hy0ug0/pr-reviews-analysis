import { useEffect, useRef, useState, type RefObject } from "react";
import type { RepoMetrics } from "../types";
import { repoOptionId } from "./repoOption";

interface RepoSwitcherProps {
  byRepo: RepoMetrics[];
  // The PRs every metric counts, across all repositories.
  totalPRs: number;
  // Null for all repositories.
  selected: string | null;
  onSelect: (repo: string | null) => void;
}

// "owner/" in a lighter ink, so names that share an owner read apart by their name. In the
// switcher, the checked option tints it.
export function RepoName({ repo }: { repo: string }) {
  const slash = repo.indexOf("/");
  return (
    <>
      <span className="text-gray-500 group-has-checked:text-indigo-500 dark:text-slate-400 dark:group-has-checked:text-indigo-400">
        {repo.slice(0, slash + 1)}
      </span>
      {repo.slice(slash + 1)}
    </>
  );
}

function Option({
  repo,
  prs,
  checked,
  onSelect,
}: {
  repo: string | null;
  prs: number;
  checked: boolean;
  onSelect: (repo: string | null) => void;
}) {
  return (
    <label
      title={repo ?? undefined}
      className="group relative inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 has-checked:bg-indigo-50 has-checked:text-indigo-700 has-focus-visible:ring-2 has-focus-visible:ring-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:has-checked:bg-indigo-950/60 dark:has-checked:text-indigo-300 dark:has-focus-visible:ring-indigo-400"
    >
      {/* A native radio: arrow keys move the selection and Tab leaves the group. */}
      <input
        type="radio"
        name="shown-repo"
        id={repoOptionId(repo)}
        checked={checked}
        onChange={() => onSelect(repo)}
        className="sr-only"
      />
      <span className="max-w-[11rem] truncate sm:max-w-[18rem]">
        {repo === null ? "All repositories" : <RepoName repo={repo} />}
      </span>
      <span className="text-xs tabular-nums text-gray-400 group-has-checked:text-indigo-500 dark:text-slate-500 dark:group-has-checked:text-indigo-400">
        {prs.toLocaleString()}
        <span className="sr-only"> PRs</span>
      </span>
    </label>
  );
}

// Which ends of a sideways-scrolling row hide options, so only those ends get a fade.
function useHiddenEdges(ref: RefObject<HTMLElement | null>, content: unknown) {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => {
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, content]);
  return edges;
}

const FADE = "2.5rem";
// The fade's width in px, kept clear around the checked option when the row scrolls to it.
const FADE_PX = 40;

// Scrolls the row sideways, and only the row, until the checked option is clear of the fades.
// Arrow keys already bring a focused option into view; a pick from the comparison table, a
// result rendered again (Refresh keeps the selection) or a narrower window would otherwise
// leave it hidden.
function useCheckedInView(ref: RefObject<HTMLElement | null>, selected: string | null) {
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const reveal = () => {
      const option = row.querySelector("input:checked")?.closest("label");
      if (!option) return;
      const rowBox = row.getBoundingClientRect();
      const box = option.getBoundingClientRect();
      if (box.left < rowBox.left + FADE_PX) {
        row.scrollLeft -= rowBox.left + FADE_PX - box.left;
      } else if (box.right > rowBox.right - FADE_PX) {
        row.scrollLeft += box.right - (rowBox.right - FADE_PX);
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(row);
    return () => observer.disconnect();
  }, [ref, selected]);
}

// Picks which repository every section below shows. It stays in view while the page scrolls,
// so the reviewer table at the bottom still says whose it is. One row that scrolls sideways
// when the names don't fit, faded on the side where options are hidden.
export function RepoSwitcher({ byRepo, totalPRs, selected, onSelect }: RepoSwitcherProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const edges = useHiddenEdges(rowRef, byRepo);
  useCheckedInView(rowRef, selected);
  const start = edges.start ? FADE : "0px";
  const end = edges.end ? FADE : "0px";

  return (
    <fieldset className="sticky top-3 z-10 min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <legend className="sr-only">Repository shown</legend>
      <div
        ref={rowRef}
        className="flex gap-1 overflow-x-auto px-3 py-1.5"
        style={{
          maskImage: `linear-gradient(to right, transparent, black ${start}, black calc(100% - ${end}), transparent)`,
        }}
      >
        <Option repo={null} prs={totalPRs} checked={selected === null} onSelect={onSelect} />
        {byRepo.map(({ repo, metrics }) => (
          <Option
            key={repo}
            repo={repo}
            prs={metrics.countedPRs}
            checked={selected === repo}
            onSelect={onSelect}
          />
        ))}
      </div>
    </fieldset>
  );
}
