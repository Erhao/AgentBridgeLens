# 项目协作约定

## 发布与插件安装包

- 默认通过 GitHub Actions 构建，并通过 GitHub Releases 发布和交付插件安装包。用户说“发版”“发布”“给安装包”时，按此流程执行。
- 除非用户专门要求本地构建插件安装包，否则不要在本地运行 `pnpm zip`、插件打包脚本或正式发布构建，也不要把本地 ZIP 作为交付物。类型检查和单元测试可正常执行；浏览器验证需要扩展产物时，优先使用对应提交的 GitHub Actions 构建制品。
- 提交前同步远端，保留主分支已有功能；推送后跟踪 Actions，确认 Release、版本和附件均已生成，再向用户提供 GitHub 下载链接。
- 扩展和 Bridge 分别发版。改动涉及 AI 工具入口时，同时检查是否需要更新 Bridge；不要以扩展发布成功代替 Bridge 或 npm 发布成功。
- 具体流程见 [扩展发布文档](docs/RELEASING.md) 与 [Bridge 发布文档](docs/BRIDGE-RELEASE.md)。

## 跨平台代码边界

- 公共协议在 `packages/protocol`，连接与请求生命周期在 `packages/runtime`，桌面适配在 `packages/desktop`；MCP 服务只在 `packages/bridge` 创建。
- 原生源码在 `platforms/{macos,windows,linux}`，不要将源文件重新放进 Bridge 的产物目录。`packages/bridge/linux-agent` 与 `windows-agent` 为构建或发布暂存目录。
- 内部 workspace 包保持 private，Bridge 构建必须内联它们；发布前在工作区外测试实际安装包。
- 安装包、Bridge 压缩包、构建清单和校验文件进入 Gitea Generic 制品库；Actions 附件用作构建记录。正式 Bridge npm 与扩展 GitHub 发布流程保持独立。
- 平台接口不支持的操作明确返回能力错误。原生权限、焦点和引用检查必须留在执行端，不能只依赖 Node 层。
