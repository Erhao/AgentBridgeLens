# Bridge release

Bridge tags (`bridge-vX.Y.Z`) are independent of extension tags (`extension-vX.Y.Z`). Source package versions and MCP initialization always match, and `agentbridgelens --version` prints the installed version without starting a server.

Release artifacts are built by GitHub Actions and delivered through GitHub Releases. Follow the project policy in [AGENTS.md](../AGENTS.md): do not build a local extension installation ZIP unless the user explicitly requests one.

## Release process

1. Update `packages/bridge/package.json` and `packages/bridge/CHANGELOG.md`.
2. Commit and push to `main`, then push `bridge-vX.Y.Z` pointing at that commit.
3. `bridge-release.yml` checks the tag/version, typechecks and tests the Bridge, builds an npm tarball and SHA256, installs that exact tarball outside the workspace, and runs stdio/HTTP/relay tests against the installed package.
4. The tested artifact is released on GitHub with `latest=false`, so extension updaters using `/releases/latest` continue to discover extension releases.
5. A separate job publishes the same artifact to npm using OIDC. A failed npm job does not remove the GitHub release or imply registry success. Check both jobs and `npm view agentbridgelens version` before announcing npm availability.

## One-time npm trusted publisher setup

A package maintainer must sign into npm and open:

https://www.npmjs.com/package/agentbridgelens/access

In Trusted Publisher, choose GitHub Actions and enter:

- Organization or user: `Erhao`
- Repository: `AgentBridgeLens`
- Workflow filename: `bridge-release.yml` (filename only)
- Environment: leave blank (the workflow does not use an environment)
- If the UI offers allowed actions, allow direct `npm publish`.

The workflow uses a GitHub-hosted runner, Node.js 24, and `id-token: write`. It does not require an npm token in repository secrets. See https://docs.npmjs.com/trusted-publishers/ . After setting up trust, rerun the failed npm job on the Bridge tag. Do not rerun a successful npm publication; npm versions are immutable.

## Installation before npm publication

Use the GitHub release tarball with `npm install -g <official-tgz-URL>`. It includes compiled JavaScript and requires no local source build. Keep your service's original host/port/token settings; point the service/MCP command at the installed executable and restart it, then reconnect the MCP client. Installing a package does not change running processes or existing launch paths.

After registry publication is confirmed, `npm install -g agentbridgelens@X.Y.Z` and MCP launch arguments `npx -y agentbridgelens@X.Y.Z` may use that exact version. Pinning a version makes upgrades explicit and avoids relying on an existing npx cache.
