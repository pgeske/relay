import type { Database } from "bun:sqlite";
import { readMessagePage, type Message } from "../server/messages.ts";
import { parsePaneTitle, type SessionStatus } from "../server/sessions.ts";
import { fileSize } from "../server/sessionFile.ts";
import { askModel } from "./askModel.ts";
import {
  agentSaidWhatItWaitsOn,
  applyStatusDecision,
  lastAgentText,
  parseReviewerRun,
  parseStatusDecision,
  parseStepOutcome,
  renderTranscript,
  reviewerRunPrompt,
  statusPrompt,
  stepPrompt,
  type Moment,
  type RecordableStep,
} from "./autoStatus.ts";
import { notifyBoardChanged } from "./boardEvents.ts";
import { liveSessions, sourceFor } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import { fetchPullRequest, type PullRequest } from "./github.ts";
import { REQUEST_MAX_AGE_MS } from "./lanes.ts";
import { prOwners, scanSessions } from "./owners.ts";
import { finishedReviewerRuns, type FinishedReviewerRun } from "./reviewerRuns.ts";
import {
  agentRequestHead,
  agentRequests,
  latestAgentReviews,
  latestCiFixes,
  latestFeedbackFixes,
  markReviewerRunSeen,
  openBoardStore,
  recordAgentReview,
  recordCiFix,
  recordFeedbackFix,
  seenReviewerRuns,
  type AgentReview,
} from "./store.ts";
import { currentTask, followsSession, getTask, reportTask, taskRef, type Task } from "./taskStore.ts";

/**
 * When relay's watcher looks at a session (see autoStatus.ts for what it does then). Spotting an
 * agent stop is a cheap tmux check every few seconds; the model only runs when one does, or when an
 * agent has worked for a while without reporting.
 */

const POLL_MS = 1000;
/** omp flips its tab to idle as the turn ends; give the session log a moment to catch up. */
const SETTLE_MS = 1500;
/** A working agent that hasn't reported in this long gets its card refreshed, at most this often. */
const QUIET_MS = 2 * 60_000;
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

/**
 * `stillCurrent` says whether what the model read is still the session's latest: an answer about a
 * stop the user has since moved past (a new turn began) is dropped.
 */
async function checkTask(sessionFile: string, moment: Moment, messages: Message[], model: string, stillCurrent: () => Promise<boolean>): Promise<void> {
  const task = sessionTask(sessionFile);
  if (!task || !followsSession(task)) return;
  if (moment === "working" && Date.now() - Date.parse(task.updatedAt) < QUIET_MS) return;
  if (moment === "stopped" && agentSaidWhatItWaitsOn(messages, task.id)) return;
  const change = await correctCard(task, moment, messages, model, stillCurrent);
  if (change) notifyBoardChanged({ wakeWorkstreams: true });
  if (change !== undefined) console.log(`watcher: ${taskRef(task.id)} ${change ? `→ ${change}` : "card already right"} (${moment})`);
}

function sessionTask(sessionFile: string): Task | null {
  const db = openBoardStore();
  try {
    const id = currentTask(db, sessionFile);
    return id === null ? null : getTask(db, id);
  } finally {
    db.close();
  }
}

/**
 * Has the model read the session and corrects the task's card from its answer. Says what changed:
 * null for nothing, undefined when there was no usable answer or it's no longer current.
 */
async function correctCard(task: Task, moment: Moment, messages: Message[], model: string, stillCurrent: () => Promise<boolean>): Promise<string | null | undefined> {
  const reply = await askModel(statusPrompt(task, moment, renderTranscript(messages), new Date()), model, SYSTEM_PROMPT);
  const decision = parseStatusDecision(reply, moment);
  if (!decision) {
    console.error(`watcher: no usable answer for ${taskRef(task.id)}: ${reply.trim().slice(0, 200)}`);
    return undefined;
  }
  if (!(await stillCurrent())) return undefined;
  const store = openBoardStore();
  try {
    return applyStatusDecision(store, task, decision, lastAgentText(messages), new Date().toISOString());
  } finally {
    store.close();
  }
}

/**
 * The board's Refresh, for a session that's busy working (an idle one is asked to check for itself):
 * the watcher reads it right away, instead of waiting for its next quiet-work look. Says what it did, in words.
 */
