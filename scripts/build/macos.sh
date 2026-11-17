#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Native Mac checks require macOS.' >&2; exit 1; }
swift build --package-path platforms/macos -c release --product AgentBridgeMac
swift run --package-path platforms/macos BridgeCoreChecks packages/protocol/fixtures/native-v1.json
binary_dir="$(swift build --package-path platforms/macos -c release --show-bin-path)"
app_dir="$PWD/artifacts/AgentBridgeMac.app"
mkdir -p "$app_dir/Contents/MacOS"
cp "$binary_dir/AgentBridgeMac" "$app_dir/Contents/MacOS/AgentBridgeMac"
cp platforms/macos/Info.plist "$app_dir/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :AgentBridgeMacCommit string $(git rev-parse HEAD)" "$app_dir/Contents/Info.plist"
codesign --force --sign "${MAC_SIGN_IDENTITY:--}" "$app_dir"
codesign --verify --deep --strict "$app_dir"
if [[ "${1:-check}" == package ]]; then
  native_version="$(node -p 'JSON.parse(require("fs").readFileSync("platforms/macos/version.json","utf8")).version')"
  ditto -c -k --sequesterRsrc --keepParent "$app_dir" "artifacts/agentbridgelens-macos-${native_version}-$(uname -m).zip"
fi
