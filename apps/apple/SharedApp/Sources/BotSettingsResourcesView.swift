#if os(macOS)
import DexterAppCore
import DexterHostClient
import Observation
import SwiftUI

/// The profile sheet retains this editor. Section navigation does not discard MCP selections.
/// All requests stay on the original owner-local host and bot; global resources are read-only here.
@MainActor @Observable
final class BotSettingsResourcesEditor {
    let botID: String
    let model: DexterAppModel
    let hostScope: UUID
    let hostAddress: String
    /// The settings window's session (nil only outside a window); every request is checked against it.
    let session: SettingsEditorSession?
    private let clientFactory: (@MainActor () -> HostClient?)?
    private var client: HostClient?
    private var active = true
    private var generation = UUID()
    private var requestTask: Task<Void, Never>?
    private(set) var busy = false
    private(set) var notice: String?

    private(set) var skills: [SkillLock] = []
    private(set) var skillNext: String?
    private var skillCursors: Set<String> = []
    private(set) var botSkills: [SkillActivation] = []
    private(set) var globalSkills: [SkillActivation] = []
    private(set) var skillContent: SkillVersion?
    private(set) var skillsLoaded = false
    private(set) var skillsNeedRefresh = false
    var selectedSkillIdentity = ""

    private(set) var servers: [McpServerSummary] = []
    /// Saved tool count of THIS bot per connection, read from the host; missing = not confirmed.
    private(set) var serverToolCounts: [String: Int] = [:]
    private(set) var selectedServerID = ""
    private(set) var tools: [McpToolSummary] = []
    private(set) var credentialStatus: McpCredentialStatus?
    private(set) var mcpLoaded = false
    private(set) var mcpSelectionReady = false
    private(set) var mcpNeedsReconcile = false
    private var originalToolIDs: Set<String> = []
    var selectedToolIDs: Set<String> = []

    private(set) var accessLoaded = false
    private(set) var historyLoaded = false
    private(set) var historyThreads: [HostThread] = []
    private(set) var historyActions: [Action] = []
    private(set) var delegations: [BotDelegation] = []
    private(set) var delegationUnavailable = false

    init(botID: String, model: DexterAppModel, session: SettingsEditorSession? = nil, clientFactory: (@MainActor () -> HostClient?)? = nil) {
        self.botID = botID; self.model = model; self.session = session
        hostScope = session?.hostScope ?? model.nativeComposerScope; hostAddress = session?.hostAddress ?? model.hostAddress
        self.clientFactory = clientFactory
    }

    var scopeMatches: Bool {
        active && hostScope == model.nativeComposerScope && hostAddress == model.hostAddress &&
            model.canEditBotProfiles && model.bots.contains(where: { $0.id == botID }) && (session?.isCurrent(in: model) ?? true)
    }

    /// One request per call, checked against the window's session before and after it (a late write stays
    /// unconfirmed and is never replayed).
    private func call<Value: Sendable>(_ kind: SettingsEditorSession.OperationKind, _ client: HostClient,
                                       _ operation: @MainActor (HostClient) async throws -> Value) async throws -> Value {
        guard let session else { return try await operation(client) }
        // In a window, the request uses the client the session hands over for this one call (an injected
        // fixture client is kept for previews/tests); the session is checked before and after it.
        let injected = clientFactory != nil
        return try await session.perform(in: model, kind: kind) { current in try await operation(injected ? client : current) }
    }
    var dirty: Bool { mcpSelectionReady && selectedToolIDs != originalToolIDs }
    var selectedSkill: SkillLock? { skills.first { $0.identity == selectedSkillIdentity } }
    var selectedServer: McpServerSummary? { servers.first { $0.id == selectedServerID } }
    var canMutateSkills: Bool { scopeMatches && skillsLoaded && !busy && !skillsNeedRefresh }
    var canSaveMcp: Bool { scopeMatches && mcpSelectionReady && dirty && !busy && !mcpNeedsReconcile }
    var grantRows: [DeviceGrantRow] {
        guard scopeMatches, model.grantBotID == botID else { return [] }
        return model.grantRows.filter { $0.botID == botID }
    }
    var canMutateGrants: Bool {
        scopeMatches && !busy && !model.isLoadingGrants && model.grantBotID == botID && model.operatingGrantID == nil
    }

    func close(clearDrafts: Bool = false) {
        active = false; generation = UUID(); requestTask?.cancel(); requestTask = nil
        client?.close(); client = nil; busy = false
        if clearDrafts {
            skills = []; botSkills = []; globalSkills = []; skillContent = nil; skillNext = nil
            selectedSkillIdentity = ""; skillsLoaded = false; skillCursors = []
            servers = []; serverToolCounts = [:]; selectedServerID = ""; tools = []; credentialStatus = nil
            originalToolIDs = []; selectedToolIDs = []; mcpLoaded = false; mcpSelectionReady = false
            historyThreads = []; historyActions = []; delegations = []; historyLoaded = false; accessLoaded = false
        }
    }
    /// The window's base changed: requests stop, drafts stay (the window shows them frozen, read-only).
    func invalidate() {
        close()
        notice = String(localized: "A conexão com a base mudou. Esta janela não lê nem salva mais; os rascunhos foram mantidos.")
    }
    private func check(_ token: UUID) throws {
        guard token == generation, !Task.isCancelled else { throw CancellationError() }
        guard scopeMatches else { invalidate(); throw CancellationError() }
    }
    private func ensureClient() -> HostClient? {
        guard scopeMatches else { return nil }
        if client == nil {
            if let clientFactory { client = clientFactory() }
            else { client = model.makeLocalMcpClient() }
        }
        return client
    }
    private func perform(_ operation: @escaping @MainActor (HostClient, UUID) async throws -> Void) {
        guard !busy, let client = ensureClient() else { return }
        busy = true; notice = nil
        let token = generation
        requestTask = Task { @MainActor in
            do { try await operation(client, token); try check(token) }
            catch {
                guard token == generation, !Task.isCancelled else { return }
                guard scopeMatches else { invalidate(); return }
                if notice == nil { notice = String(localized: "Não foi possível confirmar a consulta. Os dados anteriores foram mantidos; confira a conexão e atualize.") }
            }
            guard token == generation else { return }
            busy = false; requestTask = nil
        }
    }

    private func activations(_ client: HostClient, scope: SkillScope, token: UUID) async throws -> [SkillActivation] {
        var result: [SkillActivation] = [], cursor: String?, seen: Set<String> = []
        let deadline = Date().addingTimeInterval(30)
        for _ in 0..<20 {
            try check(token); guard Date() < deadline else { throw HostClientError.notReady }
            let page = try await call(.read, client) { try await $0.listSkillActivations(scope: scope, after: cursor) }; try check(token)
            guard page.items.allSatisfy({ item in !result.contains { $0.skillId == item.skillId } }) else { throw HostClientError.contractMismatch }
            result += page.items
            guard let next = page.next else { return result }
            guard seen.insert(next).inserted else { throw HostClientError.contractMismatch }; cursor = next
        }
        throw HostClientError.notReady
    }

    func loadSkills(force: Bool = false) {
        guard force || !skillsLoaded else { return }
        perform { client, token in
            let page = try await self.call(.read, client) { try await $0.listSkills() }; try self.check(token)
            let own = try await self.activations(client, scope: .bot(self.botID), token: token)
            let global = try await self.activations(client, scope: .global, token: token); try self.check(token)
            self.skills = page.items; self.skillNext = page.next
            self.skillCursors = []
            if let next = page.next { self.skillCursors.insert(next) }
            self.botSkills = own; self.globalSkills = global; self.skillsLoaded = true; self.skillsNeedRefresh = false
            self.skillContent = nil
            if !self.skills.contains(where: { $0.identity == self.selectedSkillIdentity }) { self.selectedSkillIdentity = "" }
        }
    }
    func loadMoreSkills() {
        guard let cursor = skillNext else { return }
        perform { client, token in
            let page = try await self.call(.read, client) { try await $0.listSkills(after: cursor) }; try self.check(token)
            for item in page.items {
                if let previous = self.skills.first(where: { $0.identity == item.identity }) {
                    guard previous == item else { throw HostClientError.contractMismatch }
                } else { self.skills.append(item) }
            }
            if let next = page.next { guard self.skillCursors.insert(next).inserted else { throw HostClientError.contractMismatch } }
            self.skillNext = page.next
        }
    }
    func readSkill() {
        guard let selected = selectedSkill else { return }
        perform { client, token in
            let value = try await self.call(.read, client) { try await $0.getSkillVersion(id: selected.id, version: selected.version) }; try self.check(token)
            guard value.lock == selected else { throw HostClientError.conflict }; self.skillContent = value
        }
    }
    func ownSkill(_ id: String) -> SkillLock? { botSkills.first { $0.skillId == id }?.lock }
    func setSkill(_ selected: SkillLock, deactivate: Bool) {
        guard canMutateSkills else { return }
        let previous = ownSkill(selected.id)
        guard deactivate ? previous == selected : skills.contains(selected) else { return }
        let input = SkillActivationInput(scope: .bot(botID), expected: previous.map(SkillActivationExpected.init(lock:)), version: deactivate ? nil : selected.version)
        perform { client, token in
            do {
                let value = try await self.call(.mutation, client) { try await $0.setSkillActivation(skillID: selected.id, input: input) }; try self.check(token)
                self.botSkills.removeAll { $0.skillId == selected.id }
                if value.lock != nil { self.botSkills.append(value) }
                self.notice = deactivate ? String(localized: "Habilidade desativada para este bot. As herdadas da base e do time continuam como estão.") : String(localized: "Habilidade ativada para este bot. Nenhum acesso a ferramentas foi concedido.")
            } catch {
                try self.check(token); self.skillsNeedRefresh = true
                self.notice = (error as? HostClientError) == .conflict
                    ? String(localized: "A ativação mudou na base. Atualize e confira a versão antes de outra alteração; nada foi reenviado.")
                    : String(localized: "Não foi possível confirmar a alteração. Atualize as ativações antes de tentar outra operação; nada será reenviado automaticamente.")
                throw error
            }
        }
    }

