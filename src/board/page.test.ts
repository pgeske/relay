import { describe, expect, test } from "bun:test";
import type { PullRequest } from "./github.ts";
import { buildBoard, type CardOwner, type LocalState } from "./lanes.ts";
import { ACTIVE_REFRESH_SECONDS, PAGE_REFRESH_SECONDS, renderBoardPage } from "./page.ts";
import type { AgentRequests, AgentReview, ApprovalAsk, CiFix } from "./store.ts";

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

/** The cards of a board holding one PR of mine, without the page's script (which names every button too). */
function cards(
  pullRequest: PullRequest,
  local: { owner?: CardOwner | null; requests?: AgentRequests; ciFix?: CiFix; review?: AgentReview; approval?: ApprovalAsk } = {},
): string {
  const state: LocalState = {
    owners: local.owner === null ? {} : { [KEY]: local.owner ?? owner() },
    requests: new Map(local.requests ? [[KEY, local.requests]] : []),
    ciFixes: new Map(local.ciFix ? [[KEY, local.ciFix]] : []),
    reviews: new Map(local.review ? [[KEY, local.review]] : []),
    approvals: new Map(local.approval ? [[KEY, local.approval]] : []),
    now,
  };
  const board = buildBoard({ mine: [pullRequest], reviewRequested: [], merged: [] }, [], state);
  return renderBoardPage(board, { now, updatedAt: now }).split("<script>")[0];
}

const FIX_CI = 'data-action="fix-ci"';
const CI_PILL_ASKS_FIX = '<button class="pill bad fix-ci" data-action="fix-ci"';

