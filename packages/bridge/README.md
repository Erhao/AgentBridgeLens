> Bridge 0.6.0 开发版：`BRIDGELENS_DESKTOP=1` 支持 macOS、Windows 和 Linux，浏览器工具保持兼容。Mac 初始化配对使用 `agentbridgelens --init-mac`，仍需本机应用授权。见 [Mac 配置](../../docs/platforms/MACOS.md)、[公共协议](../../docs/protocol/DESKTOP.md) 和 [迁移说明](../../docs/architecture/MIGRATION.md)。

# agentbridgelens

MCP server that bridges AI coding agents (Claude Code, etc.) to a **real Chrome browser** via the AgentBridgeLens extension: DOM inspection, screenshots (incl. background tabs), network/console capture, source-map tracing (UI → component source line), visual overlays, action record/replay, and multi-tab targeting.

It supports MCP stdio (default) or Streamable HTTP and relays tool calls to the browser extension over WebSocket.

Experimental Ubuntu desktop support is available in source with `BRIDGELENS_DESKTOP=1`. It adds AT-SPI observation/actions and Portal screen/input sessions through a bundled local Python executor, independently of the Chrome extension. Requires a logged-in graphical session and Ubuntu GI/GStreamer packages; see [setup, tools, limitations and validation](../../docs/LINUX-DESKTOP.md). This source feature has not been released yet.

Experimental Windows desktop support uses the same opt-in flag and desktop tools with a native C# executor (UIA3, Windows Graphics Capture, Win32 input). Local approval scopes capture and control to one window; named Windows keys do not replace Linux evdev codes. CI builds self-contained x64/ARM64 executors for Bridge releases. Source builds may set `BRIDGELENS_WINDOWS_AGENT` to the executable path. See [Windows setup, permissions and validation](../../docs/WINDOWS-DESKTOP.md); this feature is unreleased and real desktop acceptance is still pending.

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

## Connection diagnostics

The extension retries failed connections with exponential backoff (3, 6, 12, 24… seconds, capped at 600 seconds) and limits each connection attempt to 10 seconds. Each service has its own backoff; successful connections and manual retry reset it. Retry deadlines survive extension worker suspension, and keepalive wakeups do not bypass them. Its popup and side panel show attempt counts, retry timing and recent errors, with a per-service retry button.

`GET /health` on the **WebSocket port** returns `{ "service": "AgentBridgeLens", "status": "ok" }`. When `BRIDGELENS_TOKEN` is set, supply it as `Authorization: Bearer <token>`; missing or incorrect credentials return HTTP 401. Responses are not cached. This endpoint does not accept credentials in the URL and does not replace WebSocket authentication.

Update both the extension and Bridge to diagnose authentication failures. Older bridges return an unsupported-endpoint hint; the extension cannot infer a token mismatch from a generic browser WebSocket error alone.

## Streamable HTTP (remote MCP clients)

Start the bridge as a standalone process instead of an MCP subprocess:

```bash
BRIDGELENS_TRANSPORT=http node packages/bridge/dist/index.js
```

The MCP endpoint is `http://127.0.0.1:19223/mcp`; the extension still connects
over WebSocket on port **19222**, with no extension changes required.
The default stdio invocation remains unchanged.

For a LAN server (replace the sample secret with a long random value):

```bash
BRIDGELENS_TRANSPORT=http \
BRIDGELENS_HTTP_HOST=0.0.0.0 \
BRIDGELENS_HTTP_TOKEN='replace-with-a-long-random-secret' \
node packages/bridge/dist/index.js
```

Point the AI client's **Streamable HTTP** MCP connection at
`http://<bridge-machine-LAN-IP>:19223/mcp` and configure the header
`Authorization: Bearer replace-with-a-long-random-secret`.
Client configuration syntax varies; a common form is:

```json
{
  "mcpServers": {
    "bridgelens": {
      "type": "http",
      "url": "http://192.168.1.100:19223/mcp",
      "headers": { "Authorization": "Bearer replace-with-a-long-random-secret" }
    }
  }
}
```

If Chrome is also on another machine, additionally set `BRIDGELENS_HOST=0.0.0.0`
and `BRIDGELENS_TOKEN` for the **WebSocket** listener, and set the extension's
Host/Port/Token to that machine's address, `19222`, and the WebSocket token.
Allow the appropriate TCP ports through the bridge machine's firewall.
HTTP and WebSocket listener addresses and ports are configured separately.

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRIDGELENS_TRANSPORT` | `stdio` | `stdio` or `http` (Streamable HTTP) |
| `BRIDGELENS_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `BRIDGELENS_HTTP_PORT` | `19223` | HTTP port; endpoint path is `/mcp` |
| `BRIDGELENS_HTTP_TOKEN` | falls back to `BRIDGELENS_TOKEN` | Bearer token; required when HTTP binds beyond loopback |
| `BRIDGELENS_HTTP_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins, e.g. `https://client.example`; requests with no Origin are accepted |

