import Foundation
import DexterHostClient

/// One history row built only from host facts. Root maps the semantic cases to localized copy; nothing here invents a title.
public struct ThreadHistoryRow: Identifiable, Equatable, Sendable {
    public enum Title: Equatable, Sendable {
        /// First persisted human text.
        case text(String)
        /// Host confirmed zero persisted messages.
        case noMessages
        /// Messages exist but none is human text (for example image-only).
        case untitled
        /// Host sent no summary for this conversation.
        case unavailable
    }
    public enum Preview: Equatable, Sendable {
        case text(String, fromBot: Bool, lastMessageHasImage: Bool)
        case image
        case none
        case unavailable
    }

    public let id: String
    public let thread: HostThread
    public let title: Title
    public let preview: Preview
    /// Latest persisted message time when known, otherwise the creation time.
    public let activityAt: Int64
    public let activityKnown: Bool
    public let messageCount: Int?
    public var createdAt: Int64 { thread.createdAt }
}

public enum ThreadHistoryProjection {
    /// Most recent activity first. A non-empty query keeps rows whose title or preview contains every word,
    /// ignoring case and diacritics; rows without a summary never match a query.
    public static func rows(threads: [HostThread], summaries: [String: HostThreadSummary], query: String = "",
                            locale: Locale = .current) -> [ThreadHistoryRow] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return threads.map { row($0, summaries[$0.id]) }
            .filter { words.isEmpty || matches($0, words, locale) }
            .sorted { ($0.activityAt, $0.createdAt) != ($1.activityAt, $1.createdAt)
                ? ($0.activityAt, $0.createdAt) > ($1.activityAt, $1.createdAt) : $0.id < $1.id }
    }

    /// A list GET must not erase conversations persisted while that GET was in flight.
    public static func retainingNewThreads(snapshot: [HostThread], knownIDs: Set<String>, current: [HostThread]) -> [HostThread] {
        let returnedIDs = Set(snapshot.map(\.id))
        return snapshot + current.filter { !knownIDs.contains($0.id) && !returnedIDs.contains($0.id) }
    }

    static func row(_ thread: HostThread, _ summary: HostThreadSummary?) -> ThreadHistoryRow {
        guard let summary, summary.threadID == thread.id else {
            return ThreadHistoryRow(id: thread.id, thread: thread, title: .unavailable, preview: .unavailable,
                                    activityAt: thread.createdAt, activityKnown: false, messageCount: nil)
        }
        let title: ThreadHistoryRow.Title = summary.title.map { .text($0) } ?? (summary.messageCount == 0 ? .noMessages : .untitled)
        let preview: ThreadHistoryRow.Preview
        if let text = summary.preview, let role = summary.previewRole {
            preview = .text(text, fromBot: role == .assistant, lastMessageHasImage: summary.lastMessageHasImage)
        } else {
            preview = summary.lastMessageHasImage ? .image : .none
        }
        return ThreadHistoryRow(id: thread.id, thread: thread, title: title, preview: preview,
                                activityAt: summary.updatedAt, activityKnown: summary.lastMessageAt != nil, messageCount: summary.messageCount)
    }

    private static func matches(_ row: ThreadHistoryRow, _ words: [String], _ locale: Locale) -> Bool {
        var haystack: [String] = []
        if case .text(let value) = row.title { haystack.append(value) }
        if case .text(let value, _, _) = row.preview { haystack.append(value) }
        guard !haystack.isEmpty else { return false }
        let text = haystack.joined(separator: " ")
        return words.allSatisfy { text.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive], locale: locale) != nil }
    }
}
