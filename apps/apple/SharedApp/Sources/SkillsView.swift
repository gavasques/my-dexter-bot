#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Plain-text immutable versions and explicit owner-local CAS activation. No engine/tool grants.
struct SkillsView: View {
    let model: DexterAppModel
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss
    @State private var client: HostClient?
    @State private var hostBots: [Bot] = []
    @State private var perBot = false
    @State private var botID = ""
    @State private var catalog: [SkillLock] = []
    @State private var next: String?
    @State private var seenCatalogCursors: Set<String> = []
    @State private var selectedIdentity = ""
    @State private var content: SkillVersion?
    @State private var activations: [SkillActivation] = []
    @State private var scopeReady = false
    @State private var loaded = false
    @State private var busy = false
    @State private var requiresRefresh = false
    @State private var unavailable = false
    @State private var notice: String?
    @State private var newID = ""
    @State private var newVersion = ""
    @State private var markdown = ""
    @State private var confirmingRegistration = false
    @State private var confirmingActivation = false
    @State private var confirmingDeactivation = false
    @State private var generation = UUID()
    @State private var requestTask: Task<Void, Never>?

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var scope: SkillScope? { perBot ? (botID.isEmpty ? nil : .bot(botID)) : .global }
    private var selected: SkillLock? { catalog.first { $0.identity == selectedIdentity } }
    private var activeLock: SkillLock? { selected.flatMap { selected in activations.first { $0.skillId == selected.id }?.lock } }
    private var registration: SkillRegistrationInput { .init(id: newID, version: newVersion, markdown: markdown) }
    private var canMutate: Bool { client != nil && model.canEditBotProfiles && !busy && !requiresRefresh && !unavailable }
    private var scopeLabel: String {
        guard perBot else { return text("Global — todos os bots desta base", "Global — all bots on this host") }
        return hostBots.first { $0.id == botID }?.name ?? text("Escolha um bot", "Choose a bot")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(text("Versões imutáveis de instruções em Markdown. Registrar não ativa uma skill e não concede ferramentas, credenciais ou permissões.", "Immutable Markdown instruction versions. Registration does not activate a skill or grant tools, credentials or permissions."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if client == nil {
                    Section { Text(text("Conecte como proprietário ao host local deste Mac para gerenciar skills.", "Connect as owner to this Mac’s local host to manage skills.")).foregroundStyle(.secondary) }
                } else {
                    scopeSection
                    catalogSection
                    registrationSection
                }
                if busy { Section { ProgressView(text("Consultando o host…", "Contacting host…")) } }
                if unavailable { Section { Text(text("Skills estão indisponíveis neste host. Atualize após conferir a conexão e a configuração.", "Skills are unavailable on this host. Refresh after checking its connection and configuration.")).foregroundStyle(.secondary) } }
                if let notice { Section { Text(notice).foregroundStyle(.orange).accessibilityIdentifier("skills.notice") } }
            }
            .formStyle(.grouped)
            .navigationTitle(text("Catálogo de habilidades", "Skills catalog"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("Concluir", "Done")) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("skills.close")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(text("Atualizar", "Refresh"), action: refresh)
                        .disabled(busy || client == nil || !model.canEditBotProfiles)
                        .accessibilityIdentifier("skills.refresh")
                }
            }
        }
        .frame(minWidth: 600, idealWidth: 720, minHeight: 520, idealHeight: 720)
        .confirmationDialog(text("Registrar nova versão?", "Register a new version?"), isPresented: $confirmingRegistration, titleVisibility: .visible) {
            Button(text("Registrar", "Register"), action: register)
            Button(text("Cancelar", "Cancel"), role: .cancel) {}
        } message: {
            Text(text("Será registrada a versão imutável \(newID) · \(newVersion). Ela não será ativada automaticamente.", "Immutable version \(newID) · \(newVersion) will be registered. It will not be activated automatically."))
        }
        .confirmationDialog(text("Ativar esta versão?", "Activate this version?"), isPresented: $confirmingActivation, titleVisibility: .visible) {
            Button(text("Ativar", "Activate")) { setActivation(deactivate: false) }
            Button(text("Cancelar", "Cancel"), role: .cancel) {}
        } message: {
            Text(text("\(selected?.id ?? "") · \(selected?.version ?? "") em \(scopeLabel). A opção global afeta os bots desta base; nenhuma permissão de ferramenta é concedida.", "\(selected?.id ?? "") · \(selected?.version ?? "") for \(scopeLabel). Global scope affects this host’s bots; no tool permissions are granted."))
        }
        .confirmationDialog(text("Desativar esta skill?", "Deactivate this skill?"), isPresented: $confirmingDeactivation, titleVisibility: .visible) {
            Button(text("Desativar", "Deactivate"), role: .destructive) { setActivation(deactivate: true) }
            Button(text("Cancelar", "Cancel"), role: .cancel) {}
        } message: { Text(text("A ativação de \(selected?.id ?? "") será removida de \(scopeLabel). As versões registradas são preservadas.", "Activation of \(selected?.id ?? "") will be removed from \(scopeLabel). Registered versions are preserved.")) }
        .task(id: model.hostAddress + "|" + model.backendLabel) { open() }
        .onDisappear { close() }
        .onChange(of: perBot) { _, _ in changeScope() }
        .onChange(of: botID) { _, _ in changeScope() }
        .onChange(of: selectedIdentity) { _, _ in content = nil }
    }

    private var scopeSection: some View {
        Section(text("Ativação", "Activation")) {
            Picker(text("Escopo", "Scope"), selection: $perBot) {
                Text(text("Global", "Global")).tag(false)
                Text(text("Por bot", "Per bot")).tag(true)
            }.disabled(busy).accessibilityIdentifier("skills.scope")
            if perBot {
                Picker(text("Bot", "Bot"), selection: $botID) {
                    Text(text("Escolha um bot", "Choose a bot")).tag("")
                    ForEach(hostBots) { Text($0.name).tag($0.id) }
                }.disabled(busy).accessibilityIdentifier("skills.bot")
            } else {
                Text(text("Global aplica a skill aos bots do proprietário desta base.", "Global applies the skill to this host owner’s bots."))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let activeLock { LabeledContent(text("Versão ativa neste escopo", "Active version in this scope"), value: activeLock.version) }
            else if scopeReady && selected != nil { Text(text("Esta skill não está ativa neste escopo.", "This skill is not active in this scope.")).foregroundStyle(.secondary) }
            if requiresRefresh { Text(text("Atualize antes de outra alteração. Nenhuma solicitação será repetida automaticamente.", "Refresh before another change. No request will be retried automatically.")).font(.footnote).foregroundStyle(.orange) }
        }
    }
    private var catalogSection: some View {
        Section(text("Catálogo e conteúdo", "Catalog and content")) {
            if loaded && catalog.isEmpty { Text(text("Nenhuma skill registrada.", "No registered skills.")).foregroundStyle(.secondary) }
            if !catalog.isEmpty {
                Picker(text("Skill e versão", "Skill and version"), selection: $selectedIdentity) {
                    Text(text("Escolha uma versão", "Choose a version")).tag("")
                    ForEach(catalog, id: \.identity) { Text(verbatim: "\($0.id) · \($0.version)").tag($0.identity) }
                }.disabled(busy).accessibilityIdentifier("skills.version")
                HStack {
                    Button(text("Ler conteúdo", "Read content"), action: readContent).disabled(busy || selected == nil)
                    Button(text("Ativar…", "Activate…")) { confirmingActivation = true }
                        .disabled(!canMutate || !scopeReady || scope == nil || selected == nil || selected == activeLock)
                        .accessibilityIdentifier("skills.activate")
                    Button(text("Desativar…", "Deactivate…")) { confirmingDeactivation = true }
                        .disabled(!canMutate || !scopeReady || scope == nil || activeLock == nil)
                        .accessibilityIdentifier("skills.deactivate")
                }
            }
            if next != nil { Button(text("Carregar mais", "Load more"), action: loadMore).disabled(busy).accessibilityIdentifier("skills.more") }
            if let content {
                DisclosureGroup(text("Detalhes técnicos", "Technical details")) {
                    Text(verbatim: "id \(content.lock.id) · \(content.lock.version)\nsha256 \(content.lock.sha256)\ncommit \(content.lock.commit)\n\(content.lock.path)")
                        .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.caption).accessibilityIdentifier("skills.technical")
                ScrollView { Text(verbatim: content.markdown).font(.system(.body, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(minHeight: 120, maxHeight: 260).accessibilityIdentifier("skills.markdown")
            }
        }
    }
    private var registrationSection: some View {
        Section {
            DisclosureGroup(text("Registrar nova versão", "Register a new version")) {
                TextField(text("ID da skill", "Skill ID"), text: $newID).accessibilityIdentifier("skills.new-id")
                TextField(text("Versão x.y.z", "Version x.y.z"), text: $newVersion).accessibilityIdentifier("skills.new-version")
                TextEditor(text: $markdown).frame(minHeight: 130).accessibilityLabel("Markdown").accessibilityIdentifier("skills.new-markdown")
                Text(text("ID: letras, números, _ ou -, até 128 caracteres. Markdown obrigatório; limite de 32768.", "ID: letters, digits, _ or -, up to 128 characters. Markdown is required; limit 32768."))
                    .font(.footnote).foregroundStyle(.secondary)
                Button(text("Registrar versão…", "Register version…")) { confirmingRegistration = true }
                    .disabled(!canMutate || !registration.isValid || catalog.contains { $0.id == newID && $0.version == newVersion })
                    .accessibilityIdentifier("skills.register")
            }.disabled(busy)
        }
    }

    private func open() {
        close(); catalog = []; next = nil; seenCatalogCursors = []; activations = []; scopeReady = false
        loaded = false; requiresRefresh = false; unavailable = false; notice = nil; content = nil; selectedIdentity = ""
        client = model.canEditBotProfiles ? model.makeLocalMcpClient() : nil
        refresh()
    }
    private func close() {
        generation = UUID(); requestTask?.cancel(); requestTask = nil; client?.close(); client = nil; busy = false
        confirmingRegistration = false; confirmingActivation = false; confirmingDeactivation = false
    }
    private func check(_ token: UUID) throws {
        guard token == generation, model.canEditBotProfiles, !Task.isCancelled else { throw CancellationError() }
    }
    private func run(mutation: Bool = false, operation: @escaping @MainActor (HostClient, UUID) async throws -> Void) {
        guard !busy, let client, model.canEditBotProfiles, !mutation || canMutate else { return }
        busy = true; notice = nil
        let token = generation
        requestTask = Task { @MainActor in
            do { try await operation(client, token); try check(token) }
            catch {
                guard token == generation, !Task.isCancelled else { return }
                scopeReady = false
                if mutation || (error as? HostClientError) == .conflict { requiresRefresh = true }
                unavailable = (error as? HostClientError) == .notReady || (error as? HostClientError) == .notFound
                notice = (error as? HostClientError) == .conflict
                    ? text("O registro ou a ativação mudou. Atualize e confira o estado antes de tentar novamente; nada foi reenviado.", "Registration or activation changed. Refresh and check its state before trying again; nothing was resent.")
                    : text("Não foi possível confirmar a operação. Os últimos dados foram mantidos. Use Atualizar antes de outra alteração.", "Could not confirm the operation. The last data was retained. Use Refresh before another change.")
                requiresRefresh = true
            }
            guard token == generation else { return }; busy = false; requestTask = nil
        }
    }
    private func fetchActivations(_ client: HostClient, scope: SkillScope, token: UUID) async throws -> [SkillActivation] {
        var values: [SkillActivation] = [], cursor: String?, seen: Set<String> = []
        let deadline = Date().addingTimeInterval(30)
        for _ in 0..<100 {
            try check(token); guard Date() < deadline else { throw HostClientError.notReady }
            let page = try await client.listSkillActivations(scope: scope, after: cursor); try check(token)
            for item in page.items { guard !values.contains(where: { $0.skillId == item.skillId }) else { throw HostClientError.contractMismatch }; values.append(item) }
            guard let next = page.next else { return values }
            guard seen.insert(next).inserted else { throw HostClientError.contractMismatch }; cursor = next
        }
        throw HostClientError.notReady
    }
    private func refresh() {
        run { client, token in
            let bots = try await client.listBots(); try check(token)
            let page = try await client.listSkills(); try check(token)
            if perBot, !bots.contains(where: { $0.id == botID }) { botID = "" }
            let currentScope = scope
            let active: [SkillActivation]
            if let currentScope { active = try await fetchActivations(client, scope: currentScope, token: token) }
            else { active = [] }
            try check(token)
            hostBots = bots; catalog = page.items; next = page.next; seenCatalogCursors = []; if let next { seenCatalogCursors.insert(next) }
            activations = active; scopeReady = currentScope != nil; loaded = true; requiresRefresh = false; unavailable = false; content = nil
            if !catalog.contains(where: { $0.identity == selectedIdentity }) { selectedIdentity = "" }
        }
    }
    private func changeScope() {
        activations = []; scopeReady = false
        guard let scope else { return }
        run { client, token in
            let values = try await fetchActivations(client, scope: scope, token: token); try check(token)
            activations = values; scopeReady = true
        }
    }
    private func loadMore() {
        guard let cursor = next else { return }
        run { client, token in
            let page = try await client.listSkills(after: cursor); try check(token)
            var additions: [SkillLock] = []
            for item in page.items {
                if let existing = catalog.first(where: { $0.identity == item.identity }) {
                    guard existing == item else { throw HostClientError.contractMismatch }
                } else { additions.append(item) }
            }
            if let next = page.next { guard seenCatalogCursors.insert(next).inserted else { throw HostClientError.contractMismatch } }
            catalog += additions; next = page.next
        }
    }
    private func readContent() {
        guard let selected else { return }
        run { client, token in
            let version = try await client.getSkillVersion(id: selected.id, version: selected.version); try check(token)
            guard version.lock == selected else { throw HostClientError.conflict }; content = version
        }
    }
    private func register() {
        let input = registration
        guard input.isValid, !catalog.contains(where: { $0.id == input.id && $0.version == input.version }) else { return }
        run(mutation: true) { client, token in
            let lock = try await client.registerSkill(input); try check(token)
            catalog.append(lock); selectedIdentity = lock.identity; content = nil
            notice = text("Versão registrada. Nenhuma ativação foi alterada.", "Version registered. No activation was changed.")
        }
    }
    private func setActivation(deactivate: Bool) {
        guard scopeReady, let scope, let selected else { return }
        let observed = activations.first { $0.skillId == selected.id }?.lock
        guard !deactivate || observed != nil else { return }
        let input = SkillActivationInput(scope: scope, expected: observed.map(SkillActivationExpected.init(lock:)), version: deactivate ? nil : selected.version)
        run(mutation: true) { client, token in
            let updated = try await client.setSkillActivation(skillID: selected.id, input: input); try check(token)
            activations.removeAll { $0.skillId == selected.id }; if updated.lock != nil { activations.append(updated) }
            notice = deactivate ? text("Skill desativada neste escopo.", "Skill deactivated in this scope.") : text("Versão ativada neste escopo.", "Version activated in this scope.")
        }
    }
}
#endif
