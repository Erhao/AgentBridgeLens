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
install -m 644 platforms/macos/Sparkle-LICENSE.txt "$resources/Sparkle-LICENSE.txt"

bash scripts/build/stage-bridge.sh "$resources/bridge"
bash scripts/build/macos-node.sh "$helpers" "$resources" "$scratch"
identity="${MAC_SIGN_IDENTITY:--}"
profile="${MAC_NOTARY_PROFILE:-}"
feed="${MAC_UPDATE_FEED_URL:-}"
public_key="${SPARKLE_PUBLIC_ED_KEY:-}"

if [[ -n "$profile" && "$identity" == "-" ]]; then
  echo 'Notarization requires a Developer ID signing identity.' >&2
  exit 1
fi

if [[ -n "$feed" || -n "$public_key" ]]; then
  node --input-type=module - "$feed" "$public_key" <<'JS'
const [, , address, key] = process.argv;
const feed = new URL(address);
if (feed.protocol !== "https:" || feed.username || feed.password || feed.hash || feed.search || !feed.pathname.endsWith("/appcast.xml")) {
  throw new Error("The update feed must be a credential-free HTTPS appcast.xml URL.");
}
if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key) {
  throw new Error("Expected the base64 Sparkle Ed25519 public key.");
}
JS
  plutil -insert SUFeedURL -string "$feed" "$app/Contents/Info.plist"
  plutil -insert SUPublicEDKey -string "$public_key" "$app/Contents/Info.plist"
fi

sparkle_xcframework="$(find platforms/macos/.build/artifacts -type d -name Sparkle.xcframework -print -quit)"
sparkle="$app/Contents/Frameworks/Sparkle.framework"
mkdir -p "$app/Contents/Frameworks"
ditto "$sparkle_xcframework/macos-arm64_x86_64/Sparkle.framework" "$sparkle"
sparkle_version="$sparkle/Versions/B"
sign_options=(--force --sign "$identity")
if [[ "$identity" != "-" ]]; then sign_options+=(--timestamp --options runtime); fi

# Sign explicit nested components before sealing the framework and outer app.
for component in "$sparkle_version/XPCServices/Installer.xpc" "$sparkle_version/Autoupdate" "$sparkle_version/Updater.app"; do
  codesign "${sign_options[@]}" "$component"
done
codesign "${sign_options[@]}" --preserve-metadata=entitlements "$sparkle_version/XPCServices/Downloader.xpc"
codesign "${sign_options[@]}" "$sparkle"

if [[ "$identity" == "-" ]]; then
  codesign --force --sign - "$helpers/node"
else
  codesign "${sign_options[@]}" --entitlements platforms/macos/NodeEntitlements.plist "$helpers/node"
fi
codesign "${sign_options[@]}" "$app"
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
