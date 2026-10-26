import Foundation
import Testing
@testable import MacCapabilitiesCore

/// Synthetic callback contract probes only; no GUI, Accessibility or permissions.
@MainActor @Suite struct RootR5ReentrantReplyTests {
    @Test func nestedEndRequestFromApprovalReplyKeepsStartBeforeEnd() {
        let backend = FixtureBackend()
        var lines: [[String: Any]] = []
        var core: HelperCore!
        var endOnApproval = false
        core = HelperCore(backend: backend, fixtureMode: true) { line in
            let object = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            lines.append(object)
            if endOnApproval, (object["id"] as? NSNumber)?.intValue == 2 {
                endOnApproval = false
                Self.send(core, ["v": 2, "id": 3, "op": "status"])
                let reply = lines.first { ($0["id"] as? NSNumber)?.intValue == 3 }!
                let state = reply["state"] as! [String: Any]
                let session = state["session"] as! [String: Any]
                Self.send(core, ["v": 2, "id": 4, "op": "end_session",
                                 "sessionId": session["sessionId"] as! String, "reason": "daemon"])
            }
        }
        Self.send(core, ["v": 2, "id": 1, "op": "request_consent", "botKey": String(repeating: "a", count: 32),
                         "botLabel": "Synthetic", "maxSeconds": 60, "promptSeconds": 60])
        endOnApproval = true
        Self.send(core, ["v": 2, "id": 2, "op": "fixture", "command": "approve_consent"])
        let started = lines.firstIndex { $0["event"] as? String == "session_started" }
        let ended = lines.firstIndex { $0["event"] as? String == "session_ended" }
        #expect(started != nil && ended != nil && started! < ended!)
        #expect(lines.filter { $0["event"] as? String == "session_started" }.count == 1)
        #expect(lines.filter { $0["event"] as? String == "session_ended" }.count == 1)
        #expect(!core.isClosing && !core.hasSession && !core.hasOperationInFlight)
        var drained = 0
        core.shutdown { drained += 1 }
        #expect(drained == 1)
    }

    @Test func shutdownFromDequeuedStartEventWaitsForOutputAndQueuedEnd() {
        let backend = FixtureBackend()
        var lines: [[String: Any]] = []
        var core: HelperCore!
        var drained = 0
        core = HelperCore(backend: backend, fixtureMode: true) { line in
            let object = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
            lines.append(object)
            if object["event"] as? String == "session_started" {
                core.shutdown { drained += 1; lines.append(["probeDrained": true]) }
                Self.send(core, ["v": 2, "id": 3, "op": "status"])
                lines.append(["startOutputReturned": true])
            }
        }
        Self.send(core, ["v": 2, "id": 1, "op": "request_consent", "botKey": String(repeating: "b", count: 32),
                         "botLabel": "Synthetic", "maxSeconds": 60, "promptSeconds": 60])
        Self.send(core, ["v": 2, "id": 2, "op": "fixture", "command": "approve_consent"])
        let started = lines.firstIndex { $0["event"] as? String == "session_started" }
        let returned = lines.firstIndex { $0["startOutputReturned"] != nil }
        let ended = lines.firstIndex { $0["event"] as? String == "session_ended" }
        let drain = lines.firstIndex { $0["probeDrained"] != nil }
        #expect(started != nil && ended != nil && started! < ended!)
        #expect(returned != nil && ended != nil && returned! < ended!)
        #expect(ended != nil && drain != nil && ended! < drain!)
        #expect(lines.first { ($0["id"] as? NSNumber)?.intValue == 3 }?["code"] as? String == "session_ended")
        #expect(drained == 1 && core.isClosing && !core.hasSession && !core.hasOperationInFlight)
    }

    private static func send(_ core: HelperCore, _ message: [String: Any]) {
        core.handle(line: String(decoding: try! JSONSerialization.data(withJSONObject: message), as: UTF8.self))
    }
}
