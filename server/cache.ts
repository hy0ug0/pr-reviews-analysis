import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { createLogger } from "./logger.ts";

const log = createLogger("cache");

const DEFAULT_CACHE_TTL_HOURS = 6;
const DEFAULT_PR_CACHE_TTL_DAYS = 30;
const DEFAULT_CACHE_DIR = resolve(process.cwd(), ".cache", "pr-reviews-analysis");

interface CacheRecord<T> {
  cachedAt: string;
  expiresAt: string;
  value: T;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCacheRecord(value: unknown): value is CacheRecord<unknown> {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.cachedAt === "string" &&
    typeof value.expiresAt === "string" &&
    Object.hasOwn(value, "value")
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

  return parsed;
}

const CACHE_TTL_HOURS = parsePositiveInteger(process.env.CACHE_TTL_HOURS, DEFAULT_CACHE_TTL_HOURS);
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;
const PR_CACHE_TTL_DAYS = parsePositiveInteger(
  process.env.PR_CACHE_TTL_DAYS,
  DEFAULT_PR_CACHE_TTL_DAYS,
);
const PR_CACHE_TTL_MS = PR_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

// "listing" entries follow CACHE_TTL_HOURS. "pullRequest" entries stay valid while their
// updatedAt matches GitHub, so they follow the longer PR_CACHE_TTL_DAYS.
export type CacheTtl = "listing" | "pullRequest";

function ttlMs(ttl: CacheTtl): number {
  switch (ttl) {
    case "listing":
      return CACHE_TTL_MS;
    case "pullRequest":
      return PR_CACHE_TTL_MS;
    default: {
      const _exhaustive: never = ttl;
      return _exhaustive;
    }
  }
}

const CACHE_DIR = process.env.CACHE_DIR
  ? resolve(process.cwd(), process.env.CACHE_DIR)
  : DEFAULT_CACHE_DIR;

function getCacheFilePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

// The namespace is part of both the hash input and the file name, so entries from
// another namespace (or written before namespaces existed) never match a key.
export function buildCacheKey(namespace: string, value: unknown): string {
  const serialized = JSON.stringify({ namespace, value });
  const hash = createHash("sha256").update(serialized).digest("hex");
  return `${namespace}-${hash}`;
}

// Namespace plus the first 10 hash characters, for logs.
export function shortCacheKey(key: string): string {
  return key.slice(0, key.lastIndexOf("-") + 11);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removeCacheFile(key: string): Promise<void> {
  await rm(getCacheFilePath(key), { force: true }).catch((error: unknown) => {
    log.warn(`Failed to remove cache entry ${shortCacheKey(key)}: ${errorMessage(error)}`);
  });
}

async function discardCacheEntry(key: string, reason: string): Promise<null> {
  log.warn(`Discarding cache entry ${shortCacheKey(key)}: ${reason}`);
  await removeCacheFile(key);
  return null;
}

export async function readCache<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(await readFile(getCacheFilePath(key), "utf8"));
  } catch (error: unknown) {
    const code = isObjectRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return null;
    return discardCacheEntry(key, `unreadable (${errorMessage(error)})`);
  }

  if (!isCacheRecord(parsedRaw)) {
    return discardCacheEntry(key, "malformed record");
  }

  const expiresAt = Date.parse(parsedRaw.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    await removeCacheFile(key);
    return null;
  }

  const value = schema.safeParse(parsedRaw.value);
  if (!value.success) {
    return discardCacheEntry(key, "value does not match the expected shape");
  }

  return value.data;
}

export async function writeCache<T>(key: string, value: T, ttl: CacheTtl): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const filePath = getCacheFilePath(key);
  // Concurrent identical requests write the same key, so the temp name must be unique.
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  const now = Date.now();
  const payload: CacheRecord<T> = {
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs(ttl)).toISOString(),
    value,
  };

  const serialized = JSON.stringify(payload);

  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, filePath);
  } catch (error: unknown) {
    await rm(tmpPath, { force: true }).catch(() => {
      // The write error below is the one worth reporting.
    });
    throw error;
  }
}

export function getCacheConfig(): { cacheDir: string; ttlHours: number; prTtlDays: number } {
  return { cacheDir: CACHE_DIR, ttlHours: CACHE_TTL_HOURS, prTtlDays: PR_CACHE_TTL_DAYS };
}
