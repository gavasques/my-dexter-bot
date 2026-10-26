import DexterNativeActions
import Foundation
import CoreGraphics
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import DexterIOSCapabilities

private actor ForegroundFixtureBackend: IOSForegroundCapabilityBackend {
    private var calls = 0
    private var outcome: Result<IOSForegroundCapabilityOutcome, IOSForegroundCapabilityError> = .success(.value(.contact(name: "Ada Lovelace")))
    private var held = false
    private var respectCancellation = false
    private var checkAuthorizationAfterWait = false
    private var downstreamEffects = 0
    private var pending: [CheckedContinuation<Void, Never>] = []
    private var callObservers: [CheckedContinuation<Void, Never>] = []

    func configure(_ outcome: Result<IOSForegroundCapabilityOutcome, IOSForegroundCapabilityError>, held: Bool = false,
                   respectCancellation: Bool = false, checkAuthorizationAfterWait: Bool = false) {
        self.outcome = outcome
        self.held = held
        self.respectCancellation = respectCancellation
        self.checkAuthorizationAfterWait = checkAuthorizationAfterWait
    }

    func perform(_ request: IOSForegroundCapabilityRequest) async throws -> IOSForegroundCapabilityOutcome {
        try await request.checkAuthorization()
        calls += 1
        let observers = callObservers
        callObservers.removeAll()
        observers.forEach { $0.resume() }
        if held { await withCheckedContinuation { pending.append($0) } }
        if respectCancellation { try Task.checkCancellation() }
        if checkAuthorizationAfterWait { try await request.checkAuthorization() }
        downstreamEffects += 1
        return try outcome.get()
    }

    func waitForCall() async {
        if calls == 0 { await withCheckedContinuation { callObservers.append($0) } }
    }

    func release() {
        let waiters = pending
        pending.removeAll()
        waiters.forEach { $0.resume() }
    }

    func count() -> Int { calls }
    func effects() -> Int { downstreamEffects }
}

private final class ForegroundFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var uptime: TimeInterval = 10
    func now() -> TimeInterval { lock.withLock { uptime } }
    func advance(_ value: TimeInterval) { lock.withLock { uptime += value } }
}

private func makeBoundary(_ backend: ForegroundFixtureBackend, clock: ForegroundFixtureClock? = nil) -> IOSForegroundCapabilityBoundary {
    IOSForegroundCapabilityBoundary(backend: backend, monotonicUptime: { clock?.now() ?? 10 })
}

private func consent(_ boundary: IOSForegroundCapabilityBoundary, capability: IOSNativeCapability = .contacts,
                     scope: UUID = UUID(), request: UUID = UUID(), lifetime: TimeInterval = 60,
                     clock: ForegroundFixtureClock? = nil) async throws
    -> (scope: UUID, request: UUID, handle: IOSForegroundCapabilityConsent) {
    await boundary.setForegroundActive(true, scopeID: scope)
    let handle = try await boundary.consentToRequest(scopeID: scope, requestID: request, capability: capability, lifetime: lifetime)
    return (scope, request, handle)
}

private func require(_ expected: IOSForegroundCapabilityError,
                     _ action: () async throws -> IOSForegroundCapabilityResult) async {
    do {
        _ = try await action()
        Issue.record("Expected a safe refusal")
    } catch let error as IOSForegroundCapabilityError {
        #expect(error == expected)
    } catch {
        Issue.record("Unexpected error type: \(type(of: error))")
    }
}

private func syntheticJPEG(width: Int = 1, height: Int = 1) throws -> Data {
    var pixels = Data()
    pixels.reserveCapacity(width * height * 4)
    for _ in 0..<(width * height) { pixels.append(contentsOf: [0x20, 0x40, 0x60, 0xFF]) }
    guard let provider = CGDataProvider(data: pixels as CFData),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
        throw IOSForegroundCapabilityError.backendUnavailable
    }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw IOSForegroundCapabilityError.backendUnavailable
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw IOSForegroundCapabilityError.backendUnavailable }
    return output as Data
}

@MainActor
private final class ForegroundPermissionFixture: IOSForegroundPermissionPreparationBackend {
    private(set) var calls: [IOSNativeCapability] = []
    private var isHeld = false
    private var failure: IOSForegroundCapabilityError?
    private var pending: CheckedContinuation<Void, Never>?
    private var observers: [CheckedContinuation<Void, Never>] = []

    func configure(held: Bool = false, failure: IOSForegroundCapabilityError? = nil) {
        isHeld = held
        self.failure = failure
    }

    func preparePermission(for capability: IOSNativeCapability) async throws {
        calls.append(capability)
        let waiting = observers
        observers.removeAll()
        waiting.forEach { $0.resume() }
        if isHeld { await withCheckedContinuation { pending = $0 } }
        if let failure { throw failure }
    }

