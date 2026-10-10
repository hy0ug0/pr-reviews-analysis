import type { PullRequest, RepoMetrics } from "../../shared/types.ts";
import { analyze, type AnalyzeOptions } from "./analyzer.ts";

// Runs analyze() on each repo's PRs alone, so every metric it computes has a per-repo
// value without code of its own here. Every repo in options.repos gets an entry, in that
// order, those without a PR included. Repos are expected normalized (see normalizeRepos),
// like each PR's repo, which comes from the listing. A PR of a repo outside the list still
// gets an entry, after the others, so the entries always add up to the whole.
export function analyzeByRepo(prs: PullRequest[], options: AnalyzeOptions): RepoMetrics[] {
  const prsByRepo = new Map<string, PullRequest[]>(options.repos.map((repo) => [repo, []]));
  for (const pr of prs) {
    const group = prsByRepo.get(pr.repo);
    if (group) group.push(pr);
    else prsByRepo.set(pr.repo, [pr]);
  }
  return Array.from(prsByRepo, ([repo, repoPRs]) => ({
    repo,
    metrics: analyze(repoPRs, { ...options, repos: [repo] }),
  }));
}
