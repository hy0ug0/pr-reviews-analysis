import { describe, expect, test } from "bun:test";
import type { Actor } from "../../shared/types.ts";
import { isParticipant, toParticipantRules } from "./participants.ts";

function user(login: string): Actor {
  return { login, __typename: "User" };
}

const PR = { author: { login: "alice" } };
const NO_TEAM = toParticipantRules({});

describe("isParticipant", () => {
  test("counts a resolved user who is not the PR author", () => {
    expect(isParticipant(user("bob"), PR, NO_TEAM)).toBe(true);
  });

  test("rejects actors GitHub can't resolve", () => {
    expect(isParticipant(null, PR, NO_TEAM)).toBe(false);
  });

  test("rejects bots by __typename and by the [bot] login suffix", () => {
    expect(isParticipant({ login: "copilot", __typename: "Bot" }, PR, NO_TEAM)).toBe(false);
    expect(isParticipant(user("Renovate[BOT]"), PR, NO_TEAM)).toBe(false);
  });

  test("rejects the PR author whatever the casing", () => {
    expect(isParticipant(user("alice"), PR, NO_TEAM)).toBe(false);
    expect(isParticipant(user("ALICE"), PR, NO_TEAM)).toBe(false);
  });

  test("counts anyone but bots on a PR without an author", () => {
    expect(isParticipant(user("alice"), { author: null }, NO_TEAM)).toBe(true);
  });

  test("with a team filter, counts only team members, matching case-insensitively", () => {
    const rules = toParticipantRules({ teamMembers: ["BOB"] });

    expect(isParticipant(user("bob"), PR, rules)).toBe(true);
    expect(isParticipant(user("carol"), PR, rules)).toBe(false);
  });

  test("an empty team list means no team filter", () => {
    expect(isParticipant(user("carol"), PR, toParticipantRules({ teamMembers: [] }))).toBe(true);
  });
});
