# AgentBridgeLens

A Chrome extension that bridges AI coding agents with real browser environments — visual debugging, DOM inspection, and interactive verification, all from the user's actual browser.

## Architecture

```
AI Agent ←─ MCP (stdio / Streamable HTTP) ─→ Bridge Server ←─WebSocket─→ Chrome Extension
```

- **Bridge Server**: Thin MCP relay (~200 lines) — translates MCP tool calls to WebSocket messages
- **Chrome Extension**: Manifest V3 — DOM inspection, screenshots, visual overlays, console/network capture

Extension 1.1.0 can connect to multiple bridge servers simultaneously. Add each
server's Host/Port/Token in the popup or side panel; connections reconnect
independently and replies return only to the requesting bridge. Existing single
server settings are preserved. All bridges share browser and target-tab state;
use explicit `tabId` for coordinated work. See [multi-bridge setup](docs/USAGE.md#同一个-chrome-同时连接多个桥接服务).

操作页面默认使用「操作当前页」，也可切换到「固定指定页」并选择一个标签页，避免切换浏览器标签时改变默认操作对象。完整标签页列表、多目标和新标签跟随策略收在默认折叠的「高级设置」中；已有多目标配置会保留。所有 Bridge 共用目标设置，AI 明确指定标签页时以指定页面为准。

弹窗和侧边栏提供「面板内显示实时状态」及「网页自动显示悬浮状态」两个独立开关（默认开启，自动记住选择）。
状态区显示正在执行的调用、实际目标页面及标签页 ID、Bridge 名称、数据类别
（例如 DOM、网络、控制台、性能）和适用的元素/筛选范围；完成后显示最近一次结果与耗时。
多项并行调用分别展示，重新打开面板也能获取当前状态。关闭显示不影响工具执行。
这里只展示操作元信息，不展示脚本正文、请求正文或返回数据；状态保存在后台内存中，
扩展后台重启后清空。

无需打开插件，普通 HTTP/HTTPS 网页右下角会自动显示悬浮状态条，包括 AI 在后台标签页执行的操作。
操作完成或失败后保留 4 秒自动收起；点击「关闭悬浮提示」会关闭所有网页的自动提示，可在插件中重新开启。
截图期间自动隐藏悬浮条，避免遮挡截图内容。Chrome 内部页、扩展商店等受限页面无法展示；
更新扩展后，已打开的网页需要刷新一次。需要持续查看最近动作时可保持侧边栏打开。

可选的真实浏览器验证（先构建扩展，Playwright 可单独安装）：

```bash
ABL_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node packages/extension/test/activity-toast.browser.mjs
```

可用 `ABL_CHROMIUM_EXECUTABLE` 指定支持加载扩展的 Chromium 可执行文件；验证使用独立浏览器配置和本地测试服务。

> 详细架构、组件通信链路与配置说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
> 面向用户的上手与使用指南见 [docs/USAGE.md](docs/USAGE.md)。

## Quick Start

预编译扩展安装包可从 [GitHub Releases](https://github.com/Erhao/AgentBridgeLens/releases/latest) 下载。
`main` 的版本由 semantic-release 计算并通过 GitHub Actions 自动发布，见 [发布流程](docs/RELEASING.md)。

### 已安装用户：固定目录一键更新

从 [GitHub Releases](https://github.com/Erhao/AgentBridgeLens/releases/latest) 下载一次
`agentbridgelens-updater.zip` 并保留解压后的工具目录。需要 Node.js 20+ 和系统 curl，无需安装 npm 依赖。
Windows 双击 `update-extension.cmd`，macOS 运行 `update-extension.command`，Linux 运行 `sh update-extension.sh`。
首次填写 Chrome 扩展详情中显示的**原加载目录**；以后会记住目录，自动下载最新正式版、校验 SHA256、替换扩展文件并保留上一版。
完成后只需在 `chrome://extensions` 点原插件的「重新加载」，然后刷新需要操作的网页。
**不要删除原插件或换新目录重新导入**，这样升级时桥接配置和显示偏好会保留。
首次安装用户可在目录提示处直接回车，使用 `~/.agentbridgelens/extension`，之后在 Chrome 中加载一次该目录。

```bash
node update-extension.mjs --dir "原扩展目录"  # 第一次指定，之后可省略
node update-extension.mjs --check            # 仅检查版本
node update-extension.mjs --rollback         # 恢复上一版，仍使用原目录
```

需要代理时，工具会读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写变量），macOS 双击启动还会识别系统手动代理。
也可运行下面的命令指定代理，成功后会记住地址，之后直接双击即可。请将端口替换为代理软件的实际端口；仅启用 PAC 时请手动指定。

```bash
sh update-extension.command --proxy http://127.0.0.1:7897
# 或：node update-extension.mjs --proxy socks5h://127.0.0.1:1080
# 临时直连：node update-extension.mjs --no-proxy
```

完整说明见更新工具中的 `README.txt`。此方式保留本机 Chrome 配置，不承担重装或换电脑时的配置迁移。

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

### Remote MCP via Streamable HTTP

To let an AI client connect by URL, start a standalone bridge:

```bash
BRIDGELENS_TRANSPORT=http \
BRIDGELENS_HTTP_HOST=0.0.0.0 \
BRIDGELENS_HTTP_TOKEN='replace-with-a-long-random-secret' \
node packages/bridge/dist/index.js
```

Connect the MCP client to `http://<bridge-IP>:19223/mcp` with an
`Authorization: Bearer <your-secret>` header. The Chrome extension still uses
WebSocket port `19222`. To connect Chrome from another machine, also configure
`BRIDGELENS_HOST` / `BRIDGELENS_TOKEN` and the extension's matching Host/Port/Token.
See [transport configuration and limitations](packages/bridge/README.md#streamable-http-remote-mcp-clients).

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
| `get_errors` | Get only error-level console entries |
| `get_performance_metrics` | Navigation timing, FCP, LCP, CLS, JS heap |
| `get_accessibility_tree` | Simplified role/name accessibility tree |
| `trace_element_to_source` | Trace a DOM element to its component source file/line (React/Vue dev builds) |
| `trace_style_to_source` | Trace which CSS rules apply and which stylesheet they come from |
| `trace_error_to_source` | Resolve an error stack to original source via source maps |
| `start_cdp_network` / `stop_cdp_network` / `get_cdp_network` | Richer network capture via chrome.debugger (CDP) |
| `mark_elements` / `visualize_layout` / `show_responsive_frame` / `clear_overlays` | Visual overlays |
| `start_recording` / `stop_recording` / `replay_actions` | Record & replay user interactions |
| `show_hud` / `update_hud` / `hide_hud` | On-page status HUD |
| `request_user_confirmation` | Ask the user a question in the side panel and await their choice |

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
│       ├── error-tracer.ts  # Error stack → source map resolution
│       └── protocol.ts      # Message types
└── extension/           # Chrome Extension (Manifest V3)
    └── src/
        ├── manifest.json
        ├── background/
        │   ├── service-worker.ts   # WS connection + routing + side-panel plumbing
        │   ├── source-tracer.ts    # MAIN-world React/Vue source tracing
        │   └── cdp-network.ts      # chrome.debugger (CDP) network capture
        ├── content/
        │   ├── index.ts            # Tool handler dispatch
        │   ├── dom-inspector.ts    # DOM snapshot, inspect, JS exec, element rect
        │   ├── highlighter.ts      # Element highlights
        │   ├── overlays.ts         # Mark / layout / responsive overlays
        │   ├── recorder.ts         # Record & replay user actions
        │   ├── hud.ts              # On-page status HUD
        │   ├── selector.ts         # Stable CSS selector generation
        │   ├── console-capture.ts  # Console log interception
        │   ├── network-capture.ts  # Fetch/XHR interception
        │   ├── performance.ts      # Performance metrics (FCP/LCP/CLS)
        │   └── accessibility.ts    # Accessibility tree
        ├── popup/                  # Toolbar popup: bridge host/port config
        ├── sidepanel/              # Side panel: activity log + confirmations
        └── shared/
            ├── protocol.ts         # Message types
            └── config.ts           # Bridge connection config (storage)
```