    func waitForCall(_ count: Int = 1) async {
        if calls.count < count { await withCheckedContinuation { observers.append($0) } }
    }

    func release() {
        let continuation = pending
        pending = nil
        continuation?.resume()
        isHeld = false
    }
}

private func localizationFromPackage(_ key: String, language: String) -> String? {
    guard let path = Bundle.module.path(forResource: language, ofType: "lproj"),
          let localizedBundle = Bundle(path: path) else { return nil }
    return localizedBundle.localizedString(forKey: key, value: "__missing__", table: "Localizable")
}

@Test func noConsentOrInactiveForegroundMeansZeroProviderCalls() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await require(.inactive) {
        let token = try await boundary.consentToRequest(scopeID: UUID(), requestID: UUID(), capability: .contacts)
        return try await boundary.perform(consent: token, scopeID: UUID(), requestID: UUID(), capability: .contacts)
    }
    #expect(await backend.count() == 0)
}

@Test func scopeRequestAndCapabilityAreBoundBeforeProviderCall() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    let issued = try await consent(boundary, capability: .contacts)
    let otherScope = UUID()
    await boundary.setForegroundActive(true, scopeID: otherScope)
    await require(.requestChanged) {
        try await boundary.perform(consent: issued.handle, scopeID: otherScope, requestID: issued.request, capability: .contacts)
    }
    await require(.requestChanged) {
        try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: UUID(), capability: .contacts)
    }
    await require(.requestChanged) {
        try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .files)
    }
    #expect(await backend.count() == 0)
}

@Test func handleIsOneUseAndReplayNeverCallsProviderAgain() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    let issued = try await consent(boundary)
    _ = try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts)
    await require(.alreadyUsed) {
        try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts)
    }
    #expect(await backend.count() == 1)
}

@Test func sameRequestIDCannotMintAnotherHandleInsideOneScope() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    let scope = UUID(), request = UUID()
    await boundary.setForegroundActive(true, scopeID: scope)
    _ = try await boundary.consentToRequest(scopeID: scope, requestID: request, capability: .contacts)
    await requireConsentError(.requestChanged) {
        _ = try await boundary.consentToRequest(scopeID: scope, requestID: request, capability: .contacts)
    }
    #expect(await backend.count() == 0)
}

@Test func consentAndRequestCardinalityAreBounded() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    var scopes: [UUID] = []
    for _ in 0..<IOSForegroundCapabilityBoundary.maximumOutstandingConsents {
        let scope = UUID()
        scopes.append(scope)
        await boundary.setForegroundActive(true, scopeID: scope)
        _ = try await boundary.consentToRequest(scopeID: scope, requestID: UUID(), capability: .contacts)
    }
    let extraScope = UUID()
    scopes.append(extraScope)
    await boundary.setForegroundActive(true, scopeID: extraScope)
    await requireConsentError(.busy) {
        _ = try await boundary.consentToRequest(scopeID: extraScope, requestID: UUID(), capability: .contacts)
    }
    for scope in scopes { await boundary.revoke(scopeID: scope) }

    let singleScope = UUID()
    await boundary.setForegroundActive(true, scopeID: singleScope)
    for _ in 0..<IOSForegroundCapabilityBoundary.maximumRequestsPerScope {
        _ = try await boundary.consentToRequest(scopeID: singleScope, requestID: UUID(), capability: .contacts)
    }
    await requireConsentError(.busy) {
        _ = try await boundary.consentToRequest(scopeID: singleScope, requestID: UUID(), capability: .contacts)
    }
    await boundary.revoke(scopeID: singleScope)
    #expect(await backend.count() == 0)
}

private func requireConsentError(_ expected: IOSForegroundCapabilityError, _ action: () async throws -> Void) async {
    do { try await action(); Issue.record("Expected a safe refusal") }
    catch let error as IOSForegroundCapabilityError { #expect(error == expected) }
    catch { Issue.record("Unexpected error type: \(type(of: error))") }
}

@Test func invalidTTLIsRejectedAndExpiredConsentStartsNoProvider() async throws {
    let backend = ForegroundFixtureBackend(), clock = ForegroundFixtureClock(), boundary = makeBoundary(backend, clock: clock)
    let scope = UUID()
    await boundary.setForegroundActive(true, scopeID: scope)
    await requireConsentError(.invalidRequest) {
        _ = try await boundary.consentToRequest(scopeID: scope, requestID: UUID(), capability: .contacts, lifetime: .infinity)
    }
    let request = UUID()
    let token = try await boundary.consentToRequest(scopeID: scope, requestID: request, capability: .contacts, lifetime: 2)
    clock.advance(2)
    await require(.consentExpired) {
        try await boundary.perform(consent: token, scopeID: scope, requestID: request, capability: .contacts)
    }
    #expect(await backend.count() == 0)
}

@Test func expiryWhileProviderIsHeldDiscardsTheLateResult() async throws {
    let backend = ForegroundFixtureBackend(), clock = ForegroundFixtureClock(), boundary = makeBoundary(backend, clock: clock)
    await backend.configure(.success(.value(.contact(name: "private late name"))), held: true,
                            checkAuthorizationAfterWait: true)
    let issued = try await consent(boundary, lifetime: 2, clock: clock)
    let task = Task { try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts) }
    await backend.waitForCall()
    clock.advance(2)
    await backend.release()
    await require(.consentExpired) { try await task.value }
    #expect(await backend.count() == 1)
    #expect(await backend.effects() == 0)
}

