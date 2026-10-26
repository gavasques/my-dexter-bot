import Foundation
import XCTest

/// The mascot components localize with inline pt/en pairs and `portuguese ?` branches, so they need no catalog keys.
/// This runs the repo's own audit on those files without the compiled-bundle environment the full audit requires.
final class BotMascotLocalizationTests: XCTestCase {
    private static let appleRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func testMascotFilesShowNoUnlocalizedText() throws {
        let data = try Data(contentsOf: Self.appleRoot.appendingPathComponent("SharedApp/Resources/Localizable.xcstrings"))
        let keys = Set(try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["strings"] as? [String: Any]).keys)
        let audit = LocalizationAudit(catalogKeys: keys)
        var portuguese = 0
        for name in ["BotMascotDesign.swift", "BotMascotMotion.swift", "BotMascotView.swift", "BotMascotCreatorView.swift",
                     "BotMascotObservedActivity.swift", "BotAvatarAppearanceDraft.swift"] {
            let source = try String(contentsOf: Self.appleRoot.appendingPathComponent("Sources/DexterAppCore/" + name), encoding: .utf8)
            XCTAssertEqual(audit.problems(in: source), [], name)
            let report = audit.portugueseOutsideLocalization(in: source, file: name, extracted: [:], translatedKeys: keys, declarations: .current)
            XCTAssertEqual(report.problems, [], name)
            portuguese += report.portuguese
        }
        XCTAssertGreaterThan(portuguese, 20, "the audit must actually see the Portuguese labels")
    }
}
