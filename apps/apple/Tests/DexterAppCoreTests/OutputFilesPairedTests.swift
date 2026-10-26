#if os(macOS)
import CryptoKit
import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity
@testable import DexterHostClient

/// Output folders through the PAIRED SDK path (HostClient → PairedHTTPTransport → ClientRequest/ClientRoute). The native
/// mutual-TLS leg is replaced by a sender that mirrors its scope gate; the live test forwards to a real Hono router with a
/// synthetic paired authority (`scripts/output-paired-live-host.mjs`). In-memory identity only: no Keychain, TCC or account.
private struct ForwardSender: PairedNativeSending {
    let base: URL?
    let scopes: [ClientScope]
    let failure: ClientIdentityFailure?
    let counter: RequestCounter
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        await counter.add(request.route.path)
        // Same client-side gate as the native transport: the approved binding must hold the route's scope.
        guard request.route.scope.map({ scopes.contains($0) }) ?? true else { throw ClientIdentityFailure.forbidden }
        if let failure { throw failure }
        guard let base, let url = URL(string: base.absoluteString + request.route.path) else { throw ClientIdentityFailure.unavailable }
        var urlRequest = URLRequest(url: url); urlRequest.httpMethod = request.route.method
        if request.route.method != "GET" { urlRequest.httpBody = request.body; urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            let (data, response) = try await URLSession(configuration: .ephemeral).data(for: urlRequest)
            return ClientTransportResponse(statusCode: (response as! HTTPURLResponse).statusCode, data: data)
        } catch { throw request.route.mutating ? ClientIdentityFailure.outcomeUnknown : ClientIdentityFailure.unavailable }
    }
    func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
}
private actor RequestCounter { var paths: [String] = []; func add(_ path: String) { paths.append(path) }; func all() -> [String] { paths } }

