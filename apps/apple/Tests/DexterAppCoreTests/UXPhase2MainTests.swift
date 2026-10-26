#if os(macOS)
@testable import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// UX phase 2 (ux-main-opus55-wave2): Conectar a outra base (UX-P1-07). Synthetic transports, in-memory pairing
/// metadata and identity only: no Keychain, account, provider, inference, microphone, personal host or 4317/4318.
@MainActor final class UXPhase2OtherBaseTests: XCTestCase {

    func testMenuRequestIsConsumedOnceAndOnlyPresents() throws {
        let router = DexterWindowRouter()
        router.settingsTab = .general
        router.requestConnectOtherBase()
        XCTAssertEqual(router.settingsTab, .general, "The sheet opens in a main window; Settings is not navigated")
        let token = try XCTUnwrap(router.connectOtherBaseRequest)
        XCTAssertTrue(router.takeConnectOtherBaseRequest(token))
        XCTAssertFalse(router.takeConnectOtherBaseRequest(token), "The Settings window consumes it once")
        XCTAssertNil(router.connectOtherBaseRequest)
        XCTAssertFalse(router.takeConnectOtherBaseRequest(UUID()))
    }

    private func makeModel(_ wire: Phase2Host, port: Int, pairing: PairedHostOnboarding? = nil) async -> DexterAppModel {
        let pairing = pairing ?? PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
                                                      identityStorage: { _ in Phase2ForbiddenIdentityStorage() })
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire),
                                   storage: Phase2Storage(), pairing: pairing)
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        return model
    }

    func testTextThatIsNotAnInvitationChangesNothingAndSendsNothing() async throws {
        let wire = Phase2Host(); let model = await makeModel(wire, port: 49_901)
        let local = "http://127.0.0.1:49901"
        XCTAssertTrue(model.isUsingThisMacBase(localAddress: local))
        let before = await wire.requestCount()
        let wrongRole = try JSONSerialization.data(withJSONObject: ["protocol": "dexter-app-client-v1", "installationId": "host_x",
            "hostUrl": "https://127.0.0.1:49999", "hostCertificateDER": "AA==", "hostFingerprint": "f", "offerId": "o", "kind": "pair",
            "role": "client-ios", "scopes": ["chat.read"], "deviceId": NSNull(), "expiresAt": 1, "code": String(repeating: "x", count: 43)])
        for junk in [Data(), Data("olá".utf8), Data("{\"protocol\":\"dexter-app-client-v1\"}".utf8), Data(repeating: 32, count: 40_000), wrongRole] {
            XCTAssertEqual(model.importPairingInvitation(junk), .notAnInvitation)
        }
        XCTAssertTrue(model.canUseHost); XCTAssertTrue(model.isOnline)
        XCTAssertEqual(model.pairing.state, .disconnected); XCTAssertNil(model.pairing.publicReference)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.isUsingThisMacBase(localAddress: local), "The current base stays connected")
        let after = await wire.requestCount()
        XCTAssertEqual(after, before, "Nothing is sent for text that is not an invitation")
    }

    func testValidInvitationKeepsTheOldContractWithoutCreatingAKey() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity: identity)
        defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory()
        let pairing = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let wire = Phase2Host(); let model = await makeModel(wire, port: 49_902, pairing: pairing)
        let invitation = try JSONSerialization.data(withJSONObject: ["protocol": "dexter-app-client-v1", "installationId": "host_fixture",
            "hostUrl": fixture.url.absoluteString, "hostCertificateDER": fixture.der.base64EncodedString(), "hostFingerprint": fixture.fingerprint,
            "offerId": "offer_fixture", "kind": "pair", "role": "client-mac", "scopes": ["chat.read"], "deviceId": NSNull(),
            "expiresAt": Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "code": String(repeating: "x", count: 43)])
        XCTAssertEqual(model.importPairingInvitation(invitation), .accepted)
        XCTAssertEqual(model.pairing.state, .readyToProvision, "Next step is the explicit Pedir aprovação")
        XCTAssertNotNil(model.pairing.publicReference)
        let counts = await keys.counts()
        XCTAssertEqual(counts, [0, 0], "Importing never loads or creates this Mac's key")
        XCTAssertEqual(try fixture.requests(), 0, "Importing contacts nobody")
        XCTAssertFalse(model.isUsingThisMacBase(localAddress: "http://127.0.0.1:49902"),
                       "Unchanged import contract: the app leaves the current base while linking another")
        XCTAssertNil(model.pairing.binding, "No approval, no binding, no grant")
    }

    func testReturnToThisMacBaseIsTheLoopbackSwitchAndKeepsTheOtherBaseReference() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try IntegrationTLSFixture(identity: identity)
        defer { fixture.close() }
        let metadata = PairMetadataMemory(), keys = PairIdentityMemory()
        let pairing = PairedHostOnboarding(journal: metadata.journal, storage: metadata, identityStorage: { _ in keys })
        let wire = Phase2Host(); let model = await makeModel(wire, port: 49_903, pairing: pairing)
        let invitation = try JSONSerialization.data(withJSONObject: ["protocol": "dexter-app-client-v1", "installationId": "host_fixture",
            "hostUrl": fixture.url.absoluteString, "hostCertificateDER": fixture.der.base64EncodedString(), "hostFingerprint": fixture.fingerprint,
            "offerId": "offer_fixture", "kind": "pair", "role": "client-mac", "scopes": ["chat.read"], "deviceId": NSNull(),
            "expiresAt": Int64(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "code": String(repeating: "x", count: 43)])
        XCTAssertEqual(model.importPairingInvitation(invitation), .accepted)
        // A closed loopback port stands in for this Mac's base: the switch itself is what is checked, not a reply.
        let closed = "http://127.0.0.1:9"
        let returned = await model.returnToThisMacBase(localAddress: closed)
        XCTAssertTrue(returned)
        XCTAssertEqual(model.hostAddress, closed)
        XCTAssertTrue(model.isUsingThisMacBase(localAddress: closed))
        XCTAssertNotNil(model.pairing.publicReference, "Returning forgets nothing: the other base can be connected later")
        XCTAssertEqual(model.pairing.state, .offline)
        let counts = await keys.counts()
        XCTAssertEqual(counts, [0, 0]); XCTAssertEqual(try fixture.requests(), 0)
        let refused = await model.returnToThisMacBase(localAddress: "https://example.com")
        XCTAssertFalse(refused, "Only a loopback address of this Mac")
    }
}

