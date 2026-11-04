import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { approvalState } from "./lanes.ts";
import { askApprovalPrompt, bumpPrompt, isLocalRequest, runBoardAction } from "./serve.ts";
import type { ApprovalAsk } from "./store.ts";

function request(remoteAddress: string, host: string): IncomingMessage {
  return { socket: { remoteAddress }, headers: { host } } as unknown as IncomingMessage;
}

test("this computer reaches the board", () => {
  expect(isLocalRequest(request("127.0.0.1", "localhost:7878"))).toBe(true);
  expect(isLocalRequest(request("::ffff:127.0.0.1", "127.0.0.1:7878"))).toBe(true);
  expect(isLocalRequest(request("::1", "[::1]:7878"))).toBe(true);
});

test("other machines don't, even on the LAN or Tailscale", () => {
  expect(isLocalRequest(request("192.168.1.20", "localhost:7878"))).toBe(false);
  expect(isLocalRequest(request("100.101.102.103", "localhost:7878"))).toBe(false);
});

test("a page on another site that rebinds its domain to 127.0.0.1 doesn't either", () => {
  expect(isLocalRequest(request("127.0.0.1", "evil.example:7878"))).toBe(false);
});

test("an action the board doesn't have is refused", async () => {
  expect(await runBoardAction("deploy", "acme/api#1")).toEqual({ status: 404, message: "no such action: deploy" });
});

test.each(["open", "review", "merge", "fix-ci", "ask-approval", "bump"])("%s needs a session in charge of the PR", async (action) => {
  expect(await runBoardAction(action, "acme/api#1")).toEqual({ status: 404, message: "no omp session is in charge of acme/api#1" });
});

describe("the Slack steps' prompts", () => {
  const url = "https://github.com/acme/api/pull/1";
  const ask = (reviewer: string | null, channel: string | null): ApprovalAsk => ({
    repo: "acme/api",
    number: 1,
    reviewer,
    channel,
    askedAt: "2026-11-01T00:00:00Z",
    recordedAt: "2026-11-01T00:00:00Z",
    source: "drafted",
    bumpedAt: null,
    slackUrl: `https://acme.slack.com/archives/${reviewer ?? "old"}/p1`,
  });

  test("Ask for Approval names only the reviewers no ask went to yet, each to be asked in their own channel", () => {
    const approval = approvalState({ waitingOn: ["cache-team", "sre"], approvedBy: ["pat"], approvedFor: [] }, [ask("sre", "#sre")]);
    const prompt = askApprovalPrompt(url, { approval, approvedBy: ["pat"] });
    expect(prompt).toContain("It still waits on approval from cache-team, and the board has no ask for that reviewer yet: ask it.");
    expect(prompt).not.toContain("sre");
    expect(prompt).toContain("find the Slack channel where that team or person takes review requests");
    expect(prompt).toContain(`\`relay board approval ${url} --asked --for <reviewer> --channel <channel-name> --slack <link>\``);
    expect(prompt).toContain("never send or schedule");
  });

  test("with nobody listed, Ask for Approval has the session work out who, leaving out who approved or was asked", () => {
    const approval = approvalState({ waitingOn: [], approvedBy: ["pat"], approvedFor: [] }, [ask("sre", "#sre")]);
    const prompt = askApprovalPrompt(url, { approval, approvedBy: ["pat"] });
    expect(prompt).toContain("work out who from its required reviewers or CODEOWNERS");
    expect(prompt).toContain("leaving out anyone who approved already (pat) or was asked already (sre in #sre)");
  });

  test("Ask for Approval first looks for asks already sent, linking those it finds, and drafts only for the rest", () => {
    const approval = approvalState({ waitingOn: ["cache-team"], approvedBy: [], approvedFor: [] }, []);
    const prompt = askApprovalPrompt(url, { approval, approvedBy: [] });
    const search = prompt.indexOf("slack_search_public_and_private");
    const link = prompt.indexOf(`\`relay board approval ${url} --asked --existing --for <reviewer> --channel <channel-name> --slack <permalink>\``);
    const draft = prompt.indexOf(`\`relay board approval ${url} --asked --for <reviewer> --channel <channel-name> --slack <link>\``);
    // It searches for the PR both ways it's written: its URL, and repo#number.
    expect(prompt.slice(search)).toContain(url);
    expect(prompt.slice(search)).toContain("api#1");
    expect([search, link, draft].every((at) => at >= 0)).toBe(true);
    expect(search).toBeLessThan(link);
    expect(link).toBeLessThan(draft);
  });

  test("Bump lists each ask still waiting, and leaves out those whose reviewer approved", () => {
    const asks = [ask("cache-team", "#cache-team"), ask("infra", "#infra"), ask(null, null)];
    const approval = approvalState({ waitingOn: ["cache-team"], approvedBy: ["pat"], approvedFor: ["infra"] }, asks);
    const prompt = bumpPrompt(url, { approval, approvedBy: ["pat"] });
    expect(prompt).toContain("(1) the ask to cache-team in #cache-team, which the board has at https://acme.slack.com/archives/cache-team/p1");
    expect(prompt).toContain(`\`relay board approval ${url} --bumped --for cache-team --slack <permalink>\``);
    expect(prompt).toContain("(2) an ask from before the board noted who an ask was for");
    expect(prompt).toContain(`\`relay board approval ${url} --bumped --channel <channel-name> --slack <permalink>\``);
    expect(prompt).toContain("(leave out the asks to infra: they approved)");
    expect(prompt).not.toContain("--for infra");
  });

  test("Bump treats an ask found already sent as the message itself", () => {
    const found: ApprovalAsk = { ...ask("cache-team", "#cache-help"), source: "found", slackUrl: "https://acme.slack.com/archives/C1/p1793746643786509" };
    const prompt = bumpPrompt(url, { approval: approvalState({ waitingOn: ["cache-team"], approvedBy: [], approvedFor: [] }, [found]), approvedBy: [] });
    expect(prompt).toContain("which the board has at https://acme.slack.com/archives/C1/p1793746643786509 (found already sent");
    expect(prompt).toContain(`\`relay board approval ${url} --bumped --for cache-team --slack <permalink>\``);
    // A drafted ask isn't marked.
    expect(bumpPrompt(url, { approval: approvalState({ waitingOn: ["cache-team"], approvedBy: [], approvedFor: [] }, [ask("cache-team", "#cc")]), approvedBy: [] })).not.toContain("found already sent");
  });
});
