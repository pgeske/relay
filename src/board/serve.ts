import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parsePaneTitle } from "../server/sessions.ts";
import { listOmpPanes, mainSessionName, newWindow, pasteText, selectWindow } from "../tmux.ts";
import { assembleBoard, describeOwner, liveSessions, parsePrRef, sourceFor } from "./command.ts";
import { loadBoardConfig } from "./config.ts";
import { closePullRequest, fetchBoardData, fetchPullRequest, type BoardData } from "./github.ts";
import { REQUEST_MAX_AGE_MS, requestProgress, type CardOwner } from "./lanes.ts";
import { prOwner, readSessionHeader } from "./owners.ts";
import { renderBoardPage } from "./page.ts";
import {
  AGENT_ACTIONS,
  agentRequests,
  approvalAsks,
  latestAgentReviews,
  latestCiFixes,
  openBoardStore,
  recordAgentRequest,
  type AgentAction,
  type ApprovalAsk,
} from "./store.ts";
import { bringRelayTerminalToFront } from "./terminalApp.ts";

const MAX_ACTION_BODY_BYTES = 4096;
/** How long a reopened session may take to load before a button gives up on it. */
const REOPEN_TIMEOUT_MS = 30_000;
const READY_SETTLE_MS = 800;

/** The last GitHub fetch that worked, shown only when a fresh one fails, and labeled as such. */
let lastGood: { data: BoardData; at: Date } | null = null;

/**
 * The board page. Every view fetches from GitHub, so a reload always shows what GitHub has right
 * now; the browser keeps the old page up while the new one loads. Sessions, agent results, and the
 * requests the board sent are read fresh too. The page shows only your own PRs, so it skips the
 * searches for PRs waiting on your review.
 */
export async function boardPage(): Promise<string> {
  const config = loadBoardConfig();
  let error: string | undefined;
  try {
    lastGood = { data: await fetchBoardData(config, { reviewRequests: false, recheck: recentMergeRequests() }), at: new Date() };
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  const options = { now: new Date(), updatedAt: lastGood?.at ?? new Date(), error };
  return renderBoardPage(lastGood ? await assembleBoard(lastGood.data, config) : null, options);
}

/**
 * PRs the board recently asked to merge. Search can keep listing a just-merged PR as open, so the
 * page re-reads these directly, and the card leaves the moment the merge lands.
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
 * The page skips the phone token, so it is only served to this computer: the request must come
 * from loopback and name localhost, which also stops DNS rebinding from reading it.
 */
export function isLocalBrowserRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "::1" || /^(::ffff:)?127\./.test(address);
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  return loopback && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
}

/**
 * Buttons type into your sessions, so they also need the board page itself to have sent them:
 * browsers stamp every POST with its page's origin, and a page on another site can't fake ours.
 */
