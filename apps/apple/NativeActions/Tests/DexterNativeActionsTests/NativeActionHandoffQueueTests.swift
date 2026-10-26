import XCTest
@testable import DexterNativeActions

final class NativeActionHandoffQueueTests: XCTestCase {
    private let threadID = try! DexterThreadID("thr_01234567-89ab-cdef-0123-456789abcdef")

    func testLiveSubscriberReceivesOpaqueIDAndRouteIsConsumedExactlyOnce() async throws {
        let queue = NativeActionHandoffQueue()
        let updates = await queue.updates()
        let route = NativeActionRoute.openConversation(threadID: threadID)
        let id = try await queue.enqueue(route)
        let received = try await collect(from: updates, count: 1)

        let handoff = await queue.consume(id)
        let replay = await queue.consume(id)
        let pendingCount = await queue.pendingCount()

        XCTAssertEqual(received, [id])
        XCTAssertEqual(handoff?.route, route)
        XCTAssertNil(replay)
        XCTAssertEqual(pendingCount, 0)
    }

    func testPendingUnexpiredHandoffIsReplayedToLateSubscriber() async throws {
        let queue = NativeActionHandoffQueue()
        let id = try await queue.enqueue(.openConversation(threadID: threadID))
        let updates = await queue.updates()
        let received = try await collect(from: updates, count: 1)

        XCTAssertEqual(received, [id])
    }

    func testExpiredHandoffsArePrunedBeforeReplayAndEnqueue() async throws {
        let clock = TestClock(Date(timeIntervalSince1970: 1_000))
        let queue = NativeActionHandoffQueue(capacity: 1, lifetime: 10, now: { clock.read() })
        let expiredID = try await queue.enqueue(.openConversation(threadID: threadID))

        clock.set(1_010)
        let replacementID = try await queue.enqueue(.prepareMessage(
            threadID: threadID,
            draft: BoundedDraft("safe draft")
        ))
        let staleConsume = await queue.consume(expiredID)
        XCTAssertNil(staleConsume)

        let updates = await queue.updates()
        let replayed = try await collect(from: updates, count: 1)
        XCTAssertEqual(replayed, [replacementID])
        let pendingCount = await queue.pendingCount()
        let replacement = await queue.consume(replacementID)
        XCTAssertEqual(pendingCount, 1)
        XCTAssertEqual(replacement?.route.requiresInAppConfirmation, true)
    }

    func testExactTTLBoundaryExpiresHandoff() async throws {
        let clock = TestClock(Date(timeIntervalSince1970: 2_000))
        let queue = NativeActionHandoffQueue(capacity: 2, lifetime: 10, now: { clock.read() })
        let id = try await queue.enqueue(.openConversation(threadID: threadID))

        clock.set(2_009.999)
        let beforeBoundary = await queue.pendingCount()
        clock.set(2_010)
        let atBoundary = await queue.pendingCount()
        let expired = await queue.consume(id)
        XCTAssertEqual(beforeBoundary, 1)
        XCTAssertEqual(atBoundary, 0)
        XCTAssertNil(expired)
    }

    func testMinimumAndMaximumCapacityAndLifetimeAreClamped() async throws {
        let minimumClock = TestClock(Date(timeIntervalSince1970: 0))
        let minimumQueue = NativeActionHandoffQueue(capacity: 0, lifetime: -50, now: { minimumClock.read() })
        let minimumID = try await minimumQueue.enqueue(.openConversation(threadID: threadID))
        do {
            _ = try await minimumQueue.enqueue(.openConversation(threadID: threadID))
            XCTFail("Zero capacity must clamp to one entry")
        } catch {
            XCTAssertEqual(error as? NativeActionError, .handoffQueueFull)
        }
        minimumClock.set(1)
        let minimumExpired = await minimumQueue.consume(minimumID)
        XCTAssertNil(minimumExpired, "Negative lifetime clamps to one second")

        let maximumClock = TestClock(Date(timeIntervalSince1970: 0))
        let maximumQueue = NativeActionHandoffQueue(capacity: 10_000, lifetime: 1_000_000, now: { maximumClock.read() })
        var ids: [UUID] = []
        for _ in 0..<NativeActionHandoffQueue.maximumCapacity {
            ids.append(try await maximumQueue.enqueue(.openConversation(threadID: threadID)))
        }
        do {
            _ = try await maximumQueue.enqueue(.openConversation(threadID: threadID))
            XCTFail("Capacity must clamp to 32")
        } catch {
            XCTAssertEqual(error as? NativeActionError, .handoffQueueFull)
        }

        maximumClock.set(Double(NativeActionHandoffQueue.maximumLifetime) - 0.001)
        let beforeMaximum = await maximumQueue.consume(ids[0])
        maximumClock.set(Double(NativeActionHandoffQueue.maximumLifetime))
        let atMaximum = await maximumQueue.consume(ids[1])
        XCTAssertNotNil(beforeMaximum, "Lifetime remains live just before the 600-second clamp")
        XCTAssertNil(atMaximum, "Lifetime clamps to 600 seconds")
    }

