import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { BOARD_APP_ID, BOARD_APP_NAME, BOARD_APP_PATHS, GITHUB_REPO } from "../paths.ts";
import { resolveSessionFile } from "../server/sessionFile.ts";
import { parsePaneTitle } from "../server/sessions.ts";
import { listOmpPanes, listPanes, type Pane } from "../tmux.ts";
import { loadBoardConfig, type BoardConfig, type BoardSource } from "./config.ts";
import { fetchBoardData, fetchPullRequest, type BoardData } from "./github.ts";
import { buildBoard, type Board, type CardOwner } from "./lanes.ts";
import { claimPr, prOwners, readSessionHeader, scanSessions, type PrOwner } from "./owners.ts";
import {
  agentRequests,
  approvalAsks,
  latestAgentReviews,
  latestCiFixes,
  openBoardStore,
  recordAgentReview,
  recordApprovalAsk,
  recordApprovalBump,
  recordCiFix,
  type AgentVerdict,
  type CiFixVerdict,
} from "./store.ts";

export const BOARD_HELP = `relay board: where each of your pull requests is, from draft to merged.

Usage:
  relay board                         Open the ${BOARD_APP_NAME} app (macOS)
  relay board --json                  Print the board as JSON (for agents)
  relay board review <pr> --passed [--summary <text|->]
                                      Record that a reviewer agent passed the PR's current commit
  relay board review <pr> --findings <n> [--summary <text|->]
                                      Record that it found n issues
                                      (--summary - reads the reviewer's write-up from stdin)
  relay board ci-fix <pr> --fixed|--not-fixed [--summary <text|->]
                                      Record how a Fix CI request went: what failed, whether
                                      it was flaky, and what was done (or why it couldn't be)
  relay board approval <pr> --asked --slack <link>
                                      Record that you drafted a Slack message asking for the
                                      PR's approval (<link>: the channel link the draft tool gave)
  relay board approval <pr> --bumped --slack <permalink>
                                      Record that you drafted a bump in the ask's thread; the
                                      ask's link moves to <permalink>, the message as sent
  relay board claim <pr>              Put the omp session this runs in in charge of the PR

<pr> is a PR URL or owner/repo#number. Settings live in ~/.config/relay/board.json.
The app reads the board from relay's server (relay server install).`;

/** The relay tab each open omp session runs in, keyed by its session file. */
export async function liveSessions(): Promise<Map<string, Pane>> {
  const panes = await listOmpPanes();
  const files = await Promise.all(panes.map((pane) => resolveSessionFile(pane)));
  return new Map(panes.flatMap((pane, index) => (files[index] ? [[files[index], pane] as const] : [])));
}

/** Where a session runs in relay right now, from its pane; null when no relay tab has it open. */
function describeLive(pane: Pane | undefined): CardOwner["live"] {
  return pane ? { paneId: pane.paneId, windowId: pane.windowId, status: parsePaneTitle(pane.title, pane.cwd).status } : null;
}

export function describeOwner(owner: PrOwner, live: Map<string, Pane>): CardOwner {
  return {
    sessionFile: owner.sessionFile,
    title: readSessionHeader(owner.sessionFile).title,
    how: owner.how,
    live: describeLive(live.get(owner.sessionFile)),
  };
}

/**
 * Builds the board from GitHub data plus everything relay knows locally: which session owns
 * each PR, whether it is open, the agent reviews, CI fixes, and approval asks recorded so far,
 * and the requests the board sent. The local part is fast (an incremental session scan and a few SQLite reads).
 */
export async function assembleBoard(data: BoardData, config: BoardConfig): Promise<Board> {
  const live = await liveSessions();
  const db = openBoardStore();
  try {
    scanSessions(db);
    const all = prOwners(db);
    const owners: Record<string, CardOwner> = {};
    for (const pr of [...data.mine, ...data.merged]) {
      const key = `${pr.repo}#${pr.number}`;
      const owner = all.get(key);
      if (owner) owners[key] = describeOwner(owner, live);
    }
    return buildBoard(data, config.gateChecks, {
      reviews: latestAgentReviews(db),
      ciFixes: latestCiFixes(db),
      requests: agentRequests(db),
      approvals: approvalAsks(db),
      owners,
      now: new Date(),
    });
  } finally {
    db.close();
  }
}

