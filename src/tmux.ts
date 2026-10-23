import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import bundledConfig from "./mux/tmux.conf" with { type: "text" };
import { TMUX_CONF_PATH } from "./paths.ts";

/**
 * relay runs a private tmux server on its own socket, started with relay's own config
 * instead of ~/.tmux.conf, so it looks and behaves the same on every machine.
 */
export const SOCKET_NAME = process.env.RELAY_TMUX_SOCKET || "relay";
export const SESSION_NAME = "relay";
/** The agent every new tab runs. */
export const AGENT_COMMAND = "omp";

/** Field separator for tmux -F output; a control character that never appears in titles. */
const FIELD_SEPARATOR = "\u001f";

const PANE_FORMAT = [
  "#{session_name}",
  "#{window_id}",
  "#{window_index}",
  "#{window_active}",
  "#{session_attached}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_tty}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{window_bell_flag}",
  "#{pane_title}",
].join(FIELD_SEPARATOR);

const TMUX_CANDIDATES = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/opt/local/bin/tmux",
  "/usr/bin/tmux",
];

export type Pane = {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowActive: boolean;
  sessionAttached: boolean;
  paneId: string;
  panePid: string;
  paneTty: string;
  command: string;
  cwd: string;
  bellFlag: boolean;
  /** Raw pane title, e.g. "π > 󱓷 JADE: ...". */
  title: string;
};

export type TmuxSession = {
  name: string;
  attached: boolean;
  activity: number;
};

let cachedBinary: string | null = null;

export function tmuxBinary(): string {
  if (cachedBinary) return cachedBinary;
  const found = TMUX_CANDIDATES.find((candidate) => existsSync(candidate));
  cachedBinary = found ?? "tmux";
  return cachedBinary;
}

/**
 * Writes relay's tmux config to disk when it differs from the copy on disk, returning
 * whether it changed. Machines whose terminfo lacks tmux-256color (older ncurses) fall
 * back to screen-256color so programs inside panes still recognise the terminal.
 */
export function writeConfig(): boolean {
  const hasTmuxTerminfo = spawnSync("infocmp", ["tmux-256color"], { stdio: "ignore" }).status === 0;
  const config = hasTmuxTerminfo ? bundledConfig : `${bundledConfig}\nset -g default-terminal "screen-256color"\n`;
  if (existsSync(TMUX_CONF_PATH) && readFileSync(TMUX_CONF_PATH, "utf8") === config) return false;
  mkdirSync(dirname(TMUX_CONF_PATH), { recursive: true });
  writeFileSync(TMUX_CONF_PATH, config);
  return true;
}

/**
 * Every tmux call targets relay's socket. `-f` only matters when the call starts the
 * server, which is exactly when relay's config must be used instead of ~/.tmux.conf.
 */
export function tmuxArgs(args: string[]): string[] {
  return ["-L", SOCKET_NAME, "-f", TMUX_CONF_PATH, ...args];
}

/**
 * tmux replaces non-ASCII and control characters with `_` when the locale is not UTF-8,
 * which is the case under launchd. That would mangle titles and our field separator.
 * Variables from an enclosing tmux or Herdr pane are dropped so relay never nests into
 * or reports itself as part of another multiplexer.
 */
const hasUtf8Locale = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "");
export const TMUX_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries({ ...process.env, ...(hasUtf8Locale ? {} : { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" }) }).filter(
    ([key]) => key !== "TMUX" && key !== "TMUX_PANE" && !key.startsWith("HERDR_"),
  ),
);

/** Runs tmux with an argv array. Never goes through a shell. */
function tmux(args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    tmuxBinary(),
    tmuxArgs(args),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: TMUX_ENV },
    (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message).trim();
        reject(new Error(message || `tmux ${args[0]} failed`));
        return;
      }
      resolve(stdout);
    },
  );
  return promise;
}

/** Pipes stdin into tmux (load-buffer needs a stream, execFile cannot feed one). */
function tmuxWithInput(args: string[], input: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(tmuxBinary(), tmuxArgs(args), { stdio: ["pipe", "ignore", "pipe"], env: TMUX_ENV });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(stderr.trim() || `tmux ${args[0]} exited with ${code}`));
  });
  child.stdin.on("error", () => {
    // tmux may close stdin early; the exit code still tells us what happened.
  });
  child.stdin.end(input);
  return promise;
}

