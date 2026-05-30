# 设计：标签页定位与多标签跟踪（Phase A）

## 问题
默认操作"当前激活 tab"对多窗口、频繁切标签的工作流不可用。需要：能指定一个**固定目标 tab**(不随切换变)，且能**同时跟踪多个 tab**(如支付流程 A→B→回到 A)。

## 模型：tabId 寻址 + 一组固定目标作为默认
- 所有页面工具新增可选参数 `tabId`。
- **多 tab 本就靠每次调用传 tabId**：agent 同时握多个 tabId 即可并行操作多个页（CDP 也按 tabId 并行）。这是多 tab 跟踪的根本机制，不依赖"固定目标"。
- **固定目标是一组（可固定多个）**，存 `storage.session.targetTabIds`，只是"省略 tabId 时用哪个"的默认便利。
- 解析优先级：**显式 `tabId` > 固定目标（多个时取最近活跃的那个，靠 `tabs.onActivated` 记录）> 当前激活 tab**。
- 每个固定目标可**单独设新标签策略**（`storage.session.tabPolicies[tabId]`，缺省回退全局），UI 在该目标行上直接选。
- follow：某固定目标打开新标签 → 新标签**自动加入**目标组（支付场景下单页+支付页一起跟）。

## 新增工具
| 工具 | 作用 |
|------|------|
| `list_tabs` | 列出所有窗口的所有 tab：`{tabId, windowId, title, url, active, isTarget, openedByTarget}` |
| `set_target_tab(tabId)` | 固定目标 |
| `get_target_tab` | 查当前目标(含是否存活) |
| `clear_target_tab` | 取消固定，回到"跟随激活" |

现有工具(截图/DOM/inspect/execute/highlight/overlays/recorder/console/network/CDP/perf/a11y/trace_element|style)全部加可选 `tabId`。

## 新标签策略（C：检测但不劫持，可切自动跟随）
- SW 监听 `tabs.onCreated`/`onRemoved`。
- `list_tabs` 用 `tab.openerTabId === 目标` 标记 `openedByTarget`，agent 据此决定是否 `set_target_tab` 跟过去，或用 `request_user_confirmation` 问用户。
- popup 开关 `newTabPolicy`：`stay`(默认，不跟随) / `follow`(目标页打开的新标签自动设为新目标)。
- 目标被关(`onRemoved`)→ 自动清除并回退到跟随激活。

## 截图
- 目标/指定 tab 是其窗口的激活 tab → `captureVisibleTab`(快、无横幅)。
- 后台 tab → CDP `Page.captureScreenshot`(可截后台，临时 attach、闪一下横幅)。
- 元素裁剪：取 `get_element_rect` 后用 `OffscreenCanvas` 裁，逻辑不变。

## CDP 多路
`cdp-network.ts` 由单 `attachedTabId` 改为**按 tabId 的 Set + 每 tab 独立 records**，支持同时对多个 tab 抓包；`cdpEvaluate`/`cdpScreenshot` 均按 tabId。

## 权限 & 状态持久化
- 新增 `tabs` 权限(列举所有 tab 的 title/url 必需)。
- 目标 tabId 存 `chrome.storage.session`(随 SW 休眠存活、浏览器重启清空，符合"tab 绑定"语义)；`newTabPolicy` 存 `chrome.storage.local`(持久设置)。

## 已知限制
- `rel="noopener"` 打开的新标签无 `openerTabId`，无法归因为子标签(仍会出现在 `list_tabs`)。
- content script 仅在扩展安装后加载/导航的 tab 自动注入；扩展安装前就打开的旧 tab 需刷新一次。
- 无异步推送：要"等某 tab 变化"得 agent 轮询或用户给信号(`wait_for` 类工具留待后续)。

## 后续优化
- ✅ popup 标签页列表显示区域加长（max-height 360px）。
- ✅ 支持**针对单个目标标签页**单独设置「新标签策略」：每目标策略存 `storage.session.tabPolicies[tabId]`，有效策略 = 该目标设置 ?? 全局默认；UI 标注「（当前目标）/（默认）」。
- ✅ side panel 与 popup 共用同一套「连接配置 + 目标标签页」控件（`shared/panel-ui.ts` 的 `mountControls`）；side panel 额外保留 Agent 活动日志 + 交互式确认。

## UI/UX
- **popup**：连接状态下方加「目标标签页」区——当前目标显示、所有 tab 列表(按窗口分组、favicon+标题+域名+「设为目标」)、「取消固定」、新标签策略开关。
- **HUD / 角标**：目标标识(🎯)留待 Phase B。