/// UX-P1-13: one voice entry. Decisions are pure; the controller test uses a capability-only host that answers the
/// status read and refuses any start. No call, microphone, media, key or provider is ever touched.
@MainActor final class UXPhase2VoiceEntryTests: XCTestCase {
    private func input(engine: EffectiveConversationEngine, native: NativeVoiceReading = .notRead, live: Bool = false,
                       busy: Bool = false, nativeOpen: Bool = false, liveActive: Bool = false, local: Bool = true,
                       demo: Bool = false, privateBot: Bool = true) -> VoiceEntryInput {
        VoiceEntryInput(privateBotConversation: privateBot, isDemo: demo, ownerLocalBase: local, replyBusy: busy, engine: engine,
                        native: native, nativeSessionOpen: nativeOpen, liveConfigured: live, liveActive: liveActive)
    }
    private let codex = EffectiveConversationEngine.known(.codex, source: .botDefault, botDefault: .codex)
    private let claudeOverride = EffectiveConversationEngine.known(.claude, source: .conversation, botDefault: .codex)
    private let supported162 = NativeVoiceReading.read(supported: true, code: nil, cliVersion: "0.162.0")
    private let unsupported141 = NativeVoiceReading.read(supported: false, code: .unsupported, cliVersion: "0.141.0")

