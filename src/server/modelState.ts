import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OMP_AGENT_DIR, fileSize } from "./sessionFile.ts";

/** A chat model the phone can switch to, as listed by `omp models --json`. */
export type ModelOption = {
  /** `provider/id`, the form `/switch` accepts. */
  selector: string;
  name: string;
  provider: string;
  /** Levels `/effort` accepts for this model; empty when the model cannot think. */
  thinkingLevels: string[];
};

export type ModelState = { model: string | null; thinkingLevel: string | null };

export const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
};

const MODELS_CACHE_MS = 5 * 60_000;
const CONFIG_PATH = join(OMP_AGENT_DIR, "config.yml");
/** launchd's PATH does not include ~/.local/bin, where the omp installer puts the binary. */
const OMP_BINARY = [join(homedir(), ".local", "bin", "omp"), "/opt/homebrew/bin/omp", "/usr/local/bin/omp"].find((path) =>
  existsSync(path),
) ?? "omp";
/** Dated snapshots (`claude-opus-4-20250514`) duplicate their alias and only clutter the picker. */
const DATED_SNAPSHOT = /-\d{8}$/;

let modelsCache: { at: number; models: ModelOption[] } | null = null;

function runOmpModels(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(OMP_BINARY, ["models", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  return promise;
}

export async function listModels(): Promise<ModelOption[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.models;

  const parsed = JSON.parse(await runOmpModels()) as { models?: Record<string, unknown>[] };
  const models: ModelOption[] = [];
  for (const row of parsed.models ?? []) {
    if (row.kind !== undefined && row.kind !== "chat") continue;
    const selector = typeof row.selector === "string" ? row.selector : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (!selector || DATED_SNAPSHOT.test(id)) continue;
    const levels = Array.isArray(row.thinking) ? row.thinking.filter((level): level is string => typeof level === "string") : [];
    models.push({
      selector,
      name: typeof row.name === "string" && row.name ? row.name : id,
      provider: typeof row.provider === "string" ? row.provider : selector.split("/")[0] ?? "",
      thinkingLevels: row.reasoning === true && levels.length > 0 ? ["off", ...levels, "auto"] : [],
    });
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

/** Splits `provider/id:level`, the role syntax config.yml uses, into its two halves. */
function splitRoleSelector(raw: string): ModelState {
  const colon = raw.lastIndexOf(":");
  const suffix = colon === -1 ? "" : raw.slice(colon + 1);
  if (THINKING_LEVELS[suffix] === true) return { model: raw.slice(0, colon), thinkingLevel: suffix };
  return { model: raw, thinkingLevel: null };
}

/**
 * What a brand-new omp starts with: `modelRoles.default` (whose `:level` suffix wins) and then
 * `defaultThinkingLevel`. Only those two top-level keys are read, so a tiny line scan suffices.
 */
async function configuredDefaults(): Promise<ModelState> {
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, "utf8");
  } catch {
    return { model: null, thinkingLevel: null };
  }
  const defaultRole = /^modelRoles:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:[ \t]*["']?([^"'\s#]+)/m.exec(text)?.[1];
  const defaultLevel = /^defaultThinkingLevel:[ \t]*["']?([a-z]+)/m.exec(text)?.[1] ?? null;
  const role = defaultRole ? splitRoleSelector(defaultRole) : { model: null, thinkingLevel: null };
  return { model: role.model, thinkingLevel: role.thinkingLevel ?? defaultLevel };
}

/** Per-file scan result; session files are append-only, so only new bytes are read on each poll. */
type ScanCache = { offset: number; partial: string; state: ModelState };
const scanCache = new Map<string, ScanCache>();

function applyLine(line: string, state: ModelState): void {
  // Cheap substring checks first: most lines are large message entries we do not need to parse.
  if (line.includes('"type":"model_change"')) {
    const entry = JSON.parse(line) as { model?: unknown };
    if (typeof entry.model === "string") state.model = entry.model;
  } else if (line.includes('"type":"thinking_level_change"')) {
    const entry = JSON.parse(line) as { thinkingLevel?: unknown };
    if (typeof entry.thinkingLevel === "string") state.thinkingLevel = entry.thinkingLevel;
  } else if (line.includes('"role":"assistant"') && line.startsWith('{"type":"message"')) {
    // A retry fallback changes the model without a model_change entry; the reply records it.
    const entry = JSON.parse(line) as { message?: { provider?: unknown; model?: unknown } };
    const { provider, model } = entry.message ?? {};
    if (typeof provider === "string" && typeof model === "string") state.model = `${provider}/${model}`;
  }
}

async function scanSessionFile(path: string): Promise<ModelState> {
  const size = await fileSize(path);
  let cached = scanCache.get(path);
  if (!cached || size < cached.offset) {
    cached = { offset: 0, partial: "", state: { model: null, thinkingLevel: null } };
    scanCache.set(path, cached);
  }
  if (size === cached.offset) return cached.state;

  const file = await open(path, "r");
  const buffer = Buffer.allocUnsafe(size - cached.offset);
  try {
    await file.read(buffer, 0, buffer.length, cached.offset);
  } finally {
    await file.close();
  }
  cached.offset = size;

  const lines = (cached.partial + buffer.toString("utf8")).split("\n");
  cached.partial = lines.pop() ?? "";
  for (const line of lines) {
    try {
      applyLine(line, cached.state);
    } catch {
      // A malformed line never changes the model; skip it.
    }
  }
  return cached.state;
}

/**
 * Choices made from the phone before omp has written the session file (it only creates it on
 * the first prompt), keyed by that future file path so `/new` naturally starts clean.
 */
const pendingChoices = new Map<string, Partial<ModelState>>();

export function rememberChoice(sessionFile: string | null, choice: Partial<ModelState>): void {
  if (!sessionFile) return;
  pendingChoices.set(sessionFile, { ...pendingChoices.get(sessionFile), ...choice });
}

export async function readModelState(sessionFile: string | null): Promise<ModelState> {
  const fromFile = sessionFile ? await scanSessionFile(sessionFile) : { model: null, thinkingLevel: null };
  const pending = sessionFile ? pendingChoices.get(sessionFile) : undefined;
  const defaults = fromFile.model && fromFile.thinkingLevel ? null : await configuredDefaults();
  return {
    model: fromFile.model ?? pending?.model ?? defaults?.model ?? null,
    thinkingLevel: fromFile.thinkingLevel ?? pending?.thinkingLevel ?? defaults?.thinkingLevel ?? null,
  };
}
