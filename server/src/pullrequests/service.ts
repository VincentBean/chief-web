import type { Config } from '../config.js';
import { type Database, listRepositories, type Repository } from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import {
  fetchPullRequestFeedback,
  listOpenPullRequestsAcross,
  type PullRequestFeedback,
  type RepositoryPullRequests,
} from '../lib/github-review.js';
import { getGithubToken } from '../settings/index.js';

/**
 * Open pull requests across every configured repository (US-021).
 *
 * The list is remote, slow and rate limited — one request per repository
 * against a 5000/hour budget — which is why nothing here is polled and why the
 * answer is cached. It is also why a failure is reported *per repository*
 * rather than for the page: a slug the token lost access to should cost that
 * repository's row, not everybody else's.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class PullRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PullRequestError';
  }
}

export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRef: string;
  readonly baseRef: string;
  readonly draft: boolean;
  /** The head is on another repository, so this cannot be pushed to (US-021). */
  readonly fromFork: boolean;
  readonly authorLogin: string | null;
  readonly updatedAt: string;
  /** The session that opened it, when chief-web did; null otherwise. */
  readonly sessionId: string | null;
}

export interface RepositoryPullRequestsView {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly slug: string;
  readonly pullRequests: readonly PullRequestView[];
  /** A `GithubErrorCode` when this repository alone failed; null otherwise. */
  readonly error: string | null;
  readonly message: string | null;
  readonly truncated: boolean;
}

export interface PullRequestListView {
  readonly repositories: readonly RepositoryPullRequestsView[];
  /** When GitHub was actually asked; a cached answer keeps its original time. */
  readonly fetchedAt: string;
}

/** The slice of the GitHub API this service needs; tests pass a stub. */
export interface PullRequestGateway {
  list(token: string, slugs: readonly string[]): Promise<RepositoryPullRequests[]>;
  feedback(token: string, slug: string, number: number): Promise<PullRequestFeedback>;
}

export class GithubPullRequestGateway implements PullRequestGateway {
  constructor(private readonly config: Pick<Config, 'githubApiUrl' | 'githubGraphqlUrl'>) {}

  list(token: string, slugs: readonly string[]): Promise<RepositoryPullRequests[]> {
    return listOpenPullRequestsAcross(token, this.config.githubApiUrl, slugs);
  }

  feedback(token: string, slug: string, number: number): Promise<PullRequestFeedback> {
    return fetchPullRequestFeedback(token, this.config.githubGraphqlUrl, slug, number);
  }
}

export class PullRequestService {
  private cached: { at: number; value: PullRequestListView } | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly github: PullRequestGateway,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Every open pull request, grouped by repository.
   *
   * `refresh` bypasses the cache, which is what the page's Refresh button
   * sends; without it a reload inside the window costs GitHub nothing.
   */
  async list(options: { refresh?: boolean } = {}): Promise<PullRequestListView> {
    const cached = this.cached;
    if (
      options.refresh !== true &&
      cached !== null &&
      this.now() - cached.at < this.config.pullRequestCacheMs
    ) {
      return cached.value;
    }

    const token = this.requireToken();
    const repositories = listRepositories(this.db);
    // A row's slug is editable, so it is re-checked before every call — the
    // same guard the delivery step makes for the same reason.
    const usable = repositories.filter((repository) => isValidGithubSlug(repository.githubSlug));

    const answers = await this.github.list(
      token,
      usable.map((repository) => repository.githubSlug),
    );
    const bySlug = new Map(answers.map((answer) => [answer.slug, answer]));
    const sessions = this.sessionsByPrUrl();

    const value: PullRequestListView = {
      repositories: repositories.map((repository) =>
        this.viewFor(repository, bySlug.get(repository.githubSlug), sessions),
      ),
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.cached = { at: this.now(), value };
    return value;
  }

  /** One pull request's unresolved feedback: what a run would be sent. */
  async feedback(repositoryId: string, number: number): Promise<PullRequestFeedback> {
    const token = this.requireToken();
    const repository = listRepositories(this.db).find((entry) => entry.id === repositoryId);
    if (repository === undefined) {
      throw new PullRequestError(404, 'repository_not_found', 'No such repository.');
    }
    if (!isValidGithubSlug(repository.githubSlug)) {
      throw new PullRequestError(
        400,
        'invalid_github_slug',
        `"${repository.githubSlug}" is not a GitHub owner/repo slug.`,
      );
    }
    return this.github.feedback(token, repository.githubSlug, number);
  }

  private viewFor(
    repository: Repository,
    answer: RepositoryPullRequests | undefined,
    sessions: ReadonlyMap<string, string>,
  ): RepositoryPullRequestsView {
    const base = {
      repositoryId: repository.id,
      repositoryName: repository.name,
      slug: repository.githubSlug,
    };

    if (!isValidGithubSlug(repository.githubSlug)) {
      return {
        ...base,
        pullRequests: [],
        error: 'invalid_github_slug',
        message: `"${repository.githubSlug}" is not a GitHub owner/repo slug, so its pull requests cannot be read.`,
        truncated: false,
      };
    }
    if (answer === undefined) {
      return { ...base, pullRequests: [], error: 'github_error', message: 'No answer.', truncated: false };
    }

    return {
      ...base,
      pullRequests: answer.pullRequests.map((pull) => ({
        number: pull.number,
        title: pull.title,
        url: pull.url,
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        draft: pull.draft,
        fromFork: pull.fromFork,
        authorLogin: pull.authorLogin,
        updatedAt: pull.updatedAt,
        sessionId: sessions.get(pull.url) ?? null,
      })),
      error: answer.error,
      message: answer.message,
      truncated: answer.truncated,
    };
  }

  /**
   * Pull request URL to the session that opened it.
   *
   * The session row stores only `pr_url`, so this is the only join available —
   * and it is enough to badge a row as chief-web's own and link back to it.
   */
  private sessionsByPrUrl(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT id, pr_url FROM sessions WHERE pr_url IS NOT NULL')
      .all() as { id: string; pr_url: string }[];
    return new Map(rows.map((row) => [row.pr_url, row.id]));
  }

  private requireToken(): string {
    const token = getGithubToken(this.db);
    if (token === null) {
      throw new PullRequestError(
        400,
        'github_token_missing',
        'No GitHub token is configured, so pull requests cannot be read. Add one on the settings page.',
      );
    }
    return token;
  }
}

export function createPullRequestService(
  config: Config,
  db: Database,
  github: PullRequestGateway = new GithubPullRequestGateway(config),
): PullRequestService {
  return new PullRequestService(config, db, github);
}

