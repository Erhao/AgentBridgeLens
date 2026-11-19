import AppKit
import SwiftUI
import BridgeCore

@main
enum Launcher {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--mcp") { BundledBridge.launch() }
        if CommandLine.arguments.contains("--diagnose") {
            var fields = DesktopPermissions().report
            fields["version"] = .string(BuildInfo.version)
            fields["appPath"] = .string(Bundle.main.bundleURL.path)
            fields["bundleIdentifier"] = .string(Bundle.main.bundleIdentifier ?? "")
            fields["bundledBridge"] = .bool(BundledBridge.isAvailable)
            let status = JSONValue.object(fields)
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

@MainActor
struct CompanionApp: App {
    @StateObject private var client = NativeClient()

    private static let menuIcon: NSImage? = {
        guard let url = Bundle.main.url(forResource: "MenuLens", withExtension: "png"),
              let icon = NSImage(contentsOf: url) else { return nil }
        icon.size = NSSize(width: 18, height: 18)
        icon.isTemplate = true
        return icon
    }()

    var body: some Scene {
        Window("AgentBridgeLens", id: "dashboard") {
            DesktopDashboard(client: client)
        }
        .defaultSize(width: 880, height: 620)
        .windowResizability(.contentMinSize)
        .commands {
            CommandMenu("桌面") {
                Button("停止桌面控制") { client.stop() }
                    .keyboardShortcut(".", modifiers: [.command, .shift])
            }
        }

        MenuBarExtra {
            DesktopMenu(client: client)
        } label: {
            if let icon = Self.menuIcon {
                Image(nsImage: icon)
                    .accessibilityLabel("AgentBridgeLens")
            } else {
                Image(systemName: "circle.circle")
                    .accessibilityLabel("AgentBridgeLens")
            }
        }
    }
}

@MainActor
private struct DesktopMenu: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var client: NativeClient

    var body: some View {
        Text(client.connection.title)
        switch client.controlConsent {
        case .off: Text("桌面控制已关闭")
        case .waitingForConnection: Text("已允许下一次连接控制")
        case .active: Text("桌面控制已开启")
        }
        Button("打开 AgentBridgeLens") {
            openWindow(id: "dashboard")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("停止桌面控制") { client.stop() }
            .disabled(!client.controlRequested && client.pendingCount == 0)
        Button("断开桌面连接") { client.disconnect() }
            .disabled(client.connection == .disconnected)
        Divider()
        Button("退出 AgentBridgeLens") {
            client.disconnect()
            NSApp.terminate(nil)
        }
    }
}
