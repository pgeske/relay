import type { SessionStatus } from "../server/sessions.ts";
import type { PullRequest } from "./github.ts";
import type { Board, CiState, Lane } from "./lanes.ts";
import { followsSession, projectPaths, taskRef, type Project, type RelatedTask, type Task, type TaskEvent, type TaskPr, type TaskRelations, type TaskSession, type TaskStage, type WorkstreamSummary } from "./taskStore.ts";
import { timeAgo, type Confirm, type Tone } from "./view.ts";

/**
 * The Tasks board: every task you have in flight, in a column per stage, so a glance says how close
 * each one is to done, and each card says whose move it is. Like the PR board, everything a card says
 * and offers is decided here; the app only lays it out.
 */

/**
 * Columns in the order work moves (Relay Board stacks them top to bottom): a task sits in its stage's column while
 * it moves along, until its agent delivers (Ready to ship), then in Shipped once you ship it. One that stopped until
 * someone acts sits in Blocked, its pill saying who: you (an answer, a plan to approve, a PR to move along) or
 * others (a team, reviewers). So does one you blocked, until you unblock it.
 */
export type TaskColumn = "idea" | "research" | "plan" | "doing" | "ship" | "blocked" | "done";

const COLUMNS: { id: TaskColumn; title: string; hint: string }[] = [
  { id: "idea", title: "Ideas", hint: "Not started yet" },
  { id: "research", title: "Research", hint: "Finding out what it takes" },
  { id: "plan", title: "Plan", hint: "Deciding how to do it" },
  { id: "doing", title: "Doing", hint: "Making the change" },
  { id: "ship", title: "Ready to ship", hint: "Its agent delivered: look it over, then ship it" },
  { id: "blocked", title: "Blocked", hint: "Stopped until you or someone else acts, or set aside until you unblock it" },
  { id: "done", title: "Shipped", hint: "Shipped in the last two weeks" },
];

/**
 * Whose move a task waits on, said at the top of its card: you (a plan to approve, a question, a PR
 * to move along, an agent that stopped, a delivery to ship), its agent while it works, nobody because
 * something is moving it along on its own (a rollout, CI), anyone else (a team, reviewers), or nobody
 * at all: you blocked it, no session is open, or it hasn't started.
 */
export type Turn = "you" | "agent" | "progress" | "others" | "blocked" | "idle" | "idea" | "done";

const TURN_LABELS: Record<Turn, string> = {
  you: "Needs you",
  agent: "Agent working",
  progress: "In progress",
  others: "Waiting on others",
  blocked: "Blocked",
  idle: "Idle",
  idea: "Not started",
  done: "Shipped",
};

/** A column's cards, top to bottom: your move first, then what's moving, then others', then what's parked. */
const TURN_ORDER: Turn[] = ["you", "agent", "progress", "others", "blocked", "idle", "idea", "done"];

