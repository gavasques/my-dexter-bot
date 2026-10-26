import DexterHostClient
import Foundation
import Observation

/// One approved computer-access handoff, claimed by the key main window. Same context as the MCP handoff:
/// host, bot, thread, address, composer scope and generations of the conversation that received the owner's click.
public struct MacSetupHandoffPresentation: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let handoff: MacSetupHandoff
    public let context: McpAuthorizationContext
}

/// App-wide, process-only eligibility, with the same rules as `McpAuthorizationHandoffCoordinator`: only a fresh local
/// Allow click arms it; history, reloads, restarts and other owners' results never do. Presenting the panel is
/// navigation only: no preparation controller, private request, grant, route, policy write or helper launch follows.
@MainActor @Observable public final class MacSetupHandoffCoordinator {
    private struct Pending {
        let action: Action
        let context: McpAuthorizationContext
    }
    public private(set) var presentation: MacSetupHandoffPresentation?
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var consumed: Set<String> = []
    @ObservationIgnored private let now: @MainActor () -> Int64
    public init(now: @escaping @MainActor () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1_000) }) { self.now = now }
    private func key(host: String, action: String) -> String { host + "\u{1F}" + action }

    /// Called before exactly one new local Allow request, while its chat is foreground. Never called by recovery reads.
    @discardableResult public func arm(_ action: Action, context: McpAuthorizationContext?, foreground: Bool) -> Bool {
        guard foreground, let context, action.state == .awaitingApproval,
              action.request.botId == context.botID, action.request.threadId == context.threadID,
              MacSetupHandoff.isRequest(action.request), let expiry = action.approvalExpiresAt, expiry > now() else { return false }
        let id = key(host: context.hostID, action: action.id)
        guard !consumed.contains(id), pending[id] == nil, pending.count + consumed.count < 512 else { return false }
        pending[id] = Pending(action: action, context: context)
        return true
    }

    /// The original decision response or a later exact observation may finish an already armed intent.
    public func receive(_ action: Action, context: McpAuthorizationContext?, foreground: Bool) {
        guard let context else { invalidate(); return }
        let id = key(host: context.hostID, action: action.id)
        guard let original = pending[id] else { return }
        guard foreground, original.context == context,
              original.action.request == action.request, original.action.requestHash == action.requestHash,
              original.action.grantRevision == action.grantRevision else { pending.removeValue(forKey: id); return }
        guard action.state != .awaitingApproval && action.state != .ready && action.state != .running else { return }
        pending.removeValue(forKey: id)
        guard let handoff = action.macSetupHandoff, handoff.hostId == context.hostID, handoff.botId == context.botID,
              handoff.threadId == context.threadID, handoff.expiresAt > now(), !consumed.contains(id), presentation == nil else { return }
        presentation = MacSetupHandoffPresentation(id: UUID(), handoff: handoff, context: context)
    }

    /// Only the key main window may claim the sheet; a claimed handoff is never presented again in this process.
    public func take(_ token: UUID, context: McpAuthorizationContext?, foreground: Bool) -> MacSetupHandoffPresentation? {
        guard let request = presentation, request.id == token else { return nil }
        presentation = nil
        guard foreground, request.context == context, request.handoff.expiresAt > now() else { return nil }
        let id = key(host: request.context.hostID, action: request.handoff.actionId)
        guard consumed.insert(id).inserted else { return nil }
        return request
    }

    public func abandon(actionID: String, hostID: String?) {
        guard let hostID else { return }
        pending.removeValue(forKey: key(host: hostID, action: actionID))
        if presentation?.handoff.actionId == actionID, presentation?.handoff.hostId == hostID { presentation = nil }
    }

    /// Context change or Stop abandons automatic presentation; receipts remain unchanged.
    public func invalidate() { pending = [:]; presentation = nil }
}
