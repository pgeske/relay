import type { Database } from "bun:sqlite";
import type { Message } from "../server/messages.ts";
import { BLOCKERS, finishTask, getTask, reportTask, taskRef, type BlockedOn, type Task } from "./taskStore.ts";
import { timeAgo } from "./view.ts";

/**
 * Relay's watcher fills in for agents that forget to keep the board current. Agents are asked to
 * report their task's stage, status, and what it waits on, but they often forget, or report minutes
 * late. So when a task's agent stops, or works a while without reporting, relay shows the end of its
 * session to a small, fast model and corrects the card from its answer. This file decides what to
 * ask and what an answer changes; watcher.ts decides when to ask.
 */

/** When the watcher looks: the agent just stopped and waits for input, or it's still working. */
export type Moment = "stopped" | "working";

/** The stages a working task can be in; the watcher never ships a task or turns it back into an idea. */
const WORK_STAGES = ["research", "plan", "doing"] as const;
type WorkStage = (typeof WORK_STAGES)[number];

/** What a stopped agent waits on: the user, anyone else, something already moving on its own, or nothing because it says it's finished. */
type WaitingOn = BlockedOn | "finished";

const WAITING_TEXT: Record<BlockedOn, string> = { me: "waiting on you", others: "waiting on others", progress: "in progress" };

export type StatusDecision =
  | { accurate: true }
  | {
      accurate: false;
      stage: WorkStage;
      status: string;
      /** Null while the agent works: what it waits on only matters once it stops. */
      waitingOn: WaitingOn | null;
      reason: string | null;
    };

/** Each message's text is cut to this, so one long paste can't crowd out the rest. */
const MESSAGE_CHARS = 1200;
/** How much of the session the model reads, newest first. */
const TRANSCRIPT_CHARS = 12_000;
/** A note the watcher hands in for a finished task: the agent's last message, cut to this. */
const NOTE_CHARS = 4000;
const STATUS_CHARS = 120;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " "), max);
}

/** The end of a session as the model reads it: what was said and which tools ran, oldest first, as much as fits. */
export function renderTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "text") lines.push(`${message.role === "user" ? "USER" : "AGENT"}: ${clip(block.text, MESSAGE_CHARS)}`);
      else if (block.type === "toolCall") lines.push(`AGENT ran ${block.name}: ${block.summary}`);
      else if (block.type === "toolResult" && block.isError) lines.push(`  (that failed: ${oneLine(block.text, 200)})`);
    }
  }
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.toReversed()) {
    size += line.length + 1;
    if (size > TRANSCRIPT_CHARS) break;
    kept.push(line);
  }
  return kept.reverse().join("\n");
}

/** The agent's last words: what it said when it stopped. */
export function lastAgentText(messages: Message[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role !== "assistant") continue;
    const text = message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n").trim();
    if (text) return text;
  }
  return null;
}

function bashCommand(argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as { command?: unknown };
    return typeof args.command === "string" ? args.command : "";
  } catch {
    return "";
  }
}

/**
 * Whether the agent's last step before stopping was to tell the board what this task waits on
 * (`relay task update --blocked-on …` or `--in-progress`), and it went through. Then its own word
 * stands. A last report that named no blocker doesn't count: saying what it waits on is the part
 * agents forget. Neither does one that failed, or that named another task.
 */
export function agentSaidWhatItWaitsOn(messages: Message[], taskId: number): boolean {
  const turn = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1);
  const blocks = turn.flatMap((message) => message.blocks);
  const last = blocks.flatMap((block) => (block.type === "toolCall" ? [block] : [])).at(-1);
  if (!last || last.name !== "bash") return false;
  const command = bashCommand(last.argsJson);
  const update = /\brelay task update(?:\s+(?:T-?)?(\d+)\b)?/i.exec(command);
  if (!update || !/--blocked-on\b|--in-progress\b/.test(command)) return false;
  if (update[1] !== undefined && Number(update[1]) !== taskId) return false;
  return !blocks.some((block) => block.type === "toolResult" && block.toolCallId === last.id && block.isError);
}

function boardSays(task: Task, now: Date): string {
  const status = task.status
    ? `"${task.status}" (${timeAgo(task.statusAt ?? task.updatedAt, now)}, ${task.autoReportedAt ? "filled in by relay, not the agent" : "reported by the agent"})`
    : "none yet";
  const waiting = task.blockedOn ? `${WAITING_TEXT[task.blockedOn]}: ${task.blockedReason ?? "no reason given"}` : "nothing";
  const plan = !task.approvePlan
    ? "no approval needed"
    : !task.plan
      ? "the user approves its plan before it starts; none recorded yet"
      : task.planApprovedAt
        ? "approved by the user"
        : "waiting for the user's approval";
  return [`- stage: ${task.stage}`, `- status: ${status}`, `- waiting on: ${waiting}`, `- plan: ${plan}`].join("\n");
}

