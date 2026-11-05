# iPhone app

The full reference for the Relay iPhone app and the phone server behind it. The [README](../README.md) has the short version; building the app is in [`ios/README.md`](../ios/README.md).

## Pairing

1. On each computer, start the phone server in the background (it starts at login and restarts if it crashes):

   ```sh
   relay server install
   ```

2. Run `relay pair` and scan the QR code with the iPhone Camera app. Relay adds the computer as a host. Add as many computers as you like; the app groups sessions by host.

The server listens on port 7878 (`RELAY_PORT` to change), only answers loopback, private LAN, and Tailscale addresses, and requires the bearer token stored in `~/.config/relay/token`. `relay pair` prefers the computer's Tailscale address so the phone can reach it away from home.

The background server starts outside any terminal, so on startup it asks your login shell (`$SHELL -l -i`) for its environment and gives that to every agent tab, whether the server starts relay's tmux or relay is already running: agents see what you export in `~/.zshenv`, `~/.zprofile`, `~/.zshrc` and the like, as in a terminal. While it asks, `RELAY_RESOLVING_ENVIRONMENT=1` is set, so your rc files can skip slow steps. Restart the server (`relay server install`) after changing those files.

## Live voice (Mac only)

Voice calls are an early, Mac-only feature and are **off by default**. Turn them on with `relay voice on` (and off again with `relay voice off`); until then the phone shows no call button for that computer.

The waveform button in a chat (shown when the message box is empty) starts a voice call with that session's agent. It reuses omp's own `/live` mode. That mode always talks through the Mac's default microphone and speakers, so during a call relay points those at two [BlackHole](https://existential.audio/blackhole/) loopback devices and streams the audio to and from the phone. When the call ends, relay ends `/live` and switches the devices back. That also happens when the phone stops answering for 15 seconds (app killed, network lost) and when the server stops; a server that was killed mid-call cleans up when it next starts. A Mac runs one call at a time: starting a new call hangs up the old one first. One-time setup:

```sh
brew install ffmpeg sox switchaudio-osx
brew install --cask blackhole-2ch blackhole-16ch   # then: sudo killall coreaudiod
```

The first call makes macOS ask whether relay may use the microphone; click Allow on the Mac. macOS asks again after relay updates. Your omp needs a ChatGPT (Codex) login, as `/live` does on the Mac.
