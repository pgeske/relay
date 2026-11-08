import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { THINKING_LEVELS, listModels } from "../server/modelState.ts";
import { parsePaneTitle } from "../server/sessions.ts";
import { parseUploadedImages, saveUploadedImages, type UploadedImage } from "../server/uploads.ts";
import { killWindow, pasteText, type Pane } from "../tmux.ts";
import { liveSessions } from "./command.ts";
import { readSessionHeader } from "./owners.ts";
import { ActionError, modelArgs, openAgentTab, promptSession, showSession, type BoardActionResult } from "./serve.ts";
import { openBoardStore } from "./store.ts";
import { SESSION_ACTIONS, TASK_ACTIONS, primarySession, sessionsByTask, type SessionAction, type TaskAction, type TaskSessionLink } from "./taskBoard.ts";
import { readSessionInfo } from "./taskCommand.ts";
import {
  approvePlan,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  dismissSession,
  ensureProject,
  getProject,
  getTask,
  linkSession,
  markStarted,
  pauseTask,
  reportTask,
  renameProject,
  resumeTask,
  sendBack,
  taskRef,
  taskSessions,
  type Task,
  type TaskSession,
} from "./taskStore.ts";

/** A new task's details can run long, and its screenshots longer; anything past this isn't a task. */
const MAX_TASK_BODY_BYTES = 30 * 1024 * 1024;

/** How a session hands its task back: you look it over and ship it before it counts as done. */
const FINISH_ASK =
  "When it's finished, run `relay task done --summary -` with what you did and how you checked it (on stdin, through a heredoc): I look it over and ship it from the board before it counts as done.";

function startPrompt(task: Task): string {
  const plan = task.approvePlan
    ? "When you have a plan, record it with `relay task plan --summary -` (the plan on stdin, through a heredoc) and stop there: I approve it on the board before you carry it out."
    : "It skips plan approval: once you know what to do, go ahead and do it.";
  return (
    `I started ${taskRef(task.id)} from the relay board: ${task.title}\n\n` +
    (task.details ? `${task.details}\n\n` : "") +
    `This session is on it already. Follow the Tasks section of the relay skill: relay keeps the card's stage and status current on its own, ` +
    `and whenever you stop to wait on me or on others, say so first with \`relay task update --blocked-on me\` or \`--blocked-on others\`. ` +
    `${plan} ${FINISH_ASK}`
  );
}

function approvePrompt(task: Task): string {
  return `I approved your plan for ${taskRef(task.id)} on the relay board. Go ahead and carry it out; whenever you stop to wait on me or on others, say so first with \`relay task update --blocked-on me\` or \`--blocked-on others\`. ${FINISH_ASK}`;
}

const TRACK_PROMPT =
  "I pressed Track on the relay board for this session. If it's working on a task (anything we'd keep going at until it's done), register it: " +
  '`relay task new "<short title>" --stage <stage> --status "<where it stands>"`, adding `--skip-plan` when I already gave you the go-ahead or there\'s nothing to plan. ' +
  "From then on, report as the relay skill's Tasks section says. If this session isn't working on a task, just tell me so.";

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
 * Every session a task has that's still around: open in relay, or saved to resume. A session that
 * moved on to another task stays among them, marked off the task.
 */
function sessionsOfTask(taskId: number, live: Map<string, Pane>): TaskSessionLink[] {
  const db = openBoardStore();
  let links: TaskSession[];
  try {
    links = taskSessions(db);
  } finally {
    db.close();
  }
  return (sessionsByTask(links, readSessionInfo(links.map((link) => link.sessionFile), live)).get(taskId) ?? []).filter((session) => session.live || existsSync(session.sessionFile));
}

/**
 * The session a task's controls act on: the one its card shows. `onTaskOnly` leaves out sessions
 * that moved on to another task, for what only the task's own session should hear.
 */
