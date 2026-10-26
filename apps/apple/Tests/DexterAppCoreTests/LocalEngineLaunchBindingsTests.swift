#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore

final class LocalEngineLaunchBindingsTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-binding-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for folder in ["helpers", "old", "new"] { try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true) }
        for path in ["helpers/node", "old/codex", "new/claude", "new/codex"] {
            let file = root.appendingPathComponent(path); try Data(path.utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        }
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private var preference: LocalEnginePreference {
        LocalEnginePreference(allowsLocalEngines: true, claudePath: root.appendingPathComponent("new/claude").path,
            codexPath: root.appendingPathComponent("old/codex").path)
    }
    private func plan() throws -> LocalEngineActivationPlan {
        try LocalEngineActivationPlan.makeBound(preference, helpersDirectory: root.appendingPathComponent("helpers").path,
            bundledNode: root.appendingPathComponent("helpers/node").path, bindingsRoot: root.appendingPathComponent("bindings")).get()
    }
    func testDifferentSelectedVersionsUseExactAliasesDespiteSharedFolder() throws {
        let legacy = LocalEngineActivationPlan.make(preference, helpersDirectory: root.appendingPathComponent("helpers").path,
            bundledNode: root.appendingPathComponent("helpers/node").path)
        XCTAssertThrowsError(try legacy.get(), "the previously observed collision is reproduced")
        let selected = try plan(), bindings = try XCTUnwrap(selected.bindings)
        XCTAssertFalse(FileManager.default.fileExists(atPath: bindings.root.path), "planning is metadata only")
        try bindings.prepare()
        XCTAssertEqual(LocalEngineDiscovery.fileIdentity(bindings.directory.appendingPathComponent("codex").path),
            LocalEngineDiscovery.fileIdentity(root.appendingPathComponent("old/codex").path))
        XCTAssertNotEqual(LocalEngineDiscovery.fileIdentity(bindings.directory.appendingPathComponent("codex").path),
            LocalEngineDiscovery.fileIdentity(root.appendingPathComponent("new/codex").path))
        XCTAssertEqual(String(selected.path.split(separator: ":").first!), bindings.directory.path)
        let before = try FileManager.default.attributesOfItem(atPath: bindings.directory.appendingPathComponent("codex").path)[.systemFileNumber] as? NSNumber
        try bindings.prepare()
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: bindings.directory.appendingPathComponent("codex").path)[.systemFileNumber] as? NSNumber, before)
    }
    func testTamperedAliasIsRefusedAndNotRepaired() throws {
        let bindings = try XCTUnwrap(try plan().bindings); try bindings.prepare()
        let alias = bindings.directory.appendingPathComponent("codex")
        try FileManager.default.removeItem(at: alias)
        let wrong = root.appendingPathComponent("new/codex")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: wrong)
        XCTAssertThrowsError(try bindings.prepare())
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: alias.path), wrong.path)
    }
    func testForeignEntryAndSymlinkRootAreRefused() throws {
        let bindings = try XCTUnwrap(try plan().bindings); try bindings.prepare()
        try Data("foreign".utf8).write(to: bindings.directory.appendingPathComponent("foreign"))
        XCTAssertThrowsError(try bindings.prepare())
        let other = root.appendingPathComponent("other"); try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let link = root.appendingPathComponent("link"); try FileManager.default.createSymbolicLink(at: link, withDestinationURL: other)
        let candidate = try LocalEngineDiscovery.validateLauncher(root.appendingPathComponent("old/codex").path, kind: .codex).get()
        let linked = try LocalEngineLaunchBindings(root: link, chosen: [.codex: candidate])
        XCTAssertThrowsError(try linked.prepare())
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: other.path).isEmpty)
    }
    func testReplacedTargetRefusesBeforeMaterializingBindings() throws {
        let bindings = try XCTUnwrap(try plan().bindings)
        let target = root.appendingPathComponent("old/codex"), replacement = root.appendingPathComponent("replacement")
        try Data("replaced".utf8).write(to: replacement)
        try FileManager.default.removeItem(at: target); try FileManager.default.moveItem(at: replacement, to: target)
        XCTAssertThrowsError(try bindings.prepare())
        XCTAssertFalse(FileManager.default.fileExists(atPath: bindings.root.path))
    }
}
#endif