    /// Never picks a connection by itself: opening the tab lists connections; only the owner's choice loads one.
    func loadMcp(force: Bool = false) {
        guard force || !mcpLoaded else { return }
        perform { client, token in
            let values = try await self.call(.read, client) { try await $0.mcpServers() }; try self.check(token)
            guard Set(values.map(\.id)).count == values.count else { throw HostClientError.contractMismatch }
            self.servers = values; self.mcpLoaded = true
            var counts: [String: Int] = [:]
            for server in values.prefix(40) {
                // Read-only; a failed read leaves the count "not confirmed" instead of guessing zero.
                if let saved = try? await self.call(.read, client, { try await $0.mcpSelection(serverID: server.id, botID: self.botID) }), saved.botId == self.botID {
                    counts[server.id] = Set(saved.toolIds).count
                }
                try self.check(token)
            }
            self.serverToolCounts = counts
            guard !self.selectedServerID.isEmpty else { return }
            guard let selected = values.first(where: { $0.id == self.selectedServerID }) else {
                if self.dirty { self.mcpNeedsReconcile = true; self.notice = String(localized: "A conexão escolhida não aparece mais na base. Seu rascunho foi mantido; descarte-o explicitamente para escolher outra conexão.") }
                else { self.selectedServerID = ""; self.tools = []; self.credentialStatus = nil; self.mcpSelectionReady = false }
                return
            }
            try await self.fetchMcp(client, id: selected.id, token: token, preserveDraft: self.dirty)
        }
    }

    func serverChoiceLabel(_ server: McpServerSummary) -> String {
        let instance = McpInstanceLabel.short(server.id, among: servers.map(\.id))
        let count = serverToolCounts[server.id].map { " · " + ($0 == 0 ? String(localized: "nenhuma ferramenta deste bot") : String(localized: "\($0) ferramenta(s) deste bot")) } ?? ""
        return "\(server.name) · \(instance)" + count
    }
    private func fetchMcp(_ client: HostClient, id: String, token: UUID, preserveDraft: Bool) async throws {
        let fetchedTools = try await call(.read, client) { try await $0.mcpTools(serverID: id) }; try check(token)
        let selection = try await call(.read, client) { try await $0.mcpSelection(serverID: id, botID: botID) }; try check(token)
        guard selection.botId == botID, Set(selection.toolIds).count == selection.toolIds.count,
              Set(fetchedTools.map(\.id)).count == fetchedTools.count else { throw HostClientError.contractMismatch }
        // Only public custody state is read. Unlock, secrets and OAuth remain in global connection settings.
        let credentials: McpCredentialStatus?
        do {
            let value = try await call(.read, client) { try await $0.mcpCredentials(serverID: id) }; try check(token)
            guard value.serverId == id else { throw HostClientError.contractMismatch }; credentials = value
        } catch {
            try check(token); credentials = nil
        }
        let wasUncertain = mcpNeedsReconcile
        let priorDraft = selectedToolIDs
        selectedServerID = id; tools = fetchedTools; credentialStatus = credentials
        originalToolIDs = Set(selection.toolIds)
        selectedToolIDs = preserveDraft ? priorDraft : originalToolIDs
        mcpSelectionReady = true; mcpNeedsReconcile = false
        if wasUncertain {
            notice = dirty ? String(localized: "A base foi relida. Sua seleção desejada foi mantida e difere do estado atual; confira antes de salvar uma nova alteração explícita.") : String(localized: "A releitura confirmou a seleção atual na base. Nenhuma escrita foi repetida.")
        }
    }
    func chooseServer(_ id: String, discardDraft: Bool = false) {
        guard !busy, servers.contains(where: { $0.id == id }), !dirty || discardDraft else { return }
        if id == selectedServerID && !discardDraft { return }
        if discardDraft { selectedToolIDs = originalToolIDs }
        perform { client, token in try await self.fetchMcp(client, id: id, token: token, preserveDraft: false) }
    }
    func toggleTool(_ id: String, selected: Bool) {
        guard scopeMatches, mcpSelectionReady, !busy, !mcpNeedsReconcile else { return }
        guard tools.contains(where: { $0.id == id }) || selectedToolIDs.contains(id) else { return }
        if selected { selectedToolIDs.insert(id) } else { selectedToolIDs.remove(id) }
    }
    func discardMcpDraft() {
        guard scopeMatches, !busy else { return }; selectedToolIDs = originalToolIDs
        if !servers.contains(where: { $0.id == selectedServerID }) {
            selectedServerID = ""; selectedToolIDs = []; originalToolIDs = []; tools = []; credentialStatus = nil
            mcpSelectionReady = false; mcpNeedsReconcile = false
        }
    }
    func saveMcp() {
        guard canSaveMcp, !selectedServerID.isEmpty else { return }
        let id = selectedServerID, desired = selectedToolIDs
        perform { client, token in
            do {
                let value = try await self.call(.mutation, client) { try await $0.saveMcpSelection(serverID: id, botID: self.botID, toolIDs: desired.sorted()) }; try self.check(token)
                guard value.botId == self.botID, value.policy == "ask", Set(value.toolIds) == desired,
                      value.toolIds.count == desired.count else { throw HostClientError.mutationOutcomeUnknown }
                self.originalToolIDs = desired; self.selectedToolIDs = desired; self.serverToolCounts[id] = desired.count
                self.notice = desired.isEmpty ? String(localized: "Ferramentas deste servidor desligadas para este bot. A conexão compartilhada foi preservada.") : String(localized: "Seleção salva para este bot. A execução continua pedindo aprovação.")
            } catch {
                try self.check(token); self.mcpNeedsReconcile = true
                self.notice = String(localized: "Não foi possível confirmar o salvamento. Seu rascunho foi mantido e novas escritas foram bloqueadas. Releia o servidor para reconciliar; nada será reenviado automaticamente.")
                throw error
            }
        }
    }

    func loadAccess(force: Bool = false) {
        guard scopeMatches, !busy, force || !accessLoaded else { return }
        busy = true; notice = nil
        let token = generation
        requestTask = Task { @MainActor in
            await model.loadDeviceGrants(botID: botID)
            do { try check(token) } catch { return }
            accessLoaded = model.grantBotID == botID
            busy = false; requestTask = nil
        }
    }
    func setGrant(_ observed: DeviceGrantRow, to choice: DeviceGrantChoice) {
        guard canMutateGrants, observed.botID == botID, !model.uncertainGrantIDs.contains(observed.id) else { return }
        guard grantRows.first(where: { $0.id == observed.id }) == observed else {
            notice = String(localized: "Esta permissão mudou desde a confirmação. Confira a linha atual antes de alterá-la."); return
        }
        busy = true; notice = nil
        let token = generation
        requestTask = Task { @MainActor in
            _ = await model.setDeviceGrant(id: observed.id, to: choice)
            do { try check(token) } catch { return }
            busy = false; requestTask = nil
        }
    }

    func loadHistory(force: Bool = false) {
        guard force || !historyLoaded else { return }
        perform { client, token in
            // These are the app's existing bounded projections, not a new whole-host event scan.
            let conversations = self.model.threads(for: self.botID).filter { $0.botId == self.botID }
                .sorted { $0.createdAt > $1.createdAt }
            let actions = self.model.actions.filter { $0.request.botId == self.botID }.sorted { $0.createdAt > $1.createdAt }
            self.historyThreads = Array(conversations.prefix(50)); self.historyActions = Array(actions.prefix(50))
            self.historyLoaded = true
            do {
                let values = try await self.call(.read, client) { try await $0.listBotDelegations(botID: self.botID) }; try self.check(token)
                self.delegations = Array(values.sorted { $0.updatedAt > $1.updatedAt }.prefix(50)); self.delegationUnavailable = false
            } catch {
                try self.check(token); self.delegationUnavailable = true
            }
        }
    }
}

@MainActor private struct BotSettingsResourcesNotice: View {
    let editor: BotSettingsResourcesEditor
    var body: some View {
        if editor.busy { ProgressView("Consultando a base…").controlSize(.small) }
        if !editor.scopeMatches {
            Text("Os ajustes exigem a conexão do proprietário com esta base local. Feche e abra os ajustes após reconectar.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        if let notice = editor.notice {
            Text(notice).font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bot-settings.resources.notice")
        }
    }
}

/// Plain-language view of the loaded skill catalog. Pure: no request, no grant; the exact version is always shown in
/// the confirmation before anything is activated.
enum SkillCatalogSummary {
    /// The highest registered version of each skill among the loaded catalog pages, ordered by display name.
    static func latest(_ catalog: [SkillLock]) -> [SkillLock] {
        var best: [String: SkillLock] = [:]
        for lock in catalog {
            if let current = best[lock.id], !isNewer(lock.version, than: current.version) { continue }
            best[lock.id] = lock
        }
        return best.values.sorted { displayName($0.id).localizedStandardCompare(displayName($1.id)) == .orderedAscending }
    }

    /// Semantic version order (`major.minor.patch`, the only form the host registers). Unparseable never wins.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let a = parts(candidate) else { return false }
        guard let b = parts(current) else { return true }
        return a.lexicographicallyPrecedes(b) == false && a != b
    }

    /// "resumo-semanal" → "Resumo semanal". The registered ID itself stays in Detalhes técnicos and the protocol.
    static func displayName(_ id: String) -> String {
        let spaced = id.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
            .split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        guard let first = spaced.first else { return id }
        return first.uppercased() + spaced.dropFirst()
    }

    private static func parts(_ version: String) -> [Int]? {
        let values = version.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard values.count == 3, values.allSatisfy({ $0 != nil }) else { return nil }
        return values.compactMap { $0 }
    }
}

