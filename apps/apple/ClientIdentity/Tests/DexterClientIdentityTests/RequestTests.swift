import XCTest
import Foundation
@testable import DexterClientIdentity
@MainActor final class RequestTests: XCTestCase {
    func testFiniteRoutesNoAgentJobsRawDispatchOrPrincipalBodies() throws {
        let id = try ClientResourceID("fixture"), page = try ClientPage(), listPage = try ClientListPage()
        let routes: [ClientRoute] = [.health,.contracts,.bots(listPage),.bot(id),.thread(id),.messages(id,page),.turns(id,page),.turn(id),.events(page),.turnEvents(id,page),.actions(listPage),.action(id),.devices(listPage),.device(id),.grants(id)]
        for route in routes { let request = try ClientRequest(route:route); XCTAssertEqual(request.route.method,"GET"); XCTAssertFalse(request.route.path.contains("/v1/device/poll")); XCTAssertFalse(request.route.path.contains("dispatch")) }
        for id in ["../poll","x?owner=foo","x\r\n",String(repeating:"a",count:129)] { XCTAssertThrowsError(try ClientResourceID(id)) }
        for (after,limit) in [(-1,10),(0,501),(0,0)] { XCTAssertThrowsError(try ClientPage(after:after,limit:limit)) }
        XCTAssertThrowsError(try ClientRequest.json(route:.pairClaim,value:["offerId":"offer","code":String(repeating:"a",count:32),"name":"Phone","role":"agent-mac"]))
        XCTAssertThrowsError(try ClientRequest.json(route:.presence,value:["state":"foreground","deviceId":"forged"]))
        XCTAssertThrowsError(try ClientRequest.json(route:.createBot,value:["name":"Bot","profileId":"profile","engine":"arbitrary"]))
        XCTAssertThrowsError(try ClientRequest.json(route:.decideAction(id),value:["decision":"allow","requestHash":"x","ownerId":"owner"]))
        XCTAssertThrowsError(try ClientRequest(route:.health,body:Data("{}".utf8)))
        XCTAssertThrowsError(try ClientRequest(route:.pairStatus,body:Data(repeating:120,count:65_537)))
        XCTAssertNoThrow(try ClientRequest.json(route:.putGrant,value:["botId":"bot","tool":"mac.file.append","destination":"device","policy":"ask","expectedRevision":NSNull(),"expiresAt":NSNull()]))
        XCTAssertThrowsError(try ClientRequest.json(route:.putGrant,value:["botId":"bot","tool":"mac.file.append","destination":"device","policy":"allow","expiresAt":NSNull(),"expectedRevision":true]))
    }
    func testFiniteFramingAcceptsStatusesAndRefusesAmbiguity() throws {
        func bytes(_ status: Int = 200,_ fields: String = "",_ body: String = "{}") -> Data { Data("HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\(fields)\r\n\(body)".utf8) }
        for status in [200,201,202,400,403,409,503] { XCTAssertEqual(try ClientHTTPResponse.decode(bytes(status),eof:true)?.statusCode,status) }
        XCTAssertNil(try ClientHTTPResponse.decode(bytes(),eof:false))
        for data in [bytes(302),bytes(200,"Transfer-Encoding: chunked\r\n"),bytes(200,"Content-Length: 2\r\n"),bytes(200,"X-A: b\nTransfer-Encoding: chunked\r\n"),bytes(200,"Content-Encoding: gzip\r\n"),bytes()+Data("extra".utf8)] { XCTAssertThrowsError(try ClientHTTPResponse.decode(data,eof:true)) }
        XCTAssertThrowsError(try ClientHTTPResponse.decode(Data("HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n".utf8),eof:true))
    }
    func testCanonicalUTF8IsExactlyValidatedObjectWithBothSizeBounds() throws {
        let duplicate = Data(#"{"claimId":"good_claim","claimId":"../../evil"}"#.utf8)
        let request = try ClientRequest(route:.pairStatus,body:duplicate)
        let parsed = try JSONSerialization.jsonObject(with:duplicate) as! [String:Any]
        XCTAssertEqual(request.body,try JSONSerialization.data(withJSONObject:parsed,options:.sortedKeys))
        XCTAssertFalse(String(decoding:request.body,as:UTF8.self).contains("evil"))
        let padded = Data("  { \"claimId\": \"good_claim\" }  ".utf8)
        let utf16 = "{\"claimId\":\"good_claim\"}".data(using:.utf16)!
        for data in [padded,utf16] {
            XCTAssertEqual(try ClientRequest(route:.pairStatus,body:data).body,Data(#"{"claimId":"good_claim"}"#.utf8))
        }
        let id = try ClientResourceID("thread")
        // UTF16 input is below cap, but validated CJK content expands beyond the UTF8 cap.
        let text = "{\"clientMessageId\":\"message\",\"content\":\""+String(repeating:"漢",count:30000)+"\"}"
        let expanded = text.data(using:.utf16)!
        XCTAssertLessThan(expanded.count,65536)
        XCTAssertThrowsError(try ClientRequest(route:.appendMessage(id),body:expanded))
        XCTAssertThrowsError(try ClientRequest(route:.pairStatus,body:Data(repeating:32,count:65537)))
    }

}
