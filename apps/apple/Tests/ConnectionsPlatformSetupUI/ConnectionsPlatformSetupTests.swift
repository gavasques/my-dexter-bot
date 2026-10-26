#if os(macOS)
import Foundation
import XCTest
import DexterAppCore
import DexterHostClient
@testable import ConnectionsSetupUI

/// TEST ONLY (compiled by the lab package with `SharedApp/Sources/ConnectionsPlatformSetupViews.swift` as module
/// ConnectionsSetupUI). Real SDK `HostClient` + real `ConnectionsPlatformSettingsController`; the transport is in-process
/// (no listener) and the capability store is the QA in-memory store, never a Keychain. The live case talks to the real
/// HostServices fixture over loopback HTTP when `DEXTER_CONNECTIONS_UI_LIVE` names its info file.
private let capabilityText = "dxcap_" + String(repeating: "Q", count: 40) + "_synthetic"
private let origin = "https://connections.dexter.test"

private final class SetupTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _status: [String: Any]
    private var _log: [String] = []
    private var _dropNextPut = false
    private var _gate: CheckedContinuation<Void, Never>?
    private var _holdNextStatus = false
    init(_ status: [String: Any]) { _status = status }
    var status: [String: Any] { get { lock.withLock { _status } } set { lock.withLock { _status = newValue } } }
    var log: [String] { lock.withLock { _log } }
    var puts: Int { log.filter { $0.hasPrefix("PUT ") }.count }
    func dropNextPut() { lock.withLock { _dropNextPut = true } }
    func holdNextStatus() { lock.withLock { _holdNextStatus = true } }
    func release() { let gate = lock.withLock { () -> CheckedContinuation<Void, Never>? in let g = _gate; _gate = nil; return g }; gate?.resume() }
    var holding: Bool { lock.withLock { _gate != nil } }
    func send(_ request: URLRequest) async throws -> TransportResponse { try await sendWithoutRedirects(request) }
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse {
        let method = request.httpMethod ?? "GET", path = request.url?.path ?? ""
        lock.withLock { _log.append(method + " " + path) }
        if path == "/health" {
            return try reply(["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "synthetic",
                              "hostId": "host_qa", "state": ["hostId": "host_qa", "ownerId": "owner_qa"]])
        }
        if path == "/v1/connections/platform-configuration", method == "GET" {
            if lock.withLock({ () -> Bool in let h = _holdNextStatus; _holdNextStatus = false; return h }) {
                await withCheckedContinuation { c in lock.withLock { _gate = c } }
            }
            return try reply(status)
        }
        if method == "PUT", lock.withLock({ () -> Bool in let d = _dropNextPut; _dropNextPut = false; return d }) { throw URLError(.networkConnectionLost) }
        return TransportResponse(statusCode: 404, data: Data("{}".utf8))
    }
    private func reply(_ object: [String: Any]) throws -> TransportResponse {
        TransportResponse(statusCode: 200, data: try JSONSerialization.data(withJSONObject: object))
    }
}

private func statusObject(state: String, reason: String? = nil, enabled: Bool = false, configured: String? = nil, generation: Int = 0,
                          custodyChannel: String = "app_private_channel", custody: String = "absent", request: [String: Any]? = nil) -> [String: Any] {
    let active = state == "active" || state == "restart_required"
    return ["version": 1, "hostId": "host_qa", "ownerId": "owner_qa",
            "configuration": ["revision": generation, "generation": generation, "origin": configured as Any? ?? NSNull(), "enabled": enabled,
                              "credentialRef": "connections-platform", "updatedAt": generation == 0 ? NSNull() : 1] as [String: Any],
            "runtime": ["state": state, "reason": reason as Any? ?? NSNull(), "origin": active && state == "active" ? origin : NSNull(),
                        "generation": state == "active" ? generation : NSNull()] as [String: Any],
            "custody": ["channel": custodyChannel, "state": custody, "generation": custody == "ready" ? generation : NSNull()] as [String: Any],
            "privateRequest": request as Any? ?? NSNull()]
}

