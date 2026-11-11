import { expect, test } from "bun:test";
import type { Message } from "../server/messages.ts";
import { agentSaidWhatItWaitsOn, applyStatusDecision, parseStatusDecision, parseStepOutcome } from "./autoStatus.ts";
import { openBoardStore } from "./store.ts";
import { createTask, getTask, reportTask, taskEvents, type NewTask } from "./taskStore.ts";
import { dueMoment, observe } from "./watcher.ts";

const base: NewTask = { title: "Roll out the cache", details: null, projectId: null, stage: "doing", status: "Opening the PR", approvePlan: false, cwd: null, at: "2026-11-04T10:00:00Z" };

function bash(command: string): Message {
  return { id: command, role: "assistant", timestamp: "2026-11-04T10:00:00Z", blocks: [{ type: "toolCall", id: command, name: "bash", summary: command, argsJson: JSON.stringify({ command }) }] };
}

function said(role: "user" | "assistant", text: string): Message {
  return { id: text, role, timestamp: "2026-11-04T10:00:00Z", blocks: [{ type: "text", text }] };
}

test("a model answer is read out of prose or a code fence, and one the board can't use is refused", () => {
  expect(parseStatusDecision('Sure:\n```json\n{"accurate": false, "stage": "doing", "status": "PR merged", "waiting_on": "others", "reason": "Deploy running"}\n```', "stopped")).toEqual({
    accurate: false,
    stage: "doing",
    status: "PR merged",
    waitingOn: "others",
    reason: "Deploy running",
  });
  expect(parseStatusDecision('{"accurate": true}', "stopped")).toEqual({ accurate: true });
  // The watcher never ships a task, and a stopped agent's answer must say what it waits on.
  expect(parseStatusDecision('{"accurate": false, "stage": "done", "status": "Shipped", "waiting_on": "finished"}', "stopped")).toBeNull();
  expect(parseStatusDecision('{"accurate": false, "stage": "doing", "status": "Fixing tests"}', "stopped")).toBeNull();
  // While the agent works, what it waits on isn't asked, so an answer naming it anyway doesn't count.
  expect(parseStatusDecision('{"accurate": false, "stage": "doing", "status": "Fixing tests", "waiting_on": "me", "reason": "?"}', "working")).toMatchObject({ waitingOn: null, reason: null });
  expect(parseStatusDecision("I can't tell", "stopped")).toBeNull();
});

test("a stopped agent's forgotten blocker lands on the card marked as relay's, until the agent reports itself", () => {
  const db = openBoardStore(":memory:");
  const seen = createTask(db, base);
  const change = applyStatusDecision(db, seen, { accurate: false, stage: "doing", status: "Opened the PR; CI running", waitingOn: "others", reason: "CI on the PR" }, "Opened it.", "2026-11-04T10:30:00Z");
  expect(change).toBe("doing: Opened the PR; CI running; waiting on others: CI on the PR");
  expect(getTask(db, seen.id)).toMatchObject({ blockedOn: "others", blockedReason: "CI on the PR", status: "Opened the PR; CI running", autoReportedAt: "2026-11-04T10:30:00Z" });
  expect(taskEvents(db).get(seen.id)?.filter((event) => event.auto).map((event) => event.kind)).toEqual(["blocked", "status"]);

  expect(reportTask(db, seen.id, { status: "CI green", blocked: null, at: "2026-11-04T10:40:00Z" }).autoReportedAt).toBeNull();
});

test("the agent's own report wins over an answer about the card as it was, and an answer that changes nothing writes nothing", () => {
  const db = openBoardStore(":memory:");
  const seen = createTask(db, base);
  reportTask(db, seen.id, { status: "Asked you which datacenter", blocked: { on: "me", reason: "Which datacenter first?" }, at: "2026-11-04T10:20:00Z" });
  expect(applyStatusDecision(db, seen, { accurate: false, stage: "doing", status: "Waiting", waitingOn: "others", reason: "CI" }, null, "2026-11-04T10:21:00Z")).toBeNull();
  expect(getTask(db, seen.id)).toMatchObject({ blockedOn: "me", autoReportedAt: null });

  const now = getTask(db, seen.id)!;
  expect(applyStatusDecision(db, now, { accurate: false, stage: "doing", status: "Asked you which datacenter", waitingOn: "me", reason: "Which datacenter first?" }, null, "2026-11-04T10:22:00Z")).toBeNull();
  expect(getTask(db, seen.id)?.updatedAt).toBe("2026-11-04T10:20:00Z");
});

