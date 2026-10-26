import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient

private actor R8PageTransport:HTTPTransport {
    var paths:[String] = []
    private let row = #"{"version":1,"id":"mcpform_z","actionId":"act_r8","requestHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","connectionId":"conn_r8","botId":"bot_r8","threadId":"thread_r8","revision":1,"state":"pending","requests":{"r1":{"method":"elicitation/create","params":{"message":"Synthetic preference","requestedSchema":{"type":"object","properties":{"confirm":{"type":"boolean"}},"required":["confirm"],"additionalProperties":false}}}},"createdAt":1,"expiresAt":9000000000000,"responseHash":null,"clientRequestId":null}"#
    func send(_ request:URLRequest) async throws -> TransportResponse {
        let url = try XCTUnwrap(request.url); paths.append(url.path)
        var body:String
        switch url.path {
        case "/health":body = #"{"protocolVersion":1,"mode":"local-development","remotePairing":"not_implemented","hostId":"host_r8","engineRouting":"synthetic","state":{}}"#
        case "/v1/mcp/input-requests":
            var summary = try XCTUnwrap(JSONSerialization.jsonObject(with:Data(row.utf8)) as? [String:Any])
            summary.removeValue(forKey:"requests");summary["detailState"] = "not_loaded"
            let history = URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.contains { $0.name == "view" && $0.value == "history" } == true
            let object:[String:Any] = ["version":2,"view":history ? "history":"active","summaries":[summary],"nextCursor":NSNull(),"retainedRequestCount":300,"activeRequestCount":1,"scannedRequestCount":1,"invalidRequestCount":0,"invalidCountScope":"page_envelopes","quarantinedRequestCount":0,"omittedRequestCount":299,"unverifiedRequestCount":1,"incomplete":false]
            return .init(statusCode:200,data:try JSONSerialization.data(withJSONObject:object))
        case "/v1/mcp/input-requests/mcpform_z":body = row
        default:throw HostClientError.notFound
        }
        return .init(statusCode:200,data:Data(body.utf8))
    }
    func reads()->[String] { paths }
}

@MainActor final class McpPrivateInputPageR8Tests:XCTestCase {
    func testSummaryLoadNeverHydratesUntilHumanOpensOneExactForm() async throws {
        let transport = R8PageTransport(),client = HostClient(baseURL:URL(string:"http://127.0.0.1:9991")!,transport:transport)
        let editor = McpPrivateInputEditor(client:client,ownsClient:true,scope:"synthetic-r8")
        await editor.load()
        XCTAssertNil(editor.notice);XCTAssertTrue(editor.inputs.isEmpty);XCTAssertEqual(editor.summaries.count,1)
        XCTAssertEqual(editor.retainedRequestCount,300);XCTAssertEqual(editor.omittedRequestCount,299);XCTAssertFalse(editor.listIncomplete)
        var paths = await transport.reads();XCTAssertEqual(paths,["/health","/v1/mcp/input-requests"])
        await editor.open(try XCTUnwrap(editor.summaries.first))
        XCTAssertEqual(editor.open().map(\.id),["mcpform_z"]);XCTAssertTrue(editor.visibleSummaries().isEmpty)
        paths = await transport.reads();XCTAssertEqual(paths.last,"/v1/mcp/input-requests/mcpform_z")
        await editor.showHistory(true);XCTAssertTrue(editor.showingHistory);XCTAssertNil(editor.notice)
        editor.close()
    }
}

private actor R8HeldPageTransport:HTTPTransport {
    let base = R8PageTransport()
    var isHeld = false
    var released = false
    var hold:CheckedContinuation<Void,Never>?
    func send(_ request:URLRequest) async throws -> TransportResponse {
        let response = try await base.send(request)
        if request.url?.path == "/v1/mcp/input-requests" {
            isHeld = true
            if !released { await withCheckedContinuation { hold = $0 } }
        }
        return response
    }
    func waitUntilHeld() async -> Bool {
        for _ in 0..<100 { if isHeld { return true };try? await Task.sleep(for:.milliseconds(20)) };return false
    }
    func release() { released = true;hold?.resume();hold = nil }
}

extension McpPrivateInputPageR8Tests {
    func testClosingOldBaseDiscardsLatePageAndViewCannotChangeWhileReading() async {
        let transport = R8HeldPageTransport(),client = HostClient(baseURL:URL(string:"http://127.0.0.1:9991")!,transport:transport)
        let editor = McpPrivateInputEditor(client:client,ownsClient:false,scope:"old-base")
        let load = Task { await editor.load() }
        guard await transport.waitUntilHeld() else { editor.close();await transport.release();await load.value;XCTFail("Page was never requested within the finite fixture budget");return }
        await editor.showHistory(true);XCTAssertFalse(editor.showingHistory,"view changes cannot race a page read")
        editor.close();await transport.release();await load.value
        XCTAssertTrue(editor.summaries.isEmpty);XCTAssertTrue(editor.inputs.isEmpty);XCTAssertNil(editor.supported)
    }
}
