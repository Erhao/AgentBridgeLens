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

## 指定操作哪个标签页（多窗口 / 多标签 / 多 tab 同时跟踪）

默认操作「当前激活的标签页」。如果你开了很多窗口、很多标签页并频繁切换，可以**固定一个目标标签页**——固定后无论你怎么切，agent 都操作那一个：

- **手动固定**：点扩展图标 → 「目标标签页」区 → 在列表里点某个标签页的「设为目标」。固定后该行显示 🎯。「取消固定」回到跟随激活。
- **让 agent 固定**：跟 Claude 说「列一下我打开的标签页」→ 它调 `list_tabs` 列出来 →「盯住那个标题含 *结账* 的」→ 它 `set_target_tab` 固定。
- **新标签策略**（弹窗里可选）：`不跟随`(默认) / `自动跟随目标页打开的新标签`。

**多 tab 同时跟踪**：每个工具都能带 `tabId`，agent 可以同时盯多个标签页。比如支付流程——
> 我在下单页点支付，会弹出支付页。你同时盯着这两个页：支付页看支付状态，下单页等它支付完刷新。

agent 会 `list_tabs` 拿到两个 tabId，分别对它们截图/查 DOM/抓网络，互不干扰。后台标签页也能读 DOM、抓网络、截图（后台截图走 CDP，会闪一下调试横幅）。

> 注意：要让 agent 在你不切前台的情况下盯某个标签页，那个标签页得是扩展安装/刷新**之后**打开或访问过的（content script 才注入）；很久以前就开着的旧标签页，刷新一次即可。

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

## 跨机使用（Bridge 和浏览器不在同一台机器）

典型场景：Bridge 跑在远端开发机 / 服务器（比如 VAW 的 Bridge 机器）上，而你装扩展的 Chrome 在自己的笔记本上。默认 Bridge 只监听 `127.0.0.1`，扩展连不上，需要两步打开跨机：

> ⚠️ 安全提示：一旦监听 `0.0.0.0`，这条「控制浏览器」的通道就暴露在网络上了。**必须同时设置 `BRIDGELENS_TOKEN`**，否则同网段任何人都能操控你的浏览器。Bridge 在没设 token 却监听非回环地址时会打印 WARNING。

1. **Bridge 侧**：在 MCP 配置（VAW 里就是「自定义 MCP Server」的 `env` 字段）加两个环境变量：
   ```json
   {
     "mcpServers": {
       "bridgelens": {
         "command": "node",
         "args": ["/home/xinyu/space/AgentBridgeLens/packages/bridge/dist/index.js"],
         "env": {
           "BRIDGELENS_HOST": "0.0.0.0",
           "BRIDGELENS_TOKEN": "随便一串够长的随机密钥"
         }
       }
     }
   }
   ```
2. **扩展侧**：点工具栏的 AgentBridgeLens 图标：
   - **Host** 填 Bridge 机器在你这边能访问到的 IP（如 `10.0.0.246`）
   - **Port** 与 Bridge 一致（默认 `19222`）
   - **Token** 填和 `BRIDGELENS_TOKEN` 完全相同的值
   - 点「保存并重连」，顶部显示「已连接」即通。

token 不匹配时 Bridge 会拒绝连接（关闭码 1008），扩展弹窗会一直停在「未连接」。

---

## 把扩展装到其他机器（不上架 Web Store）

在本机一键打包：

```bash
pnpm zip   # 在仓库根目录；会先 build 再把 dist/ 打成 agentbridgelens-extension.zip
```

把生成的 `agentbridgelens-extension.zip` 拷到目标机（U 盘 / scp / 网盘均可），对方：

1. 解压 zip 到一个目录
2. `chrome://extensions/` → 开发者模式 → **加载已解压** → 选解压出的目录（里面有 `manifest.json`）

