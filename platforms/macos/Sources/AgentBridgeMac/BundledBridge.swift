import Darwin
import Foundation
import BridgeCore

enum BundledBridge {
    private static let resources = Bundle.main.resourceURL
    private static let node = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node")
    private static var entry: URL? { resources?.appendingPathComponent("bridge/dist/index.js") }

    static var isAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: node.path)
            && (entry.map { FileManager.default.isReadableFile(atPath: $0.path) } ?? false)
    }

    static var launcherURL: URL? { Bundle.main.executableURL }

    static func configuration(port: String, tokenFile: URL) throws -> String {
        guard isAvailable, let launcherURL else {
            throw BridgeFailure("MISSING_BRIDGE", "此应用未包含 Bridge，请安装完整版本。")
        }
        let configuration = try MCPConfiguration(
            executablePath: launcherURL.path,
            port: port,
            tokenFile: tokenFile.path
        )
        return try configuration.json()
    }

    /// Replace this process so the client owns stdio, signals and exit status directly.
    static func launch() -> Never {
        guard isAvailable, let entry else { fail("Bundled Bridge is missing. Install the full AgentBridgeLens app.") }
        unsetenv("NODE_OPTIONS")
        unsetenv("NODE_PATH")
        setenv("BRIDGELENS_TRANSPORT", "stdio", 1)
        setenv("BRIDGELENS_HOST", "127.0.0.1", 1)
        setenv("BRIDGELENS_DESKTOP", "1", 1)
        let values = [node.path, entry.path]
        var arguments: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
        arguments.append(nil)
        _ = arguments.withUnsafeMutableBufferPointer { argv in
            node.path.withCString { execv($0, argv.baseAddress!) }
        }
        fail("Could not launch the bundled Bridge: \(String(cString: strerror(errno)))")
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(EXIT_FAILURE)
    }
}