/// QA double of the Keychain port reporting an unsigned build (the real native store only compiles here).
@MainActor private final class UnsignedStore: ConnectionsCapabilityStore {
    func status(scope: ConnectionsCapabilityScope) -> ConnectionsCapabilityStatus { .signingIdentityUnavailable }
    func save(scope: ConnectionsCapabilityScope, capability: ConnectionsOwnedCapability) throws { capability.clear(); throw ConnectionsPrivateFailure.signingIdentityUnavailable }
    func load(scope: ConnectionsCapabilityScope) throws -> ConnectionsOwnedCapability { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
    func remove(scope: ConnectionsCapabilityScope) throws { throw ConnectionsPrivateFailure.signingIdentityUnavailable }
}

@MainActor private final class Rig {
    let transport: SetupTransport
    var current = true
    var frames: [[String: Any]] = []
    var sendOutcome: ConnectionsPrivateFailure?
    var unconfirmed: ConnectionsPrivateIntent?
    var settles = false
    let controller: ConnectionsPlatformSettingsController
    init(_ status: [String: Any], store: any ConnectionsCapabilityStore = InMemoryConnectionsCapabilityStore()) {
        let transport = SetupTransport(status); self.transport = transport
        var rig: Rig?
        let channel = ConnectionsPrivateChannel(available: { $0 == "host_qa" }, send: { frame in
            var bytes = Data(); try frame.handoff { bytes = $0 }
            guard let rig else { throw ConnectionsPrivateFailure.bridgeUnavailable }
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any]); bytes.resetBytes(in: 0..<bytes.count)
            rig.frames.append(object)
            if let failure = rig.sendOutcome {
                if failure == .outcomeUnknown { rig.unconfirmed = frame.intent }
                throw failure
            }
            let op = frame.intent.operation
            transport.status = statusObject(state: "active", enabled: true, configured: origin, generation: frame.intent.scope.generation,
                custody: op == .set ? "ready" : "locked",
                request: ["requestId": frame.intent.requestID, "operation": op.rawValue, "generation": frame.intent.scope.generation, "state": op == .set ? "ready" : "locked"])
        }, reconcile: { intent, status in
            guard let rig, rig.unconfirmed == intent, rig.settles, status.privateRequest?.requestId == intent.requestID else { return false }
            rig.unconfirmed = nil; return true
        }, uncertain: { rig?.unconfirmed })
        controller = ConnectionsPlatformSettingsController(hostID: "host_qa", client: HostClient(baseURL: URL(string: "http://127.0.0.1:49961")!, transport: transport),
                                                           isCurrent: { rig?.current ?? false }, channel: channel, store: store)
        rig = self
    }
    var stage: ConnectionsPlatformSetupPresentation.Stage { ConnectionsPlatformSetupPresentation(controller).stage }
    var presentation: ConnectionsPlatformSetupPresentation { ConnectionsPlatformSetupPresentation(controller) }
    func settle() async throws {
        for _ in 0..<400 { if !controller.busy { try await Task.sleep(for: .milliseconds(25)); if !controller.busy { return } }; try await Task.sleep(for: .milliseconds(5)) }
        XCTFail("controller stayed busy")
    }
}

@MainActor final class ConnectionsPlatformSetupTests: XCTestCase {
    private func scope(_ generation: Int = 1) throws -> ConnectionsCapabilityScope {
        try ConnectionsCapabilityScope(hostID: "host_qa", ownerID: "owner_qa", origin: origin, generation: generation)
    }

