const MAX_SUMMARY_LENGTH = 160;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** First task's name, else its assignment, for parallel `task` calls. */
function firstTaskSummary(args: UnknownRecord): string | null {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  const first = asRecord(tasks[0]);
  if (!first) return textValue(args.task);
  return textValue(first.name) ?? textValue(first.task) ?? textValue(args.i);
}

function pickArgumentSummary(name: string, args: UnknownRecord): string | null {
  switch (name) {
    case "bash":
      return textValue(args.command);
    case "read":
    case "edit":
    case "write":
      return textValue(args.path);
    case "grep":
      return textValue(args.pattern);
    case "web_search":
      return textValue(args.query);
    case "task":
      return firstTaskSummary(args);
    default:
      return null;
  }
}

function compactJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** One-line, ≤160-char human summary of a tool call's arguments. */
export function summarizeToolCall(name: string, args: unknown): string {
  const record = asRecord(args);
  const picked = record ? pickArgumentSummary(name, record) : textValue(args);
  const summary = (picked ?? compactJson(args)).replace(/\s+/g, " ").trim();
  const characters = Array.from(summary);
  if (characters.length <= MAX_SUMMARY_LENGTH) return characters.join("");
  return `${characters.slice(0, MAX_SUMMARY_LENGTH - 1).join("")}…`;
}
