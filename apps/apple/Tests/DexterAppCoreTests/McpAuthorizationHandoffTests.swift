import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor final class McpAuthorizationHandoffTests: XCTestCase {
    private let pin = String(repeating: "a", count: 64), requestDigest = String(repeating: "b", count: 64)
    private let epoch = UUID()
    private func context(host: String = "host-fixture", bot: String = "bot-fixture", thread: String = "thread-fixture",
                         generation: UInt64 = 1, scope: UUID? = nil) -> McpAuthorizationContext {
        .init(hostID: host, botID: bot, threadID: thread, hostAddress: "http://127.0.0.1:49181", composerScope: scope ?? epoch,
              hostGeneration: generation, threadGeneration: 1, readinessEpoch: 1)
    }
    private func action(state: ActionState = .succeeded, changes: [String: JSONValue] = [:],
                        source: ActionAuthorizationSource = .exactOwner, extraInput: [String: JSONValue] = [:],
                        tool: String = "dexter.harness.mcp.authorize", destination: String = "dexter-harness-owner-proposals") -> Action {
        var result: [String: JSONValue] = ["kind": .string("mcp_authorization_handoff"), "serverId": .string("fixture"),
            "instancePin": .string(pin), "hostId": .string("host-fixture"), "botId": .string("bot-fixture"),
            "threadId": .string("thread-fixture"), "actionId": .string("act-fixture"), "requestHash": .string(requestDigest), "expiresAt": .integer(301_000)]
        result.merge(changes) { _, latest in latest }
        var input: [String: JSONValue] = ["serverId": .string("fixture"), "expectedInstancePin": .string(pin)]
        input.merge(extraInput) { _, latest in latest }
        return Action(id: "act-fixture", request: .init(botId: "bot-fixture", threadId: "thread-fixture", tool: tool,
            destination: destination, arguments: ["input": .object(input)], idempotencyKey: "fixture-request"),
            requestHash: requestDigest, grantRevision: 1, state: state, createdAt: 500, updatedAt: 1_000,
            approvalExpiresAt: 60_000, decidedBy: state == .succeeded ? "owner-fixture" : nil,
            result: state == .succeeded ? .object(result) : nil, reason: nil,
            authorization: state == .succeeded ? .init(source: source, ownerId: "owner-fixture") : nil)
    }

    func testNewLocalDecisionClaimsOneWindowAndOnePrivateLaunchEvenAfterRemount() throws {
        let coordinator = McpAuthorizationHandoffCoordinator(now: { 2_000 }), scope = context()
        XCTAssertTrue(coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true))
        coordinator.receive(action(state: .ready), context: scope, foreground: true)
        XCTAssertNil(coordinator.presentation)
        coordinator.receive(action(), context: scope, foreground: true)
        let pending = try XCTUnwrap(coordinator.presentation)
        let request = try XCTUnwrap(coordinator.take(pending.id, context: scope, foreground: true))
        XCTAssertNil(coordinator.take(pending.id, context: scope, foreground: true), "A second window must not consume the same intent")
        XCTAssertTrue(coordinator.claimLaunch(request, context: scope, foreground: true))
        XCTAssertFalse(coordinator.claimLaunch(request, context: scope, foreground: true), "Remount must not repeat OAuth POST")
        coordinator.receive(action(), context: scope, foreground: true)
        XCTAssertNil(coordinator.presentation)
        XCTAssertFalse(coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true))
    }

    func testHistoryReloadRestartAndNonOwnerResultsRemainInert() {
        let scope = context()
        for source in [ActionAuthorizationSource.exactOwner, .boundedGrant, .ownerPolicy, .ownerType, .threadPolicy] {
            let coordinator = McpAuthorizationHandoffCoordinator(now: { 2_000 })
            coordinator.receive(action(source: source), context: scope, foreground: true)
            XCTAssertNil(coordinator.presentation, "Canonical history does not arm browser opening")
            XCTAssertTrue(coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true))
            coordinator.receive(action(source: source), context: scope, foreground: true)
            XCTAssertEqual(coordinator.presentation != nil, source == .exactOwner)
        }
        let restart = McpAuthorizationHandoffCoordinator(now: { 2_000 })
        restart.receive(action(), context: scope, foreground: true)
        XCTAssertNil(restart.presentation)
    }

    func testForgedOrChangedHandoffCannotOpenAnyPrivateFlow() {
        let scope = context()
        for bad in [["instancePin": JSONValue.string(requestDigest)], ["hostId": .string("host-other")],
                    ["botId": .string("bot-other")], ["threadId": .string("thread-other")],
                    ["actionId": .string("act-other")], ["requestHash": .string(pin)],
                    ["expiresAt": .integer(301_001)], ["authorizationUrl": .string("https://example.test/oauth")]] {
            let coordinator = McpAuthorizationHandoffCoordinator(now: { 2_000 })
            coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true)
            coordinator.receive(action(changes: bad), context: scope, foreground: true)
            XCTAssertNil(coordinator.presentation)
        }
        XCTAssertNil(action(extraInput: ["hostId": .string("host-fixture")]).mcpAuthorizationHandoff)
        XCTAssertNil(action(tool: "mcp.fixture.echo").mcpAuthorizationHandoff)
        XCTAssertNil(action(destination: "remote-mcp").mcpAuthorizationHandoff)
    }

    func testForegroundContextGenerationExpiryAndStopAreCheckedAtEachBoundary() throws {
        let clock = McpHandoffClock()
        let scope = context()
        let background = McpAuthorizationHandoffCoordinator(now: { clock.value })
        XCTAssertFalse(background.arm(action(state: .awaitingApproval), context: scope, foreground: false))
        for changed in [context(host: "host-other"), context(bot: "bot-other"), context(thread: "thread-other"), context(generation: 2), context(scope: UUID())] {
            let coordinator = McpAuthorizationHandoffCoordinator(now: { clock.value })
            coordinator.arm(action(state: .awaitingApproval), context: scope, foreground: true)
            coordinator.receive(action(), context: changed, foreground: true)
            XCTAssertNil(coordinator.presentation)
        }
        background.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        background.receive(action(), context: scope, foreground: false)
        XCTAssertNil(background.presentation)
        let expired = McpAuthorizationHandoffCoordinator(now: { clock.value })
        expired.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        expired.receive(action(), context: scope, foreground: true)
        let item = try XCTUnwrap(expired.presentation)
        clock.value = 301_000
        XCTAssertNil(expired.take(item.id, context: scope, foreground: true))
        clock.value = 2_000
        let stopped = McpAuthorizationHandoffCoordinator(now: { clock.value })
        stopped.arm(action(state: .awaitingApproval), context: scope, foreground: true)
        stopped.invalidate(); stopped.receive(action(), context: scope, foreground: true)
        XCTAssertNil(stopped.presentation)
    }

    private func authorization() throws -> McpOAuthAuthorization {
        try JSONDecoder().decode(McpOAuthAuthorization.self, from: Data(#"{"authorizationUrl":"https://example.test/oauth?state=synthetic","issuer":"https://example.test","expiresAt":500000}"#.utf8))
    }

    func testFailedBrowserOpeningRetainsPrivateURLAndNeverRepeatsPost() async throws {
        let value = try authorization()
        var posts = 0, opens = 0
        let session = McpOAuthLaunchSession(expiresAt: 301_000, start: { posts += 1; return value }, open: { _ in opens += 1; return opens > 1 },
            isCurrent: { true }, isForeground: { true }, now: { 2_000 })
        await session.begin(); XCTAssertEqual(session.phase, .browserUnavailable)
        await session.begin(); XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 1)
        session.continueInBrowser(); XCTAssertEqual(session.phase, .browserOpened)
        XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 2)
    }

    func testAsyncContextAndForegroundChangesNeverOpenBrowserOrRetryMutation() async throws {
        let value = try authorization()
        for foregroundChange in [false, true] {
            var current = true, foreground = true, posts = 0, opens = 0
            let session = McpOAuthLaunchSession(start: {
                posts += 1
                if foregroundChange { foreground = false } else { current = false }
                return value
            }, open: { _ in opens += 1; return true }, isCurrent: { current }, isForeground: { foreground }, now: { 2_000 })
            await session.begin(); await session.begin()
            XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 0)
            session.invalidate(); session.continueInBrowser(); XCTAssertEqual(opens, 0)
        }
        var posts = 0
        let expired = McpOAuthLaunchSession(expiresAt: 1_999, start: { posts += 1; return value }, open: { _ in XCTFail(); return true },
            isCurrent: { true }, isForeground: { true }, now: { 2_000 })
        await expired.begin(); XCTAssertEqual(expired.phase, .expired); XCTAssertEqual(posts, 0)
        let unknown = McpOAuthLaunchSession(start: { posts += 1; throw HostClientError.mutationOutcomeUnknown }, open: { _ in XCTFail(); return true },
            isCurrent: { true }, isForeground: { true }, now: { 2_000 })
        await unknown.begin(); await unknown.begin(); XCTAssertEqual(unknown.phase, .failed); XCTAssertEqual(posts, 1)
    }

    func testApprovalIsReadableAndDoesNotClaimLoginOrToolAccess() {
        let pending = ApprovalPresentation(action: action(state: .awaitingApproval))
        XCTAssertEqual(pending.title, "Autorizar conexão MCP")
        XCTAssertEqual(pending.shortTarget, "fixture")
        XCTAssertTrue(pending.scopeExplanation?.contains("Não libera ferramentas") == true)
        XCTAssertTrue(ApprovalPresentation(action: action()).resultExplanation.contains("sem liberação automática"))
    }

    private func credentials(state: String = "unauthorized", error: String? = "oauth_metadata_invalid", server: String = "fixture") throws -> McpCredentialStatus {
        var body: [String: JSONValue] = ["serverId": .string(server), "auth": .string("oauth"), "slots": .array([]), "state": .string(state)]
        if let error { body["lastError"] = .string(error) }
        return try JSONDecoder().decode(McpCredentialStatus.self, from: JSONEncoder().encode(JSONValue.object(body)))
    }

    func testKnownFailureRequiresReadReconciliationAndOneDistinctManualGesture() async throws {
        let value = try authorization(), clock = McpHandoffClock()
        var posts = 0, opens = 0
        let original = McpOAuthLaunchSession(serverID: "fixture", expiresAt: 301_000, start: {
            posts += 1; throw McpAuthenticationDiagnosticError(code: .oauthMetadataInvalid)
        }, open: { _ in opens += 1; return true }, isCurrent: { true }, isForeground: { true }, now: { Double(clock.value) })
        await original.begin(); XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 0)
        XCTAssertEqual(original.diagnostic?.code, .oauthMetadataInvalid)
        XCTAssertNil(original.makeManualRetry(start: { posts += 1; return value }), "A known error alone cannot create another intent")
        original.reconcileForManualRetry(try credentials(state: "authorizing")); XCTAssertFalse(original.canMakeManualRetry)
        original.reconcileForManualRetry(try credentials(server: "other")); XCTAssertFalse(original.canMakeManualRetry)
        clock.value = 301_001 // The original handoff remains consumed/expired; a new human gesture is its own intent.
        original.reconcileForManualRetry(try credentials()); XCTAssertTrue(original.canMakeManualRetry)
        XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 0, "Read reconciliation never reopens the browser")
        let fresh = try XCTUnwrap(original.makeManualRetry(start: { posts += 1; return value }))
        XCTAssertNotEqual(original.intentID, fresh.intentID)
        XCTAssertNil(original.makeManualRetry()); original.reconcileForManualRetry(try credentials())
        XCTAssertFalse(original.canMakeManualRetry, "The old intent cannot produce parallel retries")
        await original.begin(); XCTAssertEqual(posts, 1)
        await fresh.begin(); await fresh.begin(); XCTAssertEqual(posts, 2); XCTAssertEqual(opens, 1)
    }

    func testUnknownPostCannotBecomeKnownFromAnOldLastErrorOrReadRefresh() async throws {
        for error in [HostClientError.mutationOutcomeUnknown, .offline, .conflict, .contractMismatch] {
            var posts = 0, opens = 0
            let session = McpOAuthLaunchSession(serverID: "fixture", start: { posts += 1; throw error }, open: { _ in opens += 1; return true },
                isCurrent: { true }, isForeground: { true }, now: { 2_000 })
            await session.begin()
            for state in ["unauthorized", "authorizing", "locked", "expired"] {
                session.reconcileForManualRetry(try credentials(state: state))
                XCTAssertFalse(session.canMakeManualRetry); XCTAssertNil(session.makeManualRetry())
            }
            await session.begin(); XCTAssertEqual(posts, 1); XCTAssertEqual(opens, 0)
        }
    }

    func testEffectivePersistenceUsesCurrentAccountInsteadOfGlobalConfigurationOrPendingStatus() {
        let persistent = McpOAuthPersistencePresentation.message(.appKeychain, connected: true)
        XCTAssertTrue(persistent.contains("cofre deste app")); XCTAssertFalse(persistent.contains("entre novamente"))
        XCTAssertTrue(McpOAuthPersistencePresentation.message(.volatileUntilHostRestart, connected: true).contains("somente na memória"))
        XCTAssertTrue(McpOAuthPersistencePresentation.message(.hostPersistent, connected: true).contains("armazenamento protegido"))
        let unconfirmed = McpOAuthPersistencePresentation.message(nil, connected: true)
        XCTAssertTrue(unconfirmed.contains("ainda não foi confirmada"))
        XCTAssertEqual(McpOAuthPersistencePresentation.message(.appKeychain, connected: false), unconfirmed)
        XCTAssertEqual(McpOAuthPersistencePresentation.message(.volatileUntilHostRestart, connected: false), unconfirmed)
        XCTAssertEqual(McpOAuthPersistencePresentation.message(.managedService, connected: true), unconfirmed)
    }

    func testOriginalHandoffExpiryBetweenPrepareAndBrowserOpenRefusesOpening() async throws {
        let clock = McpHandoffClock(), value = try authorization()
        var posts = 0, opens = 0
        let session = McpOAuthLaunchSession(serverID: "fixture", expiresAt: 301_000, start: { posts += 1; return value },
            open: { _ in opens += 1; return true }, isCurrent: { true }, isForeground: { true }, now: { Double(clock.value) })
        await session.prepare(); XCTAssertEqual(posts, 1); XCTAssertEqual(session.phase, .prepared)
        clock.value = 301_000
        session.continueInBrowser(); XCTAssertEqual(opens, 0); XCTAssertEqual(session.phase, .expired)
        XCTAssertNil(session.authorization)
    }

    func testSDKPreDispatchCheckRefusesExpiryAfterPreflightBeforeAnyOAuthPost() async throws {
        let clock = McpHandoffClock(), box = McpHandoffSessionBox()
        let transport = McpHandoffEmptyTransport()
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:49181")!, transport: transport)
        defer { client.close() }
        box.session = McpOAuthLaunchSession(serverID: "fixture", expiresAt: 301_000, start: {
            // Simulate the health preflight taking long enough to cross the handoff deadline.
            clock.value = 301_000
            return try await client.startMcpOAuth(serverID: "fixture", beforeDispatch: { try XCTUnwrap(box.session).assertMayDispatch() })
        }, open: { _ in XCTFail("Expired handoff must not open browser"); return true }, isCurrent: { true }, isForeground: { true }, now: { Double(clock.value) })
        await box.session?.begin()
        XCTAssertEqual(box.session?.phase, .expired)
        let calls = await transport.calls(); XCTAssertEqual(calls, 0)
    }
}

@MainActor private final class McpHandoffClock { var value: Int64 = 2_000 }
@MainActor private final class McpHandoffSessionBox { var session: McpOAuthLaunchSession? }
private actor McpHandoffEmptyTransport: HTTPTransport {
    private var count = 0
    func send(_ request: URLRequest) async throws -> TransportResponse { count += 1; throw HostClientError.offline }
    func calls() -> Int { count }
}
