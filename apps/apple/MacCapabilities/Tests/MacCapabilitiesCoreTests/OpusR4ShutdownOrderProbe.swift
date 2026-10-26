import Foundation
import Testing
@testable import MacCapabilitiesCore

/// Opus R4 independent discriminant. Synthetic FixtureBackend only: no AX, GUI, lock or permission.
/// A reply whose build started a session holds `session_started`; a shutdown reached from that reply's
/// output must not publish its own `session_ended` for the same session before the held `session_started`.
@MainActor @Suite struct OpusR4ShutdownOrderProbe {
    @Test func shutdownFromAReplyThatHoldsSessionStartedKeepsStartBeforeEnd() {
        let backend = FixtureBackend()
        var lines: [[String: Any]] = []
        var core: HelperCore!
        var shutdownOnId: Int?
        var drained = 0
        core = HelperCore(backend: backend, fixtureMode: true) { line in
            let object = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            lines.append(object)
            if let target = shutdownOnId, (object["id"] as? NSNumber)?.intValue == target {
                shutdownOnId = nil
                core.shutdown { drained += 1; lines.append(["probeDrained": true]) }
            }
        }
        func send(_ m: [String: Any]) { core.handle(line: String(decoding: try! JSONSerialization.data(withJSONObject: m), as: UTF8.self)) }
        send(["v": 2, "id": 1, "op": "request_consent", "botKey": String(repeating: "e", count: 32), "botLabel": "Synthetic", "maxSeconds": 60, "promptSeconds": 60])
        shutdownOnId = 2
        send(["v": 2, "id": 2, "op": "fixture", "command": "approve_consent"])
        let started = lines.firstIndex { $0["event"] as? String == "session_started" }
        let ended = lines.firstIndex { $0["event"] as? String == "session_ended" }
        let drain = lines.firstIndex { $0["probeDrained"] != nil }
        print("OPUS R4 order startedIndex=\(String(describing: started)) endedIndex=\(String(describing: ended)) drainIndex=\(String(describing: drain)) drained=\(drained) events=\(lines.map { ($0["event"] as? String) ?? ($0["probeDrained"] != nil ? "DRAINED" : "reply#\(($0["id"] as? NSNumber)?.intValue ?? -1)") })")
        #expect(drained == 1)
        #expect(started != nil && ended != nil && started! < ended!, "session_started must precede the session_ended of the same session")
        #expect(ended != nil && drain != nil && ended! < drain!)
        #expect(core.isClosing && !core.hasSession && !core.hasOperationInFlight)
    }
}
