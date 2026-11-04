import type { BoardData, Check, PullRequest } from "./github.ts";
import { AGENT_ACTIONS, type AgentAction, type AgentRequests, type AgentReview, type ApprovalAsk, type CiFix } from "./store.ts";

/** Where a PR sits on its way from draft to merged, in the order work moves through them. */
export type Lane = "draft" | "agent-review" | "human-review" | "approved-blocked" | "ready";

export type CiState = "passed" | "failed" | "running" | "none";

export type AgentReviewState =
  | { status: "not-run" }
  /** `stale`: commits landed after the review, so it no longer covers the code. */
  | { status: "passed" | "findings"; findings: number; stale: boolean; reviewedAt: string; headSha: string; summary: string | null };

export type CiFixState =
  | { status: "not-run" }
  /** `stale`: commits landed after the result was recorded, so it is about older code. */
  | { status: "fixed" | "not-fixed"; stale: boolean; recordedAt: string; headSha: string; summary: string | null };

export type ApprovalState =
  | { status: "not-asked" }
  /** `bumped` once a bump was drafted in the ask's thread; `slackUrl` is where the ask is in Slack. */
  | { status: "asked" | "bumped"; askedAt: string; bumpedAt: string | null; slackUrl: string };

export type RequestProgress = "none" | "running" | "stalled";

export interface BoardCard {
  pr: PullRequest;
  ci: CiState;
  /**
   * What keeps the PR from merging besides CI, in a few words ("1 approval missing", "Merge
   * conflicts"); null when nothing does. See `mergeBlocker`.
   */
  mergeBlocker: string | null;
  agentReview: AgentReviewState;
  /** The latest result an agent recorded after the board asked it to fix CI. */
  ciFix: CiFixState;
  /** The Slack message the PR's session drafted asking for approval, and its latest bump. */
  approval: ApprovalState;
  /** Where each request the board sent the PR's session stands. */
  requests: Record<AgentAction, RequestProgress>;
}

export interface Board {
  lanes: Record<Lane, BoardCard[]>;
  merged: PullRequest[];
  /** Other people's PRs waiting on your review. */
  teammates: PullRequest[];
  /** Bot PRs waiting on your review, counted per bot. */
  bots: { name: string; count: number }[];
  /** The omp session in charge of each of your PRs that has one, keyed by "owner/repo#number". */
  owners: Record<string, CardOwner>;
}

export interface CardOwner {
  sessionFile: string;
  title: string;
  how: "opened" | "claimed";
  /** Where the session runs in relay right now; null when no relay tab has it open. */
  live: { paneId: string; windowId: string; status: "working" | "idle" } | null;
}

/** A just-sent request counts as running even before the session's spinner shows (it may still be reopening). */
const REQUEST_START_GRACE_MS = 90_000;
/** Requests older than this are forgotten, so a long-abandoned one doesn't linger on the card. */
export const REQUEST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** What can answer a request: a review, CI fix, approval ask, or bump recorded after it was sent, or the PR merging. */
export interface RequestResults {
  mergedAt: string | null;
  review?: AgentReview;
  ciFix?: CiFix;
  approval?: ApprovalAsk;
}

function answered(action: AgentAction, requestedAt: string, results: RequestResults): boolean {
  switch (action) {
    case "review":
      return results.review !== undefined && results.review.reviewedAt >= requestedAt;
    case "fix-ci":
      return results.ciFix !== undefined && results.ciFix.recordedAt >= requestedAt;
    case "merge":
      return results.mergedAt !== null;
    case "ask-approval":
      return results.approval !== undefined && results.approval.askedAt >= requestedAt;
    case "bump":
      // A fresh ask answers a bump too: the session found the old ask was never sent and drafted it again.
      return results.approval !== undefined && (results.approval.askedAt >= requestedAt || (results.approval.bumpedAt ?? "") >= requestedAt);
  }
}

