# AgentBridgeLens 用户使用指南

这份指南面向「我装好了，接下来怎么用」的用户，从零跑通到实际用它调一个页面。

## 它能帮你做什么

简单说：让 Claude Code 能「看见」并操作你**自己浏览器里正在看的那个页面**。

举几个真实场景：
- 「这个按钮样式不对，你看看」——Claude 直接截图、检查元素样式，定位到问题
- 「页面报错了」——Claude 读取你浏览器控制台的真实报错日志
- 「这个接口返回了什么」——Claude 查看页面发出的网络请求
- 「把出问题的元素标出来」——Claude 在页面上画高亮框，你一眼看到它指的是哪个

和 Playwright 这类自动化的区别：它跑在你**真实的、已登录的**浏览器里，不是另起一个干净的无头浏览器。你的登录态、cookie、页面当前状态它都能看到。

---

## 一次性准备（只做一次）

### 1. 构建

```bash
cd ~/space/AgentBridgeLens
pnpm install
pnpm build
```

### 2. 装扩展到 Chrome

1. 打开 `chrome://extensions/`
2. 右上角打开**开发者模式**
3. 点**加载已解压的扩展程序**
4. 选 `~/space/AgentBridgeLens/packages/extension/dist/` 目录

装好后浏览器工具栏会出现 AgentBridgeLens 图标。

### 3. 把 Bridge 告诉 Claude Code

在 Claude Code 的 MCP 配置里加上（路径换成你自己的绝对路径）：

```json
{
  "mcpServers": {
    "bridgelens": {
      "command": "node",
      "args": ["/home/xinyu/space/AgentBridgeLens/packages/bridge/dist/index.js"]
    }
  }
}
```

保存后重启 Claude Code。你**不用**自己去启动 Bridge——Claude Code 会自动把它拉起来。

---

## 每次使用的流程

1. **打开你要调试的网页**（在装了扩展的那个 Chrome 里），让它停在前台标签页。
2. **打开 Claude Code**，正常对话即可。
3. **确认连上了**：点浏览器工具栏的 AgentBridgeLens 图标，弹窗顶部显示「已连接」就说明通了。
4. **直接用自然语言让 Claude 干活**，例如：
   - 「用 bridgelens 截一张当前页面的图」
   - 「用 bridgelens 检查 `.submit-btn` 的样式，看看为什么没居中」
   - 「页面控制台有没有报错？用 bridgelens 看一下」
   - 「把 `.error-banner` 这个元素在页面上高亮出来」

Claude 会调用对应工具，把结果（截图、DOM、日志等）拿回来分析，然后结合它能直接读到的源码，一路定位到具体代码。

---

## 一个完整例子

> 场景：你发现某个页面的提交按钮点了没反应。

你对 Claude 说：

> 提交按钮点了没反应，帮我查一下。当前页面已经在浏览器里打开了。

Claude 大致会这么做：
1. `get_page_info` —— 确认当前在哪个页面
2. `inspect_element` 检查提交按钮 —— 看它的属性、是否被禁用、有没有绑定
3. `get_console_logs` —— 看点击时控制台有没有抛错
4. `get_network_requests` —— 看点击有没有发出请求、返回什么状态
5. `highlight_element` 把按钮高亮 —— 让你确认它定位的就是这个按钮
6. 结合上面信息 + 直接读你本地源码，定位到具体文件和行号，给出修复

全程你只需要：网页停在前台、看 Claude 高亮的元素对不对、确认修复效果。

---

## 改端口（默认 19222 被占用时）

两端都要改成同一个端口：

1. **Bridge 侧**：在 MCP 配置里加 `env`
   ```json
   {
     "mcpServers": {
       "bridgelens": {
         "command": "node",
         "args": ["/home/xinyu/space/AgentBridgeLens/packages/bridge/dist/index.js"],
         "env": { "BRIDGELENS_PORT": "29222" }
       }
     }
   }
   ```
   改完重启 Claude Code。
2. **扩展侧**：点工具栏的 AgentBridgeLens 图标，把 Port 改成 `29222`，点「保存并重连」。

---

## 出问题时怎么排查

| 现象 | 原因 / 解决 |
|------|------------|
| 弹窗显示「未连接」 | Bridge 没起来：确认 Claude Code 已加载 MCP 配置并重启过；确认两端端口一致 |
| Claude 报 `Chrome extension not connected` | 扩展没连上 Bridge：检查扩展是否启用、弹窗端口是否填对，点「保存并重连」 |
| 工具调用超时 | 目标页面不在前台激活标签页；切到该标签页再试 |
| 改了扩展代码后不生效 | 重新 `pnpm build`，再到 `chrome://extensions/` 点该扩展的刷新图标 |
| 看扩展日志 | `chrome://extensions/` → 找到 AgentBridgeLens → 点 **Service Worker** 链接，打开它的控制台 |

---

## 当前能用的工具一览

| 工具 | 你可以这么说 |
|------|------------|
| `get_page_info` | 「当前是什么页面」 |
| `capture_screenshot` | 「截个图」/「截一下 `.card` 这个元素」 |
| `execute_js` | 「在页面上跑一段 JS 看看 xxx 的值」 |
| `get_dom_snapshot` | 「把页面结构给我看看」 |
| `inspect_element` | 「检查这个元素的样式和盒模型」 |
| `highlight_element` / `clear_highlights` | 「把这个元素高亮出来」/「清掉高亮」 |
| `get_console_logs` | 「控制台有报错吗」 |
| `get_network_requests` | 「页面发了哪些请求」 |
| `get_errors` | 「只看报错」 |
| `get_performance_metrics` | 「页面性能怎么样」 |
| `get_accessibility_tree` | 「页面的无障碍结构是怎样的」 |
| `trace_element_to_source` | 「这个元素是哪个组件渲染的，在哪个文件」 |
| `trace_style_to_source` | 「这个样式是从哪个 CSS 文件来的」 |
| `trace_error_to_source` | 「把这个报错堆栈还原到源码行号」 |
| `start_cdp_network` / `get_cdp_network` | 「用 CDP 抓一下网络请求」（会显示调试横幅） |
| `mark_elements` / `visualize_layout` / `show_responsive_frame` | 「把改动的地方圈出来」/「哪里被截断了」/「小屏会不会溢出」 |
| `start_recording` / `replay_actions` | 「录一下我的操作」/「把刚才的操作重放一遍」 |
| `show_hud` / `update_hud` | 「在页面上显示你正在做什么」 |
| `request_user_confirmation` | agent 主动在侧边栏问你「这样改对吗」（需打开侧边栏） |