/** What the watcher asks the model about a task, given the end of its session. */
export function statusPrompt(task: Task, moment: Moment, transcript: string, now: Date): string {
  const asked = task.details ? `\nWhat the user asked for:\n${clip(task.details, 1500)}\n` : "";
  const fields =
    moment === "stopped"
      ? `{"accurate": false, "stage": "...", "status": "...", "waiting_on": "me" | "others" | "progress" | "finished", "reason": "..."}`
      : `{"accurate": false, "stage": "...", "status": "..."}`;
  const waitingRules =
    moment === "stopped"
      ? `
- waiting_on: what has to happen before the task moves again:
  - "finished": the agent says the whole task is done and checked.
  - "progress": nothing is stuck. Something is already moving it along on its own and the agent picks it back up when that ends: CI running, a deploy, rollout, or upgrade underway, a background job or subagent the agent started, a fix it just pushed. "Upgrading", "rolling out", or "CI running" is progress, not waiting.
  - "others": stopped until someone besides the user acts: a reviewer's approval, another team's answer or change, an access grant, a stuck or failed system nobody here can fix.
  - "me": stopped until the user acts, and they can: answer a question, make a decision, approve, send a message the agent drafted, log in, look at something before the agent goes on. Only when the agent truly can't go on without the user (then it's "me" even if something else is running). A problem the agent is already fixing, like red CI it pushed a fix for, is "progress", not "me".
- reason: what exactly, in one short line ("Which datacenter goes first?", "Cluster upgrade in staging underway", "Waiting on storage team's approval"). Leave it empty for "finished".`
      : "";
  return `An AI agent works on a task for the user in a terminal session. It is supposed to keep the user's task board current, but it often forgets or reports late. Read the end of its session and say what the board should show now.

Task ${taskRef(task.id)}: ${task.title}
${asked}
The board shows:
${boardSays(task, now)}

${moment === "stopped" ? "The agent just stopped and is waiting for input." : "The agent is working right now, so the status says what it's doing, not what it waits on."}

The session, oldest first, up to now (go by its end: the start can be about earlier work):
${transcript}

Stages: research (reading, investigating), plan (working out how, writing a plan), doing (making the change and seeing it through: code, PRs, CI, reviews, merging, deploying, verifying).

Reply with only a JSON object, either {"accurate": true} when the board already shows the right thing, or:
${fields}
- stage: where the work is now.
- status: where it stands now in one short, plain line under 80 characters, like "Opened the PR; CI running". Say what is true now, not what happened ten steps ago.${waitingRules}`;
}

/** The first JSON object in a model's reply, which may wrap it in prose or a code fence. */
export function jsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads the model's answer; null when it's not one the board can use. */
export function parseStatusDecision(reply: string, moment: Moment): StatusDecision | null {
  const answer = jsonObject(reply);
  if (!answer) return null;
  if (answer.accurate === true) return { accurate: true };
  const stage = WORK_STAGES.find((candidate) => candidate === answer.stage);
  const status = typeof answer.status === "string" ? oneLine(answer.status, STATUS_CHARS) : "";
  if (!stage || !status) return null;
  let waitingOn: WaitingOn | null = null;
  if (moment === "stopped") {
    const answered = [...BLOCKERS, "finished"].find((candidate) => candidate === answer.waiting_on) as WaitingOn | undefined;
    if (!answered) return null;
    waitingOn = answered;
  }
  const reason = waitingOn !== "finished" && typeof answer.reason === "string" ? oneLine(answer.reason, STATUS_CHARS) : "";
  return { accurate: false, stage, status, waitingOn, reason: waitingOn && reason ? reason : null };
}

/**
 * Corrects a task's card from the model's answer, marked as relay's, and says what changed (null
 * for nothing). `seen` is the task as the model was shown it: if the agent reported since, its own
 * word wins, so the check and the writes share one write transaction. While the agent works, what
 * the task waits on stays as it was. A finished task goes to Ready to ship with the agent's last
 * message as its note, for the user to look over as usual.
 */
export function applyStatusDecision(db: Database, seen: Task, decision: StatusDecision, agentText: string | null, at: string): string | null {
  if (decision.accurate) return null;
  return db.transaction(() => applyToCurrent(db, seen, decision, agentText, at)).immediate();
}

