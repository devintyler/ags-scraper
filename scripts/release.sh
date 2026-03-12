#!/usr/bin/env bash
set -euo pipefail

# Read version from Cargo.toml (single source of truth)
VERSION=$(grep '^version' src-tauri/Cargo.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
TAG="v$VERSION"
EXE="src-tauri/target/release/agsp-scraper.exe"
ASSET_NAME="agsp-scraper-${TAG}.exe"

# Sync check: tauri.conf.json version must match Cargo.toml
TAURI_VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/[^"]*"version"[^"]*"\([^"]*\)".*/\1/')
if [ "$VERSION" != "$TAURI_VERSION" ]; then
  echo "ERROR: Version mismatch!"
  echo "  Cargo.toml:     $VERSION"
  echo "  tauri.conf.json: $TAURI_VERSION"
  echo "Update both files to the same version before releasing."
  exit 1
fi

# Check gh CLI is available
if ! command -v gh &>/dev/null; then
  echo "ERROR: 'gh' CLI not found. Install it and authenticate with 'gh auth login'."
  exit 1
fi

# Check if tag already exists on remote
if gh release view "$TAG" &>/dev/null 2>&1; then
  echo "ERROR: Release $TAG already exists on GitHub."
  exit 1
fi

echo "Ready to release $TAG"
echo "  Asset: $ASSET_NAME"
echo ""
echo "Press Enter to build and publish, or Ctrl-C to abort."
read -r || true

# Build
cargo tauri build

if [ ! -f "$EXE" ]; then
  echo "ERROR: Build succeeded but $EXE not found."
  exit 1
fi

# Create GitHub release with auto-generated notes; asset renamed on upload
gh release create "$TAG" \
  --title "$TAG" \
  --generate-notes \
  --draft \
  "${EXE}#${ASSET_NAME}"

echo ""
echo "Released $TAG — https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${TAG}"
