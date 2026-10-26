import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// Pure decision tests. Every fact is an explicit synthetic fixture; nothing probes engines, TCC, or accounts.
final class OnboardingReadinessDecisionTests: XCTestCase {
    private let local = OnboardingHostIdentity(hostID: "host-a", mode: .localDevelopment, clientDeviceID: nil)
    private let paired = OnboardingHostIdentity(hostID: "install-a", mode: .pairedClient, clientDeviceID: "client-self")

    func testFixtureHasNoStepsAndNeverClaimsAHost() {
        let readiness = OnboardingReadiness(OnboardingReadinessInput(host: .fixture, routing: .connected(routedEngines: [.claude]), selectedEngine: .claude))
        XCTAssertEqual(readiness.steps, [])
        XCTAssertEqual(readiness.conversation, .fixture)
        XCTAssertEqual(readiness.executor, .unknown)
    }

    func testUnreachableHostStatesIgnoreStaleEngineAndDeviceFacts() {
        let stale = OnboardingReadinessInput(
            host: .offline, routing: .notConnected, selectedEngine: .claude,
            engines: [.claude: OnboardingEngineObservation(authentication: .required, observedAt: 1)],
            devices: .loaded([device("agent", role: "agent-mac")])
        )
        let cases: [(OnboardingHostFact, OnboardingStep)] = [
            (.unconfigured, .hostUnconfigured), (.pairingUnavailable, .hostPairingUnavailable),
            (.checking, .hostChecking), (.offline, .hostOffline), (.validationFailed, .hostValidationFailed),
        ]
        for (host, step) in cases {
            var input = stale
            input.host = host
            let readiness = OnboardingReadiness(input)
            XCTAssertEqual(readiness.steps, [step], "\(host)")
            XCTAssertEqual(readiness.conversation, .blocked)
            XCTAssertEqual(readiness.executor, .unknown)
        }
    }

