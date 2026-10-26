#if os(macOS)
import AppKit
import CryptoKit
import DexterAppCore
import DexterHostClient
import Observation
import SwiftUI

/// Display helpers for MCP connection instances. Names and IDs come from the host registry; nothing here
/// identifies or verifies the account a connection uses.
enum McpInstanceLabel {
    /// A short form that still distinguishes generated IDs ("http-8640a1…9628"); short IDs are shown whole.
    static func short(_ id: String) -> String { id.count <= 18 ? id : String(id.prefix(10)) + "…" + String(id.suffix(4)) }
    /// Falls back to the full ID whenever the short form would be ambiguous in this list.
    static func short(_ id: String, among ids: [String]) -> String {
        let candidate = short(id)
        return ids.contains { $0 != id && short($0) == candidate } ? id : candidate
    }
    static func duplicateWarnings(for server: McpServerSummary, among servers: [McpServerSummary]) -> [String] {
        let ids = servers.map(\.id), others = servers.filter { $0.id != server.id }
        let describe: (McpServerSummary) -> String = { "\($0.name) (\(short($0.id, among: ids)))" }
        var warnings: [String] = []
        let sameAddress = others.filter { $0.destination == server.destination }
        if !sameAddress.isEmpty {
            let list = sameAddress.map(describe).joined(separator: ", ")
            warnings.append(String(localized: "Mesmo endereço de \(list). São conexões independentes; o Dexter não sabe qual conta cada uma usa."))
        }
        let sameName = others.filter { $0.name == server.name && $0.destination != server.destination }
        if !sameName.isEmpty {
            let list = sameName.map(describe).joined(separator: ", ")
            warnings.append(String(localized: "Mesmo nome de \(list). Confira o ID antes de escolher."))
        }
        return warnings
    }
    static func status(_ status: String) -> String {
        switch status {
        case "ready": String(localized: "Ferramentas descobertas")
        case "needs_auth": String(localized: "Login necessário")
        case "unavailable_here": String(localized: "Disponível em outro host")
        case "failed": String(localized: "Descoberta não concluída")
        default: String(localized: "Registrado")
        }
    }
    static func credential(_ state: String) -> String {
        switch state {
        case "not_required": String(localized: "Não exigido")
        case "unlocked": String(localized: "Disponível")
        case "locked": String(localized: "Bloqueado")
        case "expired": String(localized: "Expirado")
        case "unauthorized": String(localized: "Login necessário")
        case "authorizing": String(localized: "Aguardando login")
        case "unavailable": String(localized: "Indisponível neste host")
        default: String(localized: "Pendente")
        }
    }
}

/// Name and address of a registration intention, read from its original definition for the simple flow.
/// Request, receipt and generation identifiers stay under Detalhes técnicos.
struct McpRegistrationSummary: Equatable {
    let serverID: String
    let name: String
    /// The HTTP endpoint; nil for a local process.
    let address: String?

    init?(_ request: McpRegistrationRequest?) {
        guard let request, case .object(let definition) = request.definition, case .string(let name) = definition["name"] else { return nil }
        serverID = request.serverID; self.name = name
        if case .object(let transport) = definition["transport"], case .string(let url) = transport["url"] { address = url } else { address = nil }
    }
}

/// Prefill for registering a connection again with a login type, after the service asked for one.
struct McpReregistration: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let url: String
    let previousID: String
}

@MainActor @Observable
private final class McpConnectionsState {
    let client: HostClient
    var servers: [McpServerSummary] = []
    var selectedID: String?
    var tools: [McpToolSummary] = []
    var botID = ""
    var selectedTools: Set<String> = []
    var savedTools: Set<String> = []
    /// The owner/base registration intention retained by the model: closing this sheet never discards it, and a
    /// sent request is only read again (never resent). Nil when this base cannot confirm registrations.
    var registration: McpRegistrationSession?
    var preview: McpImportPreview?
    var busy = false
    var needsRefresh = false
    var notice: String?
    var credentials: McpCredentialStatus?
    /// Review state of a local process' executable/arguments (GET only); nil when not read or not reported.
    var commandStatus: McpCommandStatus?
    var commandStatusRead = false
    var authorization: McpOAuthAuthorization?
    var authorizationRequest: McpAuthorizationPresentation?
    var launchSession: McpOAuthLaunchSession?
    var handoffClaimed = false
    var oauthPersistence: ConnectionPersistence?
    var oauthPersistenceConnected = false
    var oauthClientID = ""
    var oauthScope = ""
    /// UI emphasis only: after OAuth is observed, "Descobrir ferramentas…" is highlighted. Nothing is sent.
    var highlightDiscover = false
    /// The owner's explicit "read the tools once after signing in" for this HTTP connection (never armed by approval alone).
    var discoveryPlan: McpConsentedDiscoveryPlan?
    @ObservationIgnored private var closed = false
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let authorizationIsCurrent: @MainActor (McpAuthorizationPresentation) -> Bool
    @ObservationIgnored private let authorizationContextIsCurrent: @MainActor (McpAuthorizationPresentation) -> Bool
    @ObservationIgnored private let claimAuthorization: @MainActor (McpAuthorizationPresentation) -> Bool
    @ObservationIgnored private let hostID: String?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var requestGeneration = UUID()

    init(client: HostClient, hostID: String?, isCurrent: @escaping @MainActor () -> Bool,
         authorizationIsCurrent: @escaping @MainActor (McpAuthorizationPresentation) -> Bool,
         authorizationContextIsCurrent: @escaping @MainActor (McpAuthorizationPresentation) -> Bool,
         claimAuthorization: @escaping @MainActor (McpAuthorizationPresentation) -> Bool) {
        self.client = client; self.isCurrent = isCurrent; self.authorizationIsCurrent = authorizationIsCurrent
        self.claimAuthorization = claimAuthorization; self.authorizationContextIsCurrent = authorizationContextIsCurrent; self.hostID = hostID
    }
    private func check(_ token: UUID? = nil) throws {
        guard !closed, isCurrent(), !Task.isCancelled, (token ?? requestGeneration) == generation else { throw CancellationError() }
    }
    var selectedServer: McpServerSummary? { servers.first { $0.id == selectedID } }

    var canRead: Bool { !closed && isCurrent() }
    /// This window's own reads/writes or the retained registration are in flight.
    var working: Bool { busy || registration?.busy == true }
    /// A sent intention whose outcome is still open: only Conferir estado (a read by the original request) is offered.
    var registrationNeedsCheck: Bool { registration?.requiresReconciliation == true }
    var registrationSummary: McpRegistrationSummary? { McpRegistrationSummary(registration?.request) }
    /// A new reviewed registration may start: this base confirms registrations and no intention is open or unsent.
    var canStartRegistration: Bool {
        guard let registration, registration.scopeMatches, canRead, !working, !needsRefresh else { return false }
        return !registration.requiresReconciliation && registration.state != .prepared
    }
    /// Consultas guardadas: requests whose check the owner left for later, read-only values in deferral order.
    var deferred: [McpDeferredRegistration] { registration?.deferredRegistrations ?? [] }
    /// IDs the list may already show as Registrado while their own request is open. Context only, never a confirmation.
    var unconfirmedServerIDs: Set<String> {
        McpRegistrationLifecyclePresentation.unconfirmedServerIDs(
            openRequest: registrationNeedsCheck ? registration?.request : nil, deferred: deferred)
    }
    /// The open request left for later with this connection ID: a new registration of that ID waits for it.
    func unresolvedDeferred(serverID: String) -> McpDeferredRegistration? {
        guard registration?.hasUnresolvedDeferred(serverID: serverID) == true else { return nil }
        return deferred.last { $0.isUnresolved && $0.request.serverID == serverID }
    }
    func close() { closed = true; generation = UUID(); launchSession?.invalidate(); discoveryPlan?.invalidate(.closed); client.close() }
    func invalidateScope() {
        registration?.invalidateIfScopeChanged()
        close(); needsRefresh = true
        notice = String(localized: "A base ou o contexto do bot mudou. Feche e reabra as conexões para usar o novo contexto. Um cadastro não confirmado continua guardado enquanto o app estiver aberto.")
    }
    /// Owner/online facts changed without a new address: the retained session latches its own scope here, from a
    /// change hook, so reading `scopeMatches` while rendering stays free of writes.
    func latchRegistrationScope() { registration?.invalidateIfScopeChanged() }

    func refresh() async {
        // The retained intention is read first, by its original request; the inventory never confirms a registration.
        if let registration, registration.scopeMatches, registration.requiresReconciliation, canRead, !busy {
            await registration.reconcile()
        }
        await perform {
            let servers = try await self.client.mcpServers(); try self.check()
            self.servers = servers
            if !servers.contains(where: { $0.id == self.selectedID }) { self.selectedID = nil }
            try await self.loadDetail()
            self.needsRefresh = false
        }
    }

    func selectServer(_ id: String?) async {
        guard !busy else { return }
        launchSession?.invalidate(); launchSession = nil; handoffClaimed = false; discoveryPlan?.invalidate(); discoveryPlan = nil
        generation = UUID(); selectedID = id; highlightDiscover = false
        await perform { try await self.loadDetail() }
    }

    func selectBot(_ id: String) async {
        guard !busy else { return }
        launchSession?.invalidate(); launchSession = nil; handoffClaimed = false; discoveryPlan?.invalidate(); discoveryPlan = nil
        generation = UUID(); botID = id
        selectedTools = []; savedTools = []
        await perform { try await self.loadSelection() }
    }

    private func loadDetail() async throws {
        tools = []; selectedTools = []; savedTools = []; credentials = nil; authorization = nil; commandStatus = nil; commandStatusRead = false
        oauthPersistence = nil; oauthPersistenceConnected = false
        if launchSession == nil { oauthClientID = ""; oauthScope = "" }
        guard let id = selectedID else { return }
        let status = try await client.mcpCredentials(serverID: id); try check()
        guard selectedID == id, status.serverId == id else { throw HostClientError.contractMismatch }
        credentials = status
        launchSession?.reconcileForManualRetry(status)
        if !status.isReady { authorization = launchSession?.authorization }
        if status.auth == "oauth" {
            let accounts = try? await client.connectionAccounts(); try check()
            if let accounts, accounts.hostId == hostID,
               let account = accounts.items.first(where: { $0.manage == .nativeMCP && $0.nativeServerId == id && $0.hostId == hostID }) {
                oauthPersistence = account.persistence
                oauthPersistenceConnected = account.status == .connected && status.isReady
            }
        }
        if selectedServer?.transport == "stdio" {
            // A read of the review only: it never starts or re-pins the process. Unreported stays unknown.
            commandStatus = try? await client.mcpCommandStatus(serverID: id); try check()
            commandStatusRead = true
        }
        let result = try await client.mcpTools(serverID: id); try check()
        guard selectedID == id else { throw CancellationError() }
        tools = result
        try await loadSelection()
    }

    private func loadSelection() async throws {
        guard let id = selectedID, !botID.isEmpty else { return }
        let bot = botID
        let selection = try await client.mcpSelection(serverID: id, botID: bot); try check()
        guard selectedID == id, botID == bot, selection.botId == bot, selection.policy == "ask" else { throw HostClientError.contractMismatch }
        selectedTools = Set(selection.toolIds); savedTools = selectedTools
    }

    func previewImport(format: String, content: String) async {
        preview = nil
        await perform {
            let result = try await self.client.previewMcpImport(format: format, content: content)
            try self.check()
            self.preview = result
        }
    }

    /// Adicionar (import preview): the reviewed definition, with the chosen executable, becomes one manual registration.
    func add(_ imported: McpImportedServer, executable: URL? = nil) async {
        guard let registration, canStartRegistration, var draft = imported.draft else { return }
        if let executable, case .object(var definition) = draft,
           case .object(var transport) = definition["transport"],
           transport["type"] == .string("stdio") {
            transport["command"] = .string(executable.path)
            transport["searchPath"] = .array(Array(Set([executable.deletingLastPathComponent().path, "/usr/bin", "/bin"])).sorted().map(JSONValue.string))
            definition["transport"] = .object(transport)
            draft = .object(definition)
        }
        do { try registration.beginReviewedImport(definition: draft) }
        catch let error as McpRegistrationLifecycleError { notice = McpRegistrationLifecyclePresentation.notice(for: error); return }
        catch { notice = String(localized: "O Dexter não aceitou esta definição para cadastro. Confira o comando e os campos; nada foi enviado."); return }
        await submit(registration)
    }