@Test func expiryTimerCancelsTheInFlightProviderWithoutReleasingItsSlotEarly() async throws {
    let backend = ForegroundFixtureBackend()
    let boundary = IOSForegroundCapabilityBoundary(backend: backend, monotonicUptime: { ProcessInfo.processInfo.systemUptime })
    await backend.configure(.success(.value(.contact(name: "late"))), held: true, respectCancellation: true)
    let issued = try await consent(boundary, lifetime: 0.05)
    let task = Task { try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts) }
    await backend.waitForCall()
    try await Task.sleep(for: .milliseconds(120))
    let retryScope = UUID(), retryRequest = UUID()
    await boundary.setForegroundActive(true, scopeID: retryScope)
    let retryToken = try await boundary.consentToRequest(scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    await require(.busy) {
        try await boundary.perform(consent: retryToken, scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    }
    await backend.release()
    await require(.consentExpired) { try await task.value }
    await backend.configure(.success(.value(.contact(name: "fresh request"))))
    _ = try await boundary.perform(consent: retryToken, scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    #expect(await backend.count() == 2)
}

@Test func backgroundTransitionRevokesAndCancelsHeldWork() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "late"))), held: true,
                            checkAuthorizationAfterWait: true)
    let issued = try await consent(boundary)
    let task = Task { try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts) }
    await backend.waitForCall()
    await boundary.setForegroundActive(false, scopeID: issued.scope)
    await backend.release()
    await require(.inactive) { try await task.value }
    #expect(await backend.count() == 1)
    #expect(await backend.effects() == 0)
}

@Test func explicitRevocationBeforeAwaitDiscardsResult() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "late"))), held: true,
                            checkAuthorizationAfterWait: true)
    let issued = try await consent(boundary)
    let task = Task { try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts) }
    await backend.waitForCall()
    await boundary.revoke(scopeID: issued.scope)
    await backend.release()
    await require(.inactive) { try await task.value }
    #expect(await backend.effects() == 0)
}

@Test func changingTheRequestCancelsOldResultAndOldConsentCannotBeReused() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "late"))), held: true,
                            checkAuthorizationAfterWait: true)
    let scope = UUID(), oldRequest = UUID()
    await boundary.setForegroundActive(true, scopeID: scope)
    let oldToken = try await boundary.consentToRequest(scopeID: scope, requestID: oldRequest, capability: .contacts)
    let task = Task { try await boundary.perform(consent: oldToken, scopeID: scope, requestID: oldRequest, capability: .contacts) }
    await backend.waitForCall()
    let newRequest = UUID()
    let newToken = try await boundary.consentToRequest(scopeID: scope, requestID: newRequest, capability: .contacts)
    await require(.busy) {
        try await boundary.perform(consent: newToken, scopeID: scope, requestID: newRequest, capability: .contacts)
    }
    await backend.release()
    await require(.consentMissing) { try await task.value }
    #expect(await backend.effects() == 0)
    await backend.configure(.success(.value(.contact(name: "fresh request"))))
    _ = try await boundary.perform(consent: newToken, scopeID: scope, requestID: newRequest, capability: .contacts)
    #expect(await backend.count() == 2)
}

@Test func noncooperativeBackendRemainsInCustodyUntilItActuallyReturns() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "late"))), held: true)
    let first = try await consent(boundary)
    let task = Task { try await boundary.perform(consent: first.handle, scopeID: first.scope, requestID: first.request, capability: .contacts) }
    await backend.waitForCall()
    await boundary.setForegroundActive(false, scopeID: first.scope)
    let retryScope = UUID(), retryRequest = UUID()
    await boundary.setForegroundActive(true, scopeID: retryScope)
    let retryToken = try await boundary.consentToRequest(scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    await require(.busy) {
        try await boundary.perform(consent: retryToken, scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    }
    await backend.release()
    await require(.inactive) { try await task.value }
    #expect(await backend.count() == 1)
    #expect(await backend.effects() == 1)
    await backend.configure(.success(.value(.contact(name: "fresh request"))))
    _ = try await boundary.perform(consent: retryToken, scopeID: retryScope, requestID: retryRequest, capability: .contacts)
    #expect(await backend.count() == 2)
}

@Test func callerCancellationDoesNotRetryOrReturnLateData() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "late"))), held: true)
    let issued = try await consent(boundary)
    let task = Task { try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts) }
    await backend.waitForCall()
    task.cancel()
    await backend.release()
    do { _ = try await task.value; Issue.record("Cancelled request returned a result") }
    catch { #expect(error is CancellationError) }
    #expect(await backend.count() == 1)
}

