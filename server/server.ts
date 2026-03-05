import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { execFileSync } from "node:child_process";
import { fetchPullRequests } from "./github.ts";
import { analyze } from "./analyzer.ts";
import { createLogger } from "./logger.ts";
import type { AnalyzeParams } from "../shared/types.ts";
import { analyzeQuerySchema } from "../shared/schemas.ts";
import { buildCacheKey, getCacheConfig, readCache, writeCache } from "./cache.ts";

const log = createLogger("server");

try {
  execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
} catch {
  log.error("GitHub CLI not authenticated. Run: gh auth login");
  process.exit(1);
}

const app = new Hono();

const DEFAULT_REPOS = process.env.DEFAULT_REPOS ?? "";
const DEFAULT_LABEL = process.env.DEFAULT_LABEL ?? "";
const DEFAULT_TEAM = process.env.DEFAULT_TEAM ?? "";

const { cacheDir, ttlHours } = getCacheConfig();

log.info(`Local cache enabled at ${cacheDir} (TTL: ${ttlHours}h)`);

app.get("/api/defaults", (c) => {
  return c.json({ repos: DEFAULT_REPOS, label: DEFAULT_LABEL, team: DEFAULT_TEAM });
});

app.get(
  "/api/analyze",
  zValidator("query", analyzeQuerySchema, (result, c) => {
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return c.json({ error: messages.join("; ") }, 400);
    }
  }),
  async (c) => {
    const query = c.req.valid("query");
    const repoParam = query.repo || DEFAULT_REPOS;
    const skipCache = query.skipCache;

    const repos = repoParam
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    const label = query.label || undefined;
    const since = query.since || undefined;
    const until = query.until || undefined;
    const team = query.team || undefined;
    const teamMembers = team
      ? team
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    const params: AnalyzeParams = { repos, label, since, until, teamMembers };
    const cacheKey = buildCacheKey(params);

    log.info(
      `Analyzing: ${repos.join(", ")}${label ? ` [label: ${label}]` : ""}${since ? ` from ${since}` : ""}${until ? ` to ${until}` : ""}${skipCache ? " [skip cache]" : ""}`,
    );

    try {
      if (!skipCache) {
        const cached = await readCache(cacheKey);
        if (cached) {
          log.info(`Cache hit for key ${cacheKey.slice(0, 10)}`);
          return c.json(cached);
        }
        log.info(`Cache miss for key ${cacheKey.slice(0, 10)}`);
      }

      const { prs, matchingPRs, analyzedPRs, isComplete, partialReasons } = await fetchPullRequests(
        repos,
        label,
        since,
        until,
      );
      log.info(`Fetched ${analyzedPRs} PRs (total matching: ${matchingPRs})`);

      const result = analyze(prs, params);
      result.matchingPRs = matchingPRs;
      result.analyzedPRs = analyzedPRs;
      result.isComplete = isComplete;
      result.partialReasons = partialReasons;

      await writeCache(cacheKey, result);

      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      log.error(`Analysis error: ${message}`);
      return c.json({ error: message }, 500);
    }
  },
);

const PORT = parseInt(process.env.PORT || "3000", 10);

log.info(`PR Reviews Analysis running at http://localhost:${PORT}`);

export default { port: PORT, fetch: app.fetch };
