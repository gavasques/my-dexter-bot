#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// UX-P1-17: the six pages of the bot settings window. Navigation only: each `BotSettingsSection` keeps its raw value
/// (`bot-profile.tab.<raw>`, deep links, saved routes), its own drafts, session and save. Opening a page or a
/// subsection never saves, sends or discards anything.
enum BotSettingsPage: String, CaseIterable, Hashable, Sendable {
    case profile, modelVoice = "model-voice", memory, connections, permissions, activity

    /// Exhaustive on purpose: a new section does not compile until it has a page.
    init(section: BotSettingsSection) {
        switch section {
        case .profile: self = .profile
        case .model: self = .modelVoice
        case .memory, .skills: self = .memory
        case .mcp, .browser: self = .connections
        case .access, .communication: self = .permissions
        case .routines, .history: self = .activity
        }
    }

    /// The page's sections in routing order.
    var sections: [BotSettingsSection] { BotSettingsSection.allCases.filter { Self(section: $0) == self } }
    /// What the page's subsection bar offers, in order. "Este Mac" is not a section: it forwards and saves nothing itself.
    var panes: [BotSettingsPane] { sections.map(BotSettingsPane.section) + (self == .connections ? [.thisMac] : []) }
}

/// What the content area shows: one section, or "Este Mac" inside Conexões.
enum BotSettingsPane: Hashable, Sendable {
    case section(BotSettingsSection)
    case thisMac

    var page: BotSettingsPage {
        switch self {
        case .section(let section): BotSettingsPage(section: section)
        case .thisMac: .connections
        }
    }
    /// Stable accessibility ID of the subsection button: the old `bot-profile.tab.<raw>` for sections.
    var accessibilityID: String {
        switch self {
        case .section(let section): "bot-profile.tab.\(section.rawValue)"
        case .thisMac: "bot-profile.tab.this-mac"
        }
    }
}

/// How a pane keeps changes, said in the header so every page saves the same predictable way.
enum BotSettingsSaveModel: Equatable, Sendable {
    /// Edits stay as drafts until Salvar alterações; switching pages keeps them.
    case draft
    /// Each change asks for confirmation and applies when the host confirms; no draft is left behind.
    case confirmedEachChange
    /// Drafts, plus requests that wait for your approval of the exact change.
    case draftAndApproval
    case readOnly

    init(pane: BotSettingsPane) {
        switch pane {
        case .section(.profile), .section(.model), .section(.communication), .section(.browser): self = .draft
        case .section(.memory), .section(.mcp): self = .draftAndApproval
        case .section(.skills), .section(.access), .section(.routines), .thisMac: self = .confirmedEachChange
        case .section(.history): self = .readOnly
        }
    }
}

/// One titled group of the bot settings pages: the title sits outside, the rows share one rounded card with dividers
/// between them, an optional note sits below. Adaptive system colors only (no forced dark fill, no glass), so light,
/// dark, Increase Contrast and Reduce Transparency keep the platform look.
struct BotSettingsGroup<Content: View>: View {
    let title: String
    var note: String? = nil
    var id: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 0, content: content)
                .padding(.horizontal, 16).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.secondary.opacity(0.14)))
            if let note {
                Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
        .accessibilityElement(children: .contain)
        .modifier(OptionalAccessibilityID(id: id))
    }
}

/// A row inside `BotSettingsGroup`: what it is (and why) on the left, its state or control on the right.
struct BotSettingsRow<Trailing: View>: View {
    let title: String
    var detail: String? = nil
    var systemImage: String? = nil
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage).font(.title3).foregroundStyle(.secondary).frame(width: 26).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            trailing()
        }
        .padding(.vertical, 10)
    }
}

private struct OptionalAccessibilityID: ViewModifier {
    let id: String?
    func body(content: Content) -> some View {
        if let id { content.accessibilityIdentifier(id) } else { content }
    }
}

/// The bot settings window: one bot at a time, chosen by the router. The window never changes the selected bot or
/// conversation; opening a conversation goes back to the main window only after the owner decides about drafts.
@MainActor struct BotSettingsWindowRoot: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(DexterWindowRouter.self) private var router
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.locale) private var locale
    /// Taken once, when a target on the current base is adopted, with the bot snapshot of that moment. The editor's
    /// lifetime is this session, never `model.bots`: a host change cannot unmount, remount or re-bind it.
    @State private var session: SettingsEditorSession?

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private func onCurrentBase(_ target: BotSettingsTarget) -> Bool {
        target.matches(hostScope: model.nativeComposerScope, hostAddress: model.hostAddress)
    }

    var body: some View {
        Group {
            if let session, let bot = session.bot, session.id == router.botTarget?.id, let target = router.botTarget {
                let name = title(session, bot)
                BotProfileView(bot: bot, model: model, session: session,
                    initialSection: target.section,
                    request: router.botRequest,
                    onOpenThread: { threadID in
                        router.requestThread(botID: bot.id, threadID: threadID, hostScope: session.hostScope, hostAddress: session.hostAddress)
                    },
                    onAcceptSwitch: { token in router.acceptBotSwitch(token) },
                    onRequestHandled: { token in router.finishBotRequest(token) },
                    onClose: {
                        session.close()
                        router.closeBotSettings(session.id)
                        dismissWindow(id: DexterMacWindowID.botSettings)
                    })
                    .id(session.id)
                    .navigationTitle(text("Ajustes de \(name)", "\(name) settings"))
            } else if let target = router.botTarget, !onCurrentBase(target) {
                // Asked on another base (or before the connection changed): nothing is mounted or re-bound here.
                VStack(spacing: 14) {
                    ContentUnavailableView(text("Estes ajustes eram de outra base", "These settings belonged to another host"), systemImage: "arrow.triangle.2.circlepath",
                        description: Text(text("A conexão com a base mudou depois do pedido. Nada foi aberto nem aplicado aqui. Feche e abra os ajustes do bot de novo pela janela principal.", "The host connection changed after the request. Nothing was opened or applied here. Close and open the bot settings again from the main window.")))
                    Button(text("Fechar", "Close")) {
                        router.closeBotSettings(target.id)
                        dismissWindow(id: DexterMacWindowID.botSettings)
                    }.keyboardShortcut(.defaultAction).accessibilityIdentifier("bot-settings-window.stale-close")
                }
                .frame(minWidth: 480, minHeight: 320)
                .navigationTitle(text("Ajustes do bot", "Bot settings"))
                .accessibilityIdentifier("bot-settings-window.stale")
            } else {
                ContentUnavailableView(text("Nenhum bot escolhido", "No bot selected"), systemImage: "gearshape",
                    description: Text(text("Abra os ajustes com o botão direito num bot ou pelo painel Detalhes do bot.", "Open settings by right-clicking a bot or from the Bot details panel.")))
                    .frame(minWidth: 480, minHeight: 320)
                    .navigationTitle(text("Ajustes do bot", "Bot settings"))
                    .accessibilityIdentifier("bot-settings-window.empty")
            }
        }
        .errorAlert(model: model, isActive: Binding(get: { router.errorPresenter == .botSettings }, set: { _ in }))
        .modifier(DexterWindowRoleTracker(role: .botSettings))
        .onAppear { router.botWindowAppeared(); adoptTarget(); answerWithoutEditor() }
        .onDisappear { session?.close(); session = nil; router.botWindowDisappeared() }
        .onChange(of: router.botRequest?.token) { _, _ in answerWithoutEditor() }
        .onChange(of: router.botTarget?.id) { _, _ in adoptTarget(); answerWithoutEditor() }
        // Only a target still waiting for its first snapshot (bots not loaded yet) is adopted here; a mounted
        // session is never replaced by a list change, a host change or the same ID on another base.
        .onChange(of: model.bots.map(\.id)) { _, _ in if session == nil { adoptTarget(); answerWithoutEditor() } }
    }

    /// The current name while the session is valid (a saved rename shows); the snapshot's name once it retired.
    private func title(_ session: SettingsEditorSession, _ bot: Bot) -> String {
        (session.isCurrent(in: model) ? model.bots.first(where: { $0.id == bot.id })?.name : nil) ?? bot.name
    }

    /// Creates the session once per router target, only on the base the target was taken on and only with the bot
    /// visible there now. A new target (an accepted switch) retires the previous session first.
    private func adoptTarget() {
        guard let target = router.botTarget else { session?.close(); session = nil; return }
        if session?.id == target.id { return }
        session?.close(); session = nil
        guard onCurrentBase(target), model.canEditBotProfiles,
              let bot = model.bots.first(where: { $0.id == target.botID }) else { return }
        session = SettingsEditorSession(target: .bot(bot), model: model, id: target.id,
                                        hostScope: target.hostScope, hostAddress: target.hostAddress)
    }

    /// With no editor mounted there are no drafts to decide about: a switch to a target on the current base is
    /// accepted, anything else is answered as declined, so no request waits for an editor that does not exist.
    private func answerWithoutEditor() {
        guard session == nil, let request = router.botRequest else { return }
        if case .switchTo(let target) = request.kind, onCurrentBase(target) { router.acceptBotSwitch(request.token) }
        else { router.finishBotRequest(request.token) }
    }
}

/// Owner bot settings in six pages. Perfil, Modelo e voz and Comunicação each save only their own fields with the
/// profile CAS (one Salvar alterações / Descartar footer); Acessos applies each confirmed change at once; documents,
/// skills, MCPs and browser keep their own saves. Changing page or subsection never saves.
@MainActor struct BotProfileView: View {
    let model: DexterAppModel
    let onClose: () -> Void
    let onOpenThread: (String) -> Void
    let onAcceptSwitch: (UUID) -> Void
    let onRequestHandled: (UUID) -> Void
    let request: BotSettingsRequest?
    /// The window's session, kept for this editor's lifetime (SwiftUI re-runs `init` on every parent update; the
    /// first value stays). Every subeditor gets this same object; none of them reads the model's current base.
    @State private var session: SettingsEditorSession
    @Environment(\.locale) private var locale
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @Environment(\.openSettings) private var openSettings
    @State private var baseline: Bot
    @State private var name: String
    @State private var roleDescription: String
    @State private var avatarEmoji: String
    @State private var avatar: AvatarEditorController
    @State private var removedAvatarImage = false
    /// Mascot recipe draft; image and recipe changes of one Save travel in the same CAS PATCH (`BotAvatarPatchPlan`).
    @State private var appearanceDraft: BotAvatarAppearanceDraft
    @State private var canSeeBots: Bool
    @State private var canReceiveOrders: Bool
    @State private var canSendActions: Bool
    @State private var isMaster: Bool
    @State private var defaultSelection: EngineSelection
    @State private var liveVoice: String?
    @State private var busy = false
    @State private var savingSection: BotSettingsSection?
    @State private var requiresReload = false
    @State private var notice: ProfileNotice?
    @State private var active = true
    @State private var selectedSection: BotSettingsSection
    /// Conexões › Este Mac is showing (it is not a `BotSettingsSection`); any section choice clears it.
    @State private var thisMacSelected = false
    /// The subsection last shown in each page, so going back to a page restores it.
    @State private var lastPane: [BotSettingsPage: BotSettingsPane] = [:]
    @State private var discardingSection: BotSettingsSection?
    @State private var pendingSection: BotSettingsSection?
    @State private var queuedRequest: BotSettingsRequest?
    @State private var pendingDestination: Destination?
    @State private var documents: BotDocumentsEditor
    @State private var browserUse: BrowserUseSettingsEditor
    @State private var resources: BotSettingsResourcesEditor
    @State private var approvalPolicy: BotApprovalPolicyEditor
    @State private var executionAccess: BotExecutionAccessEditor
    /// UI R1: one owner-configuration presenter per window (MCP accounts and memory suggestions share it).
    @State private var ownerConfiguration: BotOwnerConfigurationPresenter
    @State private var memoryLearning: MemoryLearningEditor
    @State private var confirmingDiscard = false
    @State private var confirmingProfileReload = false
    @State private var requestGeneration = UUID()
    @State private var profileRequestTask: Task<Void, Never>?