HTTP uses the SDK's stateless Streamable HTTP transport with SSE responses to
POST requests. Each request has its own MCP server/transport; there are no
session IDs, resumable event streams, or standalone GET SSE streams (GET and
DELETE return 405). This is not the legacy HTTP+SSE transport. All MCP clients
share the same browser extension and target-tab state; this is not a multi-user
browser isolation service. Use explicit `tabId` when several clients operate
different tabs.

The built-in listeners are plain HTTP/WS. Use an SSH tunnel or a TLS reverse
proxy for encrypted connections. Browser-based MCP clients must have their
Origin explicitly allowlisted; CORS preflight is supported for these origins.

## Remote Mac app

Bridge 0.6.1 or later can relay requests to a Mac running AgentBridgeLens 0.4.0 or later, even when the Bridge runs on Linux. This is the server-side desktop executor for that Bridge process. The Chrome extension remains on its own listener.

On the server, start the Bridge as follows. Replace both examples with distinct random values (for example, create each with `openssl rand -hex 32`). Keep the existing browser `BRIDGELENS_TOKEN` distinct as well.

```bash
BRIDGELENS_TRANSPORT=http \
BRIDGELENS_HTTP_TOKEN='<MCP token>' \
BRIDGELENS_MAC_REMOTE_TOKEN='<Mac pairing token>' \
node packages/bridge/dist/index.js
```

Put the two loopback listeners behind a TLS reverse proxy. For example, this Caddy configuration preserves the path and forwards WebSocket upgrades. The browser listener can retain its own existing configuration.

```caddyfile
bridge.example.com {
    reverse_proxy /mcp 127.0.0.1:19223
    reverse_proxy /native 127.0.0.1:19224
}
```

The AI client uses `https://bridge.example.com/mcp` with the HTTP Bearer token. In the Mac app, choose **远程 Bridge** and enter `wss://bridge.example.com/native` with the Mac pairing token. `BRIDGELENS_MAC_PORT` changes the Mac listener port when 19224 is already taken. The listener is loopback-only. An SSH tunnel from the Mac to the Bridge can expose that listener at a numeric loopback address through `ws://`, if preferred.

One Mac can connect per Bridge. This mode exposes the scoped `desktop_*` tools; the legacy `mac_*` aliases are local-only. Connecting does not enable desktop input. The Mac user can enable it for the current connection and stop it from the menu bar. Disconnecting turns control off.

## Verification

```bash
pnpm --dir packages/bridge test
```

Builds the bridge, then tests real SDK HTTP clients against a spawned server and
a simulated WebSocket extension, including concurrent calls, image responses,
authentication, Origin/CORS validation, and stdio compatibility.

## License

MIT

## Concise activity explanations

The updated `execute_js` tool accepts an optional `activity` string of 1–80 characters. Use one short Chinese sentence describing the current action and purpose. Do not include credentials or private values, and do not claim a result before execution. Other tools do not require this field; the extension generates their descriptions and structural result summaries locally without an additional AI request.

```json
{
  "code": "(() => { const rowCount = document.querySelectorAll('tbody tr').length; return {rowCount, activitySummary: `找到 ${rowCount} 条表格记录`}; })()",
  "activity": "统计资源列表行数，检查筛选后是否为空",
  "tabId": 123
}
```

The extension labels this text as an AI explanation and separately displays actual result statistics. Existing calls containing only `code` remain valid. For script results, simple structural counters such as `rowCount`, `count`, `matchedCount`, `errorCount` or an array length can be summarized; arbitrary strings, object values and raw code are not shown automatically. Prefer returning an object with an `activitySummary` string computed from the actual result (up to 160 characters). This opt-in text appears directly as the card’s result; keep it free of credentials and private data. Common credential assignments are redacted, but this is not a complete privacy filter. Blank or invalid summaries fall back to up to six structured facts (counts, boolean flags, known states, byte capacities and percentages), including objects nested at most three levels deep. Bodies, arbitrary strings, credential fields and array items are not expanded. If no meaningful facts exist, the result line is omitted. Failed calls display their error outcome rather than a success summary. No extra model request is needed.

Use the prebuilt [Bridge 0.5.0 release](https://github.com/Erhao/AgentBridgeLens/releases/tag/bridge-v0.5.0):

```bash
npm install -g https://github.com/Erhao/AgentBridgeLens/releases/download/bridge-v0.5.0/agentbridgelens-0.5.0.tgz
agentbridgelens --version
```

Keep existing host/port/token settings and restart the Bridge. Update any launch configuration pointing at an old source path or `npx agentbridgelens` to the installed executable's absolute path (`command -v agentbridgelens`), then refresh the client's MCP connection. Installing globally does not rewrite launch configurations. Source deployment remains available with `pnpm --filter agentbridgelens build`. The extension updater only updates the extension. npm publication is tracked separately from GitHub release assets; do not assume a registry version exists until confirmed.
