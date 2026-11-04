import { describe, expect, test } from "bun:test";
import type { Check, PullRequest } from "./github.ts";
import { approvalState, approvalStep, buildBoard, ciFixState, ciState, requestProgress, waitingAsks, type ApprovalState, type Lane, type RequestResults } from "./lanes.ts";
import { AGENT_ACTIONS, type AgentReview, type ApprovalAsk, type CiFix } from "./store.ts";

const GATE = "merge-queue/gate";

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
    approvedFor: [],
    waitingOn: [],
    headSha: "aaa",
    updatedAt: "2026-10-30T00:00:00Z",
    mergedAt: null,
    checks: [{ name: "test", state: "passed" }],
    ...overrides,
  };
}

function review(overrides: Partial<AgentReview> = {}): AgentReview {
  return { repo: "acme/api", number: 1, headSha: "aaa", verdict: "passed", findings: 0, summary: null, reviewedAt: "2026-10-30T01:00:00Z", ...overrides };
}

function ciFix(overrides: Partial<CiFix> = {}): CiFix {
  return { repo: "acme/api", number: 1, headSha: "aaa", verdict: "fixed", summary: null, recordedAt: "2026-10-30T01:00:00Z", ...overrides };
}

/** A drafted ask, recorded when it was asked unless `overrides` says otherwise. */
function approvalAsk(overrides: Partial<ApprovalAsk> = {}): ApprovalAsk {
  const askedAt = overrides.askedAt ?? "2026-10-30T01:00:00Z";
  return {
    repo: "acme/api",
    number: 1,
    reviewer: "cache-team",
    channel: "#cache-team",
    askedAt,
    recordedAt: askedAt,
    source: "drafted",
    bumpedAt: null,
    slackUrl: "https://app.slack.com/client/T1/C1",
    ...overrides,
  };
}

/** The approval state of a PR waiting on `waitingOn`, approved by `approvedBy` (people) and `approvedFor` (teams). */
function approval(asks: ApprovalAsk[], reviewers: { waitingOn?: string[]; approvedBy?: string[]; approvedFor?: string[] } = {}): ApprovalState {
  return approvalState({ waitingOn: [], approvedBy: [], approvedFor: [], ...reviewers }, asks);
}

/** The lane the board puts a single PR in. */
function laneOf(pullRequest: PullRequest, agentReview?: AgentReview): Lane {
  const reviews = new Map(agentReview ? [[`${pullRequest.repo}#${pullRequest.number}`, agentReview]] : []);
  const board = buildBoard({ mine: [pullRequest], reviewRequested: [], merged: [] }, [GATE], { reviews });
  const lane = (Object.keys(board.lanes) as Lane[]).find((name) => board.lanes[name].length > 0);
  if (!lane) throw new Error("PR landed in no lane");
  return lane;
}

describe("ciState", () => {
  const running = (name: string): Check => ({ name, state: "pending" });

  test("a running gate check is not CI", () => {
    expect(ciState([{ name: "test", state: "passed" }, running(GATE)], [GATE])).toBe("passed");
  });

  test("a failure outranks checks that are still running", () => {
    expect(ciState([{ name: "lint", state: "failed" }, running("test")], [])).toBe("failed");
  });

  test("only gate checks means there is no CI", () => {
    expect(ciState([running(GATE)], [GATE])).toBe("none");
  });
});

