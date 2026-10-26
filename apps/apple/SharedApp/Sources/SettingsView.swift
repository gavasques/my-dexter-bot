import DexterHostClient
import DexterAppCore
import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SettingsView: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmsStorageReset = false
    @State private var confirmsFixture = false
    @State private var diagnosticCopied = false
    #if !os(macOS)
    @State private var trustedBundleText = ""
    @State private var pairedClientName = ""
    @State private var pairingBusy = false
    @State private var showsMacConnection = false
    #endif
    #if os(macOS)
    @State private var showsConnectOtherBase = false
    /// Optional: synthetic hosts without the router keep a local tab and the old single error presenter.
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @State private var localTab: DexterSettingsTab = .general
    @State private var showsMcpConnections = false
    /// The native connection Conexões asked to open; nil opens the manager without a selection.
    @State private var mcpConnectionToOpen: String?
    @State private var showsSkills = false
    @State private var macAgentClient: HostClient?
    @State private var showsAdvancedMac = false
    private let localHost: LocalHostLaunchCoordinator?
    private let macAgent: LocalMacAgentProcess?
    /// Injected only by QA/tests; the app uses the scoped Keychain item of this Mac.
    private let browserUseKeyStore: any BrowserUseAPIKeyStore
    /// Pre-fills "Nome deste Mac" in Conectar a outra base. QA injects a synthetic name; the app reads the computer name.
    private let suggestedClientName: String?
    /// Sidebar plus a readable pane in Portuguese or English.
    private static let settingsWidth: CGFloat = 860

    init(localHost: LocalHostLaunchCoordinator? = nil, macAgent: LocalMacAgentProcess? = nil,
         browserUseKeyStore: (any BrowserUseAPIKeyStore)? = nil, suggestedClientName: String? = nil) {
        self.localHost = localHost
        self.macAgent = macAgent
        self.browserUseKeyStore = browserUseKeyStore ?? ScopedBrowserUseAPIKeychain()
        self.suggestedClientName = suggestedClientName
    }
    #endif

    var body: some View {
        Group {
            #if os(macOS)
            macSettingsTabs
                .sheet(isPresented: $showsMcpConnections, onDismiss: { mcpConnectionToOpen = nil }) { McpConnectionsView(initialServerID: mcpConnectionToOpen) }
                .sheet(isPresented: $showsSkills) { SkillsView(model: model) }
                .sheet(isPresented: $showsConnectOtherBase) {
                    ConnectOtherBaseSheet(localAddress: localHost?.launchHostAddress ?? Self.defaultLocalAddress,
                                          suggestedName: suggestedClientName ?? ConnectOtherBaseDefaults.computerName)
                }

            #else
            NavigationStack {
                Form {
                    OnboardingReadinessSection()
                    storageSection
                    #if DEBUG
                    developmentSection
                    #endif
                    pairedHostSection
                    hostBaseSection
                    RemoteConnectionsSection()
                    DevicesSettingsSection()
                }
                .navigationTitle("Ajustes")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Concluir") { dismiss() }
                    }
                }
            }
            .sheet(isPresented: $showsMacConnection) {
                NavigationStack {
                    IOSMacConnectionView().navigationTitle("Conectar ao Mac").navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Fechar") { showsMacConnection = false }
                                    .accessibilityIdentifier("ios-pairing.close")
                            }
                        }
                }
            }
            #endif
        }
        #if os(macOS)
        .confirmationDialog(
            "Recuperar o armazenamento local?",
            isPresented: $confirmsStorageReset,
            titleVisibility: .visible
        ) {
            Button("Recuperar e reconectar", role: .destructive) { recoverStorage() }
                .accessibilityIdentifier("settings.reset-storage.confirm")
            if developmentToolsAvailable {
                Button("Redefinir e usar fixture", role: .destructive) { _ = model.resetCorruptStorage() }
            }
            Button("Cancelar", role: .cancel) { }
        } message: {
            Text("Os dados atuais estão ilegíveis. Se houver um ID de envio pendente no trecho danificado, o app não pode recuperá-lo. Confirme no host se existe uma mensagem enviada antes de recuperar. Depois, o app reconecta ao Dexter deste Mac.")
        }
        .confirmationDialog("Trocar para a demonstração?", isPresented: $confirmsFixture, titleVisibility: .visible) {
            Button("Usar demonstração", role: .destructive) { model.useFixture(); dismiss() }
            Button("Cancelar", role: .cancel) { }
        } message: {
            Text("Os bots desta base deixam de aparecer neste app até você usar o host local de novo. Nada é apagado na base.")
        }
        #else
        .confirmationDialog(
            "Redefinir armazenamento local?",
            isPresented: $confirmsStorageReset,
            titleVisibility: .visible
        ) {
            #if DEBUG
            Button("Redefinir e usar fixture", role: .destructive) {
                _ = model.resetCorruptStorage()
            }
            #else
            Button("Redefinir armazenamento e reconectar", role: .destructive) {
                _ = model.resetCorruptStorage(usesDemo: false)
            }
            #endif
            Button("Cancelar", role: .cancel) { }
        } message: {
            Text("Os dados atuais estão ilegíveis. Se houver um ID de envio pendente no trecho danificado, o app não pode recuperá-lo. Confirme no host se existe uma mensagem enviada antes de redefinir.")
        }
        #endif
        #if os(macOS)
        .task(id: model.hostAddress + "|" + model.backendLabel) {
            macAgentClient?.close()
            macAgentClient = model.makeLocalMcpClient()
        }
        .onDisappear { macAgentClient?.close(); macAgentClient = nil }
        #endif
    }

    @ViewBuilder private var storageSection: some View {
                if let persistenceNotice = model.persistenceNotice {
                    Section("Armazenamento local") {
                        Text(DexterLocalization.text(persistenceNotice, locale: locale))
                            .foregroundStyle(.orange)
                        if model.requiresStorageReset {
                            #if os(macOS)
                            Button("Recuperar e reconectar a este Mac", role: .destructive) {
                                confirmsStorageReset = true
                            }
                            .accessibilityIdentifier("settings.reset-storage")
                            #else
                            #if DEBUG
                            Button("Redefinir armazenamento e usar fixture", role: .destructive) {
                                confirmsStorageReset = true
                            }
                            .accessibilityIdentifier("settings.reset-storage")
                            #else
                            Button("Redefinir armazenamento e reconectar", role: .destructive) { confirmsStorageReset = true }
                            .accessibilityIdentifier("settings.reset-storage")
                            #endif
                            #endif
                        }
                    }
                }
    }

    private var developmentSection: some View {
                Section("Desenvolvimento local") {
                    LabeledContent("Estado", value: DexterLocalization.text(model.backendLabel, locale: locale))
                    TextField("Endereço do host", text: Binding(get: { model.hostAddress }, set: { model.hostAddress = $0 }))
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .autocorrectionDisabled()
                        .accessibilityLabel("Endereço HTTP local do host")
                        .accessibilityIdentifier("settings.host-address")
                    Button("Usar host local") {
                        model.configureHost()
                        if model.canUseHost {
                            Task {
                                await model.refresh()
                                await model.refreshDevices()
                            }
                        }
                    }
                    .disabled(model.requiresStorageReset)
                    .accessibilityIdentifier("settings.apply-host")
                    #if os(macOS) || DEBUG
                    Button("Usar fixture de demonstração") {
                        #if os(macOS)
                        confirmsFixture = true
                        #else
                        model.useFixture()
                        dismiss()
                        #endif
                    }
                    .accessibilityIdentifier("settings.use-fixture")
                    #endif
                    #if os(iOS)
                    #if targetEnvironment(simulator)
                    Text("No iOS Simulator deste setup, 127.0.0.1 pode alcançar o host de desenvolvimento do Mac para QA local. Isso não conecta uma VPS nem ativa pareamento remoto.")
                        .font(settingsHelpFont)
                    #else
                    Text("No iPhone físico, 127.0.0.1 aponta para o próprio aparelho. Use a oferta confiável de pareamento abaixo para conectar a outro host. Loopback permanece bloqueado no aparelho físico.")
                        .font(settingsHelpFont)
                    #endif
                    #else
                    Text("No Mac, só são salvos endereços HTTP locais em localhost, 127.0.0.1 ou ::1. O app pode chamar um host de desenvolvimento local já iniciado; O host remoto exige a oferta confiável de pareamento abaixo.")
                        .font(settingsHelpFont)
                    #endif
                }
    }

    #if os(macOS)
    private func tabText(_ pt: String, _ en: String) -> String {
        locale.language.languageCode?.identifier == "pt" ? pt : en
    }

    /// Same default as a fresh app: this Mac's loopback base. The packaged base's own address wins when known.
    private static let defaultLocalAddress = "http://127.0.0.1:4317"
    private var developmentToolsAvailable: Bool {
        DexterDevelopmentTools.isAvailable(packagedLocalHost: localHost?.acceptsLocalEnginePreference == true)
    }

    /// Release recovery: removes the unreadable snapshot (already confirmed) and reconnects to this Mac's own base,
    /// starting it once if the launch attempt was refused while storage was unreadable. Never the demo fixture.
    private func recoverStorage() {
        guard model.recoverCorruptStorage(localAddress: localHost?.launchHostAddress ?? Self.defaultLocalAddress) else { return }
        Task {
            if let localHost { await localHost.startAfterStorageRecovery(model: model) } else { await model.refresh() }
            await model.refreshDevices()
        }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        return (info?["CFBundleVersion"] as? String).map { "\(short) (\($0))" } ?? short
    }

    private var localEnginesSummary: String? {
        guard let current = localHost?.currentEngineConfiguration else { return nil }
        guard current.enableEngines else { return tabText("desligados", "off") }
        let names = current.engineCommands.map { commands in LocalEngineKind.allCases.filter { commands[$0] != nil }.map(\.displayName) } ?? []
        let engines = names.isEmpty ? tabText("ligados", "on") : names.joined(separator: " + ")
        return current.enableMcp ? engines + " + " + tabText("Ferramentas do Dexter", "Dexter tools") : engines
    }

    /// Release Advanced pane: plain status, a read-only refresh and a secret-free report. No host address editor.
    private var diagnosticsSection: some View {
        Section("Diagnóstico") {
            LabeledContent("Base") { Text(verbatim: DexterLocalization.text(model.backendLabel, locale: locale)) }
                .accessibilityIdentifier("settings.diagnostics.base")
            LabeledContent("Versão") { Text(verbatim: appVersion) }
                .accessibilityIdentifier("settings.diagnostics.version")
            HStack(spacing: 12) {
                Button("Atualizar conexão") {
                    diagnosticCopied = false
                    Task { await model.refresh(); await model.refreshDevices() }
                }
                .disabled(!model.canUseHost || model.isLoading)
                .accessibilityIdentifier("settings.diagnostics.refresh")
                Button("Copiar relatório de diagnóstico") { copyDiagnosticReport() }
                    .accessibilityIdentifier("settings.diagnostics.copy")
                if model.isLoading { ProgressView().controlSize(.small) }
            }
            Button("Conectar a outra base…") { showsConnectOtherBase = true }
                .accessibilityIdentifier("settings.diagnostics.connect-other-base")
            Text(diagnosticCopied ? "Relatório copiado. Ele não inclui endereços, chaves, contas nem mensagens."
                                  : "O relatório resume o estado atual para suporte. Nada é enviado; você escolhe onde colar.")
                .font(settingsHelpFont).foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.diagnostics.note")
        }
    }

    private func copyDiagnosticReport() {
        let system = ProcessInfo.processInfo.operatingSystemVersion
        let report = model.diagnosticReport(appVersion: appVersion,
            systemVersion: "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)",
            localEngines: localEnginesSummary, portuguese: locale.language.languageCode?.identifier == "pt")
        NSPasteboard.general.clearContents()
        diagnosticCopied = NSPasteboard.general.setString(report, forType: .string)
    }

    /// Native Settings scene (UX-P1-06), Codync-like: a sidebar of five panes, a pane page with a large title and grouped
    /// native sections. The window title follows the pane; the router keeps the last pane for the session.
    private var selectedTab: Binding<DexterSettingsTab> {
        Binding(get: { router?.settingsTab ?? localTab }, set: { tab in
            if let router { router.settingsTab = tab } else { localTab = tab }
        })
    }

    private var macSettingsTabs: some View {
        // A plain native split (sidebar list + pane) rather than NavigationSplitView: the Settings scene keeps its own
        // title bar, and nothing scrolls under it.
        HStack(spacing: 0) {
            List(selection: Binding<DexterSettingsTab?>(get: { selectedTab.wrappedValue }, set: { if let tab = $0 { selectedTab.wrappedValue = tab } })) {
                Section { paneRow(.general); paneRow(.assistants); paneRow(.connections) }
                Section(tabText("Este Mac", "This Mac")) { paneRow(.mac) }
                Section { paneRow(.advanced) }
            }
            .listStyle(.sidebar)
            .frame(width: 200)
            .accessibilityIdentifier("settings.panes")
            Divider()
            // Mount only the active pane: leaving it still cancels its tasks and clears pairing offers/passwords.
            macSettingsPane(selectedTab.wrappedValue).id(selectedTab.wrappedValue)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .navigationTitle(tabText(selectedTab.wrappedValue.portugueseTitle, selectedTab.wrappedValue.englishTitle))
        .frame(minWidth: Self.settingsWidth, idealWidth: 920, minHeight: 560, idealHeight: 680)
        .errorAlert(model: model, isActive: Binding(get: { router?.errorPresenter == .settings }, set: { _ in }))
        .modifier(DexterWindowRoleTracker(role: .settings))
    }

    private func paneRow(_ tab: DexterSettingsTab) -> some View {
        Label(tabText(tab.portugueseTitle, tab.englishTitle), systemImage: tab.systemImage)
            .tag(tab)
            .accessibilityIdentifier("settings.tab.\(tab.rawValue)")
    }

    private func macSettingsPane(_ tab: DexterSettingsTab) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: tabText(tab.portugueseTitle, tab.englishTitle)).font(.largeTitle.weight(.semibold))
                Text(verbatim: tabText(tab.portugueseSubtitle, tab.englishSubtitle)).font(.title3).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 30).padding(.top, 22).padding(.bottom, 2)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("settings.pane.\(tab.rawValue).header")
            macSettingsForm(tab)
        }
    }

    private func macSettingsForm(_ tab: DexterSettingsTab) -> some View {
        Form {
            switch tab {
            case .general:
                hostBaseSection
                OutputFilesSettingsSection()
                OnboardingReadinessSection(offersLocalEngineActivation: localHost?.acceptsLocalEnginePreference == true)
                ChatAppearanceSettingsSection()
                welcomeSection
            case .assistants:
                AssistantsSettingsSection(localHost: localHost)
                VoiceSettingsSection()
            case .connections:
                BrowserUseSettingsSection(localHost: localHost, keyStore: browserUseKeyStore)
                ManagedConnectAppsSection(openDirectConnections: { id in mcpConnectionToOpen = id; showsMcpConnections = true },
                                          directManagerOpen: showsMcpConnections, localHost: localHost)
                Section("Avançado") {
                    Button("Conexão personalizada (MCP)…") { mcpConnectionToOpen = nil; showsMcpConnections = true }
                        .disabled(!model.canUseHost || model.isFixture)
                        .accessibilityIdentifier("settings.mcp-connections")
                    Text("Endereço, importação e autorização técnica. Quais bots usam cada conexão fica nos ajustes do bot.")
                        .font(settingsHelpFont).foregroundStyle(.secondary)
                    Button("Habilidades…") { showsSkills = true }
                        .disabled(!model.canUseHost || model.isFixture)
                        .accessibilityIdentifier("settings.skills")
                    Text("Instruções reutilizáveis para todos os bots ou para um bot. Habilidades não concedem acesso.")
                        .font(settingsHelpFont).foregroundStyle(.secondary)
                }
                MemoryBackendSettingsSection(localHost: localHost)
            case .mac:
                ComputerAccessSection(localHost: localHost, macAgent: macAgent)
                if let macAgent {
                    Section("Avançado") {
                        Button("Configuração avançada do Mac…") { showsAdvancedMac = true }
                            .accessibilityIdentifier("settings.mac-agent.advanced")
                        Text("Para uma configuração existente, outro computador ou sites permitidos.").font(settingsHelpFont).foregroundStyle(.secondary)
                    }
                    .sheet(isPresented: $showsAdvancedMac) {
                        MacAdvancedSettingsSheet(agent: macAgent, client: macAgentClient)
                    }
                } else {
                    Section("Configuração avançada") {
                        Text(tabText("O agente local não está disponível nesta configuração do app.", "The local agent is unavailable in this app configuration."))
                            .foregroundStyle(.secondary)
                    }
                }
                DevicesSettingsSection()
                OwnerPairingOfferSettingsSection(localHost: localHost)
                otherBaseSection
            case .advanced:
                diagnosticsSection
                DexterToolsPauseSection(localHost: localHost)
                storageSection
                // Development only: never in Release nor in the packaged app a user installs (UX-P0-02).
                if developmentToolsAvailable { developmentSection }
            }
        }
        .formStyle(.grouped)
    }

    /// Este Mac keeps one row; the invitation, this Mac's key and the owner's approval live in the sheet (UX-P1-07).
    private var otherBaseSection: some View {
        Section("Outra base") {
            if model.pairing.publicReference != nil {
                LabeledContent("Situação") {
                    Text(verbatim: ConnectOtherBaseCopy.status(model.pairing.state, locale: locale))
                }
                .accessibilityIdentifier("settings.other-base.state")
            }
            Button(model.pairing.publicReference == nil ? "Conectar a outra base…" : "Gerenciar outra base…") {
                showsConnectOtherBase = true
            }
            .accessibilityIdentifier("settings.connect-other-base")
            Text("Para usar bots que estão em outro Mac ou servidor. A base deste Mac não muda.")
                .font(settingsHelpFont).foregroundStyle(.secondary)
        }
    }

    /// Reopens "Quem vai conversar com você?" in the main window. Nothing else changes.
    @ViewBuilder private var welcomeSection: some View {
        if model.canCreateFirstUseBot, let router {
            Section("Boas-vindas") {
                Button("Mostrar boas-vindas") { router.requestWelcome() }
                    .accessibilityIdentifier("settings.welcome.reopen")
                Text("Abre de novo a escolha do assistente na janela principal. Não muda bots nem ajustes existentes.")
                    .font(settingsHelpFont).foregroundStyle(.secondary)
            }
        }
    }
    #endif

    private var hostBaseSection: some View {
        Section("Base do bot") {
            if model.isFixture {
                Label("Demonstração local", systemImage: "play.rectangle")
                Text("Esta demonstração não executa uma engine nem conecta uma VPS.")
                    .font(settingsHelpFont)
            } else {
                #if os(macOS)
                if let localHost, localHost.ownsLiveChild,
                   let configuration = localHost.currentEngineConfiguration,
                   LocalHostStartupGate.permits(model, configuration: configuration) {
                    Label("Base neste Mac", systemImage: "desktopcomputer")
                        .accessibilityIdentifier("settings.host-base.local-mac")
                    Text("Este Mac guarda os bots e as conversas e executa as engines locais. Com o Mac desligado, os bots ficam offline.")
                        .font(settingsHelpFont)
                } else {
                    connectedHostBase
                }
                #else
                connectedHostBase
                #endif
            }
        }
    }

    private var connectedHostBase: some View {
        Group {
            if model.pairing.publicReference != nil, model.canUseHost {
                Label("Base no host pareado", systemImage: "server.rack")
            } else {
                Label("Host selecionado", systemImage: "server.rack")
            }
            Text("O host conectado guarda os bots, as conversas e as permissões e executa as engines. Este app acessa essa base.")
                .font(settingsHelpFont)
            Text(DexterLocalization.text(model.backendLabel, locale: locale))
                .font(settingsHelpFont)
        }
    }
    #if !os(macOS)
    private var pairedHostSection: some View {
        Section("Host pareado") {
            Button("Conectar ao Mac por QR…") { showsMacConnection = true }
                .accessibilityIdentifier("settings.pairing-qr.open")
            LabeledContent("Conexão", value: DexterLocalization.text(model.pairing.state.label, locale: locale))
            if let reference = model.pairing.publicReference {
                LabeledContent("Host", value: reference.hostURL)
                LabeledContent("Instalação", value: reference.installationID)
                LabeledContent("Cliente", value: reference.role.rawValue)
                if let fingerprint = reference.clientFingerprint {
                    LabeledContent("Código de verificação", value: PairingVerificationCode.text(fingerprint))
                        .accessibilityIdentifier("settings.paired-verification-code")
                }
                Text(DexterLocalization.format(model.pairing.binding == nil ? "Requested permissions: %@" : "Approved permissions: %@", reference.scopes.isEmpty ? DexterLocalization.text("none", locale: locale) : reference.scopes.map(\.rawValue).joined(separator: ", "), locale: locale))
                    .font(settingsHelpFont)
            }
            DisclosureGroup("Conexão manual e recuperação") {
            Text("Importe a oferta recebida do dono por um canal confiável. URL, certificado e instalação identificam o host; o código só fica em memória durante o claim.")
                .font(settingsHelpFont)
            TextEditor(text: $trustedBundleText)
                .frame(minHeight: 80)
                .accessibilityLabel("Oferta confiável de pareamento JSON")
                .accessibilityIdentifier("settings.paired-bundle")
            Button("Importar oferta confiável") {
                let data = Data(trustedBundleText.utf8); trustedBundleText = ""
                model.importPairingBundle(data)
            }
            .disabled(pairingBusy || trustedBundleText.isEmpty)
            .accessibilityIdentifier("settings.import-pairing")
            TextField("Nome deste cliente", text: $pairedClientName)
                .accessibilityIdentifier("settings.paired-client-name")
            if model.pairing.state == .readyToProvision {
                Button("Criar identidade local explicitamente") {
                    pairingBusy = true
                    Task { await model.pairing.provisionIdentity(); pairingBusy = false }
                }
                .disabled(pairingBusy)
                .accessibilityIdentifier("settings.provision-client-identity")
            }
            if model.pairing.state == .identityReady {
                Button("Solicitar aprovação ao dono") {
                    pairingBusy = true
                    Task { await model.pairing.claim(name: pairedClientName); pairingBusy = false }
                }
                .disabled(pairingBusy || pairedClientName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("settings.begin-pairing")
            }
            Button("Restaurar identidade e verificar aprovação") {
                pairingBusy = true
                Task { await model.connectPairedHost(); pairingBusy = false }
            }
            .disabled(pairingBusy || model.pairing.publicReference == nil || model.pairing.state == .outcomeUnknown)
            .accessibilityIdentifier("settings.restore-pairing")
            Button("Desconectar") { model.disconnectPairedHost() }
                .disabled(pairingBusy || model.pairing.publicReference == nil)
                .accessibilityIdentifier("settings.disconnect-pairing")
            Button("Desanexar deste app") { model.detachPairedHost() }
                .disabled(pairingBusy || model.pairing.publicReference == nil)
                .accessibilityIdentifier("settings.detach-pairing")
            if model.pairing.state == .paired {
                Button("Revogar este cliente no host", role: .destructive) {
                    pairingBusy = true
                    Task { await model.revokeThisClient(); pairingBusy = false }
                }
                .disabled(pairingBusy)
                .accessibilityIdentifier("settings.revoke-pairing")
            }
            if let notice = model.pairing.notice { Text(DexterLocalization.text(notice, locale: locale)).font(settingsHelpFont).foregroundStyle(.orange) }
            Text("Desconectar e desanexar fecham os clientes locais. Revogar altera a autorização no host. Nenhuma dessas ações concede permissão a bots.")
                .font(settingsHelpFont)
            }.accessibilityIdentifier("settings.pairing-advanced")
        }
    }
    #endif

}

