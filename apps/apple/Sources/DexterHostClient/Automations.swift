import Foundation

/// Internal task calendar. This contract does not access a system or account calendar.
public enum AutomationWhen: Codable, Equatable, Sendable {
    case once(at: Int64)
    case interval(everyMs: Int64, firstAt: Int64)
    case cron(expression: String, timeZone: String)
    enum CodingKeys: String, CodingKey { case kind, at, everyMs, firstAt, expression, timeZone }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "once": self = .once(at: try c.decode(Int64.self, forKey: .at))
        case "interval": self = .interval(everyMs: try c.decode(Int64.self, forKey: .everyMs), firstAt: try c.decode(Int64.self, forKey: .firstAt))
        case "cron": self = .cron(expression: try c.decode(String.self, forKey: .expression), timeZone: try c.decode(String.self, forKey: .timeZone))
        default: throw HostClientError.contractMismatch
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .once(let at): try c.encode("once", forKey: .kind); try c.encode(at, forKey: .at)
        case .interval(let everyMs, let firstAt): try c.encode("interval", forKey: .kind); try c.encode(everyMs, forKey: .everyMs); try c.encode(firstAt, forKey: .firstAt)
        case .cron(let expression, let timeZone): try c.encode("cron", forKey: .kind); try c.encode(expression, forKey: .expression); try c.encode(timeZone, forKey: .timeZone)
        }
    }
    public var isValid: Bool {
        switch self {
        case .once(let at): return at > 0 && at <= 8_640_000_000_000_000
        case .interval(let everyMs, let firstAt): return (60_000...2_592_000_000).contains(everyMs) && firstAt > 0 && firstAt <= 8_640_000_000_000_000
        case .cron(let expression, let zone): return expression.utf8.count <= 256 && expression.split(whereSeparator: \.isWhitespace).count == 5 && TimeZone(identifier: zone) != nil
        }
    }
}
public struct AutomationSchedule: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let ownerId: String
    public let installationId: String
    public let botId: String
    public let threadId: String
    public let title: String
    public let content: String
    public let kind: String
    public let at: Int64?
    public let intervalMs: Int64?
    public let nextAt: Int64?
    public let cron: String?
    public let timeZone: String?
    public let state: String
    public let revision: Int
    public let createdAt: Int64
    public let updatedAt: Int64
    public var when: AutomationWhen? {
        switch kind {
        case "once": return at.map { .once(at: $0) }
        case "interval": guard let intervalMs else { return nil }; return .interval(everyMs: intervalMs, firstAt: nextAt ?? createdAt)
        case "cron": guard let cron, let timeZone else { return nil }; return .cron(expression: cron, timeZone: timeZone)
        default: return nil
        }
    }
    var isValid: Bool {
        automationID(id) && automationID(botId) && automationID(threadId) && automationID(installationId) &&
        !title.isEmpty && title.utf16.count <= 160 && !content.isEmpty && content.utf16.count <= 32_768 &&
        ["active", "disabled", "completed"].contains(state) && revision >= 1 && createdAt >= 0 && updatedAt >= createdAt && when?.isValid == true
    }
}
public struct AutomationStatus: Decodable, Equatable, Sendable {
    public let hostId: String
    public let configured: Bool
    public let running: Bool
    public let admission: String?
    public let inFlight: Int?
    public let lastOutcome: String?
    public let completedTicks: Int?
    public let accepted: Int?
    public let replayed: Int?
    public let deferred: Int?
}
public struct AutomationScheduleCursor: Codable, Equatable, Sendable { public let createdAt: Int64; public let id: String }
public struct AutomationHistoryCursor: Codable, Equatable, Sendable { public let scheduleId: String; public let scheduledAt: Int64 }
public struct AutomationPage<Item: Decodable & Sendable, Cursor: Decodable & Sendable>: Decodable, Sendable {
    public let items: [Item]
    public let nextCursor: Cursor?
}
public struct AutomationOccurrence: Decodable, Equatable, Identifiable, Sendable {
    public let scheduleId: String
    public let scheduledAt: Int64
    public let scheduleRevision: Int
    public let clientRequestId: String
    public let state: String
    public let turnId: String?
    public let attempts: Int
    public let createdAt: Int64
    public let updatedAt: Int64
    public let source: String
    public let botId: String
    public let threadId: String
    public let title: String
    public let turnState: String?
    public let turnCode: String?
    public var id: String { "\(scheduleId):\(scheduledAt)" }
}
public struct AutomationCalendarItem: Decodable, Equatable, Identifiable, Sendable {
    public let scheduleId: String
    public let botId: String
    public let threadId: String
    public let title: String
    public let scheduledAt: Int64
    public let source: String
    public let occurrenceState: String?
    public let turnId: String?
    public let turnState: String?
    public let turnCode: String?
    public var id: String { "\(scheduleId):\(scheduledAt):\(source)" }
}
public struct AutomationCalendar: Decodable, Sendable {
    public let items: [AutomationCalendarItem]
    public let truncated: Bool
    public let from: Int64
    public let to: Int64
}
public struct AutomationPreview: Decodable, Sendable { public let hostId: String; public let when: AutomationWhen; public let dates: [Int64] }
public struct AutomationReceipt: Decodable, Equatable, Sendable {
    public let id: String
    public let hostId: String
    public let clientRequestId: String
    public let operation: String
    public let scheduleId: String
    public let revision: Int
    public let createdAt: Int64
    public let replayed: Bool
    public let schedule: AutomationSchedule
    // Mutation receipt occurrence can be the canonical occurrence without enriched history fields.
    public let occurrence: JSONValue?
}
public struct AutomationMutation: Encodable, Equatable, Sendable {
    public let hostId: String
    public let clientRequestId: String
    public let expectedRevision: Int
    public var botId: String?
    public var threadId: String?
    public var title: String?
    public var content: String?
    public var when: AutomationWhen?
    public var state: String?
    public init(hostId: String, clientRequestId: String = UUID().uuidString.lowercased(), expectedRevision: Int,
                botId: String? = nil, threadId: String? = nil, title: String? = nil, content: String? = nil,
                when: AutomationWhen? = nil, state: String? = nil) {
        self.hostId = hostId; self.clientRequestId = clientRequestId; self.expectedRevision = expectedRevision
        self.botId = botId; self.threadId = threadId; self.title = title; self.content = content; self.when = when; self.state = state
    }
}
private struct AutomationListRequest: Encodable { let hostId: String; let botId: String?; let limit: Int; let after: AutomationScheduleCursor? }
private struct AutomationHistoryRequest: Encodable { let hostId: String; let botId: String?; let scheduleId: String?; let limit: Int; let after: AutomationHistoryCursor? }
private struct AutomationCalendarRequest: Encodable { let hostId: String; let from: Int64; let to: Int64; let botId: String?; let limit: Int }
private struct AutomationPreviewRequest: Encodable { let hostId: String; let when: AutomationWhen; let after: Int64?; let count: Int }

