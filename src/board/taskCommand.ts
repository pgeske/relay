import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { parsePaneTitle } from "../server/sessions.ts";
import type { Pane } from "../tmux.ts";
import { currentSessionFile, flagValue, liveSessions, loadBoard, parsePrRef, readSummary } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import type { Board } from "./lanes.ts";
import { readSessionHeader } from "./owners.ts";
import { openBoardStore } from "./store.ts";
import { STAGE_LABELS, taskBoardView, taskChips, type TaskBoardView, type TaskChipView, type TaskSessionInfo, type TurnView } from "./taskBoard.ts";
import {
  BLOCKERS,
  TASK_STAGES,
  createTask,
  currentTask,
  dismissedSessions,
  ensureProject,
  finishTask,
  getTask,
  linkPr,
  linkSession,
  linkSessionPrs,
  listProjects,
  listTasks,
  parseTaskRef,
  recordPlan,
  reportTask,
  taskEvents,
  taskPrs,
  taskRef,
  taskSessions,
  type BlockedOn,
  type Task,
  type TaskStage,
} from "./taskStore.ts";

export const TASK_HELP = `relay task: what you're getting done, a level above pull requests.

Agents keep tasks current as they work; the Relay Board app's Tasks view shows which need you.

Usage:
  relay task                          List your tasks
  relay task --json                   Print the task board as JSON (for agents)
  relay task new <title> [--details <text|->] [--project <name>] [--stage <stage>]
                 [--status <text>] [--skip-plan]
                                      Register a task and put this session on it; prints its id
  relay task link <task>              Put this session on a task too
  relay task update [<task>] [--stage <stage>] [--status <text>]
                    [--blocked-on me|others --reason <text>] [--pr <pr>] [--project <name>]
                                      Report where it stands. An update without --blocked-on
                                      clears a block; --pr makes a PR part of it
  relay task plan [<task>] --summary <text|->
                                      Record the plan; unless the task skips plan approval,
                                      it waits for you to approve it on the board
  relay task done [<task>] --summary <text|-> [--status <text>]
                                      Say it's finished: what you did and how you checked.
                                      It waits in Ready to ship until you ship it from the board
  relay task show [<task>] [--json]   A task, its sessions, PRs, and history

<task> is its id (T-12 or 12); left out, it's the task this session is on.
<name> is a project, made if there's none yet; Parent/Child names one inside another.
<stage> is one of: ${TASK_STAGES.join(", ")}.`;

function pathMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** What each session is called, where it runs, and when it was last active, by session file. */
export function readSessionInfo(files: Iterable<string>, live: Map<string, Pane>): Map<string, TaskSessionInfo> {
  const sessionInfo = new Map<string, TaskSessionInfo>();
  for (const file of new Set(files)) {
    const pane = live.get(file);
    const header = readSessionHeader(file);
    const paneState = pane ? parsePaneTitle(pane.title, pane.cwd) : null;
    sessionInfo.set(file, {
      sessionFile: file,
      title: paneState?.title || header.title,
      cwd: pane?.cwd ?? header.cwd,
      live: pane && paneState ? { paneId: pane.paneId, windowId: pane.windowId, status: paneState.status } : null,
      activeAt: pathMtime(file),
    });
  }
  return sessionInfo;
}

/**
 * Reads every task and what its sessions are doing. `board` gives each task's PRs their lanes;
 * without it (GitHub can't be read) the tasks still show. The board's session scan links the PRs
 * sessions open, so a PR a task's session opened joins the task here.
 */
export function assembleTasks(board: Board | null, live: Map<string, Pane>, now: Date): { view: TaskBoardView; chips: Map<string, TaskChipView> } {
  const db = openBoardStore();
  try {
    linkSessionPrs(db, now.toISOString());
    const tasks = listTasks(db);
    const sessions = taskSessions(db);
    const prs = taskPrs(db);
    const sessionInfo = readSessionInfo([...sessions.map((link) => link.sessionFile), ...live.keys()], live);
    const view = taskBoardView(
      { tasks, projects: listProjects(db), events: taskEvents(db), sessions, sessionInfo, prs, board, dismissed: dismissedSessions(db), now },
      homedir(),
    );
    return { view, chips: taskChips(tasks, prs) };
  } finally {
    db.close();
  }
}

/** The task a command names, or the one its session is on. */
async function resolveTask(db: Database, ref: string | undefined): Promise<Task> {
  if (ref !== undefined) {
    const id = parseTaskRef(ref);
    const task = getTask(db, id);
    if (!task) throw new Error(`no task ${taskRef(id)}`);
    return task;
  }
  const session = await currentSessionFile();
  const id = session ? currentTask(db, session) : null;
  if (id === null) {
    throw new Error(session ? "this session isn't on a task yet: register one with `relay task new <title>`, or name it (T-12)" : "not inside relay: name the task (T-12)");
  }
  return getTask(db, id)!;
}

