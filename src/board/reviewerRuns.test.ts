import { expect, test } from "bun:test";
import { parseReviewerRun } from "./autoStatus.ts";
import { durationMs, parseReviewerRuns } from "./reviewerRuns.ts";

const result = (id: string, agent: string, duration: string, output: string) =>
  `<task-result id="${id}" agent="${agent}" status="completed" duration="${duration}">\n\n<output>\n${output}\n</output>\n</task-result>`;

/** A `task` call sending off one reviewer, named `name`, or left for omp to name when null. */
function taskCall(at: string, name: string | null, callId = "call-1") {
  return {
    type: "message",
    timestamp: at,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callId,
          name: "task",
          arguments: { context: "# Goal\nReview https://github.com/acme/api/pull/7", tasks: [{ ...(name ? { name } : {}), agent: "reviewer", task: "Look for bugs." }] },
        },
      ],
    },
  };
}

/** The `task` call's own result, naming the subagents it spawned. */
function spawned(at: string, id: string, callId = "call-1") {
  return {
    type: "message",
    timestamp: at,
    message: { role: "toolResult", toolName: "task", toolCallId: callId, content: [{ type: "text", text: `Spawned agent \`${id}\`.` }], details: { progress: [{ index: 0, id }] } },
  };
}

test("finds each reviewer that finished, once, with what it was asked and when it ran", () => {
  // Delivered late: when it ran comes from its dispatch and duration, not from when the session got it.
  const delivered = { type: "custom_message", timestamp: "2026-11-10T12:20:00.000Z", content: `Background job done.\n${result("ReviewPr7", "reviewer", "8m22s", "Two findings: …")}` };
  // The same result again, in a later wait's output.
  const waited = {
    type: "message",
    timestamp: "2026-11-10T12:21:00.000Z",
    message: { role: "toolResult", toolName: "wait", content: [{ type: "text", text: result("ReviewPr7", "reviewer", "8m22s", "Two findings: …") }] },
  };
  const scout = { type: "custom_message", timestamp: "2026-11-10T12:22:00.000Z", content: result("FindCallers", "scout", "1m", "Found 3 callers") };
  expect(parseReviewerRuns([taskCall("2026-11-10T12:00:00.000Z", "ReviewPr7"), delivered, waited, scout])).toEqual([
    {
      id: "ReviewPr7",
      startedAt: "2026-11-10T12:00:00.000Z",
      finishedAt: "2026-11-10T12:08:22.000Z",
      assignment: "# Goal\nReview https://github.com/acme/api/pull/7\n\nLook for bugs.",
      output: "Two findings: …",
    },
  ]);
});

test("a result whose dispatch isn't in the log is left out, and a reused name answers its latest dispatch", () => {
  const orphan = { type: "custom_message", timestamp: "2026-11-10T11:00:00.000Z", content: result("ReviewPr7", "reviewer", "1m", "Old run") };
  const again = taskCall("2026-11-10T13:00:00.000Z", "ReviewPr7", "call-2");
  const second = { type: "custom_message", timestamp: "2026-11-10T13:05:00.000Z", content: result("ReviewPr7", "reviewer", "5m", "Passed") };
  expect(parseReviewerRuns([orphan, taskCall("2026-11-10T12:00:00.000Z", "ReviewPr7"), again, second])).toMatchObject([{ startedAt: "2026-11-10T13:00:00.000Z", output: "Passed" }]);
});

test("a reviewer omp named itself is matched to its call through the call's result", () => {
  const done = { type: "custom_message", timestamp: "2026-11-10T12:06:00.000Z", content: result("Reviewer_3", "reviewer", "5m", "Passed") };
  const entries = [taskCall("2026-11-10T12:00:00.000Z", null), spawned("2026-11-10T12:00:01.000Z", "Reviewer_3"), done];
  expect(parseReviewerRuns(entries)).toMatchObject([{ id: "Reviewer_3", startedAt: "2026-11-10T12:00:00.000Z", assignment: expect.stringContaining("Look for bugs.") }]);
});

test("durationMs reads omp's durations", () => {
  expect(durationMs("8m22s")).toBe(502_000);
  expect(durationMs("1h2m3s")).toBe(3_723_000);
  expect(durationMs("45s")).toBe(45_000);
  expect(durationMs("850ms")).toBe(850);
  expect(durationMs("soon")).toBeNull();
  expect(durationMs("")).toBeNull();
});

test("parseReviewerRun only accepts one of the PRs it was offered", () => {
  const urls = ["https://github.com/acme/api/pull/7"];
  expect(parseReviewerRun('{"pr": "https://github.com/acme/api/pull/7", "findings": 2}', urls)).toEqual({ pr: urls[0], findings: 2 });
  expect(parseReviewerRun('{"pr": null}', urls)).toEqual({ pr: null });
  expect(parseReviewerRun('{"pr": "https://github.com/acme/api/pull/8", "findings": 0}', urls)).toBeNull();
  expect(parseReviewerRun('{"pr": "https://github.com/acme/api/pull/7"}', urls)).toBeNull();
});
