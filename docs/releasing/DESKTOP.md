# 桌面制品构建与发布

源码主仓为 `Erhao/AgentBridgeLens`，Gitea 的 `xinyu/AgentBridgeLens` 同步相同提交，供内网原生运行器执行构建和 Generic Registry 发布。Mac 不再有独立开发分支或第二份 Node Bridge。

## 组件版本

- Bridge 版本：`packages/bridge/package.json`，独立 `bridge-vX.Y.Z` npm/GitHub 发布流程保持。
- 扩展版本：既有 semantic-release 流程保持独立。
- Mac 版本：`platforms/macos/version.json`、Info.plist 和 BuildInfo，构建检查会校验运行时版本。
- 原生协议：当前为 v1，与上述版本独立。

## GitHub 检查

Linux、Windows、Mac 各有 workflow；公共包改变时运行对应检查。Windows 构建 x64/ARM64 自包含执行端，Bridge 正式 npm 发版仍要求同提交且 PE 架构正确的两份执行端。内部 workspace 包实现被打入 Bridge；使用 pnpm pack 将 workspace 元数据转换为可分发版本。

## Gitea 制品库

`.gitea/workflows/desktop.yml` 使用现有 macos-arm64 运行器，编译 Mac、测试统一 MCP，再发布到 `xinyu` 的 Generic 包 `agentbridgelens` 并关联统一仓库。

main 构建版本为 `<Bridge版本>-dev.<提交短哈希>`；显式 `desktop-v<Bridge版本>` 标签发布对应固定版本。制品含 Mac DMG（内置 Node 和 Bridge）、带生产 Node 依赖的 Bridge 压缩包、BUILD-MANIFEST.json 和 SHA256SUMS。Bridge 包包含 Linux 脚本；Windows 执行端独立构建，使用包内执行端或 BRIDGELENS_WINDOWS_AGENT 指定同提交的二进制，不能将 Mac 构建误称为 Windows 原生交付已完成。

发布凭据为当前 Gitea 仓库的 `PACKAGES_TOKEN` Secret，仅 write:package。发布器先检查仓库关联，避免重复关联错误；逐个回下载文件校验 SHA256。已有版本只有字节完全一致时才允许重跑，不删除或覆盖。关联私有仓库不会自动改变拥有者层面的包可见性。

默认应用采用开发签名，未公证。正式分发时设置 `MAC_SIGN_IDENTITY` 与 `MAC_NOTARY_PROFILE`，构建脚本会签名 Node 和应用、签名并公证 DMG，再装订和验证公证票据。应用身份和配对路径沿用旧版。

旧 `agentbridgemac/0.1.2` 制品保留供历史使用。新的安装包从统一项目的软件包页面取得，不以本地 ZIP 或临时 Actions 附件作为用户交付链接。


## 签名更新通道

Mac 版本和 Bridge 版本独立。正式 Mac 版本打 Gitea 标签 `macos-v<原生版本>`（与 `platforms/macos/version.json` 一致），并提高 Info.plist 里的 `CFBundleVersion`。正式签名 DMG 及对应 Bridge 包会发布到 Gitea 的 `macos-<原生版本>`。App 内更新通过 HTTPS 下载 GitHub 专用预发布条目 `macos-update-feed` 中的已签名 ZIP 和 appcast。独立的更新条目与 Chrome 扩展的 Latest release 分开。

首次启用由项目维护者配置以下资源：

- Mac 签名 runner 的钥匙串须同时有 **Developer ID Application** 证书和对应私钥，以及 `notarytool store-credentials` 保存的 Apple 公证配置。保留同一个 Apple Developer 团队及 Bundle Identifier `tech.xinyu.agentbridgemac`。
- Gitea Actions Variables 设置 `MAC_SIGN_IDENTITY`（完整证书名称）、`MAC_NOTARY_PROFILE`（runner 钥匙串中的配置名称）、`SPARKLE_PUBLIC_ED_KEY`（Sparkle `bin/generate_keys` 打印的公开键）。用 Sparkle 的 `generate_keys -x <file>` 导出私钥，仅存入 Secrets 中的 `SPARKLE_ED_PRIVATE_KEY`。保留公钥与私钥的安全备份。
- 在 GitHub 的 `Erhao/AgentBridgeLens` 创建已发布的预发布条目 `macos-update-feed`，设置为非 Latest。在 runner 装好 `gh`，在 Gitea Secrets 添加仅用于此 repo Release 发布的 `MAC_UPDATE_GITHUB_TOKEN`。无需给安装用户配置 Gitea 或 GitHub Token。

签名工作流编译、验证并公证 DMG 和更新包。它核对 appcast 与安装包中的版本和公开键，先上传版本化 ZIP，后切换 appcast。已经发布的 ZIP 保留，更新构建号必须单调递增。同一个签名构建还要经过安装后从工作区以外启动 App 与 Bridge 的测试。签名通道的验收需在测试 Mac 安装两个连续的正式版本，通过 App 内菜单完成 V1 → V2 并复核辅助功能和录屏授权。

开发预览版不会添加 `SUFeedURL` 或 `SUPublicEDKey`，所以更新菜单不会尝试安装未签名的制品。正式的自动检查默认打开、允许用户关闭。发现更新后须由用户确认安装。