function parsePaneLine(line: string): Pane | null {
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length < 12) return null;
  const [sessionName, windowId, windowIndex, windowActive, sessionAttached, paneId, panePid, paneTty, command, cwd, bellFlag] = fields;
  const title = fields.slice(11).join(FIELD_SEPARATOR);
  return {
    sessionName,
    windowId,
    windowIndex: Number.parseInt(windowIndex, 10) || 0,
    windowActive: windowActive === "1",
    sessionAttached: Number.parseInt(sessionAttached, 10) > 0,
    paneId,
    panePid,
    paneTty,
    command,
    cwd,
    bellFlag: bellFlag === "1",
    title,
  };
}

/** Lists every pane; empty when relay's tmux server is not running yet. */
export async function listPanes(): Promise<Pane[]> {
  let output: string;
  try {
    output = await tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
  } catch (error) {
    if (/no server running|error connecting/.test(String(error))) return [];
    throw error;
  }
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parsePaneLine)
    .filter((pane): pane is Pane => pane !== null);
}

/** Every pane whose foreground process is the agent — one pane per remote session. */
export async function listOmpPanes(): Promise<Pane[]> {
  return (await listPanes()).filter((pane) => pane.command === AGENT_COMMAND);
}

export async function listTmuxSessions(): Promise<TmuxSession[]> {
  try {
    const output = await tmux([
      "list-sessions",
      "-F",
      ["#{session_name}", "#{session_attached}", "#{session_activity}"].join(FIELD_SEPARATOR),
    ]);
    return output
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, attached, activity] = line.split(FIELD_SEPARATOR);
        return {
          name,
          attached: Number.parseInt(attached, 10) > 0,
          activity: Number.parseInt(activity, 10) || 0,
        };
      });
  } catch {
    // "no server running" and friends: treat as no sessions.
    return [];
  }
}

/** Session that new windows are added to: the attached one, else the first. */
export async function mainSessionName(): Promise<string | null> {
  const sessions = await listTmuxSessions();
  if (sessions.length === 0) return null;
  const attached = sessions.find((session) => session.attached);
  return (attached ?? sessions[0]).name;
}

export async function createDetachedSession(cwd: string): Promise<string> {
  const output = await tmux([
    "new-session",
    "-d",
    "-s",
    SESSION_NAME,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    AGENT_COMMAND,
  ]);
  return output.trim();
}

/** Creates a detached relay session when relay's tmux server has no session at all. */
export async function ensureSession(): Promise<void> {
  if ((await listTmuxSessions()).length > 0) return;
  await createDetachedSession(homedir());
}

/** Creates a window running omp without selecting it, returning the new pane id. */
export async function newWindow(sessionName: string, cwd: string): Promise<string> {
  const output = await tmux([
    "new-window",
    "-d",
    "-t",
    // Trailing colon targets the session, not a window index: a session named "0"
    // would otherwise be read as window 0 and fail with "index 0 in use".
    `${sessionName}:`,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    AGENT_COMMAND,
  ]);
  return output.trim();
}

export async function killWindow(windowId: string): Promise<void> {
  await tmux(["kill-window", "-t", windowId]);
}

export async function selectWindow(windowId: string): Promise<void> {
  await tmux(["select-window", "-t", windowId]);
}

/** Pastes text into the pane (bracketed paste when the TUI supports it) and presses Enter. */
export async function pasteText(paneId: string, text: string): Promise<void> {
  await tmuxWithInput(["load-buffer", "-b", "relay-input", "-"], text);
  await tmux(["paste-buffer", "-p", "-d", "-b", "relay-input", "-t", paneId]);
  await sleep(150);
  await tmux(["send-keys", "-t", paneId, "Enter"]);
}

export async function sendKeys(paneId: string, keys: string[]): Promise<void> {
  await tmux(["send-keys", "-t", paneId, ...keys]);
}

/** Sets (or, with null, clears) a global tmux option on relay's server if it is running. */
export async function setGlobalOption(name: string, value: string | null): Promise<void> {
  if ((await listTmuxSessions()).length === 0) return;
  await tmux(value === null ? ["set-option", "-gu", name] : ["set-option", "-g", name, value]);
}

/** Re-applies relay's config to an already running server, e.g. after an update. */
export async function reloadConfig(): Promise<void> {
  if ((await listTmuxSessions()).length === 0) return;
  await tmux(["source-file", TMUX_CONF_PATH]);
}
