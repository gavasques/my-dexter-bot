#if os(macOS)
import CryptoKit
import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class AssistantFirstRunTests: XCTestCase {
    private var root: URL!
    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-first-run-synthetic-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    }
    override func tearDown() async throws { try FileManager.default.removeItem(at: root) }

    private func fixture() throws {
        let host = root.appendingPathComponent("Resources/DexterLocalHost")
        let node = "Helpers/dexter-node"
        let files = ["app/node_modules/@dexter/cli/dist/index.js",
                     "app/node_modules/@dexter/context/dist/app-configuration-guide.js",
                     "app/node_modules/@dexter/context/dist/harness-guide.js"]
        func write(_ url: URL, _ data: Data) throws {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
        }
        let bytes = Data("synthetic metadata; never executed".utf8)
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        try write(root.appendingPathComponent(node), bytes)
        for path in files { try write(host.appendingPathComponent(path), bytes) }
        try write(host.appendingPathComponent("launch.json"), JSONSerialization.data(withJSONObject: [
            "schema": "dexter.local-host-launch/1", "node": node, "cli": "Resources/DexterLocalHost/" + files[0]]))
        try write(host.appendingPathComponent("manifest.json"), JSONSerialization.data(withJSONObject: [
            "schema": "dexter.local-host-manifest/1", "node": ["path": node, "sha256": hash],
            "files": Dictionary(uniqueKeysWithValues: files.map { ($0, hash) })]))
    }

    func testBundledRuntimeConfigurationAndGuidesAreIndependentlyVerified() throws {
        try fixture()
        XCTAssertEqual(AssistantBundledPreparation.inspect(contents: root), .init(runtime: true, configuration: true, guides: true))
        try Data("changed".utf8).write(to: root.appendingPathComponent("Helpers/dexter-node"))
        XCTAssertEqual(AssistantBundledPreparation.inspect(contents: root), .init(runtime: false, configuration: true, guides: true))
    }
    func testMissingGuideIsNotPresentedAsInstalledSkill() throws {
        try fixture()
        try FileManager.default.removeItem(at: root.appendingPathComponent("Resources/DexterLocalHost/app/node_modules/@dexter/context/dist/harness-guide.js"))
        let state = AssistantBundledPreparation.inspect(contents: root)
        XCTAssertTrue(state.runtime); XCTAssertTrue(state.configuration); XCTAssertFalse(state.guides)
    }
    func testManifestPathCannotEscapeBundleOrFollowOutsideAlias() throws {
        try fixture()
        let path = root.appendingPathComponent("Helpers/dexter-node")
        try FileManager.default.removeItem(at: path)
        try FileManager.default.createSymbolicLink(at: path, withDestinationURL: root.deletingLastPathComponent().appendingPathComponent("not-owned-node"))
        XCTAssertFalse(AssistantBundledPreparation.inspect(contents: root).runtime)
        let manifest = root.appendingPathComponent("Resources/DexterLocalHost/manifest.json")
        try JSONSerialization.data(withJSONObject: ["schema": "dexter.local-host-manifest/1", "node": ["path": "../outside", "sha256": String(repeating: "a", count: 64)], "files": [:] as [String: String]]).write(to: manifest)
        XCTAssertFalse(AssistantBundledPreparation.inspect(contents: root).runtime)
    }
    func testProgramChoiceAvailabilityAndAuthenticationRemainSeparate() throws {
        let entry = try JSONDecoder().decode(EngineCatalogEntry.self, from: Data(#"{"id":"claude","installed":true,"available":true,"models":[],"reasoningEfforts":[],"speeds":[]}"#.utf8))
        let state = AssistantFirstRunCoordinator.status(enabled: false, entry: entry, lookup: .loaded)
        XCTAssertFalse(state.enabled); XCTAssertEqual(state.installed, true); XCTAssertEqual(state.available, true)
        XCTAssertEqual(state.authentication, "unknown")
        let failedLookup = AssistantFirstRunCoordinator.status(enabled: true, entry: entry, lookup: .failed(.offline))
        XCTAssertTrue(failedLookup.enabled); XCTAssertNil(failedLookup.installed); XCTAssertNil(failedLookup.available)
        XCTAssertEqual(failedLookup.authentication, "unknown")
    }
    func testMissingBundleBlocksAutomaticHostPreparation() async throws {
        let model = DexterAppModel(storage: AssistantFirstRunMemoryStorage())
        var starts = 0
        let controller = AssistantFirstRunCoordinator(model: model, checkBundle: { .unavailable }, prepareHost: { starts += 1 })
        controller.open(); controller.open()
        await settle(controller)
        XCTAssertEqual(controller.phase, .blocked); XCTAssertEqual(starts, 0)
        controller.choose(.claude)
        XCTAssertNil(controller.assistant); XCTAssertNil(controller.selectedEngine)
    }
    func testOpeningOnlyJoinsSafeBundledPreparationOnce() async throws {
        let model = DexterAppModel(storage: AssistantFirstRunMemoryStorage())
        var starts = 0
        let controller = AssistantFirstRunCoordinator(model: model,
            checkBundle: { .init(runtime: true, configuration: true, guides: true) }, prepareHost: { starts += 1 })
        controller.open(); controller.open()
        await settle(controller)
        XCTAssertEqual(controller.phase, .ready); XCTAssertEqual(starts, 1)
        controller.open(); XCTAssertEqual(starts, 1)
        XCTAssertFalse(controller.canPrepareAssistant, "A fixture or an unrelated host must never prepare a real provider")
        XCTAssertNil(controller.assistant)
    }
    private func settle(_ controller: AssistantFirstRunCoordinator) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while controller.phase == .checking && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertNotEqual(controller.phase, .checking)
    }
}
@MainActor private final class AssistantFirstRunMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ value: Data) { data = value }
    func removeData() { data = nil }
}
#endif
