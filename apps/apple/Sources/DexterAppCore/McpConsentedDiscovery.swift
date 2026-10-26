import DexterHostClient
import Foundation
import Observation

/// One owner-consented read of an HTTP connection's metadata and tools right after its sign-in, inside the plan the owner
/// saw: this server and instance, this base and conversation context, until a deadline. It is armed only by an explicit
/// gesture (never by approving `mcp.authorize` alone), never for a local process, and dispatches at most one discovery
/// POST with `httpOnly` and the exact `expectedInstancePin` (the host refuses an HTTP-only read without it). The pin comes
/// from the bot's handoff and/or the base's server summary and must agree; without one the plan cannot exist. A failed or
/// uncertain dispatch is never retried: afterwards only GETs of the tools/servers are allowed. A changed base or pin, Stop,
/// close, withdrawal or expiry makes it inert.
@MainActor @Observable public final class McpConsentedDiscoveryPlan {
    public enum Phase: Equatable, Sendable {
        case armed, dispatching
        case discovered(toolCount: Int)
        /// The host refused the read (pin changed, not HTTP, not owner…): nothing was read.
        case refused
        /// The POST's outcome is not known: never retried; read the tools/servers instead.
        case uncertain
        case expired
        case invalidated(Reason)
    }
    public enum Reason: Equatable, Sendable { case contextChanged, withdrawn, closed, pinChanged }

    /// Which instance pin a plan may use: the handoff's and the summary's when both exist must be equal.
    public enum PinResolution: Equatable, Sendable {
        case pin(String)
        /// Neither the bot's handoff nor the base reported a pin: the read cannot be planned.
        case missing
        /// The handoff and the base disagree: the instance changed since the bot asked.
        case mismatch
    }

    public static func resolvePin(handoff: String?, summary: String?) -> PinResolution {
        let handoff = handoff.flatMap { McpAuthorizationHandoff.validHash($0) ? $0 : nil }
        let summary = summary.flatMap { McpAuthorizationHandoff.validHash($0) ? $0 : nil }
        switch (handoff, summary) {
        case (nil, nil): return .missing
        case (let pin?, nil), (nil, let pin?): return .pin(pin)
        case (let a?, let b?): return a == b ? .pin(a) : .mismatch
        }
    }

    public let serverID: String
    public let destination: String
    public let instancePin: String
    public let expiresAt: Int64
    public private(set) var phase: Phase = .armed
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let currentPin: @MainActor () -> String?
    @ObservationIgnored private let now: @MainActor () -> Int64
    @ObservationIgnored private let dispatch: @MainActor (String) async throws -> [McpToolSummary]

    /// Nil for a local process, a missing/invalid pin or a deadline already past: there is nothing to consent to.
    /// `currentPin` is the base's latest reported pin for this server (nil = not reported); a different one before the
    /// sign-in finishes makes the plan inert without sending anything.
    public init?(server: McpServerSummary, instancePin: String, expiresAt: Int64,
                 now: @escaping @MainActor () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) },
                 isCurrent: @escaping @MainActor () -> Bool,
                 currentPin: @escaping @MainActor () -> String? = { nil },
                 dispatch: @escaping @MainActor (String) async throws -> [McpToolSummary]) {
        guard server.transport != "stdio", McpAuthorizationHandoff.validHash(instancePin), expiresAt > now(),
              server.instancePin.map({ $0 == instancePin }) ?? true else { return nil }
        serverID = server.id; destination = server.destination; self.instancePin = instancePin; self.expiresAt = expiresAt
        self.now = now; self.isCurrent = isCurrent; self.currentPin = currentPin; self.dispatch = dispatch
    }

    public var isArmed: Bool { phase == .armed }

    /// Called with each observed sign-in state of the planned server. Dispatches only once: when the sign-in is ready for
    /// the same server, the plan is still armed, inside its deadline and its context is still current.
    @discardableResult
    public func signInObserved(_ credentials: McpCredentialStatus) async -> [McpToolSummary]? {
        guard phase == .armed, credentials.serverId == serverID, credentials.isReady else { return nil }
        guard now() < expiresAt else { phase = .expired; return nil }
        guard isCurrent() else { phase = .invalidated(.contextChanged); return nil }
        if let current = currentPin(), current != instancePin { phase = .invalidated(.pinChanged); return nil }
        phase = .dispatching
        do {
            let tools = try await dispatch(instancePin)
            phase = .discovered(toolCount: tools.count)
            return tools
        } catch HostClientError.conflict {
            phase = .refused
        } catch HostClientError.invalidRequest {
            phase = .refused
        } catch HostClientError.forbidden {
            phase = .refused
        } catch {
            // Offline, host failure, lost answer or cancellation after the POST may have been sent: uncertain, never retried.
            phase = .uncertain
        }
        return nil
    }

    /// The owner turned the read off before it ran (nothing is sent).
    public func withdraw() { if phase == .armed { phase = .invalidated(.withdrawn) } }
    /// Base, instance, conversation or window changed, Stop, or the manager closed.
    public func invalidate(_ reason: Reason = .contextChanged) { if phase == .armed { phase = .invalidated(reason) } }
}
