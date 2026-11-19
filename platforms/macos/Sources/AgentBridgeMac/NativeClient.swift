import AppKit
import ApplicationServices
import BridgeCore

enum BridgeMode: String, Hashable {
    case local, remote
}

// A paired credential may only be sent to the URL the user chose.
private final class BridgeSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum DesktopConnection: Equatable {
    case disconnected, waitingForClient, connecting, connected, problem(String)

    var title: String {
        switch self {
        case .disconnected: "桌面连接已断开"
        case .waitingForClient: "等待 AI 客户端"
        case .connecting: "正在连接 Bridge"
        case .connected: "AI 客户端已连接"
        case .problem: "连接需要检查"
        }
    }

    var detail: String {
        switch self {
        case .disconnected: "在「连接客户端」中重新连接。"
        case .waitingForClient: "保持应用运行，并启动使用这份 MCP 配置的 AI 会话。"
        case .connecting: "正在等待 Bridge 完成握手。"
        case .connected: "Bridge 已完成握手，可以查询桌面能力。"
        case .problem(let message): message
        }
    }
}

struct DesktopActivity: Identifiable {
    let id = UUID()
    let time = Date()
    let message: String
}

@MainActor
final class NativeClient: ObservableObject {
    @Published private(set) var connection: DesktopConnection = .waitingForClient
    var connected: Bool { connection == .connected }
    @Published private(set) var pendingCount = 0
    @Published private(set) var permissions = DesktopPermissions()
    var accessibility: Bool { permissions.accessibility }
    var screenCapture: Bool { permissions.screenCapture }
    @Published private(set) var controlConsent: DesktopControlConsent = .off
    var controlEnabled: Bool { controlConsent == .active }
    var controlRequested: Bool { controlConsent != .off }
    @Published var port: String
    @Published private(set) var mode: BridgeMode
    @Published private(set) var remoteAddress: String
    private lazy var websocketSession = URLSession(
        configuration: .ephemeral, delegate: BridgeSessionDelegate(), delegateQueue: nil
    )
    @Published private(set) var activity: [DesktopActivity] = []
    let gate = ControlGate()
    private lazy var engine = DesktopEngine(gate: gate)
    private var runner: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var jobs: [String: Task<Void, Never>] = [:]
    private var sessionId = UUID()
    private let smoke: Bool

    init(smoke: Bool = false) {
        self.smoke = smoke
        let environment = ProcessInfo.processInfo.environment
        port = environment["BRIDGELENS_MAC_PORT"] ?? environment["AGENTBRIDGEMAC_PORT"]
            ?? UserDefaults.standard.string(forKey: "bridgePort") ?? "19224"
        if smoke, let endpoint = environment["ABL_MAC_SMOKE_REMOTE_URL"] {
            mode = .remote
            remoteAddress = endpoint
        } else {
            let defaults = UserDefaults.standard
            mode = smoke ? .local : BridgeMode(rawValue: defaults.string(forKey: "bridgeMode") ?? "") ?? .local
            remoteAddress = smoke ? "" : defaults.string(forKey: "remoteBridgeURL") ?? ""
        }
        if !smoke { Task { [weak self] in self?.start() } }
    }

    var tokenFile: URL {
        let environment = ProcessInfo.processInfo.environment
        if let path = environment["BRIDGELENS_MAC_TOKEN_FILE"] ?? environment["AGENTBRIDGEMAC_TOKEN_FILE"] {
            return URL(fileURLWithPath: path)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentbridgemac/token")
    }

    func refreshPermissions() {
        let current = DesktopPermissions()
        if current != permissions { permissions = current }
        if !accessibility && controlRequested { stop() }
    }

    func setControl(_ enabled: Bool) {
        refreshPermissions()
        var next = controlConsent
        next.setRequested(enabled, connected: connected, accessibility: accessibility)
        updateControlConsent(next)
        switch next {
        case .off: record("控制已关闭")
        case .waitingForConnection: record("已允许下一次连接控制，等待 Bridge")
        case .active: record("用户已开启控制")
        }
    }

    private func updateControlConsent(_ next: DesktopControlConsent) {
        guard controlConsent != next else { return }
        let inputEnabled = next == .active
        if gate.isEnabled != inputEnabled { gate.setEnabled(inputEnabled) }
        controlConsent = next
    }

    func stop() {
        gate.stop()
        updateControlConsent(.off)
        for job in jobs.values { job.cancel() }
        record("已停止：待执行操作已取消，控制已关闭")
    }

    func useLocalBridge() {
        mode = .local
        UserDefaults.standard.set(mode.rawValue, forKey: "bridgeMode")
        start()
    }

    func useRemoteBridge(address: String, token: String) throws {
        let endpoint = try RemoteBridgeEndpoint(address).url
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            _ = try RemoteBridgeCredential.read(endpoint: endpoint)
        } else {
            try RemoteBridgeCredential.save(token, endpoint: endpoint)
        }

        mode = .remote
        remoteAddress = endpoint.absoluteString
        UserDefaults.standard.set(mode.rawValue, forKey: "bridgeMode")
        UserDefaults.standard.set(remoteAddress, forKey: "remoteBridgeURL")
        start()
    }

