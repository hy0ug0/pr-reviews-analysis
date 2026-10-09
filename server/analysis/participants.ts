import type { Actor, AnalyzeParams, PullRequest } from "../../shared/types.ts";

// Lowercased logins; null means no team filter.
export type TeamFilter = ReadonlySet<string> | null;

// The request parameters that decide who counts.
export type ParticipantOptions = Pick<AnalyzeParams, "teamMembers">;

// Who counts, in the form isParticipant checks. Every metric builds it with
// toParticipantRules so they agree.
export interface ParticipantRules {
  team: TeamFilter;
}

export function toTeamFilter(teamMembers: readonly string[] | undefined): TeamFilter {
  // GitHub logins are case-insensitive; the API returns the canonical casing.
  return teamMembers?.length ? new Set(teamMembers.map((member) => member.toLowerCase())) : null;
}

export function toParticipantRules({ teamMembers }: ParticipantOptions): ParticipantRules {
  return { team: toTeamFilter(teamMembers) };
}

export function isBot(actor: Actor): boolean {
  return actor.__typename === "Bot" || actor.login.toLowerCase().endsWith("[bot]");
}

// Whether an actor's review or comment on `pr` counts. Actors GitHub can't resolve
// (deleted accounts) and bots don't, and neither does the PR author, whatever the
// casing. With a team filter, only team members count.
export function isParticipant(
  actor: Actor | null,
  pr: Pick<PullRequest, "author">,
  rules: ParticipantRules,
): actor is Actor {
  if (actor === null || isBot(actor)) return false;
  const login = actor.login.toLowerCase();
  if (login === pr.author?.login.toLowerCase()) return false;
  return rules.team === null || rules.team.has(login);
}
