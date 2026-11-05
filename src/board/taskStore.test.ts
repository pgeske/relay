import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openBoardStore } from "./store.ts";
import {
  approvePlan,
  createTask,
  createTaskTables,
  finishTask,
  getTask,
  linkSession,
  linkSessionPrs,
  recordPlan,
  reportTask,
  sendBack,
  taskPrs,
  type NewTask,
} from "./taskStore.ts";

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

test("a finished task waits to be checked until it's sent back or the agent reports more work; done keeps its note", () => {
  const db = openBoardStore(":memory:");
  const { id } = createTask(db, { ...base, stage: "rollout" });
  reportTask(db, id, { blocked: { on: "me", reason: "Which datacenter first?" }, at: "2026-11-04T10:05:00Z" });
  expect(finishTask(db, id, { note: "Rolled out everywhere", status: "All green", at: "2026-11-04T11:00:00Z" })).toMatchObject({
    stage: "rollout",
    finishedAt: "2026-11-04T11:00:00Z",
    finishNote: "Rolled out everywhere",
    status: "All green",
    blockedOn: null,
  });

  sendBack(db, id, "2026-11-04T11:10:00Z");
  expect(getTask(db, id)).toMatchObject({ stage: "rollout", finishedAt: null });

  finishTask(db, id, { note: "Fixed the last datacenter", at: "2026-11-04T12:00:00Z" });
  expect(reportTask(db, id, { status: "One more thing", blocked: null, at: "2026-11-04T12:05:00Z" }).finishedAt).toBeNull();

  finishTask(db, id, { note: "Really done", at: "2026-11-04T13:00:00Z" });
  expect(reportTask(db, id, { stage: "done", blocked: null, at: "2026-11-04T13:10:00Z" })).toMatchObject({ stage: "done", finishedAt: null, finishNote: "Really done", doneAt: "2026-11-04T13:10:00Z" });
});

test("a board from before tasks were checked gains the columns, keeping its tasks", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT, project_id INTEGER, stage TEXT NOT NULL, status TEXT, status_at TEXT,
    blocked_on TEXT, blocked_reason TEXT, blocked_at TEXT, approve_plan INTEGER NOT NULL, plan TEXT, plan_at TEXT, plan_approved_at TEXT, cwd TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT
  )`);
  db.run("INSERT INTO tasks (title, stage, approve_plan, created_at, updated_at) VALUES ('Old task', 'doing', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
  createTaskTables(db);
  expect(finishTask(db, 1, { note: "Done at last", at: "2026-11-04T10:00:00Z" })).toMatchObject({ title: "Old task", finishedAt: "2026-11-04T10:00:00Z", finishNote: "Done at last" });
});
