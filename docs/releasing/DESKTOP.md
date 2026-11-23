# 桌面制品构建与发布

源码主仓为 `Erhao/AgentBridgeLens`，Gitea 的 `xinyu/AgentBridgeLens` 同步相同提交，供内网原生运行器执行构建和 Generic Registry 发布。Mac 不再有独立开发分支或第二份 Node Bridge。

## 组件版本

- 桌面制品的唯一版本来源：`packages/bridge/package.json`。Mac 应用显示版本、Swift 回退版本、Windows 程序版本、原生安装包文件名、Bridge 压缩包以及构建清单中的组件版本必须一致。Linux 脚本随同版本的 Bridge 分发。
- 更新 Bridge 版本后，运行 `node scripts/release/desktop-version.mjs --write` 同步原生元数据；`--check` 只检查，不修改文件。构建和上传前检查一致性，遗漏同步会阻止发布。独立 `bridge-vX.Y.Z` npm/GitHub 发布流程保持。
- 扩展版本：既有 semantic-release 流程保持独立。
- 原生协议：当前为 v1，与上述版本独立。

## 构建和交付

所有构建和发布工作在 Gitea Actions 执行，GitHub 仅保存源码和 Releases，不运行 CI/CD。旧 GitHub workflow 保存在 `docs/releasing/legacy-github/` 供查阅，不会执行。

`.gitea/workflows/desktop.yml` 在 main 推送后自动运行。Linux 运行器执行类型检查、Bridge/协议/发布/updater 测试和隔离的 GTK/D-Bus 测试，交叉编译并验证 Windows x64/ARM64 PE 架构。Mac 运行器接收同次运行的原生制品，编译 Mac 应用并验证实际 MCP 连接，打包包含 Windows 执行端、Linux 脚本和生产 Node 依赖的 Bridge，再在工作区外测试该压缩包。

Windows 交叉编译和 PE 校验不等于 Windows 真机 GUI 验收，发布说明会明确这一限制。原生 Windows 运行器离线时不假报通过。

通过全部检查后，先上传并回下载验证 Gitea Generic 制品，再直接上传完全相同的字节到 GitHub Releases。每个 main 提交创建 `desktop-build-<版本>-dev.<提交短哈希>` 预发布；`desktop-vX.Y.Z` 标签创建正式桌面 Release。桌面 Release 设置 `make_latest=false`，保留 Chrome updater 对最新正式扩展的发现。

GitHub 上传先建立草稿，全部附件回下载 SHA256 校验通过后才公开；重试只接受相同字节，禁止覆盖已发布的不同制品。Gitea Secret `GH_RELEASE_TOKEN` 提供 GitHub 目标仓库的 Contents 写权限；不依赖 GitHub Actions token 或执行 GitHub workflow。

## Gitea 制品库

`.gitea/workflows/desktop.yml` 使用 Linux 与现有 macos-arm64 运行器，构建各平台制品、测试统一 MCP，再发布到 `xinyu` 的 Generic 包 `agentbridgelens` 并关联统一仓库。

main 构建的制品库版本为 `<Bridge版本>-dev.<提交短哈希>`；显式 `desktop-v<Bridge版本>` 标签发布对应固定版本。`-dev.<提交短哈希>` 标识不可覆盖的构建批次，应用和安装包内的三段版本仍统一为 Bridge 版本。

每组制品包含：

- 同版本的 Mac ARM64 ZIP、Windows x64/ARM64 原生执行端 ZIP，以及 Linux Python 执行端压缩包。
- 带生产 Node 依赖的同版本 Bridge 压缩包。
- `agentbridgelens-updater.zip` 和 `agentbridgelens-updater.zip.sha256`：半自动扩展更新工具，包含 Windows `.cmd`、macOS `.command`、Linux `.sh` 启动入口及说明。
- `BUILD-MANIFEST.json`：记录提交、统一组件版本、实际原生平台/架构清单及所有安装包和 updater 的 SHA256。
- `SHA256SUMS`：覆盖上述制品及构建清单。

updater 下载并校验 GitHub 最新正式扩展，更新原扩展目录后，需要手动点击 Chrome 中原插件的「重新加载」。它不安装桌面应用或升级 Bridge；从 Gitea 下载 updater 不会改变它的更新源。扩展发布流程见 [RELEASING.md](../RELEASING.md)。

发布器要求原生包文件名与统一版本完全匹配，并在任何上传前验证 updater 校验文件；缺失 updater、混入旧平台包或混用版本会直接失败。相同版本的 Windows/Linux 原生包可以纳入同一批制品，当前流水线将 Windows 交叉编译结果和 Linux 脚本纳入 Bridge；Windows 原生运行验收仍需在线的 Windows 测试环境。

发布凭据为当前 Gitea 仓库的 `PACKAGES_TOKEN` Secret，仅 write:package。发布器先检查仓库关联，避免重复关联错误；逐个回下载文件校验 SHA256。已有版本只有字节完全一致时才允许重跑，不删除或覆盖。关联私有仓库不会自动改变拥有者层面的包可见性。

默认 Mac 应用为开发签名，未公证。Developer ID 签名与公证需单独配置，原有 Bundle Identifier 与配对路径保留。

旧 `agentbridgemac/0.1.2` 制品保留供历史使用。新的安装包从统一项目的软件包页面或自动同步的 GitHub Release 取得，不以本地 ZIP 或临时 Actions 附件作为用户交付链接。
