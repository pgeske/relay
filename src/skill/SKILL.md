---
name: relay
description: Relay's board of the user's tasks and PRs. Use at the start of any multi-step task in a relay session (anything taking more than a few minutes, code or not, like a change, a rollout, an investigation, or asking a team for something) to register it, and while working on it to record its plan, say what it waits on before stopping, and say when it's done; when asked to track this in relay; when asked where tasks or pull requests stand, what's ready to merge, or what's waiting on review; right after a reviewer agent finishes reviewing a pull request, after finishing a Fix CI request from the board, or after drafting a Slack approval ask or bump for a pull request, to record it; and when taking over a pull request another session opened.
---

# relay board

The Relay Board app has two views: **Tasks**, what the user is getting done, and **Pull Requests**. The user juggles several tasks at once, and attention is the bottleneck: the Tasks view exists so a task never gets forgotten while they look at another.

## Tasks

A task is one thing the user wants done: a fix, a rollout, an investigation, getting another team to do something. It can take several sessions and PRs, or none. Tasks can belong to a project (a named group of tasks); projects can nest inside other projects.

You report at four moments: when you start, when you have a plan, before you stop, and when it's done. In between, relay keeps the card current on its own: when you stop, or after a few minutes of work without a report, it reads the end of this session and refreshes the task's stage and status line, marked **auto**. You don't need to report each step; commands without a task id act on this session's task.

**1. Register the task when you start one** in a relay session, unless this session is already on a task (the user started it from the board, or you registered it earlier). Skip it for quick questions and one-off answers.

```sh
relay task new "Roll out the new cache to staging" --project "Faster search" --status "Reading the rollout runbook"
# prints T-12; this session is on it now
```

- The title says the outcome in a few plain words. `--details -` takes a longer description on stdin.
- By default the user approves your plan before you carry it out (below). Add `--skip-plan` when there's nothing to plan, or the user already told you exactly what to do.
- `--project` names a project, creating it if needed; `Parent/Child` names a subproject inside another (`--project "Relay/Sidebar"`). Reuse an existing one (`relay task --json` lists projects, each with its `path`) rather than inventing a near-duplicate.

**2. Plans.** Unless the task skips plan approval, record your plan and then stop until the user approves it on the board (they press **Approve Plan**, which tells you to go ahead):

```sh
relay task plan --summary - <<'EOF'
1. Turn the cache on in the staging config.
2. Apply one datacenter, check search latency, then the rest.
EOF
```

A plan recorded again (revised) needs approving again. On a task that skips approval, recording a plan is optional and just informs.

**3. Before ending your turn**, say what the task waits on. It decides whether the task lands in front of the user, and relay can only guess it from your last words:

```sh
relay task update --blocked-on me --reason "Which datacenter should go first?"
relay task update --blocked-on others --reason "Waiting on the storage team to approve the config change"
```

- Waiting for the user's answer or decision: `--blocked-on me`. Waiting for anyone else (a team, a reviewer, a deploy, a long job): `--blocked-on others`, which moves the task to the board's Blocked column until the block clears. When that update is your last step before you stop, relay takes your word for it.
- Any update without `--blocked-on` clears the block, so repeat it while it holds.
- Stopping because the work is finished? Run `relay task done` instead (below). Stopping after `relay task plan` needs nothing more.

**4. Finishing.** When the work is finished by the task's own bar (merged, rolled out, verified, answered), say so with a note on what you did and how you checked it. The board shows that note on the task's card, so write it for the user to verify at a glance: the outcome first, then the evidence. The task waits in the board's **Ready to ship** column until the user looks: **Ship It** moves it to Shipped and closes its idle sessions' tabs; **Not Yet** sends it back and shows them this session, to tell you what's missing. Any `relay task update` after that takes it out of Ready to ship again; pick the work back up, and run `relay task done` again once it's finished.