@Test func mismatchedProviderOutputNeverWidensTheSelectedAction() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.file(name: "private.txt", bytes: Data("private".utf8)))))
    let issued = try await consent(boundary, capability: .contacts)
    await require(.resultRejected) {
        try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts)
    }
    #expect(await backend.count() == 1)
}

@Test func boundedOutputsRejectExcessRowsInvalidNamesCoordinatesAndPayloadSizes() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    let calendarBase = Date()
    let tenEvents = (0..<11).map { IOSCalendarEventSummary(title: "event-\($0)", start: calendarBase.addingTimeInterval(Double($0) * 60)) }
    await backend.configure(.success(.value(.calendar(tenEvents))))
    let calendar = try await consent(boundary, capability: .calendar)
    await require(.resultRejected) {
        try await boundary.perform(consent: calendar.handle, scopeID: calendar.scope, requestID: calendar.request, capability: .calendar)
    }

    await backend.configure(.success(.value(.calendar([
        IOSCalendarEventSummary(title: "outside", start: Date().addingTimeInterval(31 * 86_400)),
    ]))))
    let outsideCalendarWindow = try await consent(boundary, capability: .calendar)
    await require(.resultRejected) {
        try await boundary.perform(consent: outsideCalendarWindow.handle, scopeID: outsideCalendarWindow.scope,
                                   requestID: outsideCalendarWindow.request, capability: .calendar)
    }

    await backend.configure(.success(.value(.contact(name: " \n"))))
    let contact = try await consent(boundary, capability: .contacts)
    await require(.resultRejected) {
        try await boundary.perform(consent: contact.handle, scopeID: contact.scope, requestID: contact.request, capability: .contacts)
    }

    await backend.configure(.success(.value(.location(latitude: 91, longitude: 180))))
    let location = try await consent(boundary, capability: .location)
    await require(.resultRejected) {
        try await boundary.perform(consent: location.handle, scopeID: location.scope, requestID: location.request, capability: .location)
    }

    await backend.configure(.success(.value(.file(name: "../private.txt", bytes: Data([1])))))
    let file = try await consent(boundary, capability: .files)
    await require(.resultRejected) {
        try await boundary.perform(consent: file.handle, scopeID: file.scope, requestID: file.request, capability: .files)
    }

    await backend.configure(.success(.value(.file(name: "notes.txt", bytes: Data([0xFF, 0xFE, 0x00])))))
    let binaryFile = try await consent(boundary, capability: .files)
    await require(.resultRejected) {
        try await boundary.perform(consent: binaryFile.handle, scopeID: binaryFile.scope, requestID: binaryFile.request, capability: .files)
    }

    await backend.configure(.success(.value(.file(name: "large.txt", bytes: Data(repeating: 0x61,
                                                                                   count: IOSForegroundCapabilityBoundary.maximumFileBytes + 1)))))
    let oversizedFile = try await consent(boundary, capability: .files)
    await require(.resultRejected) {
        try await boundary.perform(consent: oversizedFile.handle, scopeID: oversizedFile.scope,
                                   requestID: oversizedFile.request, capability: .files)
    }

    await backend.configure(.success(.value(.photo(jpeg: Data([0xFF, 0xD8, 0x00, 0xFF, 0xD9])))))
    let malformedPhoto = try await consent(boundary, capability: .photos)
    await require(.resultRejected) {
        try await boundary.perform(consent: malformedPhoto.handle, scopeID: malformedPhoto.scope,
                                   requestID: malformedPhoto.request, capability: .photos)
    }

    await backend.configure(.success(.value(.photo(jpeg: Data(repeating: 0, count: IOSForegroundCapabilityBoundary.maximumImageBytes + 1)))))
    let photo = try await consent(boundary, capability: .photos)
    await require(.resultRejected) {
        try await boundary.perform(consent: photo.handle, scopeID: photo.scope, requestID: photo.request, capability: .photos)
    }

    await backend.configure(.success(.value(.microphone(pcm16Mono: Data([1, 2]), duration: 10.1, sampleRate: 48_000))))
    let microphone = try await consent(boundary, capability: .microphone)
    await require(.resultRejected) {
        try await boundary.perform(consent: microphone.handle, scopeID: microphone.scope, requestID: microphone.request, capability: .microphone)
    }
}

