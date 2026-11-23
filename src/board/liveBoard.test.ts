import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pane } from "../tmux.ts";
import type { BoardData } from "./github.ts";
import { createBoardHub, githubNeedsFastRefresh } from "./liveBoard.ts";
import type { BoardView } from "./view.ts";

class FakeSseResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  events(): BoardView[] {
    return this.chunks
      .join("")
      .split("\n\n")
      .flatMap((frame) => {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        return data ? [JSON.parse(data.slice(6)) as BoardView] : [];
      });
  }
}

const emptyGitHub: BoardData = { mine: [], reviewRequested: [], merged: [] };

function pane(title: string): Pane {
  return {
    paneId: "%1",
    windowId: "@1",
    windowIndex: 1,
    sessionName: "omp",
    title,
    cwd: "/tmp/proj",
    paneTty: "/dev/ttys001",
    panePid: "123",
    command: "omp",
    bellFlag: false,
    windowActive: true,
    sessionAttached: true,
  };
}

function minimalView(opts: { updatedAt: Date | null; working: boolean; note?: string; ciTone?: "ok" | "wait" | "bad"; running?: string | null }): BoardView {
  return {
    lanes: opts.ciTone || opts.running
      ? [
          {
            id: "ready",
            title: "Ready",
            hint: "",
            hot: true,
            cards: [
              {
                ref: "acme/api#1",
                repo: "acme/api",
                repoName: "api",
                number: 1,
                url: "https://github.com/acme/api/pull/1",
                title: "Fix",
                ticket: null,
                updatedAt: "2026-11-23T00:00:00Z",
                idleDays: 0,
                stale: false,
                mergedAt: null,
                age: { text: "1m", tone: "muted", hint: null },
                rows: opts.ciTone ? [{ kind: "ci", label: "CI", value: "Running", tone: opts.ciTone, hint: null, running: false, action: null, detail: null, link: null, items: [] }] : [],
                notices: [],
                session: null,
                steps: [],
                menu: [],
                running: opts.running ?? null,
                close: null,
                task: null,
              },
            ],
          },
        ]
      : [],
    updatedAt: opts.updatedAt?.toISOString() ?? null,
    error: opts.note ?? null,
    agentWorking: opts.working,
    refreshSeconds: opts.working ? 10 : 60,
    tasks: null,
  };
}

describe("liveBoard", () => {
  test("localOnly returns immediately without waiting on GitHub, and coalesces concurrent GitHub fetches", async () => {
    let githubCalls = 0;
    const gate = Promise.withResolvers<BoardData>();
    const hub = createBoardHub({
      fetchGitHub: () => {
        githubCalls += 1;
        return gate.promise;
      },
      listLive: async () => new Map([["/tmp/s1.jsonl", pane("π > My task")]]),
      assembleView: async (github, _error, live) => minimalView({ updatedAt: github?.at ?? null, working: [...live.values()].some((p) => p.title.includes("⠋")) }),
      dbStamp: async () => "1:100",
    });

    const local = await hub.fetchBoardView({ localOnly: true });
    expect(local.updatedAt).toBeNull();
    expect(githubCalls).toBe(1);

    // Two concurrent full refreshes share the already in-flight GitHub fetch.
    const a = hub.fetchBoardView();
    const b = hub.fetchBoardView();
    expect(githubCalls).toBe(1);

    gate.resolve(emptyGitHub);
    const [viewA, viewB] = await Promise.all([a, b]);
    expect(viewA.updatedAt).not.toBeNull();
    expect(viewB.updatedAt).toBe(viewA.updatedAt);
    hub.stop();
  });

  test("SSE pushes initial state immediately, reacts to tmux working changes and external DB writes, and stops when clients leave", async () => {
    let currentTitle = "π > Waiting";
    let currentDb = "100:500";
    let externalDbWakes = 0;
    let pollCalls = 0;
    const githubGate = Promise.withResolvers<BoardData>();

    const hub = createBoardHub({
      fetchGitHub: () => githubGate.promise,
      listLive: async () => {
        pollCalls += 1;
        return new Map([["/tmp/s1.jsonl", pane(currentTitle)]]);
      },
      assembleView: async (github, _error, live) =>
        minimalView({
          updatedAt: github?.at ?? null,
          working: [...live.values()].some((p) => p.title.includes("⠋")),
          note: currentDb,
        }),
      dbStamp: async () => currentDb,
      onExternalDbChange: () => {
        externalDbWakes += 1;
      },
      localPollMs: 25,
      broadcastDebounceMs: 10,
      pingIntervalMs: 60_000,
    });

    const res = new FakeSseResponse();
    hub.startBoardEvents(res as unknown as ServerResponse);
    await sleep(30);

    // Initial local board arrives before GitHub resolves.
    expect(res.events().length).toBe(1);
    expect(res.events()[0]).toMatchObject({ updatedAt: null, agentWorking: false, error: "100:500" });

    // User types in terminal: pane flips to spinner → pushed automatically.
    currentTitle = "π ⠋ Waiting";
    await sleep(60);
    expect(res.events().at(-1)?.agentWorking).toBe(true);

    // External CLI writes to board.db → detected, pushed, and wakes workstreams.
    currentDb = "200:600";
    await sleep(60);
    expect(res.events().at(-1)?.error).toBe("200:600");
    expect(externalDbWakes).toBe(1);

    // Background GitHub resolves → pushes updatedAt to connected client.
    githubGate.resolve(emptyGitHub);
    await sleep(40);
    expect(res.events().at(-1)?.updatedAt).not.toBeNull();

    // Closing the last client stops the poll loop cleanly.
    res.end();
    expect(hub.clientCount()).toBe(0);
    const pollsAfterClose = pollCalls;
    await sleep(80);
    expect(pollCalls).toBe(pollsAfterClose);
  });

  test("githubNeedsFastRefresh is true when CI is running or a PR action is running", () => {
    expect(githubNeedsFastRefresh(null)).toBe(false);
    expect(githubNeedsFastRefresh(minimalView({ updatedAt: null, working: false, ciTone: "ok" }))).toBe(false);
    expect(githubNeedsFastRefresh(minimalView({ updatedAt: null, working: false, ciTone: "wait" }))).toBe(true);
    expect(githubNeedsFastRefresh(minimalView({ updatedAt: null, working: false, running: "Agent merging…" }))).toBe(true);
  });
});
