import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureSession, listOmpPanes, listTmuxSessions, type Pane } from "../tmux.ts";
import { resolveSessionFile, type ResolveOptions } from "./sessionFile.ts";
import { readModelState } from "./modelState.ts";

export type SessionStatus = "working" | "idle";

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
 * omp's pane title is `π > <title>` while idle and `π <spinner> <title>` while working.
 * The nerd-font glyph that omp puts in front of the title is kept as-is.
 */
export function parsePaneTitle(raw: string): { title: string; status: SessionStatus } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("π")) return { title: trimmed, status: "idle" };
  const rest = trimmed.slice(1).trimStart();
  if (rest.startsWith(">")) return { status: "idle", title: rest.slice(1).trim() };
  const marker = rest.codePointAt(0);
  if (marker !== undefined && marker >= 0x2800 && marker <= 0x28ff) {
    return { status: "working", title: rest.slice(String.fromCodePoint(marker).length).trim() };
  }
  return { status: "working", title: rest };
}

export async function toSession(pane: Pane, options: ResolveOptions = {}): Promise<Session> {
  const sessionFile = await resolveSessionFile(pane, options);
  const { title, status } = parsePaneTitle(pane.title);
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
