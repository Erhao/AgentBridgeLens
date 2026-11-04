#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 20+ from https://nodejs.org and try again.'
  printf 'Press Enter to close…'; read -r abl_reply
  exit 1
fi
node "$(dirname "$0")/update-extension.mjs" "$@"
abl_exit=$?
if [ "$#" -eq 0 ]; then printf 'Press Enter to close…'; read -r abl_reply; fi
exit "$abl_exit"
