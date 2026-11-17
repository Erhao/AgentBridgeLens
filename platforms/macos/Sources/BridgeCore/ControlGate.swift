import Foundation

/// Stop/cancel bypasses the serial AX queue. Already dispatched OS events cannot be undone.
public final class ControlGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    private var enabled = false
    private var cancelled: Set<String> = []
    public init() {}
    public var isEnabled: Bool { lock.lock(); defer { lock.unlock() }; return enabled }
    public var epoch: Int { lock.lock(); defer { lock.unlock() }; return generation }
    public func setEnabled(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        generation += 1; enabled = value
    }
    public func stop() { setEnabled(false) }
    public func cancel(_ id: String) { lock.lock(); defer { lock.unlock() }; cancelled.insert(id) }
    public func finish(_ id: String) { lock.lock(); defer { lock.unlock() }; cancelled.remove(id) }
    public func ticket(id: String) -> Ticket {
        lock.lock(); defer { lock.unlock() }; return Ticket(gate: self, id: id, generation: generation)
    }
    fileprivate func check(id: String, generation expected: Int, input: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        guard expected == generation, !cancelled.contains(id) else { throw BridgeFailure("CANCELLED", "Request cancelled or control state changed.") }
        if input && !enabled { throw BridgeFailure("CONTROL_DISABLED", "Enable control locally in the AgentBridgeMac menu-bar app.") }
    }
    public struct Ticket {
        private let gate: ControlGate
        fileprivate let id: String
        fileprivate let generation: Int
        fileprivate init(gate: ControlGate, id: String, generation: Int) { self.gate = gate; self.id = id; self.generation = generation }
        public func check(input: Bool = false) throws { try gate.check(id: id, generation: generation, input: input) }
    }
}
