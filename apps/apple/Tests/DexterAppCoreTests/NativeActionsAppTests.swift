import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity
@testable import DexterNativeActions

private let nativeThread = "thr_00000000-0000-0000-0000-000000000001"
private actor RefusingNativeIdentity: ClientIdentityStorage {
    func load(_ scope:ClientIdentityScope) throws -> ClientNativeIdentity? { throw ClientIdentityFailure.unavailable }
    func provision(_ scope:ClientIdentityScope) throws -> ClientNativeIdentity { throw ClientIdentityFailure.unavailable }
}
@MainActor private final class NativeMemoryState: DexterAppStateStorage {
    var data:Data?
    func readData() -> Data? { data }
    func writeData(_ value:Data) { data = value }
    func removeData() { data = nil }
}
private final class NativeClock: @unchecked Sendable {
    private let lock = NSLock(); private var value = Date()
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds:Double) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}
private actor NativeTransport: HTTPTransport {
    var botOwner = "synthetic-owner"
    var hostID = "synthetic-host", threadBot = "synthetic-bot", missing = false
    var offlineHealth = false, failPost = false, pairedHealth:Data?
    var postIDs:[String] = []
    var posts = 0, paths:[String] = [], holdPath:String?, held:CheckedContinuation<Void,Never>?
    func setHost(_ value:String) { hostID = value }
    func setBot(_ value:String) { threadBot = value }
    func setMissing() { missing = true }
    func hold(_ path:String) { holdPath = path }
    func isHeld() -> Bool { held != nil }
    func release() { holdPath = nil; held?.resume(); held = nil }
    func setOfflineHealth(_ value:Bool) { offlineHealth = value }
    func setPostFailure(_ value:Bool) { failPost = value }
    func setPairedHealth(_ value:Data) { pairedHealth = value; botOwner = "owner" }
    func capturedPostIDs() -> [String] { postIDs }
    func postCount() -> Int { posts }
    func requestCount() -> Int { paths.count }
    func send(_ request:URLRequest) async throws -> TransportResponse {
        let path = request.url!.path; paths.append(path)
        if holdPath == path { await withCheckedContinuation { held = $0 } }
        if path == "/health", offlineHealth { throw HostClientError.offline }
        if path == "/health", let pairedHealth { return TransportResponse(statusCode:200,data:pairedHealth) }
        var object:[String:Any] = ["items":[],"nextCursor":0]
        if request.httpMethod == "POST" {
            posts += 1
            let body = try JSONSerialization.jsonObject(with:request.httpBody!) as! [String:Any]
            postIDs.append(body["clientRequestId"] as! String)
            if failPost { return TransportResponse(statusCode:503,data:Data("{}".utf8)) }
            let turn:[String:Any] = ["cursor":1,"id":"synthetic-turn","threadId":nativeThread,"botId":"synthetic-bot","engine":"claude","clientRequestId":body["clientRequestId"]!,"inputMessageId":"synthetic-input","outputMessageId":NSNull(),"state":"completed","code":NSNull(),"outputChars":0,"outputTruncated":false,"createdAt":1,"startedAt":1,"finishedAt":2,"updatedAt":2]
            return TransportResponse(statusCode:201,data:try JSONSerialization.data(withJSONObject:turn))
        }
        switch path {
        case "/health": object = ["protocolVersion":1,"mode":"local-development","engineRouting":"host","remotePairing":"not_implemented","hostId":hostID,"state":[:]]
        case "/v1/bots": object = ["items":[["id":"synthetic-bot","name":"Synthetic","profileId":"default","engine":"claude","ownerId":botOwner,"createdAt":1]]]
        case "/v1/actions": object = ["items":[],"nextCursor":NSNull()]
        case "/v1/bots/synthetic-bot/threads": object = ["items": [["id":nativeThread,"botId":"synthetic-bot","createdAt":1]]]
        case "/v1/events": object = ["items":[["cursor":1,"id":"event-native","kind":"thread.created","botId":"synthetic-bot","threadId":nativeThread,"entityId":nativeThread,"createdAt":1]],"nextCursor":1]
        case "/v1/threads/"+nativeThread:
            if missing { return TransportResponse(statusCode:404,data:Data("{}".utf8)) }
            object = ["id":nativeThread,"botId":threadBot,"createdAt":1]
        default: break
        }
        return TransportResponse(statusCode:200,data:try JSONSerialization.data(withJSONObject:object))
    }
}
private struct NativePairedTestSender: PairedNativeSending {
    let transport:NativeTransport
    func send(_ request:ClientRequest) async throws -> ClientTransportResponse {
        var urlRequest = URLRequest(url:URL(string:"http://127.0.0.1:4317"+request.route.path)!)
        urlRequest.httpMethod = request.route.method
        if !request.body.isEmpty { urlRequest.httpBody = request.body }
        let response = try await transport.send(urlRequest)
        return ClientTransportResponse(statusCode:response.statusCode,data:response.data)
    }
    func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
}
@MainActor final class NativeActionsAppTests:XCTestCase {
    private func makeModel(_ transport:NativeTransport, clock:NativeClock = NativeClock(), storage:NativeMemoryState = NativeMemoryState()) -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{_ in RefusingNativeIdentity()})
        return DexterAppModel(client:HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport),storage:storage,pairing:pairing,nativeActionNow:{clock.now()})
    }
    private func route() throws -> NativeActionRoute { .prepareMessage(threadID:try DexterThreadID(nativeThread),draft:try BoundedDraft("synthetic private draft")) }
    private func handoff(_ queue:NativeActionHandoffQueue) async throws -> NativeActionHandoff {
        let id = try await queue.enqueue(route()); let value = await queue.consume(id); return try XCTUnwrap(value)
    }
    private func wait(_ condition:() async -> Bool) async -> Bool {
        for _ in 0..<2000 { if await condition() { return true }; await Task.yield() }
        return false
    }
    func testR6PhoneRoutePreservesOnlyCurrentNativeDraftAndHumanConfirmStillSendsOnce() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        defer { model.useFixture() }
        await model.refresh()
        let value = try await handoff(queue)
        let destination = await model.resolveNativeAction(value)
        XCTAssertNotNil(destination)
        let draft = try XCTUnwrap(model.nativeActionDraft)
        let generation = await model.enterPresentedThread(nativeThread, for: "synthetic-bot")
        XCTAssertNotNil(generation)
        XCTAssertEqual(model.nativeActionDraft, draft)
        let before = await transport.postCount(); XCTAssertEqual(before, 0)
        let accepted = await model.confirmNativeActionDraft(id: draft.id, version: draft.version, content: draft.draft, expectedThreadID: nativeThread)
        XCTAssertTrue(accepted)
        let after = await transport.postCount(); XCTAssertEqual(after, 1)
    }
    func testR6ExpiredNativeDraftCannotSurvivePhoneRouteReentry() async throws {
        let clock = NativeClock(), transport = NativeTransport(), model = makeModel(transport, clock: clock)
        let queue = NativeActionHandoffQueue(lifetime: 1, now: { clock.now() })
        defer { model.useFixture() }
        await model.refresh()
        let value = try await handoff(queue)
        _ = await model.resolveNativeAction(value)
        XCTAssertNotNil(model.nativeActionDraft)
        clock.advance(2)
        let result = await model.enterPresentedThread(nativeThread, for: "synthetic-bot")
        XCTAssertNotNil(result); XCTAssertNil(model.nativeActionDraft)
        let posts = await transport.postCount(); XCTAssertEqual(posts, 0)
    }
    func testResolvedDraftVisibleWithoutSubmitThenHumanConfirmationIsOnePost() async throws {
        let storage = NativeMemoryState(), transport = NativeTransport(), queue = NativeActionHandoffQueue()
        let model = makeModel(transport,storage:storage)
        await model.refresh(); XCTAssertTrue(model.isOnline)
        let value = try await handoff(queue)
        let destination = await model.resolveNativeAction(value)
        XCTAssertEqual(destination?.botID,"synthetic-bot"); XCTAssertEqual(destination?.threadID,nativeThread)
        let draft = try XCTUnwrap(model.nativeActionDraft), composer = NativeActionComposer(threadID:nativeThread)
        composer.offer(draft); XCTAssertEqual(composer.text,"synthetic private draft"); XCTAssertNotNil(composer.receivedDraft)
        let zero = await transport.postCount(); XCTAssertEqual(zero,0)
        guard case .native(let id,let version,let content) = try XCTUnwrap(composer.submission()) else { return XCTFail("native confirmation required") }
        let accepted = await model.confirmNativeActionDraft(id:id,version:version,content:content); XCTAssertTrue(accepted)
        composer.completeSubmission(accepted:accepted)
        let again = await model.confirmNativeActionDraft(id:id,version:version,content:content)
        XCTAssertFalse(again); XCTAssertNil(try composer.submission()); XCTAssertNil(model.nativeActionDraft)
        let posts = await transport.postCount(); XCTAssertEqual(posts,1)
        XCTAssertNotNil(storage.data); XCTAssertFalse(String(decoding:storage.data ?? Data(),as:UTF8.self).contains("synthetic private draft"))
        let replay = await model.resolveNativeAction(value); XCTAssertNil(replay)
        model.useFixture()
    }
    func testManualDraftPreservedAndExplicitReplacementDiscardAndRedaction() throws {
        let composer = NativeActionComposer(threadID:nativeThread)
        let draft = NativeActionDraft(id:UUID(),version:1,threadID:nativeThread,draft:try BoundedDraft("synthetic private draft"),expiresAt:Date().addingTimeInterval(60))
        composer.edit("my manual draft"); composer.offer(draft)
        XCTAssertEqual(composer.text,"my manual draft"); XCTAssertNotNil(composer.pendingReplacement)
        composer.clearNative(); XCTAssertEqual(composer.text,"my manual draft"); composer.offer(draft); XCTAssertNil(composer.pendingReplacement)
        let other = NativeActionDraft(id:UUID(),version:2,threadID:nativeThread,draft:draft.draft,expiresAt:draft.expiresAt)
        composer.offer(other); composer.acceptReplacement(); XCTAssertEqual(composer.text,draft.draft.text)
        XCTAssertFalse(String(reflecting:composer).contains(draft.draft.text)); XCTAssertFalse(String(reflecting:other).contains(draft.draft.text))
        composer.clearNative(); XCTAssertEqual(composer.text,"")
    }
    func testQueueTTLAndCancelNeverResolveAndModelExpiryClearsComposer() async throws {
        let clock = NativeClock(), queue = NativeActionHandoffQueue(lifetime:1,now:{clock.now()}), transport = NativeTransport(), model = makeModel(transport,clock:clock)
        let cancelled = try await queue.enqueue(route()); _ = await queue.cancel(cancelled)
        let absent = await queue.consume(cancelled); XCTAssertNil(absent)
        let expired = try await queue.enqueue(route()); clock.advance(2)
        let late = await queue.consume(expired); XCTAssertNil(late)
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:nativeThread); composer.offer(model.nativeActionDraft,now:clock.now()); XCTAssertFalse(composer.text.isEmpty)
        clock.advance(2); model.expireNativeActionDraft(); composer.offer(model.nativeActionDraft,now:clock.now())
        XCTAssertNil(model.nativeActionDraft); XCTAssertEqual(composer.text,""); model.useFixture()
    }
    func testHostChangedHealthMissingThreadAndBotMismatchRefuse() async throws {
        for failure in 0..<3 {
            let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
            await model.refresh()
            if failure == 0 { await transport.setHost("different-host") }
            if failure == 1 { await transport.setMissing() }
            if failure == 2 { await transport.setBot("different-bot") }
            let value = try await handoff(queue), destination = await model.resolveNativeAction(value)
            XCTAssertNil(destination); XCTAssertNil(model.nativeActionDraft)
            let posts = await transport.postCount(); XCTAssertEqual(posts,0); model.useFixture()
        }
    }
    func testHostAndThreadChangesDuringEachValidationAwaitRefuse() async throws {
        for path in ["/health","/v1/threads/"+nativeThread] {
            for hostChange in [false,true] {
                let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
                await model.refresh(); let value = try await handoff(queue); await transport.hold(path)
                let resolving = Task { await model.resolveNativeAction(value) }
                let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
                if hostChange { model.useFixture() } else { model.selectBot(id:nil) }
                await transport.release(); let destination = await resolving.value
                XCTAssertNil(destination); XCTAssertNil(model.nativeActionDraft); model.useFixture()
            }
        }
    }
    func testCancellationDuringOpenThreadAndHumanRevalidationRefuses() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue)
        await transport.hold("/v1/threads/"+nativeThread+"/turns")
        let task = Task { await model.resolveNativeAction(value) }
        let held = await wait { await transport.isHeld() }; XCTAssertTrue(held); task.cancel(); await transport.release()
        let result = await task.value; XCTAssertNil(result); XCTAssertNil(model.nativeActionDraft)
        let fresh = try await handoff(queue); _ = await model.resolveNativeAction(fresh)
        let draft = try XCTUnwrap(model.nativeActionDraft); await transport.hold("/health")
        let confirmation = Task { await model.confirmNativeActionDraft(id:draft.id,version:draft.version,content:draft.draft) }
        let confirming = await wait { await transport.isHeld() }; XCTAssertTrue(confirming)
        model.useFixture(); await transport.release(); let accepted = await confirmation.value; XCTAssertFalse(accepted)
        let posts = await transport.postCount(); XCTAssertEqual(posts,0)
    }
    func testSingleSubscriberForegroundOwnershipPickerAndTeardownReset() async throws {
        let queue = NativeActionHandoffQueue(), transport = NativeTransport(), model = makeModel(transport), router = NativeActionRouter(queue:queue), first = UUID(), second = UUID()
        await model.refresh(); router.attach(model); router.attach(model)
        let subscribed = await wait { await queue.activeSubscriberCount() == 1 }; XCTAssertTrue(subscribed)
        router.requestConversationPicker(); XCTAssertNil(router.navigation)
        router.setForeground(true,scene:first); router.setForeground(true,scene:second)
        XCTAssertEqual(router.navigation,.chooseConversation); XCTAssertTrue(router.ownsScene(first)); XCTAssertFalse(router.ownsScene(second)); XCTAssertEqual(router.subscriptionStarts,1)
        _ = try await queue.enqueue(route())
        let staged = await wait { model.nativeActionDraft != nil }; XCTAssertTrue(staged)
        router.setForeground(false,scene:first); XCTAssertNil(model.nativeActionDraft); XCTAssertNil(router.navigation)
        await router.teardown(); let drained = await wait { await queue.activeSubscriberCount() == 0 }; XCTAssertTrue(drained)
        XCTAssertNil(model.nativeActionDraft); router.attach(model)
        let reset = await wait { await queue.activeSubscriberCount() == 1 }; XCTAssertTrue(reset); XCTAssertEqual(router.subscriptionStarts,2)
        await router.teardown(); model.useFixture()
    }
    func testEndedStreamDoesNotReconnectSpin() async {
        let queue = NativeActionHandoffQueue(); var streams:[AsyncStream<UUID>] = []
        for _ in 0..<16 { streams.append(await queue.updates()) }
        let model = makeModel(NativeTransport()), router = NativeActionRouter(queue:queue)
        router.attach(model); let ended = await wait { router.status == .subscriptionEnded }; XCTAssertTrue(ended)
        for _ in 0..<50 { router.attach(model); await Task.yield() }
        XCTAssertEqual(router.subscriptionStarts,1); let count = await queue.activeSubscriberCount(); XCTAssertEqual(count,16)
        await router.teardown(); withExtendedLifetime(streams) {}
    }
    func testOfflineModelMakesNoRequestAndDraftDoesNotPersist() async throws {
        let storage = NativeMemoryState(), transport = NativeTransport(), queue = NativeActionHandoffQueue()
        let model = makeModel(transport,storage:storage)
        let value = try await handoff(queue), refused = await model.resolveNativeAction(value)
        XCTAssertNil(refused); let count = await transport.requestCount(); XCTAssertEqual(count,0)
        await model.refresh(); let other = try await handoff(queue); _ = await model.resolveNativeAction(other)
        XCTAssertFalse(String(decoding:storage.data ?? Data(),as:UTF8.self).contains("synthetic private draft"))
        model.selectBot(id:nil); XCTAssertNil(model.nativeActionDraft); model.useFixture()
    }
    func testInactiveReplayConsumedOnceAndSceneCancellationPreventsLateNavigation() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue(), router = NativeActionRouter(queue:queue), scene = UUID()
        await model.refresh(); router.attach(model)
        let id = try await queue.enqueue(route())
        let waiting = await wait { router.status == .waitingForForeground }; XCTAssertTrue(waiting)
        XCTAssertNil(model.nativeActionDraft); let pending = await queue.pendingCount(); XCTAssertEqual(pending,1)
        await transport.hold("/health"); router.setForeground(true,scene:scene)
        let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
        router.setForeground(false,scene:scene); XCTAssertEqual(router.status,.idle); await transport.release()
        for _ in 0..<100 { await Task.yield() }
        let consumed = await queue.consume(id); XCTAssertNil(consumed)
        XCTAssertNil(router.navigation); XCTAssertNil(model.nativeActionDraft)
        await router.teardown(); model.useFixture()
    }

    private func sendNative(_ composer:NativeActionComposer, model:DexterAppModel) async throws -> Bool {
        guard case .native(let id,let version,let content) = try XCTUnwrap(composer.submission()) else { XCTFail("native candidate"); return false }
        let accepted = await model.confirmNativeActionDraft(id:id,version:version,content:content)
        composer.completeSubmission(accepted:accepted,reason:model.nativeConfirmationMessage,
            nativeAuthorityAvailable:model.nativeActionDraft?.id == id && model.nativeActionDraft?.version == version)
        return accepted
    }
    func testR2TransientHealthRefusalPreservesEditsReasonThenOneAcceptedPost() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let handoff = try await handoff(queue); _ = await model.resolveNativeAction(handoff)
        let composer = NativeActionComposer(threadID:nativeThread,hostScope:model.nativeComposerScope)
        composer.offer(model.nativeActionDraft); composer.edit("human edited before confirmation")
        await transport.setOfflineHealth(true)
        let refused = try await sendNative(composer,model:model); XCTAssertFalse(refused)
        XCTAssertEqual(composer.text,"human edited before confirmation"); XCTAssertNotNil(composer.notice); XCTAssertNotNil(composer.receivedDraft); XCTAssertNotNil(model.nativeActionDraft)
        let zero = await transport.postCount(); XCTAssertEqual(zero,0)
        await transport.setOfflineHealth(false); await model.refresh(); composer.offer(model.nativeActionDraft)
        let accepted = try await sendNative(composer,model:model); XCTAssertTrue(accepted)
        XCTAssertEqual(composer.text,""); let count = await transport.postCount(); XCTAssertEqual(count,1); model.useFixture()
    }
    func testR2TwoPhaseBlocksRepeatedTapAndKeepsEditsMadeWhileAwaitingAcceptance() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let handoff = try await handoff(queue); _ = await model.resolveNativeAction(handoff)
        let composer = NativeActionComposer(threadID:nativeThread); composer.offer(model.nativeActionDraft)
        guard case .native(let id,let version,let content) = try XCTUnwrap(composer.submission()) else { return XCTFail("native") }
        XCTAssertTrue(composer.isConfirming); XCTAssertNil(try composer.submission()); XCTAssertFalse(composer.text.isEmpty)
        await transport.hold("/health")
        let confirming = Task { await model.confirmNativeActionDraft(id:id,version:version,content:content) }
        let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
        let duplicate = await model.confirmNativeActionDraft(id:id,version:version,content:content); XCTAssertFalse(duplicate)
        composer.edit("later manual edit")
        await transport.release(); let accepted = await confirming.value; XCTAssertTrue(accepted)
        composer.completeSubmission(accepted:accepted); composer.offer(model.nativeActionDraft)
        XCTAssertEqual(composer.text,"later manual edit"); XCTAssertNil(composer.receivedDraft); XCTAssertFalse(composer.isConfirming)
        let count = await transport.postCount(); XCTAssertEqual(count,1); model.useFixture()
    }
    func testR2PendingDigestConflictPreservesCandidateWithoutAnotherPost() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        await transport.setPostFailure(true); let failedManual = await model.submit("different prior content"); XCTAssertFalse(failedManual)
        let composer = NativeActionComposer(threadID:nativeThread); composer.offer(model.nativeActionDraft); composer.edit("new edited native content")
        let before = await transport.postCount(); let accepted = try await sendNative(composer,model:model)
        XCTAssertFalse(accepted); XCTAssertEqual(composer.text,"new edited native content"); XCTAssertNotNil(composer.notice); XCTAssertNotNil(composer.receivedDraft)
        let after = await transport.postCount(); XCTAssertEqual(before,after); model.useFixture()
    }
    func testR2UnknownPostRequiresExplicitRetryAndKeepsCanonicalRequestID() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:nativeThread); composer.offer(model.nativeActionDraft); composer.edit("same edited content")
        await transport.setPostFailure(true); let first = try await sendNative(composer,model:model); XCTAssertFalse(first)
        XCTAssertEqual(composer.text,"same edited content"); XCTAssertNotNil(composer.notice)
        let count = await transport.postCount(); XCTAssertEqual(count,1)
        for _ in 0..<100 { await Task.yield() }; let noRetry = await transport.postCount(); XCTAssertEqual(noRetry,1)
        await transport.setPostFailure(false); let second = try await sendNative(composer,model:model); XCTAssertTrue(second)
        let ids = await transport.capturedPostIDs(); XCTAssertEqual(ids.count,2); XCTAssertEqual(ids.first,ids.last); XCTAssertEqual(composer.text,""); model.useFixture()
    }
    func testR2BusySubmissionRefusesNativeWithoutLosingText() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:nativeThread); composer.offer(model.nativeActionDraft)
        await transport.hold("/v1/threads/"+nativeThread+"/turns")
        let manual = Task { await model.submit("another human action") }
        let held = await wait { await transport.isHeld() }; XCTAssertTrue(held); XCTAssertTrue(model.isSubmitting)
        let accepted = try await sendNative(composer,model:model); XCTAssertFalse(accepted)
        XCTAssertFalse(composer.text.isEmpty); XCTAssertNotNil(composer.notice)
        await transport.release(); _ = await manual.value; model.useFixture()
    }
    func testR2DefinitiveHostRefusalPreservesHumanTextButLocksOriginalScope() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:nativeThread,hostScope:model.nativeComposerScope)
        composer.offer(model.nativeActionDraft); composer.edit("human text remains here")
        await transport.setHost("different-installation")
        let accepted = try await sendNative(composer,model:model); XCTAssertFalse(accepted)
        composer.offer(model.nativeActionDraft); if composer.hostScope != model.nativeComposerScope { composer.invalidateHostScope() }
        XCTAssertEqual(composer.text,"human text remains here"); XCTAssertNil(composer.receivedDraft); XCTAssertNotNil(composer.notice); XCTAssertTrue(composer.scopeInvalidated); XCTAssertNil(try composer.submission())
        let count = await transport.postCount(); XCTAssertEqual(count,0); model.useFixture()
    }
    func testR2TTLRetainsHumanEditAsManualAndExplicitDiscardStillClears() throws {
        let expiry = Date().addingTimeInterval(60), value = NativeActionDraft(id:UUID(),version:1,threadID:nativeThread,draft:try BoundedDraft("external text"),expiresAt:expiry)
        let edited = NativeActionComposer(threadID:nativeThread), original = NativeActionComposer(threadID:nativeThread)
        edited.offer(value); original.offer(value); edited.edit("human revision")
        edited.offer(nil); original.offer(nil)
        XCTAssertEqual(edited.text,"human revision"); XCTAssertNil(edited.receivedDraft); XCTAssertNotNil(edited.notice); XCTAssertEqual(original.text,"")
        let discarded = NativeActionComposer(threadID:nativeThread); discarded.offer(value); discarded.edit("human revision"); discarded.clearNative(); XCTAssertEqual(discarded.text,"")
        let manual = NativeActionComposer(threadID:nativeThread); manual.edit("manual"); manual.offer(value); manual.offer(nil); XCTAssertEqual(manual.text,"manual")
    }
    func testR2SameHostSameThreadSettingsRefreshPreservesDraftAndEdits() async throws {
        let transport = NativeTransport(), model = makeModel(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:nativeThread,hostScope:model.nativeComposerScope)
        composer.offer(model.nativeActionDraft); composer.edit("human revision before settings refresh")
        let original = model.nativeActionDraft, scope = model.nativeComposerScope
        await model.refresh(); composer.offer(model.nativeActionDraft)
        XCTAssertEqual(model.nativeActionDraft,original); XCTAssertEqual(model.nativeComposerScope,scope); XCTAssertEqual(composer.text,"human revision before settings refresh")
        let accepted = try await sendNative(composer,model:model); XCTAssertTrue(accepted)
        model.useFixture(); XCTAssertNotEqual(model.nativeComposerScope,scope)
    }
    func testR2ParameterlessPickerTTLReplayAndTeardownGenerationAreBounded() async {
        let clock = NativeClock(), router = NativeActionRouter(pickerLifetime:1,now:{clock.now()}), model = makeModel(NativeTransport()), scene = UUID()
        router.attach(model); router.requestConversationPicker(); clock.advance(2); router.setForeground(true,scene:scene)
        XCTAssertNil(router.navigation); let before = router.navigationVersion
        router.requestConversationPicker(); XCTAssertEqual(router.navigation,.chooseConversation); XCTAssertEqual(router.navigationVersion,before+1)
        router.setForeground(false,scene:scene); let cleared = router.navigationVersion
        router.setForeground(true,scene:scene); XCTAssertNil(router.navigation); XCTAssertEqual(router.navigationVersion,cleared)
        router.setForeground(false,scene:scene); router.requestConversationPicker(); await router.teardown(); router.setForeground(true,scene:scene); XCTAssertNil(router.navigation)
        let scoped = NativeActionRouter(now:{clock.now()}); scoped.attach(model); scoped.requestConversationPicker()
        model.useFixture(); scoped.setForeground(true,scene:scene); XCTAssertNil(scoped.navigation); await scoped.teardown()
    }
    func testR2RevocationRemovesNativeAuthorityAndProjectionImmediately() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity:identity); defer { fixture.close() }
        let scope = try ClientIdentityScope(installationID:"host_fixture",localBindingID:String(repeating:"a",count:32),role:.clientMac,hostFingerprint:fixture.fingerprint)
        let bundle = try ClientPairingBundle(host:fixture.host(),installationID:scope.installationID,offerID:"offer",role:scope.role,expiresAt:Date().addingTimeInterval(300),code:String(repeating:"x",count:43))
        let binding = try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:"claim",value:["protocol":"dexter-app-client-v1","status":"approved","deviceId":"device","installationId":"host_fixture","ownerId":"owner","role":"client-mac","scopes":ClientScope.legacyPairing.map(\.rawValue).sorted(),"pinGeneration":1,"bindingRevision":1])
        let transport = NativeTransport(); await transport.setPairedHealth(try JSONSerialization.data(withJSONObject:["protocolVersion":1,"mode":"paired-client","engineRouting":"host","remotePairing":"implemented","installationId":"host_fixture","client":["deviceId":binding.deviceID,"role":binding.role.rawValue,"scopes":binding.scopes.map(\.rawValue),"pinGeneration":binding.pinGeneration,"bindingRevision":binding.bindingRevision]]))
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{_ in RefusingNativeIdentity()})
        let model = DexterAppModel(client:HostClient(baseURL:fixture.url,accessPolicy:.pairedHost(binding),transport:PairedHTTPTransport(binding:binding,sender:NativePairedTestSender(transport:transport))),storage:NativeMemoryState(),pairing:pairing)
        await model.refresh(); let queue = NativeActionHandoffQueue(), value = try await handoff(queue); _ = await model.resolveNativeAction(value)
        XCTAssertNotNil(model.nativeActionDraft); XCTAssertNotNil(model.nativeProjectionHostID); let old = model.nativeComposerScope
        await model.revokeThisClient(); XCTAssertNil(model.nativeActionDraft); XCTAssertNil(model.nativeProjectionHostID); XCTAssertNotEqual(model.nativeComposerScope,old)
        XCTAssertEqual(try fixture.requests(),0)
    }

}

