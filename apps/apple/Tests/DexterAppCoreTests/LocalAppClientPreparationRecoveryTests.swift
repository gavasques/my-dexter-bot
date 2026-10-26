#if os(macOS)
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// All state is owned by this fixture. No defaults domain is read/written and no Security backend is constructed.
private final class AppRecoveryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "com.dexter.tests.app-recovery." + UUID().uuidString.lowercased())! }
    override func object(forKey key: String) -> Any? { lock.withLock { values[key] } }
    override func set(_ value: Any?, forKey key: String) { lock.withLock { values[key] = value } }
    var keys: [String] { lock.withLock { Array(values.keys) } }
}
@MainActor private final class AppRecoveryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}
private actor AppRecoveryTransport: HTTPTransport {
    private var methods: [String] = []
    private var hostID = "host_A", ownerID = "owner_A"
    func identity(host: String, owner: String) { hostID = host; ownerID = owner }
    func recordedMethods() -> [String] { methods }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        methods.append(request.httpMethod ?? "GET")
        let value: [String: Any]
        switch request.url!.path {
        case "/health": value = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "host",
                                 "remotePairing": "not_implemented", "hostId": hostID, "ownerId": ownerID, "state": [:]]
        default: value = ["items": [], "nextCursor": 0]
        }
        return .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: value))
    }
}
@MainActor private final class AppRecoveryUnlockStore: LocalHostUnlockStore {
    private var values: [String: Data] = [:]
    private(set) var creates: [String] = []
    private(set) var loads: [String] = []
    private(set) var resumes: [String] = []
    private var creationIDs: [String: String] = [:]
    var overriddenStatus: [String: LocalHostUnlockStatus] = [:]
    var onCreate: ((LocalHostUnlockScope, String) -> Void)?
    var createFailure: LocalHostUnlockFailure?
    func seed(_ path: String) { values[path] = Data(repeating: 0x51, count: 32) }
    func seedPending(_ path: String, creationID: String) { seed(path); creationIDs[path] = creationID }
    func status(scope: LocalHostUnlockScope) -> LocalHostUnlockStatus {
        if let value = overriddenStatus[scope.custodyFilePath] { return value }
        guard values[scope.custodyFilePath] != nil else { return .missing }
        return FileManager.default.fileExists(atPath: scope.custodyFilePath) ? .configured : .blocked
    }
    func create(scope: LocalHostUnlockScope, creationId: String) throws -> OwnedLocalHostUnlockBytes {
        let path = scope.custodyFilePath
        onCreate?(scope, creationId)
        if let createFailure { throw createFailure }
        guard values[path] == nil else { throw LocalHostUnlockFailure.alreadyExists }
        let bytes = Data(repeating: 0x52, count: 32)
        values[path] = bytes; creationIDs[path] = creationId; creates.append(path)
        return try XCTUnwrap(OwnedLocalHostUnlockBytes(bytes: bytes, creationId: creationId))
    }
    func load(scope: LocalHostUnlockScope) throws -> OwnedLocalHostUnlockBytes {
        loads.append(scope.custodyFilePath)
        return try XCTUnwrap(OwnedLocalHostUnlockBytes(bytes: try XCTUnwrap(values[scope.custodyFilePath])))
    }
    func creationInfo(scope: LocalHostUnlockScope) throws -> LocalHostUnlockCreationInfo? {
        creationIDs[scope.custodyFilePath].map { .init(creationId: $0, requestHash: "synthetic-public-request-hash") }
    }
    func loadPendingCreation(scope: LocalHostUnlockScope, expectedCreationId: String) throws -> OwnedLocalHostUnlockBytes {
        let path = scope.custodyFilePath; resumes.append(path)
        guard creationIDs[path] == expectedCreationId, !FileManager.default.fileExists(atPath: path), let bytes = values[path] else {
            throw LocalHostUnlockFailure.conflict
        }
        return try XCTUnwrap(OwnedLocalHostUnlockBytes(bytes: bytes, creationId: expectedCreationId))
    }
}

@MainActor private final class AppRecoveryChildren {
    enum Behavior {
        case ready(host: String = "host_A", owner: String = "owner_A")
        case failedExit(String)
        case heldFailure(String)
    }
    var plans: [Behavior] = []
    var children: [AppRecoveryChild] = []
    var supervisors: [LocalHostSupervisor] = []
    var events: [String] = []
    var candidateHoldsStop = false
    var onStop: (() -> Void)?
    func supervisor(_ config: LocalHostLaunchConfiguration) -> LocalHostSupervisor {
        let supervisor = LocalHostSupervisor(configuration: config, makeChild: { [unowned self] config, _ in
            // A writer must be observed to leave before a replacement is even constructed.
            XCTAssertTrue(children.allSatisfy { !$0.isRunning }, "second child created before the previous child exited")
            let behavior = plans.isEmpty ? .ready() : plans.removeFirst()
            let child = AppRecoveryChild(index: children.count, configuration: config, behavior: behavior, event: { [unowned self] in events.append($0) }, onStop: { [unowned self] in onStop?() })
            if config.appClientChannel != nil { child.holdStop = candidateHoldsStop }
            children.append(child); events.append("create:\(child.index)")
            return child
        }, portIsFree: { _ in true })
        supervisors.append(supervisor)
        return supervisor
    }
    func close() { children.forEach { $0.exit() } }
}

