# AgentBridgeLens 架构文档

## 1. 整体架构

AgentBridgeLens 让 AI coding agent（如 Claude Code）能够「看见」并操作用户真实浏览器里的页面。整体由三个组件串联：

```
┌──────────────────┐   stdio / MCP   ┌──────────────────┐   WebSocket    ┌──────────────────────────────┐
│   AI Agent       │ ◄─────────────► │  Bridge Server   │ ◄────────────► │      Chrome Extension        │
│  (Claude Code)   │   (JSON-RPC)    │   (Node.js)      │  127.0.0.1     │       (Manifest V3)          │
│                  │                 │                  │   :19222       │  ┌────────────────────────┐  │
│  调用 MCP 工具    │                 │  MCP Server      │                │  │ Service Worker         │  │
│  接收结构化结果   │                 │  + WS Relay      │                │  │ (WS 客户端 + 消息路由)  │  │
└──────────────────┘                 └──────────────────┘                │  └───────────┬────────────┘  │
                                                                          │              │ chrome.tabs  │
                                                                          │              ▼ .sendMessage │
                                                                          │  ┌────────────────────────┐  │
                                                                          │  │ Content Script         │  │
                                                                          │  │ (DOM 操作 / 视觉增强)   │  │
                                                                          │  └────────────────────────┘  │
                                                                          └──────────────────────────────┘
```

### 组件职责

| 组件 | 运行位置 | 职责 |
|------|---------|------|
| **AI Agent** | 用户本地（Claude Code 进程） | 调用 MCP 工具，接收结构化结果 |
| **Bridge Server** | 由 Claude Code 作为子进程拉起 | 把 MCP 工具调用翻译成 WebSocket 消息，做双向中继 |
| **Chrome Extension** | 用户真实的 Chrome 浏览器 | 在页面上执行实际操作：读 DOM、截图、执行 JS、视觉高亮、采集日志 |

Bridge Server 本身**不含任何浏览器能力**，它只是一个薄中继（relay）。所有真实能力都在 Chrome 扩展里。

---

## 2. 组件之间怎么通信

### 2.1 Agent ↔ Bridge Server：stdio + MCP（JSON-RPC）

Claude Code 按 MCP 配置把 Bridge Server 当作**子进程**启动，通过该进程的 stdin/stdout 收发 JSON-RPC 消息。

- Agent 调用工具（如 `capture_screenshot`）→ 通过 stdin 写入 MCP 请求
- Bridge Server 处理后 → 通过 stdout 写回结果
- 入口：`packages/bridge/src/index.ts`，使用 `StdioServerTransport`

> 注意：Bridge Server 的日志走 **stderr**（`console.error`），因为 stdout 被 MCP 协议占用，不能混入普通日志。

### 2.2 Bridge Server ↔ Extension：WebSocket

Bridge Server 默认在 `127.0.0.1:19222` 起一个 **WebSocket Server**（`packages/bridge/src/ws-relay.ts`），端口可通过环境变量 `BRIDGELENS_PORT` 覆盖。Chrome 扩展的 Service Worker 是 **WebSocket 客户端**，主动连接上来，断线后每 3 秒自动重连。扩展侧的 host/port 由用户在扩展弹窗（popup）里配置，存在 `chrome.storage.local`，改动后自动重连——两端默认值统一为 `127.0.0.1:19222`。

消息格式（`packages/bridge/src/protocol.ts`）：

```ts
// Bridge → Extension：工具调用请求
interface BridgeRequest  { id: string; tool: string; params: Record<string, unknown>; }
// Extension → Bridge：结果或错误
interface BridgeResponse { id: string; result?: unknown; error?: { message: string }; }
```

每个请求带唯一 `id`，Bridge 用它把异步返回的响应匹配回对应的调用，单次调用 **30 秒超时**。

### 2.3 Extension 内部：Service Worker ↔ Content Script

Service Worker（`background/service-worker.ts`）收到 `BridgeRequest` 后分两种情况：

1. **`capture_screenshot`**：Service Worker 直接用 `chrome.tabs.captureVisibleTab` 处理（截图需要扩展级 API）。
2. **其他所有工具**：转发给当前激活标签页的 Content Script，通过 `chrome.tabs.sendMessage` 下发 `ContentRequest`，监听 `chrome.runtime.onMessage` 收回 `ContentResponse`，15 秒超时。

Content Script（`content/index.ts`）按 `tool` 名分发到具体处理函数（DOM 检查、执行 JS、高亮、读日志等），执行后把结果通过 `chrome.runtime.sendMessage` 发回 Service Worker。

### 2.4 完整调用链（以 `get_page_info` 为例）

