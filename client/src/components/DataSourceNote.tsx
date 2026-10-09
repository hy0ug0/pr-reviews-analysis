import type { DataSource } from "../types";

interface DataSourceNoteProps {
  dataSource: DataSource;
}

function formatAge(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Date(iso).toLocaleDateString()}`;
}

function countPRs(count: number): string {
  return `${count.toLocaleString()} PR${count === 1 ? "" : "s"}`;
}

function describeListing({ listing, listedAt }: DataSource): string {
  const age = formatAge(listedAt, Date.now());
  return listing === "cache" ? `Listed ${age} (cached)` : `Listed from GitHub ${age}`;
}

function describePullRequests({ fetchedPRs, reusedPRs }: DataSource): string {
  if (fetchedPRs > 0 && reusedPRs > 0) {
    return `${countPRs(fetchedPRs)} fetched from GitHub, ${reusedPRs.toLocaleString()} reused from cache`;
  }
  if (fetchedPRs > 0) return `${countPRs(fetchedPRs)} fetched from GitHub`;
  if (reusedPRs > 0) return `${countPRs(reusedPRs)} reused from cache`;
  return "no PRs loaded";
}

// One quiet line saying where the results came from.
export function DataSourceNote({ dataSource }: DataSourceNoteProps) {
  return (
    <p
      className="text-xs text-gray-400 dark:text-slate-500"
      title={`PR list fetched from GitHub at ${new Date(dataSource.listedAt).toLocaleString()}`}
    >
      {describeListing(dataSource)} · {describePullRequests(dataSource)}
    </p>
  );
}
