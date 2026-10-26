import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// The composer's approval control, reduced to one menu plus a details button. It uses the same editor, the same
/// four modes and the same stable IDs as before (`chat.approval-mode.*`); only the explanations moved into the
/// details popover. A save that is unconfirmed or needs reloading still shows inline, because it needs action.
struct ComposerApprovalControl: View {
    @Environment(\.locale) private var locale
    @State private var editor: ChatApprovalModeEditor
    let model: DexterAppModel
    let threadID: String
    @State private var showsDetails = false

    init(bot: Bot, threadID: String, model: DexterAppModel) {
        self.model = model; self.threadID = threadID
        _editor = State(initialValue: ChatApprovalModeEditor(bot: bot, threadID: threadID, model: model))
    }
    private func copy(_ p: String, _ e: String) -> String { locale.language.languageCode?.identifier == "pt" ? p : e }

    var body: some View {
        HStack(spacing: 6) {
            ApprovalModeMenu(mode: editor.effective?.mode ?? .ask, busy: editor.busy, enabled: editor.canEdit,
                usesBotDefault: editor.effective?.source == "bot_default") { mode in Task { await editor.saveHumanChoice(mode) } }
                .fixedSize()
            if let notice = editor.notice, notice != "saved" {
                Button {
                    Task { if editor.receiptMissing { await editor.retryExactRequest() } else { await editor.load() } }
                } label: {
                    Label(notice == "unknown" ? copy("Não confirmado · Conferir", "Unconfirmed · Check")
                          : editor.receiptMissing ? copy("Repetir o mesmo pedido", "Retry the same request")
                          : copy("Reler o modo", "Reload the mode"), systemImage: "exclamationmark.triangle")
                        .font(.caption)
                }
                .buttonStyle(.borderless).foregroundStyle(.orange).disabled(editor.busy)
                .help(notice == "unknown" ? copy("A mudança não foi confirmada. Conferir só lê o resultado; não reenvia.", "The change was not confirmed. Check only reads the result; it does not resend.")
                      : copy("Releia o modo antes de alterar.", "Reload the mode before changing it."))
                .accessibilityIdentifier(editor.receiptMissing ? "chat.approval-mode.retry-exact" : "chat.approval-mode.refresh")
            }
            Button { showsDetails.toggle() } label: {
                Image(systemName: "info.circle").font(.system(size: 13)).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.borderless).foregroundStyle(.secondary)
            .accessibilityLabel(copy("Detalhes do modelo e do modo de aprovação", "Model and approval mode details"))
            .accessibilityIdentifier("chat.composer.details")
            .popover(isPresented: $showsDetails, arrowEdge: .top) { details }
        }
        .task { await editor.load() }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(copy("Nesta conversa", "In this conversation")).font(.headline)
            if let state = model.threadEngineSelection, model.engineSelectionThreadID == threadID {
                VStack(alignment: .leading, spacing: 4) {
                    Text(copy("Modelo", "Model")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(state.override == nil ? copy("Usa o padrão do bot.", "Uses the bot default.") : copy("Escolhido só para esta conversa.", "Chosen for this conversation only."))
                        .font(.callout)
                    if state.override != nil {
                        Button(copy("Voltar ao modelo padrão do bot", "Use the bot’s default model")) {
                            Task { await model.changeThreadEngineSelection(threadID: threadID, selection: nil) }
                        }
                        .disabled(!model.canChangeThreadEngine)
                        .accessibilityIdentifier("chat.engine.use-bot-default")
                    }
                    if state.handoffStatus == "ready" {
                        Text(copy("Contexto recente pronto para \(EngineChoiceLabel.engine(state.selection.engine)). Será usado na próxima mensagem.",
                                  "Recent context ready for \(EngineChoiceLabel.engine(state.selection.engine)). It will be used with the next message."))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 4) {
                Text(copy("Modo de aprovação", "Approval mode")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if let mode = editor.effective?.mode {
                    Text(verbatim: mode.title(locale: locale) + " — " + (editor.effective?.source == "bot_default" ? copy("padrão do bot", "bot default") : copy("só esta conversa", "this conversation only")))
                        .font(.callout).accessibilityIdentifier("chat.approval-mode.scope")
                    Text(verbatim: mode.summary(locale: locale)).font(.caption).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("chat.approval-mode.summary")
                } else {
                    Text(copy("Modo não confirmado.", "Mode unconfirmed.")).font(.callout).accessibilityIdentifier("chat.approval-mode.scope")
                }
                if editor.notice == "saved" {
                    Text(copy("Modo salvo.", "Mode saved.")).font(.caption).accessibilityIdentifier("chat.approval-mode.notice")
                }
            }
            DisclosureGroup(copy("Ferramentas do Dexter · detalhes", "Dexter tools · details")) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: BotApprovalPolicyMode.boundary(locale: locale)).font(.caption).fixedSize(horizontal: false, vertical: true)
                    Text(copy("Não amplia acessos. Pedidos pendentes continuam pendentes. Regras de tipos salvas valem até serem revogadas.",
                              "Does not expand access. Pending requests remain pending. Saved type rules apply until revoked."))
                        .font(.caption).fixedSize(horizontal: false, vertical: true)
                    if let state = editor.effective {
                        Text(verbatim: "bot: \(state.bot.mode.rawValue) r\(state.bot.revision) · chat: r\(state.thread.revision) · \(state.source)")
                            .font(.caption.monospaced()).textSelection(.enabled)
                    }
                }.padding(.top, 4)
            }
            .font(.caption)
            .accessibilityIdentifier("chat.approval-mode.details")
        }
        .padding(16).frame(width: 340)
    }
}
#endif
