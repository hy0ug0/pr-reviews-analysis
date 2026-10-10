import { describe, expect, test } from "bun:test";
import { createTokenProvider, type RunCommand } from "./github-token.ts";

// A fake gh: `outcomes` are consumed in order, the last one repeating.
function fakeGh(...outcomes: Array<{ stdout: string } | { error: unknown }>) {
  const calls: string[][] = [];
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args]);
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    return "stdout" in outcome ? Promise.resolve(outcome.stdout) : Promise.reject(outcome.error);
  };
  return { run, calls };
}

function exitError(code: string | number, message: string): Error & { code: string | number } {
  return Object.assign(new Error(message), { code });
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the read to fail");
}

describe("reading the token", () => {
  test("asks gh for the github.com token once and trims it", async () => {
    const { run, calls } = fakeGh({ stdout: "gho_abc\n" });
    const tokens = createTokenProvider(run);

    expect(await tokens.get()).toBe("gho_abc");
    expect(await tokens.get()).toBe("gho_abc");
    expect(calls).toEqual([["gh", "auth", "token", "--hostname", "github.com"]]);
  });

  test("concurrent first callers share one read", async () => {
    const { run, calls } = fakeGh({ stdout: "gho_abc" });
    const tokens = createTokenProvider(run);

    expect(await Promise.all([tokens.get(), tokens.get(), tokens.get()])).toEqual([
      "gho_abc",
      "gho_abc",
      "gho_abc",
    ]);
    expect(calls).toHaveLength(1);
  });

  test("refresh reads again and later callers get the new token", async () => {
    const { run, calls } = fakeGh({ stdout: "gho_old" }, { stdout: "gho_new" });
    const tokens = createTokenProvider(run);

    expect(await tokens.get()).toBe("gho_old");
    expect(await Promise.all([tokens.refresh(), tokens.refresh()])).toEqual(["gho_new", "gho_new"]);
    expect(await tokens.get()).toBe("gho_new");
    expect(calls).toHaveLength(2);
  });

  test("a failed read is tried again on the next call", async () => {
    const { run, calls } = fakeGh({ error: exitError(1, "boom") }, { stdout: "gho_abc" });
    const tokens = createTokenProvider(run);

    await rejection(tokens.get());
    expect(await tokens.get()).toBe("gho_abc");
    expect(calls).toHaveLength(2);
  });
});

describe("error mapping", () => {
  test("a missing gh binary tells how to install it", async () => {
    const { run } = fakeGh({ error: exitError("ENOENT", "spawn gh ENOENT") });

    expect(await rejection(createTokenProvider(run).get())).toBe(
      "GitHub CLI (gh) not found. Install from https://cli.github.com",
    );
  });

  test("a non-zero exit tells how to log in, without gh's output", async () => {
    const { run } = fakeGh({
      error: exitError(1, "Command failed: gh auth token\nno oauth token found for github.com"),
    });

    expect(await rejection(createTokenProvider(run).get())).toBe(
      "GitHub CLI not logged in. Run: gh auth login",
    );
  });

  test("an empty token tells how to log in", async () => {
    const { run } = fakeGh({ stdout: "\n" });

    expect(await rejection(createTokenProvider(run).get())).toBe(
      "GitHub CLI not logged in. Run: gh auth login",
    );
  });
});