```sh
relay task done --status "Rolled out to every staging datacenter" --summary - <<'EOF'
Rolled the cache out to all 6 staging datacenters. Search p99 stayed under 120ms in each (dashboard checked after every one); no errors in the logs.
EOF
```

**Also worth knowing:**

- `relay task update --pr <url>` adds a PR this session didn't open; PRs it opens join the task on their own.
- `relay task update --stage <stage> --status "<line>"` is there when the auto status is wrong or you want to say something specific. Stages, in order: `research`, `plan`, `doing`, `rollout` (rolling out or verifying). Only the user moves a task to `done`.
- The user can **block** a task on the board to set it aside: it moves to the Blocked column and stays there until they unblock it or you finish it. That's separate from `--blocked-on`, which is what you say it waits on.

**When the board hands you a task** ("I started T-12 from the relay board"), this session is already on it: don't register it again. When the board asks you to track a session, register what it's working on with `relay task new`, or say it isn't a task. `relay task link <task>` puts this session on an existing task (say, a second session on the same work). `relay task show` prints this session's task; `relay task --json` lists them all, in a column per stage (`idea`, `research`, `plan`, `doing`, `rollout`, `ship`, `blocked`, `done`), each card's `turn` saying whose move it is (`you`, `agent`, `others`, `blocked`, `idle`, `idea`, `done`), then `untracked` sessions.

## Pull requests

`relay board` shows each of the user's open pull requests in a lane, closest to shipping first:

| Lane | Meaning |
|---|---|
| Ready to merge | Every approval in, CI green, and GitHub would merge it now |
| Approved · blocked | Every approval in, but CI is red or running, or GitHub still won't merge (a failed gate check, branch rules, conflicts) |
| Agent review | Ready for review, but no reviewer agent has passed its current commit, the user didn't skip its agent review, and no person has approved yet |
| Human review | Waiting on people: a reviewer agent passed the current commit, the user skipped the agent review, or someone approved, but approvals are still missing (GitHub's review decision, or a merge gate asking for more) |
| Draft | Still being shaped |

After the lanes: PRs merged recently. PRs waiting on the user's review aren't on the board; `--json` lists them (`teammates`, and `bots` counted per bot).

## Reading the board

- `relay board --json` for data. Each card has `pr` (including `mergeState`, `approvedBy`, `approvedFor`: the teams those approvals were on behalf of, and `waitingOn`: reviewers, people or teams, still asked), `ci` (`passed`/`failed`/`running`/`none`), `mergeBlocker` (what keeps it from merging besides CI, e.g. "1 approval missing", or null), `agentReview`, `ciFix` (the latest Fix CI result: `fixed`/`not-fixed`, with `stale` once newer commits landed), `approval` (the Slack asks for approval: `asks`, one per reviewer, each with `reviewer`, `channel`, `askedAt`, `recordedAt`, `source` (`drafted`, or `found` already sent), `bumpedAt`, `slackUrl`, and `approved` once that reviewer approved; and `unasked`: reviewers the PR waits on that no ask went to yet), and `requests`: where each request the board sent the PR's session stands, per step (`review`, `merge`, `fix-ci`, `ask-approval`, `bump`: `none`, `running`, or `stalled` when the session stopped without finishing). `owners` maps "owner/repo#number" to the session in charge of it.
- `relay board` opens the human view, the Relay Board macOS app (prefix `B` inside relay does the same). It is for the user; read `--json` yourself.

## The session in charge of a PR

The omp session that opens a PR (`gh pr create`) is in charge of it: relay links them on its own, and the board's buttons send that session its work: run a reviewer agent on the PR, fix its failing CI, draft Slack messages asking its reviewers for approval (then bumps of them), or merge it. When such a request arrives, do it in this session so the PR's history stays in one place. The board follows each request until it's done: a review or CI fix when you record it (below), approval asks once every reviewer the PR waits on has one recorded, bumps once each ask still waiting has one recorded, a merge when the PR merges.

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

Clicking **Fix CI** in a card's red CI row on the board (it works in any lane) asks the session in charge to find out why CI failed on the PR's head commit, then retry flaky or infrastructure failures, or fix a real failure with a new signed commit (never force-push, amend shared history, or bypass or disable checks). When you finish one, **always** record how it went, fixed or not, so the card stops showing the request as running:

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

## Recording approval asks and bumps

In **Human review**, the board's **Ask for Approval** button asks the session in charge to draft a Slack message asking each reviewer the PR still waits on (a person or a team) for a review, in the channel where that reviewer takes review requests. It only names reviewers no ask went to yet. Once every reviewer it waits on has an ask, the button becomes **Bump**, which asks the session to draft a short bump in the thread of each ask whose reviewer hasn't approved yet. The user sends every message:

- Only ever draft, with the Slack MCP draft tool (`slack_send_message_draft`). Never send or schedule a message.
- Each ask is the full PR URL plus one plain-English sentence on what the PR does and why, in the same format and tone as the user's earlier review requests (the search below finds them); casual and short if there are none.
- It goes where that team or person takes review requests: search Slack for the team's channel, or earlier review requests to them. If the channel is unclear, ask the user instead of guessing. One message per channel: reviewers who share a channel share one.
- Find before drafting: the user often asks for review in Slack himself. Search Slack with `slack_search_public_and_private` (review channels can be private) for messages containing the PR URL, and for `<repo>#<number>`, from the user or anyone. A message that asks for the PR's review in a reviewer's channel, or clearly asks their team elsewhere, is that reviewer's ask: don't draft, record it with `--existing` and the message's own permalink. If it's unclear whether a message counts, ask the user. Draft only for the rest, then tell the user which asks you found and linked and which you drafted.
- When GitHub lists nobody the PR waits on but approvals are still missing, work out who from its required reviewers or CODEOWNERS.
- Before a bump, find the ask as sent: a found ask's link is already the message; otherwise search its channel for the user's message containing the PR URL. If the draft was never sent, say so and offer to draft it again instead of bumping. A bump is a reply in that message's thread (`thread_ts` is its ts, or its thread's when the ask is itself a reply). Skip asks whose reviewer has approved.

