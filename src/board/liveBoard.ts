import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { parsePaneTitle } from "../server/sessions.ts";
import type { Pane } from "../tmux.ts";
import { onBoardChanged, wakeWorkstreams, type BoardChange } from "./boardEvents.ts";
import { assembleBoard, liveSessions } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import { judgeComments } from "./feedback.ts";
import { fetchBoardData, type BoardData } from "./github.ts";
import { REQUEST_MAX_AGE_MS } from "./lanes.ts";
import { BOARD_DB_PATH, agentRequests, openBoardStore } from "./store.ts";
import { assembleTasks } from "./taskCommand.ts";
import { boardView, type BoardView } from "./view.ts";

/**
 * Keeps Relay Board windows live without waiting on GitHub.
 *
 * Local state (which relay tabs are working or idle, and everything in board.db) takes a few tens
 * of milliseconds to read, while GitHub GraphQL searches take seconds. Separating them lets the
 * server push session and task changes to connected windows within ~1s over SSE (`GET /api/board/events`),
 * while refreshing GitHub on its own background cadence (faster while CI or a PR action runs) and
 * coalescing concurrent GitHub fetches.
 */

const LOCAL_POLL_MS = 1000;
const BROADCAST_DEBOUNCE_MS = 40;
const PING_INTERVAL_MS = 15_000;
export const GITHUB_IDLE_MS = 60_000;
export const GITHUB_ACTIVE_MS = 15_000;

export interface BoardHubDeps {
  fetchGitHub: () => Promise<BoardData>;
  listLive: () => Promise<Map<string, Pane>>;
  assembleView: (github: { data: BoardData; at: Date } | null, error: string | undefined, live: Map<string, Pane>, now: Date) => Promise<BoardView>;
  dbStamp: () => Promise<string>;
  onExternalDbChange?: () => void;
  now?: () => number;
  localPollMs?: number;
  githubIdleMs?: number;
  githubActiveMs?: number;
  pingIntervalMs?: number;
  broadcastDebounceMs?: number;
}

/** PRs the board recently asked to merge, re-read directly so search lag doesn't keep them open. */
function recentMergeRequests(): Set<string> {
  const db = openBoardStore();
  try {
    const since = Date.now() - REQUEST_MAX_AGE_MS;
    return new Set([...agentRequests(db)].filter(([, requests]) => requests.merge && new Date(requests.merge).getTime() > since).map(([key]) => key));
  } finally {
    db.close();
  }
}

/** Nanosecond stamp of board.db (and its WAL, if any) to spot writes from external CLI processes. */
async function boardDbStamp(dbPath = BOARD_DB_PATH): Promise<string> {
  const parts = await Promise.all(
    [dbPath, `${dbPath}-wal`].map(async (file) => {
      try {
        const info = await stat(file, { bigint: true });
        return `${info.mtimeNs}:${info.size}`;
      } catch {
        return "-";
      }
    }),
  );
  return parts.join("|");
}

/** Fingerprint of live tmux panes so the 1s poll only rebuilds the board when something moved. */
export function liveSignature(live: Map<string, Pane>): string {
  return [...live.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([file, pane]) => {
      const state = parsePaneTitle(pane.title, pane.cwd);
      return `${file}\u001f${pane.paneId}\u001f${pane.windowId}\u001f${state.status}\u001f${state.title}\u001f${pane.cwd}`;
    })
    .join("\n");
}

/** Whether GitHub state is actively moving (a PR step or CI running), so we poll GitHub faster. */
export function githubNeedsFastRefresh(view: BoardView | null): boolean {
  if (!view) return false;
  return view.lanes.some((lane) =>
    lane.cards.some(
      (card) =>
        card.running !== null ||
        card.rows.some((row) => row.running || (row.kind === "ci" && row.tone === "wait")),
    ),
  );
}

export interface BoardHub {
  fetchBoardView: (options?: { localOnly?: boolean }) => Promise<BoardView>;
  startBoardEvents: (res: ServerResponse) => void;
  notify: (change?: BoardChange) => void;
  refreshGitHub: () => Promise<void>;
  clientCount: () => number;
  stop: () => void;
}

