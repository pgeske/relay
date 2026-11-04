import { execFile } from "node:child_process";
import type { BoardConfig, BoardSource } from "./config.ts";

export type CheckState = "pending" | "passed" | "failed";

export interface Check {
  name: string;
  state: CheckState;
  /** The check's one-line status, e.g. a merge gate's "1 pending: 1 approval missing". */
  title?: string;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/**
 * GitHub's word on whether the PR can merge now. BLOCKED: a required review or check is
 * missing; DIRTY: merge conflicts; BEHIND: the base branch must be merged in first.
 */
export type MergeState = "CLEAN" | "HAS_HOOKS" | "UNSTABLE" | "BLOCKED" | "DIRTY" | "BEHIND" | "DRAFT" | "UNKNOWN";

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
  /** Null when the query left it out or GitHub hasn't worked it out yet. */
  mergeState: MergeState | null;
  /** Who approved the PR, by their latest review. */
  approvedBy: string[];
  /** The teams (by slug) those approvals were given on behalf of, like a team review request they answered. */
  approvedFor: string[];
  /** Reviewers (people, or teams by slug) still asked to review. */
  waitingOn: string[];
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
 * Slow for GitHub to work out: asking for these alongside checks made the open-PR search about 0.6s
 * slower than asking for them in a second search run side by side. Merged PRs leave them out.
 */
const REVIEW_FIELDS = `
  reviewDecision
  latestOpinionatedReviews(first: 30) { nodes { state author { login } onBehalfOf(first: 10) { nodes { slug } } } }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }`;

/**
 * Slower still (about 2s across every open PR), and only an approved PR's lane depends on it, so a
 * third search asks for it on approved PRs alone (about 1.2s).
 */
const MERGE_STATE = "mergeStateStatus";

/** The head commit's checks: by far the heaviest part, so only lists that show CI ask for it. */
const CHECK_FIELDS = `
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion title }
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

/**
 * One PR's state, head commit, and reviews: all that re-reading a lagging search result, recording a
 * result, or a step asking for approval needs.
 */
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${BASE_FIELDS} ${REVIEW_FIELDS} } }
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
  title?: string | null;
  context?: string;
  state?: string;
}

/** The fields REVIEW_FIELDS reads, all absent when the query left them out. */
interface RawReviewFields {
  reviewDecision?: ReviewDecision;
  mergeStateStatus?: MergeState;
  latestOpinionatedReviews?: { nodes: { state: string; author: { login: string } | null; onBehalfOf?: { nodes: { slug: string }[] } }[] };
  reviewRequests?: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] };
}

interface RawPullRequest extends RawReviewFields {
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
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}

function toCheck(context: RawContext): Check {
  if (context.__typename === "CheckRun") {
    const name = context.name ?? "";
    const title = context.title ?? undefined;
    if (context.status !== "COMPLETED") return { name, state: "pending", title };
    return { name, state: FAILED_CONCLUSIONS[context.conclusion ?? ""] ? "failed" : "passed", title };
  }
  const state = context.state === "SUCCESS" ? "passed" : context.state === "PENDING" || context.state === "EXPECTED" ? "pending" : "failed";
  return { name: context.context ?? "", state };
}

function toPullRequest(raw: RawPullRequest): PullRequest {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup;
  const approvals = (raw.latestOpinionatedReviews?.nodes ?? []).filter((review) => review.state === "APPROVED");
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
    mergeState: raw.mergeStateStatus ?? null,
    approvedBy: approvals.map((review) => review.author?.login ?? "ghost"),
    approvedFor: [...new Set(approvals.flatMap((review) => review.onBehalfOf?.nodes.map((team) => team.slug) ?? []))],
    waitingOn: (raw.reviewRequests?.nodes ?? []).flatMap(({ requestedReviewer: reviewer }) => {
      const name = reviewer?.login ?? reviewer?.slug;
      return name ? [name] : [];
    }),
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

/**
 * PRs with their CI, plus their reviews and (for approved ones) merge status from searches run
 * alongside: see REVIEW_FIELDS and MERGE_STATE.
 */
async function searchWithChecks(source: BoardSource, filters: string): Promise<PullRequest[]> {
  const [prs, reviews, mergeStates] = await Promise.all([
    searchNodes<RawPullRequest>(source, filters, BASE_FIELDS + CHECK_FIELDS, 30),
    searchNodes<RawReviewFields & { url: string }>(source, filters, `url ${REVIEW_FIELDS}`, 100),
    searchNodes<{ url: string; mergeStateStatus: MergeState }>(source, `${filters} review:approved`, `url ${MERGE_STATE}`, 100),
  ]);
  const reviewsByUrl = new Map(reviews.map((pr) => [pr.url, pr]));
  const mergeStateByUrl = new Map(mergeStates.map((pr) => [pr.url, pr.mergeStateStatus]));
  return prs.map((raw) => toPullRequest({ ...raw, ...reviewsByUrl.get(raw.url), mergeStateStatus: mergeStateByUrl.get(raw.url) }));
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
        ...reviewFilters.map((filter) => search(source, `is:open -author:@me ${filter}`, `${BASE_FIELDS} reviewDecision`)),
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

/** Fetches one PR without its checks: for recording a result against its current head commit, or a step that names its reviewers. */
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
