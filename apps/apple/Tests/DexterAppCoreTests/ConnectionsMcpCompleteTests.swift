#if os(macOS)
import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterClientIdentity
@testable import DexterHostClient

/// MCP complete, Apple parcels B/C/F: the three-fact projection, sign-in diagnostics, Reconectar/Desconectar/Quem pode usar
/// and setup requests ("Permitir e continuar"). Synthetic transport only, built from the real host's golden responses
/// (`DexterHostClientTests/Fixtures/connections-golden.json`). No process, Keychain, account, provider, browser or OAuth.
@MainActor final class ConnectionsMcpCompleteTests: XCTestCase {

    // MARK: Three facts, unknown per axis

    func testManagedFactsKeepEachAxisOnItsOwnSource() throws {
        let host = try MCFakeHost()
        let base = try host.decodedAccount()
        let facts = ConnectionsPresentation.managed(base, portuguese: true)
        XCTAssertEqual(facts.account.tone, .confirmed)
        XCTAssertEqual(facts.account.text, "Conta conectada")
        XCTAssertEqual(facts.access.text, "Acesso liberado · 1 bot")
        XCTAssertEqual(facts.admission.text, "Entra no próximo turno", "no driver proof: never 'available in this conversation'")
        XCTAssertNil(facts.action)

        // An access change with an open outcome makes only access (and therefore admission) unknown.
        let pending = ConnectionsPresentation.managed(base, accessUnconfirmed: true, portuguese: true)
        XCTAssertEqual(pending.account, facts.account, "a confirmed account stays confirmed")
        XCTAssertEqual(pending.access.tone, .unknown)
        XCTAssertEqual(pending.admission.tone, .unknown)
        XCTAssertEqual(pending.action, .check)

        // An unknown account keeps the grants it reports; it does not claim the account is connected.
        let unknown = try host.decodedAccount(["status": "unknown"])
        let unknownFacts = ConnectionsPresentation.managed(unknown, portuguese: true)
        XCTAssertEqual(unknownFacts.account.tone, .unknown)
        XCTAssertEqual(unknownFacts.access.text, "Acesso liberado · 1 bot")
        XCTAssertEqual(unknownFacts.admission.tone, .unknown)
        XCTAssertEqual(unknownFacts.action, .check)

        // Proof of admission is the only way to say "available in this conversation".
        XCTAssertEqual(ConnectionsPresentation.managed(base, admission: .provenInCurrentTurn, portuguese: true).admission.text, "Disponível nesta conversa")
        let noBots = try host.decodedAccount(["bots": [[String: Any]]()])
        let idle = ConnectionsPresentation.managed(noBots, admission: .provenInCurrentTurn, portuguese: true)
        XCTAssertEqual(idle.access.text, "Nenhum bot usa esta conta")
        XCTAssertEqual(idle.admission.text, "Não disponível", "proof without a grant is not availability")
        XCTAssertEqual(idle.action, .chooseBots)
    }

    func testRecoveryStatesOfferReconnectWithoutInventingCauseOrDate() throws {
        let host = try MCFakeHost()
        let needs = ConnectionsPresentation.managed(try host.decodedAccount(["status": "needs_reconnect"]), portuguese: true)
        XCTAssertEqual(needs.action, .reconnect)
        XCTAssertEqual(needs.account.text, "Entre novamente para reconectar")
        XCTAssertFalse(needs.all.contains { $0.text.lowercased().contains("expir") }, "the contract has no expiry or cause for needs_reconnect")
        let mismatch = ConnectionsPresentation.managed(try host.decodedAccount(["status": "identity_mismatch"]), portuguese: true)
        XCTAssertEqual(mismatch.account.tone, .problem)
        XCTAssertEqual(mismatch.action, .reconnect)
        XCTAssertEqual(mismatch.admission.text, "Não disponível")
        let leaving = ConnectionsPresentation.managed(try host.decodedAccount(), disconnectUnconfirmed: true, portuguese: false)
        XCTAssertEqual(leaving.account.text, "Disconnect not confirmed")
        XCTAssertEqual(leaving.access.text, "Access granted · 1 bot")
        XCTAssertEqual(leaving.action, .check)
        let unverified = try host.decodedAccount(["identity": ["confirmation": "unconfirmed", "value": NSNull(), "kind": NSNull(), "source": NSNull(), "issuer": NSNull(), "checkedAt": NSNull()]])
        XCTAssertEqual(ConnectionsPresentation.managed(unverified, portuguese: true).account.text, "Conectada · conta não confirmada")
    }

    func testNativeFactsReadOnlyWhatTheConnectionReports() throws {
        func server(_ status: String, auth: String = "oauth", transport: String = "http") throws -> McpServerSummary {
            try JSONDecoder().decode(McpServerSummary.self, from: Data("""
            {"id":"examplemcp","name":"ExampleMCP","transport":"\(transport)","runsOn":"owner_mac","auth":"\(auth)","status":"\(status)","destination":"https://mcp.examplemcp.test/mcp"}
            """.utf8))
        }
        func credentials(_ state: String, error: String? = nil, server: String = "examplemcp") throws -> McpCredentialStatus {
            let lastError = error.map { "\"\($0)\"" } ?? "null"
            return try JSONDecoder().decode(McpCredentialStatus.self, from: Data("""
            {"serverId":"\(server)","auth":"oauth","custody":null,"slots":[],"state":"\(state)","expiresAt":null,"issuer":null,"lastError":\(lastError)}
            """.utf8))
        }
        let elsewhere = ConnectionsPresentation.native(server: try server("unavailable_here"), credentials: nil, portuguese: true)
        XCTAssertEqual(elsewhere.action, .openOnOtherComputer)
        let unread = ConnectionsPresentation.native(server: try server("registered"), credentials: try credentials("unlocked", server: "other"), portuguese: true)
        XCTAssertEqual(unread.account.tone, .unknown, "credentials of another connection are never used")
        let client = ConnectionsPresentation.native(server: try server("needs_auth"), credentials: try credentials("unauthorized", error: "oauth_client_required"), portuguese: true)
        XCTAssertEqual(client.action, .enterClientID)
        XCTAssertEqual(client.account.text, "Exige Client ID")
        let waiting = ConnectionsPresentation.native(server: try server("needs_auth"), credentials: try credentials("authorizing"), portuguese: true)
        XCTAssertEqual(waiting.action, .check)
        let ready = ConnectionsPresentation.native(server: try server("ready"), credentials: try credentials("unlocked"), portuguese: true)
        XCTAssertEqual(ready.account.text, "Conectada · conta não verificada")
        XCTAssertEqual(ready.access.tone, .neutral, "per-bot selections are not read by the row; it never guesses a count")
        XCTAssertNotEqual(ready.admission.text, "Disponível nesta conversa")
        let registered = ConnectionsPresentation.native(server: try server("registered", auth: "none"), credentials: nil, portuguese: true)
        XCTAssertEqual(registered.account.text, "Conexão adicionada", "a registration is not a disabled flag nor a connection")
        XCTAssertEqual(registered.action, .viewTools)
    }

    // MARK: Sign-in diagnostics and local processes

    func testEveryAuthenticationCodeHasItsOwnSentenceAndNoInferredApiKey() {
        for portuguese in [true, false] {
            let all = McpAuthenticationDiagnosticError.Code.allCases.map { ConnectionsPresentation.diagnostic($0, service: "ExampleMCP", portuguese: portuguese) }
            XCTAssertEqual(Set(all.map(\.sentence)).count, McpAuthenticationDiagnosticError.Code.allCases.count, "one specific sentence per code")
            XCTAssertEqual(Set(all.map(\.short)).count, McpAuthenticationDiagnosticError.Code.allCases.count)
            for diagnosis in all {
                let text = (diagnosis.sentence + diagnosis.short).lowercased()
                XCTAssertFalse(text.contains("chave de api") || text.contains("api key") || text.contains("token de acesso"), "an error never suggests another login method")
            }
        }
        let client = ConnectionsPresentation.diagnostic(.oauthClientRequired, service: "ExampleMCP", portuguese: true)
        XCTAssertEqual(client.action, .enterClientID)
        XCTAssertTrue(client.sentence.contains("ExampleMCP") && client.sentence.contains("PKCE"))
        XCTAssertNil(ConnectionsPresentation.diagnostic(code: "something_new", service: "X", portuguese: true), "codes outside the closed set get no invented sentence")
        XCTAssertTrue(ConnectionsPresentation.clientIDRequest(service: "ExampleMCP", portuguese: true).contains("nunca um segredo"))
    }

