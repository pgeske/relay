import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../paths.ts";
import { createTaskTables } from "./taskStore.ts";

/** State GitHub doesn't know about lives here: agent reviews and CI fixes, approval asks in Slack, which session owns each PR, what the board asked of it, which PRs skip their agent review, and your tasks. */
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

/**
 * A Slack message asking one reviewer (a person or a team) to approve a PR, as the PR's session
 * recorded it after drafting it, or after finding one already sent. Reviewers who share a channel can
 * share a message; each still has its own ask.
 */
export interface ApprovalAsk {
  repo: string;
  number: number;
  /** Who it asks, as GitHub names them in a PR's `waitingOn`: a login or a team slug. Null for an ask recorded before asks named their reviewer. */
  reviewer: string | null;
  /** The channel it went to, as Slack names it ("#team-reviews"); null when unknown. */
  channel: string | null;
  /** When it was asked: when the session drafted it, or when a found message was sent. */
  askedAt: string;
  /** When the session recorded it; later than `askedAt` for an ask it found already sent. */
  recordedAt: string;
  /** `drafted` by the session, or `found` in Slack already sent (one the user wrote outside the board). */
  source: AskSource;
  /** When the session last drafted a bump in the message's thread; null until the first. */
  bumpedAt: string | null;
  /** Where the ask is in Slack: the channel its draft went to, then the sent message's permalink once a bump found it (a found ask's from the start). */
  slackUrl: string;
}

export type AskSource = "drafted" | "found";

interface ApprovalAskRow {
  repo: string;
  number: number;
  reviewer: string;
  channel: string | null;
  asked_at: string;
  /** Null for an ask recorded before asks kept when they were recorded: then, when it was asked. */
  recorded_at: string | null;
  source: AskSource;
  bumped_at: string | null;
  slack_url: string;
}

// The Slack messages asking for each PR's approval, one per reviewer, and each one's latest bump;
// asking a reviewer again starts their ask over. A key never matches NULL, so an ask that named no
// reviewer (one recorded before asks did) has ''. Logins and team slugs ignore case, and so does the key.
const APPROVAL_ASKS_TABLE = `CREATE TABLE IF NOT EXISTS approval_asks (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  reviewer TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  channel TEXT,
  asked_at TEXT NOT NULL,
  recorded_at TEXT,
  source TEXT NOT NULL DEFAULT 'drafted' CHECK (source IN ('drafted', 'found')),
  bumped_at TEXT,
  slack_url TEXT NOT NULL,
  PRIMARY KEY (repo, number, reviewer)
)`;

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
    head_sha TEXT,
    PRIMARY KEY (repo, number, action)
  )`);
  // Requests didn't note the PR's head commit before relay's watcher recorded forgotten reviews.
  const requestColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('agent_requests')").all();
  if (!requestColumns.some((column) => column.name === "head_sha")) db.run("ALTER TABLE agent_requests ADD COLUMN head_sha TEXT");
  // PRs the user said need no reviewer agent: they go straight to people, whatever commit they're at.
  db.run(`CREATE TABLE IF NOT EXISTS agent_review_skips (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    skipped_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`);
  // Asks were one per PR before each reviewer got its own; those stay, as asks that named no reviewer.
  const askColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('approval_asks')").all();
  if (askColumns.length > 0 && !askColumns.some((column) => column.name === "reviewer")) {
    db.transaction(() => {
      db.run("ALTER TABLE approval_asks RENAME TO approval_asks_per_pr");
      db.run(APPROVAL_ASKS_TABLE);
      db.run(`INSERT INTO approval_asks (repo, number, asked_at, bumped_at, slack_url)
              SELECT repo, number, asked_at, bumped_at, slack_url FROM approval_asks_per_pr`);
      db.run("DROP TABLE approval_asks_per_pr");
    })();
  } else {
    db.run(APPROVAL_ASKS_TABLE);
    // Asks kept no source or recording time before the board could link one already sent: they were all drafted.
    if (askColumns.length > 0 && !askColumns.some((column) => column.name === "source")) {
      db.run("ALTER TABLE approval_asks ADD COLUMN recorded_at TEXT");
      db.run("ALTER TABLE approval_asks ADD COLUMN source TEXT NOT NULL DEFAULT 'drafted' CHECK (source IN ('drafted', 'found'))");
    }
  }
  // Review requests had a table of their own before every button shared agent_requests.
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_requests'").get()) {
    db.transaction(() => {
      db.run(`INSERT OR IGNORE INTO agent_requests (repo, number, action, requested_at)
              SELECT repo, number, 'review', requested_at FROM review_requests`);
      db.run("DROP TABLE review_requests");
    })();
  }
  createTaskTables(db);
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

/**
 * Notes that the board sent a PR's session a request; sending the same kind again moves it to
 * `requestedAt`. `headSha` is the PR's head commit then, null when GitHub couldn't be read.
 */
export function recordAgentRequest(db: Database, repo: string, number: number, action: AgentAction, requestedAt: string, headSha: string | null): void {
  db.query("INSERT OR REPLACE INTO agent_requests (repo, number, action, requested_at, head_sha) VALUES (?, ?, ?, ?, ?)").run(
    repo,
    number,
    action,
    requestedAt,
    headSha,
  );
}

/** The PR's head commit when the board last sent this request; null when unknown or never sent. */
export function agentRequestHead(db: Database, repo: string, number: number, action: AgentAction): string | null {
  return db.query<{ head_sha: string | null }, [string, number, string]>("SELECT head_sha FROM agent_requests WHERE repo = ? AND number = ? AND action = ?").get(repo, number, action)?.head_sha ?? null;
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

/** Marks a PR as needing no agent review; skipping it again keeps the first time. */
export function skipAgentReview(db: Database, repo: string, number: number, skippedAt: string): void {
  db.query("INSERT OR IGNORE INTO agent_review_skips (repo, number, skipped_at) VALUES (?, ?, ?)").run(repo, number, skippedAt);
}

/** Puts a skipped PR back to waiting on an agent review. */
export function requireAgentReview(db: Database, repo: string, number: number): void {
  db.query("DELETE FROM agent_review_skips WHERE repo = ? AND number = ?").run(repo, number);
}

/** When each PR that skips its agent review was skipped, keyed by "owner/repo#number". */
export function agentReviewSkips(db: Database): Map<string, string> {
  const rows = db.query<{ repo: string; number: number; skipped_at: string }, []>("SELECT * FROM agent_review_skips").all();
  return new Map(rows.map((row) => [`${row.repo}#${row.number}`, row.skipped_at]));
}

