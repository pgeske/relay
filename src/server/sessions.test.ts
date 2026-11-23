import { expect, test } from "bun:test";
import { parsePaneTitle } from "./sessions.ts";

test("parsePaneTitle reads omp's idle, asking, and working markers", () => {
  expect(parsePaneTitle("π > Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "idle" });
  expect(parsePaneTitle("π ! Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "asking" });
  // Braille, pulse, line, and static-working `:` spinners are working.
  expect(parsePaneTitle("π ⠋ Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "working" });
  expect(parsePaneTitle("π ⠹ 󱚤 ACME: Speed up deploy", "/tmp")).toEqual({ title: "󱚤 ACME: Speed up deploy", status: "working" });
  expect(parsePaneTitle("π ◑ Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "working" });
  expect(parsePaneTitle("π / Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "working" });
  expect(parsePaneTitle("π : Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "working" });
});

test("parsePaneTitle treats status-disabled, unknown, and non-omp titles as idle, never working", () => {
  // omp status-disabled format: `π: <title>` (colon attached to π)
  expect(parsePaneTitle("π: Cache rollout", "/tmp")).toEqual({ title: "Cache rollout", status: "idle" });
  // Non-omp title (e.g. shell before omp sets its title)
  expect(parsePaneTitle("zsh", "/tmp")).toEqual({ title: "zsh", status: "idle" });
  // Unknown prefix after `π ` must not look like an active spinner
  expect(parsePaneTitle("π ? Cache rollout", "/tmp")).toEqual({ title: "? Cache rollout", status: "idle" });
  expect(parsePaneTitle("π", "/tmp")).toEqual({ title: "", status: "idle" });
  // Unnamed session (title equals basename of cwd) comes back empty
  expect(parsePaneTitle("π > relay", "/Users/dev/relay")).toEqual({ title: "", status: "idle" });
  expect(parsePaneTitle("π ! relay", "/Users/dev/relay")).toEqual({ title: "", status: "asking" });
});
