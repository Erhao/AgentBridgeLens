# AgentBridgeLens Privacy Policy

Effective date: 3 November 2026. This policy covers the AgentBridgeLens Chrome extension and its companion Bridge. Support and privacy requests: [project issue tracker](https://github.com/Erhao/AgentBridgeLens/issues). Do not include private browsing data or credentials in a public issue.


## Purpose and consent

AgentBridgeLens connects an AI coding client to your browser for webpage inspection, debugging, and verification. The extension does not connect to a Bridge until you enable the data-access checkbox and apply the authorization in its popup or side panel. The Bridge defaults to 127.0.0.1:19222; you can configure another host, port, and token.


## Data accessed


- Open tab titles, URLs and target selection; webpage text, DOM attributes, accessibility information, styles, layout, performance metrics, and screenshots when requested by the connected client.
- Diagnostic logs, errors and network request metadata such as URLs, methods, status codes and timings. Lightweight capture starts when the content script loads and keeps bounded buffers in page memory; detailed Debugger network capture starts on request. Data is returned to the Bridge when requested.
- Clicks, scrolling, selectors and entered form values during an explicitly started recording. Recording is not enabled by default. Form values, page contents, logs, URLs and screenshots can contain personal or sensitive information. Do not record passwords, payment details or other secrets.
- JavaScript expressions and interaction sequences supplied by your connected AI client, their results, and source information used for debugging. JavaScript execution uses the Chrome Debugger API and can read or modify the target page.
- Bridge host, port, token, consent setting and tab-selection preferences. The Bridge token is a credential stored locally by the extension and sent to the configured Bridge for authentication.


## Use and transmission

The extension uses this data only to provide its browser-debugging features. Requested results are sent over WebSocket to the Bridge you configure, which relays them to the connected MCP/AI client. The Bridge can run on your computer or another machine. Your AI client may send results to its model provider; that provider's processing and retention depend on your client, provider and settings. Source-map tracing can fetch scripts and source maps from the URLs in supplied error stacks.

The extension contains no developer-operated analytics, advertising, data-sale or model-training endpoint. It does not sell user data, use or transfer it for advertising, creditworthiness or lending, or use it for unrelated profiling. It does not automatically send browser data to the project maintainers. Data received by your chosen Bridge or AI client remains subject to those services' policies.


## Storage and control

Connection settings, the consent setting and global preferences use Chrome local extension storage. Pinned tabs and per-tab policies use session storage. Diagnostic buffers and activity records use runtime memory. Closing a page clears its content-script buffers; service-worker restart clears its runtime records. Stopping Debugger capture detaches it but does not immediately erase previously buffered requests. Recordings returned to clients may remain in those clients.

You can revoke consent in the popup or side panel by unchecking the authorization and applying it; this closes the Bridge connection and prevents reconnection. Stop any active recording and Debugger capture separately, or disable the extension to stop all extension activity. Uninstalling removes the extension's own settings. Revocation or uninstalling cannot delete copies already sent to a Bridge, AI client or provider; use that service's deletion controls.


## Security and limited use

Use only trusted Bridges and AI clients and avoid sensitive pages. Same-computer communication uses a local WebSocket. The extension uses ws:// connections; use an authenticated encrypted tunnel for connections across untrusted networks. The connection token is transmitted to your configured Bridge, not to the project maintainers.

AgentBridgeLens's use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used and transferred only as needed for the disclosed debugging purpose. Maintainers do not routinely receive or read browsing data. If you voluntarily provide diagnostic data for support, share only the necessary information with explicit consent.


## Changes

Updates to data practices will be reflected in this policy and the extension's disclosures. New or expanded sensitive-data uses require appropriate disclosure and consent.


## 中文说明

AgentBridgeLens 用于让 AI 编程客户端检查和调试网页。扩展需先获得你在弹窗或侧边栏中的明确授权，才会连接你配置的 Bridge。AI 请求的标签页信息、网页内容、截图、日志和调试结果会经 Bridge 传给 AI 客户端，并可能由客户端发送给其模型服务商。录制默认关闭，启动后会记录点击、滚动及表单输入值，请勿录制密码或其他敏感信息。

轻量日志、网络及性能采集随内容脚本加载开始，仅在内存保留；详细网络调试按请求开启。连接配置和授权保存在本机。取消勾选并应用授权设置可断开 Bridge；已开启的录制和调试需另行停止，或通过停用扩展全部停止。已经传出的数据需通过相应 Bridge、AI 客户端或服务商删除。

扩展没有开发者运营的广告或分析上传接口，不出售数据，不将数据用于广告、信用评估或无关画像。跨不可信网络请使用经过认证的加密隧道。支持与隐私咨询请使用上方项目支持链接，勿在公开问题中提交个人数据或凭证。数据处理细节以本页完整英文政策为准。
