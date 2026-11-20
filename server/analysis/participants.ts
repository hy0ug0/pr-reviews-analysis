import type { Actor, AnalyzeParams, PullRequest } from "../../shared/types.ts";

// Lowercased logins; null means no team filter.
export type TeamFilter = ReadonlySet<string> | null;

// The request parameters and settings that decide who counts.
export interface ParticipantOptions extends Pick<AnalyzeParams, "teamMembers" | "includeBots"> {
  // Bots that use regular user accounts, from BOT_LOGINS.
  botLogins?: readonly string[];
  // Coding agents that open PRs for the person who runs them, from AGENT_LOGINS.
  agentLogins?: readonly string[];
}

// Who counts, in the form isParticipant checks. Every metric builds it with
// toParticipantRules so they agree.
export interface ParticipantRules {
  team: TeamFilter;
  includeBots: boolean;
  // Lowercased.
  botLogins: ReadonlySet<string>;
  // Lowercased.
  agentLogins: ReadonlySet<string>;
}

export function toTeamFilter(teamMembers: readonly string[] | undefined): TeamFilter {
  // GitHub logins are case-insensitive; the API returns the canonical casing.
  return teamMembers?.length ? new Set(teamMembers.map((member) => member.toLowerCase())) : null;
}

export function toParticipantRules({
  teamMembers,
  includeBots = false,
  botLogins = [],
  agentLogins = [],
}: ParticipantOptions): ParticipantRules {
  return {
    team: toTeamFilter(teamMembers),
    includeBots,
    botLogins: new Set(botLogins.map((login) => login.toLowerCase())),
    agentLogins: new Set(agentLogins.map((login) => login.toLowerCase())),
  };
}

// GitHub Apps have the Bot type. Some bots run on user accounts named with a [bot] suffix;
// the others can only be listed by hand in BOT_LOGINS. Agents in AGENT_LOGINS are bots too.
export function isBot(
  actor: Actor,
  { botLogins, agentLogins }: Pick<ParticipantRules, "botLogins" | "agentLogins">,
): boolean {
  const login = actor.login.toLowerCase();
  return (
    actor.__typename === "Bot" ||
    login.endsWith("[bot]") ||
    botLogins.has(login) ||
    agentLogins.has(login)
  );
}

export type ParticipantPR = Pick<PullRequest, "author" | "assignees">;

// The people an agent opened `pr` for, lowercased: when an agent in AGENT_LOGINS is the
// author, its assignees who aren't bots. Empty for any other PR. The agent's PR is their
// work, so they count as its authors.
export function agentPROwners(pr: ParticipantPR, rules: ParticipantRules): string[] {
  if (pr.author === null || !rules.agentLogins.has(pr.author.login.toLowerCase())) return [];
  return pr.assignees
    .map((login) => login.toLowerCase())
    .filter((login) => !isBot({ login, __typename: "User" }, rules));
}

// Whether `pr` is left out of every metric: a bot opened it and bots are excluded. An agent's
// PR with a human assignee stays: someone owns it, and others review it.
export function isExcludedBotPR(pr: ParticipantPR, rules: ParticipantRules): boolean {
  return (
    !rules.includeBots &&
    pr.author !== null &&
    isBot(pr.author, rules) &&
    agentPROwners(pr, rules).length === 0
  );
}

// Whether an actor's review or comment on `pr` counts. Actors GitHub can't resolve
// (deleted accounts) don't, bots don't unless included, and neither does the PR author,
// whatever the casing, nor the people an agent opened the PR for (see agentPROwners). With a
// team filter, only team members count.
export function isParticipant(
  actor: Actor | null,
  pr: ParticipantPR,
  rules: ParticipantRules,
): actor is Actor {
  if (actor === null) return false;
  if (!rules.includeBots && isBot(actor, rules)) return false;
  const login = actor.login.toLowerCase();
  if (login === pr.author?.login.toLowerCase()) return false;
  if (agentPROwners(pr, rules).includes(login)) return false;
  return rules.team === null || rules.team.has(login);
}
