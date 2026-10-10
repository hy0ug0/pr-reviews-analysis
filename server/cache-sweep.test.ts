import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { consola, type LogObject } from "consola";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_NAMESPACES, LISTING_NAMESPACE, PULL_REQUEST_NAMESPACE } from "./cache-namespaces.ts";

const { chmod, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } = fs;

// The sweep opens an entry to read its head, then unlinks it. To put a write between the
// two, open is wrapped: closing the handle of `interceptedPath` runs `onHeadClosed` first.
let interceptedPath: string | null = null;
let onHeadClosed = async () => {};
const realOpen = fs.open;
await mock.module("node:fs/promises", () => ({
  ...fs,
  open: async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args);
    if (args[0] !== interceptedPath) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      await onHeadClosed();
    };
    return handle;
  },
}));

// Loggers copy the level and share the reporter list when a module creates them, so set
// both before importing. consola logs only warnings under test by default.
const logs: string[] = [];
consola.level = 3;
consola.options.reporters.splice(0, consola.options.reporters.length, {
  log: (entry: LogObject) => logs.push(entry.args.map(String).join(" ")),
});

// cache.ts reads CACHE_DIR once at load time, so set it only around the import.
const cacheDir = join(tmpdir(), `pr-reviews-analysis-sweep-${randomUUID()}`);
const previousCacheDir = process.env.CACHE_DIR;
process.env.CACHE_DIR = cacheDir;
const { getCacheConfig, writeCache } = await import("./cache.ts");
const { sweepCacheDir } = await import("./cache-sweep.ts");
if (previousCacheDir === undefined) delete process.env.CACHE_DIR;
else process.env.CACHE_DIR = previousCacheDir;

if (getCacheConfig().cacheDir !== cacheDir) {
  throw new Error("cache.ts was loaded before CACHE_DIR was set");
}

afterAll(() => rm(cacheDir, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  logs.length = 0;
  interceptedPath = null;
});

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function versionOf(namespace: string): string {
  return namespace.replace(/^.*-v/, "");
}

function record(expiresAt: string): string {
  return JSON.stringify({ cachedAt: "2026-10-01T00:00:00.000Z", expiresAt, value: { n: 1 } });
}

async function plant(name: string, content = record("2100-01-01T00:00:00.000Z")): Promise<string> {
  await writeFile(join(cacheDir, name), content, "utf8");
  return name;
}

async function plantWithAge(name: string, ageMs: number): Promise<string> {
  await plant(name, "{");
  const mtime = new Date(NOW - ageMs);
  await utimes(join(cacheDir, name), mtime, mtime);
  return name;
}

async function sweep() {
  return sweepCacheDir({ dir: cacheDir, namespaces: CACHE_NAMESPACES, now: NOW });
}

async function remaining(): Promise<string[]> {
  return (await readdir(cacheDir)).sort();
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the sweep to fail");
}

