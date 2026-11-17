import Foundation

public enum JSONValue: Codable, Equatable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }

    public subscript(key: String) -> JSONValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var number: Double? { if case .number(let v) = self { return v }; return nil }
    public var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var array: [JSONValue]? { if case .array(let v) = self { return v }; return nil }

    public func requiredString(_ key: String, limit: Int = 100) throws -> String {
        guard let value = self[key].string, !value.isEmpty, value.count <= limit else {
            throw BridgeFailure("INVALID_ARGUMENT", "Missing or invalid \(key).")
        }
        return value
    }
    public func int(_ key: String, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
        if self[key] == .null { return fallback }
        guard let value = self[key].number, value.isFinite, value.rounded() == value,
              value >= Double(range.lowerBound), value <= Double(range.upperBound) else {
            throw BridgeFailure("INVALID_ARGUMENT", "Invalid \(key).")
        }
        return Int(value)
    }
}

public struct BridgeFailure: Error, Codable, LocalizedError {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}

public struct WireMessage: Codable {
    public let type: String
    public var id: String?
    public var tool: String?
    public var params: JSONValue?
    public var protocolVersion: Int?
    public var deviceId: String?
    public var version: String?
    public var capabilities: [String]?
    public var result: JSONValue?
    public var error: BridgeFailure?
    public init(type: String, id: String? = nil, result: JSONValue? = nil, error: BridgeFailure? = nil) {
        self.type = type; self.id = id; self.result = result; self.error = error
    }
}

/// Stored independently from AppKit/AX, so lifetime and input guards are testable.
public struct Rect: Codable, Equatable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public func approximatelyEquals(_ other: Rect, tolerance: Double = 1) -> Bool {
        abs(x - other.x) <= tolerance && abs(y - other.y) <= tolerance &&
        abs(width - other.width) <= tolerance && abs(height - other.height) <= tolerance
    }
    public func mapImagePoint(x px: Double, y py: Double, imageWidth: Int, imageHeight: Int) throws -> (Double, Double) {
        guard px.isFinite, py.isFinite, width > 0, height > 0, imageWidth > 0, imageHeight > 0,
              px >= 0, py >= 0, px < Double(imageWidth), py < Double(imageHeight) else {
            throw BridgeFailure("INVALID_COORDINATE", "Point is outside the captured image.")
        }
        return (x + px / Double(imageWidth) * width, y + py / Double(imageHeight) * height)
    }
}

public struct SnapshotLease {
    public let createdAt: TimeInterval
    public let frame: Rect
    public init(createdAt: TimeInterval, frame: Rect) { self.createdAt = createdAt; self.frame = frame }
    public func validate(now: TimeInterval, currentFrame: Rect) throws {
        guard now >= createdAt, now - createdAt < 30 else { throw BridgeFailure("STALE_SNAPSHOT", "Snapshot expired. Observe again.") }
        guard frame.approximatelyEquals(currentFrame) else { throw BridgeFailure("WINDOW_MOVED", "Window moved or resized. Observe again.") }
    }
}
