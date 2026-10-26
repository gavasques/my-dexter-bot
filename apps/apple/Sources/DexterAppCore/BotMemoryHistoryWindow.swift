import DexterHostClient

/// Newest-first window over the host's paged MEMORY history (pages are newest first, cursor `before=rN`).
/// Keeps at most `limit` distinct revisions and always the most recent ones. Once the window is full,
/// this list stops asking for older pages: re-reading starts again from the newest page.
public struct BotMemoryHistoryWindow: Equatable, Sendable {
    public static let limit = 100
    public private(set) var items: [BotMemoryRevision] = []
    public private(set) var nextCursor: String?
    /// True when older revisions exist on the host but are outside this window.
    public private(set) var reachedLimit = false
    private var usedCursors: Set<String> = []

    public init() {}

    public var canLoadOlder: Bool { nextCursor != nil && !reachedLimit }

    public mutating func reset() { self = Self() }

    /// The first page (newest revisions) replaces the whole window.
    public mutating func replace(with page: BotMemoryHistory) {
        self = Self()
        merge(page)
    }

    /// A page read with `cursor`, which must be the window's current `nextCursor`.
    public mutating func appendOlder(_ page: BotMemoryHistory, requestedWith cursor: String) {
        guard cursor == nextCursor, canLoadOlder else { return }
        usedCursors.insert(cursor)
        merge(page)
    }

    private mutating func merge(_ page: BotMemoryHistory) {
        var known = Set(items.map(\.revision))
        var merged = items
        // A revision is one identity; a repeated item never replaces the copy already shown.
        for item in page.items where known.insert(item.revision).inserted { merged.append(item) }
        merged.sort { $0.revision > $1.revision }
        let olderExist = page.nextCursor != nil
        if merged.count > Self.limit || (merged.count == Self.limit && olderExist) {
            reachedLimit = true
            nextCursor = nil
        } else if let cursor = page.nextCursor, !usedCursors.contains(cursor) {
            nextCursor = cursor
        } else {
            // No cursor, or a cursor that would repeat a page already read: nothing more to request.
            nextCursor = nil
        }
        items = Array(merged.prefix(Self.limit))
    }
}