const DONE_SHOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** What a task card's controls ask relay's server: `POST /api/board/tasks/actions/<action>` with the card's `id`. */
export const TASK_ACTIONS = ["start", "approve-plan", "open", "refresh", "ship", "send-back", "block", "resume", "unblock", "done", "reopen", "delete", "add-dependency", "remove-dependency"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
/** What an untracked session's controls ask: the same endpoint, with the session's `sessionFile`. */
export const SESSION_ACTIONS = ["open-session", "track", "dismiss", "close-session"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const STAGE_LABELS: Record<TaskStage, string> = { idea: "Idea", research: "Research", plan: "Plan", doing: "Doing", done: "Shipped" };

/** PR lanes as a task card's PR lines word them. */
const PR_LANES: Record<Lane | "merged", { text: string; tone: Tone }> = {
  draft: { text: "Draft", tone: "muted" },
  "agent-review": { text: "Agent review", tone: "link" },
  "changes-requested": { text: "Changes requested", tone: "bad" },
  "human-review": { text: "Human review", tone: "wait" },
  "approved-blocked": { text: "Approved · blocked", tone: "warn" },
  ready: { text: "Ready to merge", tone: "ok" },
  merged: { text: "Merged", tone: "ok" },
};

/** What an open session is doing, as the board reads it from its relay tab. */
export interface TaskSessionInfo {
  sessionFile: string;
  title: string;
  cwd: string | null;
  /** Where it runs in relay; null when no tab has it open. */
  live: { paneId: string; windowId: string; status: SessionStatus } | null;
  /** When its log last changed; for an idle session, when its agent stopped. */
  activeAt: string | null;
}

export interface TaskInputs {
  tasks: Task[];
  relations: Map<number, TaskRelations>;
  projects: Project[];
  events: Map<number, TaskEvent[]>;
  sessions: TaskSession[];
  /** Every session a task links to, and every open one, by session file. */
  sessionInfo: Map<string, TaskSessionInfo>;
  prs: Map<string, TaskPr>;
  /** The PR board, for where each task's PRs are; null when GitHub couldn't be read yet. */
  board: Board | null;
  /** Open sessions you said aren't a task. */
  dismissed: Set<string>;
  /** The workstream relay's model put each task in, by task id: names from the broadest down, or null for none. */
  workstreams: Map<number, string[] | null>;
  /** Each top-level workstream's one-line summary, by its name, as relay's model wrote it. */
  summaries: Map<string, WorkstreamSummary>;
  /** Short versions of long status lines and reasons, keyed by the text each shortens. */
  briefs: Map<string, string>;
  now: Date;
}

export interface TaskActionView {
  action: TaskAction | SessionAction;
  label: string;
  hint: string;
  /** What the card says once the session took it on; null for controls that don't start anything. */
  running: string | null;
  confirm: Confirm | null;
  stalled: boolean;
}

/** Whose move it is, at the top of a card. */
export interface TurnView {
  id: Turn;
  /** "Needs you", "Agent working". */
  label: string;
  /** What exactly it waits on, when the label doesn't say it all, like "Plan ready for your approval". */
  reason: string | null;
  /** How long it's been so, like "12m"; null when that says nothing. */
  since: string | null;
}

export interface TaskPrView {
  ref: string;
  repoName: string;
  number: number;
  title: string;
  url: string;
  /** Its PR board lane, in words; "Unknown" while GitHub can't be read. */
  state: string;
  tone: Tone;
}

export interface TaskSessionView {
  title: string;
  state: "open" | "working" | "closed";
  open: TaskActionView;
  /** The task's other sessions, besides this one. */
  others: number;
}

export interface PlanView {
  text: string;
  at: string;
  /** Which plan this is, so approving it can't approve a newer one you haven't read. */
  revision: string;
  /** It waits for your approval. */
  awaiting: boolean;
  approved: boolean;
}

/** What the agent delivered, for you to look over before you ship it. */
export interface FinishView {
  /** What the agent did and how it checked; null when it said nothing. */
  text: string | null;
  at: string;
  /** It waits for you to ship it or send it back. */
  awaiting: boolean;
}

export interface HistoryView {
  at: string;
  text: string;
  stage: string;
  /** Relay's watcher reported it, not the agent. */
  auto: boolean;
}

/** Another task a card names: one it depends on or one that depends on it, in that task's color. */
export interface RelatedTaskView extends RelatedTask {
  hue: number;
}

export interface TaskCardView {
  id: number;
  /** "T-12": what the card's actions and the CLI name. */
  ref: string;
  title: string;
  details: string | null;
  project: ProjectRefView | null;
  /** Its color, 0 to 7, so its card and its PRs on the PR board match. */
  hue: number;
  dependsOn: RelatedTaskView[];
  neededBy: RelatedTaskView[];
  stage: TaskStage;
  stageLabel: string;
  turn: TurnView;
  /** The latest report, and when; `auto` when relay's watcher made it because the agent forgot. */
  status: { text: string; ago: string; auto: boolean } | null;
  plan: PlanView | null;
  finish: FinishView | null;
  prs: TaskPrView[];
  session: TaskSessionView | null;
  /** The card's one step forward: approve a plan, start, resume, answer. */
  steps: TaskActionView[];
  /** The rest of its controls, for its "…" menu. */
  menu: TaskActionView[];
  history: HistoryView[];
  updatedAt: string;
  /** For sorting a column: how long it's been waiting (oldest first while it waits on someone), else most recent first. */
  sortKey: string;
  /** Where it stands in a few words, for a one-line row: what it waits on, else its latest status. */
  brief: string;
}

export interface UntrackedSessionView {
  sessionFile: string;
  title: string;
  /** Its folder, with ~ for your home. */
  folder: string | null;
  state: SessionStatus;
  activeAgo: string | null;
  open: TaskActionView;
  track: TaskActionView;
  dismiss: TaskActionView;
  close: TaskActionView;
}

export interface TaskColumnView {
  id: TaskColumn;
  title: string;
  hint: string;
  cards: TaskCardView[];
}

/** The project a task is in: its own name, and its path from the top ("Relay/Sidebar"). */
export interface ProjectRefView {
  id: number;
  name: string;
  path: string;
}

export interface ProjectView extends ProjectRefView {
  /** The project it sits in; null for a top-level one. */
  parentId: number | null;
  /** It and every project under it, whose tasks it shows. */
  ids: number[];
  /** Its tasks not done yet, and how many of them need you, counting its subprojects'. */
  open: number;
  needsYou: number;
}

export interface TaskBoardView {
  columns: TaskColumnView[];
  /** Open sessions no task knows about, most recent first. */
  untracked: UntrackedSessionView[];
  projects: ProjectView[];
  needsYou: number;
  overview: OverviewView;
}

/**
 * The board at a glance, for when you come back to it: what needs you, best first, then each
 * workstream relay found with its open tasks, so you see what you're doing without reading every
 * card. It names cards by id; their full shape is in `columns`.
 */
export interface OverviewView {
  upNext: UpNextView[];
  workstreams: WorkstreamView[];
  /** Open tasks not waiting on you: moving along (an agent working, or on their own), waiting on others, or parked (set aside, idle, not started). */
  counts: { moving: number; waiting: number; parked: number };
}

/** A task that needs you, and why it's ranked where it is ("Unblocks T-4 · waiting 2h"). */
export interface UpNextView {
  id: number;
  why: string;
  /** The workstream it's part of, like "Search › Indexing"; null when it's in none yet. */
  workstream: string | null;
}

/**
 * A broad effort relay's model found among your tasks, with its open tasks and its parts', the
 * most pressing first; or (`id` "") the open tasks it put in none.
 */
export interface WorkstreamView {
  /** Its name, which stays put while relay keeps the workstream, so the app can remember it folded. */
  id: string;
  name: string;
  /** Where it stands, in a line; null until relay's model writes one, and for the tasks in none. */
  summary: string | null;
  /** Its open tasks in none of its parts, as cards' ids, your move first. */
  taskIds: number[];
  parts: WorkstreamPartView[];
  /** Its open tasks that need you, its parts' included. */
  needsYou: number;
  /** Its tasks shipped in the last week, its parts' included. */
  shipped: number;
}

/** A distinct piece of a workstream, like Indexing in Search rollout, with its open tasks. */
export interface WorkstreamPartView {
  /** "Workstream › Part". */
  id: string;
  name: string;
  taskIds: number[];
}

/** How a PR card on the PR board names the task it's part of. */
export interface TaskChipView {
  id: number;
  ref: string;
  title: string;
  hue: number;
}

const HUES = 8;

function withHue(task: RelatedTask): RelatedTaskView {
  return { ...task, hue: taskHue(task.id) };
}

export function taskHue(id: number): number {
  // Neighboring ids land far apart on the color wheel.
  return (id * 3) % HUES;
}

/** Where a PR is on the PR board, and what holds it there. */
interface PrPlace {
  pr: PullRequest;
  lane: Lane | "merged";
  ci: CiState;
  mergeBlocker: string | null;
}

/** Where each of your PRs is on the PR board, keyed by "owner/repo#number". */
function prPlaces(board: Board | null): Map<string, PrPlace> {
  const places = new Map<string, PrPlace>();
  if (!board) return places;
  for (const [lane, cards] of Object.entries(board.lanes) as [Lane, Board["lanes"][Lane]][]) {
    for (const card of cards) places.set(`${card.pr.repo}#${card.pr.number}`, { pr: card.pr, lane, ci: card.ci, mergeBlocker: card.mergeBlocker });
  }
  for (const pr of board.merged) places.set(`${pr.repo}#${pr.number}`, { pr, lane: "merged", ci: "none", mergeBlocker: null });
  return places;
}

/** A task's PR as placing the task reads it: its lane, and for an approved one, what still stops it merging. */
export interface TaskPrPlace {
  ref: string;
  lane: Lane | "merged" | null;
  ci?: CiState;
  mergeBlocker?: string | null;
}

/**
 * Why an approved PR can't merge yet, and whose move that is: red CI or conflicts need someone to fix
 * them (you, or the agent you ask); running CI, a merge gate, or branch rules wait on something else.
 */
function approvedButBlocked(pr: TaskPrPlace): { turn: Turn; reason: string } {
  const ref = short(pr.ref);
  if (pr.ci === "failed") return { turn: "you", reason: `${ref}: CI failed` };
  if (pr.mergeBlocker === "Merge conflicts" || pr.mergeBlocker === "Behind its base branch") return { turn: "you", reason: `${ref}: ${pr.mergeBlocker.toLowerCase()}` };
  if (pr.mergeBlocker) return { turn: "others", reason: `${ref}: ${pr.mergeBlocker.charAt(0).toLowerCase()}${pr.mergeBlocker.slice(1)}` };
  return { turn: "others", reason: `${ref}: CI running` };
}

function short(ref: string): string {
  // "acme/api#12" → "api#12": cards are narrow.
  return ref.replace(/^[^/]+\//, "");
}

function since(iso: string | null, now: Date): string | null {
  return iso ? timeAgo(iso, now).replace(/ ago$/, "") : null;
}

interface Placement {
  turn: Turn;
  /** What exactly it waits on, when the turn's label doesn't say it all. */
  reason: string | null;
  since: string | null;
  /** Its agent delivered, and it waits for you to ship it or send it back. */
  delivered: boolean;
  /** Your move takes a click or a quick look: shipping a delivery, approving a plan, merging a PR. */
  quick: boolean;
  /** Since when it's been so, for sorting. */
  at: string;
}

/**
 * Whose move a task waits on. One you blocked stays blocked, whatever its sessions do, until you
 * unblock it; its card says the stage it was in. Otherwise a working agent needs nothing from you yet, so that comes first.
 * Then a task its agent delivered, for you to look over and ship. Then what the agent said it's
 * waiting on (your approval of its plan, your answer), then PRs that need a move from you, then
 * what's moving along on its own and what's waiting elsewhere. "Needs you" means nothing moves until
 * you do: CI that's still running or a rollout the agent is watching isn't your move. An agent that
 * stopped without saying anything is waiting on you too: that's how a task you meant to finish in
 * fifteen minutes gets forgotten.
 */
export function placeTask(task: Task, sessions: TaskSessionLink[], prs: TaskPrPlace[], now: Date): Placement {
  const ago = (iso: string | null) => since(iso, now);
  const place = (turn: Turn, reason: string | null, at: string, sinceAt: string | null = null): Placement => ({ turn, reason, since: ago(sinceAt), delivered: false, quick: false, at });
  if (task.stage === "done") return place("done", timeAgo(task.doneAt ?? task.updatedAt, now), task.doneAt ?? task.updatedAt);
  if (task.pausedAt) return place("blocked", `Was in ${STAGE_LABELS[task.stage]}`, task.pausedAt, task.pausedAt);

  // What a session that moved on to another task is doing now is that task's business.
  const onTask = sessions.filter((session) => session.onTask);
  // A question waiting on you comes first: until you answer it, nothing on the task moves.
  const asking = onTask.find((session) => session.live?.status === "asking");
  if (asking) return place("you", "Agent is asking you something", asking.activeAt ?? task.updatedAt);
  const working = onTask.find((session) => session.live?.status === "working");
  if (working) return place("agent", null, working.activeAt ?? task.updatedAt);
  if (task.finishedAt) return { ...place("you", "Look it over, then ship it", task.finishedAt, task.finishedAt), delivered: true, quick: true };

  if (task.approvePlan && task.plan && !task.planApprovedAt) return { ...place("you", "Plan ready for your approval", task.planAt ?? task.updatedAt, task.planAt), quick: true };
  if (task.blockedOn === "me") return place("you", task.blockedReason, task.blockedAt ?? task.updatedAt, task.blockedAt);
  const open = prs.filter((pr) => pr.lane !== null && pr.lane !== "merged");
  const ready = open.find((pr) => pr.lane === "ready");
  if (ready) return { ...place("you", `${short(ready.ref)} is ready to merge`, task.updatedAt), quick: true };
  const approved = open.filter((pr) => pr.lane === "approved-blocked").map(approvedButBlocked);
  const fixNeeded = approved.find((blocker) => blocker.turn === "you");
  if (fixNeeded) return place("you", fixNeeded.reason, task.updatedAt);
  const feedbackPr = open.find((pr) => pr.lane === "changes-requested");
  if (feedbackPr) return place("you", `${short(feedbackPr.ref)} has feedback to address`, task.updatedAt);
  if (task.blockedOn === "others" || task.blockedOn === "progress") return place("others", task.blockedReason, task.blockedAt ?? task.updatedAt, task.blockedAt);
  // A PR waiting for a click from you comes before one waiting on CI or reviewers.
  const needsReview = open.find((pr) => pr.lane === "agent-review");
  if (needsReview) return place("you", `${short(needsReview.ref)} needs an agent review`, task.updatedAt);
  const waiting = approved[0];
  if (waiting) return place(waiting.turn, waiting.reason, task.updatedAt);
  const inReview = open.find((pr) => pr.lane === "human-review");
  if (inReview) return place("others", `${short(inReview.ref)} is waiting on reviewers`, task.updatedAt);

  const idle = onTask.filter((session) => session.live?.status === "idle").toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))[0];
  if (idle) return place("you", "The agent stopped", idle.activeAt ?? task.updatedAt, idle.activeAt);

  // A session that only made the task and moved on (say, an agent handing it off) hasn't started it.
  if (onTask.length === 0 && task.stage === "idea") return place("idea", null, task.createdAt);
  const last = sessions.map((session) => session.activeAt ?? "").toSorted().at(-1) || task.updatedAt;
  const why = onTask.length < sessions.length && sessions.some((session) => session.live) ? "Its session moved on to another task" : sessions.length ? "No session open" : "No session yet";
  return place("idle", why, last, last);
}

/** A session of a task's, and whether the task is still the one it's on. */
export interface TaskSessionLink extends TaskSessionInfo {
  onTask: boolean;
}

/** The session a task's card shows and its controls act on: one on it and working or asking you, else one on it and open (the latest to stop), else one open elsewhere, else the latest to run. */
export function primarySession(sessions: TaskSessionLink[]): TaskSessionLink | null {
  const rank = (session: TaskSessionLink) => (session.live ? 1 : 0) + (session.onTask && session.live ? 1 : 0) + (session.onTask && session.live && session.live.status !== "idle" ? 1 : 0);
  return sessions.toSorted((a, b) => rank(b) - rank(a) || (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))[0] ?? null;
}

/** Each task's sessions. A session that moved on to another task stays among this one's, as history. */
export function sessionsByTask(links: TaskSession[], sessionInfo: Map<string, TaskSessionInfo>): Map<number, TaskSessionLink[]> {
  const current = new Map<string, TaskSession>();
  for (const link of links) {
    const latest = current.get(link.sessionFile);
    if (!latest || link.linkedAt > latest.linkedAt) current.set(link.sessionFile, link);
  }
  const byTask = new Map<number, TaskSessionLink[]>();
  for (const link of links) {
    const info = sessionInfo.get(link.sessionFile);
    if (!info) continue;
    byTask.set(link.taskId, [...(byTask.get(link.taskId) ?? []), { ...info, onTask: current.get(link.sessionFile)?.taskId === link.taskId }]);
  }
  return byTask;
}

function action(name: TaskAction | SessionAction, label: string, hint: string, extra: Partial<TaskActionView> = {}): TaskActionView {
  return { action: name, label, hint, running: null, confirm: null, stalled: false, ...extra };
}

/** omp starts session titles with a nerd-font icon, which no system font draws. */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu;

function sessionTitle(title: string): string {
  return title.replace(PRIVATE_USE, "").trim() || "Untitled session";
}

/** A folder with ~ for your home, as you'd type it. */
function displayFolder(cwd: string | null, home: string): string | null {
  if (cwd === null) return null;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function openAction(session: TaskSessionInfo): TaskActionView {
  return action("open", "Open in Terminal", session.live ? "Show this session in your terminal" : "Reopen this session in a new relay tab");
}

const EVENT_TEXT: Record<TaskEvent["kind"], (event: TaskEvent) => string> = {
  created: (event) => (event.text ? `Created: ${event.text}` : "Created"),
  started: () => "Started a session",
  stage: (event) => `Moved to ${STAGE_LABELS[event.stage]}`,
  status: (event) => event.text ?? "Status update",
  blocked: (event) => `Blocked${event.text ? `: ${event.text}` : ""}`,
  "in-progress": (event) => `In progress${event.text ? `: ${event.text}` : ""}`,
  unblocked: () => "Unblocked",
  plan: () => "Wrote a plan",
  "plan-approved": () => "You approved the plan",
  finished: (event) => (event.text ? `Delivered: ${event.text}` : "Delivered"),
  "sent-back": () => "You sent it back: not yet",
  paused: () => "You blocked it",
  resumed: () => "You unblocked it",
  done: () => "Shipped",
  reopened: () => "Reopened",
};

/** How many history lines a card's details show. */
const HISTORY_SHOWN = 30;

function taskCard(task: Task, inputs: TaskInputs, places: Map<string, PrPlace>, sessions: TaskSessionLink[], projects: Map<number, ProjectRefView>): { card: TaskCardView; column: TaskColumn; quick: boolean } {
  const { now } = inputs;
  const linked = [...inputs.prs.values()].filter((pr) => pr.taskId === task.id).map((pr) => `${pr.repo}#${pr.number}`);
  const prs = linked.map((ref) => ({ ref, place: places.get(ref) ?? null }));
  const placement = placeTask(task, sessions, prs.map(({ ref, place }) => ({ ref, lane: place?.lane ?? null, ci: place?.ci, mergeBlocker: place?.mergeBlocker })), now);
  const primary = primarySession(sessions);
  const project = task.projectId !== null ? projects.get(task.projectId) : undefined;
  const ref = taskRef(task.id);

  const steps: TaskActionView[] = [];
  if (task.pausedAt) {
    steps.push(
      action("resume", "Resume", primary ? "Unblock it and show its latest session in your terminal" : `Unblock it and open a new session${task.cwd ? ` in ${task.cwd}` : ""} on it`, {
        running: primary ? null : "Starting…",
      }),
    );
    // While the agent works, the card says so, so its footer stays free for a step forward.
  } else if (task.approvePlan && task.plan && !task.planApprovedAt && task.stage !== "done" && placement.turn !== "agent") {
    steps.push(
      action("approve-plan", "Approve Plan", "Tell the task's session to carry out its plan", {
        confirm: { title: `Approve the plan for ${ref}?`, message: "Tells the task's session to go ahead and carry it out.", button: "Approve", destructive: false },
        running: "Agent working…",
      }),
    );
  } else if (placement.delivered) {
    // No confirm: Reopen undoes it, and omp keeps the closed sessions' conversations.
    steps.push(
      action("ship", "Ship It", "Move it to Shipped and close its idle session tabs; omp keeps their conversations"),
      action("send-back", "Not Yet", "Put it back in progress and show its session in your terminal, so you can tell the agent what's missing"),
    );
  } else if (placement.turn === "idea" || (placement.turn === "idle" && !primary?.onTask)) {
    steps.push(action("start", "Start", `Open a new session${task.cwd ? ` in ${task.cwd}` : ""} and hand it this task`, { running: "Starting…" }));
  }

  const menu: TaskActionView[] = [];
  // The watcher only sees the session; Refresh also has the agent check what changed outside it, like a draft you sent.
  const onTaskSession = primarySession(sessions.filter((session) => session.onTask));
  if (followsSession(task) && onTaskSession) {
    const hint =
      onTaskSession.live?.status === "working"
        ? "Have relay read its working session now and update the card"
        : `Ask its session to check where the task stands and update the card${onTaskSession.live ? "" : ", reopening it in a new relay tab"}`;
    menu.push(action("refresh", "Refresh Status", hint));
  }
  if (task.stage === "done") menu.push(action("reopen", "Reopen Task", "Put it back in progress"));
  else if (!placement.delivered) menu.push(action("done", "Mark Shipped", "Move it to Shipped and close its idle sessions"));
  if (task.pausedAt) menu.push(action("unblock", "Unblock", "Put it back in its stage without opening a session"));
  else if (placement.turn !== "done" && placement.turn !== "idea" && !placement.delivered) menu.push(action("block", "Mark Blocked", "Move it to Blocked, out of the way, until you unblock it"));
  menu.push(
    action("delete", "Delete Task…", "Forget the task; its sessions and PRs stay", {
      confirm: { title: `Delete ${ref}?`, message: "The board forgets the task and its history. Its sessions and pull requests stay.", button: "Delete", destructive: true },
    }),
  );

  const card: TaskCardView = {
    id: task.id,
    ref,
    title: task.title,
    dependsOn: (inputs.relations.get(task.id)?.dependsOn ?? []).map(withHue),
    neededBy: (inputs.relations.get(task.id)?.neededBy ?? []).map(withHue),
    details: task.details,
    project: project ?? null,
    hue: taskHue(task.id),
    stage: task.stage,
    stageLabel: STAGE_LABELS[task.stage],
    turn: { id: placement.turn, label: TURN_LABELS[placement.turn], reason: placement.reason, since: placement.since },
    status: task.status ? { text: task.status, ago: timeAgo(task.statusAt ?? task.updatedAt, now), auto: task.autoReportedAt !== null } : null,
    plan: task.plan
      ? {
          text: task.plan,
          at: task.planAt ?? task.updatedAt,
          revision: task.planAt ?? "",
          awaiting: task.approvePlan && !task.planApprovedAt,
          approved: task.planApprovedAt !== null,
        }
      : null,
    finish: task.finishNote || task.finishedAt ? { text: task.finishNote, at: task.finishedAt ?? task.doneAt ?? task.updatedAt, awaiting: placement.delivered } : null,
    prs: prs
      // Merged and closed PRs older than the PR board's Merged section drop off; while GitHub can't be read, every PR shows.
      .filter(({ place }) => place !== null || inputs.board === null)
      .map(({ ref: prRef, place }) => {
        const [repo, number] = prRef.split("#");
        const state = place ? PR_LANES[place.lane] : { text: "Unknown", tone: "muted" as Tone };
        return {
          ref: prRef,
          repoName: repo.split("/")[1] ?? repo,
          number: Number(number),
          title: place?.pr.title ?? prRef,
          url: place?.pr.url ?? `https://github.com/${repo}/pull/${number}`,
          state: state.text,
          tone: state.tone,
        };
      }),
    session: primary
      ? {
          title: sessionTitle(primary.title),
          // A session working on another task isn't working on this one.
          state: primary.live ? (primary.live.status === "working" && primary.onTask ? "working" : "open") : "closed",
          open: openAction(primary),
          others: sessions.length - 1,
        }
      : null,
    steps,
    menu,
    history: (inputs.events.get(task.id) ?? [])
      .slice(0, HISTORY_SHOWN)
      .map((event) => ({ at: event.at, text: EVENT_TEXT[event.kind](event), stage: STAGE_LABELS[event.stage], auto: event.auto })),
    updatedAt: task.updatedAt,
    sortKey: placement.at,
    brief: briefOf(task, placement, inputs.briefs),
  };
  // Stopped until someone acts, you or others, is Blocked; the stage columns hold what's moving.
  const stopped = task.pausedAt || placement.turn === "you" || placement.turn === "others";
  const column: TaskColumn = placement.delivered ? "ship" : stopped ? "blocked" : task.stage;
  return { card, column, quick: placement.quick };
}

/** A card's one-line row: what it waits on, else its latest status, in relay's short words for long ones. */
function briefOf(task: Task, placement: Placement, briefs: Map<string, string>): string {
  const shorten = (text: string | null) => (text ? (briefs.get(text) ?? text) : null);
  switch (placement.turn) {
    case "agent":
      return shorten(task.status) ?? "Working";
    case "done":
      return `Shipped ${placement.reason}`;
    case "idea":
      return "Not started";
    case "blocked":
      return "Set aside";
    default:
      return shorten(placement.reason) ?? shorten(task.status) ?? TURN_LABELS[placement.turn];
  }
}

/** Your move on top, then the agent's, then others', then what's parked. Within each, the one waiting longest first where it waits on someone; else the most recent first. */
function byTurn(a: TaskCardView, b: TaskCardView): number {
  const turns = TURN_ORDER.indexOf(a.turn.id) - TURN_ORDER.indexOf(b.turn.id);
  if (turns !== 0) return turns;
  return a.turn.id === "you" || a.turn.id === "others" ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MOVING: Turn[] = ["agent"];

/**
 * The board at a glance. Up next ranks what needs you by what it frees up: first what other tasks wait
 * on, then what takes a click (ship, approve, merge), then what's waited longest. Workstreams are as
 * relay's model grouped your tasks, each with its parts: the most pressing first, the tasks in none last.
 */
function overviewOf(open: TaskCardView[], shipped: TaskCardView[], quick: Set<number>, inputs: TaskInputs): OverviewView {
  const pathOf = (card: TaskCardView) => inputs.workstreams.get(card.id) ?? null;
  const unblocks = (card: TaskCardView) => card.neededBy.filter((task) => !task.shipped);
  const upNext = open
    .filter((card) => card.turn.id === "you")
    .toSorted((a, b) => unblocks(b).length - unblocks(a).length || Number(quick.has(b.id)) - Number(quick.has(a.id)) || a.sortKey.localeCompare(b.sortKey))
    .map((card): UpNextView => {
      const freed = unblocks(card);
      const why = [
        freed.length === 1 ? `Unblocks ${freed[0].ref}` : freed.length > 1 ? `Unblocks ${freed.length} tasks` : null,
        quick.has(card.id) ? "Takes a minute" : null,
        // A wait under a minute ("just now") says nothing worth ranking by.
        card.turn.since && card.turn.since !== "just now" ? `Waiting ${card.turn.since}` : null,
      ];
      return { id: card.id, why: why.filter(Boolean).join(" · "), workstream: pathOf(card)?.join(" › ") ?? null };
    });

  // Each workstream's open tasks, in it directly and by part, and what it shipped this week; "" holds the tasks in none.
  const groups = new Map<string, { direct: TaskCardView[]; parts: Map<string, TaskCardView[]>; shipped: number }>();
  const groupOf = (name: string) => {
    const found = groups.get(name) ?? { direct: [], parts: new Map<string, TaskCardView[]>(), shipped: 0 };
    groups.set(name, found);
    return found;
  };
  for (const card of open) {
    const path = pathOf(card);
    const group = groupOf(path?.[0] ?? "");
    if (path?.[1]) group.parts.set(path[1], [...(group.parts.get(path[1]) ?? []), card]);
    else group.direct.push(card);
  }
  const weekAgo = new Date(inputs.now.getTime() - WEEK_MS).toISOString();
  for (const card of shipped) {
    const path = pathOf(card);
    if (path && card.sortKey >= weekAgo) groupOf(path[0]).shipped++;
  }

  // Most pressing first: the one whose top task needs you, then one moving; then the one with the latest news.
  const latest = (cards: TaskCardView[]) => cards.map((card) => card.updatedAt).toSorted().at(-1)!;
  const pressing = (a: TaskCardView[], b: TaskCardView[]) => TURN_ORDER.indexOf(a[0].turn.id) - TURN_ORDER.indexOf(b[0].turn.id) || latest(b).localeCompare(latest(a));
  const found = [...groups]
    .map(([name, group]) => {
      const parts = [...group.parts].map(([part, cards]) => ({ part, cards: cards.toSorted(byTurn) })).toSorted((a, b) => pressing(a.cards, b.cards));
      const all = [...group.direct, ...parts.flatMap((part) => part.cards)].toSorted(byTurn);
      return { name, direct: group.direct.toSorted(byTurn), parts, all, shipped: group.shipped };
    })
    .filter((workstream) => workstream.all.length > 0)
    .toSorted((a, b) => Number(a.name === "") - Number(b.name === "") || pressing(a.all, b.all));
  const workstreams = found.map(
    (workstream): WorkstreamView => ({
      id: workstream.name,
      name: workstream.name || (found.length > 1 ? "Other" : "Open tasks"),
      summary: workstream.name ? (inputs.summaries.get(workstream.name)?.text ?? null) : null,
      taskIds: workstream.direct.map((card) => card.id),
      parts: workstream.parts.map(({ part, cards }) => ({ id: `${workstream.name} › ${part}`, name: part, taskIds: cards.map((card) => card.id) })),
      needsYou: workstream.all.filter((card) => card.turn.id === "you").length,
      shipped: workstream.shipped,
    }),
  );

  return {
    upNext,
    workstreams,
    counts: {
      moving: open.filter((card) => MOVING.includes(card.turn.id)).length,
      waiting: open.filter((card) => card.turn.id === "others").length,
      parked: open.filter((card) => card.turn.id === "blocked" || card.turn.id === "idle" || card.turn.id === "idea").length,
    },
  };
}

export function taskBoardView(inputs: TaskInputs, home: string): TaskBoardView {
  const { now } = inputs;
  const places = prPlaces(inputs.board);
  const paths = projectPaths(inputs.projects);
  const projects = new Map(inputs.projects.map((project) => [project.id, { id: project.id, name: project.name, path: paths.get(project.id)! }]));
  const sessionsOf = sessionsByTask(inputs.sessions, inputs.sessionInfo);

  const byColumn = new Map<TaskColumn, TaskCardView[]>(COLUMNS.map((column) => [column.id, []]));
  const quick = new Set<number>();
  for (const task of inputs.tasks) {
    if (task.stage === "done" && now.getTime() - new Date(task.doneAt ?? task.updatedAt).getTime() > DONE_SHOWN_MS) continue;
    const placed = taskCard(task, inputs, places, sessionsOf.get(task.id) ?? [], projects);
    byColumn.get(placed.column)!.push(placed.card);
    if (placed.quick) quick.add(task.id);
  }
  for (const cards of byColumn.values()) cards.sort(byTurn);

  const tracked = new Set(inputs.sessions.map((link) => link.sessionFile));
  const untracked = [...inputs.sessionInfo.values()]
    .filter((session) => session.live && !tracked.has(session.sessionFile) && !inputs.dismissed.has(session.sessionFile))
    .toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))
    .map(
      (session): UntrackedSessionView => ({
        sessionFile: session.sessionFile,
        title: sessionTitle(session.title),
        folder: displayFolder(session.cwd, home),
        state: session.live!.status,
        activeAgo: session.activeAt ? timeAgo(session.activeAt, now) : null,
        open: action("open-session", "Open Session", "Show this session in your terminal"),
        track: action("track", "Track as Task", "Ask the session to register what it's working on as a task", {
          running: "Registering…",
          stalled: false,
        }),
        dismiss: action("dismiss", "Not a Task", "Stop offering to track this session"),
        // Closing saves the conversation, so only a session in the middle of something asks first.
        close: action("close-session", "Close Session", "Close this session's relay tab; omp keeps the conversation, so you can resume it", {
          confirm:
            session.live!.status === "working"
              ? { title: `Close "${sessionTitle(session.title)}"?`, message: "It's working right now; closing stops what it's doing. omp keeps the conversation, so you can resume it.", button: "Close Session", destructive: true }
              : session.live!.status === "asking"
                ? { title: `Close "${sessionTitle(session.title)}"?`, message: "It's waiting on your answer to a question. omp keeps the conversation, so you can resume it.", button: "Close Session", destructive: true }
                : null,
        }),
      }),
    );

  const columns = COLUMNS.map(({ id, title, hint }) => ({ id, title, hint, cards: byColumn.get(id)! }));
  const open = columns.filter((column) => column.id !== "done").flatMap((column) => column.cards);
  const needsYou = open.filter((card) => card.turn.id === "you");

  return {
    columns,
    untracked,
    projects: inputs.projects.map((project) => {
      const ids = projectSubtree(project.id, inputs.projects);
      return {
        ...projects.get(project.id)!,
        parentId: project.parentId,
        ids,
        open: open.filter((card) => card.project !== null && ids.includes(card.project.id)).length,
        needsYou: needsYou.filter((card) => card.project !== null && ids.includes(card.project.id)).length,
      };
    }),
    needsYou: needsYou.length,
    overview: overviewOf(open, byColumn.get("done")!, quick, inputs),
  };
}

/** A project's id and those of every project under it, at any depth. */
function projectSubtree(id: number, projects: Project[]): number[] {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    for (const project of projects) if (project.parentId === ids[i]) ids.push(project.id);
  }
  return ids;
}

/** The task each PR is part of, as PR cards name it, keyed by "owner/repo#number". */
export function taskChips(tasks: Task[], prs: Map<string, TaskPr>): Map<string, TaskChipView> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const chips = new Map<string, TaskChipView>();
  for (const [key, pr] of prs) {
    const task = byId.get(pr.taskId);
    if (task) chips.set(key, { id: task.id, ref: taskRef(task.id), title: task.title, hue: taskHue(task.id) });
  }
  return chips;
}
