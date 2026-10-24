import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WebSocket } from "ws";
import { LIVE_AUDIO_BACKUP_PATH } from "../paths.ts";
import { capturePane, sendKeys, type Pane } from "../tmux.ts";

/**
 * Phone live voice reuses omp's own `/live` mode. That mode always records from the
 * Mac's default microphone and plays through its default speakers, so for the length
 * of a call relay points those defaults at two BlackHole loopback devices and carries
 * the audio to and from the phone over a WebSocket:
 *
 *   phone mic → ffmpeg → BlackHole 16ch → (default input)  → omp
 *   omp → (default output) BlackHole 2ch → sox → phone speaker
 *
 * Two separate devices keep omp from hearing its own voice. When the call ends, relay
 * stops omp's live mode and puts the previous devices back. sox does the capture
 * because ffmpeg's AVFoundation input drops most of the samples, and the 2-channel
 * device is the capture side because sox overruns on 16 channels.
 */
const PHONE_MIC_DEVICE = "BlackHole 16ch";
const PHONE_SPEAKER_DEVICE = "BlackHole 2ch";

/** Both directions carry 16-bit little-endian mono PCM at this rate. */
const SAMPLE_RATE = 24_000;

const PHASE_POLL_MS = 400;
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 3_000;
/** BlackHole streams silence nonstop, so a capture that stays empty this long is blocked. */
const CAPTURE_TIMEOUT_MS = 5_000;

const SETUP_HINT =
  "Live voice needs a few audio tools on this Mac. Run: brew install ffmpeg sox switchaudio-osx && brew install --cask blackhole-2ch blackhole-16ch";
const MIC_PERMISSION_HINT =
  "The Mac is blocking relay from recording audio. On the Mac, click Allow on the microphone prompt for relay (or turn relay on in System Settings > Privacy & Security > Microphone), then try again.";

/**
 * While live, omp swaps its message box for a panel whose bottom border reads
 * "╰─ ● listening · Space mute · Esc end ──╯". The word after the icon is the phase.
 */
const LIVE_BORDER = /^\s*[╰└]─ \S+ (connecting|listening|working|speaking|muted|error)\b/m;

type AudioDefaults = { input: string; output: string };

/** A message the phone receives as a WebSocket text frame. */
type CallEvent = { type: "phase"; phase: string } | { type: "ended"; error?: string };

/** Live mode uses the Mac's one set of default devices, so only one call runs at a time. */
let activeCall: LiveCall | null = null;

function run(command: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim()));
    else resolve(stdout);
  });
  return promise;
}

async function livePhase(paneId: string): Promise<string | null> {
  return LIVE_BORDER.exec(await capturePane(paneId))?.[1] ?? null;
}

async function setAudioDevices(defaults: AudioDefaults): Promise<void> {
  await run("SwitchAudioSource", ["-t", "input", "-s", defaults.input]);
  await run("SwitchAudioSource", ["-t", "output", "-s", defaults.output]);
}

async function checkPrerequisites(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Live voice only works on a Mac for now.");
  try {
    await Promise.all([run("ffmpeg", ["-version"]), run("sox", ["--version"])]);
    const [inputs, outputs] = await Promise.all(
      (["input", "output"] as const).map(async (type) => (await run("SwitchAudioSource", ["-a", "-t", type])).split("\n").map((line) => line.trim())),
    );
    if (!inputs.includes(PHONE_SPEAKER_DEVICE) || !outputs.includes(PHONE_MIC_DEVICE)) throw new Error("missing BlackHole");
  } catch {
    throw new Error(SETUP_HINT);
  }
}

/** ffmpeg's AudioToolbox output picks devices by index, listed as "[3]   BlackHole 2ch, <uid>". */
async function audioToolboxIndex(deviceName: string): Promise<number> {
  const listing = await new Promise<string>((resolve) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-f", "lavfi", "-i", "anullsrc", "-t", "0.01", "-f", "audiotoolbox", "-list_devices", "true", "-"],
      { encoding: "utf8" },
      (_error, _stdout, stderr) => resolve(stderr),
    );
  });
  for (const line of listing.split("\n")) {
    const match = /\[(\d+)\]\s+(.+?), /.exec(line);
    if (match && match[2] === deviceName) return Number(match[1]);
  }
  throw new Error(`ffmpeg cannot find the "${deviceName}" audio device.`);
}

