import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

@MainActor
final class DexterAppModelTests: XCTestCase {
    func testDeviceListUsesHostPresenceAndNeverTreatsUnpairedRegistrationAsOnline() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let devices = [
            deviceObject(id: "mac-online", presence: "online", paired: true),
            deviceObject(id: "legacy-unpaired", presence: "stale", paired: false),
            deviceObject(id: "mac-offline", presence: "stale", paired: true),
            deviceObject(id: "mac-revoked", presence: "revoked", paired: false, revokedAt: 1_791_331_201_000),
        ]
        let devicesData = try JSONSerialization.data(withJSONObject: ["items": devices])
        await transport.enqueueData(devicesData, method: "GET", path: "/v1/devices")

        await model.refreshDevices()

        XCTAssertEqual(model.devices.map(\.displayStatus), [.online, .unpaired, .offline, .revoked])
        XCTAssertEqual(model.devices.map(\.id), ["mac-online", "legacy-unpaired", "mac-offline", "mac-revoked"])
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), ["/v1/devices"])
        XCTAssertEqual(requests.map(\.method), ["GET"])
        XCTAssertFalse(requests.contains { $0.path.contains("grant") || $0.path.contains("approval") })
    }

    func testRenameUsesHostPersistedDeviceProjectionAndRevokeShowsRevokedState() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let online = deviceObject(id: "mac-managed", presence: "online", paired: true)
        var renamed = online
        renamed["name"] = "Main Mac"
        var revoked = renamed
        revoked["presence"] = "revoked"
        revoked["paired"] = false
        revoked["revokedAt"] = 1_791_331_201_000
        let onlineData = try JSONSerialization.data(withJSONObject: ["items": [online]])
        let renamedData = try JSONSerialization.data(withJSONObject: renamed)
        let revokedData = try JSONSerialization.data(withJSONObject: revoked)

        await transport.enqueueData(onlineData, method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueData(renamedData, method: "PATCH", path: "/v1/devices/mac-managed")

        let didRename = await model.renameDevice(id: "mac-managed", name: "  Main Mac  ")
        XCTAssertTrue(didRename)
        XCTAssertEqual(model.devices.first?.name, "Main Mac")

        await transport.enqueueData(revokedData, method: "POST", path: "/v1/devices/mac-managed/revoke")
        let didRevoke = await model.revokeDevice(id: "mac-managed")
        XCTAssertTrue(didRevoke)
        XCTAssertEqual(model.devices.first?.displayStatus, .revoked)
        XCTAssertEqual(model.devices.first?.revokedAt, 1_791_331_201_000)

        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.path), [
            "/v1/devices",
            "/v1/devices/mac-managed",
            "/v1/devices/mac-managed/revoke",
        ])
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "POST"])
        let renameBody = try XCTUnwrap(requests[1].body?.jsonObject())
        XCTAssertEqual(renameBody["name"] as? String, "Main Mac")
        XCTAssertFalse(requests.contains { $0.path.contains("grant") || $0.path.contains("approval") })
    }

    func testUnknownDeviceMutationFailsClosedWithoutSendingRequest() async {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let renamed = await model.renameDevice(id: "not-listed", name: "No")
        let revoked = await model.revokeDevice(id: "not-listed")

        XCTAssertFalse(renamed)
        XCTAssertFalse(revoked)
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testInFlightDeviceListCannotRepopulateAfterSwitchingToFixture() async {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        await transport.enqueueHold(method: "GET", path: "/v1/devices")

        let refresh = Task { await model.refreshDevices() }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices")
        model.useFixture()
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertTrue(model.isFixture)

        await transport.release(
            method: "GET",
            path: "/v1/devices",
            data: json(["items": [deviceObject(id: "late-device", presence: "online", paired: true)]])
        )
        await refresh.value

        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertFalse(model.isLoadingDevices)
    }

    func testCancelledDeviceListDiscardsLateResponse() async {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        await transport.enqueueHold(method: "GET", path: "/v1/devices")

        let refresh = Task { await model.refreshDevices() }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices")
        refresh.cancel()
        await transport.release(
            method: "GET",
            path: "/v1/devices",
            data: json(["items": [deviceObject(id: "cancelled-device", presence: "online", paired: true)]])
        )
        await refresh.value

        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertFalse(model.isLoadingDevices)
    }

    func testConcurrentDeviceMutationsAreSerializedByModelLock() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let first = deviceObject(id: "device-a", presence: "online", paired: true)
        let second = deviceObject(id: "device-b", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [first, second]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        var renamed = first
        renamed["name"] = "Renamed A"
        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-a")
        let rename = Task { await model.renameDevice(id: "device-a", name: "Renamed A") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-a")

        let didRevoke = await model.revokeDevice(id: "device-b")
        XCTAssertFalse(didRevoke)
        XCTAssertEqual(model.operatingDeviceIDs, ["device-a"])
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-b")
        let secondRename = await model.renameDevice(id: "device-b", name: "Renamed B")
        XCTAssertFalse(secondRename)
        XCTAssertFalse(model.awaitingDeviceConfirmationIDs.contains("device-b"), "A blocked rename must not be sent while another mutation is in flight")

        await transport.release(method: "PATCH", path: "/v1/devices/device-a", data: json(renamed))
        let didRename = await rename.value
        XCTAssertTrue(didRename)
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH"])
        XCTAssertEqual(requests.last?.path, "/v1/devices/device-a")
    }

    func testConcurrentRenamesForSameDeviceAreSerialized() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-same-rename", presence: "online", paired: true)
        var firstRename = original
        firstRename["name"] = "First name"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-same-rename")
        let first = Task { await model.renameDevice(id: "device-same-rename", name: "First name") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-same-rename")
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-same-rename")

        let second = await model.renameDevice(id: "device-same-rename", name: "Second name")
        XCTAssertFalse(second)
        XCTAssertEqual(model.operatingDeviceIDs, ["device-same-rename"])
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)

        await transport.release(method: "PATCH", path: "/v1/devices/device-same-rename", data: json(firstRename))
        let didRenameFirst = await first.value
        XCTAssertTrue(didRenameFirst)
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH"])
        XCTAssertEqual(requests.filter { $0.path == "/v1/devices/device-same-rename" }.count, 1)
        XCTAssertEqual(model.devices.first?.name, "First name")
    }

    func testUncertainDeviceDoesNotBlockOtherDeviceAndDiscardRequiresFreshRead() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let originalA = deviceObject(id: "device-a", presence: "online", paired: true)
        let originalB = deviceObject(id: "device-b", presence: "online", paired: true)
        var renamedB = originalB
        renamedB["name"] = "Renamed B"
        await transport.enqueueData(json(["items": [originalA, originalB]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-a")
        let initialRename = await model.renameDevice(id: "device-a", name: "Target A")
        XCTAssertFalse(initialRename)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-a"])

        await transport.enqueueData(json(renamedB), method: "PATCH", path: "/v1/devices/device-b")
        let renamedOtherDevice = await model.renameDevice(id: "device-b", name: "Renamed B")
        XCTAssertTrue(renamedOtherDevice)
        XCTAssertEqual(model.devices.first(where: { $0.id == "device-b" })?.name, "Renamed B")
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-a"])

        await transport.enqueueData(json(originalA), method: "GET", path: "/v1/devices/device-a")
        let matchedPriorState = await model.confirmDeviceMutation(id: "device-a")
        XCTAssertFalse(matchedPriorState)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-a"], "The old state does not prove the prior PATCH had no effect")
        XCTAssertEqual(model.discardableDeviceMutationIDs, ["device-a"])
        XCTAssertEqual(model.displayStatus(for: try XCTUnwrap(model.devices.first(where: { $0.id == "device-a" }))), .confirming)

        let beforeBlockedRetry = await transport.requests()
        let blockedRetry = await model.renameDevice(id: "device-a", name: "Target A")
        XCTAssertFalse(blockedRetry)
        let requestsAfterBlockedRetry = await transport.requests()
        XCTAssertEqual(requestsAfterBlockedRetry.filter { $0.method == "PATCH" && $0.path == "/v1/devices/device-a" }.count, 1)
        XCTAssertEqual(beforeBlockedRetry.count, requestsAfterBlockedRetry.count)

        XCTAssertTrue(model.discardDeviceMutationExpectation(id: "device-a"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
        let requestsAfterDiscard = await transport.requests()
        XCTAssertEqual(requestsAfterDiscard.count, beforeBlockedRetry.count, "Discard only clears local state; it never retries the write")
        XCTAssertEqual(requestsAfterDiscard.map(\.method), ["GET", "PATCH", "PATCH", "GET"])
    }

    func testDiscardIsRefusedBeforeAnyFreshGET() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-discard-before-get", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-discard-before-get")

        let didRename = await model.renameDevice(id: "device-discard-before-get", name: "Expected name")
        XCTAssertFalse(didRename)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.contains("device-discard-before-get"))
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-before-get"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.contains("device-discard-before-get"))

        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "GET" && $0.path == "/v1/devices/device-discard-before-get" }.count, 0)
        XCTAssertEqual(requests.filter { $0.method == "PATCH" && $0.path == "/v1/devices/device-discard-before-get" }.count, 1)
    }

    func testDiscardIsRefusedAfterOfflineFreshGET() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-discard-offline", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-discard-offline")

        let didRename = await model.renameDevice(id: "device-discard-offline", name: "Expected name")
        XCTAssertFalse(didRename)
        await transport.enqueueOffline(method: "GET", path: "/v1/devices/device-discard-offline")

        let didConfirm = await model.confirmDeviceMutation(id: "device-discard-offline")
        XCTAssertFalse(didConfirm)
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-offline"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.contains("device-discard-offline"))
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
    }

    func testDiscardRequiresSuccessfulSameDeviceGETAndRefreshInvalidatesObservation() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let originalA = deviceObject(id: "device-discard-a", presence: "online", paired: true)
        let originalB = deviceObject(id: "device-discard-b", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [originalA, originalB]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-discard-a")

        let didRename = await model.renameDevice(id: "device-discard-a", name: "Expected name")
        XCTAssertFalse(didRename)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-discard-a"])

        await transport.enqueueHold(method: "GET", path: "/v1/devices/device-discard-a")
        let mismatchedCheck = Task { await model.confirmDeviceMutation(id: "device-discard-a") }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices/device-discard-a")
        XCTAssertEqual(model.operatingDeviceIDs, ["device-discard-a"])
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-a"), "An in-flight GET is not yet an observation")
        await transport.release(
            method: "GET",
            path: "/v1/devices/device-discard-a",
            data: json(originalB)
        )
        let didMismatch = await mismatchedCheck.value
        XCTAssertFalse(didMismatch)
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-a"), "A GET response for another ID is rejected")

        await transport.enqueueData(json(originalA), method: "GET", path: "/v1/devices/device-discard-a")
        let didConfirmPrior = await model.confirmDeviceMutation(id: "device-discard-a")
        XCTAssertFalse(didConfirmPrior)
        XCTAssertEqual(model.discardableDeviceMutationIDs, ["device-discard-a"])

        await transport.enqueueHold(method: "GET", path: "/v1/devices")
        let refresh = Task { await model.refreshDevices() }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices")
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-a"), "A new list refresh invalidates the earlier discard observation")
        await transport.release(
            method: "GET",
            path: "/v1/devices",
            data: json(["items": [originalA, originalB]])
        )
        await refresh.value

        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.contains("device-discard-a"))
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-a"))
        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "PATCH" && $0.path == "/v1/devices/device-discard-a" }.count, 1)
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "GET", "GET", "GET"])
    }

    func testRevokePresenceDriftStillAllowsExplicitDiscardAfterFreshGET() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-revoke-drift", presence: "online", paired: true)
        var stale = original
        stale["presence"] = "stale"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "POST", path: "/v1/devices/device-revoke-drift/revoke")

        let didRevoke = await model.revokeDevice(id: "device-revoke-drift")
        XCTAssertFalse(didRevoke)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-revoke-drift"])
        await transport.enqueueData(json(stale), method: "GET", path: "/v1/devices/device-revoke-drift")

        let didConfirm = await model.confirmDeviceMutation(id: "device-revoke-drift")
        XCTAssertFalse(didConfirm)
        XCTAssertEqual(model.devices.first?.presence, .stale)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-revoke-drift"])
        XCTAssertEqual(model.discardableDeviceMutationIDs, ["device-revoke-drift"])
        XCTAssertTrue(model.discardDeviceMutationExpectation(id: "device-revoke-drift"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)

        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1, "Discard never retries the possibly applied revoke")
        XCTAssertEqual(requests.map(\.method), ["GET", "POST", "GET"])
    }

    func testRenameThirdNameFromConcurrentActorAllowsExplicitDiscardAfterFreshGET() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-rename-third", presence: "online", paired: true)
        var thirdName = original
        thirdName["name"] = "Changed by another client"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-rename-third")

        let didRename = await model.renameDevice(id: "device-rename-third", name: "Expected name")
        XCTAssertFalse(didRename)
        await transport.enqueueData(json(thirdName), method: "GET", path: "/v1/devices/device-rename-third")

        let didConfirm = await model.confirmDeviceMutation(id: "device-rename-third")
        XCTAssertFalse(didConfirm)
        XCTAssertEqual(model.devices.first?.name, "Changed by another client")
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-rename-third"])
        XCTAssertEqual(model.discardableDeviceMutationIDs, ["device-rename-third"])
        XCTAssertTrue(model.discardDeviceMutationExpectation(id: "device-rename-third"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)

        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "PATCH" }.count, 1, "Discard never retries the possibly applied rename")
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "GET"])
    }

    func testDiscardDoesNotOverlapAnotherDevicesInFlightWrite() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let originalA = deviceObject(id: "device-discard-a", presence: "online", paired: true)
        let originalB = deviceObject(id: "device-discard-b", presence: "online", paired: true)
        var changedA = originalA
        changedA["name"] = "Changed by another client"
        var renamedB = originalB
        renamedB["name"] = "Renamed B"
        await transport.enqueueData(json(["items": [originalA, originalB]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-discard-a")

        let didRenameA = await model.renameDevice(id: "device-discard-a", name: "Expected A")
        XCTAssertFalse(didRenameA)
        await transport.enqueueData(json(changedA), method: "GET", path: "/v1/devices/device-discard-a")
        let didConfirmA = await model.confirmDeviceMutation(id: "device-discard-a")
        XCTAssertFalse(didConfirmA)
        XCTAssertEqual(model.discardableDeviceMutationIDs, ["device-discard-a"])

        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-discard-b")
        let renameB = Task { await model.renameDevice(id: "device-discard-b", name: "Renamed B") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-discard-b")
        XCTAssertEqual(model.operatingDeviceIDs, ["device-discard-b"])
        XCTAssertFalse(model.discardDeviceMutationExpectation(id: "device-discard-a"))

        await transport.release(method: "PATCH", path: "/v1/devices/device-discard-b", data: json(renamedB))
        let didRenameB = await renameB.value
        XCTAssertTrue(didRenameB)
        XCTAssertTrue(model.discardDeviceMutationExpectation(id: "device-discard-a"))

        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "PATCH" && $0.path == "/v1/devices/device-discard-a" }.count, 1)
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "GET", "PATCH"])
    }

    func testResetClearsPendingDeviceMutationUncertainty() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-reset-uncertain", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueCancelled(method: "PATCH", path: "/v1/devices/device-reset-uncertain")

        let didRename = await model.renameDevice(id: "device-reset-uncertain", name: "Possible result")
        XCTAssertFalse(didRename)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-reset-uncertain"])
        model.useFixture()

        XCTAssertTrue(model.isFixture)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
        XCTAssertTrue(model.operatingDeviceIDs.isEmpty)
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertNil(model.deviceError)
    }

    func testHostResetFencesAnInFlightDeviceConfirmationRead() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-confirm-reset", presence: "online", paired: true)
        var renamed = original
        renamed["name"] = "Possible result"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-confirm-reset")
        let didRename = await model.renameDevice(id: "device-confirm-reset", name: "Possible result")
        XCTAssertFalse(didRename)
        await transport.enqueueHold(method: "GET", path: "/v1/devices/device-confirm-reset")

        let check = Task { await model.confirmDeviceMutation(id: "device-confirm-reset") }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices/device-confirm-reset")
        model.useFixture()
        await transport.release(method: "GET", path: "/v1/devices/device-confirm-reset", data: json(renamed))

        let didConfirm = await check.value
        XCTAssertFalse(didConfirm)
        XCTAssertTrue(model.isFixture)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertNil(model.deviceError)
    }

    func testNewerDeviceRevisionFencesLateConfirmationAndExpectationMismatchRemainsUncertain() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-revision", presence: "online", paired: true)
        var expectedRename = original
        expectedRename["name"] = "Expected"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-revision")
        let didRename = await model.renameDevice(id: "device-revision", name: "Expected")
        XCTAssertFalse(didRename)
        await transport.enqueueHold(method: "GET", path: "/v1/devices/device-revision")

        let staleCheck = Task { await model.confirmDeviceMutation(id: "device-revision") }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices/device-revision")
        model.recordDeviceMutationRevision(for: "device-revision")
        await transport.release(method: "GET", path: "/v1/devices/device-revision", data: json(expectedRename))

        let staleConfirmationResult = await staleCheck.value
        XCTAssertFalse(staleConfirmationResult)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-revision"])
        XCTAssertTrue(model.discardableDeviceMutationIDs.isEmpty)
        XCTAssertEqual(model.devices.first?.name, "Synthetic device-revision", "A response from a superseded mutation revision cannot update the projection")

        var unrelated = original
        unrelated["name"] = "Unrelated external state"
        await transport.enqueueData(json(unrelated), method: "GET", path: "/v1/devices/device-revision")
        let unrelatedStateConfirmed = await model.confirmDeviceMutation(id: "device-revision")
        XCTAssertFalse(unrelatedStateConfirmed)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.contains("device-revision"))
        XCTAssertEqual(
            model.discardableDeviceMutationIDs,
            ["device-revision"],
            "A current-revision successful GET for this device enables explicit discard when it does not confirm the expectation"
        )
        XCTAssertEqual(model.devices.first?.name, "Unrelated external state")
        XCTAssertTrue(model.discardDeviceMutationExpectation(id: "device-revision"))
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
    }

    func testConfirmationAndWritesCannotOverlap() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let originalA = deviceObject(id: "device-confirm-a", presence: "online", paired: true)
        let originalB = deviceObject(id: "device-confirm-b", presence: "online", paired: true)
        var renamedA = originalA
        renamedA["name"] = "Confirmed A"
        await transport.enqueueData(json(["items": [originalA, originalB]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-confirm-a")
        let didInitialRename = await model.renameDevice(id: "device-confirm-a", name: "Confirmed A")
        XCTAssertFalse(didInitialRename)
        await transport.enqueueHold(method: "GET", path: "/v1/devices/device-confirm-a")

        let check = Task { await model.confirmDeviceMutation(id: "device-confirm-a") }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices/device-confirm-a")
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-confirm-b")
        let didOverlappingRename = await model.renameDevice(id: "device-confirm-b", name: "Renamed B")
        XCTAssertFalse(didOverlappingRename)
        XCTAssertEqual(model.operatingDeviceIDs, ["device-confirm-a"])

        await transport.release(method: "GET", path: "/v1/devices/device-confirm-a", data: json(renamedA))
        let didConfirm = await check.value
        XCTAssertTrue(didConfirm)
        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.path == "/v1/devices/device-confirm-b" }.count, 0)
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "GET"])
    }

    func testWriteInFlightCannotStartConfirmationForAnotherDevice() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let originalA = deviceObject(id: "device-confirm-a", presence: "online", paired: true)
        let originalB = deviceObject(id: "device-confirm-b", presence: "online", paired: true)
        var renamedB = originalB
        renamedB["name"] = "Renamed B"
        await transport.enqueueData(json(["items": [originalA, originalB]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "PATCH", path: "/v1/devices/device-confirm-a")
        let didInitialRename = await model.renameDevice(id: "device-confirm-a", name: "Possible A")
        XCTAssertFalse(didInitialRename)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-confirm-a"])

        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-confirm-b")
        let write = Task { await model.renameDevice(id: "device-confirm-b", name: "Renamed B") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-confirm-b")
        await transport.enqueueOffline(method: "GET", path: "/v1/devices/device-confirm-a")

        let didOverlapConfirmation = await model.confirmDeviceMutation(id: "device-confirm-a")
        XCTAssertFalse(didOverlapConfirmation)
        XCTAssertEqual(model.operatingDeviceIDs, ["device-confirm-b"])
        let requestsWhileWriteHeld = await transport.requests()
        XCTAssertFalse(requestsWhileWriteHeld.contains { $0.method == "GET" && $0.path == "/v1/devices/device-confirm-a" })

        await transport.release(method: "PATCH", path: "/v1/devices/device-confirm-b", data: json(renamedB))
        let didRenameB = await write.value
        XCTAssertTrue(didRenameB)
        let finalRequests = await transport.requests()
        XCTAssertEqual(finalRequests.map(\.method), ["GET", "PATCH", "PATCH"])
    }

    func testModelRenameUsesUTF16BoundaryAndECMAScriptTrimPolicy() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-name-policy", presence: "online", paired: true)
        let exactLimit = String(repeating: "😀", count: 60)
        var response = original
        response["name"] = exactLimit
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueData(json(response), method: "PATCH", path: "/v1/devices/device-name-policy")

        let didRenameAtLimit = await model.renameDevice(id: "device-name-policy", name: "\u{FEFF} \(exactLimit) \u{FEFF}")
        XCTAssertTrue(didRenameAtLimit)
        XCTAssertEqual(model.devices.first?.name, exactLimit)
        let didRenameOverLimit = await model.renameDevice(id: "device-name-policy", name: exactLimit + "😀")
        XCTAssertFalse(didRenameOverLimit)

        let nelPreserved = "\u{0085}Device\u{0085}"
        var responseWithNEL = response
        responseWithNEL["name"] = nelPreserved
        await transport.enqueueData(json(responseWithNEL), method: "PATCH", path: "/v1/devices/device-name-policy")
        let didRenameWithNEL = await model.renameDevice(
            id: "device-name-policy",
            name: "\u{FEFF} \u{0085}Device\u{0085} \u{FEFF}"
        )
        XCTAssertTrue(didRenameWithNEL)
        XCTAssertEqual(model.devices.first?.name, nelPreserved)
        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "PATCH" }.count, 2)
        let inputs = try requests.filter { $0.method == "PATCH" }.map { request -> String in
            try XCTUnwrap(request.body?.jsonObject()["name"] as? String)
        }
        XCTAssertEqual(inputs, [exactLimit, nelPreserved])
    }

    func testOverlappingRefreshCannotOverwriteNewerMutationResponse() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-race", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        var renamed = original
        renamed["name"] = "Newer name"
        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-race")
        let rename = Task { await model.renameDevice(id: "device-race", name: "Newer name") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-race")

        await transport.enqueueHold(method: "GET", path: "/v1/devices")
        let refresh = Task { await model.refreshDevices() }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/devices")

        await transport.release(method: "PATCH", path: "/v1/devices/device-race", data: json(renamed))
        let didRename = await rename.value
        XCTAssertTrue(didRename)
        await transport.release(method: "GET", path: "/v1/devices", data: json(["items": [original]]))
        await refresh.value

        XCTAssertEqual(model.devices.first?.name, "Newer name")
        XCTAssertNil(model.deviceError)
    }

    func testHostResetDiscardsLateDeviceMutationResponse() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-reset", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        var renamed = original
        renamed["name"] = "Old host result"
        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-reset")
        let rename = Task { await model.renameDevice(id: "device-reset", name: "Old host result") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-reset")

        model.hostAddress = "http://127.0.0.1:4318"
        model.configureHost()
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertTrue(model.operatingDeviceIDs.isEmpty)

        await transport.release(method: "PATCH", path: "/v1/devices/device-reset", data: json(renamed))
        let didRename = await rename.value
        XCTAssertFalse(didRename)
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertNil(model.deviceError)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        XCTAssertTrue(model.operatingDeviceIDs.isEmpty)
    }

    func testCancelledRenameRequiresReadonlyConfirmationBeforeAnotherMutation() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-rename-cancel", presence: "online", paired: true)
        var renamed = original
        renamed["name"] = "Target name"
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueHold(method: "PATCH", path: "/v1/devices/device-rename-cancel")
        let rename = Task { await model.renameDevice(id: "device-rename-cancel", name: "Target name") }
        await transport.waitUntilSuspended(method: "PATCH", path: "/v1/devices/device-rename-cancel")

        rename.cancel()
        let didRename = await rename.value
        XCTAssertFalse(didRename)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-rename-cancel"])
        XCTAssertEqual(model.displayStatus(for: try XCTUnwrap(model.devices.first)), .confirming)
        XCTAssertEqual(model.deviceError, .deviceMutationOutcomeUnknown)
        let repeatedRename = await model.renameDevice(id: "device-rename-cancel", name: "Target name")
        XCTAssertFalse(repeatedRename)

        await transport.enqueueData(json(renamed), method: "GET", path: "/v1/devices/device-rename-cancel")
        let didConfirm = await model.confirmDeviceMutation(id: "device-rename-cancel")
        XCTAssertTrue(didConfirm)
        XCTAssertEqual(model.devices.first?.name, "Target name")
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "PATCH", "GET"])
        XCTAssertEqual(requests.filter { $0.method == "PATCH" }.count, 1)
    }

    func testCancelledRevokeRemainsConfirmingUntilReadonlyGETShowsRevoked() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-revoke-cancel", presence: "online", paired: true)
        var revoked = original
        revoked["presence"] = "revoked"
        revoked["paired"] = false
        revoked["revokedAt"] = 1_791_331_201_000
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueHold(method: "POST", path: "/v1/devices/device-revoke-cancel/revoke")
        let revoke = Task { await model.revokeDevice(id: "device-revoke-cancel") }
        await transport.waitUntilSuspended(method: "POST", path: "/v1/devices/device-revoke-cancel/revoke")

        revoke.cancel()
        let didRevoke = await revoke.value
        XCTAssertFalse(didRevoke)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-revoke-cancel"])
        XCTAssertEqual(model.displayStatus(for: try XCTUnwrap(model.devices.first)), .confirming)
        XCTAssertEqual(model.deviceError, .deviceMutationOutcomeUnknown)
        let repeatedRevoke = await model.revokeDevice(id: "device-revoke-cancel")
        XCTAssertFalse(repeatedRevoke)

        await transport.enqueueData(json(revoked), method: "GET", path: "/v1/devices/device-revoke-cancel")
        let didConfirm = await model.confirmDeviceMutation(id: "device-revoke-cancel")
        XCTAssertTrue(didConfirm)
        XCTAssertEqual(model.devices.first?.displayStatus, .revoked)
        XCTAssertTrue(model.awaitingDeviceConfirmationIDs.isEmpty)
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "POST", "GET"])
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
    }

    func testOfflineRevokeRemainsUnknownWhenReadonlyCheckSeesOldState() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-revoke-offline", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()
        await transport.enqueueOffline(method: "POST", path: "/v1/devices/device-revoke-offline/revoke")

        let didRevoke = await model.revokeDevice(id: "device-revoke-offline")
        XCTAssertFalse(didRevoke)
        XCTAssertEqual(model.awaitingDeviceConfirmationIDs, ["device-revoke-offline"])
        await transport.enqueueData(json(original), method: "GET", path: "/v1/devices/device-revoke-offline")
        let didConfirm = await model.confirmDeviceMutation(id: "device-revoke-offline")
        XCTAssertFalse(didConfirm)
        XCTAssertEqual(model.displayStatus(for: try XCTUnwrap(model.devices.first)), .confirming)
        XCTAssertEqual(model.deviceError, .deviceMutationOutcomeUnknown)
        let repeatedRevoke = await model.revokeDevice(id: "device-revoke-offline")
        XCTAssertFalse(repeatedRevoke)

        let requests = await transport.requests()
        XCTAssertEqual(requests.filter { $0.method == "POST" }.count, 1)
        XCTAssertEqual(requests.map(\.method), ["GET", "POST", "GET"])
    }

    func testDeviceErrorCanBeClearedBeforeOpeningRenameAndNoOpRenameSendsNothing() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let original = deviceObject(id: "device-same-name", presence: "online", paired: true)
        await transport.enqueueData(json(["items": [original]]), method: "GET", path: "/v1/devices")
        await model.refreshDevices()

        let missingRename = await model.renameDevice(id: "missing-device", name: "New name")
        XCTAssertFalse(missingRename)
        XCTAssertNotNil(model.deviceError)
        model.clearDeviceError()
        XCTAssertNil(model.deviceError)
        let unchangedRename = await model.renameDevice(id: "device-same-name", name: "Synthetic device-same-name")
        XCTAssertFalse(unchangedRename)
        let requests = await transport.requests()
        XCTAssertEqual(requests.map(\.method), ["GET"])
    }

    func testOpeningThreadDrainsTurnPagesBeforeChoosingTheActiveTurn() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let completedTurns = (1...500).map { turnObject(id: "turn-\($0)", threadID: "thread-page", cursor: $0, state: "completed") }
        let newestActiveTurn = turnObject(id: "turn-501", threadID: "thread-page", cursor: 501, state: "running")

        await enqueueOpen(threadID: "thread-page", transport: transport, turnsPage: [
            (completedTurns, 500),
            ([newestActiveTurn], 501),
        ])
        await transport.enqueueJSON(
            ["items": [], "nextCursor": 0],
            method: "GET",
            path: "/v1/turns/turn-501/events"
        )
        await transport.enqueueJSON(turnsEnvelope([newestActiveTurn]), method: "GET", path: "/v1/turns/turn-501")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/actions")

        await model.openThread("thread-page")
        let didObserveActiveTurn = await eventually { model.currentTurn?.id == "turn-501" }
        XCTAssertTrue(didObserveActiveTurn)
        XCTAssertEqual(model.currentTurn?.state, .running)

        let turnRequests = await transport.requests(for: "/v1/threads/thread-page/turns")
        XCTAssertEqual(turnRequests.count, 2)
        XCTAssertEqual(queryValue("after", in: turnRequests[0].query), "0")
        XCTAssertEqual(queryValue("after", in: turnRequests[1].query), "500")
        XCTAssertTrue(turnRequests.allSatisfy { queryValue("limit", in: $0.query) == "500" })
        model.useFixture()
    }

    func testOpeningCompletedTurnFetchesMessagesAfterTheTerminalTurnSnapshot() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let threadID = "thread-open-race"
        var completedTurn = turnObject(id: "turn-open-race", threadID: threadID, cursor: 1, state: "completed")
        completedTurn["outputMessageId"] = "answer-final"
        completedTurn["outputChars"] = 16
        let emptyMessages = json(["items": [], "nextCursor": 0])
        let finalMessages = json(["items": [messageObject(id: "answer-final", threadID: threadID, content: "final answer")], "nextCursor": 1])

        await transport.enqueueTerminalAwareMessages(threadID: threadID, beforeTurnCompletion: emptyMessages, afterTurnCompletion: finalMessages)
        await transport.enqueueJSON(["items": [completedTurn], "nextCursor": 1], method: "GET", path: "/v1/threads/\(threadID)/turns")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/actions")

        await model.openThread(threadID)

        XCTAssertEqual(model.currentTurn?.state, .completed)
        XCTAssertEqual(model.messages.map(\.content), ["final answer"])
        let requests = await transport.requests()
        let turnRead = try XCTUnwrap(requests.firstIndex { $0.path == "/v1/threads/\(threadID)/turns" })
        let messageRead = try XCTUnwrap(requests.firstIndex { $0.path == "/v1/threads/\(threadID)/messages" })
        XCTAssertLessThan(turnRead, messageRead)
        model.useFixture()
    }

    func testLateThreadAResponseCannotReplaceSelectedThreadBOrItsTurn() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        // Turn control requires an online, validated host identity as well as the selected bot.
        let health: [String: Any] = ["protocolVersion": 1, "mode": "local-development", "engineRouting": "synthetic", "remotePairing": "not_implemented", "hostId": "late-thread-host", "state": [:]]
        await transport.enqueueJSON(health, method: "GET", path: "/health")
        await transport.enqueueJSON(["items": [["id": "bot-thread-b", "name": "B", "profileId": "profile", "engine": "claude", "ownerId": "owner", "createdAt": 1]]], method: "GET", path: "/v1/bots")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/actions")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/teams")
        await transport.enqueueJSON(["items": [["id": "thread-b", "botId": "bot-thread-b", "createdAt": 1]]], method: "GET", path: "/v1/bots/bot-thread-b/threads")
        await model.refresh()
        XCTAssertTrue(model.isOnline)
        XCTAssertEqual(model.selectedBotID, "bot-thread-b")
        await transport.enqueueJSON(["items": [], "nextCursor": 0], method: "GET", path: "/v1/threads/thread-a/turns")
        await transport.enqueueHold(method: "GET", path: "/v1/threads/thread-a/messages")
        await enqueueOpen(threadID: "thread-b", transport: transport, messages: [messageObject(id: "message-b", threadID: "thread-b", content: "B")], turnsPage: [
            ([turnObject(id: "turn-b", threadID: "thread-b", cursor: 1, state: "running")], 1),
        ])
        // Keep this test's unrelated polling read suspended until cancelCurrentTurn stops it.
        // Otherwise the finite response queue can manufacture an offline host between assertions.
        await transport.enqueueHold(method: "GET", path: "/v1/turns/turn-b/events")
        await transport.enqueueJSON(turnObject(id: "turn-b", threadID: "thread-b", cursor: 1, state: "running"), method: "GET", path: "/v1/turns/turn-b")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/actions")

        let openA = Task { await model.openThread("thread-a") }
        await transport.waitUntilSuspended(method: "GET", path: "/v1/threads/thread-a/messages")
        model.selectBot(id: "bot-thread-b")
        await model.openThread("thread-b")
        await transport.waitUntilSuspended(method: "GET", path: "/v1/turns/turn-b/events")
        await transport.release(
            method: "GET",
            path: "/v1/threads/thread-a/messages",
            data: json(["items": [messageObject(id: "message-a", threadID: "thread-a", content: "stale A")], "nextCursor": 1])
        )
        await openA.value

        XCTAssertEqual(model.selectedThreadID, "thread-b")
        XCTAssertEqual(model.messages.map(\.threadId), ["thread-b"])
        XCTAssertEqual(model.messages.first?.content, "B")
        XCTAssertEqual(model.currentTurn?.id, "turn-b")

        XCTAssertTrue(model.isOnline)
        XCTAssertNotNil(model.turnControlIdentity(in: "thread-b"))
        await transport.enqueueJSON(health, method: "GET", path: "/health")
        await model.cancelCurrentTurn(in: "thread-b")
        let cancelRequest = await transport.requests(for: "/v1/turns/turn-b/cancel")
        let allRequests = await transport.requests()
        XCTAssertEqual(cancelRequest.map(\.method), ["POST"])
        XCTAssertTrue(allRequests.allSatisfy { !$0.path.contains("turn-a/cancel") })
        model.useFixture()
    }

    func testHostReconfigurationInvalidatesAnInFlightPoll() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let runningTurn = turnObject(id: "turn-old-host", threadID: "thread-host", cursor: 1, state: "running")
        await enqueueOpen(threadID: "thread-host", transport: transport, turnsPage: [([runningTurn], 1)])
        await transport.enqueueHold(method: "GET", path: "/v1/turns/turn-old-host/events")

        await model.openThread("thread-host")
        await transport.waitUntilSuspended(method: "GET", path: "/v1/turns/turn-old-host/events")
        model.hostAddress = "http://localhost:4318"
        model.configureHost()
        await transport.release(
            method: "GET",
            path: "/v1/turns/turn-old-host/events",
            data: json(["items": [eventObject(cursor: 1, turnID: "turn-old-host", threadID: "thread-host", text: "stale")], "nextCursor": 1])
        )

        try await Task.sleep(for: .milliseconds(30))
        XCTAssertNil(model.currentTurn)
        XCTAssertEqual(model.streamingText, "")
        XCTAssertNil(model.selectedThreadID)
        XCTAssertEqual(model.hostAddress, "http://localhost:4318")
        model.useFixture()
    }

    func testTerminalPollDrainsEveryEventPageThenUsesPersistedAnswerOnce() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let threadID = "thread-terminal"
        let turnID = "turn-terminal"
        let runningTurn = turnObject(id: turnID, threadID: threadID, cursor: 1, state: "running")
        let completedTurn = turnObject(id: turnID, threadID: threadID, cursor: 1, state: "completed")
        let persistedAnswer = String(repeating: "x", count: 500) + String(repeating: "y", count: 100)
        await enqueueOpen(threadID: threadID, transport: transport, turnsPage: [([runningTurn], 1)])
        await transport.enqueueJSON(turnEvents(turnID: turnID, threadID: threadID, from: 1, count: 500, text: "x"), method: "GET", path: "/v1/turns/\(turnID)/events")
        await transport.enqueueJSON(turnEvents(turnID: turnID, threadID: threadID, from: 501, count: 100, text: "y"), method: "GET", path: "/v1/turns/\(turnID)/events")
        await transport.enqueueJSON(completedTurn, method: "GET", path: "/v1/turns/\(turnID)")
        await transport.enqueueJSON(completedTurn, method: "GET", path: "/v1/turns/\(turnID)")
        await transport.enqueueJSON(["error": "temporary", "message": "private action host detail"], status: 500, method: "GET", path: "/v1/actions")
        await transport.enqueueJSON(["items": [messageObject(id: "answer", threadID: threadID, content: persistedAnswer)], "nextCursor": 1], method: "GET", path: "/v1/threads/\(threadID)/messages")

        await model.openThread(threadID)
        let completed = await eventually {
            model.currentTurn?.state == .completed
                && model.streamingText.isEmpty
                && model.messages.contains(where: { $0.content == persistedAnswer })
        }
        XCTAssertTrue(completed)
        XCTAssertEqual(model.messages.filter { $0.role == .assistant }.map(\.content), [persistedAnswer])

        let eventRequests = await transport.requests(for: "/v1/turns/\(turnID)/events")
        XCTAssertEqual(eventRequests.count, 2)
        XCTAssertEqual(queryValue("after", in: eventRequests[0].query), "0")
        XCTAssertEqual(queryValue("after", in: eventRequests[1].query), "500")
        model.useFixture()
    }

    func testInterruptedPollDrainsLateEventsAfterTheShortTerminalSnapshot() async {
        await assertTerminalStateDrainsLateTail("interrupted", expected: .interrupted)
    }

    func testFailedPollDrainsLateEventsAfterTheShortTerminalSnapshot() async {
        await assertTerminalStateDrainsLateTail("failed", expected: .failed)
    }

    func testUnknownPollDrainsLateEventsAfterTheShortTerminalSnapshot() async {
        await assertTerminalStateDrainsLateTail("unknown", expected: .unknown)
    }

    func testDefinitive400DropsPendingIDAndKeepsOversizedDraftEditable() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        model.selectBot(id: "bot-thread-send")
        await enqueueOpen(threadID: "thread-send", transport: transport)
        await transport.enqueueJSON(["error": "invalid_request", "message": "private host detail"], status: 400, method: "POST", path: "/v1/threads/thread-send/turns")
        await transport.enqueueEchoingTurn(turnObject(id: "turn-corrected", threadID: "thread-send", cursor: 1, state: "queued"), method: "POST", path: "/v1/threads/thread-send/turns")

        await model.openThread("thread-send")
        let oversizedDraft = String(repeating: "q", count: 33_000)
        let firstAccepted = await model.submit(oversizedDraft)
        XCTAssertFalse(firstAccepted)
        XCTAssertNil(model.pendingSubmission)
        XCTAssertFalse(model.errorMessage?.contains("private host detail") ?? false)
        XCTAssertFalse(model.isSubmitting)

        let correctedAccepted = await model.submit("correção menor")
        XCTAssertTrue(correctedAccepted)
        XCTAssertNil(model.pendingSubmission)

        let requests = await transport.requests(for: "/v1/threads/thread-send/turns").filter { $0.method == "POST" }
        XCTAssertEqual(requests.count, 2)
        let bodies = try requests.map { try XCTUnwrap($0.body).jsonObject() }
        XCTAssertEqual((bodies[0]["content"] as? String)?.count, 33_000)
        XCTAssertEqual(bodies[1]["content"] as? String, "correção menor")
        XCTAssertNotEqual(bodies[0]["clientRequestId"] as? String, bodies[1]["clientRequestId"] as? String)
        model.useFixture()
    }

    func testAmbiguousFailureRetryReusesExactClientRequestIDAndBody() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        model.selectBot(id: "bot-thread-retry")
        await enqueueOpen(threadID: "thread-retry", transport: transport)
        await transport.enqueueOffline(method: "POST", path: "/v1/threads/thread-retry/turns")
        await transport.enqueueEchoingTurn(turnObject(id: "turn-retried", threadID: "thread-retry", cursor: 1, state: "queued"), method: "POST", path: "/v1/threads/thread-retry/turns")

        await model.openThread("thread-retry")
        let firstAccepted = await model.submit("same body")
        let retainedID = try XCTUnwrap(model.pendingSubmission?.clientRequestID)
        XCTAssertFalse(firstAccepted)
        XCTAssertTrue(model.errorMessage?.contains("Não foi possível conectar") ?? false)

        let retryAccepted = await model.retryPendingSubmission()
        XCTAssertTrue(retryAccepted)
        XCTAssertNil(model.pendingSubmission)
        let requests = await transport.requests(for: "/v1/threads/thread-retry/turns").filter { $0.method == "POST" }
        XCTAssertEqual(requests.count, 2)
        let bodies = try requests.map { try XCTUnwrap($0.body).jsonObject() }
        XCTAssertEqual(bodies[0]["clientRequestId"] as? String, retainedID)
        XCTAssertEqual(bodies[1]["clientRequestId"] as? String, retainedID)
        XCTAssertEqual(bodies[0]["content"] as? String, bodies[1]["content"] as? String)
        model.useFixture()
    }

    func testAcceptedTurnWithDifferentBotPreservesExactSubmissionForReconciliation() async throws {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        model.selectBot(id: "different-selected-bot")
        await enqueueOpen(threadID: "thread-correlation", transport: transport)
        await transport.enqueueEchoingTurn(turnObject(id: "turn-other-bot", threadID: "thread-correlation", cursor: 1, state: "queued"), method: "POST", path: "/v1/threads/thread-correlation/turns")

        await model.openThread("thread-correlation")
        let accepted = await model.submit("exact correlation body")
        XCTAssertFalse(accepted, "A host turn from a different bot cannot become this bot's accepted send")
        let pending = try XCTUnwrap(model.pendingSubmission)
        XCTAssertEqual(pending.content, "exact correlation body")
        let requests = await transport.requests(for: "/v1/threads/thread-correlation/turns").filter { $0.method == "POST" }
        XCTAssertEqual(requests.count, 1, "A correlation mismatch never retries or creates another send")
        let body = try XCTUnwrap(requests.first?.body).jsonObject()
        XCTAssertEqual(body["clientRequestId"] as? String, pending.clientRequestID)
        XCTAssertEqual(body["content"] as? String, pending.content)
        XCTAssertNil(model.currentTurn)
        model.useFixture()
    }

    func testLoopbackAndFixturePreferencesPersistButRemoteAddressDoesNot() throws {
        let storage = MemoryAppStateStorage()
        let transport = ScriptTransport()
        let model = makeModel(transport, storage: storage)

        model.hostAddress = "http://localhost:4318/"
        model.configureHost()
        XCTAssertEqual(model.hostAddress, "http://localhost:4318")
        XCTAssertFalse(model.isFixture)
        let locallyConfiguredSnapshot = try XCTUnwrap(storage.readData())
        let localState = try JSONDecoder().decode(DexterPersistedAppState.self, from: locallyConfiguredSnapshot)
        XCTAssertEqual(localState.mode, .loopback)
        XCTAssertEqual(localState.loopbackAddress, "http://localhost:4318")

        model.hostAddress = "https://dexter.example.test"
        model.configureHost()
        XCTAssertTrue(model.remotePairingPending)
        XCTAssertFalse(model.canUseHost)
        XCTAssertEqual(storage.readData(), locallyConfiguredSnapshot)
        XCTAssertFalse(String(decoding: locallyConfiguredSnapshot, as: UTF8.self).contains("dexter.example.test"))

        model.useFixture()
        let reloaded = DexterAppModel(storage: storage)
        XCTAssertTrue(reloaded.isFixture)
        XCTAssertEqual(reloaded.hostAddress, "http://localhost:4318")
        XCTAssertFalse(reloaded.canUseHost)
    }

    func testHostAccessIsEnabledOnlyForMacOrIOSSimulatorBuilds() throws {
        let fresh = DexterAppModel(storage: MemoryAppStateStorage())
        #if os(macOS) || targetEnvironment(simulator)
        XCTAssertFalse(fresh.isFixture)
        XCTAssertTrue(fresh.canUseHost)
        XCTAssertEqual(fresh.hostAddress, "http://127.0.0.1:4317")
        XCTAssertFalse(fresh.remotePairingPending)
        #else
        XCTAssertTrue(fresh.isFixture)
        XCTAssertFalse(fresh.canUseHost)
        XCTAssertFalse(fresh.remotePairingPending)
        #endif

        let savedStorage = MemoryAppStateStorage()
        let savedState = DexterPersistedAppState(
            version: DexterPersistedAppState.currentVersion,
            mode: .loopback,
            loopbackAddress: "http://127.0.0.1:4317",
            pendingRequests: []
        )
        savedStorage.writeData(try XCTUnwrap(DexterAppStateValidation.encode(savedState)))
        let restored = DexterAppModel(storage: savedStorage)
        #if os(macOS) || targetEnvironment(simulator)
        XCTAssertTrue(restored.canUseHost)
        XCTAssertFalse(restored.remotePairingPending)
        #else
        XCTAssertFalse(restored.canUseHost)
        XCTAssertTrue(restored.remotePairingPending)
        XCTAssertEqual(restored.backendLabel, "Loopback salvo · indisponível no iPhone físico")
        #endif
    }

    func testOnlyCredentialFreeRootLoopbackConfigurationIsStored() throws {
        let storage = MemoryAppStateStorage()
        let model = makeModel(ScriptTransport(), storage: storage)
        let rejectedAddresses = [
            "http://synthetic:password@127.0.0.1:4317",
            "http://127.0.0.1:4317/v1",
            "http://127.0.0.1:4317?token=synthetic",
            "http://192.0.2.44:4317",
        ]

        for address in rejectedAddresses {
            model.hostAddress = address
            model.configureHost()
            XCTAssertFalse(model.canUseHost, "Unexpectedly accepted \(address)")
            XCTAssertNil(storage.readData())
        }

        model.hostAddress = "http://[::1]:4317/"
        model.configureHost()
        XCTAssertTrue(model.canUseHost)
        XCTAssertEqual(model.hostAddress, "http://[::1]:4317")
        let state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(state.loopbackAddress, "http://[::1]:4317")
    }

    func testEditingAValidAddressDoesNotSilentlyRetargetTheConfiguredClient() async {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        model.hostAddress = "http://127.0.0.1:4318"

        XCTAssertFalse(model.canUseHost)
        await model.refresh()
        let requests = await transport.requests()
        XCTAssertTrue(requests.isEmpty)
    }

    func testPendingIDsRemainIndependentPerThread() async throws {
        let storage = MemoryAppStateStorage()
        let transport = ScriptTransport()
        let model = makeModel(transport, storage: storage)
        let threadA = "thread-pending-a"
        let threadB = "thread-pending-b"

        await enqueueOpen(threadID: threadA, transport: transport)
        await transport.enqueueOffline(method: "POST", path: "/v1/threads/\(threadA)/turns")
        await enqueueOpen(threadID: threadB, transport: transport)
        await transport.enqueueOffline(method: "POST", path: "/v1/threads/\(threadB)/turns")
        await enqueueOpen(threadID: threadA, transport: transport)

        await model.openThread(threadA)
        let acceptedA = await model.submit("message A")
        XCTAssertFalse(acceptedA)
        let idA = try XCTUnwrap(model.pendingSubmission?.clientRequestID)

        await model.openThread(threadB)
        let acceptedB = await model.submit("message B")
        XCTAssertFalse(acceptedB)
        let idB = try XCTUnwrap(model.pendingSubmission?.clientRequestID)
        XCTAssertNotEqual(idA, idB)

        let state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(Set(state.pendingRequests.map(\.threadID)), [threadA, threadB])
        XCTAssertEqual(Set(state.pendingRequests.map(\.clientRequestID)), [idA, idB])

        await model.openThread(threadA)
        XCTAssertEqual(model.pendingSubmission?.threadID, threadA)
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, idA)
        XCTAssertTrue(model.pendingSubmission?.needsTextEntry == true)
    }

    func testRecoveredPendingIDRequiresSameTextSurvivesDefinitiveErrorAndClearsFromHostTurn() async throws {
        let threadID = "thread-persistent-retry"
        let hostAddress = "http://127.0.0.1:4317"
        let content = "frase sintética recovery 8c73e5"
        let storage = MemoryAppStateStorage()

        let firstTransport = ScriptTransport()
        await enqueueOpen(threadID: threadID, transport: firstTransport)
        await firstTransport.enqueueOffline(method: "POST", path: "/v1/threads/\(threadID)/turns")
        let firstModel = makeModel(firstTransport, storage: storage)
        await firstModel.openThread(threadID)
        let initialAccepted = await firstModel.submit(content)
        XCTAssertFalse(initialAccepted)
        let originalID = try XCTUnwrap(firstModel.pendingSubmission?.clientRequestID)

        let rawState = try XCTUnwrap(storage.readData())
        let persisted = try JSONDecoder().decode(DexterPersistedAppState.self, from: rawState)
        let firstRecord = try XCTUnwrap(persisted.pendingRequests.first)
        XCTAssertEqual(firstRecord.hostAddress, hostAddress)
        XCTAssertEqual(firstRecord.threadID, threadID)
        XCTAssertEqual(firstRecord.clientRequestID, originalID)
        XCTAssertEqual(firstRecord.contentDigest, DexterAppStateValidation.contentDigest(content))
        XCTAssertFalse(String(decoding: rawState, as: UTF8.self).contains(content))

        let secondTransport = ScriptTransport()
        await enqueueOpen(threadID: threadID, transport: secondTransport)
        await secondTransport.enqueueJSON(["error": "invalid_request", "message": "private synthetic detail"], status: 400, method: "POST", path: "/v1/threads/\(threadID)/turns")
        await secondTransport.enqueueOffline(method: "POST", path: "/v1/threads/\(threadID)/turns")
        let secondModel = makeModel(secondTransport, storage: storage)
        await secondModel.openThread(threadID)

        let recovered = try XCTUnwrap(secondModel.pendingSubmission)
        XCTAssertTrue(recovered.needsTextEntry)
        XCTAssertTrue(recovered.isRecovered)
        XCTAssertNil(recovered.content)
        XCTAssertEqual(recovered.clientRequestID, originalID)

        let changedTextAccepted = await secondModel.submit("texto diferente e sintético")
        XCTAssertFalse(changedTextAccepted)
        XCTAssertEqual(secondModel.pendingSubmission?.clientRequestID, originalID)
        let requestsAfterChangedText = await secondTransport.requests(for: "/v1/threads/\(threadID)/turns").filter { $0.method == "POST" }
        XCTAssertTrue(requestsAfterChangedText.isEmpty)

        let rejectedRecoveredAttempt = await secondModel.submit(content)
        XCTAssertFalse(rejectedRecoveredAttempt)
        XCTAssertEqual(secondModel.pendingSubmission?.clientRequestID, originalID)
        XCTAssertTrue(secondModel.pendingSubmission?.isRecovered == true)
        XCTAssertFalse(secondModel.errorMessage?.contains("private synthetic detail") ?? false)
        let ambiguousRecoveredAttempt = await secondModel.submit(content)
        XCTAssertFalse(ambiguousRecoveredAttempt)

        let retryRequests = await secondTransport.requests(for: "/v1/threads/\(threadID)/turns").filter { $0.method == "POST" }
        XCTAssertEqual(retryRequests.count, 2)
        let retryBodies = try retryRequests.map { try XCTUnwrap($0.body).jsonObject() }
        XCTAssertEqual(retryBodies.compactMap { $0["clientRequestId"] as? String }, [originalID, originalID])
        XCTAssertEqual(retryBodies.compactMap { $0["content"] as? String }, [content, content])

        var acceptedTurn = turnObject(id: "turn-persistent-retry", threadID: threadID, cursor: 1, state: "completed")
        acceptedTurn["clientRequestId"] = originalID
        let thirdTransport = ScriptTransport()
        await enqueueOpen(threadID: threadID, transport: thirdTransport, turnsPage: [([acceptedTurn], 1)])
        let thirdModel = makeModel(thirdTransport, storage: storage)
        await thirdModel.openThread(threadID)

        XCTAssertNil(thirdModel.pendingSubmission)
        let clearedState = try JSONDecoder().decode(
            DexterPersistedAppState.self,
            from: try XCTUnwrap(storage.readData())
        )
        XCTAssertFalse(clearedState.pendingRequests.contains { $0.clientRequestID == originalID })
        let thirdPostRequests = await thirdTransport.requests(for: "/v1/threads/\(threadID)/turns").filter { $0.method == "POST" }
        XCTAssertTrue(thirdPostRequests.isEmpty)
    }

    func testCorruptStateIsPreservedUntilExplicitConfirmedReset() throws {
        let storage = MemoryAppStateStorage()
        let corruptData = Data([0x7b, 0x22, 0xff, 0x00, 0x7d])
        storage.writeData(corruptData)

        let model = DexterAppModel(storage: storage)
        XCTAssertTrue(model.isFixture)
        XCTAssertFalse(model.canUseHost)
        XCTAssertTrue(model.requiresStorageReset)
        XCTAssertEqual(storage.readData(), corruptData)

        model.hostAddress = "http://127.0.0.1:4317"
        model.configureHost()
        XCTAssertTrue(model.isFixture)
        XCTAssertEqual(storage.readData(), corruptData)

        XCTAssertTrue(model.resetCorruptStorage())
        XCTAssertFalse(model.requiresStorageReset)
        XCTAssertNil(model.persistenceNotice)
        XCTAssertNotEqual(storage.readData(), corruptData)
        let reset = try JSONDecoder().decode(DexterPersistedAppState.self, from: try XCTUnwrap(storage.readData()))
        XCTAssertEqual(reset.mode, .fixture)
        XCTAssertTrue(reset.pendingRequests.isEmpty)

        let unsupportedData = try JSONEncoder().encode(DexterPersistedAppState(
            version: 77,
            mode: .fixture,
            loopbackAddress: nil,
            pendingRequests: []
        ))
        storage.writeData(unsupportedData)
        let unsupportedModel = DexterAppModel(storage: storage)
        XCTAssertTrue(unsupportedModel.isFixture)
        XCTAssertTrue(unsupportedModel.requiresStorageReset)
        XCTAssertEqual(storage.readData(), unsupportedData)
        XCTAssertTrue(unsupportedModel.resetCorruptStorage())
    }

    func testUserDefaultsStorageAdapterSharesDataAcrossInstances() throws {
        let suiteName = "com.dexter.apple.persistence-tests.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Expected an isolated UserDefaults suite")
            return
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = UserDefaultsDexterAppStateStorage(defaults: defaults, key: "test-state")
        let second = UserDefaultsDexterAppStateStorage(defaults: defaults, key: "test-state")
        let data = Data("fixture-only".utf8)
        first.writeData(data)
        XCTAssertEqual(second.readData(), data)
        second.removeData()
        XCTAssertNil(first.readData())
    }

    func testAmbiguousOfflineThen400KeepsOriginalIDInSameAndNewInstance() async throws {
        let storage = MemoryAppStateStorage(), transport = ScriptTransport()
        let model = makeModel(transport, storage: storage), thread = "thread-ambiguous-400"
        await enqueueOpen(threadID: thread, transport: transport)
        await transport.enqueueOffline(method: "POST", path: "/v1/threads/\(thread)/turns")
        await transport.enqueueJSON(["error": "invalid_request"], status: 400, method: "POST", path: "/v1/threads/\(thread)/turns")
        await model.openThread(thread)
        let first = await model.submit("synthetic review text")
        XCTAssertFalse(first)
        let original = try XCTUnwrap(model.pendingSubmission?.clientRequestID)
        let retried = await model.retryPendingSubmission()
        XCTAssertFalse(retried)
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, original, "A 400 after an ambiguous attempt proves nothing")
        var state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(state.pendingRequests.map(\.clientRequestID), [original])

        // A different text must not mint a new ID while the original is unconfirmed.
        let other = await model.submit("different text")
        XCTAssertFalse(other)
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, original)

        let transport2 = ScriptTransport()
        let relaunched = makeModel(transport2, storage: storage)
        await enqueueOpen(threadID: thread, transport: transport2)
        await relaunched.openThread(thread)
        XCTAssertEqual(relaunched.pendingSubmission?.clientRequestID, original)
        XCTAssertTrue(relaunched.pendingSubmission?.needsTextEntry == true)
        state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(state.pendingRequests.map(\.clientRequestID), [original])
        model.useFixture()
        relaunched.useFixture()
    }

    func testCancelledPostThen400KeepsOriginalIDAcrossRetryReopenAndWrongText() async throws {
        let storage = MemoryAppStateStorage(), transport = ScriptTransport()
        let model = makeModel(transport, storage: storage), thread = "thread-cancel-400"
        await enqueueOpen(threadID: thread, transport: transport)
        await transport.enqueueCancelled(method: "POST", path: "/v1/threads/\(thread)/turns")
        await transport.enqueueJSON(["error": "invalid_request"], status: 400, method: "POST", path: "/v1/threads/\(thread)/turns")
        await model.openThread(thread)
        let first = await model.submit("synthetic cancel text")
        XCTAssertFalse(first)
        let original = try XCTUnwrap(model.pendingSubmission?.clientRequestID, "Cancellation must keep the ID")
        let retried = await model.retryPendingSubmission()
        XCTAssertFalse(retried)
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, original, "A 400 after a cancelled POST proves nothing")
        var state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(state.pendingRequests.map(\.clientRequestID), [original])

        let other = await model.submit("different text")
        XCTAssertFalse(other)
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, original)

        let transport2 = ScriptTransport()
        let relaunched = makeModel(transport2, storage: storage)
        await enqueueOpen(threadID: thread, transport: transport2)
        await relaunched.openThread(thread)
        XCTAssertEqual(relaunched.pendingSubmission?.clientRequestID, original)
        let wrong = await relaunched.submit("wrong manual text")
        XCTAssertFalse(wrong)
        XCTAssertEqual(relaunched.pendingSubmission?.clientRequestID, original)
        state = try JSONDecoder().decode(DexterPersistedAppState.self, from: XCTUnwrap(storage.readData()))
        XCTAssertEqual(state.pendingRequests.map(\.clientRequestID), [original])
        model.useFixture()
        relaunched.useFixture()
    }

    func testWrongTypedUserDefaultsSnapshotIsPreservedUntilExplicitReset() throws {
        let suiteName = "com.dexter.apple.tests.wrong-type.\(UUID().uuidString)", key = "isolated-test-state"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("legacy-unreadable-pending-ID", forKey: key)
        let storage = UserDefaultsDexterAppStateStorage(defaults: defaults, key: key)
        let model = DexterAppModel(storage: storage)
        XCTAssertTrue(model.requiresStorageReset, "An existing wrongly typed value is not an absent value")
        XCTAssertTrue(model.isFixture)
        model.hostAddress = "http://127.0.0.1:4317"
        model.configureHost()
        model.useFixture()
        XCTAssertEqual(defaults.string(forKey: key), "legacy-unreadable-pending-ID")
        XCTAssertTrue(model.resetCorruptStorage())
        XCTAssertFalse(model.requiresStorageReset)
        XCTAssertNotNil(defaults.data(forKey: key))
    }

    func testMissingUserDefaultsValueIsNotCorrupt() throws {
        let suiteName = "com.dexter.apple.tests.missing.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let model = DexterAppModel(storage: UserDefaultsDexterAppStateStorage(defaults: defaults, key: "absent"))
        XCTAssertFalse(model.requiresStorageReset)
    }

    func testOptimisticOutgoingAppearsBeforeHeldAckAndDeduplicatesCanonicalInput() async throws {
        let transport = ScriptTransport(), model = makeModel(transport)
        let thread = "thread-optimistic", post = "/v1/threads/thread-optimistic/turns", messagePath = "/v1/threads/thread-optimistic/messages"
        model.selectBot(id: "bot-thread-optimistic")
        await enqueueOpen(threadID: thread, transport: transport)
        await transport.enqueueHold(method: "POST", path: post)
        await transport.enqueueHold(method: "GET", path: messagePath)
        await model.openThread(thread)
        let sending = Task { await model.submit("  exact synthetic draft  ") }
        await transport.waitUntilSuspended(method: "POST", path: post)
        let preview = try XCTUnwrap(model.outgoingMessagePreviewForActiveThread)
        XCTAssertEqual(preview.content, "  exact synthetic draft  ")
        XCTAssertEqual(preview.state, .sending)
        XCTAssertTrue(model.messages.isEmpty)
        let duplicate = await model.submit("second message")
        XCTAssertFalse(duplicate)
        let posts = await transport.requests(for: post).filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 1)
        var turn = turnObject(id: "optimistic-turn", threadID: thread, cursor: 1, state: "running")
        turn["clientRequestId"] = preview.clientRequestID
        await transport.release(method: "POST", path: post, data: json(turn), status: 201)
        let accepted = await sending.value
        XCTAssertTrue(accepted)
        await transport.waitUntilSuspended(method: "GET", path: messagePath)
        XCTAssertEqual(model.outgoingMessagePreviewForActiveThread?.state, .accepted, "Ack retains preview until canonical input is visible")
        var input = messageObject(id: "input-optimistic-turn", threadID: thread, content: "exact synthetic draft")
        input["role"] = "user"
        await transport.release(method: "GET", path: messagePath, data: json(["items": [input], "nextCursor": 1]))
        let reconciled = await eventually { model.outgoingMessagePreviewForActiveThread == nil && model.messages.count == 1 }
        XCTAssertTrue(reconciled)
        XCTAssertEqual(model.messages.first?.id, "input-optimistic-turn")
        model.useFixture()
    }

    func testOptimisticOutgoingUncertainRetryKeepsExactDraftAndScopesLateAck() async throws {
        let transport = ScriptTransport(), model = makeModel(transport)
        let thread = "thread-optimistic-a", post = "/v1/threads/thread-optimistic-a/turns"
        await enqueueOpen(threadID: thread, transport: transport)
        await transport.enqueueOffline(method: "POST", path: post)
        await transport.enqueueHold(method: "POST", path: post)
        await model.openThread(thread)
        let first = await model.submit("  exact uncertain draft  ")
        XCTAssertFalse(first)
        let uncertain = try XCTUnwrap(model.outgoingMessagePreviewForActiveThread)
        XCTAssertEqual(uncertain.state, .uncertain)
        XCTAssertEqual(uncertain.content, "  exact uncertain draft  ")
        XCTAssertEqual(model.pendingSubmission?.clientRequestID, uncertain.clientRequestID)
        let retry = Task { await model.retryPendingSubmission() }
        await transport.waitUntilSuspended(method: "POST", path: post)
        XCTAssertEqual(model.outgoingMessagePreviewForActiveThread?.content, uncertain.content)
        let posts = await transport.requests(for: post).filter { $0.method == "POST" }
        XCTAssertEqual(posts.count, 2)
        let bodies = try posts.map { try XCTUnwrap($0.body).jsonObject() }
        XCTAssertEqual(bodies[0]["clientRequestId"] as? String, bodies[1]["clientRequestId"] as? String)
        XCTAssertEqual(bodies[0]["content"] as? String, bodies[1]["content"] as? String)
        await enqueueOpen(threadID: "thread-optimistic-b", transport: transport)
        await model.openThread("thread-optimistic-b")
        XCTAssertNil(model.outgoingMessagePreviewForActiveThread)
        var turn = turnObject(id: "late-optimistic", threadID: thread, cursor: 1, state: "queued")
        turn["clientRequestId"] = uncertain.clientRequestID
        await transport.release(method: "POST", path: post, data: json(turn), status: 201)
        _ = await retry.value
        XCTAssertEqual(model.selectedThreadID, "thread-optimistic-b")
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.outgoingMessagePreviewForActiveThread)
        model.useFixture()
        XCTAssertNil(model.outgoingMessagePreview)
    }

    private func makeModel(
        _ transport: ScriptTransport,
        storage: (any DexterAppStateStorage)? = nil
    ) -> DexterAppModel {
        let client = HostClient(baseURL: URL(string: "http://127.0.0.1:4317")!, transport: transport)
        return DexterAppModel(client: client, storage: storage ?? MemoryAppStateStorage())
    }

    private func assertTerminalStateDrainsLateTail(_ rawState: String, expected: TurnState) async {
        let transport = ScriptTransport()
        let model = makeModel(transport)
        let threadID = "thread-\(rawState)"
        let turnID = "turn-\(rawState)"
        let runningTurn = turnObject(id: turnID, threadID: threadID, cursor: 1, state: "running")
        let terminalTurn = turnObject(id: turnID, threadID: threadID, cursor: 1, state: rawState)
        await enqueueOpen(threadID: threadID, transport: transport, turnsPage: [([runningTurn], 1)])
        await transport.enqueueJSON(turnEvents(turnID: turnID, threadID: threadID, from: 1, count: 1, text: "before"), method: "GET", path: "/v1/turns/\(turnID)/events")
        await transport.enqueueJSON(turnEvents(turnID: turnID, threadID: threadID, from: 2, count: 1, text: "tail"), method: "GET", path: "/v1/turns/\(turnID)/events")
        await transport.enqueueJSON(terminalTurn, method: "GET", path: "/v1/turns/\(turnID)")
        await transport.enqueueJSON(terminalTurn, method: "GET", path: "/v1/turns/\(turnID)")
        await transport.enqueueJSON(["items": []], method: "GET", path: "/v1/actions")
        await transport.enqueueJSON(["items": [], "nextCursor": 0], method: "GET", path: "/v1/threads/\(threadID)/messages")

        await model.openThread(threadID)
        let drained = await eventually {
            let messageRequests = await transport.requests(for: "/v1/threads/\(threadID)/messages")
            return model.currentTurn?.state == expected
                && model.streamingText == "beforetail"
                && !model.isTurnGenerating
                && model.messages.isEmpty
                && messageRequests.count == 2
        }
        XCTAssertTrue(drained, "Expected the late event tail to be visible for terminal state \(rawState)")

        let eventRequests = await transport.requests(for: "/v1/turns/\(turnID)/events")
        XCTAssertEqual(eventRequests.count, 2)
        XCTAssertEqual(queryValue("after", in: eventRequests.first?.query ?? ""), "0")
        XCTAssertEqual(queryValue("after", in: eventRequests.last?.query ?? ""), "1")
        XCTAssertFalse(model.isTurnGenerating, "A terminal turn must stop rendering a busy spinner")
        model.useFixture()
    }

    private func enqueueOpen(
        threadID: String,
        transport: ScriptTransport,
        messages: [[String: Any]] = [],
        turnsPage: [([[String: Any]], Int64)] = [],
        actions: [[String: Any]] = []
    ) async {
        let messageCursor = messages.compactMap { $0["cursor"] as? Int64 }.max() ?? 0
        await transport.enqueueJSON(["items": messages, "nextCursor": messageCursor], method: "GET", path: "/v1/threads/\(threadID)/messages")
        if turnsPage.isEmpty {
            await transport.enqueueJSON(["items": [], "nextCursor": 0], method: "GET", path: "/v1/threads/\(threadID)/turns")
        } else {
            for (items, nextCursor) in turnsPage {
                await transport.enqueueJSON(["items": items, "nextCursor": nextCursor], method: "GET", path: "/v1/threads/\(threadID)/turns")
            }
        }
        await transport.enqueueJSON(["items": actions], method: "GET", path: "/v1/actions")
    }

    private func turnObject(id: String, threadID: String, cursor: Int, state: String) -> [String: Any] {
        [
            "cursor": cursor,
            "id": id,
            "threadId": threadID,
            "botId": "bot-\(threadID)",
            "engine": "claude",
            "clientRequestId": "request-\(id)",
            "inputMessageId": "input-\(id)",
            "outputMessageId": NSNull(),
            "state": state,
            "code": NSNull(),
            "outputChars": 0,
            "outputTruncated": false,
            "createdAt": 1_791_331_200_000,
            "startedAt": state == "running" || state == "completed" ? 1_791_331_200_001 : NSNull(),
            "finishedAt": state == "completed" ? 1_791_331_200_002 : NSNull(),
            "updatedAt": 1_791_331_200_002,
        ]
    }

    private func deviceObject(
        id: String,
        presence: String,
        paired: Bool,
        revokedAt: Int64? = nil
    ) -> [String: Any] {
        [
            "id": id,
            "ownerId": "synthetic-owner",
            "name": "Synthetic \(id)",
            "platform": "macos",
            "capabilities": ["browser.open"],
            "lastSeenAt": 1_791_331_200_000,
            "revokedAt": revokedAt as Any? ?? NSNull(),
            "presence": presence,
            "paired": paired,
        ]
    }

    private func messageObject(id: String, threadID: String, content: String) -> [String: Any] {
        [
            "cursor": 1,
            "id": id,
            "threadId": threadID,
            "clientMessageId": "client-\(id)",
            "role": "assistant",
            "content": content,
            "createdAt": 1_791_331_200_002,
        ]
    }

    private func eventObject(cursor: Int, turnID: String, threadID: String, text: String) -> [String: Any] {
        [
            "cursor": cursor,
            "turnId": turnID,
            "threadId": threadID,
            "kind": "text.delta",
            "text": text,
            "data": NSNull(),
            "createdAt": 1_791_331_200_002,
        ]
    }

    private func turnEvents(turnID: String, threadID: String, from start: Int, count: Int, text: String) -> [String: Any] {
        let items = (start..<(start + count)).map { eventObject(cursor: $0, turnID: turnID, threadID: threadID, text: text) }
        return ["items": items, "nextCursor": start + count - 1]
    }

    private func turnsEnvelope(_ items: [[String: Any]]) -> [String: Any] {
        ["items": items, "nextCursor": items.compactMap { $0["cursor"] as? Int64 }.max() ?? 0]
    }

    private func eventually(_ predicate: () async -> Bool) async -> Bool {
        for _ in 0..<300 {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await predicate()
    }

    private func queryValue(_ name: String, in query: String) -> String? {
        URLComponents(string: "http://localhost/?\(query)")?.queryItems?.first { $0.name == name }?.value
    }

    private func json(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
    }
}

