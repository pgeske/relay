import { expect, test } from "bun:test";
import { openBoardStore } from "./store.ts";
import { approvePlan, createTask, getTask, linkSession, linkSessionPrs, recordPlan, reportTask, taskPrs, type NewTask } from "./taskStore.ts";

const base: NewTask = { title: "Roll out the cache", details: null, projectId: null, stage: "research", status: null, approvePlan: true, cwd: null, at: "2026-11-04T10:00:00Z" };

test("a report without a blocker clears the block, and a block that goes on keeps when it started", () => {
  const db = openBoardStore(":memory:");
  const { id } = createTask(db, base);
  reportTask(db, id, { blocked: { on: "others", reason: "Waiting on the storage team" }, at: "2026-11-04T10:05:00Z" });
  const still = reportTask(db, id, { status: "Pinged them again", blocked: { on: "others", reason: "Waiting on the storage team" }, at: "2026-11-04T11:00:00Z" });
  expect(still).toMatchObject({ blockedOn: "others", blockedAt: "2026-11-04T10:05:00Z", status: "Pinged them again" });

  const cleared = reportTask(db, id, { stage: "doing", blocked: null, at: "2026-11-04T12:00:00Z" });
  expect(cleared).toMatchObject({ blockedOn: null, blockedReason: null, blockedAt: null, stage: "doing", status: "Pinged them again" });
});

test("a revised plan needs approving again, approving moves an early task on to doing, and only the plan you read gets approved", () => {
  const db = openBoardStore(":memory:");
  const { id } = createTask(db, base);
  expect(recordPlan(db, id, "1. Turn it on", "2026-11-04T10:10:00Z")).toMatchObject({ stage: "plan", planApprovedAt: null });
  expect(approvePlan(db, id, "2026-11-04T10:10:00Z", "2026-11-04T10:20:00Z")).toBe(true);
  expect(getTask(db, id)).toMatchObject({ stage: "doing", planApprovedAt: "2026-11-04T10:20:00Z" });

  // Revised mid-way: still doing, but waiting on you again, and approving the plan you read before doesn't count.
  expect(recordPlan(db, id, "1. Turn it on slowly", "2026-11-04T11:00:00Z")).toMatchObject({ stage: "doing", planApprovedAt: null });
  expect(approvePlan(db, id, "2026-11-04T10:10:00Z", "2026-11-04T11:05:00Z")).toBe(false);
  expect(getTask(db, id)?.planApprovedAt).toBeNull();
});

test("a PR joins the task its session was on when it opened it, and keeps it when the session moves on", () => {
  const db = openBoardStore(":memory:");
  const first = createTask(db, base).id;
  const second = createTask(db, { ...base, title: "Clean up the old cache" }).id;
  linkSession(db, first, "/sessions/a.jsonl", "2026-11-04T10:00:00Z");
  db.query("INSERT INTO pr_owners (repo, number, session_file, how, linked_at) VALUES ('acme/api', 1, '/sessions/a.jsonl', 'opened', '2026-11-04T10:30:00Z')").run();
  linkSession(db, second, "/sessions/a.jsonl", "2026-11-04T11:00:00Z");
  db.query("INSERT INTO pr_owners (repo, number, session_file, how, linked_at) VALUES ('acme/api', 2, '/sessions/a.jsonl', 'opened', '2026-11-04T11:30:00Z')").run();
  linkSessionPrs(db, "2026-11-04T12:00:00Z");

  const prs = taskPrs(db);
  expect(prs.get("acme/api#1")?.taskId).toBe(first);
  expect(prs.get("acme/api#2")?.taskId).toBe(second);
});
