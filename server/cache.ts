import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { createLogger } from "./logger.ts";

const log = createLogger("cache");

const DEFAULT_CACHE_TTL_HOURS = 6;
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

export async function readCache<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  const path = getCacheFilePath(key);

  try {
    const raw = await readFile(path, "utf8");
    const parsedRaw: unknown = JSON.parse(raw);
    if (!isCacheRecord(parsedRaw)) {
      log.warn(`Discarding malformed cache entry ${key}`);
      await rm(path, { force: true });
      return null;
    }

    const expiresAt = Date.parse(parsedRaw.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      await rm(path, { force: true });
      return null;
    }

    const value = schema.safeParse(parsedRaw.value);
    if (!value.success) {
      log.warn(`Discarding cache entry ${key} that does not match the expected shape`);
      await rm(path, { force: true });
      return null;
    }

    return value.data;
  } catch (error: unknown) {
    const code = isObjectRecord(error) ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }

    log.warn(`Discarding unreadable cache entry ${key}`);
    await rm(path, { force: true }).catch(() => {
      // Ignore cleanup errors for broken cache files.
    });
    return null;
  }
}

export async function writeCache<T>(key: string, value: T): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const filePath = getCacheFilePath(key);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  const now = Date.now();
  const payload: CacheRecord<T> = {
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    value,
  };

  const serialized = JSON.stringify(payload);

  await writeFile(tmpPath, serialized, "utf8");
  await rename(tmpPath, filePath);
}

export function getCacheConfig(): { cacheDir: string; ttlHours: number } {
  return { cacheDir: CACHE_DIR, ttlHours: CACHE_TTL_HOURS };
}
