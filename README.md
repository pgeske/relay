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

The waveform button in a chat (shown when the message box is empty) starts a voice call with that session's agent. It reuses omp's own `/live` mode. That mode always talks through the Mac's default microphone and speakers, so during a call relay points those at two [BlackHole](https://existential.audio/blackhole/) loopback devices and streams the audio to and from the phone. When the call ends, relay switches the devices back. One-time setup:

```sh
brew install ffmpeg sox switchaudio-osx
brew install --cask blackhole-2ch blackhole-16ch   # then: sudo killall coreaudiod
```

The first call makes macOS ask whether relay may use the microphone; click Allow on the Mac. macOS asks again after relay updates. Your omp needs a ChatGPT (Codex) login, as `/live` does on the Mac.

## Updates

relay checks for new releases in the background and shows `relay x.y.z available` in the tab bar. Then run:

```sh
relay update
```

It downloads the new binary, checks its SHA-256, swaps it in place, re-applies the tmux config to your running session, and restarts the phone server. Running agents keep running.

## Commands

```
relay                    Open relay (creates the session on first run)
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
