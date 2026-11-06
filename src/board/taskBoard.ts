import type { PullRequest } from "./github.ts";
import type { Board, Lane } from "./lanes.ts";
import { TASK_STAGES, taskRef, type Project, type Task, type TaskEvent, type TaskPr, type TaskSession, type TaskStage } from "./taskStore.ts";
import { timeAgo, type Confirm, type Tone } from "./view.ts";

/**
 * The Tasks board: every task you have in flight, sorted by what it needs, so a glance says which
 * ones are waiting on you right now. Like the PR board, everything a card says and offers is decided
 * here; the app only lays it out.
 */

/** Sections top to bottom; `hot` ones are waiting on you. */
export type TaskLane = "needs-you" | "ship" | "working" | "waiting" | "paused" | "untracked" | "ideas" | "done";

const LANES: { id: TaskLane; title: string; hint: string; hot: boolean }[] = [
  { id: "needs-you", title: "Needs you", hint: "A plan to approve, a question, or a PR to move along", hot: true },
  { id: "ship", title: "Ready to ship", hint: "Its agent delivered: look it over, then ship it", hot: true },
  { id: "working", title: "Agent working", hint: "A session is on it right now", hot: false },
  { id: "waiting", title: "Waiting on others", hint: "A team, a review, a deploy", hot: false },
  { id: "paused", title: "Paused", hint: "In progress, but no session is open", hot: false },
  { id: "untracked", title: "Not tracked", hint: "Open sessions no task knows about", hot: false },
  { id: "ideas", title: "Ideas", hint: "Not started yet", hot: false },
  { id: "done", title: "Shipped", hint: "Shipped in the last two weeks", hot: false },
];

const DONE_SHOWN_MS = 14 * 24 * 60 * 60 * 1000;
/** How many folders the new-task sheet suggests. */
const FOLDERS_SHOWN = 8;

