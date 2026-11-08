#!/usr/bin/env bash
# Builds Relay Board, relay's PR board for macOS, and installs it to ~/Applications.
#   macos/scripts/build.sh               build for this Mac and install it (reopening it if it was open)
#   macos/scripts/build.sh --zip <path>  build for Apple Silicon and Intel into a zip, without installing
# Needs Swift 6.2 or newer with the macOS 26 SDK: Xcode 26, or just its Command Line Tools.
set -euo pipefail

macos="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(dirname "$macos")"
name="Relay Board"
bundle_id="io.github.pgeske.relay.board"

zip=""
case "${1:-}" in
  "") ;;
  --zip) zip="${2:?--zip needs a path}" ;;
  *) echo "usage: $0 [--zip <path>]" >&2; exit 2 ;;
esac

version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$repo/package.json")"
[[ -n "$version" ]] || { echo "build.sh: couldn't read the version from package.json" >&2; exit 1; }
build="$macos/.build"
app="$build/$name.app"

if [[ -n "$zip" ]]; then archs=(arm64 x86_64); else archs=("$(uname -m)"); fi
binaries=()
for arch in "${archs[@]}"; do
  triple="$arch-apple-macosx26.0"
  swift build -c release --package-path "$macos" --triple "$triple"
  binaries+=("$(swift build -c release --package-path "$macos" --triple "$triple" --show-bin-path)/RelayBoard")
done

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
lipo -create "${binaries[@]}" -output "$app/Contents/MacOS/RelayBoard"
sed "s/__VERSION__/$version/g" "$macos/Info.plist" > "$app/Contents/Info.plist"

# The iPhone app's icon, on the macOS icon grid.
iconset="$build/AppIcon.iconset"
rm -rf "$iconset"
swift "$macos/scripts/make-icon.swift" "$repo/ios/Relay/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png" "$iconset"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

# The icons omp puts in front of session titles are Nerd Font glyphs; the iPhone app ships the same font.
cp "$repo/ios/Relay/Resources/Fonts/SymbolsNerdFont-Regular.ttf" "$app/Contents/Resources/"

# Ad-hoc signed, like relay's own binary: Apple Silicon runs nothing unsigned.
codesign --force --sign - "$app"

if [[ -n "$zip" ]]; then
  mkdir -p "$(dirname "$zip")"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  echo "Built $name $version into $zip"
  exit 0
fi

dest="$HOME/Applications/$name.app"
running=false
if pgrep -xq RelayBoard; then
  running=true
  osascript -e "tell application id \"$bundle_id\" to quit"
  while pgrep -xq RelayBoard; do sleep 0.2; done
fi
mkdir -p "$HOME/Applications"
rm -rf "$dest"
ditto "$app" "$dest"
# So `open -b` and Spotlight find it right away.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest"
echo "Installed $name $version to $dest"
if $running; then open "$dest"; fi
