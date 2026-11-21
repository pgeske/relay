import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { askModel } from "./askModel.ts";
import { jsonObject } from "./autoStatus.ts";
import { loadBoardConfig } from "./config.ts";
import { openBoardStore } from "./store.ts";
import {
  listProjects,
  listTasks,
  placeTasks,
  projectPaths,
  saveTextBriefs,
  saveWorkstreamSummaries,
  taskRef,
  taskRelations,
  taskWorkstreams,
  textBriefs,
  workstreamSummaries,
  type Task,
  type TaskRelations,
} from "./taskStore.ts";

/**
 * Workstreams: the broad efforts you're working on, found for you, so the board can say what you're
 * doing without you filing anything. Relay keeps three things current in the background, asking omp's
 * models (see `GROUPING_MODEL` for which):
 * - it groups your tasks into workstreams, and a workstream with distinct parts into those parts
 *   ("Search rollout" › "Indexing"), keeping its grouping steady as new tasks come in;
 * - it writes each workstream a one-line summary of where it stands;
 * - it shortens long status lines and reasons, so a one-line row can show them.
 * Projects stay yours: the model reads them as a hint, and never makes or fills one.
 * This file decides what to ask and what an answer changes; `startWorkstreams` decides when.
 */

/** Something that answers a prompt: relay's model, or a stand-in in tests. */
export type Ask = (prompt: string) => Promise<string>;

const SYSTEM_PROMPT = "You help keep a person's task board easy to read. Answer only from what you're given, never use tools, and reply with only the JSON asked for.";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tasks shipped this recently are grouped too: a workstream counts what it shipped, and the model sees what each one is about. */
const GROUP_SHIPPED_WITHIN_MS = 14 * DAY_MS;
/** At most this many shipped tasks, the latest, so the prompt stays small. */
const GROUP_SHIPPED_MAX = 40;
/** A workstream and a part of it: enough to see how tasks connect, few enough to read at a glance. */
const GROUP_DEPTH = 2;
const NAME_CHARS = 40;

/** Status lines and reasons longer than this get a brief. */
export const BRIEF_OVER_CHARS = 50;
const BRIEF_CHARS = 60;
const BRIEF_BATCH = 20;
const BRIEF_KEPT_MS = 14 * DAY_MS;

const SUMMARY_CHARS = 110;
/** A workstream's summary is rewritten at most this often, however often its tasks report. */
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

// Grouping

/** The tasks workstreams are made of: every open one, and the latest shipped, by id. */
export function groupedTasks(tasks: Task[], now: Date): Task[] {
  const since = new Date(now.getTime() - GROUP_SHIPPED_WITHIN_MS).toISOString();
  const shippedAt = (task: Task) => task.doneAt ?? task.updatedAt;
  const shipped = tasks
    .filter((task) => task.stage === "done" && shippedAt(task) >= since)
    .toSorted((a, b) => shippedAt(b).localeCompare(shippedAt(a)))
    .slice(0, GROUP_SHIPPED_MAX);
  return [...tasks.filter((task) => task.stage !== "done"), ...shipped].toSorted((a, b) => a.id - b.id);
}

export interface GroupingInput {
  /** Every task to place: those placed before, and new ones. */
  tasks: Task[];
  placements: Map<number, string[] | null>;
  relations: Map<number, TaskRelations>;
  /** Each project's path, by id: the user's own filing, which the model takes as a hint. */
  projects: Map<number, string>;
}

export function groupingPrompt({ tasks, placements, relations, projects }: GroupingInput): string {
  const named = (task: Task) => `${taskRef(task.id)}: ${task.title}${task.stage === "done" ? " (shipped)" : ""}`;
  const outline = new Map<string, { tasks: Task[]; parts: Map<string, Task[]> }>();
  const loose: Task[] = [];
  const fresh: Task[] = [];
  for (const task of tasks) {
    const path = placements.get(task.id);
    if (path === undefined) fresh.push(task);
    else if (path === null) loose.push(task);
    else {
      const workstream = outline.get(path[0]) ?? { tasks: [], parts: new Map<string, Task[]>() };
      outline.set(path[0], workstream);
      if (path.length === 1) workstream.tasks.push(task);
      else workstream.parts.set(path[1], [...(workstream.parts.get(path[1]) ?? []), task]);
    }
  }
  const current: string[] = [];
  for (const [name, workstream] of outline) {
    current.push(name, ...workstream.tasks.map((task) => `  - ${named(task)}`));
    for (const [part, partTasks] of workstream.parts) current.push(`  ${part}`, ...partTasks.map((task) => `    - ${named(task)}`));
  }
  if (loose.length) current.push("(in no workstream)", ...loose.map((task) => `  - ${named(task)}`));

  const toPlace = fresh.map((task) => {
    const lines = [`- ${named(task)}`];
    if (task.details && task.details.trim() !== task.title) lines.push(`  Asked for: ${oneLine(task.details, 300)}`);
    const project = task.projectId !== null ? projects.get(task.projectId) : undefined;
    if (project) lines.push(`  In their project: ${project}`);
    const links = relations.get(task.id);
    const linked = [...(links?.dependsOn ?? []), ...(links?.neededBy ?? [])].map((other) => other.ref);
    if (linked.length) lines.push(`  Depends on or blocks: ${linked.join(", ")}`);
    return lines.join("\n");
  });

  return `Someone runs many tasks at once, each with an AI agent. Group their tasks into workstreams, the broad efforts they're working on, so one look tells them what they're doing and how their tasks connect.

Their workstreams now:
${current.length ? current.join("\n") : "(none yet)"}

New tasks:
${toPlace.join("\n")}

Place every task above, old and new: give each its workstream as a list of names, from the broadest effort down.
- ["Search rollout"] puts a task in a workstream; ["Search rollout", "Indexing"] puts it in a part of one. Two levels at most.
- Keep the workstreams above, their exact names, and the tasks in them. Change them only when the new tasks make a better shape clear, like two workstreams that turn out to be parts of one broader effort.
- A workstream is a broad effort later tasks can join, named in 1 to 4 plain words like "Search rollout" or "Task board app", never a single task. Tasks toward the same goal share one, even when nothing links them.
- Split a workstream into parts only when its tasks fall into distinct pieces of work, each with a few tasks. Name a part for what it's for, like "Mobile support", not for a kind of work, like "Investigations".
- Reviewing or approving someone else's work, and helping someone with a question, go together in one workstream for reviews and requests. Never put the person's own projects there.

Reply with only a JSON object mapping each task id to its list, like {"T-12": ["Search rollout"], "T-14": ["Search rollout", "Indexing"]}.`;
}

