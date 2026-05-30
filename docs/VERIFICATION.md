# 待验证清单（Browser Verification Checklist）

> 以下功能**已实现、通过类型检查和构建**，但**尚未在真实 Chrome 浏览器里验证过**（开发者无 GUI 环境，无法实际加载扩展跑页面）。
> 等功能开发告一段落后，按此清单逐项在浏览器里验证。验证通过的打 ✅，有问题的记录现象。

验证前置：`pnpm build` → `chrome://extensions/` 重新加载扩展 → 准备一个测试页面（建议含 React/Vue dev server 的页面）。

> ⚠️ **重要**：MCP 里运行的 Bridge 由 Claude Code 启动，工具集在启动时注册。改了 bridge 代码后必须 **重新 `pnpm build` 并重启 Claude Code**，否则跑的还是旧版（旧版只有 9 个工具）。

## 验证发现（findings）

- **F1｜`execute_js` 在严格 CSP 页面失效（已修）**：content script 里用 `new Function` 求值，会被页面 `script-src`（无 `unsafe-eval`）拦截。**修复：execute_js 先走 content script 快路径；若返回的 error 命中 CSP/eval，自动回退到 CDP `Runtime.evaluate`（`cdpEvaluate`，临时附加 debugger，可绕过页面 CSP），结束后解除。** 普通页无横幅、CSP 页短暂闪一下横幅。**状态：已修并验证 ✅（2026-05-30 于 blog.jetbrains.com 严格 CSP 页，`execute_js` 返回真实值且带 `viaCdp:true`，确认走了 CDP 回退）。**
- **F2｜`get_network_requests` 对已加载页面返回空**：注入式捕获只抓 content script 加载之后的 fetch/XHR；页面在扩展注入前已加载完则为空。属设计限制，Phase 2 的 `start_cdp_network` 可覆盖。**状态：已知限制，文档说明即可。**
- **F3｜`hide_hud` 偶发 InputValidationError**：首次调用在 harness 校验层被拒，再次调用（在 chrome:// 页）变为正常的 content-script 超时。疑为偶发，非持久 bug。**状态：待回到正常页复测确认。**
- **F4｜连接无法常驻（部分修复，根因更深）**：MV3 Service Worker 闲置 ~30s 休眠，而 WebSocket 存活绑定在 SW 生命周期上——SW 一睡连接即断。
  - 第一版修复：`chrome.alarms`（0.5min）周期唤醒 SW 并 `connect()`。**但这只是每 30s 唤醒一瞬，连接随即又断**，验证时调用大多落在"死窗口"，仍频繁报 not connected。
  - **正确修法（待做）**：Bridge 端定期发**心跳 ping**（每 ~20s），SW 每收到一条 WS 消息就重置 30s 空闲计时器，从而保持唤醒、连接常驻。需改 `ws-relay.ts` + 重建 Bridge + 重启 Claude Code。
  - **已实施心跳修复**：`ws-relay.ts` 每 20s 向扩展发一条 `{t:"ping"}` 数据消息；扩展 `onmessage` 收到 ping 即忽略（但收消息这一动作重置了 SW 空闲计时器），连接得以常驻。`alarms` 作为兜底保留（断线后唤醒重连）。
  - **状态：已修（alarms 兜底 + WS 心跳保活），待重启 Bridge/重载扩展后验证。**
- **F3｜`hide_hud` 调用被校验层拒绝**：调用报 `InputValidationError: hide_hud expects no parameters but received unexpected input`，而 `show_hud`/`clear_overlays`/`stop_cdp_network` 等同样无参工具均正常，且 `hide_hud` 的注册定义与 `show_hud` 完全一致。疑为工具调用/校验层的偶发问题，非 bridge 返回错误。2026-05-30 多次复现。**状态：待排查。规避：刷新页面即可清掉 HUD。**
- **F-token｜token 鉴权端到端有效**：扩展填错 token 时连接被拒（停在「未连接」），填对后立即连上。验证了 Phase 5 的 `verifyClient` 鉴权。✅

