import { expect, test } from "bun:test";
import { parseTitle, provisionalTitle } from "./autoTitle.ts";
import { openBoardStore } from "./store.ts";
import { createTask, getTask, retitleTask } from "./taskStore.ts";

test("a model's title is read without the quotes, label, or period it may add", () => {
  expect(parseTitle('"Retry failed uploads."')).toBe("Retry failed uploads");
  expect(parseTitle("\nTitle: **Fix login timeout in staging**\n")).toBe("Fix login timeout in staging");
  expect(parseTitle("  \n ")).toBeNull();
});

test("the stand-in title is the first line of the request, cut short", () => {
  expect(provisionalTitle("\n  fix the flaky   upload test\nit fails on main too")).toBe("fix the flaky upload test");
  const long = provisionalTitle("a".repeat(200));
  expect(long.length).toBe(60);
  expect(long.endsWith("…")).toBe(true);
});

test("relay's title replaces only the stand-in it started from", () => {
  const db = openBoardStore();
  const task = createTask(db, { title: "can you fix the", details: "can you fix the upload test", projectId: null, stage: "idea", status: null, approvePlan: true, cwd: null, at: "2026-11-09T10:00:00Z" });
  expect(retitleTask(db, task.id, "something else", "Fix the upload test")).toBe(false);
  expect(retitleTask(db, task.id, "can you fix the", "Fix the upload test")).toBe(true);
  expect(getTask(db, task.id)!.title).toBe("Fix the upload test");
  db.close();
});
