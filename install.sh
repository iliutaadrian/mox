#!/usr/bin/env bash
# mox installer — downloads the latest prebuilt binary for your Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/iliutaadrian/mox/main/install.sh | bash
#
# Env:
#   MOX_INSTALL_DIR   where to install (default: ~/.local/bin)
#   MOX_VERSION       a specific tag, e.g. v1.0.0 (default: latest)
set -euo pipefail

REPO="iliutaadrian/mox"
INSTALL_DIR="${MOX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${MOX_VERSION:-latest}"

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

os="$(uname -s)"
if [ "$os" != "Darwin" ]; then
  red "mox binaries are published for macOS only (got: $os)."
  dim "Run from source instead: https://github.com/$REPO#run-from-source-dev"
  exit 1
fi

case "$(uname -m)" in
  arm64)  asset="mox-darwin-arm64" ;;
  x86_64) asset="mox-darwin-x64" ;;
  *)      red "unsupported architecture: $(uname -m)"; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

grn "Downloading $asset ($VERSION)…"
if ! curl -fsSL "$url" -o "$tmp"; then
  red "download failed: $url"
  dim "Check that a release exists at https://github.com/$REPO/releases"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp" "$INSTALL_DIR/mox"
grn "Installed mox → $INSTALL_DIR/mox"

echo
if ! command -v mox >/dev/null 2>&1; then
  red "$INSTALL_DIR is not on your PATH."
  dim "Add it, e.g.:  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  echo
fi

dim "Next: create ~/Documents/mox/config.yaml (copy config.example.yaml and edit),"
dim "then run:  mox"
