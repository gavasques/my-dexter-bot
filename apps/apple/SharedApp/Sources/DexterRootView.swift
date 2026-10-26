import DexterHostClient
import DexterAppCore
import SwiftUI
#if os(macOS)
import AppKit
#endif
#if os(iOS)
import DexterIOSCapabilities
#endif

private enum DexterRoute: Hashable {
    case capabilities
    case bot(String)
    case thread(String, String)
}

#if os(macOS)
/// A real 32pt native popup control; label-frame modifiers on SwiftUI Menu did not size its AX leaf.
struct MacSidebarCreateMenu: NSViewRepresentable {
    let canCreateBot: Bool
    let canCreateTeam: Bool
    var canCreateGroup = false
    let createBot: () -> Void
    let createTeam: () -> Void
    var createGroup: () -> Void = {}
    func makeNSView(context: Context) -> MacSidebarCreatePopUp {
        MacSidebarCreatePopUp(frame: NSRect(x: 0, y: 0, width: 32, height: 32), pullsDown: true)
    }
    func updateNSView(_ button: MacSidebarCreatePopUp, context: Context) {
        let title = String(localized: "Criar bot ou time")
        let menu = NSMenu(title: title)
        let heading = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        heading.image = NSImage(systemSymbolName: "plus", accessibilityDescription: title)
        menu.addItem(heading)
        let bot = NSMenuItem(title: String(localized: "Novo bot"), action: #selector(MacSidebarCreatePopUp.newBot), keyEquivalent: "n")
        bot.target = button; bot.isEnabled = canCreateBot; bot.keyEquivalentModifierMask = [.command, .shift]
        bot.setAccessibilityIdentifier("bot.create"); menu.addItem(bot)
        let team = NSMenuItem(title: String(localized: "Novo time"), action: #selector(MacSidebarCreatePopUp.newTeam), keyEquivalent: "n")
        team.target = button; team.isEnabled = canCreateTeam; team.keyEquivalentModifierMask = [.command, .option, .shift]
        team.setAccessibilityIdentifier("team.create"); menu.addItem(team)
        let group = NSMenuItem(title: String(localized: "Novo grupo"), action: #selector(MacSidebarCreatePopUp.newGroup), keyEquivalent: "")
        group.target = button; group.isEnabled = canCreateGroup
        group.setAccessibilityIdentifier("group.create"); menu.addItem(group)
        menu.autoenablesItems = false; button.menu = menu
        button.imagePosition = .imageOnly; button.isBordered = false; button.bezelStyle = .rounded
        (button.cell as? NSPopUpButtonCell)?.arrowPosition = .noArrow
        button.botAllowed = canCreateBot; button.teamAllowed = canCreateTeam
        button.createBot = createBot; button.createTeam = createTeam
        button.groupAllowed = canCreateGroup; button.createGroup = createGroup
        button.setAccessibilityLabel(title); button.setAccessibilityIdentifier("sidebar.create")
        button.toolTip = String(localized: "Novo bot: ⇧⌘N. Novo time: ⌥⇧⌘N.")
    }
}
final class MacSidebarCreatePopUp: NSPopUpButton {
    var botAllowed = false, teamAllowed = false
    var createBot: (() -> Void)?, createTeam: (() -> Void)?
    var groupAllowed = false
    var createGroup: (() -> Void)?
    override var intrinsicContentSize: NSSize { NSSize(width: 32, height: 32) }
    override func accessibilityLabel() -> String? { String(localized: "Criar bot ou time") }
    @objc func newBot() { if botAllowed { createBot?() } }
    @objc func newTeam() { if teamAllowed { createTeam?() } }
    @objc func newGroup() { if groupAllowed { createGroup?() } }
}

/// A display projection only. Team membership never changes a bot's conversation or grants.
struct DexterSidebarProjection {
    struct TeamGroup: Identifiable {
        let team: Team
        let coordinator: Bot?
        let members: [Bot]
        var id: String { team.id }
    }
    let bots: [Bot]
    let teams: [Team]
    let query: String
    var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func matches(_ value: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return needle.isEmpty || value.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil
    }
    private func matches(_ bot: Bot) -> Bool { matches(bot.name) || matches(bot.roleDescription) }
    func belongs(_ botID: String, to teamID: String) -> Bool {
        teams.contains { $0.id == teamID && $0.botIds.contains(botID) } && bots.contains { $0.id == botID }
    }
    var standaloneBots: [Bot] {
        let grouped = Set(teams.flatMap(\.botIds))
        return bots.filter { !grouped.contains($0.id) && matches($0) }
    }
    var teamGroups: [TeamGroup] {
        teams.compactMap { team in
            var seen = Set<String>()
            let available = team.botIds.compactMap { id in
                seen.insert(id).inserted ? bots.first { $0.id == id } : nil
            }
            let coordinator = available.first { $0.id == team.coordinatorBotId }
            let members = available.filter { $0.id != team.coordinatorBotId }
            let wholeTeam = matches(team.name) || matches(team.roleDescription) || coordinator.map(matches) == true
            let matchingMembers = wholeTeam ? members : members.filter(matches)
            guard wholeTeam || !matchingMembers.isEmpty else { return nil }
            return TeamGroup(team: team, coordinator: coordinator, members: matchingMembers)
        }
    }
}

/// Each occurrence has its own selection identity, including bots shared by multiple teams.
enum DexterSidebarSelection: Hashable {
    case bot(String)
    case team(String)
    case teamBot(teamID: String, botID: String)
    case group(String)

    static func current(botID: String?, teamID: String?, origin: Self?, projection: DexterSidebarProjection) -> Self? {
        if let teamID, projection.teams.contains(where: { $0.id == teamID }) { return .team(teamID) }
        guard let botID, projection.bots.contains(where: { $0.id == botID }) else { return nil }
        if case .teamBot(let originTeam, let originBot) = origin,
           originBot == botID, projection.belongs(botID, to: originTeam) { return origin }
        if let team = projection.teams.first(where: { projection.belongs(botID, to: $0.id) }) {
            return .teamBot(teamID: team.id, botID: botID)
        }
        return .bot(botID)
    }
}

/// Search temporarily exposes every matching section/team without rewriting user collapse choices.
struct DexterSidebarExpansion {
    enum Section: Hashable { case bots, teams, groups }
    private(set) var collapsedSections: Set<Section> = []
    private(set) var collapsedTeamIDs: Set<String> = []

    func isExpanded(_ section: Section, searching: Bool) -> Bool {
        searching || !collapsedSections.contains(section)
    }
    mutating func setExpanded(_ expanded: Bool, section: Section, searching: Bool) {
        guard !searching else { return }
        if expanded { collapsedSections.remove(section) } else { collapsedSections.insert(section) }
    }
    func isExpanded(teamID: String, searching: Bool) -> Bool {
        searching || !collapsedTeamIDs.contains(teamID)
    }
    mutating func setExpanded(_ expanded: Bool, teamID: String, searching: Bool) {
        guard !searching else { return }
        if expanded { collapsedTeamIDs.remove(teamID) } else { collapsedTeamIDs.insert(teamID) }
    }
}

private struct MacConversationScope: Equatable {
    let botID: String
    let teamID: String?
    let host: UUID
}
private struct MacConversationEntryTrigger: Equatable {
    let scope: MacConversationScope?
    let isReady: Bool
    let revision: UInt64
}
/// Only small forms stay as sheets on the main window; Settings and bot/team settings are their own windows.
private enum MacRootSheet: Identifiable {
    case newBot
    case delegations(Bot)
    case groupEditor(BotGroup?)
    /// "Quem vai conversar com você?" (UX-P0-04).
    case welcome
    /// Arquivo › Conectar a outra base… (UX-P1-07).
    case connectOtherBase
    case assistantSetup(AssistantSetupPresentation)
    case firstRun(AssistantFirstRunPresentation)
    case mcpAuthorization(McpAuthorizationPresentation)
    /// Approved `mac.setup.request`: the read-only computer-access panel, locked to the requesting bot.
    case macSetup(MacSetupHandoffPresentation)

    var id: String {
        switch self {
        case .newBot: "new-bot"
        case .welcome: "welcome"
        case .connectOtherBase: "connect-other-base"
        case .assistantSetup(let item): "assistant-setup:\(item.id)"
        case .firstRun(let item): "assistant-first-run:\(item.id)"
        case .mcpAuthorization(let item): "mcp-authorization:\(item.id)"
        case .macSetup(let item): "mac-setup:\(item.id)"
        case .delegations(let bot): "delegations:\(bot.id)"
        case .groupEditor(let group): "group-editor:\(group?.id ?? "new")"
        }
    }
}
#endif

struct DexterRootView: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    #if os(iOS)
    @State private var isShowingSettings = false
    @State private var isShowingNewBot = false
    #endif
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    #if os(macOS)
    /// Optional so synthetic hosts without the new scenes keep running; their settings routes then do nothing.
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hostWindow = MacHostWindowBox()
    /// Inspector › "Ver no chat" → the chat of this window shows that pending card (UI only).
    @State private var approvalFocusRequest: ChatApprovalFocusRequest?
    @State private var botSearch = ""
    @State private var sidebarBotOrigin: DexterSidebarSelection?
    @State private var sidebarExpansion = DexterSidebarExpansion()
    @State private var sidebarActivityNow = Int64(Date().timeIntervalSince1970 * 1_000)
    @State private var sectionSearchApplied = false
    @FocusState private var isSidebarFocused: Bool
    @FocusState private var isSearchFocused: Bool
    @State private var focusComposerOnEntry = true
    @State private var showingAutomations = false
    @State private var automationBotFilter: String?
    @State private var macSheet: MacRootSheet?
    @State private var inspectorExpanded = true
    @State private var inspectorPopoverScope: MacConversationScope?
    @State private var isShowingHostStatus = false
    @State private var initialRefreshComplete = false
    @AppStorage("com.dexter.apple.assistant-first-run.v1") private var firstRunReviewed = false
    @State private var entryRevision: UInt64 = 0
    @State private var attemptedEntry: MacConversationScope?
    @State private var historyScope: MacConversationScope?
    @State private var openingScope: MacConversationScope?
    @State private var entryFailureScope: MacConversationScope?
    @State private var entryFailure: String?
    @State private var entryToken = UUID()
    @State private var isCreatingConversation = false
    /// Collective group conversation selected in the sidebar; while set, no bot conversation is entered.
    @State private var selectedGroupID: String?
    @State private var groupCoordinator: GroupConversationCoordinator?
    @State private var groupCoordinatorScope: UUID?
    @State private var welcome: OnboardingWelcomeController?
    /// UX-P0-03: Permitir on a Browser Use action reconnects this Mac's base first; nil keeps the decision unchanged.
    @State private var browserUsePreflight: BrowserUseApprovalPreflight?
    private var selectedGroup: BotGroup? {
        guard !showingAutomations, let selectedGroupID else { return nil }
        return groupCoordinator?.groups.first { $0.id == selectedGroupID }
    }
    /// Automations or a group fill the detail column instead of a bot/team conversation.
    private var showingNonBotDetail: Bool { showingAutomations || selectedGroupID != nil }
    private var conversationScope: MacConversationScope? {
        showingNonBotDetail ? nil : model.selectedBotID.map { MacConversationScope(botID: $0, teamID: model.selectedTeamID, host: model.nativeComposerScope) }
    }
    private var entryTrigger: MacConversationEntryTrigger {
        // Observe readiness in the task identity itself. An onChange revision after refresh can
        // cancel an opener that already latched attemptedEntry, leaving no presentation or retry.
        MacConversationEntryTrigger(scope: conversationScope,
            isReady: initialRefreshComplete && !model.isLoading && (model.isFixture || model.canUseHost),
            revision: entryRevision)
    }
    /// Supplied by the app when the local host startup coordinator owns the first refresh.
    private let initialRefresh: (@MainActor () async -> Void)?
    /// Lets Settings offer the packaged bundle's local Claude/Codex choice; never starts or stops anything.
    private let localHost: LocalHostLaunchCoordinator?
    private let macAgent: LocalMacAgentProcess?
    private let welcomeStore: any OnboardingWelcomeProgressStore
    private let browserUseKeyStore: any BrowserUseAPIKeyStore
    /// Pre-fills "Nome deste Mac" in Conectar a outra base; QA injects a synthetic name.
    private let suggestedClientName: String?

    init(initialRefresh: (@MainActor () async -> Void)? = nil, localHost: LocalHostLaunchCoordinator? = nil, macAgent: LocalMacAgentProcess? = nil,
         welcomeStore: (any OnboardingWelcomeProgressStore)? = nil, browserUseKeyStore: (any BrowserUseAPIKeyStore)? = nil,
         suggestedClientName: String? = nil) {
        self.initialRefresh = initialRefresh
        self.localHost = localHost
        self.macAgent = macAgent
        self.welcomeStore = welcomeStore ?? UserDefaultsOnboardingWelcomeProgressStore()
        self.browserUseKeyStore = browserUseKeyStore ?? ScopedBrowserUseAPIKeychain()
        self.suggestedClientName = suggestedClientName
    }
    private var sidebarProjection: DexterSidebarProjection {
        DexterSidebarProjection(bots: model.bots, teams: model.teams, query: botSearch)
    }
    /// One observed source for standalone, coordinator and member rows, independent of row selection identity.
    /// The model currently observes the presented conversation only; this does not scan other bots/threads.
    private var sidebarActivitySnapshot: BotSidebarActivitySnapshot {
        BotSidebarActivitySnapshot(botID: model.selectedBotID, threadID: model.presentedThreadID,
            currentTurn: model.currentTurn, actions: model.actions.filter { !model.actionDecisionIsSuspended($0) },
            textObserved: !model.streamingText.isEmpty,
            observationActive: (model.botActivityObservationAvailable
                || BotSidebarActivitySnapshot.terminalIsFresh(model.currentTurn, at: Int64(Date().timeIntervalSince1970 * 1_000)))
                && !model.conversationObservationWasStopped,
            connection: model.isOnline || model.isFixture ? .connected : .unavailable)
    }
    private var selectedSidebarBinding: Binding<DexterSidebarSelection?> {
        Binding(get: {
            if showingAutomations { return nil }
            if let selectedGroupID { return .group(selectedGroupID) }
            return DexterSidebarSelection.current(botID: model.selectedBotID, teamID: model.selectedTeamID,
                origin: sidebarBotOrigin, projection: sidebarProjection)
        }, set: { value in
            guard let value else { return }
            switch value {
            case .bot(let id): guard model.bots.contains(where: { $0.id == id }) else { return }
            case .team(let id): guard model.teams.contains(where: { $0.id == id }) else { return }
            case .teamBot(let teamID, let botID): guard sidebarProjection.belongs(botID, to: teamID) else { return }
            case .group(let id):
                guard groupCoordinator?.groups.contains(where: { $0.id == id }) == true else { return }
                focusComposerOnEntry = false; showingAutomations = false
                attemptedEntry = nil; historyScope = nil; inspectorPopoverScope = nil
                selectedGroupID = id
                return
            }
            selectedGroupID = nil
            // Loading a sidebar destination must leave keyboard focus with the navigation list.
            focusComposerOnEntry = false
            showingAutomations = false
            attemptedEntry = nil; historyScope = nil; inspectorPopoverScope = nil
            sidebarBotOrigin = value
            switch value {
            case .team(let id): model.selectTeam(id: id)
            case .bot(let id), .teamBot(_, let id): model.selectBot(id: id)
            case .group: break
            }
        })
    }
    private func sectionExpansion(_ section: DexterSidebarExpansion.Section) -> Binding<Bool> {
        Binding(get: { sidebarExpansion.isExpanded(section, searching: sectionSearchApplied) }, set: { expanded in
            let scope = model.nativeComposerScope, query = botSearch
            // NSTableView calls this inside its delegate. Commit outside that cycle,
            // scoped to the same host/query. The getter only reads committed state.
            DispatchQueue.main.async {
                guard scope == model.nativeComposerScope, query == botSearch else { return }
                sidebarExpansion.setExpanded(expanded, section: section, searching: sidebarProjection.isSearching)
            }
        })
    }
    private func filteredGroups(_ groups: [BotGroup]) -> [BotGroup] {
        let needle = botSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return groups }
        func hit(_ value: String) -> Bool { value.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive], locale: .current) != nil }
        return groups.filter { group in
            hit(group.name) || group.activeBotIDs.contains { id in model.bots.first { $0.id == id }.map { hit($0.name) } == true }
        }
    }
    private func expandSelectedTeam(_ expanded: Bool) -> KeyPress.Result {
        let teamID: String
        switch selectedSidebarBinding.wrappedValue {
        case .team(let id), .teamBot(let id, _): teamID = id
        default: return .ignored
        }
        sidebarExpansion.setExpanded(expanded, teamID: teamID, searching: sidebarProjection.isSearching)
        return .handled
    }
    #endif

    #if os(iOS)
    @Environment(NativeActionSceneRouter.self) private var nativeActions
    @Environment(\.scenePhase) private var scenePhase
    @State private var phonePath: [DexterRoute] = []
    @State private var nativeSceneID = UUID()
    #endif

    var body: some View {
        #if os(macOS)
        macRoot
        #else
        phoneRoot
        #endif
    }

    #if os(macOS)
    private var macRoot: some View {
        let activitySnapshot = sidebarActivitySnapshot
        return NavigationSplitView(columnVisibility: $columnVisibility) {
            VStack(spacing: 0) {
                macSidebarHeader
                List(selection: selectedSidebarBinding) {
                    // Codync-clean sidebar: empty collective sections stay out of the way; + still creates both kinds.
                    if let groupCoordinator, !groupCoordinator.groups.isEmpty {
                        Section("Grupos", isExpanded: sectionExpansion(.groups)) {
                            ForEach(filteredGroups(groupCoordinator.groups)) { group in
                                GroupSidebarRow(group: group, model: model)
                                    .id(DexterSidebarSelection.group(group.id))
                                    .tag(DexterSidebarSelection.group(group.id))
                                    .accessibilityIdentifier("sidebar.group.\(group.id)")
                            }
                            if groupCoordinator.groups.isEmpty {
                                Text("Crie um grupo para conversar com vários bots ao mesmo tempo.")
                                    .font(.system(size: 12)).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("groups.empty")
                            } else if filteredGroups(groupCoordinator.groups).isEmpty {
                                Text("Nenhum grupo encontrado.").font(.system(size: 12)).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("groups.search-empty")
                            }
                        }
                    }
                    if !model.teams.isEmpty {
                        Section("Times", isExpanded: sectionExpansion(.teams)) {
                            ForEach(sidebarProjection.teamGroups) { group in
                                macTeamHierarchy(group, activitySnapshot: activitySnapshot)
                            }
                            if model.teams.isEmpty {
                                Text("Crie um time com um coordenador e seus bots.")
                                    .font(.system(size: 12)).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("teams.empty")
                            } else if sidebarProjection.teamGroups.isEmpty {
                                Text("Nenhum time encontrado.").font(.system(size: 12)).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("teams.search-empty")
                            }
                        }
                    }
                    Section("Bots", isExpanded: sectionExpansion(.bots)) {
                        ForEach(sidebarProjection.standaloneBots) { bot in
                            macBotRow(bot, activitySnapshot: activitySnapshot)
                                .id(DexterSidebarSelection.bot(bot.id))
                                .tag(DexterSidebarSelection.bot(bot.id))
                                .accessibilityIdentifier("bot.\(bot.id)")
                        }
                        if model.bots.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(LocalizedStringKey(model.isLoading ? "Carregando bots…" : "Nenhum bot ainda"))
                                if !model.isLoading { Text("Use + para criar um bot.").font(.system(size: 12)) }
                            }
                            .foregroundStyle(.secondary).accessibilityElement(children: .combine).accessibilityIdentifier("bots.empty")
                        } else if sidebarProjection.standaloneBots.isEmpty {
                            Text(LocalizedStringKey(botSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Os bots estão nos times acima." : "Nenhum bot encontrado."))
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                                .accessibilityIdentifier("bots.search-empty")
                        }
                    }
                }
                .listStyle(.sidebar)
                .chatSidebarList()
                .focused($isSidebarFocused)
                .onKeyPress(.leftArrow) { expandSelectedTeam(false) }
                .onKeyPress(.rightArrow) { expandSelectedTeam(true) }
                // Arrow selection already opens the destination. Return here never submits chat
                // or dispatches an approval; those actions retain their own explicit focus/routes.
                .onKeyPress(.return) { .handled }
                .help("Use ↑ e ↓ para selecionar; ← e → para recolher ou mostrar o time selecionado.")
            }
            .navigationSplitViewColumnWidth(min: 228, ideal: 264, max: 300)
            .safeAreaInset(edge: .bottom, spacing: 0) { macHostFooter }
            .navigationTitle("Dexter")
            .chatSidePanel()
        } detail: {
            macWorkspaceDetail
        }
        .navigationSplitViewStyle(.balanced)
        .chatWindowAppearance()
        .task {
            if let initialRefresh { await initialRefresh() } else { await model.refresh() }
            guard !Task.isCancelled else { return }
            initialRefreshComplete = true
        }
        .task(id: entryTrigger) { await openSelectedConversation() }
        .task(id: "first-run|\(initialRefreshComplete)|\(firstRunReviewed)|\(model.nativeComposerScope)|\(macSheet?.id ?? "none")") {
            guard initialRefreshComplete, !firstRunReviewed, macSheet == nil,
                  !model.isFixture, localHost?.acceptsLocalEnginePreference == true,
                  let address = localHost?.launchHostAddress,
                  model.isUsingThisMacBase(localAddress: address) else { return }
            presentMacSheet(.firstRun(AssistantFirstRunPresentation(
                coordinator: AssistantFirstRunCoordinator(model: model, localHost: localHost))))
        }
        .task(id: welcomeTrigger) {
            guard initialRefreshComplete, macSheet == nil,
                  firstRunReviewed || localHost?.acceptsLocalEnginePreference != true,
                  OnboardingWelcomeController.shouldPresent(model: model, store: welcomeStore) else { return }
            presentWelcome()
        }
        // Arquivo › Conectar a outra base…: one main window consumes the request and shows the sheet itself (a window
        // the menu just opened picks it up when it appears).
        .onChange(of: router?.connectOtherBaseRequest) { _, token in takeConnectOtherBaseRequest(token) }
        .onAppear { takeConnectOtherBaseRequest(router?.connectOtherBaseRequest) }
        // Settings › Geral › Mostrar boas-vindas: one main window consumes the request.
        .onChange(of: router?.welcomeRequest) { _, token in
            guard let token, router?.takeWelcomeRequest(token) == true else { return }
            presentWelcome()
            hostWindow.window?.makeKeyAndOrderFront(nil)
        }
        .task(id: "\(model.nativeComposerScope)|\(initialRefreshComplete)") {
            guard initialRefreshComplete else { return }
            if groupCoordinatorScope != model.nativeComposerScope {
                groupCoordinator = GroupConversationCoordinator(model: model)
                groupCoordinatorScope = model.nativeComposerScope
                browserUsePreflight = BrowserUseApprovalPreflight(model: model,
                    bridge: LocalHostBrowserUseKeyBridge(coordinator: localHost, model: model), keyStore: browserUseKeyStore)
            }
            await groupCoordinator?.loadGroups()
        }
        .task(id: activitySnapshot) {
            let snapshot = activitySnapshot
            var now = Int64(Date().timeIntervalSince1970 * 1_000)
            sidebarActivityNow = now
            // One finite deadline task per sidebar, never one polling timer per bot/row.
            while let next = snapshot.nextTransition(after: now) {
                do { try await Task.sleep(for: .milliseconds(next - now)) }
                catch { return }
                guard !Task.isCancelled else { return }
                now = Int64(Date().timeIntervalSince1970 * 1_000)
                sidebarActivityNow = now
            }
        }
        .onChange(of: botSearch) { _, query in
            let scope = model.nativeComposerScope
            DispatchQueue.main.async {
                guard scope == model.nativeComposerScope, query == botSearch else { return }
                sectionSearchApplied = sidebarProjection.isSearching
            }
        }
        .onChange(of: model.selectedBotID) { _, _ in
            historyScope = nil
            inspectorPopoverScope = nil
            if case .mcpAuthorization = macSheet { macSheet = nil }
        }
        .onChange(of: model.selectedTeamID) { _, _ in
            historyScope = nil; inspectorPopoverScope = nil
            if case .mcpAuthorization = macSheet { macSheet = nil }
        }
        .onChange(of: model.selectedThreadID) { _, _ in
            if case .mcpAuthorization = macSheet { macSheet = nil }
        }
        .onChange(of: model.nativeComposerScope) { _, _ in
            sidebarBotOrigin = nil; sidebarExpansion = DexterSidebarExpansion(); sectionSearchApplied = false; focusComposerOnEntry = true
            selectedGroupID = nil
            historyScope = nil
            inspectorPopoverScope = nil
            isShowingHostStatus = false
            if case .delegations = macSheet { macSheet = nil }
            if case .mcpAuthorization = macSheet { macSheet = nil }
            if case .firstRun(let item) = macSheet { item.coordinator.close(); macSheet = nil }
            if case .welcome = macSheet, welcome?.isWorking != true { macSheet = nil }
            if welcome?.isWorking != true { welcome = nil }
        }
        .onChange(of: model.hostAddress) { _, _ in
            inspectorPopoverScope = nil; isShowingHostStatus = false
            if case .delegations = macSheet { macSheet = nil }
            if case .mcpAuthorization = macSheet { macSheet = nil }
            if case .firstRun(let item) = macSheet { item.coordinator.close(); macSheet = nil }
        }
        // A conversation chosen in the bot settings window opens here, once, after that window decided about drafts.
        .onChange(of: router?.threadRequest?.token) { _, token in
            guard let token, let request = router?.takeThreadRequest(token),
                  request.hostScope == model.nativeComposerScope, request.hostAddress == model.hostAddress else { return }
            openBotSettingsThread(request.threadID, botID: request.botID)
            hostWindow.window?.makeKeyAndOrderFront(nil)
        }
        .onChange(of: model.mcpAuthorizationHandoffs.presentation?.id) { _, token in takeMcpAuthorizationRequest(token) }
        .onChange(of: model.macSetupHandoffs.presentation?.id) { _, token in takeMacSetupRequest(token) }
        .onChange(of: macSheet?.id) { _, id in
            if id == nil {
                takeMcpAuthorizationRequest(model.mcpAuthorizationHandoffs.presentation?.id)
                takeMacSetupRequest(model.macSetupHandoffs.presentation?.id)
            }
        }
        // The Dexter window that was key last presents the shared error; a sheet here still defers it as before.
        .errorAlert(model: model, isActive: Binding(get: { router.map { $0.errorPresenter == .main } ?? true }, set: { _ in }))
        .focusedSceneValue(\.dexterConversationMenu, conversationMenuActions)
        .modifier(DexterWindowRoleTracker(role: .main))
        .background(MacHostWindowReader(box: hostWindow))
        .sheet(item: $macSheet) { sheet in
            switch sheet {
            case .newBot: NewBotView()
            case .welcome:
                if let welcome {
                    OnboardingWelcomeView(controller: welcome, onFinished: { botID in
                        macSheet = nil; showingAutomations = false; selectedGroupID = nil
                        focusComposerOnEntry = true; sidebarBotOrigin = .bot(botID)
                    }, onDismiss: { macSheet = nil }, openAssistants: { macSheet = nil; openAppSettings(.assistants) }, localHost: localHost)
                }
            case .firstRun(let item):
                AssistantFirstRunChecklistView(coordinator: item.coordinator,
                    onContinue: { firstRunReviewed = true; macSheet = nil },
                    openComputerAccess: { macSheet = nil; openAppSettings(.mac) })
            case .assistantSetup(let item):
                AssistantSetupView(controller: item.controller, openComputerAccess: { openAppSettings(.mac) })
            case .mcpAuthorization(let item):
                McpConnectionsView(initialBotID: item.handoff.botId, initialServerID: item.handoff.serverId, authorizationRequest: item)
                    .accessibilityIdentifier("mcp.oauth-handoff.sheet")
            case .macSetup(let item):
                if let macAgent {
                    // Navigation only: the panel reads state; preparation stays an explicit click behind its runtime gate.
                    MacScreenControlSheet(presentation: MacScreenControlPresentation(botID: item.handoff.botId, locksBot: true,
                                                                                     hostID: item.handoff.hostId),
                                          localHost: localHost, agent: macAgent)
                        .accessibilityIdentifier("mac-setup.handoff.sheet")
                }
            case .connectOtherBase:
                ConnectOtherBaseSheet(localAddress: localHost?.launchHostAddress ?? "http://127.0.0.1:4317",
                                      suggestedName: suggestedClientName ?? ConnectOtherBaseDefaults.computerName)
            case .delegations(let bot): BotDelegationsView(bot: bot, model: model)
            case .groupEditor(let group):
                if let groupCoordinator {
                    GroupEditorView(coordinator: groupCoordinator, model: model, group: group) { saved in
                        macSheet = nil
                        if let saved { showingAutomations = false; selectedGroupID = saved.id }
                    }
                }
            }
        }
    }

    private func takeConnectOtherBaseRequest(_ token: UUID?) {
        guard let token, macSheet == nil, router?.takeConnectOtherBaseRequest(token) == true else { return }
        presentMacSheet(.connectOtherBase)
        hostWindow.window?.makeKeyAndOrderFront(nil)
    }

    /// Same claim rules as the MCP handoff: one key, active main window with no other sheet.
    private func takeMacSetupRequest(_ token: UUID?) {
        guard let token, macSheet == nil, !showingNonBotDetail, NSApplication.shared.isActive, hostWindow.window?.isKeyWindow == true,
              let request = model.macSetupHandoffs.take(token, context: model.mcpAuthorizationContext, foreground: true) else { return }
        presentMacSheet(.macSetup(request))
    }

    private func takeMcpAuthorizationRequest(_ token: UUID?) {
        guard let token, macSheet == nil, !showingNonBotDetail, NSApplication.shared.isActive, hostWindow.window?.isKeyWindow == true,
              let request = model.mcpAuthorizationHandoffs.take(token, context: model.mcpAuthorizationContext, foreground: true) else { return }
        presentMacSheet(.mcpAuthorization(request))
    }

    private var macSidebarHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Bots e times").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                MacSidebarCreateMenu(canCreateBot: model.canUseHost,
                    canCreateTeam: model.canEditTeams && (model.teams.count < Team.maximumCount || model.pendingTeamCreation != nil) && !model.bots.isEmpty,
                    canCreateGroup: groupCoordinator?.scopeMatches == true && !model.bots.isEmpty,
                    createBot: { presentMacSheet(.newBot) }, createTeam: { openTeamSettings(nil) },
                    createGroup: { presentMacSheet(.groupEditor(nil)) })
                    .frame(width: 32, height: 32)
                    .background {
                        // Retain the existing global routes while the native menu is closed.
                        HStack(spacing: 0) {
                            Button("Novo bot") { presentMacSheet(.newBot) }
                                .keyboardShortcut("n", modifiers: [.command, .shift]).disabled(!model.canUseHost)
                            Button("Novo time") { openTeamSettings(nil) }
                                .keyboardShortcut("n", modifiers: [.command, .option, .shift])
                                .disabled(!model.canEditTeams || (model.teams.count >= Team.maximumCount && model.pendingTeamCreation == nil) || model.bots.isEmpty)
                        }.frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
                    }
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                TextField("Buscar bots e times", text: $botSearch).textFieldStyle(.plain)
                    .focused($isSearchFocused)
                    .onExitCommand { botSearch = ""; isSearchFocused = false }
                    .accessibilityIdentifier("bots.search")
                if !botSearch.isEmpty {
                    Button { botSearch = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            .frame(width: 24, height: 24).contentShape(Rectangle())
                    }
                        .buttonStyle(.plain).accessibilityLabel("Limpar busca")
                        .accessibilityIdentifier("bots.search.clear")
                } else {
                    Text(verbatim: "⌘K").font(.system(size: 11)).foregroundStyle(.tertiary).accessibilityHidden(true)
                }
            }
            .font(.system(size: 13)).padding(.horizontal, 12).frame(height: 32)
            .background(DexterSurface.raisedFill, in: Capsule())
            .overlay(Capsule().strokeBorder(DexterSurface.panelStroke))
            .background {
                // ⌘K moves focus to the search; it never changes selection or opens anything.
                Button("Buscar bots e times") { isSearchFocused = true }
                    .keyboardShortcut("k", modifiers: .command)
                    .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
            }
        }.padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 8)
    }

    /// macDetail always occupies the first child position. Resizing only adds/removes the inspector,
    /// preserving ChatView identity, its composer and its existing lifecycle tasks.
    private var macWorkspaceDetail: some View {
        GeometryReader { geometry in
            let wide = geometry.size.width >= 860
            HStack(spacing: 0) {
                Group {
                    if showingAutomations {
                        AutomationsView(model: model, botID: automationBotFilter, onOpenConversation: {
                            focusComposerOnEntry = true; showingAutomations = false; historyScope = nil
                        })
                            .id("automations:\(automationBotFilter ?? "all"):\(model.nativeComposerScope)")
                    } else if let group = selectedGroup, let groupCoordinator {
                        GroupConversationView(group: group, coordinator: groupCoordinator, model: model,
                            onEdit: { presentMacSheet(.groupEditor(group)) },
                            onOpenBot: { botID in
                                guard model.bots.contains(where: { $0.id == botID }) else { return }
                                selectedGroupID = nil; focusComposerOnEntry = true; sidebarBotOrigin = .bot(botID)
                                model.selectBot(id: botID)
                            })
                            .id("group:\(group.id):\(model.nativeComposerScope)")
                    } else if selectedGroupID != nil {
                        ContentUnavailableView("Grupo indisponível", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Este grupo não está mais nesta base."))
                            .accessibilityIdentifier("group.unavailable")
                    } else { macDetail }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                if !showingNonBotDetail, wide, inspectorExpanded, model.selectedBot != nil || model.selectedTeam != nil {
                    // A floating inset panel, like the sidebar; the chat column keeps its identity beside it.
                    macSelectedInspector(onClose: { inspectorExpanded = false })
                        .frame(width: 296)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .chatInspectorPanel()
                        .padding(.vertical, 8).padding(.trailing, 8)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .toolbar {
                if !showingNonBotDetail, model.selectedBot != nil || model.selectedTeam != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            isShowingHostStatus = false
                            if wide { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { inspectorExpanded.toggle() } }
                            else { inspectorPopoverScope = inspectorPopoverScope == conversationScope ? nil : conversationScope }
                        } label: { Label(model.selectedTeam == nil ? "Detalhes do bot" : "Detalhes do time", systemImage: "sidebar.right") }
                        .accessibilityIdentifier("bot-inspector.open")
                        .accessibilityValue(wide ? (inspectorExpanded ? "Visível" : "Oculto") : (inspectorPopoverScope != nil ? "Visível" : "Oculto"))
                        .help(model.selectedTeam == nil ? "Mostrar ou ocultar os detalhes do bot" : "Mostrar ou ocultar os detalhes do time")
                        .popover(isPresented: Binding(
                            get: { !wide && inspectorPopoverScope != nil && inspectorPopoverScope == conversationScope },
                            set: { if !$0 { inspectorPopoverScope = nil } }), arrowEdge: .bottom) {
                            if inspectorPopoverScope == conversationScope {
                                macSelectedInspector(onClose: { inspectorPopoverScope = nil }).frame(width: 300, height: 560)
                            }
                        }
                    }
                }
            }
            .onChange(of: wide) { _, isWide in if isWide { inspectorPopoverScope = nil } }
        }
    }

    @ViewBuilder
    private func macSelectedInspector(onClose: @escaping () -> Void) -> some View {
        if let team = model.selectedTeam {
            TeamInspectorView(team: team, model: model, onClose: onClose,
                openEditor: { openTeamSettings(team) },
                openBotSettings: { bot in openBotSettings(bot, section: .profile) },
                openDelegations: { bot in presentMacSheet(.delegations(bot)) },
                openAutomations: { bot in
                    guard model.bots.contains(where: { $0.id == bot.id }) else { return }
                    automationBotFilter = bot.id; showingAutomations = true; selectedGroupID = nil; inspectorPopoverScope = nil
                },
                openBotAccess: { bot in openBotSettings(bot, section: .access) })
        } else if let bot = model.selectedBot { macInspector(bot, onClose: onClose) }
    }

    private func macInspector(_ bot: Bot, onClose: @escaping () -> Void) -> some View {
        let scope = conversationScope
        return MacBotInspectorView(bot: bot, model: model, onClose: onClose,
            openProfile: { if inspectorScopeIsCurrent(scope) { openBotSettings(bot, section: .profile) } },
            openMemory: { if inspectorScopeIsCurrent(scope) { openBotSettings(bot, section: .memory) } },
            openDelegations: { if inspectorScopeIsCurrent(scope) { presentMacSheet(.delegations(bot)) } },
            // UX-P1-14: this bot's connections (Ajustes do bot › Conexões), not the app-wide pane.
            openIntegrations: { if inspectorScopeIsCurrent(scope) { openBotSettings(bot, section: .mcp) } },
            showInChat: { action in
                guard inspectorScopeIsCurrent(scope), let threadID = model.presentedThreadID,
                      action.request.threadId == threadID else { return }
                approvalFocusRequest = ChatApprovalFocusRequest(actionID: action.id, threadID: threadID)
            })
    }

    private func inspectorScopeIsCurrent(_ scope: MacConversationScope?) -> Bool { scope != nil && scope == conversationScope }
    private func presentMacSheet(_ sheet: MacRootSheet) {
        guard macSheet == nil else { return }
        switch sheet {
        case .delegations(let bot):
            guard model.canEditBotProfiles, model.bots.contains(where: { $0.id == bot.id }) else { return }
        case .newBot: guard model.canUseHost else { return }
        case .welcome: guard model.canCreateFirstUseBot, welcome != nil else { return }
        case .connectOtherBase: break
        case .assistantSetup: break
        case .firstRun: break
        case .mcpAuthorization(let request): guard model.mcpAuthorizationIsCurrent(request) else { return }
        case .macSetup(let request): guard macAgent != nil, model.macSetupHandoffIsCurrent(request) else { return }
        case .groupEditor(let group):
            guard let groupCoordinator, groupCoordinator.scopeMatches,
                  group == nil || groupCoordinator.groups.contains(where: { $0.id == group?.id }) else { return }
        }
        inspectorPopoverScope = nil; isShowingHostStatus = false; macSheet = sheet
    }

    private var welcomeTrigger: String {
        "\(initialRefreshComplete)|\(firstRunReviewed)|\(macSheet?.id ?? "none")|\(model.isLoading)|\(model.bots.isEmpty)|\(model.nativeComposerScope)|\(model.canCreateFirstUseBot)"
    }

    /// Opens the welcome sheet for the current base; it never changes an existing bot, preference or conversation.
    private func presentWelcome() {
        guard model.canCreateFirstUseBot, !model.isFixture else { return }
        let controller = welcome ?? OnboardingWelcomeController(model: model, localHost: localHost, store: welcomeStore)
        controller.reopen()
        welcome = controller
        if case .welcome = macSheet { return }
        if macSheet != nil { return }
        inspectorPopoverScope = nil; isShowingHostStatus = false; macSheet = .welcome
    }

    private func prepareAssistant(_ engine: EngineID) {
        guard macSheet == nil, let controller = localHost?.makeAssistantSetupController(engine: engine, model: model) else { return }
        presentMacSheet(.assistantSetup(AssistantSetupPresentation(controller: controller)))
    }

    private var assistantPreparationAction: ((EngineID) -> Void)? {
        guard localHost?.acceptsLocalEnginePreference == true else { return nil }
        return { engine in prepareAssistant(engine) }
    }

    /// The exact bot and section, in the single bot settings window; the selected bot and conversation stay as they are.
    private func openBotSettings(_ bot: Bot, section: BotSettingsSection) {
        guard let router, model.canEditBotProfiles, model.bots.contains(where: { $0.id == bot.id }) else { return }
        inspectorPopoverScope = nil; isShowingHostStatus = false
        router.requestBotSettings(botID: bot.id, section: section, hostScope: model.nativeComposerScope, hostAddress: model.hostAddress)
        openWindow(id: DexterMacWindowID.botSettings)
    }
    private func openTeamSettings(_ team: Team?) {
        guard let router, model.canEditTeams, team == nil || model.teams.contains(where: { $0.id == team?.id }) else { return }
        inspectorPopoverScope = nil; isShowingHostStatus = false
        router.requestTeamSettings(teamID: team?.id, hostScope: model.nativeComposerScope, hostAddress: model.hostAddress)
        openWindow(id: DexterMacWindowID.teamSettings)
    }
    /// Opens the native Settings window (also ⌘,), on the given tab when one is asked for.
    private func openAppSettings(_ tab: DexterSettingsTab? = nil) {
        inspectorPopoverScope = nil; isShowingHostStatus = false
        if let tab { router?.settingsTab = tab }
        openSettings()
    }

    /// Called only after settings has saved or explicitly discarded its local drafts.
    @MainActor private func openBotSettingsThread(_ threadID: String, botID: String) {
        guard model.canUseHost, model.bots.contains(where: { $0.id == botID }) else { return }
        let host = model.nativeComposerScope, address = model.hostAddress
        let oldBot = model.selectedBotID, oldTeam = model.selectedTeamID
        let oldGeneration = model.threadPresentationGeneration
        func presentKnownThread() -> Bool {
            guard model.nativeComposerScope == host, model.hostAddress == address,
                  let thread = model.threads(for: botID).first(where: { $0.id == threadID }),
                  thread.botId == botID, thread.teamID == nil else { return false }
            focusComposerOnEntry = true; showingAutomations = false; selectedGroupID = nil
            model.selectBot(id: botID)
            // An explicit requested destination must never fall through to the latest/new opener.
            attemptedEntry = conversationScope
            if model.presentThread(threadID, for: botID) != nil {
                historyScope = nil; entryFailure = nil; entryFailureScope = nil
                return true
            }
            return false
        }
        if presentKnownThread() { return }
        // A newly created automation conversation may not be in the current projection yet.
        // Refresh is read-only and happens before selection changes; no conversation is created here.
        Task { @MainActor in
            await model.refresh()
            guard !Task.isCancelled, model.nativeComposerScope == host, model.hostAddress == address,
                  model.selectedBotID == oldBot, model.selectedTeamID == oldTeam,
                  model.threadPresentationGeneration == oldGeneration else { return }
            if !presentKnownThread() {
                model.errorMessage = locale.language.languageCode?.identifier == "pt" ? "A conversa solicitada não está disponível. Atualize o host e tente novamente." : "The requested conversation is unavailable. Refresh the host and try again."
            }
        }
    }

    @MainActor
    private func openSelectedConversation() async {
        let token = UUID()
        entryToken = token
        openingScope = nil
        guard initialRefreshComplete, !model.isLoading,
              let scope = conversationScope, historyScope != scope,
              attemptedEntry != scope, model.isFixture || model.canUseHost,
              !Task.isCancelled else { return }
        // One attempt per selection/host. Cancellation or failure never schedules a retry.
        attemptedEntry = scope
        entryFailure = nil
        entryFailureScope = nil
        openingScope = scope
        defer {
            if !Task.isCancelled && entryToken == token { openingScope = nil }
        }
        let presented: Bool
        if let teamID = scope.teamID { presented = await model.openConversationForSelectedTeam(teamID) }
        else { presented = await model.openConversationForSelectedBot(scope.botID) }
        guard !Task.isCancelled, entryToken == token, conversationScope == scope else { return }
        if !presented, let error = model.errorMessage {
            entryFailure = error
            entryFailureScope = scope
        }
    }

    private func showConversationHistory() {
        historyScope = conversationScope
        model.closeThreadPresentation()
    }

    /// Arquivo › Nova conversa (⌘N) and Visualizar › Conversas anteriores (⌘[) for this window: the ⋯ item's and the
    /// Conversas button's own callbacks and gates. Nothing while automations or one of this window's sheets is open.
    private var conversationMenuActions: DexterConversationMenuActions? {
        guard !showingNonBotDetail, macSheet == nil, let bot = model.selectedBot, let scope = conversationScope else { return nil }
        let showingHistory = historyScope == scope
        return DexterConversationMenuActions(
            canCreateConversation: (model.presentedThreadID != nil || showingHistory)
                && !isCreatingConversation && !model.isSubmitting && model.canUseHost,
            isCreatingConversation: isCreatingConversation,
            canShowConversations: !showingHistory,
            createConversation: { createConversation(for: bot.id) },
            showConversations: { showConversationHistory() })
    }

    @MainActor
    private func createConversation(for botID: String) {
        guard !isCreatingConversation, !model.isSubmitting, model.canUseHost,
              model.selectedBotID == botID else { return }
        focusComposerOnEntry = true
        isCreatingConversation = true
        let hostScope = model.nativeComposerScope
        let generation = model.threadPresentationGeneration
        let teamID = model.selectedTeamID
        let previousThreadIDs = Set(model.conversationThreads.map(\.id))
        Task {
            defer { isCreatingConversation = false }
            if let teamID {
                let opened = await model.openConversationForSelectedTeam(teamID, createNew: true)
                if opened, model.selectedTeamID == teamID, model.nativeComposerScope == hostScope { historyScope = nil }
                return
            }
            await model.createThread(for: botID)
            guard !Task.isCancelled, model.errorMessage == nil,
                  model.nativeComposerScope == hostScope,
                  model.threadPresentationGeneration == generation &+ 1,
                  model.selectedBotID == botID, let thread = model.selectedThread,
                  thread.botId == botID, !previousThreadIDs.contains(thread.id) else { return }
            if model.presentThread(thread.id, for: botID) != nil { historyScope = nil }
        }
    }

    private func retryConversationEntry() {
        guard openingScope != conversationScope, !model.isLoading else { return }
        attemptedEntry = nil
        entryRevision &+= 1
    }

    /// Approvals waiting in the conversation open now. Other conversations are not read for the sidebar.
    private func waitingApprovals(teamID: String?, botID: String?) -> Int {
        guard !showingNonBotDetail, let threadID = model.presentedThreadID else { return 0 }
        if let teamID { guard model.selectedTeamID == teamID else { return 0 } }
        else { guard model.selectedTeamID == nil, model.selectedBotID == botID else { return 0 } }
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        return model.actions(for: threadID).filter { ApprovalPresentation(action: $0).needsDecision(atMilliseconds: now) }.count
    }

    private func waitingLine() -> some View {
        HStack(spacing: 5) {
            Circle().fill(DexterSurface.attention).frame(width: 6, height: 6).accessibilityHidden(true)
            Text("Aguardando sua aprovação").lineLimit(1)
        }
        .font(.system(size: 12)).foregroundStyle(DexterSurface.attention)
    }

    private func macBotRow(_ bot: Bot, membership: String? = nil, teamName: String? = nil, activitySnapshot: BotSidebarActivitySnapshot) -> some View {
        let waiting = membership == nil ? waitingApprovals(teamID: nil, botID: bot.id) : 0
        let activity = activitySnapshot.activity(for: bot.id, at: sidebarActivityNow)
        let status = activitySnapshot.statusLabel(for: bot.id, at: sidebarActivityNow,
            portuguese: locale.language.languageCode?.identifier == "pt")
        return HStack(spacing: 10) {
            DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                             fallbackSystemImage: EngineSymbol.systemName(bot.engine.rawValue), model: model, size: membership == nil ? 32 : 26,
                             appearance: bot.avatarAppearance, activity: activity, showsActivityIndicator: true,
                             isActivityObserved: activitySnapshot.botID == bot.id, mascotSeed: bot.id)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(bot.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    if bot.isMaster {
                        Image(systemName: "star.fill")
                            .font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel("Master")
                    }
                    Spacer(minLength: 0)
                }
                if waiting > 0 {
                    waitingLine()
                } else {
                    Text(verbatim: activity == .idle
                        ? (membership.map { "\($0) · \(bot.engine.displayName)" } ?? (bot.roleDescription.isEmpty ? bot.engine.displayName : bot.roleDescription))
                        : (membership.map { "\($0) · \(status)" } ?? status))
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if waiting > 0 { DexterCountBadge(count: waiting).accessibilityLabel(Text(verbatim: DexterLocalization.format("Aprovações pendentes: %@", "\(waiting)", locale: locale))) }
        }
        .frame(minHeight: membership == nil ? 40 : 32)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(verbatim: teamName.map { team in
            let role = membership ?? DexterLocalization.text("Bot", locale: locale)
            return String(localized: "\(bot.name), \(role) do time \(team). \(bot.roleDescription). Abrir conversa privada do bot.")
        } ?? String(localized: "\(bot.name), \(bot.roleDescription.isEmpty ? bot.engine.displayName : bot.roleDescription). Abrir conversa do bot.")))
        .accessibilityValue(Text(verbatim: status))
        .help(teamName.map { "\(bot.name) · \($0) · \(bot.roleDescription) · Abrir conversa privada do bot" } ?? "Abrir conversa do bot")
        .contextMenu {
            Button { openBotSettings(bot, section: .profile) } label: { Label("Ajustes do bot", systemImage: "gearshape") }
                .disabled(!model.canEditBotProfiles)
            Button { openBotSettings(bot, section: .memory) } label: { Label("Memória e instruções", systemImage: "brain") }
                .disabled(!model.canEditBotProfiles)
            Button { openBotSettings(bot, section: .access) } label: { Label("Acessos", systemImage: "shield.lefthalf.filled") }
                .disabled(!model.canEditBotProfiles)
            Button { presentMacSheet(.delegations(bot)) } label: { Label("Chamadas entre bots", systemImage: "arrow.triangle.branch") }
                .disabled(!model.canEditBotProfiles)
            Button { automationBotFilter = bot.id; showingAutomations = true; selectedGroupID = nil; inspectorPopoverScope = nil } label: { Label("Automações", systemImage: "calendar.badge.clock") }
                .disabled(!model.canEditBotProfiles)
        }
    }

    @ViewBuilder
    private func macTeamHierarchy(_ group: DexterSidebarProjection.TeamGroup, activitySnapshot: BotSidebarActivitySnapshot) -> some View {
        let team = group.team
        let expanded = sidebarExpansion.isExpanded(teamID: team.id, searching: sidebarProjection.isSearching)
        HStack(spacing: 5) {
            Button {
                sidebarExpansion.setExpanded(!expanded, teamID: team.id, searching: sidebarProjection.isSearching)
            } label: {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).frame(width: 20, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(sidebarProjection.isSearching)
            .accessibilityLabel(expanded ? "Recolher time" : "Expandir time")
            .accessibilityValue(expanded ? "Expandido" : "Recolhido")
            .accessibilityIdentifier("sidebar.team.\(team.id).expand")
            .help(sidebarProjection.isSearching ? "Limpe a busca para recolher este time" : (expanded ? "Recolher coordenador e membros" : "Mostrar coordenador e membros"))
            Button { selectedSidebarBinding.wrappedValue = .team(team.id) } label: {
                macTeamRow(team, activitySnapshot: activitySnapshot).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: DexterLocalization.format("%@, Time. Abrir conversa do time.", team.name, locale: locale)))
            .accessibilityValue(Text(verbatim: activitySnapshot.statusLabel(for: team.coordinatorBotId, at: sidebarActivityNow,
                portuguese: locale.language.languageCode?.identifier == "pt")))
            .accessibilityIdentifier("sidebar.team.\(team.id)")
            .help("Abrir conversa do time \(team.name)")
        }
        .accessibilityElement(children: .contain)
        .id(DexterSidebarSelection.team(team.id))
        .tag(DexterSidebarSelection.team(team.id))
        if expanded {
            if let coordinator = group.coordinator {
                macBotRow(coordinator, membership: DexterLocalization.text("Coordenador", locale: locale), teamName: team.name, activitySnapshot: activitySnapshot)
                    .padding(.leading, 30)
                    .id(DexterSidebarSelection.teamBot(teamID: team.id, botID: coordinator.id))
                    .tag(DexterSidebarSelection.teamBot(teamID: team.id, botID: coordinator.id))
                    .accessibilityIdentifier("sidebar.team.\(team.id).bot.\(coordinator.id)")
            } else {
                Text("Coordenador indisponível").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.leading, 30).accessibilityIdentifier("sidebar.team.\(team.id).coordinator-unavailable")
            }
            ForEach(group.members) { bot in
                macBotRow(bot, membership: DexterLocalization.text("Membro", locale: locale), teamName: team.name, activitySnapshot: activitySnapshot)
                    .padding(.leading, 30)
                    .id(DexterSidebarSelection.teamBot(teamID: team.id, botID: bot.id))
                    .tag(DexterSidebarSelection.teamBot(teamID: team.id, botID: bot.id))
                    .accessibilityIdentifier("sidebar.team.\(team.id).bot.\(bot.id)")
            }
        }
    }

    private func teamMembers(_ team: Team) -> [Bot] {
        var seen = Set<String>()
        let ordered = ([team.coordinatorBotId].compactMap { $0 } + team.botIds).filter { seen.insert($0).inserted }
        return ordered.compactMap { id in model.bots.first { $0.id == id } }
    }

    private func macTeamRow(_ team: Team, activitySnapshot: BotSidebarActivitySnapshot) -> some View {
        let waiting = waitingApprovals(teamID: team.id, botID: nil)
        let selected = selectedSidebarBinding.wrappedValue == .team(team.id)
        let activity = team.coordinatorBotId.map { activitySnapshot.activity(for: $0, at: sidebarActivityNow) } ?? .idle
        return HStack(spacing: 10) {
            DexterTeamAvatar(team: team, members: Array(teamMembers(team).prefix(3)), model: model, size: 32,
                             ring: selected ? Color.accentColor : DexterSurface.avatarRing, activity: activity,
                             memberActivities: Dictionary(uniqueKeysWithValues: teamMembers(team).filter { activitySnapshot.botID == $0.id }
                                .map { ($0.id, activitySnapshot.activity(for: $0.id, at: sidebarActivityNow)) }),
                             showsActivityIndicator: true)
            VStack(alignment: .leading, spacing: 1) {
                Text(team.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                if waiting > 0 {
                    waitingLine()
                } else {
                    Text(verbatim: activity == .idle ? (team.roleDescription.isEmpty ? "\(team.botIds.count) bots" : team.roleDescription)
                        : activity.label(portuguese: locale.language.languageCode?.identifier == "pt"))
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if waiting > 0 { DexterCountBadge(count: waiting, onAccent: selected).accessibilityLabel(Text(verbatim: DexterLocalization.format("Aprovações pendentes: %@", "\(waiting)", locale: locale))) }
        }.frame(minHeight: 40).padding(.vertical, 3)
        .contextMenu {
            Button { openTeamSettings(team) } label: { Label("Ajustes do time", systemImage: "gearshape") }
                .disabled(!model.canEditTeams)
        }
    }

    private func footerRow(_ title: LocalizedStringKey, systemImage: String, selected: Bool = false) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).frame(width: 18).foregroundStyle(selected ? Color.accentColor : Color.secondary)
            Text(title).lineLimit(1)
            Spacer(minLength: 0)
        }
        .font(.system(size: 13))
        .foregroundStyle(selected ? Color.accentColor : Color.primary)
        .padding(.horizontal, 10).frame(minHeight: 34)
        .background(selected ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
    }

    private var hostStatusTint: Color {
        model.isFixture ? Color.secondary : (model.isOnline && model.canUseHost ? Color.green : DexterSurface.attention)
    }

    /// Codync-clean footer: Automações, the base status, Ajustes and one "Conectar apps" entry to the real Conexões pane.
    /// Memória stays one click away in the inspector and the bot's context menu.
    private var macHostFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                automationBotFilter = nil; showingAutomations = true; selectedGroupID = nil; inspectorPopoverScope = nil; isShowingHostStatus = false
            } label: {
                footerRow("Automações", systemImage: "calendar.badge.clock", selected: showingAutomations)
            }
            .accessibilityIdentifier("sidebar.automations")
            .accessibilityAddTraits(showingAutomations ? [.isSelected] : [])
            .help("Abrir automações de todos os bots deste host")
            Divider().padding(.horizontal, 8).padding(.vertical, 4)
            // Plain base status (UX-P0-02): "Neste Mac · conectado", never "development" or an inference claim.
            Button { inspectorPopoverScope = nil; isShowingHostStatus = true } label: {
                HStack(spacing: 8) {
                    Circle().fill(hostStatusTint).frame(width: 8, height: 8).accessibilityHidden(true)
                    Text(DexterLocalization.text(model.backendLabel, locale: locale))
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).frame(minHeight: 26).contentShape(Rectangle())
            }
            .accessibilityLabel(Text(verbatim: DexterLocalization.text(model.backendLabel, locale: locale)))
            .accessibilityHint("Mostra o estado da base")
            .accessibilityIdentifier("host.status")
            .popover(isPresented: $isShowingHostStatus, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Estado da base").font(.headline)
                    Text(DexterLocalization.text(model.backendLabel, locale: locale))
                    HStack(spacing: 12) {
                        Button { openAppSettings(.advanced) } label: {
                            Label("Diagnóstico", systemImage: "stethoscope")
                        }
                        .accessibilityIdentifier("host.status.diagnostics")
                        Button { openAppSettings() } label: {
                            Label("Ajustes", systemImage: "gearshape")
                        }
                    }
                }
                .padding(20)
                .frame(width: 300, alignment: .leading)
            }
            HStack(spacing: 8) {
                Button { openAppSettings() } label: {
                    Image(systemName: "gearshape").font(.system(size: 15)).foregroundStyle(.secondary)
                        .frame(width: 34, height: 34)
                        .background(DexterSurface.chipFill, in: Circle())
                        .contentShape(Circle())
                }
                .help("Abrir Ajustes (⌘,)")
                .accessibilityLabel("Ajustes")
                .accessibilityIdentifier("settings.open")
                Button { openAppSettings(.connections) } label: {
                    Label("Conectar apps", systemImage: "link")
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(DexterSurface.chipFill, in: Capsule())
                        .overlay(Capsule().strokeBorder(DexterSurface.panelStroke))
                        .contentShape(Capsule())
                }
                .help("Abrir Ajustes › Conexões")
                .accessibilityIdentifier("sidebar.connect-apps")
            }
            .padding(.horizontal, 6)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 10)
    }

    /// Empty base (Codync reference): one sentence and one action. "Começar" opens the welcome sheet on the owner's base.
    private var emptyWorkspace: some View {
        VStack(spacing: 14) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable().frame(width: 72, height: 72).accessibilityHidden(true)
            Text("Seus assistentes, prontos para conversar.").font(.title2.weight(.semibold))
            Text("Escolha um assistente e comece. Navegador, apps e este Mac ficam para quando você precisar.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary).frame(maxWidth: 420)
            if model.canCreateFirstUseBot {
                Button("Começar") { presentWelcome() }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .accessibilityIdentifier("workspace.empty.start")
            } else {
                Button("Novo bot") { presentMacSheet(.newBot) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(!model.canUseHost)
                    .accessibilityIdentifier("workspace.empty.new-bot")
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("workspace.empty")
    }

    @ViewBuilder
    private var macDetail: some View {
        if !initialRefreshComplete || (model.isLoading && model.selectedBot == nil) {
            ProgressView("Conectando ao host local…")
        } else if let bot = model.selectedBot {
            if let threadID = model.presentedThreadID {
                VStack(spacing: 0) {
                    ChatView(threadID: threadID, presentationGeneration: model.threadPresentationGeneration,
                        shouldFocusComposerOnEntry: { focusComposerOnEntry && !isSidebarFocused },
                        openBotAccess: { botID in
                            // Only the action's own bot, from the current host projection; never another bot.
                            if let target = model.bots.first(where: { $0.id == botID }) { openBotSettings(target, section: .access) }
                        },
                        openBotModel: { botID in
                            if let target = model.bots.first(where: { $0.id == botID }) { openBotSettings(target, section: .model) }
                        }, prepareAssistant: assistantPreparationAction,
                        browserUsePreflight: browserUsePreflight, approvalFocusRequest: approvalFocusRequest).id(threadID)
                }
                    // The menu bar (DexterMacCommands) carries ⌘N and ⌘[; the shortcuts below repeat them, e.g. on the ⋯ item.
                    .toolbar {
                        ToolbarItem(placement: .navigation) {
                            Button { showConversationHistory() } label: { Label("Conversas", systemImage: "chevron.backward") }
                                .keyboardShortcut("[", modifiers: .command)
                                .accessibilityIdentifier("thread.back")
                        }
                        if let team = model.selectedTeam {
                            ToolbarItem(placement: .primaryAction) {
                                Button { openTeamSettings(team) } label: { Label("Ajustes do time", systemImage: "person.3") }
                                    .disabled(!model.canEditTeams)
                                    .help("Abrir os ajustes do time \(team.name)")
                                    .accessibilityIdentifier("team.settings.open")
                            }
                        }
                        ToolbarItem(placement: .primaryAction) {
                            // Nova conversa is a separate conversation, not a new session of this one: it lives in ⋯.
                            Menu {
                                Button { createConversation(for: bot.id) } label: {
                                    Label(LocalizedStringKey(isCreatingConversation ? "Criando conversa…" : "Nova conversa"), systemImage: "plus.bubble")
                                }
                                .disabled(isCreatingConversation || model.isSubmitting || !model.canUseHost)
                                .keyboardShortcut("n", modifiers: .command)
                                .accessibilityIdentifier("thread.create")
                                Text("Abre uma conversa separada, com histórico próprio.")
                            } label: {
                                Label("Mais opções da conversa", systemImage: "ellipsis.circle")
                            }
                            .menuIndicator(.hidden)
                            .help("Mais opções da conversa. Nova conversa: ⌘N. Conversas anteriores: ⌘[.")
                            .accessibilityIdentifier("conversation.more")
                        }
                    }
            } else if historyScope == conversationScope {
                if let team = model.selectedTeam {
                    TeamThreadsView(team: team, model: model, onSelectThread: {
                        focusComposerOnEntry = true
                        if model.presentTeamThread($0, teamID: team.id) != nil { historyScope = nil }
                    }, createConversation: { createConversation(for: bot.id) })
                    .id(team.id)
                } else {
                    BotThreadsView(bot: bot, onSelectThread: {
                        focusComposerOnEntry = true
                        if model.presentThread($0, for: bot.id) != nil { historyScope = nil }
                    }, createConversation: { createConversation(for: bot.id) },
                    isCreatingConversation: isCreatingConversation).id(bot.id)
                }
            } else {
                VStack(spacing: 12) {
                    if !initialRefreshComplete || model.isLoading || openingScope == conversationScope {
                        ProgressView("Carregando conversa…")
                    } else if entryFailureScope == conversationScope, let error = entryFailure {
                        Label(DexterLocalization.text(error, locale: locale), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                        Button("Tentar novamente", action: retryConversationEntry)
                            .disabled(!model.canUseHost)
                            .accessibilityIdentifier("conversation.retry")
                    } else if !model.canUseHost || !model.isOnline {
                        Label("Host indisponível", systemImage: "wifi.slash")
                            .foregroundStyle(.secondary)
                        Button("Ajustes") { openAppSettings() }
                    } else {
                        Label("Conversa", systemImage: "text.bubble")
                            .foregroundStyle(.secondary)
                    }
                    Button("Conversas") { showConversationHistory() }
                }
                .multilineTextAlignment(.center)
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle(model.selectedTeam?.name ?? bot.name)
                .accessibilityIdentifier("conversation.opening")
            }
        } else if let team = model.selectedTeam {
            VStack(spacing: 12) {
                ContentUnavailableView("Coordenador indisponível", systemImage: "person.crop.circle.badge.questionmark",
                    description: Text("Escolha um coordenador entre os membros deste time para abrir sua conversa."))
                Button("Ajustes do time") { openTeamSettings(team) }
            }.navigationTitle(team.name)
        } else {
            emptyWorkspace
        }
    }

    #endif

    #if os(iOS)
    private var phoneRoot: some View {
        NavigationStack(path:$phonePath) {
            Group {
            if !model.isFixture && !model.canUseHost {
                IOSMacConnectionView()
            } else {
            List {
                Section("Conexão") {
                    Label(DexterLocalization.text(model.backendLabel, locale: locale), systemImage: model.isFixture ? "rectangle.on.rectangle" : (model.isOnline ? "checkmark.circle.fill" : "wifi.slash"))
                    Text(DexterLocalization.text(model.inferenceLabel, locale: locale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("No iPhone") {
                    NavigationLink(value: DexterRoute.capabilities) {
                        Label("Capacidades no dispositivo", systemImage: "hand.raised.square")
                    }
                    .accessibilityIdentifier("ios-capabilities.open")
                }
                if !nativeActions.router.status.label.isEmpty {
                    Section("Solicitação do app") { Text(DexterLocalization.text(nativeActions.router.status.label, locale: locale)).font(.caption) }
                }
                Section("Bots") {
                    if model.bots.isEmpty {
                        Text(LocalizedStringKey(model.isLoading ? "Carregando bots…" : "Nenhum bot neste host."))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("bots.empty")
                    }
                    ForEach(model.bots) { bot in
                        NavigationLink(value: DexterRoute.bot(bot.id)) {
                            Label(bot.name, systemImage: EngineSymbol.systemName(bot.engine.rawValue))
                        }
                        .accessibilityIdentifier("bot.\(bot.id)")
                    }
                }
            }
            }
            }
            .navigationTitle("Dexter")
            .navigationDestination(for: DexterRoute.self) { route in
                switch route {
                case .capabilities:
                    IOSForegroundCapabilitiesView()
                case .bot(let botID):
                    if let bot = model.bots.first(where: { $0.id == botID }) { BotThreadsView(bot: bot) }
                    else { ContentUnavailableView("Bot indisponível", systemImage: "questionmark.folder") }
                case .thread(let botID, let threadID):
                    ChatView(threadID: threadID, routeBotID: botID)
                }
            }
            .toolbar {
                #if os(iOS)
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { isShowingNewBot = true } label: { Label("Novo bot", systemImage: "plus") }
                        .disabled(!model.canUseHost)
                        .accessibilityIdentifier("bot.create")
                    Button { isShowingSettings = true } label: { Label("Ajustes", systemImage: "gearshape") }
                        .accessibilityIdentifier("settings.open")
                }
                #else
                ToolbarItemGroup(placement: .automatic) {
                    Button { isShowingNewBot = true } label: { Label("Novo bot", systemImage: "plus") }
                        .disabled(!model.canUseHost)
                        .accessibilityIdentifier("bot.create")
                    Button { isShowingSettings = true } label: { Label("Ajustes", systemImage: "gearshape") }
                        .accessibilityIdentifier("settings.open")
                }
                #endif
            }
        }
        .task {
            await model.restorePairedHostAtLaunch()
            await model.refresh()
            nativeActions.router.attach(model)
            nativeActions.router.setForeground(scenePhase == .active,scene:nativeSceneID)
        }
        .task(id: model.canUseHost) {
            // Approval may complete in the onboarding observer, which is cancelled as this root switches to bots.
            // The root owns this read so that cancelling the old view cannot leave a real connection with no projection.
            if model.canUseHost { await model.refresh() }
        }
        .onChange(of:phonePath) { _, path in
            guard let draft = model.nativeActionDraft else { return }
            if case .thread(_,let threadID) = path.last, threadID == draft.threadID { return }
            model.clearNativeActionDraft()
        }
        .onChange(of:scenePhase) { _, phase in nativeActions.router.setForeground(phase == .active,scene:nativeSceneID) }
        .onChange(of:nativeActions.router.navigationVersion) { _, _ in
            guard nativeActions.router.ownsScene(nativeSceneID) else { return }
            switch nativeActions.router.navigation {
            case .chooseConversation: phonePath = []
            case .thread(let destination): phonePath = [.bot(destination.botID),.thread(destination.botID,destination.threadID)]
            case nil: break
            }
        }
        .onDisappear { nativeActions.router.setForeground(false,scene:nativeSceneID) }
        .errorAlert(model: model)
        .sheet(isPresented: $isShowingSettings) { SettingsView() }
        .sheet(isPresented: $isShowingNewBot) { NewBotView() }
    }

    #endif

    private var selectedBotBinding: Binding<String?> {
        Binding(get: { model.selectedBotID }, set: {
            #if os(macOS)
            if model.selectedBotID != $0 {
                // Reset before publishing selection, so a scheduled entry task cannot race this reset.
                attemptedEntry = nil
                historyScope = nil
            }
            #endif
            model.selectBot(id: $0)
        })
    }
}

private struct BotThreadsView: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    let bot: Bot
    /// macOS passes a closure so selection is plain state in the split detail; iOS keeps value links.
    var onSelectThread: ((String) -> Void)? = nil
    /// macOS: the root's Nova conversa (⋯ item, Arquivo › Nova conversa ⌘N) and its in-flight gate.
    var createConversation: (() -> Void)? = nil
    var isCreatingConversation = false
    @State private var historyFailure: String?
    @State private var rowSelection = DexterThreadListSelection()
    @FocusState private var isListFocused: Bool

    private var threadIDs: [String] { model.threads(for: bot.id).map(\.id) }
    private var rowBinding: Binding<String?> {
        Binding(get: { rowSelection.selectedID }, set: { rowSelection.select($0, in: threadIDs) })
    }
    private func activateSelection() {
        if let id = rowSelection.activation(in: threadIDs) { onSelectThread?(id) }
    }
    #if os(macOS)
    var body: some View {
        ConversationHistoryList(ownerName: bot.name,
            items: model.threadHistoryRows(for: bot.id).map { ConversationHistoryItem(row: $0, botName: bot.name) }, idPrefix: "thread", canCreate: createConversation != nil && !model.isSubmitting && model.canUseHost,
            creating: isCreatingConversation, loading: model.isLoading, failure: historyFailure,
            create: { createConversation?() }, activate: { onSelectThread?($0) })
            .id("\(model.nativeComposerScope):\(bot.id)")
            .task(id: "\(model.nativeComposerScope):\(bot.id)") {
                do { try await model.reloadPrivateThreadHistory(botID: bot.id); historyFailure = nil }
                catch { if !Task.isCancelled { historyFailure = String(localized: "Não foi possível carregar as conversas.") } }
            }
    }
    #else
    var body: some View {
        List(selection: onSelectThread == nil ? nil : rowBinding) {
            Section("Conversas") {
                ForEach(model.threads(for: bot.id)) { thread in
                    if let onSelectThread {
                        #if os(macOS)
                        HStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                                .frame(width: 40, height: 40)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                            VStack(alignment: .leading, spacing: 4) {
                                // Title and last activity are not in the host contract yet; only the creation date is real.
                                Text("Conversa").font(.headline)
                                Text("Criada em \(thread.createdAt.formattedDate)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .tag(thread.id)
                            .onTapGesture {
                                rowSelection.select(thread.id, in: threadIDs)
                                onSelectThread(thread.id)
                            }
                            .accessibilityIdentifier("thread.\(thread.id)")
                        #else
                        Label("Conversa · \(thread.createdAt.formattedDate)", systemImage: "bubble.left.and.bubble.right")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .tag(thread.id)
                            .onTapGesture {
                                rowSelection.select(thread.id, in: threadIDs)
                                onSelectThread(thread.id)
                            }
                            .accessibilityIdentifier("thread.\(thread.id)")
                        #endif
                    } else {
                        NavigationLink(value: DexterRoute.thread(bot.id, thread.id)) {
                            Label("Conversa · \(thread.createdAt.formattedDate)", systemImage: "bubble.left.and.bubble.right")
                        }
                        .accessibilityIdentifier("thread.\(thread.id)")
                    }
                }
                if model.threads(for: bot.id).isEmpty {
                    ContentUnavailableView("Sem conversas", systemImage: "text.bubble", description: Text("Inicie uma conversa com este bot."))
                        .listRowSeparator(.hidden)
                } else {
                    #if os(macOS)
                    Text("Título e última atividade das conversas ainda não são informados pela base.")
                        .font(.caption).foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("thread.titles-pending")
                    #endif
                }
            }
        }
        #if os(macOS)
        .focusable()
        .focused($isListFocused)
        .onAppear { isListFocused = true }
        .onChange(of: threadIDs) { _, ids in rowSelection.reconcile(in: ids) }
        .onKeyPress(.upArrow) { rowSelection.move(-1, in: threadIDs); return .handled }
        .onKeyPress(.downArrow) { rowSelection.move(1, in: threadIDs); return .handled }
        .onKeyPress(.return) { activateSelection(); return .handled }
        #endif
        .navigationTitle(bot.name)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                #if os(macOS)
                // One creator per window: the same callback and gates as ⋯ › Nova conversa; ⌘N is the menu bar's.
                Button { createConversation?() } label: { Label("Nova conversa", systemImage: "plus.bubble") }
                    .disabled(createConversation == nil || isCreatingConversation || model.isSubmitting || !model.canUseHost)
                    .accessibilityIdentifier("thread.create")
                #else
                Button { Task { await model.createThread(for: bot.id) } } label: { Label("Nova conversa", systemImage: "plus.bubble") }
                    .disabled(!model.canUseHost)
                    .accessibilityIdentifier("thread.create")
                #endif
            }
        }
        .navigationDestination(for: DexterRoute.self) { route in
            if case .thread(let botID, let threadID) = route { ChatView(threadID: threadID, routeBotID: botID) }
        }
    }
    #endif
}

private extension Int64 {
    var formattedDate: String {
        Date(timeIntervalSince1970: TimeInterval(self) / 1_000).formatted(date: .abbreviated, time: .shortened)
    }
}
