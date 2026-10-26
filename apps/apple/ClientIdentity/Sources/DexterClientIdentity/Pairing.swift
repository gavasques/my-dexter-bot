import Foundation

/// Trusted owner-delivered public pin/offer bundle. Code is transient and never Codable or descriptive output.
public struct ClientPairingBundle: Sendable, CustomStringConvertible, CustomReflectable {
    public let host: PinnedClientHost, installationID: String, offerID: String, role: ClientRole, expiresAt: Date
    private let code: String
    public init(host: PinnedClientHost, installationID: String, offerID: String, role: ClientRole, expiresAt: Date, code: String, now: Date = Date()) throws {
        guard finiteID(installationID), finiteID(offerID), expiresAt.timeIntervalSince1970.isFinite,
              expiresAt > now, expiresAt.timeIntervalSince(now) <= 86400, (16...256).contains(code.utf8.count),
              code.utf8.allSatisfy({(33...126).contains($0)}) else { throw ClientIdentityFailure.invalidInput }
        self.host = host; self.installationID = installationID; self.offerID = offerID; self.role = role; self.expiresAt = expiresAt; self.code = code
    }
    init(pending: PendingClientPairing) {
        host = pending.host; installationID = pending.scope.installationID; offerID = "pending-reference"; role = pending.scope.role; expiresAt = Date(timeIntervalSince1970:0); code = ""
    }
    public var customMirror: Mirror { Mirror(self,children:["installationID":installationID,"offerID":offerID,"code":"redacted"]) }
    public var description: String { "ClientPairingBundle(installation:\(installationID),offer:\(offerID),code:redacted)" }
    func claim(name: String) throws -> ClientRequest {
        guard Date() < expiresAt else { throw ClientIdentityFailure.expired }
        return try .json(route:.pairClaim,value:["offerId":offerID,"code":code,"name":name])
    }
}

