import Foundation
import XCTest
@testable import DexterAppCore
@testable import DexterHostClient
@testable import DexterClientIdentity

@MainActor final class ActualPairedHostFixture {
    let root: URL, process: Process, input: Pipe, output: Pipe
    var bundle: Data
    init() throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], let composition = ProcessInfo.processInfo.environment["DEXTER_REAL_HOST_COMPOSITION"], composition.hasPrefix("/private/tmp/") else { throw ClientIdentityFailure.invalidInput }
        root = URL(fileURLWithPath:"/private/tmp").appendingPathComponent("dexter-apple-actual-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        process = Process(); input = Pipe(); output = Pipe(); bundle = Data()
        let script = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/actual-host.mjs")
        process.executableURL = URL(fileURLWithPath:node); process.arguments = [script.path,root.path,composition]; process.environment = [:]; process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        do { try process.run(); let initial = try read(); guard let value = initial["bundle"] as? [String:Any] else { throw ClientIdentityFailure.protocolError }; bundle = try JSONSerialization.data(withJSONObject:value) }
        catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; try? FileManager.default.removeItem(at:root); throw error }
    }
    func read() throws -> [String:Any] {
        var data = Data(); while data.count < 32768 { guard let byte = try output.fileHandleForReading.read(upToCount:1), !byte.isEmpty else { throw ClientIdentityFailure.unavailable }; if byte.first == 10 { break }; data.append(byte) }
        guard let object = try JSONSerialization.jsonObject(with:data) as? [String:Any], object["fixtureError"] == nil else { throw ClientIdentityFailure.protocolError }; return object
    }
    func command(_ op: String, values: [String:String] = [:]) throws -> [String:Any] {
        var value = values; value["op"] = op; var data = try JSONSerialization.data(withJSONObject:value); data.append(10); try input.fileHandleForWriting.write(contentsOf:data); return try read()
    }
    func finish() throws {
        let stopped = try command("stop"); XCTAssertEqual(stopped["writerReleased"] as? Bool,true); process.waitUntilExit(); XCTAssertFalse(process.isRunning); XCTAssertEqual(process.terminationStatus,0)
    }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() }; XCTAssertFalse(process.isRunning); try? FileManager.default.removeItem(at:root) }
}
struct LostJournalACK: PairedClientClaimJournal {
    func assertNoUnknownClaim(installationID: String, role: ClientRole) throws { try file.assertNoUnknownClaim(installationID:installationID,role:role) }
    let file: FileClientClaimJournal
    func loadOnly(scope: ClientIdentityScope) async throws -> ClientClaimJournalEntry? { try await file.loadOnly(scope:scope) }
    func reserve(_ reservation: ClientClaimReservation) async throws { try await file.reserve(reservation) }
    func saveAcknowledgement(_ reservation: ClientClaimReservation, claimID: String) async throws { throw ClientIdentityFailure.unavailable }
}

