import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { execFileSync } from "node:child_process";
import {
  fetchLabelSuggestions,
  fetchRepositorySuggestions,
  fetchUserSuggestions,
} from "./github.ts";
import { analyze } from "./analysis/analyzer.ts";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import type { AnalysisResult, AnalyzeParams } from "../shared/types.ts";
import { analyzeQuerySchema, parseList } from "../shared/schemas.ts";
import { loadPullRequests } from "./pull-requests.ts";

const log = createLogger("server");

export const app = new Hono();

interface BunServerWithTimeout {
  timeout(req: Request, seconds: number): void;
}

app.get("/api/defaults", (c) => {
  // The form fields are comma-separated strings, so the lists go back to that format.
  return c.json({
    repos: config.defaultRepos.join(","),
    label: config.defaultLabel,
    team: config.defaultTeam.join(","),
  });
});

app.get("/api/suggestions/repos", async (c) => {
  const query = c.req.query("q") ?? "";
  const suggestions = await fetchRepositorySuggestions(query, config.defaultRepos);
  return c.json({ suggestions });
});

app.get("/api/suggestions/labels", async (c) => {
  const query = c.req.query("q") ?? "";
  const repoParam = c.req.query("repo");
  const repos = repoParam === undefined ? config.defaultRepos : parseList(repoParam);
  const suggestions = await fetchLabelSuggestions(repos, query, config.defaultLabel);
  return c.json({ suggestions });
});

app.get("/api/suggestions/users", async (c) => {
  const query = c.req.query("q") ?? "";
  const suggestions = await fetchUserSuggestions(query, config.defaultTeam);
  return c.json({ suggestions });
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
    const { repos, label, since, until, team, skipCache } = c.req.valid("query");
    const params: AnalyzeParams = { repos, label, since, until, teamMembers: team };

    log.info(
      `Analyzing: ${repos.join(", ")}${label ? ` [label: ${label}]` : ""}${since ? ` from ${since}` : ""}${until ? ` to ${until}` : ""}${skipCache ? " [skip cache]" : ""}`,
    );

    try {
      const { fetchResult, dataSource } = await loadPullRequests(
        { repos, label, since, until },
        { skipCache },
      );
      const { prs, matchingPRs, analyzedPRs, isComplete, partialReasons } = fetchResult;
      log.info(
        `Analyzing ${analyzedPRs} PRs (total matching: ${matchingPRs}; listing from ${dataSource.listing}, ${dataSource.fetchedPRs} fetched, ${dataSource.reusedPRs} reused)`,
      );

      const result: AnalysisResult = {
        matchingPRs,
        analyzedPRs,
        isComplete,
        partialReasons,
        ...analyze(prs, params),
        dataSource,
      };

      return c.json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      log.error(`Analysis error: ${message}`);
      return c.json({ error: message }, 500);
    }
  },
);

function checkGhAuth(): void {
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "pipe" });
  } catch {
    log.error("GitHub CLI not authenticated. Run: gh auth login");
    process.exit(1);
  }
}

// Tests import this module for `app`; only a real start checks gh and logs the settings.
if (import.meta.main) {
  checkGhAuth();
  log.info(
    `Local cache enabled at ${config.cacheDir} (listing TTL: ${config.cacheTtlHours}h, PR TTL: ${config.prCacheTtlDays}d)`,
  );
  log.info(
    config.analyzeIdleTimeoutSeconds === 0
      ? "Analyze request idle timeout disabled"
      : `Analyze request idle timeout set to ${config.analyzeIdleTimeoutSeconds}s`,
  );
  log.info(`PR Reviews Analysis running at http://localhost:${config.port}`);
}

export default {
  port: config.port,
  fetch(req: Request, server?: BunServerWithTimeout) {
    if (server && new URL(req.url).pathname === "/api/analyze") {
      server.timeout(req, config.analyzeIdleTimeoutSeconds);
    }

    return app.fetch(req);
  },
};
