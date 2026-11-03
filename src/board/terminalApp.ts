import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listClientPids } from "../tmux.ts";

const run = promisify(execFile);

/** Guards against a broken process table looping forever. */
const MAX_ANCESTORS = 32;

/** "/Applications/Ghostty.app/Contents/MacOS/ghostty" → "/Applications/Ghostty.app"; null for anything that isn't an app's executable. */
export function appBundleOf(command: string): string | null {
  return /^(.+?\.app)\/Contents\/MacOS\//.exec(command)?.[1] ?? null;
}

/** Walks up from `pid` to the macOS app it runs under, e.g. the terminal a tmux client was started in. */
async function owningApp(pid: number): Promise<string | null> {
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const { stdout } = await run("ps", ["-o", "ppid=,args=", "-p", String(pid)]);
    const match = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    const app = appBundleOf(match[2]);
    if (app) return app;
    pid = Number(match[1]);
  }
  return null;
}

/**
 * Brings the terminal showing relay to the front, so a board button lands you in the session
 * instead of leaving you to switch apps. macOS only; does nothing when no terminal is attached.
 */
export async function bringRelayTerminalToFront(): Promise<void> {
  if (process.platform !== "darwin") return;
  for (const pid of await listClientPids()) {
    const app = await owningApp(pid).catch(() => null);
    if (!app) continue;
    await run("open", ["-a", app]);
    return;
  }
}
