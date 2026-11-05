import type { Database } from "bun:sqlite";

/**
 * Tasks: what you set out to get done, a level above pull requests. A task can take several
 * sessions and PRs, or none (a rollout, asking a team for something). Agents report where each
 * stands as they work; the board shows which ones need you. Projects group tasks.
 */

/** Where a task is on its way to done, in order. `idea` is one nobody has started on yet. */
export const TASK_STAGES = ["idea", "research", "plan", "doing", "rollout", "done"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/** Who a blocked task waits on: you (an answer, a decision), or anyone else (a team, a deploy, a reviewer). */
export const BLOCKERS = ["me", "others"] as const;
export type BlockedOn = (typeof BLOCKERS)[number];

export interface Project {
  id: number;
  name: string;
  createdAt: string;
}

export interface Task {
  id: number;
  title: string;
  /** What you asked for, as you wrote it; null when the title says it all. */
  details: string | null;
  projectId: number | null;
  stage: TaskStage;
  /** Its agent's latest one-line report of where it stands. */
  status: string | null;
  statusAt: string | null;
  blockedOn: BlockedOn | null;
  blockedReason: string | null;
  blockedAt: string | null;
  /** Its agent waits for you to approve its plan before carrying it out. */
  approvePlan: boolean;
  plan: string | null;
  planAt: string | null;
  /** Null while a plan waits for approval, and after a new plan replaced an approved one. */
  planApprovedAt: string | null;
  /** Where the board starts its sessions; null for a task an agent registered from its own session. */
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
  /** When its agent said it's finished; null until then, and once it moves on (you approve it, send it back, or it reports more work). */
  finishedAt: string | null;
  /** Why its agent says it's done: what it did and how it checked. Kept after you approve it. */
  finishNote: string | null;
  doneAt: string | null;
}

/** One step in a task's history, as its card's details list it. */
export type TaskEventKind =
  | "created"
  | "started"
  | "stage"
  | "status"
  | "blocked"
  | "unblocked"
  | "plan"
  | "plan-approved"
  | "finished"
  | "sent-back"
  | "done"
  | "reopened";

export interface TaskEvent {
  taskId: number;
  at: string;
  kind: TaskEventKind;
  /** The stage the task was in after it. */
  stage: TaskStage;
  text: string | null;
}

/** A session working on a task. A session can move on to another task; the one it linked to last is its current one. */
export interface TaskSession {
  taskId: number;
  sessionFile: string;
  linkedAt: string;
}

/** A PR that's part of a task: one its session opened, or one an agent linked by hand. */
export interface TaskPr {
  repo: string;
  number: number;
  taskId: number;
  how: "session" | "linked";
}

interface TaskRow {
  id: number;
  title: string;
  details: string | null;
  project_id: number | null;
  stage: TaskStage;
  status: string | null;
  status_at: string | null;
  blocked_on: BlockedOn | null;
  blocked_reason: string | null;
  blocked_at: string | null;
  approve_plan: number;
  plan: string | null;
  plan_at: string | null;
  plan_approved_at: string | null;
  cwd: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  finish_note: string | null;
  done_at: string | null;
}

const STAGE_CHECK = `CHECK (stage IN (${TASK_STAGES.map((stage) => `'${stage}'`).join(", ")}))`;

export function createTaskTables(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT,
    project_id INTEGER,
    stage TEXT NOT NULL ${STAGE_CHECK},
    status TEXT,
    status_at TEXT,
    blocked_on TEXT CHECK (blocked_on IN ('me', 'others')),
    blocked_reason TEXT,
    blocked_at TEXT,
    approve_plan INTEGER NOT NULL,
    plan TEXT,
    plan_at TEXT,
    plan_approved_at TEXT,
    cwd TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    finish_note TEXT,
    done_at TEXT
  )`);
  // Tasks went straight to done before you checked them.
  const taskColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')").all();
  if (!taskColumns.some((column) => column.name === "finished_at")) {
    db.run("ALTER TABLE tasks ADD COLUMN finished_at TEXT");
    db.run("ALTER TABLE tasks ADD COLUMN finish_note TEXT");
  }
  db.run(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    stage TEXT NOT NULL,
    text TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS task_sessions (
    task_id INTEGER NOT NULL,
    session_file TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (task_id, session_file)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS task_prs (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    how TEXT NOT NULL CHECK (how IN ('session', 'linked')),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`);
  // Open sessions you told the board aren't a task, so it stops offering to track them.
  db.run(`CREATE TABLE IF NOT EXISTS untracked_sessions (
    session_file TEXT PRIMARY KEY,
    dismissed_at TEXT NOT NULL
  )`);
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    projectId: row.project_id,
    stage: row.stage,
    status: row.status,
    statusAt: row.status_at,
    blockedOn: row.blocked_on,
    blockedReason: row.blocked_reason,
    blockedAt: row.blocked_at,
    approvePlan: row.approve_plan === 1,
    plan: row.plan,
    planAt: row.plan_at,
    planApprovedAt: row.plan_approved_at,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    finishNote: row.finish_note,
    doneAt: row.done_at,
  };
}

