import type { Stats } from "node:fs";
import { lstat, open, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { formatFetchTime, pluralize } from "../shared/format.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("cache");

// A temp file this old is from a write that never finished: writeCache renames its temp file
// within a second, so a young one may still be in flight.
const TEMP_FILE_MAX_AGE_MS = 5 * 60 * 1000;

// writeCache serializes cachedAt, expiresAt and then the value, so expiresAt sits in the
// first bytes however large the value is. Listing entries run to megabytes.
const HEAD_BYTES = 256;
const EXPIRES_AT = /"expiresAt"\s*:\s*"([^"]*)"/;

// buildCacheKey's hash: a lowercase hex SHA-256.
const HASH = "[0-9a-f]{64}";
// writeCache's temp suffix: the pid, then a UUID (a millisecond timestamp before #17).
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEMP_SUFFIX = `\\.\\d+\\.(?:\\d+|${UUID})\\.tmp`;

export interface CacheSweepOptions {
  dir: string;
  // What the server reads today and what it used to write. A current namespace is
  // "<family>-v<version>", and every version of its family is a cache file. A retired
  // namespace is matched as is: nothing else was ever written under its family.
  namespaces: { current: readonly string[]; retired: readonly string[] };
  now?: number;
}

export type RemovalReason = "expired" | "outdated" | "legacy" | "stale temp";

export interface CacheSweepSummary {
  removed: Record<RemovalReason, number>;
  removedBytes: number;
  // Current entries that were read and still valid.
  kept: number;
  // Current entries whose expiresAt was not in the first bytes. They are left to readCache,
  // which reads them whole.
  undecided: number;
  // Files that matched but could not be inspected or removed.
  failed: number;
}

// What a file name says. Anything else in CACHE_DIR is not the cache's and is never touched.
type CacheFile =
  | { kind: "entry"; namespace: string }
  // "<hash>.json": written before namespaces existed.
  | { kind: "legacy" }
  // "<entry or legacy file>" plus TEMP_SUFFIX: writeCache's temp name, past and present.
  | { kind: "temp" };

interface CacheFilePatterns {
  entry: RegExp;
  legacy: RegExp;
  temp: RegExp;
}

function familyOf(namespace: string): string {
  const match = /^([a-z-]+)-v\d+$/.exec(namespace);
  if (!match) throw new Error(`Cache namespace "${namespace}" is not "<family>-v<version>".`);
  return match[1];
}

function buildPatterns({ current, retired }: CacheSweepOptions["namespaces"]): CacheFilePatterns {
  const families = Array.from(new Set(current.map(familyOf)), (family) => `${family}-v\\d+`);
  const namespace = `(${[...families, ...retired].join("|")})`;
  const entry = `${namespace}-${HASH}\\.json`;
  const legacy = `${HASH}\\.json`;
  return {
    entry: new RegExp(`^${entry}$`),
    legacy: new RegExp(`^${legacy}$`),
    temp: new RegExp(`^(?:${entry}|${legacy})${TEMP_SUFFIX}$`),
  };
}

function classify(name: string, patterns: CacheFilePatterns): CacheFile | null {
  const entry = patterns.entry.exec(name);
  if (entry) return { kind: "entry", namespace: entry[1] };
  if (patterns.legacy.test(name)) return { kind: "legacy" };
  if (patterns.temp.test(name)) return { kind: "temp" };
  return null;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Reads only the start of the file. Null when expiresAt is not there, which writeCache never
// produces: the file is not a record it wrote, whatever its name, so it is not decided here.
async function readExpiresAt(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0);
    return EXPIRES_AT.exec(buffer.toString("utf8", 0, bytesRead))?.[1] ?? null;
  } finally {
    await handle.close();
  }
}

type Verdict = { kind: "remove"; reason: RemovalReason } | { kind: "keep" } | { kind: "undecided" };