```
Claude Code
  │ ① stdin 写入 MCP 请求 get_page_info
  ▼
Bridge Server (mcp-server.ts)
  │ ② relay.send("get_page_info", {})  → WebSocket 发出 BridgeRequest{id}
  ▼
Service Worker (service-worker.ts)
  │ ③ 非截图工具 → chrome.tabs.sendMessage 给激活标签页
  ▼
Content Script (content/index.ts → dom-inspector.ts)
  │ ④ 执行 getPageInfo()，读取 location / document / viewport
  │ ⑤ chrome.runtime.sendMessage 回传 ContentResponse{id, result}
  ▼
Service Worker
  │ ⑥ WebSocket 回传 BridgeResponse{id, result}
  ▼
Bridge Server
  │ ⑦ 按 id 匹配 pending，stdout 写回 MCP 结果
  ▼
Claude Code  ← 拿到页面信息
```

---

## 3. 可用的 MCP 工具

由 `packages/bridge/src/mcp-server.ts` 定义，共 9 个：

| 工具 | 功能 | 处理位置 |
|------|------|---------|
| `get_page_info` | 获取页面 URL、标题、meta 信息 | Content Script |
| `capture_screenshot` | 截取页面或指定元素截图 | Service Worker |
| `execute_js` | 在页面上下文执行 JS 并返回结果 | Content Script |
| `get_dom_snapshot` | 获取精简 DOM 树（可指定子树/深度） | Content Script |
| `inspect_element` | 检查元素属性、计算样式、盒模型 | Content Script |
| `highlight_element` | 用彩色边框 + 标签高亮元素 | Content Script |
| `clear_highlights` | 清除所有高亮叠加层 | Content Script |
| `get_console_logs` | 获取捕获的控制台日志（可按级别过滤） | Content Script |
| `get_network_requests` | 获取捕获的网络请求记录（可按 URL/状态过滤） | Content Script |

---

## 4. 用户需要配置什么

### 步骤 1：构建项目

```bash
cd ~/space/AgentBridgeLens
pnpm install
pnpm build
```

构建产物：
- Bridge Server → `packages/bridge/dist/index.js`
- Chrome 扩展 → `packages/extension/dist/`

> `dist/` 是构建产物，已被 `.gitignore` 忽略，clone 后必须先 `pnpm install && pnpm build`。

### 步骤 2：加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 右上角开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择 `packages/extension/dist/` 目录

### 步骤 3：配置 Claude Code 的 MCP Server

在 Claude Code 的 MCP 配置中添加（注意用**绝对路径**）：

```json
{
  "mcpServers": {
    "bridgelens": {
      "command": "node",
      "args": ["/home/xinyu/space/AgentBridgeLens/packages/bridge/dist/index.js"]
    }
  }
}
```

配置后 Claude Code 会**自动**把 Bridge Server 作为子进程拉起——用户**不需要**手动运行 `node index.js`。Bridge 一启动就在 `127.0.0.1:19222` 开 WebSocket，扩展会自动连上。

**改端口**（两端都要改，保持一致）：

1. Bridge 侧：在 MCP 配置里加 `env` 字段
   ```json
   {
     "mcpServers": {
       "bridgelens": {
         "command": "node",
         "args": ["/home/xinyu/space/AgentBridgeLens/packages/bridge/dist/index.js"],
         "env": { "BRIDGELENS_PORT": "29222" }
       }
     }
   }
   ```
2. 扩展侧：点击扩展图标打开弹窗，把 Port 改成 `29222`，点「保存并重连」。

### 步骤 4：使用

打开任意网页，在 Claude Code 中即可调用，例如：

```
用 bridgelens 截取当前页面的截图
用 bridgelens 检查 .header 这个元素的样式
```

### 连接状态自检

- Bridge 启动后 stderr 会打印 `WebSocket server listening on 127.0.0.1:19222`
- 扩展连上后 Bridge 打印 `Extension connected`
- 扩展侧：在 `chrome://extensions/` 点扩展的 **Service Worker** 链接，控制台应有 `Connected to bridge server`
- 若调用工具报 `Chrome extension not connected`，说明扩展未连上：检查扩展是否加载、是否被禁用、端口是否一致

---

## 5. 关键约束与已知限制

- **激活标签页**：除截图外的工具都作用于「当前激活标签页」，调用前要确保目标页面处于前台。
- **WS 仅监听 localhost**：Bridge 只在 `127.0.0.1` 监听，不暴露到网络，扩展和 Bridge 必须在同一台机器。
- **改端口需两端一致**：Bridge 用 `BRIDGELENS_PORT`，扩展用弹窗配置，二者必须填同一个端口。
- **无认证**：当前 WebSocket 连接未做 token 认证（设计方案里规划了，尚未实现）。
- **单扩展连接**：Bridge 的 `WsRelay` 只保留最后一个连接的 client。
