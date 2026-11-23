import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureSession, listOmpPanes, listTmuxSessions, type Pane } from "../tmux.ts";
import { resolveSessionFile, type ResolveOptions } from "./sessionFile.ts";
import { readModelState } from "./modelState.ts";

/** "asking": omp is waiting on the user to answer a question or pick a choice (its title's `!`). */
export type SessionStatus = "working" | "idle" | "asking";

export type Session = {
  id: string;
  windowId: string;
  windowIndex: number;
  tmuxSession: string;
  title: string;
  status: SessionStatus;
  unread: boolean;
  focused: boolean;
  cwd: string;
  sessionFile: string | null;
  updatedAt: string;
  /** Active `provider/id`, or null when unknown. */
  model: string | null;
  thinkingLevel: string | null;
};

/**
 * omp's pane title is `π > <title>` while idle, `π ! <title>` while it waits on the user to
 * answer a question, and `π <spinner> <title>` while working (braille, pulse, line, or `:` when
 * animated spinners are off; `π: <title>` with no space is omp's status-disabled format).
 * The nerd-font glyph that omp puts in front of the title is kept as-is.
 * Until omp names the session, the title is just the directory name; that comes back
 * empty so the app shows its placeholder instead of an internal path like "tmp".
 */
export function parsePaneTitle(raw: string, cwd: string): { title: string; status: SessionStatus } {
  const { title, status } = splitPaneTitle(raw);
  return { title: title === basename(cwd) ? "" : title, status };
}

/** Non-braille spinner frames omp emits while working (pulse, line, and static-working `:`). */
const WORKING_MARKERS: Record<string, true> = {
  "○": true, "◔": true, "◑": true, "◕": true, "●": true,
  "-": true, "\\": true, "|": true, "/": true, ":": true,
};

function isWorkingMarker(token: string): boolean {
  if (!token) return false;
  const code = token.codePointAt(0);
  if (code !== undefined && code >= 0x2800 && code <= 0x28ff && token.length === String.fromCodePoint(code).length) return true;
  return WORKING_MARKERS[token] === true;
}

function splitPaneTitle(raw: string): { title: string; status: SessionStatus } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("π")) return { title: trimmed, status: "idle" };
  // `π: <title>` (no space before `:`) is omp's status-disabled title, not a working marker.
  if (trimmed.startsWith("π:")) return { status: "idle", title: trimmed.slice(2).trim() };
  const rest = trimmed.slice(1).trimStart();
  if (!rest) return { status: "idle", title: "" };
  const space = rest.indexOf(" ");
  const token = space === -1 ? rest : rest.slice(0, space);
  const after = space === -1 ? "" : rest.slice(space + 1).trim();
  if (token === ">") return { status: "idle", title: after };
  if (token === "!") return { status: "asking", title: after };
  if (isWorkingMarker(token)) return { status: "working", title: after };
  // Anything without an explicit working marker is idle; never guess working.
  return { status: "idle", title: rest };
}

export async function toSession(pane: Pane, options: ResolveOptions = {}): Promise<Session> {
  const sessionFile = await resolveSessionFile(pane, options);
  const { title, status } = parsePaneTitle(pane.title, pane.cwd);
  let updatedAt = new Date(0).toISOString();
  if (sessionFile) {
    try {
      updatedAt = (await stat(sessionFile)).mtime.toISOString();
    } catch {
      // File vanished between resolution and stat; keep the epoch placeholder.
    }
  }
  const { model, thinkingLevel } = await readModelState(sessionFile);
  return {
    id: pane.paneId,
    windowId: pane.windowId,
    windowIndex: pane.windowIndex,
    tmuxSession: pane.sessionName,
    title,
    status,
    unread: pane.bellFlag,
    focused: pane.windowActive && pane.sessionAttached,
    cwd: pane.cwd,
    sessionFile,
    updatedAt,
    model,
    thinkingLevel,
  };
}

/** Lists omp panes as sessions, creating a detached `omp` session if tmux has none at all. */
export async function listSessions(): Promise<Session[]> {
  let panes = await listOmpPanes();
  if (panes.length === 0 && (await listTmuxSessions()).length === 0) {
    await ensureSession();
    for (let attempt = 0; attempt < 6 && panes.length === 0; attempt += 1) {
      await sleep(250);
      panes = await listOmpPanes();
    }
  }
  const sessions = await Promise.all(panes.map((pane) => toSession(pane)));
  return sessions.sort((a, b) => a.windowIndex - b.windowIndex || a.tmuxSession.localeCompare(b.tmuxSession));
}

export async function findSessionPane(paneId: string): Promise<Pane | undefined> {
  return (await listOmpPanes()).find((pane) => pane.paneId === paneId);
}
