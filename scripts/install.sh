#!/usr/bin/env bash
set -euo pipefail

# Install script for the Released CLI
# Usage: curl -fsSL https://releases.sh/install | bash

REPO="buildinternet/releases"
INSTALL_DIR="${RELEASED_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="releases"

# ── Detect platform ──

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)
    echo "Error: Unsupported operating system: $OS" >&2
    echo "Supported: macOS (Darwin), Linux" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_SUFFIX="x64" ;;
  arm64|aarch64) ARCH_SUFFIX="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH" >&2
    echo "Supported: x86_64/amd64, arm64/aarch64" >&2
    exit 1
    ;;
esac

TARGET="${PLATFORM}-${ARCH_SUFFIX}"
PKG_NAME="@buildinternet/releases-${TARGET}"

echo "Released CLI installer"
echo "  Platform: ${OS} ${ARCH} (${TARGET})"
echo "  Install to: ${INSTALL_DIR}/${BINARY_NAME}"
echo ""

# ── Check for npm (preferred method) ──

if command -v npm &>/dev/null; then
  echo "Installing via npm..."
  npm install -g @buildinternet/releases
  echo ""
  echo "Installed! Run 'releases --help' to get started."
  exit 0
fi

# ── Fallback: download binary directly from npm registry ──

echo "npm not found — downloading binary directly from npm registry..."

# Get latest version from npm
VERSION=$(curl -fsSL "https://registry.npmjs.org/@buildinternet/releases/latest" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$VERSION" ]]; then
  echo "Error: Could not determine latest version" >&2
  exit 1
fi

echo "  Version: ${VERSION}"

TARBALL_URL="https://registry.npmjs.org/${PKG_NAME}/-/releases-${TARGET}-${VERSION}.tgz"

# Create temp directory
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "  Downloading ${PKG_NAME}@${VERSION}..."
curl -fsSL "$TARBALL_URL" | tar -xz -C "$TMP_DIR"

# The tarball extracts to a `package/` directory
BINARY_PATH="${TMP_DIR}/package/releases"

if [[ ! -f "$BINARY_PATH" ]]; then
  echo "Error: Binary not found in package" >&2
  exit 1
fi

chmod +x "$BINARY_PATH"

# Install — use sudo if needed
if [[ -w "$INSTALL_DIR" ]]; then
  mv "$BINARY_PATH" "${INSTALL_DIR}/${BINARY_NAME}"
else
  echo "  Requires sudo to install to ${INSTALL_DIR}"
  sudo mv "$BINARY_PATH" "${INSTALL_DIR}/${BINARY_NAME}"
fi

echo ""
echo "Installed releases ${VERSION} to ${INSTALL_DIR}/${BINARY_NAME}"
echo "Run 'releases --help' to get started."
