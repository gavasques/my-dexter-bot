#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI
import AppKit

/// Read-only projection of the selected bot and already loaded conversation state.
/// This panel does not discover engines, read memory, fetch integrations or poll endpoints, and it never approves or
/// runs anything: "Ver no chat" only shows the pending card where the owner decides (UX-P1-14).
@MainActor struct MacBotInspectorView: View {
    let bot: Bot
    let model: DexterAppModel
    let onClose: () -> Void
    let openProfile: () -> Void
    let openMemory: () -> Void
    let openDelegations: () -> Void
    /// This bot's connections (Ajustes do bot › Conexões).
    let openIntegrations: () -> Void
    /// Shows a pending card in this window's chat; navigation only.
    var showInChat: (Action) -> Void = { _ in }
    @Environment(\.locale) private var locale

    private func text(_ pt: String, _ en: String) -> String {
        locale.language.languageCode?.identifier == "pt" ? pt : en
    }
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private var presentedThreadID: String? {
        guard model.selectedBotID == bot.id, let id = model.presentedThreadID,
              model.threads(for: bot.id).contains(where: { $0.id == id }) else { return nil }
        return id
    }
    private var threadSelection: EngineSelection? {
        guard let id = presentedThreadID, model.engineSelectionThreadID == id else { return nil }
        return model.threadEngineSelection?.selection
    }
    private var loadedActions: [Action] {
        guard let id = presentedThreadID else { return [] }
        return model.actions(for: id).filter { $0.request.botId == bot.id }
    }
    private var botDefault: EngineSelection { bot.defaultSelection ?? EngineSelection(engine: bot.engine.rawValue) }
    private func displayName(_ selection: EngineSelection) -> String {
        EngineSelectionDisplay.name(selection, catalog: model.engineCatalog, portuguese: portuguese)
    }

