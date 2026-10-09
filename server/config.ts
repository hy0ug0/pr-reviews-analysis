import { resolve } from "node:path";
import { z } from "zod";
import { parseList } from "../shared/schemas.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("config");

export interface Config {
  port: number;
  defaultRepos: string[];
  defaultLabel: string;
  defaultTeam: string[];
  cacheDir: string;
  cacheTtlHours: number;
  prCacheTtlDays: number;
  // 0 disables Bun's idle timeout for /api/analyze.
  analyzeIdleTimeoutSeconds: number;
}

type Env = Record<string, string | undefined>;

// An invalid value logs a warning and falls back to the default instead of stopping the
// server, since every setting has a usable default.
function readInteger(
  env: Env,
  name: string,
  { min, max = Number.MAX_SAFE_INTEGER, fallback }: { min: number; max?: number; fallback: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const parsed = z.coerce.number().int().min(min).max(max).safeParse(raw);
  if (!parsed.success) {
    const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
    log.warn(`Invalid ${name}="${raw}". Expected an integer ${range}; using ${fallback}.`);
    return fallback;
  }

  return parsed.data;
}

export function parseConfig(env: Env, cwd = process.cwd()): Config {
  const cacheDir = env.CACHE_DIR?.trim() || ".cache/pr-reviews-analysis";

  return {
    port: readInteger(env, "PORT", { min: 0, max: 65_535, fallback: 3000 }),
    defaultRepos: parseList(env.DEFAULT_REPOS),
    defaultLabel: env.DEFAULT_LABEL?.trim() ?? "",
    defaultTeam: parseList(env.DEFAULT_TEAM),
    cacheDir: resolve(cwd, cacheDir),
    cacheTtlHours: readInteger(env, "CACHE_TTL_HOURS", { min: 1, fallback: 6 }),
    prCacheTtlDays: readInteger(env, "PR_CACHE_TTL_DAYS", { min: 1, fallback: 30 }),
    // Bun accepts idle timeouts up to 255 seconds.
    analyzeIdleTimeoutSeconds: readInteger(env, "ANALYZE_IDLE_TIMEOUT_SECONDS", {
      min: 0,
      max: 255,
      fallback: 0,
    }),
  };
}

// Bun loads .env before any module runs, so process.env is complete here.
export const config = parseConfig(process.env);
