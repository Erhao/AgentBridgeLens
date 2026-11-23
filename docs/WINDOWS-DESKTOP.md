# Windows 桌面接入（实验性，尚未发布）

Windows 执行端让现有 Bridge 通过 UI Automation 读取原生控件、调用控件动作，并通过 Windows.Graphics.Capture 取得窗口截图、通过 SendInput 发送键鼠输入。浏览器继续使用原来的 Chrome 扩展；桌面工具不依赖扩展连接。

当前实现使用 C# / .NET 10、UIA3 COM 接口和 Win32。`Interop.UIAutomationClient` 是 MIT 许可的 COM 类型定义，不包含另一套 AI 或自动化服务。Windows 原生调用在独立执行进程的 MTA 主线程串行运行；本机确认和停止面板使用独立 STA 线程。

## 启用

面向 Windows 11 x64 / ARM64 的当前用户、已解锁交互会话。不要从 Session 0 服务中直接运行桌面执行端。以 Node.js 的架构选择执行程序：x64 Node.js 使用 win-x64，即使它运行在 ARM64 Windows 上。

发布工作流会构建自带 .NET 运行时的两个执行端，放入 npm 包：

```text
windows-agent/win-x64/AgentBridgeLens.Windows.exe
windows-agent/win-arm64/AgentBridgeLens.Windows.exe
```

这些产物尚未发布。源码开发可安装 .NET 10 SDK 并做 Debug 构建：

```powershell
dotnet build platforms/windows/AgentBridgeLens.Windows.csproj
pnpm --dir packages/bridge build
$env:BRIDGELENS_DESKTOP = "1"
$env:BRIDGELENS_WINDOWS_AGENT = (Resolve-Path "platforms/windows/bin/Debug/net10.0-windows10.0.19041.0/AgentBridgeLens.Windows.exe").Path
node packages/bridge/dist/index.js
```

开发构建需要 .NET Desktop Runtime；正式 CI 产物自带运行时。只复制 exe 不够，保留其所在目录的全部 DLL、配置和许可文件。默认不自动下载或执行远程二进制。

在 MCP 配置里保留现有 Bridge 启动命令，加上环境变量：

```json
{
  "env": {
    "BRIDGELENS_DESKTOP": "1",
    "BRIDGELENS_WINDOWS_AGENT": "C:\\AgentBridgeLens\\AgentBridgeLens.Windows.exe"
  }
}
```

安装包含 Windows 执行端的发布包后可以省略 `BRIDGELENS_WINDOWS_AGENT`。它是可执行文件路径，不是命令行，不接受拼接的 shell 参数。Bridge 只在第一次桌面调用时启动执行端，浏览器工具仍然可独立使用。

AI 在 WSL、Linux 或其他设备时，执行端和 Bridge 仍应运行在 Windows 目标用户的会话中。可使用现有 Streamable HTTP 接口连接；跨设备连接使用可信客户端、认证和加密通道。一个 Bridge 的 HTTP 客户端共享同一窗口许可和动作队列，没有客户端间隔离；不同 Bridge 之间没有全局输入协调。

## 工具流程

沿用 9 个 `desktop_*` 工具：

1. `desktop_get_capabilities`：取得执行端 `sessionId`，检查 `graphicalSession`。不会弹出确认。
2. `desktop_list_apps` / `desktop_list_windows`：取得可见 Win32 顶层窗口引用，不等于所有进程或完整的系统界面清单。
3. `desktop_observe`：读取指定 `windowId` 的 UIA 树，返回节点 `id`、`snapshotId`、角色、名称、AutomationId、状态、边界与动作。
4. `desktop_start_session`：Windows 必须带 `windowId`。用户在本机确认访问该窗口；`input:false` 仅允许截图，`input:true` 才允许所有控件动作及键鼠输入。一次只批准一个窗口，`multiple:true` 返回不支持。
5. `desktop_capture_screenshot`：返回 PNG 图片块和 `screenshotId`、原始像素尺寸、桌面物理边界、DPI、坐标映射可用状态。
6. `desktop_act`：每次一个动作。动作尝试后，所有节点快照和截图引用作废，下一步重新观察。
7. `desktop_wait_for`：按精确名称和/或角色轮询目标窗口，返回新快照与匹配节点。
8. `desktop_stop`：取消当前及此前排队任务、关闭许可、清除所有窗口/节点/截图引用。不需要旧 sessionId。

观察可以在未批准控制时进行，与系统 UIA 的普通读取能力一致。截图许可和控制许可由本产品管理：本机对话框不是 Windows 的通用辅助功能权限窗口。

开始窗口控制：

```json
{
  "sessionId": "desktop-…",
  "windowId": "window-…",
  "input": true
}
```

批准后会显示连接面板。用户可点“停止连接”、关闭该面板，或按 Ctrl+Alt+F12 停止。快捷键如被其他程序占用，仍可使用停止按钮。停止不是撤销，已经发送给应用的动作可能已经发生。新的独立对话框需要重新枚举和批准，不自动继承原窗口的许可。

## 动作与协议差异