/** What a task card's controls ask relay's server: `POST /api/board/tasks/actions/<action>` with the card's `id`. */
export const TASK_ACTIONS = ["start", "approve-plan", "open", "ship", "send-back", "done", "reopen", "delete"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
/** What an untracked session's controls ask: the same endpoint, with the session's `sessionFile`. */
export const SESSION_ACTIONS = ["open-session", "track", "dismiss", "close-session"] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

/** The stages a card's progress bar shows; `idea` is before the first. */
const SHOWN_STAGES = TASK_STAGES.filter((stage) => stage !== "idea");

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

export interface StageView {
  id: TaskStage;
  label: string;
  state: "done" | "current" | "todo";
}

/** Why a card is in its section, said under its title. */
export interface ReasonView {
  text: string;
  tone: Tone;
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
}

export interface TaskCardView {
  id: number;
  /** "T-12": what the card's actions and the CLI name. */
  ref: string;
  title: string;
  details: string | null;
  project: { id: number; name: string } | null;
  /** Its color, 0 to 7, so its card and its PRs on the PR board match. */
  hue: number;
  stage: TaskStage;
  stageLabel: string;
  stages: StageView[];
  /** The agent's latest report, and when. */
  status: { text: string; ago: string } | null;
  reason: ReasonView;
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
  /** For sorting a section: how long it's been waiting (oldest first in Needs you and Waiting), else most recent first. */
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

export interface TaskLaneView {
  id: TaskLane;
  title: string;
  hint: string;
  hot: boolean;
  cards: TaskCardView[];
  /** Only the Not tracked section has these. */
  sessions: UntrackedSessionView[];
}

export interface ProjectView {
  id: number;
  name: string;
  /** Its tasks not done yet, and how many of them need you. */
  open: number;
  needsYou: number;
}

export interface TaskBoardView {
  lanes: TaskLaneView[];
  projects: ProjectView[];
  needsYou: number;
  /** Folders a new task can start in: its recent tasks', then open sessions'. */
  folders: string[];
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

function stagesView(stage: TaskStage): StageView[] {
  const index = TASK_STAGES.indexOf(stage);
  return SHOWN_STAGES.map((id) => {
    const at = TASK_STAGES.indexOf(id);
    return { id, label: STAGE_LABELS[id], state: stage === "done" || at < index ? "done" : at === index ? "current" : "todo" };
  });
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
  lane: Exclude<TaskLane, "untracked">;
  reason: ReasonView;
  /** Since when it's been so, for sorting. */
  at: string;
}

/**
 * Which section a task goes in. A working agent needs nothing from you yet, so that comes first.
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
  if (task.stage === "done") return { lane: "done", reason: { text: `Shipped ${timeAgo(task.doneAt ?? task.updatedAt, now)}`, tone: "ok", since: null }, at: task.doneAt ?? task.updatedAt };

  // What a session that moved on to another task is doing now is that task's business.
  const onTask = sessions.filter((session) => session.onTask);
  const working = onTask.find((session) => session.live?.status === "working");
  if (working) return { lane: "working", reason: { text: "Agent working", tone: "wait", since: null }, at: working.activeAt ?? task.updatedAt };
  // Its agent delivered: nothing else matters until you ship it or send it back.
  if (task.finishedAt) return { lane: "ship", reason: { text: "Delivered", tone: "ok", since: ago(task.finishedAt) }, at: task.finishedAt };

  if (task.approvePlan && task.plan && !task.planApprovedAt) {
    return { lane: "needs-you", reason: { text: "Plan ready for your approval", tone: "warn", since: ago(task.planAt) }, at: task.planAt ?? task.updatedAt };
  }
  if (task.blockedOn === "me") {
    return { lane: "needs-you", reason: { text: task.blockedReason ?? "Needs your input", tone: "warn", since: ago(task.blockedAt) }, at: task.blockedAt ?? task.updatedAt };
  }
  const open = prs.filter((pr) => pr.lane !== null && pr.lane !== "merged");
  const ready = open.find((pr) => pr.lane === "ready");
  if (ready) return { lane: "needs-you", reason: { text: `${short(ready.ref)} is ready to merge`, tone: "ok", since: null }, at: task.updatedAt };
  const blockedPr = open.find((pr) => pr.lane === "approved-blocked");
  if (blockedPr) return { lane: "needs-you", reason: { text: `${short(blockedPr.ref)} is approved but blocked`, tone: "warn", since: null }, at: task.updatedAt };
  if (task.blockedOn === "others") {
    return { lane: "waiting", reason: { text: task.blockedReason ?? "Waiting on others", tone: "wait", since: ago(task.blockedAt) }, at: task.blockedAt ?? task.updatedAt };
  }
  // A PR waiting for a click from you comes before one waiting on reviewers.
  const needsReview = open.find((pr) => pr.lane === "agent-review");
  if (needsReview) return { lane: "needs-you", reason: { text: `${short(needsReview.ref)} needs an agent review`, tone: "link", since: null }, at: task.updatedAt };
  const inReview = open.find((pr) => pr.lane === "human-review");
  if (inReview) return { lane: "waiting", reason: { text: `${short(inReview.ref)} is waiting on reviewers`, tone: "wait", since: null }, at: task.updatedAt };

  const idle = onTask.filter((session) => session.live?.status === "idle").toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))[0];
  if (idle) return { lane: "needs-you", reason: { text: "Agent stopped: your turn", tone: "warn", since: ago(idle.activeAt) }, at: idle.activeAt ?? task.updatedAt };

  if (sessions.length === 0 && task.stage === "idea") return { lane: "ideas", reason: { text: "Not started", tone: "muted", since: null }, at: task.createdAt };
  const last = sessions.map((session) => session.activeAt ?? "").toSorted().at(-1) || task.updatedAt;
  const why = onTask.length < sessions.length && sessions.some((session) => session.live) ? "Its session moved on to another task" : sessions.length ? "No session open" : "No session yet";
  return { lane: "paused", reason: { text: why, tone: "muted", since: ago(last) }, at: last };
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

function sessionTitle(title: string): string {
  return title.replace(PRIVATE_USE, "").trim() || "Untitled session";
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
  done: () => "Shipped",
  reopened: () => "Reopened",
};

/** How many history lines a card's details show. */
const HISTORY_SHOWN = 30;

function taskCard(task: Task, inputs: TaskInputs, places: Map<string, PrPlace>, sessions: TaskSessionLink[], projects: Map<number, Project>): { card: TaskCardView; lane: Placement["lane"] } {
  const { now } = inputs;
  const linked = [...inputs.prs.values()].filter((pr) => pr.taskId === task.id).map((pr) => `${pr.repo}#${pr.number}`);
  const prs = linked.map((ref) => ({ ref, place: places.get(ref) ?? null }));
  const placement = placeTask(task, sessions, prs.map(({ ref, place }) => ({ ref, lane: place?.lane ?? null })), now);
  const primary = primarySession(sessions);
  const project = task.projectId !== null ? projects.get(task.projectId) : undefined;
  const ref = taskRef(task.id);

  const steps: TaskActionView[] = [];
  // A working task's section says the agent is on it, so its footer stays free for a step forward.
  if (task.approvePlan && task.plan && !task.planApprovedAt && task.stage !== "done" && placement.lane !== "working") {
    steps.push(
      action("approve-plan", "Approve Plan", "Tell the task's session to carry out its plan", {
        confirm: { title: `Approve the plan for ${ref}?`, message: "Tells the task's session to go ahead and carry it out.", button: "Approve", destructive: false },
        running: "Agent working…",
      }),
    );
  } else if (placement.lane === "ship") {
    // No confirm: Reopen undoes it, and omp keeps the closed sessions' conversations.
    steps.push(
      action("ship", "Ship It", "Move it to Shipped and close its idle session tabs; omp keeps their conversations"),
      action("send-back", "Not Yet", "Put it back in progress and show its session, so you can tell the agent what's missing"),
    );
  } else if (placement.lane === "ideas") {
    steps.push(action("start", "Start", `Open a new session${task.cwd ? ` in ${task.cwd}` : ""} and hand it this task`, { running: "Starting…" }));
  } else if (placement.lane === "needs-you" && primary) {
    steps.push({ ...openAction(primary), label: primary.live ? "Go to Session" : "Reopen Session" });
  } else if (placement.lane === "paused" && primary) {
    steps.push({ ...openAction(primary), label: "Resume", hint: "Reopen its latest session in a new relay tab" });
  } else if (placement.lane === "paused") {
    steps.push(action("start", "Start", `Open a new session${task.cwd ? ` in ${task.cwd}` : ""} and hand it this task`, { running: "Starting…" }));
  }

  const menu: TaskActionView[] = [];
  if (task.stage === "done") menu.push(action("reopen", "Reopen Task", "Put it back in progress"));
  else if (placement.lane !== "ship") menu.push(action("done", "Mark Shipped", "Move it to Shipped and close its idle sessions"));
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
    project: project ? { id: project.id, name: project.name } : null,
    hue: taskHue(task.id),
    stage: task.stage,
    stageLabel: STAGE_LABELS[task.stage],
    stages: stagesView(task.stage),
    status: task.status ? { text: task.status, ago: timeAgo(task.statusAt ?? task.updatedAt, now) } : null,
    reason: placement.reason,
    plan: task.plan
      ? {
          text: task.plan,
          at: task.planAt ?? task.updatedAt,
          revision: task.planAt ?? "",
          awaiting: task.approvePlan && !task.planApprovedAt,
          approved: task.planApprovedAt !== null,
        }
      : null,
    finish: task.finishNote || task.finishedAt ? { text: task.finishNote, at: task.finishedAt ?? task.doneAt ?? task.updatedAt, awaiting: placement.lane === "ship" } : null,
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
    history: (inputs.events.get(task.id) ?? []).slice(0, HISTORY_SHOWN).map((event) => ({ at: event.at, text: EVENT_TEXT[event.kind](event), stage: STAGE_LABELS[event.stage] })),
    updatedAt: task.updatedAt,
    sortKey: placement.at,
  };
  return { card, lane: placement.lane };
}

export function taskBoardView(inputs: TaskInputs, home: string): TaskBoardView {
  const { now } = inputs;
  const places = prPlaces(inputs.board);
  const projects = new Map(inputs.projects.map((project) => [project.id, project]));
  const sessionsOf = sessionsByTask(inputs.sessions, inputs.sessionInfo);

  const byLane = new Map<TaskLane, TaskCardView[]>(LANES.map((lane) => [lane.id, []]));
  for (const task of inputs.tasks) {
    if (task.stage === "done" && now.getTime() - new Date(task.doneAt ?? task.updatedAt).getTime() > DONE_SHOWN_MS) continue;
    const { card, lane } = taskCard(task, inputs, places, sessionsOf.get(task.id) ?? [], projects);
    byLane.get(lane)!.push(card);
  }
  // Waiting the longest first where something waits; else the most recent first.
  for (const [lane, cards] of byLane) {
    cards.sort(lane === "needs-you" || lane === "ship" || lane === "waiting" ? (a, b) => a.sortKey.localeCompare(b.sortKey) : (a, b) => b.sortKey.localeCompare(a.sortKey));
  }

  const tracked = new Set(inputs.sessions.map((link) => link.sessionFile));
  const untracked = [...inputs.sessionInfo.values()]
    .filter((session) => session.live && !tracked.has(session.sessionFile) && !inputs.dismissed.has(session.sessionFile))
    .toSorted((a, b) => (b.activeAt ?? "").localeCompare(a.activeAt ?? ""))
    .map(
      (session): UntrackedSessionView => ({
        sessionFile: session.sessionFile,
        title: sessionTitle(session.title),
        // Its folder with ~ for your home, as you'd type it.
        folder: session.cwd === null ? null : session.cwd === home ? "~" : session.cwd.startsWith(`${home}/`) ? `~${session.cwd.slice(home.length)}` : session.cwd,
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

  const lanes = LANES.map(({ id, title, hint, hot }) => ({ id, title, hint, hot, cards: byLane.get(id)!, sessions: id === "untracked" ? untracked : [] }));
  const open = lanes.filter((lane) => lane.id !== "done").flatMap((lane) => lane.cards);
  const needsYou = lanes.filter((lane) => lane.hot).flatMap((lane) => lane.cards);

  const folders = [
    ...inputs.tasks.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).flatMap((task) => (task.cwd ? [task.cwd] : [])),
    ...[...inputs.sessionInfo.values()].filter((session) => session.live).flatMap((session) => (session.cwd ? [session.cwd] : [])),
  ];
  return {
    lanes,
    projects: inputs.projects.map((project) => ({
      id: project.id,
      name: project.name,
      open: open.filter((card) => card.project?.id === project.id).length,
      needsYou: needsYou.filter((card) => card.project?.id === project.id).length,
    })),
    needsYou: needsYou.length,
    folders: [...new Set(folders)].slice(0, FOLDERS_SHOWN),
  };
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
