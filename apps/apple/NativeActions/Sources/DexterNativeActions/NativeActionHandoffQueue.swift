import Foundation

public struct NativeActionHandoff: Equatable, Sendable, Identifiable {
    public let id: UUID
    public let route: NativeActionRoute
    public let expiresAt: Date

    fileprivate init(id: UUID, route: NativeActionRoute, expiresAt: Date) {
        self.id = id
        self.route = route
        self.expiresAt = expiresAt
    }
}

/// A short-lived, in-process handoff for the main app's future scene router. It persists no drafts.
public actor NativeActionHandoffQueue {
    public static let shared = NativeActionHandoffQueue()

    static let maximumCapacity = 32
    static let maximumLifetime: TimeInterval = 600
    static let maximumSubscriberCount = 16
    static let subscriberBufferCapacity = 32

    private struct Entry: Sendable {
        let route: NativeActionRoute
        let expiresAt: Date
    }

    private let capacity: Int
    private let lifetime: TimeInterval
    private let now: @Sendable () -> Date
    private var entries: [UUID: Entry] = [:]
    private var order: [UUID] = []
    private var subscribers: [UUID: AsyncStream<UUID>.Continuation] = [:]

    public init(
        capacity: Int = 8,
        lifetime: TimeInterval = 120,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.capacity = min(max(capacity, 1), 32)
        self.lifetime = min(max(lifetime, 1), 600)
        self.now = now
    }

    /// Enqueues a validated route and publishes only its opaque, one-shot handoff ID.
    /// Duplicate routes remain distinct because each invocation represents a separate user action.
    @discardableResult
    public func enqueue(_ route: NativeActionRoute) throws -> UUID {
        pruneExpired()
        guard entries.count < capacity else { throw NativeActionError.handoffQueueFull }
        let id = UUID()
        let expiresAt = now().addingTimeInterval(lifetime)
        entries[id] = Entry(route: route, expiresAt: expiresAt)
        order.append(id)
        publish(id)
        return id
    }

    /// Subscribes with a bounded buffer and replays current unexpired IDs in insertion order.
    /// If the buffer overflows, the stream finishes so callers can reconnect and replay pending IDs.
    /// If the subscriber limit is reached, the returned stream finishes immediately.
    public func updates() -> AsyncStream<UUID> {
        guard subscribers.count < Self.maximumSubscriberCount else {
            return AsyncStream { continuation in continuation.finish() }
        }

        let subscriberID = UUID()
        let (stream, continuation) = AsyncStream<UUID>.makeStream(
            bufferingPolicy: .bufferingNewest(Self.subscriberBufferCapacity)
        )
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeSubscriber(subscriberID) }
        }
        subscribers[subscriberID] = continuation
        pruneExpired()
        for id in order { continuation.yield(id) }
        return stream
    }

    /// Consumes a handoff exactly once. Callers still validate the thread against the current host.
    public func consume(_ id: UUID) -> NativeActionHandoff? {
        pruneExpired()
        guard let entry = entries.removeValue(forKey: id) else { return nil }
        order.removeAll { $0 == id }
        return NativeActionHandoff(id: id, route: entry.route, expiresAt: entry.expiresAt)
    }

    /// Discards a route when the app scene or the user abandons the handoff.
    @discardableResult
    public func cancel(_ id: UUID) -> Bool {
        pruneExpired()
        let removed = entries.removeValue(forKey: id) != nil
        if removed { order.removeAll { $0 == id } }
        return removed
    }

    public func cancelAll() -> Int {
        let count = entries.count
        entries.removeAll(keepingCapacity: false)
        order.removeAll(keepingCapacity: false)
        return count
    }

    public func pendingCount() -> Int {
        pruneExpired()
        return entries.count
    }

    func activeSubscriberCount() -> Int {
        subscribers.count
    }

    private func publish(_ id: UUID) {
        let terminated = subscribers.compactMap { subscriberID, continuation -> UUID? in
            switch continuation.yield(id) {
            case .enqueued:
                return nil
            case .dropped:
                // A subscriber that missed an ID must reconnect; updates() replays all still-pending IDs.
                continuation.finish()
                return subscriberID
            case .terminated:
                return subscriberID
            @unknown default:
                continuation.finish()
                return subscriberID
            }
        }
        for subscriberID in terminated { subscribers.removeValue(forKey: subscriberID) }
    }

    private func pruneExpired() {
        let instant = now()
        let expired = Set(order.filter { id in
            guard let entry = entries[id] else { return true }
            return instant >= entry.expiresAt
        })
        guard !expired.isEmpty else { return }
        for id in expired { entries.removeValue(forKey: id) }
        order.removeAll { expired.contains($0) }
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }
}