/// Fake child only. It never invokes Node, binds sockets, decrypts material or reads real process output.
@MainActor private final class AppRecoveryChild: LocalHostChild {
    let index: Int
    let configuration: LocalHostLaunchConfiguration
    let behavior: AppRecoveryChildren.Behavior
    private let event: (String) -> Void
    private let onStop: () -> Void
    var holdStop = false
    private(set) var stopRequests = 0
    private(set) var privateFrames = 0
    private(set) var isRunning = false
    private var status: Int32 = 0
    var terminationStatus: Int32 { status }
    private var onExit: (@Sendable () -> Void)?
    private var onStderr: (@Sendable (Data) -> Void)?
    init(index: Int, configuration: LocalHostLaunchConfiguration, behavior: AppRecoveryChildren.Behavior, event: @escaping (String) -> Void, onStop: @escaping () -> Void) {
        self.index = index; self.configuration = configuration; self.behavior = behavior; self.event = event; self.onStop = onStop
    }
    func providePrivateInput(_ bytes: Data) throws {
        XCTAssertEqual(bytes.count, 32); XCTAssertFalse(isRunning); privateFrames += 1
    }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        isRunning = true; self.onExit = onExit; self.onStderr = onStderr; event("run:\(index)")
        if let channel = configuration.appClientChannel, channel.action == .create {
            // Public fake ciphertext marker in this test's private directory, never an actual credential.
            let url = URL(fileURLWithPath: channel.custodyFile)
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
            try Data("SYNTHETIC CIPHERTEXT".utf8).write(to: url, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }
        switch behavior {
        case .ready(let host, let owner):
            let frame: [String: Any] = ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
                "hostId": host, "ownerId": owner,
                "engineExecution": configuration.enableEngines ? "enabled" : "disabled",
                "mcpGateway": configuration.enableMcp ? "enabled" : "disabled",
                "deviceTurnTools": configuration.localDeviceCustody?.allowsDeviceTools == true ? "enabled" : "disabled",
                "deviceChannel": configuration.localDeviceCustody == nil ? ["status": "unconfigured"] : ["status": "listening", "url": "https://127.0.0.1:4318"],
                "appClientChannel": configuration.appClientChannel.map { ["status": "listening", "url": $0.origin] } ?? ["status": "unconfigured"]]
            let data = try JSONSerialization.data(withJSONObject: frame)
            Task { @MainActor in onStdout(data) }
        case .failedExit(let reason):
            Task { @MainActor in failAndExit(reason) }
        case .heldFailure:
            break
        }
    }
    func failAndExit(_ reason: String? = nil) {
        let fallback: String
        if case .heldFailure(let reason) = behavior { fallback = reason } else { fallback = "invalid_input: synthetic failure" }
        onStderr?(Data((reason ?? fallback).utf8)); status = 2; exit()
    }
    func requestGracefulStop() { stopRequests += 1; event("stop:\(index)"); onStop(); if !holdStop { exit() } }
    func exit() {
        guard isRunning else { return }
        isRunning = false; event("exit:\(index)"); onExit?()
    }
}

@MainActor private final class AppRecoveryFixture {
    let root: URL
    let custodyRoot: URL
    let defaults = AppRecoveryDefaults()
    let unlock = AppRecoveryUnlockStore()
    let factory = AppRecoveryChildren()
    let transport = AppRecoveryTransport()
    let base: LocalHostLaunchConfiguration
    let store: LocalEnginePreferenceStore
    let localDevicePath: String?
    var addresses = ["100.64.0.99"]
    lazy var model = DexterAppModel(client: HostClient(baseURL: URL(string: base.hostAddress)!, transport: transport), storage: AppRecoveryStorage())
    lazy var coordinator = LocalHostLaunchCoordinator(packaged: base, enginePreferences: store, makeSupervisor: { [unowned self] in factory.supervisor($0) },
        stopGrace: .milliseconds(80), unlockStore: unlock, bundleID: "com.dexter.tests.recovery", appClientAddresses: { [unowned self] in addresses },
        appClientDefaults: defaults, appClientCustodyRoot: custodyRoot)
    lazy var preferences = LocalAppClientChannelPreferences(defaults: defaults, root: custodyRoot)

