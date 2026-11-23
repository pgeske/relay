import type { Database } from "bun:sqlite";

/**
 * Tasks: what you set out to get done, a level above pull requests. A task can take several
 * sessions and PRs, or none (a deploy, asking a team for something). Agents report where each
 * stands as they work; the board shows which ones need you.
 */

/** Where a task is on its way to done, in order. `idea` is one nobody has started on yet. */
export const TASK_STAGES = ["idea", "research", "plan", "doing", "done"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/**
 * What a task waits on: you (an answer, a decision), anyone else (a team, a reviewer, an approval),
 * or `progress`: nobody, because something is already moving it along on its own (a rollout, CI,
 * the agent's own background job) and the agent picks it back up when that ends.
 */
export const BLOCKERS = ["me", "others", "progress"] as const;
export type BlockedOn = (typeof BLOCKERS)[number];
const BLOCKED_ON_CHECK = `CHECK (blocked_on IN (${BLOCKERS.map((on) => `'${on}'`).join(", ")}))`;

export interface Task {
  id: number;
  title: string;
  /** What you asked for, as you wrote it; null when the title says it all. Tasks made on the board are named from it. */
  details: string | null;
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
  /** The model and thinking level the board starts its sessions with (`--model`, `--thinking`); null for omp's default. */
  model: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
  /** When its agent said it's finished; null until then, and once it moves on (you approve it, send it back, or it reports more work). */
  finishedAt: string | null;
  /** Why its agent says it's done: what it did and how it checked. Kept after you approve it. */
  finishNote: string | null;
  doneAt: string | null;
  /**
   * When you set it aside on the board, which shows it in Blocked (not to be confused with `blockedOn`, what its
   * agent says it waits on); null while it's in play. It stays set aside until you unblock it, ship it, or its agent delivers.
   */
  pausedAt: string | null;
  /** When relay's watcher last reported for its agent, which forgot to; null once the agent reports itself. */
  autoReportedAt: string | null;
}

/**
 * Whether a task's card follows its session, so relay's watcher and the board's Refresh may update
 * it: one in play, not shipped, set aside, delivered, or waiting on your plan approval.
 */
export function followsSession(task: Task): boolean {
  const planAwaiting = task.approvePlan && task.plan !== null && task.planApprovedAt === null;
  return task.stage !== "done" && task.pausedAt === null && task.finishedAt === null && !planAwaiting;
}

/** One step in a task's history, as its card's details list it. */
export type TaskEventKind =
  | "created"
  | "started"
  | "stage"
  | "status"
  | "blocked"
  | "unblocked"
  | "in-progress"
  | "plan"
  | "plan-approved"
  | "finished"
  | "sent-back"
  | "paused"
  | "resumed"
  | "done"
  | "reopened";

export interface TaskEvent {
  taskId: number;
  at: string;
  kind: TaskEventKind;
  /** The stage the task was in after it. */
  stage: TaskStage;
  text: string | null;
  /** Relay's watcher reported it, not the agent. */
  auto: boolean;
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
  model: string | null;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  finish_note: string | null;
  done_at: string | null;
  paused_at: string | null;
  auto_reported_at: string | null;
}

const STAGE_CHECK = `CHECK (stage IN (${TASK_STAGES.map((stage) => `'${stage}'`).join(", ")}))`;

export function createTaskTables(db: Database): void {
  // Relay once grouped tasks in manual projects; workstreams replaced them.
  db.run("DROP TABLE IF EXISTS projects");
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    details TEXT,
    stage TEXT NOT NULL ${STAGE_CHECK},
    status TEXT,
    status_at TEXT,
    blocked_on TEXT ${BLOCKED_ON_CHECK},
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
    done_at TEXT,
    paused_at TEXT,
    model TEXT,
    thinking_level TEXT,
    auto_reported_at TEXT
  )`);
  // Tasks went straight to done before you checked them.
  const taskColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')").all();
  if (!taskColumns.some((column) => column.name === "finished_at")) {
    db.run("ALTER TABLE tasks ADD COLUMN finished_at TEXT");
    db.run("ALTER TABLE tasks ADD COLUMN finish_note TEXT");
  }
  // Tasks were only ever paused by having no session open.
  if (!taskColumns.some((column) => column.name === "paused_at")) db.run("ALTER TABLE tasks ADD COLUMN paused_at TEXT");
  // Every task's sessions once started with omp's default model.
  if (!taskColumns.some((column) => column.name === "model")) {
    db.run("ALTER TABLE tasks ADD COLUMN model TEXT");
    db.run("ALTER TABLE tasks ADD COLUMN thinking_level TEXT");
  }
  // Only agents reported on tasks before relay's watcher filled in for them.
  if (!taskColumns.some((column) => column.name === "auto_reported_at")) db.run("ALTER TABLE tasks ADD COLUMN auto_reported_at TEXT");
  // Relay 0.2.40 filed tasks into projects on its own; it now groups them into workstreams of its own instead.
  if (taskColumns.some((column) => column.name === "filed_at")) db.run("ALTER TABLE tasks DROP COLUMN filed_at");
  if (taskColumns.some((column) => column.name === "project_id")) db.run("ALTER TABLE tasks DROP COLUMN project_id");
  // Tasks could once only wait on you or others; SQLite can't change a CHECK in place, so rebuild the table.
  const tasksSql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()?.sql ?? "";
  const oldCheck = /CHECK \(blocked_on IN \([^)]*\)\)/.exec(tasksSql);
  if (oldCheck && oldCheck[0] !== BLOCKED_ON_CHECK) {
    db.transaction(() => {
      db.run(`CREATE TABLE tasks_rebuilt (${tasksSql.slice(tasksSql.indexOf("(") + 1, tasksSql.lastIndexOf(")")).replace(oldCheck[0], BLOCKED_ON_CHECK)})`);
      db.run("INSERT INTO tasks_rebuilt SELECT * FROM tasks");
      db.run("DROP TABLE tasks");
      db.run("ALTER TABLE tasks_rebuilt RENAME TO tasks");
    })();
  }
  db.run(`CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id INTEGER NOT NULL,
    prerequisite_id INTEGER NOT NULL CHECK (prerequisite_id != task_id),
    PRIMARY KEY (task_id, prerequisite_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    stage TEXT NOT NULL,
    text TEXT,
    auto INTEGER NOT NULL DEFAULT 0
  )`);
  const eventColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('task_events')").all();
  if (!eventColumns.some((column) => column.name === "auto")) db.run("ALTER TABLE task_events ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
  // Rolling out was once a stage of its own after Doing.
  db.run("UPDATE tasks SET stage = 'doing' WHERE stage = 'rollout'");
  db.run("UPDATE task_events SET stage = 'doing' WHERE stage = 'rollout'");
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
  // The workstream relay's model put each task in: a JSON list of names from the broadest effort
  // down, or null when it looked and found none.
  db.run(`CREATE TABLE IF NOT EXISTS task_workstreams (
    task_id INTEGER PRIMARY KEY,
    path TEXT,
    at TEXT NOT NULL
  )`);
  // Each top-level workstream's line on where it stands, keyed by its name.
  db.run(`CREATE TABLE IF NOT EXISTS workstream_summaries (
    name TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    at TEXT NOT NULL,
    basis TEXT NOT NULL
  )`);
  // Short versions of long status lines and reasons, keyed by the text they shorten.
  db.run(`CREATE TABLE IF NOT EXISTS text_briefs (
    text TEXT PRIMARY KEY,
    brief TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
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
    model: row.model,
    thinkingLevel: row.thinking_level,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    finishNote: row.finish_note,
    doneAt: row.done_at,
    pausedAt: row.paused_at,
    autoReportedAt: row.auto_reported_at,
  };
}

