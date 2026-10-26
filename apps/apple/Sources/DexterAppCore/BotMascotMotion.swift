import DexterHostClient
import Foundation

/// What the mascot is showing. In a conversation it is always derived from facts the host already reported
/// (`BotMascotHostFacts`); the creator's "Prévia" picker only simulates it locally and never reaches the host.
public enum BotMascotActivity: String, CaseIterable, Equatable, Hashable, Sendable {
    case idle, working, thinking, tool, needsYou, writing, reconnecting, error, finished

    public func label(portuguese pt: Bool) -> String {
        switch self {
        case .idle: pt ? "Em repouso" : "Idle"
        case .working: pt ? "Trabalhando" : "Working"
        case .thinking: pt ? "Pensando" : "Thinking"
        case .tool: pt ? "Usando ferramenta" : "Using a tool"
        case .needsYou: pt ? "Precisa de você" : "Needs you"
        case .writing: pt ? "Escrevendo" : "Writing"
        case .reconnecting: pt ? "Reconectando" : "Reconnecting"
        case .error: pt ? "Erro" : "Error"
        case .finished: pt ? "Concluído" : "Finished"
        }
    }

    /// States the host can actually produce today. `thinking` stays preview-only until the host reports a reasoning
    /// event; the app never infers it from a running turn.
    public static let derivable: Set<BotMascotActivity> = Set(allCases).subtracting([.thinking])
}

/// Host facts for one bot in the visible conversation. Callers pass what they already read; nothing is guessed.
public struct BotMascotHostFacts: Equatable, Sendable {
    public enum Connection: Equatable, Sendable { case connected, reconnecting, unavailable }

    public var connection: Connection
    public var turnState: TurnState?
    public var latestEvent: TurnEventKind?
    /// Answer text of the current turn was actually received (e.g. the app's streamed text is not empty).
    public var textObserved: Bool
    /// A `tool.requested` of the current turn has no matching `tool.resolved` yet.
    public var hasUnresolvedToolRequest: Bool
    /// An action of this bot is `awaiting_approval`.
    public var awaitingApproval: Bool
    /// `finishedAt` of the latest turn (ms), when the host reported it.
    public var finishedAt: Int64?
    /// Clock used for the short "finished"/"error" moments (ms).
    public var now: Int64

    public init(connection: Connection = .connected, turnState: TurnState? = nil, latestEvent: TurnEventKind? = nil, textObserved: Bool = false,
                hasUnresolvedToolRequest: Bool = false, awaitingApproval: Bool = false, finishedAt: Int64? = nil, now: Int64) {
        self.connection = connection; self.turnState = turnState; self.latestEvent = latestEvent; self.textObserved = textObserved
        self.hasUnresolvedToolRequest = hasUnresolvedToolRequest; self.awaitingApproval = awaitingApproval
        self.finishedAt = finishedAt; self.now = now
    }

    /// Facts from the latest turn and its events as the host returned them.
    public init(turn: Turn?, events: [TurnEvent], awaitingApproval: Bool, connection: Connection = .connected, now: Int64) {
        let own = turn.map { turn in events.filter { $0.turnId == turn.id }.sorted { $0.cursor < $1.cursor } } ?? []
        let requested = own.filter { $0.kind == .toolRequested }.count
        let resolved = own.filter { $0.kind == .toolResolved }.count
        self.init(connection: connection, turnState: turn?.state, latestEvent: own.last?.kind,
                  textObserved: own.contains { $0.kind == .textDelta && !($0.text ?? "").isEmpty },
                  hasUnresolvedToolRequest: requested > resolved, awaitingApproval: awaitingApproval,
                  finishedAt: turn?.finishedAt, now: now)
    }
}

extension BotMascotActivity {
    /// How long a completed turn shows "finished" before resting (ms).
    public static let finishedWindow: Int64 = 2_500
    /// How long a failed turn shows "error" before resting (ms); the conversation keeps the failure itself.
    public static let errorWindow: Int64 = 6_000

    /// Strict reading of host facts. A queued, interrupted or unknown turn rests: nothing claims progress the host
    /// did not report, and `thinking` is never produced.
    public static func derive(_ facts: BotMascotHostFacts) -> BotMascotActivity {
        if facts.awaitingApproval { return .needsYou }
        switch facts.connection {
        case .reconnecting: return .reconnecting
        case .unavailable: return .idle
        case .connected: break
        }
        func within(_ window: Int64) -> Bool {
            guard let finishedAt = facts.finishedAt else { return false }
            let age = facts.now - finishedAt
            return age >= 0 && age < window
        }
        switch facts.turnState {
        case .running?:
            if facts.hasUnresolvedToolRequest { return .tool }
            return facts.latestEvent == .textDelta || facts.textObserved ? .writing : .working
        case .completed?: return within(finishedWindow) ? .finished : .idle
        case .failed?: return within(errorWindow) ? .error : .idle
        case .queued?, .interrupted?, .unknown?, nil: return .idle
        }
    }
}

