# 扩展自动发布

## 默认交付约定

按用户要求，本项目之后一律通过 GitHub Actions 构建、通过 GitHub Releases 发版和交付插件安装包。只有用户专门要求本地构建安装包时，才在本地运行 `pnpm zip` 或插件打包脚本；不要默认生成本地 ZIP，也不要把本地打包当作发版完成。类型检查和单元测试可在本地执行；浏览器验证所需扩展产物优先下载对应提交的 Actions 构建制品。

发版前同步远端并整合已有更新；推送后跟踪 Actions，确认版本、Release 与附件实际生成，再提供 GitHub 下载链接。扩展与 Bridge 分别发版，需要更新 AI 工具入口时同时发布相应 Bridge。协作入口见 [AGENTS.md](../AGENTS.md)。

## 自动发布流程

GitHub Actions 在推送到 `main` 时运行类型检查、桥接服务测试和发布测试。
通过后，semantic-release 根据上次 `extension-v*` 标签之后的 Conventional Commits
计算版本，生成发布说明和标签，构建扩展并上传到 GitHub Releases：

- `agentbridgelens-extension-X.Y.Z.zip`
- `agentbridgelens-extension-X.Y.Z.zip.sha256`
- `agentbridgelens-updater.zip`（固定目录更新工具，含 Windows / macOS / Linux 入口）
- `agentbridgelens-updater.zip.sha256`

下载地址：[GitHub Releases](https://github.com/Erhao/AgentBridgeLens/releases/latest)。
下载 ZIP 后解压，在 `chrome://extensions` 开启开发者模式，加载解压目录。
升级时推荐使用更新工具替换原目录，再点击原插件的「重新加载」。更新工具通过 GitHub 最新正式版接口下载版本匹配的安装包与 SHA256；校验和结构检查通过后才切换目录，保留一个相邻的 `.abl-backup` 备份。首次应填写已安装插件的原目录，不更改扩展 ID，不读取或迁移 Chrome 存储。不要卸载后重装。

## 提交与版本

| 提交 | 版本变化 |
| --- | --- |
| `fix: ...`、`perf: ...` | 修订号，例如 1.0.0 → 1.0.1 |
| `feat: ...` | 次版本，例如 1.0.0 → 1.1.0 |
| 提交正文包含 `BREAKING CHANGE: ...` | 主版本，例如 1.0.0 → 2.0.0 |
| 仅 `docs:`、`chore:`、`test:`、`ci:` 等 | 不发布 |

使用默认 Angular 提交解析规则，破坏性变更请写明 `BREAKING CHANGE:` 正文。
Squash 合并时，最终提交标题和正文必须保留这些信息。
首次没有发布标签且存在应发布的提交时，版本从 `1.0.0` 开始。
当前规则分析整个仓库的提交；桥接服务的 `fix:` / `feat:` 也会触发扩展发布。

正式发布只允许 `main`。版本会在 CI 构建前同时写入扩展的 `package.json` 和
`src/manifest.json`，并校验产物 manifest。源码中的开发版本不自动回写提交；
正式版本以发布标签和安装包中的 manifest 为准。Chrome 的三段版本每段不得超过
65535，不支持预发布后缀，越界会阻止发布。

## CI 配置

使用 Node.js 24 和根目录 `packageManager` 指定的 pnpm。
发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，仅发布任务授予 `contents: write`，
无需 npm、GitLab 或额外 PAT。仓库策略须允许 Actions 写入内容及创建发布标签。
CI 不向 issue 或 PR 发送发布通知。

更新工具的核心测试（包括 HTTP/SOCKS5 代理、HTTPS CONNECT 与发布附件重定向）额外在 Linux、Windows、macOS 三个平台运行，均通过后才允许发布。

PR 只校验和上传普通构建制品；推送 `main` 或在 `main` 上手动运行 workflow 才发布。
没有需发布的提交时不创建新版本。正式安装包及校验文件长期保存在 Releases；
Actions 中普通构建制品保留 14 天，发布制品与说明保留 30 天。
普通构建使用源码开发版本，发布制品使用 semantic-release 计算的版本。
发布任务串行执行，不中断正在进行的发布。

本地验证：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --dir packages/bridge test
pnpm test:release
pnpm test:updater
pnpm release:dry-run
```

`release:dry-run` 需要具有仓库权限的 `GITHUB_TOKEN`，会检查远程权限和计算版本，
不创建标签、不构建或上传正式安装包。不要在本地运行普通 `pnpm release`，
正式发布由 CI 完成。

可选的真实 Chrome 升级与回滚验证（将对应提交的 GitHub Actions 插件构建制品解压到 `packages/extension/dist/`；Playwright 可独立安装）：

```bash
ABL_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/update/update-extension.browser.mjs
```

可用 `ABL_CHROMIUM_EXECUTABLE` 指定 Chromium。该验证使用独立 Chrome 配置，检查原目录更新、重新加载和回滚后扩展 ID、桥接服务、Token 及显示偏好保持不变。