/** A command's leading task ref, when it has one before its flags. */
function leadingRef(args: string[]): string | undefined {
  return args[0] !== undefined && !args[0].startsWith("--") ? args[0] : undefined;
}

function parseStage(value: string | undefined): TaskStage | undefined {
  if (value === undefined) return undefined;
  if (!(TASK_STAGES as readonly string[]).includes(value)) throw new Error(`--stage is one of ${TASK_STAGES.join(", ")}, not ${value}`);
  return value as TaskStage;
}

function parseBlocker(args: string[]): { on: BlockedOn; reason: string | null } | null {
  const on = flagValue(args, "--blocked-on");
  const reason = flagValue(args, "--reason") ?? null;
  if (on === undefined) {
    if (reason !== null) throw new Error("--reason goes with --blocked-on me|others");
    return null;
  }
  if (!(BLOCKERS as readonly string[]).includes(on)) throw new Error(`--blocked-on is me or others, not ${on}`);
  return { on: on as BlockedOn, reason };
}

/** Puts the session this runs in on the task, so the board follows it; quietly does nothing outside relay. */
async function linkThisSession(db: Database, taskId: number, at: string): Promise<boolean> {
  const session = await currentSessionFile();
  if (!session) return false;
  if (currentTask(db, session) !== taskId) linkSession(db, taskId, session, at);
  return true;
}

/**
 * A session reporting on a task while on none is working on it, so it joins. One already on another
 * task is only passing word along (say, marking an old one done), and stays where it is.
 */
async function joinIfFree(db: Database, taskId: number, at: string): Promise<void> {
  const session = await currentSessionFile();
  if (session && currentTask(db, session) === null) linkSession(db, taskId, session, at);
}

async function newTask(args: string[]): Promise<void> {
  const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
  const title = args.slice(0, firstFlag === -1 ? args.length : firstFlag).join(" ").trim();
  if (!title) throw new Error(`missing <title>\n\n${TASK_HELP}`);
  const at = new Date().toISOString();
  const details = await readSummary(flagValue(args, "--details"));
  const stage = parseStage(flagValue(args, "--stage")) ?? "research";
  const projectName = flagValue(args, "--project");
  const db = openBoardStore();
  try {
    const task = createTask(db, {
      title,
      details,
      projectId: projectName ? ensureProject(db, projectName, at).id : null,
      stage,
      status: flagValue(args, "--status") ?? null,
      approvePlan: !args.includes("--skip-plan"),
      cwd: process.cwd(),
      at,
    });
    const linked = await linkThisSession(db, task.id, at);
    console.log(`${taskRef(task.id)}: ${title}${linked ? " (this session is on it)" : ` (not inside relay: name it ${taskRef(task.id)} in later commands)`}`);
  } finally {
    db.close();
  }
}

async function link(args: string[]): Promise<void> {
  const ref = leadingRef(args);
  if (!ref) throw new Error(`missing <task>\n\n${TASK_HELP}`);
  const db = openBoardStore();
  try {
    const task = await resolveTask(db, ref);
    if (!(await linkThisSession(db, task.id, new Date().toISOString()))) throw new Error("run this from an omp session inside relay: it puts that session on the task");
    console.log(`this session is on ${taskRef(task.id)}: ${task.title}`);
  } finally {
    db.close();
  }
}

async function update(args: string[]): Promise<void> {
  const at = new Date().toISOString();
  const stage = parseStage(flagValue(args, "--stage"));
  if (stage === "done") throw new Error("finish a task with `relay task done --summary -`: the user checks it on the board before it's done");
  const blocked = parseBlocker(args);
  const status = flagValue(args, "--status");
  const prRef = flagValue(args, "--pr");
  const projectName = flagValue(args, "--project");
  const db = openBoardStore();
  try {
    const task = await resolveTask(db, leadingRef(args));
    if (prRef) {
      const pr = parsePrRef(prRef);
      linkPr(db, pr.repo, pr.number, task.id, at);
    }
    const updated = reportTask(db, task.id, { stage, status, blocked, projectId: projectName ? ensureProject(db, projectName, at).id : undefined, at });
    await joinIfFree(db, task.id, at);
    const block = updated.blockedOn ? `, blocked on ${updated.blockedOn === "me" ? "you" : "others"}` : "";
    console.log(`${taskRef(task.id)} is in ${STAGE_LABELS[updated.stage]}${block}${updated.status ? `: ${updated.status}` : ""}`);
  } finally {
    db.close();
  }
}

