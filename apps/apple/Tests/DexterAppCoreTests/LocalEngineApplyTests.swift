#if os(macOS)
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Serves the preference store from memory only; no persistent defaults domain is read or written.
private final class ApplyMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    init(isolationID: UUID = UUID()) { super.init(suiteName: "com.dexter.tests.apply.\(isolationID.uuidString)")! }
    override func object(forKey defaultName: String) -> Any? { lock.lock(); defer { lock.unlock() }; return values[defaultName] }
    override func set(_ value: Any?, forKey defaultName: String) { lock.lock(); defer { lock.unlock() }; values[defaultName] = value }
}

@MainActor
private final class ApplyMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

/// Every request fails as an unreachable host; no network is used.
private struct UnreachableTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> TransportResponse { throw URLError(.cannotConnectToHost) }
}

/// Synthetic child: never spawns a process. Reports the ready contract for its own configuration.
@MainActor
private final class FakeHostChild: LocalHostChild {
    let arguments: [String]
    var ignoresStop = false
    var holdsStop = false
    var advertisedMcp: String?
    private(set) var stopRequests = 0
    private(set) var running = false
    private var onExit: (@Sendable () -> Void)?
    private let configuration: LocalHostLaunchConfiguration

    init(_ configuration: LocalHostLaunchConfiguration) {
        self.configuration = configuration
        arguments = configuration.arguments
    }

    var isRunning: Bool { running }
    var terminationStatus: Int32 { 0 }

    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        running = true
        self.onExit = onExit
        let ready: [String: Any] = [
            "status": "ready", "mode": "local-development", "url": configuration.hostAddress,
            "engineExecution": configuration.enableEngines ? "enabled" : "disabled",
            "mcpGateway": advertisedMcp ?? (configuration.enableMcp ? "enabled" : "disabled"),
            "deviceTurnTools": "disabled",
            "deviceChannel": ["status": "unconfigured"],
        ]
        let data = try JSONSerialization.data(withJSONObject: ready)
        Task { @MainActor in onStdout(data) }
    }

    func requestGracefulStop() {
        stopRequests += 1
        guard !ignoresStop, !holdsStop else { return }
        exit()
    }

    func exit() { guard running else { return }; running = false; onExit?() }
}

