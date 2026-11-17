# 统一架构与模块边界

AgentBridgeLens 用一个 MCP 入口提供浏览器检查和本机桌面控制。共同的协议、连接生命周期和结果转换在 TypeScript 包中复用，系统接口与最终权限判断留在原生执行端。

## 目录与依赖

| 目录 | 职责 | 依赖约束 |
| --- | --- | --- |
| `packages/protocol` | 浏览器 v1 类型、原生握手与响应校验、桌面工具参数和动作要求 | 不依赖 Node、MCP、UI 或系统 API |
| `packages/runtime` | 请求关联、超时、单请求取消、连接所有权、子进程与原生 WebSocket、配对、图片结果转换 | 依赖 protocol，不依赖桌面服务或浏览器服务 |
| `packages/browser-adapter` | 扩展连接、MV3 心跳、浏览器源码追踪 | 依赖 runtime 和 protocol |
| `packages/desktop` | 桌面工具注册、Linux/Windows/Mac 驱动、具名按键转换、Mac 兼容层 | 依赖 runtime 和 protocol；不创建 MCP 服务实例 |
| `packages/bridge` | MCP stdio/HTTP、配置、平台选择和组件生命周期 | 组合上述包，不直接调用 AX/UIA/AT-SPI |
| `packages/extension` | 浏览器实际执行、Vue 界面、DOM/CDP 等能力 | 复用 browser 协议类型，不导入 Node 运行层 |
| `platforms/macos` | Swift 菜单栏、AX、截图、输入与本地控制开关 | 独立 Swift 工具链 |
| `platforms/windows` | UIA、WGC、输入、本地确认与停止界面 | 独立 .NET 工具链 |
| `platforms/linux` | AT-SPI、Portal、PipeWire 与执行队列 | 系统 Python/GI 工具链 |

内部包是 private workspace 包，Bridge 将其实现打进最终 JS，发布包不依赖用户另行安装这些私有包。原生平台不纳入 pnpm 递归编译；使用明确的 CI 和平台脚本。

## 一次配置与执行端选择

默认只注册浏览器工具。`BRIDGELENS_DESKTOP=1` 按当前 Node 运行平台选择桌面执行端，并新增九个 `desktop_*` 工具；Mac 另外注册旧 `mac_*` 兼容工具。桌面与浏览器各有独立连接，不竞争客户端槽。

Linux/Windows 执行端是按需启动的 JSON Lines 子进程。Mac 应用有稳定的图形权限身份，通过配对的本机 WebSocket 主动连接。执行器都实现同一发送、关闭、停止接口，工具定义由 protocol 提供，MCP 入口由 Bridge 组合。

同一个 HTTP Bridge 的各个 POST 只创建 MCP 协议实例，复用已经创建的执行端。关闭一个 HTTP 请求不能关闭公共桌面执行端。当前仍不提供 MCP 客户端间隔离或不同 Bridge 进程间的输入互斥；每个桌面使用一个控制 Bridge。

## 会话与操作边界

- MCP 请求生命周期、执行器会话、用户控制授权与观察引用分别管理。
- `sessionId` 是执行端进程/连接会话；重启或重新连接后必须重新查询 capabilities。
- NativeChannel 每次成功握手创建新的会话 ID，响应必须同时匹配请求 ID 与原 socket。
- Mac 适配层再约束一个窗口和五分钟授权期限；它不替用户授予系统权限或打开控制开关。
- 控件与图片引用由原生端最终检查。Bridge 的格式检查不能替代原生权限、焦点、窗口和坐标校验。
- 每次输入后重新观察。`accepted` 只代表动作被接受；`verified` 只代表直接结果被确认，不代表保存或发送等业务目标已经完成。
- 请求取消按 ID 传到原生端。桌面停止取消当前和排队工作，并释放授权；已经派发的系统事件无法撤回。

浏览器 wire v1 保持原样，取消只停止等待其结果，不能承诺中断页面里的长脚本或回放。

## 能力与 UI 的复用

九个桌面工具共用名称和结构，执行前查询 capabilities。捕获范围、输入许可、角色名称和底层动作仍可能随平台不同；不支持的动作明确报错。Mac 返回归一化的常见角色并保留 rawRole/nativeActions，Linux 和 Windows 的原生角色继续兼容现有客户端。

界面继续使用各自技术栈：扩展 Vue/Element Plus、Mac SwiftUI、Windows 原生确认与状态窗口。状态、动作和权限语义共用，原生控件代码独立。尚无第二个 Web UI 消费者，因此没有新建空的 UI 组件库。

## 验证与发版

跨平台契约测试覆盖连接所有权、取消、Mac 映射、授权竞争、具名按键与旧参数兼容。Linux 的隔离 GTK/Portal、Windows 的 UIA/WGC 测试以及真实 Swift 客户端验证使用各自的运行器。测试未具备交互桌面时会明确跳过，不能算作真实桌面验收。

扩展、Bridge 和原生应用独立版本；协议版本独立于产品版本。发布清单记录源码提交、组件版本与 SHA256。源码以 GitHub 主仓维护，Gitea 同步相同提交供内网原生构建和 Generic Registry 发布，详见发布文档。
