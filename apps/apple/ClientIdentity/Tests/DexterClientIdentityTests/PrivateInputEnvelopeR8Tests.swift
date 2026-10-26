import Foundation
import XCTest
@testable import DexterClientIdentity

final class PrivateInputEnvelopeR8Tests:XCTestCase {
    func testOnlyExactPrivateRoutesReceiveReviewedByteBudgets() throws {
        let id = try ClientResourceID("mcpform_fixture")
        for route in [ClientRoute.health,.mcpInputRequests,.mcpInputPage(try ClientListPage(),history:true),.mcpServers,.connectionAccounts] {
            XCTAssertEqual(route.requestByteLimit,65_536); XCTAssertEqual(route.responseByteLimit,262_144)
        }
        XCTAssertEqual(ClientRoute.mcpInputRequest(id).requestByteLimit,65_536)
        XCTAssertEqual(ClientRoute.mcpInputRequest(id).responseByteLimit,1_052_672)
        XCTAssertEqual(ClientRoute.respondMcpInput(id).requestByteLimit,528_384)
        XCTAssertEqual(ClientRoute.respondMcpInput(id).responseByteLimit,1_052_672)
        let data = try JSONSerialization.data(withJSONObject:["padding":String(repeating:"x",count:300_000)])
        XCTAssertThrowsError(try ClientRequest(route:.appendMessage(id),body:data))
        XCTAssertThrowsError(try ClientRequest(route:.respondMcpInput(id),body:data),"larger budget never bypasses closed body validation")
    }
    func testLargePrivateFramingKeepsLengthEncodingHeaderAndTotalLimits() throws {
        let body = try JSONSerialization.data(withJSONObject:["synthetic":String(repeating:"x",count:624_353)])
        func wire(_ length:Int,_ extra:String = "") -> Data { Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(length)\r\nConnection: close\r\n\(extra)\r\n".utf8) + body }
        XCTAssertThrowsError(try ClientHTTPResponse.decode(wire(body.count),eof:true))
        XCTAssertEqual(try ClientHTTPResponse.decode(wire(body.count),eof:true,maxBodyBytes:1_052_672)?.data,body)
        XCTAssertThrowsError(try ClientHTTPResponse.decode(wire(1_052_673),eof:true,maxBodyBytes:1_052_672))
        XCTAssertThrowsError(try ClientHTTPResponse.decode(wire(body.count,"Transfer-Encoding: chunked\r\n"),eof:true,maxBodyBytes:1_052_672))
        XCTAssertThrowsError(try ClientHTTPResponse.decode(wire(body.count,"Content-Encoding: gzip\r\n"),eof:true,maxBodyBytes:1_052_672))
        XCTAssertThrowsError(try ClientHTTPResponse.decode(wire(body.count - 1),eof:true,maxBodyBytes:1_052_672))
        XCTAssertNil(try ClientHTTPResponse.decode(wire(body.count),eof:false,maxBodyBytes:1_052_672))
    }
}
