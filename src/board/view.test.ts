import { describe, expect, test } from "bun:test";
import type { PullRequest } from "./github.ts";
import { buildBoard, type CardOwner, type LocalState } from "./lanes.ts";
import type { AgentRequests, AgentReview, ApprovalAsk, CiFix } from "./store.ts";
import { ACTIVE_REFRESH_SECONDS, REFRESH_SECONDS, boardView, type CardView, type RowView } from "./view.ts";

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
    mergeState: "CLEAN",
    approvedBy: [],
    waitingOn: [],
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

const steps = (view: CardView) => view.steps.map((step) => step.label);
const kinds = (view: CardView) => view.rows.map((row) => row.kind);
const rowOf = (view: CardView, kind: RowView["kind"]) => view.rows.find((row) => row.kind === kind);
const notices = (view: CardView) => view.notices.map((notice) => notice.text);
/** Every control on the card that asks for a CI fix. */
const fixCiControls = (view: CardView) => [...view.rows.map((row) => row.action), ...view.steps].filter((action) => action?.action === "fix-ci");
const green = [{ name: "test", state: "passed" as const }];
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

test("a PR quiet for a week is stale, and its age says so as a warning", () => {
  expect(card(pr({ updatedAt: minutesAgo(6 * 24 * 60) }))).toMatchObject({ idleDays: 6, stale: false, age: { text: "6d", tone: "muted" } });
  expect(card(pr({ updatedAt: minutesAgo(9 * 24 * 60) }))).toMatchObject({ idleDays: 9, stale: true, age: { text: "Stale 9d", tone: "warn" } });
  expect(card(pr({ updatedAt: minutesAgo(60) })).age.text).toBe("Today");
});

test("the session drops omp's nerd-font icon from its title", () => {
  expect(card(pr(), { owner: { ...owner(), title: "\uF120 Fix the thing" } }).session?.title).toBe("Fix the thing");
});

test("only open cards can be closed, and closing asks first, as a destructive step", () => {
  expect(card(pr()).close?.confirm).toMatchObject({ title: "Close acme/api#1?", button: "Close PR", destructive: true });
});

test("a merged card is just its header and title", () => {
  const merged = view([], {}, [pr({ state: "MERGED", mergedAt: minutesAgo(120) })]).lanes.at(-1)!.cards[0];
  expect(merged).toMatchObject({ age: { text: "Merged 2h ago" }, rows: [], notices: [], steps: [], running: null, close: null });
});

describe("status rows", () => {
  const approved = { reviewDecision: "APPROVED" as const, approvedBy: ["pat", "sara"] };

  test("each lane shows only the rows that matter there, in a fixed order", () => {
    const asked: ApprovalAsk = { repo: "acme/api", number: 1, askedAt: minutesAgo(20), bumpedAt: null, slackUrl: "https://app.slack.com/client/T1/C1" };
    const cases: [PullRequest, Local, string, RowView["kind"][]][] = [
      [pr({ isDraft: true }), {}, "draft", ["ci"]],
      [pr(), {}, "agent-review", ["ci", "agent"]],
      [pr({ checks: green }), { review: passed }, "human-review", ["ci", "agent", "approvals"]],
      [pr({ checks: green }), { review: passed, approval: asked }, "human-review", ["ci", "agent", "approvals", "slack"]],
      [pr({ ...approved, mergeState: "DIRTY", checks: green }), { approval: asked }, "approved-blocked", ["ci", "approvals"]],
      [pr({ ...approved, checks: green }), { approval: asked }, "ready", ["ci", "approvals"]],
    ];
    for (const [pullRequest, local, lane, rows] of cases) {
      const shown = card(pullRequest, local);
      expect(shown.lane).toBe(lane);
      expect(kinds(shown)).toEqual(rows);
    }
  });

  test("CI reads as its state, toned to match", () => {
    expect(rowOf(card(pr({ checks: green })), "ci")).toMatchObject({ label: "CI", tone: "ok", value: "Green", action: null });
    expect(rowOf(card(pr({ checks: [{ name: "test", state: "pending" }] })), "ci")).toMatchObject({ tone: "wait", value: "Running" });
    expect(rowOf(card(pr({ checks: [] })), "ci")).toMatchObject({ tone: "muted", value: "No checks" });
  });

  test("a calm card has no notices", () => {
    expect(card(pr({ ...approved, checks: green })).notices).toEqual([]);
    expect(card(pr({ checks: green }), { review: passed }).notices).toEqual([]);
  });
});

