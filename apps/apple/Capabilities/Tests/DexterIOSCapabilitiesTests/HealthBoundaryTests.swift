import Foundation
import Testing
@testable import DexterIOSCapabilities

private let day = Date(timeIntervalSince1970: 1_728_000_000)
private func interval(_ count: Int = 1) throws -> UTCStepInterval {
    try UTCStepInterval(start: day, end: day.addingTimeInterval(Double(count) * 86_400))
}

private actor FixtureBackend: LocalStepBackend {
    var authorizations = 0
    var reads = 0
    var cancelledReads = 0
    var queriedIntervals: [UTCStepInterval] = []
    var result: StepReadResult = .emptyOrUnavailable
    var holdRead = false
    var holdAuthorization = false
    var authorizationResult: StepAuthorizationResult = .authorizationRequested
    var failRead = false
    private var waitingReads: [CheckedContinuation<Void, Never>] = []
    private var waitingAuthorizations: [CheckedContinuation<Void, Never>] = []
    private var observers: [CheckedContinuation<Void, Never>] = []
    private var authorizationObservers: [CheckedContinuation<Void, Never>] = []

    func configure(result: StepReadResult = .emptyOrUnavailable, holdRead: Bool = false, holdAuthorization: Bool = false) {
        self.result = result; self.holdRead = holdRead; self.holdAuthorization = holdAuthorization
    }
    func requestReadAuthorization() async throws -> StepAuthorizationResult {
        authorizations += 1
        let oldObservers = authorizationObservers; authorizationObservers.removeAll(); oldObservers.forEach { $0.resume() }
        if holdAuthorization { await withCheckedContinuation { waitingAuthorizations.append($0) } }
        return authorizationResult
    }
    func dailySteps(in interval: UTCStepInterval) async throws -> StepReadResult {
        reads += 1; queriedIntervals.append(interval)
        let oldObservers = observers; observers.removeAll(); oldObservers.forEach { $0.resume() }
        if holdRead { await withCheckedContinuation { waitingReads.append($0) } }
        if Task.isCancelled { cancelledReads += 1 }
        if failRead { throw NSError(domain: "synthetic-provider-detail", code: 7) }
        return result
    }
    func waitForRead() async {
        if reads == 0 { await withCheckedContinuation { observers.append($0) } }
    }
    func waitForAuthorization(_ target: Int = 1) async {
        if authorizations < target { await withCheckedContinuation { authorizationObservers.append($0) } }
    }
    func unavailableAuthorization() { authorizationResult = .dataUnavailable }
    func failReads() { failRead = true }
    func release() {
        let reads = waitingReads, authorizations = waitingAuthorizations
        waitingReads.removeAll(); waitingAuthorizations.removeAll()
        reads.forEach { $0.resume() }; authorizations.forEach { $0.resume() }
    }
    func counts() -> (Int, Int) { (authorizations, reads) }
    func intervals() -> [UTCStepInterval] { queriedIntervals }
    func cancellations() -> Int { cancelledReads }
}

private final class FixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var uptime: TimeInterval = 1_000
    private var wallClock = day
    func monotonicUptime() -> TimeInterval { lock.withLock { uptime } }
    func wallClockDate() -> Date { lock.withLock { wallClock } }
    func advance(_ seconds: TimeInterval) { lock.withLock { uptime += seconds } }
    func rollBackWallClock(_ seconds: TimeInterval) { lock.withLock { wallClock = wallClock.addingTimeInterval(-seconds) } }
}

private func authorized(_ backend: FixtureBackend, clock: FixtureClock? = nil) async throws -> LocalHealthBoundary {
    let boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { clock?.monotonicUptime() ?? 1_000 })
    await boundary.setForegroundActive(true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .requestStepReadAuthorization)
    #expect(try await boundary.requestAuthorization(consent: consent, scopeID: scope, requestID: request) == .authorizationRequested)
    return boundary
}

