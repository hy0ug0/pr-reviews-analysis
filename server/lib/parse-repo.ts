// Splits "owner/repo" into the owner and name that repository(owner:, name:) queries take.
export function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repository format "${repo}". Expected "owner/repo".`);
  }
  return { owner, name };
}