    var body: some View {
        ScrollView {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = Int64(context.date.timeIntervalSince1970 * 1_000)
                VStack(alignment: .leading, spacing: 22) {
                    identity
                    modelSection
                    pendingSection(now: now)
                    shortcuts
                    activitySection(now: now)
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-inspector.panel")
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                                 fallbackSystemImage: EngineSymbol.systemName(bot.engine.rawValue), model: model, size: 40, appearance: bot.avatarAppearance, mascotSeed: bot.id)
                Spacer()
                Button(text("Editar", "Edit"), action: openProfile)
                    .buttonStyle(DexterCapsuleButtonStyle(height: 28))
                    .disabled(!model.canEditBotProfiles)
                    // The accessible name keeps the visible word "Editar" (WCAG 2.5.3 label in name).
                    .accessibilityLabel(text("Editar bot", "Edit bot"))
                    .accessibilityIdentifier("bot-inspector.edit")
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .semibold))
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel(text("Fechar detalhes do bot", "Close bot details"))
                    .accessibilityIdentifier("bot-inspector.close")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: bot.name).font(.system(size: 17, weight: .semibold)).lineLimit(2)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("bot-inspector.name")
                Text(verbatim: bot.isMaster ? text("Bot Master · conversa privada", "Master bot · private conversation") : text("Bot · conversa privada", "Bot · private conversation"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Text(verbatim: bot.roleDescription.isEmpty ? text("Função não definida.", "No role defined.") : bot.roleDescription)
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).lineLimit(6)
                .accessibilityIdentifier("bot-inspector.role")
        }
    }

    /// UX-P1-14: the model that answers here in one line; the bot default only as a second line when it differs.
    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let selection = threadSelection {
                sectionTitle(text("Nesta conversa", "In this conversation"))
                Label(displayName(selection), systemImage: EngineSymbol.systemName(selection.engine))
                    .font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-inspector.thread-model")
                if !EngineSelectionDisplay.sameModel(selection, botDefault) {
                    Text(verbatim: text("Padrão do bot: ", "Bot default: ") + displayName(botDefault))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("bot-inspector.default-model")
                }
                let tuning = [selection.reasoningEffort.map { text("Esforço: ", "Effort: ") + EngineChoiceLabel.effort($0, portuguese: portuguese) },
                              selection.speed.map { text("Velocidade: ", "Speed: ") + EngineChoiceLabel.speed($0, portuguese: portuguese) }]
                    .compactMap { $0 }
                if !tuning.isEmpty {
                    Text(verbatim: tuning.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                sectionTitle(text("Modelo do bot", "Bot model"))
                Label(displayName(botDefault), systemImage: EngineSymbol.systemName(botDefault.engine))
                    .font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-inspector.default-model")
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Pending decisions of this conversation, each with "Ver no chat"; the decision itself stays on the card.
    @ViewBuilder private func pendingSection(now: Int64) -> some View {
        let pending = loadedActions.filter { ApprovalPresentation(action: $0).needsDecision(atMilliseconds: now) }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
        if !pending.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle(text("Precisa de você", "Needs you"))
                ForEach(pending) { action in
                    let presentation = ApprovalPresentation(action: action)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: DexterLocalization.text(presentation.title, locale: locale)).font(.callout.weight(.medium)).lineLimit(2)
                            if let target = presentation.shortTarget {
                                Text(verbatim: target).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 4)
                        Button(text("Ver no chat", "Show in chat")) { showInChat(action) }
                            .buttonStyle(.borderless).font(.caption)
                            .accessibilityIdentifier("bot-inspector.pending.show.\(action.id)")
                    }
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(DexterSurface.attention.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("bot-inspector.pending.\(action.id)")
                }
            }
        }
    }

    private var shortcuts: some View {
        VStack(alignment: .leading, spacing: 3) {
            sectionTitle(text("Gerenciar", "Manage")).padding(.bottom, 4)
            shortcut(text("Ajustes do bot", "Bot settings"), icon: "gearshape", id: "profile", enabled: model.canEditBotProfiles, action: openProfile)
            shortcut(text("Memória e instruções", "Memory and instructions"), icon: "brain", id: "memory", enabled: model.canEditBotProfiles, action: openMemory)
            shortcut(text("Chamadas entre bots", "Bot calls"), icon: "arrow.triangle.branch", id: "delegations", enabled: model.canEditBotProfiles, action: openDelegations)
            shortcut(text("Conexões deste bot", "This bot’s connections"), icon: "link", id: "integrations", enabled: model.canEditBotProfiles, action: openIntegrations)
        }
    }

    /// Recent outcomes, grouped like the chat history (UX-P2-20), each with its reason and when.
    private func activitySection(now: Int64) -> some View {
        let executing = loadedActions.filter { [.ready, .running].contains($0.state) }
        let groups = ApprovalHistoryGrouping.groups(loadedActions, atMilliseconds: now)
        return VStack(alignment: .leading, spacing: 10) {
            sectionTitle(text("Atividade recente", "Recent activity"))
            if presentedThreadID == nil {
                Text(text("Abra uma conversa para ver suas ações.", "Open a conversation to see its actions."))
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if executing.isEmpty && groups.isEmpty {
                Text(text("Nenhuma ação concluída nesta conversa.", "No finished actions in this conversation."))
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(executing) { action in
                    let presentation = ApprovalPresentation(action: action)
                    activityRow(title: DexterLocalization.text(presentation.title, locale: locale), state: presentation.stateLabel(atMilliseconds: now),
                                detail: presentation.resultExplanation(atMilliseconds: now), id: action.id)
                }
                ForEach(groups.prefix(3)) { group in
                    let title = DexterLocalization.text(group.title, locale: locale)
                    activityRow(title: group.count > 1 ? DexterLocalization.format("%@×", String(group.count), locale: locale) + " " + title : title,
                                state: group.stateLabel,
                                detail: ApprovalTimeLabel.text(group.newestUpdatedAt, locale: locale) + " · " + group.explanation, id: group.id)
                }
                Text(text("Aprovações e resultados completos ficam no chat.", "Full approvals and results remain in chat."))
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func activityRow(title: String, state: String, detail: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: title).font(.callout.weight(.medium)).lineLimit(2)
                Spacer(minLength: 4)
                Text(LocalizedStringKey(state)).font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(DexterSurface.insetFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("bot-inspector.action.\(id)")
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }
    private func shortcut(_ title: String, icon: String, id: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 13)).foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .background(DexterSurface.chipFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(title).font(.system(size: 13))
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary)
            }.frame(minHeight: 38).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .accessibilityIdentifier("bot-inspector.\(id)")
    }
}
#endif
