import Foundation
import Security
import BridgeCore

enum RemoteBridgeCredential {
    private static func query(for endpoint: URL) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "tech.xinyu.agentbridgemac.remote-bridge",
            kSecAttrAccount as String: endpoint.absoluteString
        ]
    }

    static func read(endpoint: URL) throws -> String {
        var request = query(for: endpoint)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        guard status != errSecItemNotFound else {
            throw BridgeFailure("REMOTE_TOKEN_MISSING", "请在「连接客户端」中输入远程 Bridge 的配对令牌。")
        }
        guard status == errSecSuccess, let bytes = result as? Data,
              let token = String(data: bytes, encoding: .utf8),
              RemoteBridgeEndpoint.validToken(token) else {
            throw keychainError
        }
        return token
    }

    static func save(_ token: String, endpoint: URL) throws {
        guard RemoteBridgeEndpoint.validToken(token) else {
            throw BridgeFailure("INVALID_REMOTE_TOKEN", "请输入 32–128 位远程配对令牌，只使用字母、数字、短横线或下划线。")
        }
        var request = query(for: endpoint)
        let bytes = Data(token.utf8)
        let update = [kSecValueData as String: bytes] as CFDictionary
        var status = SecItemUpdate(request as CFDictionary, update)
        if status == errSecItemNotFound {
            request[kSecValueData as String] = bytes
            status = SecItemAdd(request as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw keychainError }
    }

    private static let keychainError = BridgeFailure("KEYCHAIN_UNAVAILABLE", "无法访问 macOS 钥匙串。请解锁钥匙串，或重新输入远程配对令牌。")
}