@Test func locationOutputIsRoundedToApproximatePrecisionAndCalendarSorted() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.location(latitude: 37.774912, longitude: -122.419413))))
    let location = try await consent(boundary, capability: .location)
    let locationResult = try await boundary.perform(consent: location.handle, scopeID: location.scope, requestID: location.request, capability: .location)
    guard case .location(let latitude, let longitude) = locationResult.localPresentation else {
        Issue.record("Expected approximate coordinates"); return
    }
    #expect(latitude == 37.77 || latitude == 37.78)
    #expect(longitude == -122.42)

    await backend.configure(.success(.value(.calendar([
        IOSCalendarEventSummary(title: "later", start: Date().addingTimeInterval(2_000)),
        IOSCalendarEventSummary(title: "sooner", start: Date().addingTimeInterval(1_000)),
    ]))))
    let calendar = try await consent(boundary, capability: .calendar)
    let calendarResult = try await boundary.perform(consent: calendar.handle, scopeID: calendar.scope, requestID: calendar.request, capability: .calendar)
    guard case .calendar(let events) = calendarResult.localPresentation else {
        Issue.record("Expected local event summaries"); return
    }
    #expect(events.map(\.title) == ["sooner", "later"])
}

@Test func validFilePhotoCameraAndAudioResultsStayWithinTheirTypedScopes() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)

    await backend.configure(.success(.value(.file(name: "notes.txt", bytes: Data("private note".utf8)))))
    let file = try await consent(boundary, capability: .files)
    let fileResult = try await boundary.perform(consent: file.handle, scopeID: file.scope, requestID: file.request, capability: .files)
    guard case .file(let name, let byteCount, let preview) = fileResult.localPresentation else {
        Issue.record("Expected local file result"); return
    }
    #expect(name == "notes.txt")
    #expect(byteCount == 12)
    #expect(preview == "private note")

    let jpeg = try syntheticJPEG()
    await backend.configure(.success(.value(.photo(jpeg: jpeg))))
    let photo = try await consent(boundary, capability: .photos)
    let photoResult = try await boundary.perform(consent: photo.handle, scopeID: photo.scope, requestID: photo.request, capability: .photos)
    guard case .photo(let selectedJPEG) = photoResult.localPresentation else {
        Issue.record("Expected selected photo"); return
    }
    #expect(selectedJPEG == jpeg)

    await backend.configure(.success(.value(.cameraImage(jpeg: jpeg))))
    let camera = try await consent(boundary, capability: .camera)
    let cameraResult = try await boundary.perform(consent: camera.handle, scopeID: camera.scope, requestID: camera.request, capability: .camera)
    guard case .cameraImage(let capturedJPEG) = cameraResult.localPresentation else {
        Issue.record("Expected one captured image"); return
    }
    #expect(capturedJPEG == jpeg)

    let audio = Data(repeating: 1, count: 48_000)
    await backend.configure(.success(.value(.microphone(pcm16Mono: audio, duration: 0.5, sampleRate: 48_000))))
    let microphone = try await consent(boundary, capability: .microphone)
    let audioResult = try await boundary.perform(consent: microphone.handle, scopeID: microphone.scope, requestID: microphone.request, capability: .microphone)
    guard case .microphone(let duration, let rate) = audioResult.localPresentation else {
        Issue.record("Expected in-memory audio result"); return
    }
    #expect(duration == 0.5)
    #expect(rate == 48_000)
}

@Test func emptyDeniedOfflineAndBackendFailureStayDistinct() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.empty))
    let empty = try await consent(boundary)
    await require(.empty) {
        try await boundary.perform(consent: empty.handle, scopeID: empty.scope, requestID: empty.request, capability: .contacts)
    }
    for error: IOSForegroundCapabilityError in [.permissionDenied, .offline, .backendUnavailable] {
        await backend.configure(.failure(error))
        let issued = try await consent(boundary)
        await require(error) {
            try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts)
        }
    }
}

@Test func resultDescriptionDebugAndReflectionRedactPrivateValues() async throws {
    let backend = ForegroundFixtureBackend(), boundary = makeBoundary(backend)
    await backend.configure(.success(.value(.contact(name: "SENSITIVE-CONTACT-NAME"))))
    let issued = try await consent(boundary)
    let result = try await boundary.perform(consent: issued.handle, scopeID: issued.scope, requestID: issued.request, capability: .contacts)
    var dumpText = ""
    dump(result, to: &dumpText)
    let diagnostics = [String(describing: result), String(reflecting: result), dumpText,
                       String(describing: result.localPresentation), String(reflecting: result.localPresentation)]
    #expect(diagnostics.allSatisfy { !$0.contains("SENSITIVE-CONTACT-NAME") })
    #expect(diagnostics.joined(separator: " ").contains("redacted"))
    guard case .contact(let localName) = result.localPresentation else { Issue.record("Expected contact presentation"); return }
    #expect(localName == "SENSITIVE-CONTACT-NAME")
}

