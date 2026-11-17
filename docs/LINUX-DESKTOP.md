# Ubuntu 桌面接入（实验性）

Bridge 可以通过本地 Python 执行端读取和操作 Ubuntu 桌面。默认关闭，设置 `BRIDGELENS_DESKTOP=1` 后新增 9 个 `desktop_*` MCP 工具。浏览器工具仍经原有 Chrome 扩展；桌面工具不依赖扩展，也不占用扩展的 WebSocket 连接。

目标环境为 **Ubuntu 24.04 LTS / GNOME / 已登录且解锁的图形会话**。执行端使用 AT-SPI、XDG Desktop Portal 和 PipeWire；实际覆盖受应用与桌面后端影响。本轮验证了隔离 Xvfb 中的真实 GTK 应用、真实 D-Bus 传输和 GStreamer PNG 编码；GNOME Wayland 的实际授权窗口、PipeWire 屏幕流和多屏硬件尚需在图形桌面上验收。

## 安装依赖与启动

在目标 Ubuntu 机器上安装系统依赖：

```bash
sudo apt update
sudo apt install python3 python3-gi gir1.2-atspi-2.0 at-spi2-core \
  gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
  gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  pipewire xdg-desktop-portal xdg-desktop-portal-gnome
```

执行端默认使用 `/usr/bin/python3`，避免虚拟环境或 `/usr/local/bin/python3` 找不到 Ubuntu 的 GI 绑定。无需 `pip install`，也不要使用 sudo 运行 Bridge。

这是源码中的新功能，发布版尚未包含。开发验证只构建 Bridge：

```bash
pnpm install --frozen-lockfile
pnpm --dir packages/bridge build
```

MCP 配置示例（替换为自己的绝对路径）：

```json
{
  "mcpServers": {
    "bridgelens": {
      "command": "node",
      "args": ["/absolute/path/AgentBridgeLens/packages/bridge/dist/index.js"],
      "env": {
        "BRIDGELENS_DESKTOP": "1"
      }
    }
  }
}
```

**从目标桌面用户的图形会话启动 AI 客户端或 Bridge。** 仅通过 SSH 登录并不足以取得那个用户的桌面环境。执行端继承 `DISPLAY` / `WAYLAND_DISPLAY`、`XDG_RUNTIME_DIR` 和会话 D-Bus 环境；不要猜测并复制另一个用户的总线地址。

HTTP 模式也可使用相同开关：

```bash
BRIDGELENS_DESKTOP=1 BRIDGELENS_TRANSPORT=http \
  node packages/bridge/dist/index.js
```

