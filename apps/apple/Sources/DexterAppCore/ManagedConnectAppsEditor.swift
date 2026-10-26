import DexterHostClient
import Foundation
import Observation

/// "Conectar apps" (managed app connections) for this Mac's owner base. Real contract only (`Connections.swift`):
/// status, catalog and accounts are read from the host; a login is ONE authorization request whose official page opens in
/// the browser, and its outcome is only ever read back (GET by the same request id). A label change is CAS on the account
/// revision with an exact receipt; an unknown outcome is settled by reading that receipt. Nothing here grants a bot
/// anything, invents a platform, a key or an account, or claims an identity the provider did not verify.
@MainActor @Observable public final class ManagedConnectAppsEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, offline, hostChanged, catalogChanged
        case authorizationUnknown, authorizationEnded(ConnectionAuthorizationState, ConnectionAuthorizationReason?), connected
        case labelSaved, labelUnknown, labelConflict, labelRefused
        /// Bot access of one account (CAS on its revision + exact receipt). `accessSuperseded`: the host committed the
        /// request but the account or a grant changed afterwards, so it is not the access in place now.
        case accessSaved(enabled: Bool), accessUnknown, accessConflict, accessRefused, accessSuperseded
        /// Disconnect of one account: settled by its receipt or by the account read showing it disconnected.
        case disconnected(ConnectionUpstreamDisconnect?), disconnectUnknown, disconnectInProgress, disconnectConflict, disconnectRefused
        /// A reconnection finished with a new account; nothing was carried over from the previous one.
        case reconnected
        /// Setup requests (connection workflows): completed (with or without a host continuation), ended otherwise,
        /// pins the host does not publish yet, uncertain/conflicting/refused outcomes, and a GET showing nothing applied.
        case workflowCompleted(continued: Bool), workflowEnded(ConnectionWorkflowState), workflowPinsUnavailable
        case workflowAccessSavedWithoutContinuation, workflowListIncomplete
        case workflowUnknown, workflowConflict, workflowRefused, workflowNotApplied
        /// A chosen tool is not granted to the request's bot (native tools are chosen in the native manager).
        case workflowNothingGranted
    }

    public private(set) var status: ConnectionsStatus?
    public private(set) var catalog: ConnectionCatalog?
    public private(set) var accounts: [ConnectionAccount] = []
    /// The owner's login request whose outcome is still open; every check reads it by the same id.
    public private(set) var pendingAuthorization: StartConnectionAuthorizationInput?
    /// A login of a setup request read back after reopening (no input of this window): checked by the same id only.
    public private(set) var resumedAuthorizationID: String?
    /// Login attempts this editor saw end (connected, failed, expired, cancelled, mismatch, never started). They are never
    /// offered for "Retomar login…" again; a new explicit Conectar starts a new attempt for the same request.
    public private(set) var endedAuthorizationIDs: Set<String> = []
    /// Requests whose choices could not be read (other than "unavailable"): shown with a retry, never a spinner forever.
    public private(set) var choicesReadFailed: Set<String> = []
    public private(set) var authorization: ConnectionAuthorization?
    public private(set) var pendingLabel: PendingLabel?
    /// The one access change whose outcome is open; `checkAccess()` reads its receipt by the same id.
    public private(set) var pendingAccess: PendingAccess?
    /// The one disconnect whose outcome is open; `checkDisconnect()` reads its receipt, then the account.
    public private(set) var pendingDisconnect: PendingDisconnect?
    /// The account a running reconnection replaces (`replacesAccountId`) and the bots that used it, for the review after.
    public private(set) var reconnecting: ReconnectSource?
    /// After a reconnection: the new account and the bots of the previous one. Nothing is pre-selected or migrated.
    public private(set) var reconnectReview: ReconnectReview?
    /// Native MCP connections of this base (read-only here; operations stay in Conexão personalizada). Nil until read
    /// or when the read failed; never a claim that there are none.
    public private(set) var nativeServers: [McpServerSummary]?
    /// Public credential metadata per native connection that uses sign-in (GET only, never values).
    public private(set) var nativeCredentials: [String: McpCredentialStatus] = [:]
    /// Setup requests of this base, newest last. Nil when unread or when this base has no such route (`setupRequestsSupported`).
    public private(set) var setupRequests: [ConnectionWorkflow]?
    public private(set) var setupRequestsSupported: Bool?
    /// Current choices per request id (GET only; re-read before every completion).
    public private(set) var setupChoices: [String: ConnectionWorkflowChoices] = [:]
    /// False when this base answered the choices route as unavailable (503); nil until asked.
    public private(set) var choicesSupported: Bool?
    /// The one complete/cancel of a setup request whose outcome is open; settled only by `checkWorkflow()` (GET).
    public private(set) var pendingWorkflow: PendingWorkflow?
    /// Serializes the entire review chain, including its GETs before and after granting access.
    public private(set) var workflowChainInProgress = false
    public private(set) var busy = false
    public private(set) var notice: Notice?
    /// When the base last answered a full read. With `reachable` false the lists are that snapshot, shown read-only.
    public private(set) var lastReadAt: Date?
    /// False after a read found the base offline: the last snapshot stays visible and every change is refused here.
    public private(set) var reachable = true
    /// `DexterAppModel.filesScope` at creation; the UI drops the editor when the window's base changes.
    public let scope: String
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let ownsClient: Bool
    @ObservationIgnored private var hostID: String?
    @ObservationIgnored private var closed = false

    public struct PendingLabel: Equatable, Sendable {
        public let accountID: String
        public let input: SetConnectionLabelInput
    }
    public struct PendingAccess: Equatable, Sendable {
        public let accountID: String
        public let input: SetConnectionBotAccessInput
    }
    public struct PendingDisconnect: Equatable, Sendable {
        public let accountID: String
        public let input: DisconnectConnectionAccountInput
    }
    public struct PendingWorkflow: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case complete(CompleteConnectionWorkflowInput), cancel(CancelConnectionWorkflowInput) }
        public let workflowID: String
        public let kind: Kind
        public var expectedRevision: Int {
            switch kind { case .complete(let input): input.expectedRevision; case .cancel(let input): input.expectedRevision }
        }
    }
    public struct ReconnectSource: Equatable, Sendable {
        public let previousAccountID: String
        public let serviceID: String
        public let previousBotIDs: [String]
    }
    public struct ReconnectReview: Equatable, Sendable {
        /// Identity equivalence between the two accounts. Only a host contract can prove it; none exists today, so the
        /// review never pre-selects bots. `identityChanged` compares display names and is not proof.
        public enum Equivalence: Equatable, Sendable { case unproven, different }
        public let previousAccountID: String
        public let newAccountID: String
        public let previousBotIDs: [String]
        public let equivalence: Equivalence
    }

    public init(client: HostClient, ownsClient: Bool, scope: String) {
        self.client = client; self.ownsClient = ownsClient; self.scope = scope
    }

    /// What this client may read or change (owner loopback: everything; paired: the owner-granted scopes only).
    public var canReadConnections: Bool { client.connectionsAccess.read }
    public var canManageConnections: Bool { client.connectionsAccess.manage && reachable }
    public var canReadMcp: Bool { client.connectionsAccess.mcpRead }
    /// True for a paired base read through the paired channel (private custody stays on the owner's Mac).
    public var isRemote: Bool { if case .pairedHost = client.accessPolicy { true } else { false } }

    public var platform: ConnectionPlatformState? { status?.platform }
    /// Managed accounts plus the read-only projection of direct (native MCP) OAuth connections.
    public var managedAccounts: [ConnectionAccount] { accounts.filter { $0.manage == .connections } }
    public var directAccounts: [ConnectionAccount] { accounts.filter { $0.manage == .nativeMCP } }

    private func record(_ error: Error) {
        switch error as? HostClientError {
        case .offline?, .notReady?: notice = .offline; reachable = false
        default: notice = .loadFailed
        }
    }
    private func accept(_ value: String) -> Bool {
        if let hostID, hostID != value { notice = .hostChanged; return false }
        hostID = value; return true
    }

    /// Status first; the catalog only when the platform is available; accounts always (direct connections may exist
    /// without a managed platform).
    public func reload() async {
        guard !closed, !busy, canReadConnections else { return }
        busy = true; defer { busy = false }
        do {
            let status = try await client.connectionsStatus()
            guard accept(status.hostId) else { return }
            self.status = status
            if status.platform == .available {
                let catalog = try await client.connectionsCatalog()
                guard catalog.hostId == status.hostId else { notice = .hostChanged; return }
                self.catalog = catalog
            } else {
                catalog = nil
            }
            let accounts = try await client.connectionAccounts()
            guard accounts.hostId == status.hostId else { notice = .hostChanged; return }
            self.accounts = accounts.items
            lastReadAt = Date(); reachable = true
            if [.loadFailed, .offline].contains(notice) { notice = nil }
        } catch { record(error) }
    }

    /// One login request for a service the current catalog lists as available. Returns the official https page to open
    /// in the browser, or nil (the notice says why). An unknown outcome keeps the request for `checkAuthorization()`.
    /// `setupRequestID`: the awaiting setup request this login answers; the host checks its service/catalog and derives
    /// the profile from the request's bot. It grants nothing: access is still chosen and confirmed afterwards.
    public func startAuthorization(serviceID: String, setupRequestID: String? = nil) async -> URL? {
        guard !closed, !busy, pendingAuthorization == nil, status?.platform == .available, let catalog, catalog.pin != nil,
              let entry = catalog.services.first(where: { $0.serviceId == serviceID }), entry.availability.state == .available else { return nil }
        if let setupRequestID {
            guard let request = setupRequests?.first(where: { $0.id == setupRequestID }), request.state.isOpen,
                  case .managed(let service, let pin) = request.target, service == serviceID, pin == catalog.pin else { notice = .catalogChanged; return nil }
        }
        if let resumedAuthorizationID {
            // A lost GET does not prove this login ended. The new Connect gesture recovers this exact attempt.
            guard let setupRequestID, setupChoices[setupRequestID]?.authorizationRequestIds.contains(resumedAuthorizationID) == true else { return nil }
            return await checkAuthorization()
        }
        reconnecting = nil
        return await begin(StartConnectionAuthorizationInput(catalog: catalog, serviceId: serviceID, setupRequestId: setupRequestID))
    }

    /// Retomar login: after this window closed, the login already started for a setup request is read back by its own
    /// request id (GET). It never creates another provider link.
    public func resumeAuthorization(clientRequestID: String) async -> URL? {
        guard !closed, !busy, canManageConnections, pendingAuthorization == nil, resumedAuthorizationID == nil else { return nil }
        resumedAuthorizationID = clientRequestID
        reconnecting = nil
        return await checkAuthorization()
    }

    /// Statuses whose recovery is a new sign-in that replaces the account.
    public static func offersReconnect(_ account: ConnectionAccount) -> Bool {
        account.manage == .connections && [.needsReconnect, .identityMismatch].contains(account.status)
    }

    /// Reconectar: one new authorization request for the same service and profile with `replacesAccountId`. It is a new,
    /// identified sign-in, never a retry of an action. When it connects, the new account starts with no bot: the bots of
    /// the previous account are listed for a new choice, not carried over.
    public func reconnect(_ account: ConnectionAccount) async -> URL? {
        guard !closed, !busy, pendingAuthorization == nil, Self.offersReconnect(account), account.hostId == hostID,
              status?.platform == .available, let catalog, catalog.pin != nil,
              let entry = catalog.services.first(where: { $0.serviceId == account.serviceId }), entry.availability.state == .available else { return nil }
        reconnecting = ReconnectSource(previousAccountID: account.id, serviceID: account.serviceId,
                                       previousBotIDs: account.bots.filter { $0.access != .disabled }.map(\.botId))
        reconnectReview = nil
        return await begin(StartConnectionAuthorizationInput(catalog: catalog, serviceId: account.serviceId, profileId: account.profileId,
                                                             label: account.label, replacesAccountId: account.id))
    }

    private func begin(_ input: StartConnectionAuthorizationInput) async -> URL? {
        guard canManageConnections else { return nil }
        pendingAuthorization = input
        busy = true
        do {
            let value = try await client.startConnectionAuthorization(input)
            busy = false
            guard accept(value.hostId) else { return nil }
            return absorb(value)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .authorizationUnknown; return nil
        } catch HostClientError.conflict {
            busy = false; pendingAuthorization = nil; reconnecting = nil; notice = .catalogChanged; await reload(); return nil
        } catch {
            busy = false; pendingAuthorization = nil; reconnecting = nil; record(error); return nil
        }
    }

    /// Reads the pending login by its own request id (never starts another). Returns the page again while it still waits.
    @discardableResult
    public func checkAuthorization() async -> URL? {
        guard !closed, !busy, let pendingID = pendingAuthorization?.clientRequestId ?? resumedAuthorizationID else { return nil }
        busy = true
        do {
            let value = try await client.connectionAuthorization(clientRequestID: pendingID)
            busy = false
            guard accept(value.hostId) else { return nil }
            return absorb(value)
        } catch HostClientError.notFound {
            // The host has no such request: it never started. Nothing is retried; the owner may start again.
            endedAuthorizationIDs.insert(pendingID)
            busy = false; pendingAuthorization = nil; resumedAuthorizationID = nil; authorization = nil; reconnecting = nil
            notice = .authorizationEnded(.failed, .notStarted); return nil
        } catch {
            busy = false; notice = .authorizationUnknown; return nil
        }
    }

    private func absorb(_ value: ConnectionAuthorization) -> URL? {
        authorization = value
        if value.state.isTerminal { endedAuthorizationIDs.insert(value.clientRequestId) }
        switch value.state {
        case .connected:
            pendingAuthorization = nil; resumedAuthorizationID = nil
            if let source = reconnecting, value.replacesAccountId == source.previousAccountID, let newAccount = value.accountId {
                reconnectReview = ReconnectReview(previousAccountID: source.previousAccountID, newAccountID: newAccount,
                                                  previousBotIDs: source.previousBotIDs, equivalence: .unproven)
                notice = .reconnected
            } else {
                notice = .connected
            }
            reconnecting = nil
            let settled = notice
            Task { await reload(); if notice == nil { notice = settled } }
            return nil
        case .failed, .expired, .cancelled, .mismatch:
            pendingAuthorization = nil; resumedAuthorizationID = nil; reconnecting = nil; notice = .authorizationEnded(value.state, value.reason); return nil
        case .unknown:
            notice = .authorizationUnknown; return nil
        case .starting, .awaitingUser, .verifying:
            if notice == .authorizationUnknown { notice = nil }
            return value.authorizationPage
        }
    }

    /// Forget a finished or never-started login locally (nothing is sent).
    public func dismissAuthorization() {
        guard let authorization, authorization.state.isTerminal || (pendingAuthorization == nil && resumedAuthorizationID == nil) else { return }
        self.authorization = nil; pendingAuthorization = nil; resumedAuthorizationID = nil; reconnecting = nil
    }

    /// Closes the post-reconnection list locally (nothing is sent; the bots keep no access to the new account).
    public func dismissReconnectReview() { reconnectReview = nil }

    /// Owner label (CAS on the account revision + exact receipt). Managed accounts only.
    public func setLabel(_ account: ConnectionAccount, to label: String) async {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !closed, !busy, canManageConnections, pendingLabel == nil, account.manage == .connections, account.hostId == hostID,
              !trimmed.isEmpty, trimmed != account.label else { return }
        let input = SetConnectionLabelInput(account: account, label: trimmed)
        pendingLabel = PendingLabel(accountID: account.id, input: input)
        busy = true
        do {
            _ = try await client.setConnectionLabel(accountID: account.id, input)
            busy = false; pendingLabel = nil; notice = .labelSaved; await reload(); notice = .labelSaved
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .labelUnknown
        } catch HostClientError.conflict {
            busy = false; pendingLabel = nil; notice = .labelConflict; await reload(); notice = .labelConflict
        } catch HostClientError.invalidRequest {
            busy = false; pendingLabel = nil; notice = .labelRefused
        } catch {
            busy = false; pendingLabel = nil; record(error)
        }
    }

    /// Reads the original receipt of the pending label change (GET only). Nil keeps it unconfirmed.
    public func checkLabel() async {
        guard !closed, !busy, let pending = pendingLabel else { return }
        busy = true
        let receipt = try? await client.connectionReceipt(clientRequestID: pending.input.clientRequestId)
        busy = false
        if let receipt, receipt.kind == .label, receipt.accountId == pending.accountID, receipt.hostId == pending.input.expectedHostID,
           receipt.label == pending.input.label, receipt.previousRevision == pending.input.expectedRevision {
            pendingLabel = nil; notice = .labelSaved; await reload(); notice = .labelSaved
        } else {
            notice = .labelUnknown
        }
    }

    // MARK: Bot access (Quem pode usar)

    /// One bot on or off for one managed account: CAS on the account revision, one PATCH, exact receipt. Turning a bot on
    /// gives it `ask` on every pinned tool of the account (each call still follows the bot's approval mode); it needs a
    /// connected account. An unknown outcome is settled only by `checkAccess()`.
    public func setAccess(_ account: ConnectionAccount, botID: String, enabled: Bool, toolNames: [String]? = nil) async {
        guard !closed, !busy, canManageConnections, pendingAccess == nil, pendingDisconnect?.accountID != account.id, account.manage == .connections,
              account.hostId == hostID, !enabled || account.status == .connected else { return }
        if let toolNames { guard enabled, !toolNames.isEmpty, Set(toolNames).isSubset(of: Set(account.tools.map(\.name))) else { return } }
        let input = SetConnectionBotAccessInput(account: account, botId: botID, enabled: enabled, toolNames: toolNames)
        pendingAccess = PendingAccess(accountID: account.id, input: input)
        busy = true
        do {
            let receipt = try await client.setConnectionBotAccess(accountID: account.id, input)
            busy = false; pendingAccess = nil; await reload(); notice = Self.notice(for: receipt)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .accessUnknown
        } catch HostClientError.conflict {
            busy = false; pendingAccess = nil; await reload(); notice = .accessConflict
        } catch HostClientError.invalidRequest {
            busy = false; pendingAccess = nil; notice = .accessRefused
        } catch {
            busy = false; pendingAccess = nil; record(error)
        }
    }

    /// Reads the original receipt of the open access change (GET only). Nil keeps it unconfirmed.
    public func checkAccess() async {
        guard !closed, !busy, let pending = pendingAccess else { return }
        busy = true
        let receipt = try? await client.connectionReceipt(clientRequestID: pending.input.clientRequestId)
        busy = false
        if let receipt, receipt.isReceipt(of: pending.input, accountID: pending.accountID) {
            // Any terminal outcome settles the request; only `applied` means the access is in place. Nothing is re-sent;
            // a new change needs a new explicit gesture (a new request id).
            pendingAccess = nil; await reload(); notice = Self.notice(for: receipt)
        } else {
            notice = .accessUnknown
        }
    }

    /// Plain outcome of a terminal access receipt: saved only when applied.
    static func notice(for receipt: ConnectionReceipt) -> Notice {
        switch receipt.effectiveAccessOutcome {
        case .applied: return .accessSaved(enabled: receipt.access?.enabled ?? false)
        case .notApplied: return .accessConflict
        case .superseded: return .accessSuperseded
        }
    }

    // MARK: Disconnect

    /// Desconectar: CAS on the account revision, local revocation first, then one provider delete. The receipt says what
    /// the provider answered; a revocation is "requested", never shown as confirmed. Other accounts do not change.
    public func disconnect(_ account: ConnectionAccount) async {
        guard !closed, !busy, canManageConnections, pendingDisconnect == nil, pendingAccess?.accountID != account.id, account.manage == .connections,
              account.hostId == hostID, ![.disconnected, .disconnecting, .replaced].contains(account.status) else { return }
        let input = DisconnectConnectionAccountInput(account: account)
        pendingDisconnect = PendingDisconnect(accountID: account.id, input: input)
        busy = true
        do {
            let receipt = try await client.disconnectConnectionAccount(accountID: account.id, input)
            busy = false; pendingDisconnect = nil; await reload(); notice = .disconnected(receipt.disconnect)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .disconnectUnknown
        } catch HostClientError.conflict {
            busy = false; pendingDisconnect = nil; await reload(); notice = .disconnectConflict
        } catch HostClientError.invalidRequest {
            busy = false; pendingDisconnect = nil; notice = .disconnectRefused
        } catch {
            busy = false; pendingDisconnect = nil; record(error)
        }
    }

    /// Reads the original receipt; without one, reads the account itself. Only a receipt or a `disconnected` account
    /// settles it; `disconnecting` or anything else keeps the outcome open. Nothing is sent again.
    public func checkDisconnect() async {
        guard !closed, !busy, let pending = pendingDisconnect else { return }
        busy = true
        let receipt = try? await client.connectionReceipt(clientRequestID: pending.input.clientRequestId)
        if let receipt, receipt.kind == .disconnect, receipt.accountId == pending.accountID, receipt.hostId == pending.input.expectedHostID,
           receipt.previousRevision == pending.input.expectedRevision {
            busy = false; pendingDisconnect = nil; await reload(); notice = .disconnected(receipt.disconnect); return
        }
        let account = try? await client.connectionAccount(id: pending.accountID)
        busy = false
        guard let account, account.hostId == pending.input.expectedHostID else { notice = .disconnectUnknown; return }
        switch account.status {
        case .disconnected:
            pendingDisconnect = nil; await reload(); notice = .disconnected(account.disconnect)
        case .disconnecting:
            notice = .disconnectInProgress
        default:
            notice = .disconnectUnknown
        }
    }

    // MARK: Setup requests (pedidos dos bots)

    /// Requests still waiting for the owner and not expired by their own deadline.
    public func openSetupRequests(now: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)) -> [ConnectionWorkflow] {
        (setupRequests ?? []).filter { $0.state.isOpen && $0.expiresAt > now && $0.hostId == hostID }
    }

    /// GET of this base's setup requests. A base without the route (404) is remembered as unsupported, never as "none".
    public func loadSetupRequests() async {
        guard !closed, canReadConnections else { return }
        do {
            let value = try await client.connectionSetupRequests()
            guard !closed else { return }
            if let host = value.requests.first?.hostId { guard accept(host) else { return } }
            setupRequests = value.requests; setupRequestsSupported = true
            if value.invalidRequestCount > 0 { notice = .workflowListIncomplete }
            else if notice == .workflowListIncomplete { notice = nil }
        } catch HostClientError.notFound {
            setupRequests = nil; setupRequestsSupported = false
        } catch {
            // Keep a previous valid snapshot visible; a read failure never proves the list became empty.
            notice = .loadFailed
        }
    }

    /// The setup request the host derives for an approved `mcp.authorize` of this action (the old handoff is unchanged).
    public static func nativeSetupRequestID(actionID: String) -> String { "setup_" + actionID }

    /// GET of one setup request by its id. Not found means none exists for it (nothing is created here).
    public func loadSetupRequest(id: String) async {
        guard !closed, canReadConnections else { return }
        do {
            let value = try await client.connectionSetupRequest(id: id)
            guard !closed, accept(value.hostId) else { return }
            replace(value); setupRequestsSupported = true
        } catch HostClientError.notFound {
            setupRequests = setupRequests?.filter { $0.id != id }
        } catch {}
    }

    /// GET of the current choices of one request. A base without the route leaves `choicesSupported` false.
    public func loadChoices(_ workflow: ConnectionWorkflow) async {
        guard !closed, canReadConnections, workflow.hostId == hostID else { return }
        do {
            let value = try await client.connectionSetupChoices(id: workflow.id)
            guard !closed else { return }
            setupChoices[workflow.id] = value; choicesSupported = true; choicesReadFailed.remove(workflow.id)
        } catch HostClientError.notReady {
            // The base answers that choices are unavailable (no pins published): never invent them.
            setupChoices[workflow.id] = nil; choicesSupported = false
        } catch {
            setupChoices[workflow.id] = nil; choicesReadFailed.insert(workflow.id)
        }
    }

    /// The login attempt "Retomar login…" may read back for this request: the newest one the host lists that this editor
    /// has not seen end. Nil means the next step is a new, explicit Conectar (one POST per gesture).
    public func resumableAuthorizationID(for workflowID: String) -> String? {
        setupChoices[workflowID]?.authorizationRequestIds.last { !endedAuthorizationIDs.contains($0) }
    }

    /// The managed account behind one gateway connection of a choice.
    public func account(forConnection connectionID: String) -> ConnectionAccount? {
        managedAccounts.first { $0.gatewayConnectionIds.contains(connectionID) }
    }

    /// One explicit choice of the owner: a connection of the request's current choices and the exact tools on it.
    public struct SetupSelection: Equatable, Sendable {
        public let connectionID: String
        public let toolNames: [String]
        public init(connectionID: String, toolNames: [String]) { self.connectionID = connectionID; self.toolNames = Array(Set(toolNames)).sorted() }
    }

    /// The tools to start with for one choice: what the bot already holds, else only tools whose effect the host reviewed
    /// as read. A starting point the owner edits; nothing is saved until Permitir e continuar.
    public static func suggestedTools(_ choice: ConnectionWorkflowChoices.Choice) -> [String] {
        let held = choice.tools.filter(\.enabled).map(\.name)
        return (held.isEmpty ? choice.tools.filter { $0.effect == .read }.map(\.name) : held).sorted()
    }

    /// Permitir e continuar. The owner chose exact connections (1...5) of the request's current choices and exact tools on
    /// each. For a managed account whose granted tools differ from that choice, the bot's access is set to exactly those
    /// tools through the existing access route (CAS on the account revision + receipt; other tools of that account become
    /// deny). Native tools are chosen in the native manager and must already be granted here. Then the choices are read
    /// again (GET) and the request is completed once with exactly the chosen tools at the fresh gateway pins. Any unknown
    /// or conflict stops the chain; nothing is retried, and nothing applies to future accounts or tools.
    public func allowAndContinue(_ workflow: ConnectionWorkflow, selections: [SetupSelection]) async {
        guard !closed, !busy, !workflowChainInProgress, canManageConnections, pendingWorkflow == nil, pendingAccess == nil, workflow.state.isOpen, workflow.hostId == hostID,
              (1...5).contains(selections.count), Set(selections.map(\.connectionID)).count == selections.count,
              selections.allSatisfy({ !$0.toolNames.isEmpty }) else { return }
        workflowChainInProgress = true
        defer { workflowChainInProgress = false }
        await loadChoices(workflow)
        guard let current = setupChoices[workflow.id] else { notice = choicesSupported == false ? .workflowPinsUnavailable : .workflowConflict; return }
        guard current.revision == workflow.revision else { await loadSetupRequests(); notice = .workflowConflict; return }
        for selection in selections {
            guard let choice = current.choices.first(where: { $0.connectionId == selection.connectionID }),
                  Set(selection.toolNames).isSubset(of: Set(choice.tools.map(\.name))) else { notice = .workflowConflict; return }
            let held = Set(choice.tools.filter(\.enabled).map(\.name))
            switch workflow.target {
            case .managed(let serviceID, _):
                guard held != Set(selection.toolNames) else { continue }
                guard let account = account(forConnection: choice.connectionId), account.serviceId == serviceID, account.status == .connected,
                      Set(selection.toolNames).isSubset(of: Set(account.tools.map(\.name))) else { notice = .workflowConflict; return }
                await setAccess(account, botID: workflow.botId, enabled: true, toolNames: selection.toolNames)
                guard pendingAccess == nil, notice == .accessSaved(enabled: true) else { return }
            case .nativeMCP:
                guard Set(selection.toolNames).isSubset(of: held) else { notice = .workflowNothingGranted; return }
            }
        }
        await loadChoices(workflow)
        guard let fresh = setupChoices[workflow.id], fresh.revision == workflow.revision else { notice = .workflowConflict; return }
        var exact: [ConnectionWorkflowSelection] = []
        for selection in selections {
            guard let choice = fresh.choices.first(where: { $0.connectionId == selection.connectionID }) else { notice = .workflowConflict; return }
            let tools = selection.toolNames.compactMap { name in choice.tools.first { $0.name == name && $0.enabled } }
            guard tools.count == selection.toolNames.count else { notice = .workflowNothingGranted; return }
            exact.append(ConnectionWorkflowSelection(connectionId: choice.connectionId, expectedRevision: choice.expectedRevision,
                                                     tools: tools.map { ConnectionWorkflowTool(name: $0.name, manifestHash: $0.manifestHash) }))
        }
        await complete(workflow, selections: exact)
    }

    /// Managed request on a base without the choices route: only the exact account tools reviewed by the owner are
    /// granted. The request stays open and nothing is completed with invented gateway pins.
    public func allowWithoutContinuation(_ workflow: ConnectionWorkflow, selections: [SetupSelection]) async {
        guard !closed, !busy, !workflowChainInProgress, canManageConnections, pendingWorkflow == nil, pendingAccess == nil, workflow.state.isOpen, workflow.hostId == hostID,
              choicesSupported == false, case .managed(let serviceID, _) = workflow.target,
              (1...5).contains(selections.count), Set(selections.map(\.connectionID)).count == selections.count,
              selections.allSatisfy({ !$0.toolNames.isEmpty }) else { return }
        workflowChainInProgress = true
        defer { workflowChainInProgress = false }
        for selection in selections {
            guard let account = accounts.first(where: { $0.id == selection.connectionID }), account.manage == .connections, account.serviceId == serviceID,
                  account.status == .connected, Set(selection.toolNames).isSubset(of: Set(account.tools.map(\.name))) else { notice = .workflowConflict; return }
            await setAccess(account, botID: workflow.botId, enabled: true, toolNames: selection.toolNames)
            guard pendingAccess == nil, notice == .accessSaved(enabled: true) else { return }
        }
        notice = .workflowAccessSavedWithoutContinuation
    }

    /// One POST of the exact selections. Unknown keeps the request for `checkWorkflow()`.
    public func complete(_ workflow: ConnectionWorkflow, selections: [ConnectionWorkflowSelection]) async {
        guard !closed, !busy, canManageConnections, pendingWorkflow == nil, workflow.state.isOpen, workflow.hostId == hostID, !selections.isEmpty else { return }
        let input = CompleteConnectionWorkflowInput(workflow: workflow, selections: selections)
        pendingWorkflow = PendingWorkflow(workflowID: workflow.id, kind: .complete(input))
        busy = true
        do {
            let value = try await client.completeConnectionSetupRequest(id: workflow.id, input)
            busy = false; pendingWorkflow = nil; absorb(workflow: value)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .workflowUnknown
        } catch HostClientError.conflict {
            busy = false; pendingWorkflow = nil; await loadSetupRequests(); notice = .workflowConflict
        } catch HostClientError.invalidRequest {
            busy = false; pendingWorkflow = nil; notice = .workflowRefused
        } catch {
            busy = false; pendingWorkflow = nil; record(error)
        }
    }

    /// Recusar: one POST that makes the request inert; access already granted is not undone by it.
    public func cancelSetupRequest(_ workflow: ConnectionWorkflow) async {
        guard !closed, !busy, canManageConnections, pendingWorkflow == nil, workflow.state.isOpen, workflow.hostId == hostID else { return }
        let input = CancelConnectionWorkflowInput(workflow: workflow)
        pendingWorkflow = PendingWorkflow(workflowID: workflow.id, kind: .cancel(input))
        busy = true
        do {
            let value = try await client.cancelConnectionSetupRequest(id: workflow.id, input)
            busy = false; pendingWorkflow = nil; absorb(workflow: value)
        } catch HostClientError.mutationOutcomeUnknown {
            busy = false; notice = .workflowUnknown
        } catch HostClientError.conflict {
            busy = false; pendingWorkflow = nil; await loadSetupRequests(); notice = .workflowConflict
        } catch HostClientError.invalidRequest {
            busy = false; pendingWorkflow = nil; notice = .workflowRefused
        } catch {
            busy = false; pendingWorkflow = nil; record(error)
        }
    }

    /// GET of the same request. A newer revision settles the open POST with what the host shows; the same revision still
    /// waiting for the owner means it was not applied (a new explicit gesture may send a new request). Nothing is re-sent.
    public func checkWorkflow() async {
        guard !closed, !busy, let pending = pendingWorkflow else { return }
        busy = true
        let value = try? await client.connectionSetupRequest(id: pending.workflowID)
        busy = false
        guard let value, value.hostId == hostID else { notice = .workflowUnknown; return }
        if value.revision > pending.expectedRevision || !value.state.isOpen {
            // A newer revision, or a request the host now projects as ended (expired/stopped keep the same revision):
            // either way the open POST can no longer apply. Settle with what the host shows; nothing is re-sent.
            pendingWorkflow = nil; absorb(workflow: value)
        } else if value.revision == pending.expectedRevision {
            pendingWorkflow = nil; replace(value); notice = .workflowNotApplied
        } else {
            notice = .workflowUnknown
        }
    }

    private func absorb(workflow value: ConnectionWorkflow) {
        replace(value)
        notice = value.state == .ready ? .workflowCompleted(continued: value.continuationTurnId != nil) : .workflowEnded(value.state)
    }

    private func replace(_ value: ConnectionWorkflow) {
        var items = setupRequests ?? []
        if let index = items.firstIndex(where: { $0.id == value.id }) { items[index] = value } else { items.append(value) }
        setupRequests = items
    }

    // MARK: Native connections (read-only here)

    /// GET of the native MCP inventory and of each sign-in's public metadata (at most 32). Operations stay in the
    /// native manager. A failed read leaves `nativeServers` nil: unread, not empty.
    public func loadNativeInventory() async {
        guard !closed, canReadMcp else { return }
        do {
            let servers = try await client.mcpServers()
            guard !closed else { return }
            var credentials: [String: McpCredentialStatus] = [:]
            for server in servers.prefix(32) where server.auth != "none" {
                if let value = try? await client.mcpCredentials(serverID: server.id), value.serverId == server.id { credentials[server.id] = value }
                guard !closed else { return }
            }
            nativeServers = servers; nativeCredentials = credentials
        } catch {
            nativeServers = nil; nativeCredentials = [:]
        }
    }

    public func close() {
        guard !closed else { return }
        closed = true
        if ownsClient { client.close() }
    }
}