    /// Each runtime/custody combination maps to one readable stage and one next action; saved and ready are never "connected".
    func testStateToStageNextActionAndEnablement() async throws {
        let choose = Rig(statusObject(state: "inactive", reason: "disabled")); choose.controller.open(); try await choose.settle()
        XCTAssertEqual(choose.stage, .chooseService); XCTAssertEqual(choose.presentation.primary, .save)
        XCTAssertTrue(choose.controller.canEdit); XCTAssertFalse(choose.presentation.showsCredential); XCTAssertFalse(choose.controller.canStoreCapability)
        for bad in ["http://conn.example.com", "https://conn.example.com/", "https://conn.example.com:8443", "https://127.0.0.1", "https://localhost", "https://intranet"] {
            XCTAssertFalse(ConnectionsPlatformSetupPresentation.validOrigin(bad), bad)
        }
        XCTAssertTrue(ConnectionsPlatformSetupPresentation.validOrigin(" https://conn.example.com "))

        let cases: [([String: Any], ConnectionsPlatformSetupPresentation.Stage, ConnectionsPlatformSetupPresentation.Action)] = [
            (statusObject(state: "inactive", reason: "requires_mcp_engines", enabled: true, configured: origin, generation: 1), .needsEngines, .reload),
            (statusObject(state: "inactive", reason: "private_channel_unavailable", enabled: true, configured: origin, generation: 1), .channelUnavailable, .reload),
            (statusObject(state: "inactive", reason: "exclusive_upstream", enabled: true, configured: origin, generation: 1), .exclusiveUpstream, .reload),
            (statusObject(state: "inactive", reason: "origin_bound_to_other_connections", enabled: true, configured: origin, generation: 1), .originBound, .reload),
            (statusObject(state: "inactive", reason: "configuration_unavailable", enabled: true, configured: origin, generation: 1), .configurationUnavailable, .reload),
            (statusObject(state: "restart_required", enabled: true, configured: origin, generation: 1), .restartRequired, .reload),
            (statusObject(state: "active", enabled: true, configured: origin, generation: 1, custodyChannel: "unavailable"), .channelUnavailable, .reload),
            (statusObject(state: "active", enabled: true, configured: origin, generation: 1), .enterCredential, .store),
            (statusObject(state: "active", enabled: true, configured: origin, generation: 1, custody: "ready"), .hostStillHolds, .lock),
        ]
        for (status, stage, action) in cases {
            let rig = Rig(status); rig.controller.open(); try await rig.settle()
            XCTAssertEqual(rig.stage, stage, "\(status["runtime"]!)"); XCTAssertEqual(rig.presentation.primary, action)
            XCTAssertEqual(rig.transport.puts, 0, "opening never writes"); XCTAssertTrue(rig.frames.isEmpty, "nothing stored: nothing restored")
            XCTAssertEqual(rig.controller.canStoreCapability, [.enterCredential, .hostStillHolds].contains(stage), "store only where this Mac has no item for the running scope")
            XCTAssertFalse(rig.presentation.needsAttention && stage == .enterCredential)
        }
        let external = Rig(["version": 1, "hostId": "host_qa", "ownerId": "owner_qa",
            "configuration": ["revision": 0, "generation": 0, "origin": NSNull(), "enabled": false, "credentialRef": "connections-platform", "updatedAt": NSNull()],
            "runtime": ["state": "configured_externally", "reason": NSNull(), "origin": "https://operator.example.com", "generation": NSNull()],
            "custody": ["channel": "unavailable", "state": "absent", "generation": NSNull()], "privateRequest": NSNull()])
        external.controller.open(); try await external.settle()
        XCTAssertEqual(external.stage, .configuredExternally); XCTAssertEqual(external.presentation.primary, .none); XCTAssertFalse(external.controller.canEdit)

        let unsigned = Rig(statusObject(state: "active", enabled: true, configured: origin, generation: 1), store: UnsignedStore())
        unsigned.controller.open(); try await unsigned.settle()
        XCTAssertEqual(unsigned.stage, .signingUnavailable); XCTAssertFalse(unsigned.controller.canStoreCapability); XCTAssertTrue(unsigned.frames.isEmpty)
    }

