#if os(macOS)
import AppKit
#endif
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Opens one `ManagedConnectAppsEditor` for this window's owner base and drops it when the base changes or the view leaves.
@MainActor @Observable final class ManagedConnectAppsHolder {
    private(set) var editor: ManagedConnectAppsEditor?
    private(set) var attemptedScope: String?

    func open(_ model: DexterAppModel) async {
        let scope = model.connectionsScope
        if editor?.scope == scope { return }
        editor?.close()
        editor = model.makeConnectionsEditor()
        attemptedScope = scope
        await editor?.reload()
        await editor?.loadSetupRequests()
        await editor?.loadNativeInventory()
    }

    /// The editor for this base without reading anything (the chat cards read only what they need).
    func ensure(_ model: DexterAppModel) -> ManagedConnectAppsEditor? {
        let scope = model.connectionsScope
        if editor?.scope != scope {
            editor?.close()
            editor = model.makeConnectionsEditor()
            attemptedScope = scope
        }
        return editor
    }

    func close() { editor?.close(); editor = nil; attemptedScope = nil }
}

/// One row of Suas contas: a managed account or a native MCP connection, shown the same way; the method is in the detail.
private enum ConnectionsHomeRow: Identifiable {
    case managed(ConnectionAccount)
    /// A native connection from the inventory, with its public sign-in metadata and the read-only account projection.
    case native(McpServerSummary, McpCredentialStatus?, ConnectionAccount?)
    /// The read-only projection alone, when the native inventory could not be read.
    case projection(ConnectionAccount)

    var id: String {
        switch self {
        case .managed(let account), .projection(let account): account.id
        case .native(let server, _, _): "native:" + server.id
        }
    }
}

private struct InspectedAccount: Identifiable, Equatable { let id: String }
struct ReviewedSetupRequest: Identifiable, Equatable { let id: String }

#if os(macOS)
/// Ajustes › Conexões. Suas contas lists managed accounts and native MCP connections with the same row (name, identity,
/// method and three separate facts: account, access, this conversation). Conectar apps is the gallery. What the base
/// answers is what is shown: nothing is simulated, a login happens on the service's official page and its outcome is only
/// read back, and connecting gives no bot access. Each managed account opens one compact inspector with its bots, tools,
/// Reconectar, Desconectar and Renomear; native connections open the existing manager.
struct ManagedConnectAppsSection: View {
    /// Opens the native MCP manager ("Conexão personalizada (MCP)"), on one connection when given.
    let openDirectConnections: (String?) -> Void
    /// True while that manager is open; when it closes the inventory is read again (GET only).
    var directManagerOpen = false
    /// This app's own base launcher; the private connections service setup exists only there (nil elsewhere).
    var localHost: LocalHostLaunchCoordinator? = nil
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var holder = ManagedConnectAppsHolder()
    @State private var showsRequirements = false
    @State private var confirming: ConnectionCatalogEntry?
    @State private var confirmingReconnect: ConnectionAccount?
    /// The setup request a Conectar from Pedidos dos bots answers (sent with that login; nil from the gallery).
    @State private var confirmingSetupRequest: String?
    @State private var inspecting: InspectedAccount?
    @State private var reviewing: ReviewedSetupRequest?
    @State private var query = ""
    @State private var platform = ConnectionsPlatformSetupHolder()
    @State private var showsPlatformSetup = false

    /// Re-resolves the setup controller when the base, its address, the owned child or its reachability changes.
    private var platformTarget: String {
        [model.filesScope, model.hostAddress, model.browserUseHostID ?? "", localHost?.supervisor?.memoryBackendLifetime.uuidString ?? "",
         String(model.isOnline)].joined(separator: "|")
    }

    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    var body: some View {
        Group {
            Section {
                accountsContent
            } header: {
                Text(verbatim: t("Suas contas", "Your accounts")).accessibilityIdentifier("settings.connections.accounts")
            }
            if let editor = holder.editor, editor.scope == model.filesScope, !model.isFixture, !model.showsPairedBase {
                Section {
                    gallery(editor)
                } header: {
                    Text("Conectar apps").accessibilityIdentifier("settings.connections.platform")
                }
            }
        }
        .task(id: model.filesScope) { await holder.open(model) }
        .task(id: platformTarget) { platform.open(localHost: localHost, model: model) }
        .onDisappear { holder.close(); platform.close() }
        // Credential custody on the base just became ready: read the catalog again (GET only). Ready is not "connected".
        .onChange(of: platform.controller?.status?.custody.state) { _, state in
            if state == .ready, let editor = holder.editor { Task { await editor.reload() } }
        }
        .onChange(of: directManagerOpen) { _, open in
            guard !open, let editor = holder.editor else { return }
            Task { await editor.reload(); await editor.loadNativeInventory() }
        }
        .sheet(isPresented: $showsPlatformSetup) {
            ConnectionsPlatformSetupSheet(controller: platform.controller) {
                if let editor = holder.editor { Task { await editor.reload() } }
            }
        }
        .sheet(isPresented: $showsRequirements) {
            ManagedConnectAppsRequirementsSheet(providers: holder.editor?.status?.managedProviders ?? [])
        }
        .sheet(item: $reviewing) { item in
            if let editor = holder.editor { ConnectionSetupRequestSheet(workflowID: item.id, editor: editor) }
        }
        .sheet(item: $inspecting) { item in
            if let editor = holder.editor {
                ConnectionAccountInspector(accountID: item.id, editor: editor) { account in
                    inspecting = nil; confirmingReconnect = account
                }
            }
        }
        .confirmationDialog(Text(verbatim: DexterLocalization.format("Conectar %@?", confirming?.displayName ?? "", locale: locale)),
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button("Abrir a página oficial") {
                guard let entry = confirming, let editor = holder.editor else { return }
                let request = confirmingSetupRequest
                confirming = nil; confirmingSetupRequest = nil
                Task { if let page = await editor.startAuthorization(serviceID: entry.serviceId, setupRequestID: request) { NSWorkspace.shared.open(page) } }
            }
            .accessibilityIdentifier("settings.connections.connect.confirm")
            Button("Cancelar", role: .cancel) { confirming = nil; confirmingSetupRequest = nil }
        } message: {
            Text("O navegador abre a página oficial do serviço. Você entra lá; sua senha não passa pelo Dexter. Conectar não libera a conta para nenhum bot: você escolhe isso depois, nos ajustes de cada bot.")
        }
        .confirmationDialog(Text(verbatim: t("Reconectar \(confirmingReconnect?.displayName ?? "")?", "Reconnect \(confirmingReconnect?.displayName ?? "")?")),
                            isPresented: Binding(get: { confirmingReconnect != nil }, set: { if !$0 { confirmingReconnect = nil } }), titleVisibility: .visible) {
            Button("Abrir a página oficial") {
                guard let account = confirmingReconnect, let editor = holder.editor else { return }
                confirmingReconnect = nil
                Task { if let page = await editor.reconnect(account) { NSWorkspace.shared.open(page) } }
            }
            .accessibilityIdentifier("settings.connections.reconnect.confirm")
            Button("Cancelar", role: .cancel) { confirmingReconnect = nil }
        } message: {
            Text(verbatim: t("O navegador abre a página oficial do serviço para você entrar de novo. Isso cria uma conta nova no Dexter, que começa sem bots: quem usava a conta anterior não é transferido, e você escolhe de novo depois.",
                             "The browser opens the service's official page so you sign in again. This creates a new account in Dexter that starts with no bots: whoever used the previous account is not carried over, and you choose again afterwards."))
        }
    }

    // MARK: Suas contas