// R3 discriminants adapted from read-only Opus P8 fixture; original probes untouched.
private let probeThreadA = "thr_00000000-0000-0000-0000-00000000000a"
private let probeThreadB = "thr_00000000-0000-0000-0000-00000000000b"
private let probeThreadC = "thr_00000000-0000-0000-0000-00000000000c"
private actor R3ThreadTransport: HTTPTransport {
    var holdPath:String?, held:CheckedContinuation<Void,Never>?, failActions = false, failPost = false
    var postPaths:[String] = [], postIDs:[String] = []
    func hold(_ path:String) { holdPath = path }
    func isHeld() -> Bool { held != nil }
    func release() { holdPath = nil; held?.resume(); held = nil }
    func setFailActions(_ value:Bool) { failActions = value }
    func setFailPost(_ value:Bool) { failPost = value }
    func ids() -> [String] { postIDs }
    func posts() -> [String] { postPaths }
    func send(_ request:URLRequest) async throws -> TransportResponse {
        let path = request.url!.path
        if request.httpMethod != "POST", holdPath == path { holdPath = nil; await withCheckedContinuation { held = $0 } }
        var object:[String:Any] = ["items":[],"nextCursor":0]
        if request.httpMethod == "POST" {
            postPaths.append(path)
            let body = try JSONSerialization.jsonObject(with:request.httpBody!) as! [String:Any]
            postIDs.append(body["clientRequestId"] as! String)
            if failPost { return TransportResponse(statusCode:503,data:Data("{}".utf8)) }
            let thread = path.contains(probeThreadB) ? probeThreadB : path.contains(probeThreadC) ? probeThreadC : probeThreadA
            let turn:[String:Any] = ["cursor":1,"id":"probe-turn","threadId":thread,"botId":"synthetic-bot","engine":"claude","clientRequestId":body["clientRequestId"]!,"inputMessageId":"probe-input","outputMessageId":NSNull(),"state":"completed","code":NSNull(),"outputChars":0,"outputTruncated":false,"createdAt":1,"startedAt":1,"finishedAt":2,"updatedAt":2]
            return TransportResponse(statusCode:201,data:try JSONSerialization.data(withJSONObject:turn))
        }
        switch path {
        case "/health": object = ["protocolVersion":1,"mode":"local-development","engineRouting":"host","remotePairing":"not_implemented","hostId":"synthetic-host","state":[:]]
        case "/v1/bots": object = ["items":[["id":"synthetic-bot","name":"Synthetic","profileId":"default","engine":"claude","ownerId":"synthetic-owner","createdAt":1]]]
        case "/v1/actions":
            if failActions { return TransportResponse(statusCode:503,data:Data("{}".utf8)) }
            object = ["items":[],"nextCursor":NSNull()]
        case "/v1/bots/synthetic-bot/threads": object = ["items": [probeThreadA,probeThreadB,probeThreadC].enumerated().map { ["id":$0.element,"botId":"synthetic-bot","createdAt":$0.offset+1] as [String:Any] }]
        case "/v1/events": object = ["items":[["cursor":1,"id":"ev-a","kind":"thread.created","botId":"synthetic-bot","threadId":probeThreadA,"entityId":probeThreadA,"createdAt":1],["cursor":2,"id":"ev-b","kind":"thread.created","botId":"synthetic-bot","threadId":probeThreadB,"entityId":probeThreadB,"createdAt":2],["cursor":3,"id":"ev-c","kind":"thread.created","botId":"synthetic-bot","threadId":probeThreadC,"entityId":probeThreadC,"createdAt":3]],"nextCursor":3]
        case "/v1/threads/"+probeThreadA: object = ["id":probeThreadA,"botId":"synthetic-bot","createdAt":1]
        case "/v1/threads/"+probeThreadB: object = ["id":probeThreadB,"botId":"synthetic-bot","createdAt":2]
        case "/v1/threads/"+probeThreadC: object = ["id":probeThreadC,"botId":"synthetic-bot","createdAt":3]
        default: break
        }
        return TransportResponse(statusCode:200,data:try JSONSerialization.data(withJSONObject:object))
    }
}
extension NativeActionsAppTests {
    private func r3Model(_ transport:R3ThreadTransport, clock:NativeClock = NativeClock()) -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal:UnavailableClientClaimJournal(),storage:EphemeralPairedHostStateStorage(),identityStorage:{_ in RefusingNativeIdentity()})
        return DexterAppModel(client:HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport),storage:NativeMemoryState(),pairing:pairing,nativeActionNow:{clock.now()})
    }
    private func r3Handoff(_ queue:NativeActionHandoffQueue, prepare:Bool = false) async throws -> NativeActionHandoff {
        let thread = try DexterThreadID(probeThreadB)
        let route:NativeActionRoute = prepare ? .prepareMessage(threadID:thread,draft:try BoundedDraft("synthetic B draft")) : .openConversation(threadID:thread)
        let id = try await queue.enqueue(route); let value = await queue.consume(id); return try XCTUnwrap(value)
    }
    // Inverse of Opus P8, plus TTL: nil navigation never retains hidden destination B.
    func testR3RefusedHandoffInvalidatesOnlyOwnSelectionAndPreservesVisibleText() async throws {
        for variant in ["cancelled","actionsError","expired"] {
            let transport = R3ThreadTransport(), clock = NativeClock(), model = r3Model(transport,clock:clock), queue = NativeActionHandoffQueue(now:{clock.now()})
            await model.refresh(); await model.openThread(probeThreadA)
            let composer = NativeActionComposer(threadID:probeThreadA,hostScope:model.nativeComposerScope); composer.edit("synthetic manual A")
            let value = try await r3Handoff(queue)
            let destination:NativeActionDestination?
            if variant == "actionsError" {
                await transport.setFailActions(true); destination = await model.resolveNativeAction(value)
            } else {
                await transport.hold("/v1/threads/"+probeThreadB+"/turns")
                let work = Task { await model.resolveNativeAction(value) }
                let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
                if variant == "cancelled" { work.cancel() } else { clock.advance(601) }
                await transport.release(); destination = await work.value
            }
            XCTAssertNil(destination,variant); XCTAssertNil(model.selectedThreadID,variant)
            guard case .manual(let text) = try XCTUnwrap(composer.submission()) else { return XCTFail("manual") }
            let accepted = await model.submit(text,expectedThreadID:probeThreadA)
            composer.completeSubmission(accepted:accepted,reason:model.errorMessage)
            XCTAssertFalse(accepted); XCTAssertEqual(composer.text,"synthetic manual A"); XCTAssertNotNil(composer.notice)
            let zero = await transport.posts(); XCTAssertEqual(zero,[])
            // Explicitly reopen the visible conversation: a valid manual send is permitted once.
            await transport.setFailActions(false); await model.openThread(probeThreadA)
            guard case .manual(let again) = try XCTUnwrap(composer.submission()) else { return XCTFail("manual") }
            let posted = await model.submit(again,expectedThreadID:probeThreadA); composer.completeSubmission(accepted:posted)
            XCTAssertTrue(posted); XCTAssertEqual(composer.text,"")
            let posts = await transport.posts(); XCTAssertEqual(posts,["/v1/threads/"+probeThreadA+"/turns"])
            model.useFixture()
        }
    }
    func testR3SuccessfulHandoffBeforeNavigationRejectsVisibleAAndNativeBInA() async throws {
        let transport = R3ThreadTransport(), model = r3Model(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); await model.openThread(probeThreadA)
        let value = try await r3Handoff(queue,prepare:true); let destination = await model.resolveNativeAction(value)
        XCTAssertEqual(destination?.threadID,probeThreadB); XCTAssertEqual(model.selectedThreadID,probeThreadB)
        let composer = NativeActionComposer(threadID:probeThreadA,hostScope:model.nativeComposerScope); composer.edit("synthetic manual A")
        guard case .manual(let text) = try XCTUnwrap(composer.submission()) else { return XCTFail("manual") }
        let accepted = await model.submit(text,expectedThreadID:probeThreadA); composer.completeSubmission(accepted:accepted,reason:model.errorMessage)
        XCTAssertFalse(accepted); XCTAssertEqual(composer.text,"synthetic manual A"); XCTAssertNotNil(composer.notice)
        let draft = try XCTUnwrap(model.nativeActionDraft)
        let wrongNative = await model.confirmNativeActionDraft(id:draft.id,version:draft.version,content:draft.draft,expectedThreadID:probeThreadA)
        XCTAssertFalse(wrongNative); XCTAssertNotNil(model.nativeConfirmationMessage); XCTAssertEqual(model.nativeActionDraft?.id,draft.id)
        let zero = await transport.posts(); XCTAssertEqual(zero,[])
        // The newly visible B may explicitly confirm; exactly one POST, no auto-send.
        let rightNative = await model.confirmNativeActionDraft(id:draft.id,version:draft.version,content:draft.draft,expectedThreadID:probeThreadB)
        XCTAssertTrue(rightNative); let posts = await transport.posts(); XCTAssertEqual(posts,["/v1/threads/"+probeThreadB+"/turns"])
        model.useFixture()
    }
    func testR3CancelledHandoffDoesNotClobberNewerHumanCSelection() async throws {
        let transport = R3ThreadTransport(), model = r3Model(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); await model.openThread(probeThreadA); let value = try await r3Handoff(queue)
        await transport.hold("/v1/threads/"+probeThreadB+"/turns")
        let work = Task { await model.resolveNativeAction(value) }; let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
        await model.openThread(probeThreadC); let generation = model.threadPresentationGeneration
        work.cancel(); await transport.release(); let result = await work.value
        XCTAssertNil(result); XCTAssertEqual(model.selectedThreadID,probeThreadC); XCTAssertEqual(model.threadPresentationGeneration,generation)
        let posts = await transport.posts(); XCTAssertEqual(posts,[]); model.useFixture()
    }
    func testR3VisibleRetryRefusesWrongThreadPreservesCanonicalIDAndEdits() async throws {
        let transport = R3ThreadTransport(), model = r3Model(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); let value = try await r3Handoff(queue,prepare:true); _ = await model.resolveNativeAction(value)
        let composer = NativeActionComposer(threadID:probeThreadB,hostScope:model.nativeComposerScope); composer.offer(model.nativeActionDraft); composer.edit("synthetic B edit ")
        guard case .native(let id,let version,let content) = try XCTUnwrap(composer.submission()) else { return XCTFail("native") }
        await transport.setFailPost(true)
        let unknown = await model.confirmNativeActionDraft(id:id,version:version,content:content,expectedThreadID:probeThreadB)
        composer.completeSubmission(accepted:unknown,reason:model.nativeConfirmationMessage)
        XCTAssertFalse(unknown); let before = await transport.ids(); XCTAssertEqual(before.count,1)
        let wrong = await model.retryPendingSubmission(expectedThreadID:probeThreadA); XCTAssertFalse(wrong); XCTAssertNotNil(model.errorMessage)
        let unchanged = await transport.ids(); XCTAssertEqual(unchanged,before)
        await transport.setFailPost(false); await transport.hold("/v1/threads/"+probeThreadB+"/turns")
        // POST itself is immediate in this fixture; revision protection is independently checked below.
        XCTAssertTrue(composer.beginRetry(content:"synthetic B edit"))
        let accepted = await model.retryPendingSubmission(expectedThreadID:probeThreadB)
        composer.completeSubmission(accepted:accepted,reason:model.errorMessage)
        XCTAssertTrue(accepted); XCTAssertEqual(composer.text,""); XCTAssertNil(composer.receivedDraft); XCTAssertNil(model.nativeActionDraft)
        let ids = await transport.ids(); XCTAssertEqual(ids,[before[0],before[0]])
        await transport.release(); model.useFixture()
    }
    func testR3RetryCommitPreservesHumanRevisionAndTrimmedUnchangedDraft() {
        let composer = NativeActionComposer(threadID:probeThreadA); composer.edit("hello ")
        XCTAssertTrue(composer.beginRetry(content:"hello")); composer.edit("later edit")
        composer.completeSubmission(accepted:true); XCTAssertEqual(composer.text,"later edit"); XCTAssertNotNil(composer.notice)
        composer.edit("hello "); XCTAssertTrue(composer.beginRetry(content:"hello")); composer.completeSubmission(accepted:true); XCTAssertEqual(composer.text,"")
    }
}

extension NativeActionsAppTests {
    func testR3CancelledOpeningAfterSameSelectionRefreshCannotLeaveHiddenB() async throws {
        let transport = R3ThreadTransport(), model = r3Model(transport), queue = NativeActionHandoffQueue()
        await model.refresh(); await model.openThread(probeThreadA); let value = try await r3Handoff(queue)
        await transport.hold("/v1/threads/"+probeThreadB+"/turns")
        let work = Task { await model.resolveNativeAction(value) }; let held = await wait { await transport.isHeld() }; XCTAssertTrue(held)
        await model.refresh() // refresh reloads the handoff's B, advancing the selection generation.
        work.cancel(); await transport.release(); let result = await work.value
        XCTAssertNil(result); XCTAssertNil(model.selectedThreadID,"a refresh did not publish B navigation")
        let posts = await transport.posts(); XCTAssertEqual(posts,[]); model.useFixture()
    }
}
