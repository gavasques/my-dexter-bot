#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// UX-P1-06 routes, UX-P0-04 first use and UX-P0-03 Browser Use. Synthetic transports and in-memory custody only: no
/// process, Keychain, account, provider, inference, personal host or defaults domain.
@MainActor final class UXWave2MainTests: XCTestCase {

    // MARK: Five panes and legacy routes

    func testFivePanesWithStableAndMigratedRoutes() {
        XCTAssertEqual(DexterSettingsTab.allCases.map(\.rawValue), ["general", "assistants", "connections", "mac", "advanced"])
        XCTAssertEqual(DexterSettingsTab(route: "models"), .assistants)
        XCTAssertEqual(DexterSettingsTab(route: "integrations"), .connections)
        XCTAssertEqual(DexterSettingsTab(route: "devices"), .mac)
        XCTAssertEqual(DexterSettingsTab(route: "mac"), .mac)
        XCTAssertEqual(DexterSettingsTab(route: "advanced"), .advanced)
        XCTAssertNil(DexterSettingsTab(route: "browser"))
        XCTAssertEqual(DexterSettingsTab.models, .assistants)
        XCTAssertEqual(DexterSettingsTab.integrations, .connections)
        XCTAssertEqual(DexterSettingsTab.devices, .mac)
        XCTAssertEqual(DexterSettingsTab.allCases.map(\.guidePageID),
                       ["settings-general", "settings-assistants", "settings-connections", "settings-this-mac", "settings-advanced"])
        let router = DexterWindowRouter()
        router.settingsTab = .devices
        XCTAssertEqual(router.settingsTab, .mac)
        router.requestWelcome()
        let token = try! XCTUnwrap(router.welcomeRequest)
        XCTAssertTrue(router.takeWelcomeRequest(token))
        XCTAssertFalse(router.takeWelcomeRequest(token), "One main window consumes the request")
    }

    // MARK: First-use preset: fresh versus an explicit saved choice

    private func candidate(_ kind: LocalEngineKind, _ launcher: String) -> LocalEngineCandidate {
        LocalEngineCandidate(kind: kind, launcher: launcher, identity: LocalEngineFileIdentity(resolvedPath: launcher, device: 1, inode: 1))
    }

    func testFirstUsePresetOnlyOnAMacWithNothingSaved() {
        let found = [candidate(.claude, "/opt/homebrew/bin/claude")]
        guard case .applyPreset(let preset) = FirstUseEnginePlan.make(stored: .missing, kind: .claude, candidates: found) else {
            return XCTFail("fresh Mac with the CLI found gets the preset")
        }
        XCTAssertTrue(preset.allowsLocalEngines)
        XCTAssertTrue(preset.allowsDexterTools, "Root decision: new first-use configurations route Dexter tools")
        XCTAssertEqual(preset.claudePath, "/opt/homebrew/bin/claude")
        XCTAssertNil(preset.codexPath)
        XCTAssertNil(preset.mcpOnePassword); XCTAssertNil(preset.localDeviceCustody)
        XCTAssertEqual(FirstUseEnginePlan.make(stored: .missing, kind: .codex, candidates: found), .notFound)
        let explicitOff = LocalEnginePreference(allowsLocalEngines: false, claudePath: "/opt/homebrew/bin/claude", allowsDexterTools: false)
        XCTAssertEqual(FirstUseEnginePlan.make(stored: .saved(explicitOff), kind: .claude, candidates: found), .preserveExisting)
        let toolsOff = LocalEnginePreference(allowsLocalEngines: true, claudePath: "/opt/homebrew/bin/claude", allowsDexterTools: false)
        XCTAssertEqual(FirstUseEnginePlan.make(stored: .saved(toolsOff), kind: .claude, candidates: found), .alreadyChosen,
                       "An explicit tools-off choice is kept: nothing is rewritten")
        XCTAssertEqual(FirstUseEnginePlan.make(stored: .saved(toolsOff), kind: .codex, candidates: found), .preserveExisting)
        XCTAssertEqual(FirstUseEnginePlan.make(stored: .unreadable, kind: .claude, candidates: found), .preserveExisting)
        XCTAssertEqual(toolsOff.enablingDexterTools().allowsDexterTools, true)
        XCTAssertEqual(toolsOff.enablingDexterTools().claudePath, toolsOff.claudePath)
    }

