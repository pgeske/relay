import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { askModel } from "./askModel.ts";
import { jsonObject } from "./autoStatus.ts";
import { loadBoardConfig } from "./config.ts";
import { openBoardStore } from "./store.ts";
import {
  ensureProject,
  fileTask,
  listProjects,
  listTasks,
  projectPaths,
  projectSummaries,
  saveTextBriefs,
  setProjectSummary,
  taskRef,
  textBriefs,
  unfiledTasks,
  type Project,
  type Task,
} from "./taskStore.ts";

/**
 * Workstreams: the few broad things you're working on, so the board can say what you're doing without
 * you rereading every card. Relay's small model (the watcher's) keeps three things current in the
 * background:
 * - it files each task into a project: one you have, or a new one when none fits;
 * - it writes each top-level project a one-line summary of where it stands;
 * - it shortens long status lines and reasons, so a one-line row can show them.
 * This file decides what to ask and what an answer changes; `startWorkstreams` decides when.
 */

/** Something that answers a prompt: relay's model, or a stand-in in tests. */
export type Ask = (prompt: string) => Promise<string>;

const SYSTEM_PROMPT = "You help keep a person's task board easy to read. Answer only from what you're given, never use tools, and reply with only the JSON asked for.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Shipped tasks this recent still get filed, so a workstream counts what it shipped lately. */
const FILE_SHIPPED_WITHIN_MS = 14 * DAY_MS;
/** Tasks filed in one go: enough for the first pass over an existing board to keep related tasks together. */
const FILE_BATCH = 40;
const PROJECT_NAME_CHARS = 40;
/** How many of a project's tasks the filing prompt names, to say what the project is about. */
const PROJECT_EXAMPLES = 4;

/** Status lines and reasons longer than this get a brief. */
export const BRIEF_OVER_CHARS = 50;
const BRIEF_CHARS = 60;
const BRIEF_BATCH = 20;
const BRIEF_KEPT_MS = 14 * DAY_MS;

const SUMMARY_CHARS = 110;
/** A project's summary is rewritten at most this often, however often its tasks report. */
const SUMMARY_MIN_MS = 3 * 60 * 1000;
/** Tasks shipped this recently count toward where a workstream stands. */
const SUMMARY_SHIPPED_WITHIN_MS = 7 * DAY_MS;

const CYCLE_MS = 20_000;
/** After a step fails (the model timed out, say), it waits this long before trying again. */
const RETRY_MS = 5 * 60 * 1000;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Each project's top-level project, keyed by id. */
function topLevels(projects: Project[]): Map<number, Project> {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const top = new Map<number, Project>();
  for (const project of projects) {
    let root = project;
    while (root.parentId !== null && byId.has(root.parentId)) root = byId.get(root.parentId)!;
    top.set(project.id, root);
  }
  return top;
}

// Filing

export function filingPrompt(tasks: Task[], projects: { path: string; examples: string[] }[]): string {
  const existing = projects.length
    ? projects.map((project) => `- ${project.path}${project.examples.length ? `: ${project.examples.map((title) => `"${title}"`).join(", ")}` : ""}`).join("\n")
    : "(none yet)";
  const toFile = tasks
    .map((task) => {
      const details = task.details && task.details.trim() !== task.title ? `\n  Asked for: ${oneLine(task.details, 400)}` : "";
      return `${taskRef(task.id)}: ${task.title}${details}`;
    })
    .join("\n");
  return `Someone runs many tasks at once, each with an AI agent. Group their tasks into workstreams: the few broad things they're working on, like "Search rollout", "Billing migration", or "Task board app".

Their workstreams now, each with some of its tasks:
${existing}

Tasks to file:
${toFile}

For each task, name the workstream it belongs in.
- Use an existing one whenever the task is part of it, by its exact name as listed (a "Parent/Child" name files it in that subproject).
- Otherwise name a new one: 1 to 3 plain words for the broader effort, not the task itself, so later tasks can join it. Tasks in this list that belong together share one new name.
- One-off reviews, approvals, and helping someone with a question go together in one workstream for reviews and requests, not one each.

Reply with only a JSON object mapping each task id to its workstream, like {"T-12": "Search rollout"}.`;
}

/** Reads the model's filing: each task in `tasks` it named a workstream for. */
export function parseFiling(reply: string, tasks: Task[]): Map<number, string> {
  const answer = jsonObject(reply);
  const filing = new Map<number, string>();
  if (!answer) return filing;
  for (const task of tasks) {
    const name = answer[taskRef(task.id)];
    if (typeof name !== "string") continue;
    const path = name
      .split("/")
      .map((part) => oneLine(part, PROJECT_NAME_CHARS))
      .filter(Boolean)
      .join("/");
    if (path) filing.set(task.id, path);
  }
  return filing;
}