@MainActor struct BotSettingsSkillsView: View {
    @Bindable var editor: BotSettingsResourcesEditor
    @Environment(\.locale) private var locale
    @State private var confirming: SkillChange?
    @State private var showingRegistry = false
    @State private var showsAdvanced = false
    private struct SkillChange: Identifiable { var id: String { lock.identity }; let lock: SkillLock; let deactivate: Bool }
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    /// Skills not on for this bot, or on at an older version than the newest loaded one (never offers a downgrade).
    private var available: [SkillLock] {
        SkillCatalogSummary.latest(editor.skills).filter { lock in
            guard let previous = editor.ownSkill(lock.id) else { return true }
            return SkillCatalogSummary.isNewer(lock.version, than: previous.version)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack(alignment: .firstTextBaseline) {
                    Text(text("Uma habilidade orienta como este bot trabalha. Ela não dá acesso a contas, ferramentas, arquivos nem permissões.", "A skill guides how this bot works. It grants no access to accounts, tools, files or permissions."))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 12)
                    Button(text("Atualizar", "Refresh")) { editor.loadSkills(force: true) }.disabled(editor.busy || !editor.scopeMatches)
                        .accessibilityIdentifier("bot-settings.skills.refresh")
                }
                BotSettingsGroup(title: text("Ativas neste bot", "Active for this bot"), id: "bot-settings.skills.own") {
                    if editor.skillsLoaded && editor.botSkills.isEmpty {
                        Text(text("Nenhuma habilidade própria ainda. Ative uma abaixo.", "No skills of its own yet. Turn one on below."))
                            .foregroundStyle(.secondary).padding(.vertical, 12)
                    } else if !editor.skillsLoaded {
                        Text(text("Lendo as habilidades…", "Reading skills…")).foregroundStyle(.secondary).padding(.vertical, 12)
                    }
                    ForEach(Array(editor.botSkills.compactMap(\.lock).enumerated()), id: \.element.id) { index, lock in
                        if index > 0 { Divider() }
                        BotSettingsRow(title: SkillCatalogSummary.displayName(lock.id), detail: text("Versão \(lock.version)", "Version \(lock.version)"), systemImage: "sparkles") {
                            Button(text("Desativar…", "Turn off…")) { confirming = SkillChange(lock: lock, deactivate: true) }
                                .disabled(!editor.canMutateSkills)
                                .accessibilityIdentifier("bot-settings.skills.deactivate.\(lock.id)")
                        }
                        .help(lock.id)
                    }
                }
                BotSettingsGroup(title: text("Disponíveis para ativar", "Available to turn on"),
                                 note: editor.skillNext != nil ? text("Há mais habilidades no catálogo. Use Carregar mais em Avançado.", "There are more skills in the catalog. Use Load more under Advanced.") : nil,
                                 id: "bot-settings.skills.available") {
                    if editor.skillsLoaded && available.isEmpty {
                        Text(editor.skills.isEmpty ? text("Nenhuma habilidade registrada nesta base.", "No skills registered on this host.")
                                                   : text("Todas as habilidades carregadas já estão ativas neste bot.", "Every loaded skill is already on for this bot."))
                            .foregroundStyle(.secondary).padding(.vertical, 12)
                    }
                    ForEach(Array(available.enumerated()), id: \.element.id) { index, lock in
                        if index > 0 { Divider() }
                        let previous = editor.ownSkill(lock.id)
                        BotSettingsRow(title: SkillCatalogSummary.displayName(lock.id),
                                       detail: previous.map { text("Ativa na versão \($0.version); a mais nova carregada é \(lock.version)", "On at version \($0.version); the newest loaded is \(lock.version)") }
                                               ?? text("Versão \(lock.version)", "Version \(lock.version)"),
                                       systemImage: "sparkles") {
                            Button(previous == nil ? text("Ativar…", "Turn on…") : text("Usar esta versão…", "Use this version…")) {
                                confirming = SkillChange(lock: lock, deactivate: false)
                            }
                            .disabled(!editor.canMutateSkills)
                            .accessibilityIdentifier("bot-settings.skills.activate.\(lock.id)")
                        }
                        .help(lock.id)
                    }
                }
                if !editor.globalSkills.isEmpty {
                    BotSettingsGroup(title: text("Também ativas pela base", "Also on from the host"),
                                     note: text("Valem para os bots desta base e só mudam no catálogo global. Desativar uma habilidade própria não desliga uma herdada; times também podem compor o contexto.", "They apply to this host’s bots and only change in the global catalog. Turning off a skill of its own does not turn off an inherited one; teams can also add context."),
                                     id: "bot-settings.skills.inherited") {
                        ForEach(Array(editor.globalSkills.compactMap(\.lock).enumerated()), id: \.element.id) { index, lock in
                            if index > 0 { Divider() }
                            BotSettingsRow(title: SkillCatalogSummary.displayName(lock.id), detail: text("Versão \(lock.version)", "Version \(lock.version)")) {
                                Text(text("Da base", "From the host")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                DisclosureGroup(isExpanded: $showsAdvanced) { advanced.padding(.top, 10) } label: {
                    Text(text("Avançado: versões, conteúdo e catálogo", "Advanced: versions, content and catalog")).font(.callout)
                        .accessibilityIdentifier("bot-settings.skills.advanced")
                }
                BotSettingsResourcesNotice(editor: editor)
            }.padding(24)
        }
        .task { editor.loadSkills() }
        .sheet(isPresented: $showingRegistry) { SkillsView(model: editor.model) }
        .onChange(of: showingRegistry) { _, open in if !open { editor.loadSkills(force: true) } }
        .confirmationDialog(text("Alterar as habilidades deste bot?", "Change this bot’s skills?"), isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let change = confirming {
                Button(change.deactivate ? text("Desativar habilidade", "Turn off skill") : text("Ativar habilidade", "Turn on skill"), role: change.deactivate ? .destructive : nil) { editor.setSkill(change.lock, deactivate: change.deactivate); confirming = nil }
                    .accessibilityIdentifier("bot-settings.skills.confirm")
                Button(text("Cancelar", "Cancel"), role: .cancel) { confirming = nil }
            }
        } message: {
            if let change = confirming {
                Text(verbatim: "\(SkillCatalogSummary.displayName(change.lock.id)) · " + text("versão \(change.lock.version), somente para este bot. Habilidades não concedem ferramentas, contas ou acessos; permissões e habilidades herdadas continuam como estão. A base confere se esta versão continua a mesma.", "version \(change.lock.version), for this bot only. Skills grant no tools, accounts or access; permissions and inherited skills stay as they are. The host checks that this version is still the same."))
            }
        }
    }

    /// The registry-level controls, unchanged in behaviour and IDs: any registered version, its Markdown, more
    /// catalog pages and the global catalog manager.
    @ViewBuilder private var advanced: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(text("Versão registrada", "Registered version"), selection: $editor.selectedSkillIdentity) {
                Text(text("Escolha uma habilidade", "Choose a skill")).tag("")
                ForEach(editor.skills, id: \.identity) { Text(verbatim: "\($0.id) — \($0.version)").tag($0.identity) }
            }.disabled(editor.busy).accessibilityIdentifier("bot-settings.skills.version")
            HStack {
                Button(text("Ler conteúdo", "Read content"), action: editor.readSkill).disabled(editor.busy || editor.selectedSkill == nil)
                    .accessibilityIdentifier("bot-settings.skills.read")
                Button(text("Ativar para este bot…", "Turn on for this bot…")) {
                    if let lock = editor.selectedSkill { confirming = SkillChange(lock: lock, deactivate: false) }
                }.disabled(!editor.canMutateSkills || editor.selectedSkill == nil || editor.selectedSkill == editor.selectedSkill.flatMap { editor.ownSkill($0.id) })
                    .accessibilityIdentifier("bot-settings.skills.activate")
                if editor.skillNext != nil {
                    Button(text("Carregar mais", "Load more"), action: editor.loadMoreSkills).disabled(editor.busy)
                        .accessibilityIdentifier("bot-settings.skills.more")
                }
            }
            if let lock = editor.selectedSkill {
                Text(verbatim: "id \(lock.id) · \(lock.version) · sha256 \(lock.sha256) · commit \(lock.commit) · \(lock.path)")
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-settings.skills.technical")
            }
            if let content = editor.skillContent, content.lock.identity == editor.selectedSkillIdentity {
                Text(verbatim: content.markdown).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                    .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("bot-settings.skills.content")
            }
            Text(text("Ativar uma versão não concede ferramentas, contas ou acessos. Antes de ativar, a base confere se esta versão continua a mesma.", "Turning on a version grants no tools, accounts or access. Before turning it on, the host checks that this version is still the same."))
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button(text("Gerenciar catálogo global…", "Manage global catalog…")) { showingRegistry = true }.disabled(editor.busy || !editor.scopeMatches)
                .accessibilityIdentifier("bot-settings.skills.global")
        }
    }
}

@MainActor struct BotSettingsMcpView: View {
    @Bindable var editor: BotSettingsResourcesEditor
    /// UI R1: the window's single owner-configuration presenter (nil only outside a settings window).
    var owner: BotOwnerConfigurationPresenter? = nil
    var botName = ""
    var onOpenMemory: () -> Void = {}
    @State private var pendingServer: String?
    @State private var confirmingSave = false
    @State private var confirmingDiscard = false
    @State private var showingConnections = false
    @State private var legacyExpanded = false
    private var serverSelection: Binding<String> {
        Binding(get: { editor.selectedServerID }, set: { id in
            if editor.dirty { pendingServer = id } else { editor.chooseServer(id) }
        })
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Spacer()
                    Button(editor.mcpNeedsReconcile ? "Reconciliar" : "Atualizar") {
                        editor.loadMcp(force: true)
                        if let owner { Task { await owner.refreshMcp() } }
                    }
                    .disabled(editor.busy || !editor.scopeMatches || owner?.busy == true).accessibilityIdentifier("bot-settings.mcp.refresh")
                }
                if let owner {
                    BotMcpAccountsView(presenter: owner, servers: editor.servers, botName: botName, onOpenMemory: onOpenMemory)
                    DisclosureGroup(isExpanded: Binding(get: { legacyExpanded || owner.notice == .unavailable }, set: { legacyExpanded = $0 })) {
                        VStack(alignment: .leading, spacing: 18) { legacyContent(lockedBy: owner) }.padding(.top, 8)
                    } label: {
                        Text("Uma conexão de cada vez (modo anterior)").font(.subheadline.weight(.medium))
                    }
                    .accessibilityIdentifier("bot-settings.mcp.legacy")
                } else {
                    legacyContent(lockedBy: nil)
                }
                Button("Gerenciar conexões…") { showingConnections = true }.disabled(editor.busy || editor.dirty || !editor.scopeMatches || owner?.busy == true)
                    .accessibilityIdentifier("bot-settings.mcp.global")
                BotSettingsResourcesNotice(editor: editor)
            }.padding(24)
        }
        .task { editor.loadMcp() }
        .sheet(isPresented: $showingConnections) {
            // The manager opens on this window's own bot, not on whatever bot the main window has selected.
            McpConnectionsView(initialBotID: editor.botID).environment(editor.model)
        }
        .onChange(of: showingConnections) { _, open in
            guard !open else { return }
            editor.loadMcp(force: true)
            if let owner { Task { await owner.refreshMcp() } }
        }
        // A consolidated change that finished also changes what the per-connection list counts.
        .onChange(of: owner?.stage) { _, stage in if stage == .succeeded, owner?.context?.isMcp == true { editor.loadMcp(force: true) } }
        .confirmationDialog("Descartar a seleção não salva?", isPresented: Binding(get: { pendingServer != nil || confirmingDiscard }, set: { if !$0 { pendingServer = nil; confirmingDiscard = false } }), titleVisibility: .visible) {
            Button("Descartar", role: .destructive) {
                if let id = pendingServer { editor.chooseServer(id, discardDraft: true) } else { editor.discardMcpDraft() }
                pendingServer = nil; confirmingDiscard = false
            }
            Button("Continuar editando", role: .cancel) { pendingServer = nil; confirmingDiscard = false }
        } message: { Text("Somente a seleção MCP ainda não salva será descartada. Nenhuma conexão será removida.") }
        .confirmationDialog("Salvar seleção para este bot?", isPresented: $confirmingSave, titleVisibility: .visible) {
            Button("Salvar seleção", action: editor.saveMcp)
            Button("Cancelar", role: .cancel) {}
        } message: { Text("\(editor.selectedToolIDs.count) ferramenta(s) em \(editor.selectedServer.map { "\($0.name) (\(McpInstanceLabel.short($0.id, among: editor.servers.map(\.id))))" } ?? String(localized: "esta conexão")), somente para este bot. Cada chamada pede aprovação, a menos que a regra deste bot seja Executar sem perguntar. Outras conexões, mesmo com o mesmo endereço, não mudam.") }
    }

    /// The pre-R1 per-connection editor, unchanged (same IDs and save path). While the window's consolidated change is
    /// open its Save waits, so the two paths never race on this bot's selection.
    @ViewBuilder private func legacyContent(lockedBy owner: BotOwnerConfigurationPresenter?) -> some View {
                Text("As conexões são compartilhadas nesta base. Escolha uma para ver e marcar as ferramentas deste bot; nada é escolhido sozinho. Cada chamada continua pedindo aprovação, salvo a regra deste bot em Acessos.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if owner?.hasOpenProposal == true {
                    Text("Salvar aqui espera a mudança de contas aberta acima terminar.")
                        .font(.caption).foregroundStyle(.orange).accessibilityIdentifier("bot-settings.mcp.legacy-waits")
                }
                if editor.mcpLoaded && editor.servers.isEmpty {
                    ContentUnavailableView("Nenhuma conexão MCP", systemImage: "puzzlepiece.extension", description: Text("Cadastre uma conexão em Gerenciar conexões e depois escolha as ferramentas deste bot."))
                } else {
                    Picker("Conexão", selection: serverSelection) {
                        if !editor.servers.contains(where: { $0.id == editor.selectedServerID }) { Text("Escolha uma conexão…").tag("") }
                        ForEach(editor.servers) { Text(verbatim: editor.serverChoiceLabel($0)).tag($0.id) }
                    }.disabled(editor.busy || editor.mcpNeedsReconcile).accessibilityIdentifier("bot-settings.mcp.server")
                    Text("Conexões com o mesmo nome ou endereço aparecem com o ID para você distinguir. Para várias contas do mesmo serviço, use nomes como Pessoal e Trabalho.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let server = editor.selectedServer {
                        GroupBox("Conexão compartilhada") {
                            VStack(alignment: .leading, spacing: 8) {
                                LabeledContent("Nome", value: server.name)
                                LabeledContent("ID da conexão") { Text(verbatim: server.id).textSelection(.enabled) }
                                LabeledContent("Endereço") { Text(verbatim: server.destination).textSelection(.enabled).lineLimit(2) }
                                LabeledContent("Conta do serviço", value: String(localized: "Não verificada"))
                                LabeledContent("Estado", value: McpInstanceLabel.status(server.status))
                                LabeledContent("Login", value: editor.credentialStatus.map { McpInstanceLabel.credential($0.state) } ?? String(localized: "Não confirmado"))
                                ForEach(McpInstanceLabel.duplicateWarnings(for: server, among: editor.servers), id: \.self) { warning in
                                    Label(warning, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Text("O Dexter não confirma qual conta do serviço esta conexão usa. Chaves, OAuth e desbloqueio ficam no fluxo privado de Gerenciar conexões.")
                                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }.padding(8)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("bot-settings.mcp.instance-identity")
                    }
                    if editor.mcpSelectionReady {
                        GroupBox("Ferramentas deste bot") {
                            VStack(alignment: .leading, spacing: 12) {
                                if editor.tools.isEmpty { Text("Nenhuma ferramenta descoberta neste servidor.").foregroundStyle(.secondary) }
                                ForEach(editor.tools) { tool in
                                    Toggle(isOn: Binding(get: { editor.selectedToolIDs.contains(tool.id) }, set: { editor.toggleTool(tool.id, selected: $0) })) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(verbatim: tool.name).font(.headline)
                                            Text(verbatim: tool.description).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                            Text(tool.state != "publishable" ? "Indisponível pela política do Dexter" : tool.effect == "read" ? "Leitura" : "Pode alterar dados")
                                                .font(.caption).foregroundStyle(.secondary)
                                                // Plain words for the host's real values (effect, publishable state); raw codes stay out.
                                                .help(tool.state != "publishable" ? "A política do Dexter não deixa bots usarem esta ferramenta."
                                                      : tool.effect == "read" ? "Só consulta dados do serviço; não altera nada nele."
                                                      : "Pode criar, alterar ou apagar dados no serviço.")
                                        }
                                    }.disabled(editor.busy || editor.mcpNeedsReconcile || !editor.scopeMatches)
                                        .accessibilityIdentifier("bot-settings.mcp.tool.\(tool.id)")
                                }
                                ForEach(editor.selectedToolIDs.filter { id in !editor.tools.contains(where: { $0.id == id }) }.sorted(), id: \.self) { id in
                                    HStack {
                                        Text(verbatim: String(localized: "Ferramenta fora do catálogo atual: \(id)")).font(.footnote)
                                        Spacer()
                                        Button("Retirar da seleção") { editor.toggleTool(id, selected: false) }
                                            .disabled(editor.busy || editor.mcpNeedsReconcile || !editor.scopeMatches)
                                            .accessibilityIdentifier("bot-settings.mcp.remove-unlisted.\(id)")
                                    }
                                }
                                Text("Desligar todas as ferramentas retira o acesso deste bot a esta conexão, sem remover a conexão compartilhada. Se outra pessoa ou janela mudar a seleção ao mesmo tempo, use Atualizar para conferir antes de salvar.")
                                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }.padding(8)
                        }
                        HStack {
                            Button("Descartar seleção") { confirmingDiscard = true }.disabled(!editor.dirty || editor.busy)
                                .accessibilityIdentifier("bot-settings.mcp.discard")
                            Spacer()
                            Button("Salvar para este bot…") { confirmingSave = true }.buttonStyle(.borderedProminent)
                                .disabled(!editor.canSaveMcp || owner?.hasOpenProposal == true || owner?.busy == true)
                                .accessibilityIdentifier("bot-settings.mcp.save")
                        }
                    }
                }
    }
}

