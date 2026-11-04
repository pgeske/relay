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

/** One ask the PR's session recorded, and whether the reviewer it asked has approved since. */
export interface ApprovalAskState {
  /** Who it asks (a login or team slug); null for an ask recorded before asks named their reviewer. */
  reviewer: string | null;
  /** The channel it went to ("#team-reviews"); null when unknown. */
  channel: string | null;
  askedAt: string;
  /** When a bump was last drafted in its thread; null until the first. */
  bumpedAt: string | null;
  /** Where the ask is in Slack. */
  slackUrl: string;
  /** Its reviewer approved: the person, or someone on the team's behalf. Never set on an ask that named no reviewer. */
  approved: boolean;
}

/**
 * Where asking for the PR's approval stands in Slack: every ask its session recorded, oldest first,
 * and the reviewers GitHub still waits on that no ask went to yet.
 */
export interface ApprovalState {
  asks: ApprovalAskState[];
  unasked: string[];
}

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
  /** The Slack messages the PR's session drafted asking its reviewers for approval, and who still has none. */
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
  approval?: ApprovalState;
}

function answered(action: AgentAction, requestedAt: string, results: RequestResults): boolean {
  switch (action) {
    case "review":
      return results.review !== undefined && results.review.reviewedAt >= requestedAt;
    case "fix-ci":
      return results.ciFix !== undefined && results.ciFix.recordedAt >= requestedAt;
    case "merge":
      return results.mergedAt !== null;
    case "ask-approval": {
      if (results.approval === undefined) return false;
      // Every reviewer the PR waits on has an ask, at least one of them from this request. An ask
      // that named no reviewer answered a request from before asks did, whoever it left out.
      const since = results.approval.asks.filter((ask) => ask.askedAt >= requestedAt);
      return since.some((ask) => ask.reviewer === null) || (since.length > 0 && results.approval.unasked.length === 0);
    }
    case "bump": {
      if (results.approval === undefined) return false;
      // Each ask still waiting was bumped, or asked afresh (the session found it was never sent),
      // since the request. An ask that named no reviewer may be skipped: whether its people approved is the session's call.
      const since = (ask: ApprovalAskState) => ask.askedAt >= requestedAt || (ask.bumpedAt ?? "") >= requestedAt;
      const waiting = waitingAsks(results.approval);
      return waiting.length === 0 || (waiting.some(since) && waiting.every((ask) => ask.reviewer === null || since(ask)));
    }
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

/**
 * Each of the PR's approval asks, and who it still waits on without one. Asks speak for the PR, not
 * a commit: new commits don't make people's approval less needed.
 */
export function approvalState(pr: Pick<PullRequest, "approvedBy" | "approvedFor" | "waitingOn">, asks: ApprovalAsk[]): ApprovalState {
  // Logins and team slugs ignore case.
  const approvers = new Set([...pr.approvedBy, ...pr.approvedFor].map((name) => name.toLowerCase()));
  const asked = new Set(asks.flatMap((ask) => (ask.reviewer === null ? [] : [ask.reviewer.toLowerCase()])));
  return {
    asks: asks.map(({ reviewer, channel, askedAt, bumpedAt, slackUrl }) => ({
      reviewer,
      channel,
      askedAt,
      bumpedAt,
      slackUrl,
      approved: reviewer !== null && approvers.has(reviewer.toLowerCase()),
    })),
    unasked: pr.waitingOn.filter((reviewer) => !approvers.has(reviewer.toLowerCase()) && !asked.has(reviewer.toLowerCase())),
  };
}

/** The asks a bump is for: each one whose reviewer hasn't approved yet. */
export function waitingAsks(approval: ApprovalState): ApprovalAskState[] {
  return approval.asks.filter((ask) => !ask.approved);
}

/**
 * Human review's step: ask each reviewer the PR waits on that no ask went to yet, else bump the asks
 * still waiting. With no ask waiting and nobody to ask listed, asking works out who from the PR.
 */
export function approvalStep(approval: ApprovalState): "ask-approval" | "bump" {
  return approval.unasked.length > 0 || waitingAsks(approval).length === 0 ? "ask-approval" : "bump";
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
  /** Each PR's approval asks, oldest first. */
  approvals?: Map<string, ApprovalAsk[]>;
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
    const approval = approvalState(pr, approvals.get(key) ?? []);
    const card: BoardCard = {
      pr,
      ci: ciState(pr.checks, gateChecks),
      mergeBlocker: mergeBlocker(pr, gateChecks),
      agentReview: agentReviewState(pr, review),
      ciFix: ciFixState(pr, ciFix),
      approval,
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