    private enum Destination: Equatable { case close, thread(String), switchBot(token: UUID, name: String) }
    /// A profile notice belongs to one section (its own Save) or to all three (nil: reload, host change).
    private struct ProfileNotice: Equatable { let section: BotSettingsSection?; let text: String }
    private static let profileSections: [BotSettingsSection] = [.profile, .model, .communication]

    init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession? = nil,
         documentsClientFactory: (@MainActor () -> HostClient?)? = nil,
         startsWithDocuments: Bool = false,
         startsWithAccess: Bool = false,
         initialSection: BotSettingsSection? = nil,
         request: BotSettingsRequest? = nil,
         avatarController: AvatarEditorController? = nil,
         onOpenThread: @escaping (String) -> Void = { _ in },
         onAcceptSwitch: @escaping (UUID) -> Void = { _ in },
         onRequestHandled: @escaping (UUID) -> Void = { _ in },
         onClose: @escaping () -> Void) {
        self.model = model; self.onClose = onClose; self.onOpenThread = onOpenThread
        self.onAcceptSwitch = onAcceptSwitch; self.onRequestHandled = onRequestHandled; self.request = request
        let session = session ?? SettingsEditorSession(target: .bot(bot), model: model)
        _session = State(initialValue: session)
        _baseline = State(initialValue: bot); _name = State(initialValue: bot.name)
        _roleDescription = State(initialValue: bot.roleDescription); _avatarEmoji = State(initialValue: bot.avatarEmoji ?? "")
        _avatar = State(initialValue: avatarController ?? AvatarEditorController())
        _appearanceDraft = State(initialValue: BotAvatarAppearanceDraft(baseline: bot.avatarAppearance))
        _canSeeBots = State(initialValue: bot.canSeeBots); _canReceiveOrders = State(initialValue: bot.canReceiveOrders)
        _canSendActions = State(initialValue: bot.canSendActions); _isMaster = State(initialValue: bot.isMaster)
        _defaultSelection = State(initialValue: bot.defaultSelection ?? EngineSelection(engine: bot.engine.rawValue))
        _liveVoice = State(initialValue: bot.liveVoice)
        _documents = State(initialValue: BotDocumentsEditor(botID: bot.id, model: model, session: session, clientFactory: documentsClientFactory))
        _browserUse = State(initialValue: BrowserUseSettingsEditor(model: model, botID: bot.id, clientFactory: documentsClientFactory, session: session))
        _resources = State(initialValue: BotSettingsResourcesEditor(botID: bot.id, model: model, session: session, clientFactory: documentsClientFactory))
        _approvalPolicy = State(initialValue: BotApprovalPolicyEditor(bot: bot, model: model, session: session))
        _executionAccess = State(initialValue: BotExecutionAccessEditor(bot: bot, model: model, session: session))
        _ownerConfiguration = State(initialValue: BotOwnerConfigurationPresenter(bot: bot, model: model, session: session))
        // Its own owner-configuration session: the host keeps one session per window ID, and the window's
        // presenter already holds `session.id`, so sharing it would make the host revoke one of the two.
        _memoryLearning = State(initialValue: MemoryLearningEditor(bot: bot, model: model))
        _selectedSection = State(initialValue: initialSection ?? (startsWithAccess ? .access : (startsWithDocuments ? .memory : .profile)))
    }
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanEmoji: String { avatarEmoji.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var emojiValid: Bool {
        cleanEmoji.isEmpty || (cleanEmoji.count == 1 && cleanEmoji.utf16.count <= 16 && cleanEmoji.unicodeScalars.contains { $0.value > 127 && $0.properties.isEmoji })
    }
    /// False for good once the base, address, host identity or this bot changed since the window opened
    /// (`SettingsEditorSession` retires itself; going back to the old address does not revive it).
    private var scopeMatches: Bool { session.isCurrent(in: model) }
    private var avatarHasImage: Bool { avatar.imageDraft != nil || (!removedAvatarImage && baseline.avatarImage != nil) }
    private var avatarDirty: Bool { avatar.imageDraft != nil || (removedAvatarImage && baseline.avatarImage != nil) || appearanceDraft.isDirty }
    private var baselineSelection: EngineSelection { baseline.defaultSelection ?? EngineSelection(engine: baseline.engine.rawValue) }
    private var identityDirty: Bool {
        cleanName != baseline.name || roleDescription != baseline.roleDescription || cleanEmoji != (baseline.avatarEmoji ?? "") || avatarDirty
    }
    private var modelDirty: Bool { defaultSelection != baselineSelection || liveVoice != baseline.liveVoice }
    private var communicationDirty: Bool {
        canSeeBots != baseline.canSeeBots || canReceiveOrders != baseline.canReceiveOrders ||
        canSendActions != baseline.canSendActions || isMaster != baseline.isMaster
    }
    private var profileDirty: Bool { identityDirty || modelDirty || communicationDirty }
    private func isDirty(_ section: BotSettingsSection) -> Bool {
        switch section {
        case .profile: identityDirty
        case .model: modelDirty
        case .communication: communicationDirty
        case .memory: documents.dirty || (ownerConfiguration.hasOpenProposal && ownerConfiguration.context?.isMcp == false)
        case .mcp: resources.dirty || ownerConfiguration.mcpDraftDirty || (ownerConfiguration.hasOpenProposal && ownerConfiguration.context?.isMcp == true)
        case .browser: browserUse.dirty
        case .skills, .access, .routines, .history: false
        }
    }
    private func isValid(_ section: BotSettingsSection) -> Bool {
        guard scopeMatches else { return false }
        switch section {
        case .profile: return !cleanName.isEmpty && cleanName.utf16.count <= 120 && roleDescription.utf16.count <= 2000 && (emojiValid || avatarHasImage || appearanceDraft.isSelected)
        case .model: return liveVoice == nil || LiveVoiceCatalog.voices.contains(liveVoice ?? "")
        case .communication: return true
        default: return false
        }
    }
    private var working: Bool { busy || documents.busy || browserUse.busy || resources.busy || approvalPolicy.busy || executionAccess.busy || avatar.isGenerating || ownerConfiguration.busy }
    // Access and approval rule apply immediately with confirmation; they never leave a draft behind. An open owner
    // proposal (MCP accounts, memory) also asks before closing: this window is the only place that follows it.
    private var hasUnsavedChanges: Bool { profileDirty || documents.dirty || browserUse.dirty || resources.dirty || ownerConfiguration.mcpDraftDirty || ownerConfiguration.hasOpenProposal }
    private var dirtySections: [BotSettingsSection] { BotSettingsPage.allCases.flatMap(\.sections).filter(isDirty) }
    private var pane: BotSettingsPane { thisMacSelected ? .thisMac : .section(selectedSection) }
    private var page: BotSettingsPage { pane.page }
    private func pageDirty(_ page: BotSettingsPage) -> Bool { page.sections.contains(where: isDirty) }
    private func paneDirty(_ pane: BotSettingsPane) -> Bool {
        if case .section(let section) = pane { return isDirty(section) }
        return false
    }
    private var accessActionIDs: Set<String> {
        Set(model.actions.filter { $0.request.botId == baseline.id && [.awaitingApproval, .ready, .running].contains($0.state)
            && ApprovalPresentation(action: $0).executionOperation != nil }.map(\.id))
    }
    private var canEditProfile: Bool { scopeMatches && model.canEditBotProfiles && !requiresReload && !busy }

    private func sectionTitle(_ section: BotSettingsSection) -> String {
        switch section {
        case .profile: text("Perfil", "Profile")
        case .model: text("Modelo e voz", "Model and voice")
        case .memory: text("Instruções e memória", "Instructions and memory")
        case .skills: text("Habilidades", "Skills")
        case .mcp: text("Contas e ferramentas", "Accounts and tools")
        case .access: text("Acessos", "Access")
        case .communication: text("Comunicação", "Communication")
        case .browser: text("Navegador na nuvem", "Cloud browser")
        case .routines: text("Automações", "Automations")
        case .history: text("Histórico", "History")
        }
    }
    private func paneTitle(_ pane: BotSettingsPane) -> String {
        switch pane {
        case .section(let section): sectionTitle(section)
        case .thisMac: text("Este Mac", "This Mac")
        }
    }
    private func pageTitle(_ page: BotSettingsPage) -> String {
        switch page {
        case .profile: text("Perfil", "Profile")
        case .modelVoice: text("Modelo e voz", "Model and voice")
        case .memory: text("Memória", "Memory")
        case .connections: text("Conexões", "Connections")
        case .permissions: text("Permissões", "Permissions")
        case .activity: text("Atividade", "Activity")
        }
    }
    private func pageIcon(_ page: BotSettingsPage) -> String {
        switch page {
        case .profile: "person.crop.circle"
        case .modelVoice: "waveform"
        case .memory: "brain"
        case .connections: "link"
        case .permissions: "shield.lefthalf.filled"
        case .activity: "clock.arrow.circlepath"
        }
    }
    private func paneDescription(_ pane: BotSettingsPane) -> String {
        switch pane {
        case .section(.profile): text("Nome, avatar e função deste bot.", "This bot’s name, avatar and role.")
        case .section(.model): text("Modelo padrão e voz deste bot.", "This bot’s default model and voice.")
        case .section(.memory): text("Personalidade, o que ele sabe sobre você e o que lembra nas próximas conversas.", "Personality, what it knows about you and what it remembers in future conversations.")
        case .section(.skills): text("Habilidades que este bot usa. Elas orientam o bot; não dão acesso a nada.", "Skills this bot uses. They guide the bot; they grant no access.")
        case .section(.mcp): text("Contas e ferramentas de serviços conectados que este bot pode usar.", "Accounts and tools from connected services this bot can use.")
        case .section(.access): text("O que este bot pode fazer e quando pede sua aprovação.", "What this bot can do and when it asks for your approval.")
        case .section(.communication): text("Com quais bots este bot conversa e quem pode dar ordens a ele.", "Which bots this bot talks to and who can give it orders.")
        case .section(.browser): text("Como este bot usa o navegador na nuvem (Browser Use).", "How this bot uses the cloud browser (Browser Use).")
        case .section(.routines): text("Tarefas agendadas e calendário deste bot.", "This bot’s scheduled tasks and calendar.")
        case .section(.history): text("Conversas, ações e chamadas entre bots que a base já informou.", "Conversations, actions and bot calls reported by the host.")
        case .thisMac: text("Navegador, arquivos e tela deste Mac para este bot.", "This Mac’s browser, files and screen for this bot.")
        }
    }
    private func saveModelText(_ model: BotSettingsSaveModel) -> (text: String, icon: String) {
        switch model {
        case .draft: (text("Suas mudanças ficam como rascunho até Salvar alterações. Trocar de página não salva nem descarta nada.", "Your changes stay as a draft until Save changes. Switching pages neither saves nor discards anything."), "square.and.pencil")
        case .draftAndApproval: (text("Textos ficam como rascunho até Salvar alterações. Pedidos que exigem aprovação só valem depois que você aprova o pedido exato.", "Text stays as a draft until Save changes. Requests that need approval apply only after you approve the exact request."), "checkmark.seal")
        case .confirmedEachChange: (text("Cada mudança pede confirmação e vale assim que a base confirma. Não há botão Salvar.", "Each change asks for confirmation and applies as soon as the host confirms it. There is no Save button."), "checkmark.shield")
        case .readOnly: (text("Somente consulta. Nada aqui muda o bot.", "Read only. Nothing here changes the bot."), "eye")
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(spacing: 0) {
                // A retired session freezes the whole editor before any subeditor view, task or request can mount:
                // nothing below reads or writes, and the drafts stay only to be copied.
                if scopeMatches {
                    contentHeader
                    Divider()
                    sectionContent.frame(maxWidth: .infinity, maxHeight: .infinity)
                    if !thisMacSelected, Self.profileSections.contains(selectedSection) { profileFooter(selectedSection) }
                } else {
                    frozenContent.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .foregroundStyle(.primary)
        .background(Color(nsColor: .windowBackgroundColor))
        .frame(minWidth: 760, idealWidth: 1000, minHeight: 560, idealHeight: 720)
        // A window, not a sheet: its close button and ⌘W wait while drafts or a request exist.
        .background(MacWindowCloseGuard(blocksClose: working || hasUnsavedChanges))
        .confirmationDialog(discardTitle, isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button(scopeMatches ? text("Descartar e continuar", "Discard and continue") : text("Descartar e fechar", "Discard and close"), role: .destructive, action: finish)
            Button(scopeMatches ? text("Continuar editando", "Keep editing") : text("Cancelar", "Cancel"), role: .cancel, action: cancelDestination)
        } message: {
            if ownerConfiguration.hasOpenProposal {
                Text("Há um pedido de MCPs ou Memória sem resultado final nesta janela. Fechar não cancela nem repete o pedido; a janela só deixa de acompanhá-lo, e nada é aplicado sem a sua aprovação.")
            } else if scopeMatches {
                Text(text("As alterações não salvas deste bot serão descartadas. Nada é salvo automaticamente; cada seção tem seu próprio botão Salvar.", "Unsaved changes for this bot will be discarded. Nothing is saved automatically; each section has its own Save button."))
            } else {
                Text(text("Esta janela não pode mais salvar. Os rascunhos serão descartados; nada é salvo nem reenviado.", "This window can no longer save. The drafts will be discarded; nothing is saved or resent."))
            }
        }
        .confirmationDialog(text("Recarregar e descartar edições do perfil?", "Reload and discard profile edits?"), isPresented: $confirmingProfileReload, titleVisibility: .visible) {
            Button(text("Recarregar perfil", "Reload profile"), role: .destructive, action: reload)
            Button(text("Manter edições", "Keep edits"), role: .cancel) {}
        } message: {
            Text(text("Perfil, Modelo e voz e Comunicação serão substituídos pelo perfil atual da base. As edições nas outras seções serão mantidas.", "Profile, Model and voice and Communication will be replaced with the current host profile. Edits in the other sections will be kept."))
        }
        // Local only: the section's fields go back to the profile last confirmed by the host. Nothing is sent.
        .confirmationDialog(text("Descartar as alterações desta seção?", "Discard this section’s changes?"),
                            isPresented: Binding(get: { discardingSection != nil }, set: { if !$0 { discardingSection = nil } }),
                            titleVisibility: .visible, presenting: discardingSection) { section in
            Button(text("Descartar", "Discard"), role: .destructive) { discardDraft(section); discardingSection = nil }
                .accessibilityIdentifier("bot-profile.discard.confirm")
            Button(text("Continuar editando", "Keep editing"), role: .cancel) { discardingSection = nil }
        } message: { section in
            Text(text("\(sectionTitle(section)) volta ao que a base confirmou por último. Nada é enviado; as outras seções não mudam.", "\(sectionTitle(section)) goes back to what the host last confirmed. Nothing is sent; other sections do not change."))
        }
        .onChange(of: isMaster) { _, master in if master { canSeeBots = true } }
        .onChange(of: scopeMatches) { _, current in if !current { invalidate() } }
        // A new request of this bot (for example the bot's own request that creates a provisional permission) can
        // change the inventory: the open Access page reads it once more. Finished actions trigger nothing.
        .onChange(of: accessActionIDs) { old, new in
            guard scopeMatches, pane == .section(.access), !new.subtracting(old).isEmpty else { return }
            Task { await executionAccess.refresh(reason: .localActionChanged) }
        }
        .onChange(of: pane) { _, current in lastPane[current.page] = current }
        .onChange(of: request?.token) { _, _ in handle(request) }
        .onChange(of: working) { _, isWorking in
            guard !isWorking else { return }
            if let section = pendingSection { select(.section(section)); pendingSection = nil }
            if let queued = queuedRequest { queuedRequest = nil; handle(queued) }
        }
        .task {
            guard scopeMatches else { return }
            await model.refreshEngineCatalog(); await model.loadLiveVoiceSettings()
        }
        .onDisappear { active = false; profileRequestTask?.cancel(); avatar.cancelGeneration(); documents.close(); browserUse.close(); resources.close(); approvalPolicy.close(); executionAccess.close(); ownerConfiguration.retire() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                DexterAvatarView(image: baseline.avatarImage, emoji: baseline.avatarEmoji, fallbackSystemImage: "person.crop.circle", model: model, size: 44,
                                 appearance: baseline.avatarAppearance, mascotSeed: baseline.id)
                VStack(alignment: .leading, spacing: 3) {
                    Text(baseline.name).font(.headline).lineLimit(2)
                    Text(text("Ajustes do bot", "Bot settings")).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    // Pages only arrange the same sections; IDs, drafts and saves stay per section.
                    ForEach(BotSettingsPage.allCases, id: \.self) { page in pageButton(page) }
                }.padding(12)
            }
            Divider()
            Text(text("Configuração de um bot. Os acessos continuam sujeitos às permissões e aprovações da base.", "Settings for one bot. Access still depends on the host’s permissions and approvals."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(18)
        }
        .frame(width: 220).frame(maxHeight: .infinity, alignment: .top)
        .background(Color.secondary.opacity(0.025))
    }

    /// Shows a page on the subsection last seen there (or its first one). Never saves, sends or discards.
    private func select(_ next: BotSettingsPane) {
        switch next {
        case .section(let section): selectedSection = section; thisMacSelected = false
        case .thisMac: thisMacSelected = true
        }
    }

    private func pageButton(_ target: BotSettingsPage) -> some View {
        let current = page == target, dirty = pageDirty(target)
        return Button { select(lastPane[target] ?? target.panes[0]) } label: {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: pageIcon(target)).frame(width: 20).accessibilityHidden(true)
                Text(pageTitle(target)).fontWeight(current ? .semibold : .regular)
                    .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if dirty {
                    Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                        .help(text("Alterações não salvas", "Unsaved changes")).accessibilityHidden(true)
                }
            }
            .foregroundStyle(current ? Color.accentColor : Color.primary)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(current ? Color.accentColor.opacity(0.10) : .clear, in: RoundedRectangle(cornerRadius: 8))
        .disabled(working || !scopeMatches)
        .accessibilityValue(dirty ? text("Alterações não salvas", "Unsaved changes") : "")
        .accessibilityIdentifier("bot-profile.page.\(target.rawValue)")
        .accessibilityAddTraits(current ? [.isSelected] : [])
    }

    /// Subsections of a page with more than one. Each keeps the old `bot-profile.tab.<raw>` ID; a dot marks drafts.
    @ViewBuilder private var subsectionBar: some View {
        if page.panes.count > 1 {
            HStack(spacing: 6) {
                ForEach(page.panes, id: \.self) { item in
                    let selected = item == pane
                    let dirty = paneDirty(item)
                    Button { select(item) } label: {
                        HStack(spacing: 6) {
                            Text(paneTitle(item)).font(.callout.weight(selected ? .semibold : .regular)).lineLimit(1)
                            if dirty { Circle().fill(Color.accentColor).frame(width: 6, height: 6).accessibilityHidden(true) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .frame(minHeight: 28)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? Color.accentColor : Color.primary)
                    .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.06), in: Capsule())
                    .disabled(working || !scopeMatches)
                    .accessibilityValue(dirty ? text("Alterações não salvas", "Unsaved changes") : "")
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                    .accessibilityIdentifier(item.accessibilityID)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(text("Seções de \(pageTitle(page))", "\(pageTitle(page)) sections"))
            .accessibilityIdentifier("bot-profile.subsections")
        }
    }

    private var contentHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(pageTitle(page)).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Text(paneDescription(pane)).font(.subheadline).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Button(text("Concluir", "Done"), action: requestClose)
                    .keyboardShortcut("w", modifiers: .command)
                    .disabled(working).accessibilityIdentifier("bot-profile.close")
            }
            subsectionBar
            let saveModel = saveModelText(BotSettingsSaveModel(pane: pane))
            Label(saveModel.text, systemImage: saveModel.icon)
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bot-profile.save-model")
            if hasUnsavedChanges {
                let names = dirtySections.map(sectionTitle).joined(separator: ", ")
                Label(text("Alterações não salvas em \(names). Trocar de página mantém os rascunhos; nada é salvo sozinho.",
                           "Unsaved changes in \(names). Switching pages keeps your drafts; nothing is saved by itself."), systemImage: "pencil.circle")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-profile.unsaved")
            }
        }.padding(22)
    }

    @ViewBuilder private var sectionContent: some View {
        switch pane {
        case .thisMac: thisMacContent
        case .section(.profile): identityContent
        case .section(.model): modelContent
        case .section(.memory): BotDocumentsView(editor: documents, owner: ownerConfiguration, botName: baseline.name, onOpenMcp: { select(.section(.mcp)) }, learning: memoryLearning)
        case .section(.skills): BotSettingsSkillsView(editor: resources)
        case .section(.mcp): BotSettingsMcpView(editor: resources, owner: ownerConfiguration, botName: baseline.name, onOpenMemory: { select(.section(.memory)) })
        case .section(.access): accessContent
        case .section(.communication): communicationContent
        case .section(.browser): BrowserUseBotSettingsView(editor: browserUse)
        case .section(.routines):
            AutomationsView(model: model, botID: baseline.id, onRequestOpenThread: { threadID, botID in
                guard botID == baseline.id else { return }; requestOpenThread(threadID)
            })
        case .section(.history):
            BotSettingsHistoryView(editor: resources) { thread in
                guard thread.botId == baseline.id, thread.teamID == nil else { return }; requestOpenThread(thread.id)
            }
        }
    }

    /// Conexões › Este Mac: this bot's decisions for this Mac's tools, plus the way to the app settings where the Mac
    /// itself is prepared. It never claims the Mac is ready: agent, pairing and macOS permissions are checked there.
    private var thisMacContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                BotSettingsGroup(title: text("Permissões deste bot", "This bot’s permissions"),
                                 note: text("Cada linha é uma decisão real da base para este bot. Liberar algo aqui não pareia aparelhos nem concede permissões do macOS.", "Each row is a real decision on the host for this bot. Allowing something here neither pairs devices nor grants macOS permissions."),
                                 id: "bot-profile.this-mac.permissions") {
                    BotSettingsAccessView(editor: resources).padding(.vertical, 12)
                }
                BotSettingsGroup(title: text("Preparar este Mac", "Set up this Mac"),
                                 note: text("Esta janela não confirma se o agente deste Mac está pareado e pronto. O estado real de cada permissão do macOS, os sites, os arquivos e a tela de cada bot ficam nos Ajustes do app; você pode configurar depois.", "This window does not confirm whether this Mac’s agent is paired and ready. Each macOS permission’s real state, and each bot’s sites, files and screen, live in the app’s Settings; you can set this up later."),
                                 id: "bot-profile.this-mac.availability") {
                    BotSettingsRow(title: text("Navegador, arquivos e tela", "Browser, files and screen"),
                                   detail: text("Preparados uma vez para o Mac; aqui ficam só as decisões deste bot.", "Set up once for the Mac; only this bot’s decisions live here."),
                                   systemImage: "laptopcomputer") {
                        // Off once the session retired: the app's current base may no longer be this window's base.
                        Button(text("Abrir ajustes deste Mac…", "Open this Mac’s settings…")) { router?.settingsTab = .mac; openSettings() }
                            .disabled(!scopeMatches)
                            .help(text("Abre os Ajustes do app na aba do Mac: sites, arquivos e tela por bot. Abrir não muda nada.", "Opens the app’s Settings on the Mac tab: sites, files and screen per bot. Opening changes nothing."))
                            .accessibilityIdentifier("bot-profile.link.this-mac")
                    }
                    Divider()
                    BotSettingsRow(title: text("Aparelhos", "Devices"),
                                   detail: text("Permissões de cada bot por aparelho conectado a esta base.", "Each bot’s permissions per device connected to this host."),
                                   systemImage: "laptopcomputer.and.iphone") {
                        Button(text("Permissões por aparelho…", "Permissions per device…")) { router?.settingsTab = .devices; openSettings() }
                            .disabled(!scopeMatches)
                            .help(text("Abre os Ajustes do app onde ficam as permissões de cada bot por aparelho. Abrir não muda nada.", "Opens the app’s Settings where each bot’s per-device permissions live. Opening changes nothing."))
                            .accessibilityIdentifier("bot-profile.link.devices")
                    }
                }
            }.padding(22)
        }
    }

    /// Shown instead of every section once the session retired. Plain words first; the drafts stay readable and
    /// selectable so the owner can copy them; one explicit button closes (and discards, after confirmation).
    private var frozenContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Label {
                    Text(text("Esta janela não pode mais salvar", "This window can no longer save")).font(.title3.weight(.semibold))
                } icon: {
                    Image(systemName: "exclamationmark.lock").foregroundStyle(.orange)
                }
                .accessibilityAddTraits(.isHeader)
                Text(text("A conexão do app mudou depois que estes ajustes abriram: outra base, outro endereço, ou este bot não aparece mais nela. Para não ler nem gravar no bot errado, esta janela parou. Nada daqui foi lido nem salvo na base atual, e voltar ao endereço anterior não a reativa.",
                          "The app’s connection changed after these settings opened: another host, another address, or this bot is no longer there. So nothing is read from or written to the wrong bot, this window stopped. Nothing here was read from or saved to the current host, and going back to the previous address does not reactivate it."))
                    .fixedSize(horizontal: false, vertical: true)
                if hasUnsavedChanges {
                    let names = dirtySections.map(sectionTitle).joined(separator: ", ")
                    VStack(alignment: .leading, spacing: 10) {
                        Text(text("Rascunhos não salvos: \(names).", "Unsaved drafts: \(names).")).font(.callout.weight(.semibold))
                        Text(text("Eles ficam aqui só para consulta: selecione e copie o que quiser manter. Nada será salvo sozinho.", "They stay here for reference only: select and copy what you want to keep. Nothing is saved by itself."))
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        draftsPreview
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("bot-profile.frozen.drafts")
                } else {
                    Text(text("Não há rascunhos nesta janela.", "There are no drafts in this window.")).foregroundStyle(.secondary)
                }
                if let requestID = documents.pendingRequestID {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(text("Um pedido de Memória estava sem confirmação quando a conexão mudou. Para conferir o resultado, abra os ajustes deste bot na base em que ele foi feito e, em Memória › Versões e detalhes técnicos, use Recuperar pedido não confirmado com este ID:",
                                  "A Memory request was unconfirmed when the connection changed. To check its result, open this bot’s settings on the host where it was made and, under Memory › Versions and technical details, use Recover an unconfirmed request with this ID:"))
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                        Text(verbatim: requestID).font(.caption.monospaced()).textSelection(.enabled)
                    }
                    .accessibilityIdentifier("bot-profile.frozen.pending-request")
                }
                Text(text("Para editar um bot da base atual, feche esta janela e abra os ajustes pela janela principal.", "To edit a bot on the current host, close this window and open its settings from the main window."))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button(hasUnsavedChanges ? text("Descartar rascunhos e fechar…", "Discard drafts and close…") : text("Fechar", "Close"),
                           role: hasUnsavedChanges ? .destructive : nil, action: requestClose)
                        .keyboardShortcut("w", modifiers: .command)
                        .accessibilityIdentifier("bot-profile.frozen.close")
                }
            }.padding(22)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-profile.frozen")
    }

    @ViewBuilder private var draftsPreview: some View {
        VStack(alignment: .leading, spacing: 10) {
            if identityDirty {
                draftValue(text("Nome", "Name"), cleanName)
                if roleDescription != baseline.roleDescription { draftValue(text("Função", "Role"), roleDescription) }
                if cleanEmoji != (baseline.avatarEmoji ?? "") { draftValue(text("Emoji", "Emoji"), cleanEmoji) }
                if appearanceDraft.isDirty {
                    draftValue(text("Mascote", "Mascot"), appearanceDraft.selected.map { $0.accessibilityDescription(portuguese: locale.language.languageCode?.identifier == "pt") }
                        ?? text("removido", "removed"))
                }
            }
            if modelDirty { draftValue(text("Modelo e voz", "Model and voice"), EngineChoiceLabel.engine(defaultSelection.engine) + " / " + (defaultSelection.model ?? text("padrão da engine", "engine default"))) }
            if communicationDirty {
                draftValue(text("Comunicação", "Communication"), [
                    isMaster ? "Master" : nil,
                    (isMaster || canSeeBots) ? text("vê outros bots", "sees other bots") : nil,
                    canReceiveOrders ? text("recebe ordens", "receives orders") : nil,
                    canSendActions ? text("envia ações", "sends actions") : nil
                ].compactMap { $0 }.joined(separator: " · "))
            }
            if documents.dirty {
                if documents.soul != (documents.baseline?.soul ?? "") { draftValue(text("Personalidade", "Personality"), documents.soul) }
                if documents.user != (documents.baseline?.user ?? "") { draftValue(text("Sobre você", "About you"), documents.user) }
                if documents.memory != (documents.baseline?.memory ?? "") { draftValue(text("Memória", "Memory"), documents.memory) }
            }
            if resources.dirty {
                draftValue(text("Contas e ferramentas", "Accounts and tools"), text("seleção de ferramentas não salva (\(resources.selectedToolIDs.count) escolhidas)", "unsaved tool selection (\(resources.selectedToolIDs.count) chosen)"))
            }
            if browserUse.dirty { draftValue(text("Navegador na nuvem", "Cloud browser"), text("ajuste não salvo", "unsaved setting")) }
        }
    }

    private func draftValue(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(verbatim: value.isEmpty ? "—" : value).font(.callout).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var identityContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                BotSettingsGroup(title: text("Identidade", "Identity")) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(text("Nome", "Name"))
                        TextField(text("Nome do bot", "Bot name"), text: $name).textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("bot-profile.name")
                    }.padding(.vertical, 12)
                    Divider()
                    AvatarEditorView(controller: avatar, existingImage: baseline.avatarImage, removedExistingImage: $removedAvatarImage,
                                     emoji: $avatarEmoji, model: model, fallbackSystemImage: "person.crop.circle", idPrefix: "bot-profile.avatar", emojiID: "bot-profile.emoji",
                                     appearance: $appearanceDraft)
                        .padding(.vertical, 12)
                    Divider()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(text("Função", "Role"))
                        Text(text("Uma descrição curta do trabalho deste bot. A personalidade e as instruções completas ficam em Memória.", "A short description of this bot’s job. Its personality and full instructions belong in Memory."))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        TextEditor(text: $roleDescription).font(.body).padding(8)
                            .scrollContentBackground(.hidden)
                            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
                            .frame(minHeight: 120, idealHeight: 150)
                            .accessibilityLabel(text("Função do bot", "Bot role")).accessibilityIdentifier("bot-profile.role")
                    }.padding(.vertical, 12)
                }
                .disabled(!canEditProfile)
                filesGroup
            }.padding(22)
        }
    }

    /// Where this bot keeps the files it saves: its own namespace on the base this window was opened for (listing,
    /// Finder on this Mac's own base, download elsewhere). The folder choice for all bots stays in Ajustes › Geral.
    private var filesGroup: some View {
        BotSettingsGroup(title: text("Arquivos", "Files"),
                         note: text("Mudar onde ficam os arquivos novos nunca move nem apaga os que já existem. A pasta do bot não é uma área isolada para comandos do Terminal.", "Changing where new files go never moves or deletes existing ones. The bot’s folder is not an isolated area for Terminal commands."),
                         id: "bot-profile.files") {
            if scopeMatches {
                OutputFilesNamespaceRows(model: model, ref: .bot(baseline.id), owner: .bot, idPrefix: "bot-profile.files")
            } else {
                BotSettingsRow(title: text("Pasta deste bot", "This bot’s folder"),
                               detail: text("Esta janela é de outra base. Feche e abra os ajustes do bot de novo.", "This window belongs to another base. Close and reopen the bot settings."),
                               systemImage: "folder") { EmptyView() }
            }
        }
    }

    private var modelContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                BotSettingsGroup(title: text("Modelo padrão", "Default model")) { VStack(alignment: .leading, spacing: 13) {
                    EngineSelectionControls(catalog: model.engineCatalog, selection: defaultSelection,
                        enabled: canEditProfile,
                        refresh: { Task { await model.refreshEngineCatalog() } }) { defaultSelection = $0 }
                    Text(text("Novas conversas usam este padrão. Cada conversa pode escolher outro modelo abaixo da mensagem.", "New conversations use this default. Each conversation can choose another model below the message."))
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    let readiness = EngineReadiness(entry: model.engineCatalog.first { $0.id == defaultSelection.engine })
                    Label(readiness.label(portuguese: locale.language.languageCode?.identifier == "pt"), systemImage: readiness.symbol)
                        .font(.footnote).foregroundStyle(.secondary)
                        .accessibilityIdentifier("bot-profile.model.engine-state")
                    if model.engineCatalog.isEmpty {
                        Text(text("O catálogo deste host ainda não está disponível.", "This host’s catalog is not available yet.")).font(.footnote).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 12) }
                voiceSection
            }.padding(22)
        }
    }

    /// UX-P1-13 slot (voice is the main lane's overlay): everything about this bot's voice lives here and nowhere else
    /// in this window. Today: the native-call voice card (own editor, receipts and Conferir) and the Live voice
    /// picker, whose `liveVoice` draft is part of this page's profile save. A replacement keeps both IDs families
    /// (`bot-profile.native-voice.*`, `bot-profile.live-voice`) or ships their guide migration in the same delivery.
    @ViewBuilder private var voiceSection: some View {
        BotSettingsGroup(title: text("Voz", "Voice"), id: "bot-profile.voice") {
            BotVoiceSettingsCard(model: model, bot: baseline, liveVoice: $liveVoice, enabled: canEditProfile)
        }
    }

    /// Only confirmed, immediate changes live here; profile drafts moved to Communication.
    private var accessContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Label(text("Cada mudança desta página pede confirmação e vale assim que a base confirma. Não há botão Salvar.",
                           "Each change on this page asks for confirmation and applies as soon as the host confirms it. There is no Save button."),
                      systemImage: "checkmark.shield")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-profile.access.apply-model")
                BotExecutionAccessSection(model: model, botName: baseline.name, access: executionAccess, policy: approvalPolicy)
                // The per-bot Mac tool decisions moved to Conexões › Este Mac; same view, same IDs, same requests.
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Label(text("Navegador, arquivos e tela deste Mac têm decisões próprias em Conexões › Este Mac.", "This Mac’s browser, files and screen have their own decisions in Connections › This Mac."), systemImage: "laptopcomputer")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button(text("Abrir Este Mac", "Open This Mac")) { select(.thisMac) }
                        .disabled(working).accessibilityIdentifier("bot-profile.access.open-this-mac")
                }
            }.padding(22)
        }
    }

    private var communicationContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                BotSettingsGroup(title: text("Comunicação entre bots", "Bot communication"),
                                 note: text("O remetente precisa ver os bots e enviar ações; o destinatário precisa receber ordens. Ferramentas do Dexter devem estar ativas em Ajustes › Modelos. Cada bot mantém suas próprias permissões.", "The sender must see bots and send actions; the recipient must receive orders. Dexter tools must be on in Settings › Models. Each bot keeps its own permissions.")) {
                    Text(text("Estas opções fazem parte do perfil e só valem depois de Salvar alterações, abaixo.", "These options are part of the profile and apply only after Save changes, below."))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 10)
                        .accessibilityIdentifier("bot-profile.communication.save-hint")
                    Divider()
                    BotSettingsRow(title: "Master", detail: text("Só um bot pode ser Master nesta base. Ele vê os outros bots; isso não concede ferramentas ou permissões adicionais.", "Only one bot can be Master on this host. It sees other bots; this grants no additional tools or permissions.")) {
                        Toggle("Master", isOn: $isMaster).toggleStyle(.switch).labelsHidden().accessibilityIdentifier("bot-profile.master")
                    }
                    Divider()
                    BotSettingsRow(title: text("Ver outros bots", "See other bots")) {
                        Toggle(text("Ver outros bots", "See other bots"), isOn: $canSeeBots).toggleStyle(.switch).labelsHidden().disabled(isMaster)
                            .accessibilityIdentifier("bot-profile.see-bots")
                    }
                    Divider()
                    BotSettingsRow(title: text("Receber ordens de outros bots", "Receive orders from other bots")) {
                        Toggle(text("Receber ordens de outros bots", "Receive orders from other bots"), isOn: $canReceiveOrders).toggleStyle(.switch).labelsHidden()
                            .accessibilityIdentifier("bot-profile.receive-orders")
                    }
                    Divider()
                    BotSettingsRow(title: text("Enviar ações a outros bots", "Send actions to other bots")) {
                        Toggle(text("Enviar ações a outros bots", "Send actions to other bots"), isOn: $canSendActions).toggleStyle(.switch).labelsHidden()
                            .accessibilityIdentifier("bot-profile.send-actions")
                    }
                }.disabled(!canEditProfile)
            }.padding(22)
        }
    }

    private func saveExplanation(_ section: BotSettingsSection) -> String {
        switch section {
        case .model: text("Salvar guarda só o modelo padrão e a voz ao vivo deste bot.", "Save keeps only this bot’s default model and live voice.")
        case .communication: text("Salvar guarda só as quatro opções de comunicação.", "Save keeps only the four communication options.")
        default: text("Salvar guarda só nome, avatar e função.", "Save keeps only name, avatar and role.")
        }
    }

    private func savedText(_ section: BotSettingsSection) -> String {
        switch section {
        case .model: text("Modelo e voz salvos e confirmados pela base.", "Model and voice saved and confirmed by the host.")
        case .communication: text("Comunicação salva e confirmada pela base.", "Communication saved and confirmed by the host.")
        default: text("Perfil salvo e confirmado pela base.", "Profile saved and confirmed by the host.")
        }
    }

    private func profileFooter(_ section: BotSettingsSection) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            if !model.canEditBotProfiles || !scopeMatches {
                Text(text("Editar o perfil exige conexão de proprietário à base local deste Mac.", "Editing the profile requires an owner connection to this Mac’s local host."))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 22)
            }
            if let notice, notice.section == nil || notice.section == section {
                HStack(alignment: .top, spacing: 10) {
                    Text(notice.text).font(.caption).foregroundStyle(requiresReload ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("bot-profile.notice")
                    if requiresReload {
                        Button(text("Recarregar perfil", "Reload profile")) {
                            if profileDirty { confirmingProfileReload = true } else { reload() }
                        }.disabled(working || !scopeMatches).accessibilityIdentifier("bot-profile.reload")
                    }
                }.padding(.horizontal, 22)
            }
            HStack(spacing: 12) {
                Text(saveExplanation(section))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                if busy && savingSection == section { ProgressView().controlSize(.small) }
                Button(text("Descartar", "Discard")) { discardingSection = section }
                    .disabled(working || !isDirty(section) || !scopeMatches)
                    .help(text("Volta esta seção ao que a base confirmou por último. Não envia nada.", "Returns this section to what the host last confirmed. Sends nothing."))
                    .accessibilityIdentifier("bot-profile.discard")
                Button(text("Salvar alterações", "Save changes")) { save(section) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(working || !isValid(section) || !isDirty(section) || requiresReload || !model.canEditBotProfiles)
                    .accessibilityIdentifier("bot-profile.save")
            }.padding(.horizontal, 22).padding(.bottom, 18)
        }
    }

    private var discardTitle: String {
        switch pendingDestination {
        case .thread: text("Descartar alterações e abrir a conversa?", "Discard changes and open the conversation?")
        case .switchBot(_, let name): text("Descartar alterações e abrir os ajustes de \(name)?", "Discard changes and open \(name)’s settings?")
        case .close, nil: text("Descartar alterações não salvas?", "Discard unsaved changes?")
        }
    }

    /// Requests from the main window: a section switch for this bot, or another bot after the owner decides about drafts.
    private func handle(_ request: BotSettingsRequest?) {
        guard let request, active else { return }
        guard !working else { queuedRequest = request; return }
        switch request.kind {
        case .section(let section):
            onRequestHandled(request.token)
            // "Abrir Acessos…" on an Access page already open: one bounded GET of this same editor, never a PATCH.
            // From another section, the Access page's own appearance reads it once.
            if section == .access, pane == .section(.access), scopeMatches {
                Task { await executionAccess.refresh(reason: .sectionRequested) }
            }
            select(.section(section))
        case .switchTo(let target):
            let name = model.bots.first(where: { $0.id == target.botID })?.name ?? text("outro bot", "another bot")
            requestFinish(.switchBot(token: request.token, name: name))
        }
    }

    private func requestClose() { requestFinish(.close) }
    private func requestOpenThread(_ threadID: String) {
        guard active, scopeMatches, !threadID.isEmpty else { return }
        requestFinish(.thread(threadID))
    }
    private func requestFinish(_ destination: Destination) {
        guard active, !working else { return }
        // Each new request replaces the old destination; a replaced switch request is answered as declined.
        if case .switchBot(let token, _) = pendingDestination, pendingDestination != destination { onRequestHandled(token) }
        pendingDestination = destination
        if hasUnsavedChanges { confirmingDiscard = true } else { finish() }
    }
    private func cancelDestination() {
        if case .switchBot(let token, _) = pendingDestination { onRequestHandled(token) }
        pendingDestination = nil
    }
    private func finish() {
        let destination = pendingDestination ?? .close
        pendingDestination = nil
        var openThread: String?
        if case .thread(let id) = destination, scopeMatches { openThread = id }
        active = false; profileRequestTask?.cancel(); avatar.cancelGeneration(); documents.close(); browserUse.close(); resources.close(); approvalPolicy.close(); executionAccess.close()
        ownerConfiguration.retire()
        if case .switchBot(let token, _) = destination {
            onAcceptSwitch(token)
            return
        }
        onClose()
        if let openThread { onOpenThread(openThread) }
    }
    /// The session retired: every request in flight is dropped and nothing new starts. Drafts are kept (only to be
    /// copied from the frozen panel); the owner closes the window explicitly, and nothing is saved again by itself.
    private func invalidate() {
        requestGeneration = UUID(); profileRequestTask?.cancel(); profileRequestTask = nil
        busy = false; savingSection = nil; requiresReload = true; confirmingProfileReload = false; confirmingDiscard = false
        cancelDestination(); pendingSection = nil; queuedRequest = nil
        documents.close(); browserUse.close(); resources.close()
        approvalPolicy.invalidate(); executionAccess.invalidate(); ownerConfiguration.retire()
        avatar.cancelGeneration(); avatar.forgetSetAsideImageDraft()
    }

    /// Sends only the fields of one profile section, with the observed revision; nothing else is resent. Each request
    /// (avatar upload, profile PATCH, reload) goes through the window's session on its own.
    private func save(_ section: BotSettingsSection) {
        guard active, Self.profileSections.contains(section), isValid(section), !working, isDirty(section), !requiresReload, model.canEditBotProfiles else { return }
        busy = true; savingSection = section; notice = nil
        let token = requestGeneration
        let botID = baseline.id, revision = baseline.revision
        let draftImage = section == .profile ? avatar.imageDraft : nil
        let removeImage = section == .profile && removedAvatarImage
        let baselineHasImage = baseline.avatarImage != nil, appearance = appearanceDraft
        let expectedHostID = model.avatarHostID
        let identity = (name: cleanName, role: roleDescription, emoji: cleanEmoji.isEmpty || !emojiValid ? BotAvatarEmojiPatch.clear : .set(cleanEmoji))
        let selection = defaultSelection == baselineSelection ? nil : defaultSelection
        let voice: BotLiveVoicePatch = liveVoice == baseline.liveVoice ? .unchanged : (liveVoice.map(BotLiveVoicePatch.set) ?? .clear)
        let flags = (see: isMaster || canSeeBots, receive: canReceiveOrders, send: canSendActions, master: isMaster)
        profileRequestTask = Task { @MainActor in
            do {
                let input: PatchBotInput
                switch section {
                case .profile:
                    var uploadedImageID: String?
                    if let draftImage {
                        guard let expectedHostID else { throw HostClientError.forbidden }
                        let uploaded = try await session.perform(in: model, kind: .mutation) { _ in try await model.uploadAvatarImage(draftImage, expectedHostID: expectedHostID) }
                        guard active, scopeMatches, token == requestGeneration, !Task.isCancelled else { return }
                        uploadedImageID = uploaded.id
                    }
                    // Image and mascot recipe in the same CAS: an explicit mascot clears the image, an imported image
                    // clears the recipe; a bot that never had a recipe omits the field.
                    let avatarFields = BotAvatarPatchPlan.fields(uploadedImageID: uploadedImageID, removesImage: removeImage,
                                                                 baselineHasImage: baselineHasImage, appearance: appearance)
                    input = PatchBotInput(expectedRevision: revision, name: identity.name, roleDescription: identity.role,
                                          avatarEmoji: identity.emoji, avatarImageId: avatarFields.image, avatarAppearance: avatarFields.appearance)
                case .model:
                    input = PatchBotInput(expectedRevision: revision, defaultSelection: selection, liveVoice: voice)
                default:
                    input = PatchBotInput(expectedRevision: revision, canSeeBots: flags.see, canReceiveOrders: flags.receive,
                                          canSendActions: flags.send, isMaster: flags.master)
                }
                let updated = try await session.perform(in: model, kind: .mutation) { _ in try await model.updateBotProfile(botID: botID, input: input) }
                guard active, scopeMatches, token == requestGeneration, !Task.isCancelled else { return }
                applySaved(section, updated); busy = false; savingSection = nil; profileRequestTask = nil
                notice = ProfileNotice(section: section, text: savedText(section))
            } catch {
                guard active, scopeMatches, token == requestGeneration, !Task.isCancelled else { return }
                busy = false; savingSection = nil; profileRequestTask = nil; requiresReload = true
                if (error as? HostClientError) == .conflict {
                    notice = ProfileNotice(section: section, text: text("O perfil mudou ou outro bot já é Master. Recarregue antes de salvar; a alteração não foi reenviada.", "The profile changed or another bot is already Master. Reload before saving; the change was not resent."))
                } else {
                    notice = ProfileNotice(section: section, text: text("Não foi possível confirmar o salvamento. Recarregue o perfil para conferir o estado antes de tentar novamente.", "Could not confirm the save. Reload the profile to check its state before trying again."))
                }
            }
        }
    }
    private func reload() {
        guard active, !working, scopeMatches, model.canEditBotProfiles else { return }; busy = true
        let token = requestGeneration
        let botID = baseline.id
        profileRequestTask = Task { @MainActor in
            do {
                let fetched = try await session.perform(in: model) { _ in try await model.reloadBotProfile(botID: botID) }
                guard active, scopeMatches, token == requestGeneration, !Task.isCancelled else { return }
                applyProfile(fetched); requiresReload = false; notice = nil; busy = false; profileRequestTask = nil
            } catch {
                guard active, scopeMatches, token == requestGeneration, !Task.isCancelled else { return }
                busy = false; profileRequestTask = nil
                notice = ProfileNotice(section: nil, text: text("Não foi possível recarregar este perfil. Confira a conexão com a base.", "Could not reload this profile. Check the connection to the host."))
            }
        }
    }
    /// After one section saved: that section and every section without drafts follow the host; other drafts stay.
    private func applySaved(_ section: BotSettingsSection, _ bot: Bot) {
        let keepIdentity = section != .profile && (identityDirty || avatar.setAsideImageDraft != nil)
        let keepModel = section != .model && modelDirty
        let keepCommunication = section != .communication && communicationDirty
        baseline = bot
        appearanceDraft.rebase(bot.avatarAppearance, keepDraft: keepIdentity)
        if !keepIdentity {
            name = bot.name; roleDescription = bot.roleDescription; avatarEmoji = bot.avatarEmoji ?? ""
            avatar.removeImage(); removedAvatarImage = false
        }
        if !keepModel { defaultSelection = bot.defaultSelection ?? EngineSelection(engine: bot.engine.rawValue); liveVoice = bot.liveVoice }
        if !keepCommunication {
            canSeeBots = bot.canSeeBots; canReceiveOrders = bot.canReceiveOrders
            canSendActions = bot.canSendActions; isMaster = bot.isMaster
        }
    }
    /// Local only: one profile section's fields go back to the last confirmed profile; other drafts stay.
    private func discardDraft(_ section: BotSettingsSection) {
        guard Self.profileSections.contains(section), !working else { return }
        switch section {
        case .profile:
            name = baseline.name; roleDescription = baseline.roleDescription; avatarEmoji = baseline.avatarEmoji ?? ""
            avatar.removeImage(); removedAvatarImage = false; appearanceDraft.reset()
        case .model:
            defaultSelection = baselineSelection; liveVoice = baseline.liveVoice
        default:
            canSeeBots = baseline.canSeeBots; canReceiveOrders = baseline.canReceiveOrders
            canSendActions = baseline.canSendActions; isMaster = baseline.isMaster
        }
        if notice?.section == section { notice = nil }
    }
    private func applyProfile(_ bot: Bot) {
        baseline = bot; name = bot.name; roleDescription = bot.roleDescription; avatarEmoji = bot.avatarEmoji ?? ""
        canSeeBots = bot.canSeeBots; canReceiveOrders = bot.canReceiveOrders
        canSendActions = bot.canSendActions; isMaster = bot.isMaster
        defaultSelection = bot.defaultSelection ?? EngineSelection(engine: bot.engine.rawValue)
        liveVoice = bot.liveVoice
        avatar.removeImage(); removedAvatarImage = false
        appearanceDraft = BotAvatarAppearanceDraft(baseline: bot.avatarAppearance)
    }
}

