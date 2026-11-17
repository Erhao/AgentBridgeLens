# macOS 桌面执行端

Mac 菜单栏应用位于 `platforms/macos`，通过现有 AgentBridgeLens MCP Bridge 暴露 `desktop_*` 工具。macOS 14.2+，本机运行 Node.js Bridge；Swift 构建只在 macOS 进行。

## 连接

```bash
pnpm install --frozen-lockfile
pnpm --dir packages/bridge build
node packages/bridge/dist/index.js --init-mac
```

在 MCP 配置中设置 `BRIDGELENS_DESKTOP=1`。打开已安装的 `AgentBridgeMac.app`，授予辅助功能，截图时再授予屏幕录制权限。Mac 只连接本机 `ws://127.0.0.1:19224/native`，使用 owner-only 配对文件和 Authorization 请求头；浏览器 Origin 被拒绝。

`BRIDGELENS_MAC_PORT` / `BRIDGELENS_MAC_TOKEN_FILE` 支持自定义配置；兼容 `AGENTBRIDGEMAC_PORT` / `AGENTBRIDGEMAC_TOKEN_FILE`。Mac 菜单栏中须使用对应端口和配对文件。默认文件仍为 `~/.agentbridgemac/token`。

## 使用

1. 查询 `desktop_get_capabilities`，取得当前连接的 sessionId。
2. 列出窗口，通过 windowId 观察控件。默认不返回文本值。
3. 请求截图前调用 `desktop_start_session`，指定 windowId。需要输入时设置 `input:true` 并先在菜单栏开启控制；调用不会自动打开本地开关或授予系统权限。
4. 输入会话开始时尝试聚焦目标窗口。之后每次操作仍要求前台窗口匹配。
5. `desktop_act` 使用控件 snapshotId/target，或截图 screenshotId/像素坐标。PRIMARY 是 Command，具名按键不是任意文字注入。
6. 每次输入后重新观察。停止、重连、授权代际改变或引用过期后，不复用旧引用。

当前支持 AXPress、可写文本值、窗口聚焦、左键、垂直滚动及有限按键。移动指针、非左键、横向滚动、任意节点聚焦和部分按键未实现。capabilities 和错误明确反映这些差异。Mac 0.2.0 支持按截图位置滚动；0.1.x 原生端不支持该操作。

兼容的 `mac_*` 工具继续存在，使用同一个原生连接；不再启动第二个独立 Mac MCP 服务。AX 保护字段不返回内容，截图不自动打码。AX 覆盖取决于目标应用，坐标和有效期检查不构成原子界面事务。

## 验证

CI 运行 `bash scripts/build/macos.sh`，编译 release 程序并运行 Swift 核心检查；随后 `node scripts/test/macos-transport.mjs` 启动真实 Swift 二进制的禁止输入测试模式，验证浏览器、统一桌面和旧 Mac 工具共存。

这项通信测试不证明真实桌面操作通过。授权、应用覆盖、多屏、焦点、遮挡、撤销和停止需要在用户已解锁的 Mac 桌面上验收。应用身份保留；默认 ad-hoc 签名尚未公证。
