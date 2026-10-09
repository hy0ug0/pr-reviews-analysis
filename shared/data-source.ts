import { formatFetchTime, formatTimeAgo, pluralize } from "./format";
import type { DataSource } from "./types";

// Share of the loaded PRs that came from the cache, in whole percent. A mixed run never
// rounds to 0% or 100%, which would read as "none" or "all".
export function cachedPercent({ reusedPRs, fetchedPRs }: DataSource): number {
  const total = reusedPRs + fetchedPRs;
  if (total === 0) return 0;
  const percent = Math.round((reusedPRs / total) * 100);
  if (reusedPRs > 0 && fetchedPRs > 0) return Math.min(99, Math.max(1, percent));
  return percent;
}

function countRequests(count: number): string {
  return pluralize(count, "GitHub request");
}

// The server's one log line per run, e.g. "Cache usage: 540/592 PRs from cache (91%),
// 52 fetched, 4 GitHub requests in 3.1 s, listing from GitHub, oldest cached 2 h ago".
export function describeCacheUsage(dataSource: DataSource, now: number): string {
  const { reusedPRs, fetchedPRs, githubRequests, fetchDurationMs } = dataSource;
  const total = reusedPRs + fetchedPRs;
  const parts = [
    `${reusedPRs}/${total} PRs from cache${total > 0 ? ` (${cachedPercent(dataSource)}%)` : ""}`,
    `${fetchedPRs} fetched`,
    `${countRequests(githubRequests)}${fetchDurationMs === null ? "" : ` in ${formatFetchTime(fetchDurationMs)}`}`,
    `listing from ${dataSource.listing === "cache" ? "cache" : "GitHub"}`,
  ];
  if (dataSource.oldestReusedCachedAt !== null) {
    parts.push(`oldest cached ${formatTimeAgo(now - Date.parse(dataSource.oldestReusedCachedAt))}`);
  }
  if (dataSource.skippedCache) parts.push("cache skipped");
  return `Cache usage: ${parts.join(", ")}`;
}

export interface DataSourceLineItem {
  text: string;
  // The absolute time behind a relative one, or other detail, for a tooltip.
  title: string | null;
}

export interface DataSourceLine {
  items: DataSourceLineItem[];
  // PR counts for the cached/fetched bar; null unless the run mixed both.
  split: { cached: number; fetched: number } | null;
  // Refreshing only searches the PR list on GitHub again (unchanged PRs are still reused),
  // so it can change the result only when the list came from the cache.
  canRefresh: boolean;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function item(text: string, title: string | null = null): DataSourceLineItem {
  return { text, title };
}

// The data-source line under the results: where the PRs came from, what it cost on GitHub,
// and how old the cached part is. matchingPRs tells "nothing matched" apart from "every
// fetch failed", which the incomplete-results warning already reports.
export function describeDataSource({
  dataSource,
  matchingPRs,
  now,
}: {
  dataSource: DataSource;
  matchingPRs: number;
  now: number;
}): DataSourceLine {
  const { listing, listedAt, reusedPRs, fetchedPRs, githubRequests, fetchDurationMs } = dataSource;
  const total = reusedPRs + fetchedPRs;
  const canRefresh = listing === "cache";
  const ago = (iso: string) => formatTimeAgo(now - Date.parse(iso));
  const listingTitle =
    listing === "cache"
      ? `PR list cached ${formatTimestamp(listedAt)}`
      : `PR list fetched from GitHub ${formatTimestamp(listedAt)}`;
  const requests = item(
    githubRequests === 0 ? countRequests(0) : pluralize(githubRequests, "request"),
    fetchDurationMs === null ? null : `${formatFetchTime(fetchDurationMs)} on GitHub`,
  );

  if (total === 0 && matchingPRs === 0) {
    const items =
      listing === "cache"
        ? [item("No PRs matched"), item(`list cached ${ago(listedAt)}`, listingTitle), requests]
        : [item("No PRs matched, cache not used"), requests];
    return { items, split: null, canRefresh };
  }

  const oldest = dataSource.oldestReusedCachedAt;
  const oldestTitle =
    oldest === null ? null : `Oldest reused PR cached ${formatTimestamp(oldest)}. ${listingTitle}.`;
  const listedFromGitHub =
    listing === "github"
      ? item(dataSource.skippedCache ? "PR list refreshed" : "PR list from GitHub", listingTitle)
      : null;

  if (reusedPRs === 0) {
    const fetchTime = fetchDurationMs === null ? "" : ` in ${formatFetchTime(fetchDurationMs)}`;
    const items = [
      item(`${pluralize(total, "PR")} fetched from GitHub${fetchTime}`, listingTitle),
      item(requests.text),
    ];
    if (dataSource.skippedCache) items.unshift(item("Cache skipped"));
    return { items, split: null, canRefresh };
  }

  if (fetchedPRs === 0) {
    const items = [
      item(total === 1 ? "1 PR from cache" : `All ${total.toLocaleString()} PRs from cache`),
    ];
    if (oldest !== null) items.push(item(`cached ${ago(oldest)}`, oldestTitle));
    if (listedFromGitHub) items.push(listedFromGitHub);
    items.push(requests);
    return { items, split: null, canRefresh };
  }

  const items = [
    item(
      `${reusedPRs.toLocaleString()} of ${pluralize(total, "PR")} from cache (${cachedPercent(dataSource)}%)`,
    ),
    item(`${fetchedPRs.toLocaleString()} refetched`),
  ];
  if (listedFromGitHub) items.push(listedFromGitHub);
  items.push(requests);
  if (oldest !== null) items.push(item(`oldest data ${ago(oldest)}`, oldestTitle));
  return { items, split: { cached: reusedPRs, fetched: fetchedPRs }, canRefresh };
}
