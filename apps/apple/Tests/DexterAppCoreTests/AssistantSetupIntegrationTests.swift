#if os(macOS)
import DexterHostClient
import DexterAssistantRuntimeSetup
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor
final class AssistantSetupIntegrationTests: XCTestCase {
    private var directory: URL!
    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("dexter-setup-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["claude", "codex"] {
            let file = directory.appendingPathComponent(name)
            try Data("synthetic metadata only, never executed".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        }
    }
    override func tearDown() async throws { try FileManager.default.removeItem(at: directory) }

    func testPreparingOneAssistantPreservesAllOtherChoicesAndCustody() throws {
        let original = LocalEnginePreference(allowsLocalEngines: false, claudePath: nil, codexPath: "/existing/codex",
            grokPath: "/existing/grok", musePath: "/existing/muse", antigravityPath: "/existing/antigravity", allowsDexterTools: false,
            mcpOnePassword: LocalMcpOnePasswordPreference(command: "/existing/op", vault: "synthetic", account: nil),
            localDeviceCustody: LocalDeviceCustodyPreference(filePath: "/synthetic/channel.json", allowsDeviceTools: false))
        let next = try AssistantSetupController.preference(.saved(original), engine: .claude, command: directory.appendingPathComponent("claude").path)
        XCTAssertTrue(next.allowsLocalEngines)
        XCTAssertEqual(next.codexPath, original.codexPath); XCTAssertEqual(next.grokPath, original.grokPath)
        XCTAssertEqual(next.musePath, original.musePath); XCTAssertEqual(next.antigravityPath, original.antigravityPath)
        XCTAssertEqual(next.allowsDexterTools, original.allowsDexterTools)
        XCTAssertEqual(next.mcpOnePassword, original.mcpOnePassword); XCTAssertEqual(next.localDeviceCustody, original.localDeviceCustody)
    }
    func testFirstUsePreparesOnlyChosenAssistantAndDexterTools() throws {
        let next = try AssistantSetupController.preference(.missing, engine: .codex, command: directory.appendingPathComponent("codex").path)
        XCTAssertTrue(next.allowsLocalEngines); XCTAssertTrue(next.allowsDexterTools)
        XCTAssertNil(next.claudePath); XCTAssertNil(next.grokPath); XCTAssertNil(next.mcpOnePassword); XCTAssertNil(next.localDeviceCustody)
    }
    func testUnreadableChoiceIsNeverOverwritten() {
        XCTAssertThrowsError(try AssistantSetupController.preference(.unreadable, engine: .claude, command: directory.appendingPathComponent("claude").path))
    }
    func testOriginalSymlinkLauncherSurvivesVersionedTarget() throws {
        let version = directory.appendingPathComponent("2.1.296")
        try FileManager.default.moveItem(at: directory.appendingPathComponent("claude"), to: version)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("claude"), withDestinationURL: version)
        let launcher = directory.appendingPathComponent("claude").path
        let next = try AssistantSetupController.preference(.missing, engine: .claude, command: launcher)
        XCTAssertEqual(next.claudePath, launcher)
        XCTAssertThrowsError(try AssistantSetupController.preference(.missing, engine: .claude, command: version.path))
    }
    func testMetadataAndHostUseSameCanonicalPathForVersionedClaude() async throws {
        let version = directory.appendingPathComponent("2.1.300")
        let flags = "--input-format --output-format --verbose --include-partial-messages --tools --strict-mcp-config --permission-mode --setting-sources --settings --disable-slash-commands --no-chrome --session-id --resume --mcp-config --allowedTools "
        let script = "#!/bin/sh\ncase \"$1\" in --version) printf '2.1.300 (synthetic)\\n';; --help) printf '%s\\n' '\(flags)';; *) exit 90;; esac\n"
        try Data(script.utf8).write(to: version)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: version.path)
        let launcher = directory.appendingPathComponent("claude")
        try FileManager.default.removeItem(at: launcher)
        try FileManager.default.createSymbolicLink(at: launcher, withDestinationURL: version)
        let candidate = await LocalRuntimeMetadataInspector().inspect(command: launcher.path, provider: .claude, requirements: .init())
        let result = RuntimeSetupResult(command: try XCTUnwrap(candidate.resolvedCommand), version: try XCTUnwrap(candidate.version),
            sha256: try XCTUnwrap(candidate.sha256), capabilities: candidate.capabilities)
        XCTAssertTrue(AssistantSetupController.verifies(result, launcher: launcher.path), "A verified CLI must survive host application regardless of /var vs /private/var aliases")
    }
    func testOtherProviderAndWrongBasenameCannotBeApplied() {
        XCTAssertThrowsError(try AssistantSetupController.preference(.missing, engine: .grok, command: directory.appendingPathComponent("claude").path))
        XCTAssertThrowsError(try AssistantSetupController.preference(.missing, engine: .claude, command: directory.appendingPathComponent("codex").path))
    }
}
#endif
