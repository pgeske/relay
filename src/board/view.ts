import { AGENT_COMMAND } from "../tmux.ts";
import type { PullRequest } from "./github.ts";
import type { AgentReviewState, ApprovalState, Board, BoardCard, CardOwner, CiFixState, Lane, RequestProgress } from "./lanes.ts";
import { AGENT_ACTIONS, type AgentAction } from "./store.ts";

/**
 * The board as the Relay Board app draws it. Everything a card offers and how it words it is decided
 * here, so the app only lays the board out, and an app built against an older relay still words new
 * steps right.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days without activity before a PR is called stale. */
const STALE_DAYS = 7;
/** Seconds between the app's refreshes. */
export const REFRESH_SECONDS = 60;
/** Seconds between refreshes while a session runs one of the board's requests, so its end shows soon. */
export const ACTIVE_REFRESH_SECONDS = 10;

/** What a card's controls can ask relay's server to do: `POST /api/board/actions/<action>` with the card's `ref`. */
export const BOARD_ACTIONS = ["open", "close", ...AGENT_ACTIONS] as const;
export type BoardAction = (typeof BOARD_ACTIONS)[number];

/** Lanes left to right in the order work moves; `hot` lanes are the ones waiting on you to act. */
const LANES: { id: Lane; title: string; hint: string; hot: boolean }[] = [
  { id: "draft", title: "Draft", hint: "Still being shaped", hot: false },
  { id: "agent-review", title: "Agent review", hint: "No passing review of the current commit", hot: false },
  { id: "human-review", title: "Human review", hint: "Waiting on people's approvals", hot: false },
  { id: "approved-blocked", title: "Approved · blocked", hint: "All approvals in; CI or GitHub says not yet", hot: true },
  { id: "ready", title: "Ready to merge", hint: "Approved and green", hot: true },
];

/**
 * How a card words each step it can ask the PR's session to take. Steps with a `button` move the
 * PR to its next lane and get a button on the card; Fix CI has none, since CI can go red in any
 * lane: the red CI tag itself asks for it.
 */
const STEPS: Record<AgentAction, { button?: string; does: string; running: string; stalled: string }> = {
  review: { button: "Review", does: "review this PR", running: "Agent reviewing…", stalled: "Review stopped without a result" },
  merge: { button: "Merge", does: "merge this PR", running: "Agent merging…", stalled: "Merge stopped without a result" },
  "fix-ci": { does: "fix this PR's failing CI", running: "Agent fixing CI…", stalled: "CI fix stopped without a result" },
  "ask-approval": {
    button: "Ask for Approval",
    does: "draft a Slack message asking for approval (you send it)",
    running: "Agent drafting approval ask…",
    stalled: "Approval ask stopped without a result",
  },
  bump: { button: "Bump", does: "draft a bump in the approval ask's Slack thread (you send it)", running: "Agent drafting bump…", stalled: "Bump stopped without a result" },
};

/** What a control that changes something asks first. Review only starts a reviewer, which asks before changing code. */
const CONFIRMS: Partial<Record<BoardAction, (ref: string) => Confirm>> = {
  close: (ref) => ({ title: `Close ${ref}?`, message: "This closes the pull request on GitHub. Its branch stays.", button: "Close PR", destructive: true }),
  merge: (ref) => ({
    title: `Merge ${ref}?`,
    message: "Asks the session in charge to merge it the repo's normal way, once its checks and approvals allow.",
    button: "Merge",
    destructive: false,
  }),
  "fix-ci": (ref) => ({
    title: `Fix CI on ${ref}?`,
    message: "Asks the session in charge to find out why CI failed, then retry flaky jobs or push a fix.",
    button: "Fix CI",
    destructive: false,
  }),
  "ask-approval": (ref) => ({
    title: `Ask for approval of ${ref}?`,
    message: "Asks the session in charge to draft a Slack message asking for a review, in the channel you usually ask in. It only drafts; you send it.",
    button: "Draft Ask",
    destructive: false,
  }),
  bump: (ref) => ({
    title: `Bump the approval ask for ${ref}?`,
    message: "Asks the session in charge to find the ask you sent and draft a short bump in its thread. It only drafts; you send it.",
    button: "Draft Bump",
    destructive: false,
  }),
};

const CI_TAGS = { passed: ["ok", "CI green"], failed: ["bad", "CI red"], running: ["wait", "CI running"] } as const;

/** A ticket key at the start of a title, "[PROJ-123] Fix it" or "PROJ-123: Fix it", shown as a tag instead. */
const TICKET_PREFIX = /^\[?([A-Z][A-Z0-9]+-\d+)\]?:?\s+/;

/** omp starts session titles with a nerd-font icon, which no system font draws. */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu;

export type Tone = "ok" | "bad" | "wait" | "muted" | "warn" | "link" | "ghost";

