#!/usr/bin/env bash
set -euo pipefail
helpers="$1"
resources="$2"
scratch="$3"
version="24.22.3"
case "$(uname -m)" in
  arm64)
    architecture=arm64
    checksum=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd
    ;;
  x86_64)
    architecture=x64
    checksum=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7
    ;;
  *) echo 'Unsupported macOS architecture.' >&2; exit 1 ;;
esac

distribution="node-v${version}-darwin-${architecture}"
archive="$scratch/$distribution.tar.gz"
curl -fLsS --retry 2 --max-time 180 \
  "https://www.nodejs.org/dist/v${version}/${distribution}.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
tar -xzf "$archive" -C "$scratch" "$distribution/bin/node" "$distribution/LICENSE"
install -m 755 "$scratch/$distribution/bin/node" "$helpers/node"
install -m 644 "$scratch/$distribution/LICENSE" "$resources/Node-LICENSE.txt"
test "$("$helpers/node" --version)" = "v$version"
