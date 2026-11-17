import SwiftUI
import ApplicationServices
import BridgeCore

@main
enum Launcher {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--diagnose") {
            let status = JSONValue.object([
                "version": .string(BuildInfo.version), "accessibility": .bool(AXIsProcessTrusted()),
                "screenCapture": .bool(CGPreflightScreenCaptureAccess()), "postEvents": .bool(CGPreflightPostEventAccess())
            ])
            if let data = try? JSONEncoder().encode(status), let value = String(data: data, encoding: .utf8) { print(value) }
            return
        }
        if CommandLine.arguments.contains("--transport-smoke-test") {
            let client = NativeClient(smoke: true)
            client.start()
            RunLoop.main.run()
            withExtendedLifetime(client) {}
            return
        }
        CompanionApp.main()
    }
}

struct CompanionApp: App {
    @StateObject private var client = NativeClient()
    var body: some Scene {
        MenuBarExtra("AgentBridgeMac", systemImage: client.controlEnabled ? "cursorarrow.click.2" : "macwindow") {
            CompanionPanel(client: client)
        }.menuBarExtraStyle(.window)
    }
}

struct CompanionPanel: View {
    @ObservedObject var client: NativeClient
    private let timer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "macwindow").font(.title)
                VStack(alignment: .leading, spacing: 3) {
                    Text("AgentBridgeMac").font(.headline)
                    Text("让 AI 连接此 Mac 的真实桌面").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Circle().fill(client.connected ? Color.green : Color.orange).frame(width: 8, height: 8)
            }
            Text(client.connection).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            HStack {
                Text("本机端口")
                TextField("19224", text: $client.port).frame(width: 80)
                Spacer()
                Button("重新连接") { client.start() }
            }
            Divider()
            permissionRow("辅助功能", granted: client.accessibility) {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                openPrivacy("Privacy_Accessibility")
            }
            permissionRow("屏幕录制", granted: client.screenCapture) {
                _ = CGRequestScreenCaptureAccess()
                openPrivacy("Privacy_ScreenCapture")
            }
            Button("刷新权限状态") { client.refreshPermissions() }.font(.caption)
            Toggle("允许 AI 操作桌面", isOn: Binding(get: { client.controlEnabled }, set: { client.setControl($0) }))
                .disabled(!client.connected || !client.accessibility)
            Text(client.controlEnabled ? "AI 可向指定的前台窗口发送操作。鼠标、键盘与您共用。" : "当前仅观察。连接或权限变化后，需要您重新开启控制。")
                .font(.caption).foregroundStyle(.secondary)
            Button(role: .destructive) { client.stop() } label: {
                Label("立即停止并关闭控制", systemImage: "stop.circle.fill").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).tint(.red)
            Divider()
            Text("最近活动").font(.subheadline.bold())
            ScrollView {
                VStack(alignment: .leading, spacing: 5) {
                    if client.activity.isEmpty { Text("等待 AI 连接和调用").foregroundStyle(.secondary) }
                    ForEach(Array(client.activity.enumerated()), id: \.offset) { _, line in Text(line).font(.caption.monospaced()).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 120)
            HStack {
                Text("\(BuildInfo.version) · macOS 14.2+").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button("退出") { client.disconnect(); NSApplication.shared.terminate(nil) }
            }
        }
        .padding(20).frame(width: 380)
        .onReceive(timer) { _ in client.refreshPermissions() }
    }
    private func permissionRow(_ title: String, granted: Bool, action: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: granted ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(granted ? Color.green : Color.secondary)
            Spacer()
            Button(granted ? "查看设置" : "前往授权", action: action)
        }
    }
    private func openPrivacy(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
}
