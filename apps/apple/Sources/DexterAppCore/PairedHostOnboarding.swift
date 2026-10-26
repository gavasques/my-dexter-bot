import Foundation
import CoreFoundation
import Observation
import DexterClientIdentity
import DexterHostClient

public enum PairedHostConnectionState: String, Sendable {
    case disconnected, readyToProvision, identityReady, pendingApproval, paired, offline, revoked, identityMissing, identityLocked, outcomeUnknown, admissionBlocked, invalidMetadata
    public var label: String { switch self {
        case .disconnected: "Sem host pareado"
        case .readyToProvision: "Oferta importada · criar identidade explicitamente"
        case .identityReady: "Identidade disponível · solicitar pareamento"
        case .pendingApproval: "Aguardando aprovação do dono"
        case .paired: "Host pareado · conectado"
        case .offline: "Host pareado · offline"
        case .revoked: "Pareamento revogado"
        case .identityMissing: "Identidade local ausente · nenhuma recriação automática"
        case .identityLocked: "Identidade local bloqueada"
        case .outcomeUnknown: "Resultado desconhecido · confirme com o dono"
        case .admissionBlocked: "Pareamento não enviado · armazenamento ocupado ou sem capacidade"
        case .invalidMetadata: "Metadata inválida · conexão bloqueada"
    } }
}
struct ImportedClientOffer {
    let bundle: ClientPairingBundle, scopes: [ClientScope]
    static func decode(_ data: Data, platform: ClientRole) throws -> ImportedClientOffer {
        guard data.count <= PairingInvitationPreview.maximumBytes, let v = try JSONSerialization.jsonObject(with:data) as? [String:Any],
              Set(v.keys) == ["protocol","installationId","hostUrl","hostCertificateDER","hostFingerprint","offerId","kind","role","scopes","deviceId","expiresAt","code"],
              v["protocol"] as? String == "dexter-app-client-v1", v["kind"] as? String == "pair", v["deviceId"] is NSNull,
              let install = v["installationId"] as? String, let address = v["hostUrl"] as? String, let url = URL(string:address),
              let encodedDER = v["hostCertificateDER"] as? String, let der = Data(base64Encoded:encodedDER), der.base64EncodedString() == encodedDER,
              let fingerprint = v["hostFingerprint"] as? String, let offer = v["offerId"] as? String,
              let roleString = v["role"] as? String, let role = ClientRole(rawValue:roleString), role == platform,
              let strings = v["scopes"] as? [String], strings.count <= ClientScope.allCases.count, Set(strings).count == strings.count,
              strings == strings.sorted(), strings.allSatisfy({ClientScope(rawValue:$0) != nil}), let expires = v["expiresAt"] as? NSNumber,
              CFGetTypeID(expires) != CFBooleanGetTypeID(), expires.doubleValue.isFinite, expires.doubleValue.rounded() == expires.doubleValue,
              let code = v["code"] as? String, code.range(of:"^[A-Za-z0-9_-]{43}$",options:.regularExpression) != nil else { throw ClientIdentityFailure.invalidInput }
        let expiresAt = Date(timeIntervalSince1970:expires.doubleValue/1000)
        guard expiresAt > Date() else { throw ClientIdentityFailure.expired }
        return ImportedClientOffer(bundle:try .init(host:PinnedClientHost(url:url,certificateDER:der,fingerprint:fingerprint),installationID:install,offerID:offer,role:role,expiresAt:expiresAt,code:code),scopes:strings.compactMap(ClientScope.init(rawValue:)))
    }
}