> - zip 是自包含的，目标机**不需要** node / 源码 / 构建。
> - 开发者模式扩展每次启动会弹一次「停用开发者模式扩展程序」提示，忽略即可。
> - 每台机器要在扩展弹窗里**各自填 Host/Port/Token**（配置存本机，不随 zip 走）。
> - `.crx` 自安装在普通 Chrome 已被禁用；要免开发者模式提示 + 自动更新需走企业策略下发。

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

## 功能全集：什么场景用什么、怎么用

下面把 29 个能力按 **6 类场景** 分组。**你不需要记工具名**——用自然语言描述你想干嘛即可，Claude 会自己挑工具。每组给了「典型场景 + 你可以这么说」的多个例子。

> 通用前提：要操作的页面**停在前台标签页**；截图/裁剪、视觉标注等都作用于「当前激活的那个标签页」。

---

### 一、看页面 / 抓现状（最常用）

**场景**：让 Claude 先「看到」页面长什么样、结构如何、某个元素的具体样式。

| 你可以这么说 | 背后用到 |
|------|------|
| 「截一张当前页面的图」 | `capture_screenshot` |
| 「只截一下这个报错横幅 `.error-banner` 给我看」 | `capture_screenshot`（带 selector，自动滚动到该元素并裁剪） |
| 「当前是什么页面？标题和 URL」 | `get_page_info` |
| 「把页面的 DOM 结构给我看看，重点看导航栏 `nav`」 | `get_dom_snapshot` |
| 「检查 `.submit-btn` 的样式——它的字号、间距、是不是被 `display:none` 了」 | `inspect_element` |
| 「这个页面的无障碍结构怎么样？有没有缺 label 的按钮」 | `get_accessibility_tree` |

**例**：
> 截图看看这个卡片为什么右边被切了，顺便检查一下 `.card` 的 overflow 和宽度。

---

### 二、定位 Bug：从界面一路查到代码（核心卖点）

**场景**：界面有问题，要从「看到的现象」一路定位到「源码哪一行」。这是 BridgeLens 区别于截图工具的核心。

| 你可以这么说 | 背后用到 |
|------|------|
| 「这个按钮是哪个组件渲染的？在哪个文件第几行」 | `trace_element_to_source`（React/Vue **开发构建**才有文件+行号） |
| 「这个标题的字体颜色是从哪个 CSS 文件来的」 | `trace_style_to_source` |
| 「控制台这条报错堆栈，帮我还原到源码行号」 | `trace_error_to_source`（经 source map） |
| 「页面控制台有没有报错？只看 error」 | `get_errors` / `get_console_logs` |

**例（端到端）**：
> 这个提交按钮点了没反应。先看控制台有没有报错，定位到是哪个组件、哪一行，然后直接改源码修掉。

Claude 的典型路径：`get_errors` 看报错 → `trace_error_to_source` / `trace_element_to_source` 定位到组件文件行号 → 直接读你本地源码 → 给出修复。

> 💡 `trace_element_to_source` 要返回真实文件+行号，需要页面是 **React/Vue 的开发构建**（dev server）。生产构建拿不到组件来源，会提示「未发现来源」。

---

### 三、网络与控制台：查接口、查日志

**场景**：界面数据不对、接口报错、想看某个请求的状态。

| 你可以这么说 | 背后用到 |
|------|------|
| 「页面刚才发了哪些请求？有没有 4xx/5xx」 | `get_network_requests`（轻量，只抓扩展注入后发出的） |
| 「用 CDP 抓全量网络，我刷新一下页面，看完整的请求列表和耗时」 | `start_cdp_network` → 刷新 → `get_cdp_network` → `stop_cdp_network` |
| 「控制台最近 20 条日志给我」 | `get_console_logs` |

> 两种抓网络的区别：`get_network_requests` 轻量、无横幅，但**只能抓到扩展注入之后**发出的请求（页面早就加载完的抓不到）；`start_cdp_network` 用 Chrome 调试协议，能抓**完整**请求（含已加载的、响应状态、耗时），但会显示「正在调试此标签页」横幅，且与已打开的 DevTools 互斥。要查页面初始加载的请求，用 CDP 那套。

