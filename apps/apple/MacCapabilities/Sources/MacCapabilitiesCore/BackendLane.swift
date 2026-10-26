import Foundation
import os

/// One serial lane, off the main actor, for backend work that can block (an AX call waits on the target app
/// up to its messaging timeout). The main actor stays free for Stop, takeover, the timer and stdin.
///
/// Work belongs to the lane generation current when it was submitted. `invalidate()` (a session ended)
/// makes queued work skip before it starts and tells running work, through its ticket, that it should stop
/// before its next effect. Running work is never interrupted: an AX call already handed to the OS finishes
/// or times out. Completions run on the main actor, after the lane's busy count has dropped.
public final class BackendLane: Sendable {
    public struct Ticket: Sendable {
        let lane: BackendLane
        public let generation: UInt64
        /// False once the generation the work was submitted for has ended.
        public var isCurrent: Bool { lane.generation == generation }
    }

    private struct State {
        var generation: UInt64 = 0
        var submitted = 0
    }

    private let queue: DispatchQueue
    private let state = OSAllocatedUnfairLock(initialState: State())

    public init(label: String) {
        queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    public var generation: UInt64 { state.withLock { $0.generation } }
    /// True while submitted work has not delivered its completion.
    public var isBusy: Bool { state.withLock { $0.submitted > 0 } }

    public func invalidate() { state.withLock { $0.generation &+= 1 } }

    /// Runs `work` on the lane unless its generation ended first, in which case `skipped` is delivered and
    /// `work` never runs.
    public func submit<T: Sendable>(skipped: T, _ work: @escaping @Sendable (Ticket) -> T,
                                    completion: @escaping @MainActor @Sendable (T) -> Void) {
        let ticket = state.withLock { state -> Ticket in
            state.submitted += 1
            return Ticket(lane: self, generation: state.generation)
        }
        queue.async {
            let result = ticket.isCurrent ? work(ticket) : skipped
            DispatchQueue.main.async {
                self.state.withLock { $0.submitted -= 1 }
                MainActor.assumeIsolated { completion(result) }
            }
        }
    }
}
