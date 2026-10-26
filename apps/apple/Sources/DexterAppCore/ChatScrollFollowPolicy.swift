import Foundation

/// Identity of one presented transcript. Any change discards following state and every deferred scroll.
/// Local presentation only: nothing here is sent to a host or persisted.
public struct ChatScrollScope: Hashable, Sendable {
    public let host: String
    public let hostScope: UUID?
    public let conversation: String
    public let generation: UInt64?
    public init(host: String, hostScope: UUID?, conversation: String, generation: UInt64?) {
        self.host = host; self.hostScope = hostScope; self.conversation = conversation; self.generation = generation
    }
}

/// Vertical scroll geometry in points. `offset` is 0 at the top of the content.
public struct ChatScrollMetrics: Equatable, Sendable {
    public var offset: Double
    public var contentHeight: Double
    public var viewportHeight: Double
    public init(offset: Double, contentHeight: Double, viewportHeight: Double) {
        self.offset = offset; self.contentHeight = contentHeight; self.viewportHeight = viewportHeight
    }
    /// Points between the visible bottom edge and the end of the content; negative while overscrolled past the end.
    public var distanceToBottom: Double { max(0, contentHeight - viewportHeight) - offset }
}

/// Mirrors SwiftUI's ScrollPhase (macOS 15 / iOS 18). `animating` is programmatic, never a person.
public enum ChatScrollPhase: Sendable, Equatable {
    case idle, tracking, interacting, decelerating, animating
    public var isHuman: Bool { self == .tracking || self == .interacting || self == .decelerating }
}

public enum ChatScrollMode: Sendable, Equatable {
    /// At the end: new content keeps the end visible.
    case following
    /// The person moved away from the end; new content never moves the transcript.
    case reading
}

public struct ChatScrollMove: Equatable, Sendable {
    public let animated: Bool
    public init(animated: Bool) { self.animated = animated }
}

public enum ChatScrollFireResult: Equatable, Sendable {
    case none
    case move(ChatScrollMove)
    /// Recent human movement; try again at this uptime instead of pulling the person back.
    case retry(at: Double)
}

/// Pure follow/read state for a chat transcript. Times are monotonic seconds supplied by the caller.
///
/// Rules: content updates scroll only while following, never during a human gesture, coalesced into at most one
/// pending request per `throttle` window (a later update never postpones an earlier deadline). Moving up away from
/// the end switches to reading; returning to the end by the person, an explicit "latest" request or a human send
/// switches back. The first position is applied once, without animation. Forward pagination keeps reading.
public struct ChatScrollFollowPolicy: Sendable {
    public struct Tuning: Sendable, Equatable {
        public var nearBottom: Double = 80
        public var throttle: Double = 0.1
        /// Offset changes smaller than this are layout noise.
        public var noise: Double = 2
        /// Content/viewport changes smaller than this count as stable.
        public var stable: Double = 0.5
        /// After an inferred human movement no programmatic scroll runs for this long.
        public var humanGrace: Double = 0.35
        /// Follow-ups right after the first position are applied without animation while lazy rows settle.
        public var initialSettle: Double = 0.35
        /// Longer distances are applied without animation so no animation travels through history.
        public var maxAnimatedViewports: Double = 1.5
        public init() {}
    }

    public let tuning: Tuning
    public private(set) var scope: ChatScrollScope?
    public private(set) var mode: ChatScrollMode = .following
    public private(set) var initialPositionApplied = false
    public private(set) var isUserInteracting = false
    public private(set) var metrics: ChatScrollMetrics?
    public private(set) var pendingDeadline: Double?
    private var pendingIsInitial = false
    private var pendingBypassesPause = false
    private var pendingIsExplicit = false
    private var humanQuietUntil: Double = 0
    private var settleUntil: Double = 0

    public init(tuning: Tuning = Tuning()) { self.tuning = tuning }

    /// Only shown while reading away from the end; purely local navigation.
    public var showsLatestButton: Bool {
        initialPositionApplied && mode == .reading && (metrics?.distanceToBottom ?? .infinity) > tuning.nearBottom
    }

    /// Returns true when the scope changed and all state (including any pending scroll) was discarded.
    @discardableResult public mutating func sync(scope newScope: ChatScrollScope) -> Bool {
        guard scope != newScope else { return false }
        self = ChatScrollFollowPolicy(tuning: tuning)
        scope = newScope
        return true
    }

    /// Disappearance: forget everything so a later appearance positions once again.
    public mutating func reset() { self = ChatScrollFollowPolicy(tuning: tuning) }

    public mutating func cancelPending() {
        pendingDeadline = nil; pendingIsInitial = false; pendingBypassesPause = false; pendingIsExplicit = false
    }

    /// Messages, streaming text, preview or dispatch changed. Returns a deadline when a new task must be armed.
    public mutating func contentChanged(hasContent: Bool, paused: Bool, now: Double) -> Double? {
        guard hasContent else { return nil }
        if !initialPositionApplied {
            guard !isUserInteracting else { initialPositionApplied = true; return nil }
            pendingIsInitial = true
            return schedule(at: now)
        }
        guard mode == .following, !isUserInteracting, !paused else { return nil }
        return schedule(at: now + tuning.throttle)
    }

