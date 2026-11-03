# 扩展自动发布

GitHub Actions 在推送到 `main` 时运行类型检查、桥接服务测试和发布测试。
通过后，semantic-release 根据上次 `extension-v*` 标签之后的 Conventional Commits
计算版本，生成发布说明和标签，构建扩展并上传到 GitHub Releases：

- `agentbridgelens-extension-X.Y.Z.zip`
- `agentbridgelens-extension-X.Y.Z.zip.sha256`

下载地址：[GitHub Releases](https://github.com/Erhao/AgentBridgeLens/releases/latest)。
下载 ZIP 后解压，在 `chrome://extensions` 开启开发者模式，加载解压目录。
升级时覆盖原目录并重新加载扩展。

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
pnpm release:dry-run
```

`release:dry-run` 需要具有仓库权限的 `GITHUB_TOKEN`，会检查远程权限和计算版本，
不创建标签、不构建或上传正式安装包。不要在本地运行普通 `pnpm release`，
正式发布由 CI 完成。