    func testLocalProcessBoundaryIsStatedBeforeStartAndDiscoveryPlanIsExact() throws {
        XCTAssertTrue(ConnectionsPresentation.stdioBoundary(portuguese: true).contains("não são sandbox"))
        XCTAssertTrue(ConnectionsPresentation.stdioBoundary(portuguese: false).contains("not a sandbox"))
        let stdio = try JSONDecoder().decode(McpServerSummary.self, from: Data(#"{"id":"files","name":"Files","transport":"stdio","runsOn":"owner_mac","auth":"none","status":"registered","destination":"/opt/tools/files-mcp"}"#.utf8))
        let plan = ConnectionsPresentation.discoveryPlan(server: stdio, portuguese: true)
        XCTAssertTrue(plan.contains("/opt/tools/files-mcp") && plan.contains("não são sandbox") && plan.contains("Nenhuma ferramenta é executada"))
        let http = try JSONDecoder().decode(McpServerSummary.self, from: Data(#"{"id":"t","name":"T","transport":"http","runsOn":"any","auth":"oauth","status":"registered","destination":"https://mcp.t.test/mcp"}"#.utf8))
        XCTAssertTrue(ConnectionsPresentation.discoveryPlan(server: http, portuguese: true).contains("com a credencial desta conexão"))
        XCTAssertEqual(ConnectionsPresentation.placement("owner_mac", portuguese: true), "Roda no Mac do dono da base")
        XCTAssertEqual(ConnectionsPresentation.placement("future_value", portuguese: true), "future_value")
    }

    // MARK: Reconectar

    func testReconnectIsOneIdentifiedRequestAndCarriesNoBotOver() async throws {
        let host = try MCFakeHost(status: "needs_reconnect")
        let editor = host.editor(port: 49_951)
        defer { editor.close() }
        await editor.reload()
        let old = try XCTUnwrap(editor.managedAccounts.first)
        XCTAssertTrue(ManagedConnectAppsEditor.offersReconnect(old))
        let page = await editor.reconnect(old)
        XCTAssertEqual(page?.scheme, "https")
        let pending = try XCTUnwrap(editor.pendingAuthorization)
        XCTAssertEqual(pending.replacesAccountId, old.id)
        XCTAssertEqual(pending.profileId, old.profileId)
        let again = await editor.reconnect(old)
        XCTAssertNil(again, "one sign-in at a time; never a second POST")
        await host.completeAuthorization(newAccountWithoutBots: true)
        await editor.checkAuthorization()
        let review = try XCTUnwrap(editor.reconnectReview)
        XCTAssertEqual(review.previousAccountID, old.id)
        XCTAssertEqual(review.previousBotIDs, [MCFakeHost.botID])
        XCTAssertEqual(review.equivalence, .unproven, "display-name comparison is not proof of the same account")
        XCTAssertEqual(editor.notice, .reconnected)
        try await waitUntil { editor.managedAccounts.count == 2 && !editor.busy }
        let fresh = try XCTUnwrap(editor.managedAccounts.first { $0.id == review.newAccountID })
        XCTAssertTrue(fresh.bots.isEmpty, "nothing migrates to the new account")
        let posts = await host.count("POST /v1/connections/authorizations")
        XCTAssertEqual(posts, 1)
        let patches = await host.count(prefix: "PATCH")
        XCTAssertEqual(patches, 0, "no grant is written by a reconnection")
        let connected = try host.decodedAccount()
        XCTAssertFalse(ManagedConnectAppsEditor.offersReconnect(connected))
    }

    // MARK: Desconectar

    func testDisconnectUnknownIsSettledByReadingNeverByResending() async throws {
        let host = try MCFakeHost(disconnectAnswersUnknown: true)
        let editor = host.editor(port: 49_952)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.disconnect(account)
        XCTAssertEqual(editor.notice, .disconnectUnknown)
        XCTAssertEqual(editor.pendingDisconnect?.accountID, account.id)
        XCTAssertEqual(ConnectionsPresentation.managed(account, disconnectUnconfirmed: true, portuguese: true).account.tone, .unknown)
        await editor.disconnect(account)
        let posts = await host.count("POST /v1/connections/accounts/\(account.id)/disconnect")
        XCTAssertEqual(posts, 1, "nothing else is sent while the outcome is open")
        await editor.checkDisconnect()
        XCTAssertNil(editor.pendingDisconnect)
        XCTAssertEqual(editor.notice, .disconnected(ConnectionUpstreamDisconnect(upstream: .deleted, revocation: .requested)))
        XCTAssertEqual(editor.managedAccounts.first?.status, .disconnected)
        XCTAssertTrue(ConnectionsPresentation.disconnectOutcome(ConnectionUpstreamDisconnect(upstream: .deleted, revocation: .requested), portuguese: true).contains("pedida (não confirmada)"))
    }

    func testDisconnectWithoutReceiptStaysOpenWhileTheAccountIsStillLeaving() async throws {
        let host = try MCFakeHost(disconnectAnswersUnknown: true, disconnectKeepsDisconnecting: true)
        let editor = host.editor(port: 49_953)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.disconnect(account)
        await editor.checkDisconnect()
        XCTAssertEqual(editor.notice, .disconnectInProgress)
        XCTAssertNotNil(editor.pendingDisconnect, "only a receipt or a disconnected account settles it")
        let log = await host.log()
        XCTAssertTrue(log.contains("GET /v1/connections/accounts/\(account.id)"))
        XCTAssertEqual(log.filter { $0.hasPrefix("POST") }.count, 1)
    }

    func testDisconnectImpactNamesTheBotsAndOnlyThisAccount() throws {
        let host = try MCFakeHost()
        let account = try host.decodedAccount()
        let text = ConnectionsPresentation.disconnectImpact(account, botName: { $0 == MCFakeHost.botID ? "Luna" : nil }, portuguese: true)
        XCTAssertTrue(text.contains("Luna"))
        XCTAssertTrue(text.contains("Outras contas deste serviço não mudam"))
        XCTAssertTrue(text.contains("pedida, não confirmada"))
    }

    // MARK: Quem pode usar

    func testAccessIsCASAndCancellationLeavesAnOutcomeToRead() async throws {
        let host = try MCFakeHost(accessDelay: .milliseconds(300))
        let editor = host.editor(port: 49_954)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        let task = Task { await editor.setAccess(account, botID: "bot_other", enabled: true) }
        try await waitUntil { await host.count(prefix: "PATCH") == 1 }
        task.cancel()
        await task.value
        XCTAssertEqual(editor.notice, .accessUnknown, "a cancelled request may have been applied: it is unknown, not failed")
        XCTAssertEqual(editor.pendingAccess?.input.botId, "bot_other")
        await editor.setAccess(account, botID: "bot_third", enabled: true)
        let patches = await host.count(prefix: "PATCH")
        XCTAssertEqual(patches, 1, "one open outcome blocks the next change")
        await editor.checkAccess()
        XCTAssertNil(editor.pendingAccess)
        XCTAssertEqual(editor.notice, .accessSaved(enabled: true))
        XCTAssertEqual(editor.managedAccounts.first?.bots.first { $0.botId == "bot_other" }?.access, .enabled)

        // A stale revision is a conflict: re-read, never forced.
        await host.bumpRevision()
        let stale = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setAccess(stale, botID: "bot_other", enabled: false)
        XCTAssertEqual(editor.notice, .accessConflict)
        XCTAssertNil(editor.pendingAccess)
    }

    // OR-12: terminal access receipts. Only `applied` (or a historical receipt without the field) is a saved access.

    func testAccessReceiptOutcomeDecodesAndEachOutcomeHasItsOwnRevisionRule() throws {
        let host = try MCFakeHost()
        let account = try host.decodedAccount()
        let input = SetConnectionBotAccessInput(account: account, botId: "bot_other", enabled: true, toolNames: ["gmail.read"],
                                                clientRequestId: UUID().uuidString.lowercased())
        func receipt(_ outcome: String?, revision: Int, tools: Int = 1) throws -> ConnectionReceipt {
            var value: [String: Any] = ["version": 1, "hostId": input.expectedHostID, "clientRequestId": input.clientRequestId, "kind": "access",
                "accountId": account.id, "requestHash": try XCTUnwrap(input.requestHash(accountID: account.id)), "previousRevision": account.revision,
                "revision": revision, "access": ["botId": "bot_other", "enabled": true, "tools": tools, "toolNames": ["gmail.read"]], "createdAt": 1]
            if let outcome { value["accessOutcome"] = outcome }
            return try JSONDecoder().decode(ConnectionReceipt.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let historical = try receipt(nil, revision: account.revision + 1)
        XCTAssertNil(historical.accessOutcome)
        XCTAssertEqual(historical.effectiveAccessOutcome, .applied, "absent = applied")
        XCTAssertTrue(historical.isReceipt(of: input, accountID: account.id))
        XCTAssertTrue(try receipt("applied", revision: account.revision + 1).isReceipt(of: input, accountID: account.id))
        XCTAssertFalse(try receipt("applied", revision: account.revision).isReceipt(of: input, accountID: account.id))
        let notApplied = try receipt("not_applied", revision: account.revision, tools: 0)
        XCTAssertEqual(notApplied.effectiveAccessOutcome, .notApplied)
        XCTAssertTrue(notApplied.isReceipt(of: input, accountID: account.id), "not applied keeps the previous revision")
        XCTAssertFalse(try receipt("not_applied", revision: account.revision + 1, tools: 0).isReceipt(of: input, accountID: account.id))
        XCTAssertFalse(try receipt("not_applied", revision: account.revision, tools: 1).isReceipt(of: input, accountID: account.id), "nothing committed = 0 tools")
        let superseded = try receipt("superseded", revision: account.revision + 3)
        XCTAssertEqual(superseded.effectiveAccessOutcome, .superseded)
        XCTAssertTrue(superseded.isReceipt(of: input, accountID: account.id), "superseded carries the account's current revision")
        XCTAssertTrue(try receipt("superseded", revision: account.revision).isReceipt(of: input, accountID: account.id))
        XCTAssertFalse(try receipt("superseded", revision: account.revision - 1).isReceipt(of: input, accountID: account.id))
        XCTAssertThrowsError(try receipt("partial", revision: account.revision + 1), "an unknown outcome is not guessed")
        XCTAssertEqual(ManagedConnectAppsEditor.notice(for: historical), .accessSaved(enabled: true))
        XCTAssertEqual(ManagedConnectAppsEditor.notice(for: notApplied), .accessConflict)
        XCTAssertEqual(ManagedConnectAppsEditor.notice(for: superseded), .accessSuperseded)
    }

    func testNotAppliedAccessSettlesHonestlyNeverRepeatsThePatchAndAllowsANewHumanRequest() async throws {
        let host = try MCFakeHost(botsOnAccount: [], accessOutcome: "not_applied")
        let editor = host.editor(port: 49_990)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setAccess(account, botID: "bot_other", enabled: true, toolNames: ["gmail.read"])
        XCTAssertEqual(editor.notice, .accessConflict, "a terminal not-applied receipt is never 'saved'")
        XCTAssertNil(editor.pendingAccess, "the terminal receipt settles the request")
        XCTAssertNil(editor.managedAccounts.first?.bots.first { $0.botId == "bot_other" }, "the account was read again: no grant")
        let first = await host.log()
        XCTAssertEqual(first.filter { $0.hasPrefix("PATCH") }.count, 1)
        let patchIndex = try XCTUnwrap(first.firstIndex { $0.hasPrefix("PATCH") })
        XCTAssertTrue(first[(patchIndex + 1)...].contains("GET /v1/connections/accounts"), "reload after the terminal receipt")
        await editor.checkAccess()
        let afterCheck = await host.count(prefix: "PATCH")
        XCTAssertEqual(afterCheck, 1, "nothing is resubmitted automatically")
        // A new explicit gesture is a new request with a new exact UUID.
        await host.setAccessOutcome(nil)
        await editor.setAccess(try XCTUnwrap(editor.managedAccounts.first), botID: "bot_other", enabled: true, toolNames: ["gmail.read"])
        XCTAssertEqual(editor.notice, .accessSaved(enabled: true))
        let bodies = try await host.accessBodies().map { try XCTUnwrap(try JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        XCTAssertEqual(bodies.count, 2)
        let ids = bodies.compactMap { $0["clientRequestId"] as? String }
        XCTAssertEqual(ids.count, 2)
        for id in ids {
            XCTAssertNotNil(id.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#, options: .regularExpression), "exact lowercase UUID: \(id)")
        }
        XCTAssertNotEqual(ids[0], ids[1], "a new human request, not a replay")
        XCTAssertEqual(bodies.map { $0["toolNames"] as? [String] }, [["gmail.read"], ["gmail.read"]])
    }

    func testLostAccessAnswersSettleByGetAsSupersededOrNotAppliedNeverSaved() async throws {
        for (outcome, expected) in [("superseded", ManagedConnectAppsEditor.Notice.accessSuperseded), ("not_applied", .accessConflict)] {
            let host = try MCFakeHost(botsOnAccount: [], accessOutcome: outcome, accessAnswersUnknown: true)
            let editor = host.editor(port: 49_991)
            await editor.reload()
            let account = try XCTUnwrap(editor.managedAccounts.first)
            await editor.setAccess(account, botID: "bot_other", enabled: true, toolNames: ["gmail.read"])
            XCTAssertEqual(editor.notice, .accessUnknown, outcome)
            XCTAssertNotNil(editor.pendingAccess)
            await editor.checkAccess()
            XCTAssertEqual(editor.notice, expected, outcome)
            XCTAssertNil(editor.pendingAccess, "\(outcome): the GET receipt settles it")
            let patches = await host.count(prefix: "PATCH"), reads = await host.count(prefix: "GET /v1/connections/receipts/")
            XCTAssertEqual(patches, 1, "\(outcome): reconciliation is GET-only")
            XCTAssertEqual(reads, 1)
            if outcome == "superseded" {
                XCTAssertEqual(editor.managedAccounts.first?.revision, account.revision + 2, "the account was read again at its current revision")
            }
            editor.close()
        }
    }

    func testAllowAndContinueStopsBeforeCompleteWhenAccessIsNotApplied() async throws {
        let host = try MCFakeHost(botsOnAccount: [], accessOutcome: "superseded")
        await host.addWorkflow(id: "wf_or12", thread: "thread_1")
        let editor = host.editor(port: 49_992)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.loadChoices(workflow)
        let candidate = try XCTUnwrap(editor.setupChoices["wf_or12"]?.choices.first)
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: candidate.connectionId, toolNames: ["gmail.read"])])
        XCTAssertEqual(editor.notice, .accessSuperseded)
        XCTAssertNil(editor.pendingWorkflow)
        let completes = await host.count("POST /v1/connections/setup-requests/wf_or12/complete")
        XCTAssertEqual(completes, 0, "no continuation without an applied access")
    }

    func testAccessNeedsAConnectedAccountAndStaysBoundToTheFirstHost() async throws {
        let host = try MCFakeHost(status: "needs_reconnect")
        let editor = host.editor(port: 49_955)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setAccess(account, botID: "bot_other", enabled: true)
        let none = await host.count(prefix: "PATCH")
        XCTAssertEqual(none, 0, "a bot is never given an account that is not connected")
        await editor.setAccess(account, botID: MCFakeHost.botID, enabled: false)
        let removed = await host.count(prefix: "PATCH")
        XCTAssertEqual(removed, 1, "removing access is always possible")
        await host.switchHost()
        await editor.reload()
        XCTAssertEqual(editor.notice, .hostChanged)
        XCTAssertEqual(editor.managedAccounts.first?.hostId, account.hostId, "nothing from the other host is shown")
    }

    // MARK: Pedidos dos bots (setup requests)

    func testSetupRequestsWithoutPublishedPinsGrantOnlyExplicitToolsAndNeverComplete() async throws {
        let host = try MCFakeHost(botsOnAccount: [], choicesAvailable: false)
        await host.addWorkflow(id: "wf_1", thread: "thread_1")
        let editor = host.editor(port: 49_956)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        XCTAssertEqual(editor.setupRequestsSupported, true)
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: account.gatewayConnectionIds[0], toolNames: ["gmail.read"])])
        XCTAssertEqual(editor.choicesSupported, false)
        XCTAssertEqual(editor.notice, .workflowPinsUnavailable, "no published choices: nothing is written or completed")
        let none = await host.count(prefix: "PATCH")
        XCTAssertEqual(none, 0)
        await editor.allowWithoutContinuation(workflow, selections: [.init(connectionID: account.id, toolNames: ["gmail.read"])])
        XCTAssertEqual(editor.notice, .workflowAccessSavedWithoutContinuation)
        let accessData = await host.lastAccessBodyData()
        let accessBody = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(accessData)) as? [String: Any])
        XCTAssertEqual(accessBody["toolNames"] as? [String], ["gmail.read"], "missing gateway pins never grants every account tool implicitly")
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 1, "the request's bot got access through the existing route")
        XCTAssertFalse(log.contains { $0.hasSuffix("/complete") }, "never completed with invented pins")
        XCTAssertEqual(editor.managedAccounts.first?.bots.first?.botId, MCFakeHost.botID)
    }

