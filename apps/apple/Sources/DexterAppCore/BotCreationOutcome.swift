import Foundation

/// Presentation of the existing creation request, never an idempotency key or proof of rollback.
public enum BotCreationOutcome: Equatable, Sendable {
    case created(botID: String)
    case refused
    /// The host may have created the bot; read its list before starting a distinct request.
    case unconfirmed
}