function taskSession(taskId: number, live: Map<string, Pane>, onTaskOnly: boolean): SessionPlace | null {
  const primary = primarySession(sessionsOfTask(taskId, live).filter((session) => session.onTask || !onTaskOnly));
  return primary ? { sessionFile: primary.sessionFile, name: sessionName(primary.title), live: primary.live } : null;
}

/**
 * Moves a task to Shipped and closes the relay tabs of its sessions, so finished work doesn't leave
 * windows behind. omp keeps their conversations to resume. A session still working, or one that
 * moved on to another task, stays open.
 */
async function completeTask(id: number): Promise<string> {
  const db = openBoardStore();
  try {
    reportTask(db, id, { stage: "done", blocked: null, at: new Date().toISOString() });
  } finally {
    db.close();
  }
  const open = sessionsOfTask(id, await liveSessions()).filter((session) => session.onTask && session.live);
  const idle = open.filter((session) => session.live!.status === "idle");
  for (const session of idle) await killWindow(session.live!.windowId);
  const closed = idle.length ? `; closed ${idle.length === 1 ? "its session" : `${idle.length} sessions`}` : "";
  const working = open.length - idle.length;
  const kept = working ? `; left ${working === 1 ? "a working session" : `${working} working sessions`} open` : "";
  return `Shipped ${taskRef(id)}${closed}${kept}`;
}

/**
 * Starts a session on a task in a new background relay tab: omp in the task's folder, on the
 * task's model and thinking level when it names them, linked to the task as soon as it knows its
 * session file, then handed the task.
 */
async function startTask(task: Task): Promise<string> {
  const cwd = task.cwd && existsSync(task.cwd) ? task.cwd : homedir();
  const { paneId, sessionFile } = await openAgentTab(cwd, modelArgs(task.model, task.thinkingLevel));
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
 * task, `approve-plan` tells its session to carry out its plan, `open` shows its session;
 * `ship` and `done` finish it, closing its idle sessions, and `send-back` returns a task
 * its agent called finished and shows you its session. `pause` sets a task aside in Paused until
 * `unpause` takes it off hold, or `resume` does and shows its session (or starts one).
 * `track` asks an untracked session to register its task, `close-session` closes its relay tab.
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
        case "ship":
          if (!task.finishedAt) return { status: 409, message: `${taskRef(id)} isn't ready to ship` };
          break;
        case "send-back":
          if (!task.finishedAt) return { status: 409, message: `${taskRef(id)} isn't ready to ship` };
          sendBack(db, id, at);
          break;
        case "pause":
          if (task.stage === "done") return { status: 409, message: `${taskRef(id)} is already shipped` };
          pauseTask(db, id, at);
          return { status: 200, message: `Paused ${taskRef(id)}` };
        case "unpause":
          resumeTask(db, id, at);
          return { status: 200, message: `Unpaused ${taskRef(id)}` };
        case "resume":
          resumeTask(db, id, at);
          break;
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
    if (action === "resume") {
      const session = taskSession(id, await liveSessions(), false);
      return { status: 200, message: session ? await showSession(session.sessionFile, session.live, session.name) : await startTask(task) };
    }
    if (action === "ship" || action === "done") return { status: 200, message: await completeTask(id) };
    const session = taskSession(id, await liveSessions(), action === "approve-plan");
    if (!session) {
      if (action === "send-back") return { status: 200, message: `Sent ${taskRef(id)} back; it has no session to open` };
      return { status: 409, message: action === "approve-plan" ? `${taskRef(id)} has no session to carry out its plan` : `${taskRef(id)} has no session yet` };
    }
    if (action === "open" || action === "send-back") return { status: 200, message: await showSession(session.sessionFile, session.live, session.name) };

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
    case "close-session":
      // Like closing it from the phone: its tab goes, and omp keeps the conversation to resume.
      await killWindow(live.get(sessionFile)!.windowId);
      return { status: 200, message: `Closed "${session.name}"` };
  }
}

