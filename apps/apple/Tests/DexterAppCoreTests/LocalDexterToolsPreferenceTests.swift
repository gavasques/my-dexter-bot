#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore

/// The store's two UserDefaults operations are served exclusively from this dictionary.
/// No persistent domain is read or written, including when save() calls set().
private final class ToolsMemoryDefaults: UserDefaults, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Any] = [:]

    init(isolationID: UUID = UUID()) {
        super.init(suiteName: "com.dexter.tests.tools.\(isolationID.uuidString)")!
    }

    override func object(forKey defaultName: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return values[defaultName]
    }

    override func set(_ value: Any?, forKey defaultName: String) {
        lock.lock()
        defer { lock.unlock() }
        values[defaultName] = value
    }
}

@MainActor
final class LocalDexterToolsPreferenceTests: XCTestCase {
    private let key = "isolated-tools-preference"

    func testLegacyPreferenceDefaultsToolsOffWithoutRewritingBytes() throws {
        let defaults = ToolsMemoryDefaults()
        let bytes = Data(#"{"version":1,"allowsLocalEngines":true,"claudePath":"/synthetic/claude"}"#.utf8)
        defaults.set(bytes, forKey: key)
        let store = LocalEnginePreferenceStore(defaults: defaults, key: key)
        guard case .saved(let preference) = store.load() else { return XCTFail("Legacy choice must remain readable") }
        XCTAssertTrue(preference.allowsLocalEngines)
        XCTAssertFalse(preference.allowsDexterTools)
        XCTAssertEqual(preference.claudePath, "/synthetic/claude")
        XCTAssertEqual(defaults.object(forKey: key) as? Data, bytes)
    }

    func testExplicitToolsBooleanRoundTripsIncludingInertEngineOffChoice() {
        for engines in [false, true] {
            for tools in [false, true] {
                let store = LocalEnginePreferenceStore(defaults: ToolsMemoryDefaults(), key: key)
                let preference = LocalEnginePreference(allowsLocalEngines: engines,
                    claudePath: "/synthetic/claude", allowsDexterTools: tools)
                XCTAssertTrue(store.save(preference))
                XCTAssertEqual(store.load(), .saved(preference))
            }
        }
    }

    func testMalformedToolsAndUnknownKeyFailClosedWithoutRewriting() {
        let payloads = [
            #"{"version":1,"allowsLocalEngines":true,"allowsDexterTools":null}"#,
            #"{"version":1,"allowsLocalEngines":true,"allowsDexterTools":"true"}"#,
            #"{"version":1,"allowsLocalEngines":true,"allowsDexterTools":true,"grantAll":true}"#,
        ]
        for payload in payloads {
            let defaults = ToolsMemoryDefaults()
            let bytes = Data(payload.utf8)
            defaults.set(bytes, forKey: key)
            let store = LocalEnginePreferenceStore(defaults: defaults, key: key)
            XCTAssertEqual(store.load(), .unreadable, payload)
            XCTAssertEqual(defaults.object(forKey: key) as? Data, bytes)
        }
    }

    func testToolsCannotArmEnginesOrAppearInDisabledLaunchArguments() {
        let configuration = launch(engines: false, tools: true, commands: [.claude: "/synthetic/claude"])
        XCTAssertFalse(configuration.enableEngines)
        XCTAssertFalse(configuration.enableMcp)
        XCTAssertEqual(configuration.arguments, baseArguments)
    }

    func testSelectedAbsoluteTargetToolsAndLegacyArgumentsStayExact() {
        // A resolved shebang target may have a different basename; it must remain the exact argument.
        let target = "/synthetic/codex/bin/codex.js"
        let selected = launch(engines: true, tools: true, commands: [.codex: target])
        XCTAssertEqual(selected.arguments, baseArguments + ["--enable-engines", "--codex-command", target, "--enable-mcp", "--enable-bot-delegation"])
        XCTAssertEqual(launch(engines: true, tools: false, commands: [.codex: target]).arguments,
                       baseArguments + ["--enable-engines", "--codex-command", target])
        // nil remains the explicit legacy contract: no command-map or tool opt-in is invented.
        XCTAssertEqual(launch(engines: true, tools: false, commands: nil).arguments,
                       baseArguments + ["--enable-engines"])
    }

    private var baseArguments: [String] {
        ["/synthetic/cli.js", "serve", "--data-dir", "/synthetic/state", "--port", "4317", "--browser-use-private-input"]
    }

    private func launch(engines: Bool, tools: Bool, commands: [LocalEngineKind: String]?) -> LocalHostLaunchConfiguration {
        LocalHostLaunchConfiguration(node: URL(fileURLWithPath: "/synthetic/node"),
            cli: URL(fileURLWithPath: "/synthetic/cli.js"), dataDir: URL(fileURLWithPath: "/synthetic/state"),
            enableEngines: engines, engineCommands: commands, enableMcp: tools)
    }
}
#endif