@Test func catalogReportsOnlyLocalProofAndLeavesPhysicalDevicePending() throws {
    #expect(IOSNativeCapabilityCatalog.all.map(\.id).count == 7)
    #expect(IOSNativeCapabilityCatalog.all.allSatisfy { $0.state == .nativeCompiledFixturesProvedPhysicalPending })
    #expect(IOSNativeCapabilityCatalog.all.allSatisfy { $0.lifecycle == .foregroundOnly && $0.backgroundDelivery == .unavailable })
}

@Test func calendarProviderPolicyDropsOverlapsBeforeSortAndTenRowLimit() {
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let end = start.addingTimeInterval(30 * 86_400)
    var candidates = [
        IOSCalendarEventCandidate(title: "in-progress", start: start.addingTimeInterval(-3_600)),
        IOSCalendarEventCandidate(title: "all-day-began-before-window", start: start.addingTimeInterval(-86_400)),
        IOSCalendarEventCandidate(title: "before-window", start: start.addingTimeInterval(-1)),
        IOSCalendarEventCandidate(title: "at-window-start", start: start),
        IOSCalendarEventCandidate(title: "at-window-end", start: end),
        IOSCalendarEventCandidate(title: "after-window", start: end.addingTimeInterval(1)),
        IOSCalendarEventCandidate(title: "blank", start: start.addingTimeInterval(20)),
    ]
    candidates[6] = IOSCalendarEventCandidate(title: "  \n", start: candidates[6].start)
    for index in (0..<12).reversed() {
        candidates.append(IOSCalendarEventCandidate(title: "future-\(index)",
                                                    start: start.addingTimeInterval(Double(index + 1) * 3_600)))
    }

    let rows = IOSCalendarEventWindowPolicy.summaries(from: candidates, start: start, end: end)
    #expect(rows.count == 10)
    #expect(rows.first?.title == "at-window-start")
    #expect(rows.last?.title == "future-8")
    #expect(rows.allSatisfy { $0.title != "in-progress" && $0.title != "all-day-began-before-window" })
    #expect(rows.map(\.start) == rows.map(\.start).sorted())
    #expect(String(reflecting: rows).contains("redacted"))
}

@Test func selectedPhotoTemporaryFileIsConsumedInsideItsCallbackAndSourceIsBounded() throws {
    let source = try syntheticJPEG(width: 4_096, height: 8)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let temporaryURL = directory.appendingPathComponent("provider-temporary.jpg")
    try source.write(to: temporaryURL)

    var selectedJPEG: Data?
    func providerCallback(_ url: URL) throws {
        defer { try? FileManager.default.removeItem(at: url) }
        selectedJPEG = try IOSForegroundPhotoFileProcessor.jpegFromTemporaryFile(at: url)
    }
    try providerCallback(temporaryURL)

    #expect(!FileManager.default.fileExists(atPath: temporaryURL.path))
    guard let selectedJPEG,
          let imageSource = CGImageSourceCreateWithData(selectedJPEG as CFData, nil),
          let outputImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
        Issue.record("The photo callback did not consume and downsample the temporary source")
        return
    }
    #expect(outputImage.width == 2_048)
    #expect(outputImage.height <= 2_048)
    #expect(selectedJPEG.count <= IOSForegroundCapabilityBoundary.maximumImageBytes)

    let oversized = Data(repeating: 0x41, count: IOSForegroundPhotoFileProcessor.maximumSourceBytes + 1)
    do {
        _ = try IOSForegroundPhotoFileProcessor.jpeg(fromBoundedSource: oversized)
        Issue.record("An over-limit source reached image decoding")
    } catch let error as IOSForegroundCapabilityError {
        #expect(error == .resultRejected)
    } catch {
        Issue.record("Unexpected photo source rejection: \(type(of: error))")
    }
}

@Test func assetLoadDrainHoldsThePhotoOperationUntilCallbackCompletion() async {
    let drain = IOSForegroundCallbackDrain()
    await drain.begin()
    let callbackWaiter = Task { await drain.waitForDrain(); return true }
    await drain.waitUntilDrainWaiterRegistered()
    #expect(await drain.activeCallbackCount == 1)
    await drain.end()
    #expect(await callbackWaiter.value)
    #expect(await drain.activeCallbackCount == 0)
}

