import { describe, expect, test } from "bun:test";
import { placeTask, taskBoardView, type TaskSessionInfo, type TaskSessionLink } from "./taskBoard.ts";
import type { Task } from "./taskStore.ts";

const now = new Date("2026-11-04T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    title: "Roll out the cache",
    details: null,
    projectId: null,
    stage: "doing",
    status: null,
    statusAt: null,
    blockedOn: null,
    blockedReason: null,
    blockedAt: null,
    approvePlan: true,
    plan: null,
    planAt: null,
    planApprovedAt: null,
    cwd: null,
    model: null,
    thinkingLevel: null,
    createdAt: minutesAgo(120),
    updatedAt: minutesAgo(60),
    finishedAt: null,
    finishNote: null,
    doneAt: null,
    pausedAt: null,
    ...overrides,
  };
}

function session(status: "working" | "idle" | null, activeMinutesAgo = 5, onTask = true): TaskSessionLink {
  return {
    sessionFile: "/sessions/a.jsonl",
    title: "Cache rollout",
    cwd: null,
    live: status ? { paneId: "%1", windowId: "@1", status } : null,
    activeAt: minutesAgo(activeMinutesAgo),
    onTask,
  };
}

describe("where a task goes", () => {
  test("a working agent needs nothing from you, even with a block it hasn't cleared yet", () => {
    expect(placeTask(task({ blockedOn: "me", blockedAt: minutesAgo(30) }), [session("working")], [], now).lane).toBe("working");
  });

  test("a plan waiting for approval needs you, and says for how long", () => {
    const placed = placeTask(task({ stage: "plan", plan: "1. Turn it on", planAt: minutesAgo(12) }), [session("idle")], [], now);
    expect(placed).toMatchObject({ lane: "needs-you", reason: { text: "Plan ready for your approval", since: "12m" } });
  });

  test("a plan on a task that skips approval doesn't wait for you", () => {
    const placed = placeTask(task({ approvePlan: false, plan: "1. Turn it on", planAt: minutesAgo(12), blockedOn: "others", blockedAt: minutesAgo(10) }), [session("idle")], [], now);
    expect(placed.lane).toBe("waiting");
  });

  test("a PR ready to merge needs you even while the agent says it waits on others", () => {
    const placed = placeTask(task({ blockedOn: "others", blockedAt: minutesAgo(10) }), [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now);
    expect(placed).toMatchObject({ lane: "needs-you", reason: { text: "api#1 is ready to merge" } });
  });

  test("a PR in human review is waiting on others, not on you", () => {
    expect(placeTask(task(), [session("idle")], [{ ref: "acme/api#1", lane: "human-review" }], now).lane).toBe("waiting");
  });

  test("a PR waiting for your click beats another waiting on reviewers", () => {
    const prs = [
      { ref: "acme/api#1", lane: "human-review" as const },
      { ref: "acme/api#2", lane: "agent-review" as const },
    ];
    expect(placeTask(task(), [session("idle")], prs, now)).toMatchObject({ lane: "needs-you", reason: { text: "api#2 needs an agent review" } });
  });

  test("a session that moved on to another task doesn't count as working on this one", () => {
    expect(placeTask(task(), [session("working", 1, false)], [], now)).toMatchObject({ lane: "paused", reason: { text: "Its session moved on to another task" } });
  });

  test("a task you paused stays paused, even with its agent working or a PR ready, and offers Resume", () => {
    const paused = task({ pausedAt: minutesAgo(20), blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(paused, [session("working")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ lane: "paused", reason: { text: "You paused it", since: "20m" } });

    const view = taskBoardView({ tasks: [paused], projects: [], events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), now }, "/home");
    const card = view.lanes.find((lane) => lane.id === "paused")!.cards[0];
    expect(card.steps.map((step) => step.action)).toEqual(["resume"]);
    expect(card.menu.map((item) => item.action)).toContain("unpause");
    expect(card.menu.map((item) => item.action)).not.toContain("pause");
  });

  test("any task in play can be paused, but not one shipped, delivered, or not started", () => {
    const menuOf = (t: Task) => taskBoardView({ tasks: [t], projects: [], events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), now }, "/home").lanes.flatMap((lane) => lane.cards)[0].menu.map((item) => item.action);
    expect(menuOf(task({ blockedOn: "others", blockedAt: minutesAgo(5) }))).toContain("pause");
    expect(menuOf(task({ stage: "done", doneAt: minutesAgo(5) }))).not.toContain("pause");
    expect(menuOf(task({ finishedAt: minutesAgo(5) }))).not.toContain("pause");
    expect(menuOf(task({ stage: "idea" }))).not.toContain("pause");
  });

  test("an agent that stopped without saying anything is your turn", () => {
    const placed = placeTask(task(), [session("idle", 7)], [{ ref: "acme/api#1", lane: "merged" }], now);
    expect(placed).toMatchObject({ lane: "needs-you", reason: { text: "Agent stopped: your turn", since: "7m" } });
  });

  test("a task with only closed sessions is paused; one never started is an idea", () => {
    expect(placeTask(task(), [session(null)], [], now).lane).toBe("paused");
    expect(placeTask(task({ stage: "idea" }), [], [], now).lane).toBe("ideas");
    // Started and moved on, but its session is gone: paused, not an idea.
    expect(placeTask(task({ stage: "research" }), [], [], now).lane).toBe("paused");
  });

  test("a task its agent delivered waits for you to ship it, ahead of everything but a working agent", () => {
    const finished = task({ finishedAt: minutesAgo(3), finishNote: "Shipped it", blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(finished, [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ lane: "ship", reason: { text: "Delivered", since: "3m" } });
    // Still writing its last reply: it's working until it stops.
    expect(placeTask(finished, [session("working")], [], now).lane).toBe("working");
  });

  test("a delivered task counts as needing you, and offers shipping it or sending it back instead of Mark Shipped", () => {
    const view = taskBoardView(
      { tasks: [task({ finishedAt: minutesAgo(3), finishNote: "Shipped it" })], projects: [], events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), now },
      "/home",
    );
    const card = view.lanes.find((lane) => lane.id === "ship")!.cards[0];
    expect(view.needsYou).toBe(1);
    expect(card.steps.map((step) => step.action)).toEqual(["ship", "send-back"]);
    expect(card.menu.map((item) => item.action)).not.toContain("done");
    expect(card.finish).toMatchObject({ text: "Shipped it", awaiting: true });
  });
});

describe("an untracked session", () => {
  function untracked(status: "working" | "idle") {
    const info: TaskSessionInfo = { ...session(status), sessionFile: "/sessions/loose.jsonl", title: "Quick question" };
    const view = taskBoardView(
      { tasks: [], projects: [], events: new Map(), sessions: [], sessionInfo: new Map([[info.sessionFile, info]]), prs: new Map(), board: null, dismissed: new Set(), now },
      "/home",
    );
    return view.lanes.find((lane) => lane.id === "untracked")!.sessions[0];
  }

  test("closes right away while idle, but asks first while it's working", () => {
    expect(untracked("idle").close).toMatchObject({ action: "close-session", label: "Close Session", confirm: null });
    expect(untracked("working").close.confirm).toMatchObject({ title: 'Close "Quick question"?', button: "Close Session", destructive: true });
  });
});
