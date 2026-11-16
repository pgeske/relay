import { askModel } from "./askModel.ts";
import { jsonObject } from "./autoStatus.ts";
import { loadBoardConfig } from "./config.ts";
import type { PrComment, PullRequest } from "./github.ts";
import { commentVerdicts, openBoardStore, recordCommentVerdict } from "./store.ts";

/**
 * What reviewers asked of a PR that its author hasn't answered yet, so the board can show what's left
 * to address. Only people count: bots (CI reports, automated reviewers) and the author themselves
 * don't. Three kinds:
 * - a review that requested changes, made after the last commit and the author's last comment;
 * - an open review thread whose last word is a reviewer's, on lines that haven't changed since;
 * - a conversation comment, or a review's own text, made after the last commit and the author's last
 *   comment, that asks for a change. Whether it does takes reading it: relay's model judges each one
 *   once (see `judgeComments`), and until it has, the comment doesn't count.
 * Pushing a fix or replying hands the PR back to its reviewers.
 */

export interface FeedbackItem {
  kind: "changes-requested" | "thread" | "comment";
  author: string;
  /** What they said, in full. */
  body: string;
  url: string;
  at: string;
  /** The file a thread is about; null for the others. */
  path: string | null;
}

function fromPerson(pr: PullRequest, comment: PrComment): boolean {
  return !comment.authorIsBot && comment.author !== pr.author;
}

/** Since when a reviewer's top-level word is still unanswered: the last commit, or the author's last comment after it. */
function answeredAt(pr: PullRequest): string {
  const authorSaid = pr.discussion.comments.filter((comment) => comment.author === pr.author).map((comment) => comment.at);
  return [pr.headCommittedAt ?? "", ...authorSaid].toSorted().at(-1) ?? "";
}

/** People's comments since the author last answered, which take the model to tell whether they ask for a change. */
function unansweredComments(pr: PullRequest): PrComment[] {
  const since = answeredAt(pr);
  return pr.discussion.comments.filter((comment) => fromPerson(pr, comment) && comment.at > since);
}

/** Whether the PR's author said anything on it after `at`: a conversation comment, or the last word in a review thread. */
export function authorRepliedSince(pr: PullRequest, at: string): boolean {
  const { comments, threads } = pr.discussion;
  return [...comments, ...threads.map((thread) => thread.last)].some((comment) => comment.author === pr.author && comment.at > at);
}

/** What's still to address on the PR, oldest first. `verdicts` says which comments ask for a change, by URL. */
export function openFeedback(pr: PullRequest, verdicts: Map<string, boolean>): FeedbackItem[] {
  const since = answeredAt(pr);
  const changeRequests = pr.discussion.changeRequests
    .filter((review) => fromPerson(pr, review) && review.at > since)
    .map((review): FeedbackItem => ({ kind: "changes-requested", author: review.author, body: review.body, url: review.url, at: review.at, path: null }));
  const threads = pr.discussion.threads
    .filter((thread) => !thread.resolved && !thread.outdated && fromPerson(pr, thread.last))
    .map((thread): FeedbackItem => {
      // The reviewer's ask, when they started the thread; else what they replied.
      const ask = fromPerson(pr, thread.first) ? thread.first : thread.last;
      return { kind: "thread", author: ask.author, body: ask.body, url: ask.url, at: thread.last.at, path: thread.path };
    });
  const comments = unansweredComments(pr)
    .filter((comment) => verdicts.get(comment.url) === true)
    .map((comment): FeedbackItem => ({ kind: "comment", author: comment.author, body: comment.body, url: comment.url, at: comment.at, path: null }));
  return [...changeRequests, ...threads, ...comments].toSorted((a, b) => a.at.localeCompare(b.at));
}

/** Each comment is cut to this for the model. */
const COMMENT_CHARS = 3000;
const SYSTEM_PROMPT = "You sort pull request comments for a developer's review board. Answer only from what you're given, never use tools, and reply with only the JSON object asked for.";

export function commentPrompt(pr: Pick<PullRequest, "title" | "url" | "author">, comment: PrComment): string {
  return `${comment.author} left this comment on ${pr.author}'s pull request "${pr.title}" (${pr.url}):

"""
${comment.body.trim().slice(0, COMMENT_CHARS)}
"""

Does it ask ${pr.author} to do something before the PR can go ahead: change the code, answer a question, or explain a choice? A note, an FYI, thanks, or an approval ("LGTM") asks for nothing.
Reply with only a JSON object: {"asks": true} or {"asks": false}.`;
}

/** Reads the model's answer; null when it's not one the board can use. */
export function parseCommentVerdict(reply: string): boolean | null {
  const answer = jsonObject(reply);
  return typeof answer?.asks === "boolean" ? answer.asks : null;
}

/** Comments being judged right now, by URL, so a refresh while the model runs doesn't ask again. */
const judging = new Set<string>();

/**
 * Has relay's model judge, in the background and one at a time, each comment on these PRs that could
 * be feedback and isn't judged yet; the board shows the ones that ask for a change from its next
 * refresh on. Off when relay's watcher is (`autoStatus` in the board config): it's the same model.
 */
export function judgeComments(prs: PullRequest[]): void {
  const { autoStatus } = loadBoardConfig();
  if (!autoStatus.enabled) return;
  const db = openBoardStore();
  let verdicts: Map<string, boolean>;
  try {
    verdicts = commentVerdicts(db);
  } finally {
    db.close();
  }
  const pending = prs.flatMap((pr) =>
    unansweredComments(pr)
      .filter((comment) => !verdicts.has(comment.url) && !judging.has(comment.url))
      .map((comment) => ({ pr, comment })),
  );
  if (pending.length === 0) return;
  for (const { comment } of pending) judging.add(comment.url);
  void (async () => {
    for (const { pr, comment } of pending) {
      try {
        const asks = parseCommentVerdict(await askModel(commentPrompt(pr, comment), autoStatus.model, SYSTEM_PROMPT));
        if (asks === null) {
          console.error(`feedback: no usable answer about ${comment.url}`);
          continue;
        }
        const store = openBoardStore();
        try {
          recordCommentVerdict(store, comment.url, asks, new Date().toISOString());
        } finally {
          store.close();
        }
      } catch (error) {
        console.error(`feedback: judging ${comment.url} failed`, error);
      } finally {
        judging.delete(comment.url);
      }
    }
  })();
}