/** Records a fresh ask of `reviewer`; one recorded earlier for the same reviewer of the PR, and its bumps, give way to it. */
export function recordApprovalAsk(
  db: Database,
  ask: { repo: string; number: number; reviewer: string; channel: string; slackUrl: string; askedAt: string; recordedAt: string; source: AskSource },
): void {
  db.query(
    "INSERT OR REPLACE INTO approval_asks (repo, number, reviewer, channel, asked_at, recorded_at, source, bumped_at, slack_url) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
  ).run(ask.repo, ask.number, ask.reviewer, ask.channel, ask.askedAt, ask.recordedAt, ask.source, ask.slackUrl);
}

/**
 * Records a bump of the ask of `reviewer` (null: the PR's ask that named no reviewer), moving its
 * link to `slackUrl`, and its channel to `channel` when given; false when no such ask is recorded.
 */
export function recordApprovalBump(
  db: Database,
  bump: { repo: string; number: number; reviewer: string | null; channel: string | null; slackUrl: string; bumpedAt: string },
): boolean {
  const result = db
    .query("UPDATE approval_asks SET bumped_at = ?, slack_url = ?, channel = COALESCE(?, channel) WHERE repo = ? AND number = ? AND reviewer = ?")
    .run(bump.bumpedAt, bump.slackUrl, bump.channel, bump.repo, bump.number, bump.reviewer ?? "");
  return result.changes > 0;
}

/** Every PR's approval asks, oldest first, keyed by "owner/repo#number". */
export function approvalAsks(db: Database): Map<string, ApprovalAsk[]> {
  const rows = db.query<ApprovalAskRow, []>("SELECT * FROM approval_asks ORDER BY asked_at, reviewer").all();
  const asks = new Map<string, ApprovalAsk[]>();
  for (const row of rows) {
    const key = `${row.repo}#${row.number}`;
    const ask: ApprovalAsk = {
      repo: row.repo,
      number: row.number,
      reviewer: row.reviewer || null,
      channel: row.channel,
      askedAt: row.asked_at,
      recordedAt: row.recorded_at ?? row.asked_at,
      source: row.source,
      bumpedAt: row.bumped_at,
      slackUrl: row.slack_url,
    };
    asks.set(key, [...(asks.get(key) ?? []), ask]);
  }
  return asks;
}
