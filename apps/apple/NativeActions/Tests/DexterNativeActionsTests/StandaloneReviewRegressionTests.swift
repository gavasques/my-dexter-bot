import XCTest
@testable import DexterNativeActions

final class StandaloneReviewRegressionTests: XCTestCase {
    func testN05RejectsDraftExpandedBeyondLimitByNFC() {
        XCTAssertThrowsError(try BoundedDraft(String(repeating:"\u{0958}",count:4000)))
    }
    func testN08RejectsOtherwiseUnlistedFormatScalars() {
        for scalar in ["\u{2060}","\u{00AD}","\u{E0001}"] {
            XCTAssertThrowsError(try BoundedDraft("visible"+scalar))
        }
    }
    func testN20RejectsUUIDWithMissingOrWrongThreadPrefix() {
        for value in ["00000000-0000-0000-0000-000000000001","bot_00000000-0000-0000-0000-000000000001"] {
            XCTAssertThrowsError(try DexterThreadID(value))
        }
    }
}
