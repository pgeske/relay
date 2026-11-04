import { AGENT_COMMAND } from "../tmux.ts";
import type { PullRequest } from "./github.ts";
import {
  type AgentReviewState,
  type ApprovalState,
  approvalStep,
  type Board,
  type BoardCard,
  type CardOwner,
  type CiFixState,
  type CiState,
  type Lane,
  type RequestProgress,
  WAITING_ON_PEOPLE,
  waitingAsks,
} from "./lanes.ts";
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
 * lane: the red CI row itself asks for it.
 */
const STEPS: Record<AgentAction, { button?: string; does: string; running: string; stalled: string }> = {
  review: { button: "Review", does: "review this PR", running: "Agent reviewing…", stalled: "Review stopped without a result" },
  merge: { button: "Merge", does: "merge this PR", running: "Agent merging…", stalled: "Merge stopped without a result" },
  "fix-ci": { does: "fix this PR's failing CI", running: "Agent fixing CI…", stalled: "CI fix stopped without a result" },
  "ask-approval": {
    button: "Ask for Approval",
    does: "draft a Slack message asking each reviewer it still waits on for approval (you send it)",
    running: "Agent drafting approval ask…",
    stalled: "Approval ask stopped without a result",
  },
  bump: {
    button: "Bump",
    does: "draft a bump in the thread of each approval ask still waiting (you send it)",
    running: "Agent drafting bump…",
    stalled: "Bump stopped without a result",
  },
};

/** "a, b, and c". */
const AND = new Intl.ListFormat("en", { type: "conjunction" });

/** What a control's confirm can name: the PR, and for the Slack steps, who they ask. */
interface StepTarget {
  ref: string;
  approval: ApprovalState | null;
}

/** What a control that changes something asks first. Review only starts a reviewer, which asks before changing code. */
const CONFIRMS: Partial<Record<BoardAction, (target: StepTarget) => Confirm>> = {
  close: ({ ref }) => ({ title: `Close ${ref}?`, message: "This closes the pull request on GitHub. Its branch stays.", button: "Close PR", destructive: true }),
  merge: ({ ref }) => ({
    title: `Merge ${ref}?`,
    message: "Asks the session in charge to merge it the repo's normal way, once its checks and approvals allow.",
    button: "Merge",
    destructive: false,
  }),
  "fix-ci": ({ ref }) => ({
    title: `Fix CI on ${ref}?`,
    message: "Asks the session in charge to find out why CI failed, then retry flaky jobs or push a fix.",
    button: "Fix CI",
    destructive: false,
  }),
  "ask-approval": ({ ref, approval }) => ({
    title: `Ask for approval of ${ref}?`,
    message:
      `Asks the session in charge to draft a Slack message asking ${approval?.unasked.length ? AND.format(approval.unasked) : "each reviewer it still needs"} ` +
      "for a review, in the channel where they take review requests. It only drafts; you send it.",
    button: "Draft Ask",
    destructive: false,
  }),
  bump: ({ ref, approval }) => {
    const waiting = approval ? waitingAsks(approval) : [];
    const channels = [...new Set(waiting.flatMap((ask) => (ask.channel ? [ask.channel] : [])))];
    return {
      title: `Bump the approval ${waiting.length > 1 ? "asks" : "ask"} for ${ref}?`,
      message:
        `Asks the session in charge to find each ask still waiting${channels.length ? ` (in ${AND.format(channels)})` : ""} as you sent it, ` +
        "and draft a short bump in its thread. It only drafts; you send it.",
      button: "Draft Bump",
      destructive: false,
    };
  },
};

/** CI as a card's CI row words it. */
const CI_VALUES: Record<CiState, [Tone, string]> = { passed: ["ok", "Green"], failed: ["bad", "Red"], running: ["wait", "Running"], none: ["muted", "No checks"] };

/** A ticket key at the start of a title, "[PROJ-123] Fix it" or "PROJ-123: Fix it", shown as a chip instead. */
const TICKET_PREFIX = /^\[?([A-Z][A-Z0-9]+-\d+)\]?:?\s+/;

/** omp starts session titles with a nerd-font icon, which no system font draws. */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu;

