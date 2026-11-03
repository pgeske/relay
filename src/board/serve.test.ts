import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { isLocalRequest, runBoardAction } from "./serve.ts";

function request(remoteAddress: string, host: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: { host } } as unknown as IncomingMessage;
}

test("this computer reaches the board", () => {
  expect(isLocalRequest(request("127.0.0.1", "localhost:7878"))).toBe(true);
  expect(isLocalRequest(request("::ffff:127.0.0.1", "127.0.0.1:7878"))).toBe(true);
  expect(isLocalRequest(request("::1", "[::1]:7878"))).toBe(true);
});

test("other machines don't, even on the LAN or Tailscale", () => {
  expect(isLocalRequest(request("192.168.1.20", "localhost:7878"))).toBe(false);
  expect(isLocalRequest(request("100.101.102.103", "localhost:7878"))).toBe(false);
});

test("a page on another site that rebinds its domain to 127.0.0.1 doesn't either", () => {
  expect(isLocalRequest(request("127.0.0.1", "evil.example:7878"))).toBe(false);
});

test("an action the board doesn't have is refused", async () => {
  expect(await runBoardAction("deploy", "acme/api#1")).toEqual({ status: 404, message: "no such action: deploy" });
});

test.each(["open", "review", "merge", "fix-ci", "ask-approval", "bump"])("%s needs a session in charge of the PR", async (action) => {
  expect(await runBoardAction(action, "acme/api#1")).toEqual({ status: 404, message: "no omp session is in charge of acme/api#1" });
});