/** Points the Mac's default devices at BlackHole, remembering the old ones on disk first. */
async function routeAudioThroughRelay(): Promise<void> {
  const previous: AudioDefaults = {
    input: (await run("SwitchAudioSource", ["-c", "-t", "input"])).trim(),
    output: (await run("SwitchAudioSource", ["-c", "-t", "output"])).trim(),
  };
  // A previous call that never cleaned up already holds the real devices; keep those.
  const saved = await readSavedAudioDefaults();
  if (!saved) {
    await mkdir(dirname(LIVE_AUDIO_BACKUP_PATH), { recursive: true });
    await writeFile(LIVE_AUDIO_BACKUP_PATH, JSON.stringify(previous));
  }
  await setAudioDevices({ input: PHONE_MIC_DEVICE, output: PHONE_SPEAKER_DEVICE });
}

async function readSavedAudioDefaults(): Promise<AudioDefaults | null> {
  try {
    const parsed = JSON.parse(await readFile(LIVE_AUDIO_BACKUP_PATH, "utf8")) as Partial<AudioDefaults>;
    if (typeof parsed.input === "string" && typeof parsed.output === "string") {
      return { input: parsed.input, output: parsed.output };
    }
  } catch {}
  return null;
}

/**
 * Puts back the devices saved before a call. Also runs at server start, so a crash
 * mid-call cannot leave the Mac silently routed into BlackHole.
 */
export async function restoreAudioDevices(): Promise<void> {
  const saved = await readSavedAudioDefaults();
  if (!saved) return;
  await setAudioDevices(saved);
  await rm(LIVE_AUDIO_BACKUP_PATH, { force: true });
}

/** Spawns an audio tool (ffmpeg or sox) and reports an unexpected exit as a readable error. */
function spawnAudioTool(command: string, args: string[], onExit: (error: string) => void): ChildProcessWithoutNullStreams {
  const child = spawn(command, args);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-500);
  });
  child.on("error", (error) => onExit(`${command} failed to start: ${error.message}`));
  // During hang-up the call is already ending, so this report is ignored.
  child.on("exit", (code, signal) => onExit(`${command} stopped (${code ?? signal}): ${stderr.trim() || "no details"}`));
  child.stdin.on("error", () => {
    // Writes after exit are dropped; the exit handler already reports the failure.
  });
  return child;
}

class LiveCall {
  readonly #socket: WebSocket;
  readonly #pane: Pane;
  #starting: Promise<void> = Promise.resolve();
  #ending: Promise<void> | null = null;
  #phoneMic: ChildProcessWithoutNullStreams | null = null;
  #phoneSpeaker: ChildProcessWithoutNullStreams | null = null;
  #poll: NodeJS.Timeout | undefined;
  #phase: string | null = null;
  #startedAt = Date.now();

  constructor(socket: WebSocket, pane: Pane) {
    this.#socket = socket;
    this.#pane = pane;
  }