private var settingsHelpFont: Font {
    #if os(macOS)
    .callout
    #else
    .footnote
    #endif
}

#if os(macOS)
private extension DexterSettingsTab {
    var portugueseTitle: String {
        switch self {
        case .general: "Geral"
        case .assistants: "Assistentes"
        case .connections: "Conexões"
        case .mac: "Este Mac"
        case .advanced: "Avançado"
        }
    }

    var englishTitle: String {
        switch self {
        case .general: "General"
        case .assistants: "Assistants"
        case .connections: "Connections"
        case .mac: "This Mac"
        case .advanced: "Advanced"
        }
    }

    var portugueseSubtitle: String {
        switch self {
        case .general: "Estado da base, aparência da conversa e boas-vindas."
        case .assistants: "Os programas oficiais que respondem pelos seus bots nesta base."
        case .connections: "O que os seus bots podem usar fora desta conversa."
        case .mac: "Acesso a este computador, aparelhos e outras bases."
        case .advanced: "Diagnóstico e controles técnicos."
        }
    }

    var englishSubtitle: String {
        switch self {
        case .general: "Base status, conversation appearance and welcome."
        case .assistants: "The official programs that answer for your bots on this base."
        case .connections: "What your bots can use outside this conversation."
        case .mac: "Access to this computer, devices and other bases."
        case .advanced: "Diagnostics and technical controls."
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .assistants: "sparkles"
        case .connections: "link"
        case .mac: "desktopcomputer"
        case .advanced: "wrench.and.screwdriver"
        }
    }
}

