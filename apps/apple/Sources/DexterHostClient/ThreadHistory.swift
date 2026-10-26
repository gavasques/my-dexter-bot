import Foundation

/// Display-only metadata the host derives from persisted messages, delivered as the `summaries` sibling of a thread
/// list's `items`. A missing summary means unknown (older host, Team lane in a bot list, or response budget), never empty.
public struct HostThreadSummary: Codable, Equatable, Hashable, Sendable {
    public static let titleLimit = 80
    public static let previewLimit = 160

    public let threadID: String
    /// First persisted human text of the conversation, normalized to one line. `nil` when there is none.
    public let title: String?
    /// Latest persisted textual message (any role), normalized to one line.
    public let preview: String?
    public let previewRole: MessageRole?
    public let lastMessageHasImage: Bool
    public let messageCount: Int
    public let lastMessageAt: Int64?
    /// `max(createdAt, lastMessageAt)`.
    public let updatedAt: Int64

    public init(threadID: String, title: String?, preview: String?, previewRole: MessageRole?, lastMessageHasImage: Bool,
                messageCount: Int, lastMessageAt: Int64?, updatedAt: Int64) {
        self.threadID = threadID; self.title = title; self.preview = preview; self.previewRole = previewRole
        self.lastMessageHasImage = lastMessageHasImage; self.messageCount = messageCount
        self.lastMessageAt = lastMessageAt; self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case threadID = "threadId", title, preview, previewRole, lastMessageHasImage, messageCount, lastMessageAt, updatedAt
    }

    func isValid(for thread: HostThread) -> Bool {
        guard threadID == thread.id, messageCount >= 0, updatedAt >= 0,
              Self.displayText(title, limit: Self.titleLimit), Self.displayText(preview, limit: Self.previewLimit),
              (preview == nil) == (previewRole == nil) else { return false }
        guard let lastMessageAt else {
            return messageCount == 0 && title == nil && preview == nil && !lastMessageHasImage && updatedAt == thread.createdAt
        }
        return messageCount > 0 && lastMessageAt >= 0 && updatedAt == max(thread.createdAt, lastMessageAt)
    }

    private static func displayText(_ value: String?, limit: Int) -> Bool {
        guard let value else { return true }
        return !value.isEmpty && value.utf16.count <= limit && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) || (0x2028...0x202E).contains($0.value) }
    }
}

/// Threads and their summaries from one GET of the list route; no per-thread reads.
public struct HostThreadHistory: Equatable, Sendable {
    public let threads: [HostThread]
    public let summaries: [String: HostThreadSummary]
    /// `false` when the host predates summaries; rows must then show creation dates only.
    public let summariesProvided: Bool
    /// The private list is capped to the 500 most recently active conversations.
    public let mayHaveOlderThreads: Bool

    public init(threads: [HostThread], summaries: [String: HostThreadSummary], summariesProvided: Bool, mayHaveOlderThreads: Bool) {
        self.threads = threads; self.summaries = summaries
        self.summariesProvided = summariesProvided; self.mayHaveOlderThreads = mayHaveOlderThreads
    }

    public func summary(for threadID: String) -> HostThreadSummary? { summaries[threadID] }

    /// Every summary must belong to a listed thread of this response and satisfy the host invariants.
    static func validating(listed: [HostThread], kept: [HostThread], summaries: [HostThreadSummary]?, cap: Int?) throws -> HostThreadHistory {
        let limit = HostClient.threadHistoryLimit
        guard (cap.map { listed.count <= $0 } ?? true), Set(listed.map(\.id)).count == listed.count,
              (summaries?.count ?? 0) <= limit, Set((summaries ?? []).map(\.threadID)).count == (summaries?.count ?? 0)
        else { throw HostClientError.contractMismatch }
        let byID = Dictionary(uniqueKeysWithValues: listed.map { ($0.id, $0) })
        var accepted: [String: HostThreadSummary] = [:]
        let keptIDs = Set(kept.map(\.id))
        for summary in summaries ?? [] {
            guard let thread = byID[summary.threadID] else { throw HostClientError.contractMismatch }
            // Invalid display metadata cannot make an otherwise valid conversation unavailable.
            guard summary.isValid(for: thread) else { continue }
            if keptIDs.contains(summary.threadID) { accepted[summary.threadID] = summary }
        }
        return HostThreadHistory(threads: kept, summaries: accepted, summariesProvided: summaries != nil,
                                 mayHaveOlderThreads: cap.map { listed.count >= $0 } ?? false)
    }
}

struct HostThreadListResponse: Decodable, Sendable {
    let items: [HostThread]
    let summaries: [HostThreadSummary]?
}

extension HostClient {
    public static let threadHistoryLimit = 500

    /// One GET `/v1/bots/:botId/threads`. Returns only this bot's private conversations, in host order (oldest first),
    /// with summaries for the most recently active ones. The closed paired route set has no thread list yet, so a paired
    /// client, or a host without the list route (404), keeps the legacy discovery and reports `summariesProvided == false`.
    public func listThreadHistory(botID: String) async throws -> HostThreadHistory {
        guard historySafeID(botID), let segment = botID.addingPercentEncoding(withAllowedCharacters: historyPathAllowed)
        else { throw HostClientError.invalidRequest }
        let legacy = { HostThreadHistory(threads: try await listThreads(botID: botID), summaries: [:], summariesProvided: false, mayHaveOlderThreads: false) }
        if case .pairedHost = accessPolicy { return try await legacy() }
        let response: HostThreadListResponse
        do { response = try await request("/v1/bots/\(segment)/threads", timeout: 15) }
        catch HostClientError.notFound { return try await legacy() }
        guard response.items.allSatisfy({ $0.botId == botID && historySafeID($0.id) }) else { throw HostClientError.contractMismatch }
        return try HostThreadHistory.validating(listed: response.items, kept: response.items.filter(\.isPrivateConversation),
                                                summaries: response.summaries, cap: Self.threadHistoryLimit)
    }
}

private let historyPathAllowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
func historySafeID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.contains("/") && !value.contains("\\")
        && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
}
