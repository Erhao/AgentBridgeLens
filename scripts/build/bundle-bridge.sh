#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p artifacts
if [[ $# -gt 0 ]]; then
  bridge_parent="$1"
  test -f "$bridge_parent/bridge/dist/index.js"
else
  bridge_parent="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-bundle.XXXXXX")"
  trap 'rm -rf "$bridge_parent"' EXIT
  bash scripts/build/stage-bridge.sh "$bridge_parent/bridge"
fi
bridge_version="$(node -p 'JSON.parse(require("fs").readFileSync("packages/bridge/package.json","utf8")).version')"
tar -czf "artifacts/agentbridgelens-bridge-${bridge_version}.tgz" -C "$bridge_parent" bridge