    // MARK: First-use bot creation: one POST, reconcile by reading

    private func makeModel(_ wire: Wave2Host, port: Int) async throws -> DexterAppModel {
        let pairing = PairedHostOnboarding(journal: UnavailableClientClaimJournal(), storage: EphemeralPairedHostStateStorage(),
                                           identityStorage: { _ in Wave2ForbiddenIdentityStorage() })
        let model = DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: wire),
                                   storage: Wave2Storage(), pairing: pairing)
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        return model
    }

    func testCreatedBotIsAdoptedAndSelected() async throws {
        let wire = Wave2Host(); let model = try await makeModel(wire, port: 49_881)
        let outcome = await model.createFirstUseBot(name: "Assistente", engine: .claude)
        guard case .created(let id) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(model.selectedBotID, id)
        XCTAssertEqual(model.bots.first { $0.id == id }?.engine, .claude)
        let posts = await wire.botPosts()
        XCTAssertEqual(posts, 1)
    }

    func testDefinitiveRefusalIsReportedAndNothingWasCreated() async throws {
        let wire = Wave2Host(); await wire.nextBotPost(.status(400))
        let model = try await makeModel(wire, port: 49_882)
        guard case .refused = await model.createFirstUseBot(name: "Assistente", engine: .claude) else { return XCTFail() }
        XCTAssertTrue(model.bots.isEmpty)
    }

    func testUncertainCreationIsNeverResentAndReconcilesByReading() async throws {
        let wire = Wave2Host(); await wire.nextBotPost(.committedThenOffline)
        let model = try await makeModel(wire, port: 49_883)
        guard case .unconfirmed(let attempt) = await model.createFirstUseBot(name: "Assistente", engine: .claude) else { return XCTFail() }
        var posts = await wire.botPosts(); XCTAssertEqual(posts, 1)
        guard case .created(let id) = await model.reconcileFirstUseBot(attempt) else { return XCTFail() }
        XCTAssertEqual(model.selectedBotID, id)
        posts = await wire.botPosts(); XCTAssertEqual(posts, 1, "Conferir reads the list; it never POSTs")
    }

    func testReconcileReportsNotFoundAndAmbiguousWithoutPosting() async throws {
        let wire = Wave2Host(); await wire.nextBotPost(.notCommittedOffline)
        let model = try await makeModel(wire, port: 49_884)
        guard case .unconfirmed(let attempt) = await model.createFirstUseBot(name: "Assistente", engine: .claude) else { return XCTFail() }
        guard case .notFound = await model.reconcileFirstUseBot(attempt) else { return XCTFail() }
        await wire.insertBot(name: "Assistente", engine: "claude"); await wire.insertBot(name: "Assistente", engine: "claude")
        guard case .ambiguous(let count) = await model.reconcileFirstUseBot(attempt) else { return XCTFail() }
        XCTAssertEqual(count, 2)
        let posts = await wire.botPosts(); XCTAssertEqual(posts, 1)
    }

    func testReconcileAfterHostSwitchIsStale() async throws {
        let wire = Wave2Host(); await wire.nextBotPost(.committedThenOffline)
        let model = try await makeModel(wire, port: 49_885)
        guard case .unconfirmed(let attempt) = await model.createFirstUseBot(name: "Assistente", engine: .claude) else { return XCTFail() }
        model.hostAddress = "http://127.0.0.1:49886"; model.configureHost()
        let awaited1 = await model.reconcileFirstUseBot(attempt)
        XCTAssertEqual(awaited1, .stale)
    }

    // MARK: Welcome controller

    func testWelcomeOnRemoteManagedBaseCreatesBotAndRecordsCompletion() async throws {
        let wire = Wave2Host(); let model = try await makeModel(wire, port: 49_887)
        let store = InMemoryOnboardingWelcomeProgressStore()
        XCTAssertTrue(OnboardingWelcomeController.shouldPresent(model: model, store: store))
        let controller = OnboardingWelcomeController(model: model, localHost: nil, store: store, discover: { _ in [] })
        await controller.refresh()
        XCTAssertEqual(controller.cards.map(\.state), [.ready, .notInstalled])
        XCTAssertFalse(controller.managesThisMac)
        await controller.choose(.codex)
        XCTAssertEqual(controller.phase, .choosing, "A card that cannot be chosen does nothing")
        await controller.choose(.claude)
        guard case .finished(let id) = controller.phase else { return XCTFail("\(controller.phase)") }
        XCTAssertEqual(model.selectedBotID, id)
        XCTAssertEqual(store.progress, .completed)
        XCTAssertFalse(OnboardingWelcomeController.shouldPresent(model: model, store: store))
    }

    func testWelcomeLaterIsRememberedAndNeverRewritesPreferences() async throws {
        let wire = Wave2Host(); let model = try await makeModel(wire, port: 49_888)
        let store = InMemoryOnboardingWelcomeProgressStore()
        let controller = OnboardingWelcomeController(model: model, localHost: nil, store: store)
        controller.dismiss()
        XCTAssertEqual(store.progress, .dismissed)
        XCTAssertFalse(OnboardingWelcomeController.shouldPresent(model: model, store: store))
        let posts = await wire.botPosts(); XCTAssertEqual(posts, 0)
    }

    func testWelcomeUnconfirmedCreationOffersOnlyConferir() async throws {
        let wire = Wave2Host(); await wire.nextBotPost(.committedThenOffline)
        let model = try await makeModel(wire, port: 49_889)
        let store = InMemoryOnboardingWelcomeProgressStore()
        let controller = OnboardingWelcomeController(model: model, localHost: nil, store: store, discover: { _ in [] })
        await controller.refresh()
        await controller.choose(.claude)
        XCTAssertEqual(controller.phase, .failed(.createUnconfirmed))
        await controller.createAgain()
        var posts = await wire.botPosts(); XCTAssertEqual(posts, 1, "Criar de novo is only offered after Conferir found nothing")
        await controller.confirmCreation()
        guard case .finished = controller.phase else { return XCTFail("\(controller.phase)") }
        posts = await wire.botPosts(); XCTAssertEqual(posts, 1)
    }

    func testManagedMacCardsFollowSavedChoice() async throws {
        let wire = Wave2Host(claudeAvailable: false); let model = try await makeModel(wire, port: 49_890)
        let defaults = Wave2MemoryDefaults(), store = LocalEnginePreferenceStore(defaults: defaults, key: "wave2")
        let host = LocalHostLaunchCoordinator(packaged: LocalHostLaunchConfiguration(node: URL(fileURLWithPath: "/nonexistent/node"),
            cli: URL(fileURLWithPath: "/nonexistent/cli.js"), dataDir: URL(fileURLWithPath: "/nonexistent/data"), port: 1),
            enginePreferences: store, makeSupervisor: { LocalHostSupervisor(configuration: $0) })
        let discover: @MainActor (LocalEngineKind) -> [LocalEngineCandidate] = { $0 == .claude ? [self.candidate(.claude, "/opt/homebrew/bin/claude")] : [] }
        let controller = OnboardingWelcomeController(model: model, localHost: host, store: InMemoryOnboardingWelcomeProgressStore(), discover: discover)
        await controller.refresh()
        XCTAssertTrue(controller.managesThisMac)
        XCTAssertEqual(controller.cards.map(\.state), [.foundOnThisMac, .notInstalled])
        XCTAssertTrue(store.save(LocalEnginePreference(allowsLocalEngines: false)))
        controller.recomputeCards()
        XCTAssertEqual(controller.cards.map(\.state), [.savedChoiceDiffers, .notInstalled], "An explicit off is never rewritten by first use")
        XCTAssertEqual(store.load(), .saved(LocalEnginePreference(allowsLocalEngines: false)))
    }

    // MARK: Browser Use: state, guided connect, preflight

    func testBrowserUseConnectionStateMatrix() {
        let off = BrowserUseConfiguration(hostID: "h", revision: 0, enabled: false, bots: [:])
        let on = BrowserUseConfiguration(hostID: "h", revision: 1, enabled: true, bots: [:])
        func status(_ unlocked: Bool) -> BrowserUseRuntimeStatus {
            try! JSONDecoder().decode(BrowserUseRuntimeStatus.self, from: JSONSerialization.data(withJSONObject: ["hostID": "h", "available": true,
                "activeTasks": 0, "cleanupPending": false, "credential": ["unlocked": unlocked, "expiresAt": unlocked ? (1 as Any) : NSNull()],
                "authentication": "unverified", "apiVersion": "v2"]))
        }
        func derive(owner: Bool = true, deliver: Bool = true, _ key: BrowserUseKeyStatus, _ config: BrowserUseConfiguration?, _ runtime: BrowserUseRuntimeStatus?,
                    failed: Bool = false, mark: BrowserUseCustodyLedger.Mark? = nil) -> BrowserUseConnectionState {
            .derive(ownerLocal: owner, canDeliver: deliver, keyStatus: key, configuration: config, runtime: runtime, loadFailed: failed, mark: mark)
        }
        XCTAssertEqual(derive(owner: false, .configured, on, status(true)), .unavailableHere)
        XCTAssertEqual(derive(.missing, nil, nil), .checking)
        XCTAssertEqual(derive(.missing, nil, nil, failed: true), .cannotConfirm)
        XCTAssertEqual(derive(.missing, off, status(false)), .notConnected)
        XCTAssertEqual(derive(.configured, on, status(false)), .needsReconnect, "Saved key is not a ready connection")
        XCTAssertEqual(derive(.configured, on, status(false), mark: .paused), .paused)
        XCTAssertEqual(derive(.configured, on, status(false), mark: .uncertain), .cannotConfirm)
        XCTAssertEqual(derive(.configured, on, nil), .cannotConfirm)
        XCTAssertEqual(derive(.configured, off, status(true)), .needsEnable)
        XCTAssertEqual(derive(.configured, on, status(true), mark: .uncertain), .connected, "Unlocked is a confirmed host fact")
        XCTAssertEqual(derive(deliver: false, .configured, on, status(false)), .unavailableHere, "No local custody for a base this app did not start")
        XCTAssertEqual(derive(.unavailable, on, status(false)), .storageUnavailable)
    }

    private func browserSetup(_ wire: Wave2Host, port: Int) async throws -> (DexterAppModel, BrowserUseConnectionController, Wave2Bridge, InMemoryBrowserUseAPIKeyStore, BrowserUseCustodyLedger) {
        let model = try await makeModel(wire, port: port)
        let client = HostClient(baseURL: URL(string: model.hostAddress)!, transport: wire)
        let editor = BrowserUseSettingsEditor(model: model, clientFactory: { client })
        let bridge = Wave2Bridge(wire: wire), keys = InMemoryBrowserUseAPIKeyStore(), ledger = BrowserUseCustodyLedger()
        let controller = BrowserUseConnectionController(model: model, editor: editor, keyStore: keys, bridge: bridge, ledger: ledger)
        await editor.reloadAndWait()
        controller.refreshKeyStatus()
        return (model, controller, bridge, keys, ledger)
    }

    func testConnectConfirmsEachStepAndShowsConnectedOnlyAfterHostStatus() async throws {
        let wire = Wave2Host()
        let (_, controller, bridge, keys, _) = try await browserSetup(wire, port: 49_891)
        XCTAssertEqual(controller.state, .notConnected)
        await controller.connect(key: "  synthetic-browser-use-key-0001  ")
        XCTAssertEqual(controller.steps, [.keySaved: .confirmed, .delivered: .confirmed, .enabled: .confirmed])
        XCTAssertEqual(controller.outcome, .connected)
        XCTAssertEqual(controller.state, .connected)
        XCTAssertEqual(try keys.load(hostID: "host_wave2"), "synthetic-browser-use-key-0001")
        XCTAssertEqual(bridge.deliveries, ["set"])
        let patches = await wire.browserPatches(); XCTAssertEqual(patches, [0])
    }

    func testLostAcknowledgementIsUncertainAndNothingIsResent() async throws {
        let wire = Wave2Host()
        let (_, controller, bridge, _, _) = try await browserSetup(wire, port: 49_892)
        bridge.behavior = .lostAck
        await controller.connect(key: "synthetic-browser-use-key-0002")
        XCTAssertEqual(controller.steps[.delivered], .uncertain)
        XCTAssertEqual(controller.steps[.enabled], .pending, "No later step after an unconfirmed one")
        XCTAssertEqual(controller.state, .cannotConfirm)
        XCTAssertEqual(bridge.deliveries, ["set"])
        let patches = await wire.browserPatches(); XCTAssertEqual(patches, [])
        // Conferir only reads; once the base reports the connection unlocked, the mark clears.
        await wire.setUnlocked(true)
        await controller.check()
        XCTAssertEqual(bridge.deliveries, ["set"])
        XCTAssertEqual(controller.state, .needsEnable)
    }

    func testEnableConflictIsReReadNeverRePatched() async throws {
        let wire = Wave2Host()
        let (_, controller, _, _, _) = try await browserSetup(wire, port: 49_893)
        await wire.conflictNextPatch()
        await controller.connect(key: "synthetic-browser-use-key-0003")
        XCTAssertEqual(controller.steps[.enabled], .failed)
        XCTAssertEqual(controller.outcome, .enableConflict)
        let patches = await wire.browserPatches(); XCTAssertEqual(patches, [0], "One PATCH; the conflict is re-read, not re-sent")
        XCTAssertEqual(controller.state, .needsEnable)
    }

    func testPauseKeepsKeyAndDisconnectRemovesItOnlyAfterConfirmedLock() async throws {
        let wire = Wave2Host()
        let (_, controller, bridge, keys, _) = try await browserSetup(wire, port: 49_894)
        await controller.connect(key: "synthetic-browser-use-key-0004")
        await controller.pause()
        XCTAssertEqual(controller.state, .paused)
        XCTAssertEqual(keys.status(hostID: "host_wave2"), .configured)
        await controller.reconnect()
        XCTAssertEqual(controller.state, .connected)
        bridge.behavior = .lostAck
        await controller.disconnect()
        XCTAssertEqual(controller.outcome, .lockUnconfirmed)
        XCTAssertEqual(keys.status(hostID: "host_wave2"), .configured, "An unconfirmed lock keeps the key")
        bridge.behavior = .ack
        await controller.disconnect()
        XCTAssertEqual(controller.outcome, .disconnected)
        XCTAssertEqual(keys.status(hostID: "host_wave2"), .missing)
        XCTAssertEqual(bridge.deliveries, ["set", "lock", "set", "lock", "lock"])
    }

    private func preflightSetup(_ wire: Wave2Host, port: Int) async throws -> (DexterAppModel, Action, String, Wave2Bridge, InMemoryBrowserUseAPIKeyStore, BrowserUseCustodyLedger, BrowserUseApprovalPreflight) {
        await wire.insertBot(name: "Navegador (sintético)", engine: "claude")
        let model = try await makeModel(wire, port: port)
        let bot = try XCTUnwrap(model.bots.first)
        model.selectBot(id: bot.id)
        let awaited2 = await model.openConversationForSelectedBot(bot.id)
        XCTAssertTrue(awaited2)
        let thread = try XCTUnwrap(model.presentedThreadID)
        await wire.addAction(botID: bot.id, threadID: thread, tool: BrowserUseApprovalPreflight.tool)
        await model.openThread(thread)
        let action = try XCTUnwrap(model.actions(for: thread).first)
        let bridge = Wave2Bridge(wire: wire), keys = InMemoryBrowserUseAPIKeyStore(), ledger = BrowserUseCustodyLedger()
        let url = URL(string: model.hostAddress)!
        // Like makeLocalMcpClient: a fresh client per read, closed by the preflight after use.
        let preflight = BrowserUseApprovalPreflight(model: model, bridge: bridge, keyStore: keys, ledger: ledger,
                                                    clientFactory: { HostClient(baseURL: url, transport: wire) })
        return (model, action, thread, bridge, keys, ledger, preflight)
    }

    func testPermitirReconnectsOnceForThisActionThenProceeds() async throws {
        let wire = Wave2Host()
        let (_, action, thread, bridge, keys, _, preflight) = try await preflightSetup(wire, port: 49_895)
        try keys.save("synthetic-browser-use-key-0005", hostID: "host_wave2")
        let awaited3 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited3, .proceed)
        XCTAssertEqual(bridge.deliveries, ["set"])
        let awaited4 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited4, .proceed)
        XCTAssertEqual(bridge.deliveries, ["set"], "Already unlocked: nothing is delivered again")
    }

    func testPermitirNeverReopensPausedOrUncertainAndNeverSendsWithoutCustody() async throws {
        let wire = Wave2Host()
        let (_, action, thread, bridge, keys, ledger, preflight) = try await preflightSetup(wire, port: 49_896)
        let awaited5 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited5, .refused(.noKey))
        try keys.save("synthetic-browser-use-key-0006", hostID: "host_wave2")
        let child = try XCTUnwrap(bridge.lifetime)
        ledger.set(.paused, hostID: "host_wave2", lifetime: child)
        let awaited6 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited6, .refused(.paused))
        ledger.set(.uncertain, hostID: "host_wave2", lifetime: child)
        let awaited7 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited7, .refused(.uncertain))
        ledger.set(nil, hostID: "host_wave2", lifetime: child)
        bridge.behavior = .lostAck
        let awaited8 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited8, .refused(.uncertain))
        XCTAssertEqual(ledger.mark(hostID: "host_wave2", lifetime: child), .uncertain)
        XCTAssertEqual(bridge.deliveries, ["set"], "One delivery attempt; the lost acknowledgement is not retried")
        // A base this app did not start (no bridge lifetime): the decision goes unchanged, no key is sent.
        bridge.lifetime = nil
        let awaited9 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited9, .proceed)
        XCTAssertEqual(bridge.deliveries, ["set"])
    }

    func testPreflightIgnoresOtherToolsAndStaleActions() async throws {
        let wire = Wave2Host()
        let (model, action, thread, bridge, keys, _, preflight) = try await preflightSetup(wire, port: 49_897)
        try keys.save("synthetic-browser-use-key-0007", hostID: "host_wave2")
        let other = Action(id: "action-other", request: ActionRequest(botId: action.request.botId, threadId: thread, tool: "dexter.harness.terminal.run",
            destination: "host", arguments: [:], idempotencyKey: "k"), requestHash: "h", grantRevision: 0, state: .awaitingApproval,
            createdAt: 1, updatedAt: 1, approvalExpiresAt: nil, decidedBy: nil, result: nil, reason: nil, authorization: nil,
            approvalRequirement: nil, approvalType: nil)
        let awaited10 = await preflight.prepare(other, threadID: thread)
        XCTAssertEqual(awaited10, .proceed)
        let awaited11 = await preflight.prepare(action, threadID: "another-thread")
        XCTAssertEqual(awaited11, .proceed, "Only the action's own conversation")
        model.selectBot(id: nil)
        let awaited12 = await preflight.prepare(action, threadID: thread)
        XCTAssertEqual(awaited12, .refused(.changed))
        XCTAssertEqual(bridge.deliveries, [])
    }
}

