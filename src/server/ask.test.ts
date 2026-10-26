import { describe, expect, test } from "bun:test";
import { askAnswerSteps, validateAskAnswers, type AskQuestion } from "./ask.ts";

function question(optionCount: number, multi = false): AskQuestion {
  return {
    id: "q",
    question: "Pick?",
    options: Array.from({ length: optionCount }, (_, index) => ({ label: `Option ${index}` })),
    multi,
  };
}

/** The key presses only, with pastes shown as `paste:<text>` and waits dropped. */
function keysOf(questions: AskQuestion[], answers: Parameters<typeof askAnswerSteps>[1]): string[] {
  return askAnswerSteps(questions, answers).flatMap((step) => {
    if ("keys" in step) return step.keys;
    if ("paste" in step) return [`paste:${step.paste}`];
    return [];
  });
}

describe("askAnswerSteps", () => {
  test("a lone single-select question submits on Enter, with no Review tab", () => {
    // Three options plus the Other row: four Ups always reach row 0, whatever was recommended.
    expect(keysOf([question(3)], [{ options: [2] }])).toEqual(["Up", "Up", "Up", "Up", "Down", "Down", "Enter"]);
  });

  test("a typed answer opens the Other row's prompt and pastes into it", () => {
    expect(keysOf([question(2)], [{ options: [], custom: "blue" }])).toEqual([
      "Up", "Up", "Up", "Down", "Down", "Enter", "paste:blue", "Enter",
    ]);
  });

  test("multi-select toggles each pick with Space, in row order, then confirms on an option row", () => {
    expect(keysOf([question(4, true)], [{ options: [3, 1] }])).toEqual([
      "Up", "Up", "Up", "Up", "Up", "Down", "Space", "Down", "Down", "Space", "Enter",
    ]);
  });

  test("a lone multi-select question with a typed answer still needs the Review tab's Enter", () => {
    expect(keysOf([question(1, true)], [{ options: [0], custom: "also this" }])).toEqual([
      "Up", "Up", "Space", "Down", "Enter", "paste:also this", "Enter", "Enter",
    ]);
  });

  test("several questions answer in order, then submit from the Review tab", () => {
    expect(keysOf([question(1), question(2)], [{ options: [0] }, { options: [1] }])).toEqual([
      "Up", "Up", "Enter", "Up", "Up", "Up", "Down", "Enter", "Enter",
    ]);
  });
});

describe("validateAskAnswers", () => {
  test("single-select needs exactly one pick or typed answer", () => {
    expect(validateAskAnswers([question(2)], [{ options: [0, 1] }])).not.toBeNull();
    expect(validateAskAnswers([question(2)], [{ options: [0], custom: "x" }])).not.toBeNull();
    expect(validateAskAnswers([question(2)], [{ options: [], custom: "  " }])).not.toBeNull();
    expect(validateAskAnswers([question(2)], [{ options: [1] }])).toBeNull();
  });

  test("rejects options outside the question", () => {
    expect(validateAskAnswers([question(2, true)], [{ options: [2] }])).not.toBeNull();
  });
});