现有 HTTP Token 和 Origin 校验继续适用。一个 Bridge 内所有 MCP 客户端共享同一个桌面执行端、授权会话和取消状态，不提供客户端间隔离。桌面模式只应开放给被允许操作这个桌面的客户端。不同 Bridge 进程不共享操作队列，不应同时控制同一桌面。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BRIDGELENS_DESKTOP` | 未设置 | `1` 启用 Linux 桌面工具；其他值关闭 |
| `BRIDGELENS_PYTHON` | `/usr/bin/python3` | Python 可执行文件绝对路径 |
| `BRIDGELENS_LINUX_AGENT` | 包内 `linux-agent/main.py` | 可选执行端脚本路径，供开发/自定义部署；作为参数传给 Python，不经 shell |

## 工具与调用流程

1. 调用 `desktop_get_capabilities`，取得 `sessionId`，检查 `graphicalSession`、GI/GStreamer 依赖和 Portal 能力。它不会弹出屏幕授权对话框。
2. `desktop_list_apps` / `desktop_list_windows` 枚举 AT-SPI 可见的应用和顶层窗口。控件读取可用与屏幕/输入授权是不同能力。
3. `desktop_observe` 读取目标窗口；用返回的 `snapshotId`、节点 `id` 和 `actions` 操作。
4. 需要画面时调用 `desktop_start_session`。默认仅共享画面；`input: true` 同时申请键盘和指针。用户在系统对话框中选择共享显示器并授权。
5. `desktop_capture_screenshot` 返回 MCP 图片和坐标元数据。多来源时必须明确指定 `streamId`。
6. `desktop_act` 每次执行一个操作；后续重新观察并验证任务结果。
7. `desktop_stop` 取消当前及排队工作，清除引用、关闭画面和输入会话。调用不需要旧的 sessionId，浏览器工具不受影响。

| 工具 | 关键参数 / 返回 |
| --- | --- |
| `desktop_get_capabilities` | 返回执行端 `sessionId`、图形环境、依赖、Portal 可用性与当前授权 |
| `desktop_list_apps` | `sessionId`；返回 `appId`、名称和 PID |
| `desktop_list_windows` | `sessionId`、可选 `appId`；返回 `windowId`、名称、角色、状态 |
| `desktop_observe` | `sessionId`、`windowId`；可选 `maxDepth`、`maxNodes`、`includeText`、`includeScreenshot`、`streamId` |
| `desktop_start_session` | `sessionId`、可选 `input` / `multiple`；返回授予的设备位图及来源 |
| `desktop_capture_screenshot` | `sessionId`、可选 `streamId`；返回 PNG 及 `screenshotId`、像素尺寸、逻辑尺寸、采集时间 |
| `desktop_act` | `sessionId`、`action`，以及下表中的动作参数 |
| `desktop_wait_for` | `sessionId`、`windowId`、精确 `name` 和/或 `role`、可选 `timeoutMs`；返回匹配节点及新快照 |
| `desktop_stop` | 无参数 |

`desktop_act` 参数：

| 动作 | 必要参数 | 说明 |
| --- | --- | --- |
| `invoke` | `snapshotId`、`target`，多动作时加 `actionName` | 使用控件暴露的动作名；不猜测所有按钮都叫 click |
| `set_text` | `snapshotId`、`target`、`text` | 目标必须暴露 EditableText；支持 Unicode，普通文本会读回验证 |
| `focus` | `snapshotId`、`target` | Component 焦点操作，不等于窗口管理器激活窗口 |
| `click` | `screenshotId`、`x`、`y`，可选 `button` | x/y 是返回图片的原始像素坐标，button 为 left/middle/right |
| `move` | `screenshotId`、`x`、`y` | 移动指针 |
| `scroll` | `screenshotId`、`x`、`y`，非零 `dx` 和/或 `dy` | 先将指针移至目标，再发送平滑滚动增量 |
| `press_keys` | `screenshotId`、`keys` | Linux evdev keycode 数组，一起按下后逆序释放。例如 Ctrl+S：`[29,31]`；不用于输入中文 |

观察示例：

```json
{
  "sessionId": "desktop-…",
  "windowId": "window-…",
  "maxDepth": 6,
  "maxNodes": 300,
  "includeText": true
}
```

随后填写控件：

```json
{
  "sessionId": "desktop-…",
  "action": "set_text",
  "snapshotId": "snapshot-…",
  "target": "n7",
  "text": "你好 Ubuntu 👋"
}
```

返回值区分 `accepted` 和 `verified`：前者表示底层接受动作，后者表示执行端独立确认了该操作的直接结果。按钮动作和键鼠输入返回 `verified: false`，应重新观察界面、等待预期状态或检查业务结果。输入请求异常或超时不会自动重试。

## 引用、限制与停止

- 会话 ID 在 Python 进程重启时改变。旧请求返回 `STALE_SESSION`。
- 应用/窗口引用保留最多 5 分钟；节点快照最多 60 秒、最多 8 份；截图引用最多 30 秒、最多 8 份。任意动作尝试后，节点与截图引用都作废；下一步先重新观察。停止还会清除应用/窗口引用。
- 控件树默认深度 6、节点上限 300；最大深度 16、节点 1000。返回 `truncated` / `skipped`，不能把截断树中的缺失当作“控件不存在”。文本默认不读取，启用后每节点最多 2000 字符。
- PASSWORD_TEXT 控件不返回文本，也不通过读回验证密码；截图不作密码区域识别或遮挡。应用自行暴露在名称等字段中的敏感内容，不能由执行端普遍识别。
- 坐标绑定所选 Portal 流，从图片像素转换至该流的逻辑尺寸；不直接使用 AT-SPI 坐标，不把第二块显示器的位置重复加到流内坐标。后端未提供逻辑尺寸时拒绝坐标输入。
- 有时效检查不代表界面完全冻结。用户切换焦点、移动窗口或改变缩放后应重新观察；第一版没有跨环境统一的布局/焦点锁。共享期间改变显示器配置后，应停止并重新授权。
- 第一版共享显示器，不提供窗口/区域裁剪或跨窗口原子操作；窗口枚举仅覆盖 AT-SPI，未接 GNOME Shell 扩展或 X11 窗口管理后端。
- 输入使用 RemoteDesktop 的 `Notify*` 接口，尚未接 libei/EIS；无授权持久化、剪贴板注入、root/uinput 后端或任意 shell 工具。只共享画面时可用 ScreenCast，不要求输入支持。
- 目前使用有上限的轮询等待，尚未加入 AT-SPI 事件订阅。`desktop_wait_for` 单次最多 30 秒，按控件名称/角色精确匹配，成功时返回新快照。
- 同一执行端串行处理普通请求；stdin 读取独立进行，`desktop_stop` 可取消等待和授权对话框，并跳过此前排队工作。已经交给应用的动作不能撤回；原生调用退出可能有短暂延迟。
- 键鼠操作异常时尝试释放已经按下的按键/按钮；释放失败会关闭共享会话。Bridge 正常结束时先停止执行端；异常退出或协议超时则终止子进程。所有授权会话都属于执行端的专用 D-Bus 连接。

## 验证

Bridge 测试构建的是 Bridge，不构建扩展安装包：

```bash
pnpm --dir packages/bridge typecheck
pnpm --dir packages/bridge test
/usr/bin/python3 -m unittest discover -s platforms/linux/tests -p 'test_*.py' -v
```

图形集成测试额外需要 GTK3、Xvfb、xauth 与 D-Bus 测试工具：

```bash
sudo apt install gir1.2-gtk-3.0 xvfb xauth dbus-x11
dbus-run-session -- xvfb-run -a env ABL_DESKTOP_INTEGRATION=1 GIO_USE_VFS=local \
  /usr/bin/python3 -m unittest discover -s platforms/linux/tests -p 'test_*.py' -v