function addEvent(db: Database, taskId: number, at: string, kind: TaskEventKind, stage: TaskStage, text: string | null, auto = false): void {
  db.query("INSERT INTO task_events (task_id, at, kind, stage, text, auto) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, at, kind, stage, text, auto ? 1 : 0);
}

export interface NewTask {
  title: string;
  details: string | null;
  stage: TaskStage;
  status: string | null;
  approvePlan: boolean;
  cwd: string | null;
  /** Null for omp's default. */
  model?: string | null;
  thinkingLevel?: string | null;
  at: string;
}

export function createTask(db: Database, task: NewTask): Task {
  return db.transaction(() => {
    const row = db
      .query<TaskRow, Record<string, string | number | null>>(
        `INSERT INTO tasks (title, details, stage, status, status_at, approve_plan, cwd, model, thinking_level, created_at, updated_at, done_at)
         VALUES ($title, $details, $stage, $status, $statusAt, $approvePlan, $cwd, $model, $thinkingLevel, $at, $at, $doneAt) RETURNING *`,
      )
      .get({
        $title: task.title,
        $details: task.details,
        $stage: task.stage,
        $status: task.status,
        $statusAt: task.status ? task.at : null,
        $approvePlan: task.approvePlan ? 1 : 0,
        $cwd: task.cwd,
        $model: task.model ?? null,
        $thinkingLevel: task.thinkingLevel ?? null,
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
 * A report also means the task moved on from finished: more work, or done for good. Only shipping
 * or reopening it ends a pause; the agent reporting in doesn't take it off hold.
 * `auto` marks a report relay's watcher made for an agent that forgot; the agent's next own report
 * takes the mark off.
 */
export interface TaskReport {
  stage?: TaskStage;
  status?: string;
  blocked: { on: BlockedOn; reason: string | null } | null;
  auto?: boolean;
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
         blocked_at = $blockedAt, updated_at = $at, finished_at = NULL, done_at = $doneAt,
         paused_at = $pausedAt, auto_reported_at = $autoAt WHERE id = $id`,
    ).run({
      $id: id,
      $stage: stage,
      $status: report.status ?? task.status,
      $statusAt: report.status !== undefined ? report.at : task.statusAt,
      $blockedOn: blocked?.on ?? null,
      $blockedReason: blocked?.reason ?? null,
      $blockedAt: blockedAt,
      $at: report.at,
      $doneAt: stage === "done" ? (task.doneAt ?? report.at) : null,
      $pausedAt: stage === "done" || task.stage === "done" ? null : task.pausedAt,
      $autoAt: report.auto ? report.at : null,
    });
    const auto = report.auto === true;
    if (stage !== task.stage) addEvent(db, id, report.at, stage === "done" ? "done" : task.stage === "done" ? "reopened" : "stage", stage, null, auto);
    if (report.status !== undefined) addEvent(db, id, report.at, "status", stage, report.status, auto);
    if (blocked && (task.blockedOn !== blocked.on || task.blockedReason !== blocked.reason)) addEvent(db, id, report.at, blocked.on === "progress" ? "in-progress" : "blocked", stage, blocked.reason, auto);
    if (!blocked && task.blockedOn && task.blockedOn !== "progress") addEvent(db, id, report.at, "unblocked", stage, null, auto);
    return getTask(db, id)!;
  })();
}

/**
 * Notes that the agent says the task is finished, and why. It isn't done until you ship it:
 * the board shows it to you to ship or send back, so it comes off pause. `auto` as for reports.
 */
export function finishTask(db: Database, id: number, finish: { note: string | null; status?: string; auto?: boolean; at: string }): Task {
  return db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    db.query(
      `UPDATE tasks SET finished_at = $at, finish_note = $note, status = $status, status_at = $statusAt,
         blocked_on = NULL, blocked_reason = NULL, blocked_at = NULL, paused_at = NULL, updated_at = $at, auto_reported_at = $autoAt WHERE id = $id`,
    ).run({
      $id: id,
      $at: finish.at,
      $note: finish.note,
      $status: finish.status ?? task.status,
      $statusAt: finish.status !== undefined ? finish.at : task.statusAt,
      $autoAt: finish.auto ? finish.at : null,
    });
    addEvent(db, id, finish.at, "finished", task.stage, finish.status ?? null, finish.auto === true);
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

/** You set a task aside on the board: it sits in Blocked, whatever its sessions do, until you unblock it. */
export function pauseTask(db: Database, id: number, at: string): void {
  db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    if (task.pausedAt) return;
    db.query("UPDATE tasks SET paused_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
    addEvent(db, id, at, "paused", task.stage, null);
  })();
}

/** You unblocked a task you'd set aside: the board places it in its stage by what it needs again. */
export function resumeTask(db: Database, id: number, at: string): void {
  db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new Error(`no task T-${id}`);
    if (!task.pausedAt) return;
    db.query("UPDATE tasks SET paused_at = NULL, updated_at = ? WHERE id = ?").run(at, id);
    addEvent(db, id, at, "resumed", task.stage, null);
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

/**
 * Gives a task the title relay wrote for it, unless its title changed since relay began: the stand-in
 * title is only replaced, never a newer one. Says whether it was.
 */
export function retitleTask(db: Database, id: number, from: string, to: string): boolean {
  return db.query("UPDATE tasks SET title = ? WHERE id = ? AND title = ?").run(to, id, from).changes > 0;
}

export function deleteTask(db: Database, id: number): void {
  db.transaction(() => {
    for (const table of ["task_events", "task_sessions", "task_prs", "task_workstreams"]) db.query(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
    db.query("DELETE FROM task_dependencies WHERE task_id = ? OR prerequisite_id = ?").run(id, id);
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
  })();
}

export interface RelatedTask {
  id: number;
  ref: string;
  title: string;
  shipped: boolean;
}

export interface TaskRelations {
  dependsOn: RelatedTask[];
  neededBy: RelatedTask[];
}

/** Index both directions before old shipments are filtered off the board. */
export function taskRelations(db: Database, tasks: Task[]): Map<number, TaskRelations> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = new Map<number, TaskRelations>();
  function relations(id: number): TaskRelations {
    let links = result.get(id);
    if (!links) result.set(id, links = { dependsOn: [], neededBy: [] });
    return links;
  }
  function related(task: Task): RelatedTask {
    return { id: task.id, ref: taskRef(task.id), title: task.title, shipped: task.stage === "done" };
  }
  for (const edge of db.query<{ task_id: number; prerequisite_id: number }, []>("SELECT task_id, prerequisite_id FROM task_dependencies ORDER BY task_id, prerequisite_id").all()) {
    const task = byId.get(edge.task_id);
    const prerequisite = byId.get(edge.prerequisite_id);
    if (!task || !prerequisite) continue;
    relations(task.id).dependsOn.push(related(prerequisite));
    relations(prerequisite.id).neededBy.push(related(task));
  }
  return result;
}

/** The check and insert share a write lock: concurrent links cannot close a loop together. */
export function changeDependency(db: Database, task: number, prerequisite: number, change: "add" | "remove"): void {
  db.transaction(() => {
    for (const id of [task, prerequisite]) if (!getTask(db, id)) throw new Error(`no task ${taskRef(id)}`);
    if (change === "remove") {
      db.query("DELETE FROM task_dependencies WHERE task_id = ? AND prerequisite_id = ?").run(task, prerequisite);
      return;
    }
    if (task === prerequisite) throw new Error("a task cannot depend on itself");
    const cycle = db.query(`WITH RECURSIVE upstream(id) AS (
      SELECT prerequisite_id FROM task_dependencies WHERE task_id = ?
      UNION SELECT prerequisite_id FROM task_dependencies JOIN upstream ON task_id = upstream.id
    ) SELECT 1 FROM upstream WHERE id = ? LIMIT 1`).get(prerequisite, task);
    if (cycle) throw new Error(`cannot add dependency: ${taskRef(prerequisite)} already depends on ${taskRef(task)}`);
    db.query("INSERT OR IGNORE INTO task_dependencies (task_id, prerequisite_id) VALUES (?, ?)").run(task, prerequisite);
  }).immediate();
}

/**
 * The workstream relay's model put each task in, by task id: its names from the broadest effort down,
 * like ["Search", "Indexing"], or null when it found none. A task it hasn't looked at yet has no entry.
 */
export function taskWorkstreams(db: Database): Map<number, string[] | null> {
  const rows = db.query<{ task_id: number; path: string | null }, []>("SELECT task_id, path FROM task_workstreams").all();
  return new Map(rows.map((row) => [row.task_id, row.path === null ? null : (JSON.parse(row.path) as string[])]));
}

/** Records where relay's model put each task, replacing where it had them before. */
export function placeTasks(db: Database, placements: Map<number, string[] | null>, at: string): void {
  db.transaction(() => {
    const place = db.query("INSERT OR REPLACE INTO task_workstreams (task_id, path, at) VALUES (?, ?, ?)");
    for (const [id, path] of placements) place.run(id, path === null ? null : JSON.stringify(path), at);
  })();
}

/** A workstream's one-line summary of where it stands, and the inputs it was written from. */
export interface WorkstreamSummary {
  text: string;
  at: string;
  /** A fingerprint of what the summary read, so relay only writes a new one once that changes. */
  basis: string;
}

/** Each top-level workstream's summary, by its name. */
export function workstreamSummaries(db: Database): Map<string, WorkstreamSummary> {
  const rows = db.query<{ name: string; summary: string; at: string; basis: string }, []>("SELECT * FROM workstream_summaries").all();
  return new Map(rows.map((row) => [row.name, { text: row.summary, at: row.at, basis: row.basis }]));
}

/** Saves new summaries, and forgets those of workstreams no longer around (any name not in `current`). */
export function saveWorkstreamSummaries(db: Database, written: Map<string, WorkstreamSummary>, current: Set<string>): void {
  db.transaction(() => {
    for (const name of workstreamSummaries(db).keys()) if (!current.has(name)) db.query("DELETE FROM workstream_summaries WHERE name = ?").run(name);
    const save = db.query("INSERT OR REPLACE INTO workstream_summaries (name, summary, at, basis) VALUES (?, ?, ?, ?)");
    for (const [name, summary] of written) save.run(name, summary.text, summary.at, summary.basis);
  })();
}

/** Short versions of long status lines and reasons, keyed by the text each shortens. */
export function textBriefs(db: Database): Map<string, string> {
  return new Map(db.query<{ text: string; brief: string }, []>("SELECT text, brief FROM text_briefs").all().map((row) => [row.text, row.brief]));
}

/** Keeps briefs written since `keepSince`, replacing any for the same texts; older ones go, since their texts have long changed. */
export function saveTextBriefs(db: Database, briefs: Map<string, string>, at: string, keepSince: string): void {
  db.transaction(() => {
    db.query("DELETE FROM text_briefs WHERE at < ?").run(keepSince);
    const insert = db.query("INSERT OR REPLACE INTO text_briefs (text, brief, at) VALUES (?, ?, ?)");
    for (const [text, brief] of briefs) insert.run(text, brief, at);
  })();
}

/** Each task's history, newest first, keyed by task id. */
export function taskEvents(db: Database): Map<number, TaskEvent[]> {
  const rows = db
    .query<{ task_id: number; at: string; kind: TaskEventKind; stage: TaskStage; text: string | null; auto: number }, []>("SELECT * FROM task_events ORDER BY at DESC, id DESC")
    .all();
  const events = new Map<number, TaskEvent[]>();
  for (const row of rows) {
    const list = events.get(row.task_id) ?? [];
    list.push({ taskId: row.task_id, at: row.at, kind: row.kind, stage: row.stage, text: row.text, auto: row.auto === 1 });
    events.set(row.task_id, list);
  }
  return events;
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
