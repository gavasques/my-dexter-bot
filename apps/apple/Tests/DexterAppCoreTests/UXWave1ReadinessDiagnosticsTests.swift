#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// UX-P0-01 (effective conversation engine) and UX-P0-02 (no development tools in the product, recovery to the real
/// base). Synthetic transports only: no process, Keychain, account, provider, inference or personal host.
@MainActor final class UXWave1ReadinessDiagnosticsTests: XCTestCase {
    private static let identity = OnboardingHostIdentity(hostID: "host_wave1", mode: .localDevelopment, clientDeviceID: nil)

    private func entry(_ id: String, available: Bool, installed: Bool = true) -> EngineCatalogEntry {
        try! JSONDecoder().decode(EngineCatalogEntry.self, from: JSONSerialization.data(withJSONObject: [
            "id": id, "available": available, "models": [], "reasoningEfforts": [], "speeds": [], "installed": installed,
            "adapterSupported": true]))
    }

    private func status(_ engine: EffectiveConversationEngine, routing: OnboardingEngineRouting = .connected(routedEngines: [.claude, .codex]),
                        observation: OnboardingEngineObservation? = nil, entries: [EngineCatalogEntry]? = nil,
                        observedAt: Int64 = 10, lookup: EngineCatalogLookup = .loaded, online: Bool = true) -> ConversationEngineStatus.State {
        let catalog = entries.map { OnboardingEngineCatalog(entries: $0, observedAt: observedAt) }
        return ConversationEngineStatus(engine: engine, hostOnline: online, routing: routing, observation: observation,
                                        catalog: catalog, lookup: lookup).state
    }

    // MARK: Pure matrix: default × conversation × catalog × observation

    func testConversationEngineMatrix() {
        let claudeOnly = [entry("claude", available: true), entry("codex", available: false, installed: false)]
        let conversationClaude = EffectiveConversationEngine.known(.claude, source: .conversation, botDefault: .codex)
        let defaultCodex = EffectiveConversationEngine.known(.codex, source: .botDefault, botDefault: .codex)
        // The reported bug: bot default Codex unavailable, conversation on Claude → nothing blocks this conversation.
        XCTAssertEqual(status(conversationClaude, entries: claudeOnly), .clear)
        // The conversation really on Codex: unavailable, with only a reported runnable alternative.
        XCTAssertEqual(status(defaultCodex, entries: claudeOnly), .unavailable(.codex, alternative: .claude))
        XCTAssertEqual(status(defaultCodex, entries: [entry("claude", available: false), entry("codex", available: false)]),
                       .unavailable(.codex, alternative: nil))
        // A routed set that excludes the alternative never offers it.
        XCTAssertEqual(status(defaultCodex, routing: .connected(routedEngines: [.codex]), entries: claudeOnly), .unavailable(.codex, alternative: nil))
        // Distinct non-ready states.
        XCTAssertEqual(status(defaultCodex, lookup: .loading), .checking(.codex))
        XCTAssertEqual(status(defaultCodex, lookup: .failed(.offline)), .notReported(.codex))
        XCTAssertEqual(status(defaultCodex, lookup: .notLoaded), .clear)
        XCTAssertEqual(status(defaultCodex, routing: .notConnected, entries: claudeOnly), .routingOff)
        let required = OnboardingEngineObservation(authentication: .required, unavailable: false, observedAt: 5)
        XCTAssertEqual(status(conversationClaude, observation: required, entries: claudeOnly), .loginRequired(.claude))
        XCTAssertEqual(status(conversationClaude, observation: required, lookup: .loading), .loginRequired(.claude))
        // A newer successful lookup supersedes an older "unavailable" turn, and an older lookup does not hide a newer one.
        let staleUnavailable = OnboardingEngineObservation(authentication: .unknown, unavailable: true, observedAt: 5)
        XCTAssertEqual(status(conversationClaude, observation: staleUnavailable, entries: claudeOnly, observedAt: 10), .clear)
        XCTAssertEqual(status(conversationClaude, observation: staleUnavailable, entries: claudeOnly, observedAt: 1),
                       .unavailable(.claude, alternative: nil))
        // Offline and still-loading selections say nothing about an engine.
        XCTAssertEqual(status(defaultCodex, entries: claudeOnly, online: false), .clear)
        XCTAssertEqual(status(.loading(botDefault: .codex), entries: claudeOnly), .clear)
        XCTAssertEqual(status(.none, entries: claudeOnly), .clear)
    }