/// A fragment, so the profile's coordination controls and device access use a single scroll container.
@MainActor struct BotSettingsAccessView: View {
    let editor: BotSettingsResourcesEditor
    @State private var confirming: GrantChange?
    private struct GrantChange { let row: DeviceGrantRow; let choice: DeviceGrantChoice }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Ferramentas do Mac").font(.body.weight(.semibold))
                Spacer()
                Button("Atualizar acessos") { editor.loadAccess(force: true) }
                    .disabled(editor.busy || !editor.scopeMatches || editor.model.operatingGrantID != nil)
                    .accessibilityIdentifier("bot-settings.access.refresh")
            }
            Text("Decisões registradas para este bot. Pedir aprovação e Bloquear não fazem pareamento nem concedem permissões do macOS; essas etapas continuam nos fluxos privados de dispositivos.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if editor.accessLoaded && editor.grantRows.isEmpty {
                Text("Nenhuma permissão de dispositivo está disponível para este bot na projeção atual da base.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(editor.grantRows) { row in
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(verbatim: DeviceToolLabel.title(row.tool)).font(.body)
                        Spacer()
                        Text(verbatim: DeviceToolLabel.policy(row.policy)).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("bot-settings.access.policy.\(row.id)")
                    }
                    Text(verbatim: "Destino: \(row.destination)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    DisclosureGroup {
                        Text(verbatim: "tool: \(row.tool) · policy: \(row.policy ?? "—") · revision: \(row.revision.map(String.init) ?? "—")")
                            .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    } label: {
                        Text("Detalhes técnicos").font(.caption).foregroundStyle(.secondary)
                    }
                    if row.isExpired(at: Date()) { Text("A decisão anterior expirou.").font(.footnote).foregroundStyle(.orange) }
                    HStack {
                        Button("Pedir aprovação…") { confirming = GrantChange(row: row, choice: .ask) }
                            .disabled(!editor.canMutateGrants || editor.model.uncertainGrantIDs.contains(row.id) || (row.revision != nil && row.policy == "ask" && row.expiresAt == nil))
                            .accessibilityIdentifier("bot-settings.access.ask.\(row.id)")
                        Button("Bloquear…") { confirming = GrantChange(row: row, choice: .deny) }
                            .disabled(!editor.canMutateGrants || editor.model.uncertainGrantIDs.contains(row.id) || (row.revision != nil && row.policy == "deny" && row.expiresAt == nil))
                            .accessibilityIdentifier("bot-settings.access.deny.\(row.id)")
                    }
                    if editor.model.uncertainGrantIDs.contains(row.id) {
                        Text("Resultado anterior não confirmado. Atualize para reconciliar, sem repetir a escrita.").font(.footnote).foregroundStyle(.orange)
                    }
                }
                .accessibilityElement(children: .contain)
            }
            if editor.model.grantBotID == editor.botID, editor.model.grantError != nil {
                Text("Não foi possível confirmar todos os acessos. Confira a conexão e atualize; decisões incertas não serão repetidas.")
                    .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-settings.access.error")
            }
            BotSettingsResourcesNotice(editor: editor)
        }
        .task { editor.loadAccess() }
        .confirmationDialog("Alterar esta permissão do bot?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let change = confirming {
                Button(change.choice == .ask ? "Pedir aprovação" : "Bloquear", role: change.choice == .deny ? .destructive : nil) {
                    editor.setGrant(change.row, to: change.choice); confirming = nil
                }
                Button("Cancelar", role: .cancel) { confirming = nil }
            }
        } message: {
            if let change = confirming {
                // Plain interpolations keep the catalog key identical to the runtime key.
                let tool = DeviceToolLabel.title(change.row.tool), destination = change.row.destination
                Text("\(tool), destino \(destination), somente para este bot. A base confere se esta permissão continua igual; nenhuma autorização do macOS será alterada.")
            }
        }
    }
}

