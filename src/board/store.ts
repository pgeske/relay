import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../paths.ts";

/** State GitHub doesn't know about lives here: agent reviews and CI fixes, approval asks in Slack, which session owns each PR, and what the board asked of it. */
export const BOARD_DB_PATH = join(DATA_DIR, "board.db");

export type AgentVerdict = "passed" | "findings";

/** One reviewer-agent run against one commit of a PR. */
export interface AgentReview {
  repo: string;
  number: number;
  headSha: string;
  verdict: AgentVerdict;
  /** Actionable findings the reviewer reported; 0 when it passed. */
  findings: number;
  /** What the reviewer said, in full: its verdict and each finding. Null for reviews recorded without one. */
  summary: string | null;
  reviewedAt: string;
}

interface ReviewRow {
  repo: string;
  number: number;
  head_sha: string;
  verdict: AgentVerdict;
  findings: number;
  summary: string | null;
  reviewed_at: string;
}

export type CiFixVerdict = "fixed" | "not-fixed";

/** What an agent reported after the board asked it to fix a PR's failing CI. */
export interface CiFix {
  repo: string;
  number: number;
  /** The PR's head commit when the result was recorded: after a pushed fix, that's the fix. */
  headSha: string;
  verdict: CiFixVerdict;
  /** What failed, whether it was flaky, and what the agent did (or why it couldn't). Null when recorded without one. */
  summary: string | null;
  recordedAt: string;
}

interface CiFixRow {
  repo: string;
  number: number;
  head_sha: string;
  verdict: CiFixVerdict;
  summary: string | null;
  recorded_at: string;
}

/** The steps a board button asks a PR's session to take. */
export const AGENT_ACTIONS = ["review", "merge", "fix-ci", "ask-approval", "bump"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** When the board last sent each kind of request to a PR's session. */
export type AgentRequests = Partial<Record<AgentAction, string>>;

/** The Slack message asking people to approve a PR, as the PR's session recorded it after drafting it. */
export interface ApprovalAsk {
  repo: string;
  number: number;
  askedAt: string;
  /** When the session last drafted a bump in the message's thread; null until the first. */
  bumpedAt: string | null;
  /** Where the ask is in Slack: the channel its draft went to, then the sent message's permalink once a bump found it. */
  slackUrl: string;
}

interface ApprovalAskRow {
  repo: string;
  number: number;
  asked_at: string;
  bumped_at: string | null;
  slack_url: string;
}

export function openBoardStore(path = BOARD_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS agent_reviews (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'findings')),
    findings INTEGER NOT NULL,
    summary TEXT,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (repo, number, head_sha)
  )`);
  // The omp session in charge of each PR: the one that opened it, unless another claimed it.
  db.run(`CREATE TABLE IF NOT EXISTS pr_owners (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    session_file TEXT NOT NULL,
    how TEXT NOT NULL CHECK (how IN ('opened', 'claimed')),
    linked_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`);
  // How far each session file has been read for PRs it opened, so later scans read only what's new.
  db.run(`CREATE TABLE IF NOT EXISTS session_scans (
    file TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    pending_calls TEXT NOT NULL
  )`);
  // What an agent reported after the board asked it to fix CI, per commit it was recorded at.
  db.run(`CREATE TABLE IF NOT EXISTS ci_fixes (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('fixed', 'not-fixed')),
    summary TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (repo, number, head_sha)
  )`);
  // The latest time the board sent a PR's session each kind of request. Whether it has finished is
  // read from elsewhere: a review, CI fix, approval ask, or bump recorded after it, or the PR merging.
  db.run(`CREATE TABLE IF NOT EXISTS agent_requests (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    action TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    PRIMARY KEY (repo, number, action)
  )`);
  // The Slack message asking for each PR's approval, and its latest bump. One per PR: asking again starts over.
  db.run(`CREATE TABLE IF NOT EXISTS approval_asks (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    asked_at TEXT NOT NULL,
    bumped_at TEXT,
    slack_url TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`);
  // Review requests had a table of their own before every button shared agent_requests.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_requests'").get()) {
    db.transaction(() => {
      db.run(`INSERT OR IGNORE INTO agent_requests (repo, number, action, requested_at)
              SELECT repo, number, 'review', requested_at FROM review_requests`);
      db.run("DROP TABLE review_requests");
    })();
  }
  return db;
}

/** Records a review; reviewing the same commit again replaces the earlier result. */
export function recordAgentReview(db: Database, review: AgentReview): void {
  db.query(
    `INSERT OR REPLACE INTO agent_reviews (repo, number, head_sha, verdict, findings, summary, reviewed_at)
     VALUES ($repo, $number, $headSha, $verdict, $findings, $summary, $reviewedAt)`,
  ).run({
    $repo: review.repo,
    $number: review.number,
    $headSha: review.headSha,
    $verdict: review.verdict,
    $findings: review.findings,
    $summary: review.summary,
    $reviewedAt: review.reviewedAt,
  });
}

/** The most recent review of every PR, keyed by "owner/repo#number". */
export function latestAgentReviews(db: Database): Map<string, AgentReview> {
  const rows = db
    .query<ReviewRow, []>(
      `SELECT * FROM agent_reviews r WHERE reviewed_at = (
         SELECT MAX(reviewed_at) FROM agent_reviews WHERE repo = r.repo AND number = r.number)`,
    )
    .all();
  return new Map(
    rows.map((row) => [
      `${row.repo}#${row.number}`,
      {
        repo: row.repo,
        number: row.number,
        headSha: row.head_sha,
        verdict: row.verdict,
        findings: row.findings,
        summary: row.summary,
        reviewedAt: row.reviewed_at,
      },
    ]),
  );
}