    func testConcurrentConsumeReturnsOneHandoffOnly() async throws {
        let queue = NativeActionHandoffQueue()
        let id = try await queue.enqueue(.prepareMessage(threadID: threadID, draft: BoundedDraft("private")))

        let results = await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<200 {
                group.addTask { await queue.consume(id) != nil }
            }
            var successes = 0
            for await succeeded in group where succeeded { successes += 1 }
            return successes
        }

        let pendingCount = await queue.pendingCount()
        XCTAssertEqual(results, 1)
        XCTAssertEqual(pendingCount, 0)
    }

    func testDuplicateInvocationsRemainSeparateHandoffs() async throws {
        let queue = NativeActionHandoffQueue()
        let route = NativeActionRoute.openConversation(threadID: threadID)
        let first = try await queue.enqueue(route)
        let second = try await queue.enqueue(route)

        XCTAssertNotEqual(first, second)
        let pendingCount = await queue.pendingCount()
        let firstHandoff = await queue.consume(first)
        let secondHandoff = await queue.consume(second)
        XCTAssertEqual(pendingCount, 2)
        XCTAssertEqual(firstHandoff?.route, route)
        XCTAssertEqual(secondHandoff?.route, route)
    }

    func testBoundedSubscriberBufferPreservesAllStillPendingRoutes() async throws {
        let queue = NativeActionHandoffQueue(capacity: NativeActionHandoffQueue.maximumCapacity)
        let updates = await queue.updates()
        let route = NativeActionRoute.openConversation(threadID: threadID)
        var ids: [UUID] = []

        for _ in 0..<NativeActionHandoffQueue.subscriberBufferCapacity {
            ids.append(try await queue.enqueue(route))
        }
        let oldest = await queue.consume(ids[0])
        XCTAssertNotNil(oldest)
        ids.append(try await queue.enqueue(route)) // The first dropped notification forces a replayable resubscribe.

        let bufferedIDs = try await collectUntilEnd(updates)
        let stillPendingIDs = Array(ids.suffix(NativeActionHandoffQueue.maximumCapacity))
        XCTAssertEqual(bufferedIDs, stillPendingIDs, "The bounded newest buffer retains the newest notifications before it signals resync")
        let subscriberCountAfterOverflow = await queue.activeSubscriberCount()
        XCTAssertEqual(subscriberCountAfterOverflow, 0, "An overflowed subscriber is removed before its resync")

        let recoveredStream = await queue.updates()
        let recoveredIDs = try await collect(from: recoveredStream, count: NativeActionHandoffQueue.maximumCapacity)
        XCTAssertEqual(recoveredIDs, stillPendingIDs, "Re-subscribing replays every still-pending route after a dropped notification")
        var consumed: [UUID] = []
        for id in stillPendingIDs {
            if await queue.consume(id) != nil { consumed.append(id) }
        }
        XCTAssertEqual(consumed, stillPendingIDs, "Buffer overflow may drop notifications, but never a valid queued route")
        let pendingCount = await queue.pendingCount()
        XCTAssertEqual(pendingCount, 0)
    }

    func testSubscriberLimitAndTerminationCleanupAreBoundedAndIdempotent() async throws {
        let queue = NativeActionHandoffQueue()
        var readers: [Task<Void, Never>] = []
        for _ in 0..<NativeActionHandoffQueue.maximumSubscriberCount {
            let stream = await queue.updates()
            readers.append(Task.detached {
                for await _ in stream {}
            })
        }
        let fullSubscriberCount = await queue.activeSubscriberCount()
        XCTAssertEqual(fullSubscriberCount, NativeActionHandoffQueue.maximumSubscriberCount)

        let overflow = await queue.updates()
        let countAfterOverflow = await queue.activeSubscriberCount()
        let overflowValues = try await collect(from: overflow, count: 1)
        XCTAssertEqual(countAfterOverflow, NativeActionHandoffQueue.maximumSubscriberCount)
        XCTAssertTrue(overflowValues.isEmpty, "Over-limit subscriber stream finishes immediately")

        readers.forEach { $0.cancel() }
        for reader in readers { await reader.value }
        let allReadersRemoved = await eventually { await queue.activeSubscriberCount() == 0 }
        XCTAssertTrue(allReadersRemoved)

        // Repeated termination cannot underflow a separate counter: the dictionary is the source of truth.
        let replacementStream = await queue.updates()
        let replacementSubscriberCount = await queue.activeSubscriberCount()
        XCTAssertEqual(replacementSubscriberCount, 1)
        let replacementReader = Task.detached {
            for await _ in replacementStream {}
        }
        replacementReader.cancel()
        await replacementReader.value
        let replacementRemoved = await eventually { await queue.activeSubscriberCount() == 0 }
        XCTAssertTrue(replacementRemoved)
    }

    func testCancelAndCancelAllDiscardUnconsumedDrafts() async throws {
        let queue = NativeActionHandoffQueue()
        let first = try await queue.enqueue(.prepareMessage(threadID: threadID, draft: BoundedDraft("private draft")))
        let second = try await queue.enqueue(.openConversation(threadID: threadID))

        let firstCancelled = await queue.cancel(first)
        let firstAfterCancel = await queue.consume(first)
        let cancelledRemaining = await queue.cancelAll()
        let secondAfterCancel = await queue.consume(second)
        XCTAssertTrue(firstCancelled)
        XCTAssertNil(firstAfterCancel)
        XCTAssertEqual(cancelledRemaining, 1)
        XCTAssertNil(secondAfterCancel)
    }

    private func collectUntilEnd<Element: Sendable>(
        _ stream: AsyncStream<Element>,
        timeout: Duration = .seconds(1)
    ) async throws -> [Element] {
        try await withThrowingTaskGroup(of: [Element].self) { group in
            group.addTask {
                var iterator = stream.makeAsyncIterator()
                var values: [Element] = []
                for _ in 0...NativeActionHandoffQueue.subscriberBufferCapacity {
                    guard let value = await iterator.next() else { return values }
                    values.append(value)
                }
                return values
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw StreamReadTimedOut()
            }
            do {
                let values = try await group.next() ?? []
                group.cancelAll()
                return values
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }

    private func eventually(
        attempts: Int = 100,
        predicate: () async -> Bool
    ) async -> Bool {
        for _ in 0..<attempts {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return await predicate()
    }

    private func collect<Element: Sendable>(
        from stream: AsyncStream<Element>,
        count: Int,
        timeout: Duration = .seconds(1)
    ) async throws -> [Element] {
        try await withThrowingTaskGroup(of: [Element].self) { group in
            group.addTask {
                var iterator = stream.makeAsyncIterator()
                var values: [Element] = []
                for _ in 0..<count {
                    guard let value = await iterator.next() else { break }
                    values.append(value)
                }
                return values
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw StreamReadTimedOut()
            }

            do {
                let values = try await group.next() ?? []
                group.cancelAll()
                return values
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }
}

private struct StreamReadTimedOut: Error {}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date

    init(_ instant: Date) { self.instant = instant }

    func read() -> Date {
        lock.lock()
        defer { lock.unlock() }
        return instant
    }

    func set(_ instant: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        self.instant = Date(timeIntervalSince1970: instant)
    }
}
