import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { basename, dirname, join } from "node:path";
import { BOARD_APP_ASSET, BOARD_APP_PATH, GITHUB_REPO, UPDATE_CACHE_PATH } from "./paths.ts";
import { setGlobalOption } from "./tmux.ts";
import { VERSION } from "./version.ts";

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

/** Compares dotted numeric versions ("0.10.0" > "0.9.3"); a leading "v" is ignored. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string) => version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Latest release version, read from the redirect GitHub sends for /releases/latest.
 * Unlike the REST API this needs no token and has no low anonymous rate limit.
 */
export async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(`https://github.com/${GITHUB_REPO}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const tag = /\/releases\/tag\/v?([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
  if (!tag) throw new Error(`could not read the latest release of ${GITHUB_REPO} (HTTP ${response.status})`);
  return tag;
}

/** Latest version from a cache refreshed at most every few hours, so launches stay fast. */
async function cachedLatestVersion(): Promise<string> {
  try {
    const cached = JSON.parse(readFileSync(UPDATE_CACHE_PATH, "utf8")) as { checkedAt: number; version: string };
    if (Date.now() - cached.checkedAt < CHECK_TTL_MS) return cached.version;
  } catch {
    // No cache yet or unreadable: fetch below.
  }
  const version = await fetchLatestVersion();
  mkdirSync(dirname(UPDATE_CACHE_PATH), { recursive: true });
  writeFileSync(UPDATE_CACHE_PATH, JSON.stringify({ checkedAt: Date.now(), version }));
  return version;
}

/** Shows "relay x.y.z available" in relay's tab bar when a newer release exists. */
export async function refreshUpdateNotice(): Promise<void> {
  const latest = await cachedLatestVersion();
  const notice = isNewerVersion(latest, VERSION) ? `relay ${latest} available: run relay update` : null;
  await setGlobalOption("@relay_update", notice);
}

function releaseAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    throw new Error(`no relay release is built for ${platform}-${arch}`);
  }
  return `relay-${platform}-${arch}`;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed (HTTP ${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The SHA-256 `checksums.txt` lists for `asset`, if it lists it. */
export function expectedChecksum(checksums: string, asset: string): string | undefined {
  return checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
}

function verified(bytes: Buffer, asset: string, checksums: string): Buffer {
  const expected = expectedChecksum(checksums, asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${asset}; nothing was changed`);
  return bytes;
}

/** Unpacks the Relay Board app's release zip over the installed app, in ~/Applications. */
function installBoardApp(zip: Buffer): void {
  const applications = dirname(BOARD_APP_PATH);
  mkdirSync(applications, { recursive: true });
  const staging = mkdtempSync(join(applications, ".relay-board-"));
  try {
    const archive = join(staging, BOARD_APP_ASSET);
    writeFileSync(archive, zip);
    const unzip = spawnSync("ditto", ["-x", "-k", archive, staging], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error(`couldn't unpack ${BOARD_APP_ASSET}: ${unzip.stderr.trim()}`);
    rmSync(BOARD_APP_PATH, { recursive: true, force: true });
    renameSync(join(staging, basename(BOARD_APP_PATH)), BOARD_APP_PATH);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Replaces the running binary with the latest release after checking its SHA-256 against the
 * release's checksums.txt, and on a Mac the Relay Board app too, so the app and the server it
 * reads stay on one version. Returns what was installed, or null when already current.
 */
export async function installLatestRelease(): Promise<{ version: string; boardApp: boolean } | null> {
  const latest = await fetchLatestVersion();
  if (!isNewerVersion(latest, VERSION)) return null;

  const asset = releaseAssetName();
  const base = `https://github.com/${GITHUB_REPO}/releases/download/v${latest}`;
  const [binaryDownload, checksums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.txt`).then(String)]);
  const binary = verified(binaryDownload, asset, checksums);
  // The app needs macOS 26 (Darwin 25), and releases from before it have no zip.
  const macOS26 = process.platform === "darwin" && Number(release().split(".")[0]) >= 25;
  const withApp = macOS26 && expectedChecksum(checksums, BOARD_APP_ASSET) !== undefined;
  const app = withApp ? verified(await download(`${base}/${BOARD_APP_ASSET}`), BOARD_APP_ASSET, checksums) : null;

  // The app goes first: if it can't be installed, the binary stays as it was.
  if (app) installBoardApp(app);
  // Write next to the current binary and rename over it: atomic, and safe while running.
  const target = process.execPath;
  const staged = `${target}.new`;
  try {
    writeFileSync(staged, binary);
    chmodSync(staged, 0o755);
    renameSync(staged, target);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
  return { version: latest, boardApp: app !== null };
}
