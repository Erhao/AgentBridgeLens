import AppKit
import ApplicationServices
import BridgeCore

enum DesktopPermission {
    case accessibility, screenCapture

    var title: String {
        switch self {
        case .accessibility: "辅助功能"
        case .screenCapture: "屏幕与系统音频录制"
        }
    }

    var isAvailable: Bool {
        switch self {
        case .accessibility: AXIsProcessTrusted()
        case .screenCapture: CGPreflightScreenCaptureAccess()
        }
    }

    @MainActor
    func openSettings() -> Bool {
        let pane = self == .accessibility ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else {
            return false
        }
        return NSWorkspace.shared.open(url)
    }

    @MainActor
    func requestIfNeeded() {
        guard !isAvailable else { return }
        switch self {
        case .accessibility:
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
            _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
        case .screenCapture:
            _ = CGRequestScreenCaptureAccess()
        }
    }
}

struct DesktopPermissions: Equatable {
    var accessibility = DesktopPermission.accessibility.isAvailable
    var screenCapture = DesktopPermission.screenCapture.isAvailable

    var bothAvailable: Bool { accessibility && screenCapture }

    var report: [String: JSONValue] {
        [
            "accessibility": .bool(accessibility),
            "screenCapture": .bool(screenCapture),
            "postEvents": .bool(CGPreflightPostEventAccess())
        ]
    }
}