    func testProvisionalDefaultKeepsNonBlockingFactsButNeverBlocks() {
        let codexDown = OnboardingEngineCatalog(entries: [entry("codex", available: false, installed: false)], observedAt: 10)
        let provisional = OnboardingReadiness(.init(host: .online(Self.identity), routing: .connected(routedEngines: [.codex]),
            selectedEngine: .codex, selectedEngineIsProvisional: true, catalog: codexDown, devices: .loaded([])))
        XCTAssertEqual(provisional.conversationSteps, [])
        XCTAssertNotEqual(provisional.conversation, .blocked)
        let known = OnboardingReadiness(.init(host: .online(Self.identity), routing: .connected(routedEngines: [.codex]),
            selectedEngine: .codex, catalog: codexDown, devices: .loaded([])))
        XCTAssertEqual(known.conversationSteps, [.engineUnavailable(.codex)])
        XCTAssertEqual(known.conversation, .blocked)
        let provisionalUnknown = OnboardingReadiness(.init(host: .online(Self.identity), routing: .connected(routedEngines: [.claude]),
            selectedEngine: .claude, selectedEngineIsProvisional: true, devices: .loaded([])))
        XCTAssertEqual(provisionalUnknown.conversationSteps, [.engineLoginUnknown(.claude)])
    }

    func testMacAgentStepsNeverAppearAsConversationSteps() {
        let readiness = OnboardingReadiness(.init(host: .online(Self.identity), routing: .connected(routedEngines: [.claude]),
                                                  selectedEngine: .claude, devices: .notLoaded))
        XCTAssertTrue(readiness.steps.contains(.executorUnknown))
        XCTAssertFalse(readiness.conversationSteps.contains(.executorUnknown))
        XCTAssertEqual(readiness.macSteps, [.executorUnknown])
        XCTAssertEqual(readiness.conversationSteps, [.engineLoginUnknown(.claude)])
        XCTAssertNotEqual(readiness.conversation, .blocked)
    }

    // MARK: Model: effective engine bound to the presented thread, bot and host