    func testCodexConversationCallsOnlyWhenTheHostSaysItCan() {
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162)), .nativeCall)
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162, live: true)), .nativeCall,
                       "The native call is the Codex conversation's path even with Live set up")
        // 0.141: never an active call button; Live only as an explicit choice, or the setup sheet.
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: unsupported141)), .setup(.programUpdate(version: "0.141.0")))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: unsupported141, live: true)), .chooseLive(.programUpdate(version: "0.141.0")))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .read(supported: false, code: .authNeeded, cliVersion: "0.162.0"))), .setup(.signIn))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .read(supported: false, code: .modelUnsupported, cliVersion: "0.162.0"))), .setup(.modelUnsupported))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .read(supported: false, code: .audioClientMissing, cliVersion: nil))), .setup(.unavailable))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .failed, live: true)), .chooseLive(.unavailable))
        // Until the host answers, nothing is decided and the button is disabled.
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .notRead, live: true)), .checking)
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: .reading)), .checking)
        XCTAssertFalse(VoiceEntryRoute.checking.isEnabled)
    }

    func testEffectiveEngineNotBotDefaultDecides() {
        // A Codex bot whose conversation now answers with Claude never offers the native call.
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: claudeOverride, native: supported162)), .setup(.notCodex(.claude)))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: claudeOverride, native: supported162, live: true)), .live)
        // While the conversation's engine is still loading, the bot default is not used to decide.
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: .loading(botDefault: .codex), native: supported162, live: true)),
                       .unavailable(.engineLoading))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: .none)), .hidden)
    }

    func testSessionsKeepTheirPathAndBlockedStatesSayWhy() {
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: claudeOverride, native: supported162, nativeOpen: true)), .nativeInProgress,
                       "A call in progress stays a call even if the conversation's engine changed")
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162, live: true, liveActive: true)), .liveInProgress)
        XCTAssertFalse(VoiceEntryRoute.liveInProgress.isEnabled, "Live is stopped by its own visible Parar")
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162, busy: true)), .unavailable(.replyRunning))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: claudeOverride, live: true, busy: true)), .unavailable(.replyRunning))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162, local: false)), .unavailable(.noLocalBase))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, demo: true)), .unavailable(.demo))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: supported162, privateBot: false)), .hidden,
                       "Teams and groups have no voice entry")
        for route in [VoiceEntryRoute.unavailable(.demo), .unavailable(.noLocalBase), .unavailable(.engineLoading), .unavailable(.replyRunning), .hidden] {
            XCTAssertFalse(route.isEnabled)
        }
        for route in [VoiceEntryRoute.nativeCall, .live, .chooseLive(.signIn), .setup(.notCodex(.claude)), .nativeInProgress] {
            XCTAssertTrue(route.isEnabled)
        }
    }

    private final class NoMedia {
        var created = 0
    }

    private func controller(_ wire: Phase2Host, mediaCount: NoMedia) -> CodexNativeVoiceController {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49911")!, transport: wire)
        return CodexNativeVoiceController(scope: CodexVoiceScope(hostID: "host_phase2", botID: "bot_codex", threadID: "thr_codex"),
            client: client, isCurrent: { true },
            mediaFactory: { mediaCount.created += 1; return Phase2RefusingMedia() },
            canUseAudio: { true })
    }

    func testCapabilityOnlyHostDrivesTheRouteAndAStartOnAnOldProgramSendsNothing() async throws {
        let wire = Phase2Host()
        await wire.setNativeStatus(threadID: "thr_codex", supported: false, code: "native_voice_unsupported", version: "0.141.0")
        let media = NoMedia()
        let old = controller(wire, mediaCount: media)
        await old.refreshStatus()
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49912")!, transport: wire), storage: Phase2Storage())
        let reading = model.voiceEntryInput(threadID: "thr_codex", native: old).native
        XCTAssertEqual(reading, .read(supported: false, code: .unsupported, cliVersion: "0.141.0"))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: reading)), .setup(.programUpdate(version: "0.141.0")))
        await old.start()
        let starts = await wire.nativeStarts()
        XCTAssertEqual(starts, 0, "An unsupported program never gets a start request")
        XCTAssertEqual(media.created, 0, "No media (microphone) object is ever created")
        XCTAssertFalse(model.voiceEntryInput(threadID: "thr_codex", native: old).nativeSessionOpen)

        await wire.setNativeStatus(threadID: "thr_codex", supported: true, code: nil, version: "0.162.0")
        let current = controller(wire, mediaCount: media)
        await current.refreshStatus()
        let currentReading = model.voiceEntryInput(threadID: "thr_codex", native: current).native
        XCTAssertEqual(currentReading, .read(supported: true, code: nil, cliVersion: "0.162.0"))
        XCTAssertEqual(VoiceEntryDecision.route(input(engine: codex, native: currentReading)), .nativeCall)
        XCTAssertEqual(media.created, 0, "Reading the route opens no microphone; only Ligar inside the call sheet would")
        let reads = await wire.nativeStatusReads()
        XCTAssertEqual(reads, 3, "Two refreshes plus the one start() makes before deciding; all are GETs")

        // A status for another conversation is not this conversation's answer.
        XCTAssertEqual(model.voiceEntryInput(threadID: "thr_other", native: current).native, .notRead)
    }
}

