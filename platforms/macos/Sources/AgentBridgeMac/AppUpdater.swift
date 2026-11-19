import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class AppUpdater: ObservableObject {
    @Published private(set) var canCheck = false
    @Published private(set) var checksAutomatically = false
    private let controller: SPUStandardUpdaterController?

    init() {
        guard Self.isConfigured else {
            controller = nil
            return
        }
        let controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil
        )
        self.controller = controller
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: RunLoop.main)
            .assign(to: &$canCheck)
        controller.updater.publisher(for: \.automaticallyChecksForUpdates)
            .receive(on: RunLoop.main)
            .assign(to: &$checksAutomatically)
    }

    static var isConfigured: Bool {
        guard let address = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let feed = URL(string: address), feed.scheme == "https", feed.host != nil,
              let encodedKey = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: encodedKey)?.count == 32 else { return false }
        return true
    }

    var available: Bool { controller != nil }

    func setAutomaticChecks(_ enabled: Bool) {
        controller?.updater.automaticallyChecksForUpdates = enabled
    }

    func checkNow() { controller?.checkForUpdates(nil) }
}

@MainActor
struct CheckForUpdatesButton: View {
    @ObservedObject var updater: AppUpdater

    var body: some View {
        Button("检查更新…", action: updater.checkNow)
            .disabled(!updater.canCheck)
    }
}

@MainActor
struct UpdateSettings: View {
    @ObservedObject var updater: AppUpdater

    var body: some View {
        Form {
            LabeledContent("当前版本", value: BuildInfo.version)
            if updater.available {
                Toggle("自动检查更新", isOn: Binding(
                    get: { updater.checksAutomatically },
                    set: updater.setAutomaticChecks
                ))
                Text("发现更新时会提示。你可以选择安装时间。")
                    .foregroundStyle(.secondary)
                CheckForUpdatesButton(updater: updater)
            } else {
                Text("此开发版未配置签名更新通道。安装正式签名版后，即可在应用内更新。")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 440, height: 215)
    }
}
