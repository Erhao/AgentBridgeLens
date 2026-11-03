# AgentBridgeLens Chrome Web Store 上架资料

此资料对应 Chrome Web Store 1.0.1 候选包，源码引用为 `chrome-store-candidate-1.0.1`。提交前需确认公开支持信息，并在 Chrome 开发者后台核对隐私勾选项。源码保留开发版本 0.1.0；候选 ZIP 的构建产物 manifest 使用 1.0.1，高于现有 GitHub 版本 1.0.0。

## 商店条目

- 名称：AgentBridgeLens
- 类别：Developer Tools
- 语言：English；界面主要使用简体中文，详情应明确这一点。
- 网站：https://github.com/Erhao/AgentBridgeLens
- 支持：https://github.com/Erhao/AgentBridgeLens/issues
- 收费：免费；用户配置的 AI 服务可能另行收费。
- 简介：Connect your AI coding client to Chrome for webpage inspection, screenshots, and debugging through your own Bridge.
- 图标：`packages/extension/public/icons/icon128.png`
- 隐私政策源文件：`packages/extension/public/privacy.html`；随包可通过扩展的 Privacy policy 链接访问；相同内容的仓库文档为 `docs/PRIVACY.md`。
- 公开隐私政策 URL：https://github.com/Erhao/AgentBridgeLens/blob/chrome-store-candidate-1.0.1/docs/PRIVACY.md （该 tag 发布后需验证无登录可读）。
- 商店截图：`release/chrome-store/screenshot-debugging.png`，1280×800，由真实扩展在独立测试浏览器中对仓库示例页面截图；不是用户个人浏览器的截图。

### English detailed description

AgentBridgeLens connects your AI coding client to your real Chrome browser through a companion Bridge, helping you inspect and debug the webpages you choose.

Inspect page structure, styles, layout and accessibility; capture viewport or element screenshots; examine diagnostic logs and network request metadata; and verify fixes using visual annotations and interaction recording and replay. Source tracing is available where development metadata or source maps are accessible.

Choose target tabs from the extension popup or side panel. Debugging expressions run through the Chrome Debugger API and may display Chrome's debugging banner. The extension can read and modify target pages through requests from the AI client connected to your Bridge.

Setup requires the companion Bridge and an MCP-compatible AI client; the extension alone is not an AI assistant. Setup instructions and Bridge source are available on the linked project website. The default Bridge address is 127.0.0.1:19222. The extension interface is primarily Simplified Chinese.

Before connecting, review the data-access notice and enable the authorization checkbox. Requested webpage content, screenshots and diagnostics are sent to your configured Bridge and connected AI client, which may forward them to its AI provider. Recording, when started, can capture form input values. Use trusted services and avoid sensitive pages. Revoke Bridge authorization in the popup or side panel to disconnect. See the privacy policy for data handling and storage details.

## Single purpose

Connect an MCP-compatible AI coding client to user-chosen browser tabs through a user-configured Bridge so the client can inspect, debug, and verify webpages.

## 权限用途

| 权限 | 可填写的英文说明 |
| --- | --- |
| activeTab | Allows capturing the visible tab after a user invokes the extension. |
| tabs | Displays titles and URLs of open tabs in the target selector and lets the connected client identify the tab the user intends to debug. |
| scripting | Runs packaged inspection functions in the target page to inspect framework source metadata and stylesheet rules, and displays a refresh notice after extension updates. |
| debugger | Implements webpage debugging through Chrome DevTools Protocol: requested network diagnostics, screenshots of background tabs, and AI-client-supplied JavaScript expressions via Runtime.evaluate. Chrome may display a debugging banner. |
| storage | Stores the user-configured Bridge connection and token, explicit connection consent, and target-tab preferences. |
| sidePanel | Provides the extension side panel for Bridge settings, target selection, recent tool activity, and requested confirmations. |
| alarms | Wakes the extension service worker to reconnect to the configured Bridge when the user has enabled connection consent. |
| `<all_urls>` | Enables inspection and debugging of user-chosen webpages on arbitrary development and production origins, including local development sites. Content scripts supply packaged inspection features; requests from the configured Bridge select the target page. Access is not limited to a fixed vendor domain. |

不要把“选为目标”描述成强制的安全隔离：未固定时会跟随激活页，客户端也可显式传 tabId。不要把 host 权限解释成用于任意服务器连接；它主要支持网页访问和注入。

## Remote code 声明

选择使用远程代码，并如实解释 Debugger API 例外；不能因为默认连接 localhost 就选择“不使用”。

The connected user-configured Bridge may provide JavaScript debugging expressions from an MCP/AI client. These expressions execute only through chrome.debugger.sendCommand with Runtime.evaluate in the target webpage. This use supports the extension's disclosed webpage inspection and debugging purpose under the Debugger API exception in the Manifest V3 additional requirements. The extension does not evaluate Bridge-supplied strings with eval or Function in content scripts or extension pages, and does not download executable extension modules. All other extension logic is bundled in the submitted package.

