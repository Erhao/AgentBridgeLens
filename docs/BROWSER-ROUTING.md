# 多浏览器注册与路由

## 工作方式

每个 Chrome 配置中的插件安装生成一个随机 browserId，写入 chrome.storage.local；不会通过 Chrome 同步到另一台机器。扩展启动和重新连接时，先发注册消息：

```json
{"t":"register_browser","protocolVersion":2,"browserId":"<UUID>","name":"Chrome Linux <短ID>"}
```

Bridge 返回 browser_registered 确认，并维护 browserId 到 WebSocket 的独立映射。不同浏览器可以同时在线；已有在线 ID 的重复注册会被拒绝，不踢掉原连接。同一 ID 离线后可以重新注册。名称用于辨认，ID 才用于路由；复制整个 Chrome 资料目录也会复制身份，此时需要为副本重新生成 browserIdentity。

ID 表示插件安装，不证明主机名、本机归属或权限。仍须配置现有 Token 进行连接鉴权；拥有同一 Token 的调用方仍属于同一信任范围。MSAD 的本机和无痕要求继续单独核对。

## AI 如何选择浏览器

1. 调用 list_browsers，查看 browserId、名称、registered 和 connected。
2. 会话使用固定的 MCP 地址：`http://127.0.0.1:19223/mcp?browserId=<UUID>`。不同会话可以绑定不同 ID；不会改其他会话的目标。
3. 或者在每次浏览器工具调用中传 browserId，例如 get_page_info 的参数为 `{"browserId":"<UUID>","tabId":123}`。单独传 tabId 不足以跨浏览器定位。

stdio 可以用 BRIDGELENS_BROWSER_ID 固定绑定浏览器。HTTP 也可用该变量固定整个服务的目标；请求中的冲突 ID 会被拒绝。固定绑定的会话不能用工具参数临时切换到另一浏览器。注册浏览器即使只有一台在线，也必须明确指定 ID 或使用绑定地址，避免离线后静默换机。

list_browsers 仅列出身份与在线状态，不读取网页内容。命令执行期间还会固定具体连接；如果浏览器重连，旧调用不会自动转到新连接或重放。结果只接受发起请求的同一 WebSocket 返回，其他浏览器即使知道请求 ID 也不能代答。离线只影响该浏览器的请求。


## 旧插件兼容与部署边界

旧插件没有注册消息。Bridge 为其连接分配临时 legacy-* ID；仅首次旧连接且只有它在线时保留原先省略 browserId 的用法。连接变化后不会自动选择其他浏览器。新版本应使用注册身份并明确绑定，不依赖此兼容路径。

该改动需要同时更新 Bridge 和扩展；只更新其中一端不算启用多浏览器路由。修改源码和隔离协议测试不代表当前运行服务或用户 Chrome 已升级。发布分别遵循 RELEASING.md 和 BRIDGE-RELEASE.md，经 Gitea 构建；生产重启、扩展重载会影响其他会话，应在协调后进行。无需添加全机防火墙规则。