```

该命令创建独立总线和虚拟显示器，不向当前用户的真实桌面发送输入。测试覆盖真实 GTK 窗口、中文/Emoji 文本读回、密码文本省略、按钮动作、状态等待、引用失效、分数缩放、取消后释放按键，以及通过真实 D-Bus 传输的模拟 Portal 授权/拒绝/撤销/取消。GStreamer 使用测试画面源验证 PNG 编码；GNOME 合成器和真实 PipeWire 屏幕源未被模拟测试证明可用。

真实 Wayland 验收还应逐项执行：

1. 在目标桌面启动 Bridge，确认 capabilities 报告实际环境和缺失能力。
2. 用户在系统窗口中批准只读共享，确认 PNG 与桌面一致；此时键鼠操作应被拒绝。
3. 重新请求 `input: true`，确认键盘/指针授权；检查点击、滚动和快捷键的实际结果。
4. 用 100%、150%、200% 缩放及第二显示器检查坐标；每次改显示配置后重建共享会话。
5. 在系统界面撤销共享、拒绝授权、关闭窗口及调用 stop，确认旧引用不再执行操作。
6. 用实际目标应用完成“观察 → 输入中文 → 保存 → 读取文件/界面验证”闭环，记录应用和桌面版本。

## 参考接口

- [Ubuntu AT-SPI D-Bus 接口](https://ubuntu.com/desktop/docs/en/latest/reference/accessibility/dbus/)
- [GNOME libatspi](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/)
- [RemoteDesktop Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [ScreenCast Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)
- [GStreamer appsink](https://gstreamer.freedesktop.org/documentation/applib/gstappsink.html)
