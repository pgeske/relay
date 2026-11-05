import { existsSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { resolveSessionFile } from "../server/sessionFile.ts";
import { parsePaneTitle } from "../server/sessions.ts";
import { listOmpPanes, mainSessionName, newWindow, pasteText, type Pane } from "../tmux.ts";
import { liveSessions } from "./command.ts";
import { readSessionHeader } from "./owners.ts";
import { ActionError, promptSession, showSession, waitUntilReady, type BoardActionResult } from "./serve.ts";
import { openBoardStore } from "./store.ts";
import { SESSION_ACTIONS, TASK_ACTIONS, primarySession, sessionsByTask, type SessionAction, type TaskAction } from "./taskBoard.ts";
import { readSessionInfo } from "./taskCommand.ts";
import {
  approvePlan,
  createTask,
  deleteTask,
  dismissSession,
  ensureProject,
  getTask,
  linkSession,
  markStarted,
  reportTask,
  taskRef,
  taskSessions,
  type Task,
  type TaskSession,
} from "./taskStore.ts";

/** A new task's details can run long; anything past this isn't a task description. */
const MAX_TASK_BODY_BYTES = 64 * 1024;

function startPrompt(task: Task): string {
  const plan = task.approvePlan
    ? "When you have a plan, record it with `relay task plan --summary -` (the plan on stdin, through a heredoc) and stop there: I approve it on the board before you carry it out."
    : "It skips plan approval: once you know what to do, go ahead and do it.";
  return (
    `I started ${taskRef(task.id)} from the relay board: ${task.title}\n\n` +
    (task.details ? `${task.details}\n\n` : "") +
    `This session is on it already. Keep it current on the board as you go, following the Tasks section of the relay skill: ` +
    `report with \`relay task update\` as it moves through research, plan, doing, and rollout, and say whenever it's blocked on me or on others. ` +
    `${plan} When it's finished, run \`relay task done\`.`
  );
}

function approvePrompt(task: Task): string {
  return (
    `I approved your plan for ${taskRef(task.id)} on the relay board. Go ahead and carry it out, ` +
    "reporting progress with `relay task update`, and run `relay task done` when it's finished."
  );
}

const TRACK_PROMPT =
  "I pressed Track on the relay board for this session. If it's working on a task (anything we'd keep going at until it's done), register it: " +
  '`relay task new "<short title>" --stage <stage> --status "<where it stands>"`, adding `--skip-plan` when I already gave you the go-ahead or there\'s nothing to plan. ' +
  "From then on, keep it current as the relay skill's Tasks section says. If this session isn't working on a task, just tell me so.";

interface SessionPlace {
  sessionFile: string;
  name: string;
  live: { paneId: string; windowId: string; status: "working" | "idle" } | null;
}

/** omp starts session titles with a nerd-font icon, which messages can't show. */
function sessionName(title: string): string {
  return title.replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu, "").trim() || "the session";
}

function describe(sessionFile: string, live: Map<string, Pane>): SessionPlace {
  const pane = live.get(sessionFile);
  const paneState = pane ? parsePaneTitle(pane.title, pane.cwd) : null;
  return {
    sessionFile,
    name: sessionName(paneState?.title || readSessionHeader(sessionFile).title),
    live: pane && paneState ? { paneId: pane.paneId, windowId: pane.windowId, status: paneState.status } : null,
  };
}

/**
 * The session a task's controls act on: the one its card shows. `onTaskOnly` leaves out sessions
 * that moved on to another task, for what only the task's own session should hear.
 */
function taskSession(taskId: number, live: Map<string, Pane>, onTaskOnly: boolean): SessionPlace | null {
  const db = openBoardStore();
  let links: TaskSession[];
  try {
    links = taskSessions(db);
  } finally {
    db.close();
  }
  const sessions = (sessionsByTask(links, readSessionInfo(links.map((link) => link.sessionFile), live)).get(taskId) ?? []).filter(
    (session) => (session.live || existsSync(session.sessionFile)) && (session.onTask || !onTaskOnly),
  );
  const primary = primarySession(sessions);
  return primary ? { sessionFile: primary.sessionFile, name: sessionName(primary.title), live: primary.live } : null;
}

