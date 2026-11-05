import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parsePaneTitle } from "../server/sessions.ts";
import { listOmpPanes, mainSessionName, newWindow, pasteText, selectWindow } from "../tmux.ts";
import { assembleBoard, describeOwner, liveSessions, parsePrRef, sourceFor } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import { closePullRequest, fetchBoardData, fetchPullRequest, type BoardData } from "./github.ts";
import { REQUEST_MAX_AGE_MS, approvalState, requestProgress, waitingAsks, type ApprovalState, type CardOwner } from "./lanes.ts";
import { prOwner, readSessionHeader } from "./owners.ts";
import { BOARD_ACTIONS, boardView, type BoardAction, type BoardView } from "./view.ts";
import { AGENT_ACTIONS, agentRequests, approvalAsks, latestAgentReviews, latestCiFixes, openBoardStore, recordAgentRequest, type AgentAction } from "./store.ts";
import { assembleTasks } from "./taskCommand.ts";
import { bringRelayTerminalToFront } from "./terminalApp.ts";

const MAX_ACTION_BODY_BYTES = 4096;
/** How long a reopened session may take to load before a button gives up on it. */
const REOPEN_TIMEOUT_MS = 30_000;
const READY_SETTLE_MS = 800;

/** The last GitHub fetch that worked, shown only when a fresh one fails, and labeled as such. */
let lastGood: { data: BoardData; at: Date } | null = null;

/**
 * The board, as the Relay Board app shows it. Every view fetches from GitHub, so a refresh always
 * shows what GitHub has right now. Sessions, agent results, the requests the board sent, and your
 * tasks are read fresh too; tasks show even when GitHub can't be read. The app shows only your own
 * PRs, so it skips the searches for PRs waiting on your review.
 */