describe("sweepCacheDir", () => {
  test("keeps valid current entries and removes expired ones", async () => {
    // Written by writeCache itself, so a change to the record layout shows up here.
    await writeCache(`${LISTING_NAMESPACE}-${hash("listing")}`, { prs: [] }, "listing");
    await writeCache(`${PULL_REQUEST_NAMESPACE}-${hash("pr")}`, { number: 1 }, "pullRequest");
    const expiredListing = await plant(
      `${LISTING_NAMESPACE}-${hash("old listing")}.json`,
      record("2026-10-10T11:59:59.999Z"),
    );
    const expiredPR = await plant(
      `${PULL_REQUEST_NAMESPACE}-${hash("old pr")}.json`,
      record("2026-09-01T00:00:00.000Z"),
    );
    const before = await remaining();

    const summary = await sweep();

    expect(await remaining()).toEqual(
      before.filter((name) => name !== expiredListing && name !== expiredPR),
    );
    expect(summary.removed.expired).toBe(2);
    expect(summary.kept).toBe(2);
    expect(summary.failed).toBe(0);
  });

  test("checks each namespace against its own version", async () => {
    // The listing family with the PR version number, and the PR family with the listing's.
    const listingWithPRVersion = `pull-request-listing-v${versionOf(PULL_REQUEST_NAMESPACE)}`;
    const prWithListingVersion = `pull-request-v${versionOf(LISTING_NAMESPACE)}`;
    expect(CACHE_NAMESPACES.current).not.toContain(listingWithPRVersion);
    expect(CACHE_NAMESPACES.current).not.toContain(prWithListingVersion);

    await plant(`${listingWithPRVersion}-${hash("a")}.json`);
    await plant(`${prWithListingVersion}-${hash("b")}.json`);
    await plant(`pull-request-v1-${hash("c")}.json`);
    await plant(`pull-request-v99-${hash("d")}.json`);
    const current = await plant(`${PULL_REQUEST_NAMESPACE}-${hash("e")}.json`);

    const summary = await sweep();

    expect(await remaining()).toEqual([current]);
    expect(summary.removed.outdated).toBe(4);
  });

  test("removes the whole-result format and legacy unnamespaced files", async () => {
    await plant(`pull-requests-v1-${hash("whole")}.json`);
    await plant(`${hash("legacy")}.json`, "not even json");

    const summary = await sweep();

    expect(await remaining()).toEqual([]);
    expect(summary.removed).toMatchObject({ outdated: 1, legacy: 1 });
  });

  test("treats an expiresAt it cannot parse as expired, like readCache", async () => {
    await plant(`${PULL_REQUEST_NAMESPACE}-${hash("bad date")}.json`, record("soon"));

    const summary = await sweep();

    expect(await remaining()).toEqual([]);
    expect(summary.removed.expired).toBe(1);
  });

  test("leaves a current entry alone when expiresAt is not in its first bytes", async () => {
    const valid = { cachedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2100-01-01T00:00:00.000Z" };
    const planted = [
      await plant(`${PULL_REQUEST_NAMESPACE}-${hash("garbage")}.json`, '{"value":1}'),
      await plant(`${PULL_REQUEST_NAMESPACE}-${hash("empty")}.json`, ""),
      // Valid records readCache accepts, laid out in ways writeCache does not produce.
      await plant(
        `${PULL_REQUEST_NAMESPACE}-${hash("indented")}.json`,
        `${" ".repeat(300)}${JSON.stringify({ ...valid, value: 1 })}`,
      ),
      await plant(
        `${PULL_REQUEST_NAMESPACE}-${hash("reordered")}.json`,
        JSON.stringify({ value: "x".repeat(300), ...valid }),
      ),
    ];
    // Pretty-printed, with expiresAt in reach: still decided.
    await plant(
      `${PULL_REQUEST_NAMESPACE}-${hash("pretty")}.json`,
      JSON.stringify({ ...valid, expiresAt: "2000-01-01T00:00:00.000Z", value: 1 }, null, 2),
    );

    const summary = await sweep();

    expect(await remaining()).toEqual(planted.sort());
    expect(summary.undecided).toBe(4);
    expect(summary.removed.expired).toBe(1);
    expect(logs[0]).toEndWith("kept 0 entries, left 4 unreadable");
  });

  // The sweep decides from the file's content, then unlinks by path. A fresh entry renamed
  // over that path in between must not be the one unlinked.
  test("keeps an entry rewritten while the sweep was deciding on it", async () => {
    const key = `${PULL_REQUEST_NAMESPACE}-${hash("refreshed")}`;
    await plant(`${key}.json`, record("2000-01-01T00:00:00.000Z"));
    interceptedPath = join(cacheDir, `${key}.json`);
    onHeadClosed = () => writeCache(key, { fresh: true }, "pullRequest");

    const summary = await sweep();

    expect(await readFile(join(cacheDir, `${key}.json`), "utf8")).toContain(
      '"value":{"fresh":true}',
    );
    expect(summary.removed.expired).toBe(0);
    expect(summary.kept).toBe(1);
  });

  test("removes stale temp files and keeps young ones", async () => {
    const entry = `${PULL_REQUEST_NAMESPACE}-${hash("t")}.json`;
    const legacy = `${hash("l")}.json`;
    await plantWithAge(`${entry}.123.${randomUUID()}.tmp`, 5 * MINUTE_MS);
    await plantWithAge(`${entry}.123.1759000000000.tmp`, 60 * MINUTE_MS);
    await plantWithAge(`${legacy}.123.${randomUUID()}.tmp`, 60 * MINUTE_MS);
    const young = await plantWithAge(`${entry}.456.${randomUUID()}.tmp`, 5 * MINUTE_MS - 1);
    const foreign = await plantWithAge("notes.tmp", 60 * MINUTE_MS);

    const summary = await sweep();

    expect(await remaining()).toEqual([foreign, young].sort());
    expect(summary.removed["stale temp"]).toBe(3);
  });

  test("never touches files outside the cache patterns", async () => {
    const h = hash("foreign");
    const planted = [
      await plant("README.md", "hello"),
      await plant("pull-request.json", "{}"),
      await plant(`other-v1-${h}.json`),
      // The retired namespace only ever had one version.
      await plant(`pull-requests-v2-${h}.json`),
      await plant(`${PULL_REQUEST_NAMESPACE}-${h.toUpperCase()}.json`),
      await plant(`${PULL_REQUEST_NAMESPACE}-${h.slice(1)}.json`),
      await plant(`${PULL_REQUEST_NAMESPACE}-${h}.json.bak`),
      await plant(`${PULL_REQUEST_NAMESPACE}-${h}.json.tmp`),
      await plantWithAge(`${PULL_REQUEST_NAMESPACE}-${h}.json.123.deadbeef.tmp`, 60 * MINUTE_MS),
      await plantWithAge(`${PULL_REQUEST_NAMESPACE}-${h}.json.123.---.tmp`, 60 * MINUTE_MS),
      await plantWithAge(`${PULL_REQUEST_NAMESPACE}-${h}.json.${randomUUID()}.tmp`, 60 * MINUTE_MS),
      await plant(`x${PULL_REQUEST_NAMESPACE}-${h}.json`),
      await plant(`${hash("old")}.json.backup`, "x"),
    ];
    // A directory named like an entry, with a legacy file inside: neither is touched.
    const nested = `pull-request-v1-${hash("dir")}.json`;
    await mkdir(join(cacheDir, nested));
    await writeFile(join(cacheDir, nested, `${hash("inner")}.json`), "{}", "utf8");
    // A symlink named like a legacy file, pointing at a kept file: both survive.
    const link = `${hash("link")}.json`;
    await symlink(join(cacheDir, "README.md"), join(cacheDir, link));

    const summary = await sweep();

    expect(await remaining()).toEqual([...planted, nested, link].sort());
    expect(await readdir(join(cacheDir, nested))).toEqual([`${hash("inner")}.json`]);
    expect(summary).toEqual({
      removed: { expired: 0, outdated: 0, legacy: 0, "stale temp": 0 },
      removedBytes: 0,
      kept: 0,
      undecided: 0,
      failed: 0,
    });
  });

  test("counts and warns about files it cannot remove, and goes on", async () => {
    const locked = join(cacheDir, "locked");
    await mkdir(locked);
    const stuck = `pull-request-v1-${hash("stuck")}.json`;
    await writeFile(join(locked, stuck), "{}", "utf8");
    await writeFile(join(locked, `${hash("legacy")}.json`), "{}", "utf8");
    // Readable, but no file in it can be unlinked.
    await chmod(locked, 0o500);

    const summary = await sweepCacheDir({
      dir: locked,
      namespaces: CACHE_NAMESPACES,
      now: NOW,
    }).finally(() => chmod(locked, 0o700));

    expect((await readdir(locked)).sort()).toEqual([stuck, `${hash("legacy")}.json`].sort());
    expect(summary.failed).toBe(2);
    expect(summary.removed).toEqual({ expired: 0, outdated: 0, legacy: 0, "stale temp": 0 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^Cache sweep \(\d+(\.\d)? s\): nothing to remove, kept 0 entries$/);
    expect(logs[1]).toStartWith("Cache sweep: could not remove 2 files (");
  });

  test("logs what it removed", async () => {
    await plant(`${PULL_REQUEST_NAMESPACE}-${hash("k")}.json`);
    await plant(`pull-request-v1-${hash("o")}.json`, "x".repeat(2048));
    await plant(`${hash("l")}.json`, "x".repeat(1024));

    const summary = await sweep();

    expect(summary.removedBytes).toBe(3072);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^Cache sweep \(\d+(\.\d)? s\): removed 2 files, 3\.0 KB \(1 outdated, 1 legacy\), kept 1 entry$/,
    );
  });

  test("logs when there is nothing to remove", async () => {
    await writeCache(`${PULL_REQUEST_NAMESPACE}-${hash("k")}`, { number: 1 }, "pullRequest");

    await sweep();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^Cache sweep \(\d+(\.\d)? s\): nothing to remove, kept 1 entry$/);
  });

  test("warns and does nothing when the directory is missing", async () => {
    const missing = join(cacheDir, "missing");

    const summary = await sweepCacheDir({ dir: missing, namespaces: CACHE_NAMESPACES });

    expect(summary.kept).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith(`Cache sweep skipped: cannot read ${missing} (`);
  });

  test("warns and does nothing when the directory is unreadable", async () => {
    const locked = join(cacheDir, "locked");
    await mkdir(locked);
    await writeFile(join(locked, `${hash("inside")}.json`), "{}", "utf8");
    await chmod(locked, 0o000);

    try {
      await sweepCacheDir({ dir: locked, namespaces: CACHE_NAMESPACES });
    } finally {
      await chmod(locked, 0o700);
    }

    expect(await readdir(locked)).toEqual([`${hash("inside")}.json`]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith(`Cache sweep skipped: cannot read ${locked} (`);
  });

  // A programming error, not a directory problem, so it is not turned into a warning.
  test("rejects a namespace without a version", async () => {
    const sweeping = sweepCacheDir({
      dir: cacheDir,
      namespaces: { current: ["pull-request"], retired: [] },
    });

    expect(await rejection(sweeping)).toBe(
      'Cache namespace "pull-request" is not "<family>-v<version>".',
    );
  });
});
