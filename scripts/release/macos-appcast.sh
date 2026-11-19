#!/usr/bin/env bash
# Build the signed archive and appcast from the same app as the first-install DMG.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${MAC_NOTARY_PROFILE:?Notary keychain profile required}"
: "${SPARKLE_ED_PRIVATE_KEY:?Sparkle private key required}"
app="$PWD/artifacts/AgentBridgeLens.app"
plist="$app/Contents/Info.plist"
feed="$(plutil -extract SUFeedURL raw "$plist")"
public_key="$(plutil -extract SUPublicEDKey raw "$plist")"
version="$(plutil -extract CFBundleShortVersionString raw "$plist")"
build="$(plutil -extract CFBundleVersion raw "$plist")"
codesign --verify --deep --strict "$app"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-appcast.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
tools_archive="$scratch/Sparkle-2.10.1.tar.xz"
curl -fLsS --retry 2 --max-time 120 \
  "https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz" -o "$tools_archive"
printf '%s  %s\n' '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27' "$tools_archive" | shasum -a 256 -c -
tar -xf "$tools_archive" -C "$scratch" ./bin/generate_appcast ./bin/sign_update

update_dir="$PWD/artifacts/update"
mkdir "$update_dir"
archive="$update_dir/agentbridgelens-macos-${version}-$(uname -m).zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$scratch/for-notary.zip"
xcrun notarytool submit "$scratch/for-notary.zip" --keychain-profile "$MAC_NOTARY_PROFILE" --wait
xcrun stapler staple "$app"
xcrun stapler validate "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"

# The private key is sent only on standard input. The appcast tool signs the
# feed automatically when the archived app's SURequireSignedFeed is enabled.
printf '%s\n' "$SPARKLE_ED_PRIVATE_KEY" | "$scratch/bin/generate_appcast" \
  --ed-key-file - --download-url-prefix "${feed%/*}/" "$update_dir"
printf '%s\n' "$SPARKLE_ED_PRIVATE_KEY" | "$scratch/bin/sign_update" --ed-key-file - --verify "$update_dir/appcast.xml"

archive_signature="$(python3 - "$update_dir/appcast.xml" "$archive" "$feed" "$version" "$build" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

appcast, archive, feed, version, build = sys.argv[1:]
ns = {"s": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
items = ET.parse(appcast).findall("./channel/item")
assert len(items) == 1, "Expected one update in appcast"
item = items[0]
file = Path(archive)
enclosure = item.find("enclosure")
assert item.findtext("s:version", namespaces=ns) == build, "Wrong build number"
assert item.findtext("s:shortVersionString", namespaces=ns) == version, "Wrong version"
assert enclosure.get("url") == feed.rsplit("/",1)[0] + "/" + file.name, "Wrong update URL"
assert int(enclosure.get("length")) == file.stat().st_size, "Wrong update length"
print(enclosure.attrib["{" + ns["s"] + "}edSignature"])
PY
)"
node --input-type=module - "$archive" "$archive_signature" "$public_key" <<'JS'
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const [, , archive, signature, publicKey] = process.argv;
const header = Buffer.from("302a300506032b6570032100", "hex");
const key = createPublicKey({ key: Buffer.concat([header, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
if (!verify(null, readFileSync(archive), key, Buffer.from(signature, "base64"))) {
  throw new Error("Sparkle private key does not match the public key embedded in this app.");
}
console.log("Verified the appcast enclosure against the app's embedded Ed25519 key.");
JS