    func reconnect() {
        // This action retries the saved target. Configuration changes use start()
        // directly and clear any consent for the previous target.
        start(keepPendingControl: controlConsent == .waitingForConnection)
    }

    func start(keepPendingControl: Bool = false) {
        disconnect()
        if keepPendingControl && accessibility { updateControlConsent(.waitingForConnection) }
        let url: URL
        let remoteToken: String?
        do {
            if mode == .remote {
                url = try RemoteBridgeEndpoint(remoteAddress).url
                if smoke, let fixtureToken = ProcessInfo.processInfo.environment["ABL_MAC_SMOKE_REMOTE_TOKEN"] {
                    remoteToken = fixtureToken
                } else {
                    remoteToken = try RemoteBridgeCredential.read(endpoint: url)
                }
            } else {
                guard let number = MCPConfiguration.validPort(port),
                      let localURL = URL(string: "ws://127.0.0.1:\(number)/native") else {
                    throw BridgeFailure("INVALID_PORT", "本机端口须为 1024–65535。")
                }
                url = localURL
                remoteToken = nil
                if !smoke { UserDefaults.standard.set(port, forKey: "bridgePort") }
            }
        } catch {
            connection = connectionStatus(for: error)
            return
        }
        connection = mode == .remote ? .connecting : .waitingForClient
        runner = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do { try await self.connectOnce(url: url, remoteToken: remoteToken); delay = 1 }
                catch {
                    if Task.isCancelled { break }
                    var next = self.controlConsent
                    next.connectionDidEnd()
                    self.gate.stop()
                    self.updateControlConsent(next)
                    if self.connected { self.record("Bridge 已断开") }
                    self.connection = self.connectionStatus(for: error)
                }
                if Task.isCancelled { break }
                for job in self.jobs.values { job.cancel() }
                self.jobs.removeAll()
                self.pendingCount = 0
                self.socket?.cancel(with: .goingAway, reason: nil); self.socket = nil
                do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { break }
                delay = min(10, delay * 2)
            }
        }
    }

    func disconnect() {
        sessionId = UUID()
        gate.stop()
        updateControlConsent(.off)
        runner?.cancel(); runner = nil
        for job in jobs.values { job.cancel() }; jobs.removeAll()
        pendingCount = 0
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connection = .disconnected
    }

    private func connectionStatus(for error: Error) -> DesktopConnection {
        if let failure = error as? BridgeFailure {
            return failure.code == "WAITING_FOR_CLIENT" ? .waitingForClient : .problem(failure.message)
        }
        switch (error as? URLError)?.code {
        case .cannotConnectToHost, .networkConnectionLost, .timedOut:
            return mode == .remote
                ? .problem("无法连接远程 Bridge。请核对地址、网络和服务状态，App 会自动重试。")
                : .waitingForClient
        case .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .secureConnectionFailed:
            return .problem("远程 Bridge 的 TLS 连接未通过验证。请检查域名和证书。")
        case .badServerResponse, .userAuthenticationRequired:
            return .problem("Bridge 拒绝连接。请核对配对令牌，并确认该桌面连接没有被占用。")
        default:
            return mode == .remote
                ? .problem("远程握手未完成。请检查地址和远程 Bridge 版本。")
                : .problem("握手未完成。请重载 AI 客户端的 MCP 配置后重试。")
        }
    }

    private func loadToken() throws -> String {
        guard FileManager.default.fileExists(atPath: tokenFile.path) else {
            throw BridgeFailure("WAITING_FOR_CLIENT", "等待客户端启动 Bridge。")
        }
        let values = try? tokenFile.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard values?.isRegularFile == true, values?.isSymbolicLink != true,
              let attrs = try? FileManager.default.attributesOfItem(atPath: tokenFile.path),
              let mode = attrs[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0,
              let data = try? String(contentsOf: tokenFile, encoding: .utf8) else {
            throw BridgeFailure("PAIRING_REQUIRED", "配对文件无法读取，或允许了其他用户读取。请检查权限后重新连接。")
        }
        let value = data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.count == 64, value.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw BridgeFailure("PAIRING_REQUIRED", "配对文件格式错误") }
        return value
    }

    private func connectOnce(url: URL, remoteToken: String?) async throws {
        let token = try remoteToken ?? loadToken()
        let currentSession = UUID()
        sessionId = currentSession
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let ws = websocketSession.webSocketTask(with: request)
        ws.maximumMessageSize = 12 * 1024 * 1024
        socket = ws; ws.resume()
        let handshakeDeadline = Task {
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            ws.cancel(with: .goingAway, reason: nil)
        }
        defer { handshakeDeadline.cancel() }
        // Keep stable waiting UI while retrying a client which hasn't started yet.
        var hello = WireMessage(type: "hello")
        hello.protocolVersion = 1; hello.version = BuildInfo.version; hello.capabilities = DesktopEngine.capabilities
        let defaults = UserDefaults.standard
        let deviceId = smoke ? "transport-smoke" : (defaults.string(forKey: "deviceId") ?? UUID().uuidString)
        if !smoke { defaults.set(deviceId, forKey: "deviceId") }
        hello.deviceId = deviceId
        try await send(hello, socket: ws)
        guard !Task.isCancelled, sessionId == currentSession else { return }
        connection = .connecting
        var acknowledged = false
        while !Task.isCancelled && sessionId == currentSession {
            let message = try await ws.receive()
            guard !Task.isCancelled, sessionId == currentSession else { return }
            let data: Data
            switch message {
            case .data(let raw): data = raw
            case .string(let raw): data = Data(raw.utf8)
            @unknown default: throw BridgeFailure("INVALID_PROTOCOL", "Unsupported WebSocket message")
            }
            let wire = try JSONDecoder().decode(WireMessage.self, from: data)
            if !acknowledged {
                guard wire.type == "hello_ack", wire.protocolVersion == 1 else { throw BridgeFailure("INVALID_PROTOCOL", "Bridge 协议版本不匹配") }
                handshakeDeadline.cancel()
                acknowledged = true
                refreshPermissions()
                var next = controlConsent
                next.connectionDidAuthenticate(accessibility: accessibility)
                updateControlConsent(next)
                connection = .connected
                record(controlEnabled ? "Bridge 已连接，预授权的桌面控制已开启" : "Bridge 已连接，桌面控制关闭")
                continue
            }
            if wire.type == "cancel" {
                if let id = wire.id, let job = jobs[id] { gate.cancel(id); job.cancel() }
                continue
            }
            guard wire.type == "request", let id = wire.id, id.count <= 100, let tool = wire.tool, jobs[id] == nil else {
                throw BridgeFailure("INVALID_PROTOCOL", "Malformed or duplicate request")
            }
            if tool == "mac_stop" {
                stop()
                try await send(WireMessage(type: "response", id: id, result: .object(["stopped": .bool(true), "controlEnabled": .bool(false), "detail": .string("Queued work cancelled. Already dispatched OS events cannot be undone. Re-enable only from the Mac app.")])), socket: ws)
                continue
            }
            guard jobs.count < 32 else {
                try await send(WireMessage(type: "response", id: id, error: BridgeFailure("BUSY", "Native queue is full.")), socket: ws); continue
            }
            let ticket = gate.ticket(id: id)
            jobs[id] = Task { [weak self] in
                guard let self else { return }
                defer {
                    if self.sessionId == currentSession {
                        self.jobs.removeValue(forKey: id)
                        self.pendingCount = self.jobs.count
                    }
                    self.gate.finish(id)
                }
                let response: WireMessage
                do {
                    let result: JSONValue
                    if self.smoke {
                        try ticket.check()
                        if tool == "mac_get_status" { result = .object(["transportSmokeTest": .bool(true), "controlEnabled": .bool(false)]) }
                        else { throw BridgeFailure("SMOKE_MODE", "Desktop operations are disabled in transport smoke mode.") }
                    } else { result = try await self.engine.handle(tool: tool, params: wire.params ?? .object([:]), ticket: ticket) }
                    try ticket.check()
                    response = WireMessage(type: "response", id: id, result: result)
                    self.record("\(Self.activityName(for: tool)) · 已返回结果")
                } catch {
                    let failure = (error as? BridgeFailure) ?? BridgeFailure(error is CancellationError ? "CANCELLED" : "NATIVE_ERROR", error.localizedDescription)
                    response = WireMessage(type: "response", id: id, error: failure)
                    self.record("\(Self.activityName(for: tool)) · \(failure.code)")
                }
                guard self.sessionId == currentSession, self.socket === ws else { return }
                do { try await self.send(response, socket: ws) } catch { ws.cancel(with: .goingAway, reason: nil) }
            }
            pendingCount = jobs.count
        }
    }

    private func send(_ value: WireMessage, socket: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else { throw BridgeFailure("ENCODING_ERROR", "Cannot encode message") }
        try await socket.send(.string(text))
    }

    func clearActivity() { activity.removeAll() }

    private func record(_ message: String) {
        activity.insert(DesktopActivity(message: message), at: 0)
        if activity.count > 50 { activity.removeLast() }
    }

    private static func activityName(for tool: String) -> String {
        switch tool {
        case "mac_get_status": "查询桌面状态"
        case "mac_list_windows": "列出窗口"
        case "mac_focus_window": "聚焦窗口"
        case "mac_observe": "观察窗口"
        case "mac_act": "操作桌面"
        case "mac_wait_for": "等待控件"
        default: "桌面请求"
        }
    }
}
