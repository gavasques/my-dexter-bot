#if os(macOS)
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

private final class AutoMemoryDefaults: UserDefaults, @unchecked Sendable {
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "com.dexter.tests.auto.\(UUID().uuidString)")! }
    override func object(forKey key: String) -> Any? { values[key] }
    override func set(_ value: Any?, forKey key: String) { values[key] = value }
}
@MainActor private final class AutoMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }; func writeData(_ data: Data) { self.data = data }; func removeData() { data = nil }
}
private struct AutoOfflineTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> TransportResponse { throw URLError(.cannotConnectToHost) }
}
@MainActor private final class AutoUnlockStore: LocalHostUnlockStore {
    var state: LocalHostUnlockStatus = .missing
    var loads = 0, creates = 0, resumes = 0
    var afterLoad: (() -> Void)?
    let bytes = Data(repeating: 0x53, count: 32)
    func status(scope: LocalHostUnlockScope) -> LocalHostUnlockStatus { state }
    func create(scope: LocalHostUnlockScope, creationId: String) throws -> OwnedLocalHostUnlockBytes {
        creates += 1; state = .blocked; return OwnedLocalHostUnlockBytes(bytes: bytes, creationId: creationId)!
    }
    func load(scope: LocalHostUnlockScope) throws -> OwnedLocalHostUnlockBytes {
        loads += 1; afterLoad?(); return OwnedLocalHostUnlockBytes(bytes: bytes)!
    }
    func creationInfo(scope: LocalHostUnlockScope) throws -> LocalHostUnlockCreationInfo? { nil }
    func loadPendingCreation(scope: LocalHostUnlockScope, expectedCreationId: String) throws -> OwnedLocalHostUnlockBytes {
        resumes += 1; throw LocalHostUnlockFailure.conflict
    }
}
@MainActor private final class AutoHostChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    private(set) var privateByteCount = 0
    private(set) var stopRequests = 0
    var holdStop = false
    var holdReady = false
    private var pendingReady: (() -> Void)?
    private var exitCallback: (@Sendable () -> Void)?
    private(set) var isRunning = false
    var terminationStatus: Int32 { 0 }
    init(_ config: LocalHostLaunchConfiguration) { configuration = config }
    func providePrivateInput(_ bytes: Data) throws { privateByteCount = bytes.count }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        if let custody = configuration.localDeviceCustody {
            if configuration.localDeviceCustodyAction == .create {
                let target = URL(fileURLWithPath: custody.filePath)
                guard !FileManager.default.fileExists(atPath: target.path) else { throw LocalHostFailure.deviceCustodyUnavailable }
                try Data("synthetic ciphertext".utf8).write(to: target)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            } else { guard FileManager.default.fileExists(atPath: custody.filePath) else { throw LocalHostFailure.deviceCustodyUnavailable } }
        }
        isRunning = true; exitCallback = onExit
        let ready: [String: Any] = ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
            "engineExecution": configuration.enableEngines ? "enabled" : "disabled", "mcpGateway": configuration.enableMcp ? "enabled" : "disabled",
            "deviceTurnTools": configuration.localDeviceCustody?.allowsDeviceTools == true ? "enabled" : "disabled",
            "deviceChannel": configuration.localDeviceCustody == nil ? ["status": "unconfigured"] : ["status": "listening", "url": "https://127.0.0.1:4318"]]
        let data = try JSONSerialization.data(withJSONObject: ready)
        if holdReady { pendingReady = { onStdout(data) } } else { Task { @MainActor in onStdout(data) } }
    }
    func emitReady() { pendingReady?(); pendingReady = nil }
    func requestGracefulStop() { stopRequests += 1; if !holdStop { exit() } }
    func exit() { isRunning = false; exitCallback?() }
}