/** Records a CI-fix result; recording again at the same commit replaces the earlier one. */
export function recordCiFix(db: Database, fix: CiFix): void {
  db.query(
    `INSERT OR REPLACE INTO ci_fixes (repo, number, head_sha, verdict, summary, recorded_at)
     VALUES ($repo, $number, $headSha, $verdict, $summary, $recordedAt)`,
  ).run({
    $repo: fix.repo,
    $number: fix.number,
    $headSha: fix.headSha,
    $verdict: fix.verdict,
    $summary: fix.summary,
    $recordedAt: fix.recordedAt,
  });
}

/** The most recent CI-fix result of every PR, keyed by "owner/repo#number". */
export function latestCiFixes(db: Database): Map<string, CiFix> {
  const rows = db
    .query<CiFixRow, []>(
      `SELECT * FROM ci_fixes f WHERE recorded_at = (
         SELECT MAX(recorded_at) FROM ci_fixes WHERE repo = f.repo AND number = f.number)`,
    )
    .all();
  return new Map(
    rows.map((row) => [
      `${row.repo}#${row.number}`,
      {
        repo: row.repo,
        number: row.number,
        headSha: row.head_sha,
        verdict: row.verdict,
        summary: row.summary,
        recordedAt: row.recorded_at,
      },
    ]),
  );
}

/** Notes that the board sent a PR's session a request; sending the same kind again moves it to `requestedAt`. */
export function recordAgentRequest(db: Database, repo: string, number: number, action: AgentAction, requestedAt: string): void {
  db.query("INSERT OR REPLACE INTO agent_requests (repo, number, action, requested_at) VALUES (?, ?, ?, ?)").run(
    repo,
    number,
    action,
    requestedAt,
  );
}

/** When the board last sent each request, keyed by "owner/repo#number", answered or not. */
export function agentRequests(db: Database): Map<string, AgentRequests> {
  const rows = db.query<{ repo: string; number: number; action: string; requested_at: string }, []>("SELECT * FROM agent_requests").all();
  const requests = new Map<string, AgentRequests>();
  for (const row of rows) {
    // A request an older or newer relay sent that this one doesn't know.
    if (!(AGENT_ACTIONS as readonly string[]).includes(row.action)) continue;
    const key = `${row.repo}#${row.number}`;
    requests.set(key, { ...requests.get(key), [row.action as AgentAction]: row.requested_at });
  }
  return requests;
}

/** Records a fresh approval ask; one recorded earlier for the PR, and its bumps, give way to it. */
export function recordApprovalAsk(db: Database, repo: string, number: number, slackUrl: string, askedAt: string): void {
  db.query("INSERT OR REPLACE INTO approval_asks (repo, number, asked_at, bumped_at, slack_url) VALUES (?, ?, ?, NULL, ?)").run(
    repo,
    number,
    askedAt,
    slackUrl,
  );
}

/** Records a bump of the PR's approval ask, moving its link to `slackUrl`; false when no ask is recorded to bump. */
export function recordApprovalBump(db: Database, repo: string, number: number, slackUrl: string, bumpedAt: string): boolean {
  const result = db.query("UPDATE approval_asks SET bumped_at = ?, slack_url = ? WHERE repo = ? AND number = ?").run(bumpedAt, slackUrl, repo, number);
  return result.changes > 0;
}

/** Every PR's approval ask, keyed by "owner/repo#number". */
export function approvalAsks(db: Database): Map<string, ApprovalAsk> {
  const rows = db.query<ApprovalAskRow, []>("SELECT * FROM approval_asks").all();
  return new Map(
    rows.map((row) => [
      `${row.repo}#${row.number}`,
      { repo: row.repo, number: row.number, askedAt: row.asked_at, bumpedAt: row.bumped_at, slackUrl: row.slack_url },
    ]),
  );
}
