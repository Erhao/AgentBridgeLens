# 桌面协议

协议定义位于 `packages/protocol`。浏览器 wire v1、原生 wire v1 和桌面公共工具属于不同边界；产品版本号不代替协议版本。

## 入口与引用

公共桌面入口为九个 `desktop_*` 工具。除 capabilities 和 stop 外，调用带 `sessionId`，它绑定执行端进程或原生连接，不是 MCP HTTP 会话。窗口、节点快照和图片引用进一步限制作用域和有效期。

语义动作必须提供 snapshotId 与 target；set_text 还需要 text。坐标动作带 screenshotId 与图片像素 x/y；按键带 screenshotId 和具名 keys。Linux 旧数字 evdev 参数保持兼容，所有平台可用 PRIMARY 表示平台主要修饰键。原生端仍执行最终权限和边界检查。

角色和原生动作仍存在平台差异，不能假设所有按钮暴露同名 action。Mac 保留 rawRole/nativeActions。没有暴露的能力返回 UNSUPPORTED 类错误，不从截图推导出应用内部调试能力。

## 原生传输

Linux/Windows 使用 stdout 为协议、stderr 为日志的 JSON Lines：

```json
{"id":"request-id","tool":"desktop_observe","params":{"sessionId":"s","windowId":"w"}}
```

Mac 保留已发布的 WebSocket 请求封装：

```json
{"type":"request","id":"request-id","tool":"mac_observe","params":{"windowRef":"w"}}
```

Mac 握手包含 `type:hello`、`protocolVersion:1`、deviceId、version 和 capabilities。鉴权后才接受握手；完成握手后才路由工具。deviceId 可持续存在，sessionId 每次连接改变。

两类传输都按 ID 返回 result 或 `{code,message}` 错误。取消采用 `{"type":"cancel","id":"request-id"}`；取消未知或已完成请求被忽略。单请求取消不升级为其他客户端的全局停止。

## 公共请求运行层

PendingRequests 同时按请求 ID 和 socket/子进程对象匹配结果；旧连接迟到的响应不会完成新连接请求。超时、取消、断线和关闭都清理计时器与监听器，不自动重发动作。Mac 和浏览器的消息大小及握手规则独立，传输共享请求生命周期而不强制相同编码。

stop 是显式的执行端操作。Python/C# 的 stdin 读取独立于串行执行队列，Swift 的控制代际独立于 AX 队列；停止能使已经排队的旧工作失效，但无法撤销已派发事件。

## 结果

截图在公共运行层转换成 MCP 图片块，文本结果只保留图片元数据，不重复 Base64。动作统一暴露 accepted/verified；Mac v1 的 dispatched 由适配层映射为 accepted。验证范围以返回的 detail 为准，不推断业务完成。

共享契约测试位于 `tests/contracts`；平台自身的引用、权限和坐标测试保留在各原生目录。
