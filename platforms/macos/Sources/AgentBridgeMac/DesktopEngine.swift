import AppKit
import ApplicationServices
import ScreenCaptureKit
import BridgeCore

final class DesktopEngine {
    let gate: ControlGate
    private let queue = DispatchQueue(label: "AgentBridgeMac.AX", qos: .userInitiated)
    private struct Window {
        let ref: String, pid: pid_t, launched: Date?, element: AXUIElement, appName: String, bundleId: String
        let created: TimeInterval
    }
    private struct Element {
        let ax: AXUIElement, name: String, role: String, frame: Rect?, value: JSONValue
    }
    private struct Snapshot {
        let window: Window, lease: SnapshotLease
        let controlEpoch: Int
        var elements: [String: Element]
        var imageWidth: Int?, imageHeight: Int?, imageFrame: Rect?
    }
    private var windows: [String: Window] = [:]
    private var snapshots: [String: Snapshot] = [:]
    private var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    init(gate: ControlGate) { self.gate = gate }

    private func work<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try body() }) }
        }
    }

    func handle(tool: String, params: JSONValue, ticket: ControlGate.Ticket) async throws -> JSONValue {
        try ticket.check()
        switch tool {
        case "mac_get_status":
            return .object([
                "connected": .bool(true), "version": .string(BuildInfo.version),
                "controlEnabled": .bool(gate.isEnabled), "controlEpoch": .number(Double(gate.epoch)),
                "permissions": .object(DesktopPermissions().report),
                "capabilities": .array(Self.capabilities.map(JSONValue.string)),
                "limitations": .array([.string("AX coverage depends on the target app."), .string("Input shares the user's foreground desktop."), .string("No DOM, network, console, source tracing, or application-internal data access.")])
            ])
        case "mac_list_windows": return try await work { try self.listWindows(ticket: ticket) }
        case "mac_focus_window": return try await focus(params: params, ticket: ticket)
        case "mac_observe":
            let result = try await work { try self.observe(params: params, ticket: ticket) }
            if params["screenshot"].bool == true { return try await capture(result: result, ticket: ticket) }
            return result
        case "mac_act": return try await work { try self.act(params: params, ticket: ticket) }
        case "mac_wait_for": return try await waitFor(params: params, ticket: ticket)
        default: throw BridgeFailure("UNKNOWN_TOOL", "Unsupported tool: \(tool).")
        }
    }

    static let capabilities = ["windows", "accessibility", "window_screenshot", "ax_press", "set_value", "keyboard", "pointer", "scroll", "wait", "stop"]

    private func window(_ ref: String) throws -> Window {
        try AX.requireTrust()
        guard let item = windows[ref], uptime - item.created < 600,
              let app = NSRunningApplication(processIdentifier: item.pid), !app.isTerminated,
              app.launchDate == item.launched else { throw BridgeFailure("STALE_WINDOW", "Window reference expired or app restarted. List windows again.") }
        let role: String? = AX.read(item.element, kAXRoleAttribute)
        guard role != nil, AX.frame(item.element) != nil else { throw BridgeFailure("STALE_WINDOW", "Window is no longer accessible. List windows again.") }
        return item
    }

    private func listWindows(ticket: ControlGate.Ticket) throws -> JSONValue {
        try AX.requireTrust()
        windows = windows.filter { uptime - $0.value.created < 600 }
        snapshots = snapshots.filter { uptime - $0.value.lease.createdAt < 30 }
        var result: [JSONValue] = [], warnings: [JSONValue] = []
        let started = uptime
        scan: for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && app.processIdentifier != getpid() {
            try ticket.check()
            if uptime - started > 8 || result.count >= 200 { warnings.append(.string("Window scan truncated at the time/node budget.")); break }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(ax, 0.3)
            let appWindows = AX.children(ax, attribute: kAXWindowsAttribute, limit: 50)
            if appWindows.isEmpty { warnings.append(.string("\(app.localizedName ?? "App"): no accessible windows (may be closed or unsupported).")) }
            for element in appWindows {
                try ticket.check()
                if uptime - started > 8 || result.count >= 200 { warnings.append(.string("Window scan truncated at the time/node budget.")); break scan }
                guard let frame = AX.frame(element) else { continue }
                AXUIElementSetMessagingTimeout(element, 0.3)
                let existing = windows.values.first { $0.pid == app.processIdentifier && $0.launched == app.launchDate && CFEqual($0.element, element) }
                let ref = existing?.ref ?? "w-\(UUID().uuidString)"
                let item = Window(ref: ref, pid: app.processIdentifier, launched: app.launchDate, element: element, appName: app.localizedName ?? "App", bundleId: app.bundleIdentifier ?? "", created: uptime)
                windows[ref] = item
                let minimized: Bool = AX.read(element, kAXMinimizedAttribute) ?? false
                result.append(.object([
                    "windowRef": .string(ref), "pid": .number(Double(item.pid)), "app": .string(item.appName), "bundleId": .string(item.bundleId),
                    "title": .string(AX.name(element)), "frame": try frame.jsonValue(), "minimized": .bool(minimized),
                    "frontmost": .bool(app.isActive)
                ]))
            }
        }
        if windows.count > 256 {
            let oldest = windows.values.sorted { $0.created < $1.created }.prefix(windows.count - 256)
            for item in oldest { windows.removeValue(forKey: item.ref) }
        }
        return .object(["windows": .array(result), "warnings": .array(warnings)])
    }

    private func foreground(_ item: Window) throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == item.pid else {
            throw BridgeFailure("FOCUS_CHANGED", "Target app is not foreground. Focus the target window, then observe again.")
        }
        let app = AXUIElementCreateApplication(item.pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let focused: AXUIElement = AX.read(app, kAXFocusedWindowAttribute), CFEqual(focused, item.element) else {
            throw BridgeFailure("FOCUS_CHANGED", "Another window or modal dialog has focus. Observe that window instead.")
        }
    }

    private func focus(params: JSONValue, ticket: ControlGate.Ticket) async throws -> JSONValue {
        let ref = try params.requiredString("windowRef")
        let item = try await work { try ticket.check(input: true); return try self.window(ref) }
        try ticket.check(input: true)
        let activated = await MainActor.run { NSRunningApplication(processIdentifier: item.pid)?.activate(options: []) ?? false }
        guard activated else { throw BridgeFailure("FOCUS_FAILED", "macOS did not activate the target app.") }
        try await work {
            try ticket.check(input: true)
            if AX.settable(item.element, kAXMinimizedAttribute) {
                try AX.check(AXUIElementSetAttributeValue(item.element, kAXMinimizedAttribute as CFString, kCFBooleanFalse), operation: "Restore window")
            }
            try ticket.check(input: true)
            try AX.check(AXUIElementPerformAction(item.element, kAXRaiseAction as CFString), operation: "Raise window")
            if AX.settable(item.element, kAXMainAttribute) {
                try ticket.check(input: true)
                try AX.check(AXUIElementSetAttributeValue(item.element, kAXMainAttribute as CFString, kCFBooleanTrue), operation: "Focus window")
            }
        }
        for _ in 0..<20 {
            try ticket.check(input: true)
            if (try? await work { try self.foreground(item) }) != nil {
                return .object(["windowRef": .string(ref), "verified": .bool(true), "next": .string("Observe this window before sending input.")])
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw BridgeFailure("FOCUS_FAILED", "Target window did not become focused within two seconds.")
    }

    private func observe(params: JSONValue, ticket: ControlGate.Ticket) throws -> JSONValue {
        try ticket.check()
        let item = try window(params.requiredString("windowRef"))
        guard let frame = AX.frame(item.element) else { throw BridgeFailure("STALE_WINDOW", "Window has no frame.") }
        let depthLimit = try params.int("maxDepth", default: 8, range: 0...16)
        let nodeLimit = try params.int("maxNodes", default: 300, range: 1...1000)
        let started = uptime, id = "s-\(UUID().uuidString)"
        var records: [String: Element] = [:], flat: [JSONValue] = []
        var truncated = false
        var visited: Set<CFHashCode> = []
        func walk(_ ax: AXUIElement, parent: String?, depth: Int) throws {
            try ticket.check()
            guard records.count < nodeLimit, uptime - started < 8 else { truncated = true; return }
            let hash = CFHash(ax)
            guard !visited.contains(hash) else { return }
            visited.insert(hash)
            AXUIElementSetMessagingTimeout(ax, 0.3)
            let elementId = "e\(records.count + 1)"
            let role: String = AX.read(ax, kAXRoleAttribute) ?? "AXUnknown"
            let name = AX.name(ax), rect = AX.frame(ax), value = AX.value(ax), secure = AX.secure(ax)
            records[elementId] = Element(ax: ax, name: name, role: role, frame: rect, value: value)
            let enabled: Bool = AX.read(ax, kAXEnabledAttribute) ?? true
            var data: [String: JSONValue] = [
                "id": .string(elementId), "role": .string(role), "name": .string(name), "value": (params["includeText"].bool ?? true) ? value : .null,
                "enabled": .bool(enabled), "secure": .bool(secure),
                "actions": .array(AX.actions(ax).map(JSONValue.string)),
                "valueSettable": .bool(!secure && AX.settable(ax, kAXValueAttribute))
            ]
            if let parent { data["parentId"] = .string(parent) }
            if let rect { data["frame"] = try rect.jsonValue() }
            if let identifier: String = AX.read(ax, kAXIdentifierAttribute) { data["identifier"] = .string(String(identifier.prefix(500))) }
            flat.append(.object(data))
            if secure { return }
            if depth >= depthLimit {
                if !AX.children(ax, limit: 1).isEmpty { truncated = true }; return
            }
            let remaining = nodeLimit - records.count
            // One extra child detects pagination truncation without materializing a huge AX array.
            let children = AX.children(ax, limit: remaining + 1)
            if children.count > remaining { truncated = true }
            for child in children.prefix(remaining) { try walk(child, parent: elementId, depth: depth + 1) }
        }
        try walk(item.element, parent: nil, depth: 0)
        try ticket.check()
        snapshots = snapshots.filter { uptime - $0.value.lease.createdAt < 30 }
        if snapshots.count >= 16, let oldest = snapshots.min(by: { $0.value.lease.createdAt < $1.value.lease.createdAt })?.key { snapshots.removeValue(forKey: oldest) }
        snapshots[id] = Snapshot(window: item, lease: SnapshotLease(createdAt: uptime, frame: frame), controlEpoch: gate.epoch, elements: records)
        return .object([
            "snapshotId": .string(id), "windowRef": .string(item.ref), "app": .string(item.appName), "title": .string(AX.name(item.element)),
            "frame": try frame.jsonValue(), "expiresInMs": .number(30_000), "elements": .array(flat), "truncated": .bool(truncated),
            "warnings": .array([.string("AX exposes only what the app provides; missing elements are not proof of absence. Secure text values are omitted; screenshots are not redacted.")])
        ])
    }

    private func capture(result: JSONValue, ticket: ControlGate.Ticket) async throws -> JSONValue {
        guard DesktopPermission.screenCapture.isAvailable else {
            throw BridgeFailure("SCREEN_CAPTURE_DENIED", "Enable Screen Recording for the running AgentBridgeLens app in System Settings, then reopen AgentBridgeLens. Observation without screenshots is still available.")
        }
        let id = try result.requiredString("snapshotId")
        let snapshot = try await work { () throws -> Snapshot in
            try ticket.check()
            guard let s = self.snapshots[id] else { throw BridgeFailure("STALE_SNAPSHOT", "Snapshot expired.") }; return s
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        try ticket.check()
        let title = result["title"].string ?? ""
        let candidates = content.windows.filter {
            $0.owningApplication?.processID == snapshot.window.pid && Rect($0.frame).approximatelyEquals(snapshot.lease.frame, tolerance: 2) && ($0.title ?? "") == title
        }
        guard candidates.count == 1, let target = candidates.first else {
            throw BridgeFailure("AMBIGUOUS_CAPTURE", "Could not uniquely match this AX window to a capturable window. No screenshot was taken.")
        }
        let frame = Rect(target.frame)
        guard frame.width > 0, frame.height > 0 else { throw BridgeFailure("INVALID_WINDOW", "Window has no capture area.") }
        let config = SCStreamConfiguration()
        let scale = min(2, 1600 / max(frame.width, frame.height))
        config.width = max(1, Int((frame.width * scale).rounded()))
        config.height = max(1, Int((frame.height * scale).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: config)
        try ticket.check()
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]), png.count <= 7 * 1024 * 1024 else { throw BridgeFailure("CAPTURE_FAILED", "Screenshot could not be encoded within the size budget.") }
        try await work {
            try ticket.check()
            guard var current = self.snapshots[id], let currentFrame = AX.frame(current.window.element) else { throw BridgeFailure("STALE_SNAPSHOT", "Window changed during capture.") }
            try current.lease.validate(now: self.uptime, currentFrame: currentFrame)
            current.imageWidth = image.width; current.imageHeight = image.height; current.imageFrame = frame
            self.snapshots[id] = current
        }
        guard case .object(var object) = result else { return result }
        object["screenshot"] = .object([
            "data": .string(png.base64EncodedString()), "mimeType": .string("image/png"),
            "width": .number(Double(image.width)), "height": .number(Double(image.height)), "screenFrame": try frame.jsonValue(),
            "coordinates": .string("Image pixels, origin top-left. Use this snapshotId with click_point. Do not use global screen coordinates.")
        ])
        return .object(object)
    }

    private func validate(_ snapshot: Snapshot, ticket: ControlGate.Ticket) throws {
        try ticket.check(input: true)
        guard snapshot.controlEpoch == gate.epoch else { throw BridgeFailure("STALE_SNAPSHOT", "Control state or connection changed. Observe again.") }
        _ = try window(snapshot.window.ref)
        guard let frame = AX.frame(snapshot.window.element) else { throw BridgeFailure("STALE_WINDOW", "Window closed.") }
        try snapshot.lease.validate(now: uptime, currentFrame: frame)
        try foreground(snapshot.window)
    }

    private func act(params: JSONValue, ticket: ControlGate.Ticket) throws -> JSONValue {
        let id = try params.requiredString("snapshotId")
        guard let snapshot = snapshots[id] else { throw BridgeFailure("STALE_SNAPSHOT", "Unknown snapshot. Observe again.") }
        try validate(snapshot, ticket: ticket)
        defer {
            for key in Array(snapshots.keys) where snapshots[key]?.window.ref == snapshot.window.ref {
                snapshots.removeValue(forKey: key)
            }
        }
        let operation = params["operation"], action = try operation.requiredString("action")
        var verified = false, detail = "Input dispatched. Observe or wait for the expected state to verify completion."
        if ["press", "set_value", "click"].contains(action) {
            let ref = try operation.requiredString("elementId")
            guard let element = snapshot.elements[ref] else { throw BridgeFailure("STALE_ELEMENT", "Element does not belong to this snapshot.") }
            let role: String? = AX.read(element.ax, kAXRoleAttribute)
            guard role == element.role, AX.name(element.ax) == element.name, AX.value(element.ax) == element.value else {
                throw BridgeFailure("STALE_ELEMENT", "Element changed. Observe again.")
            }
            if let before = element.frame {
                guard let now = AX.frame(element.ax), before.approximatelyEquals(now) else { throw BridgeFailure("STALE_ELEMENT", "Element moved. Observe again.") }
            }
            guard !AX.secure(element.ax) else { throw BridgeFailure("SECURE_FIELD", "Secure fields require user input in this version.") }
            let enabled: Bool = AX.read(element.ax, kAXEnabledAttribute) ?? true
            guard enabled else { throw BridgeFailure("ELEMENT_DISABLED", "Target element is disabled.") }
            try validate(snapshot, ticket: ticket)
            switch action {
            case "press":
                guard AX.actions(element.ax).contains(kAXPressAction) else { throw BridgeFailure("UNSUPPORTED", "Element does not expose AXPress. An explicit click may be possible.") }
                try ticket.check(input: true)
                try AX.check(AXUIElementPerformAction(element.ax, kAXPressAction as CFString), operation: "Press")
            case "set_value":
                guard let text = operation["text"].string, text.count <= 20_000 else { throw BridgeFailure("INVALID_ARGUMENT", "Invalid text value.") }
                guard AX.settable(element.ax, kAXValueAttribute) else { throw BridgeFailure("UNSUPPORTED", "Element value is not settable.") }
                try ticket.check(input: true)
                try AX.check(AXUIElementSetAttributeValue(element.ax, kAXValueAttribute as CFString, text as CFString), operation: "Set value")
                let current: String? = AX.read(element.ax, kAXValueAttribute)
                verified = current == text
                detail = verified ? "AX value read-back matches. Application save/submit is not yet verified." : "Set-value accepted; read-back does not confirm the requested value."
            default:
                guard let rect = AX.frame(element.ax), rect.width > 0, rect.height > 0 else { throw BridgeFailure("INVALID_COORDINATE", "Element has no clickable area.") }
                try click(point: rect.center, snapshot: snapshot, expected: element.ax, ticket: ticket)
            }
        } else if action == "click_point" {
            guard let width = snapshot.imageWidth, let height = snapshot.imageHeight, let frame = snapshot.imageFrame,
                  let x = operation["x"].number, let y = operation["y"].number else { throw BridgeFailure("NO_CAPTURE", "Observe with screenshot before clicking image pixels.") }
            let point = try frame.mapImagePoint(x: x, y: y, imageWidth: width, imageHeight: height)
            try click(point: CGPoint(x: point.0, y: point.1), snapshot: snapshot, expected: nil, ticket: ticket)
        } else if action == "key" {
            try key(operation: operation, snapshot: snapshot, ticket: ticket)
        } else if action == "scroll" {
            let delta = try operation.int("deltaY", default: 0, range: -1000...1000)
            let point: CGPoint
            if let x = operation["x"].number, let y = operation["y"].number,
               let width = snapshot.imageWidth, let height = snapshot.imageHeight, let frame = snapshot.imageFrame {
                let mapped = try frame.mapImagePoint(x: x, y: y, imageWidth: width, imageHeight: height)
                point = CGPoint(x: mapped.0, y: mapped.1)
            } else if operation["x"] != .null || operation["y"] != .null {
                throw BridgeFailure("NO_CAPTURE", "Positioned scrolling requires this snapshot's screenshot.")
            } else { point = snapshot.lease.frame.center }
            try hitTest(point, window: snapshot.window, expected: nil)
            try validate(snapshot, ticket: ticket)
            try requirePostEvents()
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else { throw BridgeFailure("INPUT_FAILED", "Cannot create scroll event.") }
            event.location = point
            try ticket.check(input: true); event.post(tap: .cghidEventTap)
        } else { throw BridgeFailure("INVALID_ARGUMENT", "Unsupported action.") }
        // An action can invalidate all element positions and state. Never reuse its snapshot.
        return .object(["action": .string(action), "dispatched": .bool(true), "verified": .bool(verified), "detail": .string(detail), "snapshotConsumed": .bool(true)])
    }

    private func requirePostEvents() throws {
        guard CGPreflightPostEventAccess() else { throw BridgeFailure("INPUT_DENIED", "macOS has not granted synthetic input access. Check Accessibility permissions locally.") }
    }

    private func hitTest(_ point: CGPoint, window: Window, expected: AXUIElement?) throws {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.3)
        var hit: AXUIElement?
        try AX.check(AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit), operation: "Hit test")
        guard let hit else { throw BridgeFailure("TARGET_OCCLUDED", "No accessible target at this point.") }
        var pid: pid_t = 0
        AXUIElementGetPid(hit, &pid)
        let hitWindow: AXUIElement? = AX.read(hit, kAXWindowAttribute)
        guard pid == window.pid, CFEqual(hit, window.element) || (hitWindow.map { CFEqual($0, window.element) } ?? false) else {
            throw BridgeFailure("TARGET_OCCLUDED", "Another window covers the target point.")
        }
        if let expected {
            var current: AXUIElement? = hit
            for _ in 0..<12 {
                guard let node = current else { break }
                if CFEqual(node, expected) { return }
                current = AX.read(node, kAXParentAttribute)
            }
            throw BridgeFailure("TARGET_OCCLUDED", "The element centre is covered by another element.")
        }
    }

    private func click(point: CGPoint, snapshot: Snapshot, expected: AXUIElement?, ticket: ControlGate.Ticket) throws {
        try requirePostEvents()
        try hitTest(point, window: snapshot.window, expected: expected)
        try validate(snapshot, ticket: ticket)
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw BridgeFailure("INPUT_FAILED", "Cannot create pointer event.") }
        try ticket.check(input: true)
        down.post(tap: .cghidEventTap)
        // Always release a posted mouse-down, even when Stop is pressed between the pair.
        up.post(tap: .cghidEventTap)
    }

    private func key(operation: JSONValue, snapshot: Snapshot, ticket: ControlGate.Ticket) throws {
        let codes: [String: CGKeyCode] = ["return":36,"escape":53,"tab":48,"space":49,"backspace":51,"delete":117,"up":126,"down":125,"left":123,"right":124,"home":115,"end":119,"pageup":116,"pagedown":121,"a":0,"c":8,"v":9,"s":1,"z":6]
        guard let code = codes[try operation.requiredString("key")] else { throw BridgeFailure("INVALID_ARGUMENT", "Unsupported key.") }
        let flagsByName: [String: CGEventFlags] = ["command":.maskCommand,"shift":.maskShift,"option":.maskAlternate,"control":.maskControl]
        var flags: CGEventFlags = []
        let modifiers = operation["modifiers"].array ?? []
        guard modifiers.count <= 4 else { throw BridgeFailure("INVALID_ARGUMENT", "Too many modifiers.") }
        for modifier in modifiers {
            guard let flag = flagsByName[modifier.string ?? ""] else { throw BridgeFailure("INVALID_ARGUMENT", "Unsupported modifier.") }; flags.insert(flag)
        }
        let app = AXUIElementCreateApplication(snapshot.window.pid)
        if let focused: AXUIElement = AX.read(app, kAXFocusedUIElementAttribute), AX.secure(focused) { throw BridgeFailure("SECURE_FIELD", "Secure fields require user input.") }
        try requirePostEvents()
        try validate(snapshot, ticket: ticket)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw BridgeFailure("INPUT_FAILED", "Cannot create key event.") }
        down.flags = flags; up.flags = flags
        try ticket.check(input: true)
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }

    private func waitFor(params: JSONValue, ticket: ControlGate.Ticket) async throws -> JSONValue {
        let timeout = try params.int("timeoutMs", default: 10_000, range: 0...25_000)
        let condition = params["condition"].string ?? "exists"
        guard ["exists", "absent", "enabled", "disabled"].contains(condition), params["name"].string != nil || params["role"].string != nil else {
            throw BridgeFailure("INVALID_ARGUMENT", "Specify name or role and a supported condition.")
        }
        let deadline = uptime + Double(timeout) / 1000
        repeat {
            try ticket.check()
            let result = try await work { try self.observe(params: params, ticket: ticket) }
            let nodes = result["elements"].array ?? []
            let matches = nodes.filter { node in
                (params["name"].string.map { node["name"].string == $0 } ?? true) &&
                (params["role"].string.map { node["role"].string == $0 } ?? true) &&
                (params["value"].string.map { node["value"].string == $0 } ?? true)
            }
            let matched: Bool
            switch condition {
            case "absent": matched = matches.isEmpty && result["truncated"].bool != true
            case "enabled": matched = matches.contains { $0["enabled"].bool == true }
            case "disabled": matched = matches.contains { $0["enabled"].bool == false }
            default: matched = !matches.isEmpty
            }
            if matched { return .object(["matched": .bool(true), "snapshotId": result["snapshotId"], "windowRef": params["windowRef"], "elements": .array(matches)]) }
            if uptime >= deadline { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while uptime < deadline
        throw BridgeFailure("WAIT_TIMEOUT", "Condition was not observed before timeout. Missing AX elements may reflect incomplete accessibility support.")
    }
}
