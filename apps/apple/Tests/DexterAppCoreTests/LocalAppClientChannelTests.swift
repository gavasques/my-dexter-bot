#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor private final class AppChannelChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    var isRunning = false
    var terminationStatus: Int32 { 0 }
    var advertised: String?
    var frames = 0
    var stops = 0
    private var exit: (@Sendable () -> Void)?
    init(_ configuration: LocalHostLaunchConfiguration) { self.configuration = configuration }
    func providePrivateInput(_ bytes: Data) throws {
        XCTAssertEqual(bytes.count, 32); XCTAssertFalse(isRunning); frames += 1
    }
    func run(onStdout: @escaping @Sendable (Data) -> Void, onStderr: @escaping @Sendable (Data) -> Void, onExit: @escaping @Sendable () -> Void) throws {
        isRunning = true; exit = onExit
        let value: [String: Any] = ["status": "ready", "mode": "local-development", "url": configuration.hostAddress,
            "hostId": "synthetic-host", "ownerId": "synthetic-owner", "engineExecution": "disabled", "mcpGateway": "disabled", "deviceTurnTools": "disabled",
            "deviceChannel": ["status": "unconfigured"],
            "appClientChannel": ["status": "listening", "url": advertised ?? configuration.appClientChannel!.origin]]
        let data = try JSONSerialization.data(withJSONObject: value)
        Task { @MainActor in onStdout(data) }
    }
    func requestGracefulStop() { stops += 1; isRunning = false; exit?() }
}

/// Preferences are exercised entirely in memory; the UserDefaults domain is never consulted.
private final class AppChannelDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]
    init() { super.init(suiteName: "com.dexter.tests.app-channel." + UUID().uuidString.lowercased())! }
    override func object(forKey key: String) -> Any? { lock.withLock { values[key] } }
    override func set(_ value: Any?, forKey key: String) { lock.withLock { values[key] = value } }
    var keys: [String] { lock.withLock { Array(values.keys) } }
}

