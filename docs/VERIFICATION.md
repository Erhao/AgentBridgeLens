# 待验证清单（Browser Verification Checklist）

> 以下功能**已实现、通过类型检查和构建**，但**尚未在真实 Chrome 浏览器里验证过**（开发者无 GUI 环境，无法实际加载扩展跑页面）。
> 等功能开发告一段落后，按此清单逐项在浏览器里验证。验证通过的打 ✅，有问题的记录现象。

验证前置：`pnpm build` → `chrome://extensions/` 重新加载扩展 → 准备一个测试页面（建议含 React/Vue dev server 的页面）。

## Phase 1 — 通信与基础工具

| 功能 | 验证方法 | 状态 |
|------|---------|------|
| Bridge ↔ 扩展连接 | 启动后扩展弹窗显示「已连接」 | ⬜ |
| 端口可配置 | 弹窗改端口 + MCP 配 `BRIDGELENS_PORT`，仍能连上 | ⬜ |
| `get_page_info` | 返回当前页 URL/标题/viewport | ⬜ |
| `capture_screenshot`（整页） | 返回可视区截图 | ⬜ |
| `capture_screenshot`（元素） | 带 selector，返回裁剪到该元素的图 | ⬜ |
| `execute_js` | 执行表达式返回结果 | ⬜ |
| `get_dom_snapshot` | 返回精简 DOM 树 | ⬜ |
| `inspect_element` | 返回样式/盒模型 | ⬜ |
| `highlight_element` / `clear_highlights` | 页面出现/消失高亮框 | ⬜ |
| `get_console_logs` / `get_errors` | 返回捕获的日志/报错 | ⬜ |
| `get_network_requests` | 返回注入式捕获的请求 | ⬜ |

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