private func expectFailure(_ expected: HealthCapabilityError, _ body: () async throws -> Void) async {
    do { try await body(); Issue.record("Expected a safe refusal") }
    catch { #expect(error as? HealthCapabilityError == expected) }
}

@Test func defaultsNeverAuthorizeOrCapture() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend)
    await expectFailure(.inactive) {
        _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization)
    }
    #expect(await backend.counts().0 == 0)
    #expect(await backend.counts().1 == 0)
}

@Test func authorizationRequestIsNotAReadGrantAndReadNeedsItsOwnConsent() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { 1_000 })
    await boundary.setForegroundActive(true)
    let scope = UUID(), request = UUID()
    let read = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.authorizationRequired) { _ = try await boundary.readDailySteps(consent: read, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 0)
    let auth = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .requestStepReadAuthorization)
    #expect(try await boundary.requestAuthorization(consent: auth, scopeID: scope, requestID: request) == .authorizationRequested)
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: auth, scopeID: scope, requestID: request) }
    let fresh = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    #expect(try await boundary.readDailySteps(consent: fresh, scopeID: scope, requestID: request) == .emptyOrUnavailable)
}

@Test func consentCannotCrossScopeRequestOrOperation() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.requestChanged) { _ = try await boundary.readDailySteps(consent: consent, scopeID: UUID(), requestID: request) }
    await expectFailure(.requestChanged) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: UUID()) }
    await expectFailure(.requestChanged) { _ = try await boundary.requestAuthorization(consent: consent, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 0)
}

@Test func expiredConsentCannotStartAndExpiryAfterAwaitDiscardsResult() async throws {
    let backend = FixtureBackend(), clock = FixtureClock()
    let boundary = try await authorized(backend, clock: clock)
    let scope = UUID(), request = UUID()
    let stale = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval(), lifetime: 1)
    clock.advance(1)
    await expectFailure(.consentExpired) { _ = try await boundary.readDailySteps(consent: stale, scopeID: scope, requestID: request) }
    await backend.configure(result: .data([DailyStepCount(utcDay: day, count: 123)]), holdRead: true)
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval(), lifetime: 1)
    let task = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await backend.waitForRead(); clock.advance(1); await backend.release()
    await expectFailure(.consentExpired) { _ = try await task.value }
    #expect(await backend.counts().1 == 1)
}

@Test func wallClockRollbackDoesNotExtendMonotonicConsentTTL() async throws {
    let backend = FixtureBackend(), clock = FixtureClock()
    let boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { clock.monotonicUptime() })
    await boundary.setForegroundActive(true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request,
                                                       purpose: .displayDailySteps, interval: interval(), lifetime: 5)

    clock.rollBackWallClock(86_400)
    #expect(clock.wallClockDate() == day.addingTimeInterval(-86_400))
    clock.advance(5)
    await expectFailure(.consentExpired) {
        _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request)
    }
    #expect(await backend.counts().1 == 0)
}

@Test func revocationABAAndReplacementRequestCannotRestoreLateResults() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(result: .data([DailyStepCount(utcDay: day, count: 123)]), holdRead: true)
    let scope = UUID(), request = UUID()
    let first = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    let task = Task { try await boundary.readDailySteps(consent: first, scopeID: scope, requestID: request) }
    await backend.waitForRead(); await boundary.revoke(scopeID: scope)
    let replacement = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await backend.release()
    await expectFailure(.consentMissing) { _ = try await task.value }
    #expect(await backend.cancellations() == 1)
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: first, scopeID: scope, requestID: request) }
    await boundary.revoke(scopeID: scope)
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: replacement, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 1)
}

@Test func foregroundLossDiscardsLateResultAndOldConsentDoesNotReturn() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(holdRead: true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    let task = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await backend.waitForRead(); await boundary.setForegroundActive(false); await backend.release()
    await expectFailure(.inactive) { _ = try await task.value }
    #expect(await backend.cancellations() == 1)
    await boundary.setForegroundActive(true)
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
}

