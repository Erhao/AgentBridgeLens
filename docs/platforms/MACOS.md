# macOS 桌面执行端

AgentBridgeLens 支持 macOS 14.2 及以上版本。桌面应用内置 Node 运行时和统一 MCP Bridge，配置和授权都可在主窗口完成。

## 安装与连接

1. 从[统一制品库](https://gitea.xinyu1997.tech/xinyu/AgentBridgeLens/packages)下载与你的 Mac 芯片匹配的 DMG。打开磁盘映像，将 AgentBridgeLens 拖入「应用程序」后再启动。
2. 在「连接客户端」复制 MCP 配置，把其中的 `agentbridgelens` 条目加到支持本机 stdio MCP 的 AI 客户端，然后重载客户端。客户端负责启动 App 内的 Bridge，无需另装 Node 或运行初始化命令。
3. 回到「概览」，确认连接后可查询桌面能力。在「隐私与权限」授予辅助功能；需要截图时，再单独开启屏幕录制权限。
4. 桌面控制每次连接默认关闭。需要点击或键入时，在「概览」手动开启。可以从工具栏、菜单栏或应用的「桌面」菜单停止。

配置使用 App 当前的绝对路径。移动或改名后，重新复制配置。旧安装如果显示两份应用，请退出旧版并移除旧应用副本。保留应用数据目录中的原有配对文件。使用旧版独立 Bridge 的客户端应先停用旧配置，以免占用同一端口。

在「连接客户端 → 高级设置」可以修改本机配对端口。开发者仍可自行启动 Bridge，并通过 `BRIDGELENS_DESKTOP=1`、`BRIDGELENS_MAC_PORT` 和 `BRIDGELENS_MAC_TOKEN_FILE` 配置。旧 `AGENTBRIDGEMAC_*` 环境变量和 `~/.agentbridgemac/token` 配对路径继续兼容。

## 系统设置已开启，App 仍显示权限不可用

1. 在「隐私与权限」点「重新打开 AgentBridgeLens」，或按 `⌘Q` 完全退出，再从「应用程序」重新打开。录屏权限需要重新启动进程才能生效。
2. 如果仍显示不可用，在权限页点击「在 Finder 中显示」，确认当前运行的副本。把这份 `AgentBridgeLens.app` 添加到系统设置中对应的「辅助功能」或「屏幕与系统音频录制」列表，开启后再重开一次。若仍有旧版或同名条目，可先从相关列表移除旧条目，再添加当前副本。
3. 开发预览版采用临时签名，升级后系统可能要求重新授权，即使名称和 Bundle Identifier 一样。授予安装后的 App，避免授权仍在 DMG 中的副本。

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

CI 编译原生应用并执行 Swift 核心检查。通信检查将应用复制到工作区以外、含空格的目录，通过其 `--mcp` 启动内置 Bridge，验证原生握手、工具注册和停止命令。测试模式不派发桌面输入。

辅助功能、录屏提示、焦点和实际操作在已解锁的目标 Mac 上验收。应用的 Bundle Identifier 沿用旧版。开发预览使用临时签名，公证发布需设置 Developer ID 和 `MAC_NOTARY_PROFILE`。

安装与授权流程参考 [Alfred 安装指南](https://www.alfredapp.com/help/getting-started/install/)、[Raycast 屏幕权限说明](https://manual.raycast.com/ai/screen-awareness)和 [Apple macOS 设计指南](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)。磁盘映像与公证遵循 [Apple 分发指南](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)。