// MARK: - Animation budget

/// How much the renderer may animate. Decided from the owner's motion choice and the environment, never from content.
public enum BotMascotAnimationLevel: Equatable, Sendable {
    /// One static frame (Reduce Motion, "Parado", hidden, inactive scene, very small avatars).
    case still
    /// Only blinks, drawn on a sparse schedule (small avatars in lists).
    case blinkOnly
    case full(amplitude: Double, framesPerSecond: Double)

    public var isAnimated: Bool { self != .still }

    public static func resolve(motion: BotAvatarAppearance.Motion, side: Double, reduceMotion: Bool, isVisible: Bool,
                               isSceneActive: Bool, lowPower: Bool = false) -> BotMascotAnimationLevel {
        guard isVisible, isSceneActive, !reduceMotion, motion != .none, side >= 20 else { return .still }
        if side < 40 { return .blinkOnly }
        switch motion {
        case .none: return .still
        case .subtle: return .full(amplitude: 0.55, framesPerSecond: lowPower ? 15 : 24)
        case .lively: return .full(amplitude: 1, framesPerSecond: lowPower ? 15 : 30)
        }
    }
}

// MARK: - Pose

public struct BotMascotPose: Equatable, Sendable {
    public enum Expression: Equatable, Sendable { case neutral, happy, wide, focused, worried }
    public enum Accessory: Equatable, Sendable { case none, thinkingDots, typingDots, gear, attention, reconnecting, failure, sparkle }

    /// Body transform, in fractions of the canvas side; anchored at the bottom center (squash and stretch).
    public var bodyScaleX = 1.0
    public var bodyScaleY = 1.0
    public var bodyOffsetX = 0.0
    public var bodyOffsetY = 0.0
    public var tiltDegrees = 0.0
    /// 1 open, 0 closed.
    public var eyeOpen = 1.0
    public var eyeOffsetX = 0.0
    public var eyeOffsetY = 0.0
    public var eyeScale = 1.0
    public var expression = Expression.neutral
    public var accessory = Accessory.none
    /// Loop phase (0..<1) or one-shot progress (0...1) of the accessory.
    public var accessoryPhase = 0.0
    public var accessoryOpacity = 1.0

    public init() {}

    /// The state still reads without motion (Reduce Motion, "Parado", tiny avatars): expression plus a fixed accessory.
    public static func still(_ activity: BotMascotActivity) -> BotMascotPose {
        var pose = BotMascotPose()
        switch activity {
        case .idle: break
        case .working: pose.expression = .focused
        case .thinking: pose.eyeOffsetX = 0.02; pose.eyeOffsetY = -0.025; pose.accessory = .thinkingDots; pose.accessoryPhase = 0.66
        case .tool: pose.expression = .focused; pose.accessory = .gear; pose.accessoryPhase = 0.08
        case .needsYou: pose.expression = .wide; pose.accessory = .attention
        case .writing: pose.eyeOffsetY = 0.02; pose.accessory = .typingDots; pose.accessoryPhase = 0.5
        case .reconnecting: pose.accessory = .reconnecting; pose.accessoryPhase = 0.1
        case .error: pose.expression = .worried; pose.accessory = .failure
        case .finished: pose.expression = .happy; pose.accessory = .sparkle; pose.accessoryPhase = 1
        }
        return pose
    }

