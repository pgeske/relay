import { expect, test } from "bun:test";
import { parseChannel, parsePrRef, parseReviewers, parseSlackLink } from "./command.ts";

test("a PR can be named by URL, with or without a trailing tab, or as owner/repo#number", () => {
  expect(parsePrRef("https://github.com/acme/api/pull/12")).toEqual({ repo: "acme/api", number: 12 });
  expect(parsePrRef("https://github.com/acme/api/pull/12/files")).toEqual({ repo: "acme/api", number: 12 });
  expect(parsePrRef("acme/api#12")).toEqual({ repo: "acme/api", number: 12 });
});

test("anything else is rejected rather than guessed", () => {
  expect(() => parsePrRef("api#12")).toThrow("not a pull request");
  expect(() => parsePrRef("https://github.com/acme/api/issues/12")).toThrow("not a pull request");
});

test("an approval ask's link must be a Slack link, since the board opens it", () => {
  expect(parseSlackLink("https://app.slack.com/client/T1/C1")).toBe("https://app.slack.com/client/T1/C1");
  expect(parseSlackLink("https://acme.slack.com/archives/C1/p1793643074057839")).toBe("https://acme.slack.com/archives/C1/p1793643074057839");
  expect(() => parseSlackLink("javascript:alert(1)")).toThrow("not a Slack link");
  expect(() => parseSlackLink("http://acme.slack.com/archives/C1")).toThrow("not a Slack link");
  expect(() => parseSlackLink("https://slack.com.evil.example/archives/C1")).toThrow("not a Slack link");
  expect(() => parseSlackLink("#reviews")).toThrow("not a Slack link");
});

test("an ask's reviewers are named as GitHub's review requests name them, by login or team slug", () => {
  expect(parseReviewers("cache-team")).toEqual(["cache-team"]);
  expect(parseReviewers("@acme/cache-team, sara ,")).toEqual(["cache-team", "sara"]);
  expect(() => parseReviewers(" , ")).toThrow("--for needs a reviewer");
});

test("an ask's channel is named as Slack names it", () => {
  expect(parseChannel("cache-team")).toBe("#cache-team");
  expect(parseChannel(" #sre ")).toBe("#sre");
  expect(parseChannel("@sara")).toBe("@sara");
  expect(() => parseChannel("#")).toThrow("--channel needs");
});
