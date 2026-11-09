import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_DIR } from "../paths.ts";
import { OMP_BINARY, splitRoleSelector } from "../server/modelState.ts";
import { agentEnv } from "../tmux.ts";

const MODEL_TIMEOUT_MS = 90_000;

/** The omp settings relay's own model calls run with on top of the user's: no memory to read or fill with these calls. */
const OMP_OVERLAY_PATH = join(CACHE_DIR, "watcher-omp.yml");
const OMP_OVERLAY = "memory:\n  backend: off\nautolearn:\n  enabled: false\n";
let overlayWritten = false;

/**
 * Asks the user's omp for a one-off answer, on relay's model (by default the fast `@smol` role; see
 * `autoStatus.model` in the board config), with nothing of a coding session loaded: no tools to speak
 * of (a restricted tool list also skips MCP servers), skills, rules, context files, or memory. It runs
 * with the environment agents get. Low thinking unless the model names a level: it reads which
 * question is the latest one more reliably than none, at no cost in time.
 */
export async function askModel(prompt: string, model: string, systemPrompt: string): Promise<string> {
  if (!overlayWritten) {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(OMP_OVERLAY_PATH, OMP_OVERLAY);
    overlayWritten = true;
  }
  const role = splitRoleSelector(model);
  const args = ["-p", "--no-session", "--tools", "read", "--no-skills", "--no-rules", "--no-context-files", "--no-extensions", "--no-title", "--no-lsp"];
  args.push("--config", OMP_OVERLAY_PATH, "--model", role.model ?? model, "--thinking", role.thinkingLevel ?? "low", "--system-prompt", systemPrompt, prompt);
  const env = await agentEnv();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = execFile(OMP_BINARY, args, { cwd: tmpdir(), env, encoding: "utf8", timeout: MODEL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  // Print mode reads piped stdin into the prompt, so an open pipe would keep it waiting.
  child.stdin?.end();
  return promise;
}
