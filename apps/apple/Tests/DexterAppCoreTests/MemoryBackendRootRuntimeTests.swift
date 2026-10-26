#if os(macOS)
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

@MainActor private final class RootStartupDiagnosticChild: LocalHostChild {
    let base: FoundationLocalHostChild
    let log: URL
    var ready = false
    init(_ config: LocalHostLaunchConfiguration, node: String, log: URL) {
        base = FoundationLocalHostChild(configuration:config,environment:["PATH":URL(fileURLWithPath:node).deletingLastPathComponent().path+":/usr/bin:/bin"]); self.log = log
    }
    var isRunning: Bool { base.isRunning }
    var terminationStatus: Int32 { base.terminationStatus }
    func run(onStdout:@escaping @Sendable (Data)->Void,onStderr:@escaping @Sendable (Data)->Void,onExit:@escaping @Sendable ()->Void)throws {
        try base.run(onStdout:{[weak self] data in
            Task{@MainActor in if let o=try? JSONSerialization.jsonObject(with:data) as? [String:Any],o["status"] as? String == "ready" { self?.ready=true };onStdout(data)}
        },onStderr:{[weak self] data in
            Task{@MainActor in
                // Startup-only diagnostics: no frame/administrative input has been sent before readiness.
                if let self,!self.ready { try? data.prefix(2048).write(to:self.log) };onStderr(data)
            }
        },onExit:onExit)
    }
    func requestGracefulStop(){base.requestGracefulStop()}
    func provideMemoryBackendKeyFrame(_ data:Data)throws{try base.provideMemoryBackendKeyFrame(data)}
}

/// Real Root CLI/Hono/HostServices/private custody; fresh synthetic SQLite, synthetic admin and in-memory wrapping.
/// No OpenViking network operation, provider inference, personal Keychain, personal DB or application installation.
@MainActor final class MemoryBackendRootRuntimeTests: XCTestCase {
    func testRealRootHTTPInheritedPipeEncryptedCustodyAndRestartUnlock() async throws {
        guard let node=ProcessInfo.processInfo.environment["DEXTER_QA_NODE"],let cli=ProcessInfo.processInfo.environment["DEXTER_QA_ROOT_CLI"] else {
            throw XCTSkip("Root integration requires explicitly pinned DEXTER_QA_NODE and DEXTER_QA_ROOT_CLI; never installs or guesses a runtime.")
        }
        let source=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory=source.deletingLastPathComponent().appendingPathComponent("qa/root-memory-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        defer { try? FileManager.default.removeItem(at:directory) }
        let config=LocalHostLaunchConfiguration(node:URL(fileURLWithPath:node),cli:URL(fileURLWithPath:cli),dataDir:directory.appendingPathComponent("content"),port:UInt16.random(in:49152...61000))
        let log=source.deletingLastPathComponent().appendingPathComponent("logs/root-startup-only.txt")
        let supervisor=LocalHostSupervisor(configuration:config,makeChild:{ c,_ in RootStartupDiagnosticChild(c,node:node,log:log) })
        let started=await supervisor.start(timeout:.seconds(10));XCTAssertEqual(started,.running(address:config.hostAddress))
        guard supervisor.isRunning else { throw HostClientError.notReady }
        let client=HostClient(baseURL:URL(string:config.hostAddress)!);defer{client.close()}
        do {
            let health=try await client.health(),hostID=try XCTUnwrap(health.hostId)
            guard case .object(let state)=health.state,case .string(let ownerID)=state["ownerId"] else { throw HostClientError.contractMismatch }
            let initial=try await client.memoryBackendStatus();XCTAssertEqual(initial.state,.disabled);XCTAssertEqual(initial.settings.revision,0)
            let input=try MemoryBackendSettingsInput(expectedHostId:hostID,clientRequestId:"native_actual_root_setup",expectedRevision:0,origin:"https://uncontacted-memory.invalid",enabled:true)
            let saved=try await client.updateMemoryBackendSettings(input,ownerID:ownerID)
            XCTAssertEqual(saved.status.state,.privateUnlockRequired)
            let receipt=try await client.memoryBackendSettingReceipt(input,ownerID:ownerID);XCTAssertTrue(receipt?.matches(input,ownerID:ownerID)==true)
            let scope=try MemoryBackendWrappingScope(hostID:hostID,ownerID:ownerID,origin:input.origin),wrap=InMemoryMemoryBackendWrappingStore()
            let create=try MemoryBackendPrivateIntent(scope:scope,expectedRevision:1,operation:.create)
            let frame=try MemoryBackendPrivateFrame.create(create,wrapping:wrap.create(scope:scope),administrative:XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-root-runtime-admin-only")),role:.root)
            try await supervisor.sendMemoryBackendFrame(frame,timeout:.seconds(5))
            let connected=try await client.memoryBackendStatus();XCTAssertEqual(connected.state,.configuredUnverified);XCTAssertEqual(connected.semanticRecall,"unproven");XCTAssertEqual(connected.privateRequest?.requestId,create.requestID)
            let custody=directory.appendingPathComponent("private-memory-backend"),files=try FileManager.default.contentsOfDirectory(at:custody,includingPropertiesForKeys:nil)
            XCTAssertEqual(files.count,1)
            let sealed=try Data(contentsOf:XCTUnwrap(files.first));XCTAssertFalse(String(decoding:sealed,as:UTF8.self).contains("synthetic-root-runtime-admin-only"))
            let attrs=try FileManager.default.attributesOfItem(atPath:files[0].path);XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue,0o600)
            let lock=try MemoryBackendPrivateIntent(scope:scope,expectedRevision:1,operation:.lock)
            try await supervisor.sendMemoryBackendFrame(.lock(lock),timeout:.seconds(5))
            let locked=try await client.memoryBackendStatus();XCTAssertEqual(locked.state,.privateUnlockRequired)
            let stopped=await supervisor.stop(grace:.seconds(5));XCTAssertEqual(stopped,.stopped);XCTAssertFalse(supervisor.ownsLiveChild)
            let oldLifetime=supervisor.memoryBackendLifetime
            let restarted=await supervisor.start(timeout:.seconds(10));XCTAssertEqual(restarted,.running(address:config.hostAddress));XCTAssertNotEqual(oldLifetime,supervisor.memoryBackendLifetime)
            let healthAfter=try await client.health();XCTAssertEqual(healthAfter.hostId,hostID)
            let beforeUnlock=try await client.memoryBackendStatus();XCTAssertEqual(beforeUnlock.state,.privateUnlockRequired);XCTAssertNil(beforeUnlock.privateRequest)
            let unlock=try MemoryBackendPrivateIntent(scope:scope,expectedRevision:1,operation:.unlock)
            try await supervisor.sendMemoryBackendFrame(.unlock(unlock,wrapping:wrap.load(scope:scope),role:.root),timeout:.seconds(5))
            let afterUnlock=try await client.memoryBackendStatus();XCTAssertEqual(afterUnlock.state,.configuredUnverified);XCTAssertEqual(wrap.creates,1)
            let disable=try MemoryBackendSettingsInput(expectedHostId:hostID,clientRequestId:"native_actual_root_disable",expectedRevision:1,origin:scope.origin,enabled:false)
            let disabled=try await client.updateMemoryBackendSettings(disable,ownerID:ownerID);XCTAssertEqual(disabled.status.state,.disabled)
            let finalStop=await supervisor.stop(grace:.seconds(5));XCTAssertEqual(finalStop,.stopped);XCTAssertFalse(supervisor.ownsLiveChild)
        } catch { _=await supervisor.stop(grace:.seconds(5));throw error }
    }
}
#endif
