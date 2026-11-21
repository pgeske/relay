import { expect, test } from "bun:test";
import { openBoardStore } from "./store.ts";
import { createTask, ensureProject, getTask, listProjects, projectPaths, projectSummaries, reportTask, setTaskProject, textBriefs, type NewTask } from "./taskStore.ts";
import { briefTexts, fileTasks, summarizeProjects, type Ask } from "./workstreams.ts";

const at = "2026-11-04T10:00:00Z";
const now = new Date("2026-11-04T12:00:00Z");
const base: NewTask = { title: "Roll out the cache", details: null, projectId: null, stage: "doing", status: null, approvePlan: false, cwd: null, at };

/** A model stand-in that answers with `reply` and keeps the prompts it was asked. */
function fakeModel(reply: string): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  return Object.assign(async (prompt: string) => (prompts.push(prompt), reply), { prompts });
}

test("unfiled tasks go where the model puts them, new workstreams included, and a task it skipped isn't asked about again", async () => {
  const db = openBoardStore(":memory:");
  const search = ensureProject(db, "Search", at);
  createTask(db, { ...base, title: "Turn on the search cache", projectId: search.id });
  const rollout = createTask(db, { ...base, title: "Roll the cache out to prod" }).id;
  const review = createTask(db, { ...base, title: "Review Sam's PR" }).id;
  const skipped = createTask(db, { ...base, title: "Something odd" }).id;

  const model = fakeModel(`{"T-${rollout}": "Search", "T-${review}": "Reviews and requests"}`);
  await fileTasks(db, model, now);

  // The model saw what's in each workstream, to know what fits.
  expect(model.prompts[0]).toContain(`- Search: "Turn on the search cache"`);
  const paths = projectPaths(listProjects(db));
  expect(paths.get(getTask(db, rollout)!.projectId!)).toBe("Search");
  expect(paths.get(getTask(db, review)!.projectId!)).toBe("Reviews and requests");
  expect(getTask(db, skipped)!.projectId).toBeNull();

  await fileTasks(db, model, now);
  expect(model.prompts).toHaveLength(1);
});

test("relay never files a task you placed by hand, even one you took out of every project", async () => {
  const db = openBoardStore(":memory:");
  const search = ensureProject(db, "Search", at);
  const id = createTask(db, base).id;
  setTaskProject(db, id, search.id, at);
  setTaskProject(db, id, null, at);

  const model = fakeModel(`{"T-${id}": "Search"}`);
  await fileTasks(db, model, now);
  expect(model.prompts).toHaveLength(0);
  expect(getTask(db, id)!.projectId).toBeNull();
});

test("a project an agent picked while the model was thinking stands", async () => {
  const db = openBoardStore(":memory:");
  const id = createTask(db, base).id;
  const billing = ensureProject(db, "Billing", at);
  const model: Ask = async () => {
    reportTask(db, id, { blocked: null, projectId: billing.id, at });
    return `{"T-${id}": "Search"}`;
  };
  await fileTasks(db, model, now);
  expect(getTask(db, id)!.projectId).toBe(billing.id);
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

test("a workstream's summary covers its subprojects, and is only rewritten once its tasks change and a few minutes have passed", async () => {
  const db = openBoardStore(":memory:");
  const search = ensureProject(db, "Search", at);
  const indexing = ensureProject(db, "Search/Indexing", at);
  const id = createTask(db, { ...base, title: "Rebuild the index", projectId: indexing.id, status: "Backfill running" }).id;

  const model = fakeModel(`{"p${search.id}": "Index backfill running"}`);
  await summarizeProjects(db, model, now);
  expect(model.prompts[0]).toContain("Rebuild the index (doing; Backfill running)");
  expect(projectSummaries(db).get(search.id)?.text).toBe("Index backfill running");
  // Only top-level projects get a summary.
  expect(projectSummaries(db).has(indexing.id)).toBe(false);

  await summarizeProjects(db, model, new Date(now.getTime() + 60 * 60_000));
  expect(model.prompts).toHaveLength(1);

  reportTask(db, id, { status: "Backfill done", blocked: null, at });
  await summarizeProjects(db, model, new Date(now.getTime() + 60_000));
  expect(model.prompts).toHaveLength(1);
  await summarizeProjects(db, model, new Date(now.getTime() + 5 * 60_000));
  expect(model.prompts).toHaveLength(2);
});