/// Plain words for accounts and states. Identity is only "confirmed" when the provider's official endpoint verified it.
public enum ManagedConnectAppsPresentation {
    public static func identityLine(_ identity: ConnectionAccountIdentity, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        switch identity.confirmation {
        case .providerVerified: return t("Conta confirmada pelo serviço: ", "Account confirmed by the service: ") + (identity.value ?? "")
        case .providerDisplayName: return t("Nome informado pelo serviço (não é uma conta confirmada): ", "Name given by the service (not a confirmed account): ") + (identity.value ?? "")
        case .unconfirmed:
            if let issuer = identity.issuer { return t("Conta não confirmada · emitido por ", "Account not confirmed · issued by ") + issuer }
            return t("Conta não confirmada", "Account not confirmed")
        }
    }

    public static func statusKey(_ status: ConnectionAccountStatus) -> String {
        switch status {
        case .connected: "Conectada"
        case .needsReconnect: "Precisa conectar de novo"
        case .disconnecting: "Desconectando…"
        case .disconnected: "Desconectada"
        case .replaced: "Substituída por outra conexão"
        case .identityMismatch: "Outra conta apareceu nesta conexão; ela foi parada"
        case .unknown: "Estado não confirmado"
        }
    }

    public static func persistenceKey(_ persistence: ConnectionPersistence) -> String {
        switch persistence {
        case .managedService: "Guardada no serviço de conexões"
        case .appKeychain: "Guardada neste Mac"
        case .volatileUntilHostRestart: "Some quando a base reiniciar"
        case .hostPersistent: "Guardada na base"
        }
    }

    public static func authorizationKey(_ state: ConnectionAuthorizationState) -> String {
        switch state {
        case .starting: "Preparando a página oficial…"
        case .awaitingUser: "Aguardando você na página oficial do serviço"
        case .verifying: "Conferindo com o serviço…"
        case .connected: "Conectada"
        case .failed: "A conexão não foi concluída"
        case .expired: "O link expirou"
        case .cancelled: "Você cancelou"
        case .mismatch: "Outra conta respondeu; nada foi conectado"
        case .unknown: "Resultado não confirmado"
        }
    }
}