export function isBoardAction(req: IncomingMessage): boolean {
  return isLocalBrowserRequest(req) && req.headers.origin === `http://${req.headers.host}`;
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

function askApprovalPrompt(url: string): string {
  return (
    `I pressed Ask for approval on the relay board for ${url}. Draft a Slack message asking for a review of it. ${DRAFT_ONLY} ` +
    `Write it as \`${url}. <one plain-English sentence on what the PR does and why>\`, casual and lowercase, ` +
    `matching my recent messages in that channel. Draft it where I usually ask for reviews for this repo or its team: search my recent ` +
    `Slack messages for earlier review requests to find the channel. If the right channel is unclear, ask me which instead of guessing, and don't draft yet. ` +
    `Once the draft exists, record it with \`relay board approval ${url} --asked --slack <link>\`, using the channel link the draft tool returned. ` +
    `Then tell me the channel and what the draft says.`
  );
}

function bumpPrompt(url: string, ask: ApprovalAsk | undefined): string {
  const recorded = ask ? ` The board has the ask at ${ask.slackUrl}.` : "";
  return (
    `I pressed Bump on the relay board for ${url}: its approval ask hasn't got it approved yet.${recorded} ` +
    `First find the ask as I actually sent it: I send drafts myself, so search Slack for my message containing ${url}. ` +
    `If I never sent it, don't bump: tell me so, and offer to draft the ask again (if I say yes, draft it like a first ask and record it with ` +
    `\`relay board approval ${url} --asked --slack <link>\`). Otherwise draft a short, casual, lowercase bump as a reply in that message's thread ` +
    `(the draft tool's thread_ts is the message's ts). ${DRAFT_ONLY} Then record it with \`relay board approval ${url} --bumped --slack <permalink>\`, ` +
    `using the sent message's permalink, so the board links to its thread. Then tell me where the draft is and what it says.`
  );
}

/** What each step button pastes into the PR's session, and how the board words it. */
const REQUESTS: Record<AgentAction, { prompt: (url: string, ask: ApprovalAsk | undefined) => string; asked: string; running: string }> = {
  review: { prompt: reviewPrompt, asked: "review", running: "reviewing" },
  merge: { prompt: mergePrompt, asked: "merge", running: "merging" },
  "fix-ci": { prompt: fixCiPrompt, asked: "fix CI on", running: "fixing CI on" },
  "ask-approval": { prompt: askApprovalPrompt, asked: "draft a Slack approval ask for", running: "drafting an approval ask for" },
  bump: { prompt: bumpPrompt, asked: "draft a Slack bump for", running: "drafting a bump for" },
};

const BUTTONS = ["open", "close", ...AGENT_ACTIONS] as const;

function isButton(action: string): action is (typeof BUTTONS)[number] {
  return (BUTTONS as readonly string[]).includes(action);
}

/** Reopens a closed session in a new relay tab, returning its pane; `focus` switches relay to it. */
async function reopen(sessionFile: string, focus: boolean): Promise<string> {
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
async function waitUntilReady(paneId: string): Promise<void> {
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

class ActionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pastes `prompt` into a PR's session, reopening a closed one in a background tab first so the
 * prompt lands where the PR's history is. Refuses a session that's mid-task. Returns whether it reopened.
 */
async function promptSession(sessionFile: string, live: { paneId: string; status: string } | null, name: string, prompt: string): Promise<boolean> {
  if (live?.status === "working") throw new ActionError(409, `"${name}" is busy. Try again once it's idle.`);
  let paneId = live?.paneId;
  if (!paneId) {
    paneId = await reopen(sessionFile, false);
    await waitUntilReady(paneId);
  }
  await pasteText(paneId, prompt);
  return !live;
}

/**
 * `open` shows the PR's session in relay. `review`, `merge`, `fix-ci`, `ask-approval`, and `bump` ask
 * that session to take the PR's next step, reopening it in a background tab first if it's closed, and
 * note the request so the card can follow it until it's done. `close` closes the PR on GitHub, and needs no session.
 */
export async function runBoardAction(action: string, prRef: string): Promise<BoardActionResult> {
  if (!isButton(action)) return { status: 404, message: `no such action: ${action}` };
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
  let ask;
  try {
    owner = prOwner(db, repo, number);
    ask = approvalAsks(db).get(`${repo}#${number}`);
  } finally {
    db.close();
  }
  if (!owner) return { status: 404, message: `no omp session is in charge of ${repo}#${number}` };
  if (action === "bump" && !ask) return { status: 409, message: `no approval ask is recorded for ${repo}#${number} yet, so there's nothing to bump` };
  const card = describeOwner(owner, await liveSessions());
  const name = card.title || "the session";
  if (!card.live && !existsSync(owner.sessionFile)) return { status: 410, message: `"${name}" no longer exists` };

  try {
    if (action === "open") {
      if (card.live) await selectWindow(card.live.windowId);
      else await reopen(owner.sessionFile, true);
      // The tab already switched, so a terminal we can't raise only costs you an app switch.
      await bringRelayTerminalToFront().catch((error) => console.error(`relay board: couldn't bring the terminal forward: ${error}`));
      return { status: 200, message: card.live ? `Switched relay to "${name}"` : `Reopened "${name}" in a new relay tab` };
    }

    // A request sent moments ago may not show the session as working yet, while it reopens.
    const running = runningRequest(repo, number, card.live);
    if (running) return { status: 409, message: `"${name}" is already ${REQUESTS[running].running} ${repo}#${number}` };
    // The card may be older than the PR: a step on one that already merged or closed would only confuse its session.
    const state = await fetchPullRequest(sourceFor(loadBoardConfig(), repo), repo, number).then(
      (pr) => pr.state,
      () => "OPEN", // GitHub didn't answer; the session checks the PR itself before acting.
    );
    if (state !== "OPEN") return { status: 409, message: `${repo}#${number} is already ${state === "MERGED" ? "merged" : "closed"}` };
    const url = `https://github.com/${repo}/pull/${number}`;
    const reopened = await promptSession(owner.sessionFile, card.live, name, REQUESTS[action].prompt(url, ask));
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
function runningRequest(repo: string, number: number, live: CardOwner["live"]): AgentAction | undefined {
  const key = `${repo}#${number}`;
  const db = openBoardStore();
  try {
    // The PR is still open: its card offered the button, and merging takes the card away.
    const results = { mergedAt: null, review: latestAgentReviews(db).get(key), ciFix: latestCiFixes(db).get(key), approval: approvalAsks(db).get(key) };
    const progress = requestProgress(agentRequests(db).get(key), results, live, new Date());
    return AGENT_ACTIONS.find((action) => progress[action] === "running");
  } finally {
    db.close();
  }
}

/** Reads a button's small JSON body: `{ "pr": "owner/repo#12" }`. */
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
