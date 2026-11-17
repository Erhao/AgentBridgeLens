import AppKit
import ApplicationServices
import BridgeCore

@MainActor
final class NativeClient: ObservableObject {
    @Published var connection = "尚未连接"
    @Published var connected = false
    @Published var accessibility = AXIsProcessTrusted()
    @Published var screenCapture = CGPreflightScreenCaptureAccess()
    @Published var controlEnabled = false
    @Published var port: String
    @Published var activity: [String] = []
    let gate = ControlGate()
    private lazy var engine = DesktopEngine(gate: gate)
    private var runner: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var jobs: [String: Task<Void, Never>] = [:]
    private var sessionId = UUID()
    private let smoke: Bool

    init(smoke: Bool = false) {
        self.smoke = smoke
        port = ProcessInfo.processInfo.environment["AGENTBRIDGEMAC_PORT"] ?? UserDefaults.standard.string(forKey: "bridgePort") ?? "19224"
        if !smoke { Task { [weak self] in self?.start() } }
    }

    var tokenFile: URL {
        if let path = ProcessInfo.processInfo.environment["AGENTBRIDGEMAC_TOKEN_FILE"] { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentbridgemac/token")
    }

    func refreshPermissions() {
        accessibility = AXIsProcessTrusted(); screenCapture = CGPreflightScreenCaptureAccess()
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
        guard let number = Int(port), (1024...65535).contains(number) else { connection = "端口须为 1024–65535"; return }
        if !smoke { UserDefaults.standard.set(port, forKey: "bridgePort") }
        runner = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do { try await self.connectOnce(port: number); delay = 1 }
                catch {
                    if Task.isCancelled { break }
                    self.connection = (error as? BridgeFailure)?.message ?? "连接中断，正在重连"
                }
                if Task.isCancelled { break }
                self.connected = false; self.controlEnabled = false; self.gate.stop()
                for job in self.jobs.values { job.cancel() }
                self.jobs.removeAll()
                self.socket?.cancel(with: .goingAway, reason: nil); self.socket = nil
                do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { break }
                delay = min(10, delay * 2)
            }
        }
    }

    func disconnect() {
        sessionId = UUID(); gate.stop(); controlEnabled = false; connected = false
        runner?.cancel(); runner = nil
        for job in jobs.values { job.cancel() }; jobs.removeAll()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        connection = "尚未连接"
    }

    private func loadToken() throws -> String {
        let values = try? tokenFile.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard values?.isRegularFile == true, values?.isSymbolicLink != true,
              let attrs = try? FileManager.default.attributesOfItem(atPath: tokenFile.path),
              let mode = attrs[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0,
              let data = try? String(contentsOf: tokenFile, encoding: .utf8) else {
            throw BridgeFailure("PAIRING_REQUIRED", "请先在此 Mac 上运行 Bridge --init，配对文件须仅本人可读")
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
        socket = ws; connection = "正在连接本机 Bridge"; ws.resume()
        var hello = WireMessage(type: "hello")
        hello.protocolVersion = 1; hello.version = BuildInfo.version; hello.capabilities = DesktopEngine.capabilities
        let defaults = UserDefaults.standard
        let deviceId = smoke ? "transport-smoke" : (defaults.string(forKey: "deviceId") ?? UUID().uuidString)
        if !smoke { defaults.set(deviceId, forKey: "deviceId") }
        hello.deviceId = deviceId
        try await send(hello, socket: ws)
        var acknowledged = false
        while !Task.isCancelled && sessionId == currentSession {
            let message = try await ws.receive()
            let data: Data
            switch message {
            case .data(let raw): data = raw
            case .string(let raw): data = Data(raw.utf8)
            @unknown default: throw BridgeFailure("INVALID_PROTOCOL", "Unsupported WebSocket message")
            }
            let wire = try JSONDecoder().decode(WireMessage.self, from: data)
            if !acknowledged {
                guard wire.type == "hello_ack", wire.protocolVersion == 1 else { throw BridgeFailure("INVALID_PROTOCOL", "Bridge 协议版本不匹配") }
                acknowledged = true; connected = true; connection = "已连接本机 Bridge"; record("Bridge 已连接，默认仅观察")
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
                    if self.sessionId == currentSession { self.jobs.removeValue(forKey: id) }
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
                    self.record("\(tool)：已返回结果")
                } catch {
                    let failure = (error as? BridgeFailure) ?? BridgeFailure(error is CancellationError ? "CANCELLED" : "NATIVE_ERROR", error.localizedDescription)
                    response = WireMessage(type: "response", id: id, error: failure)
                    self.record("\(tool)：\(failure.code)")
                }
                guard self.sessionId == currentSession, self.socket === ws else { return }
                do { try await self.send(response, socket: ws) } catch { ws.cancel(with: .goingAway, reason: nil) }
            }
        }
    }

    private func send(_ value: WireMessage, socket: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else { throw BridgeFailure("ENCODING_ERROR", "Cannot encode message") }
        try await socket.send(.string(text))
    }

    private func record(_ message: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        activity.insert("\(time)  \(message)", at: 0)
        if activity.count > 25 { activity.removeLast(activity.count - 25) }
    }
}