    /// Registrar endereço: one reviewed intention, one POST. Afterwards the same request is only read.
    func addHTTP(_ draft: McpHttpDraft) async {
        guard let registration, canStartRegistration else { return }
        do { try registration.begin(httpDraft: draft) }
        catch let error as McpRegistrationLifecycleError { notice = McpRegistrationLifecyclePresentation.notice(for: error); return }
        catch { notice = String(localized: "O Dexter não aceitou este endereço para cadastro. Confira os campos; nada foi enviado."); return }
        await submit(registration)
    }

    /// Editar campos (prepared): drops only a prepared request that never left the app. Nothing is sent, cancelled or undone at the
    /// base; the edited form is a new intention that must be reviewed and registered again.
    func discardPrepared() -> Bool {
        guard let registration, canRead else { return false }
        registration.invalidateIfScopeChanged()
        do { try registration.discardPrepared(); notice = nil; return true }
        catch { notice = McpRegistrationLifecyclePresentation.notice(for: error); return false }
    }

    /// Deixar consulta para depois (after the owner confirms): the open request moves to Consultas guardadas. It is not
    /// cancelled or taken as absent, its connection ID stays blocked until a read closes it, and no request is sent.
    func deferUncertain() -> Bool {
        guard let registration, canRead, !working else { return false }
        registration.invalidateIfScopeChanged()
        do {
            try registration.deferUncertainMonitoring()
            notice = String(localized: "A consulta ficou em Consultas guardadas, na lateral de Conexões MCP. Nada foi cancelado; você já pode cadastrar outro endereço.")
            return true
        } catch { notice = McpRegistrationLifecyclePresentation.notice(for: error); return false }
    }

    /// Conferir este pedido: reads one request left for later by its own original ID. No POST, login, discovery,
    /// selection or grant; the list is read again without moving the selection.
    func checkDeferred(_ requestID: String) async {
        guard let registration, canRead, !working else { return }
        registration.invalidateIfScopeChanged()
        guard registration.scopeMatches else { return }
        notice = nil
        await registration.reconcileDeferred(requestID: requestID)
        await reloadInventory()
    }

    /// The prepared request never left the app (the base could not be checked first): send that same request.
    func submitPrepared() async {
        guard let registration, registration.scopeMatches, canRead, !working,
              registration.state == .prepared, !registration.mutationSent else { return }
        await submit(registration)
    }

    /// Conferir estado: reads the original request by its own ID; nothing is sent again.
    func checkRegistration() async {
        guard let registration, registration.scopeMatches, canRead, !working, registration.mutationSent else { return }
        notice = nil
        await registration.reconcile()
        await reloadAfterRegistration(registration)
    }

    private func submit(_ registration: McpRegistrationSession) async {
        notice = nil
        await registration.submit()
        await reloadAfterRegistration(registration)
    }

    /// Inventory read after an outcome. Only a confirmed `.registered` receipt selects its own instance;
    /// login, discovery and tool selection stay separate steps.
    private func reloadAfterRegistration(_ registration: McpRegistrationSession) async {
        await reloadInventory(selecting: registration.state == .registered ? registration.registration?.receipt.instanceID : nil)
    }

    private func reloadInventory(selecting confirmed: String? = nil) async {
        guard canRead else { return }
        await perform {
            let servers = try await self.client.mcpServers(); try self.check()
            self.servers = servers
            if let confirmed, servers.contains(where: { $0.id == confirmed }) {
                self.selectedID = confirmed; self.highlightDiscover = false
            } else if !servers.contains(where: { $0.id == self.selectedID }) { self.selectedID = nil }
            try await self.loadDetail()
            self.needsRefresh = false
        }
    }

    var setupStep: McpSetupStep? {
        guard let server = selectedServer else { return nil }
        return McpSetupStep.derive(server: server, credentials: credentials, tools: tools, savedToolIDs: savedTools, selectedBotID: botID)
    }

    /// The exact instance a consented read may target: the bot's handoff pin (same server) and the base's summary pin
    /// must agree when both exist; with neither the read cannot be planned.
    var discoveryPinResolution: McpConsentedDiscoveryPlan.PinResolution {
        let request = authorizationRequest.flatMap { $0.handoff.serverId == selectedID ? $0 : nil }
        return McpConsentedDiscoveryPlan.resolvePin(handoff: request?.handoff.instancePin, summary: selectedServer?.instancePin)
    }

    /// Arms the owner's consented read for the selected HTTP connection: this exact instance pin, this window's context and
    /// Stop, 10 minutes. Arming sends nothing; without an agreed pin nothing is armed.
    func armDiscoveryPlan() {
        guard canRead, !busy, !needsRefresh, let server = selectedServer, server.transport != "stdio",
              credentials?.serverId == server.id, credentials?.isReady == false,
              case .pin(let pin) = discoveryPinResolution else { return }
        let request = authorizationRequest.flatMap { $0.handoff.serverId == server.id ? $0 : nil }
        let token = generation, id = server.id
        discoveryPlan = McpConsentedDiscoveryPlan(server: server, instancePin: pin,
            expiresAt: Int64(Date().timeIntervalSince1970 * 1_000) + 600_000,
            isCurrent: { [weak self] in
                guard let self else { return false }
                return self.canRead && self.generation == token && self.selectedID == id && (request.map(self.authorizationContextIsCurrent) ?? true)
            },
            currentPin: { [weak self] in self?.servers.first { $0.id == id }?.instancePin },
            dispatch: { [weak self] pin in
                guard let self else { throw CancellationError() }
                return try await self.client.discoverMcpServer(id: id, expectedInstancePin: pin, httpOnly: true)
            })
    }
    func withdrawDiscoveryPlan() { discoveryPlan?.withdraw() }

    func discover() async {
        guard !needsRefresh, let id = selectedID else { return }
        discoveryPlan?.withdraw()
        await perform(mutation: true) {
            self.highlightDiscover = false
            // Explicit owner discovery: CAS on the instance pin when the base reports it; legacy `{}` otherwise.
            let pin = self.servers.first { $0.id == id }?.instancePin
            let tools = try await self.client.discoverMcpServer(id: id, expectedInstancePin: pin); try self.check()
            let servers = try await self.client.mcpServers()
            try self.check()
            self.tools = tools; self.servers = servers
            self.credentials = try await self.client.mcpCredentials(serverID: id); try self.check()
            guard self.credentials?.serverId == id else { throw HostClientError.contractMismatch }
            try await self.loadSelection()
        }
    }

    func unlock() async {
        guard !needsRefresh, let id = selectedID else { return }
        await credentialAction(id: id) { try await self.client.unlockMcpCredentials(serverID: id) }
    }

    func lock() async {
        guard !needsRefresh, let id = selectedID else { return }
        await credentialAction(id: id) { try await self.client.lockMcpCredentials(serverID: id) }
    }

    func disconnect() async {
        guard !needsRefresh, let id = selectedID else { return }
        await credentialAction(id: id) { try await self.client.disconnectMcpCredentials(serverID: id) }
    }

    private func credentialAction(id: String, _ action: () async throws -> McpCredentialStatus) async {
        await perform(mutation: true, authentication: true) {
            do {
                let result = try await action()
                try self.check(); guard self.selectedID == id else { throw CancellationError() }
                guard result.serverId == id else { throw HostClientError.contractMismatch }
                self.credentials = result; self.authorization = nil
                self.servers = try await self.client.mcpServers(); try self.check()
            } catch {
                // Reconcile public metadata only; never retry an unlock or authorization.
                let metadata = try? await self.client.mcpCredentials(serverID: id)
                try self.check()
                if metadata?.serverId == id { self.credentials = metadata }
                throw error
            }
        }
    }

    var canAuthorize: Bool {
        guard canRead, !working, !needsRefresh, credentials?.auth == "oauth", credentials?.isReady == false,
              credentials?.state != "authorizing" else { return false }
        if let launchSession, launchSession.mutationSent { return launchSession.canMakeManualRetry }
        return !handoffClaimed
    }

    func authorize(automaticHandoff: Bool = false) async {
        guard canRead, !busy, !needsRefresh, let id = selectedID, selectedServer?.auth == "oauth" else { return }
        let request = authorizationRequest.flatMap { $0.handoff.serverId == id && $0.handoff.botId == botID ? $0 : nil }
        let previous = launchSession
        let manualRetry = !automaticHandoff && previous?.canMakeManualRetry == true
        if let request, !manualRetry {
            guard request.handoff.serverId == id, request.handoff.botId == botID,
                  authorizationIsCurrent(request), claimAuthorization(request) else { return }
            handoffClaimed = true
        }
        guard previous?.mutationSent != true || manualRetry else { return }
        let clientID = oauthClientID.isEmpty ? nil : oauthClientID
        let scope = oauthScope.isEmpty ? nil : oauthScope
        let token = generation, bot = botID
        let start: @MainActor () async throws -> McpOAuthAuthorization = { [self] in
            guard let currentIntent = launchSession?.intentID else { throw CancellationError() }
            if let request {
                let health = try await client.health()
                try check(token)
                guard health.hostId == request.handoff.hostId,
                      (manualRetry ? authorizationContextIsCurrent(request) : authorizationIsCurrent(request)),
                      NSApplication.shared.isActive else { throw HostClientError.contractMismatch }
            }
            try check(token)
            guard NSApplication.shared.isActive else { throw CancellationError() }
            return try await client.startMcpOAuth(serverID: id, clientID: clientID, scope: scope,
                expectedInstancePin: request?.handoff.instancePin, beforeDispatch: {
                    try self.check(token)
                    guard let session = self.launchSession, session.intentID == currentIntent else { throw CancellationError() }
                    try session.assertMayDispatch()
                })
        }
        let launch: McpOAuthLaunchSession
        if manualRetry {
            guard let retry = previous?.makeManualRetry(start: start) else { return }
            launch = retry
        } else {
            launch = McpOAuthLaunchSession(serverID: id, expiresAt: request?.handoff.expiresAt, start: start,
                open: { NSWorkspace.shared.open($0) }, isCurrent: { [weak self] in
            guard let self else { return false }
            return self.canRead && self.generation == token && self.selectedID == id && self.botID == bot
                && (request.map(self.authorizationContextIsCurrent) ?? true)
            }, isForeground: { NSApplication.shared.isActive })
        }
        launchSession = launch
        await perform(mutation: true) {
            await launch.prepare()
            try self.check()
            self.authorization = launch.authorization
            let metadata = try? await self.client.mcpCredentials(serverID: id)
            try self.check()
            if metadata?.serverId == id { self.credentials = metadata }
        }
        // The private response is confirmed and busy has ended. No second click or POST to open the browser.
        guard canRead, generation == token, launchSession === launch else { return }
        if launch.phase == .prepared { launch.continueInBrowser() }
        switch launch.phase {
        case .browserUnavailable: notice = String(localized: "Não foi possível abrir o navegador. Use Continuar no navegador; a autorização não será iniciada novamente.")
        case .failed:
            needsRefresh = true
            notice = launch.diagnostic?.errorDescription ?? String(localized: "O resultado da autorização não foi confirmado. Atualize para consultar o estado; este pedido não será enviado novamente.")
        case .expired: notice = String(localized: "Este pedido de autorização expirou. Peça ao bot uma nova proposta ou autorize esta conexão manualmente.")
        default: break
        }
    }

    func openAuthorization() {
        guard !closed, isCurrent(), !busy, !needsRefresh, let authorization,
              authorization.expiresAt > Date().timeIntervalSince1970 * 1_000 else { return }
        if let launchSession {
            launchSession.continueInBrowser()
            if launchSession.phase == .browserOpened { notice = nil }
            else if launchSession.phase == .browserUnavailable {
                notice = String(localized: "Não foi possível abrir o navegador. Use Continuar no navegador; a autorização não será iniciada novamente.")
            }
        }
        else if !NSWorkspace.shared.open(authorization.authorizationUrl) {
            notice = String(localized: "Não foi possível abrir o navegador. Tente novamente.")
        }
    }

