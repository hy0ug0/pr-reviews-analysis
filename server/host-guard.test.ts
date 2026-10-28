import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { hostGuard, hostnameOf } from "./host-guard.ts";

function appWith(host: string, proxyHostname: string | null = null) {
  const app = new Hono();
  app.use("*", hostGuard(host, proxyHostname));
  app.get("/api/defaults", (c) => c.json({ ok: true }));
  return app;
}

async function statusFor(app: Hono, host: string): Promise<number> {
  return (await app.request("/api/defaults", { headers: { host } })).status;
}

describe("hostnameOf", () => {
  test.each([
    ["localhost:3000", "localhost"],
    ["[::1]:3000", "[::1]"],
    ["PR-Reviews.localhost", "pr-reviews.localhost"],
  ])("reads %s as %s", (host, hostname) => {
    expect(hostnameOf(host)).toBe(hostname);
  });
});

describe("hostGuard", () => {
  test("answers the loopback names on any port", async () => {
    const app = appWith("127.0.0.1");
    for (const host of ["localhost:3000", "127.0.0.1:4038", "[::1]:3000"]) {
      expect(await statusFor(app, host)).toBe(200);
    }
  });

  test("refuses another site, whose domain may resolve to 127.0.0.1", async () => {
    expect(await statusFor(appWith("127.0.0.1"), "attacker.example:3000")).toBe(403);
  });

  test("answers the .localhost name of the proxy, and no other proxy name", async () => {
    const app = appWith("127.0.0.1", "pr-reviews.localhost");
    expect(await statusFor(app, "pr-reviews.localhost")).toBe(200);
    expect(await statusFor(app, "other.localhost")).toBe(403);
    expect(await statusFor(appWith("127.0.0.1", "reviews.example"), "reviews.example")).toBe(403);
  });

  test("with a wildcard HOST, answers this machine's IP addresses but still no other domain", async () => {
    const app = appWith("0.0.0.0");
    expect(await statusFor(app, "192.168.1.20:3000")).toBe(200);
    expect(await statusFor(app, "[fe80::1]:3000")).toBe(200);
    expect(await statusFor(app, "attacker.example:3000")).toBe(403);
  });
});
