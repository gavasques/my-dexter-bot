import XCTest
import Foundation
import CryptoKit
import DexterHostClient
@testable import DexterAppCore

private actor RouteFixtureTransport: HTTPTransport {
    var requests: [URLRequest] = []
    var saved: Data?
    var loseACK = true
    var corruptHash = false
    func setCorruptHash() { corruptHash = true }
    func count(_ method: String) -> Int { requests.filter { $0.httpMethod == method }.count }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        requests.append(request)
        if request.httpMethod == "PATCH" {
            let body = try XCTUnwrap(request.httpBody)
            let input = try JSONDecoder().decode(DeviceRoutePatch.self, from: body)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let hash = SHA256.hash(data: try encoder.encode(input)).map { String(format: "%02x", $0) }.joined()
            let object: [String: Any] = ["schema":"dexter.device-route-receipt/1", "hostId":"host_qa", "ownerId":"owner_qa",
                "clientRequestId":input.clientRequestId, "requestHash":corruptHash ? String(repeating:"b",count:64) : hash,
                "request":try JSONSerialization.jsonObject(with: body), "committedAt":1000,
                "route":["id":"dvr_qa", "botId":"bot_qa", "deviceId":"dev_qa", "tool":"mac.file.read",
                    "fingerprint":String(repeating:"a",count:64), "generation":1, "pinRevision":1, "schemaHash":String(repeating:"c",count:64),
                    "operationVersion":"1.1.0", "revision":(input.expectedRevision ?? 0)+1, "status":input.status.rawValue,
                    "minimumGrantRevision":1, "needsFreshGrant":true]]
            saved = try JSONSerialization.data(withJSONObject: object)
            if loseACK { loseACK = false; throw URLError(.networkConnectionLost) }
            return TransportResponse(statusCode: 200, data: saved!)
        }
        if request.url?.path.contains("/receipts/") == true {
            return TransportResponse(statusCode: saved == nil ? 404 : 200, data: saved ?? Data())
        }
        let receipt = saved.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String:Any] }
        return TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: ["botId":"bot_qa", "routes":receipt.map { [$0["route"]!] } ?? []]))
    }
}
@MainActor private final class RouteCurrentFlag { var value = true }
@MainActor final class DeviceConversationRoutesTests: XCTestCase {
    func testLostACKUsesOriginalReceiptAcrossReopenAndNeverRepeatsPATCH() async throws {
        let transport = RouteFixtureTransport()
        let client = HostClient(baseURL: URL(string:"http://127.0.0.1:4317")!, transport:transport)
        let session = DeviceConversationRoutesSession(hostID:"host_qa",ownerID:"owner_qa",client:client,isCurrent:{true})
        await session.load(botID:"bot_qa")
        await session.set(deviceID:"dev_qa",tool:"mac.file.read",status:.active)
        XCTAssertNotNil(session.pending); XCTAssertFalse(session.canMutate)
        await session.set(deviceID:"dev_qa",tool:"mac.file.read",status:.active)
        let before = await transport.count("PATCH"); XCTAssertEqual(before,1)
        // Owner model retains this same session when the sheet reopens.
        await session.load(botID:"bot_qa"); XCTAssertNotNil(session.pending)
        await session.check()
        XCTAssertNil(session.pending); XCTAssertEqual(session.lastReceipt?.route.revision,1)
        XCTAssertEqual(session.routes.first?.status,.active)
        let after = await transport.count("PATCH"); XCTAssertEqual(after,1)
    }
    func testReceiptHashMismatchPreservesPendingAndStaleSessionCannotWrite() async throws {
        let transport = RouteFixtureTransport(); await transport.setCorruptHash()
        let current = RouteCurrentFlag()
        let client = HostClient(baseURL:URL(string:"http://127.0.0.1:4317")!,transport:transport)
        let session = DeviceConversationRoutesSession(hostID:"host_qa",ownerID:"owner_qa",client:client,isCurrent:{current.value})
        await session.load(botID:"bot_qa"); await session.set(deviceID:"dev_qa",tool:"mac.file.read",status:.active)
        await session.check(); XCTAssertNotNil(session.pending); XCTAssertEqual(session.error,.mutationOutcomeUnknown)
        current.value = false; await session.check(); await session.set(deviceID:"dev_qa",tool:"mac.file.read",status:.suspended)
        let mutations = await transport.count("PATCH"); XCTAssertEqual(mutations,1)
    }
    func testOwnerOnlySDKAndExplicitNullRevision() async throws {
        let transport = RouteFixtureTransport()
        let client = HostClient(baseURL:URL(string:"https://qa.invalid")!,accessPolicy:.unpairedHost,transport:transport)
        do { _ = try await client.deviceRoutes(botID:"bot_qa"); XCTFail("remote owner config must refuse") }
        catch { XCTAssertEqual(error as? HostClientError,.forbidden) }
        let request = DeviceRoutePatch(expectedHostId:"host_qa",clientRequestId:"req_qa",botId:"bot_qa",deviceId:"dev_qa",tool:"mac.file.read",expectedRevision:nil,status:.active)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String:Any])
        XCTAssertTrue(fields["expectedRevision"] is NSNull)
        let reads = await transport.count("GET"); XCTAssertEqual(reads,0)
    }
}
