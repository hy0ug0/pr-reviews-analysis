import type { ExcludedBots } from "../types";

interface ExcludedBotsNoteProps {
  excludedBots: ExcludedBots;
}

function describeExclusions({ prs, reviews }: ExcludedBots): string[] {
  const parts: string[] = [];
  if (prs > 0) parts.push(`${prs.toLocaleString()} PR${prs === 1 ? "" : "s"} opened by bots`);
  if (reviews > 0) {
    parts.push(`${reviews.toLocaleString()} bot review${reviews === 1 ? "" : "s"}`);
  }
  return parts;
}

// One quiet line saying what excluding bots left out, so totals that leave out bot PRs
// don't read as missing data. Nothing when no bot activity was found.
export function ExcludedBotsNote({ excludedBots }: ExcludedBotsNoteProps) {
  const parts = describeExclusions(excludedBots);
  if (parts.length === 0) return null;

  return (
    <p className="text-xs text-gray-400 dark:text-slate-500">
      Bots excluded: not counting {parts.join(" and ")}
    </p>
  );
}
