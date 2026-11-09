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
    autoReportedAt: null,
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

/** The board for these tasks, each `sessions` entry linking a session to a task. */
function boardOf(tasks: Task[], sessions: { taskId: number; info: TaskSessionInfo }[] = []) {
  const links = sessions.map(({ taskId, info }) => ({ taskId, sessionFile: info.sessionFile, linkedAt: minutesAgo(60) }));
  const sessionInfo = new Map(sessions.map(({ info }) => [info.sessionFile, info]));
  return taskBoardView({ tasks, projects: [], events: new Map(), sessions: links, sessionInfo, prs: new Map(), board: null, dismissed: new Set(), now }, "/home");
}

describe("whose move a task waits on", () => {
  test("a working agent needs nothing from you, even with a block it hasn't cleared yet", () => {
    expect(placeTask(task({ blockedOn: "me", blockedAt: minutesAgo(30) }), [session("working")], [], now).turn).toBe("agent");
  });

  test("a plan waiting for approval needs you, and says for how long", () => {
    const placed = placeTask(task({ stage: "plan", plan: "1. Turn it on", planAt: minutesAgo(12) }), [session("idle")], [], now);
    expect(placed).toMatchObject({ turn: "you", reason: "Plan ready for your approval", since: "12m" });
  });

  test("a plan on a task that skips approval doesn't wait for you", () => {
    const placed = placeTask(task({ approvePlan: false, plan: "1. Turn it on", planAt: minutesAgo(12), blockedOn: "others", blockedAt: minutesAgo(10) }), [session("idle")], [], now);
    expect(placed.turn).toBe("others");
  });

  test("a PR ready to merge needs you even while the agent says it waits on others", () => {
    const placed = placeTask(task({ blockedOn: "others", blockedAt: minutesAgo(10) }), [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now);
    expect(placed).toMatchObject({ turn: "you", reason: "api#1 is ready to merge" });
  });

  test("a PR in human review is waiting on others, not on you", () => {
    expect(placeTask(task(), [session("idle")], [{ ref: "acme/api#1", lane: "human-review" }], now).turn).toBe("others");
  });

  test("a PR waiting for your click beats another waiting on reviewers", () => {
    const prs = [
      { ref: "acme/api#1", lane: "human-review" as const },
      { ref: "acme/api#2", lane: "agent-review" as const },
    ];
    expect(placeTask(task(), [session("idle")], prs, now)).toMatchObject({ turn: "you", reason: "api#2 needs an agent review" });
  });

  test("a session that moved on to another task doesn't count as working on this one", () => {
    expect(placeTask(task(), [session("working", 1, false)], [], now)).toMatchObject({ turn: "idle", reason: "Its session moved on to another task" });
  });

  test("a task you paused stays paused, even with its agent working or a PR ready, and offers Resume", () => {
    const paused = task({ pausedAt: minutesAgo(20), blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(paused, [session("working")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ turn: "paused", since: "20m" });

    const card = boardOf([paused]).columns.flatMap((column) => column.cards)[0];
    expect(card.turn).toMatchObject({ id: "paused", label: "Paused" });
    expect(card.steps.map((step) => step.action)).toEqual(["resume"]);
    expect(card.menu.map((item) => item.action)).toContain("unpause");
    expect(card.menu.map((item) => item.action)).not.toContain("pause");
  });

  test("any task in play can be paused, but not one shipped, delivered, or not started", () => {
    const menuOf = (t: Task) => boardOf([t]).columns.flatMap((column) => column.cards)[0].menu.map((item) => item.action);
    expect(menuOf(task({ blockedOn: "others", blockedAt: minutesAgo(5) }))).toContain("pause");
    expect(menuOf(task({ stage: "done", doneAt: minutesAgo(5) }))).not.toContain("pause");
    expect(menuOf(task({ finishedAt: minutesAgo(5) }))).not.toContain("pause");
    expect(menuOf(task({ stage: "idea" }))).not.toContain("pause");
  });

  test("an agent that stopped without saying anything is your turn", () => {
    const placed = placeTask(task(), [session("idle", 7)], [{ ref: "acme/api#1", lane: "merged" }], now);
    expect(placed).toMatchObject({ turn: "you", reason: "The agent stopped", since: "7m" });
  });

  test("a task with only closed sessions is idle; one never started is an idea", () => {
    expect(placeTask(task(), [session(null)], [], now).turn).toBe("idle");
    expect(placeTask(task({ stage: "idea" }), [], [], now).turn).toBe("idea");
    // Started and moved on, but its session is gone: idle, not an idea.
    expect(placeTask(task({ stage: "research" }), [], [], now).turn).toBe("idle");
  });

  test("a task its agent delivered waits for you to ship it, ahead of everything but a working agent", () => {
    const finished = task({ finishedAt: minutesAgo(3), finishNote: "Shipped it", blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(finished, [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ turn: "you", delivered: true, since: "3m" });
    // Still writing its last reply: it's working until it stops.
    expect(placeTask(finished, [session("working")], [], now)).toMatchObject({ turn: "agent", delivered: false });
  });

  test("a delivered task counts as needing you, and offers shipping it or sending it back instead of Mark Shipped", () => {
    const view = boardOf([task({ stage: "rollout", finishedAt: minutesAgo(3), finishNote: "Shipped it" })]);
    const card = view.columns.find((column) => column.id === "ship")!.cards[0];
    expect(view.needsYou).toBe(1);
    expect(card.steps.map((step) => step.action)).toEqual(["ship", "send-back"]);
    expect(card.menu.map((item) => item.action)).not.toContain("done");
    expect(card.finish).toMatchObject({ text: "Shipped it", awaiting: true });
  });
});

describe("the columns", () => {
  test("run in the order work moves, ending with Ready to ship and Shipped", () => {
    expect(boardOf([]).columns.map((column) => column.id)).toEqual(["idea", "research", "plan", "doing", "rollout", "ship", "done"]);
  });

  test("hold each task in its stage's column, whoever's move it is", () => {
    const tasks = [
      task({ id: 1, stage: "idea" }),
      task({ id: 2, stage: "research", pausedAt: minutesAgo(5) }),
      task({ id: 3, stage: "doing", blockedOn: "others", blockedAt: minutesAgo(5) }),
      task({ id: 4, stage: "rollout", blockedOn: "me", blockedAt: minutesAgo(5) }),
      task({ id: 5, stage: "done", doneAt: minutesAgo(5) }),
    ];
    const where = new Map(boardOf(tasks).columns.flatMap((column) => column.cards.map((card) => [card.id, column.id])));
    expect(Object.fromEntries(where)).toEqual({ 1: "idea", 2: "research", 3: "doing", 4: "rollout", 5: "done" });
  });

  test("put your move on top, then the agent's, then others', then what's parked", () => {
    const tasks = [
      task({ id: 1, pausedAt: minutesAgo(5) }),
      task({ id: 2, blockedOn: "others", blockedAt: minutesAgo(5) }),
      task({ id: 3, blockedOn: "me", blockedAt: minutesAgo(5) }),
      task({ id: 4 }),
    ];
    const view = boardOf(tasks, [{ taskId: 4, info: { ...session("working"), sessionFile: "/sessions/4.jsonl" } }]);
    const doing = view.columns.find((column) => column.id === "doing")!;
    expect(doing.cards.map((card) => [card.id, card.turn.id])).toEqual([
      [3, "you"],
      [4, "agent"],
      [2, "others"],
      [1, "paused"],
    ]);
  });
});

describe("an untracked session", () => {
  function untracked(status: "working" | "idle") {
    const info: TaskSessionInfo = { ...session(status), sessionFile: "/sessions/loose.jsonl", title: "Quick question" };
    const view = taskBoardView(
      { tasks: [], projects: [], events: new Map(), sessions: [], sessionInfo: new Map([[info.sessionFile, info]]), prs: new Map(), board: null, dismissed: new Set(), now },
      "/home",
    );
    return view.untracked[0];
  }

  test("closes right away while idle, but asks first while it's working", () => {
    expect(untracked("idle").close).toMatchObject({ action: "close-session", label: "Close Session", confirm: null });
    expect(untracked("working").close.confirm).toMatchObject({ title: 'Close "Quick question"?', button: "Close Session", destructive: true });
  });
});

test("a project counts and shows its subprojects' tasks, and cards name their project's path", () => {
  const at = minutesAgo(600);
  const projects = [
    { id: 1, name: "Relay", parentId: null, createdAt: at },
    { id: 2, name: "Board", parentId: 1, createdAt: at },
    { id: 3, name: "Sidebar", parentId: 2, createdAt: at },
    { id: 4, name: "Docs", parentId: null, createdAt: at },
  ];
  const tasks = [task({ id: 1, projectId: 3 }), task({ id: 2, projectId: 1, blockedOn: "me", blockedAt: minutesAgo(5) })];
  const view = taskBoardView({ tasks, projects, events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), now }, "/home");
  const byName = new Map(view.projects.map((project) => [project.name, project]));
  expect(byName.get("Relay")).toMatchObject({ path: "Relay", ids: [1, 2, 3], open: 2, needsYou: 1 });
  expect(byName.get("Board")).toMatchObject({ path: "Relay/Board", parentId: 1, ids: [2, 3], open: 1, needsYou: 0 });
  expect(byName.get("Docs")).toMatchObject({ ids: [4], open: 0 });
  const card = view.columns.flatMap((column) => column.cards).find((card) => card.id === 1)!;
  expect(card.project).toEqual({ id: 3, name: "Sidebar", path: "Relay/Board/Sidebar" });
});