    func watchAuthorization(serverID: String) async {
        let token = generation
        while !Task.isCancelled, !closed, selectedID == serverID, credentials?.state == "authorizing" {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard !closed, !Task.isCancelled, !needsRefresh, selectedID == serverID else { return }
            if busy { continue }
            do {
                let observation = try await client.readMcpAuthorizationStep(serverID: serverID)
                let result = observation.credentials
                try check(token)
                guard selectedID == serverID, result.serverId == serverID else { throw HostClientError.contractMismatch }
                credentials = result
                if result.state != "authorizing" {
                    authorization = nil
                    guard selectedID == serverID else { return }
                    if let current = observation.servers { servers = current }
                    if result.isReady, let plan = discoveryPlan, plan.isArmed, !busy {
                        // The owner consented to this one read for this plan; it runs once and is never retried.
                        await runPlannedDiscovery(plan, credentials: result, token: token)
                        return
                    }
                    notice = result.isReady ? String(localized: "Login recebido. Próximo passo: Descobrir ferramentas…, destacado acima.") : String(localized: "Confira o login antes de escolher a próxima etapa.")
                    highlightDiscover = result.isReady
                    // Observation only: without the owner's consented plan, no discovery, selection, unlock or tool invocation follows OAuth.
                }
            } catch {
                guard !closed, !Task.isCancelled, generation == token, isCurrent(), selectedID == serverID else { return }
                needsRefresh = true
                notice = String(localized: "Não foi possível conferir a autorização. Atualize para verificar.")
                return
            }
        }
    }

    /// One consented POST (inside `McpConsentedDiscoveryPlan`), then GETs only. An uncertain outcome is never re-sent.
    private func runPlannedDiscovery(_ plan: McpConsentedDiscoveryPlan, credentials: McpCredentialStatus, token: UUID) async {
        busy = true
        let tools = await plan.signInObserved(credentials)
        busy = false
        guard !closed, generation == token, selectedID == plan.serverID else { return }
        if let tools {
            self.tools = tools; highlightDiscover = false
            if let servers = try? await client.mcpServers() { self.servers = servers }
            try? await loadSelection()
            notice = DexterLocalization.text("Login recebido e ferramentas lidas uma vez, como você pediu. Nenhuma foi executada; escolha as deste bot abaixo.")
            return
        }
        switch plan.phase {
        case .uncertain:
            needsRefresh = true
            notice = DexterLocalization.text("Não foi possível confirmar a leitura das ferramentas. Atualize para consultar o estado; a leitura não é repetida.")
        case .refused:
            notice = DexterLocalization.text("A base recusou a leitura: a conexão mudou ou não é um servidor HTTP. Nada foi lido; confira e use Descobrir ferramentas… se quiser.")
            highlightDiscover = true
        case .invalidated(.pinChanged):
            notice = DexterLocalization.text("Login recebido, mas a conexão mudou desde que você ligou a leitura; nada foi lido. Confira e use Descobrir ferramentas… se quiser.")
            highlightDiscover = true
        case .expired, .invalidated:
            notice = DexterLocalization.text("Login recebido. A leitura combinada não vale mais (prazo, base ou pedido mudou); nada foi lido. Use Descobrir ferramentas… se quiser.")
            highlightDiscover = true
        default: break
        }
    }

    func saveSelection() async {
        guard !needsRefresh, let id = selectedID, !botID.isEmpty else { return }
        let selected = selectedTools.sorted(); let bot = botID
        await perform(mutation: true) {
            let result = try await self.client.saveMcpSelection(serverID: id, botID: bot, toolIDs: selected)
            try self.check()
            guard self.selectedID == id, self.botID == bot, result.botId == bot, result.policy == "ask", result.toolIds.sorted() == selected else { throw HostClientError.mutationOutcomeUnknown }
            self.selectedTools = Set(result.toolIds); self.savedTools = self.selectedTools
            self.notice = String(localized: "Seleção salva para este bot. As novas ferramentas estarão disponíveis no próximo turno; cada chamada exige aprovação.")
        }
    }

    func remove() async {
        guard !needsRefresh, let id = selectedID else { return }
        await perform(mutation: true) {
            try await self.client.removeMcpServer(id: id); try self.check()
            let servers = try await self.client.mcpServers()
            try self.check()
            self.servers = servers; self.selectedID = nil
            try await self.loadDetail()
        }
    }

    private func perform(mutation: Bool = false, authentication: Bool = false, _ operation: () async throws -> Void) async {
        guard !busy, !closed, isCurrent() else { return }
        requestGeneration = generation
        busy = true; notice = nil
        defer { busy = false }
        do { try check(); try await operation(); try check() }
        catch {
            guard !closed else { return }
            needsRefresh = true
            if error is CancellationError { return }
            if let error = error as? McpAuthenticationDiagnosticError {
                notice = error.errorDescription
                return
            }
            if mutation {
                // Registrations are not mutations here: their outcome is the retained session's own state.
                notice = String(localized: "Não foi possível confirmar a alteração. Atualize para conferir o estado antes de tentar novamente.")
                if let error = error as? HostClientError, error == .invalidRequest { notice = String(localized: "O host recusou a configuração. Confira os campos e a autenticação escolhida; atualize antes de corrigir.") }
                if let error = error as? HostClientError, error == .conflict {
                    notice = authentication
                        ? String(localized: "Não foi possível confirmar este passo de autorização. Atualize para conferir o estado da mesma conexão antes de decidir novamente.")
                        : String(localized: "A configuração mudou ou este ID já existe. Atualize e confira a mesma conexão antes de corrigir.")
                }
            } else if let error = error as? HostClientError, error == .forbidden {
                notice = String(localized: "Esta operação exige o proprietário no host local.")
            } else {
                notice = String(localized: "Não foi possível consultar as conexões. Confira o host local e Ferramentas do Dexter, depois atualize.")
            }
        }
    }
}

