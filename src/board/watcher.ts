import type { Database } from "bun:sqlite";
import { readMessagePage, type Message } from "../server/messages.ts";
import { parsePaneTitle, type SessionStatus } from "../server/sessions.ts";
import { fileSize } from "../server/sessionFile.ts";
import { askModel } from "./askModel.ts";
import {
  agentSaidWhatItWaitsOn,
  applyStatusDecision,
  lastAgentText,
  parseStatusDecision,
  parseStepOutcome,
  renderTranscript,
  statusPrompt,
  stepPrompt,
  type Moment,
  type RecordableStep,
} from "./autoStatus.ts";
import { liveSessions, sourceFor } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import { fetchPullRequest } from "./github.ts";
import { REQUEST_MAX_AGE_MS } from "./lanes.ts";
import { prOwners } from "./owners.ts";
import { agentRequestHead, agentRequests, latestAgentReviews, latestCiFixes, openBoardStore, recordAgentReview, recordCiFix } from "./store.ts";
import { currentTask, getTask, taskRef, type Task } from "./taskStore.ts";

/**
 * When relay's watcher looks at a session (see autoStatus.ts for what it does then). Spotting an
 * agent stop is a cheap tmux check every few seconds; the model only runs when one does, or when an
 * agent has worked for a while without reporting.
 */

const POLL_MS = 3000;
/** omp flips its tab to idle as the turn ends; give the session log a moment to catch up. */
const SETTLE_MS = 3000;
/** A working agent that hasn't reported in this long gets its card refreshed, at most this often. */
const QUIET_MS = 3 * 60_000;
/** How much of a session's end the watcher reads. */
const MESSAGES_READ = 80;
/** The board pastes its prompt into a session (reopening it first, if need be) before noting the request. */
const REQUEST_PROMPT_SLACK_MS = 2 * 60_000;
const SYSTEM_PROMPT = "You keep a task board accurate by reading AI agents' terminal sessions. Answer only from what you're given, never use tools, and reply with only the JSON object asked for.";

/** One relay tab's agent, as the watcher has seen it. */
export interface Track {
  status: SessionStatus;
  /** When it last went working or idle, or its log grew while idle. */
  since: number;
  /** Its current stop was looked at already. */
  stopChecked: boolean;
  lastWorkingCheck: number;
  /** Its session log's size, in bytes. */
  logSize: number;
}

/** Whether a task's card is the watcher's to correct: one in play, not shipped, paused, delivered, or waiting on your plan approval. */
function watchable(task: Task): boolean {
  const planAwaiting = task.approvePlan && task.plan !== null && task.planApprovedAt === null;
  return task.stage !== "done" && task.pausedAt === null && task.finishedAt === null && !planAwaiting;
}

/**
 * `stillCurrent` says whether what the model read is still the session's latest: an answer about a
 * stop the user has since moved past (a new turn began) is dropped.
 */
async function checkTask(sessionFile: string, moment: Moment, messages: Message[], model: string, stillCurrent: () => Promise<boolean>): Promise<void> {
  const db = openBoardStore();
  let task: Task | null;
  try {
    const id = currentTask(db, sessionFile);
    task = id === null ? null : getTask(db, id);
  } finally {
    db.close();
  }
  if (!task || !watchable(task)) return;
  if (moment === "working" && Date.now() - Date.parse(task.updatedAt) < QUIET_MS) return;
  if (moment === "stopped" && agentSaidWhatItWaitsOn(messages, task.id)) return;

  const reply = await askModel(statusPrompt(task, moment, renderTranscript(messages), new Date()), model, SYSTEM_PROMPT);
  const decision = parseStatusDecision(reply, moment);
  if (!decision) {
    console.error(`watcher: no usable answer for ${taskRef(task.id)}: ${reply.trim().slice(0, 200)}`);
    return;
  }
  if (!(await stillCurrent())) return;
  const store = openBoardStore();
  try {
    const change = applyStatusDecision(store, task, decision, lastAgentText(messages), new Date().toISOString());
    console.log(`watcher: ${taskRef(task.id)} ${change ? `→ ${change}` : "card already right"} (${moment})`);
  } finally {
    store.close();
  }
}

interface ForgottenStep {
  repo: string;
  number: number;
  step: RecordableStep;
  requestedAt: string;
}

/** The reviews and CI fixes the board asked this session for that it hasn't recorded a result for. */
function forgottenSteps(db: Database, sessionFile: string, now: number): ForgottenStep[] {
  const requests = agentRequests(db);
  const reviews = latestAgentReviews(db);
  const ciFixes = latestCiFixes(db);
  return [...prOwners(db)].flatMap(([key, owner]) => {
    if (owner.sessionFile !== sessionFile) return [];
    return (["review", "fix-ci"] as const).flatMap((step) => {
      const requestedAt = requests.get(key)?.[step];
      if (!requestedAt || now - Date.parse(requestedAt) > REQUEST_MAX_AGE_MS) return [];
      const answeredAt = step === "review" ? reviews.get(key)?.reviewedAt : ciFixes.get(key)?.recordedAt;
      return answeredAt && answeredAt >= requestedAt ? [] : [{ repo: owner.repo, number: owner.number, step, requestedAt }];
    });
  });
}

/**
 * Records the result of a review or CI fix the board asked a session for, when the session stopped
 * without recording it. The model reads the session from the request on and says whether the step
 * finished and how; the agent's last message becomes the result's write-up. A review counts only
 * for the commit it covered, so one is left alone when commits landed since the board asked for it.
 * Right before writing, relay checks again that the request is still the same and still unanswered:
 * a result the agent recorded meanwhile wins.
 */