private struct RequestSnapshot: Sendable {
    let method: String
    let path: String
    let query: String
    let body: Data?
}

@MainActor
private final class MemoryAppStateStorage: DexterAppStateStorage {
    private(set) var data: Data?

    func readData() -> Data? { data }
    func writeData(_ data: Data) { self.data = data }
    func removeData() { data = nil }
}

private actor ScriptTransport: HTTPTransport {
    private enum Outcome: Sendable {
        case response(Int, Data)
        case terminalAwareMessages(String, Data, Data)
        case offline
        case cancelled
        case hold
    }

    private var outcomes: [String: [Outcome]] = [:]
    private var captured: [RequestSnapshot] = []
    private var suspended: [String: CheckedContinuation<TransportResponse, Error>] = [:]
    private var arrivalWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var terminalThreads: Set<String> = []

    @MainActor func enqueueJSON(_ value: Any, status: Int = 200, method: String, path: String) async {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        await enqueueData(data, status: status, method: method, path: path)
    }

    func enqueueData(_ data: Data, status: Int = 200, method: String, path: String) {
        enqueue(.response(status, data), method: method, path: path)
    }

    @MainActor func enqueueEchoingTurn(_ value: [String: Any], method: String, path: String) async {
        var response = value
        response["clientRequestId"] = "$request-id"
        let data = try! JSONSerialization.data(withJSONObject: response, options: [.fragmentsAllowed])
        await enqueueData(data,status:201,method:method,path:path)
    }

    func enqueueOffline(method: String, path: String) {
        enqueue(.offline, method: method, path: path)
    }

    func enqueueCancelled(method: String, path: String) {
        enqueue(.cancelled, method: method, path: path)
    }

    func enqueueHold(method: String, path: String) {
        enqueue(.hold, method: method, path: path)
    }

    func enqueueTerminalAwareMessages(threadID: String, beforeTurnCompletion: Data, afterTurnCompletion: Data) {
        enqueue(
            .terminalAwareMessages(threadID, beforeTurnCompletion, afterTurnCompletion),
            method: "GET",
            path: "/v1/threads/\(threadID)/messages"
        )
    }

    func requests() -> [RequestSnapshot] { captured }

    func requests(for path: String) -> [RequestSnapshot] {
        captured.filter { $0.path == path }
    }

    func waitUntilSuspended(method: String, path: String) async {
        let key = Self.key(method: method, path: path)
        if suspended[key] != nil { return }
        await withCheckedContinuation { continuation in
            arrivalWaiters[key, default: []].append(continuation)
        }
    }

    func release(method: String, path: String, data: Data, status: Int = 200) {
        let key = Self.key(method: method, path: path)
        suspended.removeValue(forKey: key)?.resume(returning: TransportResponse(statusCode: status, data: data))
    }

    func send(_ request: URLRequest) async throws -> TransportResponse {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let key = Self.key(method: method, path: path)
        captured.append(RequestSnapshot(method: method, path: path, query: request.url?.query ?? "", body: request.httpBody))
        guard var queue = outcomes[key], !queue.isEmpty else { throw URLError(.cannotConnectToHost) }
        let outcome = queue.removeFirst()
        outcomes[key] = queue

        switch outcome {
        case .response(let status, let data):
            let responseData = echoRequestIDIfNeeded(in: data, request: request)
            noteTerminalTurnIfNeeded(responseData, path: path)
            return TransportResponse(statusCode: status, data: responseData)
        case .terminalAwareMessages(let threadID, let beforeCompletion, let afterCompletion):
            let data = terminalThreads.contains(threadID) ? afterCompletion : beforeCompletion
            return TransportResponse(statusCode: 200, data: data)
        case .offline:
            throw URLError(.networkConnectionLost)
        case .cancelled:
            throw CancellationError()
        case .hold:
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<TransportResponse, Error>) in
                    suspended[key] = continuation
                    let waiters = arrivalWaiters.removeValue(forKey: key) ?? []
                    waiters.forEach { $0.resume() }
                }
            } onCancel: {
                Task { await self.cancelSuspended(key) }
            }
        }
    }

    private func enqueue(_ outcome: Outcome, method: String, path: String) {
        outcomes[Self.key(method: method, path: path), default: []].append(outcome)
    }

    private func cancelSuspended(_ key: String) {
        suspended.removeValue(forKey: key)?.resume(throwing: CancellationError())
        let waiters = arrivalWaiters.removeValue(forKey: key) ?? []
        waiters.forEach { $0.resume() }
    }

    private func noteTerminalTurnIfNeeded(_ data: Data, path: String) {
        let components = path.split(separator: "/")
        guard components.count == 4,
              components[0] == "v1",
              components[1] == "threads",
              components[3] == "turns",
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = object["items"] as? [[String: Any]],
              items.contains(where: { $0["state"] as? String == "completed" }) else { return }
        terminalThreads.insert(String(components[2]))
    }

    private func echoRequestIDIfNeeded(in data: Data, request: URLRequest) -> Data {
        guard let requestBody = request.httpBody,
              let requestObject = try? JSONSerialization.jsonObject(with: requestBody) as? [String: Any],
              let requestID = requestObject["clientRequestId"] as? String,
              var responseObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              responseObject["clientRequestId"] as? String == "$request-id" else {
            return data
        }
        responseObject["clientRequestId"] = requestID
        return (try? JSONSerialization.data(withJSONObject: responseObject, options: [.fragmentsAllowed])) ?? data
    }

    private static func key(method: String, path: String) -> String {
        "\(method.uppercased()) \(path)"
    }
}

private extension Data {
    func jsonObject() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: self) as? [String: Any])
    }
}
