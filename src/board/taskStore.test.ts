import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openBoardStore } from "./store.ts";
import {
  approvePlan,
  createProject,
  createTask,
  createTaskTables,
  deleteProject,
  ensureProject,
  finishTask,
  getTask,
  linkSession,
  linkSessionPrs,
  listProjects,
  pauseTask,
  projectPaths,
  recordPlan,
  renameProject,
  reportTask,
  resumeTask,
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
  const { id } = createTask(db, { ...base, stage: "doing" });
  reportTask(db, id, { blocked: { on: "me", reason: "Which datacenter first?" }, at: "2026-11-04T10:05:00Z" });
  expect(finishTask(db, id, { note: "Rolled out everywhere", status: "All green", at: "2026-11-04T11:00:00Z" })).toMatchObject({
    stage: "doing",
    finishedAt: "2026-11-04T11:00:00Z",
    finishNote: "Rolled out everywhere",
    status: "All green",
    blockedOn: null,
  });

  sendBack(db, id, "2026-11-04T11:10:00Z");
  expect(getTask(db, id)).toMatchObject({ stage: "doing", finishedAt: null });

  finishTask(db, id, { note: "Fixed the last datacenter", at: "2026-11-04T12:00:00Z" });
  expect(reportTask(db, id, { status: "One more thing", blocked: null, at: "2026-11-04T12:05:00Z" }).finishedAt).toBeNull();

  finishTask(db, id, { note: "Really done", at: "2026-11-04T13:00:00Z" });
  expect(reportTask(db, id, { stage: "done", blocked: null, at: "2026-11-04T13:10:00Z" })).toMatchObject({ stage: "done", finishedAt: null, finishNote: "Really done", doneAt: "2026-11-04T13:10:00Z" });
});

test("a pause holds through the agent's reports, and ends when you resume, it delivers, or it ships", () => {
  const db = openBoardStore(":memory:");
  const { id } = createTask(db, { ...base, stage: "doing" });
  pauseTask(db, id, "2026-11-04T10:05:00Z");
  expect(reportTask(db, id, { status: "Still waiting on CI", blocked: { on: "others", reason: "CI" }, at: "2026-11-04T10:10:00Z" }).pausedAt).toBe("2026-11-04T10:05:00Z");

  resumeTask(db, id, "2026-11-04T10:20:00Z");
  expect(getTask(db, id)?.pausedAt).toBeNull();

  pauseTask(db, id, "2026-11-04T10:30:00Z");
  expect(finishTask(db, id, { note: "Done after all", at: "2026-11-04T10:40:00Z" }).pausedAt).toBeNull();

  sendBack(db, id, "2026-11-04T10:45:00Z");
  pauseTask(db, id, "2026-11-04T10:50:00Z");
  expect(reportTask(db, id, { stage: "done", blocked: null, at: "2026-11-04T11:00:00Z" }).pausedAt).toBeNull();
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

test("projects nest by path, and a name only has to be unique among its siblings", () => {
  const db = openBoardStore(":memory:");
  const at = "2026-11-07T10:00:00Z";
  const sidebar = ensureProject(db, "Relay / Sidebar", at);
  const relay = ensureProject(db, "relay", at);
  expect(sidebar.parentId).toBe(relay.id);
  // The same name inside another project is a different project.
  const otherSidebar = ensureProject(db, "Docs/Sidebar", at);
  expect(otherSidebar.id).not.toBe(sidebar.id);
  expect(ensureProject(db, "Relay/sidebar", at).id).toBe(sidebar.id);
  expect(projectPaths(listProjects(db)).get(sidebar.id)).toBe("Relay/Sidebar");

  expect(() => createProject(db, "SIDEBAR", relay.id, at)).toThrow("already");
  expect(() => createProject(db, "A/B", null, at)).toThrow("can't have a /");
  expect(() => renameProject(db, otherSidebar.id, "  ")).toThrow("needs a name");
});

test("deleting a project moves its tasks and subprojects up, unless a subproject would clash", () => {
  const db = openBoardStore(":memory:");
  const at = "2026-11-07T10:00:00Z";
  const relay = ensureProject(db, "Relay", at);
  const board = ensureProject(db, "Relay/Board", at);
  const sidebar = ensureProject(db, "Relay/Board/Sidebar", at);
  const { id } = createTask(db, { ...base, projectId: board.id });

  deleteProject(db, board.id);
  expect(getTask(db, id)!.projectId).toBe(relay.id);
  expect(listProjects(db).find((project) => project.id === sidebar.id)!.parentId).toBe(relay.id);

  // Relay's Sidebar would land next to a top-level Sidebar.
  ensureProject(db, "Sidebar", at);
  expect(() => deleteProject(db, relay.id)).toThrow("rename one of them first");
  expect(listProjects(db).map((project) => project.name)).toContain("Relay");
});

test("a board from before projects nested keeps its projects, and their tasks", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL)");
  db.run("INSERT INTO projects (name, created_at) VALUES ('Relay', '2026-11-01T00:00:00Z')");
  createTaskTables(db);
  expect(listProjects(db)).toEqual([{ id: 1, name: "Relay", parentId: null, createdAt: "2026-11-01T00:00:00Z" }]);
  // The old table's name-wide uniqueness is gone: a Relay inside another project is fine now.
  expect(ensureProject(db, "Apps/Relay", "2026-11-07T10:00:00Z").id).not.toBe(1);
});