/// Code-free facts for the private QR review. Inspection writes no preference, creates no key and sends no request.
public struct PairingInvitationPreview: Equatable, Sendable {
    public static let maximumBytes = 8_192
    /// QR Model 2, byte mode, correction L. Larger valid invitations retain the explicit paste fallback.
    public static let maximumQRBytes = 2_953
    public let hostURL: URL
    public let installationID: String
    public let hostFingerprint: String
    public let scopes: [ClientScope]
    public let expiresAt: Date
    public static func inspect(_ data: Data, platform: ClientRole) throws -> Self {
        let offer = try ImportedClientOffer.decode(data, platform: platform)
        return .init(hostURL: offer.bundle.host.url, installationID: offer.bundle.installationID,
                     hostFingerprint: offer.bundle.host.fingerprint, scopes: offer.scopes, expiresAt: offer.bundle.expiresAt)
    }
}
@Observable @MainActor public final class PairedHostOnboarding {
    public private(set) var state: PairedHostConnectionState = .disconnected
    public private(set) var publicReference: PairedHostReference?
    public private(set) var generation: UInt64 = 0
    public private(set) var notice: String?
    public private(set) var invitationExpired = false
    @ObservationIgnored public private(set) var activeClient: HostClient?
    @ObservationIgnored public private(set) var binding: PairedHostBinding?
    @ObservationIgnored private var snapshot = PairedHostSnapshot()
    @ObservationIgnored private var committedSnapshot = PairedHostSnapshot()
    @ObservationIgnored private var imported: ImportedClientOffer?
    @ObservationIgnored private var operationBusy = false
    @ObservationIgnored private var session: ClientPairingSession?
    @ObservationIgnored private let journal: any PairedClientClaimJournal
    @ObservationIgnored private let storage: any PairedHostStateStorage
    @ObservationIgnored private let identityStorage: @MainActor (ClientIdentityScope) -> any ClientIdentityStorage
    @ObservationIgnored private let platform: ClientRole
    public init(journal: any PairedClientClaimJournal, storage: any PairedHostStateStorage = UserDefaultsPairedHostStateStorage(), identityStorage: @escaping @MainActor (ClientIdentityScope) -> any ClientIdentityStorage = { SecureEnclaveDataProtectionKeychain(scope:$0) }) {
        self.journal = journal; self.storage = storage; self.identityStorage = identityStorage
        #if os(iOS)
        platform = .clientIOS
        #else
        platform = .clientMac
        #endif
        do { switch storage.read() { case .missing: break; case .data(let data): snapshot = try PairedStateCodec.decode(data); publicReference = snapshot.detached == true ? nil : snapshot.selected; if publicReference != nil { state = .offline }; case .unreadable: state = .invalidMetadata } }
        catch { state = .invalidMetadata }
        committedSnapshot = snapshot
    }
    public func importBundle(_ data: Data) throws {
        guard state != .invalidMetadata else { throw ClientIdentityFailure.conflict }
        let offer = try ImportedClientOffer.decode(data,platform:platform)
        do { try journal.assertNoUnknownClaim(installationID:offer.bundle.installationID,role:offer.bundle.role) }
        catch { failed(error); throw error }
        // Unknown claims may not be silently replaced/re-paired at the same installation.
        if ([snapshot.selected].compactMap({$0}) + snapshot.retainedReferences).contains(where:{$0.installationID == offer.bundle.installationID && $0.claimOutcomeUnknown}) { failed(ClientIdentityFailure.outcomeUnknown); throw ClientIdentityFailure.outcomeUnknown }
        let previous = snapshot.selected
        var candidate = snapshot
        candidate.retainedReferences = try candidate.retainedReferences.filter { try !journal.mayDiscardReference($0) }
        if let previous, previous.installationID == offer.bundle.installationID, previous.role == offer.bundle.role,
           previous.hostFingerprint == offer.bundle.host.fingerprint, previous.hostURL == offer.bundle.host.url.absoluteString, previous.claimID == nil, !previous.claimOutcomeUnknown {
            candidate.selected = previous; candidate.selected?.scopes = offer.scopes
        } else {
            if let previous, try !journal.mayDiscardReference(previous), !candidate.retainedReferences.contains(previous) { candidate.retainedReferences.append(previous) }
            guard candidate.retainedReferences.count <= 20 else { failed(ClaimJournalAdmissionError.capacity); throw ClaimJournalAdmissionError.capacity }
            let scope = try ClientIdentityScope(installationID:offer.bundle.installationID,localBindingID:ClientIdentityScope.newLocalBindingID(),role:offer.bundle.role,hostFingerprint:offer.bundle.host.fingerprint)
            candidate.selected = PairedHostReference(scope:scope,host:offer.bundle.host,scopes:offer.scopes)
        }
        candidate.detached = false
        try commit(candidate)
        disconnect(); imported = offer
        state = candidate.selected?.clientFingerprint == nil ? .readyToProvision : .identityReady
        invitationExpired = false
        notice = nil
    }
    /// Only this explicitly invoked user action creates a key. Restore/load never does.
    public func provisionIdentity() async {
        guard !operationBusy, state == .readyToProvision, let reference = publicReference else { return }
        operationBusy = true; defer { operationBusy = false }
        let token = generation
        do { try journal.assertNoUnknownClaim(installationID:reference.installationID,role:reference.role); let lifecycle = try lifecycle(reference); let identity = try await lifecycle.provisionExplicitly(); guard current(token) else { return }; snapshot.selected?.clientFingerprint = identity.fingerprint; try save(); state = .identityReady }
        catch { guard current(token) else { return }; failed(error) }
    }
    public func claim(name: String) async {
        guard !operationBusy, state == .identityReady, let imported, let reference = publicReference else { return }
        operationBusy = true; defer { operationBusy = false }
        let token = generation
        guard !name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty, name.utf16.count <= 120, name.utf8.count <= 480, !name.unicodeScalars.contains(where:{CharacterSet.controlCharacters.contains($0)}) else { notice = "Nome do cliente inválido"; return }
        let observed = ObservedClaimJournal(base:journal)
        do {
            try journal.assertNoUnknownClaim(installationID:reference.installationID,role:reference.role)
            _ = try await checkedIdentity(reference); guard current(token) else { return }
            let next = try await ClientConnectionFactory.pairing(bundle:imported.bundle,lifecycle:lifecycle(reference),journal:observed); guard current(token) else { await next.close().wait(); return }; session = next
            // Durable quarantine precedes handoff, including process death before claim ACK.
            let claim = try await next.begin(name:name); guard current(token) else { await next.close().wait(); return }
            snapshot.selected?.claimID = claim; snapshot.selected?.claimOutcomeUnknown = false; try save(); state = .pendingApproval; self.imported = nil
        } catch { guard current(token) else { return }; let reserved = await observed.didReserve(); guard current(token) else { return }; if reserved { snapshot.selected?.claimOutcomeUnknown = true; try? save(); self.imported = nil; failed(ClientIdentityFailure.outcomeUnknown) } else { failed(error) } }
    }
    public func restoreOrCheckApproval() async {
        guard !operationBusy, state != .invalidMetadata, let reference = publicReference else { return }
        operationBusy = true; defer { operationBusy = false }
        let token = generation
        var recoveredClaim = reference.claimID
        do { let savedEntry = try await journal.loadOnly(scope:reference.scope()); guard current(token) else { return }; if let entry = savedEntry {
            let expectedHost = try reference.host()
            guard entry.reservation.host.url == expectedHost.url, entry.reservation.host.certificateDER == expectedHost.certificateDER, entry.reservation.host.fingerprint == expectedHost.fingerprint, entry.reservation.clientFingerprint == reference.clientFingerprint else { throw ClientIdentityFailure.conflict }
            guard let claim = entry.claimID else { state = .outcomeUnknown; return }
            guard recoveredClaim == nil || recoveredClaim == claim else { throw ClientIdentityFailure.conflict }
            recoveredClaim = claim; snapshot.selected?.claimID = claim; snapshot.selected?.claimOutcomeUnknown = false; try save()
        } else if reference.claimOutcomeUnknown || recoveredClaim != nil { state = .outcomeUnknown; return } } catch { failed(error); return }
        guard current(token) else { return }
        guard let claim = recoveredClaim else {
            do {
                let identity = try await lifecycle(reference).loadOnly(); guard current(token) else { return }
                if let expected = reference.clientFingerprint, expected != identity.fingerprint { throw ClientIdentityFailure.conflict }
                snapshot.selected?.clientFingerprint = identity.fingerprint; try save(); state = .identityReady
                notice = "Identidade recuperada sem recriação. Importe a oferta para enviar o claim."
            } catch { guard current(token) else { return }; failed(error) }
            return
        }
        do {
            _ = try await checkedIdentity(reference); guard current(token) else { return }
            let pending = try PendingClientPairing(scope:reference.scope(),host:reference.host(),claimID:claim)
            let next = try await ClientConnectionFactory.restore(pending:pending,lifecycle:lifecycle(reference),journal:journal); guard current(token) else { await next.close().wait(); return }; _ = session?.close(); session = next
            let status = try await journal.statusAndResolve(next); guard current(token) else { await next.close().wait(); return }
            switch status {
            case .pending: state = .pendingApproval
            case .approved(let approved):
                guard approved.scopes == reference.scopes, approved.clientFingerprint == reference.clientFingerprint,
                      reference.deviceID.map({$0 == approved.deviceID}) ?? true, reference.ownerID.map({$0 == approved.ownerID}) ?? true,
                      reference.pinGeneration.map({$0 == approved.pinGeneration}) ?? true, reference.bindingRevision.map({$0 <= approved.bindingRevision}) ?? true else { throw ClientIdentityFailure.conflict }
                let client = try await HostClient.paired(binding:approved,lifecycle:lifecycle(reference))
                guard current(token) else { await client.close().value; return }
                do { _ = try await client.health() } catch { await client.close().value; throw error }
                guard current(token) else { await client.close().value; return }
                snapshot.selected?.ownerID = approved.ownerID; snapshot.selected?.deviceID = approved.deviceID; snapshot.selected?.pinGeneration = approved.pinGeneration; snapshot.selected?.bindingRevision = approved.bindingRevision
                do { try save() } catch { await client.close().value; throw error }
                activeClient?.close(); activeClient = client; binding = approved; state = .paired; notice = nil
            case .rejected,.expired,.failed: disconnect(); state = .revoked
            }
        } catch { guard current(token) else { return }; failed(error) }
    }
    public func revokeThisClient() async {
        guard let client = activeClient else { return }; let token = generation
        do { _ = try await client.revokeOwnDevice(); guard current(token) else { return }; disconnect(); state = .revoked }
        catch { guard current(token) else { return }; failed(Self.revokeFailure(error)) }
    }
    static func revokeFailure(_ error: Error) -> Error {
        guard let host = error as? HostClientError else { return error }
        switch host { case .offline,.notReady,.hostFailure,.contractMismatch,.deviceMutationOutcomeUnknown,.mutationOutcomeUnknown: return HostClientError.mutationOutcomeUnknown
        default: return error }
    }
    public func disconnect() {
        generation &+= 1; activeClient?.close(); activeClient = nil; binding = nil; _ = session?.close(); session = nil
        state = publicReference == nil ? .disconnected : .offline
    }
    public func detach() throws {
        var candidate = snapshot
        candidate.retainedReferences = try candidate.retainedReferences.filter { try !journal.mayDiscardReference($0) }
        if let selected = candidate.selected, try !journal.mayDiscardReference(selected), !candidate.retainedReferences.contains(selected) {
            if candidate.retainedReferences.count < 20 { candidate.retainedReferences.append(selected); candidate.selected = nil }
            else { candidate.detached = true } // Existing selected slot preserves unknown bookkeeping at full capacity.
        } else { candidate.selected = nil }
        if candidate.selected == nil { candidate.detached = false }
        try commit(candidate); disconnect(); imported = nil; state = .disconnected
    }
    func recordPending(_ record: PairedPendingTurn) throws {
        guard record.isValid() else { throw ClientIdentityFailure.invalidInput }
        if let existing = snapshot.pendingTurns.first(where:{$0.installationID == record.installationID && $0.deviceID == record.deviceID && $0.threadID == record.threadID}) {
            guard existing == record else { throw ClientIdentityFailure.conflict }; return
        }
        snapshot.pendingTurns.append(record); try save()
    }
    func pending(installation: String,device: String,thread: String) -> PairedPendingTurn? { snapshot.pendingTurns.first {$0.installationID == installation && $0.deviceID == device && $0.threadID == thread} }
    func clearPending(_ record: PairedPendingTurn) throws { snapshot.pendingTurns.removeAll {$0 == record}; try save() }
    private func commit(_ candidate: PairedHostSnapshot) throws {
        try storage.write(PairedStateCodec.encode(candidate))
        guard case .data(let data) = storage.read(), try PairedStateCodec.decode(data) == candidate else { throw ClientIdentityFailure.unavailable }
        snapshot = candidate; committedSnapshot = candidate; publicReference = candidate.detached == true ? nil : candidate.selected
    }
    private func save() throws { let candidate = snapshot; snapshot = committedSnapshot; try commit(candidate) }
    private func lifecycle(_ reference: PairedHostReference) throws -> ClientIdentityLifecycle { let scope = try reference.scope(); return ClientIdentityLifecycle(scope:scope,storage:identityStorage(scope)) }
    private func checkedIdentity(_ reference: PairedHostReference) async throws -> ClientNativeIdentity {
        let identity = try await lifecycle(reference).loadOnly(); guard identity.fingerprint == reference.clientFingerprint else { throw ClientIdentityFailure.conflict }; return identity
    }
    private func current(_ token: UInt64) -> Bool { token == generation }
    private func failed(_ error: Error) {
        activeClient?.close(); activeClient = nil; binding = nil
        if error is ClaimJournalAdmissionError { state = .admissionBlocked }
        else if let failure = error as? ClientIdentityFailure { switch failure {
            case .missing,.incomplete: state = .identityMissing
            case .locked: state = .identityLocked
            case .outcomeUnknown: state = .outcomeUnknown
            case .expired: imported = nil; invitationExpired = true; state = .offline
            case .conflict,.pinMismatch,.invalidInput: state = .invalidMetadata
            default: state = .offline
        } } else if error as? HostClientError == .mutationOutcomeUnknown { state = .outcomeUnknown } else { state = .offline }
        notice = state.label
    }
}