    init(withDevice: Bool = false) throws {
        let parent = ProcessInfo.processInfo.environment["DEXTER_TEST_PRIVATE_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".synthetic-app-recovery")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        root = parent.appendingPathComponent(UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        custodyRoot = root.appendingPathComponent("app-custody", isDirectory: true)
        for name in ["node", "codex", "cli.js"] {
            let file = root.appendingPathComponent(name)
            try Data("SYNTHETIC EXECUTABLE NEVER RUN".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        }
        base = LocalHostLaunchConfiguration(node: root.appendingPathComponent("node"), cli: root.appendingPathComponent("cli.js"),
                                           dataDir: root.appendingPathComponent("host"), browserUsePrivateInput: false)
        store = LocalEnginePreferenceStore(defaults: AppRecoveryDefaults(), key: "synthetic-engine-preference")
        if withDevice {
            let folder = root.appendingPathComponent("device", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let path = folder.appendingPathComponent("device.sealed").path
            localDevicePath = path
            try Self.sealed(path); unlock.seed(path)
            XCTAssertTrue(store.save(.init(allowsLocalEngines: true, codexPath: root.appendingPathComponent("codex").path,
                                          allowsDexterTools: true, localDeviceCustody: .init(filePath: path))))
        } else { localDevicePath = nil }
    }
    static func sealed(_ path: String) throws {
        try Data("SYNTHETIC CIPHERTEXT".utf8).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
    @discardableResult func seedSavedChannel(generation: String? = UUID().uuidString.lowercased()) throws -> LocalAppClientChannelConfiguration {
        let channel = try preferences.configuration(address: "100.64.0.99", host: base.dataDir, installationID: "host_A", ownerID: "owner_A", generation: generation, prepare: true)
        try Self.sealed(channel.custodyFile); unlock.seed(channel.custodyFile)
        try preferences.save(channel, host: base.dataDir, expected: .missing)
        return channel
    }
    func start(host: String = "host_A", owner: String = "owner_A") async {
        await transport.identity(host: host, owner: owner)
        await coordinator.initialRefresh(model: model)
        XCTAssertTrue(model.isOnline); XCTAssertEqual(model.browserUseHostID, host)
        XCTAssertEqual(coordinator.confirmedOwnedHostID, host)
    }
    func close() { unlock.onCreate = nil; factory.onStop = nil; factory.close(); try? FileManager.default.removeItem(at: root) }
}

@MainActor final class LocalAppClientPreparationRecoveryTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        return condition()
    }
    private func prepare(_ fixture: AppRecoveryFixture, renew: Bool = false) async -> LocalAppClientPreparationFailure? {
        do {
            if renew { _ = try await fixture.coordinator.renewAppClientChannel(model: fixture.model) }
            else { _ = try await fixture.coordinator.prepareAppClientChannel(model: fixture.model) }
            return nil
        }
        catch let failure as LocalAppClientPreparationFailure { return failure }
        catch { XCTFail("unexpected typed failure: \(type(of: error))"); return .outcomeUnknown }
    }
    private func successfulPreparation(_ fixture: AppRecoveryFixture, renew: Bool = false) async -> LocalAppClientPreparationResult? {
        do {
            if renew { return try await fixture.coordinator.renewAppClientChannel(model: fixture.model) }
            return try await fixture.coordinator.prepareAppClientChannel(model: fixture.model)
        } catch { XCTFail("expected a confirmed preparation result, got \(type(of: error))"); return nil }
    }
    private func assertReadsOnly(_ fixture: AppRecoveryFixture) async {
        let methods = await fixture.transport.recordedMethods()
        XCTAssertFalse(methods.isEmpty); XCTAssertTrue(methods.allSatisfy { $0 == "GET" })
    }

    func testSavedExpiredDecryptAndBindFailuresRestoreLocalChatOnceWithoutRekey() async throws {
        for diagnostic in ["invalid_input: synthetic expired certificate", "invalid_input: synthetic decrypt failure", "Host listener failed: synthetic private bind failure"] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            let channel = try fixture.seedSavedChannel()
            fixture.factory.plans = [.failedExit(diagnostic), .ready()]
            await fixture.coordinator.initialRefresh(model: fixture.model)
            XCTAssertEqual(fixture.factory.children.count, 2)
            XCTAssertEqual(fixture.factory.children.first?.configuration.appClientChannel, channel)
            XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
            XCTAssertEqual(fixture.coordinator.confirmedOwnedHostID, "host_A")
            XCTAssertTrue(fixture.model.isOnline)
            XCTAssertEqual(fixture.unlock.loads, [channel.custodyFile]); XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
            XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .saved(address: channel.address, installationID: "host_A", ownerID: "owner_A", generation: channel.generation))
            await fixture.coordinator.initialRefresh(model: fixture.model)
            XCTAssertEqual(fixture.factory.children.count, 2, "the startup/fallback pair is one-shot")
            await assertReadsOnly(fixture)
        }
    }