export async function refreshWorkingSession(sessionFile: string): Promise<string> {
  const task = sessionTask(sessionFile);
  if (!task) return "it isn't on a task, so there's no card to update";
  if (!followsSession(task)) return `${taskRef(task.id)}'s card isn't one relay updates right now`;
  const { messages } = await readMessagePage(sessionFile, () => "", { limit: MESSAGES_READ });
  if (messages.length === 0) return "its session has nothing to read yet";
  const change = await correctCard(task, "working", messages, loadBoardConfig().autoStatus.model, async () => true);
  if (change) notifyBoardChanged({ wakeWorkstreams: true });
  console.log(`watcher: refresh of ${taskRef(task.id)} ${change ? `→ ${change}` : "left the card as it was"}`);
  if (change === undefined) return `couldn't tell from its session where ${taskRef(task.id)} stands; the card stays as it was`;
  return change ? `updated ${taskRef(task.id)}: ${change}` : `${taskRef(task.id)}'s card is already right`;
}

interface ForgottenStep {
  repo: string;
  number: number;
  step: RecordableStep;
  requestedAt: string;
}

/** The reviews, CI fixes, and feedback fixes the board asked this session for that it hasn't recorded a result for. */
function forgottenSteps(db: Database, sessionFile: string, now: number): ForgottenStep[] {
  const requests = agentRequests(db);
  const reviews = latestAgentReviews(db);
  const ciFixes = latestCiFixes(db);
  const feedbackFixes = latestFeedbackFixes(db);
  return [...prOwners(db)].flatMap(([key, owner]) => {
    if (owner.sessionFile !== sessionFile) return [];
    return (["review", "fix-ci", "address-feedback"] as const).flatMap((step) => {
      const requestedAt = requests.get(key)?.[step];
      if (!requestedAt || now - Date.parse(requestedAt) > REQUEST_MAX_AGE_MS) return [];
      const answeredAt = step === "review" ? reviews.get(key)?.reviewedAt : (step === "fix-ci" ? ciFixes : feedbackFixes).get(key)?.recordedAt;
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
          } else if (outcome.step === "fix-ci") {
            recordCiFix(store, { repo, number, headSha: pr.headSha, verdict: outcome.fixed ? "fixed" : "not-fixed", summary, recordedAt: at });
          } else {
            recordFeedbackFix(store, { repo, number, headSha: pr.headSha, verdict: outcome.fixed ? "addressed" : "not-addressed", summary, recordedAt: at });
          }
          return null;
        })
        .immediate();
      if (!skipped) notifyBoardChanged();
      console.log(`watcher: ${skipped ? `left the forgotten ${step} result of ${repo}#${number} alone: ${skipped}` : `recorded the forgotten ${step} result of ${repo}#${number}`}`);
    } finally {
      store.close();
    }
  }
}

/**
 * Records reviews an agent ran on its own, without the board asking, and didn't record. For each
 * reviewer agent that finished lately in the session, with the session in charge of an open PR
 * whose latest recorded review is older than the run, the model says which of those PRs it reviewed
 * (if any) and what it found; the reviewer's report becomes the result's write-up. A review counts
 * only for code it saw, so one is left alone when the PR's head commit was made after it started.
 * Reviewers that ran side by side on the same commit (say, a general and a security review) add up.
 * Each run is looked at once, which the board store remembers.
 */
async function recordUnrecordedReviews(sessionFile: string, model: string): Promise<void> {
  const now = Date.now();
  const recent = (await finishedReviewerRuns(sessionFile)).filter((run) => now - Date.parse(run.finishedAt) <= REQUEST_MAX_AGE_MS);
  if (recent.length === 0) return;

  const db = openBoardStore();
  let runs;
  let owned;
  let reviews;
  try {
    const seen = seenReviewerRuns(db, sessionFile);
    runs = recent.filter((run) => !seen.has(`${run.id}|${run.startedAt}`));
    // A PR the session opened since the board last looked is the likeliest one it reviewed.
    if (runs.length > 0) scanSessions(db);
    owned = [...prOwners(db).values()].filter((owner) => owner.sessionFile === sessionFile);
    reviews = latestAgentReviews(db);
  } finally {
    db.close();
  }
  // Agents often review before opening the PR: then the runs wait for a later stop, once it's open.
  if (runs.length === 0 || owned.length === 0) return;
  const config = loadBoardConfig();
  const fetched = await Promise.all(owned.map((owner) => fetchPullRequest(sourceFor(config, owner.repo), owner.repo, owner.number).catch(() => null)));
  const open = fetched.filter((pr): pr is PullRequest => pr?.state === "OPEN");

  for (const run of runs) {
    const match = await matchReviewerRun(run, open, reviews, model);
    // A run counts as looked at only once it's handled, along with the review it gave, so a restart midway loses none.
    const store = openBoardStore();
    try {
      store
        .transaction(() => {
          if (match) recordRecoveredReview(store, run, match.pr, match.findings);
          markReviewerRunSeen(store, sessionFile, run, new Date().toISOString());
        })
        .immediate();
      if (match) notifyBoardChanged();
    } finally {
      store.close();
    }
  }
}

