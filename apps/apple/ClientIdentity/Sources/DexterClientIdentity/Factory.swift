import Foundation

/// Future SDK adapter uses this seam; invalid public metadata fails before storage access.
/// No SDK dependency, private key copy, implicit provision or local preference authority.
public enum ClientConnectionFactory {
    public static func pairing(bundle: ClientPairingBundle, lifecycle: ClientIdentityLifecycle, journal: any ClientClaimJournal) async throws -> ClientPairingSession {
        let scope = lifecycle.scope
        guard scope.hostFingerprint == bundle.host.fingerprint, scope.installationID == bundle.installationID, scope.role == bundle.role else { throw ClientIdentityFailure.conflict }
        if Task.isCancelled { throw ClientIdentityFailure.cancelled }
        let identity = try await lifecycle.loadOnly()
        return try ClientPairingSession(bundle:bundle,scope:scope,identity:identity,journal:journal)
    }
    public static func restore(pending: PendingClientPairing, lifecycle: ClientIdentityLifecycle, journal: any ClientClaimJournal) async throws -> ClientPairingSession {
        guard pending.scope.hostFingerprint == pending.host.fingerprint, lifecycle.scope == pending.scope else { throw ClientIdentityFailure.conflict }
        if Task.isCancelled { throw ClientIdentityFailure.cancelled }
        let identity = try await lifecycle.loadOnly()
        guard let entry = try await journal.loadOnly(scope:pending.scope) else { throw ClientIdentityFailure.missing }
        guard entry.reservation.scope == pending.scope, entry.reservation.host.url == pending.host.url,
              entry.reservation.host.certificateDER == pending.host.certificateDER,
              entry.reservation.host.fingerprint == pending.host.fingerprint,
              entry.reservation.clientFingerprint == identity.fingerprint else { throw ClientIdentityFailure.conflict }
        guard let saved = entry.claimID else { throw ClientIdentityFailure.outcomeUnknown }
        guard saved == pending.claimID else { throw ClientIdentityFailure.conflict }
        return ClientPairingSession(pending:pending,identity:identity,journal:journal)
    }
    public static func paired(binding: PairedHostBinding, lifecycle: ClientIdentityLifecycle) async throws -> NativeHostTransport {
        let scope = lifecycle.scope
        guard scope.hostFingerprint == binding.host.fingerprint, scope.installationID == binding.installationID, scope.localBindingID == binding.localBindingID, scope.role == binding.role else { throw ClientIdentityFailure.conflict }
        if Task.isCancelled { throw ClientIdentityFailure.cancelled }
        return try NativeHostTransport(identity:await lifecycle.loadOnly(),binding:binding)
    }
}