@MainActor struct BotSettingsHistoryView: View {
    let editor: BotSettingsResourcesEditor
    let onOpenThread: (HostThread) -> Void
    private func date(_ milliseconds: Int64) -> String { Date(timeIntervalSince1970: Double(milliseconds) / 1000).formatted(date: .abbreviated, time: .shortened) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Spacer()
                    Button("Atualizar") { editor.loadHistory(force: true) }.disabled(editor.busy || !editor.scopeMatches)
                        .accessibilityIdentifier("bot-settings.history.refresh")
                }
                Text("Consulta parcial: até 50 registros por grupo. Conversas e ações vêm da projeção já carregada no app; não são uma auditoria completa da base nem uma medição de uso.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                GroupBox("Conversas carregadas") {
                    VStack(alignment: .leading, spacing: 12) {
                        if editor.historyLoaded && editor.historyThreads.isEmpty { Text("Nenhuma conversa deste bot está carregada no app.").foregroundStyle(.secondary) }
                        else if !editor.historyThreads.isEmpty {
                            Text("Título e última atividade das conversas ainda não são informados pela base.").font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(editor.historyThreads) { thread in
                            let created = date(thread.createdAt)
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(thread.teamID == nil ? "Conversa pessoal" : "Conversa de time").font(.headline)
                                    Text("Criada em \(created)").font(.caption).foregroundStyle(.secondary)
                                    if thread.teamID != nil { Text("Abra esta conversa pelo time correspondente.").font(.footnote).foregroundStyle(.secondary) }
                                    DisclosureGroup {
                                        Text(verbatim: thread.id).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                                    } label: {
                                        Text("Detalhes técnicos").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Button("Abrir") { onOpenThread(thread) }
                                    .disabled(thread.teamID != nil || editor.busy || !editor.scopeMatches)
                                    .accessibilityIdentifier("bot-settings.history.open.\(thread.id)")
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                GroupBox("Ações carregadas") {
                    VStack(alignment: .leading, spacing: 10) {
                        if editor.historyLoaded && editor.historyActions.isEmpty { Text("Nenhuma ação deste bot está carregada na projeção atual.").foregroundStyle(.secondary) }
                        ForEach(editor.historyActions) { action in
                            let presentation = ApprovalPresentation(action: action)
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(verbatim: presentation.title).font(.headline)
                                    Text(date(action.createdAt)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(presentation.stateLabel(atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))).font(.caption).foregroundStyle(.secondary)
                            }
                            .help("\(action.request.tool) · \(action.state.rawValue)")
                            .accessibilityIdentifier("bot-settings.history.action.\(action.id)")
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                GroupBox("Chamadas entre bots") {
                    VStack(alignment: .leading, spacing: 10) {
                        if editor.delegationUnavailable { Text("Esta base não confirmou o histórico de chamadas. Atualize para tentar uma nova leitura.").foregroundStyle(.secondary) }
                        else if editor.historyLoaded && editor.delegations.isEmpty { Text("Nenhuma chamada retornada para este bot.").foregroundStyle(.secondary) }
                        ForEach(editor.delegations) { item in
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.sourceBotId == editor.botID ? "Enviada a outro bot" : "Recebida de outro bot").font(.headline)
                                    Text(date(item.updatedAt)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(DelegationStateLabel.title(item.state)).font(.caption).foregroundStyle(.secondary)
                                    .help(item.state.rawValue)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                BotSettingsResourcesNotice(editor: editor)
            }.padding(24)
        }
        .task { editor.loadHistory() }
    }
}

/// UI R1 (MCP3-B / memory4-B). The settings window keeps ONE of these (and so one `OwnerConfigurationEditor`) for its
/// whole life: the host retires an older session of the same window, so MCP and Memória share it, one proposal at a time.
/// It only orders the editor's calls and keeps what the window shows; requests, pins, CAS and decisions stay in the
/// technical editor. Late answers after the window, base or bot changed are dropped (generation + pure scope check).
@MainActor @Observable
final class BotOwnerConfigurationPresenter {
    /// What the window's single proposal is about, kept so the review can be shown again after closing a sheet.
    enum Context: Equatable {
        case mcp(plan: McpInstanceSelectionPlan, review: McpInstanceSelectionReview)
        case policy(input: MemoryRoutinePolicyInput, previous: MemoryRoutinePolicy)
        case capture(job: MemoryRoutineJob)
        case maintenance(preview: MemoryMaintenancePreview)
        var isMcp: Bool { if case .mcp = self { return true }; return false }
    }
    enum Notice: Equatable { case readFailed, planConflict, planRefused, catalogUnavailable, memoryChangedReload, unavailable }

    let editor: OwnerConfigurationEditor
    let botID: String
    let ownerID: String
    @ObservationIgnored private let model: DexterAppModel
    @ObservationIgnored private var generation = UUID()
    private(set) var retired = false
    private(set) var working = false
    private(set) var notice: Notice?

    private(set) var context: Context?
    // MCP
    private(set) var draft: McpAccountsDraft?
    private(set) var draftBase: McpInstanceSelectionReview?
    private(set) var catalogs: [String: McpInstanceSelectionCatalog] = [:]
    private(set) var catalogFailures: Set<String> = []
    private(set) var reviewedPlan: McpInstanceSelectionPlan?
    private(set) var reviewedAgainst: McpInstanceSelectionReview?
    private(set) var mcpOutcome: McpAccountsPresentation.Outcome?
    // Memory
    private(set) var maintenancePreview: MemoryMaintenancePreview?
    private(set) var policyReceiptRead: MemoryRoutinePolicyReceiptObservation?
    private(set) var captureRead: MemoryRoutineJobObservation?

    init(bot: Bot, model: DexterAppModel, session: SettingsEditorSession) {
        botID = bot.id; ownerID = bot.ownerId; self.model = model
        editor = OwnerConfigurationEditor(bot: bot, model: model, session: session)
    }

    /// Pure: reads stored facts only. The editor's own `scopeMatches` latches the window session when read, so the
    /// views use this and `latchIfRetired()` runs from hooks and handlers, never from `body`.
    var windowCurrent: Bool {
        let session = editor.session
        guard !retired, !editor.invalidated, !session.closed, !session.invalidated, model.canEditBotProfiles,
              session.hostScope == model.nativeComposerScope, session.hostAddress == model.hostAddress,
              let hostID = session.effectiveHostID, hostID == model.approvalPolicyHostID else { return false }
        return model.bots.contains { $0.id == botID && $0.ownerId == ownerID }
    }
    /// From hooks/handlers only: a mismatch retires the editor and drops every pending callback for good.
    func latchIfRetired() {
        guard !retired else { return }
        if !windowCurrent || !editor.scopeMatches { retire() }
    }
    func retire() {
        retired = true; generation = UUID(); working = false
        editor.invalidate()
    }
    var stage: OwnerProposalStage {
        OwnerProposalStage.from(state: editor.state, action: editor.action?.state, mutationSent: editor.mutationSent)
    }
    var busy: Bool { working || editor.busy }
    var canStartReview: Bool { windowCurrent && !busy && context == nil && editor.original == nil && editor.hostSession != nil }
    /// The section dot and the close guard: a draft that differs, or a proposal that is still open.
    var mcpDraftDirty: Bool {
        guard let draft, let base = draftBase else { return false }
        return draft != McpAccountsDraft(review: base)
    }
    var hasOpenProposal: Bool { context != nil && stage.isOpen }

    private func run(_ body: @escaping @MainActor (UUID) async throws -> Void) async {
        latchIfRetired()
        guard windowCurrent, !working else { return }
        working = true; notice = nil
        let token = generation
        defer { if token == generation { working = false } }
        do { try await body(token) }
        catch {
            guard token == generation else { return }
            latchIfRetired(); guard windowCurrent else { return }
            if notice == nil { notice = .readFailed }
        }
    }
    private func accepts(_ token: UUID) -> Bool { token == generation && windowCurrent && !Task.isCancelled }

    /// Opens (or renews, after a host restart) this same window's host session. Never sends a proposal.
    func openIfNeeded() async {
        latchIfRetired()
        guard windowCurrent, editor.hostSession == nil, !editor.busy else { return }
        await editor.open()
        latchIfRetired()
        if windowCurrent, editor.hostSession == nil { notice = .unavailable }
    }

    /// The host session of this window expired or the host restarted: renew the SAME window namespace on the owner's
    /// explicit click. It reads; it never resends a proposal.
    var needsRenew: Bool { editor.hostSession != nil && editor.lastError == .forbidden && context == nil }
    func renew() async {
        latchIfRetired()
        guard windowCurrent, !editor.busy else { return }
        await editor.open()
        latchIfRetired()
        guard windowCurrent, editor.lastError == nil else { return }
        await editor.refreshMcp()
        if editor.memoryPolicy != nil { await editor.refreshMemory() }
    }

    // MARK: MCP

    /// Reads the host snapshot; a draft that equals its old base follows the new snapshot, an edited draft is kept.
    func refreshMcp() async {
        await openIfNeeded()
        guard windowCurrent, editor.hostSession != nil else { return }
        let token = generation
        await editor.refreshMcp()
        guard accepts(token), let review = editor.mcpReview else { return }
        if draft == nil || !mcpDraftDirty { draft = McpAccountsDraft(review: review); draftBase = review }
        for id in review.instances.map(\.serverId) where draft?.isIncluded(id, in: review) == true { await loadCatalog(id) }
    }
    func loadCatalog(_ serverID: String, force: Bool = false) async {
        guard force || catalogs[serverID] == nil, windowCurrent, editor.hostSession != nil else { return }
        let token = generation
        do {
            let value = try await editor.catalog(serverID: serverID)
            guard accepts(token) else { return }
            catalogs[serverID] = value; catalogFailures.remove(serverID)
        } catch {
            guard accepts(token) else { return }
            catalogFailures.insert(serverID)
        }
    }
    func updateDraft(_ change: (inout McpAccountsDraft) -> Void) {
        guard windowCurrent, context == nil, var value = draft else { return }
        change(&value); draft = value
    }
    func include(_ serverID: String, _ on: Bool) {
        guard let review = editor.mcpReview else { return }
        updateDraft { $0.include(serverID, on, in: review) }
        if on { Task { await loadCatalog(serverID) } }
    }
    func discardDraft() {
        guard context == nil, let review = editor.mcpReview else { return }
        draft = McpAccountsDraft(review: review); draftBase = review; reviewedPlan = nil; reviewedAgainst = nil
    }
    /// Read-only: the host materializes the exact pinned plan; nothing is proposed yet.
    func planReview() async {
        guard canStartReview, let review = editor.mcpReview, let input = draft?.input(for: review) else { return }
        reviewedPlan = nil; reviewedAgainst = nil
        await run { token in
            do {
                let plan = try await self.editor.plan(input)
                guard self.accepts(token) else { return }
                self.reviewedPlan = plan; self.reviewedAgainst = review
            } catch HostClientError.conflict {
                guard self.accepts(token) else { return }
                self.notice = .planConflict
            } catch let error as HostClientError where error != .offline && error != .hostFailure {
                guard self.accepts(token) else { return }
                self.notice = .planRefused
            }
        }
    }
    func cancelReview() { if context == nil { reviewedPlan = nil; reviewedAgainst = nil } }
    /// One POST for the reviewed plan; the result is a real action that still waits for the owner's decision.
    func requestMcpApproval() async {
        guard let plan = reviewedPlan, let review = reviewedAgainst else { return }
        await propose(.mcp(plan: plan, review: review)) { try OwnerConfigurationProposal(mcpPlan: plan) }
    }

    // MARK: Memory

    func refreshMemory() async {
        await openIfNeeded()
        guard windowCurrent, editor.hostSession != nil else { return }
        await editor.refreshMemory()
    }
    func requestPolicy(enabled: Bool, maintenance: Bool) async {
        guard let status = editor.memoryPolicy else { return }
        let current = status.policy
        let input = MemoryRoutinePolicyInput(expectedRevision: current.revision, enabled: enabled, maintenanceEnabled: enabled && maintenance,
                                             minIntervalMs: current.minIntervalMs, maxNotesPerDay: current.maxNotesPerDay, maxNoteCharacters: current.maxNoteCharacters)
        await propose(.policy(input: input, previous: current)) { try OwnerConfigurationProposal(memoryPolicy: input) }
    }
    func requestCapture(_ job: MemoryRoutineJob) async {
        guard MemorySuggestionsPresentation.candidate(job) == .suggested else { return }
        await propose(.capture(job: job)) { try OwnerConfigurationProposal(captureJobID: job.id) }
    }
    func previewMaintenance() async {
        guard canStartReview else { return }
        maintenancePreview = nil
        await run { token in
            let value = try await self.editor.maintenancePreview()
            guard self.accepts(token) else { return }
            self.maintenancePreview = value
        }
    }
    func requestMaintenance() async {
        guard let preview = maintenancePreview, !preview.removed.isEmpty else { return }
        await propose(.maintenance(preview: preview)) { try OwnerConfigurationProposal(maintenance: MemoryMaintenanceInput(preview: preview)) }
    }

    // MARK: The single proposal

    private func propose(_ next: Context, make: () throws -> OwnerConfigurationProposal) async {
        latchIfRetired()
        if context == nil {
            guard canStartReview else { return }
            do { try editor.prepare(try make()) } catch { notice = .planRefused; return }
            context = next; mcpOutcome = nil; policyReceiptRead = nil; captureRead = nil
        }
        guard context == next, stage == .prepared || stage == .sending || stage == .notConfirmed else { return }
        // Re-entering after a send is the editor's GET-only reconcile; it never posts a second time.
        await editor.submit()
        latchIfRetired()
    }
    /// Cancels a reviewed proposal that was never sent. After a send there is nothing to cancel here.
    func discardPrepared() {
        guard stage == .prepared, (try? editor.discardPrepared()) != nil else { return }
        context = nil
    }
    /// The owner's deliberate Approve/Decline on the displayed action. One decision; uncertainty is read, not retried.
    func decide(_ decision: ApprovalDecision) async {
        latchIfRetired()
        guard windowCurrent, stage == .awaitingDecision else { return }
        await editor.decide(decision)
        await readEffect()
    }
    /// "Conferir estado": original request read, then the effect receipt of this same action. Never a POST.
    func check() async {
        latchIfRetired()
        guard windowCurrent, context != nil else { return }
        if editor.requiresReconciliation || stage == .applying || stage == .hostUnknown { await editor.reconcile() }
        await readEffect()
    }
    private func readEffect() async {
        guard let context, windowCurrent, editor.action != nil else { return }
        let token = generation
        switch context {
        case .mcp:
            guard stage == .succeeded || stage == .applying || stage == .hostUnknown else { return }
            if let value = try? await editor.mcpReceipt(), accepts(token) { mcpOutcome = McpAccountsPresentation.outcome(value) }
            guard accepts(token), stage == .succeeded else { return }
            await editor.refreshMcp()
            if accepts(token), let review = editor.mcpReview { draft = McpAccountsDraft(review: review); draftBase = review }
        case .policy:
            guard stage.isTerminal || stage == .applying || stage == .hostUnknown else { return }
            if let value = try? await editor.policyReceipt(), accepts(token) { policyReceiptRead = value }
            if accepts(token) { await editor.refreshMemory() }
        case .capture(let job):
            guard stage.isTerminal || stage == .applying || stage == .hostUnknown else { return }
            if let value = try? await editor.job(job.id), accepts(token) { captureRead = value }
            if accepts(token) { await editor.refreshMemory() }
        case .maintenance:
            guard stage.isTerminal else { return }
            maintenancePreview = nil
        }
    }
    /// Clears a finished proposal so the next review can start. Unknown/awaiting stay: only reads can move them.
    func finish() {
        guard stage.isTerminal, (try? editor.finishReview()) != nil else { return }
        context = nil; reviewedPlan = nil; reviewedAgainst = nil; maintenancePreview = nil
    }
    /// Memory effects change MEMORY.md: the documents editor reloads only when it holds no unsaved edit.
    func memoryEffectApplied(documents: BotDocumentsEditor) {
        guard windowCurrent else { return }
        if documents.dirty { notice = .memoryChangedReload } else { documents.reload() }
    }
}

/// The review → approve → result footer every owner proposal of this window uses. Allow/Deny call the editor's
/// exact decision; "Conferir estado" only reads. No "approve all", no resend, no new request ID.
@MainActor struct OwnerProposalStagePanel: View {
    let presenter: BotOwnerConfigurationPresenter
    let approveTitle: LocalizedStringKey
    let requestTitle: LocalizedStringKey
    let onRequest: () -> Void
    let onCancel: () -> Void
    let onDone: () -> Void
    var outcome: Text? = nil

    var body: some View {
        let stage = presenter.stage
        VStack(alignment: .leading, spacing: 10) {
            statusLine(stage)
            if let outcome, stage == .succeeded || stage == .applying || stage == .hostUnknown {
                outcome.font(.callout).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("owner-proposal.outcome")
            }
            HStack {
                switch stage {
                case .none, .prepared:
                    Button("Cancelar", role: .cancel, action: onCancel).keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("owner-proposal.cancel")
                    Spacer()
                    Button(requestTitle, action: onRequest).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                        .disabled(presenter.busy || !presenter.windowCurrent).accessibilityIdentifier("owner-proposal.request")
                case .awaitingDecision:
                    Button("Recusar") { Task { await presenter.decide(.deny) } }
                        .disabled(presenter.busy || !presenter.windowCurrent).accessibilityIdentifier("owner-proposal.deny")
                    Spacer()
                    Button(approveTitle) { Task { await presenter.decide(.allow) } }.buttonStyle(.borderedProminent)
                        .disabled(presenter.busy || !presenter.windowCurrent).accessibilityIdentifier("owner-proposal.allow")
                case .sending, .applying, .hostUnknown, .notConfirmed:
                    Button("Conferir estado") { Task { await presenter.check() } }
                        .disabled(presenter.busy || !presenter.windowCurrent).accessibilityIdentifier("owner-proposal.check")
                    Spacer()
                    Button("Fechar", action: onDone).accessibilityIdentifier("owner-proposal.close")
                case .succeeded, .denied, .blocked:
                    if stage == .succeeded {
                        Button("Conferir estado") { Task { await presenter.check() } }
                            .disabled(presenter.busy || !presenter.windowCurrent).accessibilityIdentifier("owner-proposal.check")
                    }
                    Spacer()
                    Button("Concluir") { presenter.finish(); onDone() }.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("owner-proposal.done")
                case .retired:
                    Spacer()
                    Button("Fechar", action: onDone).accessibilityIdentifier("owner-proposal.close")
                }
            }
            if presenter.busy { ProgressView().controlSize(.small) }
            if presenter.context != nil { OwnerProposalTechnicalDetails(presenter: presenter) }
        }
    }

    @ViewBuilder private func statusLine(_ stage: OwnerProposalStage) -> some View {
        Group {
            switch stage {
            case .none, .prepared: Text("Nada foi enviado ainda. Pedir aprovação cria o pedido; ele só vale depois que você aprovar.")
            case .sending: Text("Enviando o pedido…")
            case .awaitingDecision: Text("Pedido criado e aguardando sua decisão. Nada muda até você aprovar.")
            case .applying: Text("Aprovado. A base está aplicando; Conferir estado só lê este mesmo pedido.")
            case .hostUnknown: Text("A base não confirmou o resultado. Conferir estado só lê este mesmo pedido; nada é reenviado.")
            case .notConfirmed: Text("Sem confirmação de que o pedido chegou à base. Conferir estado só lê o pedido original; nada é reenviado. Se continuar assim, feche a janela: nada é aplicado sem a sua aprovação.")
            case .succeeded: Text("Aprovado.")
            case .denied: Text("Recusado. Nada mudou.")
            case .blocked: Text("A base bloqueou o pedido. Nada foi aplicado.")
            case .retired: Text("A conexão com a base ou o bot mudou. Esta janela não lê nem envia mais nada; feche e abra os ajustes de novo.")
            }
        }
        .font(.callout.weight(stage == .awaitingDecision ? .semibold : .regular))
        .foregroundStyle(stage == .hostUnknown || stage == .notConfirmed || stage == .retired ? Color.orange : Color.primary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("owner-proposal.status")
    }
}

/// Folded identifiers for support: request, action and body hash. Never in the normal flow.
@MainActor struct OwnerProposalTechnicalDetails: View {
    let presenter: BotOwnerConfigurationPresenter
    var body: some View {
        DisclosureGroup("Detalhes técnicos") {
            VStack(alignment: .leading, spacing: 4) {
                if let original = presenter.editor.original {
                    LabeledContent("Pedido") { Text(verbatim: original.requestID).textSelection(.enabled) }
                    LabeledContent("Corpo (SHA-256)") { Text(verbatim: String(original.bodyHash.prefix(16)) + "…").textSelection(.enabled) }
                }
                if let action = presenter.editor.action {
                    LabeledContent("Ação") { Text(verbatim: action.id).textSelection(.enabled) }
                    LabeledContent("Situação na base") { Text(verbatim: action.state.rawValue) }
                    LabeledContent("Hash do pedido") { Text(verbatim: String(action.requestHash.prefix(16)) + "…").textSelection(.enabled) }
                }
            }.font(.caption.monospaced()).padding(.top, 4)
        }
        .font(.caption)
        .accessibilityIdentifier("owner-proposal.details")
    }
}

/// UI R1: which connected MCP accounts this bot uses, and which tools of each. One/some/all is the owner's choice over
/// the host's CURRENT snapshot ("all" lists every account available now; later accounts never join by themselves).
/// Names are the owner's aliases from Gerenciar conexões; nothing here verifies which external account (e.g. which
/// Gmail) is behind a connection. Server/connection IDs and pins stay under Detalhes técnicos.
@MainActor struct BotMcpAccountsView: View {
    let presenter: BotOwnerConfigurationPresenter
    /// The existing connection list (aliases, status). Read-only here.
    let servers: [McpServerSummary]
    let botName: String
    let onOpenMemory: () -> Void
    @State private var expanded: Set<String> = []
    @State private var showingReview = false

    private var review: McpInstanceSelectionReview? { presenter.editor.mcpReview }
    private func name(_ serverID: String) -> String { servers.first { $0.id == serverID }?.name ?? serverID }
    private func label(_ serverID: String) -> String {
        let own = name(serverID), ids = servers.map(\.id)
        let repeated = servers.contains { $0.id != serverID && $0.name == own }
        return repeated ? own + " · " + McpInstanceLabel.short(serverID, among: ids) : own
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Escolha quais contas conectadas este bot usa e as ferramentas de cada uma. Nada muda até você revisar e aprovar.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let context = presenter.context, !context.isMcp, presenter.stage.isOpen {
                Label { Text("Há uma mudança da Memória aberta nesta janela. Conclua-a antes de revisar MCPs.") } icon: { Image(systemName: "hourglass") }
                    .font(.footnote).foregroundStyle(.orange)
                Button("Abrir Memória e instruções", action: onOpenMemory).controlSize(.small).accessibilityIdentifier("bot-settings.mcp-accounts.open-memory")
            }
            if presenter.context?.isMcp == true { pendingBanner }
            if presenter.needsRenew {
                HStack {
                    Text("O acesso desta janela expirou ou a base reiniciou.").font(.footnote).foregroundStyle(.orange)
                    Button("Reabrir acesso") { Task { await presenter.renew() } }.controlSize(.small)
                        .disabled(presenter.busy).accessibilityIdentifier("bot-settings.mcp-accounts.renew")
                }
            }
            if let review, let draft = presenter.draft {
                accounts(review, draft)
            } else if presenter.editor.hostSession == nil && presenter.notice == .unavailable {
                Text("Esta base não abriu a escolha de contas para esta janela. Use o modo anterior, abaixo, ou reabra os ajustes depois de atualizar o Dexter.")
                    .font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-settings.mcp-accounts.unavailable")
            } else {
                ProgressView("Lendo as contas deste bot…").controlSize(.small)
            }
            noticeLine
        }
        .task { await presenter.refreshMcp() }
        .sheet(isPresented: $showingReview) {
            McpAccountsReviewSheet(presenter: presenter, servers: servers, botName: botName, label: label) { showingReview = false }
        }
        .onChange(of: presenter.windowCurrent) { _, current in if !current { presenter.latchIfRetired(); showingReview = false } }
    }

    @ViewBuilder private var pendingBanner: some View {
        let stage = presenter.stage
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: stage == .awaitingDecision ? "checkmark.seal" : stage.needsCheck ? "questionmark.circle" : "checkmark.circle")
                .foregroundStyle(stage.needsCheck ? Color.orange : Color.accentColor)
            Group {
                switch stage {
                case .awaitingDecision: Text("Uma mudança de MCPs aguarda sua decisão.")
                case .prepared: Text("Uma mudança revisada ainda não foi enviada.")
                case .succeeded, .denied, .blocked: Text("A última mudança de MCPs terminou. Abra para ver o resultado.")
                default: Text("Uma mudança de MCPs está sem resultado confirmado. Abra e use Conferir estado.")
                }
            }.font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("Abrir") { showingReview = true }.accessibilityIdentifier("bot-settings.mcp-accounts.open-pending")
        }
        .padding(10)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-settings.mcp-accounts.pending")
    }

    @ViewBuilder private func accounts(_ review: McpInstanceSelectionReview, _ draft: McpAccountsDraft) -> some View {
        let locked = presenter.context != nil || !presenter.windowCurrent || presenter.busy
        let available = review.instances.sorted { label($0.serverId).localizedCaseInsensitiveCompare(label($1.serverId)) == .orderedAscending }
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Usar", selection: Binding(get: { draft.mode }, set: { mode in presenter.updateDraft { $0.setMode(mode) }
                    if mode == .all { Task { for id in review.instances.map(\.serverId) { await presenter.loadCatalog(id) } } } })) {
                    Text("Uma conta").tag(McpAccountsSelectionMode.one)
                    Text("Algumas contas").tag(McpAccountsSelectionMode.some)
                    Text("Todas as conectadas agora").tag(McpAccountsSelectionMode.all)
                }
                .pickerStyle(.segmented).labelsHidden().disabled(locked)
                .accessibilityIdentifier("bot-settings.mcp-accounts.mode")
                modeCaption(review, draft)
                if available.isEmpty && review.unavailableInstances.isEmpty {
                    ContentUnavailableView("Nenhuma conta conectada", systemImage: "puzzlepiece.extension",
                        description: Text("Cadastre e conecte uma conta em Gerenciar conexões; depois escolha aqui o que este bot usa."))
                }
                ForEach(available) { instance in
                    accountRow(instance.serverId, review: review, draft: draft, locked: locked)
                    if instance.id != available.last?.id { Divider() }
                }
                ForEach(review.unavailableInstances, id: \.serverId) { item in
                    unavailableRow(item.serverId, selected: review.selected.contains { $0.serverId == item.serverId })
                }
                Text("Cada nome é um apelido dado por você em Gerenciar conexões. O Dexter não confirma qual conta (por exemplo, qual Gmail) está por trás de cada conexão.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(8)
        } label: {
            Text("Contas deste bot").font(.headline)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-settings.mcp-accounts")
        HStack {
            Button("Descartar") { presenter.discardDraft() }
                .disabled(locked || !presenter.mcpDraftDirty).accessibilityIdentifier("bot-settings.mcp-accounts.discard")
            Spacer()
            Button("Revisar mudança…") { Task { await presenter.planReview(); if presenter.reviewedPlan != nil { showingReview = true } } }
                .buttonStyle(.borderedProminent)
                .disabled(!presenter.canStartReview || draft.issue(in: review) != nil)
                .accessibilityIdentifier("bot-settings.mcp-accounts.review")
        }
        if presenter.context == nil, let issue = draft.issue(in: review), issue != .noChange { issueLine(issue) }
    }

    @ViewBuilder private func modeCaption(_ review: McpInstanceSelectionReview, _ draft: McpAccountsDraft) -> some View {
        Group {
            switch draft.mode {
            case .one: Text("O bot usa só a conta marcada.")
            case .some: Text("Marque as contas que o bot pode usar. Sem nenhuma marcada, o bot fica sem ferramentas MCP.")
            case .all:
                if McpAccountsPresentation.allConnectedAvailable(review) {
                    let count = String(review.instances.count)
                    Text("As \(count) contas conectadas agora. Contas conectadas depois não entram sozinhas.")
                } else {
                    Text("Indisponível enquanto alguma conta não estiver pronta. Use Algumas contas ou resolva a conta em Gerenciar conexões.")
                        .foregroundStyle(.orange)
                }
            }
        }
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("bot-settings.mcp-accounts.mode-caption")
    }

    @ViewBuilder private func accountRow(_ serverID: String, review: McpInstanceSelectionReview, draft: McpAccountsDraft, locked: Bool) -> some View {
        let included = draft.isIncluded(serverID, in: review)
        let chosen = draft.tools(for: serverID)
        let catalog = presenter.catalogs[serverID]
        let current = review.selected.first { $0.serverId == serverID }?.toolIds.count ?? 0
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if draft.mode == .all {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor).accessibilityLabel(Text("Incluída"))
                } else {
                    Toggle(isOn: Binding(get: { included }, set: { on in presenter.include(serverID, on); if on { expanded.insert(serverID) } })) { EmptyView() }
                        .toggleStyle(.checkbox).labelsHidden().disabled(locked)
                        .accessibilityLabel(Text(verbatim: label(serverID)))
                        .accessibilityIdentifier("bot-settings.mcp-accounts.include.\(serverID)")
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: label(serverID)).font(.body.weight(.medium))
                    Group {
                        if current == 0 { Text("Conectada · nenhuma ferramenta ligada para este bot agora") }
                        else { let count = String(current); Text("Conectada · \(count) ferramenta(s) ligada(s) para este bot agora") }
                    }.font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if included {
                    let chosenCount = String(chosen.count)
                    Text("\(chosenCount) escolhida(s)").font(.caption).foregroundStyle(chosen.isEmpty ? Color.orange : Color.secondary)
                    Button {
                        if expanded.contains(serverID) { expanded.remove(serverID) } else { expanded.insert(serverID); Task { await presenter.loadCatalog(serverID) } }
                    } label: { if expanded.contains(serverID) { Text("Ocultar ferramentas") } else { Text("Ferramentas…") } }
                    .controlSize(.small).accessibilityIdentifier("bot-settings.mcp-accounts.tools.\(serverID)")
                }
            }
            if included && (expanded.contains(serverID) || chosen.isEmpty) {
                if let catalog {
                    toolList(serverID, catalog: catalog, chosen: chosen, locked: locked)
                } else if presenter.catalogFailures.contains(serverID) {
                    HStack {
                        Text("Não foi possível ler as ferramentas desta conta.").font(.caption).foregroundStyle(.orange)
                        Button("Tentar ler de novo") { Task { await presenter.loadCatalog(serverID, force: true) } }.controlSize(.small)
                    }
                } else {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-settings.mcp-accounts.row.\(serverID)")
    }

    @ViewBuilder private func toolList(_ serverID: String, catalog: McpInstanceSelectionCatalog, chosen: Set<String>, locked: Bool) -> some View {
        let usable = catalog.tools.filter { $0.state == "publishable" }
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button("Marcar todas") { presenter.updateDraft { $0.setTools(Set(usable.map(\.id)), serverID: serverID) } }
                    .controlSize(.small).disabled(locked || usable.isEmpty)
                Button("Só leitura") { presenter.updateDraft { $0.setTools(Set(usable.filter { $0.effect == "read" }.map(\.id)), serverID: serverID) } }
                    .controlSize(.small).disabled(locked || !usable.contains { $0.effect == "read" })
                    .help("Marca só as ferramentas que consultam dados, sem alterar nada no serviço.")
                Button("Desmarcar") { presenter.updateDraft { $0.setTools([], serverID: serverID) } }
                    .controlSize(.small).disabled(locked || chosen.isEmpty)
            }
            if catalog.tools.isEmpty { Text("Esta conta não tem ferramentas descobertas.").font(.caption).foregroundStyle(.secondary) }
            ForEach(catalog.tools) { tool in
                Toggle(isOn: Binding(get: { chosen.contains(tool.id) }, set: { on in presenter.updateDraft { $0.setTool(tool.id, on, serverID: serverID) } })) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: tool.name).font(.callout)
                        Group {
                            if tool.state != "publishable" { Text("Indisponível pela política do Dexter") }
                            else if tool.effect == "read" { Text("Leitura") } else { Text("Pode alterar dados") }
                        }.font(.caption).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.checkbox)
                .disabled(locked || tool.state != "publishable")
                .help(Text(verbatim: tool.description))
                .accessibilityIdentifier("bot-settings.mcp-accounts.tool.\(serverID).\(tool.id)")
            }
        }
        .padding(.leading, 28)
    }

    @ViewBuilder private func unavailableRow(_ serverID: String, selected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(verbatim: label(serverID)).font(.body.weight(.medium))
                Spacer()
                Text("Indisponível agora").font(.caption).foregroundStyle(.secondary)
            }
            Text("As ferramentas desta conta não estão prontas (catálogo ou conexão). Resolva em Gerenciar conexões.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if selected {
                Text("Este bot usa esta conta hoje. Aplicar qualquer mudança agora tira as ferramentas dela deste bot.")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-settings.mcp-accounts.unavailable-selected.\(serverID)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-settings.mcp-accounts.unavailable-row.\(serverID)")
    }

    @ViewBuilder private func issueLine(_ issue: McpAccountsDraft.Issue) -> some View {
        Group {
            switch issue {
            case .noChange: EmptyView()
            case .chooseOneAccount: Text("Marque uma conta.")
            case .chooseTools(let ids): let names = ListFormatter.localizedString(byJoining: ids.map(label)); Text("Escolha ao menos uma ferramenta em: \(names).")
            case .allNeedsEveryAccount: Text("Todas as conectadas agora não está disponível enquanto alguma conta não estiver pronta.")
            case .noAccounts: Text("Não há contas conectadas para escolher.")
            }
        }
        .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("bot-settings.mcp-accounts.issue")
    }

    @ViewBuilder private var noticeLine: some View {
        switch presenter.notice {
        case .planConflict?:
            Text("As contas ou a seleção mudaram na base desde a leitura. Use Atualizar e revise de novo; nada foi enviado.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-settings.mcp-accounts.notice")
        case .planRefused?:
            Text("A base recusou esta seleção. Confira as contas e ferramentas e revise de novo; nada foi enviado.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-settings.mcp-accounts.notice")
        case .readFailed?:
            Text("Não foi possível confirmar a leitura. Os dados anteriores foram mantidos; use Atualizar.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-settings.mcp-accounts.notice")
        default: EmptyView()
        }
    }
}