/// Only a verified pinned pair/status response can construct this immutable binding.
/// This is metadata, not a transferable bearer or authority the server trusts.
public struct PairedHostBinding: Sendable {
    public let host: PinnedClientHost, installationID: String, ownerID: String, deviceID: String, claimID: String
    public let localBindingID: String, role: ClientRole, scopes: [ClientScope], clientFingerprint: String
    public let pinGeneration: Int, bindingRevision: Int
    init(bundle: ClientPairingBundle, scope: ClientIdentityScope, identity: ClientNativeIdentity, claimID: String, value: [String:Any]) throws {
        try ClientRequest.object(value,allowed:["protocol","status","deviceId","installationId","ownerId","role","scopes","pinGeneration","bindingRevision"])
        guard scope.hostFingerprint == bundle.host.fingerprint, finiteID(claimID), value["protocol"] as? String == "dexter-app-client-v1", value["status"] as? String == "approved",
              value["installationId"] as? String == bundle.installationID, scope.installationID == bundle.installationID,
              value["role"] as? String == bundle.role.rawValue, scope.role == bundle.role,
              let owner = value["ownerId"] as? String, finiteID(owner), let device = value["deviceId"] as? String, finiteID(device),
              let strings = value["scopes"] as? [String], strings.count <= ClientScope.allCases.count, Set(strings).count == strings.count,
              strings.allSatisfy({ClientScope(rawValue:$0) != nil}), ClientRequest.integer(value["pinGeneration"],minimum:1),
              ClientRequest.integer(value["bindingRevision"],minimum:1) else { throw ClientIdentityFailure.conflict }
        host = bundle.host; installationID = bundle.installationID; ownerID = owner; deviceID = device; self.claimID = claimID
        localBindingID = scope.localBindingID; role = bundle.role; scopes = strings.sorted().compactMap(ClientScope.init(rawValue:))
        clientFingerprint = identity.fingerprint; pinGeneration = (value["pinGeneration"] as! NSNumber).intValue; bindingRevision = (value["bindingRevision"] as! NSNumber).intValue
    }
}
/// Public metadata to locate the exact identity after restart, never an approved binding or bearer.
public struct PendingClientPairing: Sendable {
    public let scope: ClientIdentityScope, host: PinnedClientHost, claimID: String
    public init(scope: ClientIdentityScope, host: PinnedClientHost, claimID: String) throws {
        guard scope.hostFingerprint == host.fingerprint, finiteID(claimID) else { throw ClientIdentityFailure.invalidInput }; self.scope = scope; self.host = host; self.claimID = claimID
    }
}
/// Bounded code-free owner configuration. This is neither server approval nor a bearer.
public struct ClientClaimReservation: Sendable {
    public let scope: ClientIdentityScope, host: PinnedClientHost, offerID: String, clientFingerprint: String
    public init(scope: ClientIdentityScope, host: PinnedClientHost, offerID: String, clientFingerprint: String) throws {
        guard scope.hostFingerprint == host.fingerprint, finiteID(offerID), fingerprintValid(clientFingerprint) else { throw ClientIdentityFailure.invalidInput }
        self.scope = scope; self.host = host; self.offerID = offerID; self.clientFingerprint = clientFingerprint
    }
    public func matches(_ other: ClientClaimReservation) -> Bool {
        scope == other.scope && host.url == other.host.url && host.certificateDER == other.host.certificateDER &&
        host.fingerprint == other.host.fingerprint && offerID == other.offerID && clientFingerprint == other.clientFingerprint
    }
}
public struct ClientClaimJournalEntry: Sendable {
    public let reservation: ClientClaimReservation, claimID: String?
    public init(reservation: ClientClaimReservation, claimID: String?) throws {
        guard claimID.map(finiteID) ?? true else { throw ClientIdentityFailure.invalidInput }
        self.reservation = reservation; self.claimID = claimID
    }
}
/// REQUIRED durable owner implementation. No library ephemeral/default journal exists.
/// loadOnly never mutates. reserve atomically persists iff the scope has NO existing entry,
/// across sessions/processes (including other offers). saveAcknowledgement atomically compares
/// the full reservation and persists claimID before replacing uncertain state. Fail closed on
/// storage failure. Never persist code/key/token/request/error text; never clear on expiry/detach.
public protocol ClientClaimJournal: Sendable {
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry?
    func reserve(_ reservation: ClientClaimReservation) async throws
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws
}
public enum ClientPairingStatus: Sendable { case pending, approved(PairedHostBinding), rejected, expired, failed }