export async function loadBoard(config: BoardConfig): Promise<Board> {
  return assembleBoard(await fetchBoardData(config), config);
}

/** Accepts "https://github.com/owner/repo/pull/12" (any suffix) or "owner/repo#12". */
export function parsePrRef(ref: string): { repo: string; number: number } {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref) ?? /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(ref);
  if (!match) throw new Error(`not a pull request: ${ref} (use a PR URL or owner/repo#number)`);
  return { repo: match[1], number: Number(match[2]) };
}

/** The source covering a repo: the one for its org, else one without an org filter. */
export function sourceFor(config: BoardConfig, repo: string): BoardSource {
  const owner = repo.split("/")[0].toLowerCase();
  return config.sources.find((source) => source.org?.toLowerCase() === owner) ?? config.sources.find((source) => !source.org) ?? {};
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

async function recordReview(args: string[]): Promise<void> {
  const [rawRef] = args;
  if (!rawRef) throw new Error(`missing <pr>\n\n${BOARD_HELP}`);
  const passed = args.includes("--passed");
  const findingsRaw = flagValue(args, "--findings");
  if (passed === (findingsRaw !== undefined)) throw new Error("give exactly one of --passed or --findings <n>");
  const findings = passed ? 0 : Number(findingsRaw);
  if (!Number.isInteger(findings) || findings < 0) throw new Error(`--findings needs a whole number, got ${findingsRaw}`);
  // A review that found nothing is a pass, however it was reported.
  const verdict: AgentVerdict = findings === 0 ? "passed" : "findings";

  const { repo, number } = parsePrRef(rawRef);
  const summary = await readSummary(flagValue(args, "--summary"));
  const pr = await fetchPullRequest(sourceFor(loadBoardConfig(), repo), repo, number);
  const db = openBoardStore();
  try {
    recordAgentReview(db, {
      repo,
      number,
      headSha: pr.headSha,
      verdict,
      findings,
      summary,
      reviewedAt: new Date().toISOString(),
    });
  } finally {
    db.close();
  }
  const result = verdict === "passed" ? "passed" : `${findings} finding${findings === 1 ? "" : "s"}`;
  console.log(`recorded agent review of ${repo}#${number} at ${pr.headSha.slice(0, 7)}: ${result}`);
}

async function recordCiFixResult(args: string[]): Promise<void> {
  const [rawRef] = args;
  if (!rawRef) throw new Error(`missing <pr>\n\n${BOARD_HELP}`);
  const fixed = args.includes("--fixed");
  if (fixed === args.includes("--not-fixed")) throw new Error("give exactly one of --fixed or --not-fixed");
  const verdict: CiFixVerdict = fixed ? "fixed" : "not-fixed";

  const { repo, number } = parsePrRef(rawRef);
  const summary = await readSummary(flagValue(args, "--summary"));
  // After a pushed fix the head is the fix, so the board shows the result until the next commit.
  const pr = await fetchPullRequest(sourceFor(loadBoardConfig(), repo), repo, number);
  const db = openBoardStore();
  try {
    recordCiFix(db, { repo, number, headSha: pr.headSha, verdict, summary, recordedAt: new Date().toISOString() });
  } finally {
    db.close();
  }
  console.log(`recorded CI fix of ${repo}#${number} at ${pr.headSha.slice(0, 7)}: ${fixed ? "fixed" : "not fixed"}`);
}

/** `--summary -` reads stdin, so an agent can pass a long multi-line write-up through a heredoc. */
async function readSummary(value: string | undefined): Promise<string | null> {
  if (value === undefined) return null;
  const text = value === "-" ? await Bun.stdin.text() : value;
  return text.trim() || null;
}

/** A Slack link the board can open: https on slack.com, like a draft's channel link or a message permalink. */
export function parseSlackLink(link: string): string {
  const url = URL.canParse(link) ? new URL(link) : null;
  if (!url || url.protocol !== "https:" || !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))) {
    throw new Error(`not a Slack link: ${link} (use the channel link the draft tool returned, or the message's permalink)`);
  }
  return url.href;
}