/** A name as the model may echo it back: any case, any spacing. */
const nameKey = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Reads the model's grouping: the workstream it gave each of `tasks`. A name that matches one in use
 * but for case or spacing keeps the name in use, so a workstream doesn't split in two.
 */
export function parseGrouping(reply: string, tasks: Task[], placements: Map<number, string[] | null>): Map<number, string[]> {
  const answer = jsonObject(reply);
  const grouping = new Map<number, string[]>();
  if (!answer) return grouping;
  // Names in use by their key; a part's key includes its workstream's.
  const known = new Map<string, string>();
  const partKey = (top: string, part: string) => `${nameKey(top)} › ${nameKey(part)}`;
  for (const path of placements.values()) {
    if (!path) continue;
    known.set(nameKey(path[0]), path[0]);
    if (path[1]) known.set(partKey(path[0], path[1]), path[1]);
  }
  for (const task of tasks) {
    const value = answer[taskRef(task.id)];
    const names = (Array.isArray(value) ? value : [value])
      .filter((name): name is string => typeof name === "string")
      .map((name) => oneLine(name, NAME_CHARS))
      .filter(Boolean)
      .slice(0, GROUP_DEPTH);
    if (names.length === 0) continue;
    const top = known.get(nameKey(names[0])) ?? names[0];
    grouping.set(task.id, names.length === 1 ? [top] : [top, known.get(partKey(top, names[1])) ?? names[1]]);
  }
  return grouping;
}

/**
 * Places new tasks in workstreams. The model sees the grouping so far and may reshape it as it places
 * them, so this only runs when a task is new: the grouping holds still while you work.
 */
export async function groupTasks(db: Database, ask: Ask, now: Date): Promise<void> {
  const all = listTasks(db);
  const tasks = groupedTasks(all, now);
  const placements = taskWorkstreams(db);
  if (tasks.every((task) => placements.has(task.id))) return;
  const input = { tasks, placements, relations: taskRelations(db, all), projects: projectPaths(listProjects(db)) };
  const grouping: Map<number, string[] | null> = parseGrouping(await ask(groupingPrompt(input)), tasks, placements);
  // A new task the model skipped would come up every cycle; it waits in no workstream for the next new task instead.
  for (const task of tasks) if (!placements.has(task.id) && !grouping.has(task.id)) grouping.set(task.id, null);
  const changed = new Map([...grouping].filter(([id, path]) => JSON.stringify(placements.get(id)) !== JSON.stringify(path)));
  placeTasks(db, changed, now.toISOString());
  console.log(`workstreams: placed ${[...changed].map(([id, path]) => `${taskRef(id)} → ${path ? path.join(" › ") : "none"}`).join(", ")}`);
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

/** A task as a summary reads it: its title, the part it's in, and where it stands, in plain words. */
function describeTask(task: Task, part: string | undefined): string {
  const parts: string[] = [task.stage];
  if (task.status) parts.push(task.status);
  if (task.finishedAt) parts.push("finished, waiting for the user to check and ship it");
  else if (task.pausedAt) parts.push("set aside by the user");
  else if (task.approvePlan && task.plan && !task.planApprovedAt) parts.push("plan waiting for the user's approval");
  else if (task.blockedOn === "me") parts.push(`waiting on the user: ${task.blockedReason ?? "no reason given"}`);
  else if (task.blockedOn === "others") parts.push(`waiting on others: ${task.blockedReason ?? "no reason given"}`);
  else if (task.blockedOn === "progress") parts.push(`moving on its own: ${task.blockedReason ?? "no reason given"}`);
  return `- ${part ? `[${part}] ` : ""}${task.title} (${parts.join("; ")})`;
}

export interface SummaryInput {
  name: string;
  /** What the summary reads: the workstream's open tasks, its parts' included, then what it shipped lately. */
  lines: string[];
  basis: string;
}

/** Each workstream with open work, and what its summary would read. */
export function summaryInputs(tasks: Task[], placements: Map<number, string[] | null>, now: Date): SummaryInput[] {
  const shippedSince = new Date(now.getTime() - SUMMARY_SHIPPED_WITHIN_MS).toISOString();
  const byName = new Map<string, { open: string[]; shipped: string[] }>();
  for (const task of tasks) {
    const path = placements.get(task.id);
    if (!path) continue;
    const group = byName.get(path[0]) ?? { open: [], shipped: [] };
    byName.set(path[0], group);
    if (task.stage !== "done") group.open.push(describeTask(task, path[1]));
    else if ((task.doneAt ?? task.updatedAt) >= shippedSince) group.shipped.push(task.title);
  }
  return [...byName]
    .filter(([, group]) => group.open.length > 0)
    .map(([name, group]) => {
      const lines = group.shipped.length ? [...group.open, `Shipped lately: ${group.shipped.join("; ")}`] : group.open;
      return { name, lines, basis: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16) };
    });
}

