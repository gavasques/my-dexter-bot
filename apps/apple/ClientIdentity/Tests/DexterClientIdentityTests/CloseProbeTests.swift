import XCTest
import Foundation
@testable import DexterClientIdentity

private final class DrainRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []
    private var completion: (@Sendable () -> Void)?
    func record(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
    func hold(_ completion: @escaping @Sendable () -> Void) { lock.lock(); self.completion = completion; lock.unlock() }
    func release() { lock.lock(); let c = completion; completion = nil; lock.unlock(); c?() }
    func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return events }
    func waitFor(_ event: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !snapshot().contains(event) { guard Date() < deadline else { throw ClientIdentityFailure.timeout }; try await Task.sleep(for:.milliseconds(5)) }
    }
}
@MainActor final class CloseProbeTests: XCTestCase {
    func testCloseWaitsForActualRegisteredReceiveAndQueueBarrier() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity,mode:"delay"); defer { fixture.close() }
        let recorder = DrainRecorder()
        let probe = ClientTransportProbe(now:{ Date() },event:{ recorder.record($0) },receiveCompletion:{ recorder.hold($0) })
        let transport = NativeHostTransport(identity:identity,host:try fixture.host(),probe:probe)
        let request = try ClientRequest.json(route:.pairStatus,value:["claimId":"claim"])
        let send = Task { try await transport.send(request) }
        while try fixture.requests() == 0 { try await Task.sleep(for:.milliseconds(5)) }
        let close = transport.close(); XCTAssertTrue(close === transport.close())
        let closing = Task { await close.wait(); recorder.record("closed") }
        try await recorder.waitFor("recv-held"); try await recorder.waitFor("cancelled")
        XCTAssertFalse(recorder.snapshot().contains("resume"),"registered callback must drain")
        XCTAssertFalse(recorder.snapshot().contains("closed"))
        do { _ = try await transport.send(request); XCTFail("close admission reopened") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.closed) }
        recorder.release(); await closing.value
        do { _ = try await send.value; XCTFail("cancelled receive delivered") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.cancelled) }
        let events = recorder.snapshot()
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of:"recv-exit")),try XCTUnwrap(events.firstIndex(of:"resume")),"queue barrier must follow callback exit")
        XCTAssertLessThan(try XCTUnwrap(events.firstIndex(of:"cancelled")),try XCTUnwrap(events.firstIndex(of:"resume")))
        XCTAssertEqual(try fixture.requests(),1)
    }
    func testSendTimeRevalidatesActualPinnedCertificateBeforeHTTP() async throws {
        let identity = try ClientNativeIdentity.ephemeralFixture(), fixture = try ClientTLSFixture(identity:identity); defer { fixture.close() }
        let future = Date().addingTimeInterval(2*86400)
        let probe = ClientTransportProbe(now:{ future },event:{ _ in },receiveCompletion:{ $0() })
        let transport = NativeHostTransport(identity:identity,host:try fixture.host(),probe:probe)
        do { _ = try await transport.send(.json(route:.pairStatus,value:["claimId":"claim"])); XCTFail("expired-at-send certificate admitted") } catch { XCTAssertEqual(error as? ClientIdentityFailure,.expired) }
        XCTAssertEqual(try fixture.requests(),0); await transport.close().wait()
    }
}