/** Files the tasks the model named a workstream for, making new projects as needed; says what it filed. */
export function applyFiling(db: Database, filing: Map<number, string>, at: string): string[] {
  const filed: string[] = [];
  for (const [id, path] of filing) {
    const project = ensureProject(db, path, at);
    if (fileTask(db, id, project.id, at)) filed.push(`${taskRef(id)} → ${path}`);
  }
  return filed;
}

export async function fileTasks(db: Database, ask: Ask, now: Date): Promise<void> {
  const tasks = unfiledTasks(db, new Date(now.getTime() - FILE_SHIPPED_WITHIN_MS).toISOString(), FILE_BATCH);
  if (tasks.length === 0) return;
  const projects = listProjects(db);
  const paths = projectPaths(projects);
  const titles = new Map<number, string[]>();
  for (const task of listTasks(db).toReversed()) {
    if (task.projectId === null) continue;
    const list = titles.get(task.projectId) ?? [];
    if (list.length < PROJECT_EXAMPLES) list.push(task.title);
    titles.set(task.projectId, list);
  }
  const listed = projects.map((project) => ({ path: paths.get(project.id)!, examples: titles.get(project.id) ?? [] }));
  const filing = parseFiling(await ask(filingPrompt(tasks, listed)), tasks);
  const at = now.toISOString();
  const filed = applyFiling(db, filing, at);
  // A task the model skipped would come up every cycle; leave it out of every project instead. You can still move it.
  for (const task of tasks) if (!filing.has(task.id)) fileTask(db, task.id, null, at);
  if (filed.length) console.log(`workstreams: filed ${filed.join(", ")}`);
}

// Briefs

/** Open tasks' status lines and reasons too long for a row that have no brief yet. */
export function textsToBrief(tasks: Task[], briefs: Map<string, string>): string[] {
  const texts = new Set<string>();
  for (const task of tasks.filter((task) => task.stage !== "done")) {
    for (const text of [task.status, task.blockedReason]) {
      if (text && text.length > BRIEF_OVER_CHARS && !briefs.has(text)) texts.add(text);
    }
  }
  return [...texts].slice(0, BRIEF_BATCH);
}

export function briefPrompt(texts: string[]): string {
  const numbered = texts.map((text, index) => `${index + 1}. ${text}`).join("\n");
  return `These are status lines from cards on someone's task board. Each is too long to read at a glance. Shorten each one.

${numbered}

- At most 6 plain words and under 45 characters, like "Waiting on Sam's review" or "CI running on the fix".
- Keep what someone needs: who or what it waits on, a PR number, a person's name. Drop how it got there, versions, and detail.
- Sentence case, no trailing period.

Reply with only a JSON object mapping each number to its short line, like {"1": "Waiting on Sam's review"}.`;
}

export function parseBriefs(reply: string, texts: string[]): Map<string, string> {
  const answer = jsonObject(reply);
  const briefs = new Map<string, string>();
  if (!answer) return briefs;
  texts.forEach((text, index) => {
    const brief = answer[String(index + 1)];
    if (typeof brief === "string" && brief.trim()) briefs.set(text, oneLine(brief, BRIEF_CHARS).replace(/\.$/, ""));
  });
  return briefs;
}

export async function briefTexts(db: Database, ask: Ask, now: Date): Promise<void> {
  const texts = textsToBrief(listTasks(db), textBriefs(db));
  if (texts.length === 0) return;
  const briefs = parseBriefs(await ask(briefPrompt(texts)), texts);
  saveTextBriefs(db, briefs, now.toISOString(), new Date(now.getTime() - BRIEF_KEPT_MS).toISOString());
}

// Summaries

/** A task as a summary reads it: its title and where it stands, in plain words. */
function describeTask(task: Task): string {
  const parts: string[] = [task.stage];
  if (task.status) parts.push(task.status);
  if (task.finishedAt) parts.push("finished, waiting for the user to check and ship it");
  else if (task.pausedAt) parts.push("set aside by the user");
  else if (task.approvePlan && task.plan && !task.planApprovedAt) parts.push("plan waiting for the user's approval");
  else if (task.blockedOn === "me") parts.push(`waiting on the user: ${task.blockedReason ?? "no reason given"}`);
  else if (task.blockedOn === "others") parts.push(`waiting on others: ${task.blockedReason ?? "no reason given"}`);
  else if (task.blockedOn === "progress") parts.push(`moving on its own: ${task.blockedReason ?? "no reason given"}`);
  return `- ${task.title} (${parts.join("; ")})`;
}

export interface SummaryInput {
  project: Project;
  /** What the summary reads: the project's open tasks, then what it shipped lately. */
  lines: string[];
  basis: string;
}