    private func makeModel(_ wire: Wave1Host, port: Int) async throws -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
                                           identityStorage: { _ in Wave1ForbiddenIdentityStorage() })
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire),
                                   storage: Wave1Storage(), pairing: pairing)
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        return model
    }

    private func presentNewThread(_ model: DexterAppModel, bot: String) async throws -> String {
        model.selectBot(id: bot)
        let before = Set(model.threads(for: bot).map(\.id))
        if before.isEmpty {
            let opened = await model.openConversationForSelectedBot(bot)
            XCTAssertTrue(opened)
        } else {
            await model.createThread(for: bot)
        }
        let thread = try XCTUnwrap(model.threads(for: bot).map(\.id).first { !before.contains($0) })
        XCTAssertNotNil(model.presentThread(thread, for: bot))
        XCTAssertEqual(model.presentedThreadID, thread)
        return thread
    }

    func testConversationOverrideDrivesReadinessInsteadOfBotDefault() async throws {
        let wire = Wave1Host(botEngine: "codex", claudeAvailable: true)
        let model = try await makeModel(wire, port: 49_871)
        await model.refreshEngineCatalog()
        let thread = try await presentNewThread(model, bot: Wave1Host.botID)
        await wire.setOverride(thread: thread, engine: "claude")
        // Until the thread's own selection is read, the bot default is never assumed.
        XCTAssertEqual(model.effectiveConversationEngine, .loading(botDefault: .codex))
        XCTAssertEqual(model.onboardingReadinessInput.selectedEngine, .codex)
        XCTAssertTrue(model.onboardingReadinessInput.selectedEngineIsProvisional)
        XCTAssertFalse(model.onboardingReadiness.steps.contains(.engineUnavailable(.codex)), "A provisional default never blocks")
        XCTAssertNotEqual(model.onboardingReadiness.conversation, .blocked)
        XCTAssertEqual(model.conversationEngineStatus.state, .clear, "No chat banner before the conversation's own selection is read")

        await model.reloadThreadEngineSelection(threadID: thread)
        XCTAssertEqual(model.effectiveConversationEngine, .known(.claude, source: .conversation, botDefault: .codex))
        XCTAssertEqual(model.onboardingReadinessInput.selectedEngine, .claude)
        XCTAssertFalse(model.onboardingReadinessInput.selectedEngineIsProvisional)
        XCTAssertFalse(model.onboardingReadiness.conversationSteps.contains(.engineUnavailable(.codex)))
        XCTAssertNotEqual(model.onboardingReadiness.conversation, .blocked)
        XCTAssertEqual(model.conversationEngineStatus.state, .clear)
        model.closeThreadPresentation()
    }

    func testUnavailableDefaultOffersReportedAlternativeAppliedOnlyThroughThreadCAS() async throws {
        let wire = Wave1Host(botEngine: "codex", claudeAvailable: true)
        let model = try await makeModel(wire, port: 49_872)
        await model.refreshEngineCatalog()
        let thread = try await presentNewThread(model, bot: Wave1Host.botID)
        await model.reloadThreadEngineSelection(threadID: thread)
        XCTAssertEqual(model.effectiveConversationEngine, .known(.codex, source: .botDefault, botDefault: .codex))
        XCTAssertEqual(model.conversationEngineStatus.state, .unavailable(.codex, alternative: .claude))
        XCTAssertEqual(model.onboardingReadiness.conversation, .blocked)
        let beforePatch = await wire.mutations()
        XCTAssertEqual(beforePatch.filter { $0.contains("engine-selection") }, [], "Nothing switches by itself")

        XCTAssertTrue(model.canChangeThreadEngine)
        await model.changeThreadEngineSelection(threadID: thread, selection: EngineSelection(engine: "claude"))
        let patches = await wire.selectionPatches()
        XCTAssertEqual(patches.count, 1)
        XCTAssertEqual(patches.first?.expectedRevision, 0)
        XCTAssertEqual(patches.first?.scope, "thread", "Only this conversation; the bot default stays")
        XCTAssertEqual(model.effectiveConversationEngine, .known(.claude, source: .conversation, botDefault: .codex))
        XCTAssertEqual(model.conversationEngineStatus.state, .clear)
        XCTAssertEqual(model.selectedBot?.engine, .codex)
        model.closeThreadPresentation()
    }

    func testNoReportedAlternativeMeansNoSwitchOffer() async throws {
        let wire = Wave1Host(botEngine: "codex", claudeAvailable: false)
        let model = try await makeModel(wire, port: 49_873)
        await model.refreshEngineCatalog()
        let thread = try await presentNewThread(model, bot: Wave1Host.botID)
        await model.reloadThreadEngineSelection(threadID: thread)
        XCTAssertEqual(model.conversationEngineStatus.state, .unavailable(.codex, alternative: nil))
        model.closeThreadPresentation()
    }

    func testThreadSwitchAndHostSwitchNeverReuseAnotherSelection() async throws {
        let wire = Wave1Host(botEngine: "codex", claudeAvailable: true)
        let model = try await makeModel(wire, port: 49_874)
        await model.refreshEngineCatalog()
        let first = try await presentNewThread(model, bot: Wave1Host.botID)
        await wire.setOverride(thread: first, engine: "claude")
        await model.reloadThreadEngineSelection(threadID: first)
        XCTAssertEqual(model.effectiveConversationEngine.engine, .claude)

        let second = try await presentNewThread(model, bot: Wave1Host.botID)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(model.effectiveConversationEngine, .loading(botDefault: .codex), "The first thread's override is not this one's")
        XCTAssertTrue(model.onboardingReadinessInput.selectedEngineIsProvisional)
        await model.reloadThreadEngineSelection(threadID: second)
        XCTAssertEqual(model.effectiveConversationEngine, .known(.codex, source: .botDefault, botDefault: .codex))

        let before = await wire.requestCount()
        model.hostAddress = "http://127.0.0.1:49875"; model.configureHost()
        XCTAssertEqual(model.effectiveConversationEngine, .none)
        XCTAssertEqual(model.conversationEngineStatus.state, .clear)
        XCTAssertNil(model.onboardingReadinessInput.selectedEngine)
        XCTAssertFalse(model.onboardingReadinessInput.selectedEngineIsProvisional)
        let after = await wire.requestCount()
        XCTAssertEqual(before, after, "Reading status after a host switch sends nothing to the previous base")
    }

    // MARK: UX-P0-02

    func testDevelopmentToolsNeverInPackagedAppOrRelease() {
        XCTAssertFalse(DexterDevelopmentTools.isAvailable(packagedLocalHost: true))
        XCTAssertEqual(DexterDevelopmentTools.isAvailable(packagedLocalHost: false), DexterDevelopmentTools.isCompiledIn)
        #if DEBUG
        XCTAssertTrue(DexterDevelopmentTools.isCompiledIn)
        #else
        XCTAssertFalse(DexterDevelopmentTools.isCompiledIn)
        #endif
    }

    func testBaseLabelsNeverSayDevelopmentForTheOwnersMac() async throws {
        let wire = Wave1Host(botEngine: "claude", claudeAvailable: true)
        let model = try await makeModel(wire, port: 49_876)
        XCTAssertEqual(model.backendLabel, "On this Mac · connected")
        XCTAssertFalse(model.backendLabel.localizedCaseInsensitiveContains("development"))
        model.useFixture()
        XCTAssertEqual(model.backendLabel, "Demo (development only)")
    }

    func testCorruptStorageRecoveryReturnsToTheRealBaseNotTheFixture() throws {
        let storage = Wave1Storage()
        let corrupt = Data([0x7b, 0x22, 0xff, 0x00, 0x7d])
        storage.writeData(corrupt)
        let model = DexterAppModel(storage: storage)
        XCTAssertTrue(model.requiresStorageReset)
        XCTAssertTrue(model.isFixture)
        XCTAssertFalse(model.recoverCorruptStorage(localAddress: "https://example.com"), "Never a remote address")
        XCTAssertEqual(storage.readData(), corrupt)

        XCTAssertTrue(model.recoverCorruptStorage(localAddress: "http://127.0.0.1:49877"))
        XCTAssertFalse(model.requiresStorageReset)
        XCTAssertFalse(model.isFixture)
        XCTAssertTrue(model.canUseHost)
        XCTAssertEqual(model.hostAddress, "http://127.0.0.1:49877")
        let saved = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(saved.mode, .loopback)
        XCTAssertEqual(saved.loopbackAddress, "http://127.0.0.1:49877")
        XCTAssertTrue(saved.pendingRequests.isEmpty)
        XCTAssertFalse(model.recoverCorruptStorage(localAddress: "http://127.0.0.1:49878"), "Only an unreadable snapshot is recovered")
        XCTAssertEqual(model.hostAddress, "http://127.0.0.1:49877")
    }

    func testDiagnosticReportCarriesNoAddressIdentifierOrMessage() async throws {
        let wire = Wave1Host(botEngine: "codex", claudeAvailable: true)
        let model = try await makeModel(wire, port: 49_879)
        await model.refreshEngineCatalog()
        let thread = try await presentNewThread(model, bot: Wave1Host.botID)
        await model.reloadThreadEngineSelection(threadID: thread)
        let report = model.diagnosticReport(appVersion: "1.0 (7)", systemVersion: "27.0.0", localEngines: "Claude", portuguese: true)
        for forbidden in ["127.0.0.1", "49879", "host_wave1", Wave1Host.botID, thread, "Wave synthetic bot", "/Users", "key", "token"] {
            XCTAssertFalse(report.contains(forbidden), forbidden)
        }
        XCTAssertTrue(report.contains("Base: On this Mac · connected"))
        XCTAssertTrue(report.contains("Codex"))
        XCTAssertTrue(report.contains("Conversa atual: Codex · padrão do bot"))
        model.closeThreadPresentation()
    }
}

