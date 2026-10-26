import DexterClientIdentity
import Foundation
import XCTest
@testable import DexterHostClient

/// `status.scope.remoteBrowsing` against REAL host payloads (`Fixtures/output-files-status-golden.json`, produced by
/// `scripts/make-output-status-golden.mjs`): `current` = this host (owner loopback without the paired channel; with it;
/// the same status read by a paired client over the real mutual-TLS listener holding only `outputs.read`), `legacy` = the
/// previous host, whose payload lacks the additive fields. Unknown enum values and inconsistent limits are refused.
final class OutputFilesStatusContractTests: XCTestCase, @unchecked Sendable {
    private func golden() throws -> [String: Any] {
        let url = Bundle.module.url(forResource: "output-files-status-golden", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/output-files-status-golden.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func payload(_ group: String, _ name: String) throws -> [String: Any] {
        try XCTUnwrap((try golden()[group] as? [String: Any])?[name] as? [String: Any])
    }
    private func status(_ value: [String: Any]) async throws -> OutputFilesStatus {
        let data = try JSONSerialization.data(withJSONObject: value)
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:9994")!, transport: StatusTransport(data: data))
        defer { client.close() }
        return try await client.outputFilesStatus()
    }
    private func edited(_ value: [String: Any], _ section: String, _ key: String, _ replacement: Any?) -> [String: Any] {
        var copy = value, inner = value[section] as? [String: Any] ?? [:]
        inner[key] = replacement; copy[section] = inner; return copy
    }

    func testCurrentHostStatusesStateTheComposedPolicyNeverTheRelay() async throws {
        let loopback = try await status(try payload("current", "ownerLoopbackOnly"))
        XCTAssertEqual(loopback.scope.remoteBrowsing, .ownerLoopbackOnly); XCTAssertNil(loopback.limits.pairedChunkBytes)
        XCTAssertEqual(loopback.scope.relayedBrowsing, .notRelayed); XCTAssertEqual(loopback.limits.chunkBytes, 8 * 1024 * 1024)
        let owner = try await status(try payload("current", "pairedComposedOwner"))
        let remote = try await status(try payload("current", "pairedClient"))
        for value in [owner, remote] {
            XCTAssertEqual(value.scope.remoteBrowsing, .ownerLoopbackAndPairedScoped); XCTAssertEqual(value.scope.relayedBrowsing, .notRelayed)
            XCTAssertEqual(value.limits.pairedChunkBytes, 262_144); XCTAssertEqual(value.limits.chunkBytes, 8 * 1024 * 1024, "the loopback chunk stays real")
        }
        XCTAssertEqual(owner.scope, remote.scope, "the paired client reads the same policy the owner reads"); XCTAssertEqual(owner.limits, remote.limits)
        XCTAssertEqual(outputPairedChunkBytes, 262_144)
    }

    func testLegacyHostStatusesDecodeWithAbsentAdditiveFields() async throws {
        for name in ["ownerLoopbackOnly", "pairedComposedOwner", "pairedClient"] {
            let raw = try payload("legacy", name)
            XCTAssertNil((raw["scope"] as? [String: Any])?["relayedBrowsing"]); XCTAssertNil((raw["limits"] as? [String: Any])?["pairedChunkBytes"])
            let value = try await status(raw)
            XCTAssertEqual(value.scope.remoteBrowsing, .ownerLoopbackOnly, name); XCTAssertNil(value.scope.relayedBrowsing, name)
            XCTAssertNil(value.limits.pairedChunkBytes, name)
        }
    }

    func testUnknownValuesAndInconsistentLimitsAreContractMismatches() async throws {
        let paired = try payload("current", "pairedComposedOwner"), loopback = try payload("current", "ownerLoopbackOnly")
        let cases: [(String, [String: Any])] = [
            ("unknown remote browsing", edited(paired, "scope", "remoteBrowsing", "owner_loopback_and_relay")),
            ("relayed claim", edited(paired, "scope", "remoteBrowsing", "relayed")),
            ("empty remote browsing", edited(paired, "scope", "remoteBrowsing", "")),
            ("missing remote browsing", edited(paired, "scope", "remoteBrowsing", nil)),
            ("unknown relayed value", edited(paired, "scope", "relayedBrowsing", "relayed")),
            ("paired without chunk", edited(paired, "limits", "pairedChunkBytes", NSNull())),
            ("paired chunk above the listener cap", edited(paired, "limits", "pairedChunkBytes", 262_145)),
            ("paired chunk zero", edited(paired, "limits", "pairedChunkBytes", 0)),
            ("paired chunk as text", edited(paired, "limits", "pairedChunkBytes", "262144")),
            ("loopback-only with paired chunk", edited(loopback, "limits", "pairedChunkBytes", 262_144)),
        ]
        for (label, value) in cases {
            do { _ = try await status(value); XCTFail("\(label) accepted") }
            catch HostClientError.contractMismatch {}
            catch { XCTFail("\(label): \(error)") }
        }
    }

    /// "Every scope" defaults/fixtures name the explicit legacy list: outputs.* exist only when the owner grants them.
    func testLegacyScopeListIsExplicitAndNeverContainsOutputScopes() {
        XCTAssertEqual(ClientScope.legacyPairing.map(\.rawValue).sorted(), ["approvals.decide", "approvals.read", "chat.read", "chat.write",
            "devices.manage", "devices.read", "grants.manage", "grants.read"])
        XCTAssertEqual(Set(ClientScope.allCases).subtracting(ClientScope.legacyPairing),
                       [.outputsRead, .outputsManage, .connectionsRead, .connectionsManage, .mcpRead, .mcpManage], "only owner-granted opt-ins")
    }
}

private actor StatusTransport: HTTPTransport {
    private let data: Data
    init(data: Data) { self.data = data }
    func send(_ request: URLRequest) async throws -> TransportResponse { TransportResponse(statusCode: 200, data: data) }
}