function addEvent(db: Database, taskId: number, at: string, kind: TaskEventKind, stage: TaskStage, text: string | null): void {
  db.query("INSERT INTO task_events (task_id, at, kind, stage, text) VALUES (?, ?, ?, ?, ?)").run(taskId, at, kind, stage, text);
}

export interface NewTask {
  title: string;
  details: string | null;
  projectId: number | null;
  stage: TaskStage;
  status: string | null;
  approvePlan: boolean;
  cwd: string | null;
  at: string;
}

export function createTask(db: Database, task: NewTask): Task {
  return db.transaction(() => {
    const row = db
      .query<TaskRow, Record<string, string | number | null>>(
        `INSERT INTO tasks (title, details, project_id, stage, status, status_at, approve_plan, cwd, created_at, updated_at, done_at)
         VALUES ($title, $details, $projectId, $stage, $status, $statusAt, $approvePlan, $cwd, $at, $at, $doneAt) RETURNING *`,
      )
      .get({
        $title: task.title,
        $details: task.details,
        $projectId: task.projectId,
        $stage: task.stage,
        $status: task.status,
        $statusAt: task.status ? task.at : null,
        $approvePlan: task.approvePlan ? 1 : 0,
        $cwd: task.cwd,
        $at: task.at,
        $doneAt: task.stage === "done" ? task.at : null,
      })!;
    addEvent(db, row.id, task.at, "created", task.stage, task.status);
    return toTask(row);
  })();
}

export function getTask(db: Database, id: number): Task | null {
  const row = db.query<TaskRow, [number]>("SELECT * FROM tasks WHERE id = ?").get(id);
  return row ? toTask(row) : null;
}

export function listTasks(db: Database): Task[] {
  return db.query<TaskRow, []>("SELECT * FROM tasks ORDER BY id").all().map(toTask);
}

/**
 * What an agent reports as it works. Every report says whether the task is blocked, so a report
 * that names no blocker clears one: a block nobody repeats doesn't linger after it's resolved.
 * A report also means the task moved on from finished: more work, or done for good.
 */
export interface TaskReport {
  stage?: TaskStage;
  status?: string;
  blocked: { on: BlockedOn; reason: string | null } | null;
  projectId?: number;
  at: string;
}

export function reportTask(db: Database, id: number, report: TaskReport): Task {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    const stage = report.stage ?? task.stage;
    const blocked = report.blocked;
    // A block that goes on keeps the time it started, so the card can say how long it's been waiting.
    const blockedAt = blocked ? (task.blockedOn === blocked.on ? task.blockedAt : report.at) : null;
    db.query(
      `UPDATE tasks SET stage = $stage, status = $status, status_at = $statusAt, blocked_on = $blockedOn, blocked_reason = $blockedReason,
         blocked_at = $blockedAt, project_id = $projectId, updated_at = $at, finished_at = NULL, done_at = $doneAt WHERE id = $id`,
    ).run({
      $id: id,
      $stage: stage,
      $status: report.status ?? task.status,
      $statusAt: report.status !== undefined ? report.at : task.statusAt,
      $blockedOn: blocked?.on ?? null,
      $blockedReason: blocked?.reason ?? null,
      $blockedAt: blockedAt,
      $projectId: report.projectId ?? task.projectId,
      $at: report.at,
      $doneAt: stage === "done" ? (task.doneAt ?? report.at) : null,
    });
    if (stage !== task.stage) addEvent(db, id, report.at, stage === "done" ? "done" : task.stage === "done" ? "reopened" : "stage", stage, null);
    if (report.status !== undefined) addEvent(db, id, report.at, "status", stage, report.status);
    if (blocked && (task.blockedOn !== blocked.on || task.blockedReason !== blocked.reason)) addEvent(db, id, report.at, "blocked", stage, blocked.reason);
    if (!blocked && task.blockedOn) addEvent(db, id, report.at, "unblocked", stage, null);
    return getTask(db, id)!;
  })();
}