/**
 * Starts a session on a task in a new background relay tab: omp in the task's folder, linked to
 * the task as soon as it knows its session file, then handed the task.
 */
async function startTask(task: Task): Promise<string> {
  const tmuxSession = await mainSessionName();
  if (!tmuxSession) throw new ActionError(409, "relay isn't running; open it with `relay` first");
  const cwd = task.cwd && existsSync(task.cwd) ? task.cwd : homedir();
  const startedAt = Date.now();
  const paneId = await newWindow(tmuxSession, cwd);
  await waitUntilReady(paneId);
  const pane = (await listOmpPanes()).find((candidate) => candidate.paneId === paneId);
  const sessionFile = pane ? await resolveSessionFile(pane, { pointerWrittenAfter: startedAt }) : null;
  const at = new Date().toISOString();
  const db = openBoardStore();
  try {
    db.transaction(() => {
      // Deleted while its session started: the new tab stays, but has nothing to work on.
      if (!getTask(db, task.id)) throw new ActionError(410, `${taskRef(task.id)} was deleted while its session started`);
      if (sessionFile) linkSession(db, task.id, sessionFile, at);
      markStarted(db, task.id, at);
    })();
  } finally {
    db.close();
  }
  // Without its session file, the board can't follow it: the session links itself.
  const prompt = sessionFile ? startPrompt(task) : `${startPrompt(task)}\n\nFirst, run \`relay task link ${task.id}\` so the board follows this session.`;
  await pasteText(paneId, prompt);
  return `Started ${taskRef(task.id)} in a new relay tab`;
}

function isTaskAction(action: string): action is TaskAction {
  return (TASK_ACTIONS as readonly string[]).includes(action);
}

function isSessionAction(action: string): action is SessionAction {
  return (SESSION_ACTIONS as readonly string[]).includes(action);
}

/** The body of a task control: `{ "task": 12 }`, or `{ "session": "<file>" }` for an untracked session's. */
export interface TaskActionTarget {
  task?: number;
  session?: string;
  /** For approve-plan: the plan's revision, as the card you approved from showed it. */
  plan?: string;
}

/**
 * Runs one of a task card's controls, or an untracked session's. `start` opens a session on the
 * task, `approve-plan` tells its session to carry out its plan, `open` shows its session; `track`
 * asks an untracked session to register its task.
 */
export async function runTaskAction(action: string, target: TaskActionTarget): Promise<BoardActionResult> {
  try {
    if (isSessionAction(action)) return await runSessionAction(action, target.session);
    if (!isTaskAction(action)) return { status: 404, message: `no such action: ${action}` };
    if (typeof target.task !== "number") return { status: 400, message: "missing task" };
    const id = target.task;
    const db = openBoardStore();
    let task: Task | null;
    try {
      task = getTask(db, id);
      if (!task) return { status: 404, message: `no task ${taskRef(id)}` };
      const at = new Date().toISOString();
      switch (action) {
        case "done":
          reportTask(db, id, { stage: "done", blocked: null, at });
          return { status: 200, message: `${taskRef(id)} is done` };
        case "reopen":
          reportTask(db, id, { stage: "doing", blocked: null, at });
          return { status: 200, message: `Reopened ${taskRef(id)}` };
        case "delete":
          deleteTask(db, id);
          return { status: 200, message: `Deleted ${taskRef(id)}` };
      }
    } finally {
      db.close();
    }

    if (action === "start") return { status: 200, message: await startTask(task) };
    const session = taskSession(id, await liveSessions(), action === "approve-plan");
    if (!session) return { status: 409, message: action === "approve-plan" ? `${taskRef(id)} has no session to carry out its plan` : `${taskRef(id)} has no session yet` };
    if (action === "open") return { status: 200, message: await showSession(session.sessionFile, session.live, session.name) };

    // approve-plan: only the plan you read. One revised since waits for you to read it.
    if (!task.plan || task.planApprovedAt) return { status: 409, message: `${taskRef(id)} has no plan waiting for approval` };
    const revision = target.plan;
    if (revision === undefined || revision !== task.planAt) return { status: 409, message: `${taskRef(id)}'s plan changed since you looked; read the new one first` };
    const reopened = await promptSession(session.sessionFile, session.live, session.name, approvePrompt(task));
    const store = openBoardStore();
    try {
      approvePlan(store, id, revision, new Date().toISOString());
    } finally {
      store.close();
    }
    return { status: 200, message: `Approved the plan for ${taskRef(id)}${reopened ? " (reopened its session in a new relay tab)" : ""}` };
  } catch (error) {
    if (error instanceof ActionError) return { status: error.status, message: error.message };
    throw error;
  }
}