describe("Fix CI", () => {
  test("the red CI pill asks for it on a card whose PR has a session, in any lane", () => {
    for (const html of [cards(pr()), cards(pr({ isDraft: true })), cards(pr({ reviewDecision: "APPROVED" }))]) {
      expect(html).toContain(CI_PILL_ASKS_FIX);
      expect(html).toContain('title="Ask the session to fix CI">CI red<svg class="wrench"');
    }
    // Passed agent review: the human-review lane.
    const humanReview = buildBoard({ mine: [pr()], reviewRequested: [], merged: [] }, [], {
      owners: { [KEY]: owner() },
      reviews: new Map([[KEY, { repo: "acme/api", number: 1, headSha: "aaa", verdict: "passed", findings: 0, summary: null, reviewedAt: minutesAgo(5) }]]),
      now,
    });
    expect(humanReview.lanes["human-review"]).toHaveLength(1);
    expect(renderBoardPage(humanReview, { now, updatedAt: now }).split("<script>")[0]).toContain(CI_PILL_ASKS_FIX);
  });

  test("is no longer a button in the session row", () => {
    expect(cards(pr())).not.toContain('class="act next" data-action="fix-ci"');
    expect(cards(pr())).not.toContain(">Fix CI</button>");
  });

  test("a closed session's pill says it reopens it first", () => {
    expect(cards(pr(), { owner: owner(null) })).toContain('title="Reopen the session in relay and ask it to fix CI"');
  });

  test("is not offered when CI isn't red, or no session is in charge", () => {
    expect(cards(pr({ checks: [{ name: "test", state: "passed" }] }))).not.toContain(FIX_CI);
    expect(cards(pr({ checks: [{ name: "test", state: "pending" }] }))).not.toContain(FIX_CI);
    const unowned = cards(pr(), { owner: null });
    expect(unowned).not.toContain(FIX_CI);
    expect(unowned).toContain(`<span class="pill bad">CI red</span>`);
  });

  test("in progress: the card pulses next to a plain CI pill", () => {
    const html = cards(pr(), { requests: { "fix-ci": minutesAgo(1) } });
    expect(html).toContain(`<span class="pill bad">CI red</span><span class="pill wait running">agent fixing CI…</span>`);
    expect(html).not.toContain(FIX_CI);
  });

  test("stalled: the card says so, and that tag asks again", () => {
    const html = cards(pr(), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") });
    expect(html).toContain('title="Ask the session to fix CI again">CI fix stopped without a result<svg');
  });

  test("stalled once CI is no longer red: just a note", () => {
    const html = cards(pr({ checks: [{ name: "test", state: "pending" }] }), { requests: { "fix-ci": minutesAgo(10) }, owner: owner("idle") });
    expect(html).toContain(`<span class="pill warn">CI fix stopped without a result</span>`);
    expect(html).not.toContain(FIX_CI);
  });

  test("fixed at the current commit: the CI pill gets a marker that opens the write-up", () => {
    const html = cards(pr({ checks: [{ name: "test", state: "pending" }] }), { ciFix: ciFix() });
    expect(html).toContain(">CI running*</button>");
    expect(html).toContain("Retried the flaky integration job.");
  });

  test("fixed, then a new commit: the marker and write-up are gone", () => {
    const html = cards(pr({ headSha: "bbb", checks: [{ name: "test", state: "passed" }] }), { ciFix: ciFix({ headSha: "aaa" }) });
    expect(html).toContain(`<span class="pill ok">CI green</span>`);
    expect(html).not.toContain("CI green*");
    expect(html).not.toContain("Retried the flaky integration job.");
  });

  test("not fixed: a tag says so and opens why, and Fix CI stays on offer", () => {
    const html = cards(pr(), { ciFix: ciFix({ verdict: "not-fixed", summary: "The staging registry is down; nothing to fix in the PR." }) });
    expect(html).toContain(">agent couldn't fix CI</button>");
    expect(html).toContain("The staging registry is down");
    expect(html).toContain(FIX_CI);
  });

  test("a newer request outranks the last result", () => {
    const html = cards(pr(), { ciFix: ciFix({ verdict: "not-fixed" }), requests: { "fix-ci": minutesAgo(1) } });
    expect(html).toContain("agent fixing CI…");
    expect(html).not.toContain("agent couldn't fix CI");
  });
});

describe("Merge", () => {
  const ready = pr({ reviewDecision: "APPROVED", checks: [{ name: "test", state: "passed" }] });

  test("in progress: the card pulses instead of offering it", () => {
    const html = cards(ready, { requests: { merge: minutesAgo(1) } });
    expect(html).toContain("agent merging…");
    expect(html).not.toContain('data-action="merge"');
  });

  test("stalled: the card says so and offers it again", () => {
    const html = cards(ready, { requests: { merge: minutesAgo(10) }, owner: owner(null) });
    expect(html).toContain("merge stopped without a result");
    expect(html).toContain(">Merge again</button>");
  });
});

test("while one request runs, the card offers no other step", () => {
  const html = cards(pr(), { requests: { review: minutesAgo(1) } });
  expect(html).toContain("agent reviewing…");
  expect(html).not.toContain('data-action="review"');
  expect(html).not.toContain(FIX_CI);
});

describe("refresh", () => {
  const page = (requests?: AgentRequests) => {
    const board = buildBoard({ mine: [pr()], reviewRequested: [], merged: [] }, [], {
      owners: { [KEY]: owner("idle") },
      requests: new Map(requests ? [[KEY, requests]] : []),
      now,
    });
    return renderBoardPage(board, { now, updatedAt: now });
  };

  test("every minute when nothing runs, a stalled request included", () => {
    for (const html of [page(), page({ merge: minutesAgo(10) })]) {
      expect(html).toContain(`data-refresh-seconds="${PAGE_REFRESH_SECONDS}"`);
      expect(html).toContain(`}, ${PAGE_REFRESH_SECONDS * 1000});`);
    }
  });

  test(`every ${ACTIVE_REFRESH_SECONDS}s while a session runs a request`, () => {
    const html = page({ merge: minutesAgo(0.5) });
    expect(html).toContain(`data-refresh-seconds="${ACTIVE_REFRESH_SECONDS}"`);
    expect(html).toContain(`}, ${ACTIVE_REFRESH_SECONDS * 1000});`);
    expect(html).toContain(`refreshes every ${ACTIVE_REFRESH_SECONDS}s while an agent works`);
  });
});

describe("Ask for approval, then Bump", () => {
  // A passed agent review of the current commit puts the PR in Human review.
  const passed: AgentReview = { repo: "acme/api", number: 1, headSha: "aaa", verdict: "passed", findings: 0, summary: null, reviewedAt: minutesAgo(60) };
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

  test("no ask recorded: the card offers Ask for approval", () => {
    const html = cards(waiting, { review: passed });
    expect(html).toContain('data-action="ask-approval"');
    expect(html).toContain(">Ask for approval</button>");
    expect(html).not.toContain('data-action="bump"');
    expect(html).not.toContain("pill link slack");
  });

  test("ask recorded: a tag opens it in Slack in a new tab, and the card offers Bump", () => {
    const html = cards(waiting, { review: passed, approval: asked() });
    expect(html).toContain(
      `<a class="pill link slack" href="https://app.slack.com/client/T1/C1" target="_blank" rel="noopener" title="Open the approval ask in Slack">approval asked 2d ago</a>`,
    );
    expect(html).toContain('data-action="bump"');
    expect(html).toContain(">Bump</button>");
    expect(html).not.toContain('data-action="ask-approval"');
  });

  test("bumped: the tag says when, and links to the message as sent", () => {
    const permalink = "https://acme.slack.com/archives/C1/p1793643074057839";
    const html = cards(waiting, { review: passed, approval: asked({ bumpedAt: minutesAgo(24 * 60), slackUrl: permalink }) });
    expect(html).toContain(`href="${permalink}"`);
    expect(html).toContain(">bumped 1d ago</a>");
    expect(html).toContain(">Bump</button>");
  });

  test("outside Human review, neither the tag nor the steps show", () => {
    const html = cards(pr({ checks: green, reviewDecision: "APPROVED" }), { review: passed, approval: asked() });
    expect(html).not.toContain("approval asked");
    expect(html).not.toContain('data-action="bump"');
    expect(html).not.toContain('data-action="ask-approval"');
  });

  test.each([
    ["ask-approval", "agent drafting approval ask…"],
    ["bump", "agent drafting bump…"],
  ] as const)("%s in progress: the card pulses instead of offering a step", (action, running) => {
    const html = cards(waiting, { review: passed, approval: action === "bump" ? asked() : undefined, requests: { [action]: minutesAgo(1) } });
    expect(html).toContain(`<span class="pill wait running">${running}</span>`);
    expect(html).not.toContain('data-action="ask-approval"');
    expect(html).not.toContain('data-action="bump"');
  });

  test("ask stalled: the card says so and offers it again", () => {
    const html = cards(waiting, { review: passed, requests: { "ask-approval": minutesAgo(10) } });
    expect(html).toContain("approval ask stopped without a result");
    expect(html).toContain(">Ask for approval again</button>");
  });

  test("bump stalled: the card says so, keeps the link, and offers it again", () => {
    const html = cards(waiting, { review: passed, approval: asked(), requests: { bump: minutesAgo(10) } });
    expect(html).toContain("bump stopped without a result");
    expect(html).toContain("approval asked 2d ago");
    expect(html).toContain(">Bump again</button>");
  });

  test("an ask recorded after the request finishes it, and Bump takes over", () => {
    const html = cards(waiting, { review: passed, approval: asked({ askedAt: minutesAgo(1) }), requests: { "ask-approval": minutesAgo(3) } });
    expect(html).not.toContain("agent drafting approval ask…");
    expect(html).toContain("approval asked 1m ago");
    expect(html).toContain(">Bump</button>");
  });
});