struct McpConnectionsView: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var state: McpConnectionsState?
    @State private var importing = false
    @State private var addingHTTP = false
    @State private var confirmingConnect = false
    @State private var confirmingRemove = false
    @State private var confirmingDisconnect = false
    @State private var reregistration: McpReregistration?
    @State private var confirmingCloseUncertain = false
    /// Consultas guardadas starts collapsed; it opens when the owner asks to see one request from a cadastro sheet.
    @State private var deferredExpanded = false
    @State private var highlightedDeferred: String?
    /// The bot whose settings opened the manager; nil (from Settings) keeps the main window's selected bot.
    private let initialBotID: String?
    private let initialServerID: String?
    private let authorizationRequest: McpAuthorizationPresentation?

    init(initialBotID: String? = nil, initialServerID: String? = nil, authorizationRequest: McpAuthorizationPresentation? = nil) {
        self.initialBotID = initialBotID; self.initialServerID = initialServerID; self.authorizationRequest = authorizationRequest
    }
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
    private var childSheetOpen: Bool { addingHTTP || reregistration != nil || importing }
    private var authorizationStatus: String {
        switch state?.launchSession?.phase {
        case .starting: String(localized: "Preparando autorização…")
        case .failed:
            if state?.launchSession?.canMakeManualRetry == true {
                String(localized: "O estado foi conferido. Use Autorizar novamente para iniciar um novo pedido; nada será repetido automaticamente.")
            } else {
                state?.launchSession?.diagnostic?.errorDescription ?? String(localized: "O resultado da autorização não foi confirmado. Atualize para consultar o estado; este pedido não será enviado novamente.")
            }
        case .expired, .invalidated: String(localized: "Este pedido de autorização expirou. Peça ao bot uma nova proposta ou autorize esta conexão manualmente.")
        case .browserUnavailable: String(localized: "Não foi possível abrir o navegador. Use Continuar no navegador; a autorização não será iniciada novamente.")
        default: String(localized: "Conclua o login no navegador. O Dexter acompanha o retorno; descobrir e liberar ferramentas são passos separados.")
        }
    }
    /// The registration intention that is still open (sent with an uncertain outcome, or prepared and unsent).
    private var openRegistration: McpRegistrationSummary? {
        guard let state, state.registrationNeedsCheck || state.registration?.state == .prepared else { return nil }
        return state.registrationSummary
    }
    private var addTitle: LocalizedStringKey {
        guard openRegistration != nil else { return "Adicionar endereço…" }
        return state?.registrationNeedsCheck == true ? "Ver cadastro não confirmado…" : "Ver cadastro não enviado…"
    }
    /// From a cadastro sheet: close it and show that request in Consultas guardadas. Nothing is read or sent.
    private func showDeferred(_ requestID: String) {
        addingHTTP = false; reregistration = nil; importing = false
        deferredExpanded = true; highlightedDeferred = requestID
    }
    private func uncertainFooter(name: String) -> some View {
        Text("Há um cadastro não confirmado de “\(name)”. Abra Ver cadastro não confirmado… e escolha Conferir estado antes de cadastrar outro.")
            .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("mcp.http-uncertain-footer")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Conexões MCP").font(.title2.weight(.semibold))
                Spacer()
                if state?.working == true { ProgressView().controlSize(.small) }
                if authorizationRequest != nil {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).help("Fechar autorização")
                        .accessibilityLabel("Fechar autorização").accessibilityIdentifier("mcp.oauth-handoff.close")
                }
                Button(addTitle) { addingHTTP = true }
                    .disabled(state == nil || state?.working == true || state?.registration == nil
                        || (state?.needsRefresh == true && openRegistration == nil))
                    .accessibilityIdentifier("mcp.add-http")
                Button("Importar…") { importing = true }
                    .disabled(state == nil || state?.working == true || state?.needsRefresh == true
                        || state?.registration == nil || openRegistration != nil)
                    .accessibilityIdentifier("mcp.import")
                Button("Atualizar") { if let state { Task { await state.refresh() } } }.disabled(state == nil || state?.working == true || state?.canRead == false)
                    .accessibilityIdentifier("mcp.refresh")
            }.padding(20)
            Divider()
            if authorizationRequest != nil {
                Text(DexterLocalization.text(authorizationStatus, locale: locale))
                    .font(.callout).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 10)
                    .accessibilityIdentifier("mcp.oauth-handoff.status")
            }
            if let request = authorizationRequest, let state {
                // The host's setup request for this same approved action: completing it resumes the bot's task once.
                NativeSetupCompletionPanel(actionID: request.handoff.actionId, client: state.client,
                    refreshKey: [state.savedTools.sorted().joined(separator: ","), state.credentials?.state ?? "", state.selectedServer?.status ?? ""].joined(separator: "|"))
                    .padding(.horizontal, 20).padding(.bottom, 8)
            }
            // Private inputs that servers asked during running actions (any conversation): answered here, one POST each.
            McpPrivateInputStrip(scope: .all, active: true)
            if let state {
                HStack(spacing: 0) {
                    serverList(state).frame(minWidth: 200, idealWidth: 230, maxWidth: 280)
                    Divider()
                    ScrollView { detail(state).frame(maxWidth: .infinity, alignment: .leading).padding(20) }
                }
                .frame(maxHeight: .infinity)
            } else {
                ContentUnavailableView("Host local necessário", systemImage: "network", description: Text("Conecte o app ao host local para gerenciar servidores MCP."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack {
                // A sheet in front (cadastro, recadastro, importação) shows its own notice; the footer waits.
                if !childSheetOpen {
                    if let notice = state?.notice {
                        Text(DexterLocalization.text(notice, locale: locale)).font(.callout).fixedSize(horizontal: false, vertical: true)
                    } else if state?.registrationNeedsCheck == true, let summary = state?.registrationSummary {
                        uncertainFooter(name: summary.name)
                    } else if state != nil, state?.registration == nil {
                        Text("Esta base não confirmou proprietário e instalação, então novos cadastros ficam indisponíveis aqui. Abra o host local atualizado e reabra Conexões MCP; o cadastro antigo, sem confirmação, não é usado.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("mcp.registration-unavailable")
                    }
                }
                Spacer()
                Button("Concluir") {
                    if state?.registrationNeedsCheck == true { confirmingCloseUncertain = true } else { dismiss() }
                }.keyboardShortcut(.cancelAction).accessibilityIdentifier("mcp.close")
            }.padding(16)
        }
        // Resizable sheet capped at the parent window's content area: Settings is 720 pt wide and its content is 440 pt tall
        // at its minimum (the 80 pt of title bar and toolbar sit above it), so the sheet opens at 680 × 440 and never exceeds that.
        .frame(minWidth: 620, idealWidth: 680, maxWidth: 720, minHeight: 400, idealHeight: 440, maxHeight: 440)
        .alert("Fechar com um cadastro não confirmado?", isPresented: $confirmingCloseUncertain) {
            Button("Cancelar", role: .cancel) {}.keyboardShortcut(.defaultAction)
            Button("Fechar") { dismiss() }.accessibilityIdentifier("mcp.http-close-uncertain")
        } message: {
            Text(uncertainCloseMessage)
        }
        .task {
            guard state == nil, let client = model.makeLocalMcpClient() else { return }
            let scope = model.nativeComposerScope; let address = model.hostAddress; let backend = model.backendLabel
            // Kept by the model per owner/base with its own client: closing this sheet never closes it or drops its
            // original request. Without it (older or unconfirmed base) registering is unavailable; no legacy fallback.
            let registration = try? await model.makeMcpRegistrationSession()
            registration?.invalidateIfScopeChanged()
            guard !Task.isCancelled, state == nil else { client.close(); return }
            let next = McpConnectionsState(client: client, hostID: model.approvalPolicyHostID, isCurrent: {
                model.nativeComposerScope == scope && model.hostAddress == address && model.backendLabel == backend
                    && model.canEditBotProfiles && model.isOnline
            }, authorizationIsCurrent: { model.mcpAuthorizationIsCurrent($0) },
               authorizationContextIsCurrent: { $0.context == model.mcpAuthorizationContext && !model.stoppedActionIDs.contains($0.handoff.actionId) },
               claimAuthorization: { model.claimMcpAuthorizationLaunch($0) })
            next.registration = registration
            next.botID = initialBotID.flatMap { id in model.bots.contains(where: { $0.id == id }) ? id : nil } ?? model.selectedBotID ?? ""
            next.selectedID = initialServerID
            next.authorizationRequest = authorizationRequest
            state = next
            await next.refresh()
            if let authorizationRequest, model.mcpAuthorizationIsCurrent(authorizationRequest),
               next.selectedID == authorizationRequest.handoff.serverId,
               next.credentials?.auth == "oauth", next.credentials?.isReady == false {
                await next.authorize(automaticHandoff: true)
            }
        }
        .onChange(of: model.hostAddress + "|" + model.backendLabel + "|" + model.nativeComposerScope.uuidString) { _, _ in
            state?.invalidateScope()
        }
        .onChange(of: model.mcpAuthorizationContext) { _, context in
            if let authorizationRequest, authorizationRequest.context != context { state?.invalidateScope() }
        }
        .onChange(of: "\(model.isOnline)|\(model.canEditBotProfiles)|\(model.approvalPolicyHostID ?? "")") { _, _ in
            state?.latchRegistrationScope()
        }
        .onDisappear { state?.close(); state = nil }
        .task(id: (state?.selectedID ?? "") + "|" + (state?.botID ?? "") + "|" + (state?.credentials?.state ?? "")) {
            if let state, let id = state.selectedID, state.credentials?.state == "authorizing" {
                await state.watchAuthorization(serverID: id)
            }
        }
        .sheet(isPresented: $addingHTTP) { if let state { McpHttpAddView(state: state, onShowDeferred: showDeferred) } }
        .sheet(item: $reregistration) { item in if let state { McpHttpAddView(state: state, prefill: item, onShowDeferred: showDeferred) } }
        .sheet(isPresented: $importing) {
            if let state { McpImportView(state: state, onShowDeferred: showDeferred) }
        }
        .confirmationDialog("Conectar e descobrir ferramentas?", isPresented: $confirmingConnect, titleVisibility: .visible) {
            Button("Conectar") { if let state { Task { await state.discover() } } }
                .accessibilityIdentifier("mcp.discover-confirm")
        } message: {
            if let server = state?.selectedServer {
                Text(verbatim: ConnectionsPresentation.discoveryPlan(server: server, portuguese: portuguese))
            } else {
                Text("Esta ação inicia o servidor escolhido ou conecta ao seu endereço. Nenhuma ferramenta será executada.")
            }
        }
        .alert("Remover esta conexão MCP?", isPresented: $confirmingRemove) {
            Button("Cancelar", role: .cancel) {}.keyboardShortcut(.defaultAction)
            Button("Remover", role: .destructive) { if let state { Task { await state.remove() } } }
                .accessibilityIdentifier("mcp.remove-confirm")
        } message: {
            Text(removeMessage)
        }
        .confirmationDialog("Esquecer a autorização?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button("Esquecer autorização", role: .destructive) { if let state { Task { await state.disconnect() } } }
        } message: {
            Text("O Dexter encerrará a conexão e esquecerá esta autorização. Para revogar o acesso no serviço, use as configurações da sua conta nele.")
        }
    }

    private func serverList(_ state: McpConnectionsState) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.servers.isEmpty {
                Text("Nenhum servidor adicionado.").foregroundStyle(.secondary).padding(20)
            }
            let unconfirmed = state.unconfirmedServerIDs
            List(selection: Binding(get: { state.selectedID }, set: { id in Task { await state.selectServer(id) } })) {
                ForEach(state.servers) { server in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(server.name).lineLimit(2)
                        Text(verbatim: "ID " + McpInstanceLabel.short(server.id, among: state.servers.map(\.id)))
                            .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                        Text(statusLabel(server.status)).font(.caption).foregroundStyle(.secondary)
                        if unconfirmed.contains(server.id) {
                            Text("Pode ser do cadastro não confirmado").font(.caption).foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 4).tag(server.id)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("mcp.server-row.\(server.id)")
                }
            }.listStyle(.sidebar).disabled(state.busy)
            deferredHistory(state)
        }
    }

    /// Consultas guardadas: compact and collapsed by default, so up to 32 requests never crowd the list. Each request
    /// keeps its own Conferir este pedido (a read of the original request) and its IDs under Detalhes técnicos.
    /// Nothing here registers, selects, logs in, discovers, grants or cancels.
    @ViewBuilder private func deferredHistory(_ state: McpConnectionsState) -> some View {
        let items = state.deferred
        if !items.isEmpty {
            let open = items.filter(\.isUnresolved).count
            Divider()
            DisclosureGroup(isExpanded: $deferredExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    if state.registration?.scopeMatches != true {
                        Text("A base mudou. Feche e reabra Conexões MCP nesta janela para consultar; nada é lido da base anterior.")
                            .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    }
                    // One request shows whole; from two on, the rows scroll in a fixed area so the list keeps its room.
                    Group {
                        if items.count > 1 {
                            ScrollView { deferredRows(state, items) }.frame(height: 170)
                        } else {
                            deferredRows(state, items)
                        }
                    }
                    Text("Ficam aqui só enquanto o app estiver aberto. Conferir só consulta o pedido original; nada é reenviado nem cancelado.")
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 6)
            } label: {
                HStack(spacing: 6) {
                    Text(DexterLocalization.format("Consultas guardadas (%@)", String(items.count), locale: locale)).font(.callout.weight(.medium))
                    if open > 0 {
                        Text(DexterLocalization.format("%@ em aberto", String(open), locale: locale)).font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            .padding(10)
            .accessibilityIdentifier("mcp.registration-deferred")
        }
    }

    private func deferredRows(_ state: McpConnectionsState, _ items: [McpDeferredRegistration]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Most recent first; the order of deferral stays in the session. At most 32 rows: no lazy container, so
            // each row keeps its own accessibility container.
            ForEach(items.reversed()) { item in
                McpDeferredRow(state: state, item: item, highlighted: highlightedDeferred == item.id)
            }
        }
    }

    @ViewBuilder private func detail(_ state: McpConnectionsState) -> some View {
        if let server = state.selectedServer {
            VStack(alignment: .leading, spacing: 16) {
                Text(server.name).font(.title3.weight(.semibold)).textSelection(.enabled)
                Text(server.destination).font(.system(.callout, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 6) {
                    LabeledContent("ID da conexão") { Text(verbatim: server.id).font(.callout.monospaced()).textSelection(.enabled) }
                    LabeledContent("Conta do serviço", value: DexterLocalization.text("Não verificada", locale: locale))
                    Text("O Dexter não confirma qual conta do serviço esta conexão usa. Para várias contas, cadastre uma conexão para cada uma, com nomes como Pessoal e Trabalho.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    ForEach(McpInstanceLabel.duplicateWarnings(for: server, among: state.servers), id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.callout)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("mcp.instance-identity")
                HStack {
                    Text(server.transport == "stdio" ? "Processo local" : "Servidor HTTP")
                    Text("·")
                    Text(statusLabel(server.status))
                }.font(.callout).foregroundStyle(.secondary)
                Text(verbatim: ConnectionsPresentation.executorLine(server.executor, runsOn: server.runsOn, portuguese: portuguese))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("mcp.placement")
                if server.transport == "stdio", state.commandStatusRead,
                   let review = ConnectionsPresentation.commandReview(state.commandStatus, portuguese: portuguese) {
                    VStack(alignment: .leading, spacing: 4) {
                        Label(review.headline, systemImage: review.tone.symbol)
                            .font(.callout.weight(.medium)).foregroundStyle(ConnectionFactsView.color(review.tone))
                        Text(verbatim: review.detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if let status = state.commandStatus, status.reviewed != nil || status.current != nil {
                            DisclosureGroup(t("Detalhes do programa", "Program details")) {
                                ForEach(ConnectionsPresentation.commandDigests(status, portuguese: portuguese), id: \.self) { line in
                                    Text(verbatim: line).font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .font(.caption)
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("mcp.command-review")
                }
                if server.transport == "stdio" {
                    Label(ConnectionsPresentation.stdioBoundary(portuguese: portuguese), systemImage: "exclamationmark.shield")
                        .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("mcp.stdio-boundary")
                }
                ConnectionFactsView(facts: ConnectionsPresentation.native(server: server, credentials: state.credentials, portuguese: portuguese))
                    .accessibilityIdentifier("mcp.facts")
                if state.unconfirmedServerIDs.contains(server.id) {
                    // The inventory row is not the receipt: it may be this request or an older connection with the same ID.
                    Label("A lista mostra esta conexão, mas o pedido de cadastro com este ID ainda não foi confirmado. A lista sozinha não confirma o pedido: use Conferir estado ou Consultas guardadas.", systemImage: "questionmark.circle")
                        .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("mcp.inventory-unconfirmed")
                }
                let serviceAskedForLogin = server.auth == "none" && (server.status == "needs_auth" || server.diagnostic?.code == "needs_auth")
                if let step = state.setupStep {
                    Label(setupLabel(step), systemImage: step == .ready ? "checkmark.circle" : "list.number")
                        .font(.callout.weight(.medium)).accessibilityIdentifier("mcp.setup-status")
                    Text(verbatim: serviceAskedForLogin ? DexterLocalization.text("O serviço pediu login. Veja abaixo como cadastrar de novo com login.", locale: locale) : setupNextStep(step))
                        .font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("mcp.setup-next-step")
                }
                if serviceAskedForLogin {
                    reregisterGuidance(server)
                }
                if let diagnostic = server.diagnostic, !serviceAskedForLogin {
                    Text(diagnostic.message).font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("mcp.setup-diagnostic")
                    if let stage = diagnostic.stage, let code = diagnostic.code {
                        // Stage and protocol code are for support; the first level keeps the sentence above.
                        DisclosureGroup("Detalhes técnicos") {
                            Text(verbatim: "\(diagnosticStageLabel(stage)) · \(code)").font(.caption.monospaced()).foregroundStyle(.secondary)
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .font(.caption)
                        .accessibilityIdentifier("mcp.setup-diagnostic-code")
                    }
                }
                if server.auth != "none" {
                    credentialControls(state, server: server)
                }
                HStack {
                    if state.highlightDiscover {
                        discoverButton(state, server: server).buttonStyle(.borderedProminent)
                    } else {
                        discoverButton(state, server: server)
                    }
                    Spacer()
                    Button("Remover…", role: .destructive) { confirmingRemove = true }.disabled(state.busy || state.needsRefresh)
                        .accessibilityIdentifier("mcp.remove")
                }
                if state.highlightDiscover {
                    Text("Próximo passo: Descobrir ferramentas…. Nada é descoberto sem a sua confirmação.")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("mcp.next-step-highlight")
                }
                Divider()
                if state.tools.isEmpty {
                    Text("O cadastro não conecta o serviço. Autorize se necessário e escolha Descobrir ferramentas.").foregroundStyle(.secondary)
                } else {
                    Picker("Bot", selection: Binding(get: { state.botID }, set: { id in Task { await state.selectBot(id) } })) {
                        Text("Escolha um bot").tag("")
                        ForEach(model.bots) { bot in Text(bot.name).tag(bot.id) }
                    }.disabled(state.busy)
                    Text("Escolha as ferramentas deste bot e salve. A seleção salva só chega à engine no próximo turno. Cada chamada pedirá sua aprovação.").font(.callout).foregroundStyle(.secondary)
                    ForEach(state.tools) { tool in
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle(isOn: Binding(get: { state.selectedTools.contains(tool.id) }, set: { enabled in
                                if enabled { state.selectedTools.insert(tool.id) } else { state.selectedTools.remove(tool.id) }
                            })) {
                                Text(tool.name).fontWeight(.medium)
                            }.disabled(state.busy || state.needsRefresh || state.botID.isEmpty || tool.state != "publishable")
                            if !tool.description.isEmpty { Text(tool.description).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                            Text(tool.state != "publishable" ? "Indisponível pela política do Dexter" : tool.effect == "read" ? "Leitura" : "Pode alterar dados")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                    Button("Salvar permissões") { Task { await state.saveSelection() } }
                        .disabled(state.busy || state.needsRefresh || state.botID.isEmpty)
                        .accessibilityIdentifier("mcp.save-permissions")
                }
            }
        } else {
            Text("Adicione o endereço HTTP MCP fornecido pelo serviço. Para processos locais ou configurações existentes, use Importar.").foregroundStyle(.secondary)
        }
    }

    private func discoverButton(_ state: McpConnectionsState, server: McpServerSummary) -> some View {
        Button("Descobrir ferramentas…") { confirmingConnect = true }
            .disabled(state.busy || state.needsRefresh || !(state.credentials?.isReady ?? false) || server.status == "unavailable_here"
                      || (server.transport == "stdio" && ConnectionsPresentation.commandReview(state.commandStatus, portuguese: portuguese)?.blocksDiscovery == true && state.commandStatusRead))
            .accessibilityIdentifier("mcp.discover")
    }

    /// D04-R1-1: a connection registered without login whose service answered "login required".
    /// The only real exit is a new registration with a login type; nothing is removed or recreated automatically.
    private func reregisterGuidance(_ server: McpServerSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Este serviço pediu login", systemImage: "person.badge.key").font(.callout.weight(.semibold))
            Text("A conexão foi cadastrada como “Nenhuma — serviço aberto”, mas o serviço respondeu que exige login. O Dexter não muda o tipo de login de uma conexão já cadastrada e não descobre sozinho qual login o serviço usa.")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            Text("Para continuar, cadastre de novo escolhendo Token de acesso ou Entrar com a conta do serviço. Será uma conexão nova, com outro ID. Depois, se não precisar mais desta, use Remover…; nada é removido sozinho.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Cadastrar de novo com login…") {
                reregistration = McpReregistration(name: server.name, url: server.destination, previousID: server.id)
            }
            .buttonStyle(.borderedProminent)
            .disabled(state?.canStartRegistration != true)
            .accessibilityIdentifier("mcp.reregister-with-auth")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.reregister-guidance")
    }

    private var uncertainCloseMessage: String {
        guard let summary = state?.registrationSummary else { return DexterLocalization.text("Confira a lista antes de cadastrar de novo.", locale: locale) }
        return DexterLocalization.format("O pedido de “%@” pode já ter sido salvo pela base. Ele fica guardado enquanto o app estiver aberto: ao reabrir Conexões MCP, o Dexter confere de novo pelo mesmo pedido, sem reenviar. Ao encerrar o app, este pedido se perde; confira então a lista antes de cadastrar outra vez.", summary.name, locale: locale)
    }

    private var removeMessage: String {
        guard let server = state?.selectedServer else { return DexterLocalization.text("A conexão será removida.", locale: locale) }
        return String(localized: "“\(server.name)” (\(server.id)) será removida. As ferramentas desta conexão saem de todos os bots que as usam. Outras conexões, mesmo com o mesmo endereço, não mudam.")
    }

    @ViewBuilder private func credentialControls(_ state: McpConnectionsState, server: McpServerSummary) -> some View {
        if let credentials = state.credentials {
            VStack(alignment: .leading, spacing: 10) {
                Label(credentialLabel(credentials.state), systemImage: credentials.isReady ? "lock.open" : "lock")
                    .font(.callout.weight(.medium))
                if let expiry = credentials.expiresAt {
                    HStack {
                        Text("Válido até")
                        Text(Date(timeIntervalSince1970: expiry / 1_000), format: .dateTime.hour().minute())
                    }.font(.caption).foregroundStyle(.secondary)
                }
                if let error = credentials.lastError {
                    Text(verbatim: credentialErrorText(error, service: server.name))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("mcp.credential-error")
                }
                if credentials.state == "unavailable" {
                    Text(DexterLocalization.text(server.status == "unavailable_here" ? "Abra esta conexão no host onde ela está disponível." : server.auth == "broker" ? "Configure o cofre do 1Password nas opções do host local e atualize esta conexão." : "Ative a autorização desta conexão no host local e atualize.", locale: locale))
                        .font(.callout).foregroundStyle(.secondary)
                } else if server.auth == "broker" {
                    Text("As chaves são lidas do 1Password somente ao desbloquear e ficam disponíveis por tempo limitado.")
                        .font(.callout).foregroundStyle(.secondary)
                    if !credentials.slots.isEmpty {
                        Text(DexterLocalization.text("Campos necessários", locale: locale) + ": " + credentials.slots.joined(separator: ", "))
                            .font(.caption).textSelection(.enabled)
                    }
                    HStack {
                        Button("Desbloquear com 1Password") { Task { await state.unlock() } }
                            .disabled(credentials.isReady).accessibilityIdentifier("mcp.unlock")
                        Button("Bloquear") { Task { await state.lock() } }
                            .disabled(!credentials.isReady).accessibilityIdentifier("mcp.lock")
                    }
                } else if server.auth == "oauth" {
                    Text(DexterLocalization.text(McpOAuthPersistencePresentation.message(state.oauthPersistence, connected: state.oauthPersistenceConnected), locale: locale))
                        .font(.callout).foregroundStyle(.secondary)
                    if let authorization = state.authorization {
                        Text(DexterLocalization.text("Serviço de autorização", locale: locale) + ": " + authorization.issuer)
                            .font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Button("Continuar no navegador") { state.openAuthorization() }
                            .accessibilityIdentifier("mcp.open-authorization")
                        Text("Após concluir no navegador, volte ao Dexter para conectar e descobrir as ferramentas.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if credentials.state == "authorizing" {
                        Text("Conclua a autorização no navegador ou cancele para começar novamente.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        if let issuer = credentials.issuer { Text(issuer).font(.caption).foregroundStyle(.secondary) }
                        if credentials.lastError == "oauth_client_required" {
                            // The service refused automatic registration: the Client ID is the way forward, shown here and
                            // not hidden in the options. No other login method is inferred from this error.
                            VStack(alignment: .leading, spacing: 6) {
                                Label(t("Informe o Client ID compatível", "Enter the compatible Client ID"), systemImage: "person.badge.key")
                                    .font(.callout.weight(.semibold))
                                Text(verbatim: ConnectionsPresentation.clientIDRequest(service: server.name, portuguese: portuguese))
                                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                TextField(t("Client ID", "Client ID"), text: Binding(get: { state.oauthClientID }, set: { state.oauthClientID = $0 }))
                                    .textFieldStyle(.roundedBorder)
                                    .accessibilityIdentifier("mcp.oauth-client-id")
                            }
                            .padding(10)
                            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("mcp.oauth-client-required")
                        }
                        DisclosureGroup("Opções de autorização") {
                            if credentials.lastError != "oauth_client_required" {
                                TextField("ID do aplicativo (opcional)", text: Binding(get: { state.oauthClientID }, set: { state.oauthClientID = $0 }))
                                    .accessibilityIdentifier("mcp.oauth-client-id")
                            }
                            TextField("Permissões solicitadas (opcional)", text: Binding(get: { state.oauthScope }, set: { state.oauthScope = $0 }))
                                .accessibilityIdentifier("mcp.oauth-scope")
                            Text("Preencha somente se o serviço fornecer esses dados.").font(.caption).foregroundStyle(.secondary)
                        }.disabled(credentials.isReady)
                        HStack {
                            Button(DexterLocalization.text(state.launchSession?.canMakeManualRetry == true ? "Autorizar novamente…" : "Autorizar…", locale: locale)) { Task { await state.authorize() } }
                                .disabled(!state.canAuthorize).accessibilityIdentifier("mcp.authorize")
                            Button("Restaurar autorização") { Task { await state.unlock() } }
                                .disabled(credentials.isReady).accessibilityIdentifier("mcp.restore-authorization")
                        }
                    }
                    if server.transport != "stdio", !credentials.isReady {
                        consentedDiscoveryControl(state, server: server)
                    }
                    if credentials.isReady || credentials.state == "authorizing" {
                        HStack {
                            Button(DexterLocalization.text(credentials.state == "authorizing" ? "Cancelar autorização" : "Bloquear", locale: locale)) { Task { await state.lock() } }
                                .accessibilityIdentifier("mcp.lock")
                            Button("Esquecer autorização…", role: .destructive) { confirmingDisconnect = true }
                                .accessibilityIdentifier("mcp.disconnect")
                        }
                    }
                }
            }.disabled(state.busy || state.needsRefresh)
        }
    }

    /// The owner's explicit consent to one metadata/tools read right after this sign-in, with the exact plan beside it.
    /// Off by default (also when a bot's approved request opened this window); never for a local process.
    @ViewBuilder private func consentedDiscoveryControl(_ state: McpConnectionsState, server: McpServerSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(get: { state.discoveryPlan?.isArmed == true }, set: { on in if on { state.armDiscoveryPlan() } else { state.withdrawDiscoveryPlan() } })) {
                Text(verbatim: t("Depois de entrar, ler as ferramentas uma vez", "After signing in, read the tools once"))
            }
            .disabled(state.busy || state.needsRefresh || state.discoveryPlan.map { !$0.isArmed && $0.phase != .invalidated(.withdrawn) } == true
                      || state.discoveryPinResolution == .missing || state.discoveryPinResolution == .mismatch)
            .accessibilityIdentifier("mcp.oauth-read-tools-after-login")
            Text(verbatim: ConnectionsPresentation.consentedDiscoveryPlan(server: server, portuguese: portuguese))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("mcp.oauth-read-tools-plan")
            if let unavailable = ConnectionsPresentation.consentedDiscoveryUnavailable(state.discoveryPinResolution, portuguese: portuguese) {
                Text(verbatim: unavailable)
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("mcp.oauth-read-tools-unavailable")
            }
        }
    }

    private func credentialLabel(_ state: String) -> String {
        switch state {
        case "unlocked": DexterLocalization.text("Credenciais disponíveis", locale: locale)
        case "locked": DexterLocalization.text("Credenciais bloqueadas", locale: locale)
        case "expired": DexterLocalization.text("Autorização expirada", locale: locale)
        case "unauthorized": DexterLocalization.text("Autorização necessária", locale: locale)
        case "authorizing": DexterLocalization.text("Aguardando autorização", locale: locale)
        case "unavailable": DexterLocalization.text("Credenciais indisponíveis neste host", locale: locale)
        default: DexterLocalization.text("Credenciais pendentes", locale: locale)
        }
    }

    /// One specific sentence per closed diagnostic code; values outside the set keep the neutral sentence.
    private func credentialErrorText(_ code: String, service: String) -> String {
        ConnectionsPresentation.diagnostic(code: code, service: service, portuguese: portuguese)?.sentence
            ?? t("Não foi possível concluir a autorização. Atualize para conferir e tente novamente.",
                 "The authorization could not be completed. Refresh to check and try again.")
    }

    private func diagnosticStageLabel(_ stage: McpSetupDiagnostic.Stage) -> String {
        switch stage {
        case .registration: DexterLocalization.text("Cadastro", locale: locale)
        case .configuration: DexterLocalization.text("Configuração", locale: locale)
        case .host: DexterLocalization.text("Host", locale: locale)
        case .discovery: DexterLocalization.text("Descoberta", locale: locale)
        case .authentication: DexterLocalization.text("Autorização", locale: locale)
        case .selection: DexterLocalization.text("Seleção", locale: locale)
        }
    }

    private func setupLabel(_ step: McpSetupStep) -> String {
        switch step {
        case .registered: DexterLocalization.text("Registrado", locale: locale)
        case .authorizationRequired: DexterLocalization.text("Login necessário", locale: locale)
        case .discoveryRequired: DexterLocalization.text("Registrado · descoberta requer sua decisão", locale: locale)
        case .toolsAvailable: DexterLocalization.text("Descoberta concluída · nenhuma ferramenta publicada", locale: locale)
        case .selectionRequired: DexterLocalization.text("Ferramentas descobertas · escolha para este bot", locale: locale)
        case .ready: DexterLocalization.text("Ferramentas salvas para este bot · entram no próximo turno", locale: locale)
        case .unavailable: DexterLocalization.text("Indisponível neste host", locale: locale)
        case .discoveryFailed: DexterLocalization.text("Descoberta não concluída", locale: locale)
        case .checking: DexterLocalization.text("Consultando o estado da conexão", locale: locale)
        }
    }

    private func setupNextStep(_ step: McpSetupStep) -> String {
        switch step {
        case .registered, .discoveryRequired: DexterLocalization.text("Descobrir inicia a conexão após sua confirmação. Nenhuma ferramenta é executada.", locale: locale)
        case .authorizationRequired: DexterLocalization.text("Uma consulta concluída com autorização pendente não significa conexão pronta. Autorize no fluxo privado; depois escolha descobrir.", locale: locale)
        case .toolsAvailable: DexterLocalization.text("O servidor respondeu sem ferramentas publicáveis. Confira sua configuração antes de repetir a descoberta.", locale: locale)
        case .selectionRequired: DexterLocalization.text("Selecione as ferramentas permitidas e salve somente para o bot escolhido.", locale: locale)
        case .ready: DexterLocalization.text("Há ferramentas publicáveis na seleção salva. As chamadas continuam sujeitas à aprovação do host.", locale: locale)
        case .unavailable: DexterLocalization.text("Confira a disponibilidade e a custódia de autorização neste host.", locale: locale)
        case .discoveryFailed: DexterLocalization.text("Confira o diagnóstico da conexão. Uma nova descoberta exige outra confirmação e não repete chamadas de ferramentas.", locale: locale)
        case .checking: DexterLocalization.text("Atualize para conferir os metadados. A consulta não autoriza nenhuma etapa.", locale: locale)
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "ready": DexterLocalization.text("Ferramentas descobertas", locale: locale)
        case "needs_auth": DexterLocalization.text("Login necessário", locale: locale)
        case "unavailable_here": DexterLocalization.text("Disponível em outro host", locale: locale)
        case "failed": DexterLocalization.text("Descoberta não concluída", locale: locale)
        default: DexterLocalization.text("Registrado", locale: locale)
        }
    }
}

private struct McpHttpAddView: View {
    @Bindable var state: McpConnectionsState
    let prefill: McpReregistration?
    /// Closes this sheet and shows one request in Consultas guardadas of the manager.
    let onShowDeferred: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var address: String
    @State private var serverID = ""
    @Environment(\.locale) private var locale
    @State private var generatedID = McpHttpAddView.newGeneratedID()
    @State private var authentication = McpHttpDraft.Authentication.none
    @State private var reviewed: McpHttpDraft?
    @State private var validationNotice: String?
    @State private var confirmingCloseUncertain = false
    /// Set when this sheet sends or checks the retained intention, so its outcome shows here instead of an older one.
    @State private var showsOutcome = false

    init(state: McpConnectionsState, prefill: McpReregistration? = nil, onShowDeferred: @escaping (String) -> Void) {
        self.state = state; self.prefill = prefill; self.onShowDeferred = onShowDeferred
        _name = State(initialValue: prefill.map { Self.suggestedName($0.name) } ?? ""); _address = State(initialValue: prefill?.url ?? "")
    }

    /// The new connection gets a name that differs from the one asking for login, so the list and the cards can tell
    /// them apart without the form warning against its own suggestion. The owner can edit it.
    static func suggestedName(_ previous: String) -> String {
        let suffix = " · com login"
        var base = previous.trimmingCharacters(in: .whitespacesAndNewlines)
        while (base + suffix).utf16.count > 120, !base.isEmpty { base.removeLast() }
        return base.isEmpty ? previous : base + suffix
    }

    static func newGeneratedID() -> String {
        "http-" + String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(24))
    }

    /// Re-registration after "login required" needs an explicit login type; the app never infers it.
    private var needsLoginChoice: Bool { prefill != nil && authentication == .none }

    /// The retained intention shown instead of the form: one still open (sent with an uncertain outcome, prepared and
    /// unsent, being sent, or bound to a base that changed), or the outcome of what this sheet sent or checked.
    private var retained: McpRegistrationSession? {
        guard let session = state.registration, session.request != nil else { return nil }
        let open = session.requiresReconciliation || session.state == .prepared || session.state == .submitting || !session.scopeMatches
        return open || showsOutcome ? session : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(prefill == nil ? "Adicionar endereço MCP" : "Cadastrar de novo com login").font(.title2.weight(.semibold))
            Text(prefill == nil ? "Use o endereço HTTP MCP fornecido pelo serviço. Um site ou link de documentação não é resolvido e nenhum caminho será adivinhado."
                                : "O endereço veio da conexão \(prefill.map { McpInstanceLabel.short($0.previousID) } ?? ""), e o nome sugerido a diferencia dela; você pode mudar. Escolha o tipo de login que o serviço usa; a documentação do serviço costuma dizer. Esta será uma conexão nova, com outro ID.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let session = retained, let summary = state.registrationSummary {
                retainedReview(session, summary)
            } else if let draft = reviewed {
                LabeledContent("Nome", value: draft.name)
                LabeledContent("Endereço MCP", value: draft.url)
                LabeledContent("ID da conexão", value: draft.serverID)
                LabeledContent("Login", value: authenticationLabel(draft.authentication))
                ForEach(duplicateWarnings(draft), id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("mcp.http-duplicate-warning")
                }
                let waiting = state.unresolvedDeferred(serverID: draft.serverID)
                if let waiting {
                    McpSameIDWaiting(item: waiting) { onShowDeferred(waiting.id) }
                }
                Text("Registrar salva esta definição. Não conecta, não libera credenciais e não seleciona ferramentas.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Editar campos") { reviewed = nil }.disabled(state.working || state.needsRefresh)
                        .accessibilityIdentifier("mcp.http-edit")
                    Spacer()
                    Button("Registrar endereço") { showsOutcome = true; Task { await state.addHTTP(draft) } }
                        .disabled(!state.canStartRegistration || waiting != nil || state.servers.contains { $0.id == draft.serverID })
                        .accessibilityIdentifier("mcp.http-register")
                }
            } else {
                TextField("Nome da conexão", text: $name).accessibilityIdentifier("mcp.http-name")
                TextField("Endereço MCP (https://…)", text: $address).accessibilityIdentifier("mcp.http-url")
                Picker("Login que o serviço usa", selection: $authentication) {
                    ForEach(McpHttpDraft.Authentication.allCases, id: \.self) { value in Text(authenticationLabel(value)).tag(value) }
                }.accessibilityIdentifier("mcp.http-authentication")
                Text(authenticationHelp)
                    .font(.caption).foregroundStyle(needsLoginChoice ? Color.orange : Color.secondary).fixedSize(horizontal: false, vertical: true)
                DisclosureGroup("Opções avançadas") {
                    TextField("ID estável (opcional)", text: $serverID).accessibilityIdentifier("mcp.http-server-id")
                    Text("Deixe vazio para usar o ID desta nova conexão. O mesmo endereço pode ter várias conexões independentes. Configuração JSON/TOML e processo local continuam em Importar.")
                        .font(.caption).foregroundStyle(.secondary)
                }.accessibilityIdentifier("mcp.http-advanced")
                Button("Revisar cadastro") {
                    do { reviewed = try McpHttpDraft(name: name, url: address, authentication: authentication, serverID: serverID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? generatedID : serverID); validationNotice = nil }
                    catch let error as McpHttpDraftError { validationNotice = error.errorDescription }
                    catch { validationNotice = String(localized: "Confira os campos do cadastro.") }
                }.disabled(!state.canStartRegistration || needsLoginChoice).accessibilityIdentifier("mcp.http-review")
            }
            if let notice = validationNotice ?? state.notice {
                Text(DexterLocalization.text(notice, locale: locale)).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack {
                if state.working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Concluir") {
                    if state.registrationNeedsCheck { confirmingCloseUncertain = true } else { dismiss() }
                }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24).frame(minWidth: 560, idealWidth: 620, minHeight: 470)
        .alert("Fechar com um cadastro não confirmado?", isPresented: $confirmingCloseUncertain) {
            Button("Cancelar", role: .cancel) {}.keyboardShortcut(.defaultAction)
            Button("Fechar") { dismiss() }.accessibilityIdentifier("mcp.http-close-uncertain")
        } message: {
            Text(DexterLocalization.format("O pedido de “%@” pode já ter sido salvo pela base. Ele fica guardado enquanto o app estiver aberto; volte aqui por Ver cadastro não confirmado… e use Conferir estado. Ao encerrar o app, este pedido se perde.", state.registrationSummary?.name ?? "", locale: locale))
        }
    }

    /// The retained intention, its plain-language state and the next steps it allows. Nothing here sends a new request:
    /// Conferir estado only reads; Registrar sends a prepared request that never left the app; Editar campos drops only
    /// that preparation (Editar campos); Deixar consulta para depois moves an open outcome to Consultas guardadas without cancelling it.
    @ViewBuilder private func retainedReview(_ session: McpRegistrationSession, _ summary: McpRegistrationSummary) -> some View {
        LabeledContent("Nome", value: summary.name)
        if let address = summary.address { LabeledContent("Endereço MCP", value: address) }
        else { LabeledContent("Tipo", value: DexterLocalization.text("Processo local", locale: locale)) }
        LabeledContent("ID da conexão", value: summary.serverID)
        McpRegistrationStatusView(session: session)
        HStack {
            if session.requiresReconciliation || session.state == .prepared {
                McpOpenRegistrationActions(state: state, session: session, summary: summary,
                    onAct: { showsOutcome = true },
                    onEdit: { editPrepared(session) },
                    onDeferred: { resetForm() })
            } else if prefill == nil, session.state != .submitting, session.scopeMatches {
                Spacer()
                Button("Cadastrar outro endereço") { resetForm() }
                    .disabled(state.working).accessibilityIdentifier("mcp.http-new")
            }
        }
    }

    private func resetForm() {
        showsOutcome = false; reviewed = nil; validationNotice = nil
        name = ""; address = ""; serverID = ""; authentication = .none; generatedID = Self.newGeneratedID()
    }

    /// Editar campos on a prepared request: it never left the app, so only that preparation is dropped (by the session) and its
    /// fields return to the form. The owner reviews again; Registrar endereço then sends one new request. The connection ID
    /// stays the one shown at review; nothing is sent here.
    private func editPrepared(_ session: McpRegistrationSession) {
        let refill = session.request.flatMap(McpRegistrationLifecyclePresentation.httpRefill)
        guard state.discardPrepared() else { return }
        showsOutcome = false; reviewed = nil
        if let refill {
            name = refill.name; address = refill.url; authentication = refill.authentication
            serverID = ""; generatedID = refill.serverID; validationNotice = nil
        } else {
            resetForm()
            validationNotice = String(localized: "Nada foi enviado. Para revisar um processo local, abra Importar… de novo.")
        }
    }

    private var authenticationHelp: String {
        if needsLoginChoice { return DexterLocalization.text("O serviço pediu login. Escolha Token de acesso ou Entrar com a conta do serviço para revisar.", locale: locale) }
        switch authentication {
        case .none: return DexterLocalization.text("Escolha só se o serviço não pede login. Se ele pedir, o Dexter avisa e mostra como cadastrar de novo com login.", locale: locale)
        case .broker: return DexterLocalization.text("Token de acesso: fica na sua configuração privada do 1Password e só é lido quando você desbloquear. Não cole chaves aqui.", locale: locale)
        case .oauth: return DexterLocalization.text("Entrar com a conta do serviço: o login começa depois, no seu navegador, quando você escolher. O Dexter não inventa ID de aplicativo nem permissões.", locale: locale)
        }
    }

    /// Several connections to one address are allowed (e.g. two accounts); the warning only prevents confusion.
    private func duplicateWarnings(_ draft: McpHttpDraft) -> [String] {
        let ids = state.servers.map(\.id), others = state.servers.filter { $0.id != draft.serverID }
        let describe: (McpServerSummary) -> String = { "“\($0.name)” (\(McpInstanceLabel.short($0.id, among: ids)))" }
        var warnings: [String] = []
        let sameAddress = others.filter { $0.destination == draft.url }
        if !sameAddress.isEmpty {
            let list = sameAddress.map(describe).joined(separator: ", ")
            warnings.append(String(localized: "Este endereço já está cadastrado como \(list). A nova conexão será independente; o Dexter não sabe qual conta cada uma usa. Para várias contas, use nomes diferentes, como Pessoal e Trabalho."))
        }
        let sameName = others.filter { $0.name == draft.name }
        if !sameName.isEmpty {
            let list = sameName.map(describe).joined(separator: ", ")
            warnings.append(String(localized: "Já existe uma conexão chamada “\(draft.name)”: \(list). Use outro nome para não confundir na lista e nos cartões."))
        }
        if let prefill { warnings.append(String(localized: "A conexão anterior (\(McpInstanceLabel.short(prefill.previousID, among: ids))) continua existindo até você removê-la.")) }
        return warnings
    }

    private func authenticationLabel(_ value: McpHttpDraft.Authentication) -> String {
        switch value {
        case .none: DexterLocalization.text("Nenhuma — serviço aberto", locale: locale)
        case .broker: DexterLocalization.text("Token de acesso (guardado no 1Password)", locale: locale)
        case .oauth: DexterLocalization.text("Entrar com a conta do serviço (OAuth)", locale: locale)
        }
    }
}

/// One plain sentence about the retained registration, a second one with the next step, and the request/receipt
/// identifiers only under Detalhes técnicos. A confirmed registration is not a login, a discovery or a permission.
private struct McpRegistrationStatusView: View {
    let session: McpRegistrationSession
    /// mcp.http-uncertain while a sent request has an open outcome (its stable manual ID), else mcp.registration-status.
    var identifier: String { session.requiresReconciliation ? "mcp.http-uncertain" : "mcp.registration-status" }
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if session.state == .submitting { ProgressView().controlSize(.small) }
                else { Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true) }
                Text(DexterLocalization.text(headline, locale: locale)).font(.callout.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail {
                Text(DexterLocalization.text(detail, locale: locale)).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let request = session.request {
                DisclosureGroup("Detalhes técnicos") {
                    McpRegistrationTechnicalRows(request: request, receipt: session.registration?.receipt ?? session.originalReceipt,
                                                 association: session.registration?.instanceState, failure: session.lastFailure)
                }
                .font(.caption)
                .accessibilityIdentifier("mcp.registration-details")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var symbol: String {
        if !session.scopeMatches { return "arrow.triangle.2.circlepath" }
        switch session.state {
        case .registered: return "checkmark.circle.fill"
        case .unknown, .legacyUnavailable: return "questionmark.circle.fill"
        case .rejected: return "xmark.circle.fill"
        case .prepared where session.lastFailure != nil: return "exclamationmark.circle.fill"
        default: return "info.circle"
        }
    }

    private var tint: Color {
        if !session.scopeMatches { return .orange }
        switch session.state {
        case .registered: return .green
        case .unknown, .legacyUnavailable: return .orange
        case .rejected: return .red
        case .prepared where session.lastFailure != nil: return .orange
        default: return .secondary
        }
    }

    private var headline: String {
        if !session.scopeMatches { return "A base mudou. Este cadastro pertence à base anterior." }
        switch session.state {
        case .idle: return "Nenhum cadastro em andamento."
        case .prepared: return session.lastFailure == nil ? "Pronto para registrar." : "Nada foi enviado."
        case .submitting: return "Registrando na base…"
        case .registered: return "Cadastro confirmado pela base."
        case .removed: return "Este cadastro foi feito, mas a conexão já foi removida."
        case .replaced: return "Este cadastro foi feito, mas a conexão foi substituída depois."
        case .unknown: return "Resultado incerto."
        case .rejected: return "A base recusou o cadastro."
        case .legacyUnavailable: return "Esta base não confirma cadastros."
        }
    }

    private var detail: String? {
        if !session.scopeMatches { return "Feche e reabra Conexões MCP. Este pedido não é enviado à nova base." }
        switch session.state {
        case .idle, .submitting: return nil
        case .prepared:
            return session.lastFailure == nil ? nil : "Não foi possível conferir a base antes do envio. Registrar envia este mesmo pedido; Editar campos volta ao formulário sem enviar nada."
        case .registered: return "Isso só salva a conexão. Login, descoberta de ferramentas e permissões dos bots continuam sendo passos seus."
        case .removed: return "Nada foi recriado. Para usar este serviço de novo, faça um novo cadastro."
        case .replaced: return "A conexão atual com este ID não é a deste pedido. Confira-a na lista antes de usar."
        case .unknown: return "A base pode ter salvo ou não. Conferir estado só consulta este mesmo pedido; nada é enviado de novo."
        case .rejected:
            switch session.lastFailure {
            case .invalidRequest: return "Nada foi salvo. Confira os campos e o tipo de login."
            case .conflict: return "Nada foi salvo. Já existe uma conexão com este ID; confira a lista."
            case .forbidden: return "Nada foi salvo. Esta operação exige o proprietário no host local."
            default: return "Nada foi salvo."
            }
        case .legacyUnavailable: return "Ela não oferece a consulta de cadastro. O Dexter não usa o caminho antigo nem envia de novo. Atualize a base e confira a lista."
        }
    }
}

/// Request and receipt identifiers, shown only under Detalhes técnicos. Support facts; not an account, login or grant.
private struct McpRegistrationTechnicalRows: View {
    let request: McpRegistrationRequest
    let receipt: McpRegistrationReceipt?
    let association: McpRegistrationObservation.InstanceState?
    let failure: McpRegistrationSession.Failure?
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            row("Pedido", request.requestID)
            if let receipt {
                row("Recibo", receipt.receiptID)
                row("Geração", receipt.generation)
                row("Registrado em", Date(timeIntervalSince1970: TimeInterval(receipt.registeredAt) / 1_000)
                    .formatted(date: .abbreviated, time: .standard))
            }
            if let association {
                row("Situação atual", DexterLocalization.text(association == .registered ? "registrada" : association == .removed ? "removida" : "substituída", locale: locale))
            }
            if let failure { row("Última falha", String(describing: failure)) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
        LabeledContent(title) { Text(verbatim: value).font(.caption.monospaced()).textSelection(.enabled) }
    }
}

/// The next steps of an open retained request, for both cadastro sheets.
/// Prepared and never sent: Registrar sends that same request; Editar campos drops only the preparation (nothing reached
/// the base) and the edit becomes a new request that is reviewed again. Sent with an open outcome: Conferir estado reads
/// the same request; Deixar consulta para depois…, after a short confirmation, moves it to Consultas guardadas. Nothing
/// here resends, cancels, rolls back or takes the effect as absent.
private struct McpOpenRegistrationActions: View {
    @Bindable var state: McpConnectionsState
    let session: McpRegistrationSession
    let summary: McpRegistrationSummary
    let onAct: () -> Void
    let onEdit: () -> Void
    let onDeferred: () -> Void
    @Environment(\.locale) private var locale
    @State private var confirmingDefer = false

    private var blocked: Bool { state.working || !state.canRead || !session.scopeMatches }

    var body: some View {
        if session.requiresReconciliation {
            Button("Deixar consulta para depois…") { confirmingDefer = true }
                .disabled(blocked).accessibilityIdentifier("mcp.registration-defer")
            Spacer()
            Button("Conferir estado") { onAct(); Task { await state.checkRegistration() } }
                .disabled(blocked).accessibilityIdentifier("mcp.http-reconcile")
                .alert("Deixar a consulta para depois?", isPresented: $confirmingDefer) {
                    Button("Cancelar", role: .cancel) {}.keyboardShortcut(.defaultAction)
                    Button("Deixar para depois") { if state.deferUncertain() { onDeferred() } }
                        .accessibilityIdentifier("mcp.registration-defer-confirm")
                } message: {
                    Text(DexterLocalization.format("Isso não cancela o cadastro de “%@”: a base pode já tê-lo salvo. O pedido fica em Consultas guardadas, na lateral de Conexões MCP, enquanto o app estiver aberto. Você poderá cadastrar outro endereço; este ID de conexão continua reservado até a consulta fechar.", summary.name, locale: locale))
                }
        } else if session.state == .prepared, !session.mutationSent {
            Button("Editar campos") { onEdit() }
                .disabled(blocked).accessibilityIdentifier("mcp.http-edit")
            Spacer()
            Button("Registrar") { onAct(); Task { await state.submitPrepared() } }
                .disabled(blocked).accessibilityIdentifier("mcp.http-register")
        }
    }
}

/// A new registration with a connection ID whose earlier request is still open waits for that request. Plain words and
/// the way back to it; the app never switches to another ID by itself.
private struct McpSameIDWaiting: View {
    let item: McpDeferredRegistration
    let onShow: () -> Void
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(DexterLocalization.format("O cadastro anterior de “%@”, com este mesmo ID de conexão, ainda tem resultado em aberto. Confira esse pedido antes; o Dexter não troca o ID sozinho.", McpRegistrationSummary(item.request)?.name ?? item.request.serverID, locale: locale), systemImage: "clock.badge.questionmark")
                .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            Button("Ver em Consultas guardadas") { onShow() }.accessibilityIdentifier("mcp.registration-deferred-open")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.instance-still-uncertain")
    }
}

/// One request left for later, compact: name, connection ID, literal state, its own read and IDs on demand.
private struct McpDeferredRow: View {
    @Bindable var state: McpConnectionsState
    let item: McpDeferredRegistration
    let highlighted: Bool
    @Environment(\.locale) private var locale

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: McpRegistrationSummary(item.request)?.name ?? item.request.serverID).font(.callout.weight(.medium)).lineLimit(2)
            Text(verbatim: "ID " + McpInstanceLabel.short(item.request.serverID)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 4) {
                if state.registration?.readingDeferredRequestID == item.id { ProgressView().controlSize(.mini) }
                else { Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true) }
                Text(DexterLocalization.text(McpRegistrationLifecyclePresentation.deferredStatus(item), locale: locale))
                    .font(.caption).fixedSize(horizontal: false, vertical: true)
            }
            if item.isUnresolved {
                Button("Conferir este pedido") { Task { await state.checkDeferred(item.id) } }
                    .controlSize(.small)
                    .disabled(state.working || !state.canRead || state.registration?.scopeMatches != true)
                    .accessibilityIdentifier("mcp.registration-deferred-check")
            }
            DisclosureGroup("Detalhes técnicos") {
                McpRegistrationTechnicalRows(request: item.request, receipt: item.registration?.receipt ?? item.originalReceipt,
                                             association: item.registration?.instanceState, failure: item.lastFailure)
            }
            .font(.caption)
            .accessibilityIdentifier("mcp.registration-details")
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((highlighted ? Color.orange.opacity(0.14) : Color.secondary.opacity(0.07)), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.registration-deferred-row.\(item.id)")
    }

    private var symbol: String {
        if item.isUnresolved { return "questionmark.circle.fill" }
        return item.state == .registered ? "checkmark.circle.fill" : "info.circle"
    }
    private var tint: Color {
        if item.isUnresolved { return .orange }
        return item.state == .registered ? .green : .secondary
    }
}

private struct McpImportView: View {
    @Bindable var state: McpConnectionsState
    /// Closes this sheet and shows one request in Consultas guardadas of the manager.
    let onShowDeferred: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var format = "claude_json"
    @State private var content = ""
    @State private var fileNotice: String?
    @State private var executables: [String: URL] = [:]
    /// Review facts of each local executable (size and SHA-256 read now on this Mac). Display only: the base does not pin it.
    @State private var executableFacts: [String: McpExecutableFacts] = [:]
    /// Set when this sheet sends an import, so its outcome shows here instead of an older one.
    @State private var showsOutcome = false
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Importar configuração MCP").font(.title2.weight(.semibold))
            if showsOutcome, let session = state.registration, session.request != nil {
                McpRegistrationStatusView(session: session)
                if session.requiresReconciliation || session.state == .prepared, let summary = state.registrationSummary {
                    // Editar campos here drops only the unsent preparation: the preview stays, and Adicionar is a new request.
                    HStack {
                        McpOpenRegistrationActions(state: state, session: session, summary: summary,
                            onAct: { showsOutcome = true },
                            onEdit: { if state.discardPrepared() { showsOutcome = false } },
                            onDeferred: { showsOutcome = false })
                    }
                }
            }
            if let preview = state.preview {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(preview.servers) { server in
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text(server.sourceName).fontWeight(.semibold)
                                    Spacer()
                                    Button("Adicionar") { showsOutcome = true; Task { await state.add(server, executable: executables[server.id]) } }
                                        .disabled(!state.canStartRegistration || server.draft == nil || needsExecutable(server) || state.servers.contains(where: { $0.id == server.proposedId })
                                            || waiting(server) != nil)
                                }
                                if let open = waiting(server) {
                                    McpSameIDWaiting(item: open) { onShowDeferred(open.id) }
                                }
                                if let destination = executables[server.id]?.path ?? server.command ?? server.endpoint { Text(destination).font(.callout).textSelection(.enabled) }
                                if server.transport == "stdio" { localProcessReview(server) }
                                if let command = server.command, !command.hasPrefix("/"), server.draft != nil {
                                    Text("Escolha o executável local deste comando antes de adicionar.").font(.caption).foregroundStyle(.secondary)
                                    Button("Escolher executável…") { chooseExecutable(for: server) }.disabled(state.busy)
                                }
                                if !server.credentialSlots.isEmpty {
                                    Text(DexterLocalization.text("Credenciais necessárias", locale: locale) + ": " + server.credentialSlots.map(\.name).joined(separator: ", ")).font(.callout)
                                }
                                ForEach(Array(server.notes.enumerated()), id: \.offset) { _, note in Text(note).font(.caption).foregroundStyle(.secondary) }
                            }
                            Divider()
                        }
                        if preview.servers.isEmpty { Text("Nenhum servidor encontrado nesta configuração.") }
                        ForEach(Array(preview.notes.enumerated()), id: \.offset) { _, note in Text(note).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                Text("Adicionar salva a configuração revisada como um cadastro novo, confirmado pela base. O servidor só inicia quando você escolher conectar.").font(.callout).foregroundStyle(.secondary)
            } else {
                Picker("Formato", selection: $format) {
                    Text("Claude · JSON").tag("claude_json")
                    Text("Codex · TOML").tag("codex_toml")
                }
                Text("Cole a configuração ou escolha um arquivo. Valores de credenciais não serão importados.").font(.callout).foregroundStyle(.secondary)
                TextEditor(text: $content).font(.system(.callout, design: .monospaced)).frame(maxHeight: .infinity).border(.separator)
                    .accessibilityIdentifier("mcp.import-content")
                HStack {
                    Button("Escolher arquivo…") { chooseFile() }
                    Spacer()
                    Button("Ver prévia") {
                        let input = content; content = ""
                        Task { await state.previewImport(format: format, content: input) }
                    }.disabled(state.busy || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.utf8.count > 1_000_000)
                        .accessibilityIdentifier("mcp.import-preview")
                }
            }
            if let notice = fileNotice ?? state.notice { Text(DexterLocalization.text(notice, locale: locale)).font(.callout).foregroundStyle(.orange) }
            Spacer(minLength: 0)
            HStack {
                if state.preview != nil { Button("Outra configuração") { state.preview = nil; fileNotice = nil; executables = [:] } }
                if state.working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Concluir") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24).frame(minWidth: 560, idealWidth: 640, maxWidth: .infinity, minHeight: 460, idealHeight: 540, maxHeight: .infinity)
        .onAppear { state.preview = nil }
        .onDisappear { content = ""; state.preview = nil }
    }

    private func chooseFile() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: 1_000_001) ?? Data()
            guard data.count <= 1_000_000, let text = String(data: data, encoding: .utf8) else { throw HostClientError.invalidRequest }
            content = text; fileNotice = nil
        } catch { fileNotice = String(localized: "Escolha um arquivo UTF-8 de até 1 MB.") }
    }

    /// The open request left for later with the connection ID this definition would register, if any.
    private func waiting(_ server: McpImportedServer) -> McpDeferredRegistration? {
        guard case .object(let definition)? = server.draft, case .string(let id)? = definition["id"] else { return nil }
        return state.unresolvedDeferred(serverID: id)
    }

    private func needsExecutable(_ server: McpImportedServer) -> Bool {
        guard let command = server.command, !command.hasPrefix("/") else { return false }
        return executables[server.id] == nil
    }

    private func chooseExecutable(for server: McpImportedServer) {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            fileNotice = String(localized: "Escolha um arquivo executável."); return
        }
        executables[server.id] = url; fileNotice = nil
        executableFacts[server.id] = nil
        let id = server.id
        Task {
            let facts = await Task.detached(priority: .userInitiated) { McpExecutableFacts.read(url) }.value
            if executables[id] == url { executableFacts[id] = facts }
        }
    }

    /// A local process is code that runs on this Mac: its boundary is stated before Adicionar, with the executable that
    /// would run and what the app could read about it now. Origin, version and license are not read by Dexter.
    @ViewBuilder private func localProcessReview(_ server: McpImportedServer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(ConnectionsPresentation.stdioBoundary(portuguese: portuguese), systemImage: "exclamationmark.shield")
                .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            if let url = executables[server.id] {
                if let facts = executableFacts[server.id] {
                    Text(verbatim: facts.summary(path: url.path, portuguese: portuguese))
                        .font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                } else {
                    ProgressView().controlSize(.mini)
                }
            }
            Text(verbatim: t("Origem, versão e licença: não informadas. A base fixa o SHA-256 do executável e dos scripts nomeados e confere antes de iniciar; mudança exige revisão. Dependências externas não são fixadas. Iniciar o processo pede sua confirmação depois.",
                             "Origin, version and license: not reported. The host pins the executable and named scripts with SHA-256 and checks before launch; changes require review. External dependencies are not pinned. Starting the process asks for your confirmation later."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.import-stdio-review")
    }
}

/// What this Mac can read now about one chosen executable: size and SHA-256 of its bytes. A review aid; the host
/// separately binds and re-checks its canonical command pin before launch.
struct McpExecutableFacts: Equatable, Sendable {
    let bytes: Int64?
    let sha256: String?

    static func read(_ url: URL, limit: Int64 = 512 * 1_024 * 1_024) -> McpExecutableFacts {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
        guard let size, size <= limit, let handle = try? FileHandle(forReadingFrom: url) else { return McpExecutableFacts(bytes: size, sha256: nil) }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try? handle.read(upToCount: 1_048_576), !chunk.isEmpty { hasher.update(data: chunk) }
        return McpExecutableFacts(bytes: size, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined())
    }

    func summary(path: String, portuguese: Bool) -> String {
        let size = bytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "?"
        let digest = sha256 ?? (portuguese ? "não calculado" : "not computed")
        return portuguese
            ? "Executável: \(path)\nTamanho: \(size) · SHA-256 (lido agora): \(digest)"
            : "Executable: \(path)\nSize: \(size) · SHA-256 (read now): \(digest)"
    }
}
/// After an approved `mcp.authorize`: the host's setup request for the same action (`setup_<actionId>`). Sign-in, discovery
/// and this bot's tool selection stay the steps above; once the bot holds tools on this instance, Permitir e continuar
/// completes the request with exactly those tools (fresh gateway pins), so the original task resumes once without a new
/// message. Recusar makes it inert. Nothing here grants, discovers or signs in; every outcome is read back by GET.
private struct NativeSetupCompletionPanel: View {
    let actionID: String
    let client: HostClient
    /// Changes when the sign-in, the server status or this bot's saved selection changes: the request is read again.
    let refreshKey: String
    @Environment(\.locale) private var locale
    @State private var editor: ManagedConnectAppsEditor?
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
    private var workflowID: String { ManagedConnectAppsEditor.nativeSetupRequestID(actionID: actionID) }

    var body: some View {
        Group {
            if let editor, let workflow = editor.setupRequests?.first(where: { $0.id == workflowID }) {
                content(editor, workflow)
            }
        }
        .task(id: refreshKey) {
            if editor == nil { editor = ManagedConnectAppsEditor(client: client, ownsClient: false, scope: "native-setup-" + actionID) }
            guard let editor else { return }
            await editor.loadSetupRequest(id: workflowID)
            if let workflow = editor.setupRequests?.first(where: { $0.id == workflowID }), workflow.state.isOpen { await editor.loadChoices(workflow) }
        }
        .onDisappear { editor?.close(); editor = nil }
    }

    @ViewBuilder private func content(_ editor: ManagedConnectAppsEditor, _ workflow: ConnectionWorkflow) -> some View {
        let held = (editor.setupChoices[workflow.id]?.choices ?? []).compactMap { choice -> ManagedConnectAppsEditor.SetupSelection? in
            let names = choice.tools.filter(\.enabled).map(\.name)
            return names.isEmpty ? nil : ManagedConnectAppsEditor.SetupSelection(connectionID: choice.connectionId, toolNames: names)
        }
        VStack(alignment: .leading, spacing: 6) {
            Label(workflow.state.isOpen
                  ? t("Pedido do bot aberto: depois de entrar, descobrir e salvar as ferramentas, conclua aqui para a tarefa continuar.",
                      "The bot's request is open: after signing in, discovering and saving the tools, finish here so the task continues.")
                  : ManagedConnectAppsNoticeCopy.workflowStateText(workflow.state, portuguese: portuguese),
                  systemImage: workflow.state.isOpen ? "arrow.triangle.turn.up.right.circle" : "checkmark.circle")
                .font(.callout).fixedSize(horizontal: false, vertical: true)
            if workflow.state.isOpen {
                if held.count > 5 {
                    Text(verbatim: t("Só as 5 primeiras conexões com ferramentas entram neste pedido; as outras ficam como estão.",
                                     "Only the first 5 connections with tools enter this request; the others stay as they are."))
                        .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                if held.isEmpty {
                    Text(verbatim: t("Este bot ainda não tem ferramentas salvas nesta conexão.", "This bot has no saved tools on this connection yet."))
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(verbatim: t("Confirma para o bot: ", "Confirms for the bot: ") + held.flatMap(\.toolNames).joined(separator: ", "))
                        .font(.caption.monospaced()).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    if editor.pendingWorkflow?.workflowID == workflow.id {
                        Button(t("Conferir", "Check")) { Task { await editor.checkWorkflow() } }
                            .disabled(editor.busy).accessibilityIdentifier("mcp.setup-request.check")
                    }
                    Button(t("Recusar pedido", "Decline request")) { Task { await editor.cancelSetupRequest(workflow) } }
                        .disabled(editor.busy || editor.pendingWorkflow != nil)
                        .accessibilityIdentifier("mcp.setup-request.decline")
                    Spacer()
                    Button(t("Permitir e continuar", "Allow and continue")) { Task { await editor.allowAndContinue(workflow, selections: Array(held.prefix(5))) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(held.isEmpty || editor.busy || editor.pendingWorkflow != nil)
                        .accessibilityIdentifier("mcp.setup-request.allow")
                }
            }
            if let notice = editor.notice, !ManagedConnectAppsNoticeCopy.text(notice, locale: locale).isEmpty {
                Text(verbatim: ManagedConnectAppsNoticeCopy.text(notice, locale: locale))
                    .font(.caption).foregroundStyle(ManagedConnectAppsNoticeCopy.isCalm(notice) ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mcp.setup-request")
    }
}

#endif
