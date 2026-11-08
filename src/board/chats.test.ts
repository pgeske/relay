import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS_DIR } from "../server/sessionFile.ts";
import type { Pane } from "../tmux.ts";
import { chatsView, isSessionFile } from "./chats.ts";

const now = new Date("2026-11-07T12:00:00Z").getTime();
const dir = mkdtempSync(join(tmpdir(), "relay-chats-"));

/** A saved conversation: omp's title and session header lines, last written `minutesAgo`. */
function savedSession(name: string, title: string, minutesAgo: number): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "title", title })}\n${JSON.stringify({ type: "session", cwd: join(homedir(), "src", "api") })}\n`);
  const at = new Date(now - minutesAgo * 60_000);
  utimesSync(file, at, at);
  return file;
}

function pane(title: string, paneId = "%3"): Pane {
  return {
    sessionName: "relay",
    windowId: "@3",
    windowIndex: 3,
    windowActive: false,
    sessionAttached: true,
    paneId,
    panePid: "123",
    paneTty: "/dev/ttys003",
    command: "omp",
    cwd: "/tmp",
    bellFlag: false,
    title,
  };
}

describe("chatsView", () => {
  test("lists open, task, and recent sessions once each, newest first", () => {
    const old = savedSession("old", "Old investigation", 600);
    const open = savedSession("open", "Cache rollout", 5);
    const onTask = savedSession("task", "Fix the login bug", 60);
    const live = new Map([[open, pane("π ⠋ Cache rollout")]]);
    const tasks = new Map([[onTask, { id: 7, ref: "T-7", title: "Login bug", hue: 5 }]]);

    const chats = chatsView(live, tasks, [old, open, onTask], now);

    expect(chats.map((chat) => [chat.title, chat.state])).toEqual([
      ["Cache rollout", "working"],
      ["Fix the login bug", "closed"],
      ["Old investigation", "closed"],
    ]);
    expect(chats[0].paneId).toBe("%3");
    expect(chats[1].task?.ref).toBe("T-7");
    expect(chats[2].folder).toBe("~/src/api");
  });

  test("keeps a brand-new open session that hasn't saved its file yet, as active now", () => {
    const unsaved = join(dir, "unsaved.jsonl");
    const older = savedSession("older", "Earlier chat", 30);

    const chats = chatsView(new Map([[unsaved, pane("π > tmp")]]), new Map(), [older], now);

    expect(chats.map((chat) => chat.sessionFile)).toEqual([unsaved, older]);
    expect(chats[0]).toMatchObject({ state: "idle", title: "Untitled session", updatedAt: new Date(now).toISOString() });
  });

  test("drops a closed task session whose file is gone", () => {
    const gone = join(dir, "gone.jsonl");
    const chats = chatsView(new Map(), new Map([[gone, { id: 2, ref: "T-2", title: "Gone", hue: 6 }]]), [], now);
    expect(chats).toEqual([]);
  });
});

describe("isSessionFile", () => {
  test("takes a conversation omp saved in a project folder", () => {
    expect(isSessionFile(join(SESSIONS_DIR, "--tmp--", "2026-11-07_abc.jsonl"))).toBe(true);
  });

  test("refuses subagent logs, other files, and paths that climb out", () => {
    expect(isSessionFile(join(SESSIONS_DIR, "--tmp--", "2026-11-07_abc", "reviewer.jsonl"))).toBe(false);
    expect(isSessionFile(join(SESSIONS_DIR, "--tmp--", "notes.txt"))).toBe(false);
    expect(isSessionFile(`${SESSIONS_DIR}/--tmp--/../../../config.jsonl`)).toBe(false);
    expect(isSessionFile("/etc/passwd.jsonl")).toBe(false);
  });
});
