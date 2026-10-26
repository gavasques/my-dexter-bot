import Foundation

/// Public data of a native Mac agent claim awaiting the owner (`PendingClaim` of packages/devices/src/registry.ts).
/// No secrets: the fingerprint is the public pin of the certificate that proved possession during the claim.
public struct LocalMacAgentClaim: Decodable, Identifiable, Equatable, Sendable {
    public var id: String { claimId }
    public let claimId: String
    public let kind: String
    public let deviceId: String?
    public let clientFingerprint: String
    public let name: String
    public let capabilities: [String]
    public let expiresAt: Int64

    public var expiry: Date { Date(timeIntervalSince1970: Double(expiresAt) / 1000) }

    fileprivate var isValid: Bool {
        (try? enrollmentSegment(claimId)) != nil && ["pair", "rotate"].contains(kind)
            && (kind == "pair" || deviceId != nil) && deviceId.map({ (try? enrollmentSegment($0)) != nil }) ?? true
            && clientFingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
            && !name.isEmpty && name.utf8.count <= 256 && capabilities.count <= 64
            && capabilities.allSatisfy { !$0.isEmpty && $0.utf8.count <= 128 } && expiresAt > 0
    }
}

public struct LocalMacAgentApproval: Decodable, Equatable, Sendable {
    public let deviceId: String
    public let fingerprint: String
}

private struct LocalMacAgentClaimsResponse: Decodable, Sendable { let claims: [LocalMacAgentClaim] }
private struct LocalMacAgentRejection: Decodable, Sendable { let rejected: Bool }
private struct LocalMacAgentEmptyBody: Encodable {}

/// Owner-loopback enrollment of the native Mac agent. Never available through a paired or remote client.
/// The setup envelope carries a one-time pairing code: callers keep it in memory and never log it.
public extension HostClient {
    /// Canonical installation of the loopback host this client is connected to (`hostId` == `installationId`).
    func localMacAgentInstallationID() async throws -> String {
        try requireLocalMacAgentAccess()
        guard let id = try await health().hostId, (try? enrollmentSegment(id)) != nil else { throw HostClientError.contractMismatch }
        return id
    }

    /// Raw `dexter.local-mac-agent-setup/1` envelope; parse with `LocalMacAgentSetupBundle` in DexterAppCore.
    func localMacAgentSetupEnvelope() async throws -> String {
        try requireLocalMacAgentAccess()
        let value: JSONValue = try await request("/v1/local-mac-agent/setup", method: "POST", body: LocalMacAgentEmptyBody())
        guard case .object(let object) = value, Set(object.keys) == ["schema", "installationId", "offer"],
              let data = try? JSONEncoder().encode(value), data.count <= 32768,
              let text = String(data: data, encoding: .utf8) else { throw HostClientError.contractMismatch }
        return text
    }

    func localMacAgentClaims() async throws -> [LocalMacAgentClaim] {
        try requireLocalMacAgentAccess()
        let claims = try await request("/v1/local-mac-agent/claims", as: LocalMacAgentClaimsResponse.self).claims
        guard claims.count <= 64, claims.allSatisfy(\.isValid), Set(claims.map(\.claimId)).count == claims.count else {
            throw HostClientError.contractMismatch
        }
        return claims
    }

    /// Approves pairing only. Grants no bot capability; those stay explicit per bot afterwards.
    func approveLocalMacAgentClaim(_ claim: LocalMacAgentClaim) async throws -> LocalMacAgentApproval {
        try requireLocalMacAgentAccess()
        let approval: LocalMacAgentApproval
        do {
            approval = try await request("/v1/local-mac-agent/claims/\(try enrollmentSegment(claim.claimId))/approve",
                                         method: "POST", body: LocalMacAgentEmptyBody())
        } catch HostClientError.contractMismatch { throw HostClientError.mutationOutcomeUnknown }
        guard approval.fingerprint == claim.clientFingerprint, (try? enrollmentSegment(approval.deviceId)) != nil,
              claim.deviceId.map({ $0 == approval.deviceId }) ?? true else { throw HostClientError.mutationOutcomeUnknown }
        return approval
    }

    func rejectLocalMacAgentClaim(_ claim: LocalMacAgentClaim) async throws {
        try requireLocalMacAgentAccess()
        let result: LocalMacAgentRejection
        do {
            result = try await request("/v1/local-mac-agent/claims/\(try enrollmentSegment(claim.claimId))/reject",
                                       method: "POST", body: LocalMacAgentEmptyBody())
        } catch HostClientError.contractMismatch { throw HostClientError.mutationOutcomeUnknown }
        guard result.rejected else { throw HostClientError.mutationOutcomeUnknown }
    }

    private func requireLocalMacAgentAccess() throws {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
    }
}

private func enrollmentSegment(_ value: String) throws -> String {
    guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$", options: .regularExpression) != nil else {
        throw HostClientError.invalidRequest
    }
    return value
}