## Phase 1 — 通信与基础工具（已部分验证 @2026-05-30，旧版 9 工具 Bridge）

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| Bridge ↔ 扩展连接 | 启动后扩展弹窗显示「已连接」 | ✅ 已连（get_page_info 返回真实页面） |
| `get_page_info` | 返回当前页 URL/标题/viewport | ✅ |
| `inspect_element` | 返回样式/盒模型 | ✅ |
| `highlight_element` / `clear_highlights` | 页面出现/消失高亮框 | ✅ 截图确认 |
| `get_dom_snapshot` | 返回精简 DOM 树 | ✅ |
| `get_console_logs` | 返回捕获的日志 | ✅ |
| `capture_screenshot`（整页） | 返回可视区截图 | ✅ |
| `get_network_requests` | 返回注入式捕获的请求 | ⚠️ 见 F2（已加载页为空） |
| `execute_js` | 执行表达式返回结果 | ❌ 见 F1（CSP 拦截） |
| `capture_screenshot`（元素） | 带 selector，返回裁剪到该元素的图 | ⏸️ 待新版 Bridge（旧版忽略 selector） |
| 端口可配置 | 弹窗改端口 + MCP 配 `BRIDGELENS_PORT`，仍能连上 | ⬜ |

## Phase 2 — CDP 采集补全（已验证 @2026-05-30，新版 29 工具 Bridge）

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `get_performance_metrics` | 返回 navigation timing / FCP / LCP / CLS / 内存 | ✅（FCP 936/LCP 1142/内存 76MB） |
| `get_accessibility_tree` | 返回带 role/name 的简化无障碍树 | ✅（nav 子树 role/name 正确） |
| `get_errors` | 仅返回 error 级日志 | ✅（空数组，页面无报错） |
| `start_cdp_network` | 调用后标签页出现「DevTools 调试」横幅 | ✅（attached + tabId） |
| `get_cdp_network` | start 后刷新页面，返回完整请求（含 status/耗时/失败） | ✅（dev.to 刷新抓到 16 请求，含 status/type/mimeType/耗时；覆盖 F2 缺口） |
| `stop_cdp_network` | 调试横幅消失，debugger 解除 | ✅（detached） |
| CDP 与 DevTools 互斥 | 已开 DevTools 时 start 应报错而非崩溃 | ⬜ |

## Phase 3 — Source Map 代码定位（已部分验证 @2026-05-30）

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `trace_element_to_source`（生产/无框架页） | 应优雅返回提示而非报错 | ✅（正确返回「未发现 React/Vue」） |
| `trace_element_to_source`（React dev） | 返回正确组件文件+行号 | ⬜ 需 React dev 页面 |
| `trace_element_to_source`（Vue dev） | 返回 `__file` | ⬜ 需 Vue dev 页面 |
| `trace_style_to_source` | 返回元素匹配的 CSS 规则及所属样式表 | ✅（命中 h1 规则，匹配 font-size） |
| 跨域样式表 | 应标注「跨域不可读」而非崩溃 | ✅（dev.to 的 assets.dev.to 跨域 CSS 正确标注不可读） |
| `trace_error_to_source`（无 map） | 解析堆栈 + 标注「无 source map」 | ✅（正确解析帧并回退） |
| `trace_error_to_source`（有 map） | 还原到原始 .tsx/.vue 行号 | ⬜ 需带 sourcemap 的 dev app |

