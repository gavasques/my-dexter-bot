#if os(macOS)
import DexterHostClient
import Foundation
import Observation
import SwiftUI

public struct ChatApprovalModePendingMutation: Equatable, Sendable {
    public let input: PatchThreadApprovalPolicyInput
    public let previous: ThreadApprovalPolicy
    public let hostAddress: String
    public var key: String { "\(hostAddress)\u{1F}\(previous.hostId)\u{1F}\(previous.ownerId)\u{1F}\(previous.threadId)" }
}

@MainActor @Observable public final class ChatApprovalModeEditor {
    public let threadID: String
    public let bot: Bot
    public let session: SettingsEditorSession
    public private(set) var effective: EffectiveApprovalPolicy?
    public private(set) var pending: ChatApprovalModePendingMutation?
    public private(set) var busy = false
    public private(set) var notice: String?
    public private(set) var receiptMissing = false
    @ObservationIgnored private weak var model: DexterAppModel?
    @ObservationIgnored private var generation = UUID()
    public init(bot: Bot, threadID: String, model: DexterAppModel) {
        self.bot = bot; self.threadID = threadID; self.model = model
        session = SettingsEditorSession(target: .bot(bot), model: model)
        pending = model.pendingChatApprovalModeMutations.values.first {
            $0.previous.threadId == threadID && $0.previous.botId == bot.id && $0.previous.ownerId == bot.ownerId &&
            $0.previous.hostId == model.approvalPolicyHostID && $0.hostAddress == model.hostAddress
        }
    }
    public var scopeMatches: Bool {
        guard let model else { return false }
        return session.matches(botID: bot.id, ownerID: bot.ownerId, in: model) && model.selectedThreadID == threadID && model.selectedBotID == bot.id
    }
    public var canEdit: Bool {
        scopeMatches && model?.isOnline == true && model?.canEditBotProfiles == true &&
            effective != nil && pending == nil && !busy
    }
    public func load() async {
        guard scopeMatches, !busy, let model else { return }
        if pending != nil { await reconcile(); return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let value = try await session.perform(in: model) { client in try await client.effectiveApprovalPolicy(threadID: self.threadID) }
            guard scopeMatches, token == generation else { return }
            guard value.bot.botId == bot.id, value.bot.ownerId == bot.ownerId else { throw HostClientError.contractMismatch }
            effective = value; notice = nil
        } catch { if scopeMatches { notice = "load_failed"; effective = nil } }
    }
    /// Only a human menu gesture calls this method. Engine configuration APIs never expose it.
    public func saveHumanChoice(_ mode: BotApprovalPolicyMode?) async {
        guard canEdit, let previous = effective?.thread, let model else { return }
        if previous.overrideMode == mode { return }
        let input = PatchThreadApprovalPolicyInput(expectedHostId: previous.hostId, clientRequestId: UUID().uuidString.lowercased(),
                                                 expectedRevision: previous.revision, overrideMode: mode)
        let request = ChatApprovalModePendingMutation(input: input, previous: previous, hostAddress: session.hostAddress)
        pending = request; model.pendingChatApprovalModeMutations[request.key] = request
        await sendExactRequest()
    }
    public func retryExactRequest() async { guard receiptMissing, pending != nil else { return }; await sendExactRequest() }
    private func sendExactRequest() async {
        guard scopeMatches, !busy, let pending, let model else { return }
        busy = true; notice = nil; receiptMissing = false; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let receipt = try await session.perform(in: model, kind: .mutation) { client in
                try await client.updateThreadApprovalPolicy(botID: self.bot.id, ownerID: self.bot.ownerId, threadID: self.threadID, input: pending.input)
            }
            guard scopeMatches, token == generation else { return }
            try accept(receipt, request: pending, model: model)
        } catch {
            guard scopeMatches, token == generation else { return }
            if [.conflict, .forbidden, .invalidRequest, .notFound].contains(error as? HostClientError ?? .hostFailure) {
                model.pendingChatApprovalModeMutations.removeValue(forKey: pending.key); self.pending = nil; effective = nil; notice = "reload_required"
            } else { notice = "unknown" }
        }
        busy = false
        if self.pending == nil { await load() }
    }
    private func accept(_ receipt: ApprovalPreferenceReceipt, request: ChatApprovalModePendingMutation, model: DexterAppModel) throws {
        guard receipt.matches(botID: bot.id, ownerID: bot.ownerId, kind: "chat_mode", targetID: threadID, input: request.input),
              let bytes = try? JSONEncoder().encode(receipt.previous),
              (try? JSONDecoder().decode(ThreadApprovalPolicy.self, from: bytes)) == request.previous else { throw HostClientError.contractMismatch }
        model.pendingChatApprovalModeMutations.removeValue(forKey: request.key); pending = nil; notice = "saved"; receiptMissing = false
    }
    /// Reconciliation is GET-only. A missing receipt permits one explicit retry with the same original input.
    public func reconcile() async {
        guard scopeMatches, !busy, let pending, let model else { return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let receipt = try await session.perform(in: model) { client in
                try await client.approvalPreferenceReceipt(botID: self.bot.id, ownerID: self.bot.ownerId, kind: "chat_mode", targetID: self.threadID,
                                                          clientRequestID: pending.input.clientRequestId, input: pending.input)
            }
            guard scopeMatches, token == generation else { return }; try accept(receipt, request: pending, model: model)
        } catch {
            guard scopeMatches, token == generation else { return }
            receiptMissing = error as? HostClientError == .notFound; notice = receiptMissing ? "receipt_missing" : "unknown"
        }
        busy = false
        if self.pending == nil { await load() }
    }
}

