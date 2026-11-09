import { askModel } from "./askModel.ts";
import { loadBoardConfig } from "./config.ts";
import { openBoardStore } from "./store.ts";
import { retitleTask, taskRef } from "./taskStore.ts";

/**
 * Tasks made on the board are named for you: you write what you want done, and relay asks its small,
 * fast model (the watcher's) for a short title. The card shows a stand-in, the start of what you
 * wrote, until the model's title comes back a few seconds later.
 */

const TITLE_CHARS = 60;
/** The model reads this much of what you wrote; a title doesn't need the rest. */
const REQUEST_CHARS = 4000;
const SYSTEM_PROMPT = "You name tasks on a task board. Answer only from what you're given, never use tools, and reply with only the title.";

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The card's title until the model names it: the first line of what you wrote. */
export function provisionalTitle(request: string): string {
  const firstLine = request.split("\n").find((line) => line.trim()) ?? "";
  return oneLine(firstLine, TITLE_CHARS);
}

export function titlePrompt(request: string): string {
  return (
    "Someone wrote this request for an AI coding agent. Write the title of its card on their task board.\n\n" +
    "- 2 to 6 plain words saying what they want done, like a short to-do item: \"Retry failed uploads\", \"Fix login timeout in staging\".\n" +
    "- Sentence case, no quotes, no trailing period. Keep names that matter (a service, a person, a repo); drop filler like \"please\" or \"can you\".\n" +
    "- The request may be dictated, with transcription mistakes: title what they meant.\n\n" +
    `The request:\n<request>\n${request.slice(0, REQUEST_CHARS)}\n</request>\n\nReply with only the title.`
  );
}

/** Reads the model's title; null when its reply isn't one. */
export function parseTitle(reply: string): string | null {
  const line = reply.split("\n").find((candidate) => candidate.trim());
  if (!line) return null;
  const title = line
    .trim()
    .replace(/^title:\s*/i, "")
    .replace(/^["'`*]+|["'`*]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  return title ? oneLine(title, TITLE_CHARS) : null;
}

/**
 * Names a task made on the board from what you wrote, replacing its stand-in title. Failures only
 * leave the stand-in, so they're logged rather than raised.
 */
export async function nameTask(taskId: number, request: string, provisional: string): Promise<void> {
  try {
    const title = parseTitle(await askModel(titlePrompt(request), loadBoardConfig().autoStatus.model, SYSTEM_PROMPT));
    if (!title) {
      console.error(`titles: no usable title for ${taskRef(taskId)}`);
      return;
    }
    const db = openBoardStore();
    try {
      if (retitleTask(db, taskId, provisional, title)) console.log(`titles: named ${taskRef(taskId)} "${title}"`);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`titles: naming ${taskRef(taskId)} failed`, error);
  }
}
