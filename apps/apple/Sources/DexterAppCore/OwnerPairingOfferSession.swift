#if os(macOS)
import DexterClientIdentity
import DexterHostClient
import Foundation

/// One window's "Convidar outro aparelho" flow for THIS Mac's own base: a short-lived owner-loopback client (closed with
/// the session) and the real `OwnerPairingOfferEditor`. Never for a paired base, the demo or no base. A session is never
/// re-pointed: when the window's base changes the UI drops it (and the invitation text it held) and opens a new one.
@MainActor public final class OwnerPairingOfferSession {
    public let editor: OwnerPairingOfferEditor
    /// `DexterAppModel.pairingOfferScope` at creation; the UI compares it before showing anything.
    public let scope: String
    private let client: HostClient
    private var closed = false

    public init(client: HostClient, scope: String) {
        self.client = client; self.scope = scope
        editor = OwnerPairingOfferEditor(client: client)
    }

    /// Drops the invitation text from memory and closes this session's own client. Nothing is sent.
    public func close() {
        guard !closed else { return }
        closed = true
        editor.forgetInvitation()
        client.close()
    }
}

public extension DexterAppModel {
    /// Identity of the base this window shows (window scope + host address + owner host id). The invitation flow binds to it.
    var pairingOfferScope: String { "\(nativeComposerScope)|\(hostAddress)|\(approvalPolicyHostID ?? "-")" }

    /// This Mac's owner base only (`canEditBotProfiles`: loopback, not the demo, not paired): its own loopback client.
    func makeOwnerPairingOfferSession() -> OwnerPairingOfferSession? {
        guard canEditBotProfiles, let local = makeLocalMcpClient() else { return nil }
        return OwnerPairingOfferSession(client: local, scope: pairingOfferScope)
    }
}

/// Plain words for the invitation flow (Portuguese catalog keys). Display only; every decision stays with the controller.
public enum OwnerPairingOfferPresentation {
    public static func reasonKey(_ reason: OwnerPairingUnavailableReason?) -> String {
        switch reason {
        case .channelUnconfigured?: "Esta base ainda não está preparada para receber outros aparelhos."
        case .listenerNotListening?: "A conexão para outros aparelhos está parada nesta base."
        case .certificateNotValid?: "O certificado desta base não é válido agora. Nenhum convite pode ser criado."
        case .offerTTLTooShort?: "A validade de convites desta base é curta demais."
        case .hostClosing?: "A base está desligando. Tente de novo depois."
        case nil: "Convites indisponíveis nesta base agora."
        }
    }

    public static func noticeKey(_ notice: OwnerPairingOfferEditor.Notice) -> String {
        switch notice {
        case .loadFailed: "Não foi possível ler o estado dos convites desta base."
        case .baseOffline: "A base deste Mac não está respondendo agora."
        case .notOwnerLoopback: "Convites só podem ser criados na base deste Mac."
        case .hostChanged: "Outra base respondeu. Nada foi enviado; atualize para continuar."
        case .conflict: "Esta base mudou desde o pedido. Nada foi criado; confira e faça um novo pedido."
        case .invalidSelection: "Escolha o tipo de aparelho e uma validade permitida."
        case .outcomeUnknown: "Não deu para confirmar se o convite foi criado. Use Conferir antes de qualquer outra coisa."
        case .created: "Convite criado. Envie o texto ao outro aparelho por um canal privado."
        case .invitationNotRecoverable(let reason): invitationUnavailableKey(reason)
        case .cancelled: "Convite cancelado. O texto antigo não funciona mais."
        case .cancelUnknown: "Não deu para confirmar o cancelamento. Use Conferir."
        case .offerNotOpen: "Esse convite já foi usado, cancelado ou expirou."
        }
    }

    public static func invitationUnavailableKey(_ reason: OwnerPairingInvitationUnavailableReason?) -> String {
        switch reason {
        case .expired?: "O convite expirou. Crie outro."
        case .claimed?: "O convite já foi usado por um aparelho. Aprove ou recuse o pedido dele."
        case .cancelled?: "O convite foi cancelado."
        case .exhausted?, .deliveryLimit?: "O texto deste convite já foi entregue o máximo de vezes. Cancele-o e crie outro."
        case .notRetained?: "A base reiniciou e não guarda mais o texto deste convite. Cancele-o e crie outro."
        case .outcomeUnknown?: "A base não confirmou este convite. Crie outro."
        case nil: "O convite existe, mas o texto não pode ser mostrado de novo. Cancele-o e crie outro."
        }
    }

    public static func offerStateKey(_ state: OwnerPairingLive.OfferState) -> String {
        switch state {
        case .open: "Aguardando o outro aparelho"
        case .claimed: "Usado por um aparelho · falta aprovar o pedido"
        case .cancelled: "Cancelado"
        case .exhausted: "Não pode mais ser usado"
        case .expired: "Expirado"
        case .unknown: "Estado não confirmado"
        }
    }

    public static func roleKey(_ role: ClientRole) -> String {
        switch role { case .clientIOS: "iPhone"; case .clientMac: "Mac" }
    }

    /// Lifetimes the owner can pick: common values inside the host's range, plus the host's default. Sorted, unique.
    public static func lifetimeOptions(_ ttl: OwnerPairingTTL) -> [Int] {
        Array(Set([300, 600, 900, 1800, 3600].filter { (ttl.minSeconds...ttl.maxSeconds).contains($0) } + [ttl.defaultSeconds])).sorted()
    }
}
#endif