/** Which of the open PRs a reviewer run reviewed and what it found, by the model; null when none it could count for. */
async function matchReviewerRun(
  run: FinishedReviewerRun,
  open: PullRequest[],
  reviews: Map<string, AgentReview>,
  model: string,
): Promise<{ pr: PullRequest; findings: number } | null> {
  // A review recorded when this run finished is a side-by-side run's, which this one adds to.
  const unreviewed = open.filter((pr) => (reviews.get(`${pr.repo}#${pr.number}`)?.reviewedAt ?? "") <= run.finishedAt);
  if (unreviewed.length === 0) return null;
  const urls = unreviewed.map((pr) => pr.url);
  const answer = parseReviewerRun(await askModel(reviewerRunPrompt(run, urls), model, SYSTEM_PROMPT), urls);
  if (!answer) console.error(`watcher: no usable answer about reviewer run ${run.id}`);
  if (!answer?.pr) return null;
  const pr = unreviewed.find((candidate) => candidate.url === answer.pr)!;
  if (!pr.headCommittedAt || pr.headCommittedAt > run.startedAt) {
    console.log(`watcher: left reviewer run ${run.id} of ${pr.repo}#${pr.number} alone: commits landed after it started`);
    return null;
  }
  return { pr, findings: answer.findings };
}

/**
 * Records a reviewer run's result as the PR's review, inside the caller's transaction. A review
 * recorded after the run finished covers it already (the agent's own word wins); one of the same
 * commit recorded while it ran is a side-by-side run's, which this one adds its findings to.
 */
export function recordRecoveredReview(store: Database, run: FinishedReviewerRun, pr: PullRequest, found: number): void {
  const existing = latestAgentReviews(store).get(`${pr.repo}#${pr.number}`);
  if (existing && existing.reviewedAt > run.finishedAt) return;
  const alongside = existing && existing.headSha === pr.headSha && existing.reviewedAt >= run.startedAt ? existing : null;
  const findings = found + (alongside?.findings ?? 0);
  const report = `Relay recorded this from the session, which ran the reviewer on its own and didn't record it. The reviewer's report:\n\n${run.output}`;
  const summary = alongside ? `${alongside.summary ?? ""}\n\n---\n\n${report}`.trim() : report;
  recordAgentReview(store, { repo: pr.repo, number: pr.number, headSha: pr.headSha, verdict: findings === 0 ? "passed" : "findings", findings, summary, reviewedAt: run.finishedAt });
  console.log(`watcher: recorded reviewer run ${run.id} as the review of ${pr.repo}#${pr.number}: ${found} findings`);
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
  if (moment !== "stopped") return;
  await recordForgottenSteps(sessionFile, messages, autoStatus.model, stillCurrent);
  // After the board's own requests, so a review it asked for is recorded as that.
  await recordUnrecordedReviews(sessionFile, autoStatus.model);
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

/**
 * Clears a stale "waiting on you" (or legacy "in progress") block as soon as the task's session
 * starts working again: you answered or typed in the terminal, so even if the turn finishes before
 * the watcher's model runs, the card won't flash the old answered question or linger in progress.
 */
export function clearUserBlockerOnWork(db: Database, sessionFile: string, at: string): number | null {
  const id = currentTask(db, sessionFile);
  if (id === null) return null;
  const task = getTask(db, id);
  if (!task || !followsSession(task) || (task.blockedOn !== "me" && task.blockedOn !== "progress")) return null;
  reportTask(db, task.id, { blocked: null, auto: true, at });
  return task.id;
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
      const prev = tracks.get(file);
      const status = parsePaneTitle(pane.title, pane.cwd).status;
      const track = observe(prev, status, await fileSize(file), now);
      tracks.set(file, track);
      if (prev?.status !== "working" && status === "working") {
        const db = openBoardStore();
        let cleared: number | null = null;
        try {
          cleared = clearUserBlockerOnWork(db, file, new Date(now).toISOString());
        } finally {
          db.close();
        }
        if (cleared !== null) {
          console.log(`watcher: ${taskRef(cleared)} → unblocked (session started working)`);
          notifyBoardChanged({ wakeWorkstreams: true });
        }
      }
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
