#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 20+ from https://nodejs.org and try again.'
  exit 1
fi
exec node "$(dirname "$0")/update-extension.mjs" "$@"