/// Composer integration owned by Sol. The layout agent only places this component near the text field.
public struct ChatApprovalModeControl: View {
    @Environment(\.locale) private var locale
    @State private var editor: ChatApprovalModeEditor
    @State private var showsDetails = false
    public init(bot: Bot, threadID: String, model: DexterAppModel) {
        _editor = State(initialValue: ChatApprovalModeEditor(bot: bot, threadID: threadID, model: model))
    }
    private func copy(_ p: String, _ e: String) -> String { locale.language.languageCode?.identifier == "pt" ? p : e }
    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                ApprovalModeMenu(mode: editor.effective?.mode ?? .ask, busy: editor.busy, enabled: editor.canEdit,
                    usesBotDefault: editor.effective?.source == "bot_default") { mode in Task { await editor.saveHumanChoice(mode) } }
                Text(editor.effective == nil ? copy("Modo não confirmado", "Mode unconfirmed") :
                        editor.effective?.source == "bot_default" ? copy("Padrão do bot", "Bot default") : copy("Só esta conversa", "This chat only"))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat.approval-mode.scope")
            }
            if let mode = editor.effective?.mode {
                Text(verbatim: mode.summary(locale: locale)).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("chat.approval-mode.summary")
            }
            if let notice = editor.notice {
                Text(notice == "saved" ? copy("Modo salvo.", "Mode saved.") : notice == "unknown" ? copy("Ainda não confirmou. Confira o resultado antes de tentar de novo.", "Unconfirmed. Check the result before trying again.") : copy("Releia o modo antes de alterar.", "Reload the mode before changing it."))
                    .font(.caption).accessibilityIdentifier("chat.approval-mode.notice")
                HStack {
                    Button(copy("Conferir resultado", "Check result")) { Task { await editor.load() } }
                        .disabled(editor.busy).accessibilityIdentifier("chat.approval-mode.refresh")
                    if editor.receiptMissing {
                        Button(copy("Repetir o mesmo pedido", "Retry the same request")) { Task { await editor.retryExactRequest() } }
                            .disabled(editor.busy).accessibilityIdentifier("chat.approval-mode.retry-exact")
                    }
                }
            }
            DisclosureGroup(isExpanded: $showsDetails) {
                Text(verbatim: BotApprovalPolicyMode.boundary(locale: locale)).font(.caption).fixedSize(horizontal: false, vertical: true)
                Text(copy("Não amplia acessos. Pedidos pendentes continuam pendentes. Regras de tipos salvas valem até serem revogadas.",
                          "Does not expand access. Pending requests remain pending. Saved type rules apply until revoked.")).font(.caption)
                if let state = editor.effective { Text(verbatim: "bot: \(state.bot.mode.rawValue) r\(state.bot.revision) · chat: r\(state.thread.revision) · \(state.source)").font(.caption.monospaced()).textSelection(.enabled) }
            } label: { Text(copy("Ferramentas do Dexter · detalhes", "Dexter tools · details")).font(.caption).foregroundStyle(.secondary) }
            .accessibilityIdentifier("chat.approval-mode.details")
        }.task { await editor.load() }
    }
}
#endif