@Test func cameraPixelPolicyUsesPointBoundsAsPixelsAtAllImageScales() {
    let oneX = IOSForegroundImagePixelPolicy.outputSize(pointWidth: 4_032, pointHeight: 3_024)
    let twoX = IOSForegroundImagePixelPolicy.outputSize(pointWidth: 2_016, pointHeight: 1_512)
    let threeX = IOSForegroundImagePixelPolicy.outputSize(pointWidth: 1_344, pointHeight: 1_008)
    #expect(oneX == IOSForegroundImagePixelSize(width: 2_048, height: 1_536))
    #expect(twoX == IOSForegroundImagePixelSize(width: 2_016, height: 1_512))
    #expect(threeX == IOSForegroundImagePixelSize(width: 1_344, height: 1_008))
    #expect([oneX, twoX, threeX].allSatisfy { ($0?.width ?? 2_049) <= 2_048 && ($0?.height ?? 2_049) <= 2_048 })
    #expect(IOSForegroundImagePixelPolicy.outputSize(pointWidth: .infinity, pointHeight: 1) == nil)
}

@Test func microphoneSamplePolicyCapsTenSecondsAtActualStoredRateAndByteLimit() {
    for rate in [16_000.0, 44_100.0, 48_000.0] {
        guard let samples = IOSForegroundAudioSamplePolicy.maximumSamples(storedSampleRate: rate) else {
            Issue.record("A valid microphone sample rate was rejected")
            continue
        }
        let bytes = samples * MemoryLayout<Int16>.size
        let duration = Double(samples) / rate
        #expect(duration <= IOSForegroundCapabilityBoundary.maximumAudioDuration)
        #expect(bytes <= IOSForegroundCapabilityBoundary.maximumAudioBytes)
        #expect(Double(samples + 1) / rate > IOSForegroundCapabilityBoundary.maximumAudioDuration)
    }
    #expect(IOSForegroundAudioSamplePolicy.maximumSamples(storedSampleRate: 7_999) == nil)
    #expect(IOSForegroundAudioSamplePolicy.maximumSamples(storedSampleRate: .nan) == nil)
}

@Test func packageScopeDisclosureResolvesFromTheModuleBundleInBothLocales() {
    let keys = ["capability.scope.calendar", "capability.scope.contacts", "capability.scope.location",
                "capability.scope.files", "capability.scope.photos", "capability.scope.camera",
                "capability.scope.microphone"]
    for key in keys {
        guard let english = localizationFromPackage(key, language: "en"),
              let portuguese = localizationFromPackage(key, language: "pt-BR") else {
            Issue.record("The Swift package localization bundles could not be resolved")
            return
        }
        #expect(english != key)
        #expect(portuguese != key)
        #expect(english != "__missing__")
        #expect(portuguese != "__missing__")
        #expect(english != portuguese)
    }
}

@Test @MainActor func permissionPromptInactivityReturnsToASeparateExplicitOperationTap() async throws {
    let backend = ForegroundFixtureBackend()
    let permissionBackend = ForegroundPermissionFixture()
    permissionBackend.configure(held: true)
    let flow = IOSForegroundCapabilityFlowController(boundary: makeBoundary(backend),
                                                      permissionBackend: permissionBackend,
                                                      initialCapability: .calendar)
    await flow.viewAppeared(in: .active)
    #expect(flow.needsPermissionPreparation)
    #expect(permissionBackend.calls.isEmpty)
    #expect(await backend.count() == 0)

    let setupTask = Task { @MainActor in try await flow.humanTapped() }
    await permissionBackend.waitForCall()
    #expect(permissionBackend.calls == [.calendar])
    #expect(await backend.count() == 0)

    await flow.sceneDidChange(to: .inactive)
    permissionBackend.release()
    let setupOutcome = try await setupTask.value
    guard case .permissionPrepared = setupOutcome else {
        Issue.record("Permission setup unexpectedly started a data operation")
        return
    }
    #expect(flow.status == .permissionPreparedAwaitingActive)
    #expect(flow.result == nil)
    #expect(await backend.count() == 0)

    await flow.sceneDidChange(to: .active)
    #expect(flow.status == .permissionPrepared)
    #expect(await backend.count() == 0)
    await backend.configure(.success(.value(.calendar([
        IOSCalendarEventSummary(title: "synthetic event", start: Date().addingTimeInterval(60)),
    ]))))
    let operationOutcome = try await flow.humanTapped()
    guard case .result(let result) = operationOutcome,
          case .calendar(let events) = result.localPresentation else {
        Issue.record("The fresh explicit tap did not return the synthetic local result")
        return
    }
    #expect(events.map(\.title) == ["synthetic event"])
    #expect(await backend.count() == 1)
}

