import { asRecord, parseJsonEntry, scanLinesBackwards } from "./messages.ts";

/** One question of omp's `ask` tool, as the agent wrote it in the tool call. */
export type AskQuestion = {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
  multi: boolean;
  recommended?: number;
};

/** The phone's answer to one question: picked option indices and/or a typed answer. */
export type AskAnswer = { options: number[]; custom?: string };

/** One thing to do to the omp pane: press keys, paste text, or let the TUI catch up. */
export type AskStep = { keys: string[] } | { paste: string } | { waitMs: number };

/** omp opens and closes its "Custom answer" prompt asynchronously; keys sent meanwhile are dropped. */
const PROMPT_WAIT_MS = 300;

/** Reads the questions out of an `ask` tool call's arguments; null when they are malformed. */
export function parseAskQuestions(args: unknown): AskQuestion[] | null {
  const raw = asRecord(args)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (!record || typeof record.question !== "string" || !Array.isArray(record.options)) return null;
    const options: AskQuestion["options"] = [];
    for (const option of record.options) {
      const optionRecord = asRecord(option);
      if (!optionRecord || typeof optionRecord.label !== "string") return null;
      options.push({
        label: optionRecord.label,
        ...(typeof optionRecord.description === "string" ? { description: optionRecord.description } : {}),
      });
    }
    if (options.length === 0) return null;
    questions.push({
      id: typeof record.id === "string" ? record.id : String(questions.length),
      question: record.question,
      options,
      multi: record.multi === true,
      ...(typeof record.recommended === "number" ? { recommended: record.recommended } : {}),
    });
  }
  return questions;
}

/** Checks the phone's answers against the questions; returns an error message or null. */
export function validateAskAnswers(questions: AskQuestion[], answers: AskAnswer[]): string | null {
  if (answers.length !== questions.length) return "one answer per question is required";
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const answer = answers[index]!;
    const custom = answer.custom?.trim() ?? "";
    if (new Set(answer.options).size !== answer.options.length) return `question ${index + 1}: duplicate option`;
    for (const option of answer.options) {
      if (!Number.isInteger(option) || option < 0 || option >= question.options.length) {
        return `question ${index + 1}: unknown option ${option}`;
      }
    }
    if (question.multi) {
      if (answer.options.length === 0 && !custom) return `question ${index + 1}: pick at least one answer`;
    } else if (answer.options.length + (custom ? 1 : 0) !== 1) {
      return `question ${index + 1}: pick exactly one answer`;
    }
  }
  return null;
}

/** Repeats one key; tmux takes repeated key names as separate presses. */
function repeat(key: string, count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, () => key);
}

/**
 * Turns answers into the keystrokes omp's ask dialog expects. The dialog starts on the
 * first question with the cursor on the recommended row, clamps Up/Down at the ends,
 * and moves to the next question after each one is answered. So for each question:
 * Up past the top to reach row 0, walk Down to each pick (Space toggles a multi-select
 * row, Enter picks a single-select one), and for a typed answer press Enter on the
 * trailing "Other" row and paste into the prompt it opens. Enter on a multi-select
 * option row confirms that question without toggling.
 *
 * A lone single-select or multi-select question submits by itself; several questions,
 * or a lone multi-select one answered with typed text, land on the Review tab, where
 * Enter submits.
 */
export function askAnswerSteps(questions: AskQuestion[], answers: AskAnswer[]): AskStep[] {
  const steps: AskStep[] = [];
  let endsOnReviewTab = questions.length > 1;

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const answer = answers[index]!;
    const custom = answer.custom?.trim() ? answer.custom : undefined;
    const otherRow = question.options.length;
    const keys = repeat("Up", otherRow + 1);
    let cursor = 0;

    if (question.multi) {
      for (const option of [...answer.options].sort((a, b) => a - b)) {
        keys.push(...repeat("Down", option - cursor), "Space");
        cursor = option;
      }
    } else if (answer.options.length === 1) {
      const option = answer.options[0]!;
      keys.push(...repeat("Down", option - cursor));
      cursor = option;
    }

    if (custom === undefined) {
      steps.push({ keys: [...keys, "Enter"] });
      continue;
    }
    keys.push(...repeat("Down", otherRow - cursor), "Enter");
    steps.push({ keys }, { waitMs: PROMPT_WAIT_MS }, { paste: custom }, { keys: ["Enter"] }, { waitMs: PROMPT_WAIT_MS });
    if (question.multi && questions.length === 1) endsOnReviewTab = true;
  }

  if (endsOnReviewTab) steps.push({ keys: ["Enter"] });
  return steps;
}

export type PendingAsk = { toolCallId: string; questions: AskQuestion[] };

/**
 * Finds the `ask` call with this id in the session file, if it is still waiting for an
 * answer: omp writes the tool call when the agent sends it and the result only after
 * the user answers, so a call with no result yet is the open dialog.
 */
export async function findPendingAsk(filePath: string, toolCallId: string): Promise<PendingAsk | null> {
  const answered = new Set<string>();
  let found: PendingAsk | null = null;
  await scanLinesBackwards(filePath, (line) => {
    const entry = parseJsonEntry(line);
    const message = asRecord(entry?.message);
    if (!message) return true;
    if (message.role === "toolResult") {
      if (typeof message.toolCallId === "string") answered.add(message.toolCallId);
      return true;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return true;
    for (const part of message.content) {
      const block = asRecord(part);
      if (block?.type !== "toolCall" || block.id !== toolCallId) continue;
      const questions = block.name === "ask" ? parseAskQuestions(block.arguments) : null;
      if (questions && !answered.has(toolCallId)) found = { toolCallId, questions };
      return false;
    }
    return true;
  });
  return found;
}