    /// Human send or the "latest" button. `bypassesPause` only for the button, which is itself explicit navigation.
    public mutating func requestLatest(now: Double, bypassesPause: Bool) -> Double? {
        mode = .following
        humanQuietUntil = 0
        if !initialPositionApplied { pendingIsInitial = true }
        pendingIsExplicit = true
        pendingBypassesPause = pendingBypassesPause || bypassesPause
        return schedule(at: now)
    }

    /// Forward pagination ("Mostrar mais"): new rows appear below without moving the reading position.
    public mutating func preserveReadingPosition() {
        cancelPending()
        if initialPositionApplied { mode = .reading }
    }

    public mutating func phaseChanged(_ phase: ChatScrollPhase, now: Double) -> Double? {
        let wasHuman = isUserInteracting
        isUserInteracting = phase.isHuman
        if isUserInteracting, !wasHuman {
            // A gesture before the first position takes over: the person already chose where to be.
            initialPositionApplied = true
            cancelPending()
            return nil
        }
        guard wasHuman, !isUserInteracting, initialPositionApplied, let metrics else { return nil }
        if metrics.distanceToBottom <= tuning.nearBottom {
            mode = .following
            return metrics.distanceToBottom > tuning.stable ? schedule(at: now + tuning.throttle) : nil
        }
        mode = .reading
        return nil
    }

    public mutating func geometryChanged(_ new: ChatScrollMetrics, now: Double) -> Double? {
        let old = metrics
        metrics = new
        guard let old else { return nil }
        if !initialPositionApplied {
            let stableLayout = abs(new.viewportHeight - old.viewportHeight) <= tuning.stable && abs(new.contentHeight - old.contentHeight) <= tuning.stable
            if isUserInteracting || (stableLayout && abs(new.offset - old.offset) > tuning.noise) {
                initialPositionApplied = true; mode = .reading; cancelPending()
            }
            return nil
        }
        let near = new.distanceToBottom <= tuning.nearBottom
        if isUserInteracting {
            mode = near ? .following : .reading
            return nil
        }
        let delta = new.offset - old.offset
        let viewportStable = abs(new.viewportHeight - old.viewportHeight) <= tuning.stable
        let contentStable = abs(new.contentHeight - old.contentHeight) <= tuning.stable
        if delta < -tuning.noise, viewportStable {
            // Programmatic scrolling only ever moves down. A clamp after content shrank lands at the end.
            let clamped = new.contentHeight < old.contentHeight - tuning.stable && new.distanceToBottom <= tuning.stable
            guard !clamped else { return nil }
            humanQuietUntil = now + tuning.humanGrace
            cancelPending()
            // Away from the end is reading, also when ambiguous (content changed at the same time).
            if !near { mode = .reading }
            return nil
        }
        if viewportStable, near, mode == .reading, delta > tuning.noise || (contentStable && abs(new.distanceToBottom) <= tuning.stable) {
            // Only the person moves the transcript while reading: they came back to the end.
            mode = .following
            return nil
        }
        let grew = new.contentHeight > old.contentHeight + tuning.stable
        if mode == .following, grew || !viewportStable, new.distanceToBottom > tuning.stable {
            // Rows, images, tables or cards grew (or the viewport shrank) while at the end: keep the end visible.
            return schedule(at: now + tuning.throttle)
        }
        return nil
    }

    /// Called when the armed deadline elapses, with the live scope and gate values.
    public mutating func fire(now: Double, currentScope: ChatScrollScope, paused: Bool, reduceMotion: Bool) -> ChatScrollFireResult {
        guard pendingDeadline != nil else { return .none }
        let initial = pendingIsInitial, bypass = pendingBypassesPause, explicit = pendingIsExplicit
        guard scope == currentScope, !isUserInteracting, !paused || bypass else { cancelPending(); return .none }
        if now < humanQuietUntil {
            pendingDeadline = humanQuietUntil
            return .retry(at: humanQuietUntil)
        }
        cancelPending()
        if initial {
            initialPositionApplied = true
            mode = .following
            settleUntil = now + tuning.initialSettle
            return .move(ChatScrollMove(animated: false))
        }
        guard mode == .following else { return .none }
        // Already at the end: nothing to do for an update. Explicit requests always run (geometry may still be stale).
        if let metrics, metrics.distanceToBottom <= tuning.stable, !explicit { return .none }
        let short = metrics.map { $0.distanceToBottom <= $0.viewportHeight * tuning.maxAnimatedViewports } ?? false
        return .move(ChatScrollMove(animated: !reduceMotion && now >= settleUntil && short))
    }

    /// One pending request; an earlier deadline may replace a later one, never the reverse (throttle, not debounce).
    private mutating func schedule(at deadline: Double) -> Double? {
        if let pendingDeadline, pendingDeadline <= deadline { return nil }
        pendingDeadline = deadline
        return deadline
    }
}
