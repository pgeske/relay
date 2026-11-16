import { describe, expect, test } from "bun:test";
import { openFeedback, parseCommentVerdict } from "./feedback.ts";
import type { Discussion, PrComment, PullRequest, ReviewThread } from "./github.ts";
import { buildBoard } from "./lanes.ts";

const PUSHED = "2026-11-10T12:00:00Z";
const BEFORE = "2026-11-10T11:00:00Z";
const AFTER = "2026-11-10T13:00:00Z";

function comment(author: string, at: string, overrides: Partial<PrComment> = {}): PrComment {
  return { author, authorIsBot: false, body: `${author} says hi`, url: `https://github.com/acme/api/pull/1#${author}-${at}`, at, ...overrides };
}

function thread(first: PrComment, last: PrComment = first, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return { resolved: false, outdated: false, path: "src/cache.ts", first, last, ...overrides };
}

function pr(discussion: Partial<Discussion>, overrides: Partial<PullRequest> = {}): PullRequest {
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
    headCommittedAt: PUSHED,
    updatedAt: AFTER,
    mergedAt: null,
    checks: [],
    discussion: { changeRequests: [], threads: [], comments: [], ...discussion },
    ...overrides,
  };
}

const none = new Map<string, boolean>();

describe("openFeedback", () => {
  test("an open thread whose last word is a reviewer's is to address, quoting the reviewer's ask", () => {
    const ask = comment("sara", BEFORE, { body: "Can you add the gov team here too?" });
    const [item] = openFeedback(pr({ threads: [thread(ask, comment("rahul", BEFORE))] }), none);
    expect(item).toMatchObject({ kind: "thread", author: "sara", body: "Can you add the gov team here too?", url: ask.url, path: "src/cache.ts" });
  });

  test("a thread the author answered last, resolved, on changed lines, or only bots spoke in isn't", () => {
    const sara = comment("sara", BEFORE);
    const threads = [
      thread(sara, comment("me", BEFORE)),
      thread(sara, sara, { resolved: true }),
      thread(sara, sara, { outdated: true }),
      thread(comment("review-bot", BEFORE, { authorIsBot: true })),
    ];
    expect(openFeedback(pr({ threads }), none)).toEqual([]);
  });

  test("a request for changes counts until a newer commit or a reply from the author answers it", () => {
    const request = comment("sara", AFTER, { body: "" });
    expect(openFeedback(pr({ changeRequests: [request] }), none)).toMatchObject([{ kind: "changes-requested", author: "sara" }]);
    expect(openFeedback(pr({ changeRequests: [comment("sara", BEFORE)] }), none)).toEqual([]);
    const replied = pr({ changeRequests: [request], comments: [comment("me", "2026-11-10T14:00:00Z")] });
    expect(openFeedback(replied, none)).toEqual([]);
  });

  test("a conversation comment counts only once relay's model said it asks for a change", () => {
    const asks = comment("sara", AFTER, { body: "Please rename this flag" });
    const note = comment("sam", AFTER, { body: "FYI deploys are slow this week" });
    const discussion = { comments: [asks, note] };
    expect(openFeedback(pr(discussion), none)).toEqual([]);
    const verdicts = new Map([
      [asks.url, true],
      [note.url, false],
    ]);
    expect(openFeedback(pr(discussion), verdicts)).toMatchObject([{ kind: "comment", author: "sara", body: "Please rename this flag" }]);
    // Said before the last commit, it's taken as answered.
    expect(openFeedback(pr({ comments: [{ ...asks, at: BEFORE }] }), verdicts)).toEqual([]);
  });
});

describe("the board's lanes", () => {
  const sara = comment("sara", BEFORE);
  const board = (overrides: Partial<PullRequest>) => buildBoard({ mine: [pr({ threads: [thread(sara)] }, overrides)], reviewRequested: [], merged: [] }, []).lanes;

  test("a PR with feedback to address waits on you in Changes requested, whoever approved so far", () => {
    expect(board({})["changes-requested"]).toHaveLength(1);
    expect(board({ approvedBy: ["pat"] })["changes-requested"]).toHaveLength(1);
  });

  test("a fully approved one moves on, and a draft stays a draft", () => {
    expect(board({ reviewDecision: "APPROVED", approvedBy: ["sara"] }).ready).toHaveLength(1);
    expect(board({ isDraft: true }).draft).toHaveLength(1);
  });
});

test("parseCommentVerdict reads the model's yes or no, and nothing else", () => {
  expect(parseCommentVerdict('{"asks": true}')).toBe(true);
  expect(parseCommentVerdict('```json\n{"asks": false}\n```')).toBe(false);
  expect(parseCommentVerdict('{"asks": "maybe"}')).toBeNull();
  expect(parseCommentVerdict("no idea")).toBeNull();
});
