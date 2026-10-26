import Foundation
import CryptoKit
import XCTest
import DexterHostClient
@testable import DexterAppCore

// Owner-local Mac decisions include an atomic preference receipt. The paired/iOS
// path retains the exact action decision contract without owner-local preferences.
private var continuationDecisionPath: String {
    #if os(macOS)
    "/v1/actions/action-a/decision-preference"
    #else
    "/v1/actions/action-a/decisions"
    #endif
}

@MainActor
final class ChatContinuationObservationTests: XCTestCase {
    func testApprovedLateHostTurnStreamsThenShowsPersistedAnswerWithoutAnotherSend() async throws {
        let transport = ContinuationReadTransport()
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        let proposed = try XCTUnwrap(model.actions.first)
        XCTAssertEqual(model.currentTurn?.state, .completed)
        XCTAssertEqual(model.messages.map(\.content), ["synthetic original request"])
        await model.decide(proposed, as: .allow)
        XCTAssertNil(model.errorMessage, "The canonical decision receipt must be accepted")
        await assertEventually { await transport.progressReads() >= 2 }
        XCTAssertFalse(model.messages.contains { $0.role == .assistant })
        let globalReadsBeforeContinuation = await transport.recorded().filter { $0.path == "/v1/actions" || $0.path == "/v1/events" }.count
        // The host publishes a different response turn AFTER both the origin and post-Allow load.
        await transport.publishResponseWithNewProposal()
        let streamed = await eventually { model.currentTurn?.id == "response-a" && model.streamingText == "synthetic host answer" }
        XCTAssertTrue(streamed)
        XCTAssertTrue(model.botActivityObservationAvailable, "Only the exact canonical observer drives the activity badge")
        await assertEventually { model.actions.contains { $0.id == "action-extra" && $0.state == .awaitingApproval } }
        await transport.completeResponse()
        let finished = await eventually { model.messages.contains { $0.id == "answer-a" } && !model.isObservingConversation }
        XCTAssertTrue(finished)
        XCTAssertFalse(model.botActivityObservationAvailable, "Terminal observation cannot leave a running animation")
        XCTAssertEqual(model.currentTurn?.state, .completed)
        XCTAssertEqual(model.streamingText, "")
        XCTAssertEqual(model.messages.map(\.content), ["synthetic original request", "synthetic host answer"])
        XCTAssertEqual(model.actions.first?.state, .succeeded)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.path == "/v1/actions" || $0.path == "/v1/events" }.count, globalReadsBeforeContinuation,
                       "Continuation streaming discovers new proposals from turn events, never a global scan")
        XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), [continuationDecisionPath])
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(requests.filter { $0.path == "/v1/turns/response-a/events" }.first?.after, "0")
        XCTAssertFalse(requests.contains { $0.path.contains("resume") || $0.path.contains("dispatch") || $0.path.contains("grant") })
    }

    func testDenialTimeoutAndUnknownReadHostReceiptWithoutExecutionOrResend() async throws {
        for state in ["denied", "blocked", "unknown"] {
            let transport = ContinuationReadTransport()
            if state != "denied" { await transport.terminalReceipt(state) }
            let model = try await presentedModel(transport)
            if state == "denied" {
                await model.decide(try XCTUnwrap(model.actions.first), as: .deny)
                XCTAssertNil(model.errorMessage, "Denial must accept the host's atomic receipt")
                XCTAssertEqual(model.actions.first?.state, .denied)
            }
            await transport.publishResponse(state: "completed")
            let settled = await eventually { !model.isObservingConversation && model.messages.contains { $0.id == "answer-a" } }
            XCTAssertTrue(settled, state)
            XCTAssertEqual(model.actions.first?.state.rawValue, state)
            guard case .object(let receipt) = model.actions.first?.result else { return XCTFail("Missing host receipt") }
            XCTAssertEqual(receipt["termination"], JSONValue.string("timeout"))
            let requests = await transport.recorded()
            XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), state == "denied" ? [continuationDecisionPath] : [], state)
            model.closeThreadPresentation()
        }
    }

    func testKnownOriginPollHandsOffToLateHostContinuationAfterItTerminates() async throws {
        let transport = ContinuationReadTransport()
        await transport.setOriginState("running")
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await model.decide(try XCTUnwrap(model.actions.first), as: .allow)
        await transport.setOriginState("completed")
        await assertEventually {
            let reads = await transport.progressReads()
            return model.currentTurn?.id == "origin-a" && model.currentTurn?.state == .completed && reads > 0
        }
        XCTAssertTrue(model.isObservingConversation, "The finished origin must not detach the pending receipt")
        await transport.publishResponse(state: "completed")
        await assertEventually { model.currentTurn?.id == "response-a" && model.messages.last?.id == "answer-a" && !model.isObservingConversation }
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), [continuationDecisionPath])
    }

    func testReloadStartedBeforeNewHostTurnCannotReplaceItsNewerProjection() async throws {
        let transport = ContinuationReadTransport()
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await transport.hold("/v1/threads/thread-a/turns")
        let generation = model.threadPresentationGeneration
        let reload = Task { await model.loadPresentedThread("thread-a", generation: generation) }
        await assertEventually { await transport.isHeld("/v1/threads/thread-a/turns") }
        await transport.publishResponse(state: "completed")
        await assertEventually { model.currentTurn?.id == "response-a" && model.messages.last?.id == "answer-a" }
        await transport.release("/v1/threads/thread-a/turns")
        await reload.value
        XCTAssertEqual(model.currentTurn?.id, "response-a")
        XCTAssertEqual(model.currentTurn?.state, .completed)
        await assertEventually { !model.isObservingConversation }
        await assertOnlyGETs(transport)
    }

    func testConcurrentReloadAndInflightDecisionShareOneReadObserver() async throws {
        let transport = ContinuationReadTransport()
        await transport.hold("/v1/actions/action-a/continuation")
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await assertEventually { await transport.isHeld("/v1/actions/action-a/continuation") }
        await transport.hold(continuationDecisionPath)
        let proposed = try XCTUnwrap(model.actions.first)
        let decision = Task { await model.decide(proposed, as: .allow) }
        await assertEventually { await transport.isHeld(continuationDecisionPath) }
        let generation = model.threadPresentationGeneration
        async let first: Void = model.loadPresentedThread("thread-a", generation: generation)
        async let second: Void = model.loadPresentedThread("thread-a", generation: generation)
        _ = await (first, second)
        let progressReadCount = await transport.progressReads()
        XCTAssertEqual(progressReadCount, 1)
        XCTAssertTrue(model.isObservingConversation)
        XCTAssertFalse(model.botActivityObservationAvailable, "A completed origin waiting on a held decision is not running activity")
        await transport.release(continuationDecisionPath)
        await decision.value
        XCTAssertNil(model.errorMessage, "The held atomic decision must complete successfully")
        await transport.release("/v1/actions/action-a/continuation")
        await transport.publishResponse(state: "completed")
        await assertEventually { !model.isObservingConversation }
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }

    func testCloseAndReopenReadsDurableResponseWithoutAnyMutation() async throws {
        let transport = ContinuationReadTransport()
        let model = try await presentedModel(transport)
        model.closeThreadPresentation()
        let closedCount = await transport.recorded().count
        try await Task.sleep(for: .milliseconds(80))
        let afterCloseCount = await transport.recorded().count
        XCTAssertEqual(afterCloseCount, closedCount)
        await transport.terminalReceipt("unknown")
        await transport.publishResponse(state: "completed")
        let generation = try XCTUnwrap(model.presentThread("thread-a", for: "bot-a"))
        await model.loadPresentedThread("thread-a", generation: generation)
        XCTAssertEqual(model.messages.last?.id, "answer-a")
        await assertEventually { !model.isObservingConversation }
        await assertOnlyGETs(transport)
        model.closeThreadPresentation()
    }

    func testOfflineReconnectContinuesReadOnlyWithinRetryBudget() async throws {
        let transport = ContinuationReadTransport()
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await transport.setOffline(true)
        await assertEventually { !model.isOnline }
        await transport.publishResponse(state: "completed")
        await transport.setOffline(false)
        await assertEventually { model.isOnline && model.messages.last?.id == "answer-a" && !model.isObservingConversation }
        XCTAssertNil(model.errorMessage, "Successful receipt reads clear only the observer's own offline notice")
        await assertOnlyGETs(transport)
        model.closeThreadPresentation()
        let unavailable = ContinuationReadTransport()
        let bounded = try await presentedModel(unavailable)
        await unavailable.setOffline(true)
        await assertEventually { !bounded.isObservingConversation && !bounded.isOnline }
        let stoppedCount = await unavailable.recorded().count
        try await Task.sleep(for: .milliseconds(100))
        let quietCount = await unavailable.recorded().count
        XCTAssertEqual(quietCount, stoppedCount)
        await assertOnlyGETs(unavailable)
        bounded.closeThreadPresentation()
    }

    func testLateResponseCannotCrossThreadPresentationOrAddress() async throws {
        for changeAddress in [false, true] {
            let transport = ContinuationReadTransport()
            await transport.publishResponse(state: "completed")
            await transport.hold("/v1/threads/thread-a/messages")
            let model = try await loadedModel(transport)
            let generation = try XCTUnwrap(model.presentThread("thread-a", for: "bot-a"))
            let loading = Task { await model.loadPresentedThread("thread-a", generation: generation) }
            await assertEventually { await transport.isHeld("/v1/threads/thread-a/messages") }
            if changeAddress { model.hostAddress = "http://127.0.0.1:49192" }
            else {
                let next = try XCTUnwrap(model.presentThread("thread-b", for: "bot-a"))
                await model.loadPresentedThread("thread-b", generation: next)
            }
            await transport.release("/v1/threads/thread-a/messages")
            await loading.value
            XCTAssertFalse(model.messages.contains { $0.threadId == "thread-a" })
            XCTAssertNotEqual(model.currentTurn?.id, "response-a")
            XCTAssertFalse(model.isObservingConversation)
            await assertOnlyGETs(transport)
            model.closeThreadPresentation()
        }
    }

    func testLateObserverReceiptIsDiscardedOnScopeChangeAndExplicitTeardown() async throws {
        for closeOnly in [false, true] {
            let transport = ContinuationReadTransport()
            await transport.hold("/v1/actions/action-a/continuation")
            let model = try await presentedModel(transport)
            await assertEventually { await transport.isHeld("/v1/actions/action-a/continuation") }
            if closeOnly { model.stopPolling() }
            else {
                let next = try XCTUnwrap(model.presentThread("thread-b", for: "bot-a"))
                await model.loadPresentedThread("thread-b", generation: next)
            }
            let beforeRelease = await transport.recorded().count
            await transport.release("/v1/actions/action-a/continuation")
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertFalse(model.isObservingConversation)
            let afterReleaseCount = await transport.recorded().count
            XCTAssertEqual(afterReleaseCount, beforeRelease)
            XCTAssertFalse(model.messages.contains { $0.id == "answer-a" })
            XCTAssertEqual(model.streamingText, "")
            model.closeThreadPresentation()
        }
    }

    func testChangedHostIdentityFailsClosedAndIdleOrDeadlineStopsReading() async throws {
        let transport = ContinuationReadTransport()
        let model = try await presentedModel(transport)
        await transport.changeIdentity()
        await assertEventually { !model.isObservingConversation && !model.isOnline }
        XCTAssertFalse(model.botActivityObservationAvailable)
        XCTAssertFalse(model.messages.contains { $0.id == "answer-a" })
        model.closeThreadPresentation()

        let boundedTransport = ContinuationReadTransport()
        let bounded = try await loadedModel(boundedTransport)
        bounded.conversationObservationLifetime = .milliseconds(90)
        let generation = try XCTUnwrap(bounded.presentThread("thread-a", for: "bot-a"))
        await bounded.loadPresentedThread("thread-a", generation: generation)
        await assertEventually { !bounded.isObservingConversation }
        XCTAssertFalse(bounded.botActivityObservationAvailable, "Deadline stops activity even when a running snapshot is retained")
        XCTAssertTrue(bounded.errorMessage?.contains("limite de tempo") == true)
        let count = await boundedTransport.recorded().count
        try await Task.sleep(for: .milliseconds(100))
        let afterDeadlineCount = await boundedTransport.recorded().count
        XCTAssertEqual(afterDeadlineCount, count)
        await assertOnlyGETs(boundedTransport)
        let idleGeneration = try XCTUnwrap(bounded.presentThread("thread-b", for: "bot-a"))
        await bounded.loadPresentedThread("thread-b", generation: idleGeneration)
        XCTAssertFalse(bounded.isObservingConversation)
        let idleCount = await boundedTransport.recorded().count
        try await Task.sleep(for: .milliseconds(100))
        let afterIdleCount = await boundedTransport.recorded().count
        XCTAssertEqual(afterIdleCount, idleCount)
        bounded.closeThreadPresentation()
    }

    func testInterruptDetachesObserverAndDiscardsHeldLateStreamWithoutRestart() async throws {
        let transport = ContinuationReadTransport()
        await transport.publishResponse(state: "running")
        await transport.hold("/v1/turns/response-a/events")
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await assertEventually { await transport.isHeld("/v1/turns/response-a/events") }
        await model.cancelCurrentTurn(in: "thread-a")
        XCTAssertEqual(model.currentTurn?.state, .interrupted)
        XCTAssertFalse(model.isObservingConversation)
        let stoppedCount = await transport.recorded().count
        await transport.release("/v1/turns/response-a/events")
        try await Task.sleep(for: .milliseconds(80))
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, stoppedCount)
        XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), ["/v1/turns/response-a/cancel"])
        XCTAssertEqual(model.streamingText, "")
        XCTAssertFalse(model.messages.contains { $0.id == "answer-a" })
    }

    private func loadedModel(_ transport: ContinuationReadTransport) async throws -> DexterAppModel {
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49191")!, transport: transport), storage: try ContinuationMemory())
        model.continuationObservationInterval = .milliseconds(30)
        model.conversationObservationLifetime = .seconds(4)
        await model.refresh()
        let readPaths = await transport.recorded().map(\.path)
        XCTAssertTrue(model.isOnline, "\(model.errorMessage ?? "nil"); reads=\(readPaths)")
        XCTAssertEqual(model.selectedBotID, "bot-a")
        return model
    }

    func testR3CancelObserverDiscoveredContinuationOnceAndRejectStaleRenderedIdentity() async throws {
        let transport = ContinuationReadTransport(), model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        await transport.publishResponse(state: "running") // genuinely discovered by observer after origin completion
        await assertEventually { model.currentTurn?.id == "response-a" && model.currentTurn?.state == .running }
        let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
        await transport.hold("/v1/turns/response-a/cancel")
        let cancel = Task { await model.cancelTurn(identity) }
        await assertEventually { await transport.isHeld("/v1/turns/response-a/cancel") }
        await model.cancelTurn(identity)
        XCTAssertFalse(model.isObservingConversation)
        XCTAssertTrue(model.conversationObservationWasStopped)
        await transport.release("/v1/turns/response-a/cancel"); await cancel.value
        XCTAssertEqual(model.currentTurn?.state, .interrupted)
        let next = try XCTUnwrap(model.presentThread("thread-b", for: "bot-a"))
        await model.loadPresentedThread("thread-b", generation: next)
        await model.cancelTurn(identity)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), ["/v1/turns/response-a/cancel"])
        XCTAssertNil(model.currentTurn)
    }

    func testR3OfflineOrRejectedCancelNeverFabricatesInterruptionOrResurrectsApproval() async throws {
        for offline in [true, false] {
            let transport = ContinuationReadTransport(), model = try await presentedModel(transport)
            await transport.publishResponse(state: "running")
            await assertEventually { model.currentTurn?.id == "response-a" }
            let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
            if offline { await transport.setOffline(true); await assertEventually { !model.isOnline } }
            else { await transport.rejectCancel() }
            await model.cancelTurn(identity)
            XCTAssertEqual(model.currentTurn?.state, .running)
            XCTAssertFalse(model.isObservingConversation)
            XCTAssertFalse(model.isTurnGenerating)
            XCTAssertTrue(model.turnControlNotice?.contains("não foi confirmado") == true)
            await model.decide(try XCTUnwrap(model.actions.first), as: .allow)
            await transport.publishResponseWithNewProposal()
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertFalse(model.actions.contains { $0.id == "action-extra" })
            let requests = await transport.recorded()
            XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), offline ? [] : ["/v1/turns/response-a/cancel"])
            model.closeThreadPresentation()
        }
    }

    func testR3HeldReceiptResumeIsHumanSinglePOSTAndReopenOnlyReads() async throws {
        let transport = ContinuationReadTransport()
        await transport.publishResponse(state: "queued")
        let model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        XCTAssertEqual(model.currentTurn?.state, .queued)
        XCTAssertTrue(model.queuedReceiptResponseTurnIDs.contains("response-a"))
        let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
        await transport.hold("/v1/threads/thread-a/resume-queued")
        let resume = Task { await model.resumeQueuedTurns(identity) }
        await assertEventually { await transport.isHeld("/v1/threads/thread-a/resume-queued") }
        await model.resumeQueuedTurns(identity)
        await transport.release("/v1/threads/thread-a/resume-queued"); await resume.value
        XCTAssertEqual(model.messages.last?.id, "answer-a")
        XCTAssertEqual(model.currentTurn?.state, .completed)
        model.closeThreadPresentation()
        let generation = try XCTUnwrap(model.presentThread("thread-a", for: "bot-a"))
        await model.loadPresentedThread("thread-a", generation: generation)
        let requests = await transport.recorded()
        XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), ["/v1/threads/thread-a/resume-queued"])
    }

    func testR3QueuedResumeConflictAndScopeSwitchHaveNoFallbackSendOrLateProjection() async throws {
        for conflict in [true, false] {
            let transport = ContinuationReadTransport()
            await transport.publishResponse(state: "queued")
            let model = try await presentedModel(transport)
            let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
            if conflict {
                await transport.rejectResume()
                await model.resumeQueuedTurns(identity)
                XCTAssertEqual(model.currentTurn?.state, .queued)
                XCTAssertTrue(model.turnControlNotice?.contains("não foi confirmada") == true)
                await model.resumeQueuedTurns(identity) // requires a canonical reload before another human attempt
            } else {
                await transport.hold("/v1/threads/thread-a/resume-queued")
                let resume = Task { await model.resumeQueuedTurns(identity) }
                await assertEventually { await transport.isHeld("/v1/threads/thread-a/resume-queued") }
                let next = try XCTUnwrap(model.presentThread("thread-b", for: "bot-a"))
                await model.loadPresentedThread("thread-b", generation: next)
                await transport.release("/v1/threads/thread-a/resume-queued"); await resume.value
                XCTAssertNil(model.currentTurn); XCTAssertTrue(model.messages.isEmpty)
                await model.resumeQueuedTurns(identity)
            }
            let requests = await transport.recorded()
            XCTAssertEqual(requests.filter { $0.method != "GET" }.map(\.path), ["/v1/threads/thread-a/resume-queued"])
            model.closeThreadPresentation()
        }
    }

    func testR3TurnControlsRejectChangedHostAndDelayedReadCrossingBase() async throws {
        for queued in [false, true] {
            let transport = ContinuationReadTransport(), model = try await presentedModel(transport)
            await transport.publishResponse(state: queued ? "queued" : "running")
            await assertEventually { model.currentTurn?.id == "response-a" }
            let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
            model.stopPolling()
            await transport.changeIdentity()
            if queued { await model.resumeQueuedTurns(identity) } else { await model.cancelTurn(identity) }
            let requests = await transport.recorded(); XCTAssertTrue(requests.allSatisfy { $0.method == "GET" })
            XCTAssertEqual(model.currentTurn?.id, "response-a")
            model.closeThreadPresentation()
        }
        let transport = ContinuationReadTransport()
        await transport.publishResponse(state: "queued")
        let model = try await presentedModel(transport)
        let identity = try XCTUnwrap(model.turnControlIdentity(in: "thread-a"))
        model.stopPolling(); await transport.hold("/v1/turns/response-a")
        let resume = Task { await model.resumeQueuedTurns(identity) }
        await assertEventually { await transport.isHeld("/v1/turns/response-a") }
        model.hostAddress = "http://127.0.0.1:49218"
        await transport.release("/v1/turns/response-a"); await resume.value
        let requests = await transport.recorded(); XCTAssertTrue(requests.allSatisfy { $0.method == "GET" })
        XCTAssertFalse(model.isObservingConversation)
        model.closeThreadPresentation()
    }

    func testR3LocalDecisionTraceIsBoundedAndContainsOnlyIdentityMetadata() async throws {
        let transport = ContinuationReadTransport(), model = try await presentedModel(transport)
        defer { model.closeThreadPresentation() }
        let action = try XCTUnwrap(model.actions.first)
        for _ in 0..<80 { model.traceApprovalInteraction(source: "native-key", action: action, focused: true, intent: "allow") }
        XCTAssertEqual(model.approvalInteractionTrace.count, 64)
        XCTAssertEqual(model.approvalInteractionTrace.last?.sequence, 80)
        XCTAssertEqual(model.approvalInteractionTrace.last?.requestHash, action.requestHash)
        let text = String(decoding: try JSONEncoder().encode(model.approvalInteractionTrace), as: UTF8.self)
        XCTAssertFalse(text.contains("synthetic only")); XCTAssertFalse(text.contains("synthetic original request"))
        XCTAssertFalse(text.contains("arguments")); XCTAssertFalse(text.contains("hostAddress"))
        await assertOnlyGETs(transport)
    }
    private func presentedModel(_ transport: ContinuationReadTransport) async throws -> DexterAppModel {
        let model = try await loadedModel(transport)
        let generation = try XCTUnwrap(model.presentThread("thread-a", for: "bot-a"))
        await model.loadPresentedThread("thread-a", generation: generation)
        return model
    }
    private func eventually(_ condition: @MainActor () async -> Bool) async -> Bool {
        for _ in 0..<200 {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
    private func assertEventually(file: StaticString = #filePath, line: UInt = #line,
                                  _ condition: @MainActor () async -> Bool) async {
        let result = await eventually(condition)
        XCTAssertTrue(result, file: file, line: line)
    }
    private func assertOnlyGETs(_ transport: ContinuationReadTransport, file: StaticString = #filePath, line: UInt = #line) async {
        let requests = await transport.recorded()
        XCTAssertTrue(requests.allSatisfy { $0.method == "GET" }, file: file, line: line)
    }
}

@MainActor private final class ContinuationMemory: DexterAppStateStorage {
    private var bytes: Data
    init() throws {
        bytes = try JSONEncoder().encode(DexterPersistedAppState(version: 1, mode: .loopback, loopbackAddress: "http://127.0.0.1:49191", pendingRequests: []))
    }
    func readData() -> Data? { bytes }
    func readState() -> DexterStoredState { .data(bytes) }
    func writeData(_ data: Data) { bytes = data }
    func removeData() {} // No test asks to reset persistence.
}

private actor ContinuationReadTransport: HTTPTransport {
    struct Request: Sendable { let method: String; let path: String; let after: String? }
    private var requests: [Request] = []
    private var heldPaths = Set<String>()
    private var held: [String: CheckedContinuation<Void, Never>] = [:]
    private var receiptState = "awaiting_approval"
    private var responseState: String?
    private var originState = "completed"
    private var extraProposal = false
    private var extraState = "awaiting_approval"
    private var offline = false
    private var cancelRejected = false
    private var resumeRejected = false
    private var hostID = "synthetic-continuation-host"
    func recorded() -> [Request] { requests }
    func progressReads() -> Int { requests.filter { $0.path.hasSuffix("/continuation") }.count }
    func setOffline(_ value: Bool) { offline = value }
    func rejectCancel() { cancelRejected = true }
    func rejectResume() { resumeRejected = true }
    func changeIdentity() { hostID = "different-synthetic-host" }
    func terminalReceipt(_ state: String) { receiptState = state }
    func publishResponse(state: String) { responseState = state; if receiptState == "ready" || receiptState == "awaiting_approval" { receiptState = "succeeded" } }
    func publishResponseWithNewProposal() { publishResponse(state: "running"); extraProposal = true }
    func completeResponse() { responseState = "completed"; extraState = "denied" }
    func setOriginState(_ state: String) { originState = state }
    func hold(_ path: String) { heldPaths.insert(path) }
    func isHeld(_ path: String) -> Bool { held[path] != nil }
    func release(_ path: String) { heldPaths.remove(path); held.removeValue(forKey: path)?.resume() }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value
        requests.append(Request(method: method, path: path, after: after))
        if offline { throw HostClientError.offline }
        let value: [String: Any]
        switch path {
        case "/health": value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": hostID, "state": [:]]
        case "/v1/bots": value = ["items": [["id": "bot-a", "name": "Synthetic", "profileId": "profile-a", "engine": "claude", "ownerId": "owner-a", "createdAt": 1]]]
        case "/v1/bots/bot-a/threads": value = ["items": ["thread-a", "thread-b"].map { ["id": $0, "botId": "bot-a", "createdAt": 1] }]
        case "/v1/events": value = ["items": ["thread-a", "thread-b"].enumerated().map { index, id in
            ["id": "event-\(id)", "cursor": index + 1, "kind": "thread.created", "botId": "bot-a", "entityId": id, "createdAt": 1] as [String: Any]
        }, "nextCursor": 2]
        case "/v1/threads/thread-a", "/v1/threads/thread-b": value = ["id": path.hasSuffix("thread-a") ? "thread-a" : "thread-b", "botId": "bot-a", "createdAt": 1]
        case "/v1/actions": value = ["items": [action()]]
        case "/v1/actions/action-a": value = action()
        case "/v1/actions/action-extra": value = extraAction()
        case "/v1/actions/action-extra/continuation": value = ["continuation": NSNull()]
        case continuationDecisionPath:
            guard method == "POST", let body = request.httpBody,
                  let input = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                  input["requestHash"] as? String == String(repeating: "a", count: 64),
                  let decision = input["decision"] as? String, ["allow", "deny"].contains(decision)
            else { throw HostClientError.invalidRequest }
            #if os(macOS)
            guard Set(input.keys) == ["expectedHostId", "clientRequestId", "requestHash", "decision", "alwaysAccept", "expectedTypeKey", "expectedPreferenceRevision"],
                  input["expectedHostId"] as? String == hostID,
                  let clientRequestID = input["clientRequestId"] as? String, UUID(uuidString: clientRequestID) != nil,
                  input["alwaysAccept"] as? Bool == false,
                  input["expectedTypeKey"] is NSNull,
                  input["expectedPreferenceRevision"] as? Int == 0,
                  receiptState == "awaiting_approval"
            else { throw HostClientError.invalidRequest }
            let receiptInput = try JSONDecoder().decode(JSONValue.self, from: body)
            let identity: JSONValue = .object(["hostId": .string(hostID), "ownerId": .string("owner-a"),
                "botId": .string("bot-a"), "kind": .string("decision"), "targetId": .string("action-a"), "input": receiptInput])
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let inputHash = SHA256.hash(data: try encoder.encode(identity)).map { String(format: "%02x", $0) }.joined()
            receiptState = decision == "allow" ? "ready" : "denied"
            value = ["action": action(), "receipt": ["id": "arp-synthetic-\(clientRequestID)",
                "clientRequestId": clientRequestID, "inputHash": inputHash, "hostId": hostID, "ownerId": "owner-a",
                "botId": "bot-a", "kind": "decision", "targetId": "action-a", "input": input, "previous": NSNull(),
                "state": ["actionId": "action-a", "requestHash": String(repeating: "a", count: 64),
                          "decision": decision, "preference": NSNull()], "createdAt": 2,
                "revocationEffects": ["blockedActionIds": [], "abortedActionIds": []]]]
            #else
            guard Set(input.keys) == ["requestHash", "decision"] else { throw HostClientError.invalidRequest }
            receiptState = input["decision"] as? String == "allow" ? "ready" : "denied"
            value = action()
            #endif
        case "/v1/actions/action-a/continuation": value = ["continuation": ["originTurnId": "origin-a", "deliveredToEngine": responseState != nil, "responseTurnId": responseState == nil ? NSNull() : "response-a", "responseState": responseState as Any? ?? NSNull(), "originValid": true, "resultBodyAvailable": responseState != nil]]
        case "/v1/threads/thread-a/turns": value = ["items": [turn(id: "origin-a", state: originState, cursor: 1)] + (responseState.map { [turn(id: "response-a", state: $0, cursor: 2)] } ?? []), "nextCursor": responseState == nil ? 1 : 2]
        case "/v1/threads/thread-b/turns", "/v1/threads/thread-b/messages", "/v1/teams", "/v1/live-voice/settings": value = ["items": [], "nextCursor": 0]
        case "/v1/threads/thread-a/messages": value = ["items": [message(id: "input-a", role: "user", content: "synthetic original request", cursor: 1)] + (responseState == "completed" ? [message(id: "answer-a", role: "assistant", content: "synthetic host answer", cursor: 2)] : []), "nextCursor": responseState == "completed" ? 2 : 1]
        case "/v1/turns/origin-a": value = turn(id: "origin-a", state: originState, cursor: 1)
        case "/v1/turns/origin-a/events": value = ["items": [], "nextCursor": Int(after ?? "0") ?? 0]
        case "/v1/turns/response-a": value = turn(id: "response-a", state: responseState ?? "queued", cursor: 2)
        case "/v1/turns/response-a/cancel":
            guard method == "POST" else { throw HostClientError.invalidRequest }
            if cancelRejected { return TransportResponse(statusCode: 409, data: Data("{\"error\":\"conflict\"}".utf8)) }
            responseState = "interrupted"
            value = turn(id: "response-a", state: "interrupted", cursor: 2)
        case "/v1/threads/thread-a/resume-queued":
            guard method == "POST" else { throw HostClientError.invalidRequest }
            if resumeRejected { return TransportResponse(statusCode: 409, data: Data("{\"error\":\"conflict\"}".utf8)) }
            responseState = "completed"
            value = ["resumed": 1]
        case "/v1/turns/response-a/events":
            var events: [[String: Any]] = after == "0" ? [["cursor": 1, "turnId": "response-a", "threadId": "thread-a", "kind": "text.delta", "text": "synthetic host answer", "createdAt": 2]] : []
            if after == "0", extraProposal { events.append(["cursor": 2, "turnId": "response-a", "threadId": "thread-a", "kind": "tool.requested", "data": ["actionId": "action-extra"], "createdAt": 2]) }
            value = ["items": events, "nextCursor": extraProposal ? 2 : 1]
        default: throw HostClientError.notFound
        }
        // Capture the reply BEFORE suspension and deliberately ignore cancellation: stale-delivery proof.
        let data = try JSONSerialization.data(withJSONObject: value)
        if heldPaths.contains(path) { await withCheckedContinuation { held[path] = $0 } }
        return TransportResponse(statusCode: 200, data: data)
    }
    private func action() -> [String: Any] {
        ["id": "action-a", "request": ["botId": "bot-a", "threadId": "thread-a", "tool": "dexter.harness.terminal.run", "destination": "bot-workspace", "arguments": ["command": "synthetic only"], "idempotencyKey": "synthetic-idempotency"], "requestHash": String(repeating: "a", count: 64), "grantRevision": 7, "state": receiptState, "createdAt": 1, "updatedAt": receiptState == "awaiting_approval" ? 1 : 2, "approvalExpiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 60_000, "decidedBy": receiptState == "awaiting_approval" ? NSNull() : "owner-a", "result": ["exitCode": NSNull(), "termination": "timeout", "signal": "SIGTERM"], "reason": receiptState == "denied" ? "user_denied" : receiptState == "unknown" || receiptState == "blocked" ? "executor_error" as Any : NSNull() as Any]
    }
    private func turn(id: String, state: String, cursor: Int) -> [String: Any] {
        ["id": id, "cursor": cursor, "threadId": "thread-a", "botId": "bot-a", "engine": "claude", "clientRequestId": id == "origin-a" ? "real-original-request" : "host-receipt-continuation", "inputMessageId": "input-a", "outputMessageId": id == "response-a" && state == "completed" ? "answer-a" : NSNull(), "state": state, "outputChars": state == "completed" && id == "response-a" ? 21 : 0, "outputTruncated": false, "createdAt": cursor, "updatedAt": state == "completed" ? 3 : 2]
    }
    private func extraAction() -> [String: Any] {
        var value = action()
        value["id"] = "action-extra"; value["state"] = extraState
        value["requestHash"] = String(repeating: "b", count: 64)
        var request = value["request"] as! [String: Any]
        request["idempotencyKey"] = "synthetic-extra-request"
        value["request"] = request
        return value
    }
    private func message(id: String, role: String, content: String, cursor: Int) -> [String: Any] {
        ["id": id, "cursor": cursor, "threadId": "thread-a", "clientMessageId": id, "role": role, "content": content, "createdAt": cursor]
    }
}
