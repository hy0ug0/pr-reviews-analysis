import { describe, expect, test } from "bun:test";
// A static import: if loading server.ts still read the gh token and exited on failure,
// this file could not run at all without a logged-in gh.
import { app } from "./server.ts";

async function getAnalyze(query: string): Promise<{ status: number; error: unknown }> {
  const response = await app.request(`/api/analyze?${query}`);
  const body: unknown = await response.json();
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  return { status: response.status, error };
}

describe("GET /api/analyze validation", () => {
  test("rejects a repo list with no repository", async () => {
    expect(await getAnalyze("repo=,")).toEqual({
      status: 400,
      error: "repo: At least one repository is required",
    });
  });

  test("rejects a missing repo", async () => {
    expect(await getAnalyze("since=2026-01-01")).toEqual({
      status: 400,
      error: "repo: At least one repository is required",
    });
  });

  test("rejects a repository that is not owner/repo", async () => {
    expect(await getAnalyze("repo=acme/widgets,widgets")).toEqual({
      status: 400,
      error: "repo: Each repository must match the owner/repo format",
    });
  });

  test("rejects a date that is not on the calendar", async () => {
    expect(await getAnalyze("repo=acme/widgets&since=2026-02-31")).toEqual({
      status: 400,
      error: "since: Invalid date 2026-02-31, expected YYYY-MM-DD",
    });
  });

  test("rejects a since later than until", async () => {
    expect(await getAnalyze("repo=acme/widgets&since=2026-03-01&until=2026-02-01")).toEqual({
      status: 400,
      error: "since: Must be on or before until",
    });
  });

  test("rejects a since in the future when until is missing", async () => {
    expect(await getAnalyze("repo=acme/widgets&since=2999-01-01")).toEqual({
      status: 400,
      error: "since: Must be on or before today",
    });
  });

  test("rejects an until before GitHub existed", async () => {
    expect(await getAnalyze("repo=acme/widgets&until=2007-12-31")).toEqual({
      status: 400,
      error: "until: Must be on or after 2008-01-01",
    });
  });

  test("reports every invalid field", async () => {
    expect(await getAnalyze("repo=widgets&until=2026-13-01")).toEqual({
      status: 400,
      error:
        "repo: Each repository must match the owner/repo format; until: Invalid date 2026-13-01, expected YYYY-MM-DD",
    });
  });
});

describe("GET /api/defaults", () => {
  test("returns the lists as comma-separated strings for the form", async () => {
    const response = await app.request("/api/defaults");
    const body: unknown = await response.json();
    expect(body).toEqual({
      repos: expect.any(String),
      label: expect.any(String),
      team: expect.any(String),
    });
  });
});
