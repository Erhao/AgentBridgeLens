import Foundation

public struct RemoteBridgeEndpoint {
    public let url: URL

    public init(_ input: String) throws {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true else {
            throw Self.invalidAddress
        }
        let scheme = parts.scheme?.lowercased()
        let loopback = ["127.0.0.1", "[::1]", "::1"].contains(host)
        guard scheme == "wss" || (scheme == "ws" && loopback) else { throw Self.invalidAddress }
        parts.scheme = scheme
        parts.host = host
        if parts.path.isEmpty || parts.path == "/" { parts.path = "/native" }
        guard parts.percentEncodedPath == "/native", let url = parts.url else {
            throw Self.invalidAddress
        }
        self.url = url
    }

    public static func validToken(_ value: String) -> Bool {
        (32...128).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0)
                || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private static var invalidAddress: BridgeFailure {
        BridgeFailure("INVALID_REMOTE_ADDRESS", "请输入 wss://主机/native。本机 SSH 隧道可用 ws://127.0.0.1:端口/native。地址不能包含凭据、查询参数或片段。")
    }
}