// MARK: - Coordinator: recovery starts this app's own base once

@MainActor private final class Wave1Child: LocalHostChild {
    private let configuration: LocalHostLaunchConfiguration
    private(set) var running = false
    private var onExit: (@Sendable () -> Void)?
    init(_ configuration: LocalHostLaunchConfiguration) { self.configuration = configuration }
    var isRunning: Bool { running }
    var terminationStatus: Int32 { 0 }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        running = true; self.onExit = onExit
        let data = try JSONSerialization.data(withJSONObject: ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
                                                               "engineExecution": "disabled", "mcpGateway": "disabled",
                                                               "deviceTurnTools": "disabled", "deviceChannel": ["status": "unconfigured"]])
        Task { @MainActor in onStdout(data) }
    }
    func requestGracefulStop() { guard running else { return }; running = false; onExit?() }
}

@MainActor private final class Wave1Children { var items: [Wave1Child] = [] }

private final class Wave1MemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "com.dexter.tests.wave1.\(UUID().uuidString)")! }
    override func object(forKey defaultName: String) -> Any? { lock.lock(); defer { lock.unlock() }; return values[defaultName] }
    override func set(_ value: Any?, forKey defaultName: String) { lock.lock(); defer { lock.unlock() }; values[defaultName] = value }
}

