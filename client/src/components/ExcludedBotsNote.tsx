import type { ExcludedBots } from "../types";

interface ExcludedBotsNoteProps {
  excludedBots: ExcludedBots;
}

function describeExclusions({ prs, reviews }: ExcludedBots): string | null {
  const parts: string[] = [];
  if (prs > 0) parts.push(`${prs.toLocaleString()} PR${prs === 1 ? "" : "s"} opened by bots`);
  if (reviews > 0) {
    parts.push(`${reviews.toLocaleString()} bot review${reviews === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  const isSingular = parts.length === 1 && prs + reviews === 1;
  return `${parts.join(" and ")} ${isSingular ? "isn't" : "aren't"} counted.`;
}

// One quiet line saying what excluding bots left out, so the totals don't read as missing
// data. Nothing when no bot activity was found.
export function ExcludedBotsNote({ excludedBots }: ExcludedBotsNoteProps) {
  const description = describeExclusions(excludedBots);
  if (description === null) return null;

  return <p className="text-xs text-gray-500 dark:text-slate-400">Bots excluded: {description}</p>;
}