/** How many approvals a merge gate still wants, from its reason ("1 approval missing"). */
const APPROVALS_MISSING = /(\d+) approvals? missing/i;

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
  /** Offers again a request that stopped without a result ("Merge Again"). */
  stalled: boolean;
}

/** What an agent concluded, as its row or notice shows it when clicked. */
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

/** What a status row is about; the app picks each kind's symbol. */
export type RowKind = "ci" | "agent" | "approvals" | "slack";

/** One line of a row that lists several things, like each Slack ask for the PR's approval. */
export interface RowItemView {
  /** What the line is about, like the channel an ask went to. */
  text: string;
  /** Said after it, quieter, like how long ago the ask was sent; null when the text says it all. */
  note: string | null;
  tone: Tone;
  hint: string | null;
  /** Clicking opens this. */
  link: string | null;
  /** Taken care of, like an ask whose reviewer approved: shown checked off, its text muted. */
  done: boolean;
}

/**
 * One line of a card's status: a short label, then a short value in its tone. A card has its rows
 * in a fixed order (CI, Agent, Approvals, Slack), and only the ones that matter in its lane. A row
 * acts on at most one of `action`, `detail`, `link`, in that order.
 */
export interface RowView {
  kind: RowKind;
  label: string;
  value: string;
  tone: Tone;
  hint: string | null;
  /** The session is on what the value says right now, like fixing CI. */
  running: boolean;
  /** Clicking asks the PR's session for this (red CI asks it to fix CI). */
  action: ActionView | null;
  /** Clicking shows what an agent wrote. */
  detail: DetailView | null;
  /** Clicking opens this, like the approval ask in Slack. */
  link: string | null;
  /**
   * A row about several things lists them here, one line each, in place of its value: the Slack row
   * has a line per approval ask. Empty for other rows. The value, tone, hint, and link repeat the
   * first line, for an app that shows only one.
   */
  items: RowItemView[];
}

/**
 * Something on the card that needs you: a request that stopped without a result, an agent that
 * couldn't fix CI, what keeps GitHub from merging an approved PR.
 */
export interface NoticeView {
  tone: Tone;
  text: string;
  hint: string | null;
  /** Clicking shows what an agent wrote. */
  detail: DetailView | null;
}

/** How long ago the PR last changed, or merged, as the card's header says it. */
export interface AgeView {
  text: string;
  tone: Tone;
  hint: string | null;
}

