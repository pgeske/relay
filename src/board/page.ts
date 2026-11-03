import { AGENT_COMMAND } from "../tmux.ts";
import type { PullRequest } from "./github.ts";
import type { AgentReviewState, ApprovalState, Board, BoardCard, CardOwner, Lane, RequestProgress } from "./lanes.ts";
import { AGENT_ACTIONS, type AgentAction } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days without activity before a PR is called stale. */
const STALE_DAYS = 7;
/** Seconds between the page's own reloads. */
export const PAGE_REFRESH_SECONDS = 60;
/** Seconds between reloads while a session runs one of the board's requests, so its end shows soon. */
export const ACTIVE_REFRESH_SECONDS = 10;
/** Merged cards shown, newest first; more would push the review row off the screen. */
const MERGED_SHOWN = 8;
/** A small robot head, drawn in the text color, that marks a card's session row as an agent session. */
const AGENT_ICON = `<svg class="agent-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a1 1 0 0 1 .5 1.87V4H12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5V2.87A1 1 0 0 1 8 1ZM4 5.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V6a.5.5 0 0 0-.5-.5H4Zm2 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM6 10.5h4V11.5H6z"/><path fill="currentColor" d="M0 7.5h1.5v3H0zM14.5 7.5H16v3h-1.5z"/></svg>`;
/** A wrench, on the tags a click asks the session to fix CI from. */
const WRENCH_ICON = `<svg class="wrench" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M10.5 1a4.5 4.5 0 0 0-4.27 5.93L1.44 11.7a1.5 1.5 0 0 0 0 2.12l.74.74a1.5 1.5 0 0 0 2.12 0l4.77-4.79A4.5 4.5 0 0 0 14.9 4.2l-2.4 2.4-2.12-.7-.7-2.12 2.4-2.4A4.5 4.5 0 0 0 10.5 1Z"/></svg>`;

/** Lanes left to right in the order work moves; `hot` lanes are the ones waiting on you to act. */
const COLUMNS: { lane: Lane; title: string; hint: string; hot?: boolean }[] = [
  { lane: "draft", title: "Draft", hint: "still being shaped" },
  { lane: "agent-review", title: "Agent review", hint: "no passing review of the current commit" },
  { lane: "human-review", title: "Human review", hint: "agent passed; waiting on a person" },
  { lane: "approved-blocked", title: "Approved · blocked", hint: "CI red or running, or merge gate said no", hot: true },
  { lane: "ready", title: "Ready to merge", hint: "approved and green", hot: true },
];

/**
 * How a card words each step it can ask the PR's session to take. Steps with a `button` move the
 * PR to its next lane and get one in the session row; Fix CI has none, since CI can go red in any
 * lane: the red CI pill itself asks for it.
 */
const STEPS: Record<AgentAction, { button?: string; does: string; running: string; stalled: string }> = {
  review: { button: "Review", does: "review this PR", running: "agent reviewing…", stalled: "review stopped without a result" },
  merge: { button: "Merge", does: "merge this PR", running: "agent merging…", stalled: "merge stopped without a result" },
  "fix-ci": { does: "fix this PR's failing CI", running: "agent fixing CI…", stalled: "CI fix stopped without a result" },
  "ask-approval": {
    button: "Ask for approval",
    does: "draft a Slack message asking for approval (you send it)",
    running: "agent drafting approval ask…",
    stalled: "approval ask stopped without a result",
  },
  bump: { button: "Bump", does: "draft a bump in the approval ask's Slack thread (you send it)", running: "agent drafting bump…", stalled: "bump stopped without a result" },
};

const CI_PILLS = { passed: ["ok", "CI green"], failed: ["bad", "CI red"], running: ["wait", "CI running"] } as const;

/** A ticket key at the start of a title, "[PROJ-123] Fix it" or "PROJ-123: Fix it", shown as a tag instead. */
const TICKET_PREFIX = /^\[?([A-Z][A-Z0-9]+-\d+)\]?:?\s+/;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Tone = "ok" | "bad" | "wait" | "muted" | "warn" | "link" | "ghost";

function pill(tone: Tone, text: string): string {
  return `<span class="pill ${tone}">${escapeHtml(text)}</span>`;
}