**Always** record each ask right after drafting it, or finding it already sent, naming who it asks and where, so the card lists it and stops showing the request as running:

```sh
# After drafting an ask: the reviewer by GitHub login or team slug, the channel's name, and the channel_link the draft tool returned
relay board approval <pr-url> --asked --for payments --channel payments-eng --slack https://app.slack.com/client/T0123/C0456

# One message asking two reviewers who share a channel
relay board approval <pr-url> --asked --for payments,sara --channel payments-eng --slack https://app.slack.com/client/T0123/C0456

# An ask found already sent: the message's own permalink, whose ts says when it was asked
relay board approval <pr-url> --asked --existing --for payments --channel payments-eng --slack https://acme.slack.com/archives/C0456/p1793643074057839

# After drafting a bump: whose ask it bumps, and the permalink of the ask as the user sent it
relay board approval <pr-url> --bumped --for payments --slack https://acme.slack.com/archives/C0456/p1793643074057839
```

- `--channel` takes the channel's name without its `#`, which a shell would read as a comment. `--slack` must be a Slack link (https on slack.com). The card's Slack row lists each ask (**#payments-eng · asked 2d ago**, **#infra · bumped 1d ago**) and opens it; an ask whose reviewer approved is checked off.
- `--bumped` moves the ask's recorded link to the permalink, so later bumps and the board go straight to the thread. It needs that reviewer's ask recorded first. An ask recorded before asks named their reviewer has none: bump it without `--for`, adding `--channel` to note where it is.
- Recording `--asked` again for a reviewer (say, re-drafting an ask that was never sent) starts that reviewer's ask over: it replaces the ask and forgets its bumps.