function applyToCurrent(db: Database, seen: Task, decision: StatusDecision & { accurate: false }, agentText: string | null, at: string): string | null {
  const task = getTask(db, seen.id);
  if (!task || task.updatedAt !== seen.updatedAt) return null;

  if (decision.waitingOn === "finished") {
    if (decision.stage !== task.stage) reportTask(db, task.id, { stage: decision.stage, blocked: null, auto: true, at });
    finishTask(db, task.id, { note: agentText && clip(agentText, NOTE_CHARS), status: decision.status, auto: true, at });
    return `delivered: ${decision.status}`;
  }

  const blocked = decision.waitingOn
    ? { on: decision.waitingOn, reason: decision.reason }
    : // The agent is working, so it isn't waiting on you; what it said it waits on elsewhere stands.
      task.blockedOn && task.blockedOn !== "me"
      ? { on: task.blockedOn, reason: task.blockedReason }
      : null;
  const sameBlock = (blocked?.on ?? null) === task.blockedOn && (blocked?.reason ?? null) === task.blockedReason;
  if (decision.stage === task.stage && decision.status === task.status && sameBlock) return null;
  reportTask(db, task.id, {
    stage: decision.stage,
    status: decision.status === task.status ? undefined : decision.status,
    blocked,
    auto: true,
    at,
  });
  const waits = blocked ? `; ${WAITING_TEXT[blocked.on]}${blocked.reason ? `: ${blocked.reason}` : ""}` : "";
  return `${decision.stage}: ${decision.status}${waits}`;
}

/** The PR steps whose results the watcher can record when the session forgot: a review, a CI fix, and addressing feedback. */
export type RecordableStep = "review" | "fix-ci" | "address-feedback";

export type StepOutcome =
  | { done: false }
  | { done: true; step: "review"; findings: number }
  /** `fixed`: CI is fixed, or the feedback addressed. */
  | { done: true; step: "fix-ci" | "address-feedback"; fixed: boolean };

const STEP_ASKS: Record<RecordableStep, (url: string) => string> = {
  review: (url) => `The user asked the agent to run a reviewer agent on the pull request ${url} and record the result. Did the review finish, and how many actionable findings (issues worth changing the code for) did it report?
Reply with only a JSON object: {"done": true, "findings": <number>} once the review finished (0 when it found nothing to change), or {"done": false} if it didn't finish.`,
  "fix-ci": (url) => `The user asked the agent to fix the failing CI on the pull request ${url}: retry flaky jobs, or fix a real failure with a new commit, and record the result. Did it finish, and is CI fixed?
Reply with only a JSON object: {"done": true, "fixed": true} once it fixed CI or retried the failing jobs, {"done": true, "fixed": false} if it concluded it can't fix it, or {"done": false} if it didn't finish.`,
  "address-feedback": (url) => `The user asked the agent to address reviewers' feedback on the pull request ${url}: fix what they asked with new commits, draft replies for the user to post, and record the result. Did it finish, and did it address the feedback?
Reply with only a JSON object: {"done": true, "fixed": true} once it went through the feedback (fixing it, or drafting a reply explaining why not), {"done": true, "fixed": false} if it concluded it can't address it, or {"done": false} if it didn't finish.`,
};

/** What the watcher asks the model about a PR step the board asked a session for, which stopped without recording a result. */
export function stepPrompt(step: RecordableStep, url: string, transcript: string): string {
  return `An AI agent works for the user in a terminal session and just stopped. ${STEP_ASKS[step](url)}

The session, oldest first, up to now:
${transcript}`;
}

/** Reads the model's answer about a PR step; null when it's not one the board can use. */
export function parseStepOutcome(reply: string, step: RecordableStep): StepOutcome | null {
  const answer = jsonObject(reply);
  if (!answer || typeof answer.done !== "boolean") return null;
  if (!answer.done) return { done: false };
  if (step === "review") {
    const findings = answer.findings;
    return typeof findings === "number" && Number.isInteger(findings) && findings >= 0 ? { done: true, step, findings } : null;
  }
  return typeof answer.fixed === "boolean" ? { done: true, step, fixed: answer.fixed } : null;
}

/** A reviewer agent a session ran on its own, as the watcher found it: what it was asked, and what it said. */
export interface ReviewerRun {
  assignment: string;
  output: string;
}

/** What the watcher asks the model about a reviewer agent a session ran without the board asking: which of the session's PRs it reviewed. */
export function reviewerRunPrompt(run: ReviewerRun, prUrls: string[]): string {
  return `An AI agent working for the user ran a reviewer agent. Was it reviewing one of these pull requests, and if so, how many actionable findings (issues worth changing the code for) did it report?
${prUrls.map((url) => `- ${url}`).join("\n")}

What the reviewer was asked:
"""
${clip(run.assignment, 3000)}
"""

What it reported:
"""
${clip(run.output, 6000)}
"""

Reply with only a JSON object: {"pr": "<one of the URLs above>", "findings": <number>} (0 when it found nothing to change), or {"pr": null} if it reviewed something else, or you can't tell which.`;
}

/** Reads the model's answer about a reviewer run: the PR it reviewed and what it found, `pr` null for none of them; null when unusable. */
export function parseReviewerRun(reply: string, prUrls: string[]): { pr: string; findings: number } | { pr: null } | null {
  const answer = jsonObject(reply);
  if (!answer) return null;
  if (answer.pr === null) return { pr: null };
  const pr = prUrls.find((url) => url === answer.pr);
  const findings = answer.findings;
  return pr && typeof findings === "number" && Number.isInteger(findings) && findings >= 0 ? { pr, findings } : null;
}