/// A successful durable reserve is the conservative handoff boundary mandated by ClientIdentity.
/// Pre-reserve failures cannot manufacture a preferences unknown; post-reserve failures retain it.
private actor ObservedClaimJournal: ClientClaimJournal {
    let base: any PairedClientClaimJournal
    private var reserved = false
    init(base: any PairedClientClaimJournal) { self.base = base }
    func didReserve() -> Bool { reserved }
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? { try await base.loadOnly(scope:scope) }
    func reserve(_ reservation: ClientClaimReservation) async throws {
        do { try await base.reserve(reservation) }
        catch {
            // Admission refusals and pre-persist failures never wrote. Only an ambiguous failure (e.g. the parent fsync
            // after the rename) may have left a durable reservation: probe the EXACT scope, and fail closed if unreadable.
            if Self.mayHavePersisted(error) { reserved = await persisted(reservation.scope) }
            throw error
        }
        reserved = true
    }
    private static func mayHavePersisted(_ error: Error) -> Bool {
        if error is ClaimJournalAdmissionError { return false }
        if let failure = error as? ClientIdentityFailure { return failure == .unavailable }
        return true
    }
    private func persisted(_ scope: ClientIdentityScope) async -> Bool {
        do { return try await base.loadOnly(scope:scope) != nil } catch { return true }
    }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws { try await base.saveAcknowledgement(reservation,claimID:claimID) }
}