@MainActor final class LocalAppClientChannelTests: XCTestCase {
    func testPrivateEndpointDoesNotAdmitWildcardsLoopbackPublicIPsOrAlternateSpellings() {
        for address in ["100.64.0.1", "100.127.255.254"] { XCTAssertTrue(LocalAppClientChannelConfiguration.isPrivateAddress(address)) }
        for address in ["0.0.0.0", "::", "127.0.0.1", "100.63.255.255", "100.128.0.1", "100.064.0.1", "100.64.0.1\n", "100.64.0.256"] {
            XCTAssertFalse(LocalAppClientChannelConfiguration.isPrivateAddress(address))
        }
        XCTAssertNil(LocalAppClientChannelConfiguration(address: "100.64.0.1", custodyFile: "/private/../key", installationID: "synthetic-host", ownerID: "synthetic-owner"))
    }
    private func config() throws -> (URL, LocalHostLaunchConfiguration) {
        let parent = ProcessInfo.processInfo.environment["DEXTER_TEST_PRIVATE_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(".synthetic-app-channel")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let root = parent.appendingPathComponent("app-channel-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let node = root.appendingPathComponent("node"), cli = root.appendingPathComponent("cli.js")
        try Data("synthetic".utf8).write(to: node); try Data("synthetic".utf8).write(to: cli)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
        let channel = try XCTUnwrap(LocalAppClientChannelConfiguration(address: "100.64.0.99", custodyFile: root.appendingPathComponent("sealed").path, installationID: "synthetic-host", ownerID: "synthetic-owner"))
        return (root, LocalHostLaunchConfiguration(node: node, cli: cli, dataDir: root.appendingPathComponent("host"), appClientChannel: channel))
    }
    func testChannelLaunchMetadataContainsOnlyPublicExactConfigurationEvenWhenEnginesAreOff() throws {
        let (root, value) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertFalse(value.arguments.contains("--enable-engines"))
        XCTAssertEqual(Array(value.arguments.suffix(12)), ["--app-client-custody-file", value.appClientChannel!.custodyFile,
            "--app-client-custody-action", "unlock", "--app-client-listen", "100.64.0.99", "--app-client-port", "4319", "--app-client-expected-host", "synthetic-host", "--app-client-expected-owner", "synthetic-owner"])
        XCTAssertEqual(value.requiringCustodyAction(.create).appClientChannel, value.appClientChannel)
    }
    func testMissingUnlockRefusesBeforeLaunchingOrAdoptingAnyProcess() async throws {
        let (root, value) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        var creates = 0
        let supervisor = LocalHostSupervisor(configuration: value, makeChild: { configuration, _ in creates += 1; return AppChannelChild(configuration) }, portIsFree: { _ in true })
        let state = await supervisor.start(timeout: .milliseconds(100))
        XCTAssertEqual(state, .failed(.deviceUnlockRequired)); XCTAssertEqual(creates, 0); XCTAssertFalse(supervisor.ownsLiveChild)
    }
    func testReadyMustConfirmExactEndpointAndHostBeforeSuccess() async throws {
        let (root, value) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        for valid in [true, false] {
            let child = AppChannelChild(value)
            if !valid { child.advertised = "https://100.64.0.100:4319" }
            let supervisor = LocalHostSupervisor(configuration: value, makeChild: { _, _ in child }, portIsFree: { _ in true })
            let state = await supervisor.start(timeout: .seconds(1), appClientUnlockPassword: LocalHostUnlockPassword(String(repeating: "x", count: 32)))
            XCTAssertEqual(child.frames, 1)
            if valid { XCTAssertEqual(state, .running(address: value.hostAddress)); XCTAssertEqual(supervisor.confirmedHostID, "synthetic-host") }
            else { XCTAssertEqual(state, .failed(.readyContractMismatch)); XCTAssertEqual(child.stops, 1); XCTAssertNil(supervisor.confirmedHostID) }
            if supervisor.ownsLiveChild { _ = await supervisor.stop(grace: .seconds(1)) }
        }
    }

    func testLegacySavedMetadataRemainsLoadableWithoutInventingGeneration() throws {
        let (root, launch) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        let defaults = AppChannelDefaults(), preferences = LocalAppClientChannelPreferences(defaults: AppChannelDefaults())
        XCTAssertEqual(preferences.load(host: launch.dataDir), .missing)
        let saved = LocalAppClientChannelPreferences(defaults: defaults)
        let channel = try XCTUnwrap(launch.appClientChannel)
        try saved.save(channel, host: launch.dataDir, expected: .missing)
        // Three-key R6 data is intentionally retained as a supported load format.
        let key = try XCTUnwrap(defaults.keys.first)
        defaults.set(["address": channel.address, "installationID": channel.installationID, "ownerID": channel.ownerID], forKey: key)
        XCTAssertEqual(saved.load(host: launch.dataDir), .saved(address: channel.address,
            installationID: channel.installationID, ownerID: channel.ownerID, generation: nil))
        let restored = try saved.configuration(address: channel.address, host: launch.dataDir,
            installationID: channel.installationID, ownerID: channel.ownerID)
        XCTAssertNil(restored.generation)
        XCTAssertEqual(URL(fileURLWithPath: restored.custodyFile).lastPathComponent, "tailscale-100.64.0.99.sealed")
    }

    func testVersionedGenerationSeparatesCiphertextAndKeychainScopeAtSameAddress() throws {
        let (root, launch) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        let preferences = LocalAppClientChannelPreferences(defaults: AppChannelDefaults(), root: root.appendingPathComponent("custody"))
        let firstID = UUID().uuidString.lowercased(), secondID = UUID().uuidString.lowercased()
        let first = try preferences.configuration(address: "100.64.0.99", host: launch.dataDir,
            installationID: "synthetic-host", ownerID: "synthetic-owner", generation: firstID)
        let second = try preferences.configuration(address: "100.64.0.99", host: launch.dataDir,
            installationID: "synthetic-host", ownerID: "synthetic-owner", generation: secondID)
        XCTAssertEqual(first.generation, firstID); XCTAssertEqual(second.generation, secondID)
        XCTAssertEqual(URL(fileURLWithPath: first.custodyFile).lastPathComponent, "tailscale-100.64.0.99.\(firstID).sealed")
        XCTAssertNotEqual(first.custodyFile, second.custodyFile)
        let firstScope = try LocalHostUnlockScope(bundleID: "com.dexter.tests.channel", custodyFilePath: first.custodyFile)
        let secondScope = try LocalHostUnlockScope(bundleID: "com.dexter.tests.channel", custodyFilePath: second.custodyFile)
        XCTAssertNotEqual(firstScope.keychainService, secondScope.keychainService)
        XCTAssertEqual(first.unlocking().generation, firstID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("custody").path), "metadata planning must not create files")
        for invalid in ["", "../generation", "not-a-uuid", firstID + "\n"] {
            XCTAssertThrowsError(try preferences.configuration(address: first.address, host: launch.dataDir,
                installationID: first.installationID, ownerID: first.ownerID, generation: invalid))
        }
    }