/// Future app flow persists scope+pending claim ID, then restores the SAME identity via loadOnly.
/// Restoring local metadata alone never creates an approved binding.
public actor ClientPairingSession {
    private let bundle: ClientPairingBundle, scope: ClientIdentityScope, identity: ClientNativeIdentity, transport: NativeHostTransport
    private let journal: any ClientClaimJournal
    private var claimID: String?
    private var claimInFlight = false, claimUncertain = false
    public init(bundle: ClientPairingBundle, scope: ClientIdentityScope, identity: ClientNativeIdentity, journal: any ClientClaimJournal) throws {
        guard scope.hostFingerprint == bundle.host.fingerprint, bundle.installationID == scope.installationID, bundle.role == scope.role else { throw ClientIdentityFailure.conflict }
        self.bundle = bundle; self.scope = scope; self.identity = identity; self.journal = journal; claimID = nil
        transport = NativeHostTransport(identity:identity,host:bundle.host)
    }
    public init(pending: PendingClientPairing, identity: ClientNativeIdentity, journal: any ClientClaimJournal) {
        bundle = ClientPairingBundle(pending:pending); scope = pending.scope; self.identity = identity; claimID = pending.claimID; self.journal = journal
        transport = NativeHostTransport(identity:identity,host:pending.host)
    }
    public func pendingReference() throws -> PendingClientPairing {
        guard let claimID else { throw ClientIdentityFailure.missing }; return try PendingClientPairing(scope:scope,host:bundle.host,claimID:claimID)
    }
    public func begin(name: String) async throws -> String {
        guard !claimUncertain else { throw ClientIdentityFailure.outcomeUnknown }
        guard claimID == nil, !claimInFlight else { throw ClientIdentityFailure.conflict }
        claimInFlight = true; defer { claimInFlight = false }
        if let entry = try await journal.loadOnly(scope:scope) {
            if entry.claimID == nil { throw ClientIdentityFailure.outcomeUnknown }
            throw ClientIdentityFailure.conflict
        }
        let request = try bundle.claim(name:name)
        let reservation = try ClientClaimReservation(scope:scope,host:bundle.host,offerID:bundle.offerID,clientFingerprint:identity.fingerprint)
        try await journal.reserve(reservation)
        // A durable reservation is never automatically erased, even for pre-handoff failure.
        claimUncertain = true
        let response: ClientTransportResponse
        do { response = try await transport.send(request) }
        catch { if error as? ClientIdentityFailure == .outcomeUnknown { claimUncertain = true }; throw error }
        // A successful handoff with an unusable acknowledgement cannot safely create another claim.
        claimUncertain = true
        do {
            guard (200...299).contains(response.statusCode), let value = try? JSONSerialization.jsonObject(with:response.data) as? [String:Any] else { throw ClientIdentityFailure.protocolError }
            try ClientRequest.object(value,allowed:["claimId","status"])
            guard value["status"] as? String == "pending", let id = value["claimId"] as? String, finiteID(id) else { throw ClientIdentityFailure.protocolError }
            try await journal.saveAcknowledgement(reservation,claimID:id)
            claimID = id; claimUncertain = false; return id
        } catch { throw ClientIdentityFailure.outcomeUnknown }
    }
    public func status() async throws -> ClientPairingStatus {
        guard let entry = try await journal.loadOnly(scope:scope) else { throw ClientIdentityFailure.missing }
        guard entry.reservation.scope == scope, entry.reservation.host.url == bundle.host.url,
              entry.reservation.host.certificateDER == bundle.host.certificateDER,
              entry.reservation.host.fingerprint == bundle.host.fingerprint,
              entry.reservation.clientFingerprint == identity.fingerprint else { throw ClientIdentityFailure.conflict }
        guard let saved = entry.claimID else { throw ClientIdentityFailure.outcomeUnknown }
        guard claimID == nil || claimID == saved else { throw ClientIdentityFailure.conflict }
        claimID = saved
        let claimID = saved
        let response = try await transport.send(.json(route:.pairStatus,value:["claimId":claimID]))
        guard (200...299).contains(response.statusCode), let value = try? JSONSerialization.jsonObject(with:response.data) as? [String:Any],
              value["protocol"] as? String == "dexter-app-client-v1", let status = value["status"] as? String else { throw ClientIdentityFailure.protocolError }
        if status == "approved" { return .approved(try PairedHostBinding(bundle:bundle,scope:scope,identity:identity,claimID:claimID,value:value)) }
        try ClientRequest.object(value,allowed:["protocol","status","deviceId","installationId","ownerId","role","scopes","pinGeneration","bindingRevision"])
        guard value["role"] as? String == bundle.role.rawValue, value["deviceId"] is NSNull, value["installationId"] is NSNull,
              value["ownerId"] is NSNull, value["pinGeneration"] is NSNull, value["bindingRevision"] is NSNull,
              let scopes = value["scopes"] as? [String], scopes.count <= ClientScope.allCases.count, Set(scopes).count == scopes.count, scopes.allSatisfy({ClientScope(rawValue:$0) != nil}) else { throw ClientIdentityFailure.conflict }
        switch status { case "pending": return .pending; case "rejected": return .rejected; case "expired": return .expired; case "failed": return .failed; default: throw ClientIdentityFailure.protocolError }
    }
    public nonisolated func close() -> ClientTransportClose { transport.close() }
}