export function summaryPrompt(inputs: SummaryInput[]): string {
  const blocks = inputs.map((input, index) => `w${index + 1}: ${input.name}\n${input.lines.join("\n")}`).join("\n\n");
  return `Someone runs many tasks at once, each with an AI agent, grouped into workstreams. For each workstream below, write one line saying where it stands overall, so they can tell at a glance without reading its tasks.

${blocks}

- One plain sentence fragment under 90 characters, like "Cache live in staging; prod waits on the storage team's approval".
- Say what's moving and what it's waiting on. Name who or what it waits on when that matters. Lead with anything waiting on the user.
- No task ids, no stage names, no trailing period.

Reply with only a JSON object mapping each workstream's id to its line, like {"w1": "..."}.`;
}

/** Reads the model's summaries, by workstream name. */
export function parseSummaries(reply: string, inputs: SummaryInput[]): Map<string, string> {
  const answer = jsonObject(reply);
  const summaries = new Map<string, string>();
  if (!answer) return summaries;
  inputs.forEach((input, index) => {
    const line = answer[`w${index + 1}`];
    if (typeof line === "string" && line.trim()) summaries.set(input.name, oneLine(line, SUMMARY_CHARS).replace(/\.$/, ""));
  });
  return summaries;
}

/** The workstreams whose summary is out of date: what it read changed, and it wasn't written moments ago. */
export function summariesDue(inputs: SummaryInput[], written: Map<string, { basis: string; at: string }>, now: Date): SummaryInput[] {
  return inputs.filter((input) => {
    const summary = written.get(input.name);
    if (!summary) return true;
    return summary.basis !== input.basis && now.getTime() - new Date(summary.at).getTime() >= SUMMARY_MIN_MS;
  });
}

export async function summarizeWorkstreams(db: Database, ask: Ask, now: Date): Promise<void> {
  const inputs = summaryInputs(listTasks(db), taskWorkstreams(db), now);
  const written = workstreamSummaries(db);
  const current = new Set(inputs.map((input) => input.name));
  const due = summariesDue(inputs, written, now);
  if (due.length === 0 && [...written.keys()].every((name) => current.has(name))) return;
  const summaries = due.length ? parseSummaries(await ask(summaryPrompt(due)), due) : new Map<string, string>();
  const at = now.toISOString();
  const basis = new Map(due.map((input) => [input.name, input.basis]));
  saveWorkstreamSummaries(db, new Map([...summaries].map(([name, text]) => [name, { text, at, basis: basis.get(name)! }])), current);
}

/**
 * Grouping shapes the whole Overview but only runs when a task is new, so it asks omp's main model,
 * whose groupings are steadier, for a few calls a day. The other steps run often, on relay's fast model.
 */
const GROUPING_MODEL = "@default";

const STEPS = [
  { name: "grouping tasks", run: groupTasks, model: "main" },
  { name: "shortening status lines", run: briefTexts, model: "fast" },
  { name: "summarizing workstreams", run: summarizeWorkstreams, model: "fast" },
] as const;

/** Keeps workstreams current while relay's server runs, one step at a time, when relay's model is on. */
export function startWorkstreams(): void {
  const retryAt = new Map<string, number>();
  let busy = false;
  const cycle = async () => {
    const { autoStatus } = loadBoardConfig();
    if (!autoStatus.enabled) return;
    const asks: Record<"main" | "fast", Ask> = {
      main: (prompt) => askModel(prompt, GROUPING_MODEL, SYSTEM_PROMPT),
      fast: (prompt) => askModel(prompt, autoStatus.model, SYSTEM_PROMPT),
    };
    const db = openBoardStore();
    try {
      for (const step of STEPS) {
        if (Date.now() < (retryAt.get(step.name) ?? 0)) continue;
        try {
          await step.run(db, asks[step.model], new Date());
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
