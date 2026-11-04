import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellEnv, parseShellEnv } from "./shellEnv.ts";

const MARKER = "__RELAY_SHELL_ENV__";
const originalShell = process.env.SHELL;
let scratch: string | null = null;

afterEach(() => {
  process.env.SHELL = originalShell;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

/** A stand-in login shell: prints what an rc file might, exports a variable, then runs relay's script. */
function fakeShell(body: string): string {
  scratch = mkdtempSync(join(tmpdir(), "relay-shell-"));
  const path = join(scratch, "shell");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("the environment is read between the markers, skipping rc-file output and per-shell state", () => {
  const output = `Welcome!\n${MARKER}A=1\0B=x=y\0MULTI=line1\nline2\0PWD=/tmp\0SHLVL=2\0_=/usr/bin/env\0TERM=dumb\0${MARKER}bye`;
  expect(parseShellEnv(output)).toEqual({ A: "1", B: "x=y", MULTI: "line1\nline2" });
});

test("output without both markers yields nothing", () => {
  expect(parseShellEnv("")).toBeNull();
  expect(parseShellEnv(`${MARKER}A=1\0`)).toBeNull();
});

test("the login shell's exported variables come back, and rc files can tell relay is asking", async () => {
  process.env.SHELL = fakeShell('echo "rc file says hi"; export FROM_RC="seen:$RELAY_RESOLVING_ENVIRONMENT"; shift 3; eval "$1"');
  const env = await loginShellEnv();
  expect(env?.FROM_RC).toBe("seen:1");
  expect(env?.RELAY_RESOLVING_ENVIRONMENT).toBeUndefined();
  expect(env?.PWD).toBeUndefined();
});

test("a shell that never prints the environment yields nothing", async () => {
  process.env.SHELL = fakeShell("exit 1");
  expect(await loginShellEnv()).toBeNull();
});
