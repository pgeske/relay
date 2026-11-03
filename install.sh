#!/bin/sh
# Installs the latest relay release:
#   curl -fsSL https://raw.githubusercontent.com/pgeske/relay/main/install.sh | sh
# Set RELAY_INSTALL_DIR to install somewhere other than ~/.local/bin.
set -eu

REPO="pgeske/relay"
INSTALL_DIR="${RELAY_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "relay install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "unsupported OS $(uname -s); relay runs on macOS and Linux (use WSL on Windows)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac
asset="relay-$os-$arch"

# GitHub redirects /releases/latest to /releases/tag/vX.Y.Z.
latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
tag="${latest_url##*/}"
case "$tag" in
  v*) ;;
  *) fail "could not find the latest release of $REPO" ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading relay $tag ($os-$arch)…"
curl -fsSL -o "$tmp/$asset" "https://github.com/$REPO/releases/download/$tag/$asset"
curl -fsSL -o "$tmp/checksums.txt" "https://github.com/$REPO/releases/download/$tag/checksums.txt"

checksum() {
  awk -v name="$1" '$2 == name { print $1 }' "$tmp/checksums.txt"
}

# Fails unless the downloaded asset $1 matches its line in checksums.txt.
verify() {
  expected="$(checksum "$1")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$1" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$tmp/$1" | awk '{ print $1 }')"
  fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $1"
}

verify "$asset"
mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/relay"
echo "Installed relay $tag to $INSTALL_DIR/relay"

# The PR board's app (relay board), on macOS 26 and newer, from releases that have it.
app_asset="relay-board-macos.zip"
app="$HOME/Applications/Relay Board.app"
if [ "$os" = "darwin" ] && [ -n "$(checksum "$app_asset")" ]; then
  if [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 26 ]; then
    curl -fsSL -o "$tmp/$app_asset" "https://github.com/$REPO/releases/download/$tag/$app_asset"
    verify "$app_asset"
    mkdir -p "$tmp/app" "$HOME/Applications"
    ditto -x -k "$tmp/$app_asset" "$tmp/app"
    rm -rf "$app"
    mv "$tmp/app/Relay Board.app" "$app"
    echo "Installed the Relay Board app to $app"
  else
    echo "Note: the Relay Board app (relay board) needs macOS 26 or newer; skipped it."
  fi
fi

command -v tmux >/dev/null 2>&1 || echo "Note: relay needs tmux (macOS: brew install tmux; Debian/Ubuntu: sudo apt install tmux)."
command -v omp >/dev/null 2>&1 || echo "Note: relay runs omp in every tab; install it from https://github.com/can1357/oh-my-pi."
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: add $INSTALL_DIR to your PATH." ;;
esac
echo
echo "Run 'relay' to start. For the iPhone app: 'relay server install', then 'relay pair'."
