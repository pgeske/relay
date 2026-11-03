import { describe, expect, test } from "bun:test";
import type { PullRequest } from "./github.ts";
import { buildBoard, type CardOwner, type LocalState } from "./lanes.ts";
import type { AgentRequests, AgentReview, ApprovalAsk, CiFix } from "./store.ts";
import { ACTIVE_REFRESH_SECONDS, REFRESH_SECONDS, boardView, type CardView, type TagView } from "./view.ts";

const now = new Date("2026-11-02T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const KEY = "acme/api#1";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: "acme/api",
    number: 1,
    title: "Fix the thing",
    url: "https://github.com/acme/api/pull/1",
    author: "me",
    authorIsBot: false,
    isDraft: false,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    headSha: "aaa",
    updatedAt: "2026-11-02T00:00:00Z",
    mergedAt: null,
    checks: [{ name: "test", state: "failed" }],
    ...overrides,
  };
}

function owner(status: "working" | "idle" | null = "idle"): CardOwner {
  return { sessionFile: "/sessions/a.jsonl", title: "Fix the thing", how: "opened", live: status ? { paneId: "%1", windowId: "@1", status } : null };
}

function ciFix(overrides: Partial<CiFix> = {}): CiFix {
  return { repo: "acme/api", number: 1, headSha: "aaa", verdict: "fixed", summary: "Retried the flaky integration job.", recordedAt: minutesAgo(5), ...overrides };
}

interface Local {
  owner?: CardOwner | null;
  requests?: AgentRequests;
  ciFix?: CiFix;
  review?: AgentReview;
  approval?: ApprovalAsk;
}

function view(pullRequests: PullRequest[], local: Local = {}, merged: PullRequest[] = []) {
  const state: LocalState = {
    owners: local.owner === null ? {} : { [KEY]: local.owner ?? owner() },
    requests: new Map(local.requests ? [[KEY, local.requests]] : []),
    ciFixes: new Map(local.ciFix ? [[KEY, local.ciFix]] : []),
    reviews: new Map(local.review ? [[KEY, local.review]] : []),
    approvals: new Map(local.approval ? [[KEY, local.approval]] : []),
    now,
  };
  return boardView(buildBoard({ mine: pullRequests, reviewRequested: [], merged }, [], state), { now, updatedAt: now });
}

/** The one card of a board holding a single PR of mine, with the lane it landed in. */
function card(pullRequest: PullRequest, local: Local = {}): CardView & { lane: string } {
  const lane = view([pullRequest], local).lanes.find((candidate) => candidate.cards.length > 0)!;
  return { ...lane.cards[0], lane: lane.id };
}

const texts = (tags: TagView[]) => tags.map((tag) => tag.text);
const steps = (view: CardView) => view.steps.map((step) => step.label);
const ciTag = (view: CardView) => view.tags.find((tag) => tag.kind === "ci");
/** Every control on the card that asks for a CI fix. */
const fixCiControls = (view: CardView) => view.tags.filter((tag) => tag.action?.action === "fix-ci");
// A passed agent review of the current commit puts the PR in Human review.
const passed: AgentReview = { repo: "acme/api", number: 1, headSha: "aaa", verdict: "passed", findings: 0, summary: null, reviewedAt: minutesAgo(60) };

test("lanes come in the order work moves, then Merged", () => {
  expect(view([]).lanes.map((lane) => lane.id)).toEqual(["draft", "agent-review", "human-review", "approved-blocked", "ready", "merged"]);
  expect(view([]).lanes.filter((lane) => lane.hot).map((lane) => lane.id)).toEqual(["approved-blocked", "ready"]);
});

test("a board that never loaded has no lanes, and says why", () => {
  const empty = boardView(null, { now, updatedAt: null, error: "gh: not logged in" });
  expect(empty).toMatchObject({ lanes: [], updatedAt: null, error: "gh: not logged in", agentWorking: false });
});

test("a ticket key leading the title becomes the card's ticket", () => {
  expect(card(pr({ title: "[PROJ-12] Fix it" }))).toMatchObject({ title: "Fix it", ticket: "PROJ-12" });
  expect(card(pr({ title: "PROJ-12: Fix it" }))).toMatchObject({ title: "Fix it", ticket: "PROJ-12" });
  expect(card(pr({ title: "Fix PROJ-12" }))).toMatchObject({ title: "Fix PROJ-12", ticket: null });
});