/// Assistentes (UX-P1-06, T3 providers reference): assistants on the left with their real status, the selected one on
/// the right. The base reports what is found; found never means signed in or subscribed. On this app's own packaged base,
/// the toggles are the explicit local-engine choice and apply with a graceful restart of that base only.
private struct AssistantsSettingsSection: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    let localHost: LocalHostLaunchCoordinator?
    @State private var selected: EngineID = .claude
    @State private var refreshing = false
    @State private var enabled: Set<LocalEngineKind> = []
    @State private var allowsTools = false
    @State private var usesMcpOnePassword = false
    @State private var mcpOpPath = ""
    @State private var mcpVault = ""
    @State private var mcpAccount = ""
    @State private var enablesDeviceChannel = false
    @State private var allowsDeviceTools = false
    @State private var deviceCustodyPath = LocalDeviceCustodyPreference.defaultFilePath ?? ""
    @State private var devicePassphrase = ""
    @State private var selection: [LocalEngineKind: String] = [:]
    @State private var options: [LocalEngineKind: [String]] = [:]
    @State private var saved: LocalEnginePreference?
    @State private var savedUnreadable = false
    @State private var freshChoice = false
    @State private var chooserIssue: LocalEngineActivationIssue?
    @State private var appliedDraft: LocalEnginePreference?
    @State private var setup: AssistantSetupPresentation?
    @State private var firstRunPreparation: AssistantFirstRunPresentation?

    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private var manageable: Bool { localHost?.acceptsLocalEnginePreference == true }
    private var isApplying: Bool { localHost?.applyPhase == .applying }

    private var draft: LocalEnginePreference {
        func path(_ kind: LocalEngineKind) -> String? { enabled.contains(kind) ? selection[kind] : nil }
        return LocalEnginePreference(allowsLocalEngines: !enabled.isEmpty, claudePath: path(.claude), codexPath: path(.codex), grokPath: path(.grok),
            musePath: path(.muse), antigravityPath: path(.antigravity), allowsDexterTools: allowsTools,
            mcpOnePassword: usesMcpOnePassword ? LocalMcpOnePasswordPreference(command: mcpOpPath, vault: mcpVault, account: mcpAccount.isEmpty ? nil : mcpAccount) : nil,
            localDeviceCustody: enablesDeviceChannel ? LocalDeviceCustodyPreference(filePath: deviceCustodyPath, allowsDeviceTools: allowsDeviceTools) : nil)
    }
    private var draftIssue: LocalEngineActivationIssue? {
        if let custody = draft.localDeviceCustody, !custody.isWellFormed { return .invalidDeviceCustody }
        if let onePassword = draft.mcpOnePassword, onePassword.validatedCommand == nil { return .invalidMcpOnePassword }
        guard !enabled.isEmpty, let localHost, case .failure(let issue) = localHost.previewLocalEngineActivation(draft) else { return nil }
        return issue
    }
    private var needsDevicePassword: Bool { localHost?.needsDeviceChannelUnlock(draft) ?? false }
    private var validDevicePassword: Bool { (16...1_024).contains(devicePassphrase.utf8.count) }
    private var hasChanges: Bool { !(draft == saved && (localHost?.isCurrentlyApplied(draft) ?? false)) }
    private var hasUnappliedChoice: Bool {
        saved.map { draft != $0 } ?? (!enabled.isEmpty || allowsTools || usesMcpOnePassword || enablesDeviceChannel)
    }

    var body: some View {
        Section {
            if manageable {
                HStack {
                    Text("As chaves abaixo escolhem os programas desta base. Elas não confirmam instalação nem login.")
                        .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Preparação inicial…") {
                        firstRunPreparation = AssistantFirstRunPresentation(coordinator: AssistantFirstRunCoordinator(model: model, localHost: localHost))
                    }
                    .disabled(isApplying || hasUnappliedChoice)
                    .accessibilityIdentifier("settings.assistants.first-run")
                }
            }
            HStack(alignment: .top, spacing: 0) {
                VStack(spacing: 2) { ForEach(EngineID.allCases, id: \.self) { engineRow($0) } }
                    .frame(width: 250)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("settings.assistants.list")
                Divider().padding(.horizontal, 12)
                detail(selected)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            if manageable { applyBar }
        } header: {
            HStack {
                Text(manageable ? "Vale para todos os bots desta base, neste Mac" : "Vale para todos os bots da base conectada")
                Spacer()
                if let checked = model.engineCatalogCheckedAt {
                    let elapsed = Text(checked, style: .relative)
                    Text("Verificado há \(elapsed)").foregroundStyle(.secondary)
                }
                Button { refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).disabled(refreshing || !model.canUseHost)
                    .help(Text("Verificar de novo"))
                    .accessibilityLabel(Text("Verificar de novo"))
                    .accessibilityIdentifier("settings.engines.refresh")
            }
        }
        .task { load() }
        .sheet(item: $setup, onDismiss: { load() }) { item in
            AssistantSetupView(controller: item.controller)
        }
        .sheet(item: $firstRunPreparation, onDismiss: { load() }) { item in
            AssistantFirstRunChecklistView(coordinator: item.coordinator, onContinue: { firstRunPreparation = nil })
        }
        .task(id: model.nativeComposerScope) { if model.engineCatalogLookup == .notLoaded { await model.refreshEngineCatalog() } }
        .onDisappear { devicePassphrase = "" }
        .onChange(of: needsDevicePassword) { _, needed in if !needed { devicePassphrase = "" } }
        if manageable { advancedSection }
    }

    private func refresh() {
        refreshing = true
        Task { await model.refreshEngineCatalog(); refreshing = false }
    }

    private func kind(_ engine: EngineID) -> LocalEngineKind? { LocalEngineKind(rawValue: engine.rawValue) }
    private func entry(_ engine: EngineID) -> EngineCatalogEntry? { model.engineCatalog.first { $0.id == engine.rawValue } }

    private func symbol(_ engine: EngineID) -> String {
        EngineSymbol.systemName(engine.rawValue)
    }

    private func engineRow(_ engine: EngineID) -> some View {
        let state = model.engineReadiness(for: engine)
        let isSelected = selected == engine
        return HStack(alignment: .center, spacing: 10) {
            Button { selected = engine } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: symbol(engine)).frame(width: 22).foregroundStyle(.secondary).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(verbatim: engine.displayName).font(.body.weight(.medium))
                            if let version = entry(engine)?.version {
                                Text(verbatim: version).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Text(verbatim: rowStatus(engine, state: state)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            .accessibilityIdentifier("settings.engines.state.\(engine.rawValue)")
            if manageable, let kind = kind(engine) {
                Toggle(isOn: Binding(get: { enabled.contains(kind) }, set: { setEnabled($0, kind: kind) })) {
                    Text(verbatim: engine.displayName)
                }
                .labelsHidden().toggleStyle(.switch).controlSize(.small)
                .disabled(isApplying || (options[kind] ?? []).isEmpty && !enabled.contains(kind))
                .accessibilityLabel(Text("Usar \(engine.displayName) neste Mac"))
                .help(Text("Escolha para esta base. Aplique para salvar; esta chave não instala o programa nem confirma login."))
                .accessibilityIdentifier("settings.local-engines.\(kind.rawValue)")
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(isSelected ? Color.accentColor.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func rowStatus(_ engine: EngineID, state: EngineReadiness) -> String {
        if manageable, let kind = kind(engine), !enabled.contains(kind) {
            return (options[kind] ?? []).isEmpty ? (portuguese ? "Não encontrado neste Mac" : "Not found on this Mac")
                                                 : (portuguese ? "Desligado neste Mac" : "Off on this Mac")
        }
        return state.label(portuguese: portuguese)
    }

    private func setEnabled(_ on: Bool, kind: LocalEngineKind) {
        chooserIssue = nil
        if on {
            if selection[kind] == nil { selection[kind] = options[kind]?.first }
            guard selection[kind] != nil else { return }
            // Root decision 2026-10-12: a new choice on a Mac with nothing saved also routes Dexter tools (no access granted).
            if saved == nil, !savedUnreadable, enabled.isEmpty { allowsTools = true; freshChoice = true }
            enabled.insert(kind)
        } else {
            enabled.remove(kind)
        }
    }

    @ViewBuilder private func detail(_ engine: EngineID) -> some View {
        let state = model.engineReadiness(for: engine)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: symbol(engine)).foregroundStyle(.secondary).accessibilityHidden(true)
                Text(verbatim: engine.displayName).font(.title3.weight(.semibold))
                if let version = entry(engine)?.version { Text(verbatim: version).font(.callout.monospaced()).foregroundStyle(.secondary) }
            }
            LabeledContent("Disponibilidade nesta base") {
                Text(verbatim: state.canRun ? (portuguese ? "Disponível" : "Available") : state.label(portuguese: portuguese))
            }
                .accessibilityIdentifier("settings.assistants.detail.state")
            LabeledContent("Programa") {
                Text(verbatim: entry(engine)?.installed.map { $0 ? (portuguese ? "Instalado" : "Installed") : (portuguese ? "Não encontrado" : "Not found") }
                    ?? (portuguese ? "A base não confirmou a instalação" : "The host has not confirmed installation"))
            }
            .accessibilityIdentifier("settings.assistants.detail.installed")
            LabeledContent("Conta") { Text("Login não confirmado") }
                .accessibilityIdentifier("settings.assistants.detail.authentication")
            if manageable, let kind = kind(engine) {
                LabeledContent("Escolha neste Mac") {
                    Text(verbatim: enabled.contains(kind) ? (portuguese ? "Ligado na escolha atual" : "On in the current choice")
                        : (options[kind] ?? []).isEmpty ? (portuguese ? "Programa não encontrado" : "Program not found")
                        : (portuguese ? "Desligado" : "Off"))
                }
                .accessibilityIdentifier("settings.assistants.detail.enabled")
                if [.claude, .codex].contains(engine) {
                    Button("Preparar \(engine.displayName)…") {
                        if let controller = localHost?.makeAssistantSetupController(engine: engine, model: model) {
                            setup = AssistantSetupPresentation(controller: controller)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isApplying || hasUnappliedChoice || savedUnreadable || localHost?.localRuntimeSetupRefusal(model: model) != nil)
                    .accessibilityIdentifier("settings.assistants.prepare.\(engine.rawValue)")
                    if hasUnappliedChoice {
                        Text("Aplique sua escolha atual antes de preparar outro assistente.").font(settingsHelpFont).foregroundStyle(.secondary)
                    }
                } else if (options[kind] ?? []).isEmpty {
                    Text("Instale o programa oficial deste assistente e toque em Verificar de novo. O Dexter não instala programas.")
                        .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("O login fica no programa oficial do assistente. O Dexter não pede senha e não confirma login nem assinatura.")
                .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Vale para a base inteira. O modelo de cada bot fica em Ajustes do bot, e cada conversa pode trocar no seletor do chat.")
                .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.assistants.scope")
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 8) {
                    if manageable, let kind = kind(engine) { enginePicker(kind) }
                    if let entry = entry(engine) {
                        Text(verbatim: "\(entry.id): installed \(entry.installed.map(String.init) ?? "?") · adapterSupported \(entry.adapterSupported.map(String.init) ?? "?") · available \(entry.available)\(entry.unavailableReason.map { " · " + $0 } ?? "")")
                            .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    } else {
                        Text("Catálogo ainda não lido nesta sessão.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let notice = model.engineCatalogNotice {
                        Text(verbatim: notice).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("settings.engines.lookup-error")
                    }
                }
            } label: {
                Text("Detalhes técnicos").font(.callout).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("settings.engines.details")
        }
    }

    private var applyBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            if freshChoice {
                Text("Ao ligar o primeiro assistente, as Ferramentas do Dexter também são ligadas. Isso não dá acesso a contas, arquivos ou tela; pause em Avançado.")
                    .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if needsDevicePassword {
                SecureField("Frase-senha do canal", text: $devicePassphrase)
                    .accessibilityIdentifier("settings.local-device.passphrase")
                Text("Use de 16 a 1024 bytes. A frase-senha não é salva e será solicitada novamente após reiniciar o app.")
                    .font(settingsHelpFont).foregroundStyle(.secondary)
            }
            if savedUnreadable {
                Text("A preferência salva estava ilegível e foi tratada como desligada.").font(settingsHelpFont).foregroundStyle(.orange)
            }
            if let issue = chooserIssue ?? draftIssue {
                Text(DexterLocalization.text(issue.message, locale: locale)).font(settingsHelpFont).foregroundStyle(.orange)
            }
            HStack {
                LabeledContent("Aplicado agora") { Text(verbatim: currentSummary) }
                    .accessibilityIdentifier("settings.local-engines.current")
                Spacer()
                if isApplying { ProgressView().controlSize(.small); Text("Aplicando…").font(settingsHelpFont) }
                Button("Aplicar e reiniciar a base deste Mac") { apply() }
                    .buttonStyle(.borderedProminent)
                    .disabled(isApplying || draftIssue != nil || (needsDevicePassword && !validDevicePassword) || !hasChanges)
                    .accessibilityIdentifier("settings.local-engines.apply")
            }
            if appliedDraft == draft, let phase = localHost?.applyPhase {
                switch phase {
                case .applied:
                    Text("Aplicado ao host local deste Mac.").font(settingsHelpFont).accessibilityIdentifier("settings.local-engines.applied")
                case .refused(let refusal):
                    Text(DexterLocalization.text(refusal.message, locale: locale)).font(settingsHelpFont).foregroundStyle(.orange)
                        .accessibilityIdentifier("settings.local-engines.refused")
                case .idle, .applying: EmptyView()
                }
            }
            Text("Só a base que este app iniciou é reiniciada, com parada segura. Uma resposta em andamento impede aplicar agora.")
                .font(settingsHelpFont).foregroundStyle(.secondary)
        }
    }

    /// Owner-chosen technical options of this Mac's base. Values are explicit public configuration, never secrets.
    private var advancedSection: some View {
        Section {
            DisclosureGroup("1Password para conexões MCP") {
                Toggle("Usar um cofre escolhido por mim", isOn: $usesMcpOnePassword)
                    .disabled((enabled.isEmpty || !allowsTools) && !usesMcpOnePassword)
                    .accessibilityIdentifier("settings.mcp-onepassword.enable")
                if usesMcpOnePassword {
                    HStack {
                        Text(mcpOpPath.isEmpty ? DexterLocalization.text("Nenhum executável op escolhido", locale: locale) : mcpOpPath)
                            .font(settingsHelpFont).textSelection(.enabled).lineLimit(2)
                        Spacer()
                        Button("Escolher op…") { chooseMcpOp() }.accessibilityIdentifier("settings.mcp-onepassword.choose-op")
                    }
                    TextField("Nome do cofre", text: $mcpVault).accessibilityIdentifier("settings.mcp-onepassword.vault")
                    TextField("Conta 1Password (opcional)", text: $mcpAccount).accessibilityIdentifier("settings.mcp-onepassword.account")
                    Text("Escolha o CLI oficial op instalado por você e informe o cofre. Não digite senhas, chaves ou tokens aqui.")
                        .font(settingsHelpFont).foregroundStyle(.secondary)
                }
            }.disabled(isApplying)
            DisclosureGroup("Canal criptografado para este Mac") {
                Toggle("Ativar canal criptografado para este Mac", isOn: $enablesDeviceChannel)
                    .disabled((enabled.isEmpty || !allowsTools) && !enablesDeviceChannel)
                    .accessibilityIdentifier("settings.local-device.enable")
                if enablesDeviceChannel {
                    Text(deviceCustodyPath).font(settingsHelpFont).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Toggle("Permitir ferramentas deste Mac após pareamento e aprovação", isOn: $allowsDeviceTools)
                        .disabled(enabled.isEmpty || !allowsTools)
                        .accessibilityIdentifier("settings.local-device.tools")
                    Text("Ativar o canal não pareia dispositivos nem concede permissões. Cada ferramenta continua exigindo autorização.")
                        .font(settingsHelpFont).foregroundStyle(.secondary)
                }
                Text(localHost?.currentEngineConfiguration?.localDeviceCustody == nil
                     ? DexterLocalization.text("Canal bloqueado. Bots e conversas continuam disponíveis; aplique para desbloquear.", locale: locale)
                     : DexterLocalization.text("Canal criptografado ativo no host deste app. Pareamento e permissões são separados.", locale: locale))
                    .font(settingsHelpFont).foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.local-device.current")
            }.disabled(isApplying)
            Text("Estas opções também usam Aplicar e reiniciar a base deste Mac, acima.")
                .font(settingsHelpFont).foregroundStyle(.secondary)
        } header: {
            Text("Avançado deste Mac")
        }
    }

    /// Truthful summary of what the owned host runs right now (not the draft or the saved choice).
    private var currentSummary: String {
        guard let current = localHost?.currentEngineConfiguration else { return DexterLocalization.text("Host local parado", locale: locale) }
        guard current.enableEngines else { return DexterLocalization.text("Desligados", locale: locale) }
        let engines = current.engineCommands.map { commands in
            LocalEngineKind.allCases.filter { commands[$0] != nil }.map { $0.displayName }.joined(separator: " + ")
        } ?? DexterLocalization.text("Ligados", locale: locale)
        return current.enableMcp ? engines + " + " + DexterLocalization.text("Ferramentas do Dexter", locale: locale) : engines
    }

    private func enginePicker(_ kind: LocalEngineKind) -> some View {
        HStack {
            Picker(LocalizedStringKey(kind.displayName), selection: Binding(
                get: { selection[kind] ?? "" },
                set: { selection[kind] = $0.isEmpty ? nil : $0; if $0.isEmpty { enabled.remove(kind) }; chooserIssue = nil }
            )) {
                Text("Não usar").tag("")
                ForEach(options[kind] ?? [], id: \.self) { path in Text(verbatim: path).tag(path) }
            }
            .disabled(isApplying)
            .accessibilityIdentifier("settings.local-engines.\(kind.rawValue).program")
            Button(LocalizedStringKey("Escolher \(kind.displayName)…")) { choose(kind) }
                .disabled(isApplying)
                .accessibilityIdentifier("settings.local-engines.\(kind.rawValue).choose")
        }
        .font(settingsHelpFont)
    }

    private func load() {
        guard let localHost, manageable else { return }
        saved = nil; savedUnreadable = false; freshChoice = false; enabled = []; selection = [:]; options = [:]
        allowsTools = false; usesMcpOnePassword = false; mcpOpPath = ""; mcpVault = ""; mcpAccount = ""
        enablesDeviceChannel = false; allowsDeviceTools = false; devicePassphrase = ""; appliedDraft = nil; chooserIssue = nil
        switch localHost.loadLocalEnginePreference() {
        case .saved(let preference):
            saved = preference
            enabled = preference.allowsLocalEngines ? Set(LocalEngineKind.allCases.filter { preference.path(for: $0) != nil }) : []
            allowsTools = preference.allowsDexterTools
            usesMcpOnePassword = preference.mcpOnePassword != nil
            mcpOpPath = preference.mcpOnePassword?.command ?? ""
            mcpVault = preference.mcpOnePassword?.vault ?? ""
            mcpAccount = preference.mcpOnePassword?.account ?? ""
            enablesDeviceChannel = preference.localDeviceCustody != nil
            allowsDeviceTools = preference.localDeviceCustody?.allowsDeviceTools ?? false
            deviceCustodyPath = preference.localDeviceCustody?.filePath ?? LocalDeviceCustodyPreference.defaultFilePath ?? ""
            for kind in LocalEngineKind.allCases { selection[kind] = preference.path(for: kind) }
        case .unreadable: savedUnreadable = true
        case .missing: break
        }
        // Metadata-only discovery; saved choices, including explicit "off", win.
        let discovery = LocalEngineDiscovery()
        for kind in LocalEngineKind.allCases {
            var paths = discovery.candidates(for: kind).map(\.launcher)
            if let current = selection[kind], !paths.contains(current) { paths.append(current) }
            options[kind] = paths
            if selection[kind] == nil { selection[kind] = paths.first }
        }
    }

    /// Manual choice of an existing launcher; symlinks are kept as chosen and validated, never executed.
    private func choose(_ kind: LocalEngineKind) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.resolvesAliases = false; panel.showsHiddenFiles = true; panel.treatsFilePackagesAsDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        switch LocalEngineDiscovery.validateLauncher(url.path, kind: kind) {
        case .success(let candidate):
            if !(options[kind] ?? []).contains(candidate.launcher) { options[kind, default: []].append(candidate.launcher) }
            selection[kind] = candidate.launcher; chooserIssue = nil
        case .failure(let issue):
            chooserIssue = issue
        }
    }

    /// Owner-selected executable only; no automatic discovery or 1Password command is run.
    private func chooseMcpOp() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false; panel.resolvesAliases = false
        panel.showsHiddenFiles = true; panel.treatsFilePackagesAsDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let candidate = LocalMcpOnePasswordPreference(command: url.path, vault: "validation")
        guard candidate.validatedCommand != nil else { chooserIssue = .invalidMcpOnePassword; return }
        mcpOpPath = url.path; chooserIssue = nil
    }

    /// One serial Apply; the coordinator refuses a concurrent one and re-checks the selection across awaits.
    private func apply() {
        guard let localHost, !isApplying else { return }
        let preference = draft
        let unlockPassword = needsDevicePassword ? LocalHostUnlockPassword(devicePassphrase) : nil
        devicePassphrase = ""
        appliedDraft = preference
        Task {
            let phase = await localHost.applyLocalEnginePreference(preference, model: model, unlockPassword: unlockPassword, custodyAction: localHost.manualDeviceCustodyAction(preference))
            let persisted: Bool
            switch phase {
            case .applied: persisted = true
            case .refused(let refusal): persisted = refusal.preferenceSaved
            case .idle, .applying: persisted = false
            }
            if persisted { saved = preference; savedUnreadable = false; freshChoice = false }
            await model.refreshEngineCatalog()
        }
    }
}

/// Este Mac › Acesso ao computador (Codync reference): steps with the real state the app can read. macOS permissions are
/// never probed here: the agent asks when a tool runs. An advertised capability is a connection fact, never a macOS
/// permission, lock check or session; per-bot readiness lives in the guided screen-control panel.
private struct ComputerAccessSection: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    let localHost: LocalHostLaunchCoordinator?
    let macAgent: LocalMacAgentProcess?
    @State private var setup: MacAutoSetupPresentation?
    @State private var screenControl: MacScreenControlPresentation?
    @State private var preparationNotice: String?
    @State private var busy = false
    @State private var deferred = false

    private enum StepState { case ready, waiting, attention, unknown }
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }

    var body: some View {
        let readiness = model.onboardingReadiness
        let executorDevice: DeviceView? = {
            if case .online(let id) = readiness.executor { return model.devices.first { $0.id == id } }
            return nil
        }()
        let agent = agentState(readiness.executor)
        let observe = capabilityState("mac.cua.observe", device: executorDevice)
        let control = capabilityState("mac.cua.control", device: executorDevice)
        Section {
            if deferred {
                HStack {
                    Text("Configurar depois. Nada aqui é necessário para conversar.").foregroundStyle(.secondary)
                    Spacer()
                    Button("Retomar") { deferred = false }.accessibilityIdentifier("settings.computer-access.resume")
                }
            } else {
                Text("Trabalhe nos seus apps com um bot. Você escolhe quais bots podem usar este Mac, e cada ação pede aprovação.")
                    .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                step("desktopcomputer", Text("Agente deste Mac"), Text("Recebe os pedidos dos bots e roda as ferramentas do Mac."), agent, id: "agent")
                step("eye", Text("Ver a tela"), Text(text("Um bot autorizado pode ver o app que você escolher.", "An allowed bot can see the app you choose.")), observe, id: "observe")
                step("cursorarrow.click.2", Text("Controlar apps"), Text(text("Um bot autorizado pode clicar e digitar no app que você escolher, com a sua confirmação.",
                                                                              "An allowed bot can click and type in the app you choose, with your confirmation.")), control, id: "control")
                Text(text("Capacidade anunciada é o que o agente informa à base. Permissões do macOS, bloqueio da tela e cada sessão são confirmados no Dexter Control, neste Mac.",
                          "An advertised capability is what the agent reports to the base. macOS permissions, the screen lock and each session are confirmed in Dexter Control, on this Mac."))
                    .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                ForEach(readiness.macSteps.filter { [.permissionPending, .permissionDenied, .capabilityNotOffered].contains($0.kind) }, id: \.self) { item in
                    Label(DexterLocalization.text(OnboardingCopy.title(item.kind), locale: locale).replacingOccurrences(of: "%@", with: item.argument ?? ""),
                          systemImage: "exclamationmark.triangle")
                        .font(settingsHelpFont).foregroundStyle(.orange)
                }
                Label("O auxiliar do Dexter pede as permissões nos Ajustes do Sistema. Você confirma no Mac e escolhe depois quais bots podem usá-lo.",
                      systemImage: "info.circle")
                    .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let localHost, let macAgent, localHost.acceptsLocalEnginePreference {
                    Button("Preparar este Mac") {
                        if let controller = localHost.makeMacAutoSetupController(model: model, agent: macAgent) {
                            preparationNotice = nil; setup = MacAutoSetupPresentation(controller: controller)
                        } else {
                            preparationNotice = String(localized: "Conecte à base deste Mac e prepare um assistente. O pacote também precisa incluir os auxiliares assinados.")
                        }
                    }
                    .buttonStyle(.borderedProminent).disabled(busy || model.localRuntimeSetupBusy || !model.isOnline)
                    .accessibilityIdentifier("settings.computer-access.prepare")
                }
                if let preparationNotice { Text(verbatim: preparationNotice).font(settingsHelpFont).foregroundStyle(.orange) }
                if macAgent != nil {
                    // Opens a read-only overview; the selected bot is only a draft choice the owner may change there.
                    Button(text("Controle de tela por bot…", "Screen control by bot…")) {
                        screenControl = MacScreenControlPresentation(botID: model.selectedBotID, locksBot: false)
                    }
                    .disabled(!model.canUseHost || model.isFixture)
                    .accessibilityIdentifier("settings.computer-access.screen-control")
                    Text(text("Mostra o que falta para um bot usar a tela deste Mac e abre a etapa certa.",
                              "Shows what is missing for a bot to use this Mac's screen and opens the right step."))
                        .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Verificar de novo") {
                        busy = true
                        Task { await model.refreshDevices(); busy = false }
                    }
                    .disabled(busy || !model.canUseHost)
                    .accessibilityIdentifier("settings.computer-access.check")
                    if busy { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("Configurar depois") { deferred = true }.accessibilityIdentifier("settings.computer-access.later")
                }
            }
        } header: {
            HStack {
                Text("Acesso ao computador")
                Spacer()
                // Only the connection is confirmable here; physical permissions and sessions are never counted.
                Text(verbatim: agent.0 == .ready ? text("Conexão confirmada", "Connection confirmed") : text("Conexão não confirmada", "Connection not confirmed"))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.computer-access.count")
            }
        }
        .sheet(item: $setup) { item in MacAutoSetupView(controller: item.controller) }
        .sheet(item: $screenControl) { item in
            if let macAgent { MacScreenControlSheet(presentation: item, localHost: localHost, agent: macAgent) }
        }
    }

    private func agentState(_ executor: OnboardingExecutorStatus) -> (StepState, Text) {
        switch executor {
        case .online: return (.ready, Text("Conectado"))
        case .offline: return (.attention, Text("Offline"))
        case .revoked: return (.attention, Text("Revogado"))
        case .notPaired: return macAgent?.state == .running ? (.waiting, Text("Iniciado · aguardando a base")) : (.waiting, Text("Não configurado"))
        case .unknown: return (.unknown, Text("Não confirmado"))
        }
    }

    /// Advertised by the paired agent is a connection fact only; it stays "waiting" and never counts as ready.
    private func capabilityState(_ capability: String, device: DeviceView?) -> (StepState, Text) {
        guard let device else { return (.waiting, Text("Aguardando o agente")) }
        return device.capabilities.contains(capability)
            ? (.waiting, Text(text("Capacidade anunciada", "Capability advertised")))
            : (.waiting, Text(text("Não anunciada pelo agente", "Not advertised by the agent")))
    }

    private func step(_ icon: String, _ title: Text, _ detail: Text, _ state: (StepState, Text), id: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 16)).frame(width: 24).foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                title.font(.body.weight(.medium))
                detail.font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            state.1.font(settingsHelpFont)
                .foregroundStyle(state.0 == .ready ? Color.green : state.0 == .attention ? Color.orange : Color.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.computer-access.\(id)")
    }
}

