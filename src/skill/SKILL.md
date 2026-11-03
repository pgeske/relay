---
name: relay
description: Relay's PR board. Use when asked where pull requests stand, what's ready to merge, or what's waiting on review; right after a reviewer agent finishes reviewing a pull request, after finishing a Fix CI request from the board, or after drafting a Slack approval ask or bump for a pull request, to record it; and when taking over a pull request another session opened.
---

# relay board

`relay board` shows each of the user's open pull requests in a lane, closest to shipping first:

| Lane | Meaning |
|---|---|
| Ready to merge | Approved, CI green, merge gate not blocking |
| Approved · blocked | Approved, but CI is red or running, or a merge gate check failed |
| Agent review | Ready for review, but no reviewer agent has passed its current commit |
| Human review | A reviewer agent passed the current commit; waiting on a person |
| Draft | Still being shaped |

After the lanes: PRs merged recently. PRs waiting on the user's review aren't on the page; `--json` lists them (`teammates`, and `bots` counted per bot).

## Reading the board

- `relay board --json` for data. Each card has `pr`, `ci` (`passed`/`failed`/`running`/`none`), `gateBlocked`, `agentReview`, `ciFix` (the latest Fix CI result: `fixed`/`not-fixed`, with `stale` once newer commits landed), `approval` (the Slack message asking for approval: `not-asked`, or `asked`/`bumped` with `askedAt`, `bumpedAt`, and `slackUrl`), and `requests`: where each request the board sent the PR's session stands, per step (`review`, `merge`, `fix-ci`, `ask-approval`, `bump`: `none`, `running`, or `stalled` when the session stopped without finishing). `owners` maps "owner/repo#number" to the session in charge of it.
- `relay board` opens the human view in the browser (prefix `B` inside relay does the same). It is for the user; read `--json` yourself.

## The session in charge of a PR

The omp session that opens a PR (`gh pr create`) is in charge of it: relay links them on its own, and the board's buttons send that session its work: run a reviewer agent on the PR, fix its failing CI, draft a Slack message asking for approval (then a bump of it), or merge it. When such a request arrives, do it in this session so the PR's history stays in one place. The board follows each request until it's done: a review, CI fix, approval ask, or bump when you record it (below), a merge when the PR merges.

When you take over a PR that another session opened, and will keep working on it here, claim it:

```sh
relay board claim <pr-url>
```

## Recording a reviewer-agent result

GitHub can't tell whether a reviewer agent looked at a PR, so record it. Do this **every time** a reviewer agent finishes reviewing a PR, after reading its findings. Pass the reviewer's write-up on stdin so the user can read it from the board:

```sh
relay board review <pr-url> --passed --summary - <<'EOF'
Found nothing to change. Checked the mount role list against callers; no side effects.
EOF

relay board review <pr-url> --findings 2 --summary - <<'EOF'
1. retry.go: the backoff never resets after a success, so later failures wait the maximum.
2. No test covers the empty-config path.
EOF
```

- Count only actionable findings: issues worth changing the code for. Zero actionable findings is `--passed`.
- The result is tied to the PR's current head commit. Pushing fixes makes it out of date, so after fixing findings, run the reviewer again and record the new result.
- Record after the review is final, not while the reviewer is still running.
- The summary is what the user sees when they click the review on the board: the verdict in a sentence, then each finding with its file and why it matters. Keep it to the reviewer's substance, not your own process.

## Recording a Fix CI result

Clicking a card's red **CI red** pill on the board (it works in any lane) asks the session in charge to find out why CI failed on the PR's head commit, then retry flaky or infrastructure failures, or fix a real failure with a new signed commit (never force-push, amend shared history, or bypass or disable checks). When you finish one, **always** record how it went, fixed or not, so the card stops showing the request as running:

```sh
relay board ci-fix <pr-url> --fixed --summary - <<'EOF'
integration-tests timed out pulling an image (registry 503): flaky. Retried the job; it passed.
EOF

relay board ci-fix <pr-url> --not-fixed --summary - <<'EOF'
lint fails on main too (a new rule landed there); the PR can't fix it without unrelated changes.
EOF
```

- Record after pushing the fix or retrying the jobs, once the rerun finishes when that's practical.
- The result is tied to the PR's head commit when you record it, so record after pushing a fix. The board shows it until the next commit.
- The summary is what the user sees when they click the result on the board: what failed, whether it was flaky, and what you did, or why it couldn't be fixed.

## Recording an approval ask or bump

In **Human review**, the board's **Ask for approval** button asks the session in charge to draft a Slack message asking for a review; once an ask is recorded, the button becomes **Bump**, which asks it to draft a short bump in the ask's thread. The user sends every message:

- Only ever draft, with the Slack MCP draft tool (`slack_send_message_draft`). Never send or schedule a message.
- The ask reads `<full PR URL>. <one plain-English sentence on what the PR does and why>`, casual and lowercase, like the user's recent messages in that channel.
- It goes where the user usually asks for reviews for that repo or team: search the user's recent Slack messages for earlier review requests. If the channel is unclear, ask the user instead of guessing.
- Before a bump, find the ask as sent: search Slack for the user's message containing the PR URL. If the draft was never sent, say so and offer to draft it again instead of bumping. A bump is a reply in that message's thread (`thread_ts` is its ts).

**Always** record right after drafting, so the card links to the ask and stops showing the request as running:

```sh
# After drafting the ask: the channel_link the draft tool returned
relay board approval <pr-url> --asked --slack https://app.slack.com/client/T0123/C0456

# After drafting a bump: the permalink of the ask as the user sent it
relay board approval <pr-url> --bumped --slack https://acme.slack.com/archives/C0456/p1793643074057839
```

- `--slack` must be a Slack link (https on slack.com). The card's tag (**approval asked 2d ago**, **bumped 1d ago**) opens it.
- `--bumped` moves the recorded link to the permalink, so later bumps and the board go straight to the thread. It needs an ask recorded first.
- Recording `--asked` again (say, re-drafting an ask that was never sent) starts over: it replaces the ask and forgets its bumps.
