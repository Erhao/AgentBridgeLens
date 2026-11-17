# 单仓库迁移与兼容性

## 来源

Mac 原生代码迁自 `xinyu/AgentBridgeMac` 的提交 `2d1ed26ffe2de184a9cb1fd3f4cb608b5db7a184`（0.1.2）。原生应用迁入 `platforms/macos`，原来的 Node MCP 服务器没有作为第二个服务带入。Linux 和 Windows 的在研实现先记录为独立提交，再移动原生源码，以保留已有功能和可追溯的变更。

## 路径映射

| 原路径 | 新路径 |
| --- | --- |
| Mac 仓库 `native/` | `platforms/macos/` |
| `packages/windows-agent/` | `platforms/windows/` |
| `packages/bridge/linux-agent/` 源码 | `platforms/linux/agent/` |
| `packages/bridge/test/linux/` | `platforms/linux/tests/` |
| Bridge 浏览器 WebSocket / source map 实现 | `packages/browser-adapter/` |
| Bridge DesktopProcess 与 Mac NativeChannel | `packages/runtime/` |
| 三端桌面驱动、具名按键和工具注册 | `packages/desktop/` |
| Bridge / Extension 各自的浏览器协议定义 | `packages/protocol/src/browser.ts` |

旧 Bridge 源模块保留轻量 re-export，实际实现只维护一份。`packages/bridge/src/mcp` 保存浏览器工具注册，桌面工具参数和注册集中在公共包。

## 用户配置

- 保留 npm 包名 `agentbridgelens`、浏览器 Host/Port/Token、stdio/HTTP、目标标签页参数和全部浏览器工具名。
- 默认不启用桌面。Linux/Windows 的 `BRIDGELENS_DESKTOP=1`、执行端环境变量与 `desktop_*` 参数继续兼容。
- Mac 使用同一个 Bridge，运行 `--init-mac` 并设置 `BRIDGELENS_DESKTOP=1`。原有 19224 端口、`~/.agentbridgemac/token` 和 `AGENTBRIDGEMAC_*` 别名仍可使用。
- Mac 原生 Bundle Identifier `tech.xinyu.agentbridgemac` 与 `AgentBridgeMac.app` 名称保留。源码目录改变不要求用户重新配置应用身份；开发签名二进制更新仍可能被系统要求重新授权。
- 原独立 Mac MCP 工具由兼容注册函数转发到同一连接，旧 `mac_*` 客户端可继续使用。不要同时启动占用同一端口的旧 Bridge。

## 发布包与源码目录

Linux 源码在构建时复制到包内兼容路径 `linux-agent/*.py`，该目录是忽略的产物；Windows CI 仍将二进制放到 `windows-agent/win-*/`。调整源码结构不改变已发布包的执行端搜索规则。

Bridge 0.6.0 引入统一桌面入口；Mac 0.2.0 增加显式文本读取选项、权限代际信息和截图坐标滚动。已安装 Mac 0.1.2 仍可连接，其不支持的定位滚动明确返回升级提示。

## 后续扩展

事件订阅、更多原生动作、虚拟化列表、应用业务适配器、多设备路由按实际需求增量实现。当前公共包没有宣称系统功能完全一致，也未加入自动下载并执行原生二进制的路径。已有稳定制品和旧版本记录继续保留。