    func testAllowAndContinueGrantsThenCompletesOnceWithFreshHostPinsAndUnknownIsReadBack() async throws {
        let host = try MCFakeHost(botsOnAccount: [], completeAnswersUnknown: true)
        await host.addWorkflow(id: "wf_2", thread: "thread_1")
        let editor = host.editor(port: 49_957)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.loadChoices(workflow)
        let candidate = try XCTUnwrap(editor.setupChoices["wf_2"]?.choices.first)
        XCTAssertFalse(candidate.tools.contains(where: \.enabled))
        XCTAssertNil(candidate.enabledSelection)
        XCTAssertEqual(editor.account(forConnection: candidate.connectionId)?.id, editor.managedAccounts.first?.id)
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: candidate.connectionId, toolNames: ["gmail.read", "gmail.send"])])
        XCTAssertEqual(editor.notice, .workflowUnknown)
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 1)
        let accessData = await host.lastAccessBodyData()
        let accessBody = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(accessData)) as? [String: Any])
        XCTAssertEqual(accessBody["toolNames"] as? [String], ["gmail.read", "gmail.send"], "the exact chosen tools, never an implicit all")
        let patchIndex = try XCTUnwrap(log.firstIndex { $0.hasPrefix("PATCH") })
        let readIndex = try XCTUnwrap(log.lastIndex(of: "GET /v1/connections/setup-requests/wf_2/choices"))
        let completeIndex = try XCTUnwrap(log.firstIndex(of: "POST /v1/connections/setup-requests/wf_2/complete"))
        XCTAssertTrue(patchIndex < readIndex && readIndex < completeIndex, "access first, then fresh pins by GET, then one complete")
        let lastBody = await host.lastCompleteBody()
        let bodyData = try XCTUnwrap(lastBody)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: bodyData) as? [String: Any])
        let selection = try XCTUnwrap((body["selections"] as? [[String: Any]])?.first)
        XCTAssertEqual(selection["connectionId"] as? String, candidate.connectionId, "the gateway connection the host listed, not the account id")
        XCTAssertEqual(selection["expectedRevision"] as? Int, 7, "the gateway connection revision, not the account revision")
        XCTAssertEqual((selection["tools"] as? [[String: Any]])?.compactMap { $0["manifestHash"] as? String }.count, 2)
        XCTAssertEqual(body["expectedRevision"] as? Int, workflow.revision)
        // A second gesture while the outcome is open sends nothing.
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: candidate.connectionId, toolNames: ["gmail.read"])])
        let completes = await host.count("POST /v1/connections/setup-requests/wf_2/complete")
        XCTAssertEqual(completes, 1)
        await editor.checkWorkflow()
        XCTAssertNil(editor.pendingWorkflow)
        XCTAssertEqual(editor.notice, .workflowCompleted(continued: true))
        XCTAssertTrue(editor.openSetupRequests(now: 0).isEmpty)
    }

    func testCheckShowingTheSameOpenRevisionMeansNotAppliedAndDeclineIsInert() async throws {
        let host = try MCFakeHost(botsOnAccount: [MCFakeHost.botID], completeAnswersUnknown: true, completeApplies: false)
        await host.addWorkflow(id: "wf_3", thread: "thread_1")
        let editor = host.editor(port: 49_958)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.loadChoices(workflow)
        let candidate = try XCTUnwrap(editor.setupChoices["wf_3"]?.choices.first)
        XCTAssertNotNil(candidate.enabledSelection)
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: candidate.connectionId, toolNames: candidate.tools.map(\.name))])
        let patches = await host.count(prefix: "PATCH")
        XCTAssertEqual(patches, 0, "a bot that already holds every tool is not written again")
        XCTAssertEqual(editor.notice, .workflowUnknown)
        await editor.checkWorkflow()
        XCTAssertEqual(editor.notice, .workflowNotApplied)
        XCTAssertNil(editor.pendingWorkflow)
        let open = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.cancelSetupRequest(open)
        XCTAssertEqual(editor.notice, .workflowEnded(.cancelled))
        XCTAssertTrue(editor.openSetupRequests(now: 0).isEmpty)
        XCTAssertEqual(editor.managedAccounts.first?.bots.first?.access, .enabled, "declining never undoes access already saved")
    }

    func testNativeRequestNeverGrantsFromTheReviewAndNeedsChosenTools() async throws {
        let host = try MCFakeHost()
        await host.addWorkflow(id: "wf_4", thread: "thread_1", native: true)
        let editor = host.editor(port: 49_960)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.loadChoices(workflow)
        let candidate = try XCTUnwrap(editor.setupChoices["wf_4"]?.choices.first)
        XCTAssertNil(editor.account(forConnection: candidate.connectionId))
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: candidate.connectionId, toolNames: ["mcp.examplemcp.search"])])
        XCTAssertEqual(editor.notice, .workflowNothingGranted)
        let log = await host.log()
        XCTAssertFalse(log.contains { $0.hasPrefix("PATCH") || $0.hasPrefix("PUT") || $0.hasSuffix("/complete") })
    }

    func testStoppedAndConflictingRequestsKeepContinuationAndValidSiblingsSurviveOneMalformedEntry() async throws {
        let host = try MCFakeHost()
        for (id, state) in [("wf_stopped", "stopped"), ("wf_conflict", "conflict"), ("wf_open", "awaiting_user")] {
            await host.addWorkflow(id: id, thread: "thread_1")
            if state != "awaiting_user" { await host.setWorkflowState(id, state: state, continuation: "turn_continuation_1") }
        }
        await host.addWorkflow(id: "wf_bad", thread: "thread_1")
        await host.corruptWorkflow("wf_bad")
        let editor = host.editor(port: 49_970)
        defer { editor.close() }
        await editor.reload(); await editor.loadSetupRequests()
        XCTAssertEqual(Set(editor.setupRequests?.map(\.id) ?? []), ["wf_stopped", "wf_conflict", "wf_open"])
        XCTAssertEqual(editor.setupRequests?.first { $0.id == "wf_stopped" }?.continuationTurnId, "turn_continuation_1")
        XCTAssertEqual(editor.setupRequests?.first { $0.id == "wf_conflict" }?.continuationTurnId, "turn_continuation_1")
        XCTAssertEqual(editor.openSetupRequests(now: 0).map(\.id), ["wf_open"])
        XCTAssertEqual(editor.notice, .workflowListIncomplete, "a malformed entry is visible as an incomplete read, not an empty list")
    }

    func testTwoConcurrentAllowGesturesProduceOneAccessPatchAndOneCompleteAcrossAwaitedChoices() async throws {
        let host = try MCFakeHost(botsOnAccount: [], completeAnswersUnknown: true, choicesDelay: .milliseconds(50))
        await host.addWorkflow(id: "wf_serial", thread: "thread_1")
        let editor = host.editor(port: 49_971)
        defer { editor.close() }
        await editor.reload(); await editor.loadSetupRequests(); let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        let account = try XCTUnwrap(editor.managedAccounts.first)
        let selections = [ManagedConnectAppsEditor.SetupSelection(connectionID: account.gatewayConnectionIds[0], toolNames: ["gmail.read"])]
        async let first: Void = editor.allowAndContinue(workflow, selections: selections)
        async let second: Void = editor.allowAndContinue(workflow, selections: selections)
        _ = await (first, second)
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 1)
        XCTAssertEqual(log.filter { $0.hasSuffix("/complete") }.count, 1)
        XCTAssertEqual(editor.notice, .workflowUnknown)
        XCTAssertFalse(editor.workflowChainInProgress)
        await editor.checkWorkflow()
        XCTAssertEqual(editor.notice, .workflowCompleted(continued: true))
    }

    func testExplicitOutcomeUnknownFromLegacy409KeepsAccessPendingAndGetsTheSameReceipt() async throws {
        let host = try MCFakeHost(botsOnAccount: [], accessAnswersUnknown: true, accessUnknownStatus: 409)
        let editor = host.editor(port: 49_972)
        defer { editor.close() }
        await editor.reload(); let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setAccess(account, botID: MCFakeHost.botID, enabled: true, toolNames: ["gmail.read"])
        let pending = try XCTUnwrap(editor.pendingAccess)
        XCTAssertEqual(editor.notice, .accessUnknown)
        await editor.setAccess(account, botID: MCFakeHost.botID, enabled: true, toolNames: ["gmail.read"])
        await editor.checkAccess()
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 1)
        XCTAssertTrue(log.contains("GET /v1/connections/receipts/" + pending.input.clientRequestId))
        XCTAssertNil(editor.pendingAccess)
        XCTAssertEqual(editor.notice, .accessSaved(enabled: true))
    }

    func testConnectGestureAfterUnknownResumedLoginReadsTheOriginalAttemptWithoutAnotherPost() async throws {
        let host = try MCFakeHost(botsOnAccount: [])
        await host.addWorkflow(id: "wf_resume_read", thread: "thread_1")
        let editor = host.editor(port: 49_973)
        defer { editor.close() }
        await editor.reload(); await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        _ = await editor.startAuthorization(serviceID: "gmail", setupRequestID: workflow.id)
        await editor.loadChoices(workflow)
        let originalID = try XCTUnwrap(editor.pendingAuthorization?.clientRequestId)
        // A new window reads the host's listed attempt and experiences one transient GET failure.
        let second = host.editor(port: 49_974)
        defer { second.close() }
        await second.reload(); await second.loadSetupRequests(); await second.loadChoices(workflow)
        await host.failNextAuthorizationRead()
        let firstPage = await second.resumeAuthorization(clientRequestID: originalID)
        XCTAssertNil(firstPage); XCTAssertEqual(second.notice, .authorizationUnknown)
        XCTAssertEqual(second.resumedAuthorizationID, originalID)
        let recoveredPage = await second.startAuthorization(serviceID: "gmail", setupRequestID: workflow.id)
        XCTAssertNotNil(recoveredPage)
        let log = await host.log()
        XCTAssertEqual(log.filter { $0 == "POST /v1/connections/authorizations" }.count, 1)
        XCTAssertEqual(log.filter { $0 == "GET /v1/connections/authorizations/" + originalID }.count, 2)
    }

    func testBaseWithoutSetupRouteIsUnsupportedNotEmptyAndTargetsAreClosed() async throws {
        let host = try MCFakeHost(setupRoute: false)
        let editor = host.editor(port: 49_959)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        XCTAssertEqual(editor.setupRequestsSupported, false)
        XCTAssertNil(editor.setupRequests)
        let strict = Data(#"{"kind":"managed","serviceId":"gmail","catalogPin":"\#(String(repeating: "a", count: 64))","extra":1}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ConnectionWorkflowTarget.self, from: strict), "targets are closed objects")
    }

    // MARK: Snapshot of several accounts, exact tools, no implicit grant

    func testFiveAccountSnapshotGrantsExactlyTheChosenToolsAndNothingLater() async throws {
        let host = try MCFakeHost(botsOnAccount: [], accountCount: 5)
        await host.addWorkflow(id: "wf_5", thread: "thread_1")
        let editor = host.editor(port: 49_961)
        defer { editor.close() }
        await editor.reload()
        await editor.loadSetupRequests()
        let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
        await editor.loadChoices(workflow)
        let choices = try XCTUnwrap(editor.setupChoices["wf_5"]?.choices)
        XCTAssertEqual(choices.count, 5)
        XCTAssertTrue(choices.allSatisfy { ManagedConnectAppsEditor.suggestedTools($0) == ["gmail.read"] }, "the starting point is the reviewed read tools only")
        await editor.allowAndContinue(workflow, selections: choices.map { .init(connectionID: $0.connectionId, toolNames: ["gmail.read"]) })
        XCTAssertEqual(editor.notice, .workflowCompleted(continued: true))
        let log = await host.log()
        XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 5, "one exact access change per chosen account")
        let accessData = await host.lastAccessBodyData()
        let access = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(accessData)) as? [String: Any])
        XCTAssertEqual(access["toolNames"] as? [String], ["gmail.read"])
        let completeData = await host.lastCompleteBody()
        let complete = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(completeData)) as? [String: Any])
        let selections = try XCTUnwrap(complete["selections"] as? [[String: Any]])
        XCTAssertEqual(Set(selections.compactMap { $0["connectionId"] as? String }), Set(choices.map(\.connectionId)), "materialized ids, not 'all'")
        XCTAssertTrue(selections.allSatisfy { ($0["tools"] as? [[String: Any]])?.compactMap { $0["name"] as? String } == ["gmail.read"] })
        // An account connected afterwards gets nothing on its own.
        await host.addAccount()
        await editor.reload()
        XCTAssertEqual(editor.managedAccounts.count, 6)
        XCTAssertEqual(editor.managedAccounts.last?.bots.isEmpty, true)
        let after = await host.count(prefix: "PATCH")
        XCTAssertEqual(after, 5)
        // More than five connections is never sent.
        await host.addWorkflow(id: "wf_6", thread: "thread_1")
        await editor.loadSetupRequests()
        let six = try XCTUnwrap(editor.openSetupRequests(now: 0).first { $0.id == "wf_6" })
        await editor.allowAndContinue(six, selections: editor.managedAccounts.map { .init(connectionID: $0.gatewayConnectionIds[0], toolNames: ["gmail.read"]) })
        let choicesReads = await host.count("GET /v1/connections/setup-requests/wf_6/choices")
        XCTAssertEqual(choicesReads, 0, "refused before any read or write")
    }

    func testLoginForARequestGrantsNothingAndReopeningReadsTheSameAttempt() async throws {
        let host = try MCFakeHost(botsOnAccount: [])
        await host.addWorkflow(id: "wf_7", thread: "thread_1")
        let editor = host.editor(port: 49_962)
        await editor.reload()
        await editor.loadSetupRequests()
        let refused = await editor.startAuthorization(serviceID: "gmail", setupRequestID: "wf_missing")
        XCTAssertNil(refused, "a login is never tied to a request this base does not list as open")
        let page = await editor.startAuthorization(serviceID: "gmail", setupRequestID: "wf_7")
        XCTAssertEqual(page?.scheme, "https")
        let started = try XCTUnwrap(editor.pendingAuthorization)
        XCTAssertEqual(started.setupRequestId, "wf_7")
        XCTAssertEqual(editor.authorization?.setupRequestId, "wf_7", "the host's correlation is checked in its answer")
        editor.close()

        // Reopened window: the same attempt is read back by its id; no new provider link is created.
        let reopened = host.editor(port: 49_962)
        defer { reopened.close() }
        await reopened.reload()
        await reopened.loadSetupRequests()
        let workflow = try XCTUnwrap(reopened.openSetupRequests(now: 0).first)
        await reopened.loadChoices(workflow)
        let ids = try XCTUnwrap(reopened.setupChoices["wf_7"]?.authorizationRequestIds)
        XCTAssertEqual(ids, [started.clientRequestId])
        let again = await reopened.resumeAuthorization(clientRequestID: try XCTUnwrap(ids.last))
        XCTAssertEqual(again?.scheme, "https")
        await host.completeAuthorization(newAccountWithoutBots: true)
        await reopened.checkAuthorization()
        XCTAssertEqual(reopened.notice, .connected)
        try await waitUntil { reopened.managedAccounts.count == 2 && !reopened.busy }
        let log = await host.log()
        XCTAssertEqual(log.filter { $0 == "POST /v1/connections/authorizations" }.count, 1)
        XCTAssertFalse(log.contains { $0.hasPrefix("PATCH") || $0.hasSuffix("/complete") }, "signing in grants nothing and completes nothing")
    }

    func testExactToolNamesAreSentHashedAndCheckedInTheReceipt() async throws {
        let host = try MCFakeHost(botsOnAccount: [], accessDelay: .milliseconds(300))
        let editor = host.editor(port: 49_963)
        defer { editor.close() }
        await editor.reload()
        let account = try XCTUnwrap(editor.managedAccounts.first)
        await editor.setAccess(account, botID: MCFakeHost.botID, enabled: true, toolNames: ["gmail.delete"])
        let none = await host.count(prefix: "PATCH")
        XCTAssertEqual(none, 0, "a tool that is not pinned on this account is refused before sending")
        let task = Task { await editor.setAccess(account, botID: MCFakeHost.botID, enabled: true, toolNames: ["gmail.read"]) }
        try await waitUntil { await host.count(prefix: "PATCH") == 1 }
        task.cancel(); await task.value
        XCTAssertEqual(editor.notice, .accessUnknown)
        XCTAssertEqual(editor.pendingAccess?.input.toolNames, ["gmail.read"])
        await editor.checkAccess()
        XCTAssertEqual(editor.notice, .accessSaved(enabled: true))
        let input = SetConnectionBotAccessInput(account: account, botId: "b", enabled: true, toolNames: ["z.tool", "a.tool", "a.tool"], clientRequestId: "r1")
        XCTAssertEqual(input.toolNames, ["a.tool", "z.tool"], "sorted and unique: the same request always hashes the same")
        XCTAssertNotEqual(input.requestHash(accountID: account.id),
                          SetConnectionBotAccessInput(account: account, botId: "b", enabled: true, clientRequestId: "r1").requestHash(accountID: account.id))
        XCTAssertNil(SetConnectionBotAccessInput(account: account, botId: "b", enabled: false, toolNames: ["a.tool"]).toolNames, "removing never names tools")
    }

    func testNativeHandoffCompletesItsDerivedRequestWithExactlyTheToolsTheBotHolds() async throws {
        let host = try MCFakeHost(nativeGranted: true)
        let workflowID = ManagedConnectAppsEditor.nativeSetupRequestID(actionID: "act_9")
        XCTAssertEqual(workflowID, "setup_act_9")
        await host.addWorkflow(id: workflowID, thread: "thread_1", native: true)
        let editor = host.editor(port: 49_967)
        defer { editor.close() }
        await editor.loadSetupRequest(id: workflowID)
        let workflow = try XCTUnwrap(editor.setupRequests?.first { $0.id == workflowID })
        await editor.loadSetupRequest(id: "setup_missing")
        XCTAssertNil(editor.setupRequests?.first { $0.id == "setup_missing" }, "nothing is created for an action without a request")
        await editor.loadChoices(workflow)
        let choice = try XCTUnwrap(editor.setupChoices[workflowID]?.choices.first)
        let held = choice.tools.filter(\.enabled).map(\.name)
        XCTAssertEqual(held, ["mcp.examplemcp.search"])
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: choice.connectionId, toolNames: ["mcp.examplemcp.search", "mcp.examplemcp.write"])])
        XCTAssertEqual(editor.notice, .workflowNothingGranted, "a native tool the bot does not hold is never granted from here")
        await editor.allowAndContinue(workflow, selections: [.init(connectionID: choice.connectionId, toolNames: held)])
        XCTAssertEqual(editor.notice, .workflowCompleted(continued: true))
        let log = await host.log()
        XCTAssertFalse(log.contains { $0.hasPrefix("PATCH") || $0.hasPrefix("PUT") }, "completing never writes grants")
        let completeData = await host.lastCompleteBody()
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(completeData)) as? [String: Any])
        let tools = ((body["selections"] as? [[String: Any]])?.first?["tools"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
        XCTAssertEqual(tools, ["mcp.examplemcp.search"])
    }

    // MARK: Tool-reported errors, executor, command review, exact current tools

    func testToolReportedErrorIsNeverShownAsSuccess() throws {
        func action(tool: String, result: JSONValue) throws -> Action {
            let object: [String: Any] = [
                "id": "act_e1", "request": ["botId": "bot_1", "threadId": "thread_1", "tool": tool, "destination": "conn_1",
                                            "idempotencyKey": "k1", "arguments": ["input": ["q": "x"]]],
                "requestHash": String(repeating: "a", count: 64), "grantRevision": 1, "state": "succeeded",
                "createdAt": Int64(1), "updatedAt": Int64(2), "approvalExpiresAt": NSNull(), "decidedBy": NSNull(), "reason": NSNull(),
                "result": try JSONSerialization.jsonObject(with: JSONEncoder().encode(result), options: .fragmentsAllowed)]
            return try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let failed = ApprovalPresentation(action: try action(tool: "mcp.examplemcp.write", result: .object(["isError": .bool(true), "content": .array([])])))
        XCTAssertEqual(failed.action.state, .succeeded, "the receipt keeps the transport status")
        XCTAssertTrue(failed.toolReportedError)
        XCTAssertEqual(failed.outcome(atMilliseconds: 3), .toolReportedError)
        XCTAssertNotEqual(failed.stateLabel(atMilliseconds: 3), ApprovalOutcome.completed.stateLabel)
        XCTAssertTrue(failed.resultExplanation.contains("parcial"), "the effect may be partial; never 'concluída'")
        XCTAssertFalse(failed.resultExplanation.contains("Execução concluída"))
        let ok = ApprovalPresentation(action: try action(tool: "mcp.examplemcp.write", result: .object(["isError": .bool(false), "content": .array([])])))
        XCTAssertEqual(ok.outcome(atMilliseconds: 3), .completed)
        let nested = ApprovalPresentation(action: try action(tool: "mcp.examplemcp.write", result: .object(["structuredContent": .object(["isError": .bool(true)])])))
        XCTAssertEqual(nested.outcome(atMilliseconds: 3), .completed, "only the top-level envelope flag counts; content is never interpreted")
        let stringFlag = ApprovalPresentation(action: try action(tool: "mcp.examplemcp.write", result: .object(["isError": .string("true")])))
        XCTAssertFalse(stringFlag.toolReportedError)
    }

    func testExecutorLineNeverClaimsTheServiceIsUp() throws {
        func server(_ executor: String?) throws -> McpServerSummary {
            let field = executor.map { #","executor":\#($0)"# } ?? ""
            return try JSONDecoder().decode(McpServerSummary.self, from: Data(#"{"id":"files","name":"Files","transport":"stdio","runsOn":"owner_mac","auth":"none","status":"configured","destination":"/opt/files-mcp"\#(field)}"#.utf8))
        }
        let here = try server(#"{"hostId":"host_1","name":"Studio","placement":"owner_mac","reachable":true}"#)
        XCTAssertEqual(here.executor?.name, "Studio")
        let line = ConnectionsPresentation.executorLine(here.executor, runsOn: here.runsOn, portuguese: true)
        XCTAssertTrue(line.contains("executor Studio respondeu esta leitura") && line.contains("não indica se o serviço está no ar"))
        let other = try server(#"{"hostId":null,"name":null,"placement":"cloud","reachable":null}"#)
        XCTAssertTrue(ConnectionsPresentation.executorLine(other.executor, runsOn: other.runsOn, portuguese: true).contains("estado dele não foi informado"))
        let invalid = try server(#"{"hostId":"h","name":"x","placement":"cloud","reachable":false}"#)
        XCTAssertNil(invalid.executor, "a value outside the contract is dropped, not shown")
        XCTAssertEqual(ConnectionsPresentation.executorLine(try server(nil).executor, runsOn: "owner_mac", portuguese: true), "Roda no Mac do dono da base")
        for text in [line, ConnectionsPresentation.executorLine(here.executor, runsOn: here.runsOn, portuguese: false)] {
            XCTAssertFalse(text.lowercased().contains("online"), "reachable is the executor answering this read, never the upstream")
        }
    }

    func testCommandReviewBlocksDiscoveryOnlyWhenTheProgramChanged() async throws {
        let digest = #"{"path":"/opt/files-mcp","sha256":"\#(String(repeating: "1", count: 64))","argsHash":"\#(String(repeating: "2", count: 64))","sizeBytes":1024}"#
        let other = #"{"path":"/opt/files-mcp","sha256":"\#(String(repeating: "3", count: 64))","argsHash":"\#(String(repeating: "2", count: 64))","sizeBytes":1024}"#
        let host = MCCommandHost(bodies: [
            "changed": #"{"reviewed":\#(digest),"current":\#(other),"state":"changed"}"#,
            "same": #"{"reviewed":\#(digest),"current":\#(digest),"state":"unchanged"}"#,
            "lying": #"{"reviewed":\#(digest),"current":\#(other),"state":"unchanged"}"#,
            "http": #"{"reviewed":null,"current":null,"state":"not_stdio"}"#,
            "old": "null"])
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49968")!, transport: host)
        defer { client.close() }
        let changed = try await client.mcpCommandStatus(serverID: "changed")
        let review = try XCTUnwrap(ConnectionsPresentation.commandReview(changed, portuguese: true))
        XCTAssertTrue(review.blocksDiscovery)
        XCTAssertEqual(review.tone, .problem)
        XCTAssertTrue(review.detail.contains("Descobrir não substitui a revisão"))
        XCTAssertEqual(ConnectionsPresentation.commandDigests(try XCTUnwrap(changed), portuguese: true).count, 2)
        let same = try await client.mcpCommandStatus(serverID: "same")
        XCTAssertEqual(ConnectionsPresentation.commandReview(same, portuguese: true)?.blocksDiscovery, false)
        XCTAssertTrue(ConnectionsPresentation.commandReview(same, portuguese: true)?.detail.contains("não é assinatura nem sandbox") == true)
        do { _ = try await client.mcpCommandStatus(serverID: "lying"); XCTFail("an 'unchanged' with different digests is a contract mismatch") }
        catch { XCTAssertEqual(error as? HostClientError, .contractMismatch) }
        let http = try await client.mcpCommandStatus(serverID: "http")
        XCTAssertNil(ConnectionsPresentation.commandReview(http, portuguese: true), "not a local process: nothing to review")
        let old = try await client.mcpCommandStatus(serverID: "old")
        XCTAssertNil(old)
        XCTAssertEqual(ConnectionsPresentation.commandReview(old, portuguese: true)?.tone, .unknown, "not reported stays unknown")
        let log = await host.paths()
        XCTAssertTrue(log.allSatisfy { $0.hasPrefix("GET ") && $0.hasSuffix("/command-status") }, "a read only: nothing starts or re-pins")
    }

    func testCurrentBotToolsAreExactOrUnknownAndManifestHashesAreValidated() throws {
        let host = try MCFakeHost()
        let exact = try host.decodedAccount(["bots": [["botId": MCFakeHost.botID, "access": "partial", "toolNames": ["gmail.read"]]]])
        XCTAssertEqual(exact.bots.first?.toolNames, ["gmail.read"])
        XCTAssertTrue(exact.isValid)
        let unknown = try host.decodedAccount()
        XCTAssertNil(unknown.bots.first?.toolNames, "absent means not reported, never 'all'")
        let foreign = try host.decodedAccount(["bots": [["botId": MCFakeHost.botID, "access": "enabled", "toolNames": ["gmail.delete"]]]])
        XCTAssertFalse(foreign.isValid, "a tool not pinned on this account is a contract mismatch")
        let hashed = try host.decodedAccount(["tools": [["name": "gmail.read", "effect": "read", "manifestHash": String(repeating: "c", count: 64)]]])
        XCTAssertEqual(hashed.tools.first?.manifestHash, String(repeating: "c", count: 64))
        let badHash = try host.decodedAccount(["tools": [["name": "gmail.read", "effect": "read", "manifestHash": "nothex"]]])
        XCTAssertFalse(badHash.isValid)
    }

    // MARK: Consented HTTP discovery after sign-in

    private func mcpServer(_ transport: String, pin: String? = nil) throws -> McpServerSummary {
        let field = pin.map { #","instancePin":"\#($0)""# } ?? ""
        return try JSONDecoder().decode(McpServerSummary.self, from: Data(#"{"id":"examplemcp","name":"ExampleMCP","transport":"\#(transport)","runsOn":"any","auth":"oauth","status":"needs_auth","destination":"https://mcp.examplemcp.test/mcp"\#(field)}"#.utf8))
    }
    private func credentials(_ state: String, server: String = "examplemcp") throws -> McpCredentialStatus {
        try JSONDecoder().decode(McpCredentialStatus.self, from: Data(#"{"serverId":"\#(server)","auth":"oauth","custody":null,"slots":[],"state":"\#(state)","expiresAt":null,"issuer":null,"lastError":null}"#.utf8))
    }
    private let pinA = String(repeating: "9", count: 64), pinB = String(repeating: "8", count: 64)

    func testSummaryInstancePinIsExactOrUnknownAndAMalformedOneIsRefused() throws {
        XCTAssertEqual(try mcpServer("streamable_http", pin: pinA).instancePin, pinA)
        XCTAssertNil(try mcpServer("streamable_http").instancePin, "an older base reports no pin: unknown, never guessed")
        XCTAssertThrowsError(try mcpServer("streamable_http", pin: "ABC"), "a malformed pin is a contract error, never compared or sent")
        XCTAssertEqual(McpConsentedDiscoveryPlan.resolvePin(handoff: pinA, summary: nil), .pin(pinA))
        XCTAssertEqual(McpConsentedDiscoveryPlan.resolvePin(handoff: nil, summary: pinA), .pin(pinA))
        XCTAssertEqual(McpConsentedDiscoveryPlan.resolvePin(handoff: pinA, summary: pinA), .pin(pinA))
        XCTAssertEqual(McpConsentedDiscoveryPlan.resolvePin(handoff: pinA, summary: pinB), .mismatch)
        XCTAssertEqual(McpConsentedDiscoveryPlan.resolvePin(handoff: nil, summary: nil), .missing)
        XCTAssertNil(ConnectionsPresentation.consentedDiscoveryUnavailable(.pin(pinA), portuguese: true))
        XCTAssertTrue(ConnectionsPresentation.consentedDiscoveryUnavailable(.missing, portuguese: true)?.contains("não informou a versão exata") == true)
        XCTAssertTrue(ConnectionsPresentation.consentedDiscoveryUnavailable(.mismatch, portuguese: true)?.contains("mudou desde o pedido") == true)
    }

    func testConsentedDiscoveryRunsOnceOnlyAfterTheSameSignInAndNeverForLocalProcesses() async throws {
        XCTAssertNil(McpConsentedDiscoveryPlan(server: try mcpServer("stdio", pin: pinA), instancePin: pinA, expiresAt: 10, now: { 0 }, isCurrent: { true }, dispatch: { _ in [] }),
                     "a local process is never started by a consented read")
        XCTAssertNil(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: "bad", expiresAt: 10, now: { 0 }, isCurrent: { true }, dispatch: { _ in [] }))
        XCTAssertNil(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 0, now: { 0 }, isCurrent: { true }, dispatch: { _ in [] }))
        XCTAssertNil(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http", pin: pinB), instancePin: pinA, expiresAt: 10, now: { 0 }, isCurrent: { true }, dispatch: { _ in [] }),
                     "a plan never targets a pin the base no longer reports")
        var sent: [String] = []
        let plan = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http", pin: pinA), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { true },
                                                           currentPin: { self.pinA }, dispatch: { value in sent.append(value); return [] }))
        await plan.signInObserved(try credentials("authorizing"))
        await plan.signInObserved(try credentials("unlocked", server: "other"))
        XCTAssertTrue(sent.isEmpty, "only the planned server, and only once its sign-in is ready")
        await plan.signInObserved(try credentials("unlocked"))
        await plan.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(sent, [pinA], "exactly one POST with the planned instance pin")
        XCTAssertEqual(plan.phase, .discovered(toolCount: 0))
    }

    func testConsentedDiscoveryIsInertWhenLateStoppedWithdrawnOrPinChangedAndNeverRetriesAnUncertainRead() async throws {
        var clock: Int64 = 1, current = true, calls = 0, basePin: String? = pinA
        let late = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 5, now: { clock }, isCurrent: { true },
                                                           dispatch: { _ in calls += 1; return [] }))
        clock = 6
        await late.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(late.phase, .expired)
        let stopped = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { current },
                                                              dispatch: { _ in calls += 1; return [] }))
        current = false
        await stopped.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(stopped.phase, .invalidated(.contextChanged), "a changed base/instance/conversation or Stop makes it inert")
        let repinned = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http", pin: pinA), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { true },
                                                               currentPin: { basePin }, dispatch: { _ in calls += 1; return [] }))
        basePin = pinB
        await repinned.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(repinned.phase, .invalidated(.pinChanged), "the instance changed before sign-in finished: nothing is sent")
        let withdrawn = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { true },
                                                                dispatch: { _ in calls += 1; return [] }))
        withdrawn.withdraw()
        await withdrawn.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(calls, 0)
        let lost = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { true },
                                                           dispatch: { _ in calls += 1; throw HostClientError.offline }))
        await lost.signInObserved(try credentials("unlocked"))
        await lost.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(lost.phase, .uncertain)
        XCTAssertEqual(calls, 1, "an uncertain read is never re-sent")
        let refused = try XCTUnwrap(McpConsentedDiscoveryPlan(server: try mcpServer("streamable_http"), instancePin: pinA, expiresAt: 100, now: { 1 }, isCurrent: { true },
                                                              dispatch: { _ in throw HostClientError.conflict }))
        await refused.signInObserved(try credentials("unlocked"))
        XCTAssertEqual(refused.phase, .refused)
        XCTAssertTrue(ConnectionsPresentation.consentedDiscoveryPlan(server: try mcpServer("streamable_http"), portuguese: true).contains("Nenhuma ferramenta é executada"))
    }

    func testManualReadWithoutHandoffUsesTheSummaryPinInOneValidPost() async throws {
        let host = MCDiscoverHost()
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49971")!, transport: host)
        defer { client.close() }
        let server = try mcpServer("streamable_http", pin: pinA)
        guard case .pin(let pin) = McpConsentedDiscoveryPlan.resolvePin(handoff: nil, summary: server.instancePin) else { return XCTFail("summary pin resolves") }
        let plan = try XCTUnwrap(McpConsentedDiscoveryPlan(server: server, instancePin: pin, expiresAt: Int64.max, isCurrent: { true }, currentPin: { pin },
                                                           dispatch: { try await client.discoverMcpServer(id: "examplemcp", expectedInstancePin: $0, httpOnly: true) }))
        await plan.signInObserved(try credentials("unlocked"))
        await plan.signInObserved(try credentials("unlocked"))
        let bodies = await host.bodies()
        XCTAssertEqual(bodies.count, 1)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any])
        XCTAssertEqual(body["expectedInstancePin"] as? String, pinA, "httpOnly is never sent without the exact pin")
        XCTAssertEqual(body["httpOnly"] as? Bool, true)
        XCTAssertEqual(plan.phase, .discovered(toolCount: 0))
    }

    func testDiscoverBodyIsLegacyEmptyOrExactlyTheTwoOptions() async throws {
        let host = MCDiscoverHost()
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49969")!, transport: host)
        defer { client.close() }
        _ = try await client.discoverMcpServer(id: "examplemcp")
        _ = try await client.discoverMcpServer(id: "examplemcp", expectedInstancePin: String(repeating: "9", count: 64), httpOnly: true)
        do { _ = try await client.discoverMcpServer(id: "examplemcp", expectedInstancePin: "not-a-pin"); XCTFail("invalid pin is refused locally") }
        catch { XCTAssertEqual(error as? HostClientError, .invalidRequest) }
        let bodies = await host.bodies()
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: bodies[0]) as? [String: AnyHashable], [:], "the legacy call still sends {}")
        let planned = try XCTUnwrap(try JSONSerialization.jsonObject(with: bodies[1]) as? [String: Any])
        XCTAssertEqual(Set(planned.keys), ["expectedInstancePin", "httpOnly"])
        XCTAssertEqual(planned["httpOnly"] as? Bool, true)
    }

    func testConsentedReadIsAVisibleExplicitControlNotAnAutomaticStep() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("SharedApp/Sources/McpConnectionsView.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("\"mcp.oauth-read-tools-after-login\""), "a real toggle with a stable identifier")
        XCTAssertTrue(source.contains("\"mcp.oauth-read-tools-plan\""), "the exact plan is shown beside it")
        XCTAssertTrue(source.contains("if server.transport != \"stdio\", !credentials.isReady {"), "never offered for a local process")
        XCTAssertTrue(source.contains("\"mcp.oauth-read-tools-unavailable\""), "without an agreed pin the switch says why it is off")
        XCTAssertTrue(source.contains("case .pin(let pin) = discoveryPinResolution"), "arming requires the resolved exact pin")
        // The only place a plan is created is the owner's toggle; the automatic handoff path never arms one.
        XCTAssertEqual(source.components(separatedBy: "state.armDiscoveryPlan()").count - 1, 1)
        XCTAssertFalse(source.contains("automaticHandoff: true) { armDiscoveryPlan") )
    }

    // MARK: Opus R1 regressions (OR-08, OR-10, OR-11)

    func testUncertainCompleteSettlesWhenTheRequestEndsAtTheSameRevisionAndFreesOtherCards() async throws {
        for ended in ["expired", "stopped"] {
            let host = try MCFakeHost(botsOnAccount: [MCFakeHost.botID], completeAnswersUnknown: true, completeApplies: false)
            await host.addWorkflow(id: "wf_a", thread: "thread_1")
            await host.addWorkflow(id: "wf_b", thread: "thread_1")
            let editor = host.editor(port: 49_972)
            await editor.reload()
            await editor.loadSetupRequests()
            let first = try XCTUnwrap(editor.openSetupRequests(now: 0).first { $0.id == "wf_a" })
            let second = try XCTUnwrap(editor.openSetupRequests(now: 0).first { $0.id == "wf_b" })
            await editor.loadChoices(first)
            let choice = try XCTUnwrap(editor.setupChoices["wf_a"]?.choices.first)
            await editor.allowAndContinue(first, selections: [.init(connectionID: choice.connectionId, toolNames: choice.tools.map(\.name))])
            XCTAssertEqual(editor.notice, .workflowUnknown)
            await editor.cancelSetupRequest(second)
            let blocked = await host.count("POST /v1/connections/setup-requests/wf_b/cancel")
            XCTAssertEqual(blocked, 0, "while one outcome is open, nothing else is sent")
            await host.endWorkflow(id: "wf_a", state: ended)
            await editor.checkWorkflow()
            XCTAssertNil(editor.pendingWorkflow, "\(ended): the open POST can no longer apply")
            XCTAssertEqual(editor.notice, .workflowEnded(ended == "expired" ? .expired : .stopped))
            await editor.cancelSetupRequest(second)
            XCTAssertEqual(editor.notice, .workflowEnded(.cancelled), "other cards are free again")
            let completes = await host.count("POST /v1/connections/setup-requests/wf_a/complete")
            XCTAssertEqual(completes, 1, "the uncertain complete is never re-sent")
            editor.close()
        }
    }

    func testEndedLoginIsNeverResumedAgainAndConnectStartsOneNewAttempt() async throws {
        for ended in ["cancelled", "expired", "failed"] {
            let host = try MCFakeHost(botsOnAccount: [])
            await host.addWorkflow(id: "wf_l", thread: "thread_1")
            let old = await host.addEndedAuthorization(setupRequest: "wf_l", state: ended)
            let editor = host.editor(port: 49_973)
            await editor.reload()
            await editor.loadSetupRequests()
            let workflow = try XCTUnwrap(editor.openSetupRequests(now: 0).first)
            await editor.loadChoices(workflow)
            XCTAssertEqual(editor.resumableAuthorizationID(for: "wf_l"), old, "not seen ending yet: offered once")
            let page = await editor.resumeAuthorization(clientRequestID: old)
            XCTAssertNil(page, "\(ended): no link for an ended attempt")
            XCTAssertNil(editor.resumableAuthorizationID(for: "wf_l"), "an ended attempt never replaces Conectar again")
            XCTAssertNil(editor.resumedAuthorizationID)
            let beforePosts = await host.count("POST /v1/connections/authorizations")
            XCTAssertEqual(beforePosts, 0, "reading the old attempt creates no new provider link")
            let fresh = await editor.startAuthorization(serviceID: "gmail", setupRequestID: "wf_l")
            XCTAssertEqual(fresh?.scheme, "https")
            XCTAssertEqual(editor.pendingAuthorization?.setupRequestId, "wf_l")
            let again = await editor.startAuthorization(serviceID: "gmail", setupRequestID: "wf_l")
            XCTAssertNil(again, "one POST per gesture while it is open")
            let posts = await host.count("POST /v1/connections/authorizations")
            XCTAssertEqual(posts, 1)
            await editor.loadChoices(workflow)
            XCTAssertNotEqual(editor.resumableAuthorizationID(for: "wf_l"), old)
            editor.close()
        }
    }

    func testPairedAccessUnknown503AndLegacy409RecoverByTheSameGetWithoutRepeatingPatch() async throws {
        for status in [409, 503] {
            let scopes: [ClientScope] = ClientScope.legacyPairing + [.connectionsRead, .connectionsManage]
            let binding = try MCInput.binding(scopes: scopes)
            let host = try MCFakeHost(botsOnAccount: [], accessAnswersUnknown: true, accessUnknownStatus: status)
            await host.useHostID("host_mc")
            let sender = MCPairedConnectionsSender(host: host)
            let client = HostClient(baseURL: binding.host.url, accessPolicy: .pairedHost(binding), transport: PairedHTTPTransport(binding: binding, sender: sender))
            let editor = ManagedConnectAppsEditor(client: client, ownsClient: false, scope: "paired")
            await editor.reload(); let account = try XCTUnwrap(editor.managedAccounts.first)
            await editor.setAccess(account, botID: MCFakeHost.botID, enabled: true, toolNames: ["gmail.read"])
            XCTAssertEqual(editor.notice, .accessUnknown)
            let pending = try XCTUnwrap(editor.pendingAccess)
            await editor.checkAccess()
            XCTAssertEqual(editor.notice, .accessSaved(enabled: true)); XCTAssertNil(editor.pendingAccess)
            let log = await host.log()
            XCTAssertEqual(log.filter { $0.hasPrefix("PATCH") }.count, 1)
            XCTAssertTrue(log.contains("GET /v1/connections/receipts/" + pending.input.clientRequestId))
            editor.close(); client.close()
        }
    }

    func testPairedPrivateInputsLoadAndDeclineWithTheInstallationAsExpectedHost() async throws {
        let scopes: [ClientScope] = ClientScope.legacyPairing + [.mcpRead, .mcpManage]
        let binding = try MCInput.binding(scopes: scopes)
        let sender = MCPairedInputSender(installation: "host_mc", device: "device_mc", scopes: binding.scopes.map(\.rawValue))
        let client = HostClient(baseURL: binding.host.url, accessPolicy: .pairedHost(binding), transport: PairedHTTPTransport(binding: binding, sender: sender))
        let editor = McpPrivateInputEditor(client: client, ownsClient: false, scope: "s")
        defer { editor.close(); client.close() }
        XCTAssertTrue(editor.canRead && editor.canAnswer)
        await editor.load()
        XCTAssertNotEqual(editor.notice, .loadFailed, "a paired /health carries installationId, not hostId")
        let input = try XCTUnwrap(editor.open(now: 0).first)
        await editor.respond(input, answer: .decline)
        XCTAssertEqual(editor.notice, .answered(.declined))
        let body = try XCTUnwrap(sender.lastRespondBody())
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["expectedHostID"] as? String, "host_mc")
        XCTAssertNil(object["approval"])
        XCTAssertEqual(sender.paths(), ["/health", "/v1/mcp/input-requests", "/v1/mcp/input-requests/mcpform_1/respond"])
    }

    // MARK: OR-20: every new/changed accessibility identifier is documented

    func testEveryNewAccessibilityIdentifierIsDocumented() throws {
        let apple = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let doc = try String(contentsOf: apple.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/mcp-apple-ux-inventory.md"), encoding: .utf8)
        let documented = Set(doc.components(separatedBy: "`").enumerated().filter { $0.offset % 2 == 1 }.map(\.element))
        func identifiers(_ file: String) throws -> Set<String> {
            let source = try String(contentsOf: apple.appendingPathComponent(file), encoding: .utf8)
            let literal = try NSRegularExpression(pattern: #"accessibilityIdentifier\("((?:[^"\\]|\\\((?:[^()]|\([^()]*\))*\))*)"\)"#)
            let interpolation = try NSRegularExpression(pattern: #"\\\((?:[^()]|\([^()]*\))*\)"#)
            let text = source as NSString
            return Set(literal.matches(in: source, range: NSRange(location: 0, length: text.length)).map { match in
                let raw = text.substring(with: match.range(at: 1)) as NSString
                return interpolation.stringByReplacingMatches(in: raw as String, range: NSRange(location: 0, length: raw.length), withTemplate: "*")
            })
        }
        var expected = try identifiers("SharedApp/Sources/ManagedConnectAppsViews.swift")
        XCTAssertGreaterThan(expected.count, 90, "the scan found the views' identifiers")
        // Built by concatenation in the row view (identifier + suffix).
        expected.formUnion(["settings.connections.account.*.facts", "settings.connections.account.*.primary", "settings.connections.account.*.inspect",
                            "settings.connections.native.*", "settings.connections.native.*.facts", "settings.connections.native.*.primary",
                            "settings.connections.native.*.inspect"])
        let manager = try identifiers("SharedApp/Sources/McpConnectionsView.swift")
        let managerNew: Set<String> = ["mcp.facts", "mcp.placement", "mcp.credential-error", "mcp.stdio-boundary", "mcp.command-review",
            "mcp.import-stdio-review", "mcp.oauth-client-required", "mcp.oauth-read-tools-plan", "mcp.oauth-read-tools-unavailable",
            "mcp.setup-request", "mcp.discover-confirm", "mcp.oauth-read-tools-after-login", "mcp.setup-request.allow",
            "mcp.setup-request.decline", "mcp.setup-request.check"]
        XCTAssertTrue(managerNew.isSubset(of: manager), "every documented manager identifier is real: \(managerNew.subtracting(manager))")
        expected.formUnion(managerNew)
        XCTAssertTrue(try identifiers("SharedApp/Sources/ConnectOtherBaseSheet.swift").contains("pairing-offer.scope.*"))
        expected.insert("pairing-offer.scope.*")
        let missing = expected.subtracting(documented).sorted()
        XCTAssertTrue(missing.isEmpty, "undocumented identifiers: \(missing)")
        // Removed identifiers are documented with their replacement.
        for removed in ["settings.connections.label.field", "settings.connections.label.save"] {
            XCTAssertTrue(documented.contains(removed))
            XCTAssertFalse(try identifiers("SharedApp/Sources/ManagedConnectAppsViews.swift").contains(removed))
        }
        XCTAssertTrue(doc.contains("bot-settings.mcp.global (correção)"), "the bot window button is described as the native manager it opens")
    }

    // MARK: Private MCP inputs (MRTR forms)

    func testPrivateFormsAcceptOnlyPrimitiveNonSecretShapes() throws {
        let form = try MCInput.make(requests: MCInput.choiceRequest)
        let parsed = try XCTUnwrap(form.forms?.first)
        XCTAssertEqual(parsed.fields.map(\.name), ["choice", "count", "note"])
        XCTAssertEqual(parsed.content(["choice": .string("yes"), "count": .integer(2)]), ["choice": .string("yes"), "count": .integer(2)])
        XCTAssertNil(parsed.content(["count": .integer(2)]), "required field missing")
        XCTAssertNil(parsed.content(["choice": .string("maybe")]), "outside the enum")
        XCTAssertNil(parsed.content(["choice": .string("yes"), "count": .integer(99)]), "above the maximum")
        XCTAssertNil(parsed.content(["choice": .string("yes"), "count": .number(1.5)]), "an integer field never takes a fraction")
        XCTAssertNil(parsed.content(["choice": .string("yes"), "extra": .bool(true)]), "unknown field")
        XCTAssertNotNil(try MCInput.make(requests: MCInput.withFormat).forms, "uri renders plain text with host final validation")
        for unsupported in [MCInput.urlMode, MCInput.nested, MCInput.sampling] {
            XCTAssertNil(try MCInput.make(requests: unsupported).forms, "URL mode, nested objects and other methods are not forms here")
        }
    }

    func testPrivateFormsShareHostAcceptedAnnotationsAndRejectSensitiveOrExecutableMetadata() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("DexterHostClientTests/Fixtures/mcp-private-form-r3.json")
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        for item in try XCTUnwrap(root["positive"] as? [[String: Any]]) {
            let input = try MCInput.make(requests: try XCTUnwrap(item["requestJSON"] as? String))
            XCTAssertNotNil(input.forms, item["name"] as? String ?? "positive")
            let responses = try JSONDecoder().decode([String: JSONValue].self, from: Data(try XCTUnwrap(item["responseJSON"] as? String).utf8))
            var contents: [String: [String: JSONValue]] = [:]
            for (key, value) in responses {
                guard case .object(let response) = value, case .object(let content)? = response["content"] else { return XCTFail("fixture response") }
                contents[key] = content
            }
            let answer = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: "host_x", answer: .accept(contents)), item["name"] as? String ?? "positive")
            let encoded = String(decoding: try JSONEncoder().encode(answer), as: UTF8.self)
            XCTAssertFalse(encoded.contains("requestState")); XCTAssertFalse(encoded.contains("_meta")); XCTAssertFalse(encoded.contains("opaque-round1"))
        }
        for item in try XCTUnwrap(root["negative"] as? [[String: Any]]) {
            XCTAssertNil((try? MCInput.make(requests: try XCTUnwrap(item["requestJSON"] as? String)))?.forms, item["name"] as? String ?? "negative")
        }
        let textForm = try XCTUnwrap(try MCInput.make(requests: #"{"r1":{"method":"elicitation/create","params":{"message":"A note","requestedSchema":{"type":"object","properties":{"note":{"type":"string"}}}}}}"#).forms?.first)
        XCTAssertNil(textForm.content(["note": .string("sk-TESTONLYDexterFixture00000000000")]), "dynamic answer values are checked too")
        XCTAssertNotNil(textForm.content(["note": .string("An ordinary note")]))
    }

    func testAcceptNeedsTheExactApprovalAndDeclineOrCancelSendNoValues() throws {
        let input = try MCInput.make(requests: MCInput.choiceRequest)
        let accept = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: "host_x", answer: .accept(["r1": ["choice": .string("no")]])))
        XCTAssertEqual(accept.approval, "approve_exact_input")
        XCTAssertEqual(accept.responses["r1"], .object(["action": .string("accept"), "content": .object(["choice": .string("no")])]))
        XCTAssertEqual(accept.expectedRevision, input.revision)
        XCTAssertEqual(accept.acceptedValues.map(\.field), ["choice"])
        let decline = try XCTUnwrap(RespondMcpPrivateInputInput(input: input, hostID: "host_x", answer: .decline))
        XCTAssertNil(decline.approval)
        XCTAssertEqual(decline.responses["r1"], .object(["action": .string("decline")]))
        XCTAssertNil(RespondMcpPrivateInputInput(input: input, hostID: "host_x", answer: .accept(["r1": ["choice": .string("maybe")]])), "invalid values build nothing")
        XCTAssertNil(RespondMcpPrivateInputInput(input: input, hostID: "host_x", answer: .accept([:])), "every form must be answered")
        let encoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(decline)) as? [String: Any])
        XCTAssertNil(encoded["approval"], "decline/cancel carry no approval")
    }

    func testPrivateInputAnswerIsOnePostAndUnknownIsSettledByReading() async throws {
        let host = MCInputHost(mode: .unknownAfterApplying)
        let editor = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49964")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.load()
        let input = try XCTUnwrap(editor.open(threadID: "thread_1", now: 0).first)
        XCTAssertTrue(editor.open(threadID: "other", now: 0).isEmpty)
        await editor.respond(input, answer: .accept(["r1": ["choice": .string("yes")]]))
        XCTAssertEqual(editor.notice, .unknown)
        await editor.respond(input, answer: .decline)
        let posts = await host.posts()
        XCTAssertEqual(posts.count, 1, "nothing else is sent while the answer is open")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: posts[0]) as? [String: Any])
        XCTAssertEqual(body["approval"] as? String, "approve_exact_input")
        XCTAssertEqual(body["actionId"] as? String, input.actionId)
        XCTAssertEqual(body["requestHash"] as? String, input.requestHash)
        await editor.check()
        XCTAssertEqual(editor.notice, .answered(.answered))
        XCTAssertNil(editor.pending)
    }

    func testPrivateInputCheckShowsNotAppliedAndPairedReadOnlyCannotAnswer() async throws {
        let host = MCInputHost(mode: .unknownNotApplied)
        let editor = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49965")!, transport: host), ownsClient: true, scope: "s")
        defer { editor.close() }
        await editor.load()
        let input = try XCTUnwrap(editor.open(now: 0).first)
        await editor.respond(input, answer: .cancel)
        XCTAssertEqual(editor.notice, .unknown)
        await editor.check()
        XCTAssertEqual(editor.notice, .notApplied, "the same pending revision: nothing was applied")
        XCTAssertNil(editor.pending)

        let unsupported = MCInputHost(mode: .unavailable)
        let other = McpPrivateInputEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:49966")!, transport: unsupported), ownsClient: true, scope: "s")
        defer { other.close() }
        await other.load()
        XCTAssertEqual(other.supported, false, "a base without the feature is unsupported, not empty")
    }

    // MARK: Paired scopes (connections.* / mcp.*)

    func testPairedRoutesCarryTheirExactScopeAndBodiesAreClosed() throws {
        func route(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> ClientRequest {
            var request = URLRequest(url: URL(string: "https://127.0.0.1:49970" + path)!)
            request.httpMethod = method
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
            return try PairedHTTPTransport.prepare(request, binding: try MCInput.binding(scopes: ClientScope.allCases))
        }
        XCTAssertEqual(try route("GET", "/v1/connections/accounts").route.scope, .connectionsRead)
        XCTAssertEqual(try route("GET", "/v1/connections/setup-requests/wf_1/choices").route.scope, .connectionsRead)
        XCTAssertEqual(try route("GET", "/v1/mcp/input-requests").route.scope, .mcpRead)
        XCTAssertEqual(try route("GET", "/v1/mcp/servers/files/command-status").route.scope, .mcpRead)
        let access: [String: Any] = ["expectedHostID": "h", "clientRequestId": "r1", "expectedRevision": 2, "botId": "b1", "enabled": true, "toolNames": ["gmail.read"]]
        XCTAssertEqual(try route("PATCH", "/v1/connections/accounts/acct_1/access", body: access).route.scope, .connectionsManage)
        var extra = access; extra["policy"] = "allow"
        XCTAssertThrowsError(try route("PATCH", "/v1/connections/accounts/acct_1/access", body: extra), "unknown keys are refused before sending")
        let respond: [String: Any] = ["expectedHostID": "h", "clientRequestId": "r2", "expectedRevision": 1, "actionId": "a1",
                                      "requestHash": String(repeating: "a", count: 64), "responses": ["r1": ["action": "accept", "content": ["choice": "yes"]]]]
        XCTAssertThrowsError(try route("POST", "/v1/mcp/input-requests/f1/respond", body: respond), "accept without the exact approval is refused")
        var approved = respond; approved["approval"] = "approve_exact_input"
        XCTAssertEqual(try route("POST", "/v1/mcp/input-requests/f1/respond", body: approved).route.scope, .mcpManage)
        XCTAssertThrowsError(try route("POST", "/v1/mcp/servers/x/oauth/start", body: [:]), "private custody routes never cross the paired channel")
        XCTAssertThrowsError(try route("PUT", "/v1/connections/platform-configuration", body: [:]))
    }

    func testOfferScopesAreOptInAndBoundedToFourteen() {
        var selection = PairingScopeSelection()
        XCTAssertEqual(selection.scopes, PairingScopeCatalog.historical.sorted(), "nothing beyond the historical eight by default")
        selection.set(PairingScopeCatalog.connectionsManage, on: true)
        XCTAssertTrue(selection.connectionsManageWithoutReading)
        for scope in PairingScopeCatalog.connections + PairingScopeCatalog.outputs { selection.set(scope, on: true) }
        XCTAssertEqual(selection.scopes.count, 14)
        XCTAssertEqual(selection.scopes, selection.scopes.sorted())
        XCTAssertTrue(OwnerPairingScopes.isValid(selection.scopes))
        XCTAssertFalse(OwnerPairingScopes.isValid(selection.scopes + ["connections.admin"]))
        XCTAssertEqual(PairingScopeCatalog.labelKey("mcp.manage"), "Responder pedidos de servidores MCP")
    }

    // MARK: Close, Escape and identifiers of every connections sheet

    func testEveryConnectionsSheetHasAVisibleCloseThatEscapeTriggers() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("SharedApp/Sources/ManagedConnectAppsViews.swift"), encoding: .utf8)
        for (type, closeID) in [("struct ConnectionAccountInspector", "connections.inspector.close"),
                                ("struct ConnectionSetupRequestSheet", "connections.request-review.close"),
                                ("struct ManagedConnectAppsRequirementsSheet", "settings.connections.requirements.close")] {
            let start = try XCTUnwrap(source.range(of: type), type)
            let body = source[start.lowerBound...]
            let end = body.range(of: "\n}\n")?.lowerBound ?? body.endIndex
            let declaration = String(body[..<end])
            XCTAssertTrue(declaration.contains(".keyboardShortcut(.cancelAction)"), "\(type): Escape closes")
            XCTAssertTrue(declaration.contains("\"\(closeID)\""), "\(type): visible close with a stable id")
        }
        XCTAssertFalse(source.contains(".sheet(") && source.contains("ConnectionLabelSheet("), "rename is inline; no sheet over the inspector")
    }

    private func waitUntil(_ condition: @escaping @MainActor () async -> Bool) async throws {
        for _ in 0..<300 { if await condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        XCTFail("condition not reached")
    }
}