export interface Confirm {
  title: string;
  message: string;
  /** The confirming button's label. */
  button: string;
  /** Styles the confirming button as destructive. */
  destructive: boolean;
}

/** A control on a card. */
export interface ActionView {
  action: BoardAction;
  label: string;
  hint: string;
  /** What the card says once the session has taken the request on; null for controls that don't start one. */
  running: string | null;
  /** Asked before the server is; null when the control acts right away. */
  confirm: Confirm | null;
}

/** What an agent concluded, as its tag shows it when clicked. */
export interface DetailView {
  title: string;
  verdict: string;
  tone: Tone;
  /** The commit the result is about, shortened. */
  commit: string;
  at: string;
  /** A caveat, like newer commits landing after a review. */
  note: string | null;
  /** The agent's write-up; null when it saved none. */
  summary: string | null;
}

export interface TagView {
  kind: "ci" | "ci-fix" | "gate" | "approvals" | "changes-requested" | "agent-review" | "approval" | "request" | "merged";
  tone: Tone;
  text: string;
  hint: string | null;
  /** A request its session is working on right now. */
  running: boolean;
  /** Clicking asks the PR's session for this (the red CI tag asks it to fix CI). */
  action: ActionView | null;
  /** Clicking shows what an agent wrote. */
  detail: DetailView | null;
  /** Clicking opens this, like the approval ask in Slack. */
  link: string | null;
}

/** The omp session in charge of a PR. */
export interface SessionView {
  title: string;
  state: "open" | "working" | "closed";
  /** It's on one of the board's requests, whose tag says so. */
  busy: boolean;
  open: ActionView;
}

export interface CardView {
  /** "owner/repo#12": what the card's actions name. */
  ref: string;
  repo: string;
  /** The repo without its owner. */
  repoName: string;
  number: number;
  url: string;
  /** The title without a leading ticket key, which `ticket` holds. */
  title: string;
  ticket: string | null;
  updatedAt: string;
  /** Whole days since the PR last changed. */
  idleDays: number;
  stale: boolean;
  mergedAt: string | null;
  tags: TagView[];
  session: SessionView | null;
  /** The buttons that move the PR to its next lane; none while its session is on a request. */
  steps: ActionView[];
  /** Closes the PR on GitHub; null on merged cards. */
  close: ActionView | null;
}

export interface LaneView {
  id: Lane | "merged";
  title: string;
  hint: string;
  hot: boolean;
  cards: CardView[];
}

export interface BoardView {
  /** Every lane in order, then Merged; empty when the board has never loaded. */
  lanes: LaneView[];
  /** When the board's GitHub data was fetched; null when it never was. */
  updatedAt: string | null;
  /** Set when the latest refresh failed; the lanes are then from `updatedAt`. */
  error: string | null;
  /** Whether a session is on one of the board's requests right now. */
  agentWorking: boolean;
  /** When to refresh next: sooner while an agent works, so a finished step shows soon. */
  refreshSeconds: number;
}