@Test func cancelledTaskDiscardsIgnoringBackendResultAndCannotReplay() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(result: .data([DailyStepCount(utcDay: day, count: 123)]), holdRead: true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    let task = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await backend.waitForRead(); task.cancel(); await backend.release()
    do { _ = try await task.value; Issue.record("Cancelled result escaped") } catch { #expect(error is CancellationError) }
    #expect(await backend.cancellations() == 1)
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 1)
}

@Test func oneConsentCannotStartTwoConcurrentBackendCalls() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(holdRead: true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request,
                                                       purpose: .displayDailySteps, interval: interval())
    let first = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await backend.waitForRead()
    let second = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await expectFailure(.alreadyUsed) { _ = try await second.value }

    await backend.release()
    #expect(try await first.value == .emptyOrUnavailable)
    #expect(await backend.counts().1 == 1)
}

@Test func noncooperativeCancelledReadsKeepTheFourOperationLimitUntilSettled() async throws {
    let backend = FixtureBackend(), clock = FixtureClock()
    let boundary = try await authorized(backend, clock: clock)
    await backend.configure(holdRead: true)
    var scopes: [UUID] = []
    var tasks: [Task<StepReadResult, any Error>] = []
    for _ in 0..<LocalHealthBoundary.maximumConcurrentRequests {
        let scope = UUID(), request = UUID()
        scopes.append(scope)
        let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request,
                                                           purpose: .displayDailySteps, interval: interval())
        tasks.append(Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) })
    }
    let deadline = ContinuousClock.now + .seconds(5)
    while await backend.counts().1 < LocalHealthBoundary.maximumConcurrentRequests {
        if ContinuousClock.now >= deadline {
            await backend.release()
            Issue.record("Fixture requests did not start")
            return
        }
        await Task.yield()
    }

    let replacementRequest = UUID()
    let replacement = try await boundary.consentToRequest(scopeID: scopes[0], requestID: replacementRequest,
                                                           purpose: .displayDailySteps, interval: interval())
    let extraScope = UUID(), extraRequest = UUID()
    let extra = try await boundary.consentToRequest(scopeID: extraScope, requestID: extraRequest,
                                                    purpose: .displayDailySteps, interval: interval())
    await expectFailure(.busy) {
        _ = try await boundary.readDailySteps(consent: extra, scopeID: extraScope, requestID: extraRequest)
    }

    await backend.release()
    for (index, task) in tasks.enumerated() {
        if index == 0 {
            await expectFailure(.consentMissing) { _ = try await task.value }
        } else {
            #expect(try await task.value == .emptyOrUnavailable)
        }
    }
    #expect(await backend.cancellations() == 1)
    #expect(await backend.counts().1 == LocalHealthBoundary.maximumConcurrentRequests)

    await backend.configure(holdRead: false)
    #expect(try await boundary.readDailySteps(consent: replacement, scopeID: scopes[0],
                                               requestID: replacementRequest) == .emptyOrUnavailable)
    #expect(try await boundary.readDailySteps(consent: extra, scopeID: extraScope, requestID: extraRequest) == .emptyOrUnavailable)
    await boundary.revoke(scopeID: extraScope)
    for scope in scopes { await boundary.revoke(scopeID: scope) }
}

@Test func replacementAtConsentCapacityInvalidatesOldHandleAndStaysBounded() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { 1_000 })
    await boundary.setForegroundActive(true)
    let scope = UUID(), oldRequest = UUID()
    let old = try await boundary.consentToRequest(scopeID: scope, requestID: oldRequest,
                                                   purpose: .requestStepReadAuthorization)
    for _ in 1..<LocalHealthBoundary.maximumConsents {
        _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization)
    }

    let replacementRequest = UUID()
    let replacement = try await boundary.consentToRequest(scopeID: scope, requestID: replacementRequest,
                                                           purpose: .requestStepReadAuthorization)
    await expectFailure(.consentMissing) {
        _ = try await boundary.requestAuthorization(consent: old, scopeID: scope, requestID: oldRequest)
    }
    await expectFailure(.busy) {
        _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization)
    }

    #expect(try await boundary.requestAuthorization(consent: replacement, scopeID: scope,
                                                     requestID: replacementRequest) == .authorizationRequested)
    #expect(await backend.counts().0 == 1)
}