  async run(): Promise<void> {
    this.#socket.on("close", () => void this.end());
    this.#socket.on("message", (data, isBinary) => {
      if (isBinary && !this.#ending) this.#phoneMic?.stdin.write(data as Buffer);
    });
    this.#starting = this.#start();
    try {
      await this.#starting;
    } catch (error) {
      await this.end(error instanceof Error ? error.message : String(error));
    }
  }

  async #start(): Promise<void> {
    await checkPrerequisites();
    const micIndex = await audioToolboxIndex(PHONE_MIC_DEVICE);
    await routeAudioThroughRelay();

    const fail = (error: string) => void this.end(error);
    // Phone mic → BlackHole 16ch, which omp records as its microphone. Sent as stereo so
    // the voice lands on channels 1 and 2; CoreAudio puts mono on the centre channel.
    this.#phoneMic = spawnAudioTool(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-fflags", "nobuffer", "-probesize", "32", "-analyzeduration", "0",
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
        "-ac", "2", "-f", "audiotoolbox", "-audio_device_index", String(micIndex), "-",
      ],
      fail,
    );
    // omp's voice from BlackHole 2ch → phone speaker. A small buffer (~40 ms) keeps the
    // delay down; sox otherwise holds 170 ms before writing anything.
    this.#phoneSpeaker = spawnAudioTool(
      "sox",
      [
        "--buffer", "2048", "-q",
        "-t", "coreaudio", PHONE_SPEAKER_DEVICE,
        "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed-integer", "-b", "16", "-c", "1", "-",
        "remix", "-m", "1v0.5,2v0.5",
      ],
      fail,
    );
    // macOS asks once for microphone access (per relay build); until someone clicks
    // Allow on the Mac, the capture silently produces nothing.
    const captureTimeout = setTimeout(() => void this.end(MIC_PERMISSION_HINT), CAPTURE_TIMEOUT_MS);
    this.#phoneSpeaker.stdout.once("data", () => clearTimeout(captureTimeout));
    let carry: Buffer | null = null;
    this.#phoneSpeaker.stdout.on("data", (chunk: Buffer) => {
      // Keep frames whole: a 16-bit sample split across two chunks would turn into noise.
      const bytes: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = bytes.length - (bytes.length % 2);
      carry = even < bytes.length ? bytes.subarray(even) : null;
      if (even > 0 && this.#socket.readyState === this.#socket.OPEN) this.#socket.send(bytes.subarray(0, even));
    });

    // Ctrl+L toggles omp's live mode; only press it when the pane is not live already.
    if (!(await livePhase(this.#pane.paneId))) await sendKeys(this.#pane.paneId, ["C-l"]);
    this.#startedAt = Date.now();
    this.#poll = setInterval(() => void this.#checkPhase().catch((error: Error) => this.end(error.message)), PHASE_POLL_MS);
  }

  /** Mirrors omp's live phase to the phone and ends the call when live mode goes away. */
  async #checkPhase(): Promise<void> {
    if (this.#ending) return;
    const phase = await livePhase(this.#pane.paneId);
    if (phase && phase !== this.#phase) this.#send({ type: "phase", phase });
    if (!phase && this.#phase) {
      // Someone ended live mode on the computer (or omp hit an error and showed it there).
      await this.end();
      return;
    }
    if (!phase && Date.now() - this.#startedAt > START_TIMEOUT_MS) {
      await this.end("omp didn't start live mode. Check the session on the computer for an error.");
      return;
    }
    this.#phase = phase;
  }

  #send(event: CallEvent): void {
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.send(JSON.stringify(event));
  }

  end(error?: string): Promise<void> {
    this.#ending ??= this.#finish(error);
    return this.#ending;
  }

  async #finish(error: string | undefined): Promise<void> {
    await this.#starting.catch(() => {});
    clearInterval(this.#poll);

    try {
      // Esc ends live mode; outside it, Esc would interrupt the agent, so check first.
      if (await livePhase(this.#pane.paneId)) {
        await sendKeys(this.#pane.paneId, ["Escape"]);
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (Date.now() < deadline && (await livePhase(this.#pane.paneId))) await sleep(150);
      }
    } catch (stopError) {
      console.error("live: could not stop omp's live mode", stopError);
    }

    // SIGTERM leaves ffmpeg blocked on its stdin pipe; these hold no files, so kill outright.
    for (const child of [this.#phoneMic, this.#phoneSpeaker]) child?.kill("SIGKILL");
    try {
      await restoreAudioDevices();
    } catch (restoreError) {
      console.error("live: could not restore audio devices", restoreError);
    }

    this.#send({ type: "ended", ...(error ? { error } : {}) });
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.close(1000);
    if (activeCall === this) activeCall = null;
  }
}

/** Runs one phone call on an accepted WebSocket until either side hangs up. */
export function startLiveCall(socket: WebSocket, pane: Pane): void {
  if (activeCall) {
    socket.send(JSON.stringify({ type: "ended", error: "Another live call is already running on this computer." } satisfies CallEvent));
    socket.close(1000);
    return;
  }
  const call = new LiveCall(socket, pane);
  activeCall = call;
  void call.run();
}

/** Hangs up the current call, if any, so shutdown leaves omp and the Mac's audio as they were. */
export async function endLiveCall(): Promise<void> {
  await activeCall?.end("The relay server is shutting down.");
}