test("a PR quiet for a week is stale", () => {
  expect(card(pr({ updatedAt: minutesAgo(6 * 24 * 60) }))).toMatchObject({ idleDays: 6, stale: false });
  expect(card(pr({ updatedAt: minutesAgo(9 * 24 * 60) }))).toMatchObject({ idleDays: 9, stale: true });
});

test("the session drops omp's nerd-font icon from its title", () => {
  expect(card(pr(), { owner: { ...owner(), title: "\uF120 Fix the thing" } }).session?.title).toBe("Fix the thing");
});

test("only open cards can be closed, and closing asks first, as a destructive step", () => {
  expect(card(pr()).close?.confirm).toMatchObject({ title: "Close acme/api#1?", button: "Close PR", destructive: true });
  const merged = view([], {}, [pr({ state: "MERGED", mergedAt: minutesAgo(120) })]).lanes.at(-1)!.cards[0];
  expect(merged.close).toBeNull();
  expect(texts(merged.tags)).toEqual(["Merged 2h ago"]);
  expect(merged.steps).toEqual([]);
});

describe("Fix CI", () => {
  test("the red CI tag asks for it on a card whose PR has a session, in any lane", () => {
    for (const view of [card(pr()), card(pr({ isDraft: true })), card(pr({ reviewDecision: "APPROVED" })), card(pr(), { review: passed })]) {
      expect(ciTag(view)).toMatchObject({ tone: "bad", text: "CI red", hint: "Ask the session to fix CI" });
      expect(ciTag(view)?.action).toMatchObject({ action: "fix-ci", confirm: { button: "Fix CI", destructive: false } });
    }
    expect(card(pr(), { review: passed }).lane).toBe("human-review");
  });

  test("is no step button", () => {
    expect(card(pr()).steps.map((step) => step.action)).not.toContain("fix-ci");
  });

  test("a closed session's tag says it reopens it first", () => {
    expect(ciTag(card(pr(), { owner: owner(null) }))?.hint).toBe("Reopen the session in relay and ask it to fix CI");
  });

  test("is not offered when CI isn't red, or no session is in charge", () => {
    expect(fixCiControls(card(pr({ checks: [{ name: "test", state: "passed" }] })))).toEqual([]);
    expect(fixCiControls(card(pr({ checks: [{ name: "test", state: "pending" }] })))).toEqual([]);
    const unowned = card(pr(), { owner: null });
    expect(fixCiControls(unowned)).toEqual([]);
    expect(ciTag(unowned)).toMatchObject({ tone: "bad", text: "CI red", action: null });
  });

  test("in progress: the card's running tag follows a plain CI tag", () => {
    const view = card(pr(), { requests: { "fix-ci": minutesAgo(1) } });
    expect(view.tags.slice(0, 2)).toMatchObject([
      { kind: "ci", text: "CI red", action: null },
      { kind: "request", tone: "wait", text: "Agent fixing CI…", running: true },
    ]);
    expect(fixCiControls(view)).toEqual([]);
  });

  test("stalled: the card says so, and that tag asks again", () => {
    const stalled = card(pr(), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") }).tags.find((tag) => tag.kind === "ci-fix");
    expect(stalled).toMatchObject({ text: "CI fix stopped without a result", hint: "Ask the session to fix CI again", action: { action: "fix-ci" } });
  });

  test("stalled once CI is no longer red: just a note", () => {
    const view = card(pr({ checks: [{ name: "test", state: "pending" }] }), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") });
    expect(view.tags).toContainEqual(expect.objectContaining({ tone: "warn", text: "CI fix stopped without a result", action: null }));
    expect(fixCiControls(view)).toEqual([]);
  });

  test("fixed at the current commit: the CI tag gets a marker that opens the write-up", () => {
    const tag = ciTag(card(pr({ checks: [{ name: "test", state: "pending" }] }), { ciFix: ciFix() }));
    expect(tag).toMatchObject({ text: "CI running*", detail: { title: "CI fix", verdict: "Fixed", tone: "ok", commit: "aaa", summary: "Retried the flaky integration job." } });
  });

  test("fixed, then a new commit: the marker and write-up are gone", () => {
    const view = card(pr({ headSha: "bbb", checks: [{ name: "test", state: "passed" }] }), { ciFix: ciFix({ headSha: "aaa" }) });
    expect(ciTag(view)).toMatchObject({ tone: "ok", text: "CI green", detail: null });
    expect(view.tags.some((tag) => tag.detail?.title === "CI fix")).toBe(false);
  });

  test("not fixed: a tag says so and opens why, and Fix CI stays on offer", () => {
    const view = card(pr(), { ciFix: ciFix({ verdict: "not-fixed", summary: "The staging registry is down; nothing to fix in the PR." }) });
    expect(view.tags).toContainEqual(
      expect.objectContaining({ text: "Agent couldn't fix CI", detail: expect.objectContaining({ verdict: "Couldn't fix", summary: "The staging registry is down; nothing to fix in the PR." }) }),
    );
    expect(fixCiControls(view)).toHaveLength(1);
  });

  test("a newer request outranks the last result", () => {
    const view = card(pr(), { ciFix: ciFix({ verdict: "not-fixed" }), requests: { "fix-ci": minutesAgo(1) } });
    expect(texts(view.tags)).toContain("Agent fixing CI…");
    expect(texts(view.tags)).not.toContain("Agent couldn't fix CI");
  });
});

describe("Merge", () => {
  const ready = pr({ reviewDecision: "APPROVED", checks: [{ name: "test", state: "passed" }] });

  test("is offered in Ready to merge, and asks first", () => {
    const view = card(ready);
    expect(view.lane).toBe("ready");
    expect(view.steps).toMatchObject([{ action: "merge", label: "Merge", running: "Agent merging…", confirm: { title: "Merge acme/api#1?" } }]);
  });

  test("in progress: the card's tag runs instead of offering it", () => {
    const view = card(ready, { requests: { merge: minutesAgo(1) } });
    expect(view.tags).toContainEqual(expect.objectContaining({ text: "Agent merging…", running: true }));
    expect(view.steps).toEqual([]);
    expect(view.session?.busy).toBe(true);
  });

  test("stalled: the card says so and offers it again", () => {
    const view = card(ready, { requests: { merge: minutesAgo(10) }, owner: owner(null) });
    expect(texts(view.tags)).toContain("Merge stopped without a result");
    expect(steps(view)).toEqual(["Merge Again"]);
    expect(view.steps[0].hint).toBe("Reopens the session in relay, then asks it to merge this PR");
  });
});

test("Review is offered in Agent review, without asking first", () => {
  const view = card(pr({ checks: [] }));
  expect(view.lane).toBe("agent-review");
  expect(view.steps).toMatchObject([{ action: "review", label: "Review", hint: "Asks the session to review this PR", confirm: null }]);
  expect(view.tags).toMatchObject([{ kind: "agent-review", tone: "ghost", text: "No agent review", detail: null }]);
});

test("an agent review's tag opens what it said, and says when it's out of date", () => {
  const findings: AgentReview = { ...passed, verdict: "findings", findings: 2, summary: "1. retry.go never resets." };
  expect(card(pr(), { review: findings }).tags).toContainEqual(
    expect.objectContaining({ text: "Agent: 2 findings", detail: expect.objectContaining({ verdict: "2 findings", summary: "1. retry.go never resets.", note: null }) }),
  );
  const outdated = card(pr({ headSha: "bbb" }), { review: passed }).tags.find((tag) => tag.kind === "agent-review");
  expect(outdated).toMatchObject({ text: "Agent review out of date", detail: { verdict: "Passed", note: expect.stringContaining("New commits landed") } });
});

test("while one request runs, the card offers no other step", () => {
  const view = card(pr(), { requests: { review: minutesAgo(1) } });
  expect(texts(view.tags)).toContain("Agent reviewing…");
  expect(view.steps).toEqual([]);
  expect(fixCiControls(view)).toEqual([]);
});

describe("refresh", () => {
  const board = (requests?: AgentRequests) => view([pr()], { owner: owner("idle"), requests });

  test("every minute when nothing runs, a stalled request included", () => {
    for (const result of [board(), board({ merge: minutesAgo(10) })]) {
      expect(result).toMatchObject({ agentWorking: false, refreshSeconds: REFRESH_SECONDS });
    }
  });

  test(`every ${ACTIVE_REFRESH_SECONDS}s while a session runs a request`, () => {
    expect(board({ merge: minutesAgo(0.5) })).toMatchObject({ agentWorking: true, refreshSeconds: ACTIVE_REFRESH_SECONDS });
  });
});

describe("Ask for Approval, then Bump", () => {
  const green = [{ name: "test", state: "passed" as const }];
  const waiting = pr({ checks: green });
  const asked = (overrides: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
    repo: "acme/api",
    number: 1,
    askedAt: minutesAgo(2 * 24 * 60),
    bumpedAt: null,
    slackUrl: "https://app.slack.com/client/T1/C1",
    ...overrides,
  });
  const approvalTag = (view: CardView) => view.tags.find((tag) => tag.kind === "approval");

  test("no ask recorded: the card offers Ask for Approval", () => {
    const view = card(waiting, { review: passed });
    expect(view.steps).toMatchObject([{ action: "ask-approval", label: "Ask for Approval", confirm: { button: "Draft Ask" } }]);
    expect(approvalTag(view)).toBeUndefined();
  });

  test("ask recorded: a tag opens it in Slack, and the card offers Bump", () => {
    const view = card(waiting, { review: passed, approval: asked() });
    expect(approvalTag(view)).toMatchObject({ tone: "link", text: "Approval asked 2d ago", link: "https://app.slack.com/client/T1/C1" });
    expect(view.steps).toMatchObject([{ action: "bump", label: "Bump", confirm: { button: "Draft Bump" } }]);
  });

  test("bumped: the tag says when, and links to the message as sent", () => {
    const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
    const view = card(waiting, { review: passed, approval: asked({ bumpedAt: minutesAgo(24 * 60), slackUrl: permalink }) });
    expect(approvalTag(view)).toMatchObject({ text: "Bumped 1d ago", link: permalink });
    expect(steps(view)).toEqual(["Bump"]);
  });

  test("outside Human review, neither the tag nor the steps show", () => {
    const view = card(pr({ checks: green, reviewDecision: "APPROVED" }), { review: passed, approval: asked() });
    expect(approvalTag(view)).toBeUndefined();
    expect(view.steps.map((step) => step.action)).toEqual(["merge"]);
  });

  test.each([
    ["ask-approval", "Agent drafting approval ask…"],
    ["bump", "Agent drafting bump…"],
  ] as const)("%s in progress: the card's tag runs instead of offering a step", (action, running) => {
    const view = card(waiting, { review: passed, approval: action === "bump" ? asked() : undefined, requests: { [action]: minutesAgo(1) } });
    expect(view.tags).toContainEqual(expect.objectContaining({ kind: "request", text: running, running: true }));
    expect(view.steps).toEqual([]);
  });

  test("ask stalled: the card says so and offers it again", () => {
    const view = card(waiting, { review: passed, requests: { "ask-approval": minutesAgo(10) } });
    expect(texts(view.tags)).toContain("Approval ask stopped without a result");
    expect(steps(view)).toEqual(["Ask for Approval Again"]);
  });

  test("bump stalled: the card says so, keeps the link, and offers it again", () => {
    const view = card(waiting, { review: passed, approval: asked(), requests: { bump: minutesAgo(10) } });
    expect(texts(view.tags)).toContain("Bump stopped without a result");
    expect(texts(view.tags)).toContain("Approval asked 2d ago");
    expect(steps(view)).toEqual(["Bump Again"]);
  });

  test("an ask recorded after the request finishes it, and Bump takes over", () => {
    const view = card(waiting, { review: passed, approval: asked({ askedAt: minutesAgo(1) }), requests: { "ask-approval": minutesAgo(3) } });
    expect(texts(view.tags)).not.toContain("Agent drafting approval ask…");
    expect(texts(view.tags)).toContain("Approval asked 1m ago");
    expect(steps(view)).toEqual(["Bump"]);
  });
});