@MainActor final class UXWave1StorageRecoveryCoordinatorTests: XCTestCase {
    func testRecoveredStorageStartsThisAppsBaseOnceAndNeverTheFixture() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-wave1-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let node = directory.appendingPathComponent("node")
        try Data("synthetic".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        try Data("synthetic".utf8).write(to: directory.appendingPathComponent("cli.js"))
        // Port 1: nothing listens there; the refreshes that follow a start fail closed, never reaching a personal host.
        let packaged = LocalHostLaunchConfiguration(node: node, cli: directory.appendingPathComponent("cli.js"),
                                                    dataDir: directory.appendingPathComponent("store", isDirectory: true), port: 1)
        let children = Wave1Children()
        let host = LocalHostLaunchCoordinator(packaged: packaged,
            enginePreferences: LocalEnginePreferenceStore(defaults: Wave1MemoryDefaults(), key: "wave1"),
            makeSupervisor: { config in
                LocalHostSupervisor(configuration: config, makeChild: { config, _ in let child = Wave1Child(config); children.items.append(child); return child },
                                    portIsFree: { _ in true })
            }, stopGrace: .milliseconds(200))
        XCTAssertEqual(host.launchHostAddress, "http://127.0.0.1:1")

        let storage = Wave1Storage()
        storage.writeData(Data([0xff, 0x00]))
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: Wave1Unreachable()), storage: storage)
        XCTAssertTrue(model.requiresStorageReset)
        await host.initialRefresh(model: model)
        XCTAssertEqual(children.items.count, 0, "Unreadable storage refuses the launch attempt")
        await host.startAfterStorageRecovery(model: model)
        XCTAssertEqual(children.items.count, 0, "Nothing starts before the owner confirms recovery")

        XCTAssertTrue(model.recoverCorruptStorage(localAddress: try XCTUnwrap(host.launchHostAddress)))
        await host.startAfterStorageRecovery(model: model)
        XCTAssertEqual(children.items.count, 1)
        XCTAssertTrue(host.ownsLiveChild)
        XCTAssertFalse(model.isFixture)
        await host.startAfterStorageRecovery(model: model)
        XCTAssertEqual(children.items.count, 1, "A live child this app started is never started again")
        await host.stopForTermination()
    }
}

// MARK: - Synthetic host

private struct Wave1Unreachable: HTTPTransport {
    func send(_ request: URLRequest) async throws -> TransportResponse { throw URLError(.cannotConnectToHost) }
}

@MainActor private final class Wave1Storage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}

private actor Wave1ForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}

private struct Wave1Patch: Sendable { let expectedRevision: Int?; let scope: String? }