/**
 * Notes that the agent says the task is finished, and why. It isn't done until you check it:
 * the board shows it to you to approve or send back.
 */
export function finishTask(db: Database, id: number, finish: { note: string | null; status?: string; at: string }): Task {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    db.query(
      `UPDATE tasks SET finished_at = $at, finish_note = $note, status = $status, status_at = $statusAt,
         blocked_on = NULL, blocked_reason = NULL, blocked_at = NULL, updated_at = $at WHERE id = $id`,
    ).run({
      $id: id,
      $at: finish.at,
      $note: finish.note,
      $status: finish.status ?? task.status,
      $statusAt: finish.status !== undefined ? finish.at : task.statusAt,
    });
    addEvent(db, id, finish.at, "finished", task.stage, finish.status ?? null);
    return getTask(db, id)!;
  })();
}

/** You checked a finished task and it isn't done yet: it goes back to its agent. */
export function sendBack(db: Database, id: number, at: string): void {
  db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    db.query("UPDATE tasks SET finished_at = NULL, updated_at = ? WHERE id = ?").run(at, id);
    addEvent(db, id, at, "sent-back", task.stage, null);
  })();
}

/** Records the agent's plan. A new plan needs approving afresh, even after an earlier one was approved. */
export function recordPlan(db: Database, id: number, plan: string, at: string): Task {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    // Planning is the plan stage, unless the task is already past it (a plan revised mid-way).
    const stage = TASK_STAGES.indexOf(task.stage) < TASK_STAGES.indexOf("plan") ? "plan" : task.stage;
    db.query("UPDATE tasks SET plan = ?, plan_at = ?, plan_approved_at = NULL, stage = ?, updated_at = ? WHERE id = ?").run(plan, at, stage, at, id);
    addEvent(db, id, at, "plan", stage, null);
    return getTask(db, id)!;
  })();
}

/**
 * Approves the task's plan, which moves it on to doing. `revision` is when the plan you read was
 * recorded: a plan revised since then isn't the one you approved, so it stays waiting (false).
 */
export function approvePlan(db: Database, id: number, revision: string, at: string): boolean {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task?.plan || task.planAt !== revision) return false;
    const stage = TASK_STAGES.indexOf(task.stage) < TASK_STAGES.indexOf("doing") ? "doing" : task.stage;
    db.query("UPDATE tasks SET plan_approved_at = ?, stage = ?, updated_at = ? WHERE id = ?").run(at, stage, at, id);
    addEvent(db, id, at, "plan-approved", stage, null);
    return true;
  })();
}

/** Notes that the board started a session on the task: an idea becomes research. */
export function markStarted(db: Database, id: number, at: string): void {
  db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    const stage = task.stage === "idea" ? "research" : task.stage;
    db.query("UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?").run(stage, at, id);
    addEvent(db, id, at, "started", stage, null);
  })();
}

