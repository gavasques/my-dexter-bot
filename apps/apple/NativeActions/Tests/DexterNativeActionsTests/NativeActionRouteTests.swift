import XCTest
@testable import DexterNativeActions

final class NativeActionRouteTests: XCTestCase {
    private let validThreadID = "thr_01234567-89ab-cdef-0123-456789abcdef"
    private let authorityKeys = [
        "host", "Host", "HOST", "origin", "principal", "token", "authorization", "url",
        "deeplink", "send", "requiresInAppConfirmation", "engine", "bot", "profile",
    ]

    func testOpenRouteAcceptsOnlyCanonicalHostThreadID() throws {
        let route = try NativeActionArgumentParser.parse([
            "action": "open_conversation",
            "threadId": validThreadID,
        ])

        XCTAssertEqual(route, .openConversation(threadID: try DexterThreadID(validThreadID)))
        XCTAssertFalse(route.requiresInAppConfirmation)
    }

    func testParserRejectsArbitraryIdentifiersAndAuthorityKeysOnBothRoutes() {
        for invalidID in [
            "thread-1", "thr_not-a-uuid", "thr_01234567-89AB-CDEF-0123-456789abcdef",
            "thr_01234567-89ab-cdef-0123-456789abcde", "thr_０1234567-89ab-cdef-0123-456789abcdef",
            " thr_01234567-89ab-cdef-0123-456789abcdef", "thr_01234567-89ab-cdef-0123-456789abcdef\n",
        ] {
            XCTAssertThrowsError(try NativeActionArgumentParser.parse([
                "action": "open_conversation",
                "threadId": invalidID,
            ]))
        }

        for authorityKey in authorityKeys {
            var openArguments = ["action": "open_conversation", "threadId": validThreadID]
            openArguments[authorityKey] = "https://untrusted.example"
            XCTAssertThrowsError(try NativeActionArgumentParser.parse(openArguments), "open_conversation accepted \(authorityKey)")

            var prepareArguments = ["action": "prepare_message", "threadId": validThreadID, "draft": "safe draft"]
            prepareArguments[authorityKey] = "https://untrusted.example"
            XCTAssertThrowsError(try NativeActionArgumentParser.parse(prepareArguments), "prepare_message accepted \(authorityKey)")
        }
    }

    func testParserRequiresExactRouteKeysAndRejectsUnknownActions() {
        XCTAssertThrowsError(try NativeActionArgumentParser.parse([
            "action": "open_conversation",
            "threadId": validThreadID,
            "draft": "unexpected",
        ]))
        XCTAssertThrowsError(try NativeActionArgumentParser.parse([
            "action": "prepare_message",
            "threadId": validThreadID,
        ]))
        XCTAssertThrowsError(try NativeActionArgumentParser.parse([
            "action": "send_message",
            "threadId": validThreadID,
        ]))
    }

    func testPrepareMessagePreservesCanonicalUnicodeAndRequiresConfirmation() throws {
        let text = "Olá 👋\nVeja isso"
        let route = try NativeActionArgumentParser.parse([
            "action": "prepare_message",
            "threadId": validThreadID,
            "draft": text,
        ])

        guard case .prepareMessage(_, let draft) = route else { return XCTFail("Expected draft route") }
        XCTAssertEqual(draft.text, text)
        XCTAssertTrue(route.requiresInAppConfirmation)
    }

    func testDraftNormalizesBeforeStorageAndEnforcesUTF16Bounds() throws {
        let decomposed = "Cafe\u{0301}"
        let normalized = try BoundedDraft(decomposed)
        XCTAssertEqual(normalized.text, "Café")

        let exactLimit = String(repeating: "😀", count: BoundedDraft.maximumUTF16Length / 2)
        XCTAssertEqual(try BoundedDraft(exactLimit).text.utf16.count, BoundedDraft.maximumUTF16Length)
        XCTAssertThrowsError(try BoundedDraft(exactLimit + "😀"))

        let normalizedWithinLimit = String(repeating: "a", count: 4_094) + "e\u{0301}"
        XCTAssertEqual(try BoundedDraft(normalizedWithinLimit).text.utf16.count, 4_095)
        let rawOverLimit = String(repeating: "a", count: 4_095) + "e\u{0301}"
        XCTAssertThrowsError(try BoundedDraft(rawOverLimit), "Raw input is bounded before normalization")
    }

    func testDraftRejectsEmptyControlBidiAndInvisibleOnlyText() {
        let invalidDrafts = [
            " \n\t", "\u{200B}", "\u{FEFF}", "safe\u{0001}text", "safe\u{007F}text",
            "safe\u{0085}text", "safe\u{009B}31m", "look\u{202E}txt.exe", "\u{202A}text\u{202C}",
            "safe\u{2066}hidden\u{2069}", "line\u{2028}separator", "paragraph\u{2029}separator",
        ]
        for invalid in invalidDrafts {
            XCTAssertThrowsError(try BoundedDraft(invalid), "Accepted unsafe or invisible text \(invalid.debugDescription)")
        }

        XCTAssertNoThrow(try BoundedDraft("line one\nline two"))
        XCTAssertNoThrow(try BoundedDraft("👩‍💻 shipped"), "ZWJ remains available in visible emoji sequences")
    }

    func testDraftAndRouteDiagnosticsNeverExposeDraftThroughReflectionOrDump() throws {
        let secret = "PRIVADO-XYZ-123"
        let draft = try BoundedDraft(secret)
        let route = NativeActionRoute.prepareMessage(threadID: try DexterThreadID(validThreadID), draft: draft)

        XCTAssertFalse(String(describing: draft).contains(secret))
        XCTAssertFalse(String(reflecting: draft).contains(secret))
        XCTAssertFalse(String(describing: route).contains(secret))
        XCTAssertFalse(String(reflecting: route).contains(secret))
        XCTAssertFalse("\(route)".contains(secret))
        XCTAssertFalse(Mirror(reflecting: draft).children.contains { ($0.value as? String) == secret })
        XCTAssertFalse(Mirror(reflecting: route).children.contains { String(reflecting: $0.value).contains(secret) })

        var dumpedDraft = ""
        dump(draft, to: &dumpedDraft)
        var dumpedRoute = ""
        dump(route, to: &dumpedRoute)
        XCTAssertFalse(dumpedDraft.contains(secret))
        XCTAssertFalse(dumpedRoute.contains(secret))
    }
}
