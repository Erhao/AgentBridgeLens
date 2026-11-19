/// In-memory user consent for the currently configured connection. An offline
/// request applies once, when the next authenticated connection succeeds.
public enum DesktopControlConsent: Equatable {
    case off
    case waitingForConnection
    case active

    public mutating func setRequested(_ requested: Bool, connected: Bool, accessibility: Bool) {
        guard requested && accessibility else {
            self = .off
            return
        }
        self = connected ? .active : .waitingForConnection
    }

    public mutating func connectionDidAuthenticate(accessibility: Bool) {
        self = self == .waitingForConnection && accessibility ? .active : .off
    }

    /// Preserve pending consent after a failed connection attempt. Once a
    /// connection has used it, any later connection needs fresh consent.
    public mutating func connectionDidEnd() {
        if self == .active { self = .off }
    }
}