export function deleteTask(db: Database, id: number): void {
  db.transaction(() => {
    for (const table of ["task_events", "task_sessions", "task_prs"]) db.query(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
  })();
}

/** Each task's history, newest first, keyed by task id. */
export function taskEvents(db: Database): Map<number, TaskEvent[]> {
  const rows = db
    .query<{ task_id: number; at: string; kind: TaskEventKind; stage: TaskStage; text: string | null }, []>("SELECT * FROM task_events ORDER BY at DESC, id DESC")
    .all();
  const events = new Map<number, TaskEvent[]>();
  for (const row of rows) {
    const list = events.get(row.task_id) ?? [];
    list.push({ taskId: row.task_id, at: row.at, kind: row.kind, stage: row.stage, text: row.text });
    events.set(row.task_id, list);
  }
  return events;
}

/** The project named `name`, creating it if there's none yet; names ignore case. */
export function ensureProject(db: Database, name: string, at: string): Project {
  db.query("INSERT OR IGNORE INTO projects (name, created_at) VALUES (?, ?)").run(name, at);
  const row = db.query<{ id: number; name: string; created_at: string }, [string]>("SELECT * FROM projects WHERE name = ?").get(name)!;
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export function listProjects(db: Database): Project[] {
  return db
    .query<{ id: number; name: string; created_at: string }, []>("SELECT * FROM projects ORDER BY name COLLATE NOCASE")
    .all()
    .map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

/** Puts a session on a task; linking it again makes the task its current one. */
export function linkSession(db: Database, taskId: number, sessionFile: string, at: string): void {
  db.query("INSERT OR REPLACE INTO task_sessions (task_id, session_file, linked_at) VALUES (?, ?, ?)").run(taskId, sessionFile, at);
  // A session on a task is tracked, whatever you said about it before.
  db.query("DELETE FROM untracked_sessions WHERE session_file = ?").run(sessionFile);
}

export function taskSessions(db: Database): TaskSession[] {
  return db
    .query<{ task_id: number; session_file: string; linked_at: string }, []>("SELECT * FROM task_sessions ORDER BY linked_at")
    .all()
    .map((row) => ({ taskId: row.task_id, sessionFile: row.session_file, linkedAt: row.linked_at }));
}

/** The task a session linked to last; null when it was never on one. */
export function currentTask(db: Database, sessionFile: string): number | null {
  const row = db.query<{ task_id: number }, [string]>("SELECT task_id FROM task_sessions WHERE session_file = ? ORDER BY linked_at DESC LIMIT 1").get(sessionFile);
  return row?.task_id ?? null;
}

/** Makes a PR part of a task, whichever task it was part of before. */
export function linkPr(db: Database, repo: string, number: number, taskId: number, at: string): void {
  db.query("INSERT OR REPLACE INTO task_prs (repo, number, task_id, how, linked_at) VALUES (?, ?, ?, 'linked', ?)").run(repo, number, taskId, at);
}

/**
 * Makes each PR a session opened (or claimed) part of the task that session was on when relay
 * linked the PR to it: the task it linked to last before then, else the one it linked to last.
 * relay links a PR at the first board refresh after it opens, so a session that switches tasks
 * within that minute can hand a PR to the newer task; `relay task update --pr` moves it back.
 * A PR keeps the task it first joined, so a session moving on leaves its earlier PRs be.
 */
export function linkSessionPrs(db: Database, at: string): void {
  db.query(
    `INSERT OR IGNORE INTO task_prs (repo, number, task_id, how, linked_at)
     SELECT o.repo, o.number,
       COALESCE(
         (SELECT s.task_id FROM task_sessions s WHERE s.session_file = o.session_file AND s.linked_at <= o.linked_at ORDER BY s.linked_at DESC LIMIT 1),
         (SELECT s.task_id FROM task_sessions s WHERE s.session_file = o.session_file ORDER BY s.linked_at DESC LIMIT 1)
       ),
       'session', ?
     FROM pr_owners o WHERE EXISTS (SELECT 1 FROM task_sessions s WHERE s.session_file = o.session_file)`,
  ).run(at);
}

/** Every PR that's part of a task, keyed by "owner/repo#number". */
export function taskPrs(db: Database): Map<string, TaskPr> {
  const rows = db.query<{ repo: string; number: number; task_id: number; how: TaskPr["how"] }, []>("SELECT * FROM task_prs").all();
  return new Map(rows.map((row) => [`${row.repo}#${row.number}`, { repo: row.repo, number: row.number, taskId: row.task_id, how: row.how }]));
}

/** Notes that an open session isn't a task, so the board stops offering to track it. */
export function dismissSession(db: Database, sessionFile: string, at: string): void {
  db.query("INSERT OR REPLACE INTO untracked_sessions (session_file, dismissed_at) VALUES (?, ?)").run(sessionFile, at);
}

export function dismissedSessions(db: Database): Set<string> {
  return new Set(db.query<{ session_file: string }, []>("SELECT session_file FROM untracked_sessions").all().map((row) => row.session_file));
}

/** "T-12", "t12", or "12" → 12. */
export function parseTaskRef(ref: string): number {
  const match = /^(?:t-?)?(\d+)$/i.exec(ref.trim());
  if (!match) throw new Error(`not a task: ${ref} (use its id, like T-12)`);
  return Number(match[1]);
}

export function taskRef(id: number): string {
  return `T-${id}`;
}
