import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The phone server runs as a per-user background service: launchd on macOS, a systemd
 * user unit on Linux. Both start it at login and restart it if it crashes.
 */
const LAUNCHD_LABEL = "io.github.pgeske.relay";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const LAUNCHD_DOMAIN = `gui/${process.getuid?.() ?? 0}`;
export const LAUNCHD_LOG = join(homedir(), "Library", "Logs", "relay.log");
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "relay.service");

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function runOrThrow(command: string, args: string[]): void {
  const result = run(command, args);
  if (!result.ok) throw new Error(`${command} ${args.join(" ")} failed: ${result.output}`);
}

/**
 * The service starts without a login shell, so it gets the PATH relay was installed from
 * (where omp and tmux were found) plus the system dirs lsof lives in.
 */
function servicePath(): string {
  const entries = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) if (!entries.includes(dir)) entries.push(dir);
  return entries.join(":");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchdPlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${escapeXml(binary)}</string>
		<string>server</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${escapeXml(servicePath())}</string>
		<key>HOME</key>
		<string>${escapeXml(homedir())}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${escapeXml(LAUNCHD_LOG)}</string>
	<key>StandardErrorPath</key>
	<string>${escapeXml(LAUNCHD_LOG)}</string>
</dict>
</plist>
`;
}

function systemdUnit(binary: string): string {
  return `[Unit]
Description=relay phone server

[Service]
ExecStart="${binary}" server
Environment="PATH=${servicePath()}"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function isServiceInstalled(): boolean {
  return existsSync(process.platform === "darwin" ? LAUNCHD_PLIST : SYSTEMD_UNIT);
}

/** Installs (or rewrites) the service for the running relay binary and (re)starts it. */
export function installService(): void {
  const binary = process.execPath;
  if (process.platform === "darwin") {
    mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true });
    mkdirSync(dirname(LAUNCHD_LOG), { recursive: true });
    writeFileSync(LAUNCHD_PLIST, launchdPlist(binary));
    run("launchctl", ["bootout", `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`]);
    runOrThrow("launchctl", ["bootstrap", LAUNCHD_DOMAIN, LAUNCHD_PLIST]);
    return;
  }
  mkdirSync(dirname(SYSTEMD_UNIT), { recursive: true });
  writeFileSync(SYSTEMD_UNIT, systemdUnit(binary));
  runOrThrow("systemctl", ["--user", "daemon-reload"]);
  runOrThrow("systemctl", ["--user", "enable", "--now", "relay.service"]);
  runOrThrow("systemctl", ["--user", "restart", "relay.service"]);
}

export function uninstallService(): void {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`]);
    rmSync(LAUNCHD_PLIST, { force: true });
    return;
  }
  run("systemctl", ["--user", "disable", "--now", "relay.service"]);
  rmSync(SYSTEMD_UNIT, { force: true });
  run("systemctl", ["--user", "daemon-reload"]);
}

/** Restarts an installed service so it runs the binary that is on disk now. */
export function restartService(): void {
  if (process.platform === "darwin") runOrThrow("launchctl", ["kickstart", "-k", `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`]);
  else runOrThrow("systemctl", ["--user", "restart", "relay.service"]);
}

export function serviceStatus(): string {
  if (!isServiceInstalled()) return "not installed (run: relay server install)";
  const result =
    process.platform === "darwin"
      ? run("launchctl", ["print", `${LAUNCHD_DOMAIN}/${LAUNCHD_LABEL}`])
      : run("systemctl", ["--user", "is-active", "relay.service"]);
  if (process.platform !== "darwin") return result.output || "unknown";
  const state = /^\s*state = (.+)$/m.exec(result.output)?.[1];
  return state ? `${state} (logs: ${LAUNCHD_LOG})` : "installed but not loaded";
}