async function plan(args: string[]): Promise<void> {
  const text = await readSummary(flagValue(args, "--summary"));
  if (!text) throw new Error("give the plan with --summary <text>, or --summary - to read it from stdin");
  const at = new Date().toISOString();
  const db = openBoardStore();
  try {
    const task = await resolveTask(db, leadingRef(args));
    recordPlan(db, task.id, text, at);
    await joinIfFree(db, task.id, at);
    console.log(
      task.approvePlan
        ? `recorded the plan for ${taskRef(task.id)}; it waits for approval on the board. Stop here until the user approves it.`
        : `recorded the plan for ${taskRef(task.id)}; it skips plan approval, so carry it out.`,
    );
  } finally {
    db.close();
  }
}

async function done(args: string[]): Promise<void> {
  const note = await readSummary(flagValue(args, "--summary"));
  if (!note) throw new Error("say what you did and how you checked it with --summary <text>, or --summary - to read it from stdin");
  const at = new Date().toISOString();
  const db = openBoardStore();
  try {
    const task = await resolveTask(db, leadingRef(args));
    finishTask(db, task.id, { note, status: flagValue(args, "--status"), at });
    console.log(`${taskRef(task.id)} is ready to ship: it waits on the board until the user ships it or sends it back: ${task.title}`);
  } finally {
    db.close();
  }
}

/** The task board with PR lanes when GitHub answers, and without them when it doesn't. */
async function loadTaskBoard(): Promise<TaskBoardView> {
  const now = new Date();
  const live = await liveSessions();
  const board = await loadBoard(loadBoardConfig()).catch(() => null);
  return assembleTasks(board, live, now).view;
}

async function show(args: string[]): Promise<void> {
  const db = openBoardStore();
  let task: Task;
  try {
    task = await resolveTask(db, leadingRef(args));
  } finally {
    db.close();
  }
  const board = await loadTaskBoard();
  const column = board.columns.find((candidate) => candidate.cards.some((card) => card.id === task.id));
  const card = column?.cards.find((candidate) => candidate.id === task.id);
  // Done long enough ago, it's off the board: what the store has says it all.
  if (!column || !card) {
    console.log(args.includes("--json") ? JSON.stringify(task, null, 2) : `${taskRef(task.id)}: ${task.title}\nDone${task.doneAt ? ` ${task.doneAt.slice(0, 10)}` : ""}`);
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({ column: column.id, ...card }, null, 2));
    return;
  }
  const lines = [`${card.ref}: ${card.title}${card.project ? `  [${card.project.path}]` : ""}`, `${column.title} · ${turnText(card.turn)}`];
  if (card.status) lines.push(`Status: ${card.status.text} (${card.status.ago}${card.status.auto ? ", filled in by relay" : ""})`);
  if (card.plan) lines.push(`Plan: ${card.plan.awaiting ? "waiting for approval" : card.plan.approved ? "approved" : "recorded"}`);
  if (card.finish) lines.push(`Delivery note${card.finish.awaiting ? " (ready for the user to ship)" : ""}: ${card.finish.text ?? "none"}`);
  for (const pr of card.prs) lines.push(`PR ${pr.ref}: ${pr.state}`);
  if (card.session) lines.push(`Session: ${card.session.title} (${card.session.state})${card.session.others ? ` and ${card.session.others} more` : ""}`);
  console.log(lines.join("\n"));
}

async function list(args: string[]): Promise<void> {
  const board = await loadTaskBoard();
  if (args.includes("--json")) {
    console.log(JSON.stringify(board, null, 2));
    return;
  }
  const lines: string[] = [];
  for (const column of board.columns) {
    if (column.cards.length === 0) continue;
    lines.push(`${column.title}:`);
    for (const card of column.cards) lines.push(`  ${card.ref}  ${card.title} · ${turnText(card.turn)}`);
  }
  if (board.untracked.length) {
    lines.push("Not tracked:");
    for (const session of board.untracked) lines.push(`  ${session.title} (${session.state})`);
  }
  console.log(lines.length ? lines.join("\n") : "No tasks yet. Register one with: relay task new <title>");
}

/** "Needs you: Plan ready for your approval (12m)", or just "Agent working". */
function turnText(turn: TurnView): string {
  return `${turn.label}${turn.reason ? `: ${turn.reason}` : ""}${turn.since ? ` (${turn.since})` : ""}`;
}

export async function taskCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "new":
      return newTask(rest);
    case "link":
      return link(rest);
    case "update":
      return update(rest);
    case "plan":
      return plan(rest);
    case "done":
      return done(rest);
    case "show":
      return show(rest);
    case "--help":
    case "-h":
    case "help":
      console.log(TASK_HELP);
      return;
    case undefined:
    case "--json":
      return list(args);
    default:
      throw new Error(`unknown option: ${subcommand}\n\n${TASK_HELP}`);
  }
}