**例**：
> 列表数据是空的。开 CDP 抓包，我刷新页面，你看看拉数据那个接口返回了啥。

---

### 四、在页面上「画东西」：可视化标注

**场景**：让 Claude 把它的判断**画在页面上**，你一眼确认；或排查布局/响应式问题。

| 你可以这么说 | 背后用到 |
|------|------|
| 「把你说的那个元素在页面上高亮出来，我确认是不是它」 | `highlight_element` / `clear_highlights` |
| 「把这次改动影响的几个元素都用红框圈出来」 | `mark_elements` |
| 「页面上有哪些内容被 overflow 截断了？标出来」 | `visualize_layout` |
| 「叠一个 375px 手机宽度的框，看哪些元素会溢出」 | `show_responsive_frame` |
| 「把刚才的标注都清掉」 | `clear_overlays` |

**例**：
> 我说的「价格不对齐」是指右侧这三个卡片。你先把它们高亮出来让我确认，确认后再查为什么不对齐。

---

### 五、复现与回归：录制 / 回放操作

**场景**：bug 要走几步才能复现；或修完想确认「同样的操作」现在正常了。

| 你可以这么说 | 背后用到 |
|------|------|
| 「开始录制，我来操作复现一下这个 bug」 | `start_recording` |
| 「我操作完了，停止录制」 | `stop_recording`（返回点击/输入/滚动序列） |
| 「把刚才录的操作在页面上重放一遍，看现在还出不出问题」 | `replay_actions` |

**例（复现 → 修 → 回归）**：
> 这个 bug 要先在搜索框输入再点筛选才会出现。我录一遍给你 → 你照着定位修 → 修完把这段操作重放，确认不再复现。

---

### 六、协作与状态：确认面板 / HUD / 性能

**场景**：Claude 改东西时想跟你确认意图；或让你实时看到它在干嘛。

| 你可以这么说 | 背后用到 |
|------|------|
| 「拿不准就在侧边栏问我，给我选项点」 | `request_user_confirmation`（**需打开扩展侧边栏 Side Panel**） |
| 「在页面角上显示你当前在做什么」 | `show_hud` / `update_hud` / `hide_hud` |
| 「这页性能怎么样？FCP/LCP/CLS、内存」 | `get_performance_metrics` |
| 「在页面上跑一小段 JS，把 `window.__APP_STATE__` 打出来」 | `execute_js`（严格 CSP 页会自动回退到 CDP 执行，可能闪一下调试横幅） |

**例**：
> 这个间距我有两种改法。你在侧边栏给我「方案 A / 方案 B」两个按钮，我点了你再改。

---

## 串起来的完整案例

> **场景**：用户报「下单页提交按钮点了没反应」，你在本地跑着这个项目的 dev server。

对 Claude 说：
> 下单页提交按钮点了没反应。页面我开好了在前台。你查一下到底卡在哪，定位到代码改掉，改完让我确认。

Claude 可能这样走：
1. `get_page_info` 确认在下单页
2. `highlight_element` 把提交按钮高亮 → 在侧边栏 `request_user_confirmation` 问你「是这个按钮吗？」
3. `get_errors` 看点击有没有抛错；`start_cdp_network` + 你点一次按钮 + `get_cdp_network` 看有没有发请求、什么状态
4. `trace_element_to_source` 把按钮定位到 `src/pages/Checkout/SubmitButton.tsx:42`
5. 直接读源码 → 发现 `onClick` 没绑定 → 改掉
6. `replay_actions`（或让你再点一次）验证；`mark_elements` 圈出改动区域
7. 侧边栏 `request_user_confirmation` 问你「修好了，这样对吗？」

你全程只需要：页面停前台、点几下确认、看高亮对不对。