@MainActor
final class LocalEngineApplyTests: XCTestCase {
    private var directory: URL!
    private var children: [FakeHostChild] = []
    private var configureNext: ((FakeHostChild) -> Void)?

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-apply-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let node = directory.appendingPathComponent("node")
        try Data("synthetic".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        try Data("synthetic".utf8).write(to: directory.appendingPathComponent("cli.js"))
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func packaged(engines: Bool) -> LocalHostLaunchConfiguration {
        LocalHostLaunchConfiguration(node: directory.appendingPathComponent("node"), cli: directory.appendingPathComponent("cli.js"),
                                     dataDir: directory.appendingPathComponent("store", isDirectory: true), enableEngines: engines)
    }

    private func coordinator(engines: Bool, store: LocalEnginePreferenceStore) -> LocalHostLaunchCoordinator {
        LocalHostLaunchCoordinator(packaged: packaged(engines: engines), enginePreferences: store, makeSupervisor: { [unowned self] config in
            LocalHostSupervisor(configuration: config, makeChild: { config, _ in
                let child = FakeHostChild(config)
                self.configureNext?(child)
                self.children.append(child)
                return child
            }, portIsFree: { _ in true })
        }, stopGrace: .milliseconds(200))
    }

    private func model() -> DexterAppModel {
        DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: UnreachableTransport()), storage: ApplyMemoryStorage())
    }

    private var store: LocalEnginePreferenceStore { LocalEnginePreferenceStore(defaults: ApplyMemoryDefaults(), key: "isolated-apply") }

    func testApplyGracefullyRestartsOwnedHostOnceAndReportsCurrentState() async {
        let store = store
        let host = coordinator(engines: true, store: store)
        let model = model()
        await host.initialRefresh(model: model)
        XCTAssertEqual(host.currentEngineConfiguration?.enableEngines, true)
        XCTAssertEqual(children.count, 1)

        let off = LocalEnginePreference(allowsLocalEngines: false)
        let phase = await host.applyLocalEnginePreference(off, model: model)
        XCTAssertEqual(phase, .applied)
        XCTAssertEqual(children.count, 2)
        XCTAssertEqual(children[0].stopRequests, 1)
        XCTAssertFalse(children[0].isRunning)
        XCTAssertFalse(children[1].arguments.contains("--enable-engines"))
        XCTAssertEqual(host.currentEngineConfiguration?.enableEngines, false)
        XCTAssertTrue(host.enginesEnabledThisLaunch, "launch-time value stays immutable")
        XCTAssertEqual(store.load(), .saved(off))
        XCTAssertTrue(host.isCurrentlyApplied(off))

        // The same choice again changes nothing and starts nothing.
        let again = await host.applyLocalEnginePreference(off, model: model)
        XCTAssertEqual(again, .applied)
        XCTAssertEqual(children.count, 2)
        XCTAssertEqual(children[1].stopRequests, 0)
    }

    func testUncertainStopRefusesRestartWhileWriterMayLive() async {
        let store = store
        let host = coordinator(engines: true, store: store)
        let model = model()
        configureNext = { $0.ignoresStop = true }
        await host.initialRefresh(model: model)
        configureNext = nil

        let off = LocalEnginePreference(allowsLocalEngines: false)
        let phase = await host.applyLocalEnginePreference(off, model: model)
        XCTAssertEqual(phase, .refused(.stopUncertain))
        XCTAssertEqual(children.count, 1, "no second writer while the first may live")
        XCTAssertTrue(children[0].isRunning)
        XCTAssertTrue(host.ownsLiveChild)
        XCTAssertEqual(store.load(), .saved(off), "saved for the next opening")
        XCTAssertNil(host.currentEngineConfiguration)
    }

    func testFixtureSelectionRefusesWithoutSavingOrTouchingHost() async {
        let store = store
        let host = coordinator(engines: true, store: store)
        let model = model()
        await host.initialRefresh(model: model)
        model.useFixture()

        let phase = await host.applyLocalEnginePreference(LocalEnginePreference(allowsLocalEngines: false), model: model)
        XCTAssertEqual(phase, .refused(.notThisHost))
        XCTAssertEqual(store.load(), .missing)
        XCTAssertEqual(children.count, 1)
        XCTAssertEqual(children[0].stopRequests, 0)
    }

    func testSelectionChangeDuringStopDiscardsResultAndStartsNothing() async {
        let store = store
        let host = coordinator(engines: true, store: store)
        let model = model()
        configureNext = { $0.holdsStop = true }
        await host.initialRefresh(model: model)
        configureNext = nil

        let off = LocalEnginePreference(allowsLocalEngines: false)
        let apply = Task { await host.applyLocalEnginePreference(off, model: model) }
        while children[0].stopRequests == 0 { await Task.yield() }
        // A second Apply while the first is in flight is refused by state, not queued.
        let concurrent = await host.applyLocalEnginePreference(off, model: model)
        XCTAssertEqual(concurrent, .applying)
        model.useFixture()
        children[0].exit()
        let phase = await apply.value
        XCTAssertEqual(phase, .refused(.changedWhileApplying))
        XCTAssertEqual(children.count, 1)
        XCTAssertFalse(host.ownsLiveChild)
    }

    func testReadyContractMustMatchToolGatewayMetadata() async {
        let config = packaged(engines: false)
        let supervisor = LocalHostSupervisor(configuration: config, makeChild: { config, _ in
            let child = FakeHostChild(config)
            child.advertisedMcp = "enabled"
            return child
        }, portIsFree: { _ in true })
        let state = await supervisor.start(timeout: .seconds(2))
        XCTAssertEqual(state, .failed(.readyContractMismatch))
    }

    func testExpectedChoiceMismatchDoesNotSaveOrStop() async {
        let store = store; let host = coordinator(engines: true, store: store); let model = model()
        await host.initialRefresh(model: model)
        let original = store.load()
        let off = LocalEnginePreference(allowsLocalEngines: false)
        XCTAssertTrue(store.save(off))
        let phase = await host.applyLocalEnginePreference(off, model: model, expectedPreference: original)
        XCTAssertEqual(phase, .refused(.choiceChanged))
        XCTAssertEqual(store.load(), .saved(off)); XCTAssertEqual(children.count, 1)
        XCTAssertEqual(children[0].stopRequests, 0)
    }

    func testRuntimeHashMismatchDoesNotSaveOrStop() async {
        let store = store; let host = coordinator(engines: true, store: store); let model = model()
        await host.initialRefresh(model: model)
        let phase = await host.applyLocalEnginePreference(LocalEnginePreference(allowsLocalEngines: false), model: model,
            expectedPreference: .missing, verifyRuntime: { false })
        XCTAssertEqual(phase, .refused(.choiceChanged)); XCTAssertEqual(store.load(), .missing)
        XCTAssertEqual(children[0].stopRequests, 0)
    }

    func testRuntimeChangeWhileStoppingDoesNotStartAnotherWriter() async {
        let store = store; let host = coordinator(engines: true, store: store); let model = model()
        configureNext = { $0.holdsStop = true }; await host.initialRefresh(model: model); configureNext = nil
        var unchanged = true
        let apply = Task { await host.applyLocalEnginePreference(LocalEnginePreference(allowsLocalEngines: false), model: model,
            expectedPreference: .missing, verifyRuntime: { unchanged }) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while children[0].stopRequests == 0 && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(children[0].stopRequests, 1)
        unchanged = false; children[0].exit()
        let phase = await apply.value
        XCTAssertEqual(phase, .refused(.changedWhileApplying)); XCTAssertEqual(children.count, 1)
    }

    func testSameAddressNewSelectionGenerationIsRefusedAfterStop() async {
        let store = store; let host = coordinator(engines: true, store: store); let model = model()
        configureNext = { $0.holdsStop = true }; await host.initialRefresh(model: model); configureNext = nil
        let originalScope = model.filesScope, address = model.hostAddress
        let apply = Task { await host.applyLocalEnginePreference(LocalEnginePreference(allowsLocalEngines: false), model: model) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while children[0].stopRequests == 0 && ContinuousClock.now < deadline { await Task.yield() }
        model.configureHost()
        XCTAssertEqual(model.hostAddress, address); XCTAssertNotEqual(model.filesScope, originalScope)
        children[0].exit()
        let phase = await apply.value
        XCTAssertEqual(phase, .refused(.changedWhileApplying)); XCTAssertEqual(children.count, 1)
    }
}
#endif