describe("lanes", () => {
  test("a draft stays a draft, whatever its reviews say", () => {
    expect(laneOf(pr({ isDraft: true, reviewDecision: "APPROVED" }), review())).toBe("draft");
  });

  test("a PR without an agent review waits on one", () => {
    expect(laneOf(pr())).toBe("agent-review");
  });

  test("a passed agent review of the current commit hands the PR to humans", () => {
    expect(laneOf(pr(), review())).toBe("human-review");
  });

  test("a review with findings keeps the PR in agent review", () => {
    expect(laneOf(pr(), review({ verdict: "findings", findings: 3 }))).toBe("agent-review");
  });

  test("a passed review of an older commit no longer counts", () => {
    expect(laneOf(pr({ headSha: "bbb" }), review({ headSha: "aaa" }))).toBe("agent-review");
  });

  test("human approval outranks a missing agent review", () => {
    expect(laneOf(pr({ reviewDecision: "APPROVED" }))).toBe("ready");
  });

  test("an approved PR whose gate check failed is blocked even with green CI", () => {
    const checks: Check[] = [{ name: "test", state: "passed" }, { name: GATE, state: "failed" }];
    expect(laneOf(pr({ reviewDecision: "APPROVED", checks }))).toBe("approved-blocked");
  });

  test("an approved PR waiting only on its running gate check is ready while GitHub would merge it", () => {
    const checks: Check[] = [{ name: "test", state: "passed" }, { name: GATE, state: "pending" }];
    expect(laneOf(pr({ reviewDecision: "APPROVED", checks }))).toBe("ready");
  });

  test("a PR its merge gate still wants approvals for stays in Human review, even approved and without an agent review", () => {
    const checks: Check[] = [{ name: "test", state: "passed" }, { name: GATE, state: "pending", title: "1 pending: 1 approval missing" }];
    const card = buildBoard({ mine: [pr({ reviewDecision: "APPROVED", mergeState: "BLOCKED", checks })], reviewRequested: [], merged: [] }, [GATE]).lanes["human-review"][0];
    expect(card?.mergeBlocker).toBe("1 approval missing");
  });

  test("a partly approved PR stays in Human review without an agent review", () => {
    expect(laneOf(pr({ approvedBy: ["pat"] }))).toBe("human-review");
  });

  test("a fully approved PR GitHub won't merge is blocked: conflicts, branch rules", () => {
    expect(laneOf(pr({ reviewDecision: "APPROVED", mergeState: "DIRTY" }))).toBe("approved-blocked");
    expect(laneOf(pr({ reviewDecision: "APPROVED", mergeState: "BLOCKED" }))).toBe("approved-blocked");
  });

  test("an approved PR with CI still running is not ready yet", () => {
    expect(laneOf(pr({ reviewDecision: "APPROVED", checks: [{ name: "test", state: "pending" }] }))).toBe("approved-blocked");
  });
});

test("bot review requests are counted per bot, not listed", () => {
  const bot = (n: number, author: string) => pr({ number: n, url: `u${n}`, author, authorIsBot: true });
  const board = buildBoard(
    {
      mine: [],
      reviewRequested: [bot(1, "renovate-1a2b3c"), bot(2, "renovate-1a2b3c"), bot(3, "dependabot[bot]"), pr({ number: 4, author: "teammate" })],
      merged: [],
    },
    [],
  );
  expect(board.bots).toEqual([
    { name: "renovate", count: 2 },
    { name: "dependabot", count: 1 },
  ]);
  expect(board.teammates.map((p) => p.author)).toEqual(["teammate"]);
});

describe("a PR search still lists as open after it merged or closed", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const requests = new Map([["acme/api#1", { merge: new Date(now.getTime() - 60_000).toISOString() }]]);
  const working = { "acme/api#1": { sessionFile: "/s.jsonl", title: "", how: "opened" as const, live: { paneId: "%1", windowId: "@1", status: "working" as const } } };
  const approved = { reviewDecision: "APPROVED" as const };

  test("a merged one leaves the lanes for Merged, which finishes its merge request", () => {
    const mergedPr = pr({ ...approved, state: "MERGED", mergedAt: "2026-11-02T11:59:30Z" });
    const board = buildBoard({ mine: [mergedPr], reviewRequested: [], merged: [] }, [], { requests, owners: working, now });
    expect(Object.values(board.lanes).flat()).toEqual([]);
    expect(board.merged).toEqual([mergedPr]);
  });

  test("a merged one the merged search already has shows there once", () => {
    const mergedPr = pr({ ...approved, state: "MERGED", mergedAt: "2026-11-02T11:59:30Z" });
    const board = buildBoard({ mine: [mergedPr], reviewRequested: [], merged: [mergedPr] }, [], { now });
    expect(board.merged).toHaveLength(1);
  });

  test("a closed one leaves the board", () => {
    const board = buildBoard({ mine: [pr({ ...approved, state: "CLOSED" })], reviewRequested: [], merged: [] }, [], { requests, owners: working, now });
    expect(Object.values(board.lanes).flat()).toEqual([]);
    expect(board.merged).toEqual([]);
  });

  test("while it is still open, its merge request keeps running", () => {
    const board = buildBoard({ mine: [pr(approved)], reviewRequested: [], merged: [] }, [], { requests, owners: working, now });
    expect(board.lanes.ready[0].requests.merge).toBe("running");
  });
});

