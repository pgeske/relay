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
/** How long Ctrl+L gets to show a live panel when probing for a hidden live mode. */
const PROBE_TIMEOUT_MS = 1_500;
/** BlackHole streams silence nonstop, so a capture that stays empty this long is blocked. */
const CAPTURE_TIMEOUT_MS = 5_000;
/**
 * The phone answers pings on its own, even while muted. One that stays silent this long
 * is gone (app killed, network lost) without having closed the socket.
 */
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;

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
/** What a call in progress saves on disk, so a restarted server can clean up after it. */
type SavedCall = AudioDefaults & { paneId?: string };

/** A message the phone receives as a WebSocket text frame. */
type CallEvent = { type: "phase"; phase: string } | { type: "ended"; error?: string };

function run(command: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim()));
    else resolve(stdout);
  });
  return promise;
}

/** omp's live phase as shown on a captured pane screen, or null when no live panel shows. */
export function livePhaseOnScreen(screen: string): string | null {
  return LIVE_BORDER.exec(screen)?.[1] ?? null;
}

async function livePhase(paneId: string): Promise<string | null> {
  return livePhaseOnScreen(await capturePane(paneId));
}

/** Waits until the live panel is shown (or gone, with `shown` false); false on timeout. */
async function waitForLivePanel(paneId: string, shown: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (((await livePhase(paneId)) !== null) === shown) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Ends omp's live mode in the pane. Esc ends it while its panel shows. omp can also keep
 * live mode running with no panel: a dialog such as the `ask` tool's replaces the panel,
 * and closing the dialog brings back the message box instead. Nothing on screen shows
 * that, so with no panel in sight press Ctrl+L, which toggles live mode from the message
 * box, and if that started a new live session instead, end it again with Esc.
 */
async function stopLiveMode(paneId: string): Promise<void> {
  if (!(await livePhase(paneId))) {
    console.log(`live: no live panel on ${paneId}; pressing Ctrl+L in case live mode is hidden`);
    await sendKeys(paneId, ["C-l"]);
    if (!(await waitForLivePanel(paneId, true, PROBE_TIMEOUT_MS))) return;
  }
  // Esc ends live mode; outside it, Esc would interrupt the agent, so only press it here.
  await sendKeys(paneId, ["Escape"]);
  if (!(await waitForLivePanel(paneId, false, STOP_TIMEOUT_MS))) {
    console.error(`live: omp's live mode on ${paneId} did not end after Esc`);
  }
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

/** Points the Mac's default devices at BlackHole, remembering the old ones and the pane on disk first. */
async function routeAudioThroughRelay(paneId: string): Promise<void> {
  // A previous call that never cleaned up already holds the real devices; keep those.
  const previous: AudioDefaults = (await readSavedCall()) ?? {
    input: (await run("SwitchAudioSource", ["-c", "-t", "input"])).trim(),
    output: (await run("SwitchAudioSource", ["-c", "-t", "output"])).trim(),
  };
  const saved: SavedCall = { input: previous.input, output: previous.output, paneId };
  await mkdir(dirname(LIVE_AUDIO_BACKUP_PATH), { recursive: true });
  await writeFile(LIVE_AUDIO_BACKUP_PATH, JSON.stringify(saved));
  await setAudioDevices({ input: PHONE_MIC_DEVICE, output: PHONE_SPEAKER_DEVICE });
}

async function readSavedCall(): Promise<SavedCall | null> {
  try {
    const parsed = JSON.parse(await readFile(LIVE_AUDIO_BACKUP_PATH, "utf8")) as Partial<SavedCall>;
    if (typeof parsed.input === "string" && typeof parsed.output === "string") {
      return { input: parsed.input, output: parsed.output, ...(typeof parsed.paneId === "string" ? { paneId: parsed.paneId } : {}) };
    }
  } catch {}
  return null;
}

/** Puts back the devices saved before a call. */
async function restoreAudioDevices(): Promise<void> {
  const saved = await readSavedCall();
  if (!saved) return;
  await setAudioDevices(saved);
  await rm(LIVE_AUDIO_BACKUP_PATH, { force: true });
}

/**
 * Runs at server start: a server that stopped mid-call (crash, kill) leaves the Mac
 * routed into BlackHole and omp possibly still live. End live mode before putting the
 * devices back, or omp would go on listening and talking through the Mac itself.
 */
export async function recoverInterruptedCall(): Promise<void> {
  const saved = await readSavedCall();
  if (!saved) return;
  console.log("live: cleaning up after a call the previous server did not finish");
  if (saved.paneId) {
    await stopLiveMode(saved.paneId).catch((error: unknown) => console.error("live: could not stop omp's live mode", error));
  }
  await restoreAudioDevices();
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

/** What `CallSlot` needs from a call. */
export type SlotCall = {
  /** Starts the call unless it already ended; resolves once it has ended and cleaned up. */
  run(): Promise<void>;
  /** Hangs up; resolves once cleaned up. Safe to call more than once, and before `run`. */
  end(error?: string): Promise<void>;
};

const REPLACED_ERROR = "A newer call took over from this one.";

/**
 * Live mode uses the Mac's one set of default devices, so only one call runs at a time.
 * A new call hangs up the current one and starts only after that one has cleaned up, so
 * the old call can't put the Mac's devices back underneath the new one. Starting the
 * newest call, rather than refusing it, also takes over from a call whose phone vanished
 * before the heartbeat noticed.
 */
export class CallSlot<Call extends SlotCall> {
  #current: Call | null = null;
  #handover: Promise<void> = Promise.resolve();
  /** Set by `close`; calls still waiting for their turn end with it instead of starting. */
  #closeError: string | null = null;

  start(call: Call): void {
    const previous = this.#current;
    this.#current = call;
    this.#handover = this.#handover.then(async () => {
      await previous?.end(REPLACED_ERROR);
      if (this.#closeError !== null || this.#current !== call) {
        await call.end(this.#closeError ?? REPLACED_ERROR);
        return;
      }
      void call.run().finally(() => {
        if (this.#current === call) this.#current = null;
      });
    });
  }

  /** Hangs up the current call and keeps waiting calls from starting, for shutdown. */
  async close(error: string): Promise<void> {
    this.#closeError = error;
    await this.#current?.end(error);
    await this.#handover;
  }
}

class LiveCall implements SlotCall {
  readonly #socket: WebSocket;
  readonly #pane: Pane;
  #starting: Promise<void> = Promise.resolve();
  #ending: Promise<void> | null = null;
  #ended = Promise.withResolvers<void>();
  #started = false;
  /** Set once this call takes over omp's live mode, so hanging up must end it. */
  #tookOverLive = false;
  #phoneMic: ChildProcessWithoutNullStreams | null = null;
  #phoneSpeaker: ChildProcessWithoutNullStreams | null = null;
  #poll: NodeJS.Timeout | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #lastHeardAt = Date.now();
  #phase: string | null = null;
  #startedAt = Date.now();
  /** Per-call totals for the server log, so a silent call shows which direction failed. */
  #stats = { fromPhoneBytes: 0, fromPhonePeak: 0, toPhoneBytes: 0, phases: [] as string[] };

  constructor(socket: WebSocket, pane: Pane) {
    this.#socket = socket;
    this.#pane = pane;
    // Listen from the start: a call waiting for the previous one to end can hang up too.
    socket.on("close", () => void this.end());
    socket.on("pong", () => {
      this.#lastHeardAt = Date.now();
    });
    socket.on("message", (data, isBinary) => {
      this.#lastHeardAt = Date.now();
      if (!isBinary || this.#ending) return;
      const chunk = data as Buffer;
      this.#stats.fromPhoneBytes += chunk.length;
      for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
        this.#stats.fromPhonePeak = Math.max(this.#stats.fromPhonePeak, Math.abs(chunk.readInt16LE(offset)));
      }
      this.#phoneMic?.stdin.write(chunk);
    });
  }

  async run(): Promise<void> {
    // The phone may have hung up while this call waited for the previous one to end.
    if (this.#ending) return this.#ending;
    this.#started = true;
    console.log(`live: call started on ${this.#pane.paneId}`);
    this.#lastHeardAt = Date.now();
    this.#heartbeat = setInterval(() => this.#checkHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.#starting = this.#start();
    try {
      await this.#starting;
    } catch (error) {
      void this.end(error instanceof Error ? error.message : String(error));
    }
    await this.#ended.promise;
  }

  /** Hangs up when the phone stops answering pings: a dead network never closes the socket. */
  #checkHeartbeat(): void {
    if (Date.now() - this.#lastHeardAt > HEARTBEAT_TIMEOUT_MS) {
      console.log(`live: the phone stopped answering on ${this.#pane.paneId}`);
      void this.end("Lost the connection to the phone.");
      this.#socket.terminate();
      return;
    }
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.ping();
  }

  async #start(): Promise<void> {
    await checkPrerequisites();
    const micIndex = await audioToolboxIndex(PHONE_MIC_DEVICE);
    await routeAudioThroughRelay(this.#pane.paneId);

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
      if (even > 0 && this.#socket.readyState === this.#socket.OPEN) {
        this.#socket.send(bytes.subarray(0, even));
        this.#stats.toPhoneBytes += even;
      }
    });

    // Ctrl+L toggles omp's live mode; only press it when the pane is not live already.
    this.#tookOverLive = true;
    if (!(await livePhase(this.#pane.paneId))) await sendKeys(this.#pane.paneId, ["C-l"]);
    this.#startedAt = Date.now();
    this.#poll = setInterval(() => void this.#checkPhase().catch((error: Error) => this.end(error.message)), PHASE_POLL_MS);
  }

  /** Mirrors omp's live phase to the phone and ends the call when live mode goes away. */
  async #checkPhase(): Promise<void> {
    if (this.#ending) return;
    const phase = await livePhase(this.#pane.paneId);
    if (phase && phase !== this.#phase) {
      this.#send({ type: "phase", phase });
      this.#stats.phases.push(phase);
    }
    if (!phase && this.#phase) {
      // Someone ended live mode on the computer, omp hit an error and showed it there,
      // or a dialog hid the live panel; hanging up handles the hidden case too.
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
    clearInterval(this.#heartbeat);

    if (this.#started) {
      if (this.#tookOverLive) {
        try {
          await stopLiveMode(this.#pane.paneId);
        } catch (stopError) {
          console.error("live: could not stop omp's live mode", stopError);
        }
      }
      // SIGTERM leaves ffmpeg blocked on its stdin pipe; these hold no files, so kill outright.
      for (const child of [this.#phoneMic, this.#phoneSpeaker]) child?.kill("SIGKILL");
      try {
        await restoreAudioDevices();
      } catch (restoreError) {
        console.error("live: could not restore audio devices", restoreError);
      }

      const seconds = (bytes: number) => (bytes / 2 / SAMPLE_RATE).toFixed(1);
      console.log(
        `live: call ended on ${this.#pane.paneId} after ${((Date.now() - this.#startedAt) / 1000).toFixed(0)}s;` +
          ` phone sent ${seconds(this.#stats.fromPhoneBytes)}s of audio (peak ${this.#stats.fromPhonePeak}),` +
          ` phone got ${seconds(this.#stats.toPhoneBytes)}s; phases ${this.#stats.phases.join(">") || "none"}` +
          (error ? `; error: ${error}` : ""),
      );
    }
    this.#send({ type: "ended", ...(error ? { error } : {}) });
    if (this.#socket.readyState === this.#socket.OPEN) this.#socket.close(1000);
    this.#ended.resolve();
  }
}

const calls = new CallSlot<LiveCall>();

/** Runs one phone call on an accepted WebSocket until either side hangs up or a newer call takes over. */
export function startLiveCall(socket: WebSocket, pane: Pane): void {
  calls.start(new LiveCall(socket, pane));
}

/** Hangs up the current call, if any, so shutdown leaves omp and the Mac's audio as they were. */
export async function endLiveCall(): Promise<void> {
  await calls.close("The relay server is shutting down.");
}
