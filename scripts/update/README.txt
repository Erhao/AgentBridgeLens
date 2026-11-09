AgentBridgeLens 固定目录更新工具（Node.js 20+，无需 npm install；代理下载使用系统 curl）

首次使用：
1. 保留此工具文件夹，以后重复使用，不需要每次重新下载。
2. 已安装插件的用户：打开 chrome://extensions → AgentBridgeLens 详情，
   找到「加载路径」，第一次运行工具时填写这个原目录。
   不要删除旧插件，不要把新解压的目录重新导入 Chrome。
3. Windows：双击 update-extension.cmd。
   macOS：双击 update-extension.command；如无执行权限，终端运行
   sh update-extension.command
   Linux：终端运行 sh update-extension.sh
4. 工具会记住原目录，自动获取 GitHub 最新版并校验 SHA256，保留上一版备份。
5. 更新后在 chrome://extensions 点原插件的「重新加载」，刷新需要操作的网页。
   目录及扩展身份不变时，桥接配置和显示偏好会保留。

首次安装：运行后在目录提示处直接回车，工具会使用固定目录：
~/.agentbridgelens/extension
然后只需在 Chrome 中加载一次该目录。

命令行：
node update-extension.mjs --dir "原扩展目录"
node update-extension.mjs --check
node update-extension.mjs --rollback
node update-extension.mjs --help

代理设置（新版）：
- 自动读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（以及小写变量）。
- macOS 双击启动时，会自动读取系统手动 HTTP/HTTPS/SOCKS 代理。
- 只有 PAC 地址时不会执行 PAC 脚本；请填写代理软件的本地 HTTP 或 SOCKS 端口。
- 可手动指定并记住地址，例如（端口须替换为代理软件的实际端口）：
  sh update-extension.command --proxy http://127.0.0.1:7897
  node update-extension.mjs --proxy socks5h://127.0.0.1:1080
  也可仅输入端口：node update-extension.mjs --proxy 7897
- 优先级：--no-proxy / --proxy → 环境变量 → 已保存地址 → macOS 系统代理。
- 指定代理成功后会保存，以后双击无需再输入；网络失败时交互窗口也会提示输入代理。
- 临时直连：node update-extension.mjs --no-proxy（不会删除保存的代理）。
- --proxy 与 --no-proxy 不能同时使用；标准 NO_PROXY / no_proxy 例外列表仍按 curl 规则生效。
- 代理模式无需安装 Node 第三方库；需要系统 curl（macOS 和新版 Windows 通常自带，Linux 可通过包管理器安装）。
- 代理软件需保持启动；不要关闭 TLS 证书校验来规避网络错误。

下载重试与 403 排查：
- 临时网络错误、超时、HTTP 429/5xx 默认最多尝试 5 次，按 1、2、4、8 秒延长重试间隔并显示进度。
- 自定义额外重试次数（0～10）：
  sh update-extension.command --proxy http://127.0.0.1:7897 --retries 6
- 持续 HTTP 403 最多重试一次；代理认证失败 407、文件不存在 404、证书错误不会盲目反复重试。
- 日志会标明“检查最新版本 / 查询发行页 / 下载校验文件 / 下载安装包”及对应主机。
- “代理 CONNECT 隧道被拒绝”：本地代理返回了拒绝响应，请检查代理规则或更换出口节点，不一定是端口错误。
- GitHub API 限流时不继续请求同一接口；自动尝试 GitHub 公开发行页确认版本，再下载原官方安装包和校验文件。
- 备用查询仍使用当前代理，不会偷偷切换直连；SHA256、版本、扩展身份检查保持不变。
- 服务器要求长时间等待时会显示原因并停止自动重试；默认单次下载步骤总超时 60 秒。

--check 仅检查版本；--rollback 将上一版恢复到同一个原目录。
--dir 可以重新指定目录。若有多个 Chrome 配置使用不同目录，请分别指定。
工具只更新扩展文件，不读取 Chrome 配置，不备份或导出 Bridge Token。
桥接配置保存在 Chrome 中；删除插件、换 Chrome 配置或清除扩展数据仍会丢失配置。
默认只升级，不自动降级；需要降级时使用 --rollback。
GitHub 网络或校验失败时保留原版本。若目录正在被占用，请关闭插件面板后重试。
更新中断导致目录缺失时，不要重新安装：保留相邻的 .abl-backup 目录，
确认没有更新任务后删除提示的 .abl-update.lock 文件，再运行 --rollback。

Node.js 下载：https://nodejs.org
项目：https://github.com/Erhao/AgentBridgeLens
