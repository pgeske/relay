import type { PullRequest } from "./github.ts";
import type { Board, Lane } from "./lanes.ts";
import { projectPaths, taskRef, type Project, type Task, type TaskEvent, type TaskPr, type TaskSession, type TaskStage } from "./taskStore.ts";
import { timeAgo, type Confirm, type Tone } from "./view.ts";

/**
 * The Tasks board: every task you have in flight, in a column per stage, so a glance says how close
 * each one is to done, and each card says whose move it is. Like the PR board, everything a card says
 * and offers is decided here; the app only lays it out.
 */

/**
 * Columns in the order work moves (Relay Board stacks them top to bottom): a task sits in its stage's column until its agent
 * delivers (Ready to ship), then in Shipped once you ship it. One waiting on others (a team, reviewers) sits in Blocked,
 * since nobody here can move it, and so does one you blocked, until you unblock it.
 */
export type TaskColumn = "idea" | "research" | "plan" | "doing" | "rollout" | "ship" | "blocked" | "done";

const COLUMNS: { id: TaskColumn; title: string; hint: string }[] = [
  { id: "idea", title: "Ideas", hint: "Not started yet" },
  { id: "research", title: "Research", hint: "Finding out what it takes" },
  { id: "plan", title: "Plan", hint: "Deciding how to do it" },
  { id: "doing", title: "Doing", hint: "Making the change" },
  { id: "rollout", title: "Rollout", hint: "Rolling it out or verifying it" },
  { id: "ship", title: "Ready to ship", hint: "Its agent delivered: look it over, then ship it" },
  { id: "blocked", title: "Blocked", hint: "Waiting on others, or set aside until you unblock it" },
  { id: "done", title: "Shipped", hint: "Shipped in the last two weeks" },
];

/**
 * Whose move a task waits on, said at the top of its card: you (a plan to approve, a question, a PR
 * to move along, an agent that stopped, a delivery to ship), its agent while it works, anyone else (a
 * team, reviewers), or nobody: you blocked it, no session is open, or it hasn't started.
 */
export type Turn = "you" | "agent" | "others" | "blocked" | "idle" | "idea" | "done";

const TURN_LABELS: Record<Turn, string> = {
  you: "Needs you",
  agent: "Agent working",
  others: "Waiting on others",
  blocked: "Blocked",
  idle: "Idle",
  idea: "Not started",
  done: "Shipped",
};

/** A column's cards, top to bottom: your move first, then the agent's, then others', then what's parked. */
const TURN_ORDER: Turn[] = ["you", "agent", "others", "blocked", "idle", "idea", "done"];