/// UX-P1-07 scopes: plain labels and the owner's draft. Raw strings only; nothing is granted here.
final class UXPhase2PairingScopeTests: XCTestCase {
    func testHistoricalEightAreExplicitAndOutputsStartOff() {
        XCTAssertEqual(PairingScopeCatalog.historical.count, 8)
        XCTAssertFalse(PairingScopeCatalog.historical.contains(PairingScopeCatalog.outputsRead))
        let fresh = PairingScopeSelection()
        XCTAssertFalse(fresh.outputsRead); XCTAssertFalse(fresh.outputsManage)
        XCTAssertEqual(fresh.scopes, PairingScopeCatalog.historical.sorted(), "A new offer never carries outputs.*")
        XCTAssertEqual(fresh.scopes, fresh.scopes.sorted())
    }

    func testOnlyAHumanGestureAddsEachOutputScopeAndManageDoesNotImplyRead() {
        var selection = PairingScopeSelection()
        selection.set("devices.manage", on: true); selection.set("grants.read", on: false); selection.set("anything", on: true)
        XCTAssertEqual(selection, PairingScopeSelection(), "Nothing but the two output scopes can be toggled here")
        selection.set(PairingScopeCatalog.outputsManage, on: true)
        XCTAssertTrue(selection.managesWithoutReading)
        XCTAssertTrue(selection.scopes.contains("outputs.manage")); XCTAssertFalse(selection.scopes.contains("outputs.read"))
        selection.selectAllOutputs()
        XCTAssertEqual(selection.scopes.count, 10); XCTAssertFalse(selection.managesWithoutReading)
        XCTAssertEqual(selection.scopes, selection.scopes.sorted())
    }

    func testRowsDescribeAnOfferWithoutInventingScopes() {
        let rows = PairingScopeCatalog.rows(for: PairingScopeCatalog.historical)
        XCTAssertEqual(rows.count, 14, "the eight historical scopes plus six owner-granted opt-ins (outputs, connections, mcp)")
        XCTAssertEqual(rows.filter(\.included).count, 8)
        XCTAssertEqual(rows.first { $0.scope == "outputs.read" }?.included, false)
        XCTAssertEqual(rows.first { $0.scope == "connections.read" }?.included, false)
        XCTAssertEqual(PairingScopeCatalog.labelKey("outputs.read"), "Ver e baixar arquivos")
        XCTAssertEqual(PairingScopeCatalog.labelKey("outputs.manage"), "Alterar pasta de arquivos")
        XCTAssertTrue(PairingScopeCatalog.managesWithoutReading(["outputs.manage"]))
        let future = PairingScopeCatalog.rows(for: ["chat.read", "future.scope"])
        XCTAssertEqual(future.last?.scope, "future.scope", "An unknown scope is listed as it is, never hidden")
    }
}

// MARK: - Synthetic pieces

@MainActor final class Phase2Storage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}

actor Phase2ForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}

