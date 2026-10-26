#if os(macOS)
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

/// Synthetic facts only: no host, helper, Keychain, TCC, pairing or app control.
final class MacScreenControlGuideTests: XCTestCase {
    private let bot = "bot_alpha", other = "bot_beta", mac = "dev_this_mac", otherMac = "dev_other_mac"
    private let all = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"]
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func device(_ id: String? = nil, presence: DevicePresence = .online, paired: Bool = true,
                        revoked: Bool = false, capabilities: [String]? = nil) -> DeviceView {
        DeviceView(id: id ?? mac, ownerId: "own_1", name: "Mac", platform: .macos, capabilities: capabilities ?? all,
                   lastSeenAt: 1, revokedAt: revoked ? 2 : nil, presence: presence, paired: paired, role: "agent-mac")
    }
    private func grant(_ tool: String, policy: String? = "ask", bot: String? = nil, destination: String? = nil,
                       expiresAt: Int64? = nil, revision: Int = 3) throws -> DeviceGrantRow {
        let grant: [String: Any] = policy.map { ["botId": bot ?? self.bot, "tool": tool, "destination": destination ?? mac,
                                                 "policy": $0, "expiresAt": expiresAt.map { $0 as Any } ?? NSNull(), "revision": revision] } ?? [:]
        let entry: [String: Any] = ["botId": bot ?? self.bot, "tool": tool, "destination": destination ?? mac,
                                    "grant": policy == nil ? NSNull() : grant]
        return DeviceGrantRow(try JSONDecoder().decode(DeviceGrantEntry.self, from: JSONSerialization.data(withJSONObject: entry)))
    }
    private func route(_ tool: String, status: String = "active", bot: String? = nil, device: String? = nil,
                       needsFreshGrant: Bool = false, minimumGrantRevision: Int = 1) throws -> DeviceConversationRoute {
        let object: [String: Any] = ["id": "dvr_\(tool.replacingOccurrences(of: ".", with: "_"))", "botId": bot ?? self.bot,
            "deviceId": device ?? mac, "tool": tool, "fingerprint": String(repeating: "a", count: 64), "generation": 1,
            "pinRevision": 1, "schemaHash": String(repeating: "b", count: 64), "operationVersion": "1.1.0", "revision": 2,
            "status": status, "minimumGrantRevision": minimumGrantRevision, "needsFreshGrant": needsFreshGrant]
        return try JSONDecoder().decode(DeviceConversationRoute.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func access(_ tools: [String] = ["mac.cua.status", "mac.cua.observe", "mac.cua.control"]) throws -> [String: MacScreenControlHostAccess] {
        MacScreenControlHostAccess.read(botID: bot, deviceID: mac, grants: try tools.map { try grant($0) },
                                        routes: try tools.map { try route($0) }, now: now)
    }
    private func facts(setup: MacScreenControlFacts.Setup = .prepared(screenControl: true), agent: MacScreenControlFacts.Agent = .running,
                       device: MacScreenControlFacts.Device? = nil, bot: String?? = nil,
                       hostAccess: [String: MacScreenControlHostAccess]? = nil, local: MacScreenControlFacts.Local? = nil,
                       preparationAllowed: Bool = true) throws -> MacScreenControlFacts {
        MacScreenControlFacts(setup: setup, agent: agent, device: device ?? .bound(self.device()), botID: bot ?? self.bot,
                              hostAccess: try hostAccess ?? access(),
                              local: local ?? .authorized(operations: all, maxSessionSeconds: 300), preparationAllowed: preparationAllowed)
    }
    private func state(_ guide: MacScreenControlGuide, _ kind: MacScreenControlGuide.StepKind) -> MacScreenControlGuide.StepState {
        guide.steps.first { $0.kind == kind }!.state
    }

    func testEveryAppVerifiableLayerDoneStillNeverClaimsPermissionsCalibrationOrSession() throws {
        let guide = MacScreenControlGuide(try facts())
        XCTAssertEqual(guide.steps.map(\.kind), [.mac, .hostAccess, .localAuthorization, .macPermissions, .eachUse])
        XCTAssertEqual(guide.steps.prefix(3).map(\.state), [.done, .done, .done])
        XCTAssertEqual(state(guide, .macPermissions), .notReadable)
        XCTAssertEqual(state(guide, .eachUse), .perUse)
        XCTAssertEqual(guide.summary, .configured(control: true))
        XCTAssertEqual(guide.effectiveOperations, all)
        // The last thing the app can do is bring the already running helper forward; it never launches it.
        XCTAssertEqual(guide.next, .macPermissions)
        XCTAssertEqual(guide.action, .showControlPanel)
        XCTAssertFalse(guide.steps.contains { $0.kind == .macPermissions && $0.state == .done })
    }

    func testAdvertisedCapabilitiesAloneAreConnectionFactsNotBotReadiness() throws {
        // Online, CUA advertised, but no host access or local authorization: nothing is "ready" for the bot.
        let guide = MacScreenControlGuide(try facts(hostAccess: MacScreenControlHostAccess.read(botID: bot, deviceID: mac, grants: [], routes: [], now: now),
                                                    local: MacScreenControlFacts.Local.missing))
        XCTAssertEqual(state(guide, .mac), .done)
        XCTAssertEqual(guide.steps.first { $0.kind == .mac }?.operations, all)
        XCTAssertEqual(state(guide, .hostAccess), .needed)
        XCTAssertEqual(state(guide, .localAuthorization), .needed)
        XCTAssertEqual(guide.next, .hostAccess)
        XCTAssertEqual(guide.action, .reviewBotAccess)
        XCTAssertEqual(guide.summary, .remaining(2))
        XCTAssertEqual(guide.effectiveOperations, [])
    }

    func testObserveWithoutControlIsConfiguredForViewingOnly() throws {
        let tools = ["mac.cua.status", "mac.cua.observe"]
        let guide = MacScreenControlGuide(try facts(hostAccess: access(tools), local: .authorized(operations: all, maxSessionSeconds: 60)))
        XCTAssertEqual(guide.summary, .configured(control: false))
        XCTAssertEqual(guide.effectiveOperations, tools)
        // Status is required: observe alone cannot ask for a consented session.
        let noStatus = MacScreenControlGuide(try facts(local: .authorized(operations: ["mac.cua.observe", "mac.cua.control"], maxSessionSeconds: 60)))
        XCTAssertEqual(state(noStatus, .localAuthorization), .needed)
        XCTAssertEqual(noStatus.effectiveOperations, [])
    }

    func testHostAccessUsesOnlyThisBotAndThisMacAndTheClosedStatusVocabulary() throws {
        let tool = "mac.cua.observe"
        func one(_ grants: [DeviceGrantRow]?, _ routes: [DeviceConversationRoute]?) -> MacScreenControlHostAccess? {
            MacScreenControlHostAccess.read(botID: bot, deviceID: mac, grants: grants, routes: routes, now: now)[tool]
        }
        XCTAssertEqual(one([try grant(tool)], [try route(tool)]), .valid)
        XCTAssertEqual(one([try grant(tool, policy: "allow")], [try route(tool)]), .valid)
        XCTAssertEqual(one(nil, [try route(tool)]), .unknown)
        XCTAssertEqual(one([try grant(tool)], nil), .unknown)
        XCTAssertEqual(one([try grant(tool)], []), .notPublished)
        XCTAssertEqual(one([try grant(tool)], [try route(tool, status: "suspended")]), .notPublished)
        XCTAssertEqual(one([try grant(tool)], [try route(tool, status: "revoked")]), .notPublished)
        XCTAssertEqual(one([try grant(tool)], [try route(tool, needsFreshGrant: true)]), .revisionRequired)
        XCTAssertEqual(one([try grant(tool, revision: 1)], [try route(tool, minimumGrantRevision: 2)]), .revisionRequired)
        XCTAssertEqual(one([], [try route(tool)]), .missing)
        XCTAssertEqual(one([try grant(tool, policy: nil)], [try route(tool)]), .missing)
        XCTAssertEqual(one([try grant(tool, policy: "deny")], [try route(tool)]), .denied)
        XCTAssertEqual(one([try grant(tool, expiresAt: Int64(now.timeIntervalSince1970 * 1000))], [try route(tool)]), .expired)
        XCTAssertEqual(one([try grant(tool, policy: "something")], [try route(tool)]), .unknown)
        // Host precedence: missing, denied and expired are never hidden behind "renew permission".
        XCTAssertEqual(one([try grant(tool, policy: "deny")], [try route(tool, needsFreshGrant: true)]), .denied)
        XCTAssertEqual(one([try grant(tool, policy: "deny", revision: 1)], [try route(tool, minimumGrantRevision: 2)]), .denied)
        XCTAssertEqual(one([try grant(tool, expiresAt: 1)], [try route(tool, needsFreshGrant: true)]), .expired)
        XCTAssertEqual(one([], [try route(tool, needsFreshGrant: true)]), .missing)
        // Another bot's or another Mac's rows never count for this bot on this Mac.
        XCTAssertEqual(one([try grant(tool, bot: other)], [try route(tool)]), .missing)
        XCTAssertEqual(one([try grant(tool, destination: otherMac)], [try route(tool)]), .missing)
        XCTAssertEqual(one([try grant(tool)], [try route(tool, bot: other)]), .notPublished)
        XCTAssertEqual(one([try grant(tool)], [try route(tool, device: otherMac)]), .notPublished)
        // Duplicate rows are ambiguous, never resolved by picking one.
        XCTAssertEqual(one([try grant(tool), try grant(tool, policy: "deny")], [try route(tool)]), .unknown)
        XCTAssertEqual(MacScreenControlHostAccess.read(botID: bot, deviceID: mac, grants: [], routes: [], now: now).count, 3)
    }

    func testUnknownReadsAreShownAsUnknownWithReloadNotAsMissingOrDone() throws {
        let unknownAccess = MacScreenControlHostAccess.read(botID: bot, deviceID: mac, grants: nil, routes: nil, now: now)
        let guide = MacScreenControlGuide(try facts(hostAccess: unknownAccess, local: .unknown))
        XCTAssertEqual(state(guide, .hostAccess), .unknown)
        XCTAssertEqual(state(guide, .localAuthorization), .unknown)
        XCTAssertEqual(guide.next, .hostAccess)
        XCTAssertEqual(guide.action, .reload)
        XCTAssertNotEqual(guide.summary, .configured(control: true))
        let unverified = MacScreenControlGuide(try facts(setup: .unverified))
        XCTAssertEqual(state(unverified, .mac), .unknown)
        XCTAssertEqual(unverified.action, .reload)
        let deviceUnknown = MacScreenControlGuide(try facts(device: .unknown))
        XCTAssertEqual(state(deviceUnknown, .mac), .unknown)
        XCTAssertEqual(deviceUnknown.action, .checkAgain)
        XCTAssertEqual(state(deviceUnknown, .hostAccess), .waiting)
    }

    func testPreparationStartsOnlyFromAnExplicitActionAndHonoursTheRuntimeGate() throws {
        let fresh = MacScreenControlGuide(try facts(setup: .notPrepared, agent: .stopped, device: .notBound, local: .unknown))
        XCTAssertEqual(fresh.next, .mac)
        XCTAssertEqual(fresh.action, .prepareMac)
        XCTAssertFalse(fresh.actionBlockedByRuntime)
        let busy = MacScreenControlGuide(try facts(setup: .notPrepared, agent: .stopped, device: .notBound, local: .unknown, preparationAllowed: false))
        XCTAssertEqual(busy.action, .prepareMac)
        XCTAssertTrue(busy.actionBlockedByRuntime)
        // Showing the Dexter Control window or reviewing access never depends on the preparation gate.
        XCTAssertFalse(MacScreenControlGuide(try facts(preparationAllowed: false)).actionBlockedByRuntime)
        let pairing = MacScreenControlGuide(try facts(device: .notBound))
        XCTAssertEqual(state(pairing, .mac), .waiting)
        XCTAssertEqual(pairing.action, .prepareMac)
    }

    func testPackageWithoutHelperIsUnavailableWithoutAnyAction() throws {
        let guide = MacScreenControlGuide(try facts(setup: .packageMissing, agent: .stopped, device: .notBound, local: .unknown))
        XCTAssertEqual(state(guide, .mac), .unavailable)
        XCTAssertEqual(guide.summary, .unavailable)
        XCTAssertNil(guide.action)
        XCTAssertEqual(guide.effectiveOperations, [])
    }

    func testLocalAuthorizationIsEditedWhileStoppedBeforeStartingAgain() throws {
        // Running agent: the explicit way forward is to stop it (files change only while stopped).
        let running = MacScreenControlGuide(try facts(local: MacScreenControlFacts.Local.missing))
        XCTAssertEqual(running.next, .localAuthorization)
        XCTAssertEqual(running.action, .stopAgent)
        // Stopped agent with a known paired device: edit first, start once afterwards.
        let stopped = MacScreenControlGuide(try facts(agent: .stopped, local: MacScreenControlFacts.Local.missing))
        XCTAssertEqual(state(stopped, .mac), .needed)
        XCTAssertEqual(stopped.next, .localAuthorization)
        XCTAssertEqual(stopped.action, .editLocalAuthorization)
        let saved = MacScreenControlGuide(try facts(agent: .stopped))
        XCTAssertEqual(saved.next, .mac)
        XCTAssertEqual(saved.action, .startAgent)
        XCTAssertEqual(saved.summary, .remaining(1))
        let stopping = MacScreenControlGuide(try facts(agent: .stopping, local: MacScreenControlFacts.Local.missing))
        XCTAssertNil(stopping.action)
        XCTAssertEqual(state(stopping, .localAuthorization), .waiting)
    }

    func testLegacyConfigurationWithoutHelperAsksToPrepareItWhileStopped() throws {
        let running = MacScreenControlGuide(try facts(setup: .prepared(screenControl: false), local: .unknown))
        XCTAssertEqual(running.next, .mac)
        XCTAssertEqual(running.action, .stopAgent)
        let stopped = MacScreenControlGuide(try facts(setup: .prepared(screenControl: false), agent: .stopped, local: .unknown))
        XCTAssertEqual(stopped.action, .prepareHelper)
        XCTAssertEqual(state(stopped, .localAuthorization), .waiting)
    }

    func testRevokedOfflineAndUnadvertisedDevicesAreNotDone() throws {
        let revoked = MacScreenControlGuide(try facts(device: .bound(device(revoked: true))))
        XCTAssertEqual(state(revoked, .mac), .attention)
        XCTAssertEqual(revoked.summary, .attention)
        XCTAssertEqual(revoked.action, .openAdvanced)
        let offline = MacScreenControlGuide(try facts(device: .bound(device(presence: .stale))))
        XCTAssertEqual(state(offline, .mac), .waiting)
        XCTAssertEqual(offline.action, .checkAgain)
        XCTAssertEqual(offline.effectiveOperations, [])
        let unadvertised = MacScreenControlGuide(try facts(device: .bound(device(capabilities: ["mac.browser.read"]))))
        XCTAssertEqual(state(unadvertised, .mac), .attention)
        XCTAssertEqual(unadvertised.effectiveOperations, [])
        let unpaired = MacScreenControlGuide(try facts(device: .bound(device(paired: false))))
        XCTAssertEqual(state(unpaired, .mac), .waiting)
        XCTAssertEqual(unpaired.action, .prepareMac)
    }

    func testWithoutABotNothingIsScopedAndTheOwnerChoosesFirst() throws {
        let guide = MacScreenControlGuide(try facts(bot: .some(nil)))
        XCTAssertEqual(state(guide, .hostAccess), .needed)
        XCTAssertEqual(guide.next, .hostAccess)
        XCTAssertEqual(guide.action, .chooseBot)
        XCTAssertEqual(guide.summary, .chooseBot)
        XCTAssertEqual(guide.effectiveOperations, [])
    }

    func testEffectiveOperationsAreTheIntersectionOfEveryKnownLayer() throws {
        let guide = MacScreenControlGuide(try facts(device: .bound(device(capabilities: ["mac.cua.status", "mac.cua.observe", "mac.cua.control"])),
                                                    hostAccess: access(["mac.cua.status", "mac.cua.observe", "mac.cua.control"]),
                                                    local: .authorized(operations: ["mac.cua.status", "mac.cua.observe"], maxSessionSeconds: 900)))
        XCTAssertEqual(guide.effectiveOperations, ["mac.cua.status", "mac.cua.observe"])
        XCTAssertEqual(guide.summary, .configured(control: false))
        XCTAssertEqual(guide.steps.first { $0.kind == .localAuthorization }?.operations, ["mac.cua.status", "mac.cua.observe"])
    }
}
#endif