/// The exact change the host materialized, then the approval and the result of the same action.
@MainActor struct McpAccountsReviewSheet: View {
    let presenter: BotOwnerConfigurationPresenter
    let servers: [McpServerSummary]
    let botName: String
    let label: (String) -> String
    let onClose: () -> Void

    private var planAndReview: (McpInstanceSelectionPlan, McpInstanceSelectionReview)? {
        if case .mcp(let plan, let review)? = presenter.context { return (plan, review) }
        if let plan = presenter.reviewedPlan, let review = presenter.reviewedAgainst { return (plan, review) }
        return nil
    }
    private func toolName(_ serverID: String, _ toolID: String) -> String {
        presenter.catalogs[serverID]?.tools.first { $0.id == toolID }?.name ?? toolID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Revisar mudança de MCPs").font(.title2.weight(.semibold))
            Text("Somente para \(botName). A conexão compartilhada e os outros bots não mudam.")
                .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let pair = planAndReview {
                ScrollView { changes(pair.0, pair.1).frame(maxWidth: .infinity, alignment: .leading) }.frame(minHeight: 120, maxHeight: 280)
                Text("Ferramentas ligadas chegam na próxima resposta do bot. Cada chamada continua seguindo a regra de aprovação deste bot.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                planDetails(pair.0)
            }
            Divider()
            OwnerProposalStagePanel(presenter: presenter, approveTitle: "Aprovar e aplicar", requestTitle: "Pedir aprovação",
                                    onRequest: { Task { await presenter.requestMcpApproval() } },
                                    onCancel: { if presenter.context != nil { presenter.discardPrepared() } else { presenter.cancelReview() }; onClose() },
                                    onDone: onClose, outcome: outcomeText)
        }
        .padding(24)
        .frame(minWidth: 560, idealWidth: 620, minHeight: 540)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-settings.mcp-accounts.review-sheet")
    }