private actor Wave1Host: HTTPTransport {
    static let botID = "bot_wave1"
    private let botEngine: String
    private let claudeAvailable: Bool
    private var requests: [String] = []
    private var patches: [Wave1Patch] = []
    private var overrides: [String: String] = [:]
    private var revisions: [String: Int] = [:]
    private var threads: [String] = []

    init(botEngine: String, claudeAvailable: Bool) { self.botEngine = botEngine; self.claudeAvailable = claudeAvailable }

    func setOverride(thread: String, engine: String) { overrides[thread] = engine }
    func mutations() -> [String] { requests.filter { !$0.hasPrefix("GET ") } }
    func selectionPatches() -> [Wave1Patch] { patches }
    func requestCount() -> Int { requests.count }

    private func json(_ value: Any, status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: value))
    }

    private func selection(_ thread: String) -> [String: Any] {
        let override = overrides[thread].map { ["engine": $0, "model": NSNull(), "reasoningEffort": NSNull(), "speed": NSNull()] as [String: Any] }
        return ["selection": ["engine": overrides[thread] ?? botEngine, "model": NSNull(), "reasoningEffort": NSNull(), "speed": NSNull()],
                "override": override ?? NSNull(), "revision": revisions[thread] ?? 0, "handoffStatus": "none", "updatedBot": NSNull()]
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        requests.append(method + " " + path)
        switch (method, path) {
        case ("GET", "/health"):
            return try json(["protocolVersion": 1, "mode": "local-development", "engineRouting": "connected", "remotePairing": "not_implemented",
                             "hostId": "host_wave1", "state": [:], "runtime": ["engines": ["claude", "codex"]]])
        case ("GET", "/v1/bots"):
            return try json(["items": [["id": Self.botID, "name": "Wave synthetic bot", "profileId": "default", "ownerId": "owner_wave1",
                                        "engine": botEngine, "revision": 0, "createdAt": 1]]])
        case ("GET", "/v1/engines/catalog"):
            return try json(["items": [
                ["id": "claude", "available": claudeAvailable, "installed": claudeAvailable, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": []],
                ["id": "codex", "available": false, "installed": false, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": [],
                 "unavailableReason": "Codex não encontrado (sintético)."]]])
        case ("POST", "/v1/bots/\(Self.botID)/threads"):
            let id = "thr_wave1_\(threads.count + 1)"
            threads.append(id)
            return try json(["id": id, "botId": Self.botID, "createdAt": threads.count], status: 201)
        default: break
        }
        if path.hasPrefix("/v1/threads/"), path.hasSuffix("/engine-selection") {
            let thread = String(path.dropFirst("/v1/threads/".count).dropLast("/engine-selection".count))
            if method == "PATCH" {
                let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
                patches.append(Wave1Patch(expectedRevision: input["expectedRevision"] as? Int, scope: input["scope"] as? String))
                guard input["expectedRevision"] as? Int == revisions[thread] ?? 0 else { return try json(["error": "conflict"], status: 409) }
                if let selection = input["selection"] as? [String: Any], let engine = selection["engine"] as? String { overrides[thread] = engine }
                else { overrides[thread] = nil }
                revisions[thread] = (revisions[thread] ?? 0) + 1
            }
            return try json(selection(thread))
        }
        if method == "GET", path.hasPrefix("/v1/threads/"), path.hasSuffix("/messages") || path.hasSuffix("/turns") {
            return try json(["items": [], "nextCursor": 0])
        }
        if method == "GET", path.hasPrefix("/v1/threads/") {
            let id = String(path.dropFirst("/v1/threads/".count))
            guard let index = threads.firstIndex(of: id) else { return try json(["error": "not_found"], status: 404) }
            return try json(["id": id, "botId": Self.botID, "createdAt": index + 1])
        }
        if method == "GET", ["/v1/actions", "/v1/events", "/v1/teams", "/v1/live-voice/settings", "/v1/devices"].contains(path) {
            return try json(["items": [], "nextCursor": 0])
        }
        return try json(["error": "not_found"], status: 404)
    }
}
#endif
