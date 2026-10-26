import XCTest
import Foundation

private final class OwnedProcess: @unchecked Sendable { let process = Process(); init() {} }

/// N1: the fixture request counter is published by atomic rename. The node harness holds each publication mid-flight and reads at that instant.
@MainActor final class FixtureAtomicityTests: XCTestCase {
    func testRequestCountPublicationIsAtomicWhileHeld() throws {
        guard let node = ProcessInfo.processInfo.environment["DEXTER_TEST_NODE"], node.hasPrefix("/"), FileManager.default.isExecutableFile(atPath:node) else { return XCTFail("DEXTER_TEST_NODE absolute node path required") }
        let harness = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/publish-count-harness.mjs")
        let owned = OwnedProcess(), process = owned.process, pipe = Pipe(), timedOut = ManagedFlag()
        process.executableURL = URL(fileURLWithPath:node); process.arguments = [harness.path]; process.environment = [:]; process.standardOutput = pipe; process.standardError = pipe
        try process.run()
        let deadline = DispatchWorkItem { if owned.process.isRunning { timedOut.set(); owned.process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline:.now()+30,execute:deadline)
        let output = String(decoding:pipe.fileHandleForReading.readDataToEndOfFile(),as:UTF8.self); process.waitUntilExit(); deadline.cancel()
        XCTAssertFalse(process.isRunning,"owned harness process remains alive"); print("DEXTER_FIXTURE_CLEANUP pid=\(process.processIdentifier) running=\(process.isRunning)")
        XCTAssertFalse(timedOut.isSet,"harness exceeded its finite deadline")
        XCTAssertEqual(process.terminationStatus,0,"harness failed: \(output)"); XCTAssertEqual(output,"OK held=20\n")
    }
}
private final class ManagedFlag: @unchecked Sendable { private let lock = NSLock(); private var value = false; func set() { lock.lock(); value = true; lock.unlock() }; var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value } }