    func testPendingGenerationPersistsExactCreationAndOnlyExpectedSnapshotCanBecomeActive() throws {
        let (root, launch) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        let preferences = LocalAppClientChannelPreferences(defaults: AppChannelDefaults(), root: root.appendingPathComponent("custody"))
        let generation = UUID().uuidString.lowercased(), creationID = UUID().uuidString.lowercased()
        let channel = try preferences.configuration(address: "100.64.0.99", host: launch.dataDir,
            installationID: "synthetic-host", ownerID: "synthetic-owner", generation: generation)
        let pending = LocalAppClientChannelPreferences.Stored.pending(address: channel.address, installationID: channel.installationID,
            ownerID: channel.ownerID, generation: generation, creationID: creationID)
        try preferences.savePending(channel, creationID: creationID, host: launch.dataDir, expected: .missing)
        XCTAssertEqual(preferences.load(host: launch.dataDir), pending)
        XCTAssertThrowsError(try preferences.save(channel, host: launch.dataDir, expected: .missing))
        XCTAssertEqual(preferences.load(host: launch.dataDir), pending)
        try preferences.save(channel, host: launch.dataDir, expected: pending)
        XCTAssertEqual(preferences.load(host: launch.dataDir), .saved(address: channel.address, installationID: channel.installationID,
            ownerID: channel.ownerID, generation: generation))
        XCTAssertFalse(FileManager.default.fileExists(atPath: channel.custodyFile))
    }

    func testUnreadableMetadataFingerprintIsStableAndRejectsChangedSnapshotWithoutOverwriting() throws {
        let (root, launch) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        let defaults = AppChannelDefaults(), preferences = LocalAppClientChannelPreferences(defaults: AppChannelDefaults())
        XCTAssertEqual(preferences.load(host: launch.dataDir), .missing)
        let saved = LocalAppClientChannelPreferences(defaults: defaults)
        let channel = try XCTUnwrap(launch.appClientChannel)
        try saved.save(channel, host: launch.dataDir, expected: .missing)
        let key = try XCTUnwrap(defaults.keys.first)
        defaults.set(["invalid": "first synthetic metadata"], forKey: key)
        let first = saved.load(host: launch.dataDir)
        guard case .unreadable(let firstFingerprint) = first else { return XCTFail("invalid metadata must be unreadable") }
        XCTAssertFalse(firstFingerprint.isEmpty); XCTAssertEqual(saved.load(host: launch.dataDir), first)
        defaults.set(["invalid": "changed synthetic metadata"], forKey: key)
        let changed = saved.load(host: launch.dataDir)
        XCTAssertNotEqual(changed, first)
        XCTAssertThrowsError(try saved.save(channel, host: launch.dataDir, expected: first))
        XCTAssertEqual(saved.load(host: launch.dataDir), changed)
    }

    func testDeactivationCannotOverwriteAReplacementGeneration() throws {
        let (root, launch) = try config(); defer { try? FileManager.default.removeItem(at: root) }
        let preferences = LocalAppClientChannelPreferences(defaults: AppChannelDefaults(), root: root.appendingPathComponent("custody"))
        let old = try preferences.configuration(address: "100.64.0.99", host: launch.dataDir,
            installationID: "synthetic-host", ownerID: "synthetic-owner", generation: UUID().uuidString.lowercased())
        let replacement = try preferences.configuration(address: "100.64.0.99", host: launch.dataDir,
            installationID: "synthetic-host", ownerID: "synthetic-owner", generation: UUID().uuidString.lowercased())
        try preferences.save(old, host: launch.dataDir, expected: .missing)
        let oldSnapshot = preferences.load(host: launch.dataDir)
        try preferences.save(replacement, host: launch.dataDir, expected: oldSnapshot)
        let replacementSnapshot = preferences.load(host: launch.dataDir)
        XCTAssertThrowsError(try preferences.deactivate(old, host: launch.dataDir))
        XCTAssertEqual(preferences.load(host: launch.dataDir), replacementSnapshot)
        try preferences.deactivate(replacement, host: launch.dataDir)
        XCTAssertEqual(preferences.load(host: launch.dataDir), .inactive(address: replacement.address,
            installationID: replacement.installationID, ownerID: replacement.ownerID, generation: replacement.generation))
    }
}
#endif