/// Avançado › Ferramentas do Dexter: the general pause (Root decision 2026-10-12). It changes only the tools path of the
/// saved choice on this app's own base, with the same Apply and graceful restart; no grant, approval or deny changes.
private struct DexterToolsPauseSection: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    let localHost: LocalHostLaunchCoordinator?
    @State private var saved: LocalEngineStoredPreference = .missing
    @State private var confirming = false
    @State private var requested: LocalEnginePreference?

    private var target: LocalEnginePreference? {
        guard case .saved(let preference) = saved, preference.allowsLocalEngines else { return nil }
        var next = preference; next.allowsDexterTools.toggle(); return next
    }

    var body: some View {
        if let localHost, localHost.acceptsLocalEnginePreference {
            Section("Ferramentas do Dexter") {
                LabeledContent("Estado") {
                    Text(localHost.currentEngineConfiguration?.enableMcp == true ? "Ligadas" : "Pausadas")
                }
                .accessibilityIdentifier("settings.dexter-tools.state")
                Text("Permitem que os bots usem ferramentas já configuradas e autorizadas, como o navegador na nuvem e chamadas entre bots. Não concedem acesso: cada bot e cada ação continuam pedindo autorização.")
                    .font(settingsHelpFont).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let target, !localHost.needsDeviceChannelUnlock(target) {
                    Button(target.allowsDexterTools ? "Ligar ferramentas…" : "Pausar ferramentas…") { confirming = true }
                        .disabled(localHost.applyPhase == .applying)
                        .accessibilityIdentifier("settings.dexter-tools.toggle")
                } else {
                    Text("Ligue um assistente em Assistentes primeiro, ou ajuste lá quando o canal criptografado pedir a frase-senha.")
                        .font(settingsHelpFont).foregroundStyle(.secondary)
                }
                if requested != nil {
                    switch localHost.applyPhase {
                    case .applying: ProgressView().controlSize(.small)
                    case .refused(let refusal): Text(DexterLocalization.text(refusal.message, locale: locale)).font(settingsHelpFont).foregroundStyle(.orange)
                    case .applied, .idle: EmptyView()
                    }
                }
            }
            .task { saved = localHost.loadLocalEnginePreference() }
            .confirmationDialog(target?.allowsDexterTools == true ? "Ligar as Ferramentas do Dexter?" : "Pausar as Ferramentas do Dexter?",
                                isPresented: $confirming, titleVisibility: .visible) {
                Button(target?.allowsDexterTools == true ? "Ligar e reiniciar a base" : "Pausar e reiniciar a base") { apply() }
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text("A base deste Mac reinicia com parada segura. Permissões, aprovações e acessos dos bots não mudam.")
            }
        }
    }

    private func apply() {
        guard let localHost, let next = target else { return }
        requested = next
        Task {
            _ = await localHost.applyLocalEnginePreference(next, model: model)
            saved = localHost.loadLocalEnginePreference()
        }
    }
}
#endif

