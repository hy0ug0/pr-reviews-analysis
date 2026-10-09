import { describe, expect, test } from "bun:test";
import type { Actor } from "../../shared/types.ts";
import { isBot, isExcludedBotPR, isParticipant, toParticipantRules } from "./participants.ts";

function user(login: string): Actor {
  return { login, __typename: "User" };
}

const APP: Actor = { login: "copilot", __typename: "Bot" };
const PR = { author: user("alice") };
const NO_TEAM = toParticipantRules({});
const WITH_BOTS = toParticipantRules({ includeBots: true });

describe("isBot", () => {
  test("recognizes GitHub Apps, the [bot] suffix in any casing, and the configured logins", () => {
    const rules = toParticipantRules({ botLogins: ["CI-User"] });

    expect(isBot(APP, rules)).toBe(true);
    expect(isBot(user("Renovate[BOT]"), rules)).toBe(true);
    expect(isBot(user("ci-user"), rules)).toBe(true);
    expect(isBot(user("bob"), rules)).toBe(false);
  });

  test("a login on the list is a bot whatever casing GitHub returns", () => {
    expect(isBot(user("RELEASE-BOT"), toParticipantRules({ botLogins: ["release-bot"] }))).toBe(
      true,
    );
  });
});

describe("isParticipant", () => {
  test("counts a resolved user who is not the PR author", () => {
    expect(isParticipant(user("bob"), PR, NO_TEAM)).toBe(true);
  });

  test("rejects actors GitHub can't resolve", () => {
    expect(isParticipant(null, PR, NO_TEAM)).toBe(false);
    expect(isParticipant(null, PR, WITH_BOTS)).toBe(false);
  });

  test("rejects bots by default", () => {
    expect(isParticipant(APP, PR, NO_TEAM)).toBe(false);
    expect(isParticipant(user("Renovate[BOT]"), PR, NO_TEAM)).toBe(false);
  });

  test("rejects users on the configured bot list, case-insensitively", () => {
    const rules = toParticipantRules({ botLogins: ["CI-User"] });

    expect(isParticipant(user("ci-user"), PR, rules)).toBe(false);
    expect(isParticipant(user("bob"), PR, rules)).toBe(true);
  });

  test("with bots included, counts bots like anyone else", () => {
    const rules = toParticipantRules({ includeBots: true, botLogins: ["ci-user"] });

    expect(isParticipant(APP, PR, rules)).toBe(true);
    expect(isParticipant(user("renovate[bot]"), PR, rules)).toBe(true);
    expect(isParticipant(user("ci-user"), PR, rules)).toBe(true);
  });

  test("with bots included, still rejects a bot reviewing its own PR", () => {
    const botPR = { author: user("renovate[bot]") };

    expect(isParticipant(user("renovate[bot]"), botPR, WITH_BOTS)).toBe(false);
  });

  test("with bots included, the team filter still applies to them", () => {
    const rules = toParticipantRules({ includeBots: true, teamMembers: ["bob"] });

    expect(isParticipant(APP, PR, rules)).toBe(false);
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

describe("isExcludedBotPR", () => {
  const rules = toParticipantRules({ botLogins: ["ci-user"] });

  test("excludes PRs opened by any kind of bot", () => {
    expect(isExcludedBotPR({ author: APP }, rules)).toBe(true);
    expect(isExcludedBotPR({ author: user("dependabot[bot]") }, rules)).toBe(true);
    expect(isExcludedBotPR({ author: user("CI-USER") }, rules)).toBe(true);
  });

  test("keeps PRs opened by people or by deleted accounts", () => {
    expect(isExcludedBotPR(PR, rules)).toBe(false);
    expect(isExcludedBotPR({ author: null }, rules)).toBe(false);
  });

  test("keeps bot PRs when bots are included", () => {
    expect(isExcludedBotPR({ author: APP }, WITH_BOTS)).toBe(false);
  });
});
