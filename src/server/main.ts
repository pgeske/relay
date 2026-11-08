import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { fetchBoardView, isLocalRequest, readActionBody, runBoardAction } from "../board/serve.ts";
import { createTaskFromBoard, parseNewTask, readJsonBody, runProjectAction, runTaskAction, type NewTaskRequest } from "../board/taskServe.ts";
import { endLiveCall, recoverInterruptedCall, startLiveCall } from "./live.ts";
import { askAnswerSteps, findPendingAsk, validateAskAnswers, type AskAnswer } from "./ask.ts";
import { startSessionEvents } from "./events.ts";
import { readEntryImage, readMessagePage } from "./messages.ts";
import { isVoiceEnabled } from "../voice.ts";
import { findSessionPane, listSessions, toSession, type Session } from "./sessions.ts";
import { THINKING_LEVELS, configuredDefaults, listModels, rememberChoice } from "./modelState.ts";
import { resolveSessionFile } from "./sessionFile.ts";
import {
  adoptLoginShellEnv,
  createDetachedSession,
  killWindow,
  listPanes,
  mainSessionName,
  newWindow,
  pasteOnly,
  pasteText,
  selectWindow,
  sendKeys,
  writeConfig,
  type Pane,
} from "../tmux.ts";
import { TOKEN_PATH, SERVER_PORT } from "../paths.ts";
import { loadToken, tokenMatches } from "../token.ts";
import { refreshUpdateNotice } from "../update.ts";
import { installSkill } from "../skill.ts";
import { VERSION } from "../version.ts";
import { parseUploadedImages, saveUploadedImages } from "./uploads.ts";

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 60;
const MAX_PAGE_LIMIT = 500;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Room for hanging up a live call (ending omp's live mode, restoring devices) before exiting. */
const SHUTDOWN_TIMEOUT_MS = 12_000;

/** Keys the phone may press: enough for Stop and answering interactive TUI prompts. */
const ALLOWED_KEYS: Record<string, true> = {
  Escape: true,
  Enter: true,
  Up: true,
  Down: true,
  Left: true,
  Right: true,
  Tab: true,
  BTab: true,
  "C-c": true,
  Space: true,
  y: true,
  n: true,
  ...Object.fromEntries("0123456789".split("").map((digit) => [digit, true as const])),
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAllowedAddress(address: string | undefined): boolean {
  if (!address) return false;
  // IPv4 clients arrive as ::ffff:a.b.c.d over a dual-stack listener.
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (ip === "::1") return true;
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // 100.64.0.0/10 — Tailscale's address range.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  // Private/link-local IPv6 (Tailscale uses fd7a:... inside fc00::/7).
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  return false;
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  return match !== null && tokenMatches(match[1]);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function pageLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

/** Cwd for a new window: the focused pane's cwd, else $HOME. */
async function defaultCwd(): Promise<string> {
  const panes = await listPanes();
  const focused = panes.find((pane) => pane.windowActive && pane.sessionAttached);
  return focused?.cwd ?? homedir();
}

/** Waits for the freshly created window to run omp and write a brand-new session file. */
async function waitForSession(paneId: string): Promise<Session> {
  const deadline = Date.now() + 6000;
  const startedAt = Date.now() - 2000;
  let lastSeen: Pane | undefined;
  while (Date.now() < deadline) {
    const pane = (await listPanes()).find((candidate) => candidate.paneId === paneId);
    if (pane) {
      lastSeen = pane;
      if (pane.command === "omp") {
        const session = await toSession(pane, { pointerWrittenAfter: startedAt });
        if (session.sessionFile) return session;
      }
    }
    await sleep(150);
  }
  if (lastSeen) {
    const session = await toSession(lastSeen);
    return { ...session, sessionFile: null, updatedAt: new Date(0).toISOString() };
  }
  throw new HttpError(500, "created window did not appear in tmux");
}

async function createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const requestedCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : null;
  const cwd = requestedCwd ?? (await defaultCwd());

  const mainSession = await mainSessionName();
  const paneId = mainSession ? await newWindow(mainSession, cwd) : await createDetachedSession(cwd);
  const session = await waitForSession(paneId);
  sendJson(res, 200, { session });
}

async function handleInput(req: IncomingMessage, res: ServerResponse, pane: Pane): Promise<void> {
  const body = await readJson(req);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  let images;
  try {
    images = parseUploadedImages(body.images);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "invalid image");
  }
  const attachmentLines = await saveUploadedImages(images);

  const message = [text, ...attachmentLines].filter((part) => part.length > 0).join("\n");
  if (message.length === 0) throw new HttpError(400, "empty message");

  await pasteText(pane.paneId, message);
  sendJson(res, 200, { ok: true });
}

async function handleKeys(req: IncomingMessage, res: ServerResponse, pane: Pane): Promise<void> {
  const body = await readJson(req);
  const keys = Array.isArray(body.keys) ? body.keys : null;
  if (!keys || keys.length === 0) throw new HttpError(400, "keys must be a non-empty array");
  for (const key of keys) {
    if (typeof key !== "string" || ALLOWED_KEYS[key] !== true) {
      throw new HttpError(400, `unsupported key: ${String(key)}`);
    }
  }
  await sendKeys(pane.paneId, keys as string[]);
  sendJson(res, 200, { ok: true });
}

/** Ask calls whose answer keystrokes are being typed right now, so a double tap can't type them twice. */
const answeringAsks = new Set<string>();

function parseAskAnswers(raw: unknown): AskAnswer[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "answers must be an array");
  return raw.map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const options = Array.isArray(record.options) ? record.options : [];
    if (!options.every((option) => typeof option === "number")) throw new HttpError(400, "options must be numbers");
    return {
      options: options as number[],
      ...(typeof record.custom === "string" ? { custom: record.custom } : {}),
    };
  });
}