/// "O que este bot pode fazer" and "Quando pedir sua aprovação". Switches show only the state confirmed by the
/// host; every change is one exact owner request, confirmed in an alert whose default (Return) is Cancel.
@MainActor struct BotExecutionAccessSection: View {
    let model: DexterAppModel
    let botName: String
    let access: BotExecutionAccessEditor
    let policy: BotApprovalPolicyEditor
    @Environment(\.locale) private var locale
    @State private var accessConfirmation: BotExecutionAccessConfirmation?
    @State private var policyConfirmation: BotApprovalPolicyConfirmation?
    @State private var lastAccessOperation: BotExecutionOperation?
    @State private var showsAccessDetails = false
    @State private var showsPolicyDetails = false

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            accessCard
            policyCard
        }
        .alert(accessAlertTitle, isPresented: Binding(get: { accessConfirmation != nil }, set: { if !$0 { accessConfirmation = nil } }),
               presenting: accessConfirmation) { confirmation in
            Button(text("Cancelar", "Cancel"), role: .cancel) { accessConfirmation = nil }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("bot-profile.execution-access.cancel")
            Button(confirmation.request.input.enabled ? text("Ligar", "Turn on") : text("Desligar", "Turn off"),
                   role: confirmation.request.input.enabled ? nil : .destructive) {
                accessConfirmation = nil; lastAccessOperation = confirmation.request.input.operation
                Task { await access.saveHumanChoice(confirmation) }
            }.accessibilityIdentifier("bot-profile.execution-access.confirm")
        } message: { confirmation in
            Text(accessAlertMessage(confirmation))
        }
        .alert(policyAlertTitle, isPresented: Binding(get: { policyConfirmation != nil }, set: { if !$0 { policyConfirmation = nil } }),
               presenting: policyConfirmation) { confirmation in
            Button(text("Cancelar", "Cancel"), role: .cancel) { policyConfirmation = nil }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("bot-profile.approval-policy.cancel")
            Button(confirmation.request.input.mode == .approveAll ? text("Executar sem perguntar", "Run without asking")
                                                                  : text("Perguntar sempre", "Always ask")) {
                policyConfirmation = nil
                apply(confirmation)
            }.accessibilityIdentifier("bot-profile.approval-policy.confirm")
        } message: { confirmation in
            Text(policyAlertMessage(confirmation))
        }
        // Each time the Access page appears it reads the inventory once on this same editor (an uncertain change is
        // checked by its receipt instead). Nothing is reapplied or resent; the rule keeps the owner's choice.
        .task {
            if access.pending != nil { await access.load() }
            else { await access.refresh(reason: access.baseline == nil ? .opened : .sectionRequested) }
            if policy.pending != nil || policy.baseline == nil { await policy.load() }
            else { await policy.refreshPreservingDraft() }
        }
    }

    // MARK: Access

    private struct AccessCopy { let title: String; let summary: String; let icon: String }
    private func copy(_ operation: BotExecutionOperation) -> AccessCopy {
        switch operation {
        case .terminal:
            AccessCopy(title: "Terminal", summary: text("Roda comandos (bash, zsh, sh, bun) como o seu usuário do Mac, sem administrador. A pasta de trabalho não isola o sistema.", "Runs commands (bash, zsh, sh, bun) as your Mac user, without administrator rights. The working folder does not isolate the system."), icon: "terminal")
        case .cli:
            AccessCopy(title: text("GitHub e Python", "GitHub and Python"), summary: text("Usa gh e python3 já instalados neste Mac. Estar instalado não significa estar conectado à sua conta.", "Uses gh and python3 already installed on this Mac. Being installed does not mean signed in to your account."), icon: "chevron.left.forwardslash.chevron.right")
        case .filesWrite:
            AccessCopy(title: text("Salvar arquivos", "Save files"), summary: text("Só na pasta de arquivos deste bot. Não limita o que um comando do Terminal pode fazer.", "Only in this bot’s files folder. It does not limit what a Terminal command can do."), icon: "doc.badge.plus")
        case .automation:
            AccessCopy(title: text("Rodar automações", "Run automations"), summary: text("Executa rotinas já criadas deste bot, nos horários e limites salvos. Não cria rotinas nem acessos novos.", "Runs this bot’s existing routines within their saved schedule and limits. It creates no routines or new access."), icon: "calendar.badge.clock")
        }
    }

    private func time(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000).formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }
    private func dateTime(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000).formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale))
    }

    /// Derived only from the confirmed inventory, never from a draft or a click.
    private func stateText(_ entry: BotExecutionAccessEntry) -> (text: String, attention: Bool) {
        if entry.provisional { return (text("Desligado · cada ação deste tipo pede sua aprovação", "Off · each action of this kind asks for your approval"), false) }
        if entry.enabled {
            if let expiry = entry.grant?.expiresAt { return (text("Ligado até \(dateTime(expiry))", "On until \(dateTime(expiry))"), false) }
            return (text("Ligado", "On"), false)
        }
        if entry.grant?.policy == "deny" { return (text("Desligado por você", "Turned off by you"), false) }
        if entry.grant?.expiresAt != nil { return (text("Expirado — ligue de novo para usar", "Expired — turn on again to use"), true) }
        return (text("Desligado", "Off"), false)
    }

    private var noticeOperation: BotExecutionOperation? { access.pending?.input.operation ?? lastAccessOperation ?? access.lastReceipt?.input.operation }

    private var accessCard: some View {
        card {
            HStack(alignment: .firstTextBaseline) {
                Text(text("O que este bot pode fazer", "What this bot can do")).font(.headline)
                Spacer()
                if access.busy { ProgressView().controlSize(.small).accessibilityIdentifier("bot-profile.execution-access.loading") }
            }
            Text(text("Ligue só o que este bot precisa. Ligar não executa nada: cada ação continua seguindo a regra de aprovação logo abaixo. Ligar ou desligar invalida os pedidos deste tipo que ainda não começaram; o bot precisa pedir de novo.", "Turn on only what this bot needs. Turning something on runs nothing: each action still follows the approval rule below. Turning it on or off invalidates requests of that kind that have not started; the bot has to ask again."))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let notice = access.notice, [.unavailable, .loadFailed, .hostChanged].contains(notice) {
                cardNotice(accessNoticeText(notice), retry: notice == .hostChanged ? nil : { Task { await access.refresh(reason: .explicitReload) } })
            }
            if let baseline = access.baseline {
                VStack(spacing: 0) {
                    ForEach(baseline.entries) { entry in
                        accessRow(entry)
                        if entry.operation != baseline.entries.last?.operation { Divider().padding(.leading, 40) }
                    }
                }
                .padding(.vertical, 4)
                .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.12)))
            } else if access.busy {
                Text(text("Lendo os acessos deste bot…", "Reading this bot’s access…")).font(.callout).foregroundStyle(.secondary)
            }
            if access.pending != nil || access.busy, access.baseline != nil {
                Text(text("Um pedido por vez: aguarde a confirmação do pedido anterior.", "One request at a time: wait for the previous request to be confirmed."))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(text("MCP, navegador e ferramentas do Mac têm controles próprios. Isto não dá acesso a contas, senhas, OAuth nem permissões do macOS.", "MCP, browser and Mac tools have their own controls. This grants no access to accounts, passwords, OAuth or macOS permissions."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(isExpanded: $showsAccessDetails) {
                VStack(alignment: .leading, spacing: 4) {
                    if let baseline = access.baseline {
                        Text(text("Versão do bot observada: \(baseline.botRevision)", "Observed bot revision: \(baseline.botRevision)"))
                        Text(text("Inventário: \(baseline.inventoryHash)", "Inventory: \(baseline.inventoryHash)")).textSelection(.enabled)
                        ForEach(baseline.entries) { entry in
                            if let grant = entry.grant {
                                Text(verbatim: "\(entry.operation.rawValue): \(grant.policy) · rev \(grant.revision)\(entry.provisional ? " · provisional" : "")")
                            }
                        }
                    }
                    if let id = access.pending?.input.clientRequestId ?? access.lastReceipt?.clientRequestId {
                        Text(text("Último pedido: \(id)", "Last request: \(id)")).textSelection(.enabled)
                    }
                    if let receipt = access.lastReceipt { Text(text("Recibo: \(receipt.id)", "Receipt: \(receipt.id)")).textSelection(.enabled) }
                    Text(text("Mudanças passam pela base deste Mac por conexão local do seu usuário. Isso não comprova um clique físico nem isola o sistema operacional.", "Changes go through this Mac’s host over your user’s local connection. That neither proves a physical click nor isolates the operating system."))
                        .fixedSize(horizontal: false, vertical: true)
                }.font(.caption.monospaced()).foregroundStyle(.secondary).padding(.top, 4)
            } label: {
                Text(text("Detalhes técnicos", "Technical details")).font(.caption).foregroundStyle(.secondary)
            }.accessibilityIdentifier("bot-profile.execution-access.details")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-profile.execution-access")
    }

    private func accessRow(_ entry: BotExecutionAccessEntry) -> some View {
        let info = copy(entry.operation), state = stateText(entry)
        let rowPending = access.pending?.input.operation == entry.operation
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: info.icon).font(.title3).foregroundStyle(.secondary).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(info.title).font(.body.weight(.semibold))
                Text(info.summary).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(rowPending && access.busy ? text("Enviando…", "Sending…") : state.text)
                    .font(.caption).foregroundStyle(state.attention ? Color.orange : Color.secondary)
                    .accessibilityIdentifier("bot-profile.execution-access.state.\(entry.operation.rawValue)")
                if noticeOperation == entry.operation, let notice = access.notice, ![.unavailable, .loadFailed, .hostChanged].contains(notice) {
                    rowNotice(notice)
                }
            }
            Spacer(minLength: 8)
            if rowPending && access.busy { ProgressView().controlSize(.small) }
            Toggle(info.title, isOn: Binding(get: { entry.enabled }, set: { requestAccess(entry.operation, enabled: $0) }))
                .toggleStyle(.switch).labelsHidden()
                .disabled(!access.canEdit)
                .help(access.pending != nil ? text("Aguarde a confirmação do pedido anterior.", "Wait for the previous request to be confirmed.") : "")
                .accessibilityLabel(info.title)
                .accessibilityValue(state.text)
                .accessibilityIdentifier("bot-profile.execution-access.\(entry.operation.rawValue)")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    @ViewBuilder private func rowNotice(_ notice: BotExecutionAccessEditor.Notice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(rowNoticeText(notice)).font(.caption)
                .foregroundStyle(notice == .saved ? Color.secondary : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bot-profile.execution-access.notice")
            HStack(spacing: 8) {
                switch notice {
                case .saveUnknown:
                    Button(text("Conferir", "Check")) { Task { await access.load() } }
                        .disabled(access.busy).accessibilityIdentifier("bot-profile.execution-access.reconcile")
                case .receiptMissing:
                    Button(text("Conferir de novo", "Check again")) { Task { await access.load() } }
                        .disabled(access.busy).accessibilityIdentifier("bot-profile.execution-access.reconcile")
                    Button(text("Repetir o mesmo pedido", "Retry the same request")) { Task { await access.retryExactRequest() } }
                        .disabled(!access.canRetryExactRequest).accessibilityIdentifier("bot-profile.execution-access.retry-exact")
                case .conflict where !access.requiresReload:
                    // The host refused the change and the page already read the current state once: choose again.
                    EmptyView()
                case .conflict, .rejected, .savedRefreshFailed:
                    Button(text("Atualizar", "Refresh")) { Task { await access.refresh(reason: .explicitReload) } }
                        .disabled(access.busy).accessibilityIdentifier("bot-profile.execution-access.refresh")
                default: EmptyView()
                }
            }.font(.caption).buttonStyle(.bordered).controlSize(.small)
        }
    }

    private func rowNoticeText(_ notice: BotExecutionAccessEditor.Notice) -> String {
        switch notice {
        case .saved:
            guard let receipt = access.lastReceipt else { return text("Confirmado pela base.", "Confirmed by the host.") }
            let at = time(receipt.createdAt)
            // The receipt's effects are read in both directions: turning on also changes the grant revision.
            let message = receipt.input.enabled ? text("Ligado às \(at) · confirmado pela base.", "Turned on at \(at) · confirmed by the host.")
                                                : text("Desligado às \(at) · confirmado pela base.", "Turned off at \(at) · confirmed by the host.")
            guard let effects = access.lastReceiptEffects.flatMap({ accessEffectsText(enabled: receipt.input.enabled, $0) }) else { return message }
            return message + " " + effects
        case .saveUnknown: return text("Não foi possível confirmar esta mudança nem o que aconteceu com os pedidos deste tipo. Nada será reenviado sozinho; Conferir só lê o recibo.", "Could not confirm this change or what happened to requests of this kind. Nothing is resent automatically; Check only reads the receipt.")
        case .receiptMissing: return text("A base ainda não registrou este pedido. Confira de novo ou repita exatamente o mesmo pedido.", "The host has not recorded this request yet. Check again or retry exactly the same request.")
        case .conflict:
            // 409: the host had a newer state (often the bot's own new request). Exactly one read follows; no resend.
            return access.requiresReload
                ? text("Este acesso mudou desde que a página leu (por exemplo, um pedido novo do bot). Nada foi aplicado nem reenviado. Não foi possível reler agora: use Atualizar e escolha de novo.", "This access changed since the page read it (for example, a new request from the bot). Nothing was applied or resent. It could not be read again now: use Refresh and choose again.")
                : text("Este acesso mudou desde que a página leu (por exemplo, um pedido novo do bot). Nada foi aplicado nem reenviado. A linha já mostra o estado atual; se ainda quiser, escolha de novo.", "This access changed since the page read it (for example, a new request from the bot). Nothing was applied or resent. The row now shows the current state; choose again if you still want to.")
        case .rejected: return text("A base recusou esta mudança. Nada foi alterado.", "The host rejected this change. Nothing was changed.")
        case .savedRefreshFailed: return text("O recibo confirmou a mudança, mas a leitura seguinte falhou. Atualize antes de outra mudança.", "The receipt confirmed the change, but the next read failed. Refresh before another change.")
        case .unavailable, .loadFailed, .hostChanged: return accessNoticeText(notice)
        }
    }

    private func accessNoticeText(_ notice: BotExecutionAccessEditor.Notice) -> String {
        switch notice {
        case .unavailable: text("Esta conexão não permite mudar acessos. Use o app no Mac onde a base deste bot roda. Nada foi ligado.", "This connection cannot change access. Use the app on the Mac that runs this bot’s host. Nothing was turned on.")
        case .loadFailed: text("Não foi possível ler os acessos deste bot.", "Could not read this bot’s access.")
        case .hostChanged: text("A base mudou. Feche e abra os ajustes deste bot.", "The host changed. Close and reopen this bot’s settings.")
        default: rowNoticeText(notice)
        }
    }

    private func requestAccess(_ operation: BotExecutionOperation, enabled: Bool) {
        guard let confirmation = access.prepareHumanChange(operation: operation, enabled: enabled) else { return }
        accessConfirmation = confirmation
    }

    /// Receipt facts in plain words. Blocked requests never ran, so nothing about undoing is said for them; the
    /// partial-result sentence appears only when the host asked a running action to stop.
    private func accessEffectsText(enabled: Bool, _ effects: AccessMutationEffectSummary) -> String? {
        var parts: [String] = []
        let blocked = effects.blockedCount, stopped = effects.stopRequestedCount
        if blocked > 0 {
            if enabled {
                parts.append(blocked == 1
                    ? text("1 pedido deste tipo que ainda não tinha começado foi bloqueado e não será executado; o bot precisará pedir de novo.", "1 request of this kind that had not started was blocked and will not run; the bot will need to ask again.")
                    : text("\(blocked) pedidos deste tipo que ainda não tinham começado foram bloqueados e não serão executados; o bot precisará pedir de novo.", "\(blocked) requests of this kind that had not started were blocked and will not run; the bot will need to ask again."))
            } else {
                parts.append(blocked == 1
                    ? text("1 ação que ainda não tinha começado foi bloqueada e não será executada.", "1 action that had not started was blocked and will not run.")
                    : text("\(blocked) ações que ainda não tinham começado foram bloqueadas e não serão executadas.", "\(blocked) actions that had not started were blocked and will not run."))
            }
        }
        if effects.shouldExplainPossiblePartialEffects { parts.append(stopEffectsText(stopped)) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func policyEffectsText(_ effects: AccessMutationEffectSummary) -> String? {
        var parts: [String] = []
        let blocked = effects.blockedCount
        if blocked > 0 {
            parts.append(blocked == 1
                ? text("1 ação liberada pela regra e ainda não iniciada foi bloqueada.", "1 action released by the rule and not yet started was blocked.")
                : text("\(blocked) ações liberadas pela regra e ainda não iniciadas foram bloqueadas.", "\(blocked) actions released by the rule and not yet started were blocked."))
        }
        if effects.shouldExplainPossiblePartialEffects { parts.append(stopEffectsText(effects.stopRequestedCount)) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private func stopEffectsText(_ stopped: Int) -> String {
        stopped == 1
            ? text("Pedido de parada enviado para 1 ação em andamento; o resultado dela pode ficar parcial, e o que ela já fez não é desfeito.", "Stop requested for 1 running action; its result may be partial, and what it already did is not undone.")
            : text("Pedido de parada enviado para \(stopped) ações em andamento; o resultado delas pode ficar parcial, e o que já fizeram não é desfeito.", "Stop requested for \(stopped) running actions; their results may be partial, and what they already did is not undone.")
    }

    private var accessAlertTitle: String {
        guard let confirmation = accessConfirmation else { return "" }
        let title = copy(confirmation.request.input.operation).title
        return confirmation.request.input.enabled ? text("Ligar \(title) para \(botName)?", "Turn on \(title) for \(botName)?")
                                                  : text("Desligar \(title) para \(botName)?", "Turn off \(title) for \(botName)?")
    }

    /// Warns before the change about what the host does to requests already made; the row reports the receipt after.
    private func accessAlertMessage(_ confirmation: BotExecutionAccessConfirmation) -> String {
        let info = copy(confirmation.request.input.operation)
        if confirmation.request.input.enabled {
            return info.summary + " " + text("Vale só para este bot nesta base. Cada ação ainda segue a regra de aprovação.", "Applies only to this bot on this host. Each action still follows the approval rule.")
                + "\n\n" + text("Pedidos de \(info.title) que ainda não começaram, inclusive os que aguardam sua aprovação na conversa, serão bloqueados e não executados; o bot precisará pedir de novo. Para fazer só um pedido, use Permitir no cartão dele.",
                                 "\(info.title) requests that have not started, including those awaiting your approval in the conversation, will be blocked and not run; the bot will need to ask again. To run just one request, use Allow on its card.")
                + " " + enableRunningNotice
        }
        return text("Ações deste acesso que aguardam aprovação serão bloqueadas e as que estão rodando receberão pedido de parada, com resultado possivelmente parcial. O que já foi feito não é desfeito.", "Actions of this access awaiting approval will be blocked, and running ones will be asked to stop, possibly with a partial result. What already happened is not undone.")
    }

    /// What turning on does to work already running, as the host contract proves it: only a running action you
    /// approved yourself can continue (and only if its chain stays valid); any other is asked to stop. No promise here.
    private var enableRunningNotice: String {
        text("Uma ação que você aprovou e já está rodando pode continuar; outras em andamento recebem pedido de parada, com resultado possivelmente parcial. Depois de confirmar, a linha mostra o que aconteceu.",
             "An action you approved that is already running may continue; others in progress are asked to stop, possibly with a partial result. After you confirm, the row shows what happened.")
    }

    // MARK: Policy

    private var confirmedMode: BotApprovalPolicyMode { policy.baseline?.mode ?? .ask }
    private var enabledTitles: [String]? { access.baseline.map { $0.entries.filter(\.enabled).map { copy($0.operation).title } } }

    private var policyCard: some View {
        card {
            HStack(alignment: .firstTextBaseline) {
                Text(text("Quando pedir sua aprovação", "When to ask for your approval")).font(.headline)
                Spacer()
                if policy.busy { ProgressView().controlSize(.small).accessibilityIdentifier("bot-profile.approval-policy.loading") }
            }
            Picker(text("Regra de aprovação deste bot", "This bot’s approval rule"),
                   selection: Binding(get: { confirmedMode }, set: { requestPolicy($0) })) {
                ForEach(BotApprovalPolicyMode.allCases, id: \.rawValue) { mode in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: mode.title(locale: locale))
                        Text(verbatim: mode.summary(locale: locale)).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }.tag(mode).accessibilityIdentifier("bot-profile.approval-policy.mode.\(mode.rawValue)")
                }
            }
            .pickerStyle(.radioGroup).labelsHidden()
            .disabled(!policy.canEdit)
            // The picker title above is the group's only label; a second accessibilityLabel was announced twice.
            .accessibilityIdentifier("bot-profile.approval-policy.mode")
            if let state = policy.baseline {
                Group {
                    if state.revision == 0 {
                        Text(text("Padrão de bots novos: perguntar antes de cada ação.", "Default for new bots: ask before each action."))
                    } else {
                        Text(text("Salvo \(dateTime(state.updatedAt)) · confirmado pela base.", "Saved \(dateTime(state.updatedAt)) · confirmed by the host."))
                            .accessibilityIdentifier("bot-profile.approval-policy.updated-at")
                    }
                }
                .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("bot-profile.approval-policy.state")
                if state.mode != .ask, let titles = enabledTitles, titles.isEmpty {
                    Label(text("Nada está ligado acima, então comandos, arquivos e automações continuam pedindo aprovação.", "Nothing is on above, so commands, files and automations still ask for approval."), systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("bot-profile.approval-policy.nothing-enabled")
                }
            }
            if let pending = policy.pending, policy.busy {
                Text(text("Aplicando “\(pending.input.mode.title(locale: locale))”…", "Applying “\(pending.input.mode.title(locale: locale))”…"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let bot = policy.session.bot { SavedApprovalTypesControl(bot: bot, model: model, session: policy.session) }
            if let notice = policy.notice { policyNotice(notice) }
            Text(verbatim: BotApprovalPolicyMode.boundary(locale: locale)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(text("Ações que já aguardam sua aprovação continuam aguardando. Esta regra vale só para este bot nesta base.", "Actions already awaiting your approval keep waiting. This rule applies only to this bot on this host."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(isExpanded: $showsPolicyDetails) {
                VStack(alignment: .leading, spacing: 4) {
                    if let state = policy.baseline {
                        Text(verbatim: "mode \(state.mode.rawValue) · revision \(state.revision) · \(state.eligibleScopeVersion)")
                        if let receipt = state.receiptId { Text(text("Recibo: \(receipt)", "Receipt: \(receipt)")).textSelection(.enabled) }
                    }
                    if let id = policy.pending?.input.clientRequestId ?? policy.lastReceipt?.clientRequestId {
                        Text(text("Último pedido: \(id)", "Last request: \(id)")).textSelection(.enabled)
                    }
                }.font(.caption.monospaced()).foregroundStyle(.secondary).padding(.top, 4)
            } label: {
                Text(text("Detalhes técnicos", "Technical details")).font(.caption).foregroundStyle(.secondary)
            }.accessibilityIdentifier("bot-profile.approval-policy.details")
        }
    }

    @ViewBuilder private func policyNotice(_ notice: BotApprovalPolicyEditor.Notice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(policyNoticeText(notice)).font(.caption).foregroundStyle(notice == .saved ? Color.secondary : Color.orange)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("bot-profile.approval-policy.notice")
            HStack(spacing: 8) {
                switch notice {
                case .saveUnknown, .receiptMissing:
                    Button(notice == .saveUnknown ? text("Conferir", "Check") : text("Conferir de novo", "Check again")) { Task { await policy.load() } }
                        .disabled(policy.busy || !policy.scopeMatches).accessibilityIdentifier("bot-profile.approval-policy.refresh")
                    if notice == .receiptMissing {
                        Button(text("Repetir o mesmo pedido", "Retry the same request")) { Task { await policy.retryExactRequest() } }
                            .disabled(!policy.canRetryExactRequest).accessibilityIdentifier("bot-profile.approval-policy.retry-exact")
                    }
                case .conflict, .rejected, .savedRefreshFailed, .loadFailed:
                    Button(text("Atualizar", "Refresh")) { Task { await policy.refreshPreservingDraft() } }
                        .disabled(policy.busy || !policy.scopeMatches).accessibilityIdentifier("bot-profile.approval-policy.refresh")
                default: EmptyView()
                }
            }.font(.caption).buttonStyle(.bordered).controlSize(.small)
        }
    }

    private func policyNoticeText(_ notice: BotApprovalPolicyEditor.Notice) -> String {
        switch notice {
        case .saved:
            let message = text("Regra aplicada e confirmada pela base.", "Rule applied and confirmed by the host.")
            guard let sentence = policy.lastReceiptEffects.flatMap(policyEffectsText) else { return message }
            return message + " " + sentence
        case .unavailable: return text("Esta conexão não permite mudar a regra. Nenhuma regra local foi aplicada.", "This connection cannot change the rule. No local rule was applied.")
        case .loadFailed: return text("Não foi possível ler a regra deste bot.", "Could not read this bot’s rule.")
        case .hostChanged: return text("A base mudou. Feche e abra os ajustes deste bot.", "The host changed. Close and reopen this bot’s settings.")
        case .conflict: return text("A regra deste bot mudou desde que a página leu. Nada foi aplicado nem reenviado. Atualize e escolha de novo.", "This bot’s rule changed since the page read it. Nothing was applied or resent. Refresh and choose again.")
        case .saveUnknown: return text("Não foi possível confirmar a mudança da regra. Nada será reenviado sozinho.", "Could not confirm the rule change. Nothing is resent automatically.")
        case .receiptMissing: return text("A base ainda não registrou este pedido. Confira de novo ou repita exatamente o mesmo pedido.", "The host has not recorded this request yet. Check again or retry exactly the same request.")
        case .savedRefreshFailed: return text("O recibo confirmou a mudança, mas a leitura seguinte falhou. Atualize antes de outra escolha.", "The receipt confirmed the change, but the next read failed. Refresh before another choice.")
        case .rejected: return text("A base recusou a mudança. Nada foi alterado.", "The host rejected the change. Nothing was changed.")
        }
    }

    /// Captures the exact request from the confirmed baseline; the radio keeps showing the saved rule until the receipt.
    private func requestPolicy(_ mode: BotApprovalPolicyMode) {
        guard let saved = policy.baseline?.mode, mode != saved, policy.canEdit else { return }
        policy.mode = mode
        let confirmation = policy.prepareHumanSave()
        policy.mode = saved
        policyConfirmation = confirmation
    }

    private func apply(_ confirmation: BotApprovalPolicyConfirmation) {
        policy.mode = confirmation.request.input.mode
        Task {
            await policy.saveHumanChoice(confirmation)
            // A refused or conflicting choice leaves no draft behind; an uncertain one keeps the exact pending request.
            if policy.pending == nil, let saved = policy.baseline?.mode { policy.mode = saved }
        }
    }

    private var policyAlertTitle: String {
        guard let confirmation = policyConfirmation else { return "" }
        return text("Usar “\(confirmation.request.input.mode.title(locale: locale))” para \(botName)?", "Use “\(confirmation.request.input.mode.title(locale: locale))” for \(botName)?")
    }

    private func policyAlertMessage(_ confirmation: BotApprovalPolicyConfirmation) -> String {
        confirmation.request.input.mode.summary(locale: locale) + " " + BotApprovalPolicyMode.boundary(locale: locale) + " " +
            text("Vale para pedidos seguintes deste bot. Não cria acessos. Ações pendentes continuam aguardando. Ações admitidas pela regra anterior serão bloqueadas ou receberão pedido de parada; efeitos anteriores não são desfeitos.",
                 "Applies to this bot’s next requests. Does not create access. Pending actions remain pending. Actions admitted by the previous rule are blocked or asked to stop; previous effects are not undone.")
    }

    // MARK: Layout

    private func cardNotice(_ message: String, retry: (() -> Void)?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let retry { Button(text("Tentar de novo", "Try again"), action: retry).font(.caption).disabled(access.busy) }
        }
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 13, content: content)
            .frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.10)))
    }
}
#endif
