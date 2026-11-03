# relay

An agent multiplexer for [omp](https://github.com/can1357/oh-my-pi), with an iPhone app to drive your agents from your phone.

Every tab runs an omp agent. The tab bar shows each agent's state: a spinner while it works, a green dot when it finished while you were looking elsewhere. The Relay iPhone app shows the same conversations live, so you can read, reply, dictate, and start new agents from anywhere on your Tailscale network.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/pgeske/relay/main/install.sh | sh
```

This puts a single `relay` binary in `~/.local/bin` (set `RELAY_INSTALL_DIR` to change that). relay needs [tmux](https://github.com/tmux/tmux) and omp on your `PATH`. It runs on macOS and Linux (Apple Silicon/Intel, x64/arm64).

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

This opens the board in your browser at `http://localhost:7878/board`. relay's server (`relay server install`) serves it, only to this computer. Every load asks GitHub fresh, and the page reloads itself every minute, or every 10 seconds while a session is on one of the board's requests, so a finished step shows soon. It doesn't reload while its dialog is open or a button is working.

Your open pull requests sit in columns left to right as work moves: **Draft**, **Agent review**, **Human review**, **Approved · blocked** (CI red or running, or a merge gate said no), and **Ready to merge**, then the PRs you merged lately. Each card shows CI, how long the PR has been quiet, and whether an agent reviewed it. PRs waiting on your review stay off the page, and the page doesn't search for them; `relay board --json` still lists them (`teammates`, and `bots` counted per bot). GitHub's search can list a PR as open for a little while after it merged or closed; the board goes by the PR's own state, so it leaves the lanes right away (a merged one joins the merged list), and PRs the board recently asked to merge are read directly to be sure.

Hover one of your PR cards and click its **×** to close the PR on GitHub (after you confirm in the board's dialog); its branch stays.

When an omp session opened or claimed a PR, the card's bottom row names that session behind an `omp` tag. Click it to jump to the session: relay switches to its tab, reopening it if it was closed, and brings your terminal to the front.

Cards in **Agent review** also get a **Review** button that asks the session to run a reviewer agent on the PR, and cards in **Ready to merge** a **Merge** button that asks it to merge the PR the repo's normal way, checking checks and approvals first and never bypassing branch protection. These step buttons move a PR to its next lane. CI can go red in any lane, so fixing it isn't a button: on any card with a session, the red **CI red** pill (marked with a wrench) asks the session to fix CI. It looks at the failing checks, retries the jobs if the failure was flaky, or fixes a real failure with a new signed commit, without force-pushing or bypassing checks. Merge and Fix CI ask you to confirm first. Each one reopens a closed session in a background tab first, says no while the session is busy, and says no if the PR already merged or closed (then the page reloads to catch up).

Once the session takes a request on, its button gives way to a pulsing tag (**agent reviewing…**, **agent merging…**, **agent fixing CI…**, the last next to the CI pill) until it's done: a review or CI fix when the agent records its result, a merge when the PR merges or closes. If the session goes idle or closes first, the card says the request stopped without a result and offers it again (**Review again**, **Merge again**; for CI, the **CI fix stopped without a result** tag asks again while CI is still red).

GitHub can't tell whether a reviewer agent looked at a PR, so relay keeps that itself, in `~/.local/share/relay/board.db`, together with what the reviewer said: click a card's agent tag to read it. A review is tied to the commit it covered: push new commits and the PR goes back to Agent review until it is reviewed again.

A Fix CI result is kept the same way, tied to the head commit when it was recorded. After a fix, the CI pill gets an asterisk (**CI running\***, then **CI green\***) that opens what the agent found and did; if it couldn't fix CI, an **agent couldn't fix CI** tag opens why. Either goes away with the next commit.

Cards in **Human review** move on through Slack. **Ask for approval** asks the session to draft a Slack message asking for a review: `<PR URL>. <what it does and why>`, casual and lowercase, in the channel you usually post `lfr`s in for that repo (it asks you when that's unclear). Once the ask is recorded, the button becomes **Bump**: the session finds the message you sent (or tells you if you never sent the draft) and drafts a short bump in its thread. Both only ever create drafts; you send them. A tag (**approval asked 2d ago**, then **bumped 1d ago**) opens the ask in Slack in a new tab. Both confirm first, and follow a request like the other steps (**agent drafting approval ask…**, **agent drafting bump…**, or **Ask for approval again** / **Bump again** if the session stopped before recording the draft).

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

It downloads the new binary, checks its SHA-256, swaps it in place, re-applies the tmux config to your running session, and restarts the phone server. Running agents keep running.

## Commands

```
relay                    Open relay (creates the session on first run)
relay board              Open the PR board in your browser (relay board --help)
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
```

`RELAY_TMUX_SOCKET` and `RELAY_PORT` let a development copy run beside your real relay without touching it.

To release, bump `version` in `package.json`, commit, and push a matching `vX.Y.Z` tag. The release workflow builds binaries for every platform, publishes them with a `checksums.txt`, and every machine then sees the update.

## License

MIT