@MainActor final class MacAutoSetupIntegrationTests: XCTestCase {
    private var root: URL!
    private var children: [AutoHostChild] = []
    private var nextChild: ((AutoHostChild) -> Void)?
    override func setUp() async throws {
        // Foundation normalizes /private/var to /var; these production realpath guards deliberately refuse aliases.
        // Root supplies a plain owned /Users lab. Standalone tests use a unique test-source sibling only.
        let base = ProcessInfo.processInfo.environment["DEXTER_TEST_PRIVATE_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".synthetic-mac-auto")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        root = base.appendingPathComponent("dexter-auto-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        for name in ["node", "codex", "cli.js"] {
            let file = root.appendingPathComponent(name); try Data("synthetic only".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("custody"), withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }
    private var preference: LocalEnginePreference {
        LocalEnginePreference(allowsLocalEngines: true, codexPath: root.appendingPathComponent("codex").path, allowsDexterTools: true,
            localDeviceCustody: LocalDeviceCustodyPreference(filePath: root.appendingPathComponent("custody/local-device.sealed").path, allowsDeviceTools: true))
    }
    private func store(_ preference: LocalEnginePreference) -> LocalEnginePreferenceStore {
        let store = LocalEnginePreferenceStore(defaults: AutoMemoryDefaults(), key: "synthetic-auto"); XCTAssertTrue(store.save(preference)); return store
    }
    private func model() -> DexterAppModel {
        DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: AutoOfflineTransport()), storage: AutoMemoryStorage())
    }
    private func coordinator(store: LocalEnginePreferenceStore, unlock: AutoUnlockStore) -> LocalHostLaunchCoordinator {
        let base = LocalHostLaunchConfiguration(node: root.appendingPathComponent("node"), cli: root.appendingPathComponent("cli.js"), dataDir: root.appendingPathComponent("store"))
        return LocalHostLaunchCoordinator(packaged: base, enginePreferences: store, makeSupervisor: { [unowned self] config in
            LocalHostSupervisor(configuration: config, makeChild: { config, _ in
                let child = AutoHostChild(config); self.nextChild?(child); self.children.append(child); return child
            }, portIsFree: { _ in true })
        }, stopGrace: .milliseconds(100), unlockStore: unlock, bundleID: "com.dexter.tests")
    }
    private func sealed() throws {
        let path = preference.localDeviceCustody!.filePath
        try Data("synthetic ciphertext".utf8).write(to: URL(fileURLWithPath: path)); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
    func testStartupLoadsExactExistingUnlockOnceWithoutCreating() async throws {
        try sealed(); let unlock = AutoUnlockStore(); unlock.state = .configured
        let host = coordinator(store: store(preference), unlock: unlock), model = model()
        await host.initialRefresh(model: model); await host.initialRefresh(model: model)
        XCTAssertEqual(unlock.loads, 1); XCTAssertEqual(unlock.creates, 0); XCTAssertEqual(unlock.resumes, 0)
        XCTAssertEqual(children.count, 1); XCTAssertEqual(children[0].privateByteCount, 32)
        XCTAssertEqual(children[0].configuration.localDeviceCustodyAction, .unlock)
        XCTAssertEqual(host.currentEngineConfiguration?.localDeviceCustody, preference.localDeviceCustody)
    }
    func testMissingAndPartialNeverCreateOrResumeAtStartup() async {
        for state in [LocalHostUnlockStatus.missing, .blocked, .legacyPasswordRequired] {
            let unlock = AutoUnlockStore(); unlock.state = state
            let host = coordinator(store: store(preference), unlock: unlock)
            await host.initialRefresh(model: model())
            XCTAssertEqual(unlock.creates, 0); XCTAssertEqual(unlock.resumes, 0); XCTAssertEqual(unlock.loads, 0)
            XCTAssertNil(host.currentEngineConfiguration?.localDeviceCustody)
            await host.stopForTermination()
        }
    }
    func testSealedDisappearingAfterLoadDoesNotPromoteUnlockToCreate() async throws {
        try sealed(); let unlock = AutoUnlockStore(); unlock.state = .configured
        unlock.afterLoad = { [unowned self] in try! FileManager.default.removeItem(atPath: self.preference.localDeviceCustody!.filePath) }
        let host = coordinator(store: store(preference), unlock: unlock)
        await host.initialRefresh(model: model())
        XCTAssertEqual(unlock.loads, 1); XCTAssertEqual(unlock.creates, 0); XCTAssertEqual(children.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: preference.localDeviceCustody!.filePath))
        let config = LocalHostLaunchConfiguration(node: root.appendingPathComponent("node"), cli: root.appendingPathComponent("cli.js"), dataDir: root.appendingPathComponent("store"), enableEngines: true, enableMcp: true, localDeviceCustody: preference.localDeviceCustody)
        XCTAssertEqual(config.arguments[config.arguments.firstIndex(of: "--local-device-custody-action")! + 1], "unlock")
    }
    func testHumanCreationCreatesOnceThenReusesAppliedChoice() async throws {
        var initial = preference; initial.localDeviceCustody?.allowsDeviceTools = false
        let store = store(initial), unlock = AutoUnlockStore(), host = coordinator(store: store, unlock: unlock), model = model()
        await host.initialRefresh(model: model)
        try await host.prepareDeviceChannel(model: model)
        XCTAssertEqual(unlock.creates, 1); XCTAssertEqual(children.count, 2)
        XCTAssertEqual(children[1].configuration.localDeviceCustodyAction, .create)
        XCTAssertEqual(children[1].privateByteCount, 32); XCTAssertTrue(FileManager.default.fileExists(atPath: preference.localDeviceCustody!.filePath))
        unlock.state = .configured
        try await host.prepareDeviceChannel(model: model)
        XCTAssertEqual(unlock.creates, 1); XCTAssertEqual(unlock.loads, 1); XCTAssertEqual(children.count, 2)
    }
    func testClosingDuringOwnedStopRefusesAnotherStartAndRetainsUncertainCreation() async throws {
        let unlock = AutoUnlockStore(), host = coordinator(store: store(preference), unlock: unlock), model = model()
        nextChild = { $0.holdStop = true }; await host.initialRefresh(model: model); nextChild = nil
        var opened = true
        let task = Task { try await host.prepareDeviceChannel(model: model, isCurrent: { opened }) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while children[0].stopRequests == 0, ContinuousClock.now < deadline { await Task.yield() }
        guard children[0].stopRequests > 0 else { task.cancel(); _ = try? await task.value; XCTFail("owned stop was not reached"); return }
        opened = false; task.cancel(); children[0].exit()
        do { try await task.value; XCTFail("closed intent must refuse restart") } catch {}
        XCTAssertEqual(unlock.creates, 1); XCTAssertEqual(children.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: preference.localDeviceCustody!.filePath))
    }
    func testClosingAfterNewRunBeforeLateReadyStopsOnlyNewOwnedChild() async throws {
        let unlock = AutoUnlockStore(), host = coordinator(store: store(preference), unlock: unlock), model = model()
        await host.initialRefresh(model: model)
        nextChild = { $0.holdReady = true }
        var opened = true
        let task = Task { try await host.prepareDeviceChannel(model: model, isCurrent: { opened }) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while (children.count < 2 || !children[1].isRunning), ContinuousClock.now < deadline { await Task.yield() }
        guard children.count == 2, children[1].isRunning else { task.cancel(); _ = try? await task.value; XCTFail("new child was not started"); return }
        opened = false; task.cancel(); children[1].emitReady()
        do { try await task.value; XCTFail("late readiness cannot validate a closed setup") } catch {}
        XCTAssertEqual(unlock.creates, 1); XCTAssertEqual(children.count, 2)
        XCTAssertFalse(children[1].isRunning); XCTAssertGreaterThanOrEqual(children[1].stopRequests, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: preference.localDeviceCustody!.filePath), "cancellation makes no rollback claim")
    }
    func testOlderCustodyPreferenceDoesNotAuthorizeAutomaticAgentStartup() throws {
        let data = Data(#"{"filePath":"/synthetic/local-device.sealed","allowsDeviceTools":true}"#.utf8)
        let preference = try JSONDecoder().decode(LocalDeviceCustodyPreference.self, from: data)
        XCTAssertFalse(preference.autostartPreparedAgent)
    }
    func testFixtureCannotReadOrCreateUnlockForPreparationOrStartup() async {
        let unlock = AutoUnlockStore(); unlock.state = .configured
        let host = coordinator(store: store(preference), unlock: unlock), model = model(); model.useFixture()
        await host.initialRefresh(model: model)
        do { try await host.prepareDeviceChannel(model: model); XCTFail("fixture must refuse") } catch {}
        XCTAssertEqual(unlock.loads, 0); XCTAssertEqual(unlock.creates, 0); XCTAssertEqual(children.count, 0)
    }
    func testClaimMatchingRejectsOtherIdentityScopeRotationDuplicatesAndExpiry() throws {
        let pin = String(repeating: "a", count: 64), caps = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"]
        func claim(pin: String, caps: [String], kind: String = "pair", expiry: Int64 = Int64(Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)) throws -> LocalMacAgentClaim {
            let data = try JSONSerialization.data(withJSONObject: ["claimId": "claim-a", "kind": kind, "clientFingerprint": pin,
                "name": "Synthetic Mac", "capabilities": caps, "expiresAt": expiry]); return try JSONDecoder().decode(LocalMacAgentClaim.self, from: data)
        }
        let exact = try claim(pin: pin, caps: caps)
        XCTAssertEqual(MacAutoSetupController.exactClaim([try claim(pin: String(repeating: "b", count: 64), caps: caps), exact], fingerprint: pin, capabilities: caps), exact)
        for claims in [[try claim(pin: pin, caps: caps + ["mac.file.read"])], [try claim(pin: pin, caps: caps, kind: "rotate")], [exact, exact], [try claim(pin: pin, caps: caps, expiry: 1)]] {
            XCTAssertNil(MacAutoSetupController.exactClaim(claims, fingerprint: pin, capabilities: caps))
        }
    }
    func testImmutableApprovalIntentCannotReplayAndTamperedHashIsRefused() throws {
        let location = LocalMacAgentSetupLocation(root: root), caps = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"]
        let intent = MacAutoApprovalIntent(claimID: "claim-a", installation: "install-a", fingerprint: String(repeating: "a", count: 64), capabilities: caps, root: root.path)
        try intent.save(location: location)
        XCTAssertEqual(try MacAutoApprovalIntent.read(location: location, installation: "install-a"), intent)
        XCTAssertThrowsError(try intent.save(location: location)); XCTAssertThrowsError(try MacAutoApprovalIntent.read(location: location, installation: "other"))
        let path = root.appendingPathComponent(".mac-auto-approval.json")
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]; json["claimID"] = "different"
        try JSONSerialization.data(withJSONObject: json).write(to: path)
        XCTAssertThrowsError(try MacAutoApprovalIntent.read(location: location, installation: "install-a"))
    }
}
#endif
