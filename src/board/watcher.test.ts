import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { PullRequest } from "./github.ts";
import type { FinishedReviewerRun } from "./reviewerRuns.ts";
import { latestAgentReviews, openBoardStore, recordAgentReview } from "./store.ts";
import { recordRecoveredReview } from "./watcher.ts";

const pr = { repo: "acme/api", number: 7, headSha: "aaa" } as PullRequest;
const run = (id: string, finishedAt: string, output: string): FinishedReviewerRun => ({ id, startedAt: "2026-11-10T12:00:00.000Z", finishedAt, assignment: "", output });
const latest = (db: Database) => latestAgentReviews(db).get("acme/api#7");

test("reviewers that ran side by side on one commit add up, even finishing at the same moment", () => {
  const db = openBoardStore(":memory:");
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  recordRecoveredReview(db, run("Security", "2026-11-10T12:05:00.000Z", "Token logged in plain text"), pr, 1);
  expect(latest(db)).toMatchObject({ verdict: "findings", findings: 1 });
  expect(latest(db)?.summary).toContain("Looks fine");
  expect(latest(db)?.summary).toContain("Token logged in plain text");
});

test("a review the agent recorded after the run finished wins", () => {
  const db = openBoardStore(":memory:");
  recordAgentReview(db, { repo: "acme/api", number: 7, headSha: "aaa", verdict: "findings", findings: 2, summary: "the agent's", reviewedAt: "2026-11-10T12:06:00.000Z" });
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  expect(latest(db)).toMatchObject({ findings: 2, summary: "the agent's" });
});

test("a review of an earlier commit gives way", () => {
  const db = openBoardStore(":memory:");
  recordAgentReview(db, { repo: "acme/api", number: 7, headSha: "old", verdict: "findings", findings: 3, summary: null, reviewedAt: "2026-11-10T11:00:00.000Z" });
  recordRecoveredReview(db, run("General", "2026-11-10T12:05:00.000Z", "Looks fine"), pr, 0);
  expect(latest(db)).toMatchObject({ headSha: "aaa", verdict: "passed", findings: 0 });
});