政策：https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

## 隐私申报

按本次实际后台的定义核对每一项，不能一律填写“不收集数据”。默认建议披露：

- Website content：DOM、文本、属性、截图、调试输出。
- Web history：打开的标签页标题、URL 及调试时的请求 URL；不申请 history 权限，也不读取 Chrome 历史数据库。
- User activity：按请求启动录制后的点击、滚动与输入。
- Authentication information：扩展本机保存用户输入的 Bridge token，并传给指定 Bridge；表单录制和网页调试也可能涉及敏感值。即便无开发者自建服务器，也应核对后台该类别定义后如实披露。

网页本身可能含有身份、健康、金融或通信信息；不得宣称自动脱敏或永不访问这些信息。扩展不专门提取这些类别，但调试任意网页时需结合后台说明准确申报。认证三项 Limited Use 声明前核对其完整文字与政策一致。

## 审核员操作步骤

对应源码版本为 `chrome-store-candidate-1.0.1`，应在提交前验证该 tag 可公开访问。

1. Install the submitted extension. The companion Bridge runs on the same computer and needs Node.js 24 and pnpm 10.33.3 for the source-build path below. No paid AI account or account on a developer-operated service is required for this inspection path.
2. Clone https://github.com/Erhao/AgentBridgeLens and run `git checkout chrome-store-candidate-1.0.1`. Run `pnpm install --frozen-lockfile` and `pnpm --filter agentbridgelens build`.
3. In a terminal at the repository root, run `BRIDGELENS_TRANSPORT=http node packages/bridge/dist/index.js`. The MCP endpoint is http://127.0.0.1:19223/mcp and the extension WebSocket endpoint is 127.0.0.1:19222. The Bridge binds to loopback by default.
4. Open the extension popup, read the disclosure, check the consent checkbox and click 应用授权设置 (Apply authorization). Confirm 已连接 (Connected). If needed, open 连接设置, leave Host=127.0.0.1, Port=19222, Token empty for this local-only setup, and click 保存并重连.
5. Open https://example.com in a fresh tab after extension installation. Pin it using 设为目标 (Set target) in the popup.
6. Connect an MCP client supporting Streamable HTTP to http://127.0.0.1:19223/mcp. To inspect without a paid AI service, run `npx @modelcontextprotocol/inspector`, use its local browser UI and session authorization as printed by that tool, select Streamable HTTP, enter the endpoint, and connect. Follow that tool's current prompts; do not expose either local service to the internet.
7. List tools and call `get_page_info`, `get_dom_snapshot`, `capture_screenshot`, and `inspect_element` with selector `h1`. Results should describe Example Domain. Keep the test tab active for the screenshot.
8. Call `execute_js` with `code: "document.title"`. Chrome may show a debugging banner. The returned value should be Example Domain.
9. Call `start_cdp_network`, reload the test page, and call `get_cdp_network` followed by `stop_cdp_network`. This should return request metadata and then detach debugging.
10. Uncheck and apply consent in the popup; the connection should close and remain closed. Do not perform input recording on login, payment, or other sensitive pages.

No login credentials are required by the extension or the local Bridge. The project issue tracker is the support channel.

## 提交前检查

- [ ] 确认开发者账号注册、联系邮箱验证及后台要求的身份验证已完成。
- [ ] 公开隐私政策，验证无登录可读取；补充公开支持邮箱（如果后台需要）。
- [ ] 取得至少一张真实运行截图，使用 1280×800 或 640×400，且不含私人标签页、密钥或个人数据。
- [ ] 在真实 Chrome 中验证授权、撤销、检查网页、截图及执行表达式；仅构建通过不能代替浏览器验证。
- [ ] 将本次对应的源码 commit 或 tag 写入审核说明；验证上述 Bridge 复现路径。
- [ ] 上传候选 ZIP，核对版本、权限和隐私声明，选择公开分发，提交审核。
- [ ] 记录商店 item ID、提交时间、审核状态及正式商店 URL。只有后台显示发布成功后才报告已上架。

## 本地浏览器验证

`scripts/store/verify-chrome.mjs` 使用独立临时浏览器配置和仅监听本机的测试服务，验证授权前不连接、授权后连接、撤销和重连定时器、隐私页、目标标签页、DOM 检查、Debugger 执行及错误清理、网络诊断、1280×800 截图。运行前先执行 `pnpm zip`，另行安装 Playwright 并设置 `ABL_PLAYWRIGHT_MODULE` 指向其 `index.mjs`；如需要，可用 `ABL_CHROMIUM_EXECUTABLE` 指定支持扩展的 Chromium 可执行文件。运行 `node scripts/store/verify-chrome.mjs` 后，结果和截图在 `release/chrome-store/`。这些验证不代表 Google 商店已审核通过。