/// Owner-loopback connections host for these tests, from the golden responses: one managed account (programmable status,
/// bots, manifest hashes), its receipts, authorizations and setup requests. Lost answers (503 `outcome_unknown` after
/// applying) prove the app settles them by reading only.
private actor MCFakeHost: HTTPTransport {
    nonisolated static let botID = "bot_26e01326-1bef-47d2-9c3d-7536586ff485"
    private let calls: [String: Any]
    private var hostID: String
    private var accounts: [[String: Any]]
    private var receipts: [String: [String: Any]] = [:]
    private var authorizations: [String: [String: Any]] = [:]
    private var workflows: [String: [String: Any]] = [:]
    private var entries: [String] = []
    private var completeBody: Data?
    private var accessBody: Data?
    private var accessBodyLog: [Data] = []
    /// Exact tools per account and bot (nil = every pinned tool, the legacy meaning).
    private var botTools: [String: [String: [String]?]] = [:]
    private var setupAuthorizations: [String: [String]] = [:]
    private let disconnectAnswersUnknown: Bool, disconnectKeepsDisconnecting: Bool, completeAnswersUnknown: Bool, completeApplies: Bool
    private let setupRoute: Bool
    private let choicesAvailable: Bool
    private let choicesDelay: Duration?
    private let accessUnknownStatus: Int
    private var authorizationReadFailures = 0
    private let nativeGranted: Bool
    private let accessDelay: Duration?
    /// Terminal outcome the host states for the next access PATCH (nil = applied, as historical receipts) and whether the
    /// PATCH answer is lost (503) after the receipt exists.
    private var accessOutcome: String?
    private let accessAnswersUnknown: Bool
    private let originalAccount: [String: Any]
    nonisolated let originalAccountData: Data

    init(status: String = "connected", botsOnAccount: [String]? = nil, disconnectAnswersUnknown: Bool = false,
         disconnectKeepsDisconnecting: Bool = false, completeAnswersUnknown: Bool = false, completeApplies: Bool = true,
         setupRoute: Bool = true, choicesAvailable: Bool = true, accessDelay: Duration? = nil, accountCount: Int = 1, nativeGranted: Bool = false,
         accessOutcome: String? = nil, accessAnswersUnknown: Bool = false, accessUnknownStatus: Int = 503, choicesDelay: Duration? = nil) throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("DexterHostClientTests/Fixtures/connections-golden.json")
        let golden = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let parsed = try XCTUnwrap(golden["calls"] as? [String: Any])
        calls = parsed
        hostID = try XCTUnwrap(golden["hostId"] as? String)
        var account = try XCTUnwrap((((parsed["accounts"] as? [String: Any])?["response"] as? [String: Any])?["items"] as? [[String: Any]])?.first)
        account["status"] = status
        if let botsOnAccount { account["bots"] = botsOnAccount.map { ["botId": $0, "access": "enabled"] } }
        originalAccount = account
        originalAccountData = try JSONSerialization.data(withJSONObject: account)
        accounts = [account]
        self.disconnectAnswersUnknown = disconnectAnswersUnknown; self.disconnectKeepsDisconnecting = disconnectKeepsDisconnecting
        self.completeAnswersUnknown = completeAnswersUnknown; self.completeApplies = completeApplies
        self.setupRoute = setupRoute; self.choicesAvailable = choicesAvailable; self.accessDelay = accessDelay; self.nativeGranted = nativeGranted
        self.accessOutcome = accessOutcome; self.accessAnswersUnknown = accessAnswersUnknown
        self.accessUnknownStatus = accessUnknownStatus; self.choicesDelay = choicesDelay
        for index in 1..<max(1, accountCount) { accounts.append(Self.extraAccount(from: account, index: index)) }
    }

    nonisolated func decodedAccount(_ overrides: [String: Any] = [:]) throws -> ConnectionAccount {
        var item = try XCTUnwrap(try JSONSerialization.jsonObject(with: originalAccountData) as? [String: Any])
        item["status"] = "connected"
        for (key, value) in overrides { item[key] = value }
        return try JSONDecoder().decode(ConnectionAccount.self, from: JSONSerialization.data(withJSONObject: item))
    }

    @MainActor func editor(port: Int) -> ManagedConnectAppsEditor {
        ManagedConnectAppsEditor(client: HostClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, transport: self), ownsClient: true, scope: "s")
    }

    func log() -> [String] { entries }
    func failNextAuthorizationRead() { authorizationReadFailures += 1 }
    func corruptWorkflow(_ id: String) { workflows[id]?["version"] = 999 }
    func setWorkflowState(_ id: String, state: String, continuation: String) {
        workflows[id]?["state"] = state; workflows[id]?["continuationTurnId"] = continuation
    }
    func count(_ entry: String) -> Int { entries.filter { $0 == entry }.count }
    func count(prefix: String) -> Int { entries.filter { $0.hasPrefix(prefix) }.count }
    func lastCompleteBody() -> Data? { completeBody }
    func lastAccessBodyData() -> Data? { accessBody }
    func setAccessOutcome(_ value: String?) { accessOutcome = value }
    func accessBodies() -> [Data] { accessBodyLog }
    func accountIDs() -> [String] { accounts.compactMap { $0["id"] as? String } }
    /// A further connected account of the same service (as if the owner connected it later).
    func addAccount() { accounts.append(Self.extraAccount(from: originalAccount, index: accounts.count)) }
    private static func extraAccount(from original: [String: Any], index: Int) -> [String: Any] {
        var account = original
        account["id"] = "acct_" + UUID().uuidString.lowercased(); account["label"] = "Conta \(index + 1)"; account["revision"] = 1
        account["gatewayConnectionIds"] = ["conn_" + UUID().uuidString.lowercased()]; account["bots"] = [[String: Any]]()
        return account
    }
    func bumpRevision() { accounts[0]["revision"] = (accounts[0]["revision"] as? Int ?? 1) + 1 }
    func switchHost() { hostID = "host_" + UUID().uuidString.lowercased() }
    func useHostID(_ id: String) { hostID = id }

    func addWorkflow(id: String, thread: String, native: Bool = false) {
        workflows[id] = ["version": 1, "id": id, "hostId": hostID, "botId": Self.botID, "threadId": thread, "originTurnId": "turn_1", "actionId": "act_1",
                         "clientRequestId": UUID().uuidString.lowercased(), "requestHash": String(repeating: "c", count: 64),
                         "target": native ? ["kind": "native_mcp", "serverId": "examplemcp", "instancePin": String(repeating: "d", count: 64)]
                                          : ["kind": "managed", "serviceId": "gmail", "catalogPin": catalogPin],
                         "revision": 1, "state": "awaiting_user",
                         "expiresAt": 9_000_000_000_000, "createdAt": 1, "selections": [[String: Any]](), "continuationTurnId": NSNull()]
    }

    /// Host-computed choices: the account's gateway connection (or the native instance's) at its gateway revision, each
    /// active tool's pin, and whether the request's bot holds it now. Reading grants nothing.
    private func choices(_ workflow: [String: Any]) -> [String: Any] {
        let native = (workflow["target"] as? [String: Any])?["kind"] as? String == "native_mcp"
        let list: [[String: Any]]
        if native {
            list = [["connectionId": "conn_native_examplemcp", "expectedRevision": 3, "label": "ExampleMCP",
                     "tools": [["name": "mcp.examplemcp.search", "manifestHash": String(repeating: "e", count: 64), "effect": "read", "enabled": nativeGranted],
                               ["name": "mcp.examplemcp.write", "manifestHash": String(repeating: "f", count: 64), "effect": "write", "enabled": false]]]]
        } else {
            list = accounts.filter { $0["status"] as? String == "connected" }.map { account -> [String: Any] in
                let id = account["id"] as? String ?? ""
                let enabled = (account["bots"] as? [[String: Any]] ?? []).contains { $0["botId"] as? String == Self.botID && $0["access"] as? String == "enabled" }
                let exact = botTools[id]?[Self.botID] ?? nil
                let tools = (account["tools"] as? [[String: Any]] ?? []).enumerated().map { index, tool -> [String: Any] in
                    let name = tool["name"] as? String ?? ""
                    return ["name": name, "manifestHash": String(repeating: index == 0 ? "1" : "2", count: 64), "effect": tool["effect"] ?? "write",
                            "enabled": enabled && (exact.map { $0.contains(name) } ?? true)]
                }
                return ["connectionId": (account["gatewayConnectionIds"] as? [String])?.first ?? "conn_x", "expectedRevision": 7,
                        "label": account["label"] ?? "Gmail", "tools": tools]
            }
        }
        return ["requestId": workflow["id"] ?? "", "revision": workflow["revision"] ?? 1, "choices": list,
                "authorizationRequestIds": setupAuthorizations[workflow["id"] as? String ?? ""] ?? [String]()]
    }

    /// The host now projects a request as ended without a new revision (expired/stopped keep the same revision).
    func endWorkflow(id: String, state: String) { workflows[id]?["state"] = state }

    /// A login attempt for a setup request that already ended (expired/cancelled/failed). Returns its request id.
    func addEndedAuthorization(setupRequest: String, state: String) -> String {
        let id = UUID().uuidString.lowercased()
        var value = response("start")
        value["id"] = "auth_" + UUID().uuidString.lowercased(); value["clientRequestId"] = id
        value["requestHash"] = String(repeating: "e", count: 64); value["state"] = state
        value["reason"] = state == "expired" ? "link_expired" : state == "cancelled" ? "user_cancelled" : "provider_failed"
        value["authorizationURL"] = NSNull(); value["linkAvailable"] = false; value["accountId"] = NSNull()
        value["setupRequestId"] = setupRequest; value["callback"] = state == "cancelled" ? "cancelled" : "none"
        authorizations[id] = value
        setupAuthorizations[setupRequest, default: []].append(id)
        return id
    }

    /// The pending authorization connects: a NEW account (replacing the old one when asked) with no bots.
    func completeAuthorization(newAccountWithoutBots: Bool) {
        for (id, var authorization) in authorizations where authorization["state"] as? String == "awaiting_user" {
            let newID = "acct_" + UUID().uuidString.lowercased()
            var account = originalAccount
            account["id"] = newID; account["status"] = "connected"; account["revision"] = 1
            account["bots"] = newAccountWithoutBots ? [[String: Any]]() : originalAccount["bots"]
            account["previousAccountId"] = authorization["replacesAccountId"] ?? NSNull()
            account["identityChanged"] = false
            accounts.append(account)
            if authorization["replacesAccountId"] is String { accounts[0]["status"] = "replaced" }
            authorization["state"] = "connected"; authorization["accountId"] = newID; authorization["authorizationURL"] = NSNull()
            authorization["linkAvailable"] = false; authorization["callback"] = "returned"
            authorizations[id] = authorization
        }
    }

    private var catalog: [String: Any] { ((calls["catalog"] as? [String: Any])?["response"] as? [String: Any]) ?? [:] }
    private var catalogPin: String { catalog["pin"] as? String ?? "" }
    private func response(_ name: String) -> [String: Any] { ((calls[name] as? [String: Any])?["response"] as? [String: Any]) ?? [:] }
    private func rehost(_ value: Any) -> Any {
        if var object = value as? [String: Any] {
            for (key, item) in object { object[key] = key == "hostId" ? hostID : rehost(item) }
            return object
        }
        if let array = value as? [Any] { return array.map(rehost) }
        return value
    }
    private func json(_ value: Any, status: Int = 200) throws -> TransportResponse {
        TransportResponse(statusCode: status, data: try JSONSerialization.data(withJSONObject: rehost(value)))
    }
    private func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: rehost(value)))
    }
    private func notFound() throws -> TransportResponse { try json(["error": "not_found", "message": "x"], status: 404) }
    private var unknown: [String: Any] { ["error": "outcome_unknown", "message": "synthetic lost answer"] }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let method = request.httpMethod ?? "GET", path = request.url?.path ?? ""
        entries.append("\(method) \(path)")
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        switch (method, path) {
        case ("GET", "/v1/connections/status"): return try json(response("status"))
        case ("GET", "/v1/connections/catalog"): return try json(catalog)
        case ("GET", "/v1/connections/accounts"): return try json(["version": 1, "hostId": hostID, "items": accounts])
        case ("POST", "/v1/connections/authorizations"):
            let catalogValue = try decode(ConnectionCatalog.self, catalog)
            let id = try XCTUnwrap(body["clientRequestId"] as? String)
            let input = StartConnectionAuthorizationInput(catalog: catalogValue, serviceId: try XCTUnwrap(body["serviceId"] as? String), clientRequestId: id,
                profileId: body["profileId"] as? String, label: body["label"] as? String, replacesAccountId: body["replacesAccountId"] as? String,
                setupRequestId: body["setupRequestId"] as? String)
            var started = response("start")
            started["id"] = "auth_" + UUID().uuidString.lowercased()
            started["clientRequestId"] = id; started["requestHash"] = input.requestHash
            started["replacesAccountId"] = body["replacesAccountId"] ?? NSNull()
            if let setup = body["setupRequestId"] as? String { started["setupRequestId"] = setup; setupAuthorizations[setup, default: []].append(id) }
            if let profile = body["profileId"] as? String { started["profileId"] = profile }
            authorizations[id] = started
            return try json(started, status: 201)
        case ("GET", "/v1/connections/setup-requests"):
            guard setupRoute else { return try notFound() }
            return try json(["requests": workflows.keys.sorted().compactMap { workflows[$0] }])
        default: break
        }
        if method == "GET", path.hasPrefix("/v1/connections/authorizations/") {
            let id = String(path.dropFirst("/v1/connections/authorizations/".count))
            guard let value = authorizations[id] else { return try notFound() }
            if authorizationReadFailures > 0 { authorizationReadFailures -= 1; return try json(unknown, status: 503) }
            return try json(value)
        }
        if method == "GET", path.hasPrefix("/v1/connections/accounts/") {
            let id = String(path.dropFirst("/v1/connections/accounts/".count))
            guard let item = accounts.first(where: { $0["id"] as? String == id }) else { return try notFound() }
            return try json(item)
        }
        if method == "PATCH", path.hasSuffix("/access") {
            let index = try XCTUnwrap(accounts.firstIndex { path.contains($0["id"] as? String ?? "?") })
            let current = try decode(ConnectionAccount.self, accounts[index])
            guard body["expectedRevision"] as? Int == current.revision else { return try json(["error": "conflict", "message": "x"], status: 409) }
            let id = try XCTUnwrap(body["clientRequestId"] as? String), bot = try XCTUnwrap(body["botId"] as? String), enabled = try XCTUnwrap(body["enabled"] as? Bool)
            let names = body["toolNames"] as? [String]
            accessBody = request.httpBody
            if let data = request.httpBody { accessBodyLog.append(data) }
            let input = SetConnectionBotAccessInput(account: current, botId: bot, enabled: enabled, toolNames: names, clientRequestId: id)
            var receipt = response("access")
            receipt["clientRequestId"] = id; receipt["requestHash"] = input.requestHash(accountID: current.id); receipt["accountId"] = current.id
            receipt["previousRevision"] = current.revision
            var access: [String: Any] = ["botId": bot, "enabled": enabled, "tools": names?.count ?? current.tools.count]
            if let names { access["toolNames"] = names }
            switch accessOutcome {
            case "not_applied"?:
                // No Hub commit: the account and grants stay as they were; the receipt keeps the previous revision.
                receipt["revision"] = current.revision; access["tools"] = 0
            case "superseded"?:
                // Grants committed, then the account changed again concurrently: recovery repeats nothing and reports the
                // account's current revision.
                botTools[current.id, default: [:]][bot] = names
                accounts[index]["revision"] = current.revision + 2
                receipt["revision"] = current.revision + 2
            default:
                botTools[current.id, default: [:]][bot] = names
                var bots = (accounts[index]["bots"] as? [[String: Any]] ?? []).filter { $0["botId"] as? String != bot }
                if enabled { bots.append(["botId": bot, "access": "enabled"]) }
                accounts[index]["bots"] = bots; accounts[index]["revision"] = current.revision + 1
                receipt["revision"] = current.revision + 1
            }
            if let accessOutcome { receipt["accessOutcome"] = accessOutcome }
            receipt["access"] = access
            receipts[id] = receipt
            if accessAnswersUnknown { return try json(unknown, status: accessUnknownStatus) }
            // Applied first, answer later: a cancelled caller never learns the outcome from this request.
            if let accessDelay { try await Task.sleep(for: accessDelay) }
            return try json(receipt)
        }
        if method == "POST", path.hasSuffix("/disconnect") {
            let index = try XCTUnwrap(accounts.firstIndex { path.contains($0["id"] as? String ?? "?") })
            let current = try decode(ConnectionAccount.self, accounts[index])
            guard body["expectedRevision"] as? Int == current.revision else { return try json(["error": "conflict", "message": "x"], status: 409) }
            let id = try XCTUnwrap(body["clientRequestId"] as? String)
            let input = DisconnectConnectionAccountInput(account: current, clientRequestId: id)
            accounts[index]["revision"] = current.revision + 1
            if disconnectKeepsDisconnecting {
                accounts[index]["status"] = "disconnecting"
                return try json(unknown, status: 503)
            }
            accounts[index]["status"] = "disconnected"; accounts[index]["bots"] = [[String: Any]]()
            accounts[index]["disconnect"] = ["upstream": "deleted", "revocation": "requested"]
            var receipt = response("disconnect")
            receipt["clientRequestId"] = id; receipt["requestHash"] = input.requestHash(accountID: current.id); receipt["accountId"] = current.id
            receipt["previousRevision"] = current.revision; receipt["revision"] = current.revision + 1
            receipts[id] = receipt
            return disconnectAnswersUnknown ? try json(unknown, status: 503) : try json(receipt)
        }
        if method == "GET", path.hasPrefix("/v1/connections/receipts/") {
            let id = String(path.dropFirst("/v1/connections/receipts/".count))
            guard let receipt = receipts[id] else { return try notFound() }
            return try json(receipt)
        }
        if path.hasPrefix("/v1/connections/setup-requests/") {
            guard setupRoute else { return try notFound() }
            let rest = path.dropFirst("/v1/connections/setup-requests/".count).split(separator: "/").map(String.init)
            guard let id = rest.first, var workflow = workflows[id] else { return try notFound() }
            if method == "GET", rest.count == 1 { return try json(workflow) }
            if method == "GET", rest.count == 2, rest[1] == "choices" {
                guard choicesAvailable else { return try json(["error": "device_unavailable", "message": "x"], status: 503) }
                if let choicesDelay { try await Task.sleep(for: choicesDelay) }
                return try json(choices(workflow))
            }
            guard method == "POST", rest.count == 2 else { return try notFound() }
            guard body["expectedRevision"] as? Int == workflow["revision"] as? Int, workflow["state"] as? String == "awaiting_user" else {
                return try json(["error": "conflict", "message": "x"], status: 409)
            }
            if rest[1] == "complete" {
                completeBody = request.httpBody
                if completeApplies {
                    workflow["state"] = "ready"; workflow["revision"] = (workflow["revision"] as? Int ?? 1) + 1
                    workflow["selections"] = body["selections"]; workflow["continuationTurnId"] = "turn_continuation_1"
                    workflows[id] = workflow
                }
                return completeAnswersUnknown ? try json(unknown, status: 503) : try json(workflow)
            }
            if rest[1] == "cancel" {
                workflow["state"] = "cancelled"; workflow["revision"] = (workflow["revision"] as? Int ?? 1) + 1
                workflows[id] = workflow
                return try json(workflow)
            }
        }
        return try notFound()
    }
}
/// Synthetic private-input fixtures (MRTR forms) and a paired binding for route checks.
private enum MCInput {
    nonisolated static let choiceRequest = #"{"r1":{"method":"elicitation/create","params":{"mode":"form","message":"Escolha uma opção","requestedSchema":{"type":"object","properties":{"choice":{"type":"string","enum":["yes","no"]},"count":{"type":"integer","minimum":1,"maximum":3},"note":{"type":"string","maxLength":40}},"required":["choice"],"additionalProperties":false}}}}"#
    nonisolated static let urlMode = #"{"r1":{"method":"elicitation/create","params":{"mode":"url","message":"Abra","requestedSchema":{"type":"object","properties":{"a":{"type":"string"}}}}}}"#
    nonisolated static let nested = #"{"r1":{"method":"elicitation/create","params":{"message":"x","requestedSchema":{"type":"object","properties":{"a":{"type":"object"}}}}}}"#
    nonisolated static let withFormat = #"{"r1":{"method":"elicitation/create","params":{"message":"x","requestedSchema":{"type":"object","properties":{"a":{"type":"string","format":"uri"}}}}}}"#
    nonisolated static let sampling = #"{"r1":{"method":"sampling/createMessage","params":{"message":"x"}}}"#