async function runSessionAction(action: SessionAction, sessionFile: string | undefined): Promise<BoardActionResult> {
  if (typeof sessionFile !== "string") return { status: 400, message: "missing session" };
  const live = await liveSessions();
  // Only sessions open in relay are offered, so only those are taken.
  if (!live.has(sessionFile)) return { status: 410, message: "that session isn't open in relay anymore" };
  const session = describe(sessionFile, live);
  switch (action) {
    case "open-session":
      return { status: 200, message: await showSession(sessionFile, session.live, session.name) };
    case "track":
      await promptSession(sessionFile, session.live, session.name, TRACK_PROMPT);
      return { status: 200, message: `Asked "${session.name}" to register its task` };
    case "dismiss": {
      const db = openBoardStore();
      try {
        dismissSession(db, sessionFile, new Date().toISOString());
      } finally {
        db.close();
      }
      return { status: 200, message: `"${session.name}" won't be offered for tracking again` };
    }
  }
}

/** A task as the board's New Task sheet sends it. */
export interface NewTaskRequest {
  title: string;
  details?: string;
  /** A project's name: an existing one, or a new one to create. */
  project?: string;
  /** Where its session starts; ~ means your home. */
  folder?: string;
  approvePlan: boolean;
  /** Start a session on it now, rather than keeping it as an idea. */
  start: boolean;
}

/** Creates a task from the board, starting a session on it when asked. */
export async function createTaskFromBoard(request: NewTaskRequest): Promise<BoardActionResult & { task?: number }> {
  const title = request.title.trim();
  if (!title) return { status: 400, message: "a task needs a title" };
  const folder = request.folder?.trim() ? request.folder.trim().replace(/^~(?=$|\/)/, homedir()) : null;
  if (folder && !(existsSync(folder) && statSync(folder).isDirectory())) return { status: 400, message: `${request.folder} isn't a folder` };
  const at = new Date().toISOString();
  const db = openBoardStore();
  let task: Task;
  try {
    task = createTask(db, {
      title,
      details: request.details?.trim() || null,
      projectId: request.project?.trim() ? ensureProject(db, request.project.trim(), at).id : null,
      stage: "idea",
      status: null,
      approvePlan: request.approvePlan,
      cwd: folder ?? homedir(),
      at,
    });
  } finally {
    db.close();
  }
  if (!request.start) return { status: 200, message: `Saved ${taskRef(task.id)} in Ideas`, task: task.id };
  try {
    return { status: 200, message: await startTask(task), task: task.id };
  } catch (error) {
    // The task stays as an idea, so Start can try again.
    const why = error instanceof Error ? error.message : String(error);
    return { status: error instanceof ActionError ? error.status : 500, message: `Saved ${taskRef(task.id)}, but couldn't start it: ${why}`, task: task.id };
  }
}

/** Reads a small JSON body, refusing anything past `maxBytes`. */
export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_TASK_BODY_BYTES): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error("request body too large");
  }
  const body = JSON.parse(raw || "{}") as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("expected a JSON object");
  return body as Record<string, unknown>;
}

/** Checks a New Task body's fields. */
export function parseNewTask(body: Record<string, unknown>): NewTaskRequest {
  const text = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${key} must be text`);
    return value;
  };
  const title = text("title");
  if (!title) throw new Error("missing title");
  return { title, details: text("details"), project: text("project"), folder: text("folder"), approvePlan: body.approvePlan !== false, start: body.start === true };
}