@Test func revocationAndForegroundLossDiscardPendingAuthorization() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { 1_000 })
    await backend.configure(holdAuthorization: true)
    await boundary.setForegroundActive(true)

    let revokedScope = UUID(), revokedRequest = UUID()
    let revokedConsent = try await boundary.consentToRequest(scopeID: revokedScope, requestID: revokedRequest,
                                                              purpose: .requestStepReadAuthorization)
    let revokedTask = Task {
        try await boundary.requestAuthorization(consent: revokedConsent, scopeID: revokedScope, requestID: revokedRequest)
    }
    await backend.waitForAuthorization()
    await boundary.revoke(scopeID: revokedScope)
    await backend.release()
    await expectFailure(.consentMissing) { _ = try await revokedTask.value }

    let revokedReadRequest = UUID()
    let revokedRead = try await boundary.consentToRequest(scopeID: revokedScope, requestID: revokedReadRequest,
                                                           purpose: .displayDailySteps, interval: interval())
    await expectFailure(.authorizationRequired) {
        _ = try await boundary.readDailySteps(consent: revokedRead, scopeID: revokedScope, requestID: revokedReadRequest)
    }

    let foregroundScope = UUID(), foregroundRequest = UUID()
    let foregroundConsent = try await boundary.consentToRequest(scopeID: foregroundScope, requestID: foregroundRequest,
                                                                 purpose: .requestStepReadAuthorization)
    let foregroundTask = Task {
        try await boundary.requestAuthorization(consent: foregroundConsent, scopeID: foregroundScope, requestID: foregroundRequest)
    }
    await backend.waitForAuthorization(2)
    await boundary.setForegroundActive(false)
    await backend.release()
    await expectFailure(.inactive) { _ = try await foregroundTask.value }

    await boundary.setForegroundActive(true)
    let foregroundReadRequest = UUID()
    let foregroundRead = try await boundary.consentToRequest(scopeID: foregroundScope, requestID: foregroundReadRequest,
                                                              purpose: .displayDailySteps, interval: interval())
    await expectFailure(.authorizationRequired) {
        _ = try await boundary.readDailySteps(consent: foregroundRead, scopeID: foregroundScope, requestID: foregroundReadRequest)
    }
    #expect(await backend.counts().0 == 2)
    #expect(await backend.counts().1 == 0)
}

@Test func newRequestIdentityInvalidatesRunningRequestInSameScope() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(holdRead: true)
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    let task = Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await backend.waitForRead()
    _ = try await boundary.consentToRequest(scopeID: scope, requestID: UUID(), purpose: .displayDailySteps, interval: interval())
    await backend.release()
    await expectFailure(.consentMissing) { _ = try await task.value }
}

@Test func aggregatesRejectForeignDaysDuplicatesNonfiniteAndUnboundedCounts() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    let bad: [[DailyStepCount]] = [
        [], [DailyStepCount(utcDay: day.addingTimeInterval(86_400), count: 1)],
        [DailyStepCount(utcDay: day, count: 1), DailyStepCount(utcDay: day, count: 1)],
        [DailyStepCount(utcDay: day, count: .nan)], [DailyStepCount(utcDay: day, count: .infinity)],
        [DailyStepCount(utcDay: day, count: -1)], [DailyStepCount(utcDay: day, count: 1_000_001)],
        [DailyStepCount(utcDay: day.addingTimeInterval(1), count: 1)],
    ]
    for rows in bad {
        await backend.configure(result: .data(rows))
        let scope = UUID(), request = UUID()
        let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
        await expectFailure(.invalidAggregate) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    }
    #expect(await backend.counts().1 == bad.count)
}

