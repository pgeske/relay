#!/usr/bin/env bash
# Builds Relay for a real iPhone and installs + launches it.
# Usage: ios/scripts/deploy.sh [device identifier]   (default: first paired physical iPhone)
set -euo pipefail
cd "$(dirname "$0")/.."

device="${1:-}"
if [[ -z "$device" ]]; then
  devices_json="$(mktemp)"
  trap 'rm -f "$devices_json"' EXIT
  xcrun devicectl list devices --json-output "$devices_json" >/dev/null
  device="$(plutil -extract result.devices json -o - "$devices_json" |
    node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).find(x=>x.hardwareProperties?.deviceType==="iPhone"&&x.hardwareProperties?.reality!=="simulated"); if(!d) process.exit(1); console.log(d.hardwareProperties.udid)')" ||
    { echo "No iPhone found. Pair it in Xcode (Window > Devices and Simulators) first." >&2; exit 1; }
fi

xcodegen generate

# Building for the specific device (not generic iOS) lets Xcode register it with the
# team and create the development provisioning profile automatically.
xcodebuild -project Relay.xcodeproj -scheme Relay \
  -destination "id=$device" -derivedDataPath build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build

app="build/Build/Products/Debug-iphoneos/Relay.app"
xcrun devicectl device install app --device "$device" "$app"
# The bundle id predates the rename; keeping it upgrades the installed app in place.
xcrun devicectl device process launch --device "$device" com.pgeske.ompremote
