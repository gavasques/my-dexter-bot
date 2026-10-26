import Foundation

/// Plain-language effects of one confirmed access or approval-rule change, read only from the host receipt's
/// `revocationEffects`, in both directions. Counts appear only when greater than zero; nothing here is inferred.
public enum AccessChangeEffectsPresentation {
    /// Turning an access on or off for one operation. `blocked` = waiting actions of that kind (awaiting approval or
    /// released and not started); `stopped` = running actions the host asked to stop.
    public static func accessSentence(enabled: Bool, blocked: Int, stopped: Int, portuguese: Bool) -> String? {
        var parts: [String] = []
        if blocked > 0 {
            if enabled {
                parts.append(portuguese
                    ? (blocked == 1 ? "1 pedido deste tipo que ainda não tinha começado foi bloqueado e não será executado; o bot precisará pedir de novo."
                                    : "\(blocked) pedidos deste tipo que ainda não tinham começado foram bloqueados e não serão executados; o bot precisará pedir de novo.")
                    : (blocked == 1 ? "1 request of this kind that had not started was blocked and will not run; the bot will need to ask again."
                                    : "\(blocked) requests of this kind that had not started were blocked and will not run; the bot will need to ask again."))
            } else {
                parts.append(portuguese
                    ? (blocked == 1 ? "1 ação que ainda não tinha começado foi bloqueada." : "\(blocked) ações que ainda não tinham começado foram bloqueadas.")
                    : (blocked == 1 ? "1 action that had not started was blocked." : "\(blocked) actions that had not started were blocked."))
            }
        }
        if stopped > 0 {
            parts.append(portuguese
                ? (stopped == 1 ? "Pedido de parada enviado para 1 ação em andamento; o resultado dela pode ficar parcial."
                                : "Pedido de parada enviado para \(stopped) ações em andamento; o resultado delas pode ficar parcial.")
                : (stopped == 1 ? "Stop requested for 1 running action; its result may be partial."
                                : "Stop requested for \(stopped) running actions; their results may be partial."))
        }
        guard !parts.isEmpty else { return nil }
        parts.append(portuguese ? "O que já foi feito não é desfeito." : "What already happened is not undone.")
        return parts.joined(separator: " ")
    }

    /// Approval rule receipts: only owner-policy releases are affected by the host.
    public static func policySentence(blocked: Int, stopped: Int, portuguese: Bool) -> String? {
        var parts: [String] = []
        if blocked > 0 {
            parts.append(portuguese
                ? (blocked == 1 ? "1 ação liberada pela regra e ainda não iniciada foi bloqueada." : "\(blocked) ações liberadas pela regra e ainda não iniciadas foram bloqueadas.")
                : (blocked == 1 ? "1 action released by the rule and not yet started was blocked." : "\(blocked) actions released by the rule and not yet started were blocked."))
        }
        if stopped > 0 {
            parts.append(portuguese
                ? (stopped == 1 ? "Pedido de parada enviado para 1 ação em andamento." : "Pedido de parada enviado para \(stopped) ações em andamento.")
                : (stopped == 1 ? "Stop requested for 1 running action." : "Stop requested for \(stopped) running actions."))
        }
        guard !parts.isEmpty else { return nil }
        parts.append(portuguese ? "O que já foi feito não é desfeito." : "What already happened is not undone.")
        return parts.joined(separator: " ")
    }
}

/// One stoppable action as rendered in the conversation.
public struct EffectStopCandidate: Equatable, Sendable {
    public let actionID: String
    public let title: String
    public let createdAt: Int64
    public init(actionID: String, title: String, createdAt: Int64) {
        self.actionID = actionID; self.title = title; self.createdAt = createdAt
    }
}

/// One choice of the stop menu. `originTurnID` is set only when the host confirmed the origin by GET continuation;
/// otherwise the choice stands for one action whose origin the app does not know.
public struct EffectStopChoice: Equatable, Sendable, Identifiable {
    public let id: String
    public let representativeActionID: String
    public let actionIDs: [String]
    public let titles: [String]
    public let earliestCreatedAt: Int64
    public let originTurnID: String?
}

/// Groups stoppable actions by their confirmed origin. The host stops every action of an origin together, so a menu
/// line per action of the same origin would offer the same stop twice. Unconfirmed actions stay one per line.
public enum EffectStopGrouping {
    public static func choices(_ candidates: [EffectStopCandidate], confirmedOrigins: [String: String]) -> [EffectStopChoice] {
        var order: [String] = []
        var grouped: [String: [EffectStopCandidate]] = [:]
        var result: [EffectStopChoice] = []
        for candidate in candidates.sorted(by: { ($0.createdAt, $0.actionID) < ($1.createdAt, $1.actionID) }) {
            if let origin = confirmedOrigins[candidate.actionID], !origin.isEmpty {
                if grouped[origin] == nil { order.append(origin) }
                grouped[origin, default: []].append(candidate)
            } else {
                result.append(EffectStopChoice(id: "action:" + candidate.actionID, representativeActionID: candidate.actionID,
                    actionIDs: [candidate.actionID], titles: [candidate.title], earliestCreatedAt: candidate.createdAt, originTurnID: nil))
            }
        }
        for origin in order {
            let members = grouped[origin] ?? []
            guard let first = members.first else { continue }
            result.append(EffectStopChoice(id: "origin:" + origin, representativeActionID: first.actionID,
                actionIDs: members.map(\.actionID), titles: members.map(\.title), earliestCreatedAt: first.createdAt, originTurnID: origin))
        }
        return result.sorted { ($0.earliestCreatedAt, $0.id) < ($1.earliestCreatedAt, $1.id) }
    }

    /// Distinct labels: tool title(s) and time; a short ID is added only where two labels would otherwise match.
    public static func labels(_ choices: [EffectStopChoice], time: (Int64) -> String, portuguese: Bool) -> [String: String] {
        func base(_ choice: EffectStopChoice) -> String {
            var unique: [String] = []
            for title in choice.titles where !unique.contains(title) { unique.append(title) }
            let names = unique.prefix(2).map { "“\($0)”" }.joined(separator: ", ") + (unique.count > 2 ? "…" : "")
            if choice.originTurnID != nil {
                let count = choice.actionIDs.count
                return portuguese
                    ? "Pedido das \(time(choice.earliestCreatedAt)) · \(names) · \(count == 1 ? "1 ação" : "\(count) ações")"
                    : "Request from \(time(choice.earliestCreatedAt)) · \(names) · \(count == 1 ? "1 action" : "\(count) actions")"
            }
            return portuguese ? "\(names) · \(time(choice.earliestCreatedAt)) · origem não confirmada"
                              : "\(names) · \(time(choice.earliestCreatedAt)) · origin not confirmed"
        }
        func disambiguate(_ values: [String], suffix: (EffectStopChoice) -> String) -> [String] {
            values.enumerated().map { index, value in
                values.enumerated().contains { $0.offset != index && $0.element == value } ? value + " · " + suffix(choices[index]) : value
            }
        }
        var values = disambiguate(choices.map(base)) { shortID($0.originTurnID ?? $0.representativeActionID) }
        if Set(values).count != values.count { values = disambiguate(choices.map(base)) { $0.originTurnID ?? $0.representativeActionID } }
        return Dictionary(zip(choices.map(\.id), values), uniquingKeysWith: { first, _ in first })
    }

    /// "act_6d3afc…9f2a": keeps generated IDs distinguishable without filling the line.
    public static func shortID(_ id: String) -> String { id.count <= 14 ? id : String(id.prefix(8)) + "…" + String(id.suffix(4)) }
}
