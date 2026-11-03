import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentRequests,
  approvalAsks,
  latestAgentReviews,
  latestCiFixes,
  openBoardStore,
  recordAgentRequest,
  recordAgentReview,
  recordApprovalAsk,
  recordApprovalBump,
  recordCiFix,
  type AgentReview,
  type CiFix,
} from "./store.ts";

const base: AgentReview = { repo: "acme/api", number: 1, headSha: "aaa", verdict: "findings", findings: 2, summary: null, reviewedAt: "2026-10-30T01:00:00Z" };

test("the newest review of each PR wins, and re-reviewing a commit replaces its result", () => {
  const db = openBoardStore(":memory:");
  recordAgentReview(db, base);
  recordAgentReview(db, { ...base, headSha: "bbb", reviewedAt: "2026-10-30T02:00:00Z" });
  recordAgentReview(db, { ...base, headSha: "bbb", verdict: "passed", findings: 0, reviewedAt: "2026-10-30T03:00:00Z" });
  recordAgentReview(db, { ...base, number: 2, reviewedAt: "2026-10-29T00:00:00Z" });

  const latest = latestAgentReviews(db);
  expect(latest.get("acme/api#1")).toMatchObject({ headSha: "bbb", verdict: "passed", findings: 0 });
  expect(latest.get("acme/api#2")).toMatchObject({ headSha: "aaa", verdict: "findings" });
  expect(latest.size).toBe(2);
});

test("the board remembers when it last sent each kind of request", () => {
  const db = openBoardStore(":memory:");
  recordAgentRequest(db, "acme/api", 1, "review", "2026-10-30T01:00:00Z");
  recordAgentRequest(db, "acme/api", 1, "fix-ci", "2026-10-30T02:00:00Z");
  recordAgentRequest(db, "acme/api", 1, "review", "2026-10-30T03:00:00Z");
  recordAgentRequest(db, "acme/api", 2, "merge", "2026-10-30T04:00:00Z");
  expect(agentRequests(db).get("acme/api#1")).toEqual({ review: "2026-10-30T03:00:00Z", "fix-ci": "2026-10-30T02:00:00Z" });
  expect(agentRequests(db).get("acme/api#2")).toEqual({ merge: "2026-10-30T04:00:00Z" });
});

test("the newest CI-fix result of each PR wins", () => {
  const db = openBoardStore(":memory:");
  const fix: CiFix = { repo: "acme/api", number: 1, headSha: "aaa", verdict: "not-fixed", summary: "infra down", recordedAt: "2026-10-30T01:00:00Z" };
  recordCiFix(db, fix);
  recordCiFix(db, { ...fix, headSha: "bbb", verdict: "fixed", summary: "pinned the flaky test's clock", recordedAt: "2026-10-30T02:00:00Z" });
  expect(latestCiFixes(db).get("acme/api#1")).toEqual({ ...fix, headSha: "bbb", verdict: "fixed", summary: "pinned the flaky test's clock", recordedAt: "2026-10-30T02:00:00Z" });
});

test("an approval ask is bumped in place, and asking again starts over", () => {
  const db = openBoardStore(":memory:");
  const channel = "https://app.slack.com/client/T1/C1";
  const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
  // Nothing to bump before an ask is recorded.
  expect(recordApprovalBump(db, "acme/api", 1, permalink, "2026-10-30T00:00:00Z")).toBe(false);
  expect(approvalAsks(db).size).toBe(0);

  recordApprovalAsk(db, "acme/api", 1, channel, "2026-10-30T01:00:00Z");
  expect(approvalAsks(db).get("acme/api#1")).toEqual({ repo: "acme/api", number: 1, askedAt: "2026-10-30T01:00:00Z", bumpedAt: null, slackUrl: channel });

  expect(recordApprovalBump(db, "acme/api", 1, permalink, "2026-10-31T01:00:00Z")).toBe(true);
  expect(approvalAsks(db).get("acme/api#1")).toEqual({ repo: "acme/api", number: 1, askedAt: "2026-10-30T01:00:00Z", bumpedAt: "2026-10-31T01:00:00Z", slackUrl: permalink });

  recordApprovalAsk(db, "acme/api", 1, channel, "2026-11-01T01:00:00Z");
  expect(approvalAsks(db).get("acme/api#1")).toMatchObject({ askedAt: "2026-11-01T01:00:00Z", bumpedAt: null, slackUrl: channel });
});

test("review requests from before every button shared one table move onto it", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-board-"));
  try {
    const path = join(dir, "board.db");
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE review_requests (repo TEXT NOT NULL, number INTEGER NOT NULL, requested_at TEXT NOT NULL, PRIMARY KEY (repo, number))");
    old.run("INSERT INTO review_requests VALUES ('acme/api', 1, '2026-10-30T01:00:00Z')");
    old.close();

    const db = openBoardStore(path);
    expect(agentRequests(db).get("acme/api#1")).toEqual({ review: "2026-10-30T01:00:00Z" });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'review_requests'").get()).toBeNull();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});