/** Each top-level project with open work, and what its summary would read. */
export function summaryInputs(tasks: Task[], projects: Project[], now: Date): SummaryInput[] {
  const top = topLevels(projects);
  const shippedSince = new Date(now.getTime() - SUMMARY_SHIPPED_WITHIN_MS).toISOString();
  const byRoot = new Map<number, { open: Task[]; shipped: Task[] }>();
  for (const task of tasks) {
    const root = task.projectId !== null ? top.get(task.projectId) : undefined;
    if (!root) continue;
    const group = byRoot.get(root.id) ?? { open: [], shipped: [] };
    if (task.stage !== "done") group.open.push(task);
    else if ((task.doneAt ?? task.updatedAt) >= shippedSince) group.shipped.push(task);
    byRoot.set(root.id, group);
  }
  const inputs: SummaryInput[] = [];
  for (const project of projects) {
    const group = byRoot.get(project.id);
    if (!group || group.open.length === 0) continue;
    const lines = group.open.map(describeTask);
    if (group.shipped.length) lines.push(`Shipped lately: ${group.shipped.map((task) => task.title).join("; ")}`);
    inputs.push({ project, lines, basis: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16) });
  }
  return inputs;
}

export function summaryPrompt(inputs: SummaryInput[]): string {
  const blocks = inputs.map((input) => `p${input.project.id}: ${input.project.name}\n${input.lines.join("\n")}`).join("\n\n");
  return `Someone runs many tasks at once, each with an AI agent, grouped into workstreams. For each workstream below, write one line saying where it stands overall, so they can tell at a glance without reading its tasks.

${blocks}

- One plain sentence fragment under 90 characters, like "Cache live in staging; prod waits on the storage team's approval".
- Say what's moving and what it's waiting on. Name who or what it waits on when that matters. Lead with anything waiting on the user.
- No task ids, no stage names, no trailing period.

Reply with only a JSON object mapping each workstream's id to its line, like {"p3": "..."}.`;
}

export function parseSummaries(reply: string, inputs: SummaryInput[]): Map<number, string> {
  const answer = jsonObject(reply);
  const summaries = new Map<number, string>();
  if (!answer) return summaries;
  for (const input of inputs) {
    const line = answer[`p${input.project.id}`];
    if (typeof line === "string" && line.trim()) summaries.set(input.project.id, oneLine(line, SUMMARY_CHARS).replace(/\.$/, ""));
  }
  return summaries;
}

/** The projects whose summary is out of date: what it read changed, and it wasn't written moments ago. */
export function summariesDue(inputs: SummaryInput[], written: Map<number, { basis: string; at: string }>, now: Date): SummaryInput[] {
  return inputs.filter((input) => {
    const summary = written.get(input.project.id);
    if (!summary) return true;
    return summary.basis !== input.basis && now.getTime() - new Date(summary.at).getTime() >= SUMMARY_MIN_MS;
  });
}

export async function summarizeProjects(db: Database, ask: Ask, now: Date): Promise<void> {
  const due = summariesDue(summaryInputs(listTasks(db), listProjects(db), now), projectSummaries(db), now);
  if (due.length === 0) return;
  const summaries = parseSummaries(await ask(summaryPrompt(due)), due);
  const at = now.toISOString();
  for (const input of due) {
    const text = summaries.get(input.project.id);
    if (text) setProjectSummary(db, input.project.id, { text, at, basis: input.basis });
  }
}

const STEPS = [
  { name: "filing tasks", run: fileTasks },
  { name: "shortening status lines", run: briefTexts },
  { name: "summarizing projects", run: summarizeProjects },
] as const;

/** Keeps workstreams current while relay's server runs, one step at a time, when relay's model is on. */
export function startWorkstreams(): void {
  const retryAt = new Map<string, number>();
  let busy = false;
  const cycle = async () => {
    const { autoStatus } = loadBoardConfig();
    if (!autoStatus.enabled) return;
    const ask: Ask = (prompt) => askModel(prompt, autoStatus.model, SYSTEM_PROMPT);
    const db = openBoardStore();
    try {
      for (const step of STEPS) {
        if (Date.now() < (retryAt.get(step.name) ?? 0)) continue;
        try {
          await step.run(db, ask, new Date());
        } catch (error) {
          console.error(`workstreams: ${step.name} failed; trying again in ${RETRY_MS / 60_000}m`, error);
          retryAt.set(step.name, Date.now() + RETRY_MS);
        }
      }
    } finally {
      db.close();
    }
  };
  setInterval(() => {
    if (busy) return;
    busy = true;
    void cycle()
      .catch((error: unknown) => console.error("workstreams: cycle failed", error))
      .finally(() => (busy = false));
  }, CYCLE_MS).unref();
}
