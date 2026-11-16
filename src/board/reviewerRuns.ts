import { asRecord, parseJsonEntry, scanLinesBackwards } from "../server/messages.ts";
import type { ReviewerRun } from "./autoStatus.ts";

/**
 * Agents often run a reviewer agent on their PR on their own and forget to record it, so the board
 * keeps calling the PR unreviewed. This finds the reviewer agents a session ran, straight from its
 * log: omp delivers a subagent's result as a `<task-result … agent="reviewer" status="completed">`
 * block, in a follow-up message or in the result of a `wait` for it.
 */

/** A reviewer agent that finished, with when it ran. */
export interface FinishedReviewerRun extends ReviewerRun {
  /** omp's id for the run: the name the `task` call gave it. With `startedAt`, it names the run. */
  id: string;
  /** When the `task` call sent it off. */
  startedAt: string;
  /** When it finished: its start plus how long omp says it ran. The result can reach the session later. */
  finishedAt: string;
}

/** How far back into a session's log to look, in lines. */
const LINES_READ = 2000;

const TASK_RESULT = /<task-result id="([^"]+)" agent="(?:security-)?reviewer" status="completed" duration="([^"]+)">\s*<output>([\s\S]*?)<\/output>/g;

/** "1h2m3s", "8m22s", "45s", "850ms" → milliseconds; null when it's none of those. */
export function durationMs(duration: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(duration.trim());
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [, hours = "0", minutes = "0", seconds = "0", millis = "0"] = match;
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(millis);
}

/** The text an entry carries that a task result can be in: a follow-up message's, or a tool result's. */
function entryText(entry: Record<string, unknown>): string {
  if (entry.type === "custom_message") return typeof entry.content === "string" ? entry.content : "";
  const message = asRecord(entry.message);
  if (message?.role !== "toolResult" || !Array.isArray(message.content)) return "";
  return message.content
    .map((part) => asRecord(part))
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

/** A `task` call: what it asked each subagent, in order, and the name it gave it (null to let omp pick one). */
interface TaskCall {
  tasks: { name: string | null; assignment: string }[];
  at: string;
}

/** The `task` calls an assistant entry made, keyed by the tool call's id. */
function taskCalls(entry: Record<string, unknown>, at: string): [string, TaskCall][] {
  const message = asRecord(entry.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part): [string, TaskCall][] => {
    const call = asRecord(part);
    const args = asRecord(call?.arguments);
    if (call?.type !== "toolCall" || call.name !== "task" || typeof call.id !== "string" || !args || !Array.isArray(args.tasks)) return [];
    const context = typeof args.context === "string" ? args.context : "";
    const tasks = args.tasks.map((raw) => {
      const task = asRecord(raw);
      return { name: typeof task?.name === "string" ? task.name : null, assignment: `${context}\n\n${typeof task?.task === "string" ? task.task : ""}`.trim() };
    });
    return [[call.id, { tasks, at }]];
  });
}

/** The run ids omp gave a `task` call's subagents, by their place in the call, from the call's result. */
function spawnedIds(entry: Record<string, unknown>): { callId: string; ids: [number, string][] } | null {
  const message = asRecord(entry.message);
  const details = asRecord(message?.details);
  if (message?.role !== "toolResult" || message.toolName !== "task" || typeof message.toolCallId !== "string" || !Array.isArray(details?.progress)) return null;
  const ids = details.progress.flatMap((raw): [number, string][] => {
    const spawned = asRecord(raw);
    return typeof spawned?.index === "number" && typeof spawned.id === "string" ? [[spawned.index, spawned.id]] : [];
  });
  return { callId: message.toolCallId, ids };
}

/**
 * The reviewer agents that finished in these log entries (oldest first), each once. A run counts
 * only when the `task` call that started it is among them too: when it started decides which
 * commits the review saw, and the result's own arrival can't tell.
 */
export function parseReviewerRuns(entries: Record<string, unknown>[]): FinishedReviewerRun[] {
  const calls = new Map<string, TaskCall>();
  // Each run id's latest dispatch so far: names can repeat, and a result answers the call before it.
  const asked = new Map<string, { assignment: string; at: string }>();
  const runs = new Map<string, FinishedReviewerRun>();
  for (const entry of entries) {
    if (typeof entry.timestamp !== "string") continue;
    for (const [callId, call] of taskCalls(entry, entry.timestamp)) {
      calls.set(callId, call);
      for (const task of call.tasks) if (task.name) asked.set(task.name, { assignment: task.assignment, at: call.at });
    }
    // omp names the subagents a call left unnamed in its result.
    const spawned = spawnedIds(entry);
    const spawnedBy = spawned ? calls.get(spawned.callId) : undefined;
    if (spawned && spawnedBy) {
      for (const [index, id] of spawned.ids) {
        const task = spawnedBy.tasks[index];
        if (task) asked.set(id, { assignment: task.assignment, at: spawnedBy.at });
      }
    }
    for (const [, id, duration, output] of entryText(entry).matchAll(TASK_RESULT)) {
      const dispatch = asked.get(id);
      const ms = durationMs(duration);
      if (!dispatch || ms === null) continue;
      // A result can show twice, delivered and again in a later wait.
      const key = `${id}|${dispatch.at}`;
      const finishedAt = new Date(Date.parse(dispatch.at) + ms).toISOString();
      if (!runs.has(key)) runs.set(key, { id, startedAt: dispatch.at, finishedAt, assignment: dispatch.assignment, output: output.trim() });
    }
  }
  return [...runs.values()].toSorted((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** The reviewer agents that finished near the end of a session's log, oldest first. */
export async function finishedReviewerRuns(sessionFile: string): Promise<FinishedReviewerRun[]> {
  const entries: Record<string, unknown>[] = [];
  await scanLinesBackwards(sessionFile, (line) => {
    const entry = parseJsonEntry(line);
    if (entry) entries.push(entry);
    return entries.length < LINES_READ;
  });
  return parseReviewerRuns(entries.reverse());
}
