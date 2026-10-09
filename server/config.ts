import { resolve } from "node:path";
import { z } from "zod";
import { isRepoName, parseList } from "../shared/schemas.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("config");

export interface Config {
  port: number;
  defaultRepos: string[];
  defaultLabel: string;
  defaultTeam: string[];
  // Bots that use regular user accounts, which only a list can tell apart from people.
  botLogins: string[];
  cacheDir: string;
  cacheTtlHours: number;
  prCacheTtlDays: number;
  // 0 disables Bun's idle timeout for /api/analyze.
  analyzeIdleTimeoutSeconds: number;
}

type Env = Record<string, string | undefined>;

function blankAsUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

// Every setting has a usable default, so an invalid value logs a warning and falls back to
// it instead of stopping the server.
function integerSetting(
  name: string,
  { min, max, fallback }: { min: number; max?: number; fallback: number },
) {
  const range = max === undefined ? `of at least ${min}` : `from ${min} to ${max}`;
  return z
    .preprocess(
      blankAsUndefined,
      z.coerce
        .number()
        .int()
        .min(min)
        .max(max ?? Number.MAX_SAFE_INTEGER)
        .optional(),
    )
    .transform((value) => value ?? fallback)
    .catch(({ input }) => {
      log.warn(
        `Invalid ${name}="${String(input)}". Expected an integer ${range}; using ${fallback}.`,
      );
      return fallback;
    });
}

const textSetting = z
  .string()
  .optional()
  .transform((value) => value?.trim() ?? "");

const listSetting = z.string().optional().transform(parseList);

// A bad entry would only fail later, when the form submits it, so it is dropped here.
const repoListSetting = listSetting.transform((repos) =>
  repos.filter((repo) => {
    if (isRepoName(repo)) return true;
    log.warn(`Ignoring "${repo}" in DEFAULT_REPOS. Expected the owner/repo format.`);
    return false;
  }),
);

const envSchema = z
  .object({
    PORT: integerSetting("PORT", { min: 0, max: 65_535, fallback: 3000 }),
    DEFAULT_REPOS: repoListSetting,
    DEFAULT_LABEL: textSetting,
    DEFAULT_TEAM: listSetting,
    BOT_LOGINS: listSetting,
    CACHE_DIR: textSetting,
    CACHE_TTL_HOURS: integerSetting("CACHE_TTL_HOURS", { min: 1, fallback: 6 }),
    PR_CACHE_TTL_DAYS: integerSetting("PR_CACHE_TTL_DAYS", { min: 1, fallback: 30 }),
    // Bun accepts idle timeouts up to 255 seconds.
    ANALYZE_IDLE_TIMEOUT_SECONDS: integerSetting("ANALYZE_IDLE_TIMEOUT_SECONDS", {
      min: 0,
      max: 255,
      fallback: 0,
    }),
  })
  .transform((env): Config => ({
    port: env.PORT,
    defaultRepos: env.DEFAULT_REPOS,
    defaultLabel: env.DEFAULT_LABEL,
    defaultTeam: env.DEFAULT_TEAM,
    botLogins: env.BOT_LOGINS,
    cacheDir: env.CACHE_DIR || ".cache/pr-reviews-analysis",
    cacheTtlHours: env.CACHE_TTL_HOURS,
    prCacheTtlDays: env.PR_CACHE_TTL_DAYS,
    analyzeIdleTimeoutSeconds: env.ANALYZE_IDLE_TIMEOUT_SECONDS,
  }));

export function parseConfig(env: Env, cwd = process.cwd()): Config {
  const config = envSchema.parse(env);
  return { ...config, cacheDir: resolve(cwd, config.cacheDir) };
}

// Bun loads .env before any module runs, so process.env is complete here.
export const config = parseConfig(process.env);
