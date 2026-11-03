import { execFile } from "node:child_process";
import type { BoardConfig, BoardSource } from "./config.ts";

export type CheckState = "pending" | "passed" | "failed";

export interface Check {
  name: string;
  state: CheckState;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorIsBot: boolean;
  isDraft: boolean;
  /** GitHub's own word on the PR, read live: search can still list a PR as open for a while after it merged. */
  state: PullRequestState;
  reviewDecision: ReviewDecision;
  headSha: string;
  updatedAt: string;
  mergedAt: string | null;
  /** Checks on the head commit. */
  checks: Check[];
}

/** The pull requests one board shows, before they are sorted into lanes. */
export interface BoardData {
  mine: PullRequest[];
  reviewRequested: PullRequest[];
  merged: PullRequest[];
}

const BASE_FIELDS = `
  number title url isDraft state updatedAt mergedAt headRefOid
  repository { nameWithOwner }
  author { __typename login }`;

/**
 * Slow for GitHub to work out: asking for it alongside checks made the open-PR search about 0.6s
 * slower than asking for it in a second search run side by side. Merged PRs leave it out.
 */
const REVIEW_DECISION = "reviewDecision";

/** The head commit's checks: by far the heaviest part, so only lists that show CI ask for it. */
const CHECK_FIELDS = `
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state }
  } } } } } }`;

/** Pages stay small when they carry checks; a large page of them makes GitHub time out. */
function searchQuery(fields: string, pageSize: number): string {
  return `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: ${pageSize}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${fields} } }
    }
  }`;
}
/** Search pages read per list; a list longer than this is cut off. */
const MAX_SEARCH_PAGES = 10;

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${BASE_FIELDS} ${REVIEW_DECISION} } }
}`;

const FAILED_CONCLUSIONS: Record<string, true> = {
  FAILURE: true,
  TIMED_OUT: true,
  STARTUP_FAILURE: true,
  ACTION_REQUIRED: true,
  CANCELLED: true,
};

interface RawContext {
  __typename: "CheckRun" | "StatusContext";
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: PullRequestState;
  updatedAt: string;
  mergedAt: string | null;
  headRefOid: string;
  repository: { nameWithOwner: string };
  author: { __typename: string; login: string } | null;
  /** Absent when the query left it out. */
  reviewDecision?: ReviewDecision;
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}

function toCheck(context: RawContext): Check {
  if (context.__typename === "CheckRun") {
    if (context.status !== "COMPLETED") return { name: context.name ?? "", state: "pending" };
    return { name: context.name ?? "", state: FAILED_CONCLUSIONS[context.conclusion ?? ""] ? "failed" : "passed" };
  }
  const state = context.state === "SUCCESS" ? "passed" : context.state === "PENDING" || context.state === "EXPECTED" ? "pending" : "failed";
  return { name: context.context ?? "", state };
}

function toPullRequest(raw: RawPullRequest): PullRequest {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup;
  return {
    repo: raw.repository.nameWithOwner,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? "ghost",
    authorIsBot: raw.author?.__typename === "Bot" || (raw.author?.login.endsWith("[bot]") ?? false),
    isDraft: raw.isDraft,
    state: raw.state,
    reviewDecision: raw.reviewDecision ?? null,
    headSha: raw.headRefOid,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    checks: (rollup?.contexts.nodes ?? []).map(toCheck),
  };
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${command} ${args[0]} ${args[1] ?? ""} failed: ${stderr.trim() || error.message}`));
    else resolve(stdout);
  });
  return promise;
}

const tokens = new Map<string, Promise<string>>();

/** The environment `gh` runs with: the source's account token when it names one. */
async function ghEnv(source: BoardSource): Promise<NodeJS.ProcessEnv> {
  if (!source.ghUser) return process.env;
  let token = tokens.get(source.ghUser);
  if (!token) {
    token = run("gh", ["auth", "token", "--user", source.ghUser]).then((out) => out.trim());
    tokens.set(source.ghUser, token);
  }
  return { ...process.env, GH_TOKEN: await token };
}

async function graphql<T>(source: BoardSource, query: string, variables: Record<string, string | number>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const body = JSON.parse(await run("gh", args, await ghEnv(source))) as { data: T };
  return body.data;
}

async function searchNodes<T extends { url: string }>(source: BoardSource, filters: string, fields: string, pageSize: number): Promise<T[]> {
  const q = `is:pr archived:false ${filters}${source.org ? ` org:${source.org}` : ""}`;
  const found: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const data = await graphql<{
      search: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: (T | Record<string, never>)[] };
    }>(source, searchQuery(fields, pageSize), after ? { q, after } : { q });
    found.push(...data.search.nodes.filter((node): node is T => "url" in node));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return found;
}

