# Bridge release

Bridge tags (`bridge-vX.Y.Z`) are independent of extension tags (`extension-vX.Y.Z`). Source package versions and MCP initialization always match, and `agentbridgelens --version` prints the installed version without starting a server.

Release artifacts are built and tested by Gitea Actions, stored in Gitea Generic Registry, then uploaded directly to GitHub Releases. GitHub does not build, test or repack the artifacts; its publication-only workflow uses npm OIDC. Do not build local installation packages unless explicitly requested.

## Release process

1. Update `packages/bridge/package.json` and `packages/bridge/CHANGELOG.md`, then run `node scripts/release/desktop-version.mjs --write`. Commit the synchronized native metadata; the extension keeps its independent version.
2. Push the same main commit to GitHub and Gitea, then push `bridge-vX.Y.Z` to both repositories.
3. `.gitea/workflows/bridge-release.yml` checks versions, cross-compiles Windows x64/ARM64 executors, validates their PE architectures, typechecks and tests Bridge, then creates the npm tarball and checksum. The exact tarball is installed and tested outside the workspace. Windows GUI acceptance is not performed by cross-compilation.
4. Gitea publishes the tested package and updater to the Generic package `agentbridgelens-npm`, verifies downloads, then uploads the identical files directly to GitHub with `make_latest=false`. GitHub latest continues to identify the extension release.
5. After all identical assets are public on GitHub, Gitea sends `gitea-bridge-published` with the exact tag and commit. `.github/workflows/bridge-release.yml` downloads those assets, verifies the build manifest, tag commit, package metadata and checksums, then publishes the same tarball to npm through OIDC. There is no GitHub rebuild and no NPM_TOKEN requirement. The separate GitHub job and official registry must both be checked before claiming npm publication. Retries skip publication only if the existing npm version has identical SHA512 integrity.

## npm trusted publishing

Keep the npm Trusted Publisher configured for owner `Erhao`, repository `AgentBridgeLens`, workflow filename `bridge-release.yml`, with no environment. This preserves the identity used by the successful 0.5.0 publisher. The GitHub-hosted publication job has `id-token: write`, Node 24 and npm 11. An expired local npm token does not affect OIDC publishing.

For recovery of a previously delivered Gitea package, manually dispatch the GitHub workflow on main with its exact `bridge-vX.Y.Z` tag. This downloads and publishes the existing release; it does not move the tag or build another package. During the 0.6.0 migration the tag predates this workflow restoration, so its Gitea job uses the old delivery script; dispatch npm publication after its assets are verified.

GitHub delivery uses Gitea Secret `GH_RELEASE_TOKEN` with Contents write access; registry publication uses `PACKAGES_TOKEN`. Never store token values in source or print them in logs.

## Installation before npm publication

Use the GitHub release tarball with `npm install -g <official-tgz-URL>`. It includes compiled JavaScript and requires no local source build. Keep your service's original host/port/token settings; point the service/MCP command at the installed executable and restart it, then reconnect the MCP client. Installing a package does not change running processes or existing launch paths.

After registry publication is confirmed, `npm install -g agentbridgelens@X.Y.Z` and MCP launch arguments `npx -y agentbridgelens@X.Y.Z` may use that exact version. Pinning a version makes upgrades explicit and avoids relying on an existing npx cache.
