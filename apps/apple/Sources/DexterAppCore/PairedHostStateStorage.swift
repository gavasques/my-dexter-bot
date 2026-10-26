import Foundation
import DexterClientIdentity

/// Public metadata only. Reading this record never creates an approved binding.
public struct PairedHostReference: Codable, Equatable, Sendable {
    public let installationID: String, localBindingID: String, role: ClientRole, hostURL: String, hostDER: Data, hostFingerprint: String
    public var claimID: String?, clientFingerprint: String?, ownerID: String?, deviceID: String?, scopes: [ClientScope]
    public var pinGeneration: Int?, bindingRevision: Int?, claimOutcomeUnknown: Bool
    public init(scope: ClientIdentityScope, host: PinnedClientHost, scopes: [ClientScope]) {
        installationID = scope.installationID; localBindingID = scope.localBindingID; role = scope.role; hostURL = host.url.absoluteString; hostDER = host.certificateDER; hostFingerprint = host.fingerprint
        self.scopes = scopes; claimOutcomeUnknown = false
    }
    public func scope() throws -> ClientIdentityScope { try .init(installationID:installationID,localBindingID:localBindingID,role:role,hostFingerprint:hostFingerprint) }
    public func host() throws -> PinnedClientHost { guard let url = URL(string:hostURL) else { throw ClientIdentityFailure.invalidInput }; return try .init(url:url,certificateDER:hostDER,fingerprint:hostFingerprint) }
    public func isValid() -> Bool {
        guard (try? scope()) != nil, hostDER.count <= 16_384, hostURL.utf8.count <= 1024, hostFingerprint.utf8.count == 64,
              scopes.count <= ClientScope.allCases.count, Set(scopes).count == scopes.count, scopes.map(\.rawValue) == scopes.map(\.rawValue).sorted() else { return false }
        for id in [claimID,ownerID,deviceID].compactMap({$0}) { guard (try? ClientResourceID(id)) != nil else { return false } }
        if let fingerprint = clientFingerprint, !Self.digest(fingerprint) { return false }
        if let pinGeneration, pinGeneration < 1 { return false }; if let bindingRevision, bindingRevision < 1 { return false }
        if deviceID != nil && (claimID == nil || clientFingerprint == nil || ownerID == nil || pinGeneration == nil || bindingRevision == nil) { return false }
        return true
    }
    static func digest(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}) }
}
public struct PairedPendingTurn: Codable, Equatable, Sendable {
    public let installationID: String, deviceID: String, threadID: String, clientRequestID: String, contentDigest: String
    public init(installationID: String, deviceID: String, threadID: String, clientRequestID: String, contentDigest: String) {
        self.installationID = installationID; self.deviceID = deviceID; self.threadID = threadID; self.clientRequestID = clientRequestID; self.contentDigest = contentDigest
    }
    func isValid() -> Bool { [installationID,deviceID,threadID,clientRequestID].allSatisfy({(try? ClientResourceID($0)) != nil}) && PairedHostReference.digest(contentDigest) }
}
public struct PairedHostSnapshot: Codable, Equatable, Sendable {
    public var version = 1
    public var selected: PairedHostReference?
    public var detached: Bool?
    public var pendingTurns: [PairedPendingTurn] = []
    public var retainedReferences: [PairedHostReference] = []
    public init() {}
    public func isValid() -> Bool {
        guard version == 1, selected?.isValid() ?? true, retainedReferences.count <= 20, retainedReferences.allSatisfy({$0.isValid()}), pendingTurns.count <= 100, pendingTurns.allSatisfy({$0.isValid()}) else { return false }
        let keys = pendingTurns.map { "\($0.installationID)|\($0.deviceID)|\($0.threadID)" }; return Set(keys).count == keys.count
    }
}
@MainActor public protocol PairedHostStateStorage {
    func read() -> DexterStoredState
    func write(_ data: Data) throws
}
/// Preferences hold public addressing/idempotency metadata, never keys/code/token or approved authority.
@MainActor public final class UserDefaultsPairedHostStateStorage: PairedHostStateStorage {
    private let defaults: UserDefaults, key: String
    public init(defaults: UserDefaults = .standard, key: String = "com.dexter.apple.paired-host-state.v1") { self.defaults = defaults; self.key = key }
    public func read() -> DexterStoredState { guard let value = defaults.object(forKey:key) else { return .missing }; guard let data = value as? Data else { return .unreadable }; return .data(data) }
    public func write(_ data: Data) throws { defaults.set(data,forKey:key); guard defaults.data(forKey:key) == data else { throw ClientIdentityFailure.unavailable } }
}
enum PairedStateCodec {
    static func decode(_ data: Data) throws -> PairedHostSnapshot {
        guard data.count <= 65_536 else { throw ClientIdentityFailure.invalidInput }; let state = try JSONDecoder().decode(PairedHostSnapshot.self,from:data)
        guard state.isValid() else { throw ClientIdentityFailure.conflict }; return state
    }
    static func encode(_ state: PairedHostSnapshot) throws -> Data {
        guard state.isValid() else { throw ClientIdentityFailure.conflict }; let data = try JSONEncoder().encode(state)
        guard data.count <= 65_536 else { throw ClientIdentityFailure.invalidInput }; return data
    }
}

@MainActor final class EphemeralPairedHostStateStorage: PairedHostStateStorage {
    private var bytes: Data?
    func read() -> DexterStoredState { bytes.map(DexterStoredState.data) ?? .missing }
    func write(_ data: Data) { bytes = data }
}
