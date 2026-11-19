import Foundation
import BridgeCore

struct CheckFailure: Error { let message: String }
func expect(_ condition: @autoclosure () -> Bool, _ message: String = "Expectation failed") throws {
    if !condition() { throw CheckFailure(message: message) }
}
func expectThrows(_ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw CheckFailure(message: "Expected an error")
}

/// Runs with Command Line Tools alone; does not depend on full Xcode's XCTest.
@main
enum BridgeCoreChecks {
    static func main() throws {
        try stopInvalidatesQueuedInputAndRequiresLocalEnable()
        try cancellationIsPerRequest()
        try staleAndMovedSnapshotRejected()
        try retinaAndNegativeDisplayOriginMapping()
        try wireRoundTripAndMalformedArguments()
        try mcpConfigurationResolvesPathsAndValidatesPorts()
        if let path = CommandLine.arguments.dropFirst().first {
            let fixture = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            let decode = { (value: JSONValue) throws -> WireMessage in
                try JSONDecoder().decode(WireMessage.self, from: JSONEncoder().encode(value))
            }
            let hello = try decode(fixture["hello"]), request = try decode(fixture["request"])
            let response = try decode(fixture["response"]), cancel = try decode(fixture["cancel"])
            try expect(hello.protocolVersion == 1 && hello.type == "hello")
            try expect(request.tool == "mac_observe" && request.params?["windowRef"].string == "fixture-window")
            try expect(response.id == request.id && response.result?["snapshotId"].string == "fixture-snapshot")
            try expect(cancel.type == "cancel" && cancel.id == request.id)
            print("PASS: shared native wire fixture decoded by Swift.")
        }
        print("PASS: 6 Swift core checks (stop, cancellation, snapshot lifetime, coordinates, protocol, app configuration).")
    }
    static func stopInvalidatesQueuedInputAndRequiresLocalEnable() throws {
        let gate = ControlGate()
        try expectThrows { try gate.ticket(id: "a").check(input: true) }
        gate.setEnabled(true)
        let old = gate.ticket(id: "b")
        try old.check(input: true)
        gate.stop()
        try expectThrows { try old.check(input: true) }
        gate.setEnabled(true)
        try expectThrows { try old.check(input: true) }
        try gate.ticket(id: "c").check(input: true)
    }
    static func cancellationIsPerRequest() throws {
        let gate = ControlGate()
        let a = gate.ticket(id: "a"), b = gate.ticket(id: "b")
        gate.cancel("a")
        try expectThrows { try a.check() }
        try b.check()
        gate.finish("a")
    }
    static func staleAndMovedSnapshotRejected() throws {
        let frame = Rect(x: -1600, y: 40, width: 800, height: 600)
        let lease = SnapshotLease(createdAt: 100, frame: frame)
        try lease.validate(now: 129, currentFrame: frame)
        try expectThrows { try lease.validate(now: 130, currentFrame: frame) }
        try expectThrows { try lease.validate(now: 99, currentFrame: frame) }
        try expectThrows { try lease.validate(now: 101, currentFrame: Rect(x: 0, y: 40, width: 800, height: 600)) }
    }
    static func retinaAndNegativeDisplayOriginMapping() throws {
        let frame = Rect(x: -1600, y: 40, width: 800, height: 600)
        let point = try frame.mapImagePoint(x: 800, y: 600, imageWidth: 1600, imageHeight: 1200)
        try expect(point.0 == -1200); try expect(point.1 == 340)
        try expectThrows { _ = try frame.mapImagePoint(x: 1600, y: 0, imageWidth: 1600, imageHeight: 1200) }
        try expectThrows { _ = try frame.mapImagePoint(x: .nan, y: 0, imageWidth: 1600, imageHeight: 1200) }
    }
    static func wireRoundTripAndMalformedArguments() throws {
        let value = JSONValue.object(["nested": .array([.bool(true), .null, .number(4), .string("保存")])])
        let message = WireMessage(type: "response", id: "a", result: value)
        let decoded = try JSONDecoder().decode(WireMessage.self, from: JSONEncoder().encode(message))
        try expect(decoded.result == value)
        try expectThrows { _ = try value.requiredString("missing") }
        try expectThrows { _ = try JSONValue.object(["depth": .number(1.5)]).int("depth", default: 8, range: 1...15) }
    }
    static func mcpConfigurationResolvesPathsAndValidatesPorts() throws {
        let executable = "/Applications/AgentBridgeLens 副本.app/Contents/MacOS/AgentBridgeMac"
        let tokenFile = "/Users/Example name/.agentbridgemac/token"
        let config = try MCPConfiguration(executablePath: executable, port: "019224", tokenFile: tokenFile)
        let json = try JSONDecoder().decode(JSONValue.self, from: Data(config.json().utf8))
        let server = json["mcpServers"]["agentbridgelens"]
        try expect(server["command"].string == executable)
        try expect(server["args"] == .array([.string("--mcp")]))
        try expect(server["env"]["BRIDGELENS_MAC_PORT"].string == "19224")
        try expect(server["env"]["BRIDGELENS_MAC_TOKEN_FILE"].string == tokenFile)
        try expect(MCPConfiguration.validPort("65536") == nil)
        try expect(MCPConfiguration.validPort("+19224") == nil)
        try expectThrows {
            _ = try MCPConfiguration(executablePath: "relative", port: "19224", tokenFile: tokenFile)
        }
    }

}
