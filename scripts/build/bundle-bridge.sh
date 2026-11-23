#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/release/desktop-version.mjs --check
mkdir -p artifacts
bundle_stage="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-bundle.XXXXXX")"
trap 'rm -rf "$bundle_stage"' EXIT
pnpm --filter agentbridgelens deploy --prod --legacy "$bundle_stage/bridge"
node scripts/build/prepare-bundle.mjs "$bundle_stage/bridge"
node "$bundle_stage/bridge/dist/index.js" --version
bridge_version="$(node -p 'JSON.parse(require("fs").readFileSync("packages/bridge/package.json","utf8")).version')"
tar -czf "artifacts/agentbridgelens-bridge-${bridge_version}.tgz" -C "$bundle_stage" bridge
