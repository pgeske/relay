import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEntryImage, readMessagePage, type Message } from "../server/messages.ts";
import { THINKING_LEVELS, listModels } from "../server/modelState.ts";
import { SESSIONS_DIR } from "../server/sessionFile.ts";
import { parsePaneTitle } from "../server/sessions.ts";
import { parseUploadedImages, saveUploadedImages, type UploadedImage } from "../server/uploads.ts";
import { pasteText, type Pane } from "../tmux.ts";
import { liveSessions } from "./command.ts";
import { readSessionHeader } from "./owners.ts";
import { ActionError, modelArgs, openAgentTab, reopen, showSession, waitUntilReady, type BoardActionResult } from "./serve.ts";
import { openBoardStore } from "./store.ts";
import { displayFolder, sessionTitle, taskHue, type TaskChipView } from "./taskBoard.ts";
import { getTask, linkSession, listTasks, taskRef, taskSessions } from "./taskStore.ts";

/**
 * The board's Chats: your omp sessions as conversations you can read and type into from Relay
 * Board, like a chat app. Open sessions come first; closed ones stay readable, and typing into one
 * reopens it in a background relay tab.
 */

/** A conversation in the Chats list. */
export interface ChatView {
  sessionFile: string;
  title: string;
  /** The Nerd Font icon omp puts in front of the title, if it has one. */
  icon: string | null;
  /** Where it runs, with ~ for your home. */
  folder: string | null;
  state: "working" | "idle" | "closed";
  /** Its relay tab's pane while it's open, for the phone's session endpoints (live stream, Stop, answers). */
  paneId: string | null;
  /** When it last wrote to its conversation. */
  updatedAt: string;
  /** The task it's on, if any. */
  task: TaskChipView | null;
}

/** Closed sessions this recent show in the list, besides every open one and every one a task has. */
const RECENT_DAYS = 30;
/** The list stops here; older conversations are a search in the terminal away. */
const MAX_CHATS = 300;
/** Where conversations started from the board run: a scratch folder, as tasks do, since agents pick their repos themselves. */
const NEW_CHAT_FOLDER = "/tmp";

/** Titles and folders by session file, read again only when the file changes. */
const headerCache = new Map<string, { mtimeMs: number; title: string; cwd: string | null }>();

