#if os(macOS)
import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

@MainActor private final class MemoryLifetimeChild: LocalHostChild {
    let configuration: LocalHostLaunchConfiguration
    var isRunning = false
    var terminationStatus: Int32 { 0 }
    var received: [String:Any]?
    var count = 0
    var onStdout: (@Sendable (Data)->Void)?
    var onExit: (@Sendable ()->Void)?
    init(_ configuration:LocalHostLaunchConfiguration){self.configuration=configuration}
    func run(onStdout:@escaping @Sendable (Data)->Void,onStderr:@escaping @Sendable (Data)->Void,onExit:@escaping @Sendable ()->Void) throws {
        self.onStdout=onStdout;self.onExit=onExit;isRunning=true
        onStdout(try JSONSerialization.data(withJSONObject:["status":"ready","mode":"local-development","url":configuration.hostAddress,"hostId":"host_qa","engineExecution":"disabled","mcpGateway":"disabled","deviceTurnTools":"disabled","deviceChannel":["status":"unconfigured"]]))
    }
    func provideMemoryBackendKeyFrame(_ data:Data)throws { received=try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any]);count+=1 }
    func requestGracefulStop(){isRunning=false;onExit?()}
    func ack(_ id:String,status:String="ready",extra:Bool=false)throws {
        var object:[String:Any]=["schema":"dexter.memory-backend-key-ack/1","requestId":id,"hostID":"host_qa","status":status]
        if extra{object["unexpected"]="must_refuse"}
        var data=try JSONSerialization.data(withJSONObject:object);data.append(10);onStdout?(data)
    }
}
@MainActor final class MemoryBackendLifetimeTests: XCTestCase {
    private func config()throws->LocalHostLaunchConfiguration {
        let source=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory=source.deletingLastPathComponent().appendingPathComponent("qa/memory-lifetime-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
        let node=directory.appendingPathComponent("node"),cli=directory.appendingPathComponent("fixture.js")
        try Data("synthetic executable is never launched".utf8).write(to:node);try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:node.path)
        try Data("synthetic source is never executed".utf8).write(to:cli)
        return LocalHostLaunchConfiguration(node:node,cli:cli,dataDir:directory.appendingPathComponent("data"))
    }
    private func intent(_ op:MemoryBackendPrivateOperation = .create)throws->MemoryBackendPrivateIntent {
        try MemoryBackendPrivateIntent(scope:MemoryBackendWrappingScope(hostID:"host_qa",ownerID:"owner_qa",origin:"https://memory.example"),expectedRevision:1,operation:op)
    }
    private func frame(_ intent:MemoryBackendPrivateIntent)throws->MemoryBackendPrivateFrame {
        try .create(intent,wrapping:XCTUnwrap(MemoryBackendOwnedSecret(wrappingKey:Data(repeating:2,count:32))),administrative:XCTUnwrap(MemoryBackendOwnedSecret(administrativeKey:"synthetic-only")),role:.workspaceAdmin)
    }
    func testFrameExactScopeOneShotSecretOwnershipAndNoDescriptionLeak()throws {
        let config=try config();defer{try? FileManager.default.removeItem(at:config.node.deletingLastPathComponent())}
        let child=MemoryLifetimeChild(config),intent=try intent(),value=try frame(intent)
        XCTAssertEqual(value.description,"MemoryBackendPrivateFrame(redacted)");try value.handoff(to:child)
        let fields=try XCTUnwrap(child.received)
        XCTAssertEqual(Set(fields.keys),["schema","requestId","hostID","origin","expectedRevision","operation","wrappingKeyBase64","administrativeKey","administrativeRole"])
        XCTAssertEqual(fields["administrativeRole"] as? String,"workspace_admin")
        XCTAssertEqual(Data(base64Encoded:try XCTUnwrap(fields["wrappingKeyBase64"] as? String))?.count,32)
        XCTAssertThrowsError(try value.handoff(to:child));XCTAssertEqual(child.count,1)
        XCTAssertNil(MemoryBackendOwnedSecret(administrativeKey:""));XCTAssertNil(MemoryBackendOwnedSecret(administrativeKey:"bad\0value"));XCTAssertNil(MemoryBackendOwnedSecret(wrappingKey:Data(count:31)))
        XCTAssertThrowsError(try MemoryBackendPrivateIntent(scope:intent.scope,expectedRevision:0,operation:.unlock))
        XCTAssertThrowsError(try MemoryBackendPrivateIntent(scope:intent.scope,expectedRevision:1,operation:.unlock,requestID:UUID().uuidString))
    }
    func testOldChildLateACKAndExitCannotConfirmOrStopNewLifetime()async throws {
        let config=try config();defer{try? FileManager.default.removeItem(at:config.node.deletingLastPathComponent())}
        var children:[MemoryLifetimeChild]=[]
        let supervisor=LocalHostSupervisor(configuration:config,makeChild:{ c,_ in let child=MemoryLifetimeChild(c);children.append(child);return child },portIsFree:{_ in true})
        _=await supervisor.start(timeout:.seconds(1));let old=try XCTUnwrap(children.first),firstLifetime=supervisor.memoryBackendLifetime
        _=await supervisor.stop(grace:.seconds(1));_=await supervisor.start(timeout:.seconds(1))
        XCTAssertNotEqual(firstLifetime,supervisor.memoryBackendLifetime);let current=try XCTUnwrap(children.last),original=try intent()
        var confirmed=false
        let send=Task{@MainActor in try await supervisor.sendMemoryBackendFrame(frame(original),timeout:.seconds(1));confirmed=true}
        for _ in 0..<50 { if current.count>0{break};try await Task.sleep(for:.milliseconds(2)) }
        try old.ack(original.requestID);old.onExit?();try await Task.sleep(for:.milliseconds(20))
        XCTAssertFalse(confirmed);XCTAssertTrue(supervisor.isRunning)
        try current.ack(original.requestID);try await send.value;XCTAssertTrue(confirmed)
        _=await supervisor.stop(grace:.seconds(1))
    }
    func testClosedACKSchemaAndOfflineDeliveryCannotSucceedOrReplay()async throws {
        let config=try config();defer{try? FileManager.default.removeItem(at:config.node.deletingLastPathComponent())}
        let child=MemoryLifetimeChild(config),supervisor=LocalHostSupervisor(configuration:config,makeChild:{_,_ in child},portIsFree:{_ in true})
        _=await supervisor.start(timeout:.seconds(1));let original=try intent()
        let sending=Task{@MainActor in try await supervisor.sendMemoryBackendFrame(frame(original),timeout:.milliseconds(50))}
        for _ in 0..<50 { if child.count>0{break};try await Task.sleep(for:.milliseconds(1)) }
        try child.ack(original.requestID,extra:true)
        do {try await sending.value;XCTFail("extra ACK fields cannot prove success")}catch{XCTAssertEqual(error as? MemoryBackendPrivateFailure,.outcomeUnknown)}
        do {try await supervisor.sendMemoryBackendFrame(frame(try intent()),timeout:.milliseconds(20));XCTFail("unknown create cannot be retried")}catch{XCTAssertEqual(error as? MemoryBackendPrivateFailure,.bridgeUnavailable)}
        XCTAssertEqual(child.count,1);_=await supervisor.stop(grace:.seconds(1))
        do {try await supervisor.sendMemoryBackendFrame(frame(try intent()));XCTFail("offline delivery must refuse")}catch{XCTAssertEqual(error as? MemoryBackendPrivateFailure,.bridgeUnavailable)}
        XCTAssertEqual(child.count,1)
    }
}
#endif