    func testEngineRoutingAndExplicitAuthenticationStates() {
        func steps(_ routing: OnboardingEngineRouting, _ auth: OnboardingEngineAuthentication, unavailable: Bool = false) -> OnboardingReadiness {
            OnboardingReadiness(OnboardingReadinessInput(
                host: .online(local), routing: routing, selectedEngine: .codex,
                engines: [.codex: OnboardingEngineObservation(authentication: auth, unavailable: unavailable, observedAt: 1)],
                devices: .loaded([device("agent", role: "agent-mac")])
            ))
        }
        XCTAssertEqual(steps(.notConnected, .authenticated).steps, [.engineRoutingOff])
        XCTAssertEqual(steps(.notConnected, .authenticated).conversation, .blocked)
        XCTAssertEqual(steps(.connected(routedEngines: [.claude]), .authenticated).steps, [.engineUnavailable(.codex)])
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .unknown, unavailable: true).steps, [.engineUnavailable(.codex)])
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .required).steps, [.engineLoginRequired(.codex)])
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .required).conversation, .blocked)
        // Routed is not signed in: unknown never blocks text, and never reads as ready.
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .unknown).steps, [.engineLoginUnknown(.codex)])
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .unknown).conversation, .unconfirmed)
        XCTAssertEqual(steps(.connected(routedEngines: nil), .unknown).steps, [.engineLoginUnknown(.codex)])
        // Only an explicit authenticated fact plus connected routing is ready.
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .authenticated).steps, [])
        XCTAssertEqual(steps(.connected(routedEngines: [.codex]), .authenticated).conversation, .ready)
        XCTAssertEqual(steps(.unknown, .authenticated).conversation, .unconfirmed)
        // Without a selected bot there is no engine to judge.
        let none = OnboardingReadiness(OnboardingReadinessInput(host: .online(local), routing: .connected(routedEngines: nil), devices: .loaded([])))
        XCTAssertEqual(none.steps, [.executorNotPaired])
        XCTAssertEqual(none.conversation, .unconfirmed)
    }

    func testTurnObservationUsesOnlyStructuredFreshCodes() {
        let empty = OnboardingEngineObservation()
        let required = empty.observing(turn(state: "failed", code: "authentication_required", updatedAt: 10))
        XCTAssertEqual(required.authentication, .required)
        // An older turn cannot overwrite a newer fact.
        XCTAssertEqual(required.observing(turn(state: "completed", code: nil, updatedAt: 5)), required)
        // A later success clears the requirement to unknown, never to authenticated.
        let cleared = required.observing(turn(state: "completed", code: nil, updatedAt: 11))
        XCTAssertEqual(cleared.authentication, .unknown)
        XCTAssertFalse(cleared.unavailable)
        for code in ["not_installed", "engine_unavailable", "no_driver"] {
            let unavailable = empty.observing(turn(state: "failed", code: code, updatedAt: 3))
            XCTAssertTrue(unavailable.unavailable, code)
            XCTAssertEqual(unavailable.authentication, .unknown)
        }
        // Unrelated codes and non-terminal turns carry no auth fact.
        XCTAssertEqual(required.observing(turn(state: "failed", code: "rate_limited", updatedAt: 20)), required)
        XCTAssertEqual(required.observing(turn(state: "running", code: nil, updatedAt: 30)), required)
        XCTAssertEqual(empty.observing(turn(state: "unknown", code: "authentication_required", updatedAt: 4)), empty)
    }

    func testExecutorRequiresPairedAgentMacAndNeverCountsClientMacs() {
        func executor(_ devices: [DeviceView], self id: String? = "client-self") -> OnboardingExecutorStatus {
            OnboardingReadiness.executor(.loaded(devices), excluding: id)
        }
        XCTAssertEqual(executor([]), .notPaired)
        XCTAssertEqual(executor([device("client-mac", role: "client-mac")]), .notPaired)
        XCTAssertEqual(executor([device("client-self", role: nil)]), .notPaired)
        XCTAssertEqual(executor([device("phone", platform: .ios, role: "agent-mac")]), .notPaired)
        XCTAssertEqual(executor([device("agent", role: "agent-mac")]), .online(deviceID: "agent"))
        XCTAssertEqual(executor([device("agent", presence: .stale, role: "agent-mac")]), .offline)
        XCTAssertEqual(executor([device("agent", presence: .online, revokedAt: 9, role: "agent-mac")]), .revoked)
        XCTAssertEqual(executor([device("agent", presence: .revoked, paired: false, role: "agent-mac")]), .revoked)
        XCTAssertEqual(executor([device("agent", paired: false, role: "unpaired")]), .notPaired)
        // A role-less paired Mac may be a client: unknown, not ready.
        XCTAssertEqual(executor([device("legacy", role: nil)]), .unknown)
        XCTAssertEqual(executor([device("legacy", role: nil), device("agent", role: "agent-mac")]), .online(deviceID: "agent"))
        XCTAssertEqual(OnboardingReadiness.executor(.notLoaded, excluding: nil), .unknown)
        XCTAssertEqual(OnboardingReadiness.executor(.failed, excluding: nil), .unknown)
    }

    func testOnlyMatchingCapabilityNeedsPermissionAndNeverBlocksText() {
        let agent = device("agent", capabilities: ["mac.browser.navigate", "mac.file.read"], role: "agent-mac")
        let browse = OnboardingCapabilityRequest(deviceID: "agent", capability: "mac.browser.navigate")
        let read = OnboardingCapabilityRequest(deviceID: "agent", capability: "mac.file.read")
        let missing = OnboardingCapabilityRequest(deviceID: "agent", capability: "mac.cua.click")
        let elsewhere = OnboardingCapabilityRequest(deviceID: "other", capability: "mac.file.read")
        var input = OnboardingReadinessInput(
            host: .online(paired), routing: .connected(routedEngines: nil), devices: .loaded([agent]),
            capabilityRequests: [browse, read, missing, elsewhere, browse]
        )
        XCTAssertEqual(OnboardingReadiness(input).steps, [
            .permissionUnknown("mac.browser.navigate"), .permissionUnknown("mac.file.read"), .capabilityNotOffered("mac.cua.click"),
        ])
        input.permissions = [browse: .pending, read: .denied]
        XCTAssertEqual(OnboardingReadiness(input).steps, [
            .permissionPending("mac.browser.navigate"), .permissionDenied("mac.file.read"), .capabilityNotOffered("mac.cua.click"),
        ])
        input.permissions = [browse: .granted, read: .granted]
        input.capabilityRequests = [browse, read]
        let granted = OnboardingReadiness(input)
        XCTAssertEqual(granted.steps, [])
        XCTAssertEqual(granted.conversation, .unconfirmed)
        input.permissions = [browse: .denied]
        XCTAssertFalse(OnboardingReadiness(input).steps.contains(where: \.blocksConversation))
        XCTAssertEqual(OnboardingReadiness(input).conversation, .unconfirmed)
        // No executor online: capability steps are not invented on top of the executor step.
        input.devices = .loaded([device("agent", presence: .stale, capabilities: ["mac.browser.navigate"], role: "agent-mac")])
        XCTAssertEqual(OnboardingReadiness(input).steps, [.executorOffline])
    }

    func testActionsAreLimitedToExistingReadOnlyRefreshes() {
        XCTAssertEqual(OnboardingStep.hostOffline.action, .retryHost)
        XCTAssertEqual(OnboardingStep.hostValidationFailed.action, .retryHost)
        XCTAssertTrue(OnboardingStep.hostValidationFailed.blocksConversation)
        XCTAssertEqual(OnboardingStep.engineLoginRequired(.claude).action, .retryHost)
        XCTAssertEqual(OnboardingStep.executorNotPaired.action, .refreshDevices)
        XCTAssertNil(OnboardingStep.engineLoginUnknown(.claude).action)
        XCTAssertNil(OnboardingStep.permissionUnknown("mac.file.read").action)
        XCTAssertNil(OnboardingStep.hostUnconfigured.action)
    }

    private func device(
        _ id: String, platform: DevicePlatform = .macos, presence: DevicePresence = .online, paired: Bool = true,
        revokedAt: Int64? = nil, capabilities: [String] = [], role: String?
    ) -> DeviceView {
        DeviceView(id: id, ownerId: "owner", name: id, platform: platform, capabilities: capabilities, lastSeenAt: 1,
                   revokedAt: revokedAt, presence: presence, paired: paired, role: role)
    }

    private func turn(state: String, code: String?, updatedAt: Int64) -> Turn {
        let object: [String: Any] = [
            "cursor": 1, "id": "turn", "threadId": "thread", "botId": "bot", "engine": "claude", "clientRequestId": "r",
            "inputMessageId": "m", "outputMessageId": NSNull(), "state": state, "code": code as Any? ?? NSNull(),
            "outputChars": 0, "outputTruncated": false, "createdAt": 1, "startedAt": NSNull(), "finishedAt": NSNull(), "updatedAt": updatedAt,
        ]
        return try! JSONDecoder().decode(Turn.self, from: JSONSerialization.data(withJSONObject: object))
    }
}