/** Answers the pane's open `ask` dialog by pressing the keys the TUI would get from a person. */
async function handleAnswerAsk(req: IncomingMessage, res: ServerResponse, pane: Pane): Promise<void> {
  const body = await readJson(req);
  const toolCallId = typeof body.toolCallId === "string" ? body.toolCallId : "";
  if (!toolCallId) throw new HttpError(400, "missing toolCallId");
  const answers = parseAskAnswers(body.answers);

  const sessionFile = await resolveSessionFile(pane);
  const pending = sessionFile ? await findPendingAsk(sessionFile, toolCallId) : null;
  if (!pending || answeringAsks.has(toolCallId)) throw new HttpError(409, "this question was already answered");
  const invalid = validateAskAnswers(pending.questions, answers);
  if (invalid) throw new HttpError(400, invalid);

  answeringAsks.add(toolCallId);
  try {
    for (const step of askAnswerSteps(pending.questions, answers)) {
      if ("keys" in step) await sendKeys(pane.paneId, step.keys);
      else if ("paste" in step) await pasteOnly(pane.paneId, step.paste);
      else await sleep(step.waitMs);
    }
  } finally {
    answeringAsks.delete(toolCallId);
  }
  sendJson(res, 200, { ok: true });
}

/** Switches model and/or thinking level by typing omp's own `/switch` and `/effort` commands. */
async function handleSetModel(req: IncomingMessage, res: ServerResponse, pane: Pane): Promise<void> {
  const body = await readJson(req);
  const model = typeof body.model === "string" ? body.model : null;
  const thinkingLevel = typeof body.thinkingLevel === "string" ? body.thinkingLevel : null;
  if (!model && !thinkingLevel) throw new HttpError(400, "model or thinkingLevel is required");
  if (model && !(await listModels()).some((option) => option.selector === model)) {
    throw new HttpError(400, `unknown model: ${model}`);
  }
  if (thinkingLevel && THINKING_LEVELS[thinkingLevel] !== true) {
    throw new HttpError(400, `unknown thinking level: ${thinkingLevel}`);
  }

  if (model) await pasteText(pane.paneId, `/switch ${model}`);
  if (thinkingLevel) await pasteText(pane.paneId, `/effort ${thinkingLevel}`);
  rememberChoice(await resolveSessionFile(pane), {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  sendJson(res, 200, { ok: true });
}

async function handleMessages(
  res: ServerResponse,
  pane: Pane,
  url: URL,
): Promise<void> {
  const sessionFile = await resolveSessionFile(pane);
  if (!sessionFile) {
    sendJson(res, 200, { messages: [], hasMore: false, sessionFile: null });
    return;
  }

  const before = url.searchParams.get("before") ?? undefined;
  try {
    const page = await readMessagePage(sessionFile, pane.paneId, {
      before,
      limit: pageLimit(url.searchParams.get("limit")),
    });
    if (!page.beforeFound) {
      sendJson(res, 404, { error: "message not found" });
      return;
    }
    sendJson(res, 200, { messages: page.messages, hasMore: page.hasMore, sessionFile });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      sendJson(res, 200, { messages: [], hasMore: false, sessionFile: null });
      return;
    }
    throw error;
  }
}

async function handleImage(
  res: ServerResponse,
  pane: Pane,
  entryId: string,
  indexRaw: string,
): Promise<void> {
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isFinite(index) || index < 0) throw new HttpError(400, "invalid image index");

  const sessionFile = await resolveSessionFile(pane);
  if (!sessionFile) throw new HttpError(404, "image not found");

  const image = await readEntryImage(sessionFile, entryId, index);
  if (!image) throw new HttpError(404, "image not found");

  res.writeHead(200, {
    "Content-Type": image.contentType,
    "Content-Length": String(image.bytes.length),
    "Cache-Control": "private, max-age=3600",
  });
  res.end(image.bytes);
}

