## Bridge 0.3.0

- `execute_js` accepts an optional `activity` explanation (up to 80 characters).
- Tool guidance asks scripts to compute an `activitySummary` from actual results for readable on-page outcomes (requires extension 1.8.1+).
- Existing code-only calls and existing host/port/token settings remain compatible.
- `agentbridgelens --version` and MCP initialization report the installed package version.
- Includes stdio and authenticated Streamable HTTP transports, verified from the installed release tarball.

### Install / upgrade without building source

GitHub release package (available independently of npm publication):

```bash
npm install -g https://github.com/Erhao/AgentBridgeLens/releases/download/bridge-v0.3.0/agentbridgelens-0.3.0.tgz
agentbridgelens --version
```

Keep the original environment settings and restart the Bridge with your existing service manager. Reconnect the MCP client to refresh its tool list. If the service launches `node /path/to/old/dist/index.js` or `npx agentbridgelens`, change that command to the installed `agentbridgelens` executable; otherwise it continues running its previous source/package. No Chrome Bridge profile needs to be re-entered.

After npm publication is confirmed, npm users can select `agentbridgelens@0.3.0`. A GitHub release alone does not update the npm registry.
