import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveClient } from "./client.ts";

const root = join(tmpdir(), `pr-reviews-analysis-client-${randomUUID()}`);
await Bun.write(join(root, "index.html"), "<!doctype html><title>reviews</title>");
await Bun.write(join(root, "assets/app.js"), "console.log(1)");
afterAll(() => rm(root, { recursive: true, force: true }));

const app = new Hono();
app.get("/api/defaults", (c) => c.json({ ok: true }));
app.get("*", serveClient(root));

describe("serveClient", () => {
  test("sends index.html for the root and for a page path", async () => {
    for (const path of ["/", "/some/page"]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>reviews</title>");
    }
  });

  test("sends a file of the build", async () => {
    expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)");
  });

  test("leaves API routes alone, and answers 404 for an unknown one or a missing asset", async () => {
    expect(await (await app.request("/api/defaults")).json()).toEqual({ ok: true });
    expect((await app.request("/api/nope")).status).toBe(404);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
  });

  test.each([
    ["/%2e%2e/package.json", '"name"'],
    ["/..%2fpackage.json", '"name"'],
    ["/..%5cpackage.json", '"name"'],
    ["//etc/hosts", "127.0.0.1"],
  ])("never sends the file %s points at outside the build", async (path, content) => {
    expect(await (await app.request(path)).text()).not.toContain(content);
  });
});
