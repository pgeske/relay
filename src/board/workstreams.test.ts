import { expect, test } from "bun:test";
import { openBoardStore } from "./store.ts";
import { createTask, placeTasks, reportTask, taskWorkstreams, textBriefs, workstreamSummaries, type NewTask } from "./taskStore.ts";
import { briefTexts, groupTasks, summarizeWorkstreams, type Ask } from "./workstreams.ts";

const at = "2026-11-04T10:00:00Z";
const now = new Date("2026-11-04T12:00:00Z");
const base: NewTask = { title: "Roll out the cache", details: null, projectId: null, stage: "doing", status: null, approvePlan: false, cwd: null, at };

/** A model stand-in that answers with `reply` and keeps the prompts it was asked. */
function fakeModel(reply: string): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  return Object.assign(async (prompt: string) => (prompts.push(prompt), reply), { prompts });
}

test("new tasks go in the workstream and part the model picks, under the names already in use, and nothing is asked again until a task is new", async () => {
  const db = openBoardStore(":memory:");
  const cache = createTask(db, { ...base, title: "Turn on the search cache" }).id;
  placeTasks(db, new Map([[cache, ["Search"]]]), at);
  const index = createTask(db, { ...base, title: "Rebuild the index" }).id;
  const review = createTask(db, { ...base, title: "Review Sam's PR" }).id;
  const odd = createTask(db, { ...base, title: "Something odd" }).id;
  const longShipped = createTask(db, { ...base, title: "Old launch", stage: "done", at: "2026-10-01T10:00:00Z" }).id;

  const model = fakeModel(`{"T-${cache}": ["Search"], "T-${index}": ["search", "Indexing"], "T-${review}": ["Reviews and requests"]}`);
  await groupTasks(db, model, now);

  // The model saw the grouping so far, and what's new.
  expect(model.prompts[0]).toContain(`Search\n  - T-${cache}: Turn on the search cache`);
  expect(model.prompts[0]).toContain(`New tasks:\n- T-${index}: Rebuild the index`);
  expect(model.prompts[0]).not.toContain("Old launch");
  const placed = taskWorkstreams(db);
  expect(placed.get(index)).toEqual(["Search", "Indexing"]);
  expect(placed.get(review)).toEqual(["Reviews and requests"]);
  expect(placed.get(odd)).toBeNull();
  expect(placed.has(longShipped)).toBe(false);

  await groupTasks(db, model, now);
  expect(model.prompts).toHaveLength(1);
});

test("placing a new task can reshape the grouping, like two workstreams turning out to be parts of one", async () => {
  const db = openBoardStore(":memory:");
  const cache = createTask(db, { ...base, title: "Turn on the search cache" }).id;
  const index = createTask(db, { ...base, title: "Rebuild the index" }).id;
  placeTasks(db, new Map([[cache, ["Search cache"]], [index, ["Indexing"]]]), at);
  const launch = createTask(db, { ...base, title: "Launch the new search" }).id;

  await groupTasks(db, fakeModel(`{"T-${cache}": ["Search", "Cache"], "T-${index}": ["Search", "Indexing"], "T-${launch}": ["Search"]}`), now);
  expect([...taskWorkstreams(db)].toSorted()).toEqual([
    [cache, ["Search", "Cache"]],
    [index, ["Search", "Indexing"]],
    [launch, ["Search"]],
  ]);
});

test("only long status lines and reasons get a brief, once", async () => {
  const db = openBoardStore(":memory:");
  const long = "PR #41 has the retry fix and full manual test results in the description; awaiting Sam's approval";
  createTask(db, { ...base, status: "Tests green" });
  const id = createTask(db, base).id;
  reportTask(db, id, { status: "Short", blocked: { on: "others", reason: long }, at });

  const model = fakeModel(`{"1": "Waiting on Sam's approval."}`);
  await briefTexts(db, model, now);
  expect(model.prompts[0]).toContain(`1. ${long}`);
  expect(model.prompts[0]).not.toContain("Tests green");
  expect(textBriefs(db).get(long)).toBe("Waiting on Sam's approval");

  await briefTexts(db, model, now);
  expect(model.prompts).toHaveLength(1);
});

test("a workstream's summary covers its parts, is only rewritten once its tasks change and a few minutes have passed, and goes with its open tasks", async () => {
  const db = openBoardStore(":memory:");
  const id = createTask(db, { ...base, title: "Rebuild the index", status: "Backfill running" }).id;
  placeTasks(db, new Map([[id, ["Search", "Indexing"]]]), at);

  const model = fakeModel(`{"w1": "Index backfill running"}`);
  await summarizeWorkstreams(db, model, now);
  expect(model.prompts[0]).toContain("w1: Search\n- [Indexing] Rebuild the index (doing; Backfill running)");
  expect(workstreamSummaries(db).get("Search")?.text).toBe("Index backfill running");

  await summarizeWorkstreams(db, model, new Date(now.getTime() + 60 * 60_000));
  expect(model.prompts).toHaveLength(1);

  reportTask(db, id, { status: "Backfill done", blocked: null, at });
  await summarizeWorkstreams(db, model, new Date(now.getTime() + 60_000));
  expect(model.prompts).toHaveLength(1);
  await summarizeWorkstreams(db, model, new Date(now.getTime() + 5 * 60_000));
  expect(model.prompts).toHaveLength(2);

  placeTasks(db, new Map([[id, null]]), at);
  await summarizeWorkstreams(db, model, new Date(now.getTime() + 10 * 60_000));
  expect(model.prompts).toHaveLength(2);
  expect(workstreamSummaries(db).has("Search")).toBe(false);
});