/** Records an approval ask or bump an agent drafted in Slack; the user sends drafts, so drafting is the agent's whole step. */
function recordApproval(args: string[]): void {
  const [rawRef] = args;
  if (!rawRef) throw new Error(`missing <pr>\n\n${BOARD_HELP}`);
  const asked = args.includes("--asked");
  if (asked === args.includes("--bumped")) throw new Error("give exactly one of --asked or --bumped");
  const link = flagValue(args, "--slack");
  if (link === undefined) throw new Error("--slack <link> is required: where the ask is in Slack");
  const slackUrl = parseSlackLink(link);
  const { repo, number } = parsePrRef(rawRef);
  const at = new Date().toISOString();
  const db = openBoardStore();
  try {
    if (asked) recordApprovalAsk(db, repo, number, slackUrl, at);
    else if (!recordApprovalBump(db, repo, number, slackUrl, at)) {
      throw new Error(`no approval ask is recorded for ${repo}#${number} to bump; record the ask with --asked first`);
    }
  } finally {
    db.close();
  }
  console.log(`recorded ${asked ? "approval ask" : "bump"} of ${repo}#${number}: ${slackUrl}`);
}

/**
 * Hands a PR to the omp session the command runs in. omp's tools inherit the pane's $TMUX_PANE,
 * which leads to the pane, and the pane to its session file.
 */
async function claim(args: string[]): Promise<void> {
  const [rawRef] = args;
  if (!rawRef) throw new Error(`missing <pr>\n\n${BOARD_HELP}`);
  const { repo, number } = parsePrRef(rawRef);
  const paneId = process.env.TMUX_PANE;
  const pane = paneId ? (await listPanes()).find((candidate) => candidate.paneId === paneId) : undefined;
  const sessionFile = pane ? await resolveSessionFile(pane) : null;
  if (!sessionFile) throw new Error("run this from an omp session inside relay: it puts that session in charge of the PR");
  const db = openBoardStore();
  try {
    claimPr(db, repo, number, sessionFile);
  } finally {
    db.close();
  }
  console.log(`${repo}#${number} is now in the care of "${readSessionHeader(sessionFile).title || sessionFile}"`);
}

/**
 * Opens the Relay Board app. `--env` hands it this relay's port and config directory (where the
 * token it authenticates with lives); an app that's already running keeps the ones it has.
 */
function openApp(): void {
  if (process.platform !== "darwin") throw new Error("the board is a macOS app; elsewhere, read it with: relay board --json");
  const env = ["RELAY_PORT", "XDG_CONFIG_HOME"].flatMap((name) => (process.env[name] ? ["--env", `${name}=${process.env[name]}`] : []));
  const installed = BOARD_APP_PATHS.find((path) => existsSync(path));
  // Elsewhere, Launch Services may still know it by its bundle identifier.
  const target = installed ? ["-a", installed] : ["-b", BOARD_APP_ID];
  if (spawnSync("open", [...target, ...env], { stdio: "ignore" }).status === 0) return;
  throw new Error(
    `the ${BOARD_APP_NAME} app isn't installed. Install it with relay's installer ` +
      `(curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh | sh), ` +
      `or build it from a relay checkout with macos/scripts/build.sh`,
  );
}

export async function boardCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "review") return recordReview(rest);
  if (subcommand === "ci-fix") return recordCiFixResult(rest);
  if (subcommand === "approval") return recordApproval(rest);
  if (subcommand === "claim") return claim(rest);
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(BOARD_HELP);
    return;
  }
  if (subcommand === "--json") {
    console.log(JSON.stringify(await loadBoard(loadBoardConfig()), null, 2));
    return;
  }
  if (subcommand !== undefined) throw new Error(`unknown option: ${subcommand}\n\n${BOARD_HELP}`);
  openApp();
}
