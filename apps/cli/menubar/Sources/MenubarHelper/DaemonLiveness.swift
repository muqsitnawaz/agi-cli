import Foundation

enum DaemonLiveness: Equatable {
    case running
    case wedged
    case stopped

    private struct Heartbeat: Decodable {
        let lastTick: String
        let pid: Int
    }

    /// Mirror the daemon's three one-minute monitor ticks. The menubar is a
    /// separate launchd process, so this still advances when the daemon's event
    /// loop freezes across sleep/wake.
    static let wedgeThreshold: TimeInterval = 3 * 60

    static func classify(
        pid: Int?,
        heartbeatData: Data?,
        now: Date = Date()
    ) -> DaemonLiveness {
        guard let pid else { return .stopped }
        guard let heartbeatData,
              let heartbeat = try? JSONDecoder().decode(Heartbeat.self, from: heartbeatData),
              heartbeat.pid == pid,
              let lastTick = ISO8601DateFormatter().date(from: heartbeat.lastTick)
        else {
            // A live PID with no trustworthy heartbeat is not enough evidence
            // to terminate it. The CLI status surface can still report the
            // missing file; automatic recovery is fail-closed.
            return .running
        }
        return now.timeIntervalSince(lastTick) > wedgeThreshold ? .wedged : .running
    }
}