export async function fetchBoardView(): Promise<BoardView> {
  const config = loadBoardConfig();
  let error: string | undefined;
  try {
    lastGood = { data: await fetchBoardData(config, { reviewRequests: false, recheck: recentMergeRequests() }), at: new Date() };
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const live = await liveSessions();
  const board = lastGood ? await assembleBoard(lastGood.data, config, live) : null;
  const now = new Date();
  const tasks = assembleTasks(board, live, now);
  return boardView(board, { now, updatedAt: lastGood?.at ?? null, error, tasks: tasks.view, taskChips: tasks.chips });
}

/**
 * PRs the board recently asked to merge. Search can keep listing a just-merged PR as open, so the
 * board re-reads these directly, and the card leaves the moment the merge lands.
 */
function recentMergeRequests(): Set<string> {
  const db = openBoardStore();
  try {
    const since = Date.now() - REQUEST_MAX_AGE_MS;
    return new Set([...agentRequests(db)].filter(([, requests]) => requests.merge && new Date(requests.merge).getTime() > since).map(([key]) => key));
  } finally {
    db.close();
  }
}

/**
 * The board's endpoints type into your sessions, so on top of the phone token they only answer this
 * computer: the request must come from loopback and name localhost, which also stops a page that
 * rebinds its domain to 127.0.0.1 from talking to them.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "::1" || /^(::ffff:)?127\./.test(address);
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  return loopback && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
}

export type BoardActionResult = { status: number; message: string };

function reviewPrompt(url: string): string {
  return (
    `Run a reviewer agent on ${url}. When it finishes, record the result with ` +
    `\`relay board review ${url} --passed\` or \`--findings <n>\`, adding \`--summary -\` with the reviewer's ` +
    `verdict and each finding on stdin (a heredoc), so the board can show what it said. ` +
    `Then tell me what it found and ask before changing any code.`
  );
}

function mergePrompt(url: string): string {
  return (
    `I pressed Merge on the relay board for ${url}: that's my explicit approval to merge it. ` +
    `Merge it the repo's normal way: squash by default, or its merge queue or merge-gate bot/comment if it uses one. ` +
    `Confirm the required checks and approvals first, and never bypass branch protection or admin-merge; ` +
    `if something blocks the merge, stop and tell me why. Then tell me how it went.`
  );
}

function fixCiPrompt(url: string): string {
  return (
    `I pressed Fix CI on the relay board for ${url}. Look at the failing checks on its head commit and find out why they failed. ` +
    `If it's a flaky or infrastructure failure, retry the failed jobs; if it's a real failure, fix it with a new signed commit and push it ` +
    `(never force-push or amend shared history). Don't change behavior beyond what CI needs, and don't bypass or disable checks. ` +
    `Once the fix is pushed or the jobs retried (waiting for the rerun to finish when practical), record the result with ` +
    `\`relay board ci-fix ${url} --fixed --summary -\`, putting what failed, whether it was flaky, and what you did on stdin (a heredoc); ` +
    `if you can't fix it, record \`--not-fixed\` with why. Then tell me how it went.`
  );
}

/** Slack asks are only ever drafted: Philip reads and sends them himself. */
const DRAFT_ONLY =
  `Only ever draft, with the Slack MCP draft tool (slack_send_message_draft); never send or schedule a message, since I send drafts myself.`;

/** What a step's prompt can say about the PR besides its URL. */
interface PromptContext {
  approval: ApprovalState;
  /** Who approved the PR so far; empty when GitHub didn't answer. */
  approvedBy: string[];
}

/**
 * Asks each reviewer the PR waits on that no ask went to yet, in that reviewer's own channel; with
 * none listed, the session works out who. It first looks for asks the user already sent outside the
 * board, and links those instead of drafting again.
 */
export function askApprovalPrompt(url: string, { approval, approvedBy }: PromptContext): string {
  const { unasked } = approval;
  const { repo, number } = parsePrRef(url);
  const asked = approval.asks.flatMap((ask) => (ask.reviewer ? [`${ask.reviewer}${ask.channel ? ` in ${ask.channel}` : ""}`] : []));
  const leaveOut = [approvedBy.length ? `approved already (${approvedBy.join(", ")})` : null, asked.length ? `was asked already (${asked.join(", ")})` : null]
    .filter((part): part is string => part !== null)
    .join(" or ");
  const who = unasked.length
    ? `It still waits on approval from ${unasked.join(", ")}, and the board has no ask for ${unasked.length === 1 ? "that reviewer yet: ask it" : "those reviewers yet: ask each of them"}.`
    : `GitHub doesn't list anyone it still waits on, though it still needs approval: work out who from its required reviewers or CODEOWNERS ` +
      `(the owners of the files it changes; its merge gate's status may say what's missing)${leaveOut ? `, leaving out anyone who ${leaveOut}` : ""}, and ask each of them.`;
  return (
    `I pressed Ask for Approval on the relay board for ${url}. ${who} ${DRAFT_ONLY} ` +
    `First, find asks already sent: I often ask for review in Slack myself, outside the board. Search Slack with slack_search_public_and_private ` +
    `(review channels can be private) for messages containing ${url}, and for ${repo.split("/")[1]}#${number}, mine or anyone's. ` +
    `Then, for each reviewer, find the Slack channel where that team or person takes review requests: search Slack for the team's channel, or for earlier review requests sent to them. ` +
    `If a reviewer's channel is unclear, ask me which instead of guessing, and don't draft for them yet. ` +
    `If a message you found asks for this PR's review in that channel, or elsewhere but clearly asks that reviewer's team, don't draft for them: ` +
    `record it with \`relay board approval ${url} --asked --existing --for <reviewer> --channel <channel-name> --slack <permalink>\`, ` +
    `using that message's own permalink (the board reads when it was asked from it). If you can't tell whether a message you found counts as asking a reviewer, ask me instead of guessing. ` +
    `For every other reviewer, draft one message per channel (reviewers who share a channel share one): the PR's link (${url}) and one plain-English sentence on what the PR does and why, ` +
    `in the same format and tone as my earlier review requests (the ones you found while searching), or casual and short if there are none. Right after each draft, record it with ` +
    `\`relay board approval ${url} --asked --for <reviewer> --channel <channel-name> --slack <link>\`, using the channel link the draft tool returned. ` +
    `Either way, name the reviewers by GitHub login or team slug (comma-separated when one message asks several) and the channel by its name without the # (a shell reads # as a comment). ` +
    `Then tell me which asks you found and linked, with each one's channel and link, and which you drafted, with each one's channel and what it says.`
  );
}

/** Bumps each ask whose reviewer hasn't approved yet, in its own thread; asks whose reviewer approved are left out. */
export function bumpPrompt(url: string, { approval, approvedBy }: PromptContext): string {
  const asks = waitingAsks(approval).map((ask, index) =>
    ask.reviewer
      ? `(${index + 1}) the ask to ${ask.reviewer}${ask.channel ? ` in ${ask.channel}` : ""}, which the board has at ${ask.slackUrl}` +
        `${ask.source === "found" ? " (found already sent: that link is the message itself)" : ""}: ` +
        `record its bump with \`relay board approval ${url} --bumped --for ${ask.reviewer} --slack <permalink>\``
      : `(${index + 1}) an ask from before the board noted who an ask was for, which it has at ${ask.slackUrl}: find who it asked, and skip it if they've approved since` +
        `${approvedBy.length ? ` (so far ${approvedBy.join(", ")} approved)` : ""}; else record its bump with ` +
        `\`relay board approval ${url} --bumped --channel <channel-name> --slack <permalink>\``,
  );
  const approved = approval.asks.flatMap((ask) => (ask.approved && ask.reviewer ? [ask.reviewer] : []));
  return (
    `I pressed Bump on the relay board for ${url}: it still waits on approvals. Bump each of these asks, whose reviewer hasn't approved yet` +
    `${approved.length ? ` (leave out the asks to ${approved.join(", ")}: they approved)` : ""}: ${asks.join("; ")}. ` +
    `For each, first find the ask as I actually sent it: when the board's link is a message permalink, that's the message; otherwise I send drafts myself, ` +
    `so search its channel for my message containing ${url}. ` +
    `If I never sent it, don't bump it: tell me so, and offer to draft it again (if I say yes, draft it like a first ask and record it with ` +
    `\`relay board approval ${url} --asked --for <reviewer> --channel <channel-name> --slack <link>\`). Otherwise draft a short, casual, lowercase bump as a reply ` +
    `in that message's thread (the draft tool's thread_ts is the message's ts, or its thread's when the ask is itself a reply in a thread); ` +
    `asks that share a message share one bump, recorded for each. ${DRAFT_ONLY} ` +
    `Record each bump right after drafting it, with the sent message's permalink, so the board links to its thread. Then tell me where each draft is and what it says.`
  );
}

/** What each step button pastes into the PR's session, and how the board words it. */
const REQUESTS: Record<AgentAction, { prompt: (url: string, context: PromptContext) => string; asked: string; running: string }> = {
  review: { prompt: reviewPrompt, asked: "review", running: "reviewing" },
  merge: { prompt: mergePrompt, asked: "merge", running: "merging" },
  "fix-ci": { prompt: fixCiPrompt, asked: "fix CI on", running: "fixing CI on" },
  "ask-approval": { prompt: askApprovalPrompt, asked: "draft Slack approval asks for", running: "drafting approval asks for" },
  bump: { prompt: bumpPrompt, asked: "draft Slack bumps for", running: "drafting bumps for" },
};

function isBoardAction(action: string): action is BoardAction {
  return (BOARD_ACTIONS as readonly string[]).includes(action);
}

/** Reopens a closed session in a new relay tab, returning its pane; `focus` switches relay to it. */
export async function reopen(sessionFile: string, focus: boolean): Promise<string> {
  const tmuxSession = await mainSessionName();
  if (!tmuxSession) throw new ActionError(409, "relay isn't running; open it with `relay` first");
  const paneId = await newWindow(tmuxSession, readSessionHeader(sessionFile).cwd ?? homedir(), ["--resume", sessionFile]);
  if (focus) await selectWindow(paneId);
  return paneId;
}

/**
 * Waits for a freshly reopened omp to load its session and sit idle. Its pane title only takes
 * omp's "π > title" form once the TUI is up; before that the title is the shell's.
 */
export async function waitUntilReady(paneId: string): Promise<void> {
  const deadline = Date.now() + REOPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pane = (await listOmpPanes()).find((candidate) => candidate.paneId === paneId);
    if (pane && pane.title.trim().startsWith("π") && parsePaneTitle(pane.title, pane.cwd).status === "idle") {
      // The title flips a moment before the editor takes input.
      await sleep(READY_SETTLE_MS);
      return;
    }
    await sleep(250);
  }
  throw new ActionError(504, "the session took too long to reopen; it's open in relay now, so press the button again");
}

