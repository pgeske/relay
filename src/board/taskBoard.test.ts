import { describe, expect, test } from "bun:test";
import { placeTask, taskBoardView, type TaskInputs, type TaskSessionInfo, type TaskSessionLink } from "./taskBoard.ts";
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
  return taskBoardView({ tasks, relations: new Map(), projects: [], events: new Map(), sessions: links, sessionInfo, prs: new Map(), board: null, dismissed: new Set(), summaries: new Map(), briefs: new Map(), now }, "/home");
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

  test("an approved PR that can't merge yet needs you only when someone has to fix something", () => {
    const approved = (ci: "failed" | "running" | "passed", mergeBlocker: string | null = null) => [{ ref: "acme/api#1", lane: "approved-blocked" as const, ci, mergeBlocker }];
    expect(placeTask(task(), [session("idle")], approved("running"), now)).toMatchObject({ turn: "progress", reason: "api#1: CI running" });
    expect(placeTask(task(), [session("idle")], approved("failed"), now)).toMatchObject({ turn: "you", reason: "api#1: CI failed" });
    expect(placeTask(task(), [session("idle")], approved("passed", "Merge conflicts"), now)).toMatchObject({ turn: "you", reason: "api#1: merge conflicts" });
    expect(placeTask(task(), [session("idle")], approved("passed", "Blocked by branch rules"), now)).toMatchObject({ turn: "others", reason: "api#1: blocked by branch rules" });
  });

  test("something moving along on its own is in progress, not your move", () => {
    const upgrading = task({ blockedOn: "progress", blockedReason: "Cluster upgrade in staging underway", blockedAt: minutesAgo(15) });
    expect(placeTask(upgrading, [session("idle")], [], now)).toMatchObject({ turn: "progress", reason: "Cluster upgrade in staging underway", since: "15m" });
    // A PR you can merge still comes first.
    expect(placeTask(upgrading, [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now).turn).toBe("you");
  });

  test("a session that moved on to another task doesn't count as working on this one", () => {
    expect(placeTask(task(), [session("working", 1, false)], [], now)).toMatchObject({ turn: "idle", reason: "Its session moved on to another task" });
  });

  test("a task you blocked stays blocked, even with its agent working or a PR ready, says its stage, and offers Resume", () => {
    const blocked = task({ pausedAt: minutesAgo(20), blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(blocked, [session("working")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ turn: "blocked", reason: "Was in Doing", since: "20m" });

    const card = boardOf([blocked]).columns.flatMap((column) => column.cards)[0];
    expect(card.turn).toMatchObject({ id: "blocked", label: "Blocked" });
    expect(card.steps.map((step) => step.action)).toEqual(["resume"]);
    expect(card.menu.map((item) => item.action)).toContain("unblock");
    expect(card.menu.map((item) => item.action)).not.toContain("block");
  });

  test("any task in play can be blocked, but not one shipped, delivered, or not started", () => {
    const menuOf = (t: Task) => boardOf([t]).columns.flatMap((column) => column.cards)[0].menu.map((item) => item.action);
    expect(menuOf(task({ blockedOn: "others", blockedAt: minutesAgo(5) }))).toContain("block");
    expect(menuOf(task({ stage: "done", doneAt: minutesAgo(5) }))).not.toContain("block");
    expect(menuOf(task({ finishedAt: minutesAgo(5) }))).not.toContain("block");
    expect(menuOf(task({ stage: "idea" }))).not.toContain("block");
  });

  test("Refresh Status is offered on a task in play with a session on it, not one delivered, set aside, awaiting plan approval, or without a session", () => {
    const menuWith = (t: Task, sessions: TaskSessionLink[]) =>
      boardOf([t], sessions.map((info) => ({ taskId: t.id, info }))).columns.flatMap((column) => column.cards)[0].menu.map((item) => item.action);
    expect(menuWith(task({ blockedOn: "me", blockedAt: minutesAgo(5) }), [session("idle")])).toContain("refresh");
    expect(menuWith(task(), [session("working")])).toContain("refresh");
    expect(menuWith(task(), [])).not.toContain("refresh");
    expect(menuWith(task({ finishedAt: minutesAgo(5) }), [session("idle")])).not.toContain("refresh");
    expect(menuWith(task({ pausedAt: minutesAgo(5) }), [session("idle")])).not.toContain("refresh");
    expect(menuWith(task({ stage: "plan", plan: "1. Turn it on", planAt: minutesAgo(5) }), [session("idle")])).not.toContain("refresh");
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

  test.each(["idle", null] as const)("a linked session (%s) opens from its row, without a second footer action", (status) => {
    const card = boardOf([task()], [{ taskId: 1, info: session(status) }]).columns.flatMap((column) => column.cards)[0];
    expect(card.session?.open.action).toBe("open");
    expect(card.steps).toEqual([]);
  });

  test("a task whose only session made it and moved on offers Start, not that other task's session", () => {
    const info: TaskSessionInfo = { sessionFile: "/sessions/a.jsonl", title: "Other work", cwd: null, live: { paneId: "%1", windowId: "@1", status: "working" }, activeAt: minutesAgo(1) };
    // The session registered task 2, then went back to task 1.
    const links = [
      { taskId: 2, sessionFile: info.sessionFile, linkedAt: minutesAgo(10) },
      { taskId: 1, sessionFile: info.sessionFile, linkedAt: minutesAgo(5) },
    ];
    const stepsOf = (handedOff: Task) => {
      const view = taskBoardView({ tasks: [task(), handedOff], relations: new Map(), projects: [], events: new Map(), sessions: links, sessionInfo: new Map([[info.sessionFile, info]]), prs: new Map(), board: null, dismissed: new Set(), summaries: new Map(), briefs: new Map(), now }, "/home");
      const card = view.columns.flatMap((column) => column.cards).find((c) => c.id === 2)!;
      return { turn: card.turn.id, steps: card.steps.map((step) => step.action) };
    };
    expect(stepsOf(task({ id: 2, stage: "idea" }))).toEqual({ turn: "idea", steps: ["start"] });
    expect(stepsOf(task({ id: 2, stage: "research" }))).toEqual({ turn: "idle", steps: ["start"] });
  });

  test("a task its agent delivered waits for you to ship it, ahead of everything but a working agent", () => {
    const finished = task({ finishedAt: minutesAgo(3), finishNote: "Shipped it", blockedOn: "me", blockedAt: minutesAgo(30) });
    expect(placeTask(finished, [session("idle")], [{ ref: "acme/api#1", lane: "ready" }], now)).toMatchObject({ turn: "you", delivered: true, since: "3m" });
    // Still writing its last reply: it's working until it stops.
    expect(placeTask(finished, [session("working")], [], now)).toMatchObject({ turn: "agent", delivered: false });
  });

  test("a delivered task counts as needing you, and offers shipping it or sending it back instead of Mark Shipped", () => {
    const view = boardOf([task({ stage: "doing", finishedAt: minutesAgo(3), finishNote: "Shipped it" })]);
    const card = view.columns.find((column) => column.id === "ship")!.cards[0];
    expect(view.needsYou).toBe(1);
    expect(card.steps.map((step) => step.action)).toEqual(["ship", "send-back"]);
    expect(card.menu.map((item) => item.action)).not.toContain("done");
    expect(card.finish).toMatchObject({ text: "Shipped it", awaiting: true });
  });
});

describe("the columns", () => {
  test("run in the order work moves, ending with Ready to ship, Blocked, and Shipped", () => {
    expect(boardOf([]).columns.map((column) => column.id)).toEqual(["idea", "research", "plan", "doing", "ship", "blocked", "done"]);
  });

  test("hold each task in its stage's column while it moves, and in Blocked once it stopped until someone acts or you blocked it", () => {
    const tasks = [
      task({ id: 1, stage: "idea" }),
      task({ id: 2, stage: "research", pausedAt: minutesAgo(5) }),
      task({ id: 3, stage: "doing", blockedOn: "others", blockedAt: minutesAgo(5) }),
      task({ id: 4, stage: "plan", blockedOn: "me", blockedAt: minutesAgo(5) }),
      task({ id: 5, stage: "done", doneAt: minutesAgo(5) }),
      // Its agent is still at it, so it hasn't stopped to wait yet.
      task({ id: 6, stage: "doing", blockedOn: "others", blockedAt: minutesAgo(5) }),
      task({ id: 7, stage: "doing", blockedOn: "progress", blockedAt: minutesAgo(5) }),
    ];
    const view = boardOf(tasks, [{ taskId: 6, info: { ...session("working"), sessionFile: "/sessions/6.jsonl" } }]);
    const where = new Map(view.columns.flatMap((column) => column.cards.map((card) => [card.id, column.id])));
    expect(Object.fromEntries(where)).toEqual({ 1: "idea", 2: "blocked", 3: "blocked", 4: "blocked", 5: "done", 6: "doing", 7: "doing" });
  });

  test("put your move on top, then what's moving, then others', then what's parked", () => {
    const tasks = [
      task({ id: 1 }),
      task({ id: 2, blockedOn: "others", blockedAt: minutesAgo(5) }),
      task({ id: 3, blockedOn: "me", blockedAt: minutesAgo(5) }),
      task({ id: 4 }),
      task({ id: 5, pausedAt: minutesAgo(5) }),
      task({ id: 6, blockedOn: "progress", blockedAt: minutesAgo(5) }),
    ];
    const view = boardOf(tasks, [{ taskId: 4, info: { ...session("working"), sessionFile: "/sessions/4.jsonl" } }]);
    const cardsOf = (id: string) => view.columns.find((column) => column.id === id)!.cards.map((card) => [card.id, card.turn.id]);
    expect(cardsOf("doing")).toEqual([
      [4, "agent"],
      [6, "progress"],
      [1, "idle"],
    ]);
    expect(cardsOf("blocked")).toEqual([
      [3, "you"],
      [2, "others"],
      [5, "blocked"],
    ]);
  });
});

describe("an untracked session", () => {
  function untracked(status: "working" | "idle") {
    const info: TaskSessionInfo = { ...session(status), sessionFile: "/sessions/loose.jsonl", title: "Quick question" };
    const view = taskBoardView(
      { tasks: [], relations: new Map(), projects: [], events: new Map(), sessions: [], sessionInfo: new Map([[info.sessionFile, info]]), prs: new Map(), board: null, dismissed: new Set(), summaries: new Map(), briefs: new Map(), now },
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
  const view = taskBoardView({ tasks, relations: new Map(), projects, events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), summaries: new Map(), briefs: new Map(), now }, "/home");
  const byName = new Map(view.projects.map((project) => [project.name, project]));
  expect(byName.get("Relay")).toMatchObject({ path: "Relay", ids: [1, 2, 3], open: 2, needsYou: 1 });
  expect(byName.get("Board")).toMatchObject({ path: "Relay/Board", parentId: 1, ids: [2, 3], open: 1, needsYou: 0 });
  expect(byName.get("Docs")).toMatchObject({ ids: [4], open: 0 });
  const card = view.columns.flatMap((column) => column.cards).find((card) => card.id === 1)!;
  expect(card.project).toEqual({ id: 3, name: "Sidebar", path: "Relay/Board/Sidebar" });
});

describe("the overview", () => {
  function boardWith(tasks: Task[], extra: Partial<TaskInputs> = {}) {
    return taskBoardView(
      { tasks, relations: new Map(), projects: [], events: new Map(), sessions: [], sessionInfo: new Map(), prs: new Map(), board: null, dismissed: new Set(), summaries: new Map(), briefs: new Map(), now, ...extra },
      "/home",
    );
  }

  test("ranks what needs you by what it frees up: what other tasks wait on, then what takes a click, then what's waited longest", () => {
    const oldest = task({ id: 1, blockedOn: "me", blockedReason: "Which region first?", blockedAt: minutesAgo(60) });
    const plan = task({ id: 2, plan: "1. Do it", planAt: minutesAgo(10) });
    const unblocker = task({ id: 3, blockedOn: "me", blockedReason: "Send the draft", blockedAt: minutesAgo(5) });
    const waiting = task({ id: 4, blockedOn: "others", blockedReason: "Waiting on T-3" });
    const relations = new Map([[3, { dependsOn: [], neededBy: [{ id: 4, ref: "T-4", title: "Next step", shipped: false }] }]]);

    const overview = boardWith([oldest, plan, unblocker, waiting], { relations }).overview;
    expect(overview.upNext).toEqual([
      { id: 3, why: "Unblocks T-4 · Waiting 5m" },
      { id: 2, why: "Takes a minute · Waiting 10m" },
      { id: 1, why: "Waiting 1h" },
    ]);
    expect(overview.counts).toEqual({ moving: 0, waiting: 1, parked: 0 });
  });

  test("groups open tasks by top-level project, the one needing you first and tasks in no project last, with each row's short line", () => {
    const at = minutesAgo(600);
    const projects = [
      { id: 1, name: "Search", parentId: null, createdAt: at },
      { id: 2, name: "Indexing", parentId: 1, createdAt: at },
      { id: 3, name: "Billing", parentId: null, createdAt: at },
    ];
    const long = "PR #41 has the retry fix and full manual test results; awaiting Sam's approval";
    const tasks = [
      task({ id: 1, projectId: 2, blockedOn: "others", blockedReason: long }),
      task({ id: 2, projectId: 3, blockedOn: "me", blockedReason: "Pick a plan tier" }),
      task({ id: 3, projectId: null, stage: "idea" }),
      task({ id: 4, projectId: 1, stage: "done", doneAt: minutesAgo(90) }),
    ];
    const view = boardWith(tasks, {
      projects,
      summaries: new Map([[1, { text: "Index fix waits on Sam", at, basis: "x" }]]),
      briefs: new Map([[long, "Waiting on Sam's approval"]]),
    });
    expect(view.overview.workstreams).toEqual([
      { id: 3, name: "Billing", summary: null, taskIds: [2], needsYou: 1, shipped: 0 },
      { id: 1, name: "Search", summary: "Index fix waits on Sam", taskIds: [1], needsYou: 0, shipped: 1 },
      { id: null, name: "Not in a project", summary: null, taskIds: [3], needsYou: 0, shipped: 0 },
    ]);
    const brief = new Map(view.columns.flatMap((column) => column.cards).map((card) => [card.id, card.brief]));
    expect(brief.get(1)).toBe("Waiting on Sam's approval");
    expect(brief.get(2)).toBe("Pick a plan tier");
    expect(brief.get(3)).toBe("Not started");
  });
});