    nonisolated static func json(requests: String, state: String = "pending", revision: Int = 1, clientRequestId: String? = nil) -> String {
        let request = clientRequestId.map { "\"\($0)\"" } ?? "null"
        return #"{"version":1,"id":"mcpform_1","actionId":"act_1","requestHash":"\#(String(repeating: "b", count: 64))","connectionId":"conn_1","botId":"bot_1","threadId":"thread_1","revision":\#(revision),"state":"\#(state)","requests":\#(requests),"createdAt":1,"expiresAt":9000000000000,"responseHash":null,"clientRequestId":\#(request)}"#
    }
    static func make(requests: String) throws -> McpPrivateInput {
        try JSONDecoder().decode(McpPrivateInput.self, from: Data(json(requests: requests).utf8))
    }

    @MainActor static func binding(scopes: [ClientScope]) throws -> PairedHostBinding {
        let fixture = try IntegrationTLSFixture(identity: try ClientNativeIdentity.ephemeralFixture())
        let certificate = fixture.der, fingerprint = fixture.fingerprint
        fixture.close()
        let host = try PinnedClientHost(url: URL(string: "https://127.0.0.1:49970")!, certificateDER: certificate, fingerprint: fingerprint)
        let scope = try ClientIdentityScope(installationID: "host_mc", localBindingID: String(repeating: "d", count: 32), role: .clientIOS, hostFingerprint: fingerprint)
        let bundle = try ClientPairingBundle(host: host, installationID: "host_mc", offerID: "offer", role: .clientIOS, expiresAt: Date().addingTimeInterval(300), code: String(repeating: "z", count: 43))
        return try PairedHostBinding(bundle: bundle, scope: scope, identity: try ClientNativeIdentity.ephemeralFixture(), claimID: "claim",
            value: ["protocol": "dexter-app-client-v1", "status": "approved", "deviceId": "device_mc", "installationId": "host_mc", "ownerId": "owner_mc",
                    "role": "client-ios", "scopes": scopes.map(\.rawValue).sorted(), "pinGeneration": 1, "bindingRevision": 1])
    }
}