const DONE_SHOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** What a task card's controls ask relay's server: `POST /api/board/tasks/actions/<action>` with the card's `id`. */
export const TASK_ACTIONS = ["start", "approve-plan", "open", "ship", "send-back", "block", "resume", "unblock", "done", "reopen", "delete"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
/** What an untracked session's controls ask: the same endpoint, with the session's `sessionFile`. */
export const SESSION_ACTIONS = ["open-session", "track", "dismiss", "close-session"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const STAGE_LABELS: Record<TaskStage, string> = { idea: "Idea", research: "Research", plan: "Plan", doing: "Doing", rollout: "Rollout", done: "Shipped" };

/** PR lanes as a task card's PR lines word them. */
const PR_LANES: Record<Lane | "merged", { text: string; tone: Tone }> = {
  draft: { text: "Draft", tone: "muted" },
  "agent-review": { text: "Agent review", tone: "link" },
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
  live: { paneId: string; windowId: string; status: "working" | "idle" } | null;
  /** When its log last changed; for an idle session, when its agent stopped. */
  activeAt: string | null;
}

export interface TaskInputs {
  tasks: Task[];
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
  /** Which session it is, for opening it in the board's Chats. */
  sessionFile: string;
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

export interface TaskCardView {
  id: number;
  /** "T-12": what the card's actions and the CLI name. */
  ref: string;
  title: string;
  details: string | null;
  project: ProjectRefView | null;
  /** Its color, 0 to 7, so its card and its PRs on the PR board match. */
  hue: number;
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
}

export interface UntrackedSessionView {
  sessionFile: string;
  title: string;
  /** Its folder, with ~ for your home. */
  folder: string | null;
  state: "working" | "idle";
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
}

/** How a PR card on the PR board names the task it's part of. */
export interface TaskChipView {
  id: number;
  ref: string;
  title: string;
  hue: number;
}

const HUES = 8;

export function taskHue(id: number): number {
  // Neighboring ids land far apart on the color wheel.
  return (id * 3) % HUES;
}

/** Where a PR is on the PR board. */
interface PrPlace {
  pr: PullRequest;
  lane: Lane | "merged";
}

/** Where each of your PRs is on the PR board, keyed by "owner/repo#number". */
function prPlaces(board: Board | null): Map<string, PrPlace> {
  const places = new Map<string, PrPlace>();
  if (!board) return places;
  for (const [lane, cards] of Object.entries(board.lanes) as [Lane, Board["lanes"][Lane]][]) {
    for (const card of cards) places.set(`${card.pr.repo}#${card.pr.number}`, { pr: card.pr, lane });
  }
  for (const pr of board.merged) places.set(`${pr.repo}#${pr.number}`, { pr, lane: "merged" });
  return places;
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
  /** Since when it's been so, for sorting. */
  at: string;
}

/**
 * Whose move a task waits on. One you blocked stays blocked, whatever its sessions do, until you
 * unblock it; its card says the stage it was in. Otherwise a working agent needs nothing from you yet, so that comes first.
 * Then a task its agent delivered, for you to look over and ship. Then what the agent
 * said it's waiting on (your approval of its plan, your answer), then PRs that
 * need a click from you, then what it's waiting on elsewhere. An agent that stopped without saying
 * anything is waiting on you too: that's how a task you meant to finish in fifteen minutes gets forgotten.
 */
export function placeTask(
  task: Task,
  sessions: TaskSessionLink[],
  prs: { ref: string; lane: Lane | "merged" | null }[],
  now: Date,
): Placement {
  const ago = (iso: string | null) => since(iso, now);
  const place = (turn: Turn, reason: string | null, at: string, sinceAt: string | null = null): Placement => ({ turn, reason, since: ago(sinceAt), delivered: false, at });
  if (task.stage === "done") return place("done", timeAgo(task.doneAt ?? task.updatedAt, now), task.doneAt ?? task.updatedAt);
  if (task.pausedAt) return place("blocked", `Was in ${STAGE_LABELS[task.stage]}`, task.pausedAt, task.pausedAt);

  // What a session that moved on to another task is doing now is that task's business.
  const onTask = sessions.filter((session) => session.onTask);
  const working = onTask.find((session) => session.live?.status === "working");
  if (working) return place("agent", null, working.activeAt ?? task.updatedAt);
  // Its agent delivered: nothing else matters until you ship it or send it back.
  if (task.finishedAt) return { ...place("you", "Look it over, then ship it", task.finishedAt, task.finishedAt), delivered: true };

  if (task.approvePlan && task.plan && !task.planApprovedAt) return place("you", "Plan ready for your approval", task.planAt ?? task.updatedAt, task.planAt);
  if (task.blockedOn === "me") return place("you", task.blockedReason, task.blockedAt ?? task.updatedAt, task.blockedAt);
  const open = prs.filter((pr) => pr.lane !== null && pr.lane !== "merged");
  const ready = open.find((pr) => pr.lane === "ready");
  if (ready) return place("you", `${short(ready.ref)} is ready to merge`, task.updatedAt);
  const blockedPr = open.find((pr) => pr.lane === "approved-blocked");
  if (blockedPr) return place("you", `${short(blockedPr.ref)} is approved but blocked`, task.updatedAt);
  if (task.blockedOn === "others") return place("others", task.blockedReason, task.blockedAt ?? task.updatedAt, task.blockedAt);
  // A PR waiting for a click from you comes before one waiting on reviewers.
  const needsReview = open.find((pr) => pr.lane === "agent-review");
  if (needsReview) return place("you", `${short(needsReview.ref)} needs an agent review`, task.updatedAt);
  const inReview = open.find((pr) => pr.lane === "human-review");
  if (inReview) return place("others", `${short(inReview.ref)} is waiting on reviewers`, task.updatedAt);

  const idle = onTask.filter((session) => session.live?.status === "idle").toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))[0];
  if (idle) return place("you", "The agent stopped", idle.activeAt ?? task.updatedAt, idle.activeAt);

  if (sessions.length === 0 && task.stage === "idea") return place("idea", null, task.createdAt);
  const last = sessions.map((session) => session.activeAt ?? "").toSorted().at(-1) || task.updatedAt;
  const why = onTask.length < sessions.length && sessions.some((session) => session.live) ? "Its session moved on to another task" : sessions.length ? "No session open" : "No session yet";
  return place("idle", why, last, last);
}

/** A session of a task's, and whether the task is still the one it's on. */
export interface TaskSessionLink extends TaskSessionInfo {
  onTask: boolean;
}

/** The session a task's card shows and its controls act on: one on it and working, else one on it and open (the latest to stop), else one open elsewhere, else the latest to run. */
export function primarySession(sessions: TaskSessionLink[]): TaskSessionLink | null {
  const rank = (session: TaskSessionLink) => (session.live ? 1 : 0) + (session.onTask && session.live ? 1 : 0) + (session.onTask && session.live?.status === "working" ? 1 : 0);
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

export function sessionTitle(title: string): string {
  return title.replace(PRIVATE_USE, "").trim() || "Untitled session";
}

/** A folder with ~ for your home, as you'd type it. */
export function displayFolder(cwd: string | null, home: string): string | null {
  if (cwd === null) return null;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

function openAction(session: TaskSessionInfo): TaskActionView {
  return action("open", "Open Session", session.live ? "Show this session in your terminal" : "Reopen this session in a new relay tab");
}

const EVENT_TEXT: Record<TaskEvent["kind"], (event: TaskEvent) => string> = {
  created: (event) => (event.text ? `Created: ${event.text}` : "Created"),
  started: () => "Started a session",
  stage: (event) => `Moved to ${STAGE_LABELS[event.stage]}`,
  status: (event) => event.text ?? "Status update",
  blocked: (event) => `Blocked${event.text ? `: ${event.text}` : ""}`,
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

function taskCard(task: Task, inputs: TaskInputs, places: Map<string, PrPlace>, sessions: TaskSessionLink[], projects: Map<number, ProjectRefView>): { card: TaskCardView; column: TaskColumn } {
  const { now } = inputs;
  const linked = [...inputs.prs.values()].filter((pr) => pr.taskId === task.id).map((pr) => `${pr.repo}#${pr.number}`);
  const prs = linked.map((ref) => ({ ref, place: places.get(ref) ?? null }));
  const placement = placeTask(task, sessions, prs.map(({ ref, place }) => ({ ref, lane: place?.lane ?? null })), now);
  const primary = primarySession(sessions);
  const project = task.projectId !== null ? projects.get(task.projectId) : undefined;
  const ref = taskRef(task.id);

  const steps: TaskActionView[] = [];
  if (task.pausedAt) {
    steps.push(
      action("resume", "Resume", primary ? "Unblock it and reopen its latest session" : `Unblock it and open a new session${task.cwd ? ` in ${task.cwd}` : ""} on it`, {
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
      action("send-back", "Not Yet", "Put it back in progress and show its session, so you can tell the agent what's missing"),
    );
  } else if (placement.turn === "idea") {
    steps.push(action("start", "Start", `Open a new session${task.cwd ? ` in ${task.cwd}` : ""} and hand it this task`, { running: "Starting…" }));
  } else if (placement.turn === "you" && primary) {
    steps.push({ ...openAction(primary), label: primary.live ? "Go to Session" : "Reopen Session" });
  } else if (placement.turn === "idle" && primary) {
    steps.push({ ...openAction(primary), label: "Resume", hint: "Reopen its latest session in a new relay tab" });
  } else if (placement.turn === "idle") {
    steps.push(action("start", "Start", `Open a new session${task.cwd ? ` in ${task.cwd}` : ""} and hand it this task`, { running: "Starting…" }));
  }

  const menu: TaskActionView[] = [];
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
          sessionFile: primary.sessionFile,
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
  };
  const column: TaskColumn = placement.delivered ? "ship" : task.pausedAt || placement.turn === "others" ? "blocked" : task.stage;
  return { card, column };
}

export function taskBoardView(inputs: TaskInputs, home: string): TaskBoardView {
  const { now } = inputs;
  const places = prPlaces(inputs.board);
  const paths = projectPaths(inputs.projects);
  const projects = new Map(inputs.projects.map((project) => [project.id, { id: project.id, name: project.name, path: paths.get(project.id)! }]));
  const sessionsOf = sessionsByTask(inputs.sessions, inputs.sessionInfo);

  const byColumn = new Map<TaskColumn, TaskCardView[]>(COLUMNS.map((column) => [column.id, []]));
  for (const task of inputs.tasks) {
    if (task.stage === "done" && now.getTime() - new Date(task.doneAt ?? task.updatedAt).getTime() > DONE_SHOWN_MS) continue;
    const { card, column } = taskCard(task, inputs, places, sessionsOf.get(task.id) ?? [], projects);
    byColumn.get(column)!.push(card);
  }
  // Your move on top, then the agent's, then others', then what's parked. Within each, the one
  // waiting longest first where it waits on someone; else the most recent first.
  for (const cards of byColumn.values()) {
    cards.sort((a, b) => {
      const byTurn = TURN_ORDER.indexOf(a.turn.id) - TURN_ORDER.indexOf(b.turn.id);
      if (byTurn !== 0) return byTurn;
      return a.turn.id === "you" || a.turn.id === "others" ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey);
    });
  }

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
