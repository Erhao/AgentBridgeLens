import Foundation

public struct MCPConfiguration {
    private let executablePath: String
    private let port: String
    private let tokenFile: String

    public init(executablePath: String, port: String, tokenFile: String) throws {
        guard executablePath.hasPrefix("/"), tokenFile.hasPrefix("/") else {
            throw BridgeFailure("INVALID_PATH", "客户端需要使用本机的绝对路径。")
        }
        guard let port = Self.validPort(port) else {
            throw BridgeFailure("INVALID_PORT", "本机端口须为 1024–65535。")
        }
        self.executablePath = executablePath
        self.port = String(port)
        self.tokenFile = tokenFile
    }

    public static func validPort(_ value: String) -> Int? {
        guard value.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(value), (1024...65535).contains(port) else { return nil }
        return port
    }

    public func json() throws -> String {
        struct Server: Encodable {
            let command: String
            let args: [String]
            let env: [String: String]
        }

        let server = Server(command: executablePath, args: ["--mcp"], env: [
            "BRIDGELENS_MAC_PORT": port,
            "BRIDGELENS_MAC_TOKEN_FILE": tokenFile
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(["mcpServers": ["agentbridgelens": server]])
        return String(decoding: data, as: UTF8.self) + "\n"
    }
}