@Test @MainActor func deniedPermissionPreparationNeverCallsTheCapabilityProvider() async {
    let backend = ForegroundFixtureBackend()
    let permissionBackend = ForegroundPermissionFixture()
    permissionBackend.configure(failure: .permissionDenied)
    let flow = IOSForegroundCapabilityFlowController(boundary: makeBoundary(backend),
                                                      permissionBackend: permissionBackend,
                                                      initialCapability: .microphone)
    await flow.viewAppeared(in: .active)
    do {
        _ = try await flow.humanTapped()
        Issue.record("Denied permission setup started or passed the capability action")
    } catch let error as IOSForegroundCapabilityError {
        #expect(error == .permissionDenied)
    } catch {
        Issue.record("Unexpected permission preparation error")
    }
    #expect(flow.status == .permissionDenied)
    #expect(permissionBackend.calls == [.microphone])
    #expect(await backend.count() == 0)
    #expect(flow.result == nil)
}

@Test @MainActor func permissionPreparationInvalidatedByBackgroundOrScopeChangeCannotArmAnOperation() async throws {
    let backend = ForegroundFixtureBackend()
    let permissionBackend = ForegroundPermissionFixture()
    permissionBackend.configure(held: true)
    let flow = IOSForegroundCapabilityFlowController(boundary: makeBoundary(backend),
                                                      permissionBackend: permissionBackend,
                                                      initialCapability: .calendar)
    await flow.viewAppeared(in: .active)

    let setupTask = Task { @MainActor in try await flow.humanTapped() }
    await permissionBackend.waitForCall()
    await flow.sceneDidChange(to: .background)
    #expect(flow.isBusy)
    permissionBackend.release()
    do {
        _ = try await setupTask.value
        Issue.record("A backgrounded permission setup was kept as ready")
    } catch {
        #expect(flow.permissionIsPreparedForSelection == false)
    }
    #expect(flow.result == nil)
    #expect(await backend.count() == 0)

    await flow.sceneDidChange(to: .active)
    permissionBackend.configure(held: true)
    let changedTask = Task { @MainActor in try await flow.humanTapped() }
    await permissionBackend.waitForCall(2)
    await flow.select(.photos)
    #expect(flow.isBusy)
    permissionBackend.release()
    do {
        _ = try await changedTask.value
        Issue.record("A permission setup for the old scope was kept after selection changed")
    } catch {
        #expect(flow.selectedCapability == .photos)
        #expect(flow.permissionIsPreparedForSelection == false)
    }
    #expect(flow.result == nil)
    #expect(await backend.count() == 0)

    await flow.select(.camera)
    permissionBackend.configure(held: true)
    let leavingTask = Task { @MainActor in try await flow.humanTapped() }
    await permissionBackend.waitForCall(3)
    await flow.viewDisappeared()
    #expect(flow.isBusy)
    permissionBackend.release()
    do {
        _ = try await leavingTask.value
        Issue.record("Leaving the view retained permission setup for a later operation")
    } catch {
        #expect(flow.permissionIsPreparedForSelection == false)
        #expect(flow.result == nil)
    }
    #expect(await backend.count() == 0)
}

@Test @MainActor func noncooperativeLateProviderCallbackStaysInCustodyAndCannotReleaseAResult() async throws {
    let backend = ForegroundFixtureBackend()
    let permissionBackend = ForegroundPermissionFixture()
    let boundary = makeBoundary(backend)
    let flow = IOSForegroundCapabilityFlowController(boundary: boundary,
                                                      permissionBackend: permissionBackend,
                                                      initialCapability: .contacts)
    await backend.configure(.success(.value(.contact(name: "late synthetic contact"))), held: true,
                            checkAuthorizationAfterWait: true)
    await flow.viewAppeared(in: .active)
    let first = Task { @MainActor in try await flow.humanTapped() }
    await backend.waitForCall()
    await flow.sceneDidChange(to: .background)
    first.cancel()
    await flow.sceneDidChange(to: .active)

    do {
        _ = try await flow.humanTapped()
        Issue.record("A second flow request bypassed the held provider")
    } catch let error as IOSForegroundCapabilityError {
        #expect(error == .busy)
    }
    #expect(await backend.count() == 1)
    #expect(flow.result == nil)

    await backend.release()
    do {
        _ = try await first.value
        Issue.record("A cancelled noncooperative provider returned its late result")
    } catch {
        #expect(flow.result == nil)
    }
    #expect(await backend.effects() == 0)
    #expect(flow.isBusy == false)

    await backend.configure(.success(.value(.contact(name: "fresh synthetic contact"))))
    let fresh = try await flow.humanTapped()
    guard case .result(let result) = fresh,
          case .contact(let name) = result.localPresentation else {
        Issue.record("A new explicit tap did not return after the old provider actually drained")
        return
    }
    #expect(name == "fresh synthetic contact")
    #expect(await backend.count() == 2)
}