async function decide(
  path: string,
  file: CacheFile,
  info: Stats,
  current: readonly string[],
  now: number,
): Promise<Verdict> {
  switch (file.kind) {
    case "legacy":
      return { kind: "remove", reason: "legacy" };
    case "temp":
      return now - info.mtimeMs >= TEMP_FILE_MAX_AGE_MS
        ? { kind: "remove", reason: "stale temp" }
        : { kind: "keep" };
    case "entry": {
      if (!current.includes(file.namespace)) return { kind: "remove", reason: "outdated" };
      const expiresAt = await readExpiresAt(path);
      if (expiresAt === null) return { kind: "undecided" };
      // Same rule as readCache: a date it cannot parse counts as expired.
      const expiry = Date.parse(expiresAt);
      return !Number.isFinite(expiry) || now > expiry
        ? { kind: "remove", reason: "expired" }
        : { kind: "keep" };
    }
    default: {
      const _exhaustive: never = file;
      return _exhaustive;
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeSweep(
  { removed, removedBytes, kept, undecided }: CacheSweepSummary,
  durationMs: number,
): string {
  const reasons = Object.entries(removed).filter(([, count]) => count > 0);
  const removedCount = reasons.reduce((sum, [, count]) => sum + count, 0);
  const head = `Cache sweep (${formatFetchTime(durationMs)}):`;
  const keptEntries = `kept ${pluralize(kept, "entry", "entries")}`;
  const tail = undecided === 0 ? "" : `, left ${undecided.toLocaleString()} unreadable`;
  if (removedCount === 0) return `${head} nothing to remove, ${keptEntries}${tail}`;
  const breakdown = reasons.map(([reason, count]) => `${count.toLocaleString()} ${reason}`);
  return `${head} removed ${pluralize(removedCount, "file")}, ${formatBytes(removedBytes)} (${breakdown.join(", ")}), ${keptEntries}${tail}`;
}

// Deletes the cache files the server will never read again: expired entries, entries from
// another cache version, files from before namespaces existed, and temp files left by an
// interrupted write. Only regular files whose name matches a cache pattern are considered,
// and only in `dir` itself: CACHE_DIR is the user's and may hold anything else. Nothing found
// on disk makes it reject: a directory it cannot read is a warning, a file it cannot remove
// is counted.
export async function sweepCacheDir(options: CacheSweepOptions): Promise<CacheSweepSummary> {
  const { dir, namespaces, now = Date.now() } = options;
  const patterns = buildPatterns(namespaces);
  const startedAt = performance.now();
  const summary: CacheSweepSummary = {
    removed: { expired: 0, outdated: 0, legacy: 0, "stale temp": 0 },
    removedBytes: 0,
    kept: 0,
    undecided: 0,
    failed: 0,
  };
  let firstFailure = "";

  async function sweepFile(name: string, file: CacheFile): Promise<void> {
    const path = join(dir, name);
    try {
      // lstat, so a symlink that points at a file is left alone along with its target.
      const info = await lstat(path);
      if (!info.isFile()) return;
      const verdict = await decide(path, file, info, namespaces.current, now);
      if (verdict.kind === "undecided") summary.undecided++;
      if (verdict.kind === "keep" && file.kind === "entry") summary.kept++;
      if (verdict.kind !== "remove") return;
      // A writeCache may have renamed a fresh entry over this path since the decision. The
      // check cannot be atomic with the unlink, so a rename between the two still loses the
      // fresh entry, as it does under readCache: one refetch, nothing worse.
      const current = await lstat(path);
      if (current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) {
        if (file.kind === "entry") summary.kept++;
        return;
      }
      await unlink(path);
      summary.removed[verdict.reason]++;
      summary.removedBytes += info.size;
    } catch (error: unknown) {
      // Gone since the listing: readCache or another write took it.
      if (isErrorWithCode(error, "ENOENT")) return;
      summary.failed++;
      if (firstFailure === "") firstFailure = `${name}: ${errorMessage(error)}`;
    }
  }

  try {
    for await (const dirent of await opendir(dir)) {
      const file = classify(dirent.name, patterns);
      if (file) await sweepFile(dirent.name, file);
    }
  } catch (error: unknown) {
    log.warn(`Cache sweep skipped: cannot read ${dir} (${errorMessage(error)})`);
    return summary;
  }

  log.info(describeSweep(summary, performance.now() - startedAt));
  if (summary.failed > 0) {
    log.warn(
      `Cache sweep: could not remove ${pluralize(summary.failed, "file")} (${firstFailure})`,
    );
  }
  return summary;
}
