import AppKit
import ApplicationServices
import BridgeCore

enum AX {
    static func read<T>(_ element: AXUIElement, _ attribute: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? T
    }
    static func children(_ element: AXUIElement, attribute: String = kAXChildrenAttribute, limit: Int) -> [AXUIElement] {
        guard limit > 0 else { return [] }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, attribute as CFString, &count) == .success, count > 0 else { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, attribute as CFString, 0, min(count, limit), &values) == .success else { return [] }
        return values as? [AXUIElement] ?? []
    }
    static func actions(_ element: AXUIElement) -> [String] {
        var values: CFArray?
        guard AXUIElementCopyActionNames(element, &values) == .success else { return [] }
        return values as? [String] ?? []
    }
    static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var answer = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &answer) == .success && answer.boolValue
    }
    static func frame(_ element: AXUIElement) -> Rect? {
        guard let p: AXValue = read(element, kAXPositionAttribute), let s: AXValue = read(element, kAXSizeAttribute),
              AXValueGetType(p) == .cgPoint, AXValueGetType(s) == .cgSize else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p, .cgPoint, &point), AXValueGetValue(s, .cgSize, &size) else { return nil }
        return Rect(x: point.x, y: point.y, width: size.width, height: size.height)
    }
    static func name(_ element: AXUIElement) -> String {
        for key in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let value: String = read(element, key), !value.isEmpty { return String(value.prefix(500)) }
        }
        if let label: AXUIElement = read(element, kAXTitleUIElementAttribute) {
            let title: String? = read(label, kAXValueAttribute)
            return String((title ?? "").prefix(500))
        }
        return ""
    }
    static func secure(_ element: AXUIElement) -> Bool {
        let subrole: String? = read(element, kAXSubroleAttribute)
        return subrole == "AXSecureTextField"
    }
    static func value(_ element: AXUIElement) -> JSONValue {
        if secure(element) { return .null }
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw) == .success else { return .null }
        if let text = raw as? String { return .string(String(text.prefix(1000))) }
        if let number = raw as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
            return .number(number.doubleValue)
        }
        return .null
    }
    static func requireTrust() throws {
        guard DesktopPermission.accessibility.isAvailable else {
            throw BridgeFailure("ACCESSIBILITY_DENIED", "Enable Accessibility for the running AgentBridgeLens app in System Settings. Refresh permissions or reopen AgentBridgeLens.")
        }
    }
    static func check(_ error: AXError, operation: String) throws {
        guard error != .success else { return }
        let code: String
        switch error {
        case .invalidUIElement: code = "STALE_ELEMENT"
        case .apiDisabled: code = "ACCESSIBILITY_DENIED"
        case .actionUnsupported, .attributeUnsupported, .notImplemented: code = "UNSUPPORTED"
        case .cannotComplete: code = "APP_UNRESPONSIVE"
        default: code = "AX_ERROR"
        }
        throw BridgeFailure(code, "\(operation) failed (AX \(error.rawValue)). Observe again; do not blindly repeat an action.")
    }
}

extension Encodable {
    func jsonValue() throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(self)) }
}

extension Rect {
    var center: CGPoint { CGPoint(x: x + width / 2, y: y + height / 2) }
    init(_ rect: CGRect) { self.init(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height) }
}