/// Owner loopback base with the reads the app makes on refresh. Counts every request.
actor Phase2Host: HTTPTransport {
    private var requests = 0
    private var bots: [[String: Any]] = []
    private var actions: [[String: Any]] = []
    private var liveVoice: [String: Any]? = nil
    private var catalog: [[String: Any]] = [
        ["id": "claude", "available": true, "installed": true, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": []],
        ["id": "codex", "available": false, "installed": false, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": []]]

    private var nativeStatus: [String: [String: Any]] = [:]
    private var nativeStartCount = 0
    private var nativeStatusCount = 0

    func requestCount() -> Int { requests }
    func nativeStarts() -> Int { nativeStartCount }
    func nativeStatusReads() -> Int { nativeStatusCount }
    func setNativeStatus(threadID: String, supported: Bool, code: String?, version: String?) {
        nativeStatus[threadID] = ["hostId": "host_phase2", "botId": "bot_codex", "threadId": threadID, "botRevision": 0,
            "selectionRevision": 0, "supported": supported, "code": code as Any? ?? NSNull(), "authentication": "unknown",
            "billing": "unknown", "protocol": "synthetic", "transport": "synthetic", "voices": ["alloy", "cedar"],
            "cliVersion": version as Any? ?? NSNull(), "activeSessionId": NSNull()]
    }
    func insertBot(id: String, name: String, engine: String) {
        bots.append(["id": id, "name": name, "profileId": "default", "ownerId": "owner_phase2", "engine": engine, "revision": 0,
                     "createdAt": bots.count + 1])
    }
    func setCatalog(_ items: [[String: Any]]) { catalog = items }
    func setLiveVoice(_ value: [String: Any]?) { liveVoice = value }
    func setActions(_ items: [[String: Any]]) { actions = items }

    private func json(_ value: Any, status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: value))
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests += 1
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        switch (method, path) {
        case ("GET", "/health"):
            return try json(["protocolVersion": 1, "mode": "local-development", "engineRouting": "connected", "remotePairing": "not_implemented",
                             "hostId": "host_phase2", "state": [:], "runtime": ["engines": ["claude", "codex"]]])
        case ("GET", "/v1/bots"): return try json(["items": bots])
        case ("GET", "/v1/engines/catalog"): return try json(["items": catalog])
        case ("GET", "/v1/actions"): return try json(["items": actions])
        case ("GET", "/v1/voice/config"):
            if let liveVoice { return try json(liveVoice) }
            return try json(["error": "not_found"], status: 404)
        default: break
        }
        if method == "GET", path.hasPrefix("/v1/threads/"), path.hasSuffix("/native-voice/status") {
            nativeStatusCount += 1
            let id = String(path.dropFirst("/v1/threads/".count).dropLast("/native-voice/status".count))
            if let status = nativeStatus[id] { return try json(status) }
            return try json(["error": "not_found"], status: 404)
        }
        if method == "POST", path.contains("/native-voice/") {
            // Capability-only: any start or stop is refused and nothing is created.
            nativeStartCount += 1
            return try json(["error": "refused_by_synthetic_host"], status: 503)
        }
        if method == "GET", path.hasPrefix("/v1/threads/"), path.hasSuffix("/messages") || path.hasSuffix("/turns") {
            return try json(["items": [], "nextCursor": 0])
        }
        if method == "GET", ["/v1/events", "/v1/teams", "/v1/devices"].contains(path) {
            return try json(["items": [], "nextCursor": 0])
        }
        return try json(["error": "not_found"], status: 404)
    }
}
/// Never connects: every method fails. The tests assert it is not even created.
@MainActor final class Phase2RefusingMedia: CodexVoiceMedia {
    var onFailure: (@MainActor (CodexVoiceMediaFailure) -> Void)?
    var onConnected: (@MainActor () -> Void)?
    func prepareOffer() async throws -> String { throw URLError(.cancelled) }
    func accept(answer: String) async throws { throw URLError(.cancelled) }
    func setMuted(_ muted: Bool) {}
    func close() async -> Bool { true }
}
#endif
