import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { PullRequest } from "./github.ts";
import type { FinishedReviewerRun } from "./reviewerRuns.ts";
import { latestAgentReviews, openBoardStore, recordAgentReview } from "./store.ts";
import { createTask, finishTask, getTask, linkSession, pauseTask, recordPlan, reportTask } from "./taskStore.ts";
import { clearUserBlockerOnWork, recordRecoveredReview } from "./watcher.ts";

const pr = { repo: "acme/api", number: 7, headSha: "aaa" } as PullRequest;
const run = (id: string, finishedAt: string, output: string): FinishedReviewerRun => ({ id, startedAt: "2026-11-10T12:00:00.000Z", finishedAt, assignment: "", output });
const latest = (db: Database) => latestAgentReviews(db).get("acme/api#7");

test("reviewers that ran side by side on one commit add up, even finishing at the same moment", () => {
  const db = openBoardStore(":memory:");
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  recordRecoveredReview(db, run("Security", "2026-11-10T12:05:00.000Z", "Token logged in plain text"), pr, 1);
  expect(latest(db)).toMatchObject({ verdict: "findings", findings: 1 });
  expect(latest(db)?.summary).toContain("Looks fine");
  expect(latest(db)?.summary).toContain("Token logged in plain text");
});

test("a review the agent recorded after the run finished wins", () => {
  const db = openBoardStore(":memory:");
  recordAgentReview(db, { repo: "acme/api", number: 7, headSha: "aaa", verdict: "findings", findings: 2, summary: "the agent's", reviewedAt: "2026-11-10T12:06:00.000Z" });
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  expect(latest(db)).toMatchObject({ findings: 2, summary: "the agent's" });
});

test("a review of an earlier commit gives way", () => {
  const db = openBoardStore(":memory:");
  recordAgentReview(db, { repo: "acme/api", number: 7, headSha: "old", verdict: "findings", findings: 3, summary: null, reviewedAt: "2026-11-10T11:00:00.000Z" });
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  expect(latest(db)).toMatchObject({ headSha: "aaa", verdict: "passed", findings: 0 });
});

test("starting work clears a stale 'waiting on you' block, leaving other blockers and delivered/paused tasks alone", () => {
  const db = openBoardStore(":memory:");
  const at = "2026-11-23T10:00:00Z";
  const later = "2026-11-23T10:05:00Z";

  // Blocked on me → cleared when its session starts working.
  const waitingOnMe = createTask(db, { title: "Pick datacenter", details: null, projectId: null, stage: "doing", status: "Asked which DC", approvePlan: false, cwd: null, at });
  reportTask(db, waitingOnMe.id, { blocked: { on: "me", reason: "Which datacenter?" }, at });
  linkSession(db, waitingOnMe.id, "/tmp/s-me.jsonl", at);
  expect(clearUserBlockerOnWork(db, "/tmp/s-me.jsonl", later)).toBe(waitingOnMe.id);
  expect(getTask(db, waitingOnMe.id)).toMatchObject({ blockedOn: null, blockedReason: null, status: "Asked which DC" });

  // Blocked on others → left alone.
  const waitingOnOthers = createTask(db, { title: "Review PR", details: null, projectId: null, stage: "doing", status: "Waiting", approvePlan: false, cwd: null, at });
  reportTask(db, waitingOnOthers.id, { blocked: { on: "others", reason: "Waiting on Sara" }, at });
  linkSession(db, waitingOnOthers.id, "/tmp/s-others.jsonl", at);
  expect(clearUserBlockerOnWork(db, "/tmp/s-others.jsonl", later)).toBeNull();
  expect(getTask(db, waitingOnOthers.id)?.blockedOn).toBe("others");

  // Paused, delivered, or waiting on plan approval → left alone.
  const paused = createTask(db, { title: "Paused", details: null, projectId: null, stage: "doing", status: null, approvePlan: false, cwd: null, at });
  reportTask(db, paused.id, { blocked: { on: "me", reason: "Question" }, at });
  pauseTask(db, paused.id, at);
  linkSession(db, paused.id, "/tmp/s-paused.jsonl", at);
  expect(clearUserBlockerOnWork(db, "/tmp/s-paused.jsonl", later)).toBeNull();

  const delivered = createTask(db, { title: "Delivered", details: null, projectId: null, stage: "doing", status: null, approvePlan: false, cwd: null, at });
  finishTask(db, delivered.id, { note: "Done", at });
  linkSession(db, delivered.id, "/tmp/s-done.jsonl", at);
  expect(clearUserBlockerOnWork(db, "/tmp/s-done.jsonl", later)).toBeNull();

  const planning = createTask(db, { title: "Plan", details: null, projectId: null, stage: "plan", status: null, approvePlan: true, cwd: null, at });
  reportTask(db, planning.id, { blocked: { on: "me", reason: "Approve?" }, at });
  recordPlan(db, planning.id, "1. Do it", at);
  linkSession(db, planning.id, "/tmp/s-plan.jsonl", at);
  expect(clearUserBlockerOnWork(db, "/tmp/s-plan.jsonl", later)).toBeNull();
});