async function recordForgottenSteps(sessionFile: string, messages: Message[], model: string, stillCurrent: () => Promise<boolean>): Promise<void> {
  const db = openBoardStore();
  let forgotten: ForgottenStep[];
  try {
    forgotten = forgottenSteps(db, sessionFile, Date.now());
  } finally {
    db.close();
  }
  for (const { repo, number, step, requestedAt } of forgotten) {
    const since = new Date(Date.parse(requestedAt) - REQUEST_PROMPT_SLACK_MS).toISOString();
    const fromRequest = messages.filter((message) => message.timestamp >= since);
    // The request scrolled out of what the watcher reads, or the session never got it.
    if (!fromRequest.some((message) => message.role === "user")) continue;
    const url = `https://github.com/${repo}/pull/${number}`;
    const outcome = parseStepOutcome(await askModel(stepPrompt(step, url, renderTranscript(fromRequest)), model, SYSTEM_PROMPT), step);
    if (!outcome?.done) {
      console.log(`watcher: the ${step} of ${repo}#${number} didn't finish, by the session; leaving it`);
      continue;
    }

    const pr = await fetchPullRequest(sourceFor(loadBoardConfig(), repo), repo, number);
    if (pr.state !== "OPEN" || !(await stillCurrent())) continue;
    const summary = `Relay recorded this from the session, which stopped without recording it. The agent's last message:\n\n${lastAgentText(fromRequest) ?? "(none)"}`;
    const at = new Date().toISOString();
    const store = openBoardStore();
    try {
      const skipped = store
        .transaction(() => {
          const unchanged = forgottenSteps(store, sessionFile, Date.now()).some((other) => other.repo === repo && other.number === number && other.step === step && other.requestedAt === requestedAt);
          if (!unchanged) return "the request changed or got a result meanwhile";
          if (outcome.step === "review") {
            if (agentRequestHead(store, repo, number, "review") !== pr.headSha) return "commits landed since the review was asked for";
            recordAgentReview(store, { repo, number, headSha: pr.headSha, verdict: outcome.findings === 0 ? "passed" : "findings", findings: outcome.findings, summary, reviewedAt: at });
          } else {
            recordCiFix(store, { repo, number, headSha: pr.headSha, verdict: outcome.fixed ? "fixed" : "not-fixed", summary, recordedAt: at });
          }
          return null;
        })
        .immediate();
      console.log(`watcher: ${skipped ? `left the forgotten ${step} result of ${repo}#${number} alone: ${skipped}` : `recorded the forgotten ${step} result of ${repo}#${number}`}`);
    } finally {
      store.close();
    }
  }
}

async function check(sessionFile: string, moment: Moment): Promise<void> {
  const { autoStatus } = loadBoardConfig();
  if (!autoStatus.enabled) return;
  const sizeRead = await fileSize(sessionFile);
  // The model reads text only, so images need no URL.
  const { messages } = await readMessagePage(sessionFile, () => "", { limit: MESSAGES_READ });
  if (messages.length === 0) return;
  // A working agent's log grows all the time, and what it waits on isn't decided then anyway.
  const stillCurrent = async () => moment === "working" || (await fileSize(sessionFile)) === sizeRead;
  await checkTask(sessionFile, moment, messages, autoStatus.model, stillCurrent);
  if (moment === "stopped") await recordForgottenSteps(sessionFile, messages, autoStatus.model, stillCurrent);
}

/**
 * A session's track after a look at its status and log. A turn quicker than a poll never shows as
 * working, so an idle session whose log grew stopped again too. A session first seen idle (open
 * before the server started) isn't looked at until it works and stops again.
 */
export function observe(track: Track | undefined, status: SessionStatus, logSize: number, now: number): Track {
  if (!track) return { status, since: now, stopChecked: true, lastWorkingCheck: now, logSize };
  if (track.status !== status) return { status, since: now, stopChecked: false, lastWorkingCheck: now, logSize };
  if (status === "idle" && logSize !== track.logSize) return { ...track, since: now, stopChecked: false, logSize };
  return track;
}

/** What's due a look: an agent's stop, once it settled, or its quiet work. */
export function dueMoment(track: Track, now: number): Moment | null {
  if (track.status === "idle" && !track.stopChecked && now - track.since >= SETTLE_MS) return "stopped";
  if (track.status === "working" && now - track.lastWorkingCheck >= QUIET_MS) return "working";
  return null;
}

/** Starts watching relay's tabs for as long as the server runs. */
export function startWatcher(): void {
  const tracks = new Map<string, Track>();
  const busy = new Set<string>();

  const tick = async () => {
    const live = await liveSessions();
    const now = Date.now();
    for (const file of tracks.keys()) if (!live.has(file)) tracks.delete(file);
    for (const [file, pane] of live) {
      const track = observe(tracks.get(file), parsePaneTitle(pane.title, pane.cwd).status, await fileSize(file), now);
      tracks.set(file, track);
      // A look still under way leaves what's due for the next tick.
      if (busy.has(file)) continue;
      const moment = dueMoment(track, now);
      if (!moment) continue;
      tracks.set(file, moment === "stopped" ? { ...track, stopChecked: true } : { ...track, lastWorkingCheck: now });
      busy.add(file);
      void check(file, moment)
        .catch((error: unknown) => console.error(`watcher: checking ${file} failed`, error))
        .finally(() => busy.delete(file));
    }
  };
  setInterval(() => void tick().catch((error: unknown) => console.error("watcher: could not list relay's tabs", error)), POLL_MS).unref();
}
