#!/usr/bin/env bash
set -euo pipefail
destination="$1"
cd "$(dirname "$0")/../.."
pnpm --filter agentbridgelens deploy --prod --legacy "$destination"
node scripts/build/prepare-bundle.mjs "$destination"
node "$destination/dist/index.js" --version