/**
 * Where each request the board sent a PR's session stands. One without an answer yet runs while
 * the session works on it; a session that stopped without answering has `stalled`, so the card
 * can say so and offer the button again. Only the newest request can run: the board sends one
 * only to an idle session, so any older one still unanswered by then had already stopped.
 */
export function requestProgress(
  requests: AgentRequests | undefined,
  results: RequestResults,
  live: CardOwner["live"],
  now: Date,
): Record<AgentAction, RequestProgress> {
  const open = AGENT_ACTIONS.flatMap((action) => {
    const requestedAt = requests?.[action];
    if (!requestedAt || answered(action, requestedAt, results)) return [];
    const age = now.getTime() - new Date(requestedAt).getTime();
    return age > REQUEST_MAX_AGE_MS ? [] : [{ action, requestedAt, age }];
  });
  const newest = open.toSorted((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  const progress = Object.fromEntries(AGENT_ACTIONS.map((action) => [action, "none"])) as Record<AgentAction, RequestProgress>;
  for (const request of open) {
    const running = request === newest && (live?.status === "working" || request.age < REQUEST_START_GRACE_MS);
    progress[request.action] = running ? "running" : "stalled";
  }
  return progress;
}

/** CI as a person reads it: gate checks never count, any failure wins, then anything still running. */
export function ciState(checks: Check[], gateChecks: string[]): CiState {
  const ci = checks.filter((check) => !gateChecks.includes(check.name));
  if (ci.length === 0) return "none";
  if (ci.some((check) => check.state === "failed")) return "failed";
  if (ci.some((check) => check.state === "pending")) return "running";
  return "passed";
}

export function agentReviewState(pr: PullRequest, review: AgentReview | undefined): AgentReviewState {
  if (!review) return { status: "not-run" };
  return {
    status: review.verdict,
    findings: review.findings,
    stale: review.headSha !== pr.headSha,
    reviewedAt: review.reviewedAt,
    headSha: review.headSha,
    summary: review.summary,
  };
}

export function ciFixState(pr: PullRequest, fix: CiFix | undefined): CiFixState {
  if (!fix) return { status: "not-run" };
  return {
    status: fix.verdict,
    stale: fix.headSha !== pr.headSha,
    recordedAt: fix.recordedAt,
    headSha: fix.headSha,
    summary: fix.summary,
  };
}

/** An approval ask speaks for the PR, not a commit: new commits don't make people's approval less needed. */
export function approvalState(ask: ApprovalAsk | undefined): ApprovalState {
  if (!ask) return { status: "not-asked" };
  return { status: ask.bumpedAt ? "bumped" : "asked", askedAt: ask.askedAt, bumpedAt: ask.bumpedAt, slackUrl: ask.slackUrl };
}

/** A gate reason that means people still have to review, like "1 approval missing". */
export const WAITING_ON_PEOPLE = /approv|review/i;

/**
 * Why GitHub won't merge the PR yet, apart from CI, in a few words. A gate check that failed says
 * why in its title, and so does a pending one still waiting on reviewers ("1 pending: 1 approval
 * missing" → "1 approval missing"). GitHub calling an approved PR BLOCKED means a required check
 * or rule is unmet.
 */
export function mergeBlocker(pr: PullRequest, gateChecks: string[]): string | null {
  const gate = pr.checks.find((check) => gateChecks.includes(check.name) && check.state !== "passed");
  const reason = gate?.title?.replace(/^\d+ pending:\s*/i, "");
  const gateReason = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : null;
  if (gate?.state === "failed") return gateReason ?? "Merge gate blocked";
  if (gateReason && WAITING_ON_PEOPLE.test(gateReason)) return gateReason;
  if (pr.mergeState === "DIRTY") return "Merge conflicts";
  if (pr.mergeState === "BEHIND") return "Behind its base branch";
  if (pr.mergeState === "BLOCKED") return gateReason ?? "Blocked by branch rules";
  return null;
}

/**
 * A PR stays with people until it has every approval it needs: GitHub's own review decision, and
 * a merge gate that can ask for more. Before anyone approved, it waits on its agent review until a
 * review of its current commit passed. Fully approved, it is ready once nothing else (CI, a gate,
 * conflicts) stops GitHub from merging it.
 */
export function laneFor(card: BoardCard): Lane {
  const { pr, ci, mergeBlocker, agentReview } = card;
  if (pr.isDraft) return "draft";
  const fullyApproved = pr.reviewDecision === "APPROVED" && !WAITING_ON_PEOPLE.test(mergeBlocker ?? "");
  if (!fullyApproved) {
    const peopleStarted = pr.approvedBy.length > 0 || pr.reviewDecision === "APPROVED";
    return peopleStarted || (agentReview.status === "passed" && !agentReview.stale) ? "human-review" : "agent-review";
  }
  return mergeBlocker || ci === "failed" || ci === "running" ? "approved-blocked" : "ready";
}

/** "acme-deploy-bot-c2e9d4" → "acme-deploy-bot": GitHub app bots end in a random suffix. */
function botName(login: string): string {
  return login.replace(/\[bot\]$/, "").replace(/-[0-9a-f]{6}$/, "");
}

/** What relay knows about PRs that GitHub doesn't, keyed by "owner/repo#number"; a board can be built without any of it. */
export interface LocalState {
  reviews?: Map<string, AgentReview>;
  ciFixes?: Map<string, CiFix>;
  approvals?: Map<string, ApprovalAsk>;
  requests?: Map<string, AgentRequests>;
  /** The omp session in charge of each PR that has one. */
  owners?: Record<string, CardOwner>;
  now?: Date;
}

/**
 * Search lags behind GitHub, so `data.mine` can still hold a PR that merged or closed moments ago.
 * Its live `state` says so: it leaves the lanes right away (a merged one joins Merged), which is
 * also what finishes a merge request on it.
 */
export function buildBoard(data: BoardData, gateChecks: string[], local: LocalState = {}): Board {
  const { reviews = new Map(), ciFixes = new Map(), approvals = new Map(), requests = new Map(), owners = {}, now = new Date() } = local;
  const lanes: Record<Lane, BoardCard[]> = { draft: [], "agent-review": [], "human-review": [], "approved-blocked": [], ready: [] };
  const merged = new Map(data.merged.map((pr) => [pr.url, pr]));
  for (const pr of data.mine) {
    if (pr.state === "MERGED") merged.set(pr.url, pr);
    if (pr.state !== "OPEN") continue;
    const key = `${pr.repo}#${pr.number}`;
    const review = reviews.get(key);
    const ciFix = ciFixes.get(key);
    const approval = approvals.get(key);
    const card: BoardCard = {
      pr,
      ci: ciState(pr.checks, gateChecks),
      mergeBlocker: mergeBlocker(pr, gateChecks),
      agentReview: agentReviewState(pr, review),
      ciFix: ciFixState(pr, ciFix),
      approval: approvalState(approval),
      requests: requestProgress(requests.get(key), { mergedAt: pr.mergedAt, review, ciFix, approval }, owners[key]?.live ?? null, now),
    };
    lanes[laneFor(card)].push(card);
  }
  for (const cards of Object.values(lanes)) cards.sort((a, b) => b.pr.updatedAt.localeCompare(a.pr.updatedAt));

  const botCounts = new Map<string, number>();
  for (const pr of data.reviewRequested.filter((pr) => pr.authorIsBot)) {
    const name = botName(pr.author);
    botCounts.set(name, (botCounts.get(name) ?? 0) + 1);
  }
  return {
    lanes,
    merged: [...merged.values()].toSorted((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "")),
    teammates: data.reviewRequested.filter((pr) => !pr.authorIsBot).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    bots: [...botCounts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count),
    owners,
  };
}