extension HostClient {
    public func automationStatus() async throws -> AutomationStatus {
        try automationOwner(); let value: AutomationStatus = try await request("/v1/automations/status", timeout: 15)
        guard automationID(value.hostId), value.inFlight.map({ $0 >= 0 }) ?? !value.configured,
              value.configured || !value.running else { throw HostClientError.contractMismatch }; return value
    }
    public func listAutomations(hostID: String, botID: String? = nil, after: AutomationScheduleCursor? = nil) async throws -> AutomationPage<AutomationSchedule, AutomationScheduleCursor> {
        try automationOwner(); let value: AutomationPage<AutomationSchedule, AutomationScheduleCursor> = try await request("/v1/automations/list", method: "POST", body: AutomationListRequest(hostId: hostID, botId: botID, limit: 500, after: after), timeout: 15)
        guard value.items.count <= 500, value.items.allSatisfy({ $0.isValid && $0.installationId == hostID && (botID == nil || $0.botId == botID) }) else { throw HostClientError.contractMismatch }; return value
    }
    public func automationHistory(hostID: String, botID: String? = nil, scheduleID: String? = nil, after: AutomationHistoryCursor? = nil) async throws -> AutomationPage<AutomationOccurrence, AutomationHistoryCursor> {
        try automationOwner(); let value: AutomationPage<AutomationOccurrence, AutomationHistoryCursor> = try await request("/v1/automations/history", method: "POST", body: AutomationHistoryRequest(hostId: hostID, botId: botID, scheduleId: scheduleID, limit: 100, after: after), timeout: 15)
        guard value.items.count <= 100, value.items.allSatisfy({ automationID($0.botId) && automationID($0.threadId) && (botID == nil || $0.botId == botID) }) else { throw HostClientError.contractMismatch }; return value
    }
    public func automationCalendar(hostID: String, from: Int64, to: Int64, botID: String? = nil) async throws -> AutomationCalendar {
        try automationOwner(); guard to > from, to - from <= 42 * 86_400_000 else { throw HostClientError.invalidRequest }
        let value: AutomationCalendar = try await request("/v1/automations/calendar", method: "POST", body: AutomationCalendarRequest(hostId: hostID, from: from, to: to, botId: botID, limit: 1000), timeout: 15)
        guard value.items.count <= 1000, value.from == from, value.to == to, value.items.allSatisfy({ $0.scheduledAt >= from && $0.scheduledAt < to && (botID == nil || $0.botId == botID) }) else { throw HostClientError.contractMismatch }; return value
    }
    public func previewAutomation(hostID: String, when: AutomationWhen, after: Int64? = nil) async throws -> AutomationPreview {
        try automationOwner(); guard when.isValid else { throw HostClientError.invalidRequest }
        let value: AutomationPreview = try await request("/v1/automations/preview", method: "POST", body: AutomationPreviewRequest(hostId: hostID, when: when, after: after, count: 5), timeout: 15)
        guard value.hostId == hostID, value.when == when, value.dates.count <= 5, value.dates == value.dates.sorted(), value.dates.allSatisfy({ $0 > (after ?? 0) }) else { throw HostClientError.contractMismatch }; return value
    }
    public func mutateAutomation(id: String?, operation: String, input: AutomationMutation) async throws -> AutomationReceipt {
        try automationOwner(); guard automationID(input.hostId), UUID(uuidString: input.clientRequestId) != nil, ["create", "update", "state", "run"].contains(operation), id.map(automationID) ?? (operation == "create") else { throw HostClientError.invalidRequest }
        let path = id.map { "/v1/automations/\($0)/\(operation)" } ?? "/v1/automations/create"
        let value: AutomationReceipt
        do { value = try await request(path, method: "POST", body: input, timeout: 30) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.hostId == input.hostId, value.clientRequestId == input.clientRequestId, value.scheduleId == value.schedule.id,
              id == nil || value.scheduleId == id, value.schedule.installationId == input.hostId, value.schedule.isValid else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    private func automationOwner() throws { guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden } }
}
private func automationID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 256 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
}
