import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchTracker, readMessagePage } from "./messages.ts";

type Entry = Record<string, unknown>;

function message(id: string, parentId: string | null, role: "user" | "assistant", text: string): Entry {
  return { type: "message", id, parentId, timestamp: "2026-10-28T00:00:00.000Z", message: { role, content: [{ type: "text", text }] } };
}

function usage(id: string, parentId: string): Entry {
  return { type: "model_usage", id, parentId };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sessionFile(entries: Entry[]): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-messages-"));
  dirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return filePath;
}

async function pageIds(entries: Entry[], options: { before?: string; limit: number } = { limit: 50 }): Promise<string[]> {
  const page = await readMessagePage(sessionFile(entries), "%1", options);
  return page.messages.map((entry) => entry.id);
}

// u1 -> a1 -> u2 -> a2, then /tree back to a1 and the session continues from there.
const abandonedPrompt = [
  { type: "session", id: "s" },
  message("u1", null, "user", "first"),
  message("a1", "u1", "assistant", "reply"),
  message("u2", "a1", "user", "backed out of"),
  message("a2", "u2", "assistant", "interrupted"),
  { type: "custom", id: "c1", parentId: "a1", customType: "session_exit" },
];

describe("readMessagePage", () => {
  test("hides messages on a branch the user left with /tree", async () => {
    expect(await pageIds(abandonedPrompt)).toEqual(["u1", "a1"]);
  });

  test("a usage record filed under the old branch does not bring it back", async () => {
    expect(await pageIds([...abandonedPrompt, usage("m1", "a2")])).toEqual(["u1", "a1"]);
  });

  test("follows the branch through usage records on it", async () => {
    const entries = [
      { type: "session", id: "s" },
      message("u1", null, "user", "q"),
      usage("m1", "u1"),
      message("a1", "m1", "assistant", "a"),
    ];
    expect(await pageIds(entries)).toEqual(["u1", "a1"]);
  });

  test("pages older messages along the active branch only", async () => {
    const entries = [...abandonedPrompt, message("u3", "c1", "user", "new prompt")];
    expect(await pageIds(entries, { before: "u3", limit: 50 })).toEqual(["u1", "a1"]);
  });
});

describe("BranchTracker", () => {
  test("reports a switch when an entry hangs off an earlier point in the tree", async () => {
    const tracker = await BranchTracker.atEndOf(sessionFile(abandonedPrompt.slice(0, 5)));
    expect(tracker.advance(abandonedPrompt[5])).toBe(false);
    expect(tracker.advance(message("u3", "c1", "user", "new prompt"))).toBe(true);
  });

  test("accepts the next message after a usage record at the end of the file", async () => {
    const entries = [{ type: "session", id: "s" }, message("u1", null, "user", "q"), usage("m1", "u1")];
    const tracker = await BranchTracker.atEndOf(sessionFile(entries));
    expect(tracker.advance(message("a1", "m1", "assistant", "a"))).toBe(true);
  });

  test("ignores usage records filed on another branch", async () => {
    const tracker = await BranchTracker.atEndOf(sessionFile(abandonedPrompt));
    expect(tracker.advance(usage("m1", "a2"))).toBe(true);
    expect(tracker.advance(message("u3", "c1", "user", "next"))).toBe(true);
  });
});
