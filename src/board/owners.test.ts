import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPr, findOpenedPrs, prOwner, scanSessions } from "./owners.ts";
import { openBoardStore } from "./store.ts";

function call(id: string, command: string): string {
  return `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } })}\n`;
}

function result(id: string, text: string, isError = false): string {
  return `${JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }] } })}\n`;
}

describe("findOpenedPrs", () => {
  test("a gh pr create call's result names the PRs it opened, all of them", () => {
    const log = call("a", "gh pr create --repo acme/api --fill && gh pr create --repo acme/web --fill") +
      result("a", "https://github.com/acme/api/pull/12\nhttps://github.com/acme/web/pull/7");
    expect(findOpenedPrs(log, new Set())).toEqual([
      { repo: "acme/api", number: 12 },
      { repo: "acme/web", number: 7 },
    ]);
  });

  test("PRs a session only looked at or mentioned are not its own", () => {
    const log = call("a", "gh pr view 12 --repo acme/api") + result("a", "https://github.com/acme/api/pull/12");
    expect(findOpenedPrs(log, new Set())).toEqual([]);
  });

  test("a failed create opens nothing", () => {
    const log = call("a", "gh pr create --fill") + result("a", "a pull request already exists: https://github.com/acme/api/pull/12", true);
    expect(findOpenedPrs(log, new Set())).toEqual([]);
  });
});

describe("scanSessions", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "relay-sessions-"));
    mkdirSync(join(dir, "proj", "s1", "sub"), { recursive: true });
    return { dir, db: openBoardStore(":memory:"), s1: join(dir, "proj", "s1.jsonl"), s2: join(dir, "proj", "s2.jsonl") };
  }

  test("a call and its result split across two scans still link the PR", () => {
    const { dir, db, s1 } = setup();
    writeFileSync(s1, call("a", "gh pr create --fill"));
    scanSessions(db, dir);
    expect(prOwner(db, "acme/api", 12)).toBeNull();
    appendFileSync(s1, result("a", "https://github.com/acme/api/pull/12"));
    scanSessions(db, dir);
    expect(prOwner(db, "acme/api", 12)?.sessionFile).toBe(s1);
  });

  test("a PR a subagent opened belongs to the session that ran the subagent", () => {
    const { dir, db, s1 } = setup();
    writeFileSync(s1, "");
    writeFileSync(join(dir, "proj", "s1", "sub", "0-task.jsonl"), call("a", "gh pr create --fill") + result("a", "https://github.com/acme/api/pull/12"));
    scanSessions(db, dir);
    expect(prOwner(db, "acme/api", 12)?.sessionFile).toBe(s1);
  });

  test("the session that opened a PR keeps it until another claims it", () => {
    const { dir, db, s1, s2 } = setup();
    writeFileSync(s1, call("a", "gh pr create --fill") + result("a", "https://github.com/acme/api/pull/12"));
    scanSessions(db, dir);
    // A later session re-running create for the same PR (gh prints the existing URL) doesn't take it over.
    writeFileSync(s2, call("b", "gh pr create --fill") + result("b", "https://github.com/acme/api/pull/12"));
    scanSessions(db, dir);
    expect(prOwner(db, "acme/api", 12)).toMatchObject({ sessionFile: s1, how: "opened" });

    claimPr(db, "acme/api", 12, s2);
    scanSessions(db, dir);
    expect(prOwner(db, "acme/api", 12)).toMatchObject({ sessionFile: s2, how: "claimed" });
  });
});