/** The omp session in charge of a PR. */
export interface SessionView {
  title: string;
  state: "open" | "working" | "closed";
  /** It's on one of the board's requests, which the card's row or `running` says. */
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
  age: AgeView;
  rows: RowView[];
  notices: NoticeView[];
  session: SessionView | null;
  /** The buttons that move the PR to its next lane; none while its session is on a request. */
  steps: ActionView[];
  /** The request the session is on, shown where the step was ("Agent merging…"); a CI fix shows in the CI row instead. */
  running: string | null;
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

const LABELS: Record<RowKind, string> = { ci: "CI", agent: "Agent", approvals: "Approvals", slack: "Slack" };

function row(kind: RowKind, tone: Tone, value: string, extra: Partial<Omit<RowView, "kind" | "label" | "tone" | "value">> = {}): RowView {
  return { kind, label: LABELS[kind], value, tone, hint: null, running: false, action: null, detail: null, link: null, items: [], ...extra };
}

function notice(tone: Tone, text: string, extra: Partial<Omit<NoticeView, "tone" | "text">> = {}): NoticeView {
  return { tone, text, hint: null, detail: null, ...extra };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function stepAction(action: AgentAction, target: StepTarget, hint: string, stalled = false, button = STEPS[action].button ?? action): ActionView {
  const label = stalled ? `${button} Again` : button;
  return { action, label, hint, running: STEPS[action].running, confirm: CONFIRMS[action]?.(target) ?? null, stalled };
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

/**
 * The CI row, in every lane, and what about CI needs you. CI can go red in any lane, so red CI
 * itself asks the session to fix it, unless the session is already on a request; after a fix
 * stopped, it asks again while a notice says so. The row says when a fix runs, and marks CI an
 * agent fixed at this commit with an asterisk that opens what it did.
 */
function ciParts(card: BoardCard, target: StepTarget, owner: CardOwner | undefined, busy: AgentAction | null): { row: RowView; notices: NoticeView[] } {
  const { ci, requests, ciFix } = card;
  const [tone, value] = CI_VALUES[ci];
  const fixable = ci === "failed" && owner !== undefined && busy === null;
  const fixHint = owner?.live ? "Ask the session to fix CI" : "Reopen the session in relay and ask it to fix CI";
  // A CI-fix result speaks only for the commit it was recorded at, and a newer request outranks it.
  const fix = requests["fix-ci"] === "none" && ciFix.status !== "not-run" && !ciFix.stale ? ciFix : null;
  const fixDetail = fix ? ciFixDetail(fix) : null;
  const fixedHint = "An agent fixed CI on this commit: see what it did";

  if (requests["fix-ci"] === "running") return { row: row("ci", "wait", `${value} · agent fixing…`, { hint: "The session is fixing CI", running: true }), notices: [] };
  if (requests["fix-ci"] === "stalled") {
    // The stop needs you either way; while CI is still red, the row asks again.
    const stalled = [notice("warn", STEPS["fix-ci"].stalled)];
    if (!fixable) return { row: row("ci", tone, value), notices: stalled };
    const hint = `${fixHint} again`;
    return { row: row("ci", tone, value, { hint, action: stepAction("fix-ci", target, hint, true, "Fix CI") }), notices: stalled };
  }
  const notices: NoticeView[] = [];
  if (fix?.status === "not-fixed") notices.push(notice("bad", "Agent couldn't fix CI", { hint: "See why the agent couldn't fix CI", detail: fixDetail }));
  if (fixable) {
    if (fix?.status === "fixed") notices.push(notice("warn", "Red again after the agent's fix", { hint: fixedHint, detail: fixDetail }));
    return { row: row("ci", tone, value, { hint: fixHint, action: stepAction("fix-ci", target, fixHint, false, "Fix CI") }), notices };
  }
  if (fix?.status === "fixed") return { row: row("ci", tone, `${value}*`, { hint: fixedHint, detail: fixDetail }), notices };
  return { row: row("ci", tone, value), notices };
}

/** The agent review row: what the reviewer agent said about the PR, which opens its write-up. */
function agentRow(review: AgentReviewState, progress: RequestProgress): RowView {
  if (progress === "running") return row("agent", "wait", "Reviewing…", { hint: "The session is reviewing this PR", running: true });
  if (review.status === "not-run") return row("agent", "ghost", "Not run", { hint: "No agent has reviewed this PR" });
  const detail: DetailView = {
    title: "Agent review",
    verdict: review.status === "passed" ? "Passed" : plural(review.findings, "finding"),
    tone: review.status === "passed" ? "ok" : "wait",
    commit: review.headSha.slice(0, 7),
    at: review.reviewedAt,
    note: review.stale ? "New commits landed after this review, so it doesn't cover the latest code." : null,
    summary: review.summary,
  };
  const [tone, value]: [Tone, string] = review.stale ? ["wait", "Out of date"] : [detail.tone, detail.verdict];
  return row("agent", tone, value, { hint: "See what the review said", detail });
}

/**
 * Who approved and who the PR still waits on: "1 of 2 · needs cache-team" when a merge gate says
 * how many approvals are missing, else the count. What else keeps GitHub from merging it (conflicts,
 * a failed gate, branch rules) needs you, so it's a notice, urgent once every approval is in.
 */
function approvalsParts(card: BoardCard, lane: Lane): { row: RowView; notices: NoticeView[] } {
  const { pr, mergeBlocker } = card;
  const peopleBlocker = mergeBlocker !== null && WAITING_ON_PEOPLE.test(mergeBlocker) ? mergeBlocker : null;
  const fullyApproved = pr.reviewDecision === "APPROVED" && peopleBlocker === null;
  const approved = pr.approvedBy.length;
  const missing = peopleBlocker ? APPROVALS_MISSING.exec(peopleBlocker) : null;
  const count = missing ? `${approved} of ${approved + Number(missing[1])}` : approved ? plural(approved, "approval") : fullyApproved ? "Approved" : "None yet";
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED";
  const waitingOn = pr.waitingOn.length > 2 ? [...pr.waitingOn.slice(0, 2), `+${pr.waitingOn.length - 2}`] : pr.waitingOn;
  const parts = [
    changesRequested ? "Changes requested" : count,
    // A gate reason that isn't a count ("Needs owner approval") says itself.
    peopleBlocker && !missing ? peopleBlocker.charAt(0).toLowerCase() + peopleBlocker.slice(1) : null,
    waitingOn.length ? `needs ${waitingOn.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  const hint = [approved ? `Approved by ${pr.approvedBy.join(", ")}` : "No approvals yet", pr.waitingOn.length ? `still waiting on ${pr.waitingOn.join(", ")}` : null]
    .filter((part): part is string => part !== null)
    .join("; ");
  const tone: Tone = changesRequested ? "bad" : fullyApproved ? "ok" : "wait";
  const blocker = mergeBlocker && !peopleBlocker ? notice(lane === "approved-blocked" ? "bad" : "warn", mergeBlocker) : null;
  return { row: row("approvals", tone, parts.join(" · "), { hint }), notices: blocker ? [blocker] : [] };
}

/**
 * Each approval ask in Slack, a line per message (reviewers who share a channel can share one):
 * where it went, and how long ago it was asked or last bumped, opening it. Lines still waiting come
 * first; one whose reviewers all approved is checked off. An ask found already sent reads the same,
 * saying so only in its hint.
 */
function slackRow(approval: ApprovalState, now: Date): RowView | null {
  const items = [...Map.groupBy(approval.asks, (ask) => ask.slackUrl)]
    .map(([slackUrl, asks]): RowItemView => {
      const done = asks.every((ask) => ask.approved);
      const channel = asks.find((ask) => ask.channel !== null)?.channel ?? null;
      const bumpedAt = asks.flatMap((ask) => (ask.bumpedAt ? [ask.bumpedAt] : [])).toSorted().at(-1);
      const when = bumpedAt ? `bumped ${timeAgo(bumpedAt, now)}` : `asked ${timeAgo(asks.map((ask) => ask.askedAt).toSorted().at(-1)!, now)}`;
      const reviewers = asks.flatMap((ask) => (ask.reviewer ? [ask.reviewer] : []));
      const approved = asks.flatMap((ask) => (ask.approved && ask.reviewer ? [ask.reviewer] : []));
      const opens = `Open ${reviewers.length ? `the ask to ${AND.format(reviewers)}` : "the approval ask"} in Slack`;
      const found = asks.some((ask) => ask.source === "found") ? "Found your earlier ask. " : "";
      return {
        text: channel ?? when.charAt(0).toUpperCase() + when.slice(1),
        note: channel ? when : null,
        tone: done ? "muted" : "link",
        hint: `${approved.length ? `${AND.format(approved)} approved. ` : ""}${found}${opens}`,
        link: slackUrl,
        done,
      };
    })
    .toSorted((a, b) => Number(a.done) - Number(b.done));
  const [first] = items;
  if (!first) return null;
  return row("slack", first.tone, first.note ? `${first.text} · ${first.note}` : first.text, { hint: first.hint, link: first.link, items });
}

/**
 * The session a card names, and the steps in `offered` (Review, Ask for Approval or Bump, Merge) that
 * ask it to move the PR to its next lane. While the session runs one of the board's requests, the
 * card says so instead: no steps. A step whose request stalled offers itself again.
 */
function sessionParts(
  target: StepTarget,
  owner: CardOwner | undefined,
  offered: AgentAction[],
  busy: AgentAction | null,
  requests: BoardCard["requests"] | undefined,
): { session: SessionView | null; steps: ActionView[] } {
  if (!owner) return { session: null, steps: [] };
  const state = !owner.live ? "closed" : owner.live.status === "working" ? "working" : "open";
  const asks = state === "closed" ? "Reopens the session in relay, then asks it to" : "Asks the session to";
  const steps = busy
    ? []
    : offered
        .filter((action) => STEPS[action].button)
        .map((action) => stepAction(action, target, `${asks} ${STEPS[action].does}`, requests?.[action] === "stalled"));
  const open: ActionView = {
    action: "open",
    label: "Open Session",
    hint: `Show this ${AGENT_COMMAND} session in your terminal${state === "closed" ? ", reopening it in a new relay tab" : ""}`,
    running: null,
    confirm: null,
    stalled: false,
  };
  return { session: { title: owner.title.replace(PRIVATE_USE, "").trim() || "Untitled session", state, busy: busy !== null, open }, steps };
}

function ageView(pr: PullRequest, idleDays: number, stale: boolean, now: Date): AgeView {
  if (pr.mergedAt) return { text: `Merged ${timeAgo(pr.mergedAt, now)}`, tone: "muted", hint: null };
  if (stale) return { text: `Stale ${idleDays}d`, tone: "warn", hint: `No activity for ${plural(idleDays, "day")}` };
  return idleDays === 0 ? { text: "Today", tone: "muted", hint: "Active today" } : { text: `${idleDays}d`, tone: "muted", hint: `Last activity ${plural(idleDays, "day")} ago` };
}

function cardBase(pr: PullRequest, now: Date): Omit<CardView, "rows" | "notices" | "session" | "steps" | "running" | "close"> {
  const ticket = TICKET_PREFIX.exec(pr.title);
  const idleDays = Math.max(0, Math.floor((now.getTime() - new Date(pr.updatedAt).getTime()) / DAY_MS));
  const stale = idleDays >= STALE_DAYS;
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
    stale,
    mergedAt: pr.mergedAt,
    age: ageView(pr, idleDays, stale, now),
  };
}

/** Lanes whose cards show the agent review, and the ones that show people's approvals. */
const AGENT_LANES: Lane[] = ["agent-review", "human-review"];
const APPROVAL_LANES: Lane[] = ["human-review", "approved-blocked", "ready"];

function laneCard(boardCard: BoardCard, lane: Lane, owners: Board["owners"], now: Date): CardView {
  const { requests } = boardCard;
  const ref = `${boardCard.pr.repo}#${boardCard.pr.number}`;
  const target: StepTarget = { ref, approval: boardCard.approval };
  const owner = owners[ref];
  const offered: AgentAction[] = [];
  if (lane === "agent-review") offered.push("review");
  if (lane === "ready") offered.push("merge");
  // Human review moves on through Slack: ask each reviewer once, then bump the asks still waiting.
  if (lane === "human-review") offered.push(approvalStep(boardCard.approval));
  // Only the newest request can run.
  const busy = AGENT_ACTIONS.find((action) => requests[action] === "running") ?? null;

  const ci = ciParts(boardCard, target, owner, busy);
  const showsAgent = AGENT_LANES.includes(lane);
  const approvals = APPROVAL_LANES.includes(lane) ? approvalsParts(boardCard, lane) : null;
  const rows = [
    ci.row,
    showsAgent ? agentRow(boardCard.agentReview, requests.review) : null,
    approvals?.row ?? null,
    lane === "human-review" ? slackRow(boardCard.approval, now) : null,
  ].filter((candidate): candidate is RowView => candidate !== null);

  // A stopped request needs you; its step offers it again. A stopped CI fix is the CI row's or its own notice.
  const stalled = (["review", "ask-approval", "bump", "merge"] as const).filter((action) => requests[action] === "stalled").map((action) => notice("warn", STEPS[action].stalled));
  const notices = [...ci.notices, ...stalled, ...(approvals?.notices ?? [])];

  // A step's request shows where its button was, so the card keeps its shape; a CI fix, in the CI row it was asked from.
  const running = busy && busy !== "fix-ci" ? STEPS[busy].running : null;

  const close: ActionView = { action: "close", label: "Close Pull Request…", hint: "Close this PR on GitHub", running: null, confirm: CONFIRMS.close!(target), stalled: false };
  return { ...cardBase(boardCard.pr, now), rows, notices, ...sessionParts(target, owner, offered, busy, requests), running, close };
}

function mergedCard(pr: PullRequest, owners: Board["owners"], now: Date): CardView {
  const ref = `${pr.repo}#${pr.number}`;
  return { ...cardBase(pr, now), rows: [], notices: [], ...sessionParts({ ref, approval: null }, owners[ref], [], null, undefined), running: null, close: null };
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