## Phase 4 — 交互增强（已部分验证 @2026-05-30）

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `capture_screenshot`（元素裁剪） | 带 selector，返回裁剪到该元素的图 | ✅ 截图确认（仅返回 h1 一条） |
| `mark_elements` | 传一组 selector，页面出现彩框标注 | ✅ 截图确认（nav+h1 绿框） |
| `visualize_layout` | 圈出 overflow 截断的元素（橙色虚线框） | ✅ 调用成功（本页无截断元素可框） |
| `show_responsive_frame` | 叠加目标宽度蓝框 + 列出更宽元素 | ✅ 截图确认（375px 蓝框 + 220 超宽元素） |
| `clear_overlays` | 清除上述所有叠加层 | ✅ |
| `show_hud`/`update_hud` | 右下角面板出现/更新文字 | ✅ 截图确认 |
| `hide_hud` | 面板消失 | ✅（返回 hidden，截图确认消失；F3 偶发，复测正常） |
| `start_recording`/`stop_recording` | 录制点击/输入/滚动，返回 action 序列 | ✅（dev.to 抓到 22 个动作：click/input/change/scroll + 选择器） |
| `replay_actions` | 把序列在页面回放，控件状态变化正确 | ✅（回放 5/5，截图确认搜索框被填入 "lifhudisau"） |
| Side Panel 连接状态 / 活动日志 | 打开侧栏显示已连 + 每次调用新增日志 | ✅（侧栏正常打开，确认面板往返工作） |
| `request_user_confirmation` | 侧栏弹出问题+按钮，点击后 agent 收到选择 | ✅（用户点「看起来对 ✅」，agent 收到 choice） |
| token 鉴权 | 错 token 拒连，对 token 放行 | ✅（端到端确认） |
| F4 连接保活 | 心跳后连接常驻、不再频繁掉线 | ✅（重启后多轮调用连续成功，未再掉线） |

> 注意：`request_user_confirmation` 依赖 Side Panel 处于打开状态（扩展无法在无用户手势时强行打开侧栏）。WS 调用超时已从 30s 放宽到 120s 以容纳人工确认与长回放。

## Phase A — 标签页定位与多 tab（待验证，需重启 Bridge + 重载扩展）

> 本批改动了 **Bridge + 扩展两端**，且新增 `tabs` 权限：需 `git pull`(主仓库) → `pnpm build` → 重载扩展 → 重启 Claude Code。

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `list_tabs` | 返回所有窗口的所有 tab（含 isTarget/openedByTarget） | ✅（列出 10 个 tab，字段齐全） |
| `set_target_tab` / `get_target_tab` / `clear_target_tab` | 固定/查询/取消目标 | ✅（pinned↔follow-active 切换正常） |
| 固定后操作后台目标页 | 激活页停在 chrome://extensions，工具仍操作被固定的后台页 | ✅（截图返回 dev.to、get_page_info 返回 dev.to） |
| 工具 `tabId` 参数 | 显式传 tabId，操作指定 tab | ✅（CDP 显式 tabId attach/抓包/detach） |
| 后台 tab 截图（CDP） | 不切前台，对后台 tab 截图成功 | ✅（Page.captureScreenshot 截到后台 dev.to） |
| 后台目标页 content-script 工具 | 后台目标页刷新后 get_page_info 成功 | ✅ |
| 多 tab 并行 | 同时：A 用 content-script 工具、B 用 CDP 抓 72 请求，互不干扰 | ✅ |
| 目标关闭/取消回退 | clear_target_tab → 回到跟随激活 | ✅ |
| 新标签策略 follow / openedByTarget | 目标页开新标签后行为 | ⬜ 需点链接开新标签触发 |
| popup 标签页列表 UI | 弹窗列出 tab、点「设为目标」、🎯 标识 | ⬜ 需肉眼确认 |

> 已知限制复现：reload 扩展后，**reload 之前就打开的旧标签页** content script 会失效，content-script 类工具（get_page_info 等）超时，需刷新该 tab 一次；CDP 类工具（截图/抓包/trace/execute_js 回退）不受影响。本次验证已观察到并确认。

## 仍未覆盖（需特定条件，非 bug）

- ~~`execute_js` 在严格 CSP 页~~ —— 已修并验证（见 F1）；普通页走 content script 快路径同样可用
- `trace_element_to_source` 返回**真实组件文件+行号**（需本地 React/Vue **dev** 页；目前只验了优雅回退）
- `trace_error_to_source` **真实 sourcemap 还原**（需带 .map 的 dev 堆栈）
- `visualize_layout` 实际**画出橙框**（需含 overflow 截断内容的页面）
- CDP 与已开 DevTools 的**互斥报错**路径
