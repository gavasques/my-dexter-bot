import XCTest
import Foundation
@testable import DexterDeviceIdentity

final class FramingTests:XCTestCase {
    private func wire(_ headers:String = "Content-Length: 2\r\nContent-Type: application/json",status:String = "200 OK",body:String = "{}") -> Data { Data("HTTP/1.1 \(status)\r\n\(headers)\r\n\r\n\(body)".utf8) }
    func testFiniteFramingRejectsSmugglingRedirectEncodingAndTruncation() throws {
        XCTAssertEqual(try HTTPResponse.decode(wire(),eof:true),Data("{}".utf8))
        let complete = wire(); XCTAssertNil(try HTTPResponse.decode(complete,eof:false)); XCTAssertNil(try HTTPResponse.decode(Data(complete.dropLast()),eof:false))
        for data in [wire("Content-Length: 2\r\nContent-Length: 2\r\nContent-Type: application/json"),wire("Content-Length: 2\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json"),wire("Content-Length: 2\r\nContent-Encoding: gzip\r\nContent-Type: application/json"),wire("Content-Length: 02\r\nContent-Type: application/json"),wire(status:"302 Found"),wire(body:"{}x"),wire(body:"{"),Data(repeating:65,count:16_385)] {
            XCTAssertThrowsError(try HTTPResponse.decode(data,eof:true))
        }
    }
    func testEveryHeaderLineRejectsBareControlsIncludingHiddenTransferEncoding() throws {
        for control in ["\n","\r","\u{0}","\u{1}","\t","\u{7f}"] {
            let bytes = wire("X-A: b\(control)Transfer-Encoding: chunked\r\nContent-Length: 2\r\nContent-Type: application/json")
            XCTAssertThrowsError(try HTTPResponse.decode(bytes,eof:true)) { XCTAssertEqual($0 as? IdentityFailure,.protocolError) }
        }
    }
    func testRemoteErrorsExposeOnlyClosedCodesAndNeverRemoteMessage() throws {
        let secretText = "synthetic-do-not-return"
        let body = "{\"error\":\"forbidden\",\"message\":\"\(secretText)\"}"
        do { _ = try HTTPResponse.decode(wire("Content-Length: \(body.utf8.count)\r\nContent-Type: application/json",status:"403 Forbidden",body:body),eof:true); XCTFail("remote refusal accepted") }
        catch { XCTAssertEqual(error as? RemoteDeviceFailure,.forbidden); XCTAssertFalse(String(describing:error).contains(secretText)) }
        let unknown = "{\"error\":\"arbitrary-peer-text\"}"
        XCTAssertThrowsError(try HTTPResponse.decode(wire("Content-Length: \(unknown.utf8.count)\r\nContent-Type: application/json",status:"400 Bad Request",body:unknown),eof:true)) { XCTAssertEqual($0 as? IdentityFailure,.protocolError) }
    }
}
