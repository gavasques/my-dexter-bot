#if os(macOS)
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

@MainActor private final class MemoryQAFlag { var current = true }
@MainActor private struct MemoryQAHost {
    let supervisor: LocalHostSupervisor
    let client: HostClient
    let directory: URL
    let config: LocalHostLaunchConfiguration
    func mode(_ value: [String:Any]) throws { try JSONSerialization.data(withJSONObject:value).write(to:directory.appendingPathComponent("data/qa-mode.json")) }
    func counters() async throws -> [String:Any] {
        let (bytes,_) = try await URLSession.shared.data(from:URL(string:config.hostAddress+"/qa/counters")!)
        return try XCTUnwrap(JSONSerialization.jsonObject(with:bytes) as? [String:Any])
    }
    func editor(_ store: InMemoryMemoryBackendWrappingStore, current: MemoryQAFlag = MemoryQAFlag()) -> MemoryBackendSettingsEditor {
        MemoryBackendSettingsEditor(hostID:"host_memory_qa",client:client,isCurrent:{current.current},
            channel:MemoryBackendPrivateChannel(available:{supervisor.canManageMemoryBackend(hostID:$0)},
                send:{try await supervisor.sendMemoryBackendFrame($0,timeout:.milliseconds(80))},
                reconcile:{supervisor.reconcileMemoryBackend($0,status:$1)},uncertain:{supervisor.unconfirmedMemoryBackendIntent}),wrapping:store)
    }
}
@MainActor final class MemoryBackendNativeTests: XCTestCase {
    private func withHost(_ operation: @MainActor (MemoryQAHost) async throws -> Void) async throws {
        let root=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let nodePath=try XCTUnwrap(ProcessInfo.processInfo.environment["DEXTER_QA_NODE"],"Set DEXTER_QA_NODE to the observed absolute Node executable; never installs.")
        let directory=root.deletingLastPathComponent().appendingPathComponent("qa/native-memory-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:directory.appendingPathComponent("data"),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        defer { try? FileManager.default.removeItem(at:directory) }
        let fixture=root.appendingPathComponent("scripts/tests/native-memory-backend-fixture.mjs"), cli=directory.appendingPathComponent("fixture.js")
        try FileManager.default.copyItem(at:fixture,to:cli)
        try Data("{\"type\":\"module\"}".utf8).write(to:directory.appendingPathComponent("package.json"))
        let config=LocalHostLaunchConfiguration(node:URL(fileURLWithPath:nodePath),cli:cli,dataDir:directory.appendingPathComponent("data"),port:UInt16.random(in:49152...61000))
        let supervisor=LocalHostSupervisor(configuration:config,makeChild:{ config,_ in FoundationLocalHostChild(configuration:config,environment:["PATH":URL(fileURLWithPath:nodePath).deletingLastPathComponent().path]) })
        let started = await supervisor.start(timeout:.seconds(5)); XCTAssertEqual(started,.running(address:config.hostAddress))
        let client=HostClient(baseURL:URL(string:config.hostAddress)!)
        defer { client.close() }
        let host=MemoryQAHost(supervisor:supervisor,client:client,directory:directory,config:config)
        do { try await operation(host); let stopped=await supervisor.stop(grace:.seconds(2));XCTAssertEqual(stopped,.stopped);XCTAssertFalse(supervisor.ownsLiveChild) }
        catch { _ = await supervisor.stop(grace:.seconds(2)); throw error }
    }
    private func settled(_ editor: MemoryBackendSettingsEditor) async throws {
        for _ in 0..<600 { if !editor.busy { return }; try await Task.sleep(for:.milliseconds(5)) }
        XCTFail("bounded editor task did not settle")
    }
    private func enabled(_ host:MemoryQAHost) async throws -> MemoryBackendWrappingScope {
        let input=try MemoryBackendSettingsInput(expectedHostId:"host_memory_qa",clientRequestId:"setup_qa",expectedRevision:0,origin:"http://127.0.0.1:1933",enabled:true)
        _ = try await host.client.updateMemoryBackendSettings(input,ownerID:"owner_memory_qa")
        return try MemoryBackendWrappingScope(hostID:"host_memory_qa",ownerID:"owner_memory_qa",origin:input.origin)
    }
    func testScopeIsolationExplicitWrappingAndNoLegacyFallback() throws {
        let store=InMemoryMemoryBackendWrappingStore(), a=try MemoryBackendWrappingScope(hostID:"host_a",ownerID:"owner_a",origin:"https://memory.example")
        let scopes=[try MemoryBackendWrappingScope(hostID:"host_b",ownerID:"owner_a",origin:a.origin),try MemoryBackendWrappingScope(hostID:"host_a",ownerID:"owner_b",origin:a.origin),try MemoryBackendWrappingScope(hostID:"host_a",ownerID:"owner_a",origin:"https://other.example")]
        XCTAssertEqual(store.status(scope:a),.missing);try store.create(scope:a).clear();XCTAssertEqual(store.status(scope:a),.configured)
        XCTAssertThrowsError(try store.create(scope:a)){XCTAssertEqual($0 as? MemoryBackendPrivateFailure,.wrappingKeyExists)}
        for scope in scopes { XCTAssertNotEqual(a.keychainService,scope.keychainService);XCTAssertEqual(store.status(scope:scope),.missing);XCTAssertThrowsError(try store.load(scope:scope)) }
        let secret=try store.load(scope:a);XCTAssertEqual(secret.description,"MemoryBackendOwnedSecret(redacted)");secret.clear()
        XCTAssertEqual(store.creates,1);XCTAssertEqual(store.loads,1)
    }
    func testObservedOwnFoundationInheritedPipeMetadata() async throws {
        try await withHost { host in
            let counters=try await host.counters(),metadata=try XCTUnwrap(counters["stdin"] as? [String:Any])
            XCTAssertEqual(metadata["isFIFO"] as? Bool,true);XCTAssertEqual(metadata["isSocket"] as? Bool,false)
            let source=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            try JSONSerialization.data(withJSONObject:metadata,options:[.prettyPrinted,.sortedKeys]).write(to:source.deletingLastPathComponent().appendingPathComponent("logs/observed-foundation-pipe.json"))
        }
    }
    func testOriginPolicyAndOwnerOnlyHTTPNeverAcceptSecretBody() async throws {
        for invalid in ["http://localhost:1933","http://127.0.0.1","https://name:secret@memory.example","https://memory.example/path","https://memory.example?key=value","https://memory.example:443","https://Memory.example"] { XCTAssertThrowsError(try memoryBackendOrigin(invalid)) }
        XCTAssertEqual(try memoryBackendOrigin("https://memory.example/"),"https://memory.example")
        let remote=HostClient(baseURL:URL(string:"https://memory.example")!,accessPolicy:.unpairedHost)
        do { _ = try await remote.memoryBackendStatus();XCTFail("unpaired remote must refuse before network") } catch { XCTAssertEqual(error as? HostClientError,.forbidden) };remote.close()
        try await withHost { host in
            var req=URLRequest(url:URL(string:host.config.hostAddress+"/v1/memory-backend/settings")!);req.httpMethod="PATCH"
            req.httpBody=Data("{\"administrativeKey\":\"synthetic-only\"}".utf8);req.setValue("application/json",forHTTPHeaderField:"content-type")
            let (_,response)=try await URLSession.shared.data(for:req);XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,400)
        }
    }
    func testRealHTTPMetadataLostACKOriginalReceiptNoSecondPATCHAcrossReopen() async throws {
        try await withHost { host in
            let editor=host.editor(InMemoryMemoryBackendWrappingStore());editor.open();try await settled(editor)
            XCTAssertEqual(editor.ownerID,"owner_memory_qa") // Works before any bot exists.
            editor.origin="http://127.0.0.1:1933";editor.enabled=true;try host.mode(["loseSettingsACK":true])
            editor.save();try await settled(editor);XCTAssertNotNil(editor.pendingSettings);XCTAssertFalse(editor.canSave)
            editor.save();editor.close();editor.open();try await settled(editor)
            XCTAssertNil(editor.pendingSettings);XCTAssertEqual(editor.status?.settings.revision,1)
            let counters=try await host.counters();XCTAssertEqual(counters["patches"] as? Int,1);editor.close()
        }
    }
    func testMalformedReceiptCannotResolveAnUnknownSave() async throws {
        try await withHost { host in
            let editor=host.editor(InMemoryMemoryBackendWrappingStore());editor.open();try await settled(editor)
            editor.origin="https://memory.example";editor.enabled=true;try host.mode(["corruptReceipt":true])
            editor.save();try await settled(editor);XCTAssertNotNil(editor.pendingSettings)
            editor.verify();try await settled(editor);XCTAssertNotNil(editor.pendingSettings);XCTAssertFalse(editor.canSave)
            try host.mode([:]);editor.verify();try await settled(editor);XCTAssertNil(editor.pendingSettings)
            let counts = try await host.counters(); XCTAssertEqual(counts["patches"] as? Int,1);editor.close()
        }
    }
    func testRealPipeCreateBrowserMultiplexLockUnlockAndDisable() async throws {
        try await withHost { host in
            _ = try await enabled(host);let store=InMemoryMemoryBackendWrappingStore(),editor=host.editor(store)
            editor.open();try await settled(editor);XCTAssertTrue(editor.canInitialize)
            editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-admin-only")));try await settled(editor)
            XCTAssertEqual(editor.status?.state,.configuredUnverified);XCTAssertEqual(store.creates,1)
            try await host.supervisor.setBrowserUseKey("synthetic-browser-only-123",hostID:"host_memory_qa",timeout:.seconds(1))
            editor.lock();try await settled(editor);XCTAssertEqual(editor.status?.state,.privateUnlockRequired);XCTAssertTrue(editor.canUnlock)
            editor.unlock();try await settled(editor);XCTAssertEqual(editor.status?.state,.configuredUnverified);XCTAssertEqual(store.creates,1);XCTAssertEqual(store.loads,1)
            editor.enabled=false;editor.save();try await settled(editor);XCTAssertEqual(editor.status?.state,.disabled)
            let counts=try await host.counters();XCTAssertEqual(counts["privateOperations"] as? [String],["create","lock","unlock"]);XCTAssertEqual(counts["browserFrames"] as? Int,1)
            XCTAssertFalse(host.config.arguments.contains(where:{$0.contains("synthetic-admin")}));editor.close()
        }
    }
    func testLostPrivateACKGETMatchingIdentityAndNoBlindRetry() async throws {
        try await withHost { host in
            _ = try await enabled(host);let editor=host.editor(InMemoryMemoryBackendWrappingStore());editor.open();try await settled(editor)
            try host.mode(["losePrivateACK":true]);editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")));try await settled(editor)
            XCTAssertNotNil(editor.pendingPrivate);XCTAssertEqual(editor.notice,.privateUnknown);XCTAssertFalse(editor.canInitialize)
            editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-other")));try await settled(editor)
            try host.mode(["statusWrongRequest":true]);editor.verify();try await settled(editor);XCTAssertNotNil(editor.pendingPrivate)
            try host.mode([:]);editor.verify();try await settled(editor);XCTAssertNil(editor.pendingPrivate);XCTAssertNil(host.supervisor.unconfirmedMemoryBackendIntent)
            let counts = try await host.counters(); XCTAssertEqual(counts["privateFrames"] as? Int,1);editor.close()
        }
    }
    func testWrongHostACKCannotConfirmAndExplicitLockCutsUncertainState() async throws {
        try await withHost { host in
            _ = try await enabled(host);let editor=host.editor(InMemoryMemoryBackendWrappingStore());editor.open();try await settled(editor)
            try host.mode(["wrongPrivateHost":true]);editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")));try await settled(editor)
            XCTAssertNotNil(editor.pendingPrivate);XCTAssertNotNil(host.supervisor.unconfirmedMemoryBackendIntent)
            try host.mode([:]);editor.lock();try await settled(editor);XCTAssertEqual(editor.notice,.locked);XCTAssertNil(host.supervisor.unconfirmedMemoryBackendIntent)
            let counts = try await host.counters(); XCTAssertEqual(counts["privateOperations"] as? [String],["create","lock"]);editor.close()
        }
    }
    func testWrongOwnerOrChangedRevisionPreflightCannotReadOrCreateWrappingKey() async throws {
        try await withHost { host in
            _ = try await enabled(host);let store=InMemoryMemoryBackendWrappingStore(),editor=host.editor(store);editor.open();try await settled(editor)
            try host.mode(["wrongOwner":true]);editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")));try await settled(editor)
            XCTAssertEqual(store.creates,0);XCTAssertEqual(store.loads,0)
            try host.mode([:]);editor.verify();try await settled(editor)
            let input=try MemoryBackendSettingsInput(expectedHostId:"host_memory_qa",clientRequestId:"changed_qa",expectedRevision:1,origin:"https://other.example",enabled:true)
            _ = try await host.client.updateMemoryBackendSettings(input,ownerID:"owner_memory_qa")
            editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")));try await settled(editor)
            let counts = try await host.counters(); XCTAssertEqual(store.creates,0);XCTAssertEqual(counts["privateFrames"] as? Int,0);editor.close()
        }
    }
    func testStaleHTTPCallbackCannotAdoptNewOwnerOrEnablePrivateButtons() async throws {
        try await withHost { host in
            let flag=MemoryQAFlag(),editor=host.editor(InMemoryMemoryBackendWrappingStore(),current:flag)
            try host.mode(["delayStatus":100]);editor.open();try await Task.sleep(for:.milliseconds(20));flag.current=false;editor.close()
            try await Task.sleep(for:.milliseconds(150));XCTAssertNil(editor.status);XCTAssertFalse(editor.canSave);XCTAssertFalse(editor.canInitialize)
        }
    }
    func testOriginChangeReportsRestartWithoutSendingAnyPrivateBytes() async throws {
        try await withHost { host in
            _ = try await enabled(host);let editor=host.editor(InMemoryMemoryBackendWrappingStore());editor.open();try await settled(editor)
            editor.initialize(administrative:try XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")));try await settled(editor)
            editor.origin="https://other.example";editor.save();try await settled(editor)
            XCTAssertEqual(editor.status?.state,.restartRequired);XCTAssertFalse(editor.canInitialize);XCTAssertFalse(editor.canUnlock)
            let counts = try await host.counters(); XCTAssertEqual(counts["privateFrames"] as? Int,1);editor.close()
        }
    }
}
#endif
