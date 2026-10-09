import type { Actor, AnalyzeParams, PullRequest } from "../../shared/types.ts";

// Lowercased logins; null means no team filter.
export type TeamFilter = ReadonlySet<string> | null;

// The request parameters and settings that decide who counts.
export interface ParticipantOptions extends Pick<AnalyzeParams, "teamMembers" | "includeBots"> {
  // Bots that use regular user accounts, from BOT_LOGINS.
  botLogins?: readonly string[];
}

// Who counts, in the form isParticipant checks. Every metric builds it with
// toParticipantRules so they agree.
export interface ParticipantRules {
  team: TeamFilter;
  includeBots: boolean;
  // Lowercased.
  botLogins: ReadonlySet<string>;
}

export function toTeamFilter(teamMembers: readonly string[] | undefined): TeamFilter {
  // GitHub logins are case-insensitive; the API returns the canonical casing.
  return teamMembers?.length ? new Set(teamMembers.map((member) => member.toLowerCase())) : null;
}

export function toParticipantRules({
  teamMembers,
  includeBots = false,
  botLogins = [],
}: ParticipantOptions): ParticipantRules {
  return {
    team: toTeamFilter(teamMembers),
    includeBots,
    botLogins: new Set(botLogins.map((login) => login.toLowerCase())),
  };
}

// GitHub Apps have the Bot type. Some bots run on user accounts named with a [bot] suffix;
// the others can only be listed by hand in BOT_LOGINS.
export function isBot(actor: Actor, { botLogins }: Pick<ParticipantRules, "botLogins">): boolean {
  const login = actor.login.toLowerCase();
  return actor.__typename === "Bot" || login.endsWith("[bot]") || botLogins.has(login);
}

// Whether `pr` is left out of every metric: a bot opened it and bots are excluded.
export function isExcludedBotPR(pr: Pick<PullRequest, "author">, rules: ParticipantRules): boolean {
  return !rules.includeBots && pr.author !== null && isBot(pr.author, rules);
}

// Whether an actor's review or comment on `pr` counts. Actors GitHub can't resolve
// (deleted accounts) don't, bots don't unless included, and neither does the PR author,
// whatever the casing. With a team filter, only team members count.
export function isParticipant(
  actor: Actor | null,
  pr: Pick<PullRequest, "author">,
  rules: ParticipantRules,
): actor is Actor {
  if (actor === null) return false;
  if (!rules.includeBots && isBot(actor, rules)) return false;
  const login = actor.login.toLowerCase();
  if (login === pr.author?.login.toLowerCase()) return false;
  return rules.team === null || rules.team.has(login);
}