    private var outcomeText: Text? {
        switch presenter.mcpOutcome {
        case .applied(let matches)?:
            return matches ? Text("Aplicada. As ferramentas valem a partir da próxima resposta deste bot.")
                : Text("Aplicada, mas a seleção mudou depois na base. Use Atualizar para ver o estado atual.")
        case .partial?: return Text("Aplicada em parte. Nada foi repetido; o que não entrou continua fora. Revise uma nova mudança se precisar.")
        case .pending?: return Text("Aprovada; a base ainda está registrando o efeito. Use Conferir estado.")
        case .noEffectReceipt?: return Text("Aprovada; a base ainda não mostra o recibo do efeito. Conferir estado só lê; nada é reenviado.")
        case nil: return nil
        }
    }

    @ViewBuilder private func changes(_ plan: McpInstanceSelectionPlan, _ review: McpInstanceSelectionReview) -> some View {
        let rows = McpAccountsPresentation.changes(review: review, plan: plan)
        VStack(alignment: .leading, spacing: 10) {
            if plan.mode == .allConnected {
                let names = ListFormatter.localizedString(byJoining: plan.targets.map { label($0.serverId) })
                Text("Todas as conectadas agora: \(names). Contas conectadas depois não entram sozinhas.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rows.filter { $0.kind != .unchanged }) { row in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(verbatim: label(row.serverID)).font(.headline)
                        switch row.kind {
                        case .added: Text("Passa a usar").font(.caption).foregroundStyle(Color.accentColor)
                        case .removed: Text("Deixa de usar").font(.caption).foregroundStyle(.orange)
                        default: Text("Muda ferramentas").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !row.added.isEmpty { Label { Text(verbatim: row.added.map { toolName(row.serverID, $0) }.joined(separator: ", ")) } icon: { Image(systemName: "plus.circle") }.font(.callout) }
                    if !row.removed.isEmpty { Label { Text(verbatim: row.removed.map { toolName(row.serverID, $0) }.joined(separator: ", ")) } icon: { Image(systemName: "minus.circle") }.font(.callout).foregroundStyle(.orange) }
                    if row.kind == .removed { Text("Só este bot perde o acesso; a conexão continua cadastrada.").font(.caption).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("bot-settings.mcp-accounts.change.\(row.serverID)")
            }
            let same = ListFormatter.localizedString(byJoining: rows.filter { $0.kind == .unchanged }.map { label($0.serverID) })
            if !same.isEmpty {
                Text("Sem mudança: \(same).").font(.caption).foregroundStyle(.secondary)
            }
            if rows.allSatisfy({ $0.kind == .unchanged }) && plan.mode == .allConnected {
                Text("As ferramentas ficam iguais; a mudança registra a lista atual de contas.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func planDetails(_ plan: McpInstanceSelectionPlan) -> some View {
        DisclosureGroup("Detalhes técnicos da seleção") {
            VStack(alignment: .leading, spacing: 4) {
                LabeledContent("Revisão esperada") { Text(verbatim: String(plan.expectedRevision)) }
                LabeledContent("Inventário") { Text(verbatim: String(plan.inventoryPin.prefix(16)) + "…") }
                LabeledContent("Seleção") { Text(verbatim: String(plan.selectionPin.prefix(16)) + "…") }
                ForEach(plan.targets, id: \.serverId) { target in
                    Text(verbatim: "\(target.serverId) · \(target.connectionId) · r\(target.connectionRevision) · \(target.toolIds.count)")
                }
                Text("A seleção identifica conexões, não verifica a conta autenticada.")
            }.font(.caption.monospaced()).textSelection(.enabled).padding(.top, 4)
        }
        .font(.caption)
        .accessibilityIdentifier("bot-settings.mcp-accounts.plan-details")
    }
}
#endif