describe("requestProgress", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const live = (status: "working" | "idle") => ({ paneId: "%1", windowId: "@1", status });
  const open: RequestResults = { mergedAt: null };

  test.each(AGENT_ACTIONS)("a %s request runs while its session works on it", (action) => {
    expect(requestProgress({ [action]: minutesAgo(30) }, open, live("working"), now)[action]).toBe("running");
  });

  test.each(AGENT_ACTIONS)("a %s request just sent counts as running before the session picks it up", (action) => {
    expect(requestProgress({ [action]: minutesAgo(0.5) }, open, null, now)[action]).toBe("running");
  });

  test.each(AGENT_ACTIONS)("a %s request whose session went idle or closed without finishing it has stalled", (action) => {
    expect(requestProgress({ [action]: minutesAgo(10) }, open, live("idle"), now)[action]).toBe("stalled");
    expect(requestProgress({ [action]: minutesAgo(10) }, open, null, now)[action]).toBe("stalled");
  });

  test("no request, or a long-abandoned one, shows nothing", () => {
    expect(requestProgress(undefined, open, live("working"), now)).toEqual({ review: "none", merge: "none", "fix-ci": "none", "ask-approval": "none", bump: "none" });
    expect(requestProgress({ review: minutesAgo(7 * 60) }, open, live("working"), now).review).toBe("none");
  });

  test("a review request finishes when a review is recorded after it", () => {
    const requests = { review: minutesAgo(10) };
    expect(requestProgress(requests, { mergedAt: null, review: review({ reviewedAt: minutesAgo(2) }) }, live("working"), now).review).toBe("none");
    // A review from before the request doesn't answer it.
    expect(requestProgress(requests, { mergedAt: null, review: review({ reviewedAt: minutesAgo(20) }) }, live("idle"), now).review).toBe("stalled");
  });

  test("a CI-fix request finishes when a result is recorded after it, fixed or not", () => {
    const requests = { "fix-ci": minutesAgo(10) };
    const finished = (fix: CiFix) => requestProgress(requests, { mergedAt: null, ciFix: fix }, live("idle"), now)["fix-ci"];
    expect(finished(ciFix({ recordedAt: minutesAgo(1) }))).toBe("none");
    expect(finished(ciFix({ verdict: "not-fixed", recordedAt: minutesAgo(1) }))).toBe("none");
    expect(finished(ciFix({ recordedAt: minutesAgo(30) }))).toBe("stalled");
  });

  test("a merge request finishes when the PR merges, with nothing to record", () => {
    const requests = { merge: minutesAgo(10) };
    expect(requestProgress(requests, { mergedAt: minutesAgo(1) }, live("idle"), now).merge).toBe("none");
    expect(requestProgress(requests, open, live("idle"), now).merge).toBe("stalled");
  });

  test("an approval-ask request finishes once every reviewer the PR waits on has an ask, one at least from after it", () => {
    const requests = { "ask-approval": minutesAgo(10) };
    const finished = (state: ApprovalState) => requestProgress(requests, { mergedAt: null, approval: state }, live("idle"), now)["ask-approval"];
    const waitingOn = ["cache-team", "sre"];
    const fresh = approvalAsk({ askedAt: minutesAgo(2) });
    expect(finished(approval([fresh, approvalAsk({ reviewer: "sre", channel: "#sre", askedAt: minutesAgo(1) })], { waitingOn }))).toBe("none");
    // One of two asked isn't done yet.
    expect(finished(approval([fresh], { waitingOn }))).toBe("stalled");
    // Nobody listed: any ask from after the request finishes it.
    expect(finished(approval([fresh]))).toBe("none");
    // Nothing recorded, or only asks from before the request, leaves it stalled.
    expect(finished(approval([]))).toBe("stalled");
    expect(finished(approval([approvalAsk({ askedAt: minutesAgo(60) })]))).toBe("stalled");
    // An ask that named no reviewer was the whole answer before asks did, whoever it left out.
    expect(finished(approval([approvalAsk({ reviewer: null, channel: null, askedAt: minutesAgo(2) })], { waitingOn }))).toBe("none");
  });

  test("an ask found already sent answers the request when recorded for it, though the message is older", () => {
    const requests = { "ask-approval": minutesAgo(10) };
    const finished = (state: ApprovalState) => requestProgress(requests, { mergedAt: null, approval: state }, live("idle"), now)["ask-approval"];
    const found = approvalAsk({ askedAt: minutesAgo(3 * 24 * 60), recordedAt: minutesAgo(1), source: "found" });
    expect(finished(approval([found], { waitingOn: ["cache-team"] }))).toBe("none");
    // One found before this request doesn't answer it.
    expect(finished(approval([{ ...found, recordedAt: minutesAgo(60) }], { waitingOn: ["cache-team"] }))).toBe("stalled");
  });

  test("a bump request finishes once each ask still waiting was bumped, or asked afresh, after it; approved reviewers are skipped", () => {
    const requests = { bump: minutesAgo(10) };
    const finished = (state: ApprovalState) => requestProgress(requests, { mergedAt: null, approval: state }, live("idle"), now).bump;
    const bumped = approvalAsk({ askedAt: minutesAgo(60), bumpedAt: minutesAgo(2) });
    const old = approvalAsk({ reviewer: "sre", channel: "#sre", askedAt: minutesAgo(60) });
    expect(finished(approval([bumped]))).toBe("none");
    expect(finished(approval([approvalAsk({ askedAt: minutesAgo(2) })]))).toBe("none");
    expect(finished(approval([approvalAsk({ askedAt: minutesAgo(60) })]))).toBe("stalled");
    expect(finished(approval([approvalAsk({ askedAt: minutesAgo(120), bumpedAt: minutesAgo(60) })]))).toBe("stalled");
    // sre still waits, unbumped; once sre approved, its ask needs no bump.
    expect(finished(approval([bumped, old], { waitingOn: ["sre"] }))).toBe("stalled");
    expect(finished(approval([bumped, old], { approvedFor: ["sre"] }))).toBe("none");
    // An ask from before asks named their reviewer may be skipped: the session judges whether its people approved.
    expect(finished(approval([bumped, approvalAsk({ reviewer: null, channel: null, askedAt: minutesAgo(60) })]))).toBe("none");
    expect(finished(approval([approvalAsk({ reviewer: null, channel: null, askedAt: minutesAgo(60) })]))).toBe("stalled");
  });

  test("only the newest request can be running: the board sent it because the older one had stopped", () => {
    const progress = requestProgress({ review: minutesAgo(30), "fix-ci": minutesAgo(5) }, open, live("working"), now);
    expect(progress).toEqual({ review: "stalled", merge: "none", "fix-ci": "running", "ask-approval": "none", bump: "none" });
  });

  test("each card follows its requests through the session in charge", () => {
    const board = buildBoard({ mine: [pr()], reviewRequested: [], merged: [] }, [], {
      requests: new Map([["acme/api#1", { review: minutesAgo(10) }]]),
      owners: { "acme/api#1": { sessionFile: "/s.jsonl", title: "", how: "opened", live: live("working") } },
      now,
    });
    expect(board.lanes["agent-review"][0].requests.review).toBe("running");
  });
});

