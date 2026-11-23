/**
 * Lightweight in-process signals so mutations anywhere in relay's server (board actions, the
 * watcher, workstreams, auto-titles, comment judging) push updates to connected Relay Board
 * windows and wake background workstreams right away, without circular imports.
 */

export interface BoardChange {
  /** Also re-fetch GitHub PR data, e.g. after closing a PR or requesting a merge. */
  github?: boolean;
  /** Wake the workstream grouper/briefer/summarizer right away instead of waiting for its timer. */
  wakeWorkstreams?: boolean;
}

type BoardListener = (change: BoardChange) => void;
type WakeListener = () => void;

const boardListeners = new Set<BoardListener>();
const workstreamListeners = new Set<WakeListener>();

export function onBoardChanged(listener: BoardListener): () => void {
  boardListeners.add(listener);
  return () => boardListeners.delete(listener);
}

export function onWorkstreamsWake(listener: WakeListener): () => void {
  workstreamListeners.add(listener);
  return () => workstreamListeners.delete(listener);
}

/** Tells connected Relay Board windows that board state changed (and optionally wakes workstreams). */
export function notifyBoardChanged(change: BoardChange = {}): void {
  for (const listener of boardListeners) listener(change);
  if (change.wakeWorkstreams) wakeWorkstreams();
}

/** Wakes the background workstream loop so new tasks, briefs, and summaries update right away. */
export function wakeWorkstreams(): void {
  for (const listener of workstreamListeners) listener();
}
