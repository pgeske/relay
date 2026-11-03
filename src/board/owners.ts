import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SESSIONS_DIR } from "../server/sessionFile.ts";

/** The omp session in charge of a PR. */
export interface PrOwner {
  repo: string;
  number: number;
  /** The session's top-level `.jsonl`; subagents' PRs belong to the session that ran them. */
  sessionFile: string;
  /** `opened`: the session ran `gh pr create`. `claimed`: it took the PR over with `relay board claim`. */
  how: "opened" | "claimed";
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
/** `gh pr create`, also with the repo flag before the subcommand (`gh -R acme/api pr create`). */
const CREATE_COMMAND = /\bgh\s+(?:(?:-R|--repo)[=\s]\S+\s+)?pr\s+create\b/;
/** Only lines mentioning one of these can hold a PR-opening call or its result; the rest skip JSON parsing. */
const INTERESTING = /"toolCall"|"toolResult"/;

interface ToolCall {
  type?: string;
  id?: string;
  arguments?: unknown;
}

interface Entry {
  message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
}

/**
 * Finds the PRs a session opened in the part of its log after `offset`. A PR is opened by a
 * tool call running `gh pr create`; its result carries the new PR's URL. The call and its result
 * can land in different scans, so call ids still waiting for a result carry over in `pending`.
 */
export function findOpenedPrs(text: string, pending: Set<string>): { repo: string; number: number }[] {
  const opened: { repo: string; number: number }[] = [];
  for (const line of text.split("\n")) {
    if (!INTERESTING.test(line)) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as ToolCall[]) {
        if (part.type === "toolCall" && part.id && CREATE_COMMAND.test(JSON.stringify(part.arguments ?? ""))) pending.add(part.id);
      }
    } else if (message?.role === "toolResult" && message.toolCallId && pending.has(message.toolCallId)) {
      pending.delete(message.toolCallId);
      if (message.isError) continue;
      for (const match of JSON.stringify(message.content ?? "").matchAll(PR_URL)) {
        opened.push({ repo: match[1], number: Number(match[2]) });
      }
    }
  }
  return opened;
}

/** "proj/2026…_id.jsonl" stays; "proj/2026…_id/sub/0-task.jsonl" (a subagent) maps to its session. */
export function owningSessionFile(file: string, sessionsDir = SESSIONS_DIR): string {
  const parts = relative(sessionsDir, file).split(sep);
  if (parts.length <= 2) return file;
  return join(sessionsDir, parts[0], `${parts[1]}.jsonl`);
}

function sessionLogs(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sessionLogs(path);
    return entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

/** Reads `file` from `offset` up to its last complete line. */
function readNewLines(file: string, offset: number, size: number): { text: string; end: number } {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    const lastNewline = buffer.lastIndexOf(0x0a, read - 1);
    if (lastNewline === -1) return { text: "", end: offset };
    return { text: buffer.toString("utf8", 0, lastNewline + 1), end: offset + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Links every PR that an omp session opened to that session, reading only what each log gained
 * since the last scan; the first scan reads every log, which links PRs opened before the board
 * existed. A PR keeps its first owner: later sessions that mention or reopen it don't take it.
 */
export function scanSessions(db: Database, sessionsDir = SESSIONS_DIR): void {
  const scans = new Map(
    db
      .query<{ file: string; offset: number; pending_calls: string }, []>("SELECT * FROM session_scans")
      .all()
      .map((row) => [row.file, row]),
  );
  const saveScan = db.query("INSERT OR REPLACE INTO session_scans (file, offset, pending_calls) VALUES ($file, $offset, $pending)");
  const link = db.query(
    `INSERT OR IGNORE INTO pr_owners (repo, number, session_file, how, linked_at)
     VALUES ($repo, $number, $sessionFile, 'opened', $linkedAt)`,
  );

  db.transaction(() => {
    for (const file of sessionLogs(sessionsDir)) {
      const previous = scans.get(file);
      const size = statSync(file).size;
      // A smaller file was rewritten from scratch; read it again.
      const offset = previous && previous.offset <= size ? previous.offset : 0;
      if (offset === size) continue;
      const pending = new Set<string>(offset === 0 ? [] : (JSON.parse(previous?.pending_calls ?? "[]") as string[]));
      const { text, end } = readNewLines(file, offset, size);
      for (const pr of findOpenedPrs(text, pending)) {
        link.run({ $repo: pr.repo, $number: pr.number, $sessionFile: owningSessionFile(file, sessionsDir), $linkedAt: new Date().toISOString() });
      }
      saveScan.run({ $file: file, $offset: end, $pending: JSON.stringify([...pending]) });
    }
  })();
}

/** Hands a PR to a session, replacing whoever was in charge of it. */
export function claimPr(db: Database, repo: string, number: number, sessionFile: string): void {
  db.query(
    `INSERT OR REPLACE INTO pr_owners (repo, number, session_file, how, linked_at)
     VALUES ($repo, $number, $sessionFile, 'claimed', $linkedAt)`,
  ).run({ $repo: repo, $number: number, $sessionFile: sessionFile, $linkedAt: new Date().toISOString() });
}

type OwnerRow = { repo: string; number: number; session_file: string; how: PrOwner["how"] };

function toOwner(row: OwnerRow): PrOwner {
  return { repo: row.repo, number: row.number, sessionFile: row.session_file, how: row.how };
}

/** Every PR's owner, keyed by "owner/repo#number". */
export function prOwners(db: Database): Map<string, PrOwner> {
  const rows = db.query<OwnerRow, []>("SELECT * FROM pr_owners").all();
  return new Map(rows.map((row) => [`${row.repo}#${row.number}`, toOwner(row)]));
}

export function prOwner(db: Database, repo: string, number: number): PrOwner | null {
  const row = db.query<OwnerRow, [string, number]>("SELECT * FROM pr_owners WHERE repo = ? AND number = ?").get(repo, number);
  return row ? toOwner(row) : null;
}

/** The session's title and directory, from the two header lines omp writes first. */
export function readSessionHeader(sessionFile: string): { title: string; cwd: string | null } {
  let head: string;
  try {
    const fd = openSync(sessionFile, "r");
    try {
      const buffer = Buffer.alloc(8192);
      head = buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return { title: "", cwd: null };
  }
  let title = "";
  let cwd: string | null = null;
  for (const line of head.split("\n").slice(0, 2)) {
    try {
      const entry = JSON.parse(line) as { type?: string; title?: string; cwd?: string };
      if (entry.type === "title" && entry.title) title = entry.title;
      if (entry.type === "session") {
        title ||= entry.title ?? "";
        cwd = entry.cwd ?? null;
      }
    } catch {
      // The second line can be cut off by the 8 KB read; the title line comes first anyway.
    }
  }
  return { title, cwd };
}
