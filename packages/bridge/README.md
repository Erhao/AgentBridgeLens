# agentbridgelens

MCP server that bridges AI coding agents (Claude Code, etc.) to a **real Chrome browser** via the AgentBridgeLens extension: DOM inspection, screenshots (incl. background tabs), network/console capture, source-map tracing (UI → component source line), visual overlays, action record/replay, and multi-tab targeting.

It runs over MCP stdio and relays tool calls to the browser extension over a local WebSocket.

## Install (recommended: once, globally)

No clone/build needed — run straight from npm via `npx`, registered at **user scope** so every project/session has it:

```bash
claude mcp add -s user bridgelens -- npx -y agentbridgelens
```

Or add it to your MCP config manually:

```json
{
  "mcpServers": {
    "bridgelens": { "command": "npx", "args": ["-y", "agentbridgelens"] }
  }
}
```

Then install the **AgentBridgeLens Chrome extension** and open any page. The extension auto-connects to the bridge on `127.0.0.1:19222`.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `BRIDGELENS_PORT` | `19222` | WebSocket port |
| `BRIDGELENS_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` for cross-machine (extension on another machine). |
| `BRIDGELENS_TOKEN` | _(none)_ | Shared secret required from the extension. **Strongly recommended whenever HOST ≠ 127.0.0.1.** |

Single machine needs no env vars. For cross-machine, prefer an SSH tunnel (`ssh -L 19222:127.0.0.1:19222 …`) and keep the bridge on loopback.

## License

MIT
