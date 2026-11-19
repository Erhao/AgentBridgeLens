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

        MenuBarExtra(
            "AgentBridgeLens",
            systemImage: client.controlEnabled ? "cursorarrow.click.2" : "macwindow"
        ) {
            DesktopMenu(client: client)
        }
    }
}

@MainActor
private struct DesktopMenu: View {
    @Environment(\.openWindow) private var openWindow
    @ObservedObject var client: NativeClient

    var body: some View {
        Text(client.connection.title)
        Button("打开 AgentBridgeLens") {
            openWindow(id: "dashboard")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("停止桌面控制") { client.stop() }
            .disabled(!client.controlEnabled && client.pendingCount == 0)
        Button("断开桌面连接") { client.disconnect() }
            .disabled(client.connection == .disconnected)
        Divider()
        Button("退出 AgentBridgeLens") {
            client.disconnect()
            NSApp.terminate(nil)
        }
    }
}
