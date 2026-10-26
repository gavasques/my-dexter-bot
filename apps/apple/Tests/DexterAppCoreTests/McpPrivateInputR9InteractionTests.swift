import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient

/// Synthetic pages deliberately put this conversation beyond the first lexical page.
private actor R9InteractionTransport: HTTPTransport {
    private var holdNextPage = false
    private var pageHeld = false
    private var heldPage: CheckedContinuation<Void, Never>?
    private var releasePage = false
    private var unknownAnswer = false
    private var answered = false
    private var firstPageMatches = false
    private var summaryRevision = 1
    private var summaryState = "pending"
    private var summaryHash = String(repeating: "a", count: 64)
    private var retainedCount = 201
    private var holdNextDetail = false
    private var detailHeld = false
    private var heldDetail: CheckedContinuation<Void, Never>?
    private let hostID: String
    private var posts: [[String: JSONValue]] = []
    private var paths: [String] = []

    init(hostID: String = "host_r9") { self.hostID = hostID }

    func holdPage() { holdNextPage = true; releasePage = false; pageHeld = false }
    func makeAnswerUnknown() { unknownAnswer = true }
    func emptyWindow() { retainedCount = 0 }
    func holdExactRead() { holdNextDetail = true; detailHeld = false }
    func releaseExactRead() { heldDetail?.resume(); heldDetail = nil }
    func publishSummary(revision: Int, state: String, hash: String = String(repeating: "a", count: 64)) {
        firstPageMatches = true; summaryRevision = revision; summaryState = state; summaryHash = hash
    }
    func release() { releasePage = true; heldPage?.resume(); heldPage = nil }
    func postCount() -> Int { posts.count }
    func reads() -> [String] { paths }
    func waitUntilHeld() async -> Bool {
        for _ in 0..<100 {
            if pageHeld { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
    func waitUntilExactReadHeld() async -> Bool {
        for _ in 0..<100 {
            if detailHeld { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
    private func input(id: String, thread: String, state: String = "pending", revision: Int = 1) -> [String: Any] {
        var row: [String: Any] = ["version": 1, "id": id, "actionId": "act_r9", "requestHash": String(repeating: "a", count: 64),
            "connectionId": "conn_r9", "botId": "bot_r9", "threadId": thread, "revision": revision, "state": state,
            "requests": ["r1": ["method": "elicitation/create", "params": ["message": "Synthetic preference", "requestedSchema": ["type": "object", "properties": ["confirm": ["type": "boolean"]], "required": ["confirm"], "additionalProperties": false]]]],
            "createdAt": 1, "expiresAt": 9_000_000_000_000 as Int64, "responseHash": NSNull(), "clientRequestId": NSNull()]
        if answered, id == "mcpform_a", let request = posts.last, case .string(let uuid)? = request["clientRequestId"] {
            row["clientRequestId"] = uuid
        }
        return row
    }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let url = try XCTUnwrap(request.url)
        paths.append(url.path)
        let body: [String: Any]
        switch url.path {
        case "/health":
            body = ["protocolVersion": 1, "mode": "local-development", "remotePairing": "not_implemented", "hostId": hostID, "engineRouting": "synthetic", "state": [:]]
        case "/v1/mcp/input-requests":
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let history = query.contains { $0.name == "view" && $0.value == "history" }
            let later = query.contains { $0.name == "after" }
            var summaries: [[String: Any]] = []
            if retainedCount > 0, !answered || history {
                let matching = later || firstPageMatches
                var row = input(id: matching ? "mcpform_a" : "mcpform_z", thread: matching ? "thread_r9" : "thread_other", state: answered && later ? "answered" : "pending", revision: answered && later ? 2 : 1)
                if matching, firstPageMatches {
                    row["revision"] = summaryRevision; row["state"] = summaryState; row["requestHash"] = summaryHash
                }
                row.removeValue(forKey: "requests"); row["detailState"] = "not_loaded"
                summaries = [row]
            }
            body = ["version": 2, "view": history ? "history" : "active", "summaries": summaries, "nextCursor": later || answered || retainedCount == 0 ? NSNull() : "mcpform_z", "retainedRequestCount": retainedCount, "activeRequestCount": answered || retainedCount == 0 ? 0 : 2, "scannedRequestCount": summaries.count, "invalidRequestCount": 0, "invalidCountScope": "page_envelopes", "quarantinedRequestCount": 0, "omittedRequestCount": retainedCount == 0 ? 0 : 200, "unverifiedRequestCount": summaries.count, "incomplete": false]
            if holdNextPage {
                holdNextPage = false; pageHeld = true
                if !releasePage { await withCheckedContinuation { heldPage = $0 } }
            }
        case "/v1/mcp/input-requests/mcpform_a":
            body = input(id: "mcpform_a", thread: "thread_r9", state: answered ? "answered" : "pending", revision: answered ? 2 : 1)
            if holdNextDetail {
                holdNextDetail = false; detailHeld = true
                await withCheckedContinuation { heldDetail = $0 }
            }
        case "/v1/mcp/input-requests/mcpform_a/respond":
            posts.append(try JSONDecoder().decode([String: JSONValue].self, from: request.httpBody ?? Data()))
            answered = true
            if unknownAnswer { throw HostClientError.mutationOutcomeUnknown }
            body = input(id: "mcpform_a", thread: "thread_r9", state: "answered", revision: 2)
        default: throw HostClientError.notFound
        }
        return .init(statusCode: 200, data: try JSONSerialization.data(withJSONObject: body))
    }
}

@MainActor final class McpPrivateInputR9InteractionTests: XCTestCase {
    private func editor(_ transport: R9InteractionTransport, scope: String = "synthetic-r9", ownsClient: Bool = true) -> McpPrivateInputEditor {
        .init(client: HostClient(baseURL: URL(string: "http://127.0.0.1:9993")!, transport: transport), ownsClient: ownsClient, scope: scope)
    }
    private func openLaterPage(_ editor: McpPrivateInputEditor) async throws -> McpPrivateInput {
        await editor.load()
        await editor.showHistory(true)
        await editor.more()
        await editor.open(try XCTUnwrap(editor.summaries.first { $0.id == "mcpform_a" }))
        return try XCTUnwrap(editor.open(threadID: "thread_r9").first)
    }
    func testRefreshKeepsOpenedExactFormBeyondFirstPage() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        await editor.load()
        XCTAssertTrue(editor.showingHistory)
        XCTAssertEqual(editor.open(threadID: "thread_r9"), [input], "metadata window refresh must preserve the exact opened form")
        let paths = await transport.reads()
        XCTAssertEqual(paths.filter { $0 == "/v1/mcp/input-requests/mcpform_a" }.count, 1, "no bulk detail hydration")
        let count = await transport.postCount(); XCTAssertEqual(count, 0)
    }
    func testHeldMetadataReadDoesNotConsumeOrPreventReviewedAnswer() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        let reviewed = McpPrivateInputAnswer.accept(["r1": ["confirm": .bool(true)]])
        await transport.holdPage()
        let poll = Task { await editor.poll() }
        guard await transport.waitUntilHeld() else { await transport.release(); await poll.value; return XCTFail("finite page fixture did not hold") }
        XCTAssertTrue(editor.listBusy); XCTAssertFalse(editor.busy)
        let attempted = await editor.respond(input, answer: reviewed)
        XCTAssertTrue(attempted, "the view clears review only after this exact gesture was admitted")
        let count = await transport.postCount(); XCTAssertEqual(count, 1, "a metadata read must not silently swallow the reviewed send")
        await transport.release(); await poll.value
        XCTAssertEqual(editor.notice, .answered(.answered))
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty, "late page cannot resurrect the submitted revision")
    }

    func testBackgroundPollKeepsHistoryPaginationAndOpenedForm() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        let summaries = editor.summaries, cursor = editor.nextCursor
        await editor.poll()
        XCTAssertTrue(editor.showingHistory)
        XCTAssertEqual(editor.summaries, summaries)
        XCTAssertEqual(editor.nextCursor, cursor, "poll must not rewind the later-page cursor to page one")
        XCTAssertEqual(editor.open(threadID: "thread_r9"), [input])
        let paths = await transport.reads()
        XCTAssertEqual(paths.filter { $0 == "/v1/mcp/input-requests/mcpform_a" }.count, 1)
    }

    func testConversationWithoutFirstPageMatchKeepsItsOwnHistoryControls() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        await editor.load()
        XCTAssertTrue(editor.visibleSummaries(threadID: "thread_r9").isEmpty)
        XCTAssertTrue(editor.hasVisibleContent(threadID: "thread_r9"))
        await editor.showHistory(true)
        XCTAssertTrue(editor.visibleSummaries(threadID: "thread_r9").isEmpty)
        XCTAssertTrue(editor.hasListNavigation)
        XCTAssertTrue(editor.hasVisibleContent(threadID: "thread_r9"), "history must never hide its return or next-page control")
        await editor.more()
        XCTAssertEqual(editor.visibleSummaries(threadID: "thread_r9").map(\.id), ["mcpform_a"])
        await editor.showHistory(false)
        XCTAssertFalse(editor.showingHistory)
        XCTAssertTrue(editor.hasVisibleContent(threadID: "thread_r9"))
    }

    func testUnknownOutcomeKeepsExactCheckAfterCardDisappearsAndNeverRepeatsEffect() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        let summary = try XCTUnwrap(editor.summaries.first { $0.id == input.id })
        await transport.makeAnswerUnknown()
        await editor.respond(input, answer: .accept(["r1": ["confirm": .bool(true)]]))
        let pending = try XCTUnwrap(editor.pending)
        XCTAssertEqual(editor.notice, .unknown)
        XCTAssertEqual(pending.threadID, "thread_r9")
        await editor.poll()
        // Exact GET observes the recorded terminal revision; the pending recovery path is independent of open().
        await editor.open(summary)
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty)
        XCTAssertEqual(editor.pending, pending)
        XCTAssertTrue(editor.hasVisibleContent(threadID: "thread_r9"))
        let repeated = await editor.respond(input, answer: .decline)
        XCTAssertFalse(repeated, "pending reconciliation refuses every second effect")
        await editor.check()
        XCTAssertNil(editor.pending)
        XCTAssertEqual(editor.notice, .answered(.answered))
        let paths = await transport.reads(), posts = await transport.postCount()
        XCTAssertEqual(paths.last, "/v1/mcp/input-requests/mcpform_a")
        XCTAssertEqual(posts, 1)
    }

    func testClosedEditorDiscardsHeldBackgroundPage() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        await editor.load()
        let before = editor.summaries
        await transport.holdPage()
        let poll = Task { await editor.poll() }
        guard await transport.waitUntilHeld() else { await transport.release(); await poll.value; return XCTFail("finite page fixture did not hold") }
        editor.close()
        await transport.release(); await poll.value
        XCTAssertEqual(editor.summaries, before)
        XCTAssertNil(editor.notice)
        XCTAssertFalse(editor.listBusy)
        let posts = await transport.postCount(); XCTAssertEqual(posts, 0)
    }

    func testObservedTerminalRevisionRejectsLateOlderDetailAndEveryOldAnswer() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        await transport.publishSummary(revision: 2, state: "answered")
        await editor.poll()
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty)
        let declined = await editor.respond(input, answer: .decline); XCTAssertFalse(declined)
        let observed = try XCTUnwrap(editor.visibleSummaries(threadID: "thread_r9").first)
        await editor.open(observed) // fixture intentionally returns the older pending detail
        XCTAssertEqual(editor.notice, .conflict)
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty, "a late older GET cannot restore actionability")
        let cancelled = await editor.respond(input, answer: .cancel); XCTAssertFalse(cancelled)
        let count = await transport.postCount(); XCTAssertEqual(count, 0)
    }

    func testObservedHashChangeRequiresFreshExactReadEvenIfOldMetadataReturns() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        await transport.publishSummary(revision: 1, state: "pending", hash: String(repeating: "b", count: 64))
        await editor.poll()
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty)
        XCTAssertEqual(editor.visibleSummaries(threadID: "thread_r9").map(\.id), [input.id], "changed forms must retain their exact GET entry")
        await transport.publishSummary(revision: 1, state: "pending")
        await editor.poll()
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty, "metadata alone cannot restore the old review")
        let declined = await editor.respond(input, answer: .decline); XCTAssertFalse(declined)
        await editor.open(try XCTUnwrap(editor.visibleSummaries(threadID: "thread_r9").first))
        XCTAssertEqual(editor.open(threadID: "thread_r9"), [input], "only a new explicit canonical GET restores this unchanged pending form")
        let count = await transport.postCount(); XCTAssertEqual(count, 0)
    }

    func testFirstExactOpenRejectsDetailOlderThanItsObservedSummary() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        await transport.publishSummary(revision: 2, state: "pending")
        await editor.load()
        await editor.open(try XCTUnwrap(editor.visibleSummaries(threadID: "thread_r9").first))
        XCTAssertTrue(editor.inputs.isEmpty, "an older detail is not a new actionable form")
        XCTAssertTrue(editor.open(threadID: "thread_r9").isEmpty)
        XCTAssertEqual(editor.notice, .conflict)
        XCTAssertEqual(editor.visibleSummaries(threadID: "thread_r9").count, 1)
        let count = await transport.postCount(); XCTAssertEqual(count, 0)
    }

    func testPendingFromConversationARemainsVisibleInBAndChecksOnlyOriginalA() async throws {
        let transport = R9InteractionTransport(), editor = editor(transport)
        defer { editor.close() }
        let input = try await openLaterPage(editor)
        await transport.makeAnswerUnknown()
        await editor.respond(input, answer: .accept(["r1": ["confirm": .bool(true)]]))
        let pending = try XCTUnwrap(editor.pending)
        await transport.emptyWindow()
        await editor.showHistory(false)
        XCTAssertFalse(editor.hasListNavigation)
        XCTAssertTrue(editor.open(threadID: "thread_other").isEmpty)
        XCTAssertTrue(editor.visibleSummaries(threadID: "thread_other").isEmpty)
        XCTAssertTrue(editor.hasVisibleContent(threadID: "thread_other"), "the global pending effect must retain its Check even in another thread's display context")
        XCTAssertEqual(pending.threadID, "thread_r9")
        XCTAssertEqual(pending.expectedHostID, "host_r9")
        let before = await transport.reads()
        await editor.check()
        let after = await transport.reads()
        XCTAssertEqual(Array(after.dropFirst(before.count)), ["/v1/mcp/input-requests/mcpform_a"])
        XCTAssertNil(editor.pending)
        XCTAssertEqual(editor.notice, .answered(.answered))
        let count = await transport.postCount(); XCTAssertEqual(count, 1, "displaying B never sends a response for B or repeats A")
    }

    func testBaseScopeResetDiscardsOldHeldRecoveryAndRefusesOldCallback() async throws {
        let oldTransport = R9InteractionTransport(), oldEditor = editor(oldTransport, ownsClient: false)
        let input = try await openLaterPage(oldEditor)
        await oldTransport.makeAnswerUnknown()
        await oldEditor.respond(input, answer: .accept(["r1": ["confirm": .bool(true)]]))
        let oldPending = try XCTUnwrap(oldEditor.pending)
        await oldTransport.holdExactRead()
        let check = Task { await oldEditor.check() }
        guard await oldTransport.waitUntilExactReadHeld() else { oldEditor.close(); await oldTransport.releaseExactRead(); await check.value; return XCTFail("finite exact-read fixture did not hold") }
        oldEditor.close()
        let newTransport = R9InteractionTransport(hostID: "host_new_r9"), newEditor = editor(newTransport, scope: "synthetic-new-base")
        defer { newEditor.close() }
        await newEditor.load()
        let pathsBeforeCallback = await oldTransport.reads()
        await oldTransport.releaseExactRead(); await check.value
        await oldEditor.check() // a retained UI closure from the old base has no authority
        let pathsAfterCallback = await oldTransport.reads()
        XCTAssertEqual(pathsAfterCallback, pathsBeforeCallback)
        XCTAssertEqual(oldEditor.pending, oldPending, "late old GET cannot settle or publish after closure")
        XCTAssertEqual(oldEditor.notice, .unknown)
        XCTAssertNil(newEditor.pending)
        XCTAssertNil(newEditor.notice)
        XCTAssertEqual(newEditor.scope, "synthetic-new-base")
        let oldPosts = await oldTransport.postCount(), newPosts = await newTransport.postCount()
        XCTAssertEqual(oldPosts, 1); XCTAssertEqual(newPosts, 0)
    }
}
