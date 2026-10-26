#if os(macOS)
import DexterHostClient
import SwiftUI

public struct SavedApprovalTypeRevocation: Equatable, Sendable {
    public let key: String
    public let botID: String
    public let ownerID: String
    public let hostAddress: String
    public let input: RevokeApprovalTypeInput
}

public struct SavedApprovalTypesControl: View {
    @Environment(\.locale) private var locale
    @State private var types: [ApprovalTypePreference] = []
    @State private var busy = false
    @State private var notice: String?
    @State private var showsDetails = false
    @State private var pending: SavedApprovalTypeRevocation?
    public let bot: Bot
    public let model: DexterAppModel
    public let session: SettingsEditorSession
    public init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession) { self.bot = bot; self.model = model; self.session = session }
    private func copy(_ p: String, _ e: String) -> String { locale.language.languageCode?.identifier == "pt" ? p : e }
    public var body: some View {
        DisclosureGroup(isExpanded: $showsDetails) {
            VStack(alignment: .leading, spacing: 8) {
                if types.filter(\.enabled).isEmpty { Text(copy("Nenhum tipo salvo.", "No saved types.")).font(.caption) }
                ForEach(types.filter(\.enabled)) { type in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(title(type)).font(.caption.weight(.semibold))
                            Spacer()
                            Button(copy("Voltar a perguntar", "Ask again")) { Task { await revoke(type) } }
                                .disabled(busy || pending != nil || !session.isCurrent(in: model))
                                .accessibilityIdentifier("bot-profile.approval-types.revoke.\(type.key)")
                        }
                        Text(verbatim: type.destination).font(.caption).textSelection(.enabled)
                        DisclosureGroup(copy("Detalhes do tipo", "Type details")) {
                            Text(verbatim: "\(type.tool)\n\(type.key)\nrevision \(type.revision) · access \(type.grantRevision) · epoch \(type.authorityEpoch)\npins \(type.pinsHash)\nreceipt \(type.receiptId)")
                                .font(.caption.monospaced()).textSelection(.enabled)
                        }.accessibilityIdentifier("bot-profile.approval-types.details.\(type.key)")
                    }
                }
                if let notice {
                    Text(notice == "saved" ? copy("Regra revogada. Novos pedidos voltam a seguir o modo efetivo.", "Rule revoked. New requests follow the effective mode again.")
                         : copy("Resultado não confirmado. Confira o recibo antes de tentar novamente.", "Result unconfirmed. Check the receipt before trying again."))
                        .font(.caption).accessibilityIdentifier("bot-profile.approval-types.notice")
                }
                Button(copy("Conferir regras e resultado", "Check rules and result")) { Task { await load() } }
                    .disabled(busy).accessibilityIdentifier("bot-profile.approval-types.refresh")
                if notice == "receipt_missing", pending != nil {
                    Button(copy("Repetir o mesmo pedido", "Retry the same request")) { Task { await send() } }
                        .disabled(busy).accessibilityIdentifier("bot-profile.approval-types.retry-exact")
                }
                Text(copy("Uma regra nunca amplia acessos. Trocar ferramenta, conta, destino, revisão ou limites pede nova aprovação. Parar não desfaz efeitos anteriores.",
                          "A rule never expands access. A different tool, account, destination, revision or limits asks again. Stopping does not undo previous effects."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        } label: { Text(copy("Tipos que você sempre aceita", "Types you always accept")) }
        .accessibilityIdentifier("bot-profile.approval-types")
        .task { await load() }
    }
    private func title(_ type: ApprovalTypePreference) -> String {
        switch type.tool {
        case "dexter.harness.terminal.run": copy("Comandos nesta pasta", "Commands in this folder")
        case "dexter.harness.cli.run": copy("Ferramenta de comando nesta pasta", "Command tool in this folder")
        case "dexter.harness.files.write": copy("Salvar este arquivo", "Save this file")
        case "dexter.automations.run": copy("Iniciar esta rotina", "Start this routine")
        default: copy("Usar esta ferramenta nesta conexão", "Use this tool on this connection")
        }
    }
    private func key(_ pending: SavedApprovalTypeRevocation) -> String { "\(pending.hostAddress)\u{1F}\(pending.input.expectedHostId)\u{1F}\(pending.ownerID)\u{1F}\(pending.botID)\u{1F}\(pending.key)" }
    private func load() async {
        guard !busy, session.isCurrent(in: model) else { return }; busy = true; defer { busy = false }
        if pending == nil { pending = model.pendingApprovalTypeRevocations.values.first { $0.botID == bot.id && $0.ownerID == bot.ownerId && $0.hostAddress == session.hostAddress && $0.input.expectedHostId == session.effectiveHostID } }
        do {
            if let pending {
                _ = try await session.perform(in: model) { client in
                    try await client.approvalPreferenceReceipt(botID: bot.id, ownerID: bot.ownerId, kind: "type_revoke", targetID: pending.key,
                                                              clientRequestID: pending.input.clientRequestId, input: pending.input)
                }
                model.pendingApprovalTypeRevocations.removeValue(forKey: key(pending)); self.pending = nil; notice = "saved"
            }
            types = try await session.perform(in: model) { client in try await client.approvalTypes(botID: bot.id) }
        } catch { notice = error as? HostClientError == .notFound && pending != nil ? "receipt_missing" : "unknown" }
    }
    private func revoke(_ type: ApprovalTypePreference) async {
        guard !busy, pending == nil, session.isCurrent(in: model), type.hostId == session.effectiveHostID else { return }
        let request = SavedApprovalTypeRevocation(key: type.key, botID: bot.id, ownerID: bot.ownerId, hostAddress: session.hostAddress,
            input: RevokeApprovalTypeInput(expectedHostId: type.hostId, clientRequestId: UUID().uuidString.lowercased(), expectedRevision: type.revision))
        pending = request; model.pendingApprovalTypeRevocations[key(request)] = request; await send()
    }
    private func send() async {
        guard !busy, let pending, session.isCurrent(in: model) else { return }; busy = true
        do {
            _ = try await session.perform(in: model, kind: .mutation) { client in
                try await client.revokeApprovalType(botID: bot.id, ownerID: bot.ownerId, key: pending.key, input: pending.input)
            }
            model.pendingApprovalTypeRevocations.removeValue(forKey: key(pending)); self.pending = nil; notice = "saved"
        } catch {
            if [.conflict, .forbidden, .invalidRequest].contains(error as? HostClientError ?? .hostFailure) {
                model.pendingApprovalTypeRevocations.removeValue(forKey: key(pending)); self.pending = nil
            }
            notice = "unknown"
        }
        busy = false; if self.pending == nil { await load() }
    }
}
#endif
