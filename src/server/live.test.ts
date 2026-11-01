import { describe, expect, test } from "bun:test";
import { CallSlot, livePhaseOnScreen, type SlotCall } from "./live.ts";

/** A call whose hang-up finishes only when the test says so, logging what happens to it. */
class FakeCall implements SlotCall {
  readonly #name: string;
  readonly #log: string[];
  #ended = Promise.withResolvers<void>();
  #ending: Promise<void> | null = null;
  readonly #cleanedUp = Promise.withResolvers<void>();

  constructor(name: string, log: string[]) {
    this.#name = name;
    this.#log = log;
  }

  async run(): Promise<void> {
    if (this.#ending) return this.#ending;
    this.#log.push(`${this.#name} runs`);
    await this.#ended.promise;
  }

  end(error?: string): Promise<void> {
    this.#ending ??= (async () => {
      this.#log.push(`${this.#name} ends${error ? `: ${error}` : ""}`);
      await this.#cleanedUp.promise;
      this.#log.push(`${this.#name} cleaned up`);
      this.#ended.resolve();
    })();
    return this.#ending;
  }

  /** Lets an in-progress hang-up finish. */
  finishCleanup(): void {
    this.#cleanedUp.resolve();
  }
}

/** Lets every queued promise callback run: the immediate fires only once they have all drained. */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe("CallSlot", () => {
  test("a new call hangs up the running one and starts only after it has cleaned up", async () => {
    const log: string[] = [];
    const slot = new CallSlot<FakeCall>();
    const first = new FakeCall("first", log);
    const second = new FakeCall("second", log);

    slot.start(first);
    await settle();
    slot.start(second);
    await settle();
    expect(log).toEqual(["first runs", "first ends: A newer call took over from this one."]);

    first.finishCleanup();
    await settle();
    expect(log.slice(2)).toEqual(["first cleaned up", "second runs"]);
  });

  test("a call replaced while waiting for its turn never starts", async () => {
    const log: string[] = [];
    const slot = new CallSlot<FakeCall>();
    const [first, second, third] = ["first", "second", "third"].map((name) => new FakeCall(name, log));

    slot.start(first);
    await settle();
    slot.start(second);
    slot.start(third);
    second.finishCleanup();
    first.finishCleanup();
    await settle();

    expect(log).not.toContain("second runs");
    expect(log.at(-1)).toBe("third runs");
    expect(log.indexOf("second cleaned up")).toBeLessThan(log.indexOf("third runs"));
  });

  test("closing hangs up the running call and keeps waiting calls from starting", async () => {
    const log: string[] = [];
    const slot = new CallSlot<FakeCall>();
    const first = new FakeCall("first", log);
    const second = new FakeCall("second", log);

    slot.start(first);
    await settle();
    slot.start(second);
    first.finishCleanup();
    second.finishCleanup();
    await slot.close("shutting down");

    expect(log).not.toContain("second runs");
    expect(log).toContain("second ends: shutting down");
  });

  test("a call that ended on its own frees the slot without being hung up again", async () => {
    const log: string[] = [];
    const slot = new CallSlot<FakeCall>();
    const first = new FakeCall("first", log);
    const second = new FakeCall("second", log);

    slot.start(first);
    await settle();
    first.finishCleanup();
    await first.end();
    await settle();
    slot.start(second);
    await settle();

    expect(log).toEqual(["first runs", "first ends", "first cleaned up", "second runs"]);
  });
});

describe("livePhaseOnScreen", () => {
  test("reads the phase from the live panel's bottom border, whatever the icon", () => {
    const screen = [
      "│ …and then we can continue │",
      "╰─ \u{f144e} working · \u{f1050} mute · \u{f12b7} end ──────╯",
      " ⠼ 1m · Opus · /tmp",
    ].join("\n");
    expect(livePhaseOnScreen(screen)).toBe("working");
    expect(livePhaseOnScreen("╰─ ● listening · Space mute · Esc end ──╯")).toBe("listening");
  });

  test("finds no phase on the regular message box", () => {
    expect(livePhaseOnScreen("╭──────╮\n│ hello │\n╰──────╯")).toBeNull();
  });
});
