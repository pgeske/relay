import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { isBoardAction, isLocalBrowserRequest, runBoardAction } from "./serve.ts";

function request(remoteAddress: string, host: string, origin?: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: { host, origin } } as unknown as IncomingMessage;
}

test("this computer's browser gets the board", () => {
  expect(isLocalBrowserRequest(request("127.0.0.1", "localhost:7878"))).toBe(true);
  expect(isLocalBrowserRequest(request("::ffff:127.0.0.1", "127.0.0.1:7878"))).toBe(true);
  expect(isLocalBrowserRequest(request("::1", "[::1]:7878"))).toBe(true);
});

test("other machines don't, even on the LAN or Tailscale", () => {
  expect(isLocalBrowserRequest(request("192.168.1.20", "localhost:7878"))).toBe(false);
  expect(isLocalBrowserRequest(request("100.101.102.103", "localhost:7878"))).toBe(false);
});

test("a page on another site that rebinds its domain to 127.0.0.1 doesn't either", () => {
  expect(isLocalBrowserRequest(request("127.0.0.1", "evil.example:7878"))).toBe(false);
});

test("buttons work only when the board page itself sent the click", () => {
  expect(isBoardAction(request("127.0.0.1", "localhost:7878", "http://localhost:7878"))).toBe(true);
  // Another site's page can make the browser POST to localhost, but the browser stamps its own origin.
  expect(isBoardAction(request("127.0.0.1", "localhost:7878", "https://evil.example"))).toBe(false);
  expect(isBoardAction(request("127.0.0.1", "localhost:7878"))).toBe(false);
});

test.each(["ask-approval", "bump"])("%s needs a session in charge of the PR to draft in", async (action) => {
  expect(await runBoardAction(action, "acme/api#1")).toEqual({ status: 404, message: "no omp session is in charge of acme/api#1" });
});