import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentRequests,
  agentReviewSkips,
  approvalAsks,
  latestAgentReviews,
  latestCiFixes,
  openBoardStore,
  recordAgentRequest,
  requireAgentReview,
  recordAgentReview,
  recordApprovalAsk,
  recordApprovalBump,
  recordCiFix,
  skipAgentReview,
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

test("a skipped agent review keeps when it was first skipped, until the PR requires one again", () => {
  const db = openBoardStore(":memory:");
  skipAgentReview(db, "acme/api", 1, "2026-10-30T01:00:00Z");
  skipAgentReview(db, "acme/api", 1, "2026-10-30T02:00:00Z");
  skipAgentReview(db, "acme/api", 2, "2026-10-30T03:00:00Z");
  expect(agentReviewSkips(db)).toEqual(new Map([["acme/api#1", "2026-10-30T01:00:00Z"], ["acme/api#2", "2026-10-30T03:00:00Z"]]));
  requireAgentReview(db, "acme/api", 1);
  expect([...agentReviewSkips(db).keys()]).toEqual(["acme/api#2"]);
});

test("the newest CI-fix result of each PR wins", () => {
  const db = openBoardStore(":memory:");
  const fix: CiFix = { repo: "acme/api", number: 1, headSha: "aaa", verdict: "not-fixed", summary: "infra down", recordedAt: "2026-10-30T01:00:00Z" };
  recordCiFix(db, fix);
  recordCiFix(db, { ...fix, headSha: "bbb", verdict: "fixed", summary: "pinned the flaky test's clock", recordedAt: "2026-10-30T02:00:00Z" });
  expect(latestCiFixes(db).get("acme/api#1")).toEqual({ ...fix, headSha: "bbb", verdict: "fixed", summary: "pinned the flaky test's clock", recordedAt: "2026-10-30T02:00:00Z" });
});

test("each reviewer's approval ask is bumped in place, and asking a reviewer again starts their ask over", () => {
  const db = openBoardStore(":memory:");
  const channel = "https://app.slack.com/client/T1/C1";
  const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
  const ask = { repo: "acme/api", number: 1, reviewer: "cache-team", channel: "#cache-team", slackUrl: channel, askedAt: "2026-10-30T01:00:00Z" };
  const drafted = (overrides: Partial<typeof ask> = {}) => {
    const fields = { ...ask, ...overrides };
    return { ...fields, recordedAt: fields.askedAt, source: "drafted" as const };
  };
  const bump = { repo: "acme/api", number: 1, reviewer: "cache-team", channel: null, slackUrl: permalink, bumpedAt: "2026-10-31T01:00:00Z" };
  // Nothing to bump before an ask is recorded.
  expect(recordApprovalBump(db, bump)).toBe(false);
  expect(approvalAsks(db).size).toBe(0);

  recordApprovalAsk(db, drafted());
  recordApprovalAsk(db, drafted({ reviewer: "sre", channel: "#sre", askedAt: "2026-10-30T02:00:00Z" }));
  expect(approvalAsks(db).get("acme/api#1")).toEqual([
    { ...drafted(), bumpedAt: null },
    { ...drafted({ reviewer: "sre", channel: "#sre", askedAt: "2026-10-30T02:00:00Z" }), bumpedAt: null },
  ]);

  // A bump moves only its reviewer's ask, whatever case the reviewer is named in; one without a channel keeps the ask's.
  expect(recordApprovalBump(db, { ...bump, reviewer: "Cache-Team" })).toBe(true);
  expect(recordApprovalBump(db, { ...bump, reviewer: "security" })).toBe(false);
  expect(recordApprovalBump(db, { ...bump, reviewer: null })).toBe(false);
  expect(approvalAsks(db).get("acme/api#1")).toMatchObject([
    { reviewer: "cache-team", channel: "#cache-team", bumpedAt: "2026-10-31T01:00:00Z", slackUrl: permalink },
    { reviewer: "sre", bumpedAt: null, slackUrl: channel },
  ]);

  recordApprovalAsk(db, drafted({ channel: "#cache-team-reviews", askedAt: "2026-11-01T01:00:00Z" }));
  expect(approvalAsks(db).get("acme/api#1")).toMatchObject([
    { reviewer: "sre" },
    { reviewer: "cache-team", channel: "#cache-team-reviews", askedAt: "2026-11-01T01:00:00Z", bumpedAt: null, slackUrl: channel },
  ]);
});

