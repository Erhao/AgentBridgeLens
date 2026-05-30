# AgentBridgeLens

A Chrome extension that bridges AI coding agents with real browser environments — visual debugging, DOM inspection, and interactive verification, all from the user's actual browser.

## Architecture

```
AI Agent (Claude Code) ←─stdio/MCP─→ Bridge Server ←─WebSocket─→ Chrome Extension
```

- **Bridge Server**: Thin MCP relay (~200 lines) — translates MCP tool calls to WebSocket messages
- **Chrome Extension**: Manifest V3 — DOM inspection, screenshots, visual overlays, console/network capture

> 详细架构、组件通信链路与配置说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
> 面向用户的上手与使用指南见 [docs/USAGE.md](docs/USAGE.md)。

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Build

```bash
pnpm build
```

### 3. Load the Chrome extension

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select `packages/extension/dist/`

### 4. Configure Claude Code

Add to your `.claude/settings.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridgelens": {
      "command": "node",
      "args": ["/path/to/AgentBridgeLens/packages/bridge/dist/index.js"]
    }
  }
}
```

### 5. Use

Open any webpage in Chrome, then in Claude Code:

```
Use bridgelens to capture a screenshot of the current page
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_page_info` | Get current page URL, title, viewport info |
| `capture_screenshot` | Screenshot the page or a specific element |
| `execute_js` | Run JavaScript in the page context |
| `get_dom_snapshot` | Get simplified DOM tree |
| `inspect_element` | Inspect element styles, box model, attributes |
| `highlight_element` | Highlight an element with colored overlay |
| `clear_highlights` | Remove all highlight overlays |
| `get_console_logs` | Get captured console logs |
| `get_network_requests` | Get captured network requests |

## Development

```bash
# Watch mode for bridge
pnpm dev:bridge

# Watch mode for extension (rebuild on change)
pnpm dev:extension
```

After rebuilding the extension, click the refresh icon on `chrome://extensions/` to reload.

## Project Structure

```
packages/
├── bridge/              # MCP Server (stdio ↔ WebSocket relay)
│   └── src/
│       ├── index.ts         # Entry point
│       ├── mcp-server.ts    # MCP tool definitions
│       ├── ws-relay.ts      # WebSocket server
│       └── protocol.ts      # Message types
└── extension/           # Chrome Extension (Manifest V3)
    └── src/
        ├── manifest.json
        ├── background/
        │   └── service-worker.ts   # WS connection + message routing
        ├── content/
        │   ├── index.ts            # Tool handler dispatch
        │   ├── dom-inspector.ts    # DOM snapshot, inspect, JS exec
        │   ├── highlighter.ts      # Visual overlay highlights
        │   ├── console-capture.ts  # Console log interception
        │   └── network-capture.ts  # Fetch/XHR interception
        └── shared/
            └── protocol.ts         # Message types
```