/// Catalog completeness for the shipped SharedApp catalog: both languages are explicit.
final class SharedAppLocalizationCatalogTests: XCTestCase {
    private struct Entry { let pt: String?; let ptState: String?; let en: String? }

    private func catalog() throws -> (source: String, entries: [String: Entry]) {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("SharedApp/Resources/Localizable.xcstrings")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let strings = try XCTUnwrap(root["strings"] as? [String: [String: Any]])
        var entries: [String: Entry] = [:]
        for (key, value) in strings {
            let localizations = value["localizations"] as? [String: [String: Any]] ?? [:]
            func unit(_ language: String) -> [String: Any]? { localizations[language]?["stringUnit"] as? [String: Any] }
            entries[key] = Entry(pt: unit("pt-BR")?["value"] as? String, ptState: unit("pt-BR")?["state"] as? String, en: unit("en")?["value"] as? String)
        }
        return (try XCTUnwrap(root["sourceLanguage"] as? String), entries)
    }

    private func placeholders(_ text: String) -> Int { text.components(separatedBy: "%@").count - 1 }

    func testEveryShippedEntryHasPortugueseAndEnglishFallback() throws {
        let (source, entries) = try catalog()
        XCTAssertEqual(source, "en")
        XCTAssertFalse(entries.isEmpty)
        for (key, entry) in entries {
            let pt = try XCTUnwrap(entry.pt, "missing pt-BR for \(key)")
            let en = try XCTUnwrap(entry.en, "missing en for \(key)")
            XCTAssertFalse(pt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key)
            XCTAssertFalse(en.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key)
            XCTAssertEqual(entry.ptState, "translated", key)
            XCTAssertEqual(placeholders(pt), placeholders(en), key)
        }
    }

    func testEveryOnboardingCopyKeyIsInTheCatalog() throws {
        let entries = try catalog().entries
        var keys = [OnboardingCopy.sectionTitle]
        keys += OnboardingStep.Kind.allCases.flatMap { [OnboardingCopy.title($0), OnboardingCopy.detail($0)] }
        keys += OnboardingAction.allCases.map(OnboardingCopy.action)
        keys += [OnboardingConversationStatus.fixture, .blocked, .unconfirmed, .ready].map(OnboardingCopy.conversation)
        for key in keys {
            XCTAssertNotNil(entries[key]?.pt, "missing catalog entry: \(key)")
        }
        XCTAssertEqual(Set(keys).count, keys.count, "copy keys must be distinct")
    }

    func testOnlyParameterizedStepsUseAPlaceholder() {
        let samples: [OnboardingStep] = [
            .hostUnconfigured, .hostPairingUnavailable, .hostChecking, .hostOffline, .hostValidationFailed, .engineRoutingOff,
            .engineUnavailable(.claude), .engineLoginRequired(.codex), .engineLoginUnknown(.claude),
            .executorNotPaired, .executorRevoked, .executorOffline, .executorUnknown,
            .capabilityNotOffered("x"), .permissionPending("x"), .permissionDenied("x"), .permissionUnknown("x"),
        ]
        XCTAssertEqual(Set(samples.map(\.kind)), Set(OnboardingStep.Kind.allCases))
        for step in samples {
            XCTAssertEqual(placeholders(OnboardingCopy.title(step.kind)), step.argument == nil ? 0 : 1, "\(step)")
            XCTAssertEqual(placeholders(OnboardingCopy.detail(step.kind)), 0, "\(step)")
        }
        XCTAssertEqual(OnboardingStep.engineLoginRequired(.claude).argument, "Claude")
        XCTAssertEqual(OnboardingStep.engineLoginRequired(.codex).argument, "Codex")
    }

    func testValidationFailureCopyNeverClaimsAHostReplyOrVersionMismatch() throws {
        // `contractMismatch` also covers local refusals (expired client certificate, pin) before any HTTP exchange.
        let entries = try catalog().entries
        let title = OnboardingCopy.title(.hostValidationFailed), detail = OnboardingCopy.detail(.hostValidationFailed)
        let portuguese = [title, detail].map { entries[$0]?.pt ?? "" }
        XCTAssertFalse(portuguese.contains(""), "both keys are translated")
        for text in [title, detail] + portuguese {
            let lowered = text.lowercased()
            for claim in ["answered", "replied with", "respondeu", "doesn't match", "não corresponde", "version mismatch"] {
                XCTAssertFalse(lowered.contains(claim), "\(text) asserts \(claim)")
            }
        }
        XCTAssertTrue(detail.contains("before the host replies"), detail)
    }