@Test func utcBoundedIntervalsAndMinimalSortedAggregation() async throws {
    #expect(throws: HealthCapabilityError.invalidRequest) { try interval(32) }
    #expect(throws: HealthCapabilityError.invalidRequest) { try UTCStepInterval(start: day.addingTimeInterval(1), end: day.addingTimeInterval(86_400)) }
    #expect(throws: HealthCapabilityError.invalidRequest) { try UTCStepInterval(start: day, end: Date(timeIntervalSince1970: .infinity)) }
    let bounded = try interval(31)
    #expect(bounded.days.count == 31)
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    let rows = [DailyStepCount(utcDay: day.addingTimeInterval(86_400), count: 20), DailyStepCount(utcDay: day, count: 10)]
    await backend.configure(result: .data(rows))
    let scope = UUID(), request = UUID(), requested = try interval(2)
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: requested)
    #expect(try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) == .data(rows.reversed()))
    #expect(await backend.intervals() == [requested])
    #expect(String(reflecting: StepReadResult.data(rows)) == "StepReadResult(redacted)")
    #expect(String(reflecting: rows[0]) == "DailyStepCount(redacted)")
}

@Test func consentAndConcurrencyBudgetsAreBounded() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.configure(holdRead: true)
    var tasks: [Task<StepReadResult, any Error>] = []
    for _ in 0..<LocalHealthBoundary.maximumConcurrentRequests {
        let scope = UUID(), request = UUID()
        let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
        tasks.append(Task { try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) })
    }
    let deadline = ContinuousClock.now + .seconds(5)
    while await backend.counts().1 < LocalHealthBoundary.maximumConcurrentRequests {
        if ContinuousClock.now >= deadline { await backend.release(); Issue.record("Fixture requests did not start"); return }
        await Task.yield()
    }
    let scope = UUID(), request = UUID()
    let extra = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.busy) { _ = try await boundary.readDailySteps(consent: extra, scopeID: scope, requestID: request) }
    await backend.release()
    for task in tasks { #expect(try await task.value == .emptyOrUnavailable) }
    await boundary.revoke(scopeID: scope)
    for _ in 0..<LocalHealthBoundary.maximumConsents {
        _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization)
    }
    await expectFailure(.busy) { _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization) }
    await boundary.setForegroundActive(false)
    await boundary.setForegroundActive(true)
    _ = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), purpose: .requestStepReadAuthorization)
}

@Test func unavailableAuthorizationDoesNotPermitARead() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { 1_000 })
    await backend.unavailableAuthorization(); await boundary.setForegroundActive(true)
    let scope = UUID(), request = UUID()
    let auth = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .requestStepReadAuthorization)
    #expect(try await boundary.requestAuthorization(consent: auth, scopeID: scope, requestID: request) == .dataUnavailable)
    let read = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.authorizationRequired) { _ = try await boundary.readDailySteps(consent: read, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 0)
}

@Test func cancelledAuthorizationDoesNotSetRequestedState() async throws {
    let backend = FixtureBackend(), boundary = LocalHealthBoundary(backend: backend, monotonicUptime: { 1_000 })
    await backend.configure(holdAuthorization: true); await boundary.setForegroundActive(true)
    let scope = UUID(), request = UUID()
    let auth = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .requestStepReadAuthorization)
    let task = Task { try await boundary.requestAuthorization(consent: auth, scopeID: scope, requestID: request) }
    await backend.waitForAuthorization(); task.cancel(); await backend.release()
    do { _ = try await task.value; Issue.record("Cancelled authorization escaped") } catch { #expect(error is CancellationError) }
    let read = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.authorizationRequired) { _ = try await boundary.readDailySteps(consent: read, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 0)
}

@Test func backendFailureIsSafeAndDoesNotResend() async throws {
    let backend = FixtureBackend(), boundary = try await authorized(backend)
    await backend.failReads()
    let scope = UUID(), request = UUID()
    let consent = try await boundary.consentToRequest(scopeID: scope, requestID: request, purpose: .displayDailySteps, interval: interval())
    await expectFailure(.backendUnavailable) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    await expectFailure(.consentMissing) { _ = try await boundary.readDailySteps(consent: consent, scopeID: scope, requestID: request) }
    #expect(await backend.counts().1 == 1)
}