export function createBoardHub(deps: BoardHubDeps): BoardHub {
  const nowMs = deps.now ?? (() => Date.now());
  const localPollMs = deps.localPollMs ?? LOCAL_POLL_MS;
  const githubIdleMs = deps.githubIdleMs ?? GITHUB_IDLE_MS;
  const githubActiveMs = deps.githubActiveMs ?? GITHUB_ACTIVE_MS;
  const pingIntervalMs = deps.pingIntervalMs ?? PING_INTERVAL_MS;
  const broadcastDebounceMs = deps.broadcastDebounceMs ?? BROADCAST_DEBOUNCE_MS;

  let lastGood: { data: BoardData; at: Date } | null = null;
  let lastError: string | undefined;
  let lastGitHubAttemptAt = 0;
  let githubInFlight: Promise<void> | null = null;

  let lastView: BoardView | null = null;
  let lastPayload: string | null = null;
  let lastLocalKey: string | null = null;
  let lastDbStamp: string | null = null;

  const clients = new Set<ServerResponse>();
  let localTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let broadcastTimer: NodeJS.Timeout | null = null;
  let polling = false;
  let broadcasting = false;
  let broadcastQueued = false;

  function writeEvent(res: ServerResponse, payload: string): void {
    if (res.writableEnded) return;
    res.write(`event: board\ndata: ${payload}\n\n`);
  }

  function githubIsStale(): boolean {
    const cadence = githubNeedsFastRefresh(lastView) ? githubActiveMs : githubIdleMs;
    return !lastGood || nowMs() - lastGitHubAttemptAt >= cadence;
  }

  async function buildCurrentView(live?: Map<string, Pane>): Promise<{ view: BoardView; payload: string; live: Map<string, Pane>; db: string }> {
    const [resolvedLive, db] = await Promise.all([live ? Promise.resolve(live) : deps.listLive(), deps.dbStamp()]);
    const now = new Date(nowMs());
    const view = await deps.assembleView(lastGood, lastError, resolvedLive, now);
    const payload = JSON.stringify(view);
    lastView = view;
    lastDbStamp = db;
    lastLocalKey = `${liveSignature(resolvedLive)}\u001e${db}\u001e${Math.floor(now.getTime() / 60_000)}`;
    return { view, payload, live: resolvedLive, db };
  }

  async function broadcastNow(live?: Map<string, Pane>): Promise<void> {
    if (clients.size === 0) return;
    if (broadcasting) {
      broadcastQueued = true;
      return;
    }
    broadcasting = true;
    try {
      const { payload } = await buildCurrentView(live);
      if (payload !== lastPayload) {
        lastPayload = payload;
        for (const client of clients) writeEvent(client, payload);
      }
    } catch (error) {
      console.error("board events: failed to build board", error);
    } finally {
      broadcasting = false;
      if (broadcastQueued && clients.size > 0) {
        broadcastQueued = false;
        void broadcastNow();
      }
    }
  }

  function scheduleBroadcast(): void {
    if (clients.size === 0 || broadcastTimer !== null) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      void broadcastNow();
    }, broadcastDebounceMs);
    broadcastTimer.unref();
  }

  async function refreshGitHub(): Promise<void> {
    if (githubInFlight) return githubInFlight;
    lastGitHubAttemptAt = nowMs();
    githubInFlight = (async () => {
      try {
        const data = await deps.fetchGitHub();
        lastGood = { data, at: new Date(nowMs()) };
        lastError = undefined;
      } catch (failure) {
        lastError = failure instanceof Error ? failure.message : String(failure);
      } finally {
        githubInFlight = null;
      }
      if (clients.size > 0) void broadcastNow();
    })();
    return githubInFlight;
  }

  async function pollLocal(): Promise<void> {
    if (polling || clients.size === 0) return;
    polling = true;
    try {
      const [live, db] = await Promise.all([deps.listLive(), deps.dbStamp()]);
      const dbChanged = lastDbStamp !== null && db !== lastDbStamp;
      const key = `${liveSignature(live)}\u001e${db}\u001e${Math.floor(nowMs() / 60_000)}`;
      if (dbChanged) deps.onExternalDbChange?.();
      if (key !== lastLocalKey) await broadcastNow(live);
      if (githubIsStale()) void refreshGitHub();
    } catch (error) {
      console.error("board events: local poll failed", error);
    } finally {
      polling = false;
    }
  }

  function ensureLoops(): void {
    if (localTimer === null) {
      localTimer = setInterval(() => void pollLocal(), localPollMs);
      localTimer.unref();
    }
    if (pingTimer === null) {
      pingTimer = setInterval(() => {
        for (const client of clients) {
          if (!client.writableEnded) client.write(": ping\n\n");
        }
      }, pingIntervalMs);
      pingTimer.unref();
    }
  }

  function stopLoopsIfEmpty(): void {
    if (clients.size > 0) return;
    if (localTimer !== null) {
      clearInterval(localTimer);
      localTimer = null;
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (broadcastTimer !== null) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
  }

  async function fetchBoardView(options: { localOnly?: boolean } = {}): Promise<BoardView> {
    if (options.localOnly) {
      if (githubIsStale()) void refreshGitHub();
      const { view, payload } = await buildCurrentView();
      if (clients.size > 0 && payload !== lastPayload) {
        lastPayload = payload;
        for (const client of clients) writeEvent(client, payload);
      }
      return view;
    }
    await refreshGitHub();
    const { view, payload } = await buildCurrentView();
    if (clients.size > 0 && payload !== lastPayload) {
      lastPayload = payload;
      for (const client of clients) writeEvent(client, payload);
    }
    return view;
  }

  function startBoardEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    clients.add(res);
    ensureLoops();

    res.on("close", () => {
      clients.delete(res);
      stopLoopsIfEmpty();
    });

    // Send local state right away so the window renders immediately, then catch up GitHub if stale.
    void (async () => {
      try {
        const { payload } = await buildCurrentView();
        if (!clients.has(res)) return;
        if (payload !== lastPayload) {
          lastPayload = payload;
          for (const client of clients) writeEvent(client, payload);
        } else {
          writeEvent(res, payload);
        }
        if (githubIsStale()) void refreshGitHub();
      } catch (error) {
        console.error("board events: initial push failed", error);
      }
    })();
  }

  function notify(change: BoardChange = {}): void {
    if (change.github && clients.size > 0) void refreshGitHub();
    scheduleBroadcast();
  }

  function stop(): void {
    for (const client of clients) {
      if (!client.writableEnded) client.end();
    }
    clients.clear();
    stopLoopsIfEmpty();
  }

  return {
    fetchBoardView,
    startBoardEvents,
    notify,
    refreshGitHub,
    clientCount: () => clients.size,
    stop,
  };
}

/** The server's shared board hub. */
export const boardHub = createBoardHub({
  fetchGitHub: async () => {
    const config = loadBoardConfig();
    const data = await fetchBoardData(config, { reviewRequests: false, recheck: recentMergeRequests() });
    // Comments that may ask for a change get read in the background; when judged, feedback.ts notifies the hub.
    judgeComments(data.mine.filter((pr) => pr.state === "OPEN" && !pr.isDraft));
    return data;
  },
  listLive: liveSessions,
  assembleView: async (github, error, live, now) => {
    const config = loadBoardConfig();
    const board = github ? await assembleBoard(github.data, config, live) : null;
    const tasks = assembleTasks(board, live, now);
    return boardView(board, { now, updatedAt: github?.at ?? null, error, tasks: tasks.view, taskChips: tasks.chips });
  },
  dbStamp: () => boardDbStamp(),
  onExternalDbChange: () => wakeWorkstreams(),
});

onBoardChanged((change) => boardHub.notify(change));

export const fetchBoardView = boardHub.fetchBoardView;
export const startBoardEvents = boardHub.startBoardEvents;
