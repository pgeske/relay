# relay

An agent multiplexer for [omp](https://github.com/can1357/oh-my-pi), with an iPhone app to drive your agents from your phone.

Every tab runs an omp agent. The tab bar shows each agent's state: a spinner while it works, a green dot when it finished while you were looking elsewhere. The Relay iPhone app shows the same conversations live, so you can read, reply, dictate, and start new agents from anywhere on your Tailscale network.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pgeske/relay/main/install.sh | sh
```

This puts a single `relay` binary in `~/.local/bin` (set `RELAY_INSTALL_DIR` to change that), and on macOS 26 or newer the [Relay Board](#pr-board) app in `~/Applications`. relay needs [tmux](https://github.com/tmux/tmux) and omp on your `PATH`. It runs on macOS and Linux (Apple Silicon/Intel, x64/arm64).

## Use

```sh
relay
```

The first run creates the relay session with one agent in the current directory; later runs reattach to it.

| Keys | Action |
|---|---|
| Ctrl+N | New agent tab in the current directory |
| Ctrl+K | Pick a tab from a list with each agent's status |
| Alt+Shift+[ / ] | Previous / next tab |
| Ctrl+] | Zoom the current pane |
| Ctrl+B or Ctrl+A | tmux prefix (prefix `d` detaches, prefix `&` closes a tab) |

### Looks the same everywhere

relay is built on tmux but runs its own tmux server (`tmux -L relay`) started with relay's bundled config instead of `~/.tmux.conf`. Your personal tmux setup, and any tmux sessions you already have, never affect relay and relay never touches them. The config ships inside the binary, so every machine on the same relay version looks and behaves identically.

## iPhone app

1. On each computer, start the phone server in the background (it starts at login and restarts if it crashes):

   ```sh
   relay server install
   ```

2. Run `relay pair` and scan the QR code with the iPhone Camera app. Relay adds the computer as a host. Add as many computers as you like; the app groups sessions by host.

The server listens on port 7878 (`RELAY_PORT` to change), only answers loopback, private LAN, and Tailscale addresses, and requires the bearer token stored in `~/.config/relay/token`. `relay pair` prefers the computer's Tailscale address so the phone can reach it away from home.

The app lives in [`ios/`](ios/README.md); build it with Xcode and install it on your phone.

### Live voice (Mac only)

Voice calls are an early, Mac-only feature and are **off by default**. Turn them on with `relay voice on` (and off again with `relay voice off`); until then the phone shows no call button for that computer.

The waveform button in a chat (shown when the message box is empty) starts a voice call with that session's agent. It reuses omp's own `/live` mode. That mode always talks through the Mac's default microphone and speakers, so during a call relay points those at two [BlackHole](https://existential.audio/blackhole/) loopback devices and streams the audio to and from the phone. When the call ends, relay ends `/live` and switches the devices back. That also happens when the phone stops answering for 15 seconds (app killed, network lost) and when the server stops; a server that was killed mid-call cleans up when it next starts. A Mac runs one call at a time: starting a new call hangs up the old one first. One-time setup:

```sh
brew install ffmpeg sox switchaudio-osx
brew install --cask blackhole-2ch blackhole-16ch   # then: sudo killall coreaudiod
```

The first call makes macOS ask whether relay may use the microphone; click Allow on the Mac. macOS asks again after relay updates. Your omp needs a ChatGPT (Codex) login, as `/live` does on the Mac.

## PR board

```sh
relay board          # or prefix B inside relay
```

This opens **Relay Board**, a macOS app (macOS 26 or newer) that relay's installer puts in `~/Applications` and `relay update` keeps on the same version as relay. The app reads the board from relay's server (`relay server install`); when the server isn't running, it says so and shows the command that starts it. Every refresh asks GitHub fresh. The app refreshes every minute, or every 10 seconds while a session is on one of the board's requests so a finished step shows soon, and whenever you press ⌘R; it holds off while a confirmation is open or a button is working. Elsewhere, read the board with `relay board --json`.

Your open pull requests sit in columns left to right as work moves: **Draft**, **Agent review**, **Human review** (until every approval it needs is in, including any a merge gate asks for), **Approved · blocked** (all approvals in, but CI is red or running, or GitHub still won't merge: a merge gate said no, branch rules, or conflicts), and **Ready to merge**, then the PRs you merged lately. The sidebar shows how many each lane holds and opens one on its own, and the Dock icon counts the PRs waiting on you (Approved · blocked and Ready to merge). Each card's header names the repo and PR number, the ticket its title starts with, and how long the PR has been quiet (stale after a week). Below the title, a few status rows, always in the same order and only the ones that matter in the card's lane: **CI** in every lane, **Agent** (its agent review) in Agent review and Human review, **Approvals** from Human review on ("1 of 2 · needs some-team" when a merge gate says how many are missing, **Changes requested** in red), and **Slack** once an approval ask exists. Anything that needs you, like a request that stopped without a result or what keeps GitHub from merging an approved PR, gets a notice line under the rows. Click a card to open the PR in your browser. PRs waiting on your review stay off the board, and the app doesn't search for them; `relay board --json` still lists them (`teammates`, and `bots` counted per bot). GitHub's search can list a PR as open for a little while after it merged or closed; the board goes by the PR's own state, so it leaves the lanes right away (a merged one joins the merged list), and PRs the board recently asked to merge are read directly to be sure.

Hover one of your PR cards and click its **×** (or right-click it and choose **Close PR…**) to close the PR on GitHub, after you confirm; its branch stays.

When an omp session opened or claimed a PR, the card's bottom row names that session. Click it to jump to the session: relay switches to its tab, reopening it if it was closed, and brings your terminal to the front.

Cards in **Agent review** also get a **Review** button that asks the session to run a reviewer agent on the PR, and cards in **Ready to merge** a **Merge** button that asks it to merge the PR the repo's normal way, checking checks and approvals first and never bypassing branch protection. These step buttons move a PR to its next lane. CI can go red in any lane, so fixing it isn't a button: on any card with a session, red CI's **Fix CI** control (marked with a wrench) in the CI row asks the session to fix CI. It looks at the failing checks, retries the jobs if the failure was flaky, or fixes a real failure with a new signed commit, without force-pushing or bypassing checks. Merge and Fix CI ask you to confirm first. Each one reopens a closed session in a background tab first, says no while the session is busy, and says no if the PR already merged or closed (then the board refreshes to catch up).

Once the session takes a request on, its button gives way to a spinner: in the row the request is about (**Reviewing…** in the Agent row, **Red · agent fixing…** in the CI row), or in the card's footer where the button was (**Agent merging…**) until it's done: a review or CI fix when the agent records its result, a merge when the PR merges or closes. If the session goes idle or closes first, a notice says the request stopped without a result, and the card offers it again (**Review Again**, **Merge Again**; for CI, the CI row's **Fix CI Again** while CI is still red).

GitHub can't tell whether a reviewer agent looked at a PR, so relay keeps that itself, in `~/.local/share/relay/board.db`, together with what the reviewer said: click the value in a card's Agent row to read it. A review is tied to the commit it covered: push new commits and the PR goes back to Agent review until it is reviewed again.

A Fix CI result is kept the same way, tied to the head commit when it was recorded. After a fix, the CI row's value gets an asterisk (**Running\***, then **Green\***) that opens what the agent found and did; if it couldn't fix CI, an **Agent couldn't fix CI** notice opens why. Either goes away with the next commit.

Cards in **Human review** move on through Slack. **Ask for Approval** asks the session to draft a Slack message asking for a review: `<PR URL>. <what it does and why>`, casual and lowercase, in the channel you usually post `lfr`s in for that repo (it asks you when that's unclear). Once the ask is recorded, the button becomes **Bump**: the session finds the message you sent (or tells you if you never sent the draft) and drafts a short bump in its thread. Both only ever create drafts; you send them. The card's Slack row (**Asked 2d ago**, then **Bumped 1d ago**) opens the ask in Slack. Both confirm first, and follow a request like the other steps (**Agent drafting approval ask…**, **Agent drafting bump…**, or **Ask for Approval Again** / **Bump Again** if the session stopped before recording the draft).

The board's buttons type into your sessions, so its endpoints (`GET /api/board` and `POST /api/board/actions/<action>`) answer only this computer: a request must come over loopback and name `localhost`, and it must carry the bearer token in `~/.config/relay/token`, a mode-600 file the app reads and a web page can't. A page that rebinds its domain to 127.0.0.1 fails the first check, and no page can read the token.

```sh
relay board review <pr-url> --passed --summary "Found nothing to change."
relay board review <pr-url> --findings 3 --summary - < review.md   # a longer write-up from stdin
relay board ci-fix <pr-url> --fixed --summary - < fix.md            # or --not-fixed, saying why
relay board approval <pr-url> --asked --slack <channel-link>        # after drafting the approval ask
relay board approval <pr-url> --bumped --slack <permalink>          # after drafting a bump; the link moves to the sent ask
```

relay installs an omp skill (`~/.omp/agent/skills/relay`) that tells agents to record every review, CI fix, approval ask, and bump they finish and to read the board with `relay board --json`, so you rarely run these by hand. Each card in the JSON also says where every request the board sent stands (`requests`), the latest CI fix (`ciFix`), and the approval ask (`approval`: when it was asked and last bumped, and its Slack link).

The board reads GitHub through the [`gh`](https://cli.github.com) CLI. Settings live in `~/.config/relay/board.json`; every field is optional:

```json
{
  "sources": [{ "org": "my-org", "ghUser": "my-work-account" }],
  "gateChecks": ["merge-queue/gate"],
  "reviewTeams": ["my-org/my-team"],
  "mergedDays": 7
}
```

| Field | Meaning |
|---|---|
| `sources` | Orgs to search, each with the `gh` account to use (`gh auth token --user`). Default: everything gh's active account sees. |
| `gateChecks` | Checks that gate merging instead of testing code. They never count as CI running, and block the PR when they fail. |
| `reviewTeams` | Teams whose review requests count as waiting on you. Default: every team you are on, which can include busy admin teams. |
| `mergedDays` | How far back the Merged section goes. Default 7. |

## Updates

relay checks for new releases in the background and shows `relay x.y.z available` in the tab bar. Then run:

```sh
relay update
```

It downloads the new binary (and on a Mac the Relay Board app), checks its SHA-256, swaps it in place, re-applies the tmux config to your running session, and restarts the phone server. Running agents keep running.

## Commands

```
relay                    Open relay (creates the session on first run)
relay board              Open the PR board app (relay board --help)
relay pair [address]     Show a QR code that adds this computer to the Relay iPhone app
relay server             Run the phone server in the foreground
relay server install     Run the phone server in the background, starting at login
relay server uninstall   Stop and remove the background phone server
relay server status      Show whether the background phone server is running
relay update             Install the latest release
relay reload             Re-apply relay's tmux config to the running session
relay version            Print the version
```

## Development

relay is TypeScript compiled into a standalone binary with [Bun](https://bun.sh).

```sh
bun install
bun run dev          # run from source
bun run typecheck
bun test
bun run build        # dist/relay
macos/scripts/build.sh   # build the Relay Board app and install it to ~/Applications
```

`RELAY_TMUX_SOCKET` and `RELAY_PORT` let a development copy run beside your real relay without touching it; `relay board` passes `RELAY_PORT` on to the app.

The Relay Board app in [`macos/`](macos/) is a SwiftUI app built with Swift Package Manager, so it needs only the Command Line Tools with the macOS 26 SDK (Swift 6.2 or newer), not Xcode. `macos/scripts/build.sh` builds it for this Mac, turns the iPhone app's icon into a macOS one, ad-hoc signs the bundle, and installs it as `~/Applications/Relay Board.app`, reopening it if it was open.

To release, bump `version` in `package.json`, commit, and push a matching `vX.Y.Z` tag. The release workflow builds binaries for every platform and the Relay Board app (a universal `relay-board-macos.zip`), publishes them with a `checksums.txt`, and every machine then sees the update.

## License

MIT