@MainActor final class ActualPairedHostTests: XCTestCase {
    func testRealSDKNativeTLSHostServicesCanonicalStoreRestartExpiryAndSelfRevoke() async throws {
        let fixture = try ActualPairedHostFixture(); defer { fixture.close() }
        let identity = try ClientNativeIdentity.ephemeralFixture(), keys = PairIdentityMemory(preferred:identity), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys})
        do { try onboarding.importBundle(fixture.bundle) } catch {
            if let failure = error as? ClientIdentityFailure { XCTFail("bundle import failure: \(failure)") } else { XCTFail("bundle import typed unexpected error") }; return
        }; fixture.bundle.removeAll(); await onboarding.provisionIdentity(); await onboarding.claim(name:"Synthetic Native Mac")
        XCTAssertEqual(onboarding.state,.pendingApproval); let claimID = try XCTUnwrap(onboarding.publicReference?.claimID)
        let approved = try fixture.command("approve",values:["claimID":claimID]), deviceID = try XCTUnwrap(approved["deviceId"] as? String)
        let appModel = DexterAppModel(storage:PairedAppStateMemory(),pairing:onboarding); await appModel.connectPairedHost(); XCTAssertEqual(onboarding.state,.paired); XCTAssertTrue(appModel.canUseHost)
        let client = try XCTUnwrap(onboarding.activeClient); _ = try await client.health(); try await client.presence()
        let bot = try await client.createBot(.init(name:"Synthetic",profileId:"synthetic_profile",engine:.codex)), thread = try await client.createThread(botID:bot.id)
        let message = try await client.appendMessage(threadID:thread.id,input:.init(clientMessageId:"synthetic_message",content:"Synthetic direct message")); XCTAssertEqual(message.threadId,thread.id)
        let submission = TurnSubmission(content:"Synthetic turn",clientRequestId:"synthetic_turn"), turn = try await client.startTurn(threadID:thread.id,submission:submission)
        _ = try fixture.command("wait",values:["turnID":turn.id]); let finished = try await client.getTurn(id:turn.id); XCTAssertEqual(finished.state,.completed)
        let page = try await client.listMessages(threadID:thread.id,after:0,limit:1); XCTAssertEqual(page.items.count,1); XCTAssertEqual(page.nextCursor,page.items.last?.cursor)
        let all = try await client.listMessages(threadID:thread.id); XCTAssertTrue(all.items.contains(where:{$0.content == "Synthetic reply"}))
        _ = try fixture.command("action",values:["botID":bot.id,"threadID":thread.id])
        let approvals = try await client.listActions(), action = try XCTUnwrap(approvals.first); XCTAssertEqual(action.state,.awaitingApproval)
        let altered = Action(id:action.id,request:action.request,requestHash:String(repeating:"a",count:64),grantRevision:action.grantRevision,state:action.state,createdAt:action.createdAt,updatedAt:action.updatedAt,approvalExpiresAt:action.approvalExpiresAt,decidedBy:action.decidedBy,result:action.result,reason:action.reason)
        do { _ = try await client.decide(action:altered,decision:.deny); XCTFail("changed approval hash admitted") } catch { XCTAssertEqual(error as? HostClientError,.conflict) }
        let display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.destination, "conn-A")
        let expectedArguments: [String: JSONValue] = ["fixture": .bool(true), "accountId": .string("personal"),
            "payload": .object(["text": .string("  ação \"quoted\"\n "), "items": .array([.integer(1), .bool(false), .null, .object(["destination": .string("nested-only")])])])]
        XCTAssertEqual(display.arguments, expectedArguments)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(display.formattedArguments.utf8)), .object(expectedArguments))
        XCTAssertEqual(display.requestHash, action.requestHash)
        XCTAssertEqual(display.grantRevision, action.grantRevision)
        XCTAssertEqual(display.expiresAtMilliseconds, action.approvalExpiresAt)
        await appModel.refresh()
        XCTAssertEqual(appModel.actions.first(where: { $0.id == action.id }), display.action)
        await appModel.decide(display.action, as: .deny)
        XCTAssertNil(appModel.errorMessage)
        let decided = try await client.getAction(id: action.id)
        XCTAssertEqual(decided.state, .denied)
        XCTAssertEqual(decided.request, action.request)
        XCTAssertEqual(decided.requestHash, action.requestHash)
        XCTAssertEqual(appModel.actions.first(where: { $0.id == action.id }), decided)
        _ = try fixture.command("action", values: ["botID": bot.id, "threadID": thread.id, "key": "synthetic_allow_action"])
        await appModel.refresh()
        let allowAction = try XCTUnwrap(appModel.actions.first(where: { $0.state == .awaitingApproval }))
        let allowDisplay = ApprovalPresentation(action: allowAction)
        XCTAssertEqual(allowDisplay.arguments, expectedArguments)
        XCTAssertTrue(allowDisplay.canDecide(hostAvailable: appModel.canUseHost, atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)))
        await appModel.decide(allowDisplay.action, as: .allow)
        XCTAssertNil(appModel.errorMessage)
        let allowed = try await client.getAction(id: allowAction.id)
        XCTAssertEqual(allowed.state, .ready)
        XCTAssertEqual(allowed.request, allowAction.request)
        XCTAssertEqual(allowed.requestHash, allowAction.requestHash)
        XCTAssertEqual(allowed.grantRevision, allowAction.grantRevision)
        XCTAssertEqual(appModel.actions.first(where: { $0.id == allowAction.id }), allowed)
        await appModel.refresh(); XCTAssertEqual(appModel.bots.map(\.id),[bot.id])
        let devices = try await client.listDevices(); XCTAssertEqual(devices.map(\.id),[deviceID]); XCTAssertEqual(devices.first?.platform,.macos); XCTAssertTrue(devices.first?.paired ?? false)
        let renamed = try await client.renameDevice(id:deviceID,name:"  Native renamed  "); XCTAssertEqual(renamed.name,"Native renamed")
        let inspected = try fixture.command("inspect"); XCTAssertEqual(inspected["calls"] as? Int,1); XCTAssertEqual(inspected["bots"] as? Int,1); XCTAssertEqual(inspected["devices"] as? Int,1); XCTAssertEqual(inspected["writerHeld"] as? Bool,true)
        let oldScope = try XCTUnwrap(onboarding.publicReference).scope(); onboarding.disconnect(); await client.close().value
        _ = try fixture.command("restart"); _ = try fixture.command("advance")
        // Pending status restores the original identity after the original offer expiry; no code exists locally.
        let restored = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}), restoredModel = DexterAppModel(storage:PairedAppStateMemory(),pairing:restored); await restoredModel.connectPairedHost(); XCTAssertEqual(restored.state,.paired); XCTAssertTrue(restoredModel.canUseHost)
        XCTAssertEqual(try XCTUnwrap(restored.publicReference).scope(),oldScope); XCTAssertEqual(restored.binding?.deviceID,deviceID); XCTAssertGreaterThanOrEqual(try XCTUnwrap(restored.binding?.bindingRevision),1)
        let restoredClient = try XCTUnwrap(restored.activeClient), repeated = try await restoredClient.startTurn(threadID:thread.id,submission:submission); XCTAssertEqual(repeated.id,turn.id)
        XCTAssertEqual(try fixture.command("inspect")["calls"] as? Int,1)
        await restoredModel.revokeThisClient(); XCTAssertFalse(restoredModel.canUseHost); XCTAssertEqual(restored.state,.revoked); XCTAssertNil(restored.activeClient)
        do { _ = try await restoredClient.health(); XCTFail("retained SDK admitted after self revoke") } catch { XCTAssertTrue(error is CancellationError) }
        let afterRevoke = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); await afterRevoke.restoreOrCheckApproval(); XCTAssertEqual(afterRevoke.state,.revoked); XCTAssertNil(afterRevoke.binding)
        let counts = await keys.counts(); XCTAssertEqual(counts[1],1)
        try fixture.finish()
    }
    func testRealClaimACKStorageLossHoldsAcrossRestartDetachAndDifferentOffer() async throws {
        let fixture = try ActualPairedHostFixture(); defer { fixture.close() }
        let identity = try ClientNativeIdentity.ephemeralFixture(), keys = PairIdentityMemory(preferred:identity), metadata = PairMetadataMemory()
        let onboarding = PairedHostOnboarding(journal:LostJournalACK(file:metadata.journal),storage:metadata,identityStorage:{_ in keys})
        do { try onboarding.importBundle(fixture.bundle) } catch {
            if let failure = error as? ClientIdentityFailure { XCTFail("bundle import failure: \(failure)") } else { XCTFail("bundle import typed unexpected error") }; return
        }; fixture.bundle.removeAll(); await onboarding.provisionIdentity(); await onboarding.claim(name:"Synthetic ACK loss")
        XCTAssertEqual(onboarding.state,.outcomeUnknown); XCTAssertNil(onboarding.publicReference?.claimID); XCTAssertTrue(onboarding.publicReference?.claimOutcomeUnknown ?? false)
        let scope = try XCTUnwrap(onboarding.publicReference).scope(), entry = try await metadata.journal.loadOnly(scope:scope); XCTAssertNil(try XCTUnwrap(entry).claimID)
        let inspect = try fixture.command("inspect"), pending = try XCTUnwrap(inspect["pendingClaims"] as? [[String:Any]])
        XCTAssertEqual(pending.count,1); XCTAssertEqual(pending.first?["clientFingerprint"] as? String,identity.fingerprint); XCTAssertEqual(inspect["devices"] as? Int,0)
        onboarding.disconnect(); _ = try fixture.command("restart")
        let restored = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); await restored.restoreOrCheckApproval(); XCTAssertEqual(restored.state,.outcomeUnknown); try restored.detach()
        let next = try fixture.command("offer"), fresh = try JSONSerialization.data(withJSONObject:try XCTUnwrap(next["bundle"] as? [String:Any]))
        let detached = PairedHostOnboarding(journal:metadata.journal,storage:metadata,identityStorage:{_ in keys}); XCTAssertThrowsError(try detached.importBundle(fresh)); let counts = await keys.counts(); XCTAssertEqual(counts[1],1)
        XCTAssertEqual((try fixture.command("inspect")["pendingClaims"] as? [[String:Any]])?.count,1,"no duplicate claim after restart/detach/new offer")
        _ = try fixture.command("advance")
        let afterExpiryOffer = try fixture.command("offer")
        let afterExpiry = try JSONSerialization.data(withJSONObject:try XCTUnwrap(afterExpiryOffer["bundle"] as? [String:Any]))
        let changedIdentity = try ClientNativeIdentity.ephemeralFixture(), changedPin = try IntegrationTLSFixture(identity:changedIdentity)
        defer { changedPin.close() }
        var changed = try XCTUnwrap(JSONSerialization.jsonObject(with:afterExpiry) as? [String:Any])
        changed["hostUrl"] = changedPin.url.absoluteString; changed["hostCertificateDER"] = changedPin.der.base64EncodedString(); changed["hostFingerprint"] = changedPin.fingerprint
        let beforeCounts = await keys.counts()
        let beforeHTTP = try fixture.command("inspect")["httpRequests"] as? Int
        for candidate in [afterExpiry,try JSONSerialization.data(withJSONObject:changed)] {
            let freshPreferences = PairMetadataMemory()
            let sdk = PairedHostOnboarding(journal:metadata.journal,storage:freshPreferences,identityStorage:{_ in keys})
            XCTAssertThrowsError(try sdk.importBundle(candidate)) { XCTAssertEqual($0 as? ClientIdentityFailure,.outcomeUnknown) }
            XCTAssertNil(sdk.publicReference); XCTAssertEqual(freshPreferences.writes,0)
            await sdk.provisionIdentity(); await sdk.claim(name:"Must remain held")
        }
        let afterCounts = await keys.counts(); XCTAssertEqual(afterCounts,beforeCounts)
        XCTAssertEqual(try changedPin.requests(),0)
        let afterExpiryInspect = try fixture.command("inspect")
        XCTAssertEqual(afterExpiryInspect["httpRequests"] as? Int,beforeHTTP,"SDK hold must precede native helper and HTTP even after expiry with new binding/pin")
        XCTAssertEqual((afterExpiryInspect["pendingClaims"] as? [[String:Any]])?.count,0,"server filters expired pending claims; zero HTTP proves no new claim")
        let held = try await metadata.journal.loadOnly(scope:scope); XCTAssertNil(try XCTUnwrap(held).claimID)
        try fixture.finish()
    }
}