function header(sessionFile: string, mtimeMs: number): { title: string; cwd: string | null } {
  const cached = headerCache.get(sessionFile);
  if (cached?.mtimeMs === mtimeMs) return cached;
  const read = { mtimeMs, ...readSessionHeader(sessionFile) };
  headerCache.set(sessionFile, read);
  return read;
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Top-level conversations omp saved since `sinceMs`; subagents' logs nest a level deeper and stay out. */
function recentSessionFiles(sinceMs: number): string[] {
  let projects: string[];
  try {
    projects = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(join(SESSIONS_DIR, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(SESSIONS_DIR, project, name);
      if ((mtimeOf(file) ?? 0) >= sinceMs) files.push(file);
    }
  }
  return files;
}

/** The task each session is on now: the one it linked to last. */
function currentTasks(): Map<string, TaskChipView> {
  const db = openBoardStore();
  try {
    const tasks = new Map(listTasks(db).map((task) => [task.id, task]));
    const latest = new Map<string, { taskId: number; linkedAt: string }>();
    for (const link of taskSessions(db)) {
      const seen = latest.get(link.sessionFile);
      if (!seen || link.linkedAt > seen.linkedAt) latest.set(link.sessionFile, link);
    }
    const chips = new Map<string, TaskChipView>();
    for (const [sessionFile, { taskId }] of latest) {
      const task = tasks.get(taskId);
      if (task) chips.set(sessionFile, { id: task.id, ref: taskRef(task.id), title: task.title, hue: taskHue(task.id) });
    }
    return chips;
  } finally {
    db.close();
  }
}

/** A Nerd Font glyph: a character in one of Unicode's private use areas. */
const TITLE_ICON = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/u;

/** Builds the Chats list from what's open, what tasks know, and what omp saved lately. Newest first. */
export function chatsView(live: Map<string, Pane>, tasks: Map<string, TaskChipView>, recent: string[], now: number): ChatView[] {
  const home = homedir();
  const chats: ChatView[] = [];
  for (const sessionFile of new Set([...live.keys(), ...tasks.keys(), ...recent])) {
    const pane = live.get(sessionFile);
    const mtimeMs = mtimeOf(sessionFile);
    // A closed session whose file is gone has nothing left to read. A brand-new one has no file
    // until its first message, so it counts as active right now.
    if (mtimeMs === null && !pane) continue;
    const saved = mtimeMs === null ? { title: "", cwd: null } : header(sessionFile, mtimeMs);
    const paneState = pane ? parsePaneTitle(pane.title, pane.cwd) : null;
    const rawTitle = paneState?.title || saved.title;
    chats.push({
      sessionFile,
      title: sessionTitle(rawTitle),
      icon: TITLE_ICON.exec(rawTitle)?.[0] ?? null,
      folder: displayFolder(pane?.cwd ?? saved.cwd, home),
      state: paneState?.status ?? "closed",
      paneId: pane?.paneId ?? null,
      updatedAt: new Date(mtimeMs ?? now).toISOString(),
      task: tasks.get(sessionFile) ?? null,
    });
  }
  return chats.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_CHATS);
}

export async function listChats(): Promise<ChatView[]> {
  const now = Date.now();
  return chatsView(await liveSessions(), currentTasks(), recentSessionFiles(now - RECENT_DAYS * 86_400_000), now);
}

/**
 * Whether a path the app sent names one of omp's conversations: a `.jsonl` right inside a project
 * folder of omp's sessions. Anything else (a subagent's log, a file elsewhere) isn't a chat.
 */
export function isSessionFile(path: string): boolean {
  if (resolve(path) !== path || !path.endsWith(".jsonl")) return false;
  return path.startsWith(`${SESSIONS_DIR}/`) && path.slice(SESSIONS_DIR.length + 1).split("/").length === 2;
}

function checkedSessionFile(raw: unknown): string {
  if (typeof raw !== "string" || !isSessionFile(raw)) throw new ActionError(400, "that isn't one of omp's sessions");
  return raw;
}

/** Where the app fetches a chat's images, open or closed. */
function chatImageUrl(sessionFile: string) {
  return (entryId: string, index: number) =>
    `/api/board/chats/images?session=${encodeURIComponent(sessionFile)}&entry=${encodeURIComponent(entryId)}&index=${index}`;
}

/** A page of a chat's conversation, ending just before `before` (or at its latest message). */
export async function readChatPage(rawSessionFile: unknown, before: string | undefined, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
  const sessionFile = checkedSessionFile(rawSessionFile);
  try {
    const page = await readMessagePage(sessionFile, chatImageUrl(sessionFile), { before, limit });
    if (!page.beforeFound) throw new ActionError(404, "message not found");
    return { messages: page.messages, hasMore: page.hasMore };
  } catch (error) {
    // A new session writes its file with its first message.
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { messages: [], hasMore: false };
    throw error;
  }
}

export async function readChatImage(rawSessionFile: unknown, entryId: string, index: number): Promise<{ bytes: Buffer; contentType: string } | null> {
  return readEntryImage(checkedSessionFile(rawSessionFile), entryId, index);
}

/** The text a message sends: what you typed, then one "[Attached image: <path>]" line per screenshot. */
async function messageText(text: string, images: UploadedImage[]): Promise<string> {
  const message = [text.trim(), ...(await saveUploadedImages(images))].filter(Boolean).join("\n");
  if (!message) throw new ActionError(400, "empty message");
  return message;
}

/** A new chat as the app sends it: its first message, and the model and thinking level it starts on. */
export interface NewChatRequest {
  text: string;
  images: UploadedImage[];
  model?: string;
  thinkingLevel?: string;
}

export function parseNewChat(body: Record<string, unknown>): NewChatRequest {
  const optional = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${key} must be text`);
    return value;
  };
  const thinkingLevel = optional("thinkingLevel");
  if (thinkingLevel && THINKING_LEVELS[thinkingLevel] !== true) throw new Error(`unknown thinking level: ${thinkingLevel}`);
  return { text: optional("text") ?? "", images: parseUploadedImages(body.images), model: optional("model"), thinkingLevel };
}

/**
 * Starts a conversation: omp in a new background relay tab, on the model asked for, handed the
 * first message. Returns the chat to show, so the app can follow it from its first reply.
 */
export async function createChat(request: NewChatRequest): Promise<BoardActionResult & { chat?: { sessionFile: string; paneId: string } }> {
  try {
    const text = await messageText(request.text, request.images);
    if (request.model && !(await listModels()).some((option) => option.selector === request.model)) {
      return { status: 400, message: `omp has no model ${request.model}` };
    }
    const { paneId, sessionFile } = await openAgentTab(NEW_CHAT_FOLDER, modelArgs(request.model, request.thinkingLevel));
    await pasteText(paneId, text);
    if (!sessionFile) return { status: 502, message: "Started the chat in a new relay tab, but omp didn't say where it saves it" };
    return { status: 200, message: "Started a new chat", chat: { sessionFile, paneId } };
  } catch (error) {
    if (error instanceof ActionError) return { status: error.status, message: error.message };
    throw error;
  }
}

/** What a chat control acts on, as the app sends it. */
export interface ChatActionBody {
  session?: unknown;
  text?: unknown;
  images?: unknown;
  task?: unknown;
}

export const CHAT_ACTIONS = ["send", "link", "open"] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

function linkPrompt(taskId: number, title: string): string {
  return (
    `I added this session to ${taskRef(taskId)} ("${title}") on the relay board. ` +
    "Keep that task current from here on, following the Tasks section of the relay skill."
  );
}

/**
 * Runs a chat's control. `send` types a message into it, reopening a closed chat in a background
 * tab first; `link` puts it on a task and tells it so; `open` shows it in your terminal.
 */
export async function runChatAction(action: string, body: ChatActionBody): Promise<BoardActionResult & { paneId?: string }> {
  try {
    if (!(CHAT_ACTIONS as readonly string[]).includes(action)) return { status: 404, message: `no such action: ${action}` };
    const sessionFile = checkedSessionFile(body.session);
    const pane = (await liveSessions()).get(sessionFile) ?? null;
    const name = sessionTitle(pane ? parsePaneTitle(pane.title, pane.cwd).title : readSessionHeader(sessionFile).title);
    switch (action as ChatAction) {
      case "send": {
        let images: UploadedImage[];
        try {
          images = parseUploadedImages(body.images);
        } catch (error) {
          throw new ActionError(400, error instanceof Error ? error.message : "invalid image");
        }
        const text = await messageText(typeof body.text === "string" ? body.text : "", images);
        let paneId = pane?.paneId;
        if (!paneId) {
          paneId = await reopen(sessionFile, false);
          await waitUntilReady(paneId);
        }
        await pasteText(paneId, text);
        return { status: 200, message: pane ? "Sent" : `Reopened "${name}" and sent your message`, paneId };
      }
      case "link": {
        if (typeof body.task !== "number") return { status: 400, message: "missing task" };
        const db = openBoardStore();
        let title: string;
        try {
          const task = getTask(db, body.task);
          if (!task) return { status: 404, message: `there's no ${taskRef(body.task)}` };
          title = task.title;
          linkSession(db, task.id, sessionFile, new Date().toISOString());
        } finally {
          db.close();
        }
        // An open chat hears it at once; a closed one isn't reopened just to be told.
        if (pane) await pasteText(pane.paneId, linkPrompt(body.task, title));
        return { status: 200, message: `Added "${name}" to ${taskRef(body.task)}` };
      }
      case "open":
        return { status: 200, message: await showSession(sessionFile, pane, name) };
    }
  } catch (error) {
    if (error instanceof ActionError) return { status: error.status, message: error.message };
    throw error;
  }
}