    func testCopyNeverSaysTheRelayRunsInference() {
        for kind in OnboardingStep.Kind.allCases {
            for text in [OnboardingCopy.title(kind), OnboardingCopy.detail(kind)] where text.lowercased().contains("relay") {
                XCTAssertTrue(text.contains("never runs"), text)
            }
        }
    }
}

/// AppModel integration with a scripted synthetic loopback host. Only GET reads are expected.
@MainActor
final class OnboardingReadinessAppModelTests: XCTestCase {
    func testOnlineHostWithRoutedEngineAndAgentMacStaysUnconfirmed() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostChecking])
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .executorUnknown])
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("agent", role: "agent-mac"), deviceObject("client", role: "client-mac")]])
        await model.refreshDevices()
        let readiness = model.onboardingReadiness
        XCTAssertEqual(readiness.steps, [.engineLoginUnknown(.claude)])
        XCTAssertEqual(readiness.executor, .online(deviceID: "agent"))
        XCTAssertEqual(readiness.conversation, .unconfirmed)
        let requests = await transport.requests()
        XCTAssertTrue(requests.allSatisfy { $0.hasPrefix("GET ") }, "\(requests)")
        XCTAssertTrue(requests.contains("GET /v1/engines/catalog"), "Retry refresh reads the catalog too")
        XCTAssertFalse(requests.contains { $0.contains("account") || $0.contains("login") || $0.contains("native-voice") || $0.contains("grant") })
    }

    func testOfflineThenEngineRoutingOffThenUnroutedEngine() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await model.refresh() // nothing scripted: connection refused
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostOffline])
        XCTAssertEqual(model.onboardingReadiness.conversation, .blocked)
        await enqueueHost(transport, hostID: "host-a", routing: "not_connected", engines: nil)
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineRoutingOff, .executorUnknown])
        await enqueueHost(transport, hostID: "host-a", engines: ["codex"])
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineUnavailable(.claude), .executorUnknown])
    }

    func testContractMismatchIsValidationFailureNotOfflineAndKeepsSelection() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await enqueueThread(transport, "thread-a", turns: [])
        await model.openThread("thread-a")
        XCTAssertEqual(model.selectedThreadID, "thread-a")

        // Here a future protocol version does answer; the step still claims only a failed validation.
        await put(transport, "GET", "/health", healthObject(hostID: "host-a", protocolVersion: 2))
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostValidationFailed])
        XCTAssertEqual(model.onboardingReadiness.conversation, .blocked)
        XCTAssertEqual(model.onboardingReadiness.executor, .unknown)
        XCTAssertFalse(model.isOnline)
        XCTAssertEqual(model.errorMessage, HostClientError.contractMismatch.localizedDescription, "the existing alert keeps the cause")
        XCTAssertEqual(model.selectedBotID, "bot-a")
        XCTAssertEqual(model.selectedThreadID, "thread-a")

        // A loopback host claiming remote pairing fails the same contract check.
        await put(transport, "GET", "/health", healthObject(hostID: "host-a", remotePairing: "implemented"))
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostValidationFailed])

        await model.refresh() // nothing scripted: connection refused
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostOffline])
        XCTAssertEqual(model.errorMessage, HostClientError.offline.localizedDescription)

        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await enqueueThread(transport, "thread-a", turns: [])
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .executorUnknown])
        XCTAssertEqual(model.selectedThreadID, "thread-a")
        let requests = await transport.requests()
        XCTAssertTrue(requests.allSatisfy { $0.hasPrefix("GET ") }, "\(requests)")
    }

    func testLocalValidationRefusalBeforeAnyReplyIsValidationFailureNotOffline() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        // Models a local trusted-connection refusal (expired certificate, pin) that never reaches HTTP.
        await transport.pushFailure("GET", "/health", HostClientError.contractMismatch)
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostValidationFailed])
        XCTAssertEqual(model.onboardingReadiness.conversation, .blocked)
        XCTAssertEqual(model.errorMessage, HostClientError.contractMismatch.localizedDescription, "the existing alert keeps the cause")
        let requests = await transport.requests()
        XCTAssertEqual(requests, ["GET /health"])
    }

    func testAuthenticationRequiredTurnIsObservedAndClearedByHostChange() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await enqueueThread(transport, "thread-a", turns: [turnObject("t1", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5)])
        await model.openThread("thread-a")
        XCTAssertEqual(model.onboardingReadiness.steps.first, .engineLoginRequired(.claude))
        XCTAssertEqual(model.onboardingReadiness.conversation, .blocked)

        // Same address, different host identity: the old sign-in fact and device list are dropped.
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("agent", role: "agent-mac")]])
        await model.refreshDevices()
        XCTAssertEqual(model.onboardingReadiness.executor, .online(deviceID: "agent"))
        await enqueueHost(transport, hostID: "host-b", engines: ["claude"], threads: ["thread-a"])
        await enqueueThread(transport, "thread-a", turns: [])
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .executorUnknown])
        XCTAssertTrue(model.devices.isEmpty, "host-a's device names, roles and presence are not shown for host-b")

        model.useFixture()
        XCTAssertEqual(model.onboardingReadiness.steps, [])
        XCTAssertEqual(model.onboardingReadiness.conversation, .fixture)
    }

    func testDeviceListHeldAcrossSameAddressIdentityChangeNeverQualifiesNewHost() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        await transport.enqueueHold("GET", "/v1/devices")
        let oldDevices = Task { await model.refreshDevices() }
        await transport.waitUntilHeld("GET", "/v1/devices")
        await enqueueHost(transport, hostID: "host-b", engines: ["claude"])
        await model.refresh()
        await release(transport, "GET", "/v1/devices", ["items": [deviceObject("mac-1", role: "agent-mac")]])
        await oldDevices.value
        XCTAssertEqual(model.onboardingReadiness.executor, .unknown)
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .executorUnknown])
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertFalse(model.isLoadingDevices)

        // host-b reuses the ID with another role; only its own list counts.
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("mac-1", role: "client-mac", name: "B client")]])
        await model.refreshDevices()
        XCTAssertEqual(model.onboardingReadiness.executor, .notPaired)
        XCTAssertEqual(model.devices.map(\.role), ["client-mac"])
        XCTAssertEqual(model.devices.map(\.name), ["B client"])
        let requests = await transport.requests()
        XCTAssertTrue(requests.allSatisfy { $0.hasPrefix("GET ") }, "\(requests)")
    }

    func testDeviceRefusalHeldAcrossIdentityChangeIsDroppedNotReportedAsFailure() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        await transport.enqueueHold("GET", "/v1/devices")
        let oldDevices = Task { await model.refreshDevices() }
        await transport.waitUntilHeld("GET", "/v1/devices")
        await enqueueHost(transport, hostID: "host-b", engines: ["claude"])
        await model.refresh()
        await transport.resumeFailing("GET", "/v1/devices", URLError(.cannotConnectToHost))
        await oldDevices.value
        XCTAssertNil(model.deviceError)
        XCTAssertEqual(model.onboardingReadiness.executor, .unknown)
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .executorUnknown])
    }

    func testListRequestedBeforeAnyValidatedIdentityIsShownButNeverQualifies() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await transport.enqueueHold("GET", "/v1/devices")
        let early = Task { await model.refreshDevices() }
        await transport.waitUntilHeld("GET", "/v1/devices")
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        await release(transport, "GET", "/v1/devices", ["items": [deviceObject("agent", role: "agent-mac")]])
        await early.value
        XCTAssertEqual(model.devices.map(\.id), ["agent"], "the existing devices view keeps its list")
        XCTAssertEqual(model.onboardingReadiness.executor, .unknown)

        // A read dispatched under the validated identity qualifies, and a same-identity refresh keeps it.
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("agent", role: "agent-mac")]])
        await model.refreshDevices()
        XCTAssertEqual(model.onboardingReadiness.executor, .online(deviceID: "agent"))
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        XCTAssertEqual(model.onboardingReadiness.executor, .online(deviceID: "agent"))
        XCTAssertEqual(model.devices.map(\.id), ["agent"])
    }

    func testPendingRenameFromPreviousIdentityCannotOverwriteCoincidentDevice() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"])
        await model.refresh()
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("mac-1", role: "agent-mac")]])
        await model.refreshDevices()
        XCTAssertEqual(model.onboardingReadiness.executor, .online(deviceID: "mac-1"))

        await transport.enqueueHold("PATCH", "/v1/devices/mac-1")
        let rename = Task { await model.renameDevice(id: "mac-1", name: "Renamed on A") }
        await transport.waitUntilHeld("PATCH", "/v1/devices/mac-1")
        await enqueueHost(transport, hostID: "host-b", engines: ["claude"])
        await model.refresh()
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("mac-1", role: "client-mac", name: "B client")]])
        await model.refreshDevices()
        await release(transport, "PATCH", "/v1/devices/mac-1", deviceObject("mac-1", role: "agent-mac", name: "Renamed on A"))
        let applied = await rename.value
        XCTAssertFalse(applied)
        XCTAssertEqual(model.devices.map(\.name), ["B client"])
        XCTAssertEqual(model.devices.map(\.role), ["client-mac"])
        XCTAssertEqual(model.displayStatus(for: model.devices[0]), model.devices[0].displayStatus, "no stale confirmation carried over")
        XCTAssertNil(model.deviceError)
        XCTAssertEqual(model.onboardingReadiness.executor, .notPaired)
    }

    func testLateTurnFromPreviousIdentityOnSameAddressIsNotObserved() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await transport.enqueueHold("GET", "/v1/threads/thread-a/turns")
        let open = Task { await model.openThread("thread-a") }
        await transport.waitUntilHeld("GET", "/v1/threads/thread-a/turns")
        // host-b lists the same thread ID; reopening it under host-b supersedes the held host-a read.
        await enqueueHost(transport, hostID: "host-b", engines: ["claude"], threads: ["thread-a"])
        await enqueueThread(transport, "thread-a", turns: [])
        await model.refresh()
        await release(transport, "GET", "/v1/threads/thread-a/turns", ["items": [turnObject("t1", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5)], "nextCursor": 1])
        await open.value
        XCTAssertEqual(model.selectedThreadID, "thread-a")
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:])
        XCTAssertEqual(model.onboardingReadiness.steps.first, .engineLoginUnknown(.claude))
    }

    /// The earlier window: host-b's health is accepted while its bot list is still held, so the thread is not yet
    /// reopened and host-a's scope still passes the thread guard. The epoch bound at dispatch must reject the read.
    func testHeldTurnReleasedWhileNewIdentityBotsAreHeldIsNeverObserved() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await transport.enqueueHold("GET", "/v1/threads/thread-a/turns")
        let open = Task { await model.openThread("thread-a") }
        await transport.waitUntilHeld("GET", "/v1/threads/thread-a/turns")
        await put(transport, "GET", "/health", healthObject(hostID: "host-b"))
        await transport.enqueueHold("GET", "/v1/bots")
        await put(transport, "GET", "/v1/actions", ["items": []])
        let refreshB = Task { await model.refresh() }
        await transport.waitUntilHeld("GET", "/v1/bots")
        await put(transport, "GET", "/v1/threads/thread-a/messages", ["items": [], "nextCursor": 0])
        await put(transport, "GET", "/v1/actions", ["items": []])
        await release(transport, "GET", "/v1/threads/thread-a/turns", ["items": [turnObject("t-a", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5)], "nextCursor": 1])
        await open.value
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:], "host-a's turn is not a host-b fact, even before host-b's refresh completes")

        await enqueueHostAfterHealth(transport, threads: ["thread-a"])
        await enqueueThread(transport, "thread-a", turns: [])
        await release(transport, "GET", "/v1/bots", botsObject())
        await refreshB.value
        XCTAssertEqual(model.selectedThreadID, "thread-a")
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:], "nothing from host-a survives host-b's refresh")
        XCTAssertEqual(model.onboardingReadiness.steps.first, .engineLoginUnknown(.claude))
    }

    func testPolledTerminalTurnUnderSameIdentityIsObserved() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await enqueueThread(transport, "thread-a", turns: [turnObject("t1", thread: "thread-a", state: "running", code: nil, updatedAt: 3)])
        await put(transport, "GET", "/v1/turns/t1/events", ["items": [], "nextCursor": 0])
        await put(transport, "GET", "/v1/turns/t1", turnObject("t1", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5))
        await put(transport, "GET", "/v1/actions", ["items": []])
        await model.openThread("thread-a")
        // The current observer verifies the scoped host and reads exact action IDs; it no longer lists all actions.
        await transport.waitUntilRequested("GET", "/health", count: 2)
        model.stopPolling()
        XCTAssertEqual(model.onboardingReadiness.steps.first, .engineLoginRequired(.claude))
    }

    func testPolledTurnReleasedWhileNewIdentityBotsAreHeldIsNeverObserved() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await enqueueThread(transport, "thread-a", turns: [turnObject("t1", thread: "thread-a", state: "running", code: nil, updatedAt: 3)])
        await put(transport, "GET", "/v1/turns/t1/events", ["items": [], "nextCursor": 0])
        await transport.enqueueHold("GET", "/v1/turns/t1")
        await model.openThread("thread-a")
        await transport.waitUntilHeld("GET", "/v1/turns/t1")
        await put(transport, "GET", "/health", healthObject(hostID: "host-b"))
        await transport.enqueueHold("GET", "/v1/bots")
        await put(transport, "GET", "/v1/actions", ["items": []])
        let refreshB = Task { await model.refresh() }
        await transport.waitUntilHeld("GET", "/v1/bots")
        await transport.waitUntilRequested("GET", "/v1/actions", count: 3)
        await put(transport, "GET", "/v1/actions", ["items": []])
        await release(transport, "GET", "/v1/turns/t1", turnObject("t1", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5))
        // The poll now verifies health after observing the turn, rather than reading the global action list.
        await transport.waitUntilRequested("GET", "/health", count: 3)
        model.stopPolling()
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:], "host-a's polled turn is not a host-b fact")

        await enqueueHostAfterHealth(transport, threads: ["thread-a"])
        await enqueueThread(transport, "thread-a", turns: [])
        await release(transport, "GET", "/v1/bots", botsObject())
        await refreshB.value
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:])
        XCTAssertEqual(model.onboardingReadiness.steps.first, .engineLoginUnknown(.claude))
    }

    func testLateOldHostTurnCannotWriteReadinessAfterHostSwitch() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"])
        await model.refresh()
        await transport.enqueueHold("GET", "/v1/threads/thread-a/turns")
        let open = Task { await model.openThread("thread-a") }
        await transport.waitUntilHeld("GET", "/v1/threads/thread-a/turns")
        // An unpaired remote address is never contacted, so the switch needs no network.
        model.hostAddress = "https://example.invalid"
        model.configureHost()
        await release(transport, "GET", "/v1/threads/thread-a/turns", ["items": [turnObject("t1", thread: "thread-a", state: "failed", code: "authentication_required", updatedAt: 5)], "nextCursor": 1])
        await open.value
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostPairingUnavailable])
        XCTAssertEqual(model.onboardingReadinessInput.engines, [:])
        XCTAssertEqual(model.onboardingReadinessInput.routing, .unknown)
        let requests = await transport.requests()
        XCTAssertEqual(requests.last, "GET /v1/threads/thread-a/turns", "the late response must not trigger further reads")
    }

    func testReadinessRefreshPreservesSelectionAndPendingApprovalsAndMapsMatchingCapability() async throws {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        let action = actionObject(destination: "agent", tool: "mac.browser.navigate")
        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"], actions: [action])
        await model.refresh()
        await enqueueThread(transport, "thread-a", turns: [], actions: [action])
        XCTAssertNotNil(model.presentThread("thread-a", for: "bot-a"))
        await model.loadPresentedThread("thread-a", generation: model.threadPresentationGeneration)
        model.stopPolling() // This test owns readiness/manual refresh, not the separate receipt continuation observer.
        let generation = model.threadPresentationGeneration
        await put(transport, "GET", "/v1/devices", ["items": [deviceObject("agent", role: "agent-mac", capabilities: ["mac.browser.navigate"])]])
        await model.refreshDevices()
        XCTAssertEqual(model.onboardingReadiness.steps, [.engineLoginUnknown(.claude), .permissionUnknown("mac.browser.navigate")])
        XCTAssertNotEqual(model.onboardingReadiness.conversation, .blocked)

        await enqueueHost(transport, hostID: "host-a", engines: ["claude"], threads: ["thread-a"], actions: [action])
        await enqueueThread(transport, "thread-a", turns: [], actions: [action])
        await model.refresh()
        XCTAssertEqual(model.selectedBotID, "bot-a")
        XCTAssertEqual(model.selectedThreadID, "thread-a")
        XCTAssertEqual(model.presentedThreadID, "thread-a")
        XCTAssertGreaterThanOrEqual(model.threadPresentationGeneration, generation)
        XCTAssertEqual(model.actions.map(\.id), ["action-1"])
        XCTAssertEqual(model.actions.first?.state, .awaitingApproval)
        XCTAssertEqual(model.onboardingReadiness.executor, .online(deviceID: "agent"), "same identity keeps its device facts")
        let requests = await transport.requests()
        XCTAssertTrue(requests.allSatisfy { $0.hasPrefix("GET ") }, "\(requests)")
    }

    func testPairedRemoteAddressAndUnconfiguredHostStates() async {
        let transport = ReadinessTransport()
        let model = makeModel(transport)
        model.hostAddress = "https://example.invalid"
        model.configureHost()
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostPairingUnavailable])
        model.hostAddress = "not a url"
        XCTAssertEqual(model.onboardingReadiness.steps, [.hostPairingUnavailable])
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    // MARK: - Synthetic host

    private func put(_ transport: ReadinessTransport, _ method: String, _ path: String, _ object: Any) async {
        let data = try! JSONSerialization.data(withJSONObject: object)
        await transport.push(method, path, data)
    }

    private func release(_ transport: ReadinessTransport, _ method: String, _ path: String, _ object: Any) async {
        let data = try! JSONSerialization.data(withJSONObject: object)
        await transport.resume(method, path, data)
    }

    private func makeModel(_ transport: ReadinessTransport) -> DexterAppModel {
        DexterAppModel(client: HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport), storage: ReadinessMemoryStorage())
    }

    private func enqueueHost(
        _ transport: ReadinessTransport, hostID: String, routing: String = "connected", engines: [String]?,
        threads: [String] = [], actions: [[String: Any]] = []
    ) async {
        await put(transport, "GET", "/health", healthObject(hostID: hostID, routing: routing, engines: engines))
        await put(transport, "GET", "/v1/bots", botsObject())
        await put(transport, "GET", "/v1/actions", ["items": actions])
        await enqueueHostAfterHealth(transport, threads: threads)
    }

    private func botsObject() -> [String: Any] {
        ["items": [["id": "bot-a", "name": "A", "profileId": "default", "engine": "claude", "ownerId": "owner", "createdAt": 1]]]
    }

    /// The thread listing that follows bots and actions in `refresh`.
    private func enqueueHostAfterHealth(_ transport: ReadinessTransport, threads: [String]) async {
        await put(transport, "GET", "/v1/bots/bot-a/threads", ["items": threads.map {
            ["id": $0, "botId": "bot-a", "createdAt": 1] as [String: Any]
        }])
        // The current AppModel also reads the owner Teams projection before private thread events.
        await put(transport, "GET", "/v1/teams", ["items": []])
        let events = threads.enumerated().map { index, id in
            ["cursor": index + 1, "id": "event-\(id)", "kind": "thread.created", "botId": "bot-a", "threadId": id, "entityId": id, "createdAt": 1] as [String: Any]
        }
        await put(transport, "GET", "/v1/events", ["items": events, "nextCursor": events.count])
        for id in threads { await put(transport, "GET", "/v1/threads/\(id)", ["id": id, "botId": "bot-a", "createdAt": 1]) }
    }

    private func healthObject(
        hostID: String, protocolVersion: Int = 1, routing: String = "connected", engines: [String]? = ["claude"],
        remotePairing: String = "not_implemented"
    ) -> [String: Any] {
        var health: [String: Any] = [
            "protocolVersion": protocolVersion, "mode": "local-development", "hostId": hostID, "engineRouting": routing,
            "remotePairing": remotePairing, "state": [String: Any](),
        ]
        health["runtime"] = engines.map { ["state": "running", "engines": $0] as [String: Any] } ?? NSNull()
        return health
    }

    private func enqueueThread(_ transport: ReadinessTransport, _ id: String, turns: [[String: Any]], actions: [[String: Any]] = []) async {
        await put(transport, "GET", "/v1/threads/\(id)/turns", ["items": turns, "nextCursor": turns.count])
        await put(transport, "GET", "/v1/threads/\(id)/messages", ["items": [], "nextCursor": 0])
        await put(transport, "GET", "/v1/actions", ["items": actions])
    }

    private func turnObject(_ id: String, thread: String, state: String, code: String?, updatedAt: Int64) -> [String: Any] {
        [
            "cursor": 1, "id": id, "threadId": thread, "botId": "bot-a", "engine": "claude", "clientRequestId": "request-\(id)",
            "inputMessageId": "input-\(id)", "outputMessageId": NSNull(), "state": state, "code": code as Any? ?? NSNull(),
            "outputChars": 0, "outputTruncated": false, "createdAt": 1, "startedAt": 2, "finishedAt": updatedAt, "updatedAt": updatedAt,
        ]
    }

    private func deviceObject(_ id: String, role: String, capabilities: [String] = [], name: String? = nil) -> [String: Any] {
        [
            "id": id, "ownerId": "owner", "name": name ?? "Synthetic \(id)", "platform": "macos", "capabilities": capabilities,
            "lastSeenAt": 1, "revokedAt": NSNull(), "presence": "online", "paired": true, "role": role,
        ]
    }

    private func actionObject(destination: String, tool: String) -> [String: Any] {
        [
            "id": "action-1",
            "request": ["botId": "bot-a", "threadId": "thread-a", "tool": tool, "destination": destination, "arguments": ["url": "https://example.invalid"], "idempotencyKey": "k"],
            "requestHash": "hash", "grantRevision": 1, "state": "awaiting_approval", "createdAt": 1, "updatedAt": 1,
            "approvalExpiresAt": 99, "decidedBy": NSNull(), "result": NSNull(), "reason": NSNull(),
        ]
    }
}