/**
 * The Relay Board app's endpoints: `GET /api/board` is the board as the app shows it, and
 * `POST /api/board/actions/<action>` with `{ "pr": "owner/repo#12" }` runs one of a card's controls.
 * `POST /api/board/tasks` creates a task, and `POST /api/board/tasks/actions/<action>` with
 * `{ "task": 12 }` (or `{ "session": "<file>" }`) runs one of a task card's controls.
 * `POST /api/board/projects/<create|rename|delete>` with `{ "project": 3, "name": "…", "parent": 1 }`
 * manages the sidebar's projects.
 */
async function routeBoard(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
  if (rest.length === 0) {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    sendJson(res, 200, await fetchBoardView());
    return;
  }
  if (rest[0] === "tasks") {
    await routeTasks(req, res, rest.slice(1));
    return;
  }
  if (rest[0] === "projects" && rest.length === 2) {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "bad request");
    }
    const result = runProjectAction(rest[1], {
      project: typeof body.project === "number" ? body.project : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      parent: typeof body.parent === "number" ? body.parent : undefined,
    });
    sendJson(res, result.status, result.status < 300 ? { message: result.message } : { error: result.message });
    return;
  }
  if (rest.length !== 2 || rest[0] !== "actions") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  let pr: string;
  try {
    pr = await readActionBody(req);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "bad request");
  }
  const result = await runBoardAction(rest[1], pr);
  sendJson(res, result.status, result.status < 300 ? { message: result.message } : { error: result.message });
}