    @ViewBuilder private var accountsContent: some View {
        if model.isFixture {
            Text("A demonstração não conecta contas de serviços.")
                .font(.callout).foregroundStyle(.secondary)
        } else if model.showsPairedBase {
            // The other base, by the scopes its owner granted this app (read-only or none without them).
            VStack(alignment: .leading, spacing: 8) { RemoteConnectionsContent() }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("settings.connections.paired")
        } else if let editor = holder.editor, editor.scope == model.filesScope {
            accountsList(editor)
        } else if holder.attemptedScope == model.filesScope || !model.canEditBotProfiles {
            Text("Sem base deste Mac conectada. Conectar apps aparece quando a base deste Mac estiver ligada.")
                .font(.callout).foregroundStyle(.secondary)
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func rows(_ editor: ManagedConnectAppsEditor) -> [ConnectionsHomeRow] {
        var rows = editor.managedAccounts.map(ConnectionsHomeRow.managed)
        if let servers = editor.nativeServers {
            rows += servers.map { server in
                .native(server, editor.nativeCredentials[server.id],
                        editor.directAccounts.first { $0.nativeServerId == server.id })
            }
        } else {
            rows += editor.directAccounts.map(ConnectionsHomeRow.projection)
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter { row in
            let haystack: [String]
            switch row {
            case .managed(let account), .projection(let account):
                haystack = [account.label, account.displayName, account.serviceId, account.identity.value ?? ""]
            case .native(let server, _, _):
                haystack = [server.name, server.destination, server.id]
            }
            return haystack.contains { $0.lowercased().contains(needle) }
        }
    }

    @ViewBuilder private func accountsList(_ editor: ManagedConnectAppsEditor) -> some View {
        HStack(spacing: 8) {
            TextField(t("Buscar contas", "Search accounts"), text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("settings.connections.search")
            connectMenu(editor)
        }
        setupRequests(editor)
        McpPrivateInputStrip(scope: .all, active: false)
        authorizationRow(editor)
        reconnectReview(editor)
        noticeRow(editor)
        let items = rows(editor)
        if items.isEmpty {
            Text(verbatim: query.isEmpty
                 ? t("Nenhuma conta ainda. Use Conectar app para entrar num serviço; nenhum bot ganha acesso só por conectar.",
                     "No accounts yet. Use Connect app to sign in to a service; no bot gets access just by connecting.")
                 : t("Nenhuma conta corresponde à busca.", "No account matches the search."))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.connections.accounts.empty")
        }
        ForEach(items) { row in
            switch row {
            case .managed(let account): managedRow(account, editor: editor)
            case .native(let server, let credentials, let projection): nativeRow(server, credentials: credentials, projection: projection, editor: editor)
            case .projection(let account): projectionRow(account)
            }
        }
        if editor.nativeServers == nil, editor.status != nil {
            Text(verbatim: t("As conexões MCP desta base não foram lidas agora. Abra Conexão personalizada (MCP) para conferir.",
                             "This host's MCP connections were not read now. Open Custom connection (MCP) to check."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func connectMenu(_ editor: ManagedConnectAppsEditor) -> some View {
        Menu {
            let services = editor.catalog?.services.filter { $0.availability.state == .available } ?? []
            if editor.status?.platform == .available, editor.catalog?.pin != nil, !services.isEmpty {
                ForEach(services) { entry in
                    Button(entry.displayName + "…") { confirming = entry }
                        .disabled(editor.busy || editor.pendingAuthorization != nil)
                }
            } else {
                Text(verbatim: t("Nenhum app gerenciado disponível nesta base", "No managed app available on this host"))
            }
            Divider()
            Button(t("Avançado: endereço MCP ou comando local…", "Advanced: MCP address or local command…")) { openDirectConnections(nil) }
                .disabled(!model.canUseHost)
        } label: {
            Label(t("Conectar app", "Connect app"), systemImage: "plus")
        }
        .fixedSize()
        .accessibilityIdentifier("settings.connections.connect-app")
    }

    private func managedRow(_ account: ConnectionAccount, editor: ManagedConnectAppsEditor) -> some View {
        let facts = ConnectionsPresentation.managed(account, accessUnconfirmed: editor.pendingAccess?.accountID == account.id,
                                                    disconnectUnconfirmed: editor.pendingDisconnect?.accountID == account.id, portuguese: portuguese)
        return ConnectionHomeRowView(
            title: account.label == account.displayName ? account.displayName : "\(account.label) · \(account.displayName)",
            subtitle: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese),
            method: t("via Composio", "via Composio"),
            facts: facts,
            primaryTitle: facts.action?.title(portuguese: portuguese),
            primaryDisabled: editor.busy,
            primary: { perform(facts.action, on: account, editor: editor) },
            detailsTitle: t("Detalhes…", "Details…"),
            details: { inspecting = InspectedAccount(id: account.id) },
            identifier: "settings.connections.account.\(account.id)")
    }

    private func nativeRow(_ server: McpServerSummary, credentials: McpCredentialStatus?, projection: ConnectionAccount?,
                           editor: ManagedConnectAppsEditor) -> some View {
        let facts = ConnectionsPresentation.native(server: server, credentials: credentials, portuguese: portuguese)
        let local = server.transport == "stdio"
        let place = server.status == "unavailable_here"
            ? t("roda em outro computador", "runs on another computer")
            : (local ? t("processo local", "local process") : t("servidor HTTP", "HTTP server"))
        let executor = server.executor.flatMap { $0.reachable == true ? $0.name : nil }
        let identity = projection.map { ManagedConnectAppsPresentation.identityLine($0.identity, portuguese: portuguese) }
            ?? t("Conta do serviço não verificada", "Service account not verified")
        return ConnectionHomeRowView(
            title: server.name,
            subtitle: identity,
            method: "MCP · " + place + (executor.map { " · " + $0 } ?? ""),
            facts: facts,
            primaryTitle: facts.action?.title(portuguese: portuguese),
            primaryDisabled: editor.busy,
            primary: {
                if facts.action == .check { Task { await editor.loadNativeInventory() } } else { openDirectConnections(server.id) }
            },
            detailsTitle: t("Abrir…", "Open…"),
            details: { openDirectConnections(server.id) },
            identifier: "settings.connections.native.\(server.id)")
    }

    /// The projection of a native OAuth connection when the inventory itself could not be read: status only.
    private func projectionRow(_ account: ConnectionAccount) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: account.label.isEmpty ? account.displayName : "\(account.label) · \(account.displayName)")
                    .font(.body.weight(.medium))
                Text(verbatim: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese))
                    .font(.callout).foregroundStyle(.secondary)
                Text(verbatim: [ManagedConnectAppsPresentation.statusKey(account.status), ManagedConnectAppsPresentation.persistenceKey(account.persistence)]
                    .map { DexterLocalization.text($0, locale: locale) }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(account.status == .connected ? Color.secondary : Color.orange)
            }
            Spacer(minLength: 8)
            Button("Abrir…") { openDirectConnections(account.nativeServerId) }
                .help(Text("Conexões personalizadas são geridas em Conexão personalizada (MCP)."))
                .accessibilityIdentifier("settings.connections.account.\(account.id).direct")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.connections.account.\(account.id)")
    }

    private func perform(_ action: ConnectionAction?, on account: ConnectionAccount, editor: ManagedConnectAppsEditor) {
        switch action {
        case .reconnect?: confirmingReconnect = account
        case .check?:
            if editor.pendingDisconnect?.accountID == account.id { Task { await editor.checkDisconnect() } }
            else if editor.pendingAccess?.accountID == account.id { Task { await editor.checkAccess() } }
            else { Task { await editor.reload() } }
        case .chooseBots?, .viewDetails?: inspecting = InspectedAccount(id: account.id)
        default: break
        }
    }

    /// Pedidos dos bots: open setup requests of this base, each with the private flow its target needs. Shown only when
    /// the base has the route and a request is open; nothing here grants by itself.
    @ViewBuilder private func setupRequests(_ editor: ManagedConnectAppsEditor) -> some View {
        let open = editor.openSetupRequests()
        if !open.isEmpty {
            Text(verbatim: t("Pedidos dos bots", "Requests from bots")).font(.headline)
                .accessibilityIdentifier("settings.connections.requests")
            ForEach(open) { workflow in
                ConnectionSetupRequestCard(workflow: workflow, editor: editor,
                    connect: { entry in confirmingSetupRequest = workflow.id; confirming = entry },
                    review: { reviewing = ReviewedSetupRequest(id: workflow.id) },
                    openNative: { server, _ in openDirectConnections(server) })
            }
        }
    }

    /// After Reconectar: the new account and the bots of the previous one, none selected. Each Permitir is one reviewed
    /// access change on the new account; nothing is migrated from the old one.
    @ViewBuilder private func reconnectReview(_ editor: ManagedConnectAppsEditor) -> some View {
        if let review = editor.reconnectReview {
            let account = editor.managedAccounts.first { $0.id == review.newAccountID }
            VStack(alignment: .leading, spacing: 8) {
                Label(t("Conta reconectada", "Account reconnected"), systemImage: "checkmark.circle").font(.callout.weight(.semibold))
                Text(verbatim: t("A conta nova começa sem bots. Os bots da conta anterior não foram transferidos: o Dexter não tem prova de que é a mesma conta. Escolha de novo quem pode usar.",
                                 "The new account starts with no bots. The previous account's bots were not carried over: Dexter has no proof it is the same account. Choose again who may use it."))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let account {
                    Text(verbatim: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese)).font(.callout)
                }
                ForEach(review.previousBotIDs, id: \.self) { botID in
                    let allowed = account?.bots.first { $0.botId == botID }.map { $0.access != .disabled } ?? false
                    HStack {
                        Text(verbatim: model.bots.first { $0.id == botID }?.name ?? botID)
                        Spacer()
                        if allowed {
                            Text(verbatim: t("Pode usar", "May use")).font(.caption).foregroundStyle(.secondary)
                        } else {
                            Button(t("Escolher ferramentas…", "Choose tools…")) {
                                if let account { inspecting = InspectedAccount(id: account.id) }
                            }
                            .disabled(account?.status != .connected || editor.busy || editor.pendingAccess != nil)
                            .accessibilityIdentifier("settings.connections.reconnect-review.bot.\(botID).allow")
                        }
                    }
                }
                HStack {
                    Spacer()
                    Button(t("Fechar", "Close")) { editor.dismissReconnectReview() }
                        .accessibilityIdentifier("settings.connections.reconnect-review.close")
                }
            }
            .padding(10)
            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.connections.reconnect-review")
        }
    }

    // MARK: Gallery (Conectar apps)

    @ViewBuilder private func gallery(_ editor: ManagedConnectAppsEditor) -> some View {
        if let status = editor.status {
            switch status.platform {
            case .unconfigured:
                Label("Conectar apps ainda não está configurado nesta base", systemImage: "puzzlepiece.extension")
                    .accessibilityIdentifier("settings.connections.unconfigured")
                Text(verbatim: DexterLocalization.text("connections.platform.entry.unconfiguredBody", locale: locale))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                ConnectionsPlatformSetupEntry(controller: platform.controller, prominent: true) { showsPlatformSetup = true }
                Button("O que falta para configurar…") { showsRequirements = true }
                    .accessibilityIdentifier("settings.connections.configure")
            case .unavailable:
                Label("O serviço de conexões não está respondendo", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("settings.connections.unavailable")
                Text("A base tem um serviço de conexões, mas ele não respondeu agora. Nenhuma conta nova pode ser conectada até ele voltar.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Atualizar") { Task { await editor.reload() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("settings.connections.reload")
            case .available:
                catalog(editor)
            }
            if status.platform != .unconfigured {
                ConnectionsPlatformSetupEntry(controller: platform.controller, prominent: false) { showsPlatformSetup = true }
            }
        } else if let notice = editor.notice {
            Label(noticeText(notice), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityIdentifier("settings.connections.notice")
            Button("Tentar de novo") { Task { await editor.reload() } }
                .disabled(editor.busy)
                .accessibilityIdentifier("settings.connections.reload")
        } else {
            ProgressView().controlSize(.small)
        }
    }

    @ViewBuilder private func catalog(_ editor: ManagedConnectAppsEditor) -> some View {
        if let catalog = editor.catalog {
            if catalog.freshness != .fresh {
                Text(catalog.freshness == .never ? "A lista de serviços ainda não foi carregada pela base." : "A lista de serviços pode estar desatualizada.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if catalog.services.isEmpty {
                Text("Nenhum serviço disponível nesta base.").font(.callout).foregroundStyle(.secondary)
            }
            ForEach(catalog.services) { entry in catalogRow(entry, editor: editor, pinned: catalog.pin != nil) }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func catalogRow(_ entry: ConnectionCatalogEntry, editor: ManagedConnectAppsEditor, pinned: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: entry.displayName).font(.body.weight(.medium))
                    if entry.verification == .unproven {
                        Text("Não comprovado").font(.caption).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            .help(Text("Este serviço ainda não foi testado de ponta a ponta com o Dexter."))
                    }
                }
                Text(verbatim: entry.description).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                Text(verbatim: toolsLine(entry.tools)).font(.caption).foregroundStyle(.secondary)
                if entry.availability.state == .unavailable {
                    Text(verbatim: DexterLocalization.text(availabilityKey(entry.availability.reason), locale: locale))
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 8)
            Button("Conectar…") { confirming = entry }
                .disabled(!pinned || editor.busy || editor.pendingAuthorization != nil || entry.availability.state != .available)
                .accessibilityIdentifier("settings.connections.connect.\(entry.serviceId)")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.connections.service.\(entry.serviceId)")
    }

    private func toolsLine(_ tools: [ConnectionToolSummary]) -> String {
        let reads = tools.filter { $0.effect == .read }.count, writes = tools.count - reads
        return DexterLocalization.format("Ferramentas: %@", "\(reads) " + (portuguese ? "de leitura" : "read") + " · \(writes) " + (portuguese ? "que alteram" : "that change"), locale: locale)
    }

    /// The pending login of THIS window: its state, "Conferir" (GET of the same request) and reopening the same page.
    @ViewBuilder private func authorizationRow(_ editor: ManagedConnectAppsEditor) -> some View {
        if (editor.pendingAuthorization != nil || editor.resumedAuthorizationID != nil) || editor.authorization != nil {
            let state = editor.authorization?.state ?? .unknown
            let service = editor.catalog?.services.first { $0.serviceId == (editor.authorization?.serviceId ?? editor.pendingAuthorization?.serviceId) }?.displayName
            let replacing = editor.pendingAuthorization?.replacesAccountId != nil
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    if let service {
                        Text(verbatim: replacing ? t("Reconectando \(service)", "Reconnecting \(service)") : service).font(.body.weight(.medium))
                    }
                    Text(verbatim: DexterLocalization.text(ManagedConnectAppsPresentation.authorizationKey(state), locale: locale))
                        .font(.callout).foregroundStyle(state.isTerminal && state != .connected ? Color.orange : Color.secondary)
                }
                Spacer()
                if editor.busy { ProgressView().controlSize(.small) }
                if (editor.pendingAuthorization != nil || editor.resumedAuthorizationID != nil) {
                    if let page = editor.authorization?.authorizationPage, editor.authorization?.linkAvailable == true {
                        Button("Abrir de novo") { NSWorkspace.shared.open(page) }
                            .accessibilityIdentifier("settings.connections.authorization.reopen")
                    }
                    Button("Conferir") { Task { await editor.checkAuthorization() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.connections.authorization.check")
                } else {
                    Button("Fechar") { editor.dismissAuthorization() }
                        .accessibilityIdentifier("settings.connections.authorization.dismiss")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.connections.authorization")
            if (editor.pendingAuthorization != nil || editor.resumedAuthorizationID != nil) {
                Text("Depois de entrar na página oficial, volte aqui e use Conferir. Nada é reenviado.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func noticeRow(_ editor: ManagedConnectAppsEditor) -> some View {
        if let notice = editor.notice, (notice != .connected && notice != .reconnected) || editor.authorization == nil {
            HStack {
                Text(verbatim: noticeText(notice))
                    .font(.callout).foregroundStyle(Self.isCalm(notice) ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if notice == .labelUnknown, editor.pendingLabel != nil {
                    Button("Conferir") { Task { await editor.checkLabel() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.connections.label.check")
                }
                if notice == .accessUnknown, editor.pendingAccess != nil {
                    Button("Conferir") { Task { await editor.checkAccess() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.connections.access.check")
                }
                if [.disconnectUnknown, .disconnectInProgress].contains(notice), editor.pendingDisconnect != nil {
                    Button("Conferir") { Task { await editor.checkDisconnect() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.connections.disconnect.check")
                }
                if notice == .workflowUnknown, editor.pendingWorkflow != nil {
                    Button("Conferir") { Task { await editor.checkWorkflow() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.connections.request.check")
                }
            }
            .accessibilityIdentifier("settings.connections.notice")
        }
    }

    private static func isCalm(_ notice: ManagedConnectAppsEditor.Notice) -> Bool { ManagedConnectAppsNoticeCopy.isCalm(notice) }
    private func noticeText(_ notice: ManagedConnectAppsEditor.Notice) -> String { ManagedConnectAppsNoticeCopy.text(notice, locale: locale) }

    private func availabilityKey(_ reason: ConnectionAvailability.Reason?) -> String {
        switch reason {
        case .platformUnconfigured?: "O serviço de conexões não está configurado."
        case .platformUnavailable?: "O serviço de conexões não está respondendo."
        case .noEligibleProfile?: "Este serviço não tem um perfil de conexão pronto nesta base."
        case nil: "Indisponível agora."
        }
    }

}

#endif

/// Plain words for every editor notice, shared by Conexões, the setup-request sheet and the chat cards.
enum ManagedConnectAppsNoticeCopy {
    static func isCalm(_ notice: ManagedConnectAppsEditor.Notice) -> Bool {
        switch notice {
        case .connected, .labelSaved, .accessSaved, .disconnected, .reconnected, .workflowCompleted, .workflowAccessSavedWithoutContinuation: true
        default: false
        }
    }

    static func text(_ notice: ManagedConnectAppsEditor.Notice, locale: Locale) -> String {
        let portuguese = locale.language.languageCode?.identifier == "pt"
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        if let key = noticeKey(notice) { return DexterLocalization.text(key, locale: locale) }
        switch notice {
        case .accessSaved(let enabled):
            return enabled ? t("Acesso salvo: o bot pode usar esta conta, com aprovação a cada chamada conforme o modo dele. Entra no próximo turno.",
                               "Access saved: the bot may use this account, with approval per call according to its mode. It enters on the next turn.")
                : t("Acesso retirado: o bot não usa mais esta conta.", "Access removed: the bot no longer uses this account.")
        case .accessUnknown: return t("Não foi possível confirmar a mudança de acesso. Use Conferir; nada foi reenviado.", "The access change could not be confirmed. Use Check; nothing was sent again.")
        case .accessConflict: return t("A conta mudou na base. Os dados foram relidos; o acesso não foi alterado.", "The account changed on the host. It was read again; access was not changed.")
        case .accessRefused: return t("A base recusou essa mudança de acesso.", "The host refused this access change.")
        case .accessSuperseded: return t("A base registrou a mudança de acesso, mas a conta ou as permissões mudaram depois; ela não é o acesso atual. Os dados foram relidos: confira e decida de novo.",
                                         "The host recorded the access change, but the account or permissions changed afterwards; it is not the current access. It was read again: check and decide again.")
        case .disconnected(let outcome): return ConnectionsPresentation.disconnectOutcome(outcome, portuguese: portuguese)
        case .disconnectUnknown: return t("Não foi possível confirmar a desconexão. Use Conferir; nada foi reenviado.", "The disconnect could not be confirmed. Use Check; nothing was sent again.")
        case .disconnectInProgress: return t("A base ainda está desconectando esta conta. Use Conferir de novo em instantes.", "The host is still disconnecting this account. Use Check again shortly.")
        case .disconnectConflict: return t("A conta mudou na base. Os dados foram relidos; nada foi desconectado.", "The account changed on the host. It was read again; nothing was disconnected.")
        case .disconnectRefused: return t("A base recusou a desconexão desta conta.", "The host refused to disconnect this account.")
        case .reconnected: return t("Conta reconectada. Escolha de novo quem pode usar.", "Account reconnected. Choose again who may use it.")
        case .workflowCompleted(let continued):
            return continued ? t("Acesso confirmado. A retomada da tarefa está na fila, nesta conversa.", "Access confirmed. The task resume is queued in this conversation.")
                : t("Acesso confirmado. A base não retomou a tarefa; peça ao bot para continuar.", "Access confirmed. The host did not resume the task; ask the bot to continue.")
        case .workflowEnded(let state): return workflowStateText(state, portuguese: portuguese)
        case .workflowPinsUnavailable:
            return t("A base ainda não informa os identificadores exatos das ferramentas. Esta tentativa não salvou acesso nem concluiu o pedido. Revise as ferramentas antes de Permitir.",
                     "The host does not report the tools' exact identifiers yet. This attempt saved no access and did not complete the request. Review the tools before Allow.")
        case .workflowAccessSavedWithoutContinuation:
            return t("Acesso salvo para as ferramentas escolhidas. O pedido continua aberto porque a base não publica os identificadores exatos; sem retomada automática.",
                     "Access saved for the selected tools. The request stays open because the host does not publish the exact identifiers; no automatic resume.")
        case .workflowListIncomplete:
            return t("Alguns pedidos vieram em um formato inválido. Os pedidos válidos continuam visíveis; use Atualizar para conferir a base.",
                     "Some requests have an invalid format. Valid requests remain visible; use Refresh to check the host.")
        case .workflowUnknown: return t("Não foi possível confirmar o pedido. Use Conferir; nada foi reenviado.", "The request could not be confirmed. Use Check; nothing was sent again.")
        case .workflowConflict: return t("O pedido ou a conta mudou na base. Os dados foram relidos; nada foi concluído.", "The request or the account changed on the host. It was read again; nothing was completed.")
        case .workflowRefused: return t("A base recusou concluir este pedido.", "The host refused to complete this request.")
        case .workflowNotApplied: return t("A base mostra o pedido ainda aberto: nada foi concluído. Você pode decidir de novo.", "The host shows the request still open: nothing was completed. You can decide again.")
        case .workflowNothingGranted: return t("Uma conexão escolhida não tem ferramentas permitidas para este bot. Nada foi concluído.", "A chosen connection has no tools allowed for this bot. Nothing was completed.")
        default: return ""
        }
    }

    static func workflowStateText(_ state: ConnectionWorkflowState, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        switch state {
        case .awaitingUser: return t("Aguardando você", "Waiting for you")
        case .ready: return t("Concluído", "Completed")
        case .cancelled: return t("Recusado", "Declined")
        case .expired: return t("Expirou", "Expired")
        case .stopped: return t("Parado", "Stopped")
        case .conflict: return t("Em conflito: algo mudou desde o pedido", "In conflict: something changed since the request")
        }
    }

    private static func noticeKey(_ notice: ManagedConnectAppsEditor.Notice) -> String? {
        switch notice {
        case .loadFailed: "Não foi possível ler as conexões desta base."
        case .offline: "A base deste Mac não está respondendo agora."
        case .hostChanged: "A base mudou enquanto você olhava. Feche e abra Ajustes de novo."
        case .catalogChanged: "A lista de serviços mudou. Ela foi relida; nada foi enviado."
        case .authorizationUnknown: "Não foi possível confirmar como está a conexão. Use Conferir; nada foi reenviado."
        case .authorizationEnded(let state, _): ManagedConnectAppsPresentation.authorizationKey(state)
        case .connected: "Conta conectada. Nenhum bot usa esta conta até você escolher nos ajustes do bot."
        case .labelSaved: "Nome salvo."
        case .labelUnknown: "Não foi possível confirmar o novo nome. Use Conferir; nada foi reenviado."
        case .labelConflict: "A conta mudou na base. Os dados foram relidos; o nome não foi trocado."
        case .labelRefused: "A base recusou esse nome."
        default: nil
        }
    }
}

/// One row of Suas contas: identity, method, the three facts (each on its own line, labelled by axis) and at most one
/// primary verb beside the details. Text wraps instead of truncating.
private struct ConnectionHomeRowView: View {
    let title: String
    let subtitle: String
    let method: String
    let facts: ConnectionRowFacts
    let primaryTitle: String?
    let primaryDisabled: Bool
    let primary: () -> Void
    let detailsTitle: String
    let details: () -> Void
    let identifier: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: title).font(.body.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                    Text(verbatim: method).font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1).background(.quaternary, in: Capsule())
                }
                Text(verbatim: subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                ConnectionFactsView(facts: facts, compact: true)
                    .accessibilityIdentifier(identifier + ".facts")
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let primaryTitle {
                    Button(primaryTitle, action: primary)
                        .disabled(primaryDisabled)
                        .accessibilityIdentifier(identifier + ".primary")
                }
                Button(detailsTitle, action: details)
                    .accessibilityIdentifier(identifier + ".inspect")
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }
}

/// Account, access and this conversation as three labelled lines; tone by symbol and color, never by color alone.
struct ConnectionFactsView: View {
    let facts: ConnectionRowFacts
    var compact = false
    @Environment(\.locale) private var locale
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 1 : 4) {
            ForEach(facts.all, id: \.axis) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: fact.symbol).foregroundStyle(Self.color(fact.tone)).accessibilityHidden(true)
                    Text(verbatim: axisLabel(fact.axis)).foregroundStyle(.secondary)
                    Text(verbatim: fact.text).fixedSize(horizontal: false, vertical: true)
                }
                .font(compact ? .caption : .callout)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("connections.fact.\(fact.axis.rawValue)")
            }
        }
    }

    private func axisLabel(_ axis: ConnectionFact.Axis) -> String {
        switch axis {
        case .account: t("Conta:", "Account:")
        case .access: t("Acesso:", "Access:")
        case .admission: t("Nesta conversa:", "This conversation:")
        }
    }

    static func color(_ tone: ConnectionFactTone) -> Color {
        switch tone {
        case .confirmed: .green
        case .attention: .orange
        case .problem: .red
        case .neutral: .secondary
        case .unknown: .orange
        }
    }
}

/// One managed account, compact and reusable: identity (confirmed versus the owner's name), where the access is kept,
/// the three facts, the tools, who may use it (one reviewed change per bot), Reconectar, Desconectar and Renomear,
/// and the technical details on demand. Close is visible and Escape closes; nothing here opens another sheet.
struct ConnectionAccountInspector: View {
    let accountID: String
    let editor: ManagedConnectAppsEditor
    /// The parent confirms Reconectar and opens the official page (this sheet closes first).
    let onReconnect: (ConnectionAccount) -> Void
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var editingLabel = false
    @State private var label = ""
    @State private var confirmingDisconnect = false
    /// The bot whose exact tools are being chosen inline (no extra sheet), and the tools ticked for it.
    @State private var editingBot: String?
    @State private var botTools: Set<String> = []
    @FocusState private var labelFocused: Bool

    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
    private var account: ConnectionAccount? { editor.managedAccounts.first { $0.id == accountID } }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: account.map { $0.label == $0.displayName ? $0.displayName : "\($0.label) · \($0.displayName)" } ?? t("Conta", "Account"))
                    .font(.title3.weight(.semibold)).lineLimit(2)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if editor.busy { ProgressView().controlSize(.small) }
                Button { dismiss() } label: { Label(t("Fechar", "Close"), systemImage: "xmark.circle.fill").labelStyle(.iconOnly) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .keyboardShortcut(.cancelAction)
                    .help(Text(verbatim: t("Fechar (Esc)", "Close (Esc)")))
                    .accessibilityLabel(Text(verbatim: t("Fechar", "Close")))
                    .accessibilityIdentifier("connections.inspector.close")
            }
            .padding(16)
            Divider()
            ScrollView {
                if let account {
                    content(account).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(verbatim: t("Esta conta não está mais na lista desta base.", "This account is no longer listed on this host."))
                        .foregroundStyle(.secondary).padding(16)
                }
            }
            Divider()
            HStack {
                Spacer()
                Button(t("Fechar", "Close")) { dismiss() }
                    .accessibilityIdentifier("connections.inspector.done")
            }
            .padding(12)
        }
        .connectionsSheetFrame()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.inspector")
        .confirmationDialog(Text(verbatim: t("Desconectar esta conta?", "Disconnect this account?")), isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button(t("Desconectar", "Disconnect"), role: .destructive) {
                guard let account else { return }
                Task { await editor.disconnect(account) }
            }
            .accessibilityIdentifier("connections.inspector.disconnect.confirm")
            Button(t("Cancelar", "Cancel"), role: .cancel) {}
        } message: {
            if let account {
                Text(verbatim: ConnectionsPresentation.disconnectImpact(account, botName: { id in model.bots.first { $0.id == id }?.name }, portuguese: portuguese))
            }
        }
    }

    @ViewBuilder private func content(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            identity(account)
            ConnectionFactsView(facts: ConnectionsPresentation.managed(account, accessUnconfirmed: editor.pendingAccess?.accountID == account.id,
                                                                       disconnectUnconfirmed: editor.pendingDisconnect?.accountID == account.id,
                                                                       portuguese: portuguese))
                .accessibilityIdentifier("connections.inspector.facts")
            pending(account)
            access(account)
            tools(account)
            actions(account)
            DisclosureGroup(t("Detalhes técnicos", "Technical details")) { technical(account) }
                .font(.callout)
                .accessibilityIdentifier("connections.inspector.technical")
        }
    }

    @ViewBuilder private func identity(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese))
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            if editingLabel {
                HStack {
                    TextField(t("Nome que você dá a esta conta", "Your name for this account"), text: $label)
                        .textFieldStyle(.roundedBorder).focused($labelFocused)
                        .onSubmit(saveLabel)
                        .accessibilityIdentifier("connections.inspector.rename.field")
                    Button(t("Cancelar", "Cancel")) { editingLabel = false }
                    Button(t("Salvar", "Save"), action: saveLabel)
                        .disabled(trimmedLabel.isEmpty || trimmedLabel == account.label || trimmedLabel.count > 80 || editor.busy)
                        .accessibilityIdentifier("connections.inspector.rename.save")
                }
                Text(verbatim: t("Só um nome para você reconhecer a conta. Não muda a conta no serviço nem o nome que os bots veem.",
                                 "Just a name for you to recognize the account. It does not change the account at the service or the name bots see."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                HStack {
                    LabeledContent(t("Nome que você deu", "Your name for it")) { Text(verbatim: account.label) }
                    Button(t("Renomear…", "Rename…")) { label = account.label; editingLabel = true; labelFocused = true }
                        .disabled(editor.busy || editor.pendingLabel != nil || !editor.canManageConnections)
                        .accessibilityIdentifier("settings.connections.account.\(account.id).rename")
                }
            }
            LabeledContent(t("Serviço", "Service")) { Text(verbatim: account.displayName + " · via Composio") }
            LabeledContent(t("Onde fica o acesso", "Where access is kept")) {
                Text(verbatim: DexterLocalization.text(ManagedConnectAppsPresentation.persistenceKey(account.persistence), locale: locale))
            }
            LabeledContent(t("Base", "Host")) { Text(verbatim: editor.isRemote ? t("Base pareada (outra máquina)", "Paired host (another machine)") : t("Base deste Mac", "This Mac's host")) }
        }
        .font(.callout)
    }

    private var trimmedLabel: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func saveLabel() {
        guard let account, !trimmedLabel.isEmpty, trimmedLabel != account.label, trimmedLabel.count <= 80, !editor.busy else { return }
        let value = trimmedLabel
        editingLabel = false
        Task { await editor.setLabel(account, to: value) }
    }

    @ViewBuilder private func pending(_ account: ConnectionAccount) -> some View {
        if editor.pendingAccess?.accountID == account.id {
            HStack {
                Text(verbatim: t("A última mudança de acesso não foi confirmada. Conferir lê o recibo do mesmo pedido; nada é reenviado.",
                                 "The last access change is not confirmed. Check reads the receipt of the same request; nothing is sent again."))
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(t("Conferir", "Check")) { Task { await editor.checkAccess() } }
                    .disabled(editor.busy).accessibilityIdentifier("connections.inspector.access.check")
            }
        }
        if editor.pendingDisconnect?.accountID == account.id {
            HStack {
                Text(verbatim: t("A desconexão não foi confirmada. Conferir lê o recibo e depois a conta; nada é reenviado.",
                                 "The disconnect is not confirmed. Check reads the receipt, then the account; nothing is sent again."))
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(t("Conferir", "Check")) { Task { await editor.checkDisconnect() } }
                    .disabled(editor.busy).accessibilityIdentifier("connections.inspector.disconnect.check")
            }
        }
        if editor.pendingLabel?.accountID == account.id {
            HStack {
                Text(verbatim: t("O novo nome não foi confirmado.", "The new name is not confirmed."))
                    .font(.callout).foregroundStyle(.orange)
                Spacer()
                Button(t("Conferir", "Check")) { Task { await editor.checkLabel() } }
                    .disabled(editor.busy).accessibilityIdentifier("connections.inspector.label.check")
            }
        }
    }

    /// Quem pode usar: each bot of this base with its derived access and one reviewed change at a time. Turning a bot on
    /// gives it every tool below with `ask`; the bot's approval mode still applies. Nothing applies to future bots.
    @ViewBuilder private func access(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: t("Quem pode usar", "Who may use it")).font(.headline)
            Text(verbatim: t("Escolha as ferramentas exatas de cada bot; as não marcadas ficam negadas para ele nesta conta. Cada chamada segue o modo de aprovação do bot. Bots e ferramentas que aparecerem depois não entram sozinhos.",
                             "Choose each bot's exact tools; unticked ones are denied for it on this account. Each call follows the bot's approval mode. Bots and tools that appear later are not added on their own."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            let known = Set(model.bots.map(\.id))
            let others = account.bots.filter { !known.contains($0.botId) && $0.access != .disabled }
            if model.bots.isEmpty && others.isEmpty {
                Text(verbatim: t("Nenhum bot nesta base.", "No bots on this host.")).font(.callout).foregroundStyle(.secondary)
            }
            ForEach(model.bots) { bot in
                botRow(account, botID: bot.id, name: bot.name)
            }
            ForEach(others) { item in
                botRow(account, botID: item.botId, name: item.botId)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.inspector.access")
    }

    @ViewBuilder private func botRow(_ account: ConnectionAccount, botID: String, name: String) -> some View {
        let access = account.bots.first { $0.botId == botID }
        let state = access?.access ?? .disabled
        let current = access?.toolNames
        let blocked = editor.busy || editor.pendingAccess != nil || editor.pendingDisconnect?.accountID == account.id || !editor.canManageConnections
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(verbatim: name)
                Text(verbatim: state == .enabled ? t("usa", "uses") : state == .partial ? t("parcial", "partial") : t("não usa", "does not use"))
                    .font(.caption).foregroundStyle(state == .partial ? Color.orange : Color.secondary)
                Spacer()
                Button(state == .disabled ? t("Permitir…", "Allow…") : t("Ferramentas…", "Tools…")) {
                    editingBot = botID
                    // Start from the exact current tools when the host reports them; otherwise from reviewed reads only.
                    botTools = Set(current.flatMap { $0.isEmpty ? nil : $0 } ?? account.tools.filter { $0.effect == .read }.map(\.name))
                }
                .disabled(blocked || account.status != .connected || editingBot == botID)
                .accessibilityIdentifier("connections.inspector.bot.\(botID).allow")
                if state != .disabled {
                    Button(t("Retirar", "Remove")) { Task { await editor.setAccess(account, botID: botID, enabled: false) } }
                        .disabled(blocked)
                        .accessibilityIdentifier("connections.inspector.bot.\(botID).revoke")
                }
            }
            if let current, state != .disabled {
                Text(verbatim: current.isEmpty ? t("Nenhuma ferramenta permitida agora", "No tool allowed now")
                     : t("Permitidas agora: ", "Allowed now: ") + current.joined(separator: ", "))
                    .font(.caption.monospaced()).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connections.inspector.bot.\(botID).current")
            }
            if editingBot == botID { toolPicker(account, botID: botID, current: state, known: current != nil) }
        }
        .font(.callout)
        .accessibilityElement(children: .contain)
    }

    /// Inline exact-tool choice for one bot: presets, one toggle per pinned tool with its reviewed effect, and one save.
    @ViewBuilder private func toolPicker(_ account: ConnectionAccount, botID: String, current: ConnectionBotAccessState, known: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if current != .disabled, !known {
                Text(verbatim: t("A base não informa quais ferramentas este bot tem hoje nesta conta. Salvar define exatamente as marcadas.",
                                 "The host does not report which tools this bot holds on this account today. Saving sets exactly the ticked ones."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button(t("Só leitura", "Read only")) { botTools = Set(account.tools.filter { $0.effect == .read }.map(\.name)) }
                Button(t("Todas", "All")) { botTools = Set(account.tools.map(\.name)) }
            }
            .controlSize(.small)
            ForEach(account.tools, id: \.name) { tool in
                Toggle(isOn: Binding(get: { botTools.contains(tool.name) }, set: { on in
                    if on { botTools.insert(tool.name) } else { botTools.remove(tool.name) }
                })) {
                    HStack {
                        Text(verbatim: tool.name).font(.callout.monospaced())
                        Spacer()
                        Text(verbatim: tool.effect == .read ? t("leitura", "read") : t("pode alterar dados", "can change data"))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("connections.inspector.bot.\(botID).tool.\(tool.name)")
            }
            HStack {
                Spacer()
                Button(t("Cancelar", "Cancel")) { editingBot = nil }
                Button(t("Salvar acesso", "Save access")) {
                    let names = botTools.sorted()
                    editingBot = nil
                    Task { await editor.setAccess(account, botID: botID, enabled: true, toolNames: names) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(botTools.isEmpty || editor.busy || editor.pendingAccess != nil)
                .accessibilityIdentifier("connections.inspector.bot.\(botID).save")
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.inspector.bot.\(botID).tools")
    }

    @ViewBuilder private func tools(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: t("Ferramentas", "Tools")).font(.headline)
            if account.tools.isEmpty {
                Text(verbatim: t("Esta conta não tem ferramentas fixadas.", "This account has no pinned tools.")).font(.callout).foregroundStyle(.secondary)
            }
            ForEach(account.tools, id: \.name) { tool in
                HStack {
                    Text(verbatim: tool.name).font(.callout.monospaced()).textSelection(.enabled)
                    Spacer()
                    Text(verbatim: tool.effect == .read ? t("leitura", "read") : t("pode alterar dados", "can change data"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(verbatim: t("O efeito vem do catálogo revisado da base.", "The effect comes from the host's reviewed catalog."))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func actions(_ account: ConnectionAccount) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack { actionButtons(account) }
            VStack(alignment: .leading) { actionButtons(account) }
        }
    }

    @ViewBuilder private func actionButtons(_ account: ConnectionAccount) -> some View {
        if ManagedConnectAppsEditor.offersReconnect(account) {
            Button(t("Reconectar…", "Reconnect…")) { onReconnect(account) }
                .buttonStyle(.borderedProminent)
                .disabled(editor.busy || !editor.canManageConnections || editor.pendingAuthorization != nil || editor.catalog?.services.contains { $0.serviceId == account.serviceId && $0.availability.state == .available } != true)
                .accessibilityIdentifier("connections.inspector.reconnect")
        }
        Button(t("Desconectar…", "Disconnect…"), role: .destructive) { confirmingDisconnect = true }
            .disabled(editor.busy || !editor.canManageConnections || editor.pendingDisconnect != nil || [.disconnected, .disconnecting, .replaced].contains(account.status))
            .accessibilityIdentifier("connections.inspector.disconnect")
    }

    @ViewBuilder private func technical(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            row(t("ID da conta", "Account ID"), account.id)
            row(t("Revisão", "Revision"), String(account.revision))
            if let profile = account.profileId { row(t("Perfil", "Profile"), profile) }
            if let previous = account.previousAccountId { row(t("Conta anterior", "Previous account"), previous) }
            if let checked = account.statusCheckedAt {
                row(t("Estado consultado em", "State checked at"),
                    Date(timeIntervalSince1970: TimeInterval(checked) / 1_000).formatted(date: .abbreviated, time: .shortened))
            }
            if let changed = account.identityChanged {
                row(t("Nome de exibição mudou desde a conta anterior", "Display name changed since the previous account"),
                    changed ? t("sim (não prova outra conta)", "yes (does not prove another account)") : t("não (não prova a mesma conta)", "no (does not prove the same account)"))
            }
            row(t("Destinos no gateway", "Gateway destinations"), String(account.gatewayConnectionIds.count))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title) { Text(verbatim: value).font(.caption.monospaced()).textSelection(.enabled) }.font(.caption)
    }
}

/// One open setup request: which bot asks for what, until when, and the one private step its target needs next —
/// Conectar (no connected account of the service yet), Revisar e permitir (an account exists) or the native manager.
/// Recusar makes the request inert. The bot comes from the host's request, never from this view.
struct ConnectionSetupRequestCard: View {
    let workflow: ConnectionWorkflow
    let editor: ManagedConnectAppsEditor
    let connect: (ConnectionCatalogEntry) -> Void
    let review: () -> Void
    /// Server and bot of a native request: opens the native manager on them.
    let openNative: (String, String) -> Void
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.openURL) private var openURL
    @State private var confirmingDecline = false
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    private var botName: String { model.bots.first { $0.id == workflow.botId }?.name ?? workflow.botId }
    private var targetName: String {
        switch workflow.target {
        case .managed(let service, _): editor.catalog?.services.first { $0.serviceId == service }?.displayName ?? service
        case .nativeMCP(let server, _): editor.nativeServers?.first { $0.id == server }?.name ?? server
        }
    }
    private var connectedAccounts: [ConnectionAccount] {
        guard case .managed(let service, _) = workflow.target else { return [] }
        return editor.managedAccounts.filter { $0.serviceId == service && $0.status == .connected }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: t("\(botName) pede acesso a \(targetName)", "\(botName) asks for access to \(targetName)"))
                .font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            Text(verbatim: t("Expira \(Date(timeIntervalSince1970: TimeInterval(workflow.expiresAt) / 1_000).formatted(date: .omitted, time: .shortened)). Nada é liberado sem a sua revisão de conta, bot e ferramentas.",
                             "Expires \(Date(timeIntervalSince1970: TimeInterval(workflow.expiresAt) / 1_000).formatted(date: .omitted, time: .shortened)). Nothing is granted without your review of account, bot and tools."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(alignment: .leading, spacing: 6) { buttons }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.request.\(workflow.id)")
        .task(id: workflow.id + "|" + String(connectedAccounts.isEmpty)) {
            // A login already started for this request (e.g. before this window closed) is offered back, never restarted.
            if case .managed = workflow.target, connectedAccounts.isEmpty { await editor.loadChoices(workflow) }
        }
        .confirmationDialog(Text(verbatim: t("Recusar este pedido?", "Decline this request?")), isPresented: $confirmingDecline, titleVisibility: .visible) {
            Button(t("Recusar pedido", "Decline request"), role: .destructive) { Task { await editor.cancelSetupRequest(workflow) } }
                .accessibilityIdentifier("connections.request.\(workflow.id).decline.confirm")
            Button(t("Cancelar", "Cancel"), role: .cancel) {}
        } message: {
            Text(verbatim: t("O bot não recebe acesso por este pedido. Acessos que você já salvou em uma conta continuam como estão.",
                             "The bot gets no access from this request. Access you already saved on an account stays as it is."))
        }
    }

    @ViewBuilder private var buttons: some View {
        let blocked = editor.busy || editor.pendingWorkflow != nil || !editor.canManageConnections
        switch workflow.target {
        case .managed(let service, _):
            if connectedAccounts.isEmpty, editor.pendingAuthorization == nil, editor.resumedAuthorizationID == nil,
               let started = editor.resumableAuthorizationID(for: workflow.id) {
                Button(t("Retomar login…", "Resume sign-in…")) {
                    Task { if let page = await editor.resumeAuthorization(clientRequestID: started) { openURL(page) } }
                }
                .buttonStyle(.borderedProminent)
                .disabled(blocked)
                .help(Text(verbatim: t("Lê o login já começado para este pedido; não cria outro link.", "Reads the sign-in already started for this request; it creates no new link.")))
                .accessibilityIdentifier("connections.request.\(workflow.id).resume")
            } else if connectedAccounts.isEmpty {
                let entry = editor.catalog?.services.first { $0.serviceId == service && $0.availability.state == .available }
                Button(t("Conectar \(targetName)…", "Connect \(targetName)…")) { if let entry { connect(entry) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(blocked || entry == nil || editor.pendingAuthorization != nil || editor.catalog?.pin == nil)
                    .accessibilityIdentifier("connections.request.\(workflow.id).connect")
            } else {
                Button(t("Revisar e permitir…", "Review and allow…"), action: review)
                    .buttonStyle(.borderedProminent)
                    .disabled(blocked)
                    .accessibilityIdentifier("connections.request.\(workflow.id).review")
            }
        case .nativeMCP(let server, _):
            if editor.isRemote {
                // Native sign-in and tool choice stay on the owner's Mac; nothing here pretends to open them.
                Text(verbatim: t("Entrar e escolher as ferramentas de \(targetName) é feito no Mac dono da base.",
                                 "Signing in and choosing \(targetName)'s tools is done on the host owner's Mac."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Button(t("Abrir \(targetName)…", "Open \(targetName)…")) { openNative(server, workflow.botId) }
                    .buttonStyle(.borderedProminent)
                    .disabled(blocked)
                    .accessibilityIdentifier("connections.request.\(workflow.id).open")
            }
            Button(t("Revisar e permitir…", "Review and allow…"), action: review)
                .disabled(blocked)
                .accessibilityIdentifier("connections.request.\(workflow.id).review")
        }
        Button(t("Recusar…", "Decline…")) { confirmingDecline = true }
            .disabled(blocked)
            .accessibilityIdentifier("connections.request.\(workflow.id).decline")
        if editor.pendingWorkflow?.workflowID == workflow.id {
            Button(t("Conferir", "Check")) { Task { await editor.checkWorkflow() } }
                .disabled(editor.busy)
                .accessibilityIdentifier("connections.request.\(workflow.id).check")
        }
    }
}

/// Revisar e permitir: the exact connection(s) the host lists as choices for this request now, the requesting bot (fixed)
/// and the tools it would hold, then one Permitir e continuar. Connections are chosen explicitly (one, some, or every one listed
/// now, up to five); nothing is added later on its own. Close is visible and Escape closes; nothing opens another sheet.
struct ConnectionSetupRequestSheet: View {
    let workflowID: String
    let editor: ManagedConnectAppsEditor
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var chosen: Set<String> = []
    /// Exact tools per chosen connection; seeded from what the bot holds or the reviewed read tools, then edited.
    @State private var tools: [String: Set<String>] = [:]
    @State private var seeded = false
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    private var workflow: ConnectionWorkflow? { editor.setupRequests?.first { $0.id == workflowID } }
    private var isNative: Bool { if case .nativeMCP? = workflow?.target { true } else { false } }
    /// The host's current choices (GET, re-read before completing); nil until read or when the base has none to offer.
    private var candidates: [ConnectionWorkflowChoices.Choice]? {
        editor.choicesSupported == false ? nil : editor.setupChoices[workflowID]?.choices
    }
    /// Fallback when the base answers that choices are unavailable (managed only): connected accounts of the service.
    private var accounts: [ConnectionAccount] {
        guard case .managed(let service, _)? = workflow?.target else { return [] }
        return editor.managedAccounts.filter { $0.serviceId == service && $0.status == .connected }
    }
    private var choices: [String] {
        if let candidates { return candidates.map(\.connectionId) }
        return editor.choicesSupported == false ? accounts.map(\.id) : []
    }
    private var chosenInOrder: [String] { choices.filter { chosen.contains($0) } }
    private var nativeChoiceWithoutTools: Bool {
        isNative && (candidates ?? []).contains { chosen.contains($0.connectionId) && $0.enabledSelection == nil }
    }
    /// The exact selections Permitir e continuar sends; nil while a chosen connection has no tool ticked.
    private var exactSelections: [ManagedConnectAppsEditor.SetupSelection]? {
        let list = chosenInOrder.map { ManagedConnectAppsEditor.SetupSelection(connectionID: $0, toolNames: Array(tools[$0] ?? [])) }
        return list.isEmpty || list.contains(where: { $0.toolNames.isEmpty }) ? nil : list
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: t("Revisar acesso", "Review access")).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                if (editor.busy || editor.workflowChainInProgress) { ProgressView().controlSize(.small) }
                Button { dismiss() } label: { Label(t("Fechar", "Close"), systemImage: "xmark.circle.fill").labelStyle(.iconOnly) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .keyboardShortcut(.cancelAction)
                    .help(Text(verbatim: t("Fechar (Esc)", "Close (Esc)")))
                    .accessibilityLabel(Text(verbatim: t("Fechar", "Close")))
                    .accessibilityIdentifier("connections.request-review.close")
            }
            .padding(16)
            Divider()
            ScrollView {
                if let workflow {
                    content(workflow).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(verbatim: t("Este pedido não está mais na lista desta base.", "This request is no longer listed on this host."))
                        .foregroundStyle(.secondary).padding(16)
                }
            }
            Divider()
            footer.padding(12)
        }
        .connectionsSheetFrame()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.request-review")
        .onAppear(perform: seed)
        .onChange(of: choices) { _, _ in seed() }
        .task { if let workflow { await editor.loadChoices(workflow) } }
    }

    /// Intent may be prefilled, never granted: a single listed connection starts chosen; with several, none is.
    private func seed() {
        guard !seeded, !choices.isEmpty else { return }
        seeded = true
        if choices.count == 1 { toggle(choices[0]).wrappedValue = true }
    }

    private func toggle(_ id: String) -> Binding<Bool> {
        Binding(get: { chosen.contains(id) }, set: { on in
            if on, chosen.count < 5 {
                chosen.insert(id)
                if tools[id] == nil {
                    if let choice = candidates?.first(where: { $0.connectionId == id }) {
                        tools[id] = Set(ManagedConnectAppsEditor.suggestedTools(choice))
                    } else if let account = accounts.first(where: { $0.id == id }) {
                        tools[id] = Set(account.tools.filter { $0.effect == .read }.map(\.name))
                    }
                }
            } else if !on { chosen.remove(id) }
        })
    }

    private func toolToggle(_ connectionID: String, _ name: String) -> Binding<Bool> {
        Binding(get: { tools[connectionID]?.contains(name) == true }, set: { on in
            var set = tools[connectionID] ?? []
            if on { set.insert(name) } else { set.remove(name) }
            tools[connectionID] = set
        })
    }

    @ViewBuilder private func content(_ workflow: ConnectionWorkflow) -> some View {
        let botName = model.bots.first { $0.id == workflow.botId }?.name ?? workflow.botId
        VStack(alignment: .leading, spacing: 14) {
            LabeledContent(t("Bot", "Bot")) { Text(verbatim: botName) }
            LabeledContent(t("Pedido", "Request")) { Text(verbatim: ManagedConnectAppsNoticeCopy.workflowStateText(workflow.state, portuguese: portuguese)) }
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: isNative ? t("Conexões", "Connections") : t("Contas", "Accounts")).font(.headline)
                if candidates == nil, editor.choicesReadFailed.contains(workflowID) {
                    HStack {
                        Text(verbatim: t("Não foi possível ler as opções deste pedido agora.", "This request's options could not be read now."))
                            .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button(t("Ler de novo", "Read again")) { Task { await editor.loadChoices(workflow) } }
                            .disabled((editor.busy || editor.workflowChainInProgress))
                            .accessibilityIdentifier("connections.request-review.reload")
                    }
                } else if candidates == nil, editor.choicesSupported == nil {
                    ProgressView().controlSize(.small)
                } else if choices.isEmpty {
                    Text(verbatim: isNative
                         ? t("A base ainda não lista esta conexão para o pedido. Abra a conexão para entrar e escolher as ferramentas deste bot.",
                             "The host does not list this connection for the request yet. Open the connection to sign in and choose this bot's tools.")
                         : t("Nenhuma conta conectada deste serviço. Conecte uma em Conexões e volte aqui.",
                             "No connected account of this service. Connect one in Connections and come back."))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let candidates {
                    ForEach(candidates) { candidate in
                        Toggle(isOn: toggle(candidate.connectionId)) { candidateLabel(candidate) }
                            .disabled((editor.busy || editor.workflowChainInProgress))
                            .accessibilityIdentifier("connections.request-review.connection.\(candidate.connectionId)")
                    }
                } else if editor.choicesSupported == false {
                    ForEach(accounts) { account in
                        Toggle(isOn: toggle(account.id)) { accountLabel(account) }
                            .disabled((editor.busy || editor.workflowChainInProgress))
                            .accessibilityIdentifier("connections.request-review.account.\(account.id)")
                    }
                }
                if choices.count > 1 {
                    Text(verbatim: t("Marque uma, algumas ou todas as listadas agora (até 5). As que aparecerem depois não entram sozinhas.",
                                     "Tick one, some or every one listed now (up to 5). Ones that appear later are not added on their own."))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            tools(botName: botName)
            if editor.choicesSupported == false, !isNative, !chosen.isEmpty {
                Label(t("A base ainda não publica os identificadores exatos destas ferramentas. Permitir salva o acesso; o pedido fica aberto e o bot usa a conta no próximo turno, sem retomada automática.",
                        "The host does not publish these tools' exact identifiers yet. Allow saves the access; the request stays open and the bot uses the account on its next turn, without automatic resume."),
                      systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connections.request-review.pins-unavailable")
            }
            if nativeChoiceWithoutTools {
                Label(t("Nenhuma ferramenta desta conexão está escolhida para este bot. Escolha-as na conexão (Abrir…) e volte aqui.",
                        "No tool of this connection is chosen for this bot. Choose them in the connection (Open…) and come back."),
                      systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connections.request-review.native-no-tools")
            }
            if let notice = editor.notice, Self.relevant(notice) {
                Text(verbatim: ManagedConnectAppsNoticeCopy.text(notice, locale: locale))
                    .font(.callout).foregroundStyle(ManagedConnectAppsNoticeCopy.isCalm(notice) ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connections.request-review.notice")
            }
        }
    }

    private func accountLabel(_ account: ConnectionAccount) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: account.label == account.displayName ? account.displayName : "\(account.label) · \(account.displayName)")
            Text(verbatim: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func candidateLabel(_ candidate: ConnectionWorkflowChoices.Choice) -> some View {
        if let account = editor.account(forConnection: candidate.connectionId) {
            accountLabel(account)
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: candidate.label)
                Text(verbatim: candidate.connectionId).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }

    /// The exact tools of each chosen connection: ticked explicitly, with presets, and whether the bot holds them now.
    /// Unticked tools of a managed account become denied for this bot; native tools are chosen in the native manager.
    @ViewBuilder private func tools(botName: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: t("Ferramentas para \(botName)", "Tools for \(botName)")).font(.headline)
            if chosen.isEmpty {
                Text(verbatim: t("Escolha uma opção acima para ver as ferramentas.", "Choose an option above to see the tools.")).font(.callout).foregroundStyle(.secondary)
            }
            if let candidates {
                ForEach(candidates.filter { chosen.contains($0.connectionId) }) { candidate in
                    if candidates.filter({ chosen.contains($0.connectionId) }).count > 1 {
                        Text(verbatim: editor.account(forConnection: candidate.connectionId)?.label ?? candidate.label).font(.subheadline.weight(.semibold))
                    }
                    if !isNative {
                        HStack {
                            Button(t("Só leitura", "Read only")) {
                                tools[candidate.connectionId] = Set(candidate.tools.filter { $0.effect == .read }.map(\.name))
                            }
                            Button(t("Todas", "All")) { tools[candidate.connectionId] = Set(candidate.tools.map(\.name)) }
                        }
                        .controlSize(.small)
                        .accessibilityIdentifier("connections.request-review.presets.\(candidate.connectionId)")
                    }
                    ForEach(candidate.tools, id: \.name) { tool in
                        Toggle(isOn: toolToggle(candidate.connectionId, tool.name)) {
                            toolRow(tool.name, effect: tool.effect, state: tool.enabled ? t("permitida hoje", "allowed today")
                                    : isNative ? t("não escolhida na conexão", "not chosen in the connection") : nil)
                        }
                        .disabled((editor.busy || editor.workflowChainInProgress) || (isNative && !tool.enabled))
                        .accessibilityIdentifier("connections.request-review.tool.\(candidate.connectionId).\(tool.name)")
                    }
                    if candidate.tools.isEmpty {
                        Text(verbatim: t("Esta conexão não tem ferramentas ativas.", "This connection has no active tools.")).font(.callout).foregroundStyle(.secondary)
                    }
                }
            } else {
                ForEach(accounts.filter { chosen.contains($0.id) }) { account in
                    ForEach(account.tools, id: \.name) { tool in
                        Toggle(isOn: toolToggle(account.id, tool.name)) { toolRow(tool.name, effect: tool.effect, state: nil) }
                            .disabled((editor.busy || editor.workflowChainInProgress) || editor.workflowChainInProgress)
                            .accessibilityIdentifier("connections.request-review.tool.\(account.id).\(tool.name)")
                    }
                }
            }
            Text(verbatim: isNative
                 ? t("Cada chamada segue o modo de aprovação do bot. Recusar não desfaz acessos já salvos.",
                     "Each call follows the bot's approval mode. Declining does not undo access already saved.")
                 : t("Só as ferramentas marcadas ficam permitidas para este bot nesta conta; as outras ficam negadas. Cada chamada segue o modo de aprovação do bot. Recusar não desfaz acessos já salvos.",
                     "Only the ticked tools stay allowed for this bot on this account; the others are denied. Each call follows the bot's approval mode. Declining does not undo access already saved."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func toolRow(_ name: String, effect: ConnectionToolEffect, state: String?) -> some View {
        HStack {
            Text(verbatim: name).font(.callout.monospaced())
            Spacer()
            Text(verbatim: (effect == .read ? t("leitura", "read") : t("pode alterar dados", "can change data")) + (state.map { " · " + $0 } ?? ""))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private static func relevant(_ notice: ManagedConnectAppsEditor.Notice) -> Bool {
        switch notice {
        case .accessSaved, .accessUnknown, .accessConflict, .accessRefused, .accessSuperseded, .workflowCompleted, .workflowEnded, .workflowPinsUnavailable,
             .workflowUnknown, .workflowConflict, .workflowRefused, .workflowNotApplied, .workflowNothingGranted, .workflowAccessSavedWithoutContinuation, .workflowListIncomplete: true
        default: false
        }
    }

    @ViewBuilder private var footer: some View {
        HStack {
            if editor.pendingWorkflow?.workflowID == workflowID {
                Button(t("Conferir", "Check")) { Task { await editor.checkWorkflow() } }
                    .disabled((editor.busy || editor.workflowChainInProgress)).accessibilityIdentifier("connections.request-review.check")
            } else if editor.pendingAccess != nil {
                Button(t("Conferir acesso", "Check access")) { Task { await editor.checkAccess() } }
                    .disabled((editor.busy || editor.workflowChainInProgress)).accessibilityIdentifier("connections.request-review.access-check")
            }
            Spacer()
            Button(t("Fechar revisão", "Close review")) { dismiss() }
                .accessibilityIdentifier("connections.request-review.done")
            if let workflow, workflow.state.isOpen, candidates != nil || (!isNative && editor.choicesSupported == false) {
                let ids = chosenInOrder
                let selections = exactSelections
                Button(candidates == nil ? t("Permitir", "Allow") : t("Permitir e continuar", "Allow and continue")) {
                    Task {
                        if candidates == nil, let selections { await editor.allowWithoutContinuation(workflow, selections: selections) }
                        else if let selections { await editor.allowAndContinue(workflow, selections: selections) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(ids.isEmpty || selections == nil || nativeChoiceWithoutTools || (editor.busy || editor.workflowChainInProgress) || !editor.canManageConnections
                          || editor.pendingWorkflow != nil || editor.pendingAccess != nil)
                .accessibilityIdentifier("connections.request-review.allow")
            }
        }
    }
}

#if os(macOS)
/// Chat: the open setup requests of THIS conversation, as compact cards above the composer. The Mac owner's own base
/// only; a paired or demo window shows nothing here. Reads are GETs, refreshed when this conversation's actions change.
struct ConnectionSetupRequestStrip: View {
    let threadID: String?
    /// Changes when this conversation's actions change (a newly approved request may have created a setup request).
    let refreshKey: String
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var holder = ManagedConnectAppsHolder()
    @State private var confirming: ConnectionCatalogEntry?
    @State private var confirmingSetupRequest: String?
    @State private var reviewing: ReviewedSetupRequest?
    @State private var native: NativeTarget?
    private struct NativeTarget: Identifiable { let id: String; let botID: String }

    var body: some View {
        Group {
            if let editor = holder.editor, let threadID {
                let open = editor.openSetupRequests().filter { $0.threadId == threadID }
                if !open.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(open) { workflow in
                            ConnectionSetupRequestCard(workflow: workflow, editor: editor,
                                connect: { confirmingSetupRequest = workflow.id; confirming = $0 },
                                review: { reviewing = ReviewedSetupRequest(id: workflow.id) },
                                openNative: { server, bot in native = NativeTarget(id: server, botID: bot) })
                        }
                        if let notice = editor.notice, !ManagedConnectAppsNoticeCopy.text(notice, locale: locale).isEmpty {
                            Text(verbatim: ManagedConnectAppsNoticeCopy.text(notice, locale: locale))
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.horizontal).padding(.vertical, 4)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat.connection-requests")
                }
            }
        }
        .task(id: model.filesScope + "|" + refreshKey) {
            guard !model.isFixture, !model.showsPairedBase, let threadID, let editor = holder.ensure(model) else { return }
            // GET of the requests first; status, catalog and accounts only when this conversation has an open one.
            await editor.loadSetupRequests()
            let open = editor.openSetupRequests().filter { $0.threadId == threadID }
            guard !open.isEmpty else { return }
            await editor.reload()
            if open.contains(where: { if case .nativeMCP = $0.target { true } else { false } }) { await editor.loadNativeInventory() }
        }
        .onDisappear { holder.close() }
        .sheet(item: $reviewing) { item in
            if let editor = holder.editor { ConnectionSetupRequestSheet(workflowID: item.id, editor: editor) }
        }
        .sheet(item: $native, onDismiss: { if let editor = holder.editor { Task { await editor.loadNativeInventory(); await editor.loadSetupRequests() } } }) { item in
            McpConnectionsView(initialBotID: item.botID, initialServerID: item.id)
        }
        .confirmationDialog(Text(verbatim: DexterLocalization.format("Conectar %@?", confirming?.displayName ?? "", locale: locale)),
                            isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button("Abrir a página oficial") {
                guard let entry = confirming, let editor = holder.editor else { return }
                let request = confirmingSetupRequest
                confirming = nil; confirmingSetupRequest = nil
                Task { if let page = await editor.startAuthorization(serviceID: entry.serviceId, setupRequestID: request) { NSWorkspace.shared.open(page) } }
            }
            .accessibilityIdentifier("chat.connection-requests.connect.confirm")
            Button("Cancelar", role: .cancel) { confirming = nil; confirmingSetupRequest = nil }
        } message: {
            Text("O navegador abre a página oficial do serviço. Você entra lá; sua senha não passa pelo Dexter. Conectar não libera a conta para nenhum bot: você escolhe isso depois, nos ajustes de cada bot.")
        }
    }
}

/// "O que falta para configurar": exactly what this base lacks for managed app logins. Explanation only; it starts
/// nothing, stores nothing and asks for no key here.
struct ManagedConnectAppsRequirementsSheet: View {
    let providers: [String]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    private var providerNames: String {
        providers.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("O que falta para Conectar apps").font(.title2.weight(.semibold))
            Text("Esta base respondeu que o serviço de conexões não está configurado. Por isso não há lista de serviços nem botão Conectar: nada é simulado no lugar.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 10) {
                requirement(1, providerNames.isEmpty
                    ? Text("Um serviço de conexões confiável para esta base: o endereço oficial do serviço e a permissão de uso dada pelo dono.")
                    : Text(verbatim: DexterLocalization.format("Um serviço de conexões confiável para esta base (suportado: %@): o endereço oficial do serviço e a permissão de uso dada pelo dono.", providerNames)))
                requirement(2, Text("Um lugar privado da base para a chave desse serviço. A chave nunca fica no app, no chat nem em registros."))
                requirement(3, Text(verbatim: DexterLocalization.text("connections.platform.requirements.delivery", locale: locale)))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.connections.requirements.list")
            Text(verbatim: DexterLocalization.text("connections.platform.requirements.after", locale: locale))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            Text("Até lá, servidores MCP que você já usa continuam em Ajustes › Conexões › Avançado › Conexão personalizada (MCP).")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Fechar") { dismiss() }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("settings.connections.requirements.close")
            }
        }
        .padding(24)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.connections.requirements")
    }

    private func requirement(_ number: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: "\(number).").font(.body.monospacedDigit()).foregroundStyle(.secondary)
            text.fixedSize(horizontal: false, vertical: true)
        }
    }
}

#endif

extension View {
    /// Compact, resizable sheet on the Mac (fits the Settings window); full sheet on iPhone/iPad.
    @ViewBuilder func connectionsSheetFrame() -> some View {
        #if os(macOS)
        frame(minWidth: 440, idealWidth: 540, maxWidth: 720, minHeight: 340, idealHeight: 500, maxHeight: .infinity)
        #else
        self
        #endif
    }
}

/// One private input an MCP server asked during a running action. It shows who asked (bot), for what (the action, its
/// tool and connection), the server's message as untrusted text and the exact fields. Enviar first shows the exact values
/// for this action and revision and needs a second explicit gesture (the host records `approve_exact_input`); Recusar and
/// Cancelar answer without values. One POST; an open outcome offers only Conferir (GET of the same input).
struct McpPrivateInputCard: View {
    let input: McpPrivateInput
    let editor: McpPrivateInputEditor
    /// Display name of the account behind the connection, when the connections list resolves it.
    var accountLabel: String? = nil
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var texts: [String: String] = [:]
    @State private var choices: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var reviewing: RespondMcpPrivateInputInput?
    /// The input revision the owner reviewed; Enviar is refused if the request changed since.
    @State private var reviewedRevision: Int?
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
    private func key(_ form: McpPrivateInputForm, _ field: McpPrivateInputForm.Field) -> String { form.key + "\u{1F}" + field.name }

    private var action: Action? { model.actions(for: input.threadId).first { $0.id == input.actionId } }
    private var botName: String { model.bots.first { $0.id == input.botId }?.name ?? input.botId }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: t("\(botName) · o servidor pede dados para continuar uma ação", "\(botName) · the server asks for data to continue an action"))
                .font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
            facts
            if let forms = input.forms {
                if let reviewing {
                    review(reviewing)
                } else {
                    ForEach(forms) { form in formView(form) }
                }
            } else {
                Text(verbatim: t("Este pedido usa um formato que o Dexter não aceita aqui (só formulários simples, sem senhas, links ou arquivos). Você pode recusar ou cancelar.",
                                 "This request uses a format Dexter does not accept here (simple forms only, no passwords, links or files). You can decline or cancel."))
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            buttons(forms: input.forms)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.private-input.\(input.id)")
        .onChange(of: input) { _, _ in
            reviewing = nil; reviewedRevision = nil
            texts = [:]; choices = [:]; flags = [:]
        }
    }

    /// The fixed context of the answer: action, tool, connection/account, revision and deadline; full request on demand.
    @ViewBuilder private var facts: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let action {
                let presentation = ApprovalPresentation(action: action)
                Text(verbatim: t("Ação: ", "Action: ") + presentation.title + (presentation.mcpToolName.map { " · " + $0 } ?? ""))
            } else {
                Text(verbatim: t("Ação: ", "Action: ") + input.actionId)
            }
            Text(verbatim: t("Conexão: ", "Connection: ") + (accountLabel.map { "\($0) · " } ?? "") + input.connectionId)
            Text(verbatim: t("Pedido \(input.revision) · expira \(Date(timeIntervalSince1970: TimeInterval(input.expiresAt) / 1_000).formatted(date: .omitted, time: .shortened))",
                             "Request \(input.revision) · expires \(Date(timeIntervalSince1970: TimeInterval(input.expiresAt) / 1_000).formatted(date: .omitted, time: .shortened))"))
        }
        .font(.caption).foregroundStyle(.secondary)
        if let action {
            DisclosureGroup(t("Pedido original", "Original request")) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(ApprovalPresentation(action: action).summaryFields) { field in
                        LabeledContent(field.label) { Text(verbatim: field.value).font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    Text(verbatim: action.requestHash).font(.caption2.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                .font(.caption)
            }
            .font(.caption)
            .accessibilityIdentifier("mcp.private-input.\(input.id).original")
        }
    }

    @ViewBuilder private func formView(_ form: McpPrivateInputForm) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: t("Mensagem do servidor (não verificada)", "Server message (not verified)")).font(.caption2).foregroundStyle(.secondary)
                Text(verbatim: form.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
            ForEach(form.fields) { field in fieldView(form, field) }
        }
    }

    @ViewBuilder private func fieldView(_ form: McpPrivateInputForm, _ field: McpPrivateInputForm.Field) -> some View {
        let id = key(form, field)
        let label = (field.title ?? field.name) + (field.required ? " *" : "")
        VStack(alignment: .leading, spacing: 2) {
            switch field.kind {
            case .text, .number:
                TextField(label, text: Binding(get: { texts[id] ?? "" }, set: { texts[id] = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("mcp.private-input.\(input.id).field.\(field.name)")
            case .choice(let options, let names):
                Picker(label, selection: Binding<Int?>(get: {
                    guard let chosen = choices[id] else { return nil }
                    return options.firstIndex { $0.utf8.elementsEqual(chosen.utf8) }
                }, set: { index in
                    choices[id] = index.flatMap { options.indices.contains($0) ? options[$0] : nil }
                })) {
                    Text(verbatim: t("Escolha…", "Choose…")).tag(nil as Int?)
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                        let title = names?[index] ?? option
                        Text(verbatim: title.isEmpty ? "\"\"" : title).tag(Optional(index))
                    }
                }
                .accessibilityIdentifier("mcp.private-input.\(input.id).field.\(field.name)")
            case .boolean:
                Toggle(label, isOn: Binding(get: { flags[id] ?? false }, set: { flags[id] = $0 }))
                    .accessibilityIdentifier("mcp.private-input.\(input.id).field.\(field.name)")
            }
            if let description = field.description {
                Text(verbatim: description).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Raw values per form, as typed; the form validates them before anything can be reviewed.
    private func answer(_ forms: [McpPrivateInputForm]) -> McpPrivateInputAnswer {
        var contents: [String: [String: JSONValue]] = [:]
        for form in forms {
            var content: [String: JSONValue] = [:]
            for field in form.fields {
                let id = key(form, field)
                switch field.kind {
                case .text:
                    if let text = texts[id] { content[field.name] = .string(text) }
                case .number(let integer, _, _):
                    let text = (texts[id] ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
                    if text.isEmpty { break }
                    if integer, let value = Int64(text) { content[field.name] = .integer(value) }
                    else if !integer, let value = Double(text), value.isFinite { content[field.name] = .number(value) }
                    else { content[field.name] = .string(text) } // refused by the form: never coerced
                case .choice:
                    if let choice = choices[id] { content[field.name] = .string(choice) }
                case .boolean:
                    if let flag = flags[id] { content[field.name] = .bool(flag) } else if field.required { content[field.name] = .bool(false) }
                }
            }
            contents[form.key] = content
        }
        return .accept(contents)
    }

    /// Local validation and the exact values for the review; the editor builds the request it sends (with the host id and
    /// a new request id) from the same answer, for the same revision.
    private func reviewRequest(_ forms: [McpPrivateInputForm]) -> RespondMcpPrivateInputInput? {
        RespondMcpPrivateInputInput(input: input, hostID: "review", answer: answer(forms))
    }

    @ViewBuilder private func review(_ request: RespondMcpPrivateInputInput) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: t("Conferir antes de enviar", "Check before sending")).font(.callout.weight(.semibold))
            ForEach(Array(request.acceptedValues.enumerated()), id: \.offset) { _, item in
                LabeledContent(item.field) { Text(verbatim: Self.display(item.value)).textSelection(.enabled) }
                    .font(.callout)
            }
            Text(verbatim: t("Estes valores vão só para esta ação, nesta conexão e neste pedido (\(input.revision)). Não liberam outra conta, destino ou ferramenta.",
                             "These values go only to this action, on this connection and this request (\(input.revision)). They grant no other account, destination or tool."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.private-input.\(input.id).review")
    }

    static func display(_ value: JSONValue) -> String {
        switch value {
        case .string(let text): text.isEmpty ? "\"\"" : text
        case .bool(let flag): flag ? "true" : "false"
        case .integer(let number): String(number)
        case .number(let number): String(number)
        default: "—"
        }
    }

    @ViewBuilder private func buttons(forms: [McpPrivateInputForm]?) -> some View {
        let blocked = editor.busy || editor.pending != nil || !editor.canAnswer
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { buttonRow(forms: forms, blocked: blocked) }
            VStack(alignment: .leading, spacing: 6) { buttonRow(forms: forms, blocked: blocked) }
        }
        if !editor.canAnswer {
            Text(verbatim: t("Este app pode ver, mas não responder: falta a permissão \"Responder pedidos de servidores MCP\".",
                             "This app can see but not answer: it lacks the \"Answer MCP server requests\" permission."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private func buttonRow(forms: [McpPrivateInputForm]?, blocked: Bool) -> some View {
        if editor.pending?.inputID != input.id, let forms {
            if reviewing != nil {
                Button(t("Voltar", "Back")) { reviewing = nil; reviewedRevision = nil }
                    .accessibilityIdentifier("mcp.private-input.\(input.id).back")
                Button(t("Enviar estes valores", "Send these values")) {
                    let exactAnswer = answer(forms)
                    Task {
                        if await editor.respond(input, answer: exactAnswer) { reviewing = nil; reviewedRevision = nil }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(blocked || reviewedRevision != input.revision)
                .accessibilityIdentifier("mcp.private-input.\(input.id).send")
            } else {
                Button(t("Revisar e enviar…", "Review and send…")) { reviewing = reviewRequest(forms); reviewedRevision = input.revision }
                    .buttonStyle(.borderedProminent)
                    .disabled(blocked || reviewRequest(forms) == nil)
                    .accessibilityIdentifier("mcp.private-input.\(input.id).review-button")
            }
        }
        Button(t("Recusar", "Decline")) {
            Task { if await editor.respond(input, answer: .decline) { reviewing = nil; reviewedRevision = nil } }
        }
            .disabled(blocked)
            .accessibilityIdentifier("mcp.private-input.\(input.id).decline")
        Button(t("Cancelar etapa", "Cancel step")) {
            Task { if await editor.respond(input, answer: .cancel) { reviewing = nil; reviewedRevision = nil } }
        }
            .disabled(blocked)
            .help(Text(verbatim: t("Responde ao servidor que você cancelou este pedido. Não desfaz o que a ação já fez.",
                                   "Tells the server you cancelled this request. It does not undo what the action already did.")))
            .accessibilityIdentifier("mcp.private-input.\(input.id).cancel")
    }
}

/// Plain words for private-input notices.
enum McpPrivateInputNoticeCopy {
    static func text(_ notice: McpPrivateInputEditor.Notice, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        switch notice {
        case .loadFailed: return t("Não foi possível ler os pedidos dos servidores MCP.", "The MCP servers' requests could not be read.")
        case .unavailable: return t("Esta base não oferece pedidos privados de MCP.", "This host does not offer private MCP requests.")
        case .hostChanged: return t("A base mudou. Reabra para ver os pedidos atuais.", "The host changed. Reopen to see the current requests.")
        case .answered(let state):
            switch state {
            case .answered: return t("Resposta enviada. A ação continua na base.", "Answer sent. The action continues on the host.")
            case .declined: return t("Pedido recusado. A ação segue sem esses dados.", "Request declined. The action continues without that data.")
            case .cancelled: return t("Etapa cancelada. O que a ação já fez não é desfeito.", "Step cancelled. What the action already did is not undone.")
            default: return t("A base registrou o pedido como encerrado.", "The host recorded the request as ended.")
            }
        case .unknown: return t("Não foi possível confirmar a resposta. Use Conferir; nada foi reenviado.", "The answer could not be confirmed. Use Check; nothing was sent again.")
        case .notApplied: return t("A base mostra o pedido ainda aberto: nada foi enviado. Você pode responder de novo.", "The host shows the request still open: nothing was sent. You can answer again.")
        case .ended(let state): return state == .expired ? t("O pedido expirou antes da resposta.", "The request expired before the answer.")
            : t("O pedido já foi encerrado de outra forma.", "The request was already ended another way.")
        case .conflict: return t("O pedido mudou ou a ação parou. Os dados foram relidos; nada foi enviado.", "The request changed or the action stopped. It was read again; nothing was sent.")
        case .refused: return t("A base recusou esta resposta.", "The host refused this answer.")
        case .invalidAnswer: return t("Confira os campos: algum valor não segue o formulário. Nada foi enviado.", "Check the fields: a value does not follow the form. Nothing was sent.")
        }
    }
}

/// Chat (one conversation) or Conexões / the native manager (every conversation): pending private inputs, read again
/// every few seconds while `active` (a running action exists or the owner is looking). GET only.
struct McpPrivateInputSummaryList: View {
    let editor: McpPrivateInputEditor
    var threadID: String? = nil
    @Environment(\.locale) private var locale
    var body: some View {
        VStack(alignment:.leading,spacing:6) {
            // The return/refresh controls cannot depend on a matching summary in this lexical page.
            if editor.hasListNavigation {
                Text("Pendentes ativos: \(editor.activeRequestCount) · Histórico retido: \(editor.retainedRequestCount)")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Resumos sem campos. Abra um formulário para carregar e revisar seus valores. As páginas podem mudar; atualize para ver novos pedidos.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                HStack {
                    Button { Task { await editor.showHistory(!editor.showingHistory) } } label: {
                        if editor.showingHistory { Text("Ver pendentes ativos") } else { Text("Ver histórico retido") }
                    }
                        .accessibilityIdentifier("mcp.private-inputs.history")
                    Button("Atualizar formulários") { Task { await editor.load() } }
                        .accessibilityIdentifier("mcp.private-inputs.refresh")
                }.disabled(editor.busy || editor.listBusy)
            }
            // Reconciliation outlives the open card, expiry, metadata windows and the active host wait.
            if let pending = editor.pending {
                HStack {
                    VStack(alignment: .leading) {
                        Text(verbatim: DexterLocalization.text("Conversa", locale: locale) + ": " + pending.threadID)
                        Text(verbatim: (locale.language.languageCode?.identifier == "pt" ? "Ação: " : "Action: ") + pending.actionID)
                        Text(verbatim: (locale.language.languageCode?.identifier == "pt" ? "Conexão: " : "Connection: ") + pending.connectionID)
                        Text(verbatim: pending.inputID)
                    }.font(.caption)
                    Button(DexterLocalization.text("Conferir", locale: locale)) { Task { await editor.check() } }
                        .disabled(editor.busy || !editor.canRead)
                        .accessibilityIdentifier("mcp.private-input.\(pending.inputID).check")
                }
            }
            ForEach(editor.visibleSummaries(threadID:threadID)) { summary in
                HStack {
                    VStack(alignment:.leading) {
                        Text(summary.connectionId + " · " + summary.id).font(.caption).lineLimit(2)
                        Text(summary.state.rawValue).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if summary.state == .pending {
                        Button("Abrir formulário") { Task { await editor.open(summary) } }
                            .disabled(editor.busy).accessibilityIdentifier("mcp.private-inputs.open." + summary.id)
                    }
                }
            }
            if editor.nextCursor != nil {
                Button("Carregar mais resumos") { Task { await editor.more() } }
                    .disabled(editor.busy || editor.listBusy).accessibilityIdentifier("mcp.private-inputs.more")
            }
        }.accessibilityIdentifier("mcp.private-inputs.summaries")
    }
}

struct McpPrivateInputStrip: View {
    enum Scope: Equatable { case thread(String), all, none }
    let scope: Scope
    /// True while there is something to wait for: the inputs are read every few seconds (GET only).
    let active: Bool
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var editor: McpPrivateInputEditor?

    var body: some View {
        Group {
            if let editor, scope != .none {
                let open: [McpPrivateInput] = { if case .thread(let id) = scope { editor.open(threadID: id) } else { editor.open() } }()
                let threadID: String? = { if case .thread(let id) = scope { id } else { nil } }()
                if editor.hasVisibleContent(threadID: threadID) {
                    VStack(alignment: .leading, spacing: 6) {
                        if editor.listIncomplete {
                            Text("A lista de formulários está incompleta; pedidos inválidos ou em quarentena não podem ser respondidos.")
                                .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("chat.mcp-private-inputs.incomplete")
                            Text("Envelopes inválidos nesta página: \(editor.invalidRequestCount) · Quarentena na base: \(editor.quarantinedRequestCount) · Histórico fora desta página: \(editor.omittedRequestCount)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        McpPrivateInputSummaryList(editor:editor,threadID:threadID)
                        ForEach(open) { input in McpPrivateInputCard(input: input, editor: editor) }
                        if let notice = editor.notice {
                            Text(verbatim: McpPrivateInputNoticeCopy.text(notice, portuguese: locale.language.languageCode?.identifier == "pt"))
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("chat.mcp-private-inputs.notice")
                        }
                    }
                    .padding(.horizontal).padding(.vertical, 4)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat.mcp-private-inputs")
                }
            }
        }
        .task(id: model.connectionsScope + "|" + String(active)) {
            if editor?.scope != model.connectionsScope { editor?.close(); editor = model.makeMcpPrivateInputEditor() }
            guard let editor, scope != .none else { return }
            await editor.poll()
            while active, !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await editor.poll()
            }
        }
        .onDisappear { editor?.close(); editor = nil }
    }
}

/// A paired base's connections, by its owner-granted scopes: the accounts and native connections (read), requests from
/// bots and private MCP inputs, and only the changes the base allows remotely (managed sign-in through the provider page,
/// bot access, label, disconnect, complete/decline requests, answer inputs). Credentials, keys and native sign-in stay on
/// the owner's Mac. When the base is offline the last read stays visible, marked, with every change refused.
struct RemoteConnectionsContent: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.openURL) private var openURL
    @State private var holder = ManagedConnectAppsHolder()
    @State private var inputs: McpPrivateInputEditor?
    @State private var inspecting: InspectedAccount?
    @State private var reviewing: ReviewedSetupRequest?
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    var body: some View {
        Group {
            if let access = model.pairedConnectionsAccess {
                if !access.read && !access.mcpRead {
                    Text(verbatim: t("Este app não tem permissão para ver as conexões desta base. Para incluir, o dono pareia de novo marcando \"Ver conexões e pedidos dos bots\".",
                                     "This app has no permission to see this host's connections. To add it, the owner pairs again with \"See connections and bot requests\"."))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("connections.remote.no-scope")
                } else if let editor = holder.editor, editor.scope == model.connectionsScope {
                    content(editor, access: access)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .task(id: model.connectionsScope) {
            guard model.pairedConnectionsAccess != nil else { return }
            await holder.open(model)
            if inputs?.scope != model.connectionsScope { inputs?.close(); inputs = model.makeMcpPrivateInputEditor() }
            await inputs?.load()
        }
        .onDisappear { holder.close(); inputs?.close(); inputs = nil }
        .sheet(item: $inspecting) { item in
            if let editor = holder.editor {
                ConnectionAccountInspector(accountID: item.id, editor: editor) { account in
                    inspecting = nil
                    Task { if let page = await editor.reconnect(account) { openURL(page) } }
                }
            }
        }
        .sheet(item: $reviewing) { item in
            if let editor = holder.editor { ConnectionSetupRequestSheet(workflowID: item.id, editor: editor) }
        }
    }

    @ViewBuilder private func content(_ editor: ManagedConnectAppsEditor, access: (read: Bool, manage: Bool, mcpRead: Bool, mcpManage: Bool)) -> some View {
        if !editor.reachable, let last = editor.lastReadAt {
            Label(t("Base offline · última leitura \(last.formatted(date: .omitted, time: .shortened)). Nada pode ser alterado agora.",
                    "Host offline · last read \(last.formatted(date: .omitted, time: .shortened)). Nothing can be changed now."), systemImage: "wifi.slash")
                .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("connections.remote.offline")
        }
        if !access.manage {
            Text(verbatim: t("Só leitura: este app não tem a permissão \"Conectar contas e mudar acessos\".",
                             "Read-only: this app lacks the \"Connect accounts and change access\" permission."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(editor.openSetupRequests()) { workflow in
            ConnectionSetupRequestCard(workflow: workflow, editor: editor,
                connect: { entry in Task { if let page = await editor.startAuthorization(serviceID: entry.serviceId, setupRequestID: workflow.id) { openURL(page) } } },
                review: { reviewing = ReviewedSetupRequest(id: workflow.id) },
                openNative: { _, _ in })
        }
        if let inputs {
            if inputs.listIncomplete {
                Text("A lista de formulários está incompleta; pedidos inválidos ou em quarentena não podem ser respondidos.")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("mcp.private-inputs.incomplete")
                Text("Envelopes inválidos nesta página: \(inputs.invalidRequestCount) · Quarentena na base: \(inputs.quarantinedRequestCount) · Histórico fora desta página: \(inputs.omittedRequestCount)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            McpPrivateInputSummaryList(editor:inputs)
            ForEach(inputs.open()) { input in
                McpPrivateInputCard(input: input, editor: inputs,
                                    accountLabel: editor.account(forConnection: input.connectionId).map { $0.label })
            }
            if let notice = inputs.notice {
                Text(verbatim: McpPrivateInputNoticeCopy.text(notice, portuguese: portuguese)).font(.caption).foregroundStyle(.secondary)
            }
        }
        if editor.pendingAuthorization != nil || editor.resumedAuthorizationID != nil {
            HStack {
                Text(verbatim: DexterLocalization.text(ManagedConnectAppsPresentation.authorizationKey(editor.authorization?.state ?? .unknown), locale: locale))
                    .font(.callout)
                Spacer()
                if let page = editor.authorization?.authorizationPage, editor.authorization?.linkAvailable == true {
                    Button(t("Abrir de novo", "Open again")) { openURL(page) }
                        .accessibilityIdentifier("connections.remote.authorization.reopen")
                }
                Button(t("Conferir", "Check")) { Task { await editor.checkAuthorization() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("connections.remote.authorization.check")
            }
        }
        if let notice = editor.notice, !ManagedConnectAppsNoticeCopy.text(notice, locale: locale).isEmpty {
            Text(verbatim: ManagedConnectAppsNoticeCopy.text(notice, locale: locale))
                .font(.callout).foregroundStyle(ManagedConnectAppsNoticeCopy.isCalm(notice) ? Color.secondary : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("connections.remote.notice")
        }
        ForEach(editor.managedAccounts) { account in
            let facts = ConnectionsPresentation.managed(account, accessUnconfirmed: editor.pendingAccess?.accountID == account.id,
                                                        disconnectUnconfirmed: editor.pendingDisconnect?.accountID == account.id, portuguese: portuguese)
            Button { inspecting = InspectedAccount(id: account.id) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: account.label == account.displayName ? account.displayName : "\(account.label) · \(account.displayName)")
                        .font(.body.weight(.medium))
                    Text(verbatim: ManagedConnectAppsPresentation.identityLine(account.identity, portuguese: portuguese))
                        .font(.caption).foregroundStyle(.secondary)
                    ConnectionFactsView(facts: facts, compact: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("connections.remote.account.\(account.id)")
        }
        if let servers = editor.nativeServers {
            ForEach(servers) { server in
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: server.name).font(.body.weight(.medium))
                    Text(verbatim: ConnectionsPresentation.executorLine(server.executor, runsOn: server.runsOn, portuguese: portuguese)
                         + t(" · login e ferramentas são geridos no Mac dono", " · sign-in and tools are managed on the owner's Mac"))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    ConnectionFactsView(facts: ConnectionsPresentation.native(server: server, credentials: editor.nativeCredentials[server.id], portuguese: portuguese),
                                        compact: true)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("connections.remote.native.\(server.id)")
            }
        }
        if editor.managedAccounts.isEmpty && (editor.nativeServers ?? []).isEmpty && editor.lastReadAt != nil {
            Text(verbatim: t("Nenhuma conta nesta base.", "No accounts on this host.")).font(.callout).foregroundStyle(.secondary)
        }
        Button(t("Atualizar", "Refresh")) {
            Task { await editor.reload(); await editor.loadSetupRequests(); await editor.loadNativeInventory(); await inputs?.load() }
        }
        .disabled(editor.busy)
        .accessibilityIdentifier("connections.remote.refresh")
        Text(verbatim: t("Senhas, chaves e logins de MCP local ficam no Mac dono da base; daqui nada disso é pedido.",
                         "Passwords, keys and local MCP sign-ins stay on the host owner's Mac; none of that is asked here."))
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

/// iPhone/iPad Ajustes: the paired base's connections (only when this app is paired).
struct RemoteConnectionsSection: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale

    var body: some View {
        if model.connectionsArePaired {
            Section {
                RemoteConnectionsContent()
            } header: {
                Text(verbatim: locale.language.languageCode?.identifier == "pt" ? "Conexões desta base" : "This host's connections")
                    .accessibilityIdentifier("connections.remote")
            }
        }
    }
}