describe("ciFixState", () => {
  test("a CI-fix result speaks for the commit it was recorded at", () => {
    expect(ciFixState(pr(), ciFix({ summary: "retried the flaky job" }))).toMatchObject({ status: "fixed", stale: false, summary: "retried the flaky job" });
    expect(ciFixState(pr(), ciFix({ verdict: "not-fixed" }))).toMatchObject({ status: "not-fixed", stale: false });
  });

  test("a commit pushed after the result makes it stale", () => {
    expect(ciFixState(pr({ headSha: "bbb" }), ciFix({ headSha: "aaa" }))).toMatchObject({ status: "fixed", stale: true });
  });

  test("no result recorded", () => {
    expect(ciFixState(pr(), undefined)).toEqual({ status: "not-run" });
  });
});

describe("approvalState", () => {
  test("names the reviewers the PR waits on that no ask went to yet, ignoring case", () => {
    const state = approval([approvalAsk({ reviewer: "Cache-Team" })], { waitingOn: ["cache-team", "sre", "sara"] });
    expect(state.unasked).toEqual(["sre", "sara"]);
    expect(approval([], { waitingOn: ["sre"] }).unasked).toEqual(["sre"]);
    // An ask that named no reviewer covers nobody.
    expect(approval([approvalAsk({ reviewer: null })], { waitingOn: ["sre"] }).unasked).toEqual(["sre"]);
  });

  test("an ask's reviewer approved when the person did, or someone did on the team's behalf", () => {
    const asks = [approvalAsk({ reviewer: "sara" }), approvalAsk({ reviewer: "cache-team" }), approvalAsk({ reviewer: "sre" }), approvalAsk({ reviewer: null })];
    const state = approval(asks, { approvedBy: ["Sara", "pat"], approvedFor: ["cache-team"], waitingOn: ["sre"] });
    expect(state.asks.map((ask) => [ask.reviewer, ask.approved])).toEqual([
      ["sara", true],
      ["cache-team", true],
      ["sre", false],
      [null, false],
    ]);
    expect(waitingAsks(state).map((ask) => ask.reviewer)).toEqual(["sre", null]);
  });

  test("each ask keeps where it went and when it was asked and bumped", () => {
    const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
    expect(approval([approvalAsk({ bumpedAt: "2026-10-31T01:00:00Z", slackUrl: permalink })]).asks).toEqual([
      {
        reviewer: "cache-team",
        channel: "#cache-team",
        askedAt: "2026-10-30T01:00:00Z",
        recordedAt: "2026-10-30T01:00:00Z",
        source: "drafted",
        bumpedAt: "2026-10-31T01:00:00Z",
        slackUrl: permalink,
        approved: false,
      },
    ]);
  });

  test("each card carries its PR's asks, whatever commit it is at", () => {
    const board = buildBoard({ mine: [pr({ headSha: "bbb", waitingOn: ["cache-team", "sre"] })], reviewRequested: [], merged: [] }, [], {
      reviews: new Map([["acme/api#1", review({ headSha: "bbb" })]]),
      approvals: new Map([["acme/api#1", [approvalAsk()]]]),
    });
    expect(board.lanes["human-review"][0].approval).toMatchObject({ asks: [{ reviewer: "cache-team", approved: false }], unasked: ["sre"] });
  });
});

