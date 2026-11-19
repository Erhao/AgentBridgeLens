import AppKit
import SwiftUI
import BridgeCore

private enum DesktopPage: String, CaseIterable, Identifiable {
    case overview, connection, permissions, activity
    var id: Self { self }

    var title: String {
        switch self {
        case .overview: "概览"
        case .connection: "连接客户端"
        case .permissions: "隐私与权限"
        case .activity: "活动记录"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "macwindow"
        case .connection: "link"
        case .permissions: "hand.raised"
        case .activity: "list.bullet.rectangle"
        }
    }
}

@MainActor
struct DesktopDashboard: View {
    @ObservedObject var client: NativeClient
    @Environment(\.scenePhase) private var scenePhase
    @State private var page: DesktopPage? = CommandLine.arguments.contains("--show-permissions")
        ? .permissions : .overview
    @State private var portDraft = ""
    @State private var selectedMode: BridgeMode = .local
    @State private var remoteAddressDraft = ""
    @State private var remoteTokenDraft = ""
    @State private var remoteError: String?
    @State private var copyFeedback = ""
    @State private var copyError = ""
    @State private var permissionsError: String?
    @State private var restarting = false
    @State private var lastPermissionCheck: Date?

    var body: some View {
        NavigationSplitView {
            List(DesktopPage.allCases, selection: $page) { item in
                Label(item.title, systemImage: item.symbol).tag(item)
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable().frame(width: 26, height: 26)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("AgentBridgeLens").font(.caption.weight(.semibold))
                        Text(BuildInfo.version).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(12)
            }
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text((page ?? .overview).title).font(.largeTitle.weight(.bold))
                        .accessibilityAddTraits(.isHeader)
                    switch page ?? .overview {
                    case .overview: overview
                    case .connection: connection
                    case .permissions: permissions
                    case .activity: activity
                    }
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle((page ?? .overview).title)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        client.stop()
                    } label: {
                        Label("停止控制", systemImage: "stop.circle")
                    }
                    .disabled(!client.controlRequested && client.pendingCount == 0)
                    .help("取消当前请求并关闭桌面控制")
                }
            }
        }
        .frame(minWidth: 700, minHeight: 470)
        .onAppear {
            portDraft = client.port
            selectedMode = client.mode
            remoteAddressDraft = client.remoteAddress
            checkPermissions()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { checkPermissions() }
        }
        .task {
            while !Task.isCancelled {
                client.refreshPermissions()
                do { try await Task.sleep(for: .seconds(3)) }
                catch { break }
            }
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: client.connection == .connected ? "link.circle.fill" : "link.circle")
                        .font(.system(size: 32))
                        .foregroundStyle(client.connected ? Color.green : Color.accentColor)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(client.connection.title).font(.title2.weight(.semibold))
                        Text(client.connection.detail).foregroundStyle(.secondary)
                        if !client.connected {
                            Button("配置 AI 客户端") { page = .connection }
                                .buttonStyle(.borderedProminent)
                                .padding(.top, 4)
                        }
                    }
                    Spacer()
                }.padding(8)
            }

            GroupBox("桌面控制") {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("允许 AI 点击和键入", isOn: Binding(
                        get: { client.controlRequested }, set: { client.setControl($0) }
                    ))
                    .toggleStyle(.switch)
                    .disabled(!client.accessibility)
                    Text(controlHint)
                        .foregroundStyle(.secondary)
                    if !client.accessibility {
                        Button("查看权限") { page = .permissions }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
        }
    }

    private var controlHint: String {
        if !client.accessibility { return "授予辅助功能权限后可开启。" }
        switch client.controlConsent {
        case .off:
            return client.connected
                ? "开启后，当前连接可以在获准的前台窗口点击和键入。"
                : "可以提前开启。下一次连接完成后生效，断开或停止后自动关闭。"
        case .waitingForConnection:
            return "已允许下一次连接控制。当前正在等待 Bridge，尚未控制桌面。"
        case .active:
            return "当前连接可向获准的前台窗口发送操作。你可以随时停止。"
        }
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Picker("连接方式", selection: $selectedMode) {
                Text("本机").tag(BridgeMode.local)
                Text("远程 Bridge").tag(BridgeMode.remote)
            }
            .pickerStyle(.segmented)
            .onChange(of: selectedMode) { _, _ in
                copyFeedback = ""
                remoteTokenDraft = ""
            }

            if selectedMode == .remote {
                remoteSettings
            } else {
                localSettings
            }
            connectionStatus
        }
        .alert("复制失败", isPresented: Binding(
            get: { !copyError.isEmpty }, set: { if !$0 { copyError = "" } }
        )) { Button("好", role: .cancel) {} } message: { Text(copyError) }
    }

    private var localSettings: some View {
        Group {
            Text("将内置 Bridge 的配置添加到支持本地 stdio MCP 的 AI 客户端，然后重载客户端。")
                .foregroundStyle(.secondary)
            if client.mode != .local {
                Button("切换到本机 Bridge") { client.useLocalBridge() }
            }
            GroupBox("客户端配置") {
                VStack(alignment: .leading, spacing: 12) {
                    if let configuration = try? BundledBridge.configuration(port: client.port, tokenFile: client.tokenFile) {
                        Text(configuration.trimmingCharacters(in: .newlines))
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                        HStack {
                            Button("复制 MCP 配置", systemImage: "doc.on.doc") { copy(configuration) }
                                .buttonStyle(.borderedProminent)
                            if !copyFeedback.isEmpty { Text(copyFeedback).foregroundStyle(.secondary) }
                        }
                        Text("已有 MCP 配置时，把 agentbridgelens 项加入现有列表。客户端只有在成功握手后才会显示为已连接。")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        Label("当前安装中无法生成客户端配置。请确认使用完整安装包和有效端口。", systemImage: "exclamationmark.triangle")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }

            DisclosureGroup("高级设置") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        TextField("本机配对端口", text: $portDraft)
                            .frame(width: 170)
                            .onSubmit(applyPort)
                        Button("应用端口", action: applyPort)
                            .disabled(MCPConfiguration.validPort(portDraft) == nil || portDraft == client.port)
                    }
                    if MCPConfiguration.validPort(portDraft) == nil {
                        Text("端口须为 1024–65535。").foregroundStyle(.secondary)
                    }
                    Text("更改端口后，请重新复制配置并重载客户端。")
                        .font(.callout).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
            }
        }
    }

    private var remoteSettings: some View {
        GroupBox("远程 Bridge") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Mac 连接到你部署的 Bridge，另一台设备上的 AI 客户端通过该服务调用桌面工具。")
                    .foregroundStyle(.secondary)
                TextField("WebSocket 地址", text: $remoteAddressDraft, prompt: Text("wss://bridge.example.com/native"))
                SecureField("配对令牌", text: $remoteTokenDraft)
                Text("使用服务器的 Mac 配对令牌。令牌存入钥匙串，之前保存过的地址可以留空令牌。")
                    .font(.callout).foregroundStyle(.secondary)
                Button("连接远程 Bridge") {
                    do {
                        try client.useRemoteBridge(address: remoteAddressDraft, token: remoteTokenDraft)
                        remoteAddressDraft = client.remoteAddress
                        remoteTokenDraft = ""
                        remoteError = nil
                    } catch {
                        remoteError = error.localizedDescription
                    }
                }
                .buttonStyle(.borderedProminent)
                if let remoteError {
                    Label(remoteError, systemImage: "exclamationmark.circle")
                        .foregroundStyle(.red)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }

    private var connectionStatus: some View {
        GroupBox("连接状态") {
            VStack(alignment: .leading, spacing: 10) {
                Text(client.connection.title).font(.headline)
                if client.mode == .remote {
                    Text(client.remoteAddress).textSelection(.enabled).foregroundStyle(.secondary)
                } else {
                    Text("本机 Bridge").foregroundStyle(.secondary)
                }
                Text(client.connection.detail).foregroundStyle(.secondary)
                HStack {
                    Button("重新连接", systemImage: "arrow.clockwise") { client.reconnect() }
                    Button("断开连接") { client.disconnect() }
                        .disabled(client.connection == .disconnected)
                }
                if client.connected {
                    Button("复制验证指令") {
                        copy("请调用 AgentBridgeLens 的 desktop_get_capabilities，告诉我 Mac 桌面连接和权限状态。")
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("这里显示 macOS 为当前运行的 AgentBridgeLens 进程报告的权限。")
                .foregroundStyle(.secondary)
            if isTemporaryApp {
                Label(
                    "当前 App 正从磁盘映像或临时位置运行。请拖入「应用程序」，退出这份 App，再打开已安装的副本进行授权。",
                    systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(Color.orange)
            }
            permissionCard(
                .accessibility, description: "读取当前窗口的控件，并在开启控制后执行点击和键入。",
                symbol: "accessibility", granted: client.accessibility
            )
            permissionCard(
                .screenCapture, description: "抓取指定窗口的静态截图。开启录屏权限后请重新打开 App。",
                symbol: "rectangle.dashed", granted: client.screenCapture
            )
            HStack {
                Button("重新检查", systemImage: "arrow.clockwise", action: checkPermissions)
                if let lastPermissionCheck {
                    Text(lastPermissionCheck, style: .time)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("上次检查时间")
                }
            }

            if !client.permissions.bothAvailable {
                GroupBox("设置里已经开启？") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("先重新打开当前 App。如果仍显示不可用，请在 Finder 中定位这份 App，在对应权限列表中添加它。旧版本或同名副本的授权可能不会生效。")
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("重新打开 AgentBridgeLens", action: reopenForPermissionCheck)
                                .buttonStyle(.borderedProminent)
                                .disabled(restarting || isTemporaryApp)
                            Button("在 Finder 中显示") {
                                NSWorkspace.shared.activateFileViewerSelecting([appURL])
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                }
            }
            DisclosureGroup("当前运行的 App") {
                LabeledContent("安装路径") { Text(appURL.path).textSelection(.enabled) }
                    .padding(.vertical, 4)
                LabeledContent("版本", value: BuildInfo.version)
            }
        }
        .alert("权限操作未完成", isPresented: Binding(
            get: { permissionsError != nil }, set: { if !$0 { permissionsError = nil } }
        )) {
            Button("好", role: .cancel) { permissionsError = nil }
        } message: {
            Text(permissionsError ?? "")
        }
    }

    private var appURL: URL { Bundle.main.bundleURL.resolvingSymlinksInPath() }

    private var isTemporaryApp: Bool {
        if appURL.pathComponents.contains("AppTranslocation") { return true }
        let volume = try? appURL.resourceValues(forKeys: [.volumeIsReadOnlyKey])
        return volume?.volumeIsReadOnly == true
    }

    private func checkPermissions() {
        client.refreshPermissions()
        lastPermissionCheck = Date()
    }

    private func reopenForPermissionCheck() {
        guard !restarting else { return }
        restarting = true
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.arguments = ["--show-permissions"]
        let currentPID = ProcessInfo.processInfo.processIdentifier
        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
            let openedNewApp = app.map { $0.processIdentifier != currentPID } ?? false
            Task { @MainActor in
                guard error == nil, openedNewApp else {
                    restarting = false
                    permissionsError = "无法自动重新打开。请按 ⌘Q 退出，再从 Finder 打开此 App。"
                    return
                }
                client.disconnect()
                NSApp.terminate(nil)
            }
        }
    }

    private var activity: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("记录本次运行的连接、控制状态和操作结果，不记录窗口内容或输入文字。")
                .foregroundStyle(.secondary)
            if client.activity.isEmpty {
                ContentUnavailableView("还没有活动", systemImage: "clock", description: Text("连接客户端后，操作记录会显示在这里。"))
                    .frame(minHeight: 190)
            } else {
                GroupBox {
                    VStack(spacing: 0) {
                        ForEach(client.activity) { entry in
                            LabeledContent {
                                Text(entry.time, style: .time)
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            } label: {
                                Text(entry.message).textSelection(.enabled)
                            }
                            .padding(9)
                            if entry.id != client.activity.last?.id { Divider() }
                        }
                    }
                }
                Button("清空活动记录") { client.clearActivity() }
            }
        }
    }

    private func permissionCard(
        _ permission: DesktopPermission, description: String, symbol: String, granted: Bool
    ) -> some View {
        GroupBox {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol)
                    .font(.title2).foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 5) {
                    Text(permission.title).font(.headline)
                    Text(description).foregroundStyle(.secondary)
                    Label(granted ? "当前 App 可用" : "当前 App 不可用",
                          systemImage: granted ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(granted ? Color.green : Color.secondary)
                }
                Spacer()
                Button(granted ? "查看设置" : "前往授权") {
                    if !granted { permission.requestIfNeeded() }
                    if !permission.openSettings() {
                        permissionsError = "请手动打开「系统设置 → 隐私与安全性 → \(permission.title)」。"
                    }
                    checkPermissions()
                }
                .disabled(isTemporaryApp)
            }
            .padding(8)
        }
    }

    private func applyPort() {
        guard let port = MCPConfiguration.validPort(portDraft) else { return }
        client.port = String(port)
        portDraft = client.port
        copyFeedback = ""
        client.useLocalBridge()
    }

    private func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if pasteboard.setString(text, forType: .string) {
            copyFeedback = "已复制"
        } else {
            copyError = "无法写入剪贴板。你可以选中配置并手动复制。"
        }
    }
}