function timeAgo(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export interface PageOptions {
  now: Date;
  /** When the board was fetched. */
  updatedAt: Date;
  /** Set when the latest refresh failed; the page then shows the last board it had. */
  error?: string;
}

export function renderBoardPage(board: Board | null, options: PageOptions): string {
  const age = (iso: string) => {
    const days = Math.floor((options.now.getTime() - new Date(iso).getTime()) / DAY_MS);
    return days >= STALE_DAYS ? pill("warn", `stale ${days}d`) : pill("muted", `${days}d`);
  };

  /**
   * The session line under a card: a button that shows the session in relay, plus a button for each
   * step in `offered` (Review, Ask for approval or Bump, Merge) that asks the session to move the PR to its next lane. While
   * the session runs one of the board's requests, that request's pulsing tag says it all: no step
   * buttons, no "working". A step whose request stalled offers itself again.
   */
  const sessionRow = (pr: PullRequest, owner: CardOwner | undefined, offered: AgentAction[] = [], requests?: BoardCard["requests"]) => {
    if (!owner) return "";
    // omp starts titles with a nerd-font icon, which a browser font draws as a box.
    const title = owner.title.replace(/[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/gu, "").trim();
    const ref = escapeHtml(`${pr.repo}#${pr.number}`);
    const state = !owner.live ? "closed" : owner.live.status === "working" ? "working" : "open";
    const busy = AGENT_ACTIONS.some((action) => requests?.[action] === "running");
    const label = busy ? "" : { open: "", working: " · working", closed: " · closed" }[state];
    const reopens = state === "closed" ? "Reopens the session in relay, then asks it to" : "Asks the session to";
    const buttons = busy
      ? ""
      : offered
          .filter((action) => STEPS[action].button)
          .map((action) => {
            const step = STEPS[action];
            const again = requests?.[action] === "stalled" ? " again" : "";
            return `<button class="act next" data-action="${action}" data-pr="${ref}" data-running="${escapeHtml(step.running)}" title="${reopens} ${step.does}">${step.button}${again}</button>`;
          })
          .join("");
    return `<div class="session">
      <button class="act owner ${state}" data-action="open" data-pr="${ref}" title="Open this ${AGENT_COMMAND} session in your terminal">
        <span class="agent">${AGENT_ICON}${AGENT_COMMAND}</span><span class="session-title">${escapeHtml(title || "untitled session")}<span class="muted">${label}</span></span></button>${buttons}</div>`;
  };

  /** `closable` adds an × that closes the PR on GitHub, for your own open PRs. */
  const card = (pr: PullRequest, pills: string[], session = "", closable = false) => {
    const ticket = TICKET_PREFIX.exec(pr.title);
    const title = ticket ? pr.title.slice(ticket[0].length) : pr.title;
    const tags = [...pills, ticket ? pill("link", ticket[1]) : ""].filter(Boolean).join("");
    const ref = escapeHtml(`${pr.repo}#${pr.number}`);
    const close = closable
      ? `<button class="close-pr" data-action="close" data-pr="${ref}" title="Close this PR on GitHub" aria-label="Close ${ref}">×</button>`
      : "";
    return `<div class="card">${close}
      <a class="open-pr" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">
        <div class="repo">${escapeHtml(pr.repo.split("/")[1])} #${pr.number}</div>
        <div class="title">${escapeHtml(title)}</div></a>
      <div class="pills">${tags}</div>${session}</div>`;
  };

  /** A tag that opens a write-up in the dialog; the write-up rides along in a template until then. */
  const opensDetail = (tone: Tone, text: string, hint: string, detailHtml: string) =>
    `<button class="pill ${tone} opens-detail" title="${escapeHtml(hint)}">${escapeHtml(text)}</button><template class="detail">${detailHtml}</template>`;

  /** What an agent concluded, as the dialog shows it: the verdict, at which commit and when, then its write-up. */
  const detail = (heading: string, pr: PullRequest, verdict: string, result: { headSha: string; at: string; summary: string | null }, note = "") => {
    const body = result.summary
      ? `<div class="detail-text">${escapeHtml(result.summary)}</div>`
      : `<p class="muted">No write-up was saved with this result. Its session has the details.</p>`;
    return `<header><h3>${heading} · ${escapeHtml(pr.repo.split("/")[1])} #${pr.number}</h3>
      <button class="close" aria-label="Close">×</button></header>
      <p>${verdict} <span class="muted">· commit ${escapeHtml(result.headSha.slice(0, 7))} · ${timeAgo(result.at, options.now)}</span></p>${note}${body}`;
  };

  /** A request's tag while it runs (pulsing) or after its session stopped without finishing it. */
  const requestTag = (action: AgentAction, progress: RequestProgress) =>
    progress === "running"
      ? `<span class="pill wait running">${escapeHtml(STEPS[action].running)}</span>`
      : progress === "stalled"
        ? pill("warn", STEPS[action].stalled)
        : "";

  const agentPill = (boardCard: BoardCard) => {
    const review = boardCard.agentReview;
    if (review.status === "not-run") return pill("ghost", "agent: not run");
    const [tone, text]: [Tone, string] = review.stale
      ? ["wait", "agent review out of date"]
      : review.status === "passed"
        ? ["ok", "agent ✓"]
        : ["wait", `agent: ${review.findings} finding${review.findings === 1 ? "" : "s"}`];
    return opensDetail(tone, text, "See what the review said", reviewDetail(boardCard.pr, review));
  };

  const reviewDetail = (pr: PullRequest, review: Extract<AgentReviewState, { status: "passed" | "findings" }>) => {
    const verdict =
      review.status === "passed"
        ? `<span class="ok">Passed</span>`
        : `<span class="wait">${review.findings} finding${review.findings === 1 ? "" : "s"}</span>`;
    const stale = review.stale ? `<p class="warn">New commits landed after this review, so it doesn't cover the latest code.</p>` : "";
    return detail("Agent review", pr, verdict, { headSha: review.headSha, at: review.reviewedAt, summary: review.summary }, stale);
  };

  /** Where the PR's approval ask is in Slack, saying how long ago it was asked or last bumped. */
  const approvalTag = (approval: ApprovalState) => {
    if (approval.status === "not-asked") return "";
    const text = approval.bumpedAt ? `bumped ${timeAgo(approval.bumpedAt, options.now)}` : `approval asked ${timeAgo(approval.askedAt, options.now)}`;
    return `<a class="pill link slack" href="${escapeHtml(approval.slackUrl)}" target="_blank" rel="noopener" title="Open the approval ask in Slack">${escapeHtml(text)}</a>`;
  };

  const laneCard = (boardCard: BoardCard, lane: Lane, owners: Board["owners"]) => {
    const { pr, requests, ciFix } = boardCard;
    const owner = owners[`${pr.repo}#${pr.number}`];
    const offered: AgentAction[] = [];
    if (lane === "agent-review") offered.push("review");
    if (lane === "ready") offered.push("merge");
    // Human review moves on through Slack: ask for approval once, then bump the ask.
    if (lane === "human-review") offered.push(boardCard.approval.status === "not-asked" ? "ask-approval" : "bump");
    // CI can go red in any lane, so the red pill itself asks the session to fix it, unless the session is already on a request.
    const fixable = boardCard.ci === "failed" && owner !== undefined && !AGENT_ACTIONS.some((action) => requests[action] === "running");
    const fixHint = owner?.live ? "Ask the session to fix CI" : "Reopen the session in relay and ask it to fix CI";
    const ref = escapeHtml(`${pr.repo}#${pr.number}`);
    /** A red tag that asks for a CI fix; `plain` is what it turns into once the session takes the request on, if anything. */
    const asksFix = (text: string, hint: string, plain = "") =>
      `<button class="pill bad fix-ci" data-action="fix-ci" data-pr="${ref}" data-running="${escapeHtml(STEPS["fix-ci"].running)}" data-plain="${escapeHtml(plain)}" title="${escapeHtml(hint)}">${escapeHtml(text)}${WRENCH_ICON}</button>`;
    // A CI-fix result speaks only for the commit it was recorded at, and a newer request outranks it.
    const fix = requests["fix-ci"] === "none" && ciFix.status !== "not-run" && !ciFix.stale ? ciFix : null;
    const fixVerdict = fix?.status === "fixed" ? `<span class="ok">Fixed</span>` : `<span class="bad">Couldn't fix</span>`;
    const fixDetail = fix ? detail("CI fix", pr, fixVerdict, { headSha: fix.headSha, at: fix.recordedAt, summary: fix.summary }) : "";
    const fixedHint = "An agent fixed CI on this commit: see what it did";
    let ciPill = "";
    if (fixable) {
      ciPill = asksFix(CI_PILLS.failed[1], fixHint, CI_PILLS.failed[1]);
    } else if (boardCard.ci !== "none") {
      const [tone, text] = CI_PILLS[boardCard.ci];
      // After an agent fixed CI on this commit, an asterisk marks the pill, and it opens what the agent did.
      ciPill = fix?.status === "fixed" ? opensDetail(tone, `${text}*`, fixedHint, fixDetail) : pill(tone, text);
    }
    // Next to the CI pill: the fix running, stalled (asking again when CI is still red), or how the last one went.
    const fixTag =
      requests["fix-ci"] === "stalled" && fixable
        ? asksFix(STEPS["fix-ci"].stalled, `${fixHint} again`)
        : requestTag("fix-ci", requests["fix-ci"]) ||
          (fix?.status === "not-fixed" ? opensDetail("bad", "agent couldn't fix CI", "See why the agent couldn't fix CI", fixDetail) : "") ||
          (fix?.status === "fixed" && fixable ? opensDetail("ok", "agent fixed CI", fixedHint, fixDetail) : "");
    const reviewing = lane === "agent-review" || lane === "human-review" ? agentPill(boardCard) : "";
    return card(
      pr,
      [
        ciPill,
        fixTag,
        boardCard.gateBlocked ? pill("bad", "merge gate blocked") : "",
        pr.reviewDecision === "CHANGES_REQUESTED" ? pill("bad", "changes requested") : "",
        requestTag("review", requests.review) || reviewing,
        lane === "human-review" ? approvalTag(boardCard.approval) : "",
        requestTag("ask-approval", requests["ask-approval"]),
        requestTag("bump", requests.bump),
        requestTag("merge", requests.merge),
        age(pr.updatedAt),
      ],
      sessionRow(pr, owner, offered, requests),
      true,
    );
  };

  /** `total` is the column's full count when only some of its cards are shown. */
  const column = (title: string, hint: string, cards: string[], tone = "", total = cards.length) => `
    <section class="col ${tone}">
      <header><h2>${escapeHtml(title)}</h2><span class="count">${total}</span></header>
      <p class="hint">${escapeHtml(hint)}</p>
      ${cards.join("") || '<div class="empty">nothing here</div>'}
      ${total > cards.length ? `<div class="empty">+${total - cards.length} more</div>` : ""}
    </section>`;

  const sections = (board: Board) => {
    const chips = [
      [board.lanes.ready.length, "ready to merge"],
      [board.lanes["approved-blocked"].length, "approved, blocked"],
      [board.lanes["agent-review"].length, "need an agent review"],
      [board.lanes["human-review"].length, "waiting on people"],
    ]
      .map(([count, label]) => `<div class="chip"><b>${count}</b>${escapeHtml(String(label))}</div>`)
      .join("");
    const lanes = COLUMNS.map(({ lane, title, hint, hot }) =>
      column(
        title,
        hint,
        board.lanes[lane].map((boardCard) => laneCard(boardCard, lane, board.owners)),
        hot ? "hot" : "",
      ),
    ).join("");
    const merged = column(
      "Merged",
      "deploys not tracked yet",
      board.merged
        .slice(0, MERGED_SHOWN)
        .map((pr) => card(pr, [pill("muted", `merged ${pr.mergedAt?.slice(5, 10)}`)], sessionRow(pr, board.owners[`${pr.repo}#${pr.number}`]))),
      "dim",
      board.merged.length,
    );
    return `<div class="summary">${chips}</div>
          <div class="group">My changes</div><div class="board lanes">${lanes}${merged}</div>`;
  };
  const body = board ? sections(board) : '<div class="empty big">Couldn\'t load the board. It tries again every minute.</div>';

  const updated = options.updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // While a session runs one of the board's requests, reload often, so a finished merge or review shows soon.
  const active = board !== null && Object.values(board.lanes).some((cards) => cards.some((c) => AGENT_ACTIONS.some((action) => c.requests[action] === "running")));
  const refreshSeconds = active ? ACTIVE_REFRESH_SECONDS : PAGE_REFRESH_SECONDS;
  const refreshes = active ? `refreshes every ${ACTIVE_REFRESH_SECONDS}s while an agent works` : "refreshes every minute";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>relay board</title>
<style>${STYLE}</style></head><body data-refresh-seconds="${refreshSeconds}">
<div class="top"><h1>relay board</h1><span class="meta">updated ${updated} · ${refreshes}</span></div>
${options.error ? `<div class="error">Couldn't refresh: ${escapeHtml(options.error)}.${board ? ` Showing the board from ${updated}.` : ""}</div>` : ""}
${body}
<div id="toast" hidden></div>
<dialog id="dialog"></dialog>
<script>${script(refreshSeconds)}</script>
</body></html>`;
}

/**
 * Reloads the page on a timer (paused while a button is working or the dialog is open), opens PRs
 * in new tabs, shows an agent's write-up when its tag is clicked, asks before a button changes
 * something, and runs the card's buttons and the tags that act like them (the red CI pill).
 */
function script(refreshSeconds: number): string {
  return `
let busy = false;
const dialog = document.getElementById("dialog");
setInterval(() => { if (!busy && !dialog.open) location.reload(); }, ${refreshSeconds * 1000});
const toast = document.getElementById("toast");
function show(text, failed) {
  toast.textContent = text;
  toast.className = failed ? "failed" : "";
  toast.hidden = false;
  clearTimeout(show.timer);
  show.timer = setTimeout(() => (toast.hidden = true), 5000);
}
// What a button that changes something asks first: a title, what will happen, the primary button, and whether it's destructive.
const confirms = {
  close: (pr) => ["Close " + pr + "?", "This closes the pull request on GitHub. Its branch stays.", "Close PR", true],
  merge: (pr) => ["Merge " + pr + "?", "Asks the session in charge to merge it the repo's normal way, once its checks and approvals allow.", "Merge", false],
  "fix-ci": (pr) => ["Fix CI on " + pr + "?", "Asks the session in charge to find out why CI failed, then retry flaky jobs or push a fix.", "Fix CI", false],
  "ask-approval": (pr) => ["Ask for approval of " + pr + "?", "Asks the session in charge to draft a Slack message asking for a review, in the channel you usually ask in. It only drafts; you send it.", "Draft ask", false],
  bump: (pr) => ["Bump the approval ask for " + pr + "?", "Asks the session in charge to find the ask you sent and draft a short bump in its thread. It only drafts; you send it.", "Draft bump", false],
};
// Asks in the board's own dialog. Only the primary button says yes; Esc, Cancel, the ×, and the backdrop say no.
function ask(title, text, yes, danger) {
  const form = document.createElement("form");
  form.method = "dialog";
  form.innerHTML = '<header><h3></h3><button type="button" class="close" aria-label="Close">×</button></header>' +
    '<p class="confirm-text"></p><div class="buttons"><button value="no">Cancel</button><button class="primary" value="yes"></button></div>';
  form.querySelector("h3").textContent = title;
  form.querySelector(".confirm-text").textContent = text;
  const primary = form.querySelector(".primary");
  primary.textContent = yes;
  primary.classList.toggle("danger", danger);
  dialog.replaceChildren(form);
  dialog.className = "confirm";
  dialog.returnValue = "";
  const { promise, resolve } = Promise.withResolvers();
  dialog.addEventListener("close", () => resolve(dialog.returnValue === "yes"), { once: true });
  dialog.showModal();
  // Enter presses the focused button, so it confirms.
  primary.focus();
  return promise;
}
document.addEventListener("click", async (event) => {
  const detailTag = event.target.closest(".opens-detail");
  if (detailTag) {
    dialog.className = "";
    dialog.replaceChildren(detailTag.nextElementSibling.content.cloneNode(true));
    dialog.showModal();
    return;
  }
  if (event.target.closest("#dialog .close")) {
    dialog.close();
    return;
  }
  // A click on the dimmed backdrop lands on the dialog element itself, outside its box.
  if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
    return;
  }
  // A PR opens in a new tab, never in place of the board; Cmd/Ctrl/Shift-click keep the browser's own behavior.
  const prLink = event.target.closest("a.open-pr");
  if (prLink && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
    event.preventDefault();
    window.open(prLink.href, "_blank", "noopener");
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button || busy) return;
  const action = button.dataset.action;
  if (confirms[action] && !(await ask(...confirms[action](button.dataset.pr)))) return;
  busy = true;
  button.disabled = true;
  const starting = {
    review: "Starting the review…",
    merge: "Asking the session to merge…",
    "fix-ci": "Asking the session to fix CI…",
    "ask-approval": "Asking the session to draft an approval ask…",
    bump: "Asking the session to draft a bump…",
  }[action];
  if (starting) show(starting, false);
  try {
    const res = await fetch("/board/actions/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pr: button.dataset.pr }),
    });
    const body = await res.json().catch(() => ({}));
    show(body.message || body.error || "Something went wrong", !res.ok);
    // The session took the step on: its pulsing tag replaces whatever asked for a step (buttons, the
    // red CI pill's click), and a reload draws the card in full.
    if (res.ok && button.dataset.running) {
      const card = button.closest(".card");
      const tag = document.createElement("span");
      tag.className = "pill wait running";
      tag.textContent = button.dataset.running;
      card.querySelector(".pills").append(tag);
      card.querySelectorAll("[data-running]").forEach((asker) => {
        if (!asker.dataset.plain) return asker.remove();
        const plain = document.createElement("span");
        plain.className = "pill bad";
        plain.textContent = asker.dataset.plain;
        asker.replaceWith(plain);
      });
      setTimeout(() => location.reload(), 1200);
    }
    // 409: the card was out of date (the PR already merged or closed, or its session is already on a request); show what's true now.
    if (res.status === 409) setTimeout(() => location.reload(), 1200);
    // A closed PR leaves the board; drop its card now rather than wait for the next reload.
    if (res.ok && action === "close") button.closest(".card").remove();
  } catch {
    show("Couldn't reach relay's server", true);
  } finally {
    busy = false;
    button.disabled = false;
  }
});`;
}

const STYLE = `
:root{--bg:#f6f7f9;--panel:#fff;--card:#fbfbfc;--fg:#1d2128;--muted:#6b7280;--border:#e3e6ea;--ok:#1a7f37;--bad:#cf222e;--wait:#9a6700;--link:#0969da;--warn:#bc4c00;--hot:#0969da;--primary:#0969da;--danger:#cf222e}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--card:#1e222b;--fg:#e6e8ee;--muted:#8a90a0;--border:#2a2f3a;--ok:#3fb950;--bad:#f85149;--wait:#d29922;--link:#58a6ff;--warn:#e3b341;--hot:#3b5bdb;--primary:#1f6feb;--danger:#da3633}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif}
.top{display:flex;align-items:baseline;gap:14px;padding:16px 20px 8px}
.top h1{font-size:18px;margin:0}
.meta{color:var(--muted)}
.error{margin:0 20px 12px;padding:8px 12px;border:1px solid var(--bad);border-radius:8px;color:var(--bad)}
.summary{display:flex;gap:10px;flex-wrap:wrap;padding:0 20px 14px}
.chip{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px}
.chip b{font-size:16px;margin-right:6px}
.group{padding:0 20px 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:11px}
.board{display:grid;gap:12px;padding:0 20px 18px}
.board.lanes{grid-template-columns:repeat(6,minmax(190px,1fr))}
.col{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;min-height:120px}
.col.hot{border-color:var(--hot)}
.col.dim{opacity:.85}
.col header{display:flex;justify-content:space-between;align-items:center}
.col h2{font-size:13px;margin:0}
.count{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:0 8px;color:var(--muted)}
.hint{color:var(--muted);margin:2px 0 8px;font-size:11.5px}
.card{position:relative;display:block;break-inside:avoid;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px 9px;margin-bottom:7px}
.close-pr{position:absolute;top:4px;right:4px;width:18px;height:18px;padding:0;font-size:14px;line-height:1;border:none;border-radius:4px;background:none;color:var(--muted);cursor:pointer;opacity:0}
.card:hover .close-pr,.close-pr:focus-visible{opacity:1}
.close-pr:hover{color:var(--bad);background:var(--panel)}
.close-pr:disabled{opacity:.5;cursor:progress}
.card:has(.open-pr:hover){border-color:var(--link)}
.open-pr{display:block;color:inherit;text-decoration:none}
.session{display:flex;gap:6px;align-items:center;margin-top:7px;padding-top:6px;border-top:1px solid var(--border)}
.act{font:inherit;font-size:11px;cursor:pointer;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--fg);padding:2px 7px}
.act:hover{border-color:var(--link)}
.act:disabled{opacity:.5;cursor:progress}
.act.owner{flex:1;min-width:0;display:flex;align-items:center;text-align:left;white-space:nowrap;border-color:transparent;background:none;padding-left:0}
.session-title{min-width:0;overflow:hidden;text-overflow:ellipsis;line-height:16px}
.act.owner:hover{color:var(--link);border-color:transparent}
.act.owner.closed{color:var(--muted)}
.act.next{flex:none;color:var(--link);font-weight:600}
.agent{flex:none;display:inline-flex;align-items:center;gap:2px;height:16px;box-sizing:border-box;margin-right:4px;padding:0 3px 0 5px;border-radius:4px;background:var(--panel);border:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:600;line-height:1}
.agent-icon{width:11px;height:11px;display:block}
.act.owner:hover .agent{color:var(--link);border-color:var(--link)}
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:9px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.25);font-size:13px}
#toast.failed{background:var(--bad);color:#fff}
button.pill.opens-detail{font:inherit;font-size:10.5px;background:none;cursor:pointer}
button.pill.opens-detail:hover{border-color:currentColor}
button.pill.fix-ci{font:inherit;font-size:10.5px;background:none;cursor:pointer;display:inline-flex;align-items:center;gap:3px}
button.pill.fix-ci:hover{border-color:currentColor;background:color-mix(in srgb,var(--bad) 12%,transparent)}
button.pill.fix-ci:disabled{opacity:.5;cursor:progress}
.wrench{width:9px;height:9px;display:block;opacity:.7}
button.pill.fix-ci:hover .wrench{opacity:1}
a.pill.slack{text-decoration:none}
a.pill.slack:hover{border-color:currentColor}
#dialog{width:min(640px,92vw);max-height:80vh;overflow:auto;background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:12px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
#dialog.confirm{width:min(420px,92vw)}
#dialog::backdrop{background:rgba(0,0,0,.45)}
#dialog header{display:flex;justify-content:space-between;align-items:center}
#dialog h3{margin:0;font-size:15px}
#dialog .close{font-size:20px;line-height:1;background:none;border:none;color:var(--muted);cursor:pointer}
#dialog .detail-text{white-space:pre-wrap;line-height:1.5;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
#dialog .confirm-text{margin:10px 0 16px;color:var(--muted);line-height:1.5}
#dialog .buttons{display:flex;justify-content:flex-end;gap:8px}
#dialog .buttons button{font:inherit;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--fg);padding:5px 14px;cursor:pointer}
#dialog .buttons button:not(.primary):hover{border-color:var(--link)}
#dialog .buttons .primary{background:var(--primary);border-color:var(--primary);color:#fff;font-weight:600}
#dialog .buttons .primary.danger{background:var(--danger);border-color:var(--danger)}
#dialog .buttons .primary:hover{filter:brightness(1.1)}
#dialog .buttons button:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.repo{color:var(--muted);font-size:11px}
.title{margin:2px 0 6px}
.pills{display:flex;gap:4px;flex-wrap:wrap}
.pill{font-size:10.5px;border-radius:9px;padding:1px 7px;border:1px solid var(--border)}
.pill.running{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.45}}
.ok{color:var(--ok)}.bad{color:var(--bad)}.wait{color:var(--wait)}.muted{color:var(--muted)}.warn{color:var(--warn)}.link{color:var(--link)}
.ghost{color:var(--muted);border-style:dashed}
.empty{color:var(--muted);font-style:italic;padding:6px}
.empty.big{padding:40px 20px;font-size:15px}
`;