// MARK: - Synthetic pieces

@MainActor private final class Wave2Storage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}

private actor Wave2ForbiddenIdentityStorage: ClientIdentityStorage {
    func load(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity? { throw ClientIdentityFailure.forbidden }
    func provision(_ scope: ClientIdentityScope) async throws -> ClientNativeIdentity { throw ClientIdentityFailure.forbidden }
}

private final class Wave2MemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "com.dexter.tests.wave2.\(UUID().uuidString)")! }
    override func object(forKey defaultName: String) -> Any? { lock.lock(); defer { lock.unlock() }; return values[defaultName] }
    override func set(_ value: Any?, forKey defaultName: String) { lock.lock(); defer { lock.unlock() }; values[defaultName] = value }
}

@MainActor private final class Wave2Bridge: BrowserUseKeyBridge {
    enum Behavior { case ack, lostAck }
    let wire: Wave2Host
    var behavior = Behavior.ack
    var lifetime: UUID? = UUID()
    private(set) var deliveries: [String] = []
    init(wire: Wave2Host) { self.wire = wire }
    func deliveryLifetime(hostID: String) -> UUID? { hostID == "host_wave2" ? lifetime : nil }
    func deliver(_ key: String?, hostID: String) async throws {
        guard lifetime != nil else { throw BrowserUseKeyFailure.bridgeUnavailable }
        deliveries.append(key == nil ? "lock" : "set")
        guard behavior == .ack else { throw BrowserUseKeyFailure.bridgeUnconfirmed }
        await wire.setUnlocked(key != nil)
    }
}