/// Read-only status of the conversation on screen, derived from current host facts and its effective engine
/// (UX-P0-01). Buttons only re-read the host or open the pane that holds the control; nothing here signs in, pairs,
/// grants, switches engines or prompts for macOS permissions. Mac agent facts live in the Mac pane.
private struct OnboardingReadinessSection: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    #if os(macOS)
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    #endif
    @State private var busy = false
    var offersLocalEngineActivation = false

    private var usesLocalActivationInstruction: Bool {
        guard offersLocalEngineActivation,
              case .online(let identity) = model.onboardingReadinessInput.host else { return false }
        return identity.mode == .localDevelopment
    }

    var body: some View {
        let readiness = model.onboardingReadiness
        Section("Estado") {
            Label(LocalizedStringKey(OnboardingCopy.conversation(readiness.conversation)), systemImage: conversationSymbol(readiness.conversation))
                .accessibilityIdentifier("onboarding.conversation")
            if let engineLine {
                Text(verbatim: engineLine)
                    .font(settingsHelpFont).foregroundStyle(.secondary)
                    .accessibilityIdentifier("onboarding.effective-engine")
            }
            ForEach(visibleSteps(readiness), id: \.self) { step in
                VStack(alignment: .leading, spacing: 4) {
                    Label(localized(OnboardingCopy.title(step.kind), step.argument), systemImage: step.blocksConversation ? "exclamationmark.triangle" : "info.circle")
                        .font(.headline)
                    Text(localized(usesLocalActivationInstruction && step.kind == .engineRoutingOff
                        ? "Ligue um assistente em Assistentes e toque em Aplicar e reiniciar a base deste Mac."
                        : OnboardingCopy.detail(step.kind), nil))
                        .font(settingsHelpFont)
                        .foregroundStyle(.secondary)
                    #if os(macOS)
                    if usesLocalActivationInstruction && step.kind == .engineRoutingOff, let router {
                        Button("Abrir Assistentes") { router.settingsTab = .assistants }
                            .accessibilityIdentifier("onboarding.engineRoutingOff.open-assistants")
                    }
                    #endif
                    if let action = step.action, !(usesLocalActivationInstruction && step.kind == .engineRoutingOff) {
                        Button(LocalizedStringKey(OnboardingCopy.action(action))) { perform(action) }
                            .disabled(busy || !model.canUseHost)
                            .accessibilityIdentifier("onboarding.\(step.kind.rawValue).\(action.rawValue)")
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("onboarding.\(step.kind.rawValue)")
            }
        }
    }

    /// The Mac pane shows the Mac agent facts; iOS has no such pane and keeps every step here, as before.
    private func visibleSteps(_ readiness: OnboardingReadiness) -> [OnboardingStep] {
        #if os(macOS)
        readiness.conversationSteps
        #else
        readiness.steps
        #endif
    }

    /// Which engine these facts are about, so a thread override is never read as the bot default (or vice versa).
    private var engineLine: String? {
        switch model.effectiveConversationEngine {
        case .none: return nil
        case .loading:
            return DexterLocalization.text("Current conversation: model not read yet", locale: locale)
        case .known(let engine, let source, let botDefault):
            if source == .conversation {
                return DexterLocalization.format(engine == botDefault ? "Current conversation: %@ · chosen in this conversation"
                    : "Current conversation: %@ · chosen in this conversation (the bot default is different)", engine.displayName, locale: locale)
            }
            return DexterLocalization.format(model.presentedThreadID == nil ? "Selected bot: %@ · bot default" : "Current conversation: %@ · bot default",
                engine.displayName, locale: locale)
        }
    }

    private func perform(_ action: OnboardingAction) {
        busy = true
        Task {
            switch action {
            case .retryHost: await model.refresh(); await model.refreshEngineCatalog(); await model.refreshDevices()
            case .refreshDevices: await model.refreshDevices()
            }
            busy = false
        }
    }

    private func localized(_ key: String, _ argument: String?) -> String {
        let format = DexterLocalization.text(key, locale: locale)
        guard let argument else { return format }
        return String(format: format, argument)
    }

    private func conversationSymbol(_ status: OnboardingConversationStatus) -> String {
        switch status {
        case .fixture: "shippingbox"
        case .blocked: "exclamationmark.triangle"
        case .unconfirmed: "questionmark.circle"
        case .ready: "checkmark.circle"
        }
    }
}

#if !os(macOS)
/// iOS keeps the simple form; the Mac sheet (suggestions, available assistants first) lives in NewBotView.swift.
struct NewBotView: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var engine: EngineID = .claude

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nome do bot", text: $name)
                    .accessibilityLabel("Nome do bot")
                    .accessibilityIdentifier("bot.name")
                Picker("Engine", selection: $engine) {
                    ForEach(EngineID.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .accessibilityIdentifier("bot.engine")
                Text("O host local mantém as credenciais no CLI oficial. Inferência ainda não foi verificada por este app.")
                    .font(.footnote)
            }
            .navigationTitle("Novo bot")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Criar") {
                        Task {
                            await model.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), engine: engine)
                            dismiss()
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.canUseHost)
                    .accessibilityIdentifier("bot.save")
                }
            }
        }
    }
}
#endif