    /// Opening restores ONLY an already stored exact-scope credential, once; the result is custody, not a connection.
    func testOpenRestoresStoredCredentialOnceAndReadyIsNotConnected() async throws {
        let store = InMemoryConnectionsCapabilityStore()
        try store.save(scope: scope(), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))
        try store.save(scope: scope(2), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))
        let rig = Rig(statusObject(state: "active", enabled: true, configured: origin, generation: 1), store: store)
        rig.controller.open(); try await rig.settle(); try await rig.settle()
        XCTAssertEqual(rig.frames.count, 1); XCTAssertEqual(rig.frames.first?["generation"] as? Int, 1, "never another generation")
        XCTAssertEqual(rig.stage, .ready); XCTAssertEqual(rig.presentation.primary, .showServices); XCTAssertFalse(rig.presentation.needsAttention)
        XCTAssertEqual(rig.presentation.symbol, "checkmark.circle")
        rig.controller.close(); rig.controller.open(); try await rig.settle(); try await rig.settle()
        XCTAssertEqual(rig.frames.count, 1, "custody already ready on the base: reopening sends nothing")
        XCTAssertEqual(rig.transport.puts, 0)
    }

    /// Lost save response: Conferir is the only action, it reads the original receipt (GET), the request survives close/reopen
    /// of the same retained controller, and nothing is written twice.
    func testUnknownSaveOffersConferirWithGETOnlyAcrossReopen() async throws {
        let rig = Rig(statusObject(state: "inactive", reason: "disabled")); rig.controller.open(); try await rig.settle()
        rig.controller.origin = origin; rig.controller.enabled = true
        XCTAssertTrue(rig.controller.canSave)
        rig.transport.dropNextPut(); rig.controller.save(); try await rig.settle()
        XCTAssertEqual(rig.stage, .confirmSettings); XCTAssertEqual(rig.presentation.primary, .check); XCTAssertTrue(rig.presentation.needsAttention)
        XCTAssertFalse(rig.controller.canSave); XCTAssertFalse(rig.controller.canEdit)
        let request = try XCTUnwrap(rig.controller.pendingSettings?.clientRequestId)
        rig.controller.close(); XCTAssertNotNil(rig.controller.pendingSettings, "kept in this app process")
        rig.controller.open(); try await rig.settle()
        XCTAssertEqual(rig.stage, .confirmSettings)
        rig.controller.verify(); try await rig.settle()
        XCTAssertEqual(rig.stage, .confirmSettings, "receipt not found = still unconfirmed, never 'did not happen'")
        XCTAssertEqual(rig.transport.puts, 1, "no second write, no retry")
        XCTAssertEqual(rig.transport.log.filter { $0 == "GET /v1/connections/platform-configuration/receipts/\(request)" }.count, 2)
    }

    /// Lost private ACK: Conferir only; the credential is never resent and the exact request id decides.
    func testUnknownPrivateDeliveryIsSettledByTheSameRequestOnly() async throws {
        let rig = Rig(statusObject(state: "active", enabled: true, configured: origin, generation: 1)); rig.controller.open(); try await rig.settle()
        XCTAssertEqual(rig.stage, .enterCredential)
        rig.sendOutcome = .outcomeUnknown
        rig.controller.storeCapability(try XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText))); try await rig.settle()
        XCTAssertEqual(rig.stage, .confirmPrivate); XCTAssertEqual(rig.presentation.primary, .check)
        XCTAssertFalse(rig.controller.canDeliver); XCTAssertFalse(rig.controller.canStoreCapability)
        rig.controller.verify(); try await rig.settle()
        XCTAssertEqual(rig.stage, .confirmPrivate, "GET without the exact request decides nothing")
        let intent = try XCTUnwrap(rig.unconfirmed)
        rig.transport.status = statusObject(state: "active", enabled: true, configured: origin, generation: 1, custody: "ready",
            request: ["requestId": intent.requestID, "operation": "set", "generation": 1, "state": "ready"])
        rig.settles = true; rig.controller.verify(); try await rig.settle()
        XCTAssertEqual(rig.stage, .ready); XCTAssertEqual(rig.frames.count, 1, "never resent"); XCTAssertEqual(rig.transport.puts, 0)
    }

    /// A read that finishes after the base changed is dropped: nothing from the old base reaches the screen.
    func testHostSwitchDropsStaleCallback() async throws {
        let rig = Rig(statusObject(state: "active", enabled: true, configured: origin, generation: 1))
        rig.transport.holdNextStatus(); rig.controller.open()
        for _ in 0..<400 where !rig.transport.holding { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(rig.transport.holding); XCTAssertEqual(rig.stage, .loading)
        rig.current = false; rig.transport.release(); try await Task.sleep(for: .milliseconds(150))
        XCTAssertNil(rig.controller.status, "stale response ignored"); XCTAssertFalse(rig.controller.scopeMatches)
        XCTAssertFalse(rig.controller.canEdit); XCTAssertFalse(rig.controller.canStoreCapability)
        XCTAssertTrue(rig.frames.isEmpty); XCTAssertEqual(rig.transport.puts, 0)
    }

    /// Forgetting removes this Mac's item, asks the base to lock, and until the exact ACK/GET the base may still hold it.
    func testForgetShowsHostStillHoldsUntilLockIsConfirmed() async throws {
        let store = InMemoryConnectionsCapabilityStore()
        try store.save(scope: scope(), capability: XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText)))
        let rig = Rig(statusObject(state: "active", enabled: true, configured: origin, generation: 1, custody: "ready"), store: store)
        rig.controller.open(); try await rig.settle()
        XCTAssertEqual(rig.stage, .ready); XCTAssertTrue(rig.frames.isEmpty)
        rig.sendOutcome = .outcomeUnknown
        rig.controller.forgetCapability(); try await rig.settle()
        XCTAssertEqual(rig.controller.capabilityStatus, .missing)
        XCTAssertEqual(rig.stage, .confirmPrivate, "lock outcome unknown: removal alone proves nothing on the base")
        XCTAssertEqual(rig.frames.count, 1); XCTAssertNil(rig.frames[0]["capability"])
    }

    /// Every key the presentation and the view can show exists in the catalog in both languages; English never falls back
    /// to the controller's fixed Portuguese sentences.
    func testCatalogCoversEveryKeyInBothLanguages() throws {
        let root = try XCTUnwrap(ProcessInfo.processInfo.environment["DEXTER_APPLE_SOURCE"], "lab sets the source path")
        let data = try Data(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("SharedApp/Resources/Localizable.xcstrings"))
        let strings = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["strings"] as? [String: [String: Any]])
        let view = try String(contentsOf: URL(fileURLWithPath: root).appendingPathComponent("SharedApp/Sources/ConnectionsPlatformSetupViews.swift"), encoding: .utf8)
        let regex = try NSRegularExpression(pattern: #"t\("([^"]+)"\)"#)
        let viewKeys = regex.matches(in: view, range: NSRange(view.startIndex..., in: view)).map { String(view[Range($0.range(at: 1), in: view)!]) }
        let keys = Set(ConnectionsPlatformSetupPresentation.allKeys + viewKeys)
        XCTAssertGreaterThan(keys.count, 60)
        let portugueseNotices = [ConnectionsPlatformSettingsController.Notice.saved, .ready, .locked, .refused, .loadFailed].map(\.message)
        for key in keys {
            let languages = try XCTUnwrap(strings[key]?["localizations"] as? [String: [String: Any]], key)
            let en = try XCTUnwrap((languages["en"]?["stringUnit"] as? [String: String])?["value"], key)
            let pt = try XCTUnwrap((languages["pt-BR"]?["stringUnit"] as? [String: String])?["value"], key)
            XCTAssertFalse(en.isEmpty || pt.isEmpty, key)
            XCTAssertFalse(portugueseNotices.contains(en), key)
            for word in ["revision", "generation 1", "requestId", "host_", "restart_required", "app_private_channel"] { XCTAssertFalse(en.contains(word) || pt.contains(word), key) }
        }
    }

    /// Real HostServices behind loopback HTTP (fixture): stages along the whole path, with the base restarted by the fixture.
    func testLiveStagesAgainstRealHost() async throws {
        guard let path = ProcessInfo.processInfo.environment["DEXTER_CONNECTIONS_UI_LIVE"], !path.isEmpty,
              let info = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else { throw XCTSkip("no synthetic live host") }
        let control = URL(string: info["controlUrl"] as! String)!, hostID = info["hostId"] as! String
        func post(_ path: String, _ body: Data = Data()) async throws -> [String: Any] {
            var request = URLRequest(url: control.appendingPathComponent(path)); request.httpMethod = "POST"; request.httpBody = body
            let (data, _) = try await URLSession(configuration: .ephemeral).data(for: request)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        var unconfirmed: ConnectionsPrivateIntent?
        let channel = ConnectionsPrivateChannel(available: { $0 == hostID }, send: { frame in
            var bytes = Data(); try frame.handoff { bytes = $0 }
            let reply = try await post("frame", bytes); bytes.resetBytes(in: 0..<bytes.count)
            if reply["dropped"] as? Bool == true { unconfirmed = frame.intent; throw ConnectionsPrivateFailure.outcomeUnknown }
            let ack = try XCTUnwrap(reply["ack"] as? [String: Any]); XCTAssertNil(ack["capability"])
            if ack["status"] as? String == "refused" { throw ConnectionsPrivateFailure.refused }
        }, reconcile: { intent, status in
            guard unconfirmed == intent, let request = status.privateRequest, request.requestId == intent.requestID, request.operation == intent.operation,
                  request.generation == intent.scope.generation else { return false }
            unconfirmed = nil; return true
        }, uncertain: { unconfirmed })
        let store = InMemoryConnectionsCapabilityStore()
        func controller(_ url: String) -> ConnectionsPlatformSettingsController {
            ConnectionsPlatformSettingsController(hostID: hostID, client: HostClient(baseURL: URL(string: url)!), isCurrent: { true }, channel: channel, store: store)
        }
        func settle(_ c: ConnectionsPlatformSettingsController) async throws { for _ in 0..<400 { if !c.busy { try await Task.sleep(for: .milliseconds(30)); if !c.busy { return } }; try await Task.sleep(for: .milliseconds(10)) } }
        func stage(_ c: ConnectionsPlatformSettingsController) -> ConnectionsPlatformSetupPresentation.Stage { ConnectionsPlatformSetupPresentation(c).stage }
        let first = controller(info["url"] as! String); first.open(); try await settle(first)
        XCTAssertEqual(stage(first), .chooseService)
        first.origin = origin; first.enabled = true; first.save(); try await settle(first)
        XCTAssertEqual(stage(first), .restartRequired); XCTAssertEqual(first.notice, .restartRequired)
        XCTAssertNil(ConnectionsPlatformSetupPresentation.noticeKey(.restartRequired), "the stage already says it")
        first.close()
        let restarted = try await post("restart"), second = controller(restarted["url"] as! String)
        second.open(); try await settle(second)
        XCTAssertEqual(stage(second), .enterCredential)
        second.storeCapability(try XCTUnwrap(ConnectionsOwnedCapability(capability: capabilityText))); try await settle(second)
        XCTAssertEqual(stage(second), .ready); XCTAssertEqual(second.status?.custody.state, .ready)
        _ = try await post("drop-next-ack"); second.lock(); try await settle(second)
        XCTAssertEqual(stage(second), .confirmPrivate)
        second.verify(); try await settle(second)
        XCTAssertEqual(stage(second), .deliver); XCTAssertEqual(second.notice, .locked)
        let counts = try await post("counts")
        XCTAssertEqual(counts["puts"] as? Int, 1); XCTAssertEqual(counts["frames"] as? Int, 2)
        second.close()
    }
}
#endif