describe("Fix CI", () => {
  test("red CI asks for it on a card whose PR has a session, in any lane", () => {
    for (const view of [card(pr()), card(pr({ isDraft: true })), card(pr({ reviewDecision: "APPROVED" })), card(pr(), { review: passed })]) {
      expect(rowOf(view, "ci")).toMatchObject({ tone: "bad", value: "Red", hint: "Ask the session to fix CI" });
      expect(rowOf(view, "ci")?.action).toMatchObject({ action: "fix-ci", confirm: { button: "Fix CI", destructive: false } });
    }
    expect(card(pr(), { review: passed }).lane).toBe("human-review");
  });

  test("is no step button", () => {
    expect(card(pr()).steps.map((step) => step.action)).not.toContain("fix-ci");
  });

  test("a closed session's row says it reopens it first", () => {
    expect(rowOf(card(pr(), { owner: owner(null) }), "ci")?.hint).toBe("Reopen the session in relay and ask it to fix CI");
  });

  test("is not offered when CI isn't red, or no session is in charge", () => {
    expect(fixCiControls(card(pr({ checks: green })))).toEqual([]);
    expect(fixCiControls(card(pr({ checks: [{ name: "test", state: "pending" }] })))).toEqual([]);
    const unowned = card(pr(), { owner: null });
    expect(fixCiControls(unowned)).toEqual([]);
    expect(rowOf(unowned, "ci")).toMatchObject({ tone: "bad", value: "Red", action: null });
  });

  test("in progress: the CI row says the agent is on it, and nothing else runs in the footer", () => {
    const view = card(pr(), { requests: { "fix-ci": minutesAgo(1) } });
    expect(rowOf(view, "ci")).toMatchObject({ value: "Red · agent fixing…", running: true, action: null });
    expect(view).toMatchObject({ running: null, steps: [], notices: [] });
    expect(fixCiControls(view)).toEqual([]);
  });

  test("stalled: a notice says so, and the CI row asks again", () => {
    const view = card(pr(), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") });
    expect(rowOf(view, "ci")).toMatchObject({ tone: "bad", value: "Red", hint: "Ask the session to fix CI again", action: { action: "fix-ci", label: "Fix CI Again" } });
    expect(view.notices).toMatchObject([{ tone: "warn", text: "CI fix stopped without a result" }]);
    expect(fixCiControls(view)).toHaveLength(1);
  });

  test("stalled once CI is no longer red: just a notice", () => {
    const view = card(pr({ checks: [{ name: "test", state: "pending" }] }), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") });
    expect(view.notices).toMatchObject([{ tone: "warn", text: "CI fix stopped without a result" }]);
    expect(rowOf(view, "ci")).toMatchObject({ value: "Running", action: null });
    expect(fixCiControls(view)).toEqual([]);
  });

  test("fixed at the current commit: the CI value gets a marker that opens the write-up", () => {
    const row = rowOf(card(pr({ checks: [{ name: "test", state: "pending" }] }), { ciFix: ciFix() }), "ci");
    expect(row).toMatchObject({ value: "Running*", detail: { title: "CI fix", verdict: "Fixed", tone: "ok", commit: "aaa", summary: "Retried the flaky integration job." } });
  });

  test("fixed, then red again: red CI asks for another fix, and a notice opens the last write-up", () => {
    const view = card(pr(), { ciFix: ciFix() });
    expect(rowOf(view, "ci")?.action?.action).toBe("fix-ci");
    expect(view.notices).toMatchObject([{ tone: "warn", detail: { verdict: "Fixed" } }]);
  });

  test("fixed, then a new commit: the marker and write-up are gone", () => {
    const view = card(pr({ headSha: "bbb", checks: green }), { ciFix: ciFix({ headSha: "aaa" }) });
    expect(rowOf(view, "ci")).toMatchObject({ tone: "ok", value: "Green", detail: null });
    expect(view.notices).toEqual([]);
  });

  test("not fixed: a notice says so and opens why, and Fix CI stays on offer", () => {
    const view = card(pr(), { ciFix: ciFix({ verdict: "not-fixed", summary: "The staging registry is down; nothing to fix in the PR." }) });
    expect(view.notices).toMatchObject([
      { tone: "bad", text: "Agent couldn't fix CI", detail: { verdict: "Couldn't fix", summary: "The staging registry is down; nothing to fix in the PR." } },
    ]);
    expect(fixCiControls(view)).toHaveLength(1);
  });

  test("a newer request outranks the last result", () => {
    const view = card(pr(), { ciFix: ciFix({ verdict: "not-fixed" }), requests: { "fix-ci": minutesAgo(1) } });
    expect(rowOf(view, "ci")?.running).toBe(true);
    expect(view.notices).toEqual([]);
  });
});

describe("Merge", () => {
  const ready = pr({ reviewDecision: "APPROVED", checks: green });

  test("is offered in Ready to merge, and asks first", () => {
    const view = card(ready);
    expect(view.lane).toBe("ready");
    expect(view.steps).toMatchObject([{ action: "merge", label: "Merge", running: "Agent merging…", confirm: { title: "Merge acme/api#1?" } }]);
  });

  test("in progress: the footer says the agent is merging instead of offering it", () => {
    const view = card(ready, { requests: { merge: minutesAgo(1) } });
    expect(view).toMatchObject({ running: "Agent merging…", steps: [], session: { busy: true } });
  });

  test("stalled: a notice says so, and the card offers it again", () => {
    const view = card(ready, { requests: { merge: minutesAgo(10) }, owner: owner(null) });
    expect(view.notices).toMatchObject([{ tone: "warn", text: "Merge stopped without a result" }]);
    expect(view.running).toBeNull();
    expect(steps(view)).toEqual(["Merge Again"]);
    expect(view.steps[0].hint).toBe("Reopens the session in relay, then asks it to merge this PR");
  });
});

describe("Approvals", () => {
  const gate = (title: string, state: "pending" | "failed" = "pending") => ({ name: "merge-queue/gate", state, title });
  const gated = (overrides: Partial<PullRequest>, gateTitle: string, state?: "pending" | "failed") => {
    const check = gate(gateTitle, state);
    const pullRequest = pr({ checks: [{ name: "test", state: "passed" }, check], ...overrides });
    const board = buildBoard({ mine: [pullRequest], reviewRequested: [], merged: [] }, [check.name], { owners: { [KEY]: owner() }, now });
    const lane = boardView(board, { now, updatedAt: now }).lanes.find((candidate) => candidate.cards.length > 0)!;
    return { ...lane.cards[0], lane: lane.id };
  };

  test("a gate that counts missing approvals reads as how many of how many, and who the PR waits on", () => {
    const view = gated({ reviewDecision: "APPROVED", mergeState: "BLOCKED", approvedBy: ["pat"], waitingOn: ["cache-team"] }, "1 pending: 1 approval missing");
    expect(view.lane).toBe("human-review");
    expect(rowOf(view, "approvals")).toMatchObject({ tone: "wait", value: "1 of 2 · needs cache-team", hint: "Approved by pat; still waiting on cache-team" });
    expect(view.notices).toEqual([]);
    expect(steps(view)).toEqual(["Ask for Approval"]);
  });

  test("without a count, the approvals so far; more than two reviewers fold into +n", () => {
    const view = card(pr({ checks: green, approvedBy: ["pat"], waitingOn: ["a", "b", "c", "d"] }));
    expect(rowOf(view, "approvals")?.value).toBe("1 approval · needs a, b, +2");
    expect(rowOf(card(pr({ checks: green }), { review: passed }), "approvals")?.value).toBe("None yet");
  });

  test("changes requested reads as bad", () => {
    const view = card(pr({ checks: green, reviewDecision: "CHANGES_REQUESTED", approvedBy: ["pat"] }));
    expect(rowOf(view, "approvals")).toMatchObject({ tone: "bad", value: "Changes requested" });
  });

  test("fully approved reads as ok, and what still blocks the merge is an urgent notice", () => {
    const conflicted = card(pr({ reviewDecision: "APPROVED", approvedBy: ["pat", "sara"], mergeState: "DIRTY", checks: green }));
    expect(conflicted.lane).toBe("approved-blocked");
    expect(rowOf(conflicted, "approvals")).toMatchObject({ tone: "ok", value: "2 approvals" });
    expect(conflicted.notices).toMatchObject([{ tone: "bad", text: "Merge conflicts" }]);
    const failedGate = gated({ reviewDecision: "APPROVED", approvedBy: ["pat"] }, "Frozen for the holidays", "failed");
    expect(failedGate.notices).toMatchObject([{ tone: "bad", text: "Frozen for the holidays" }]);
  });

  test("a blocker besides people while approvals are still due is a milder notice", () => {
    const view = card(pr({ checks: green, approvedBy: ["pat"], mergeState: "BEHIND" }));
    expect(view.lane).toBe("human-review");
    expect(view.notices).toMatchObject([{ tone: "warn", text: "Behind its base branch" }]);
  });
});

describe("Agent review", () => {
  test("Review is offered in Agent review, without asking first, and the row says none ran yet", () => {
    const view = card(pr({ checks: [] }));
    expect(view.lane).toBe("agent-review");
    expect(view.steps).toMatchObject([{ action: "review", label: "Review", hint: "Asks the session to review this PR", confirm: null }]);
    expect(rowOf(view, "agent")).toMatchObject({ label: "Agent", tone: "ghost", value: "Not run", detail: null });
  });

  test("the row opens what the review said, and says when it's out of date", () => {
    expect(rowOf(card(pr({ checks: green }), { review: passed }), "agent")).toMatchObject({ tone: "ok", value: "Passed", detail: { verdict: "Passed", note: null } });
    const findings: AgentReview = { ...passed, verdict: "findings", findings: 2, summary: "1. retry.go never resets." };
    expect(rowOf(card(pr(), { review: findings }), "agent")).toMatchObject({ tone: "wait", value: "2 findings", detail: { verdict: "2 findings", summary: "1. retry.go never resets." } });
    const outdated = rowOf(card(pr({ headSha: "bbb" }), { review: passed }), "agent");
    expect(outdated).toMatchObject({ tone: "wait", value: "Out of date", detail: { verdict: "Passed", note: expect.stringContaining("New commits landed") } });
  });

  test("in progress: the row says so, and the card offers no other step", () => {
    const view = card(pr(), { requests: { review: minutesAgo(1) } });
    expect(rowOf(view, "agent")).toMatchObject({ value: "Reviewing…", running: true });
    expect(view).toMatchObject({ running: null, steps: [] });
    expect(fixCiControls(view)).toEqual([]);
    expect(rowOf(view, "ci")).toMatchObject({ value: "Red", action: null });
  });

  test("stalled: a notice says so, and Review is offered again", () => {
    const view = card(pr(), { requests: { review: minutesAgo(10) } });
    expect(notices(view)).toEqual(["Review stopped without a result"]);
    expect(steps(view)).toEqual(["Review Again"]);
  });
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
  const waiting = pr({ checks: green });
  const asked = (overrides: Partial<ApprovalAsk> = {}): ApprovalAsk => ({
    repo: "acme/api",
    number: 1,
    askedAt: minutesAgo(2 * 24 * 60),
    bumpedAt: null,
    slackUrl: "https://app.slack.com/client/T1/C1",
    ...overrides,
  });
  const slack = (view: CardView) => rowOf(view, "slack");

  test("no ask recorded: the card offers Ask for Approval", () => {
    const view = card(waiting, { review: passed });
    expect(view.steps).toMatchObject([{ action: "ask-approval", label: "Ask for Approval", confirm: { button: "Draft Ask" } }]);
    expect(slack(view)).toBeUndefined();
  });

  test("ask recorded: the Slack row opens it, and the card offers Bump", () => {
    const view = card(waiting, { review: passed, approval: asked() });
    expect(slack(view)).toMatchObject({ label: "Slack", tone: "link", value: "Asked 2d ago", link: "https://app.slack.com/client/T1/C1" });
    expect(view.steps).toMatchObject([{ action: "bump", label: "Bump", confirm: { button: "Draft Bump" } }]);
  });

  test("bumped: the row says when, and links to the message as sent", () => {
    const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
    const view = card(waiting, { review: passed, approval: asked({ bumpedAt: minutesAgo(24 * 60), slackUrl: permalink }) });
    expect(slack(view)).toMatchObject({ value: "Bumped 1d ago", link: permalink });
    expect(steps(view)).toEqual(["Bump"]);
  });

  test("outside Human review, neither the row nor the steps show", () => {
    const view = card(pr({ checks: green, reviewDecision: "APPROVED" }), { review: passed, approval: asked() });
    expect(slack(view)).toBeUndefined();
    expect(view.steps.map((step) => step.action)).toEqual(["merge"]);
  });

  test.each([
    ["ask-approval", "Agent drafting approval ask…"],
    ["bump", "Agent drafting bump…"],
  ] as const)("%s in progress: the footer runs it instead of offering a step", (action, running) => {
    const view = card(waiting, { review: passed, approval: action === "bump" ? asked() : undefined, requests: { [action]: minutesAgo(1) } });
    expect(view).toMatchObject({ running, steps: [] });
  });

  test("ask stalled: a notice says so, and the card offers it again", () => {
    const view = card(waiting, { review: passed, requests: { "ask-approval": minutesAgo(10) } });
    expect(notices(view)).toEqual(["Approval ask stopped without a result"]);
    expect(steps(view)).toEqual(["Ask for Approval Again"]);
  });

  test("bump stalled: a notice says so, the link stays, and the card offers it again", () => {
    const view = card(waiting, { review: passed, approval: asked(), requests: { bump: minutesAgo(10) } });
    expect(notices(view)).toEqual(["Bump stopped without a result"]);
    expect(slack(view)?.value).toBe("Asked 2d ago");
    expect(steps(view)).toEqual(["Bump Again"]);
  });

  test("an ask recorded after the request finishes it, and Bump takes over", () => {
    const view = card(waiting, { review: passed, approval: asked({ askedAt: minutesAgo(1) }), requests: { "ask-approval": minutesAgo(3) } });
    expect(view.running).toBeNull();
    expect(slack(view)?.value).toBe("Asked 1m ago");
    expect(steps(view)).toEqual(["Bump"]);
  });
});