describe("approvalStep", () => {
  test("asks while a reviewer the PR waits on has no ask yet", () => {
    expect(approvalStep(approval([], { waitingOn: ["cache-team"] }))).toBe("ask-approval");
    expect(approvalStep(approval([approvalAsk({ reviewer: "infra" })], { waitingOn: ["cache-team"] }))).toBe("ask-approval");
  });

  test("bumps once every reviewer it waits on was asked", () => {
    expect(approvalStep(approval([approvalAsk()], { waitingOn: ["cache-team"] }))).toBe("bump");
    expect(approvalStep(approval([approvalAsk({ reviewer: null })]))).toBe("bump");
  });

  test("an ask found already sent covers its reviewer like a drafted one, so the next step is Bump", () => {
    const found = approvalAsk({ channel: "#cache-help", askedAt: "2026-11-03T22:57:23.786Z", recordedAt: "2026-11-04T01:00:00Z", source: "found" });
    const state = approval([found], { waitingOn: ["cache-team"] });
    expect(state.unasked).toEqual([]);
    expect(approvalStep(state)).toBe("bump");
    expect(waitingAsks(state)).toMatchObject([{ reviewer: "cache-team", source: "found" }]);
  });

  test("asks when nobody is listed and no ask still waits, so the session works out who", () => {
    expect(approvalStep(approval([]))).toBe("ask-approval");
    expect(approvalStep(approval([approvalAsk()], { approvedFor: ["cache-team"] }))).toBe("ask-approval");
  });
});
