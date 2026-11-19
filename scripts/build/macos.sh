#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Native Mac checks require macOS.' >&2; exit 1; }
mode="${1:-app}"
case "$mode" in app|package) ;; *) echo 'Usage: macos.sh [app|package]' >&2; exit 1 ;; esac

swift build --package-path platforms/macos -c release --product AgentBridgeMac
swift run --package-path platforms/macos BridgeCoreChecks packages/protocol/fixtures/native-v1.json
binary_dir="$(swift build --package-path platforms/macos -c release --show-bin-path)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-app.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
app="$scratch/AgentBridgeLens.app"
resources="$app/Contents/Resources"
helpers="$app/Contents/Helpers"
mkdir -p "$app/Contents/MacOS" "$resources" "$helpers" artifacts
install -m 755 "$binary_dir/AgentBridgeMac" "$app/Contents/MacOS/AgentBridgeMac"
cp platforms/macos/Info.plist "$app/Contents/Info.plist"
native_version="$(node -p 'JSON.parse(require("fs").readFileSync("platforms/macos/version.json","utf8")).version')"
test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$native_version"
/usr/libexec/PlistBuddy -c "Add :AgentBridgeMacCommit string $(git rev-parse HEAD)" "$app/Contents/Info.plist"

# Reuse the extension's lens mark at all required Finder and Dock sizes.
iconset="$scratch/AgentBridgeLens.iconset"
mkdir -p "$iconset"
node packages/extension/scripts/gen-icons.mjs "$scratch"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$scratch/icon1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "$retina" "$retina" "$scratch/icon1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$resources/AgentBridgeLens.icns"
install -m 644 "$scratch/MenuLens.png" "$resources/MenuLens.png"

bash scripts/build/stage-bridge.sh "$resources/bridge"
bash scripts/build/macos-node.sh "$helpers" "$resources" "$scratch"
identity="${MAC_SIGN_IDENTITY:--}"
profile="${MAC_NOTARY_PROFILE:-}"
if [[ -n "$profile" && "$identity" == "-" ]]; then
  echo 'Notarization requires a Developer ID signing identity.' >&2
  exit 1
fi
if [[ "$identity" == "-" ]]; then
  codesign --force --sign - "$helpers/node"
  codesign --force --sign - "$app"
else
  codesign --force --sign "$identity" --timestamp --options runtime \
    --entitlements platforms/macos/NodeEntitlements.plist "$helpers/node"
  codesign --force --sign "$identity" --timestamp --options runtime "$app"
fi
codesign --verify --deep --strict "$app"

if [[ "$mode" == package ]]; then
  disk="$PWD/artifacts/agentbridgelens-macos-${native_version}-$(uname -m).dmg"
  staging="$scratch/disk"
  mkdir "$staging"
  ditto "$app" "$staging/AgentBridgeLens.app"
  ln -s /Applications "$staging/Applications"
  hdiutil create -ov -format UDZO -volname AgentBridgeLens -srcfolder "$staging" "$disk"
  if [[ "$identity" != "-" ]]; then codesign --force --sign "$identity" --timestamp "$disk"; fi
  if [[ -n "$profile" ]]; then
    xcrun notarytool submit "$disk" --keychain-profile "$profile" --wait
    xcrun stapler staple "$disk"
    xcrun stapler validate "$disk"
  fi
  hdiutil verify "$disk"
fi

rm -rf "$PWD/artifacts/AgentBridgeLens.app"
ditto "$app" "$PWD/artifacts/AgentBridgeLens.app"
