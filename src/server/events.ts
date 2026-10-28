import { open } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { BranchTracker, normalizeEntry, parseJsonEntry } from "./messages.ts";
import { fileSize, resolveSessionFile } from "./sessionFile.ts";
import { toSession, type Session } from "./sessions.ts";
import { listOmpPanes, type Pane } from "../tmux.ts";

const TAIL_INTERVAL_MS = 500;
const STATUS_EVERY_TICKS = 2; // ~1s, matching the status poll cadence
const PING_INTERVAL_MS = 15_000;

type Tail = { filePath: string | null; offset: number; partial: Buffer; branch: BranchTracker };

function statusKey(session: Session): string {
  return [
    session.status,
    session.title,
    session.unread,
    session.focused,
    session.cwd,
    session.sessionFile,
    session.model,
    session.thinkingLevel,
  ].join("\u001f");
}

/** Streams new jsonl messages and session status changes until the client disconnects. */
export function startSessionEvents(res: ServerResponse, pane: Pane): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tail: Tail = { filePath: null, offset: 0, partial: Buffer.alloc(0), branch: new BranchTracker() };
  let finished = false;
  let ready = false;
  let running = false;
  let tickCount = 0;
  let lastStatusKey = "";

  /** Starts streaming from the current end of `filePath`. */
  async function restartTail(filePath: string | null): Promise<void> {
    tail.filePath = filePath;
    tail.branch = filePath ? await BranchTracker.atEndOf(filePath).catch(() => new BranchTracker()) : new BranchTracker();
    tail.offset = filePath ? await fileSize(filePath) : 0;
    tail.partial = Buffer.alloc(0);
  }

  async function pump(filePath: string): Promise<void> {
    const size = await fileSize(filePath);
    if (size < tail.offset) {
      // Truncated or replaced: tell the app to reload instead of replaying stale bytes.
      await restartTail(filePath);
      send("reset", { sessionFile: filePath });
      return;
    }
    if (size === tail.offset) return;

    const file = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(size - tail.offset);
    try {
      await file.read(buffer, 0, buffer.length, tail.offset);
    } finally {
      await file.close();
    }
    tail.offset = size;

    const combined = Buffer.concat([tail.partial, buffer]);
    const lastNewline = combined.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // Nothing but a partial trailing line so far; hold it until the newline arrives.
      tail.partial = combined;
      return;
    }
    tail.partial = Buffer.from(combined.subarray(lastNewline + 1));

    // After a branch switch the app reloads the whole page, which covers the rest of this batch.
    let switchedBranch = false;
    for (const line of combined.subarray(0, lastNewline).toString("utf8").split("\n")) {
      const entry = parseJsonEntry(line);
      if (!entry) continue;
      if (!tail.branch.advance(entry) && !switchedBranch) {
        switchedBranch = true;
        send("reset", { sessionFile: filePath });
      }
      if (switchedBranch || entry.type !== "message") continue;
      const message = normalizeEntry(entry, pane.paneId);
      if (message) send("message", message);
    }
  }

  async function tick(): Promise<void> {
    if (finished || !ready || running) return;
    running = true;
    try {
      const current = (await listOmpPanes()).find((candidate) => candidate.paneId === pane.paneId);
      if (!current) {
        send("closed", {});
        finish();
        return;
      }

      const filePath = await resolveSessionFile(current);
      if (filePath !== tail.filePath) {
        await restartTail(filePath);
        send("reset", { sessionFile: filePath });
      } else if (filePath) {
        await pump(filePath);
      }

      tickCount += 1;
      if (tickCount % STATUS_EVERY_TICKS === 0) {
        const session = await toSession(current);
        const key = statusKey(session);
        if (key !== lastStatusKey) {
          lastStatusKey = key;
          send("status", session);
        }
      }
    } catch (error) {
      console.error("events: poll failed", error);
    } finally {
      running = false;
    }
  }

  const tickTimer = setInterval(() => {
    void tick();
  }, TAIL_INTERVAL_MS);
  const pingTimer = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, PING_INTERVAL_MS);

  function finish(): void {
    if (finished) return;
    finished = true;
    clearInterval(tickTimer);
    clearInterval(pingTimer);
    res.end();
  }

  res.on("close", () => {
    finished = true;
    clearInterval(tickTimer);
    clearInterval(pingTimer);
  });

  void (async () => {
    const session = await toSession(pane);
    if (finished) return;
    lastStatusKey = statusKey(session);
    send("status", session);
    await restartTail(session.sessionFile);
    ready = true;
  })();
}