@MainActor
private final class ReadinessMemoryStorage: DexterAppStateStorage {
    private var data: Data?
    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

private actor ReadinessTransport: HTTPTransport {
    private enum Outcome { case data(Data), failure(Error), hold }
    private var outcomes: [String: [Outcome]] = [:]
    private var log: [String] = []
    private var held: [String: CheckedContinuation<TransportResponse, Error>] = [:]
    private var heldWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func push(_ method: String, _ path: String, _ data: Data) { outcomes["\(method) \(path)", default: []].append(.data(data)) }
    func pushFailure(_ method: String, _ path: String, _ error: Error) { outcomes["\(method) \(path)", default: []].append(.failure(error)) }
    func enqueueHold(_ method: String, _ path: String) { outcomes["\(method) \(path)", default: []].append(.hold) }
    func requests() -> [String] { log }
    private var requestWaiters: [(key: String, count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    func waitUntilRequested(_ method: String, _ path: String, count: Int) async {
        let key = "\(method) \(path)"
        if log.filter({ $0 == key }).count >= count { return }
        await withCheckedContinuation { requestWaiters.append((key, count, $0)) }
    }
    func waitUntilHeld(_ method: String, _ path: String) async {
        let key = "\(method) \(path)"
        if held[key] != nil { return }
        await withCheckedContinuation { heldWaiters[key, default: []].append($0) }
    }
    func resume(_ method: String, _ path: String, _ data: Data) {
        held.removeValue(forKey: "\(method) \(path)")?.resume(returning: TransportResponse(statusCode: 200, data: data))
    }
    func resumeFailing(_ method: String, _ path: String, _ error: Error) {
        held.removeValue(forKey: "\(method) \(path)")?.resume(throwing: error)
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        log.append(key)
        let seen = log.filter { $0 == key }.count
        requestWaiters.removeAll { waiter in
            guard waiter.key == key, seen >= waiter.count else { return false }
            waiter.continuation.resume()
            return true
        }
        guard var queue = outcomes[key], !queue.isEmpty else { throw URLError(.cannotConnectToHost) }
        let outcome = queue.removeFirst()
        outcomes[key] = queue
        switch outcome {
        case .data(let data): return TransportResponse(statusCode: 200, data: data)
        case .failure(let error): throw error
        case .hold:
            return try await withCheckedThrowingContinuation { continuation in
                held[key] = continuation
                heldWaiters.removeValue(forKey: key)?.forEach { $0.resume() }
            }
        }
    }
}
