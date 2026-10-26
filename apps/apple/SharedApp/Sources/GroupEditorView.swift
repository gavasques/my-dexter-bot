import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// Creates or edits a group: a name and its bots. A group has no coordinator; each bot answers as itself.
/// Membership grants no tools, documents, memory or 1:1 history. Nothing is saved until "Criar grupo"/"Salvar".
@MainActor struct GroupEditorView: View {
    let coordinator: GroupConversationCoordinator
    let model: DexterAppModel
    /// nil creates a new group.
    let group: BotGroup?
    let onClose: (BotGroup?) -> Void
    @State private var name: String
    @State private var selected: [String]
    @State private var withHistory: Set<String>
    @State private var saving = false
    @State private var confirmingArchive = false

    init(coordinator: GroupConversationCoordinator, model: DexterAppModel, group: BotGroup?, onClose: @escaping (BotGroup?) -> Void) {
        self.coordinator = coordinator; self.model = model; self.group = group; self.onClose = onClose
        let active = group?.members.filter(\.active) ?? []
        _name = State(initialValue: group?.name ?? "")
        _selected = State(initialValue: active.map(\.botId))
        _withHistory = State(initialValue: Set(active.filter { $0.history == .all }.map(\.botId)))
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Bots already in the group keep their recorded join point; the history choice only applies to bots added now.
    private func isNew(_ botID: String) -> Bool { group?.members.contains { $0.botId == botID && $0.active } != true }
    private var changed: Bool {
        guard let group else { return true }
        return trimmedName != group.name || Set(selected) != Set(group.activeBotIDs)
    }
    private var canSave: Bool {
        !saving && coordinator.canEdit && !trimmedName.isEmpty && trimmedName.count <= 120
            && !selected.isEmpty && selected.count <= BotGroup.maximumMembers && changed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Form {
                Section {
                    TextField("Nome do grupo", text: $name)
                        .accessibilityIdentifier("group-editor.name")
                } footer: {
                    Text("Um grupo é uma conversa entre você e vários bots. Não há coordenador: cada bot responde por si.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    ForEach(model.bots) { bot in memberRow(bot) }
                    if model.bots.isEmpty {
                        Text("Nenhum bot neste host.").foregroundStyle(.secondary)
                    }
                } header: {
                    Text(verbatim: String(localized: "Bots do grupo (\(selected.count)/\(BotGroup.maximumMembers))"))
                } footer: {
                    Text("Entrar no grupo não dá ferramentas, documentos, memória nem acesso às conversas 1:1 de nenhum bot. Cada ferramenta continua pedindo a aprovação daquele bot.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            .formStyle(.grouped)
            if !coordinator.scopeMatches {
                Text("Criar e editar grupos exige conexão de proprietário a esta base.")
                    .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 20)
                    .accessibilityIdentifier("group-editor.unavailable")
            }
            if let error = coordinator.error {
                Text(error).font(.footnote).foregroundStyle(.orange).padding(.horizontal, 20)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("group-editor.error")
            }
            Divider()
            HStack {
                Button("Cancelar") { onClose(nil) }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("group-editor.cancel")
                if group != nil {
                    Button("Arquivar grupo…", role: .destructive) { confirmingArchive = true }
                        .disabled(saving || !coordinator.canEdit)
                        .accessibilityIdentifier("group-editor.archive")
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button(group == nil ? "Criar grupo" : "Salvar") { save() }
                    .buttonStyle(.borderedProminent).disabled(!canSave).keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("group-editor.save")
            }.padding(16)
        }
        .frame(minWidth: 460, minHeight: 520)
        .accessibilityIdentifier("group-editor")
        .confirmationDialog("Arquivar este grupo?", isPresented: $confirmingArchive, titleVisibility: .visible) {
            Button("Arquivar", role: .destructive) { archive() }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("A conversa continua disponível para leitura, mas ninguém poderá enviar novas mensagens neste grupo. As conversas 1:1 dos bots não mudam.")
        }
    }

    @ViewBuilder private func memberRow(_ bot: Bot) -> some View {
        let isMember = selected.contains(bot.id)
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(get: { isMember }, set: { on in
                if on { if !selected.contains(bot.id), selected.count < BotGroup.maximumMembers { selected.append(bot.id) } }
                else { selected.removeAll { $0 == bot.id }; withHistory.remove(bot.id) }
            })) {
                HStack(spacing: 8) {
                    DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                                     fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 24, appearance: bot.avatarAppearance, mascotSeed: bot.id)
                    Text(bot.name)
                }
            }
            .disabled(!isMember && selected.count >= BotGroup.maximumMembers)
            .accessibilityIdentifier("group-editor.member.\(bot.id)")
            if isMember, isNew(bot.id) {
                Toggle("Pode ler as mensagens anteriores do grupo", isOn: Binding(
                    get: { withHistory.contains(bot.id) },
                    set: { if $0 { withHistory.insert(bot.id) } else { withHistory.remove(bot.id) } }))
                    .font(.caption).padding(.leading, 32)
                    .accessibilityIdentifier("group-editor.history.\(bot.id)")
            }
        }
    }

    private func archive() {
        guard let group, !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            if await coordinator.archive(group) { onClose(group) }
        }
    }

    private func save() {
        guard canSave else { return }
        saving = true
        let ids = selected
        let kept = Set(group?.members.filter { $0.active && $0.history == .all }.map(\.botId) ?? [])
        let history = ids.filter { kept.contains($0) || (isNew($0) && withHistory.contains($0)) }
        Task {
            defer { saving = false }
            if let group {
                if await coordinator.update(group, name: trimmedName, botIDs: ids, historyBotIDs: history) { onClose(group) }
            } else if let created = await coordinator.create(name: trimmedName, botIDs: ids, historyBotIDs: history) {
                onClose(created)
            }
        }
    }
}
#endif
