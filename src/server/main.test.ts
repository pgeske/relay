import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadToken } from "../token.ts";
import { handleRequest } from "./main.ts";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer(handleRequest);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

/** Calls the test server over loopback; `host` overrides the Host header, as a rebinding page's would. */
function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: unknown }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: unknown }>();
  const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
    let raw = "";
    res.on("data", (chunk) => (raw += chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
  });
  req.on("error", reject);
  if (body !== undefined) req.setHeader("content-type", "application/json");
  req.end(body === undefined ? undefined : JSON.stringify(body));
  return promise;
}

const review = (headers: Record<string, string>) => call("POST", "/api/board/actions/review", headers, { pr: "acme/api#1" });

test("the board's endpoints need relay's token", async () => {
  expect((await call("GET", "/api/board")).status).toBe(401);
  expect(await review({})).toEqual({ status: 401, body: { error: "unauthorized" } });
  expect((await review({ authorization: "Bearer not-the-token" })).status).toBe(401);
});

test("and answer only requests that name this computer, whatever the token", async () => {
  const rebound = { host: `evil.example:${port}`, authorization: `Bearer ${loadToken()}` };
  expect(await review(rebound)).toEqual({ status: 403, body: { error: "the board only answers this computer" } });
  expect((await call("GET", "/api/board", rebound)).status).toBe(403);
});

test("with the token, an action reaches the board", async () => {
  const authorized = { authorization: `Bearer ${loadToken()}` };
  expect(await review(authorized)).toEqual({ status: 404, body: { error: "no omp session is in charge of acme/api#1" } });
  expect((await call("POST", "/api/board/actions/deploy", authorized, { pr: "acme/api#1" })).body).toEqual({ error: "no such action: deploy" });
  expect(await call("POST", "/api/board/actions/review", authorized, { pr: "not a pr" })).toEqual({
    status: 400,
    body: { error: "not a pull request: not a pr (use a PR URL or owner/repo#number)" },
  });
  expect((await call("GET", "/api/board/actions/review", authorized)).status).toBe(405);
});

test("the old board page is gone", async () => {
  expect((await call("GET", "/board")).status).toBe(404);
});
