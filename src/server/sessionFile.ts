import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const OMP_AGENT_DIR = join(homedir(), ".omp", "agent");
export const SESSIONS_DIR = join(OMP_AGENT_DIR, "sessions");
export const BLOBS_DIR = join(OMP_AGENT_DIR, "blobs");
const TERMINAL_SESSIONS_DIR = join(OMP_AGENT_DIR, "terminal-sessions");

function listOpenJsonlFiles(panePid: string): Promise<string[]> {
  const { promise, resolve } = Promise.withResolvers<string[]>();
  // Plain "lsof" from PATH: it lives in /usr/sbin on macOS and /usr/bin on Linux.
  execFile("lsof", ["-p", panePid, "-Fn"], { encoding: "utf8" }, (error, stdout) => {
    if (error) {
      resolve([]);
      return;
    }
    resolve(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("n"))
        .map((line) => line.slice(1))
        .filter((path) => path.endsWith(".jsonl") && path.startsWith(`${SESSIONS_DIR}/`)),
    );
  });
  return promise;
}

/**
 * Session files sit at sessions/<project>/<file>.jsonl; subagent logs nest inside a directory
 * named after the session, so they are only used when nothing else is open.
 */
function topLevelSessionFiles(paths: string[]): string[] {
  return paths.filter((path) => path.slice(SESSIONS_DIR.length + 1).split("/").length === 2);
}

export type ResolveOptions = {
  /** Reject a pointer written before this time (a freshly created window reuses a tty). */
  pointerWrittenAfter?: number;
};

/**
 * Resolves the pane's omp session file. omp writes `<tty basename>` with the cwd on line 1
 * and the active `.jsonl` path on line 2, rewriting it on `/new`, so this runs every poll.
 * A pane that is not running omp has no session: the tty pointer file may belong to an
 * earlier omp run on the same tty.
 */
export async function resolveSessionFile(pane: { paneTty: string; panePid: string; command: string }, options: ResolveOptions = {}): Promise<string | null> {
  if (pane.command !== "omp") return null;

  const pointerPath = join(TERMINAL_SESSIONS_DIR, basename(pane.paneTty));
  try {
    if (options.pointerWrittenAfter !== undefined) {
      const pointerStat = await stat(pointerPath);
      if (pointerStat.mtimeMs < options.pointerWrittenAfter) return null;
    }
    const pointer = await readFile(pointerPath, "utf8");
    const candidate = pointer.split("\n")[1]?.trim();
    // A brand-new omp writes the pointer before it creates the jsonl (first prompt), so the
    // path is trusted even while the file does not exist yet.
    if (candidate && candidate.endsWith(".jsonl")) return candidate;
  } catch {
    // Pointer file missing (omp still starting): fall back to the process's open files.
  }

  const openFiles = await listOpenJsonlFiles(pane.panePid);
  return topLevelSessionFiles(openFiles)[0] ?? openFiles[0] ?? null;
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
