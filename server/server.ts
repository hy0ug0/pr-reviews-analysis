import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import type { z } from "zod";
import {
  fetchLabelSuggestions,
  fetchRepositorySuggestions,
  fetchUserSuggestions,
} from "./github-suggestions.ts";
import { analyze } from "./analysis/analyzer.ts";
import { config } from "./config.ts";
import { githubToken } from "./github-token.ts";
import { createLogger } from "./logger.ts";
import type { AnalysisProgress, AnalysisResult, AnalyzeParams } from "../shared/types.ts";
import { describeCacheUsage } from "../shared/data-source.ts";
import { analyzeQuerySchema, parseList } from "../shared/schemas.ts";
import type { ProgressListener } from "./load-run.ts";
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

type AnalyzeQuery = z.output<typeof analyzeQuerySchema>;

// At most one progress event per interval; the latest snapshot wins, since each is whole.
const PROGRESS_INTERVAL_MS = 100;
// An SSE comment this often keeps a quiet stream (a slow GitHub call) from being dropped by
// a proxy along the way.
const PING_INTERVAL_MS = 15_000;

function wantsEventStream(req: Request): boolean {
  return req.headers.get("accept")?.includes("text/event-stream") ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

async function runAnalysis(
  query: AnalyzeQuery,
  progress: { onProgress?: ProgressListener; signal?: AbortSignal } = {},
): Promise<AnalysisResult> {
  const { repos, label, since, until, team, skipCache, includeBots } = query;
  const params: AnalyzeParams = { repos, label, since, until, teamMembers: team, includeBots };

  log.info(
    `Analyzing: ${repos.join(", ")}${label ? ` [label: ${label}]` : ""}${since ? ` from ${since}` : ""}${until ? ` to ${until}` : ""}${skipCache ? " [skip cache]" : ""}${includeBots ? " [include bots]" : ""}`,
  );

  const { fetchResult, dataSource } = await loadPullRequests(
    { repos, label, since, until },
    { skipCache, ...progress },
  );
  const { prs, matchingPRs, analyzedPRs, isComplete, partialReasons } = fetchResult;
  log.info(`Analyzing ${analyzedPRs} PRs (total matching: ${matchingPRs})`);
  progress.onProgress?.({ phase: "analyzing", prs: analyzedPRs });

  return {
    matchingPRs,
    analyzedPRs,
    isComplete,
    partialReasons,
    ...analyze(prs, { ...params, botLogins: config.botLogins }),
    dataSource,
  };
}

// Here rather than in loadPullRequests: requests that join one load each get a line.
function logCacheUsage(result: AnalysisResult) {
  if (result.dataSource) log.info(describeCacheUsage(result.dataSource, Date.now()));
}

// Sends `progress` events while the analysis runs, then one `result` or `error` event.
// Closing the stream stops this request's progress only: the load it may share with other
// requests keeps going and still fills the cache.
function streamAnalysis(c: Context, query: AnalyzeQuery) {
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    // Writes go out one at a time, in the order they were queued.
    let queue = Promise.resolve();
    const enqueue = (write: () => Promise<unknown>) => {
      queue = queue.then(write).then(
        () => {},
        () => {},
      );
      return queue;
    };
    const send = (event: string, data: unknown) =>
      enqueue(() => stream.writeSSE({ event, data: JSON.stringify(data) }));

    // Leading and trailing throttle: the first snapshot goes out at once, later ones at most
    // once per interval, and the last one in an interval is never lost.
    let pending: AnalysisProgress | null = null;
    let throttle: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      throttle = null;
      if (pending === null) return;
      void send("progress", pending);
      pending = null;
      throttle = setTimeout(flush, PROGRESS_INTERVAL_MS);
    };
    const onProgress: ProgressListener = (progress) => {
      pending = progress;
      if (throttle === null) flush();
    };

    const ping = setInterval(
      () => void enqueue(() => stream.write(": ping\n\n")),
      PING_INTERVAL_MS,
    );

    try {
      const result = await runAnalysis(query, { onProgress, signal: abort.signal });
      pending = null;
      await send("result", result);
      if (!abort.signal.aborted) logCacheUsage(result);
    } catch (error: unknown) {
      const message = errorMessage(error);
      log.error(`Analysis error: ${message}`);
      await send("error", { message });
    } finally {
      clearInterval(ping);
      if (throttle !== null) clearTimeout(throttle);
    }
  });
}

// Content negotiation: an EventSource-style client (Accept: text/event-stream) gets progress
// as server-sent events; anything else, such as curl, gets the result as plain JSON. Both
// share the validation, which answers a JSON 400 before any stream starts.
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
    if (wantsEventStream(c.req.raw)) return streamAnalysis(c, query);

    try {
      const result = await runAnalysis(query);
      logCacheUsage(result);
      return c.json(result);
    } catch (error: unknown) {
      const message = errorMessage(error);
      log.error(`Analysis error: ${message}`);
      return c.json({ error: message }, 500);
    }
  },
);

// Tests import this module for `app`; only a real start reads the gh token and logs the
// settings. Every request would fail without a token, so the server stops here instead.
if (import.meta.main) {
  try {
    await githubToken.get();
  } catch (error: unknown) {
    log.error(errorMessage(error));
    process.exit(1);
  }
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
      // Bun's per-request timeout does not restart when the response writes, so a stream
      // would be cut mid-run however often it sends: streams get none and rely on their pings.
      server.timeout(req, wantsEventStream(req) ? 0 : config.analyzeIdleTimeoutSeconds);
    }

    return app.fetch(req);
  },
};
