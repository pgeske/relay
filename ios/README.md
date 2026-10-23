# Relay — iPhone app

SwiftUI client for the relay server in `../src`. Each tmux window running
`omp` is a chat session with live output, attachments, and dictation. The app
can talk to several computers at once; the session list groups sessions by host.

## Build and run

Generate the Xcode project (it is gitignored), then build for the simulator:

    cd ios && xcodegen generate
    xcodebuild -project Relay.xcodeproj -scheme Relay \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
      CODE_SIGNING_ALLOWED=NO build

To build, install, and launch on a paired iPhone in one step: `./scripts/deploy.sh`
(needs your Apple ID in Xcode > Settings > Accounts). The first dictation downloads the Parakeet model.

The bundle identifier is still `com.pgeske.ompremote` so the app upgrades an
existing install in place and keeps its settings.

## Pair a computer

Run `relay pair` on each computer that runs the relay server. It shows a QR
code; scan it with the iPhone Camera app and Relay adds that computer as a
host. Pairing the same server URL again updates its name and token instead of
adding a duplicate. The QR code encodes a link of the form

    relay://pair?url=<server URL>&token=<token>&name=<host name>

Hosts can also be added, edited, tested, and deleted by hand in Settings.