/** A task as the board's New Task sheet sends it. */
export interface NewTaskRequest {
  title: string;
  details?: string;
  /** Screenshots pasted into its details, saved for its agent to read. */
  images: UploadedImage[];
  /** A project's name: an existing one, or a new one to create. */
  project?: string;
  approvePlan: boolean;
  /** Start a session on it now, rather than keeping it as an idea. */
  start: boolean;
  /** A `provider/id` from `omp models`; omitted for omp's default. */
  model?: string;
  /** omp's thinking level for its sessions; omitted for the default. */
  thinkingLevel?: string;
}

/** Where sessions on tasks made from the board start: a scratch folder, since agents pick their repos themselves. */
const NEW_TASK_FOLDER = "/tmp";

/** Creates a task from the board, starting a session on it when asked. */
export async function createTaskFromBoard(request: NewTaskRequest): Promise<BoardActionResult & { task?: number }> {
  const title = request.title.trim();
  if (!title) return { status: 400, message: "a task needs a title" };
  if (request.model && !(await listModels()).some((option) => option.selector === request.model)) {
    return { status: 400, message: `omp has no model ${request.model}` };
  }
  // Its screenshots go below what you wrote, one "[Attached image: <path>]" line each, like the phone's.
  const attachments = (await saveUploadedImages(request.images)).join("\n");
  const details = [request.details?.trim(), attachments].filter(Boolean).join("\n\n") || null;
  const at = new Date().toISOString();
  const db = openBoardStore();
  let task: Task;
  try {
    task = createTask(db, {
      title,
      details,
      projectId: request.project?.trim() ? ensureProject(db, request.project.trim(), at).id : null,
      stage: "idea",
      status: null,
      approvePlan: request.approvePlan,
      cwd: NEW_TASK_FOLDER,
      model: request.model ?? null,
      thinkingLevel: request.thinkingLevel ?? null,
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

/** What the board's sidebar asks of projects: `POST /api/board/projects/<action>`. */
export const PROJECT_ACTIONS = ["create", "rename", "delete"] as const;

/** The body of a project control: the project to act on, its new name, and where a new one goes. */
export interface ProjectActionRequest {
  project?: number;
  name?: string;
  /** A new project's parent; left out for a top-level one. */
  parent?: number;
}

/** Makes, renames, or deletes a project from the board's sidebar. */
export function runProjectAction(action: string, request: ProjectActionRequest): BoardActionResult {
  if (!(PROJECT_ACTIONS as readonly string[]).includes(action)) return { status: 404, message: `no project action ${action}` };
  const db = openBoardStore();
  try {
    if (action === "create") {
      const project = createProject(db, request.name ?? "", request.parent ?? null, new Date().toISOString());
      const parent = project.parentId !== null ? getProject(db, project.parentId) : null;
      return { status: 200, message: parent ? `Made ${project.name} inside ${parent.name}` : `Made ${project.name}` };
    }
    if (request.project === undefined) return { status: 400, message: "which project?" };
    const project = getProject(db, request.project);
    if (!project) return { status: 404, message: `no project ${request.project}` };
    if (action === "rename") {
      const renamed = renameProject(db, project.id, request.name ?? "");
      return { status: 200, message: `Renamed ${project.name} to ${renamed.name}` };
    }
    deleteProject(db, project.id);
    return { status: 200, message: `Deleted ${project.name}; what was in it moved up` };
  } catch (error) {
    return { status: 400, message: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
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
  const thinkingLevel = text("thinkingLevel") || undefined;
  if (thinkingLevel && THINKING_LEVELS[thinkingLevel] !== true) throw new Error(`unknown thinking level: ${thinkingLevel}`);
  return {
    title,
    details: text("details"),
    images: parseUploadedImages(body.images),
    project: text("project"),
    approvePlan: body.approvePlan !== false,
    start: body.start === true,
    model: text("model") || undefined,
    thinkingLevel,
  };
}