async function routeTasks(req: IncomingMessage, res: ServerResponse, rest: string[]): Promise<void> {
  const isCreate = rest.length === 0;
  if (!isCreate && (rest.length !== 2 || rest[0] !== "actions")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (req.method !== "POST") throw new HttpError(405, "method not allowed");
  let body: Record<string, unknown>;
  let request: NewTaskRequest | null = null;
  try {
    body = await readJsonBody(req);
    if (isCreate) request = parseNewTask(body);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "bad request");
  }
  const result = request
    ? await createTaskFromBoard(request)
    : await runTaskAction(rest[1], {
        task: typeof body.task === "number" ? body.task : undefined,
        session: typeof body.session === "string" ? body.session : undefined,
        plan: typeof body.plan === "string" ? body.plan : undefined,
      });
  sendJson(res, result.status, result.status < 300 ? { message: result.message } : { error: result.message });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const [, resource, rawId, action, ...rest] = segments;
  if (resource === "board") {
    await routeBoard(req, res, segments.slice(2));
    return;
  }
  if (resource === "models" && !rawId) {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed");
    // `defaults` is what a new omp starts on, for pickers that offer "omp's default".
    const [models, defaults] = await Promise.all([listModels(), configuredDefaults()]);
    sendJson(res, 200, { models, defaults });
    return;
  }
  if (resource !== "sessions") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (!rawId) {
    if (req.method === "GET") {
      sendJson(res, 200, { sessions: await listSessions() });
      return;
    }
    if (req.method === "POST") {
      await createSession(req, res);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const pane = await findSessionPane(rawId);
  if (!pane) {
    sendJson(res, 404, { error: "unknown session" });
    return;
  }

  switch (`${req.method} ${action ?? ""}`) {
    case "DELETE ":
      await killWindow(pane.windowId);
      sendJson(res, 200, { ok: true });
      return;
    case "GET messages":
      await handleMessages(res, pane, url);
      return;
    case "GET events":
      startSessionEvents(res, pane);
      return;
    case "GET images": {
      const [entryId, indexRaw] = rest;
      if (!entryId || !indexRaw) throw new HttpError(400, "missing image path");
      await handleImage(res, pane, entryId, indexRaw);
      return;
    }
    case "POST input":
      await handleInput(req, res, pane);
      return;
    case "POST keys":
      await handleKeys(req, res, pane);
      return;
    case "POST ask":
      await handleAnswerAsk(req, res, pane);
      return;
    case "POST focus":
      await selectWindow(pane.windowId);
      sendJson(res, 200, { ok: true });
      return;
    case "POST model":
      await handleSetModel(req, res, pane);
      return;
    default:
      sendJson(res, 404, { error: "not found" });
  }
}

/** Splits "/api/sessions/%2572/messages" into decoded segments; null when a segment is malformed. */
function pathSegments(url: URL): string[] | null {
  try {
    return url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAllowedAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://relay.local");
  const segments = pathSegments(url);
  if (!segments) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }

  if (req.method === "GET" && segments[0] === "api" && segments[1] === "health" && segments.length === 2) {
    sendJson(res, 200, { ok: true, version: VERSION, voice: isVoiceEnabled() });
    return;
  }
  if (segments[0] !== "api") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  // The board's controls type into your sessions, so its endpoints answer only this computer, besides needing the token.
  if (segments[1] === "board" && !isLocalRequest(req)) {
    sendJson(res, 403, { error: "the board only answers this computer" });
    return;
  }
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  await route(req, res, url, segments);
}

const liveSockets = new WebSocketServer({ noServer: true });

/** The only WebSocket route: `/api/sessions/<id>/live` carries a live voice call. */
async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const reject = (status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  if (!isAllowedAddress(req.socket.remoteAddress)) return reject(403, "Forbidden");
  if (!isAuthorized(req)) return reject(401, "Unauthorized");

  const segments = pathSegments(new URL(req.url ?? "/", "http://relay.local"));
  const [api, resource, paneId, action] = segments ?? [];
  if (segments?.length !== 4 || api !== "api" || resource !== "sessions" || action !== "live") {
    return reject(404, "Not Found");
  }
  if (!isVoiceEnabled()) return reject(403, "Voice Disabled");
  const pane = await findSessionPane(paneId);
  if (!pane) return reject(404, "Not Found");

  liveSockets.handleUpgrade(req, socket, head, (webSocket) => startLiveCall(webSocket, pane));
}

/** Answers one HTTP request, turning whatever it throws into a JSON error. */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch((error: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    console.error("request failed", error);
    sendJson(res, 500, { error: "internal error" });
  });
}

/** Runs the phone server in the foreground until SIGINT/SIGTERM. */
export function runServer(): void {
  loadToken();
  writeConfig();
  installSkill();
  // Agents this server starts should see what a terminal tab would; every tmux call waits for this.
  void adoptLoginShellEnv().catch((error: unknown) => console.error("could not pass the login-shell environment to tmux", error));

  const server = createServer(handleRequest);
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleUpgrade(req, socket, head).catch((error: unknown) => {
      console.error("upgrade failed", error);
      socket.destroy();
    });
  });

  // A server that stopped mid-call may have left omp live and the Mac's audio routed into
  // BlackHole; clean that up before taking new calls.
  void recoverInterruptedCall()
    .catch((error: unknown) => console.error("live: could not clean up the interrupted call", error))
    .finally(() => {
      server.listen(SERVER_PORT, "0.0.0.0", () => {
        console.log(`relay ${VERSION} server listening on http://0.0.0.0:${SERVER_PORT}`);
        console.log(`auth token: ${TOKEN_PATH}`);
      });
    });

  // The server is the long-lived process, so it keeps the "update available" tab hint fresh.
  const checkForUpdate = () => void refreshUpdateNotice().catch(() => {});
  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS).unref();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Hang up first so omp leaves live mode and the Mac gets its own audio devices back.
      // Open event streams would keep server.close() waiting, so exit once the call is down.
      server.close();
      void endLiveCall().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    });
  }
}