export class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pastes `prompt` into a session, reopening a closed one in a background tab first so the prompt
 * lands where its history is. Refuses a session that's mid-task. Returns whether it reopened.
 */
export async function promptSession(sessionFile: string, live: { paneId: string; status: string } | null, name: string, prompt: string): Promise<boolean> {
  if (live?.status === "working") throw new ActionError(409, `"${name}" is busy. Try again once it's idle.`);
  let paneId = live?.paneId;
  if (!paneId) {
    paneId = await reopen(sessionFile, false);
    await waitUntilReady(paneId);
  }
  await pasteText(paneId, prompt);
  return !live;
}

/** Shows a session in your terminal: switches relay to its tab, or reopens it in a new one. Returns what it did, in words. */
export async function showSession(sessionFile: string, live: { windowId: string } | null, name: string): Promise<string> {
  if (live) await selectWindow(live.windowId);
  else await reopen(sessionFile, true);
  // The tab already switched, so a terminal we can't raise only costs you an app switch.
  await bringRelayTerminalToFront().catch((error) => console.error(`relay board: couldn't bring the terminal forward: ${error}`));
  return live ? `Switched relay to "${name}"` : `Reopened "${name}" in a new relay tab`;
}

/**
 * `open` shows the PR's session in relay. `review`, `merge`, `fix-ci`, `ask-approval`, and `bump` ask
 * that session to take the PR's next step, reopening it in a background tab first if it's closed, and
 * note the request so the card can follow it until it's done. `close` closes the PR on GitHub, and needs no session.
 */
