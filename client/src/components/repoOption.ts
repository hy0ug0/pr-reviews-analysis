// The id of a repo's radio in the switcher, so the comparison table can move focus to it.
// Null stands for all repositories.
export function repoOptionId(repo: string | null): string {
  return repo === null ? "repo-option-all" : `repo-option-${repo}`;
}
