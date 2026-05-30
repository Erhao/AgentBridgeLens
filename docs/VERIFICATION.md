# 待验证清单（Browser Verification Checklist）

> 以下功能**已实现、通过类型检查和构建**，但**尚未在真实 Chrome 浏览器里验证过**（开发者无 GUI 环境，无法实际加载扩展跑页面）。
> 等功能开发告一段落后，按此清单逐项在浏览器里验证。验证通过的打 ✅，有问题的记录现象。

验证前置：`pnpm build` → `chrome://extensions/` 重新加载扩展 → 准备一个测试页面（建议含 React/Vue dev server 的页面）。

> ⚠️ **重要**：MCP 里运行的 Bridge 由 Claude Code 启动，工具集在启动时注册。改了 bridge 代码后必须 **重新 `pnpm build` 并重启 Claude Code**，否则跑的还是旧版（旧版只有 9 个工具）。

## 验证发现（findings）

- **F1｜`execute_js` 在严格 CSP 页面失效**：content script 里用 `new Function` 求值，会被页面 `script-src`（无 `unsafe-eval`）拦截，报 CSP 错误。彻底修复需改用 CDP `Runtime.evaluate`（经 chrome.debugger，可绕过页面 CSP）。已在 2026-05-30 于 JetBrains 博客页复现。**状态：待修。**
- **F2｜`get_network_requests` 对已加载页面返回空**：注入式捕获只抓 content script 加载之后的 fetch/XHR；页面在扩展注入前已加载完则为空。属设计限制，Phase 2 的 `start_cdp_network` 可覆盖。**状态：已知限制，文档说明即可。**

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

## Phase 2 — CDP 采集补全

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `get_performance_metrics` | 返回 navigation timing / FCP / LCP / CLS / 内存 | ⬜ |
| `get_accessibility_tree` | 返回带 role/name 的简化无障碍树 | ⬜ |
| `start_cdp_network` | 调用后标签页出现「DevTools 调试」横幅 | ⬜ |
| `get_cdp_network` | start 后刷新页面，返回完整请求（含 status/耗时/失败） | ⬜ |
| `stop_cdp_network` | 调试横幅消失，debugger 解除 | ⬜ |
| CDP 与 DevTools 互斥 | 已开 DevTools 时 start 应报错而非崩溃 | ⬜ |

## Phase 3 — Source Map 代码定位

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `trace_element_to_source`（React） | 在 React dev 页面对元素调用，返回正确组件文件+行号 | ⬜ |
| `trace_element_to_source`（Vue） | 在 Vue dev 页面验证返回 `__file` | ⬜ |
| `trace_element_to_source`（生产构建） | 应优雅返回「无 _debugSource」提示而非报错 | ⬜ |
| `trace_style_to_source` | 返回元素匹配的 CSS 规则及所属样式表 href | ⬜ |
| 跨域样式表 | 应标注「跨域不可读」而非崩溃 | ⬜ |
| `trace_error_to_source` | 传入含 sourcemap 的 bundle 堆栈，还原到原始 .tsx/.vue 行号 | ⬜ |
| `trace_error_to_source`（无 map） | 应标注「无 source map」而非崩溃 | ⬜ |

## Phase 4 — 交互增强

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| `mark_elements` | 传一组 selector，页面出现红框标注 | ⬜ |
| `visualize_layout` | 圈出 overflow 截断的元素（橙色虚线框） | ⬜ |
| `show_responsive_frame` | 叠加目标宽度蓝框 + 列出更宽元素 | ⬜ |
| `clear_overlays` | 清除上述所有叠加层 | ⬜ |
| `start_recording`/`stop_recording` | 录制点击/输入/滚动，返回 action 序列 | ⬜ |
| `replay_actions` | 把序列在页面回放，控件状态变化正确 | ⬜ |
| `show_hud`/`update_hud`/`hide_hud` | 右下角面板出现/更新文字/消失 | ⬜ |
| Side Panel 连接状态 | 打开侧边栏显示「已连接」 | ⬜ |
| Side Panel 活动日志 | agent 每次调工具，侧栏日志新增一行 | ⬜ |
| `request_user_confirmation` | 侧栏弹出问题+按钮，点击后 agent 收到选择 | ⬜ |
| 确认面板未开侧栏 | 侧栏没打开时调用应在 120s 后超时（已知限制） | ⬜ |

> 注意：`request_user_confirmation` 依赖 Side Panel 处于打开状态（扩展无法在无用户手势时强行打开侧栏）。WS 调用超时已从 30s 放宽到 120s 以容纳人工确认与长回放。
