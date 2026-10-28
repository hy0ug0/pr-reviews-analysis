import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";
import { serveStatic } from "hono/serve-static";

function fileOptions(root: string) {
  const base = resolve(root) + sep;
  return {
    root,
    join,
    // serveStatic already refuses `..`; this keeps the build folder a hard limit if it misses one.
    getContent: async (path: string) => {
      if (!resolve(path).startsWith(base)) return null;
      const file = Bun.file(path);
      return (await file.exists()) ? file : null;
    },
    isDir: async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
  };
}

// The Vite build (dist/client), so `bun run start` needs no second server. A file of the
// build is sent as is; any other page path gets index.html. /api and missing assets fall
// through to the 404.
export function serveClient(root: string): MiddlewareHandler {
  const files = serveStatic(fileOptions(root));
  const index = serveStatic({ ...fileOptions(root), path: "index.html" });
  return async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    const file = await files(c, async () => undefined);
    if (file !== undefined) return file;
    if (/\.[^/]*$/.test(c.req.path)) return next();
    return index(c, next);
  };
}
