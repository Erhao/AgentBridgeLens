import AppKit
import ApplicationServices
import BridgeCore

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
        case .waitingForClient: "请保持应用运行，并在 AI 客户端中添加或重载 MCP 配置。"
        case .connecting: "正在等待本机 Bridge 完成握手。"
        case .connected: "本机 Bridge 已完成握手，可以查询桌面能力。"
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
    @Published var controlEnabled = false
    @Published var port: String
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
        if !accessibility && controlEnabled { stop() }
    }

    func setControl(_ enabled: Bool) {
        refreshPermissions()
        controlEnabled = enabled && accessibility && connected
        gate.setEnabled(controlEnabled)
        record(controlEnabled ? "用户已开启控制" : "控制已关闭")
    }

    func stop() {
        gate.stop(); controlEnabled = false
        for job in jobs.values { job.cancel() }
        record("已停止：待执行操作已取消，控制已关闭")
    }

    func start() {
        disconnect()
        guard let number = MCPConfiguration.validPort(port) else {
            connection = .problem("本机端口须为 1024–65535。")
            return
        }
        connection = .waitingForClient
        if !smoke { UserDefaults.standard.set(port, forKey: "bridgePort") }
        runner = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do { try await self.connectOnce(port: number); delay = 1 }
                catch {
                    if Task.isCancelled { break }
                    if self.connected { self.record("Bridge 已断开") }
                    self.connection = self.connectionStatus(for: error)
                }
                if Task.isCancelled { break }
                self.controlEnabled = false; self.gate.stop()
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
        sessionId = UUID(); gate.stop(); controlEnabled = false
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
            return .waitingForClient
        case .badServerResponse, .userAuthenticationRequired:
            return .problem("本机 Bridge 拒绝连接。请检查端口、配对或是否有另一个已连接的实例。")
        default:
            return .problem("握手未完成。请重载 AI 客户端的 MCP 配置后重试。")
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

    private func connectOnce(port: Int) async throws {
        let token = try loadToken(), currentSession = UUID()
        sessionId = currentSession
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(port)/native")!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let ws = URLSession.shared.webSocketTask(with: request)
        ws.maximumMessageSize = 12 * 1024 * 1024
        socket = ws; ws.resume()
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
                acknowledged = true; connection = .connected; record("Bridge 已连接，桌面控制关闭")
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