async function search(source: BoardSource, filters: string, fields: string): Promise<PullRequest[]> {
  return (await searchNodes<RawPullRequest>(source, filters, fields, 100)).map(toPullRequest);
}

/** PRs with their CI, plus each one's review decision from a second search run alongside (see REVIEW_DECISION). */
async function searchWithChecks(source: BoardSource, filters: string): Promise<PullRequest[]> {
  const [prs, decisions] = await Promise.all([
    searchNodes<RawPullRequest>(source, filters, BASE_FIELDS + CHECK_FIELDS, 30),
    searchNodes<{ url: string; reviewDecision: ReviewDecision }>(source, filters, `url ${REVIEW_DECISION}`, 100),
  ]);
  const decisionByUrl = new Map(decisions.map((pr) => [pr.url, pr.reviewDecision]));
  return prs.map((raw) => toPullRequest({ ...raw, reviewDecision: decisionByUrl.get(raw.url) ?? null }));
}

function uniqueByUrl(prs: PullRequest[]): PullRequest[] {
  return [...new Map(prs.map((pr) => [pr.url, pr])).values()];
}

export interface FetchOptions {
  now?: Date;
  /** Also fetch open PRs waiting on your review (teammates' and bots'). The page doesn't show them; `--json` does. */
  reviewRequests?: boolean;
  /**
   * PRs ("owner/repo#number") to re-read directly when the open-PR search lists them, because search
   * lags behind GitHub: a PR can stay in `is:open` results for a while after it merged.
   */
  recheck?: Set<string>;
}

/**
 * Your open PRs, your recently merged PRs, and (unless `reviewRequests` is false) open PRs waiting
 * on your review, across every source. `mine` is what search calls open; a PR in it may already
 * have merged or closed, which its `state` tells.
 */
export async function fetchBoardData(config: BoardConfig, options: FetchOptions = {}): Promise<BoardData> {
  const { now = new Date(), reviewRequests = true, recheck = new Set<string>() } = options;
  const since = new Date(now.getTime() - config.mergedDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const reviewFilters = !reviewRequests
    ? []
    : config.reviewTeams.length
      ? ["user-review-requested:@me", ...config.reviewTeams.map((team) => `team-review-requested:${team}`)]
      : ["review-requested:@me"];
  const perSource = await Promise.all(
    config.sources.map(async (source) => {
      const [mine, merged, ...reviewRequested] = await Promise.all([
        searchWithChecks(source, "is:open author:@me").then((prs) => Promise.all(prs.map((pr) => reread(source, pr, recheck)))),
        search(source, `is:merged author:@me merged:>=${since}`, BASE_FIELDS),
        ...reviewFilters.map((filter) => search(source, `is:open -author:@me ${filter}`, `${BASE_FIELDS} ${REVIEW_DECISION}`)),
      ]);
      return { mine, reviewRequested: reviewRequested.flat(), merged };
    }),
  );
  return {
    mine: uniqueByUrl(perSource.flatMap((data) => data.mine)),
    reviewRequested: uniqueByUrl(perSource.flatMap((data) => data.reviewRequested)),
    merged: uniqueByUrl(perSource.flatMap((data) => data.merged)),
  };
}

/** A PR named in `recheck`, with its state as GitHub reads it right now; the search copy if that read fails. */
async function reread(source: BoardSource, pr: PullRequest, recheck: Set<string>): Promise<PullRequest> {
  if (!recheck.has(`${pr.repo}#${pr.number}`)) return pr;
  try {
    const fresh = await fetchPullRequest(source, pr.repo, pr.number);
    return { ...pr, state: fresh.state, mergedAt: fresh.mergedAt };
  } catch {
    return pr;
  }
}

/** Fetches one PR, for recording a review against its current head commit. */
export async function fetchPullRequest(source: BoardSource, repo: string, number: number): Promise<PullRequest> {
  const [owner, name] = repo.split("/");
  const data = await graphql<{ repository: { pullRequest: RawPullRequest | null } | null }>(source, PR_QUERY, { owner, name, number });
  const raw = data.repository?.pullRequest;
  if (!raw) throw new Error(`no pull request ${repo}#${number}`);
  return toPullRequest(raw);
}

/** Closes one PR on GitHub, leaving its branch alone. */
export async function closePullRequest(source: BoardSource, repo: string, number: number): Promise<void> {
  await run("gh", ["pr", "close", String(number), "--repo", repo], await ghEnv(source));
}