private actor Wave2Host: HTTPTransport {
    enum BotPost { case created, status(Int), committedThenOffline, notCommittedOffline }
    private let claudeAvailable: Bool
    private var bots: [[String: Any]] = []
    private var botPostQueue: [BotPost] = []
    private var botPostCount = 0
    private var threads: [String: String] = [:]
    private var actions: [[String: Any]] = []
    private var unlocked = false
    private var browserRevision = 0
    private var browserEnabled = false
    private var conflictNext = false
    private var patches: [Int] = []

    init(claudeAvailable: Bool = true) { self.claudeAvailable = claudeAvailable }

    func nextBotPost(_ behavior: BotPost) { botPostQueue.append(behavior) }
    func botPosts() -> Int { botPostCount }
    func insertBot(name: String, engine: String) { bots.append(bot(name: name, engine: engine)) }
    func setUnlocked(_ value: Bool) { unlocked = value }
    func conflictNextPatch() { conflictNext = true }
    func browserPatches() -> [Int] { patches }
    func addAction(botID: String, threadID: String, tool: String) {
        actions.append(["id": "action-browser-1", "request": ["botId": botID, "threadId": threadID, "tool": tool, "destination": "browser-use",
            "arguments": [:], "idempotencyKey": "idem-1"], "requestHash": "hash-1", "grantRevision": 0, "state": "awaiting_approval",
            "createdAt": 1, "updatedAt": 1, "approvalExpiresAt": NSNull()])
    }

    private func bot(name: String, engine: String) -> [String: Any] {
        ["id": "bot_wave2_\(bots.count + 1)", "name": name, "profileId": "default", "ownerId": "owner_wave2", "engine": engine,
         "revision": 0, "createdAt": bots.count + 1]
    }
    private func json(_ value: Any, status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: value))
    }
    private func browserStatus() throws -> TransportResponse {
        try json(["hostID": "host_wave2", "available": true, "activeTasks": 0, "cleanupPending": false,
                  "credential": ["unlocked": unlocked, "expiresAt": unlocked ? (9_999_999_999_999 as Any) : NSNull()],
                  "authentication": "unverified", "apiVersion": "v2"])
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        switch (method, path) {
        case ("GET", "/health"):
            return try json(["protocolVersion": 1, "mode": "local-development", "engineRouting": "connected", "remotePairing": "not_implemented",
                             "hostId": "host_wave2", "state": [:], "runtime": ["engines": ["claude", "codex"]]])
        case ("GET", "/v1/bots"): return try json(["items": bots])
        case ("POST", "/v1/bots"):
            botPostCount += 1
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            let created = bot(name: input["name"] as! String, engine: input["engine"] as! String)
            switch botPostQueue.isEmpty ? .created : botPostQueue.removeFirst() {
            case .created: bots.append(created); return try json(created, status: 201)
            case .status(let code): return try json(["error": "refused"], status: code)
            case .committedThenOffline: bots.append(created); throw URLError(.networkConnectionLost)
            case .notCommittedOffline: throw URLError(.networkConnectionLost)
            }
        case ("GET", "/v1/engines/catalog"):
            return try json(["items": [
                ["id": "claude", "available": claudeAvailable, "installed": claudeAvailable, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": []],
                ["id": "codex", "available": false, "installed": false, "adapterSupported": true, "models": [], "reasoningEfforts": [], "speeds": []]]])
        case ("GET", "/v1/actions"): return try json(["items": actions])
        case ("GET", "/v1/browser-use/status"): return try browserStatus()
        case ("GET", "/v1/browser-use/config"):
            return try JSONEncoder().encode(BrowserUseConfiguration(hostID: "host_wave2", revision: browserRevision, enabled: browserEnabled, bots: [:]))
                .withStatus(200)
        case ("PATCH", "/v1/browser-use/config"):
            let input = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            patches.append(input["expectedRevision"] as? Int ?? -1)
            if conflictNext { conflictNext = false; browserRevision += 1; return try json(["error": "conflict"], status: 409) }
            guard input["expectedRevision"] as? Int == browserRevision else { return try json(["error": "conflict"], status: 409) }
            browserEnabled = input["enabled"] as? Bool ?? browserEnabled; browserRevision += 1
            return try JSONEncoder().encode(BrowserUseConfiguration(hostID: "host_wave2", revision: browserRevision, enabled: browserEnabled, bots: [:]))
                .withStatus(200)
        default: break
        }
        if method == "POST", path.hasPrefix("/v1/bots/"), path.hasSuffix("/threads") {
            let botID = String(path.dropFirst("/v1/bots/".count).dropLast("/threads".count))
            let id = "thr_wave2_\(threads.count + 1)"; threads[id] = botID
            return try json(["id": id, "botId": botID, "createdAt": threads.count], status: 201)
        }
        if method == "GET", path.hasPrefix("/v1/threads/"), path.hasSuffix("/messages") || path.hasSuffix("/turns") {
            return try json(["items": [], "nextCursor": 0])
        }
        if method == "GET", path.hasPrefix("/v1/threads/"), path.hasSuffix("/engine-selection") {
            return try json(["selection": ["engine": "claude", "model": NSNull(), "reasoningEffort": NSNull(), "speed": NSNull()],
                             "override": NSNull(), "revision": 0, "handoffStatus": "none", "updatedBot": NSNull()])
        }
        if method == "GET", path.hasPrefix("/v1/threads/") {
            let id = String(path.dropFirst("/v1/threads/".count))
            guard let botID = threads[id] else { return try json(["error": "not_found"], status: 404) }
            return try json(["id": id, "botId": botID, "createdAt": 1])
        }
        if method == "GET", ["/v1/events", "/v1/teams", "/v1/live-voice/settings", "/v1/devices"].contains(path) {
            return try json(["items": [], "nextCursor": 0])
        }
        return try json(["error": "not_found"], status: 404)
    }
}

private extension Data {
    func withStatus(_ status: Int) -> TransportResponse { TransportResponse(statusCode: status, data: self) }
}
#endif
