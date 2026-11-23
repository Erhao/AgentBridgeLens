#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/release/desktop-version.mjs --check
dotnet run --project platforms/windows/tests/Core/Core.csproj
dotnet build platforms/windows/tests/Integration/Integration.csproj
for arch in x64 arm64; do
  dotnet publish platforms/windows/AgentBridgeLens.Windows.csproj \
    --configuration Release --runtime "win-$arch" --self-contained true \
    -p:RestoreLockedMode=true --output "packages/bridge/windows-agent/win-$arch"
done
node --input-type=module -e 'import {validateWindowsExecutors} from "./scripts/release/bridge.mjs"; await validateWindowsExecutors("packages/bridge");'
node scripts/build/native-archives.mjs