@MainActor final class OutputFilesPairedTests: XCTestCase {
    private func binding(installation: String, owner: String, port: Int, certificate: Data, scopes: [ClientScope]) throws -> PairedHostBinding {
        let fingerprint = SHA256.hash(data: certificate).map { String(format: "%02x", $0) }.joined()
        let host = try PinnedClientHost(url: URL(string: "https://127.0.0.1:\(port)")!, certificateDER: certificate, fingerprint: fingerprint)
        let scope = try ClientIdentityScope(installationID: installation, localBindingID: String(repeating: "b", count: 32), role: .clientMac, hostFingerprint: fingerprint)
        let bundle = try ClientPairingBundle(host: host, installationID: installation, offerID: "offer", role: .clientMac, expiresAt: Date().addingTimeInterval(300), code: String(repeating: "x", count: 43))
        return try PairedHostBinding(bundle: bundle, scope: scope, identity: try ClientNativeIdentity.ephemeralFixture(), claimID: "claim",
            value: ["protocol": "dexter-app-client-v1", "status": "approved", "deviceId": "device_fixture", "installationId": installation, "ownerId": owner,
                    "role": "client-mac", "scopes": scopes.map(\.rawValue).sorted(), "pinGeneration": 1, "bindingRevision": 1])
    }
    private func client(_ binding: PairedHostBinding, base: URL?, failure: ClientIdentityFailure? = nil, counter: RequestCounter) -> HostClient {
        HostClient(baseURL: binding.host.url, accessPolicy: .pairedHost(binding),
                   transport: PairedHTTPTransport(binding: binding, sender: ForwardSender(base: base, scopes: binding.scopes, failure: failure, counter: counter)))
    }
    private func liveInfo() throws -> [String: Any]? {
        guard let path = ProcessInfo.processInfo.environment["DEXTER_OUTPUT_PAIRED_LIVE"] else { return nil }
        return try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any]
    }

    func testPairedRoutesAreClosedStrictlyEncodedAndBinaryOnlyForContent() throws {
        guard let info = try liveInfo(), let der = Data(base64Encoded: info["certDER"] as! String) else { throw XCTSkip("no synthetic paired host") }
        let bound = try binding(installation: info["hostId"] as! String, owner: info["ownerId"] as! String, port: info["port"] as! Int, certificate: der, scopes: [.outputsRead])
        let base = "https://127.0.0.1:\(info["port"] as! Int)"
        var content = URLRequest(url: URL(string: base + "/v1/output-files/content?namespace=bot:b_1&path=slides/apresenta%C3%A7%C3%A3o.pptx&pin=\(String(repeating: "a", count: 64))&offset=0&length=262144")!)
        content.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        let prepared = try PairedHTTPTransport.prepare(content, binding: bound)
        XCTAssertEqual(prepared.route.path, "/v1/output-files/content?length=262144&namespace=bot%3Ab_1&offset=0&path=slides%2Fapresenta%C3%A7%C3%A3o.pptx&pin=\(String(repeating: "a", count: 64))")
        XCTAssertEqual(prepared.route.scope, .outputsRead); XCTAssertFalse(prepared.route.mutating)
        var listing = URLRequest(url: URL(string: base + "/v1/output-files/entries?namespace=general")!); listing.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        XCTAssertThrowsError(try PairedHTTPTransport.prepare(listing, binding: bound), "octet-stream only for content")
        for bad in ["/v1/output-files/entries?namespace=general&owner=x", "/v1/output-files/status?x=1", "/v1/output-files/receipts/../x", "/v1/output-files/destination"] {
            XCTAssertThrowsError(try PairedHTTPTransport.prepare(URLRequest(url: URL(string: base + bad)!), binding: bound), bad)
        }
        var put = URLRequest(url: URL(string: base + "/v1/output-files/destination")!); put.httpMethod = "PUT"
        put.httpBody = Data(#"{"expectedHostID":"h","clientRequestId":"c","expectedRevision":1,"destination":{"kind":"owner_path","path":"/x"},"ownerId":"forged"}"#.utf8)
        XCTAssertThrowsError(try PairedHTTPTransport.prepare(put, binding: bound), "body never carries authority")
    }

    func testScopesAreCheckedBeforeAnyByteAndAConfiguredVPSNeverFallsBack() async throws {
        guard let info = try liveInfo(), let der = Data(base64Encoded: info["certDER"] as! String) else { throw XCTSkip("no synthetic paired host") }
        let hostID = info["hostId"] as! String, owner = info["ownerId"] as! String, port = info["port"] as! Int
        // No outputs scope: refused locally, zero requests.
        let counter = RequestCounter()
        let none = client(try binding(installation: hostID, owner: owner, port: port, certificate: der, scopes: [.chatRead, .grantsManage]), base: nil, counter: counter)
        defer { none.close() }
        do { _ = try await none.outputFilesStatus(); XCTFail("no scope") } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let reader = client(try binding(installation: hostID, owner: owner, port: port, certificate: der, scopes: [.outputsRead]), base: nil, counter: counter)
        defer { reader.close() }
        let status = try JSONDecoder().decode(OutputFilesStatus.self, from: Data(#"{"version":1,"hostId":"\#(hostID)","revision":1,"persisted":false,"current":{"generation":1,"kind":"host_data_legacy","layout":"legacy","path":"/x","current":true,"availability":"available","namespaces":{"general":false,"bots":true,"teams":true},"createdAt":null,"retiredAt":null},"host":{"platform":"linux"},"scope":{"botFileTools":"own_bot_namespace","teamFileTools":"team_namespace_revalidated","groupTurns":"no_file_tools","terminalCwd":"output_namespace_not_os_sandbox","engineNativeWorkspace":"internal_not_outputs","contextDocuments":"separate_custody","sharing":"not_implemented","remoteBrowsing":"owner_loopback_only"},"limits":{"pageEntries":200,"scannedEntries":10000,"chunkBytes":8388608,"exportBytes":2147483648,"hashedBytes":268435456,"toolFileBytes":65536}}"#.utf8))
        do { _ = try await reader.setOutputDestination(.init(status: status, destination: .hostDataDefault, clientRequestId: "never")); XCTFail("read is not manage") }
        catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        do { _ = try await reader.outputDestinationReceipt(clientRequestID: "never"); XCTFail("receipts are manage") } catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        let sent = await counter.all(); XCTAssertEqual(sent, [], "nothing left the app")
        // Editor bound to the VPS: another installation's binding or a loopback client is never used for it.
        let foreign = client(try binding(installation: "host_other_installation", owner: owner, port: port, certificate: der, scopes: [.outputsRead]), base: nil, counter: counter)
        defer { foreign.close() }
        let mismatched = OutputFilesEditor(base: .remote(hostID: hostID), client: foreign)
        XCTAssertFalse(mismatched.clientMatchesBase); await mismatched.reload()
        XCTAssertEqual(mismatched.notice, .remoteBrowsingUnavailable)
        let local = OutputFilesEditor(base: .remote(hostID: hostID), client: HostClient(baseURL: URL(string: "http://127.0.0.1:9")!))
        await local.reload(); XCTAssertEqual(local.notice, .remoteBrowsingUnavailable, "a loopback client never stands in for the VPS")
        let afterMismatch = await counter.all(); XCTAssertEqual(afterMismatch, [])
        // VPS offline: the paired base reports offline; no other base is contacted.
        let offline = client(try binding(installation: hostID, owner: owner, port: port, certificate: der, scopes: [.outputsRead, .outputsManage]), base: nil,
                             failure: .unavailable, counter: counter)
        defer { offline.close() }
        let vps = OutputFilesEditor(base: .remote(hostID: hostID), client: offline)
        XCTAssertTrue(vps.canBrowse); XCTAssertTrue(vps.canManageDestination)
        await vps.reload()
        XCTAssertEqual(vps.notice, .baseOffline); XCTAssertNil(vps.status)
        let attempts = await counter.all(); XCTAssertEqual(attempts, ["/v1/output-files/status"], "one attempt, to the VPS only")
    }

    /// Actual SDK → real HTTP → real Hono router + HostServices output folders (run by `scripts/swift-paired-live.sh`).
    func testLivePairedSDKAgainstRealRouter() async throws {
        guard let info = try liveInfo(), let der = Data(base64Encoded: info["certDER"] as! String) else { throw XCTSkip("no synthetic paired host") }
        let hostID = info["hostId"] as! String, owner = info["ownerId"] as! String, port = info["port"] as! Int, botID = info["botId"] as! String
        let api = URL(string: info["url"] as! String)!, controlBase = URL(string: info["controlUrl"] as! String)!
        XCTAssertNotEqual(port, 4317); XCTAssertNotEqual(port, 4318)
        func control(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
            var request = URLRequest(url: controlBase.appendingPathComponent(path)); request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, _) = try await URLSession(configuration: .ephemeral).data(for: request)
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        let counter = RequestCounter()
        let full = client(try binding(installation: hostID, owner: owner, port: port, certificate: der, scopes: [.outputsRead, .outputsManage]), base: api, counter: counter)
        defer { full.close() }
        let health = try await full.health(); XCTAssertEqual(health.installationId, hostID)
        let editor = OutputFilesEditor(base: .remote(hostID: hostID), client: full)
        await editor.reload()
        XCTAssertNil(editor.notice); XCTAssertEqual(editor.status?.current.kind, .hostDataLegacy)
        XCTAssertEqual(editor.status?.scope.remoteBrowsing, .ownerLoopbackAndPairedScoped, "the real paired composition, not the loopback-only literal")
        XCTAssertEqual(editor.status?.scope.relayedBrowsing, .notRelayed); XCTAssertEqual(editor.status?.limits.pairedChunkBytes, 262_144)
        XCTAssertEqual(editor.namespaces.map(\.ref), [.bot(botID)])
        await editor.browse(namespace: .bot(botID))
        XCTAssertEqual(editor.browsing?.items.map(\.name), ["escape", "slides"]); XCTAssertEqual(editor.browsing?.items.first?.type, .blocked)
        XCTAssertEqual(editor.browsing?.hidden.secretLike, 1)
        let item = try await full.outputItem(namespace: .bot(botID), path: "slides/apresentação.pptx")
        XCTAssertEqual(item.sha256, info["deckSha256"] as? String)
        let target = URL(fileURLWithPath: info["exportDir"] as! String).appendingPathComponent("apresentação.pptx")
        let exported = await editor.export(item, to: target)
        XCTAssertEqual(exported?.sha256, item.sha256); XCTAssertEqual(exported?.bytes, Int64(info["deckBytes"] as! Int))
        let chunks = (await counter.all()).filter { $0.hasPrefix("/v1/output-files/content") }
        XCTAssertEqual(chunks.count, 3, "256 KiB chunks on the paired channel")
        XCTAssertEqual(editor.access(location: try XCTUnwrap(editor.locations.first)), .downloadOnly, "a VPS path is never handed to Finder")
        // Destination: CAS + receipt; wrong host refused; same request replays.
        let status = try XCTUnwrap(editor.status)
        do { _ = try await full.setOutputDestination(SetOutputDestinationInput(status: try JSONDecoder().decode(OutputFilesStatus.self,
              from: JSONEncoder().encode(status).replacingHost(hostID, with: "host_wrong")), destination: .hostDataDefault, clientRequestId: "wrong-host")); XCTFail("wrong host") }
        catch { XCTAssertEqual(error as? HostClientError, .conflict) }
        await editor.chooseDestination(.ownerPath(info["chosen"] as! String))
        XCTAssertEqual(editor.notice, .destinationSaved); XCTAssertEqual(editor.lastReceipt?.existingFilesMoved, false)
        let receipt = try XCTUnwrap(editor.lastReceipt)
        let replay = try await full.outputDestinationReceipt(clientRequestID: receipt.clientRequestId); XCTAssertEqual(replay, receipt)
        // Lost ACK after the host applied it: unknown → the editor only READS the original receipt.
        _ = try await control("drop-next")
        await editor.chooseDestination(.hostDataDefault)
        XCTAssertNil(editor.pendingDestination); XCTAssertEqual(editor.notice, .destinationSaved)
        let after = try await control("count"); XCTAssertEqual(after["revision"] as? Int, 3, "exactly two changes, no duplicate")
        // The host enforces the scope even if this client believes it holds it.
        _ = try await control("scopes", ["scopes": ["outputs.read"]])
        do { _ = try await full.outputDestinationReceipt(clientRequestID: receipt.clientRequestId); XCTFail("host gate") }
        catch { XCTAssertEqual(error as? HostClientError, .forbidden) }
        do { _ = try await full.health(); XCTFail("binding scopes changed") } catch { XCTAssertEqual(error as? HostClientError, .contractMismatch) }
        // Revoked: everything stops; nothing falls back.
        _ = try await control("revoke")
        await editor.reload(); XCTAssertEqual(editor.notice, .remoteBrowsingUnavailable)
    }
}

private extension Data {
    func replacingHost(_ host: String, with other: String) -> Data {
        Data(String(decoding: self, as: UTF8.self).replacingOccurrences(of: host, with: other).utf8)
    }
}
#endif
