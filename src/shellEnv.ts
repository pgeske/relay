import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";

/**
 * Agents should see the environment the user's terminal has: variables exported from
 * ~/.zshenv, ~/.zprofile, ~/.zshrc and friends. The phone server runs under launchd or
 * systemd, which read none of those, and a tmux server it starts hands its environment
 * to every tab. So, like VS Code does, relay asks the user's login shell once for its
 * environment: an interactive login shell reads the same files a terminal tab does.
 */
const MARKER = "__RELAY_SHELL_ENV__";
const TIMEOUT_MS = 10_000;
/** Set while the shell starts, so rc files can skip slow or interactive steps. */
const RESOLVING_VARIABLE = "RELAY_RESOLVING_ENVIRONMENT";
/** Per-process shell state, and TERM, which tmux sets for each pane itself. */
const DROPPED = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TERM", RESOLVING_VARIABLE]);

/** Parses `env -0` output that rc files may have surrounded with their own output. */
export function parseShellEnv(output: string): Record<string, string> | null {
  const start = output.indexOf(MARKER);
  const end = output.lastIndexOf(MARKER);
  if (start < 0 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(start + MARKER.length, end).split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!DROPPED.has(key)) env[key] = entry.slice(separator + 1);
  }
  return env;
}

function userShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  try {
    return userInfo().shell || "/bin/sh";
  } catch {
    return "/bin/sh";
  }
}

/** The user's login-shell environment, or null when the shell fails or takes over 10 seconds. */
export function loginShellEnv(): Promise<Record<string, string> | null> {
  const { promise, resolve } = Promise.withResolvers<Record<string, string> | null>();
  const script = `printf '%s' '${MARKER}'; command env -0; printf '%s' '${MARKER}'`;
  // Its own process group, so a timeout also stops whatever the rc files started.
  const child = spawn(userShell(), ["-l", "-i", "-c", script], {
    cwd: homedir(),
    detached: true,
    env: { ...process.env, [RESOLVING_VARIABLE]: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const timer = setTimeout(() => {
    resolve(null);
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, TIMEOUT_MS);
  child.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
  child.on("close", () => {
    clearTimeout(timer);
    resolve(parseShellEnv(Buffer.concat(chunks).toString("utf8")));
  });
  return promise;
}