function timeAgo(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function tag(kind: TagView["kind"], tone: Tone, text: string, extra: Partial<Omit<TagView, "kind" | "tone" | "text">> = {}): TagView {
  return { kind, tone, text, hint: null, running: false, action: null, detail: null, link: null, ...extra };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A request's tag while it runs or after its session stopped without finishing it. */
function requestTag(action: AgentAction, progress: RequestProgress): TagView | null {
  if (progress === "running") return tag("request", "wait", STEPS[action].running, { running: true });
  if (progress === "stalled") return tag("request", "warn", STEPS[action].stalled);
  return null;
}

function agentReviewTag(review: AgentReviewState): TagView {
  if (review.status === "not-run") return tag("agent-review", "ghost", "No agent review");
  const [tone, text]: [Tone, string] = review.stale
    ? ["wait", "Agent review out of date"]
    : review.status === "passed"
      ? ["ok", "Agent passed"]
      : ["wait", `Agent: ${plural(review.findings, "finding")}`];
  const detail: DetailView = {
    title: "Agent review",
    verdict: review.status === "passed" ? "Passed" : plural(review.findings, "finding"),
    tone: review.status === "passed" ? "ok" : "wait",
    commit: review.headSha.slice(0, 7),
    at: review.reviewedAt,
    note: review.stale ? "New commits landed after this review, so it doesn't cover the latest code." : null,
    summary: review.summary,
  };
  return tag("agent-review", tone, text, { hint: "See what the review said", detail });
}

function ciFixDetail(fix: Extract<CiFixState, { status: "fixed" | "not-fixed" }>): DetailView {
  return {
    title: "CI fix",
    verdict: fix.status === "fixed" ? "Fixed" : "Couldn't fix",
    tone: fix.status === "fixed" ? "ok" : "bad",
    commit: fix.headSha.slice(0, 7),
    at: fix.recordedAt,
    note: null,
    summary: fix.summary,
  };
}

/** Where the PR's approval ask is in Slack, saying how long ago it was asked or last bumped. */
function approvalTag(approval: ApprovalState, now: Date): TagView | null {
  if (approval.status === "not-asked") return null;
  const text = approval.bumpedAt ? `Bumped ${timeAgo(approval.bumpedAt, now)}` : `Approval asked ${timeAgo(approval.askedAt, now)}`;
  return tag("approval", "link", text, { hint: "Open the approval ask in Slack", link: approval.slackUrl });
}

function stepAction(action: AgentAction, ref: string, hint: string, label = STEPS[action].button ?? action): ActionView {
  return { action, label, hint, running: STEPS[action].running, confirm: CONFIRMS[action]?.(ref) ?? null };
}

/**
 * The session a card names, and the steps in `offered` (Review, Ask for Approval or Bump, Merge) that
 * ask it to move the PR to its next lane. While the session runs one of the board's requests, that
 * request's tag says it all: no steps. A step whose request stalled offers itself again.
 */
function sessionParts(
  ref: string,
  owner: CardOwner | undefined,
  offered: AgentAction[],
  requests: BoardCard["requests"] | undefined,
): { session: SessionView | null; steps: ActionView[] } {
  if (!owner) return { session: null, steps: [] };
  const state = !owner.live ? "closed" : owner.live.status === "working" ? "working" : "open";
  const busy = AGENT_ACTIONS.some((action) => requests?.[action] === "running");
  const asks = state === "closed" ? "Reopens the session in relay, then asks it to" : "Asks the session to";
  const steps = busy
    ? []
    : offered
        .filter((action) => STEPS[action].button)
        .map((action) => {
          const again = requests?.[action] === "stalled" ? " Again" : "";
          return stepAction(action, ref, `${asks} ${STEPS[action].does}`, `${STEPS[action].button}${again}`);
        });
  const open: ActionView = {
    action: "open",
    label: "Open Session",
    hint: `Show this ${AGENT_COMMAND} session in your terminal${state === "closed" ? ", reopening it in a new relay tab" : ""}`,
    running: null,
    confirm: null,
  };
  return { session: { title: owner.title.replace(PRIVATE_USE, "").trim() || "Untitled session", state, busy, open }, steps };
}

function cardBase(pr: PullRequest, now: Date): Omit<CardView, "tags" | "session" | "steps" | "close"> {
  const ticket = TICKET_PREFIX.exec(pr.title);
  const idleDays = Math.max(0, Math.floor((now.getTime() - new Date(pr.updatedAt).getTime()) / DAY_MS));
  return {
    ref: `${pr.repo}#${pr.number}`,
    repo: pr.repo,
    repoName: pr.repo.split("/")[1] ?? pr.repo,
    number: pr.number,
    url: pr.url,
    title: ticket ? pr.title.slice(ticket[0].length) : pr.title,
    ticket: ticket?.[1] ?? null,
    updatedAt: pr.updatedAt,
    idleDays,
    stale: idleDays >= STALE_DAYS,
    mergedAt: pr.mergedAt,
  };
}

function laneCard(boardCard: BoardCard, lane: Lane, owners: Board["owners"], now: Date): CardView {
  const { pr, requests, ciFix } = boardCard;
  const ref = `${pr.repo}#${pr.number}`;
  const owner = owners[ref];
  const offered: AgentAction[] = [];
  if (lane === "agent-review") offered.push("review");
  if (lane === "ready") offered.push("merge");
  // Human review moves on through Slack: ask for approval once, then bump the ask.
  if (lane === "human-review") offered.push(boardCard.approval.status === "not-asked" ? "ask-approval" : "bump");

  // CI can go red in any lane, so the red tag itself asks the session to fix it, unless the session is already on a request.
  const fixable = boardCard.ci === "failed" && owner !== undefined && !AGENT_ACTIONS.some((action) => requests[action] === "running");
  const fixHint = owner?.live ? "Ask the session to fix CI" : "Reopen the session in relay and ask it to fix CI";
  // A CI-fix result speaks only for the commit it was recorded at, and a newer request outranks it.
  const fix = requests["fix-ci"] === "none" && ciFix.status !== "not-run" && !ciFix.stale ? ciFix : null;
  const fixDetail = fix ? ciFixDetail(fix) : null;
  const fixedHint = "An agent fixed CI on this commit: see what it did";

  let ciTag: TagView | null = null;
  if (fixable) {
    ciTag = tag("ci", "bad", CI_TAGS.failed[1], { hint: fixHint, action: stepAction("fix-ci", ref, fixHint, "Fix CI") });
  } else if (boardCard.ci !== "none") {
    const [tone, text] = CI_TAGS[boardCard.ci];
    // After an agent fixed CI on this commit, an asterisk marks the tag, and it opens what the agent did.
    ciTag = fix?.status === "fixed" ? tag("ci", tone, `${text}*`, { hint: fixedHint, detail: fixDetail }) : tag("ci", tone, text);
  }
  // Next to the CI tag: the fix running, stalled (asking again while CI is still red), or how the last one went.
  const fixTag =
    requests["fix-ci"] === "stalled" && fixable
      ? tag("ci-fix", "bad", STEPS["fix-ci"].stalled, { hint: `${fixHint} again`, action: stepAction("fix-ci", ref, `${fixHint} again`, "Fix CI Again") })
      : (requestTag("fix-ci", requests["fix-ci"]) ??
        (fix?.status === "not-fixed" ? tag("ci-fix", "bad", "Agent couldn't fix CI", { hint: "See why the agent couldn't fix CI", detail: fixDetail }) : null) ??
        (fix?.status === "fixed" && fixable ? tag("ci-fix", "ok", "Agent fixed CI", { hint: fixedHint, detail: fixDetail }) : null));

  const reviewing = lane === "agent-review" || lane === "human-review" ? agentReviewTag(boardCard.agentReview) : null;
  // Once people review, the card shows who approved and what GitHub still wants before it will merge.
  const awaitingPeople = lane === "human-review" || lane === "approved-blocked";
  const waitingOn = pr.waitingOn.length > 2 ? [...pr.waitingOn.slice(0, 2), `+${pr.waitingOn.length - 2}`] : pr.waitingOn;
  const blocker = boardCard.mergeBlocker
    ? tag("gate", lane === "approved-blocked" ? "bad" : "wait", [boardCard.mergeBlocker, ...(waitingOn.length ? [`needs ${waitingOn.join(", ")}`] : [])].join(" · "), {
        hint: pr.waitingOn.length ? `Still waiting on ${pr.waitingOn.join(", ")}` : null,
      })
    : null;
  const approvals = pr.approvedBy.length ? tag("approvals", "ok", plural(pr.approvedBy.length, "approval"), { hint: `Approved by ${pr.approvedBy.join(", ")}` }) : null;
  const tags = [
    ciTag,
    fixTag,
    awaitingPeople ? approvals : null,
    awaitingPeople ? blocker : null,
    pr.reviewDecision === "CHANGES_REQUESTED" ? tag("changes-requested", "bad", "Changes requested") : null,
    requestTag("review", requests.review) ?? reviewing,
    lane === "human-review" ? approvalTag(boardCard.approval, now) : null,
    requestTag("ask-approval", requests["ask-approval"]),
    requestTag("bump", requests.bump),
    requestTag("merge", requests.merge),
  ].filter((candidate): candidate is TagView => candidate !== null);

  const close: ActionView = { action: "close", label: "Close PR…", hint: "Close this PR on GitHub", running: null, confirm: CONFIRMS.close!(ref) };
  return { ...cardBase(pr, now), tags, ...sessionParts(ref, owner, offered, requests), close };
}

function mergedCard(pr: PullRequest, owners: Board["owners"], now: Date): CardView {
  const ref = `${pr.repo}#${pr.number}`;
  const tags = pr.mergedAt ? [tag("merged", "muted", `Merged ${timeAgo(pr.mergedAt, now)}`)] : [];
  return { ...cardBase(pr, now), tags, ...sessionParts(ref, owners[ref], [], undefined), close: null };
}

export interface ViewOptions {
  now: Date;
  /** When the board's GitHub data was fetched. */
  updatedAt: Date | null;
  /** Set when the latest refresh failed; the view then shows the last board it had. */
  error?: string;
}

export function boardView(board: Board | null, options: ViewOptions): BoardView {
  const { now } = options;
  const lanes: LaneView[] = board
    ? [
        ...LANES.map(({ id, title, hint, hot }) => ({
          id,
          title,
          hint,
          hot,
          cards: board.lanes[id].map((boardCard) => laneCard(boardCard, id, board.owners, now)),
        })),
        { id: "merged", title: "Merged", hint: "Deploys aren't tracked yet", hot: false, cards: board.merged.map((pr) => mergedCard(pr, board.owners, now)) },
      ]
    : [];
  // While a session runs one of the board's requests, refresh often, so a finished merge or review shows soon.
  const agentWorking = board !== null && Object.values(board.lanes).some((cards) => cards.some((card) => AGENT_ACTIONS.some((action) => card.requests[action] === "running")));
  return {
    lanes,
    updatedAt: options.updatedAt?.toISOString() ?? null,
    error: options.error ?? null,
    agentWorking,
    refreshSeconds: agentWorking ? ACTIVE_REFRESH_SECONDS : REFRESH_SECONDS,
  };
}
