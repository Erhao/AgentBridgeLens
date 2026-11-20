#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${GH_TOKEN:?GitHub release publishing token required}"
repo="Erhao/AgentBridgeLens"
tag="macos-update-feed"
dir="$PWD/artifacts/update"
archives=("$dir"/*.zip)
[[ ${#archives[@]} -eq 1 && -f "${archives[0]}" && -f "$dir/appcast.xml" ]]
archive="${archives[0]}"

# Create the dedicated public feed once. It must not become the extension's
# latest release. Archive names are immutable; the appcast is replaced last.
if ! assets="$(gh release view "$tag" --repo "$repo" --json assets,isDraft,isPrerelease)"; then
  gh release create "$tag" --repo "$repo" --target "${GITHUB_SHA:?Expected a GitHub Actions commit}" \
    --prerelease --latest=false --title "AgentBridgeLens Mac · 更新通道" \
    --notes "Mac 个人版应用内更新文件。首次安装包请使用 Gitea 制品库。"
  assets="$(gh release view "$tag" --repo "$repo" --json assets,isDraft,isPrerelease)"
fi
node --input-type=module - "$assets" <<'JS'
const release = JSON.parse(process.argv[2]);
if (release.isDraft || !release.isPrerelease) throw new Error("The feed release must be a published prerelease.");
JS
has_asset() {
  node -e 'process.exit(JSON.parse(process.argv[1]).assets.some(a => a.name === process.argv[2]) ? 0 : 1)' "$assets" "$1"
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/agentbridgelens-previous-feed.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
archive_name="$(basename "$archive")"
archive_published=false
if has_asset "$archive_name"; then
  gh release download "$tag" --repo "$repo" --pattern "$archive_name" --dir "$scratch"
  if ! cmp -s "$archive" "$scratch/$archive_name"; then
    echo 'This version already has a different archive. Use the originally built archive or release a new version.' >&2
    exit 1
  fi
  archive_published=true
fi

if has_asset appcast.xml; then
  gh release download "$tag" --repo "$repo" --pattern appcast.xml --dir "$scratch"
  if cmp -s "$scratch/appcast.xml" "$dir/appcast.xml"; then
    [[ "$archive_published" == true ]] || { echo 'The current feed is missing its update archive.' >&2; exit 1; }
    exit 0
  fi
  python3 - "$scratch/appcast.xml" "$dir/appcast.xml" <<'PY2'
import sys
import xml.etree.ElementTree as ET
ns = {"s": "http://www.andymatuschak.org/xml-namespaces/sparkle"}
def latest(path):
    builds = ET.parse(path).findall("./channel/item/s:version", ns)
    return max(int(build.text) for build in builds)
if latest(sys.argv[2]) <= latest(sys.argv[1]):
    raise SystemExit("The update feed requires an increasing CFBundleVersion.")
PY2
fi

if [[ "$archive_published" == false ]]; then
  gh release upload "$tag" "$archive" --repo "$repo"
  curl -fsSL --retry 3 --max-time 180 \
    "https://github.com/$repo/releases/download/$tag/$archive_name" -o "$scratch/$archive_name"
  cmp "$archive" "$scratch/$archive_name"
fi
gh release upload "$tag" "$dir/appcast.xml" --clobber --repo "$repo"
mkdir "$scratch/verify"
gh release download "$tag" --repo "$repo" --pattern appcast.xml --dir "$scratch/verify"
cmp "$dir/appcast.xml" "$scratch/verify/appcast.xml"