export async function runBoardAction(action: string, prRef: string): Promise<BoardActionResult> {
  if (!isBoardAction(action)) return { status: 404, message: `no such action: ${action}` };
  const { repo, number } = parsePrRef(prRef);
  if (action === "close") {
    try {
      await closePullRequest(sourceFor(loadBoardConfig(), repo), repo, number);
    } catch (error) {
      return { status: 502, message: `Couldn't close ${repo}#${number}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { status: 200, message: `Closed ${repo}#${number}` };
  }
  const db = openBoardStore();
  let owner;
  let asks;
  try {
    owner = prOwner(db, repo, number);
    asks = approvalAsks(db).get(`${repo}#${number}`) ?? [];
  } finally {
    db.close();
  }
  if (!owner) return { status: 404, message: `no omp session is in charge of ${repo}#${number}` };
  const card = describeOwner(owner, await liveSessions());
  const name = card.title || "the session";
  if (!card.live && !existsSync(owner.sessionFile)) return { status: 410, message: `"${name}" no longer exists` };

  try {
    if (action === "open") return { status: 200, message: await showSession(owner.sessionFile, card.live, name) };

    // The card may be older than the PR: a step on one that already merged or closed would only confuse its session.
    // If GitHub doesn't answer, the session checks the PR itself before acting, and works out who to ask for approval.
    const pr = await fetchPullRequest(sourceFor(loadBoardConfig(), repo), repo, number).catch(() => null);
    const approval = approvalState(pr ?? { approvedBy: [], approvedFor: [], waitingOn: [] }, asks);
    // A request sent moments ago may not show the session as working yet, while it reopens.
    const running = runningRequest(repo, number, approval, card.live);
    if (running) return { status: 409, message: `"${name}" is already ${REQUESTS[running].running} ${repo}#${number}` };
    if (pr && pr.state !== "OPEN") return { status: 409, message: `${repo}#${number} is already ${pr.state === "MERGED" ? "merged" : "closed"}` };
    if (action === "bump" && waitingAsks(approval).length === 0) {
      const why = asks.length ? "everyone it asked has approved" : "no approval ask is recorded for it yet";
      return { status: 409, message: `${repo}#${number} has nothing to bump: ${why}` };
    }
    const url = `https://github.com/${repo}/pull/${number}`;
    const reopened = await promptSession(owner.sessionFile, card.live, name, REQUESTS[action].prompt(url, { approval, approvedBy: pr?.approvedBy ?? [] }));
    const store = openBoardStore();
    try {
      recordAgentRequest(store, repo, number, action, new Date().toISOString());
    } finally {
      store.close();
    }
    return { status: 200, message: `Asked "${name}" to ${REQUESTS[action].asked} ${repo}#${number}${reopened ? " (reopened it in a new relay tab)" : ""}` };
  } catch (error) {
    if (error instanceof ActionError) return { status: error.status, message: error.message };
    throw error;
  }
}

/** The request the PR's session is still on, if any. */
function runningRequest(repo: string, number: number, approval: ApprovalState, live: CardOwner["live"]): AgentAction | undefined {
  const key = `${repo}#${number}`;
  const db = openBoardStore();
  try {
    // The PR is still open: its card offered the button, and merging takes the card away.
    const results = { mergedAt: null, review: latestAgentReviews(db).get(key), ciFix: latestCiFixes(db).get(key), approval };
    const progress = requestProgress(agentRequests(db).get(key), results, live, new Date());
    return AGENT_ACTIONS.find((action) => progress[action] === "running");
  } finally {
    db.close();
  }
}

/** Reads an action's small JSON body: `{ "pr": "owner/repo#12" }`. */
export async function readActionBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_ACTION_BODY_BYTES) throw new Error("request body too large");
  }
  const body = JSON.parse(raw || "{}") as { pr?: unknown };
  if (typeof body.pr !== "string") throw new Error("missing pr");
  parsePrRef(body.pr);
  return body.pr;
}
