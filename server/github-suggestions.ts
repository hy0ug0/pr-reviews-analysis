import type { AppSuggestion } from "../shared/types.ts";
import { github } from "./github-client.ts";
import { parseRepo } from "./lib/parse-repo.ts";
import { createLogger } from "./logger.ts";

// Repository, label and user suggestions for the form's autocomplete.

const log = createLogger("fetch");

const REPOSITORY_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!) {
  search(query: $searchQuery, type: REPOSITORY, first: $first) {
    nodes {
      ... on Repository {
        nameWithOwner
        description
        isPrivate
      }
    }
  }
}`;

const VIEWER_REPOSITORIES_QUERY = `
query($first: Int!) {
  viewer {
    repositories(
      first: $first
      orderBy: { field: PUSHED_AT, direction: DESC }
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
    ) {
      nodes {
        nameWithOwner
        description
        isPrivate
      }
    }
  }
}`;

const LABELS_QUERY = `
query($owner: String!, $name: String!, $first: Int!, $labelQuery: String) {
  repository(owner: $owner, name: $name) {
    labels(first: $first, query: $labelQuery, orderBy: { field: NAME, direction: ASC }) {
      nodes {
        name
        color
        description
      }
    }
  }
}`;

const USER_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!) {
  search(query: $searchQuery, type: USER, first: $first) {
    nodes {
      ... on User {
        login
        name
      }
    }
  }
}`;

interface RepositorySuggestionNode {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
}

interface RepositorySearchResponse {
  search: {
    nodes: Array<RepositorySuggestionNode | null>;
  };
}

interface ViewerRepositoriesResponse {
  viewer: {
    repositories: {
      nodes: Array<RepositorySuggestionNode | null>;
    };
  };
}

interface LabelsResponse {
  repository: {
    labels: {
      nodes: Array<{
        name: string;
        color: string;
        description: string | null;
      } | null>;
    };
  } | null;
}

interface UserSearchResponse {
  search: {
    nodes: Array<{
      login: string;
      name: string | null;
    } | null>;
  };
}

function matchesSuggestionSeed(value: string, query: string): boolean {
  return query === "" || value.toLowerCase().includes(query.toLowerCase());
}

function addUniqueSuggestion(
  suggestions: AppSuggestion[],
  seen: Set<string>,
  suggestion: AppSuggestion,
) {
  const key = suggestion.value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  suggestions.push(suggestion);
}

function uniqueSuggestions(suggestions: AppSuggestion[], limit: number): AppSuggestion[] {
  const seen = new Set<string>();
  const unique: AppSuggestion[] = [];
  for (const suggestion of suggestions) {
    addUniqueSuggestion(unique, seen, suggestion);
    if (unique.length >= limit) break;
  }
  return unique;
}

function toRepositorySuggestion(node: RepositorySuggestionNode): AppSuggestion {
  return {
    value: node.nameWithOwner,
    detail: node.description ?? (node.isPrivate ? "Private repository" : "Repository"),
    isPrivate: node.isPrivate,
  };
}

export async function fetchRepositorySuggestions(
  query: string,
  defaultRepos: string[] = [],
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions = defaultRepos
    .filter((repo) => matchesSuggestionSeed(repo, trimmed))
    .map((repo) => ({ value: repo, detail: "Default repository" }));

  try {
    if (trimmed) {
      const data = await github.query<RepositorySearchResponse>(REPOSITORY_SEARCH_QUERY, {
        searchQuery: `${trimmed} in:name fork:true`,
        first: 12,
      });
      const githubSuggestions = data.search.nodes
        .filter((node): node is RepositorySuggestionNode => node !== null)
        .map(toRepositorySuggestion);

      return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
    }

    const data = await github.query<ViewerRepositoriesResponse>(VIEWER_REPOSITORIES_QUERY, {
      first: 12,
    });
    const githubSuggestions = data.viewer.repositories.nodes
      .filter((node): node is RepositorySuggestionNode => node !== null)
      .map(toRepositorySuggestion);

    return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown repository suggestion error";
    log.warn(`Repository suggestions failed: ${message}`);
    return uniqueSuggestions(seedSuggestions, 12);
  }
}

export async function fetchLabelSuggestions(
  repoList: readonly string[],
  query: string,
  defaultLabel?: string,
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions =
    defaultLabel && matchesSuggestionSeed(defaultLabel, trimmed)
      ? [{ value: defaultLabel, detail: "Default label" }]
      : [];
  const suggestions: AppSuggestion[] = [...seedSuggestions];
  const repos = repoList.slice(0, 5);

  for (const repo of repos) {
    let parsed: { owner: string; name: string };
    try {
      parsed = parseRepo(repo);
    } catch {
      continue;
    }

    try {
      const data = await github.query<LabelsResponse>(LABELS_QUERY, {
        owner: parsed.owner,
        name: parsed.name,
        first: 20,
        labelQuery: trimmed || undefined,
      });

      for (const label of data.repository?.labels.nodes ?? []) {
        if (!label) continue;
        suggestions.push({
          value: label.name,
          detail:
            repos.length > 1
              ? `${repo}${label.description ? ` - ${label.description}` : ""}`
              : (label.description ?? undefined),
          color: label.color,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown label suggestion error";
      log.warn(`Label suggestions failed for ${repo}: ${message}`);
    }
  }

  return uniqueSuggestions(suggestions, 20);
}

export async function fetchUserSuggestions(
  query: string,
  defaultUsers: string[] = [],
): Promise<AppSuggestion[]> {
  const trimmed = query.trim();
  const seedSuggestions = defaultUsers
    .filter((user) => matchesSuggestionSeed(user, trimmed))
    .map((user) => ({ value: user, detail: "Default team member" }));

  if (trimmed.length < 2) {
    return uniqueSuggestions(seedSuggestions, 12);
  }

  try {
    const data = await github.query<UserSearchResponse>(USER_SEARCH_QUERY, {
      searchQuery: `${trimmed} in:login in:name type:user`,
      first: 12,
    });
    const githubSuggestions = data.search.nodes
      .filter((node): node is { login: string; name: string | null } => node !== null)
      .map((node) => ({ value: node.login, detail: node.name ?? "GitHub user" }));

    return uniqueSuggestions([...seedSuggestions, ...githubSuggestions], 12);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown user suggestion error";
    log.warn(`User suggestions failed: ${message}`);
    return uniqueSuggestions(seedSuggestions, 12);
  }
}
