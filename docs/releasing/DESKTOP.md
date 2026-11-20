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


## Mac 个人版更新通道

Mac 版本和 Bridge 版本独立。更新 Mac 版本时同步 `platforms/macos/version.json` 和 Info.plist，并提高 Info.plist 中的 `CFBundleVersion`。把同一个 `macos-v<原生版本>` 标签推送到 GitHub 和 Gitea。

- GitHub Actions 构建 Apple Silicon App，用 `SPARKLE_ED_PRIVATE_KEY` 签名 ZIP 和目录文件，核对提交中的公钥、文件长度和版本，再发布到 `macos-update-feed` 专用预发布条目。这个条目不会成为 Chrome 扩展的 Latest release。更新文件公开下载，用户侧无需令牌。
- Gitea Actions 用同一个公开更新地址和公钥生成首次安装 DMG，并保存在 `macos-<原生版本>` 制品中。
- 两边的 App 都使用本地签名。Sparkle 更新签名独立于 Apple Developer ID。普通分支预览包不配置更新通道。个人版自动检查默认打开，可在设置里关闭，安装需要用户手动确认。
- `platforms/macos/update-channel.env` 只包含公开配置。更新私钥保存在 GitHub 仓库 Secret 中，不发给客户端。更换更新密钥会使已有个人版无法沿用原更新通道，应保护密钥并保持公钥不变。从不同签名身份迁移时，保留原安装位置和 App 设置，macOS 仍可能要求重新授权。

发布器先验证 ZIP，再更新 appcast。历史 ZIP 保留，版本构建号必须递增。首次使用此通道需用支持更新的 DMG 替换旧 App 一次。通过 App 菜单「检查更新…」即可手动检查并安装后续更新。
