import Foundation

/// The verification code of a device certificate, as both sides show it: uppercase hex in groups of four, two lines of
/// eight groups. The owner compares the request's code with the one the requesting device shows (iPhone or Mac). Anything
/// that is not 64 hex characters is shown as it is (never shortened: the whole code is the comparison).
public enum PairingVerificationCode {
    public static func text(_ fingerprint: String) -> String {
        let hex = fingerprint.lowercased()
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return fingerprint }
        let groups = stride(from: 0, to: 64, by: 4).map { start -> String in
            let from = hex.index(hex.startIndex, offsetBy: start)
            return String(hex[from..<hex.index(from, offsetBy: 4)]).uppercased()
        }
        return groups[0..<8].joined(separator: " ") + "\n" + groups[8..<16].joined(separator: " ")
    }
}

#if os(macOS)
import DexterClientIdentity
import DexterHostClient

/// One window's "Pedidos de aparelhos" flow for THIS Mac's own base: a short-lived owner-loopback client (closed with the
/// session) and the real `OwnerPairingClaimsEditor`. Never for a paired base, the demo or no base. When the window's base
/// changes the UI drops the session and opens a new one; nothing decided for the old base is sent to the new one.
@MainActor public final class OwnerPairingClaimsSession {
    public let editor: OwnerPairingClaimsEditor
    /// `DexterAppModel.pairingOfferScope` at creation; the UI compares it before showing anything.
    public let scope: String
    private let client: HostClient
    private var closed = false

    public init(client: HostClient, scope: String) {
        self.client = client; self.scope = scope
        editor = OwnerPairingClaimsEditor(client: client)
    }

    /// Closes this session's own client. Nothing is sent.
    public func close() {
        guard !closed else { return }
        closed = true
        client.close()
    }
}

public extension DexterAppModel {
    /// This Mac's owner base only (`canEditBotProfiles`: loopback, not the demo, not paired): its own loopback client.
    func makeOwnerPairingClaimsSession() -> OwnerPairingClaimsSession? {
        guard canEditBotProfiles, let local = makeLocalMcpClient() else { return nil }
        return OwnerPairingClaimsSession(client: local, scope: pairingOfferScope)
    }
}

/// Plain words for device requests (Portuguese catalog keys) and the verification code both devices show. Display only.
public enum OwnerPairingClaimsPresentation {
    /// The verification code the owner compares (same string the requesting device shows).
    public static func verificationCode(_ fingerprint: String) -> String { PairingVerificationCode.text(fingerprint) }

    public static func reasonKey(_ reason: OwnerPairingClaimsList.Reason?) -> String {
        switch reason {
        case .channelUnconfigured?: "Esta base ainda não está preparada para receber outros aparelhos."
        case .hostClosing?: "A base está desligando. Tente de novo depois."
        case nil: "Pedidos indisponíveis nesta base agora."
        }
    }

    public static func kindKey(_ kind: OwnerPairingClaim.Kind) -> String {
        switch kind {
        case .pair: "Quer entrar nesta base"
        case .rotate: "Quer trocar a chave de um aparelho já conectado"
        }
    }

    public static func statusKey(_ status: OwnerPairingClaim.Status) -> String {
        switch status {
        case .pending: "Esperando você"
        case .approving: "Aprovação em andamento"
        case .approved: "Aprovado"
        case .rejected: "Recusado"
        case .failed: "Não concluído"
        case .expired: "Expirado"
        }
    }

    public static func outcomeKey(_ outcome: OwnerPairingDecisionReceipt.Outcome) -> String {
        switch outcome {
        case .approved: "Aparelho aprovado. Ele já pode usar esta base com as permissões mostradas. Nenhum bot ganhou permissão."
        case .rejected: "Pedido recusado. Esse aparelho não entra nesta base."
        case .notApplied: "O pedido não estava mais esperando; nada mudou."
        case .failed: "A base não conseguiu concluir esta decisão. Veja Aparelhos para o estado atual."
        case .unknown: "Não deu para confirmar a decisão. Use Conferir."
        }
    }

    public static func noticeKey(_ notice: OwnerPairingClaimsEditor.Notice) -> String {
        switch notice {
        case .loadFailed: "Não foi possível ler os pedidos desta base."
        case .baseOffline: "A base deste Mac não está respondendo agora."
        case .notOwnerLoopback: "Pedidos só podem ser decididos na base deste Mac."
        case .hostChanged: "Outra base respondeu. Nada foi enviado; atualize para continuar."
        case .conflict: "Esta base mudou desde que você abriu o pedido. Nada foi decidido; a lista foi relida. Confira e decida de novo."
        case .invalidRequest: "A base recusou esta decisão. Nada foi aplicado."
        case .outcomeUnknown: "Não deu para confirmar a decisão. Use Conferir antes de qualquer outra coisa."
        case .decided(let outcome): outcomeKey(outcome)
        }
    }

    /// True when a decision call ended with no new receipt, nothing pending and no notice: the host refused it before
    /// applying anything (409: revision, pins or journal continuity after a restore) and the controller already re-read the
    /// list, which clears its own conflict notice. The UI then says that nothing was decided (never a success).
    @MainActor public static func nothingDecided(_ editor: OwnerPairingClaimsEditor, previousReceiptRequestID: String?) -> Bool {
        editor.pendingDecision == nil && editor.notice == nil && editor.lastDecision?.receipt.clientRequestId == previousReceiptRequestID
    }

    /// Requests ordered for review: the one tied to `focusOfferRequestID` (the invitation just used) first, then newest.
    public static func ordered(_ claims: [OwnerPairingClaim], focusOfferRequestID: String?) -> [OwnerPairingClaim] {
        claims.sorted { lhs, rhs in
            let lf = focusOfferRequestID != nil && lhs.offerClientRequestId == focusOfferRequestID
            let rf = focusOfferRequestID != nil && rhs.offerClientRequestId == focusOfferRequestID
            if lf != rf { return lf }
            return lhs.createdAt != rhs.createdAt ? lhs.createdAt > rhs.createdAt : lhs.claimId < rhs.claimId
        }
    }
}
#endif