| action | 参数 | Windows 行为 |
| --- | --- | --- |
| `set_text` | `snapshotId`、`target`、`text` | UIA ValuePattern.SetValue；支持 Unicode。非密码控件读回验证；不支持 ValuePattern 的编辑器返回不支持 |
| `focus` | `snapshotId`、`target` | 尝试恢复并激活已批准窗口，再调用 UIA SetFocus，读回焦点；系统拒绝激活时明确报错 |
| `invoke` | `snapshotId`、`target`、可选 `actionName` | 默认 Invoke；可指定 `toggle`、`select`、`expand`、`collapse`，必须有对应 Pattern |
| `click` / `move` | `screenshotId`、`x`、`y`、可选 `button` | 使用原始图片像素，转换到虚拟桌面物理像素；检查前台窗口、遮挡和几何 |
| `scroll` | `screenshotId`、`x`、`y`、非零 `dx`/`dy` | 整数 Windows wheel 单位；正 dy 向下，通常 120 为一格；范围 -1000 到 1000 |
| `press_keys` | `screenshotId`、`keys` | 具名按键，例如 `["CTRL","S"]`、`["ENTER"]`、`["ALT","F4"]`；按下后逆序释放 |

Windows 的 `keys` 是字符串数组，Linux 的 evdev 数字数组保持兼容。Windows 明确拒绝 Linux 数字键码，不做静默转换。支持 A-Z、0-9、F1-F24，以及 CTRL、ALT、SHIFT、ENTER、ESC、TAB、SPACE、BACKSPACE、DELETE、INSERT、HOME、END、PAGEUP、PAGEDOWN、方向键。拒绝 WIN、ALT+TAB、ALT+ESC、CTRL+ESC 等明显跳出窗口的系统快捷键。

截图需要 `streamId` 时只接受 `1`。`desktop_observe(includeScreenshot:true)` 的窗口必须与已批准窗口一致。

返回 `accepted:true` 只表示控件调用返回或输入已提交；`verified:true` 只确认该动作的直接读回结果。按钮动作、鼠标和快捷键不代表业务成功，需重新观察、等待或读取应用结果。超时、断线、原生异常均不自动重放动作。

## 限制

- 这是一版源码实现。当前 Linux 开发环境已进行跨目标编译和公共协议测试，尚未在用户真实 Windows 桌面完成验收。
- UIA 覆盖取决于应用；自绘区域和画布可能没有可操作控件。未实现虚拟化列表的 ItemContainer/Realize 适配、UIA 事件订阅、应用 COM/CLI 业务适配器和文本键盘回退；等待使用有限轮询。
- 树默认深度 6、节点 300，上限分别为 16 和 1000，返回 `truncated`、`skipped`。角色为英文归一化名称，例如 `button`、`edit`、`document`；不能将截断结果中的缺失解释为不存在。
- 文本默认不读；开启后每个节点最多 2000 字符。UIA 密码控件不返回文本；应用自己在名称中暴露的秘密无法普遍识别。截图不做敏感区域遮挡。
- 普通执行端拒绝高于自身完整性级别的目标，不自动提权、不设置 UIAccess；UAC 安全桌面、锁屏、登录页和 Session 0 不支持。
- 窗口引用最多 5 分钟、512 项；节点快照 60 秒、8 份；截图 30 秒、8 份。执行端重启改变 sessionId。引用检查与实际操作之间仍存在界面变化的时间窗口，不能当作桌面锁或安全沙箱。
- WGC 捕获一个窗口，保留系统捕获边框。最小化、受保护内容、驱动或硬件限制可能使捕获不可用或返回黑图；没有 GDI 降级路径和黑图语义识别。
- 只有截图尺寸与当前物理窗口边界完全匹配时才允许键鼠输入。DPI、几何或虚拟桌面边界变化会拒绝旧坐标。多显示器使用物理坐标和负原点，不将缩放率重复乘入 UIA 坐标。HDR 尚未做专门的色彩映射。
- 键鼠输入要求批准窗口位于前台；坐标目标被其他窗口遮挡时拒绝。不会强行抢焦点。用户按住鼠标或修饰键时拒绝注入。快捷键可能被应用或系统全局处理，窗口许可不构成运行隔离。
- 停止信号在独立读取线程处理，取消等待、确认和排队工作。卡住的第三方 UIA/图形原生调用不一定能立即中断；Bridge 超时会终止执行端。输入异常时尽量释放注入的键/按钮；硬终止和系统故障无法保证释放成功。

## 验证与交付

```powershell
pnpm --dir packages/bridge typecheck
pnpm --dir packages/bridge test
dotnet run --project platforms/windows/tests/Core/Core.csproj
dotnet run --project platforms/windows/tests/Integration/Integration.csproj
```

Core 测试可以在 Linux 运行，覆盖坐标边界、负原点、引用淘汰、取消、具名按键及系统快捷键限制。Integration 仅在 Windows 运行，创建独立 WinForms 测试进程，检查真实 UIA、密码省略、Unicode 读回、按钮状态改变、WGC 像素、权限门控与协议取消。测试驱动只批准本次测试创建的进程中的确认框，生产执行端不包含跳过本机确认的环境变量。

没有已解锁交互桌面的 CI 会明确跳过交互测试；设置 `ABL_REQUIRE_INTERACTIVE=1` 可让缺少桌面成为验收失败。跳过不等于真实桌面验证通过。真实验收还需覆盖记事本保存、目标应用、100%/150%/200% 缩放、不同 DPI 双屏、遮挡、焦点改变、提权窗口、取消和停止。

`.gitea/workflows/desktop.yml` 在 Linux 上交叉编译 win-x64 / win-arm64 制品，打包前验证必需文件及 PE 架构。Bridge 发版由 `.gitea/workflows/bridge-release.yml` 将同提交的两个执行端纳入 npm 包。制品经 Gitea 构建、校验和入库后直接上传 GitHub Releases；不运行 GitHub CI/CD，Bridge 与扩展分别发版。Windows 真机 GUI 验收另行执行。

官方接口：[UIA](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview)、[线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、[Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)、[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。
