import { execFile } from "node:child_process";

export const GH_NOT_FOUND_MESSAGE =
  "GitHub CLI (gh) not found. Install from https://cli.github.com";
export const GH_NOT_LOGGED_IN_MESSAGE = "GitHub CLI not logged in. Run: gh auth login";

// Runs a command and resolves with its stdout. Rejects with the spawn or exit error.
export type RunCommand = (file: string, args: string[]) => Promise<string>;

export interface TokenProvider {
  // The cached token, read from gh on first use.
  get(): Promise<string>;
  // Reads the token again, after GitHub rejected the cached one.
  refresh(): Promise<string>;
}

// A GitHub token is printable ASCII without spaces. Anything else is not a token, and a
// control character in it would make fetch fail with the header, token included, in the
// error message.
const TOKEN_SHAPE = /^[\x21-\x7E]+$/;

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// The token comes from the GitHub CLI's own login, so nothing here is configured. Errors
// never carry gh's output: it could include the token.
async function readToken(run: RunCommand): Promise<string> {
  let stdout: string;
  try {
    stdout = await run("gh", ["auth", "token", "--hostname", "github.com"]);
  } catch (error: unknown) {
    throw new Error(hasCode(error, "ENOENT") ? GH_NOT_FOUND_MESSAGE : GH_NOT_LOGGED_IN_MESSAGE);
  }
  const token = stdout.trim();
  if (!TOKEN_SHAPE.test(token)) throw new Error(GH_NOT_LOGGED_IN_MESSAGE);
  return token;
}

// Lazy, so importing a module that uses GitHub (tests, CI) spawns nothing. Callers that
// arrive while a read is in flight share it, refreshes included.
export function createTokenProvider(run: RunCommand = runCommand): TokenProvider {
  let token: string | null = null;
  let pending: Promise<string> | null = null;

  function read(): Promise<string> {
    pending ??= readToken(run)
      .then((value) => {
        token = value;
        return value;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    get: () => (token === null ? read() : Promise.resolve(token)),
    refresh: () => {
      token = null;
      return read();
    },
  };
}

export const githubToken = createTokenProvider();