    func testPrepareWaitsForFailedCandidateExitThenRestoresOnlyLocalChatWithoutSecondCreate() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.heldFailure("invalid_input: synthetic expired certificate"), .ready()]
        let pending = Task { await successfulPreparation(fixture) }
        let arrived = await waitUntil { fixture.factory.children.count == 2 }; XCTAssertTrue(arrived)
        guard arrived else { pending.cancel(); _ = await pending.value; return }
        XCTAssertTrue(fixture.factory.children[1].isRunning)
        XCTAssertEqual(fixture.factory.children.count, 2, "no fallback while the failed candidate may still own the writer")
        XCTAssertEqual(fixture.unlock.creates.count, 1)
        fixture.factory.children[1].failAndExit()
        let result = await pending.value; XCTAssertEqual(result, .localChatOnly)
        XCTAssertEqual(fixture.factory.children.count, 3)
        XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel); XCTAssertTrue(fixture.model.isOnline)
        XCTAssertEqual(fixture.unlock.creates.count, 1); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        let events = fixture.factory.events
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of: "exit:0")), try XCTUnwrap(events.firstIndex(of: "create:1")))
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of: "exit:1")), try XCTUnwrap(events.firstIndex(of: "create:2")))
        await assertReadsOnly(fixture)
    }

    func testFallbackLoadsExistingLocalDeviceUnlockAndNeverRepeatsDeviceCreation() async throws {
        let fixture = try AppRecoveryFixture(withDevice: true); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.failedExit("Host listener failed: synthetic private bind failure"), .ready()]
        let result = await successfulPreparation(fixture); XCTAssertEqual(result, .localChatOnly)
        XCTAssertEqual(fixture.factory.children.count, 3)
        let fallback = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration)
        XCTAssertNil(fallback.appClientChannel); XCTAssertEqual(fallback.localDeviceCustodyAction, .unlock)
        XCTAssertEqual(fallback.localDeviceCustody?.filePath, fixture.localDevicePath)
        XCTAssertFalse(fixture.unlock.creates.contains(try XCTUnwrap(fixture.localDevicePath)))
        XCTAssertTrue(fixture.unlock.loads.contains(try XCTUnwrap(fixture.localDevicePath)))
        XCTAssertEqual(fixture.factory.children.last?.privateFrames, 1, "fallback receives only the existing local-device unlock")
        XCTAssertTrue(fixture.model.isOnline); await assertReadsOnly(fixture)
    }

    func testEngineApplyKnownChannelFailurePreservesNewEngineChoiceAndRestoresLocalChatOnly() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let channel = try fixture.seedSavedChannel()
        await fixture.start()
        fixture.factory.plans = [.failedExit("invalid_input: synthetic expired certificate"), .ready()]
        let choice = LocalEnginePreference(allowsLocalEngines: true, codexPath: fixture.root.appendingPathComponent("codex").path)
        let phase = await fixture.coordinator.applyLocalEnginePreference(choice, model: fixture.model)
        XCTAssertEqual(phase, .applied)
        XCTAssertEqual(fixture.factory.children.count, 3)
        let fallback = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration)
        XCTAssertTrue(fallback.enableEngines); XCTAssertNil(fallback.appClientChannel)
        XCTAssertEqual(fixture.store.load(), .saved(choice)); XCTAssertTrue(fixture.model.isOnline)
        XCTAssertEqual(fixture.unlock.loads, [channel.custodyFile, channel.custodyFile])
        XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .saved(address: channel.address, installationID: "host_A", ownerID: "owner_A", generation: channel.generation))
        XCTAssertTrue(fixture.coordinator.isCurrentlyApplied(choice), "the optional channel failure must not leave the engine choice pending")
        await assertReadsOnly(fixture)
    }

    func testUncertainOldStopRetainsWriterAndNeverStartsCandidateOrFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.children[0].holdStop = true
        let failure = await prepare(fixture); XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertTrue(fixture.coordinator.ownsLiveChild)
        XCTAssertEqual(fixture.coordinator.supervisor?.state, .stopUncertain)
        XCTAssertTrue(fixture.coordinator.supervisor === fixture.factory.supervisors[0])
        XCTAssertTrue(fixture.unlock.creates.isEmpty, "a new key cannot be created before the previous writer confirms exit")
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .missing)
    }

    func testCancellationDuringCandidateStartStopsOwnedCandidateWithoutFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.heldFailure("invalid_input: synthetic deferred failure")]
        let pending = Task { await prepare(fixture) }
        let arrived = await waitUntil { fixture.factory.children.count == 2 }; XCTAssertTrue(arrived)
        pending.cancel()
        let failure = await pending.value; XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2)
        if arrived { XCTAssertEqual(fixture.factory.children[1].stopRequests, 1); XCTAssertFalse(fixture.factory.children[1].isRunning) }
        XCTAssertFalse(fixture.coordinator.ownsLiveChild)
    }

    func testSelectionChangeAfterCandidateHandoffNeverStartsLocalFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.heldFailure("invalid_input: synthetic decrypt failure")]
        let pending = Task { await prepare(fixture) }
        let arrived = await waitUntil { fixture.factory.children.count == 2 }; XCTAssertTrue(arrived)
        guard arrived else { pending.cancel(); _ = await pending.value; return }
        fixture.model.useFixture()
        fixture.factory.children[1].failAndExit()
        let failure = await pending.value; XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2); XCTAssertTrue(fixture.model.isFixture)
        XCTAssertFalse(fixture.coordinator.ownsLiveChild)
    }

    func testWrongReadyHostIsStoppedAndNeverAcceptedOrRetriedAsLocalFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.ready(host: "host_B")]
        let failure = await prepare(fixture); XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2)
        XCTAssertEqual(fixture.factory.children[1].stopRequests, 1); XCTAssertFalse(fixture.factory.children[1].isRunning)
        XCTAssertFalse(fixture.coordinator.ownsLiveChild)
        XCTAssertEqual(fixture.unlock.creates.count, 1, "wrong host must not cause another custody attempt")
    }

    func testWrongReadyOwnerUncertainStopRetainsExactCandidateAndNeverStartsAnotherWriter() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.ready(owner: "owner_B")]
        fixture.factory.candidateHoldsStop = true
        let pending = Task { await prepare(fixture) }
        let arrived = await waitUntil { fixture.factory.children.count == 2 }; XCTAssertTrue(arrived)
        guard arrived else { pending.cancel(); _ = await pending.value; return }
        let failure = await pending.value; XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2); XCTAssertTrue(fixture.factory.children[1].isRunning)
        XCTAssertEqual(fixture.factory.children[1].stopRequests, 1)
        XCTAssertTrue(fixture.coordinator.supervisor === fixture.factory.supervisors[1])
        XCTAssertEqual(fixture.coordinator.supervisor?.state, .stopUncertain); XCTAssertTrue(fixture.coordinator.ownsLiveChild)
    }

    func testQuitDuringCandidateStartPreventsAutomaticLocalFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        await fixture.start()
        fixture.factory.plans = [.heldFailure("invalid_input: synthetic deferred failure")]
        let pending = Task { await prepare(fixture) }
        let arrived = await waitUntil { fixture.factory.children.count == 2 }; XCTAssertTrue(arrived)
        guard arrived else { pending.cancel(); _ = await pending.value; return }
        await fixture.coordinator.stopForTermination()
        let failure = await pending.value; XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2); XCTAssertFalse(fixture.coordinator.ownsLiveChild)
    }

    func testStartupStaleHostOrOwnerAcceptsFreshLocalIdentityAndDeactivatesOnlyOldMetadata() async throws {
        for identity in [("host_B", "owner_A"), ("host_A", "owner_B")] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            let old = try fixture.seedSavedChannel()
            let ciphertext = try Data(contentsOf: URL(fileURLWithPath: old.custodyFile))
            fixture.factory.plans = [.failedExit("conflict: synthetic old installation"), .ready(host: identity.0, owner: identity.1)]
            await fixture.start(host: identity.0, owner: identity.1)
            XCTAssertEqual(fixture.factory.children.count, 2)
            XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
            XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .inactive(address: old.address,
                installationID: old.installationID, ownerID: old.ownerID, generation: old.generation))
            XCTAssertFalse(fixture.model.errorMessage?.isEmpty ?? true)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: old.custodyFile)), ciphertext)
            XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
            await fixture.coordinator.initialRefresh(model: fixture.model)
            XCTAssertEqual(fixture.factory.children.count, 2)
            await assertReadsOnly(fixture)
        }
    }

    func testApplyStaleChannelPreferenceAcceptsFreshLocalIdentityAndActuallyAppliesEngine() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        fixture.factory.plans = [.ready(host: "host_B", owner: "owner_B")]
        await fixture.start(host: "host_B", owner: "owner_B")
        let old = try fixture.seedSavedChannel()
        fixture.factory.plans = [.failedExit("conflict: synthetic old installation"), .ready(host: "host_B", owner: "owner_B")]
        let choice = LocalEnginePreference(allowsLocalEngines: true, codexPath: fixture.root.appendingPathComponent("codex").path)
        let phase = await fixture.coordinator.applyLocalEnginePreference(choice, model: fixture.model)
        XCTAssertEqual(phase, .applied); XCTAssertTrue(fixture.coordinator.isCurrentlyApplied(choice))
        XCTAssertTrue(fixture.coordinator.currentEngineConfiguration?.enableEngines == true)
        XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertEqual(fixture.coordinator.confirmedOwnedHostID, "host_B"); XCTAssertTrue(fixture.model.isOnline)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .inactive(address: old.address,
            installationID: old.installationID, ownerID: old.ownerID, generation: old.generation))
        XCTAssertTrue(fixture.unlock.creates.isEmpty); await assertReadsOnly(fixture)
    }

    func testStartupPendingOldIdentityStartsFreshLocalBaseAndDeactivatesOnlyTheOldPointer() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let old = try fixture.seedSavedChannel()
        let oldBytes = try Data(contentsOf: URL(fileURLWithPath: old.custodyFile))
        try fixture.preferences.savePending(old, creationID: UUID().uuidString.lowercased(), host: fixture.base.dataDir,
            expected: fixture.preferences.load(host: fixture.base.dataDir))
        fixture.factory.plans = [.ready(host: "host_B", owner: "owner_B")]
        await fixture.start(host: "host_B", owner: "owner_B")
        XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .inactive(address: old.address,
            installationID: old.installationID, ownerID: old.ownerID, generation: old.generation))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: old.custodyFile)), oldBytes)
        XCTAssertTrue(fixture.unlock.loads.isEmpty); XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        await assertReadsOnly(fixture)
    }

    private func makeOptionalChannelUnavailable(_ state: String, fixture: AppRecoveryFixture) throws {
        let channel = try fixture.seedSavedChannel()
        switch state {
        case "missing": fixture.unlock.overriddenStatus[channel.custodyFile] = .missing
        case "blocked": fixture.unlock.overriddenStatus[channel.custodyFile] = .blocked
        case "legacy": fixture.unlock.overriddenStatus[channel.custodyFile] = .legacyPasswordRequired
        case "unreadable": fixture.defaults.set(["synthetic-invalid": "metadata"], forKey: try XCTUnwrap(fixture.defaults.keys.first))
        case "pending": try fixture.preferences.savePending(channel, creationID: UUID().uuidString.lowercased(), host: fixture.base.dataDir,
            expected: fixture.preferences.load(host: fixture.base.dataDir))
        default: XCTFail("unknown fixture state")
        }
    }

    func testStartupAndApplyIgnoreUnavailableOptionalChannelWithoutCreatingOrResumingKeys() async throws {
        for state in ["missing", "blocked", "legacy", "unreadable", "pending"] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            try makeOptionalChannelUnavailable(state, fixture: fixture)
            await fixture.start()
            XCTAssertEqual(fixture.factory.children.count, 1, state)
            XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel, state)
            let choice = LocalEnginePreference(allowsLocalEngines: true, codexPath: fixture.root.appendingPathComponent("codex").path)
            let phase = await fixture.coordinator.applyLocalEnginePreference(choice, model: fixture.model)
            XCTAssertEqual(phase, .applied, state); XCTAssertTrue(fixture.coordinator.isCurrentlyApplied(choice), state)
            XCTAssertTrue(fixture.coordinator.currentEngineConfiguration?.enableEngines == true, state)
            XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel, state)
            XCTAssertEqual(fixture.store.load(), .saved(choice), state); XCTAssertTrue(fixture.model.isOnline, state)
            XCTAssertTrue(fixture.unlock.creates.isEmpty, state); XCTAssertTrue(fixture.unlock.resumes.isEmpty, state)
            XCTAssertTrue(fixture.unlock.loads.isEmpty, state)
            await assertReadsOnly(fixture)
        }
    }

    func testOptionalAppChannelFallbackDoesNotBypassRequiredDeviceUnlock() async throws {
        let fixture = try AppRecoveryFixture(withDevice: true); defer { fixture.close() }
        try makeOptionalChannelUnavailable("missing", fixture: fixture)
        fixture.unlock.overriddenStatus[try XCTUnwrap(fixture.localDevicePath)] = .blocked
        await fixture.start()
        guard case .saved(let choice) = fixture.store.load() else { return XCTFail("expected device fixture choice") }
        let phase = await fixture.coordinator.applyLocalEnginePreference(choice, model: fixture.model)
        XCTAssertEqual(phase, .refused(.unlockRequired))
        XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertTrue(fixture.factory.children[0].isRunning)
        XCTAssertTrue(fixture.unlock.creates.isEmpty)
    }

    func testRenewExpiredLikeChannelUsesNewGenerationAndKeyScopeAfterConfirmedExitWithoutOverwrite() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let old = try fixture.seedSavedChannel()
        let oldBytes = try Data(contentsOf: URL(fileURLWithPath: old.custodyFile))
        fixture.factory.plans = [.failedExit("invalid_input: synthetic expired certificate"), .ready()]
        await fixture.start()
        fixture.unlock.onCreate = { scope, creationID in
            XCTAssertTrue(fixture.factory.children.allSatisfy { !$0.isRunning })
            guard case .pending(let address, let host, let owner, let generation, let savedCreationID) = fixture.preferences.load(host: fixture.base.dataDir) else {
                return XCTFail("the exact pending generation must be persisted before key creation")
            }
            XCTAssertEqual(address, fixture.addresses.first); XCTAssertEqual(host, "host_A"); XCTAssertEqual(owner, "owner_A")
            XCTAssertNotNil(UUID(uuidString: generation)); XCTAssertEqual(savedCreationID, creationID)
            XCTAssertTrue(scope.custodyFilePath.contains(generation)); fixture.factory.events.append("key:create")
        }
        let result = await successfulPreparation(fixture, renew: true); XCTAssertEqual(result, .listening)
        let fresh = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertNotEqual(fresh.generation, old.generation); XCTAssertNotNil(fresh.generation)
        XCTAssertNotEqual(fresh.custodyFile, old.custodyFile)
        let oldScope = try LocalHostUnlockScope(bundleID: "com.dexter.tests.recovery", custodyFilePath: old.custodyFile)
        let newScope = try LocalHostUnlockScope(bundleID: "com.dexter.tests.recovery", custodyFilePath: fresh.custodyFile)
        XCTAssertNotEqual(oldScope.keychainService, newScope.keychainService)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: old.custodyFile)), oldBytes)
        XCTAssertEqual(fixture.unlock.creates, [fresh.custodyFile]); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .saved(address: fresh.address,
            installationID: fresh.installationID, ownerID: fresh.ownerID, generation: fresh.generation))
        let events = fixture.factory.events
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of: "exit:1")), try XCTUnwrap(events.firstIndex(of: "key:create")))
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of: "key:create")), try XCTUnwrap(events.firstIndex(of: "create:2")))
        let second = await successfulPreparation(fixture, renew: true); XCTAssertEqual(second, .listening)
        let newer = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertNotEqual(newer.generation, fresh.generation); XCTAssertNotEqual(newer.custodyFile, fresh.custodyFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.custodyFile)); XCTAssertEqual(fixture.unlock.creates.count, 2)
        await assertReadsOnly(fixture)
    }

    func testRenewUsesCurrentSingleAddressWhenSavedAddressNoLongerExists() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let old = try fixture.seedSavedChannel(); await fixture.start()
        fixture.addresses = ["100.64.0.70"]
        let result = await successfulPreparation(fixture, renew: true); XCTAssertEqual(result, .listening)
        let fresh = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertEqual(fresh.address, "100.64.0.70"); XCTAssertNotEqual(fresh.custodyFile, old.custodyFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: old.custodyFile))
        XCTAssertEqual(fixture.unlock.creates, [fresh.custodyFile]); await assertReadsOnly(fixture)
    }

    func testRenewRefusesAmbiguousOrMissingInterfaceWithoutStoppingOrCreating() async throws {
        for addresses in [[], ["100.64.0.99", "100.64.0.70"]] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            let old = try fixture.seedSavedChannel(); await fixture.start()
            let captured = fixture.preferences.load(host: fixture.base.dataDir)
            fixture.addresses = addresses
            let failure = await prepare(fixture, renew: true); XCTAssertEqual(failure, .networkUnavailable)
            XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertEqual(fixture.factory.children[0].stopRequests, 0)
            XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), captured)
            XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(FileManager.default.fileExists(atPath: old.custodyFile))
        }
    }

    func testPreparePendingCreationResumesOriginalGenerationAndCreationIDWithoutNewKey() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let generation = UUID().uuidString.lowercased(), creationID = UUID().uuidString.lowercased()
        let pending = try fixture.preferences.configuration(address: "100.64.0.99", host: fixture.base.dataDir,
            installationID: "host_A", ownerID: "owner_A", generation: generation, prepare: true)
        try fixture.preferences.savePending(pending, creationID: creationID, host: fixture.base.dataDir, expected: .missing)
        fixture.unlock.seedPending(pending.custodyFile, creationID: creationID)
        await fixture.start()
        XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertTrue(fixture.unlock.resumes.isEmpty, "startup must not resume a pending human operation")
        let result = await successfulPreparation(fixture); XCTAssertEqual(result, .listening)
        let active = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertEqual(active.generation, generation); XCTAssertEqual(active.custodyFile, pending.custodyFile)
        XCTAssertEqual(fixture.unlock.resumes, [pending.custodyFile]); XCTAssertTrue(fixture.unlock.creates.isEmpty)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), .saved(address: active.address,
            installationID: active.installationID, ownerID: active.ownerID, generation: generation))
        await assertReadsOnly(fixture)
    }

    func testRenewKnownFailureReturnsLocalChatOnlyAndPrepareReusesPendingSealedGeneration() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let old = try fixture.seedSavedChannel(); await fixture.start()
        fixture.factory.plans = [.failedExit("Host listener failed: synthetic private bind failure"), .ready()]
        let result = await successfulPreparation(fixture, renew: true); XCTAssertEqual(result, .localChatOnly)
        XCTAssertTrue(fixture.model.isOnline); XCTAssertNil(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        guard case .pending(let address, let host, let owner, let generation, let creationID) = fixture.preferences.load(host: fixture.base.dataDir) else {
            return XCTFail("a failed renewal cannot claim an active remote listener")
        }
        let pending = try fixture.preferences.configuration(address: address, host: fixture.base.dataDir,
            installationID: host, ownerID: owner, generation: generation)
        XCTAssertNotEqual(pending.custodyFile, old.custodyFile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: pending.custodyFile))
        let pendingScope = try LocalHostUnlockScope(bundleID: "com.dexter.tests.recovery", custodyFilePath: pending.custodyFile)
        XCTAssertEqual(try fixture.unlock.creationInfo(scope: pendingScope)?.creationId, creationID)
        let resumed = await successfulPreparation(fixture); XCTAssertEqual(resumed, .listening)
        let active = try XCTUnwrap(fixture.coordinator.currentEngineConfiguration?.appClientChannel)
        XCTAssertEqual(active.generation, generation); XCTAssertEqual(active.custodyFile, pending.custodyFile)
        XCTAssertEqual(active.action, .unlock); XCTAssertEqual(fixture.unlock.creates, [pending.custodyFile])
        XCTAssertTrue(fixture.unlock.resumes.isEmpty, "sealed pending custody uses its existing exact unlock")
        await assertReadsOnly(fixture)
    }

    func testPreparePendingWrongCreationAssociationRefusesWithoutStoppingOrCreating() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        let channel = try fixture.preferences.configuration(address: "100.64.0.99", host: fixture.base.dataDir,
            installationID: "host_A", ownerID: "owner_A", generation: UUID().uuidString.lowercased(), prepare: true)
        try fixture.preferences.savePending(channel, creationID: UUID().uuidString.lowercased(), host: fixture.base.dataDir, expected: .missing)
        fixture.unlock.seedPending(channel.custodyFile, creationID: UUID().uuidString.lowercased())
        await fixture.start()
        let captured = fixture.preferences.load(host: fixture.base.dataDir)
        let failure = await prepare(fixture); XCTAssertEqual(failure, .custodyUnavailable)
        XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertEqual(fixture.factory.children[0].stopRequests, 0)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), captured)
        XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
    }

    func testRenewUncertainOldStopPreservesMetadataAndDoesNotCreatePendingGeneration() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        try fixture.seedSavedChannel(); await fixture.start()
        let captured = fixture.preferences.load(host: fixture.base.dataDir)
        fixture.factory.children[0].holdStop = true
        let failure = await prepare(fixture, renew: true); XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertTrue(fixture.factory.children[0].isRunning)
        XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), captured)
        XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
    }

    func testRenewCancelledOrSelectionChangedAfterStopDoesNotCreateKeyOrReplacementWriter() async throws {
        for cancel in [true, false] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            try fixture.seedSavedChannel(); await fixture.start()
            let captured = fixture.preferences.load(host: fixture.base.dataDir)
            fixture.factory.children[0].holdStop = true
            let pending = Task { await prepare(fixture, renew: true) }
            let arrived = await waitUntil { fixture.factory.children[0].stopRequests == 1 }; XCTAssertTrue(arrived)
            if cancel { pending.cancel() } else { fixture.model.useFixture() }
            fixture.factory.children[0].exit()
            let failure = await pending.value; XCTAssertEqual(failure, .outcomeUnknown)
            XCTAssertEqual(fixture.factory.children.count, 1)
            XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), captured)
            XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        }
    }

    func testRenewSelectedInterfaceChangedOrBecameAmbiguousWhileStoppingDoesNotMintKey() async throws {
        for addresses in [["100.64.0.70"], ["100.64.0.99", "100.64.0.70"]] {
            let fixture = try AppRecoveryFixture(); defer { fixture.close() }
            try fixture.seedSavedChannel(); await fixture.start()
            let captured = fixture.preferences.load(host: fixture.base.dataDir)
            fixture.factory.onStop = { fixture.addresses = addresses }
            let failure = await prepare(fixture, renew: true); XCTAssertEqual(failure, .outcomeUnknown)
            XCTAssertEqual(fixture.factory.children.count, 1); XCTAssertFalse(fixture.factory.children[0].isRunning)
            XCTAssertEqual(fixture.preferences.load(host: fixture.base.dataDir), captured)
            XCTAssertTrue(fixture.unlock.creates.isEmpty); XCTAssertTrue(fixture.unlock.resumes.isEmpty)
        }
    }

    func testRenewWrongReadyHostNeverAcceptsCandidateOrStartsFallback() async throws {
        let fixture = try AppRecoveryFixture(); defer { fixture.close() }
        try fixture.seedSavedChannel(); await fixture.start()
        fixture.factory.plans = [.ready(host: "host_B")]
        let failure = await prepare(fixture, renew: true); XCTAssertEqual(failure, .outcomeUnknown)
        XCTAssertEqual(fixture.factory.children.count, 2); XCTAssertEqual(fixture.factory.children[1].stopRequests, 1)
        XCTAssertFalse(fixture.coordinator.ownsLiveChild); XCTAssertEqual(fixture.unlock.creates.count, 1)
        guard case .pending = fixture.preferences.load(host: fixture.base.dataDir) else { return XCTFail("unconfirmed renewal must remain pending") }
    }

    func testPhoneCorruptStorageResetWithoutDemoLeavesNoExampleDataAndReopensForPairing() throws {
        let storage = AppRecoveryStorage(), corrupt = Data([0x7b, 0x22, 0xff, 0x00, 0x7d])
        storage.writeData(corrupt)
        let model = DexterAppModel(storage: storage, platform: .iPhone)
        XCTAssertTrue(model.requiresStorageReset); XCTAssertEqual(storage.readData(), corrupt)
        XCTAssertTrue(model.resetCorruptStorage(usesDemo: false))
        XCTAssertFalse(model.requiresStorageReset); XCTAssertFalse(model.isFixture); XCTAssertFalse(model.isOnline)
        XCTAssertTrue(model.remotePairingPending); XCTAssertFalse(model.canUseHost)
        XCTAssertTrue(model.bots.isEmpty); XCTAssertTrue(model.teams.isEmpty); XCTAssertTrue(model.actions.isEmpty)
        XCTAssertNil(model.selectedBotID); XCTAssertNil(model.selectedTeamID); XCTAssertNil(model.selectedThreadID)
        let saved = try JSONDecoder().decode(DexterPersistedAppState.self, from: try XCTUnwrap(storage.readData()))
        XCTAssertTrue(saved.pendingRequests.isEmpty); XCTAssertNotEqual(storage.readData(), corrupt)
        let reopened = DexterAppModel(storage: storage, platform: .iPhone)
        XCTAssertFalse(reopened.isFixture); XCTAssertTrue(reopened.remotePairingPending)
        XCTAssertTrue(reopened.bots.isEmpty); XCTAssertTrue(reopened.teams.isEmpty); XCTAssertTrue(reopened.actions.isEmpty)
        XCTAssertFalse(reopened.canUseHost); XCTAssertFalse(reopened.requiresStorageReset)
    }
}
#endif