test("an ask found already sent keeps when its message was sent, apart from when it was recorded", () => {
  const db = openBoardStore(":memory:");
  const permalink = "https://acme.slack.com/archives/C0123ABCD/p1793746643786509?thread_ts=1793045199.212839&cid=C0123ABCD";
  const found = { repo: "acme/api", number: 1, reviewer: "cache-team", channel: "#cache-help", slackUrl: permalink, askedAt: "2026-11-03T22:57:23.786Z" };
  recordApprovalAsk(db, { ...found, recordedAt: "2026-11-04T01:00:00.000Z", source: "found" });
  expect(approvalAsks(db).get("acme/api#1")).toEqual([{ ...found, recordedAt: "2026-11-04T01:00:00.000Z", source: "found", bumpedAt: null }]);
  // Drafting the reviewer's ask afresh replaces it.
  recordApprovalAsk(db, { ...found, slackUrl: "https://app.slack.com/client/T1/C1", askedAt: "2026-11-05T01:00:00Z", recordedAt: "2026-11-05T01:00:00Z", source: "drafted" });
  expect(approvalAsks(db).get("acme/api#1")).toMatchObject([{ source: "drafted", askedAt: "2026-11-05T01:00:00Z" }]);
});

test("asks per reviewer from before the board kept where an ask came from stay, as drafted ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-board-"));
  try {
    const path = join(dir, "board.db");
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE approval_asks (repo TEXT NOT NULL, number INTEGER NOT NULL, reviewer TEXT NOT NULL DEFAULT '' COLLATE NOCASE, channel TEXT,
             asked_at TEXT NOT NULL, bumped_at TEXT, slack_url TEXT NOT NULL, PRIMARY KEY (repo, number, reviewer))`);
    old.run("INSERT INTO approval_asks VALUES ('acme/api', 1, 'sre', '#sre', '2026-10-30T01:00:00Z', NULL, 'https://app.slack.com/client/T1/C1')");
    old.close();

    const db = openBoardStore(path);
    expect(approvalAsks(db).get("acme/api#1")).toMatchObject([{ reviewer: "sre", askedAt: "2026-10-30T01:00:00Z", recordedAt: "2026-10-30T01:00:00Z", source: "drafted" }]);
    db.close();
    const reopened = openBoardStore(path);
    expect(approvalAsks(reopened).get("acme/api#1")).toHaveLength(1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval asks from when there was one per PR stay, as asks that named no reviewer", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-board-"));
  try {
    const path = join(dir, "board.db");
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE approval_asks (repo TEXT NOT NULL, number INTEGER NOT NULL, asked_at TEXT NOT NULL, bumped_at TEXT,
             slack_url TEXT NOT NULL, PRIMARY KEY (repo, number))`);
    old.run("INSERT INTO approval_asks VALUES ('acme/api', 1, '2026-10-30T01:00:00Z', '2026-10-31T01:00:00Z', 'https://acme.slack.com/archives/C1/p1')");
    old.close();

    const db = openBoardStore(path);
    expect(approvalAsks(db).get("acme/api#1")).toEqual([
      {
        repo: "acme/api",
        number: 1,
        reviewer: null,
        channel: null,
        askedAt: "2026-10-30T01:00:00Z",
        recordedAt: "2026-10-30T01:00:00Z",
        source: "drafted",
        bumpedAt: "2026-10-31T01:00:00Z",
        slackUrl: "https://acme.slack.com/archives/C1/p1",
      },
    ]);
    // It can still be bumped, naming its channel now that a bump found it, and asks per reviewer join it.
    const bump = { repo: "acme/api", number: 1, reviewer: null, channel: "#team", slackUrl: "https://acme.slack.com/archives/C1/p1", bumpedAt: "2026-11-01T01:00:00Z" };
    expect(recordApprovalBump(db, bump)).toBe(true);
    const askedAt = "2026-11-01T02:00:00Z";
    recordApprovalAsk(db, { repo: "acme/api", number: 1, reviewer: "sre", channel: "#sre", slackUrl: "https://app.slack.com/client/T1/C2", askedAt, recordedAt: askedAt, source: "drafted" });
    expect(approvalAsks(db).get("acme/api#1")).toMatchObject([
      { reviewer: null, channel: "#team", bumpedAt: "2026-11-01T01:00:00Z" },
      { reviewer: "sre", channel: "#sre" },
    ]);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'approval_asks_per_pr'").get()).toBeNull();
    db.close();
    // Opening it again leaves it be.
    const reopened = openBoardStore(path);
    expect(approvalAsks(reopened).get("acme/api#1")).toHaveLength(2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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