test("while the agent works, a refresh moves the stage and status but keeps what the task waits on", () => {
  const db = openBoardStore(":memory:");
  const { id } = createTask(db, { ...base, stage: "plan" });
  const seen = reportTask(db, id, { blocked: { on: "others", reason: "Storage team approval" }, at: "2026-11-04T10:05:00Z" });
  applyStatusDecision(db, seen, { accurate: false, stage: "doing", status: "Applying in staging", waitingOn: null, reason: null }, null, "2026-11-04T10:30:00Z");
  expect(getTask(db, id)).toMatchObject({ stage: "doing", status: "Applying in staging", blockedOn: "others", blockedReason: "Storage team approval", blockedAt: "2026-11-04T10:05:00Z" });
});

test("an agent that says it's done without handing it over goes to Ready to ship with its last message as the note", () => {
  const db = openBoardStore(":memory:");
  const seen = createTask(db, base);
  applyStatusDecision(db, seen, { accurate: false, stage: "doing", status: "Rolled out everywhere", waitingOn: "finished", reason: null }, "Rolled out to all 6 datacenters; p99 flat.", "2026-11-04T11:00:00Z");
  expect(getTask(db, seen.id)).toMatchObject({
    stage: "doing",
    finishedAt: "2026-11-04T11:00:00Z",
    finishNote: "Rolled out to all 6 datacenters; p99 flat.",
    autoReportedAt: "2026-11-04T11:00:00Z",
  });
});

test("only a last step that told the board what this task waits on, and went through, makes the watcher leave a stop alone", () => {
  const blocked = bash('relay task update --blocked-on others --reason "CI"');
  expect(agentSaidWhatItWaitsOn([said("user", "go"), blocked, said("assistant", "Waiting on CI.")], 1)).toBe(true);
  expect(agentSaidWhatItWaitsOn([said("user", "go"), bash('relay task update T-1 --blocked-on me --reason "?"')], 1)).toBe(true);
  // A report that named no blocker, or work after the report, leaves the stop to check.
  expect(agentSaidWhatItWaitsOn([said("user", "go"), bash('relay task update --status "PR open"'), said("assistant", "Waiting on CI.")], 1)).toBe(false);
  expect(agentSaidWhatItWaitsOn([said("user", "go"), blocked, bash("gh pr checks 12")], 1)).toBe(false);
  // So does a report about another task, or one that failed.
  expect(agentSaidWhatItWaitsOn([said("user", "go"), bash('relay task update T-2 --blocked-on others --reason "CI"')], 1)).toBe(false);
  const failed: Message = { id: "r", role: "tool", timestamp: "2026-11-04T10:00:00Z", blocks: [{ type: "toolResult", toolCallId: blocked.id, name: "bash", text: "no task", truncated: false, isError: true }] };
  expect(agentSaidWhatItWaitsOn([said("user", "go"), blocked, failed], 1)).toBe(false);
  // A report from an earlier turn says nothing about this one.
  expect(agentSaidWhatItWaitsOn([blocked, said("user", "it passed, go on"), said("assistant", "Merged.")], 1)).toBe(false);
});

test("a stop is looked at once, after it settles; quiet work every few minutes; tabs open before the server aren't", () => {
  const start = 1_000_000;
  const idleAtStart = observe(undefined, "idle", 500, start);
  expect(dueMoment(idleAtStart, start + 60_000)).toBeNull();

  const working = observe(idleAtStart, "working", 500, start + 1000);
  expect(dueMoment(working, start + 60_000)).toBeNull();
  expect(dueMoment(working, start + 1000 + 3 * 60_000)).toBe("working");

  const stopped = observe(working, "idle", 900, start + 2000);
  expect(dueMoment(stopped, start + 3000)).toBeNull();
  expect(dueMoment(stopped, start + 6000)).toBe("stopped");
  const checked = { ...stopped, stopChecked: true };
  expect(dueMoment(observe(checked, "idle", 900, start + 9000), start + 9000)).toBeNull();

  // A turn over between two polls never shows as working, but its log grew: that's a stop too.
  const quickTurn = observe(checked, "idle", 1400, start + 12_000);
  expect(dueMoment(quickTurn, start + 16_000)).toBe("stopped");
});

test("a PR step's outcome needs the shape its step records", () => {
  expect(parseStepOutcome('{"done": true, "findings": 2}', "review")).toEqual({ done: true, step: "review", findings: 2 });
  expect(parseStepOutcome('{"done": true, "findings": "two"}', "review")).toBeNull();
  expect(parseStepOutcome('{"done": true, "fixed": false}', "fix-ci")).toEqual({ done: true, step: "fix-ci", fixed: false });
  expect(parseStepOutcome('{"done": false}', "fix-ci")).toEqual({ done: false });
});