/// Owner-loopback host answering /health and the private-input routes; the answer can be lost after applying, lost
/// without applying, or the feature can be absent (503).
private actor MCInputHost: HTTPTransport {
    enum Mode: Sendable { case unknownAfterApplying, unknownNotApplied, unavailable }
    let mode: Mode
    private var current = MCInput.json(requests: MCInput.choiceRequest)
    private var bodies: [Data] = []
    init(mode: Mode) { self.mode = mode }
    func posts() -> [Data] { bodies }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url?.path ?? "", method = request.httpMethod ?? "GET"
        func json(_ text: String, _ status: Int = 200) -> TransportResponse { TransportResponse(statusCode: status, data: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/health"):
            return json(#"{"protocolVersion":1,"mode":"local-development","engineRouting":"synthetic","remotePairing":"not_implemented","hostId":"host_mc","state":{}}"#)
        case ("GET", "/v1/mcp/input-requests"):
            if mode == .unavailable { return json(#"{"error":"device_unavailable","message":"x"}"#, 503) }
            return json("{\"requests\":[\(current)]}")
        case ("GET", "/v1/mcp/input-requests/mcpform_1"):
            return json(current)
        case ("POST", "/v1/mcp/input-requests/mcpform_1/respond"):
            let body = request.httpBody ?? Data()
            bodies.append(body)
            let object = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            if mode == .unknownAfterApplying {
                current = MCInput.json(requests: MCInput.choiceRequest, state: "answered", revision: 2, clientRequestId: object["clientRequestId"] as? String)
            }
            return json(#"{"error":"outcome_unknown","message":"synthetic lost answer"}"#, 503)
        default:
            return json(#"{"error":"not_found","message":"x"}"#, 404)
        }
    }
}
/// Owner-loopback host answering only `command-status` reads with fixed bodies per server id.
private actor MCCommandHost: HTTPTransport {
    let bodies: [String: String]
    private var log: [String] = []
    init(bodies: [String: String]) { self.bodies = bodies }
    func paths() -> [String] { log }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        let path = request.url?.path ?? ""
        log.append("\(request.httpMethod ?? "GET") \(path)")
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 5, parts[3] != "", parts[4] == "command-status", let body = bodies[parts[3]] else {
            return TransportResponse(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8))
        }
        return TransportResponse(statusCode: 200, data: Data(body.utf8))
    }
}
/// Owner-loopback host recording discover bodies.
private actor MCDiscoverHost: HTTPTransport {
    private var captured: [Data] = []
    func bodies() -> [Data] { captured }
    func send(_ request: URLRequest) async throws -> TransportResponse {
        guard request.httpMethod == "POST", request.url?.path == "/v1/mcp/servers/examplemcp/discover" else {
            return TransportResponse(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8))
        }
        captured.append(request.httpBody ?? Data())
        return TransportResponse(statusCode: 200, data: Data(#"{"server":{"id":"examplemcp","name":"ExampleMCP","transport":"streamable_http","runsOn":"any","auth":"oauth","status":"ready","destination":"https://mcp.examplemcp.test/mcp"},"tools":[]}"#.utf8))
    }
}
/// Paired route adapter to the same synthetic host, so scope and body admission are exercised before the lost ACK.
private final class MCPairedConnectionsSender: PairedNativeSending, @unchecked Sendable {
    let host: MCFakeHost
    init(host: MCFakeHost) { self.host = host }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        var routed = URLRequest(url: URL(string: "http://127.0.0.1:49975" + request.route.path)!)
        routed.httpMethod = request.route.method
        if !request.body.isEmpty { routed.httpBody = request.body; routed.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let result = try await host.send(routed)
        return ClientTransportResponse(statusCode: result.statusCode, data: result.data)
    }
    func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
}
/// Paired leg without TLS: answers the paired /health (installationId, no hostId) and the private-input routes.
private final class MCPairedInputSender: PairedNativeSending, @unchecked Sendable {
    let installation: String, device: String, scopes: [String]
    private let lock = NSLock()
    private var routed: [String] = []
    private var respondBody: Data?
    private var current = MCInput.json(requests: MCInput.choiceRequest)
    init(installation: String, device: String, scopes: [String]) { self.installation = installation; self.device = device; self.scopes = scopes }
    func paths() -> [String] { lock.withLock { routed } }
    func lastRespondBody() -> Data? { lock.withLock { respondBody } }
    func send(_ request: ClientRequest) async throws -> ClientTransportResponse {
        let path = request.route.path
        lock.withLock { routed.append(path) }
        guard request.route.scope.map({ scopes.contains($0.rawValue) }) ?? true else { throw ClientIdentityFailure.forbidden }
        func json(_ text: String) -> ClientTransportResponse { ClientTransportResponse(statusCode: 200, data: Data(text.utf8)) }
        switch path {
        case "/health":
            let list = scopes.map { "\"\($0)\"" }.joined(separator: ",")
            return json(#"{"protocolVersion":1,"mode":"paired-client","engineRouting":"synthetic","remotePairing":"implemented","hostId":null,"installationId":"\#(installation)","client":{"deviceId":"\#(device)","role":"client-ios","scopes":[\#(list)],"pinGeneration":1,"bindingRevision":1}}"#)
        case "/v1/mcp/input-requests":
            return json("{\"requests\":[\(lock.withLock { current })]}")
        case "/v1/mcp/input-requests/mcpform_1/respond":
            let object = (try? JSONSerialization.jsonObject(with: request.body) as? [String: Any]) ?? [:]
            let updated = MCInput.json(requests: MCInput.choiceRequest, state: "declined", revision: 2, clientRequestId: object["clientRequestId"] as? String)
            lock.withLock { respondBody = request.body; current = updated }
            return json(updated)
        default:
            return ClientTransportResponse(statusCode: 404, data: Data(#"{"error":"not_found","message":"x"}"#.utf8))
        }
    }
    func close() -> ClientTransportClose { ClientTransportClose(Task {}) }
}
#endif
