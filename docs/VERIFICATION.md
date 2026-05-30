# 待验证清单（Browser Verification Checklist）

> 以下功能**已实现、通过类型检查和构建**，但**尚未在真实 Chrome 浏览器里验证过**（开发者无 GUI 环境，无法实际加载扩展跑页面）。
> 等功能开发告一段落后，按此清单逐项在浏览器里验证。验证通过的打 ✅，有问题的记录现象。

验证前置：`pnpm build` → `chrome://extensions/` 重新加载扩展 → 准备一个测试页面（建议含 React/Vue dev server 的页面）。

> ⚠️ **重要**：MCP 里运行的 Bridge 由 Claude Code 启动，工具集在启动时注册。改了 bridge 代码后必须 **重新 `pnpm build` 并重启 Claude Code**，否则跑的还是旧版（旧版只有 9 个工具）。

## 验证发现（findings）

- **F1｜`execute_js` 在严格 CSP 页面失效**：content script 里用 `new Function` 求值，会被页面 `script-src`（无 `unsafe-eval`）拦截，报 CSP 错误。彻底修复需改用 CDP `Runtime.evaluate`（经 chrome.debugger，可绕过页面 CSP）。已在 2026-05-30 于 JetBrains 博客页复现。**状态：待修。**
- **F2｜`get_network_requests` 对已加载页面返回空**：注入式捕获只抓 content script 加载之后的 fetch/XHR；页面在扩展注入前已加载完则为空。属设计限制，Phase 2 的 `start_cdp_network` 可覆盖。**状态：已知限制，文档说明即可。**
- **F3｜`hide_hud` 偶发 InputValidationError**：首次调用在 harness 校验层被拒，再次调用（在 chrome:// 页）变为正常的 content-script 超时。疑为偶发，非持久 bug。**状态：待回到正常页复测确认。**
- **F4｜断线后不自动重连（已修）**：MV3 Service Worker 闲置 ~30s 休眠，基于 `setTimeout` 的重连定时器随之失效，导致每次都要手动点扩展图标唤醒才重连。**修复：用 `chrome.alarms`（0.5min）周期唤醒 SW 并 `connect()`，断线后自动恢复。已加 `alarms` 权限。状态：已修，待验证。**
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
| `get_cdp_network` | start 后刷新页面，返回完整请求（含 status/耗时/失败） | ⚠️ 结构正常但 count=0；**待刷新页面触发真实请求再验** |
| `stop_cdp_network` | 调试横幅消失，debugger 解除 | ✅（detached） |
| CDP 与 DevTools 互斥 | 已开 DevTools 时 start 应报错而非崩溃 | ⬜ |

## Phase 3 — Source Map 代码定位（已部分验证 @2026-05-30）

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `trace_element_to_source`（生产/无框架页） | 应优雅返回提示而非报错 | ✅（正确返回「未发现 React/Vue」） |
| `trace_element_to_source`（React dev） | 返回正确组件文件+行号 | ⬜ 需 React dev 页面 |
| `trace_element_to_source`（Vue dev） | 返回 `__file` | ⬜ 需 Vue dev 页面 |
| `trace_style_to_source` | 返回元素匹配的 CSS 规则及所属样式表 | ✅（命中 h1 规则，匹配 font-size） |
| 跨域样式表 | 应标注「跨域不可读」而非崩溃 | ⬜（本页未触发跨域分支） |
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
| `hide_hud` | 面板消失 | ❌ 见 F3（调用被校验层拒绝） |
| `start_recording`/`stop_recording` | 录制点击/输入/滚动，返回 action 序列 | ⬜ 需用户在页面操作 |
| `replay_actions` | 把序列在页面回放，控件状态变化正确 | ⬜ 需先录制 |
| Side Panel 连接状态 / 活动日志 | 打开侧栏显示已连 + 每次调用新增日志 | ⬜ 需用户打开侧栏 |
| `request_user_confirmation` | 侧栏弹出问题+按钮，点击后 agent 收到选择 | ⬜ 需用户打开侧栏并点选 |

> 注意：`request_user_confirmation` 依赖 Side Panel 处于打开状态（扩展无法在无用户手势时强行打开侧栏）。WS 调用超时已从 30s 放宽到 120s 以容纳人工确认与长回放。
