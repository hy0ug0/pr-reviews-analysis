import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

function isCacheRecord<T>(value: unknown): value is CacheRecord<T> {
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

export function buildCacheKey(value: unknown): string {
  const serialized = JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

export async function readCache<T>(key: string): Promise<T | null> {
  const path = getCacheFilePath(key);

  try {
    const raw = await readFile(path, "utf8");
    const parsedRaw: unknown = JSON.parse(raw);
    if (!isCacheRecord<T>(parsedRaw)) {
      await rm(path, { force: true });
      return null;
    }

    const parsed = parsedRaw;

    const expiresAt = Date.parse(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      await rm(path, { force: true });
      return null;
    }

    return parsed.value;
  } catch (error: unknown) {
    const code = isObjectRecord(error) ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }

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
