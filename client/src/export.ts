import { parseList } from "../../shared/schemas";
import type { ShownAnalysis } from "./analysisState";

// Past a few repositories the joined names would make an unwieldy filename, close to the
// 255-byte limit most filesystems set, so the name only counts them.
const MAX_NAMED_REPOS = 3;

// A name like pr-reviews-acme-widgets-2026-10-01-2026-11-09.json. An open range end, which
// the server leaves empty, reads "start" or "today".
export function exportFilename(shown: ShownAnalysis, extension: string): string {
  const repos = parseList(shown.values.repo);
  const repoPart =
    repos.length > MAX_NAMED_REPOS ? `${repos.length}-repos` : repos.join("+").replaceAll("/", "-");
  const { since, until } = shown.result.timeRange;
  const name = `pr-reviews-${repoPart}-${since || "start"}-${until || "today"}`;
  return `${name.replace(/[^\w.+-]/g, "-")}.${extension}`;
}

// The analysis as JSON for an LLM: the question it answers, then the full result, per-repo
// metrics included. The range is the server's resolved one, with null for an open end, so
// a preset like "month" never needs interpreting.
export function toExportJson(shown: ShownAnalysis, exportedAt: Date = new Date()): string {
  const { values, result } = shown;
  return JSON.stringify(
    {
      exportedAt: exportedAt.toISOString(),
      query: {
        repos: parseList(values.repo),
        label: values.label || null,
        team: parseList(values.team),
        timeRange: {
          since: result.timeRange.since || null,
          until: result.timeRange.until || null,
        },
        includeBots: values.includeBots,
      },
      result,
    },
    null,
    2,
  );
}
