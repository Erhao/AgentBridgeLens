#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
images=(artifacts/agentbridgelens-macos-*.dmg)
[[ ${#images[@]} == 1 && -f "${images[0]}" ]] || { echo 'Expected one macOS disk image.' >&2; exit 1; }
mount="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-dmg.XXXXXX")"
cleanup() {
  hdiutil detach "$mount" >/dev/null 2>&1 || true
  rmdir "$mount"
}
trap cleanup EXIT
hdiutil attach "${images[0]}" -readonly -nobrowse -mountpoint "$mount"
test "$(readlink "$mount/Applications")" = /Applications
codesign --verify --deep --strict "$mount/AgentBridgeLens.app"
node scripts/test/macos-transport.mjs "$mount/AgentBridgeLens.app/Contents/MacOS/AgentBridgeMac"
