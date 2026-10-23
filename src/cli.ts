#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { printPairing } from "./pair.ts";
import { runServer } from "./server/main.ts";
import { installService, isServiceInstalled, restartService, serviceStatus, uninstallService } from "./service.ts";
import {
  AGENT_COMMAND,
  SESSION_NAME,
  SOCKET_NAME,
  TMUX_ENV,
  reloadConfig,
  setGlobalOption,
  tmuxArgs,
  tmuxBinary,
  writeConfig,
} from "./tmux.ts";
import { installLatestRelease, refreshUpdateNotice } from "./update.ts";
import { VERSION } from "./version.ts";

const HELP = `relay ${VERSION}: an agent multiplexer for omp, with an iPhone companion app.

Usage:
  relay                    Open relay (creates the session on first run)
  relay pair [address]     Show a QR code that adds this computer to the Relay iPhone app
  relay server             Run the phone server in the foreground
  relay server install     Run the phone server in the background, starting at login
  relay server uninstall   Stop and remove the background phone server
  relay server status      Show whether the background phone server is running
  relay update             Install the latest release
  relay reload             Re-apply relay's tmux config to the running session
  relay version            Print the version

Inside relay: Ctrl+N new agent tab, Ctrl+K tab picker, Alt+Shift+[ / ] switch tabs,
Ctrl+B or Ctrl+A is the tmux prefix.`;

function hasCommand(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

/** tmux's $TMUX is "<socket path>,<pid>,<session>"; relay's socket path ends in its name. */
function insideRelay(): boolean {
  return (process.env.TMUX ?? "").split(",")[0].endsWith(`/${SOCKET_NAME}`);
}

async function openRelay(): Promise<number> {
  if (!hasCommand(tmuxBinary(), ["-V"])) {
    throw new Error("relay needs tmux. Install it first (macOS: brew install tmux; Debian/Ubuntu: sudo apt install tmux).");
  }
  if (!hasCommand("sh", ["-c", `command -v ${AGENT_COMMAND}`])) {
    throw new Error(`relay opens ${AGENT_COMMAND} in every tab, but ${AGENT_COMMAND} is not on your PATH.`);
  }
  if (insideRelay()) {
    console.log("You are already inside relay. Press Ctrl+N for a new agent tab.");
    return 0;
  }

  if (writeConfig()) await reloadConfig();

  // -A attaches to the relay session when it exists and creates it otherwise.
  const child = spawn(tmuxBinary(), tmuxArgs(["new-session", "-A", "-s", SESSION_NAME, AGENT_COMMAND]), {
    stdio: "inherit",
    env: TMUX_ENV,
  });
  // Once the session exists, show an "update available" hint in the tab bar if needed.
  setTimeout(() => void refreshUpdateNotice().catch(() => {}), 1000);
  const { promise, resolve } = Promise.withResolvers<number>();
  child.on("exit", (code) => resolve(code ?? 1));
  child.on("error", (error) => {
    console.error(`relay: could not start tmux: ${error.message}`);
    resolve(1);
  });
  return promise;
}

async function update(): Promise<void> {
  console.log(`relay ${VERSION}: checking for updates…`);
  const installed = await installLatestRelease();
  if (!installed) {
    console.log("Already up to date.");
    return;
  }
  console.log(`Installed relay ${installed}.`);
  // The new binary carries the new tmux config; let it apply that to the running session.
  spawnSync(process.execPath, ["reload"], { stdio: "inherit" });
  await setGlobalOption("@relay_update", null);
  if (isServiceInstalled()) {
    restartService();
    console.log("Restarted the phone server.");
  }
}

async function serverCommand(subcommand: string): Promise<void> {
  switch (subcommand) {
    case "install":
      installService();
      console.log(`Phone server installed and running (${serviceStatus()}).`);
      console.log("Next: run `relay pair` and scan the code with your iPhone.");
      return;
    case "uninstall":
      uninstallService();
      console.log("Phone server stopped and removed.");
      return;
    case "status":
      console.log(serviceStatus());
      return;
    default:
      throw new Error(`unknown server command: ${subcommand}\n\n${HELP}`);
  }
}

/** Returns the exit code, or null for `relay server`, which keeps running. */
async function main(args: string[]): Promise<number | null> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      return openRelay();
    case "pair":
      await printPairing(rest[0]);
      return 0;
    case "server":
      if (rest[0] === undefined) {
        runServer();
        return null;
      }
      await serverCommand(rest[0]);
      return 0;
    case "update":
      await update();
      return 0;
    case "reload":
      writeConfig();
      await reloadConfig();
      return 0;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
} catch (error) {
  console.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