    /// One frame. `time` is a monotonic clock in seconds (loops); `elapsed` is the time since the activity started
    /// (one-shots such as the finish hop). Pure and deterministic for tests and for the HTML prototype.
    public static func resolve(_ activity: BotMascotActivity, level: BotMascotAnimationLevel, time: Double, elapsed: Double, seed: UInt32 = 0) -> BotMascotPose {
        var pose = still(activity)
        let amplitude: Double
        switch level {
        case .still: return pose
        case .blinkOnly:
            if activity != .finished { pose.eyeOpen = BotMascotBlink.openness(at: time, seed: seed) }
            return pose
        case .full(let value, _): amplitude = min(max(value, 0), 1)
        }
        let breathe = sin(time * 2 * .pi / 4.2)
        func applyBreath(_ strength: Double = 1) {
            pose.bodyScaleY = 1 + 0.022 * amplitude * strength * breathe
            pose.bodyScaleX = 1 - 0.012 * amplitude * strength * breathe
        }
        if pose.expression != .happy { pose.eyeOpen = BotMascotBlink.openness(at: time, seed: seed) }
        switch activity {
        case .idle:
            applyBreath()
            pose.eyeOffsetX = 0.026 * amplitude * glance(time, seed: seed)
        case .working:
            applyBreath(0.5)
            pose.bodyOffsetY = -0.018 * amplitude * abs(sin(time * .pi / 0.55))
            pose.eyeOffsetY = 0.008
        case .thinking:
            applyBreath()
            pose.tiltDegrees = 3 * amplitude * sin(time * 2 * .pi / 3.2)
            pose.accessoryPhase = fract(time / 1.5)
        case .tool:
            applyBreath(0.5)
            pose.bodyOffsetY = -0.012 * amplitude * abs(sin(time * .pi / 0.4))
            pose.accessoryPhase = fract(time / 2.4)
        case .writing:
            applyBreath(0.6)
            pose.eyeOffsetX = 0.02 * amplitude * sin(time * 2 * .pi / 1.8)
            pose.accessoryPhase = fract(time / 1.2)
        case .needsYou:
            applyBreath()
            let cycle = fract(time / 2.4)
            pose.bodyOffsetY = cycle < 0.22 ? -0.045 * amplitude * sin(cycle / 0.22 * .pi) : 0
            pose.eyeScale = 1.04
            pose.accessoryPhase = fract(time / 1.2)
        case .reconnecting:
            applyBreath(0.4)
            pose.eyeOffsetX = 0.024 * amplitude * sin(time * 1.7)
            pose.accessoryPhase = fract(time / 1.4)
        case .error:
            // One short shake, then calm: no looping alarm.
            let shake = elapsed < 0.5 ? sin(elapsed * 42) * (1 - elapsed / 0.5) : 0
            pose.bodyOffsetX = 0.03 * amplitude * shake
        case .finished:
            let hop = elapsed < 0.6 ? sin(elapsed / 0.6 * .pi) : 0
            pose.bodyOffsetY = -0.06 * amplitude * hop
            pose.bodyScaleY = 1 + 0.03 * amplitude * hop
            if elapsed >= 0.6 { applyBreath(0.6) }
            pose.accessoryPhase = min(max(elapsed / 0.9, 0), 1)
            pose.accessoryOpacity = elapsed < 1.4 ? 1 : max(0, 1 - (elapsed - 1.4) / 0.6)
        }
        return pose
    }

    /// Idle look-around: an eased glance to one side every ~9 s, alternating sides.
    static func glance(_ time: Double, seed: UInt32) -> Double {
        let period = 9.0, length = 1.1
        let shifted = time + Double(seed % 97) * 0.13
        let cycle = shifted.truncatingRemainder(dividingBy: period)
        guard cycle < length else { return 0 }
        let side: Double = Int((shifted / period).rounded(.down)) % 2 == 0 ? 1 : -1
        return side * sin(cycle / length * .pi)
    }

    static func fract(_ value: Double) -> Double { value - value.rounded(.down) }
}

/// Blink timing shared by the pose and the sparse blink-only schedule.
public enum BotMascotBlink {
    public static let duration = 0.16

    /// Cycle length in seconds; the seed spreads avatars apart so a list never blinks in unison.
    public static func period(seed: UInt32) -> Double { 3.6 + Double(seed % 13) * 0.17 }
    public static func offset(seed: UInt32) -> Double { Double((seed / 13) % 29) * 0.11 }

    public static func openness(at time: Double, seed: UInt32) -> Double {
        let period = period(seed: seed)
        let cycle = (time + offset(seed: seed)).truncatingRemainder(dividingBy: period)
        let position = cycle < 0 ? cycle + period : cycle
        guard position < duration else { return 1 }
        return 1 - sin(position / duration * .pi)
    }

    /// Start of the next blink at or after `time`.
    public static func nextStart(after time: Double, seed: UInt32) -> Double {
        let period = period(seed: seed), offset = offset(seed: seed)
        let index = ((time + offset) / period).rounded(.up)
        return index * period - offset
    }

    /// Frame times for one blink starting at `start`, ending with an open frame.
    public static func frames(startingAt start: Double) -> [Double] {
        [0, 0.04, 0.08, 0.12, duration + 0.01].map { start + $0 }
    }

    /// Stable 32-bit seed (FNV-1a) from any identifier, e.g. a bot ID.
    public static func seed(_ text: String) -> UInt32 {
        var hash: UInt32 = 2_166_136_261
        for byte in text.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        return hash
    }
}
