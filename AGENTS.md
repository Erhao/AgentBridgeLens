# 项目协作约定

## 发布与插件安装包

- 默认通过 GitHub Actions 构建，并通过 GitHub Releases 发布和交付插件安装包。用户说“发版”“发布”“给安装包”时，按此流程执行。
- 除非用户专门要求本地构建插件安装包，否则不要在本地运行 `pnpm zip`、插件打包脚本或正式发布构建，也不要把本地 ZIP 作为交付物。类型检查和单元测试可正常执行；浏览器验证需要扩展产物时，优先使用对应提交的 GitHub Actions 构建制品。
- 提交前同步远端，保留主分支已有功能；推送后跟踪 Actions，确认 Release、版本和附件均已生成，再向用户提供 GitHub 下载链接。
- 扩展和 Bridge 分别发版。改动涉及 AI 工具入口时，同时检查是否需要更新 Bridge；不要以扩展发布成功代替 Bridge 或 npm 发布成功。
- 具体流程见 [扩展发布文档](docs/RELEASING.md) 与 [Bridge 发布文档](docs/BRIDGE-RELEASE.md)。
