import Foundation
import Testing
@testable import MacCapabilitiesCore

@MainActor
final class Harness {
    let backend = FixtureBackend()
    var now = Date(timeIntervalSince1970: 1_000_000)
    var lines: [[String: Any]] = []
    var counter = 0
    lazy var core = HelperCore(backend: backend, fixtureMode: true, clock: { [unowned self] in self.now },
                               randomHex: { [unowned self] in self.counter += 1; return String(repeating: String(self.counter % 10), count: 32) },
                               output: { [unowned self] line in
                                   self.lines.append(try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any])
                               })
    var nextId = 0

    @discardableResult
    func send(_ message: [String: Any]) -> [String: Any] {
        nextId += 1
        var m = message
        m["v"] = cuaProtocolVersion
        m["id"] = nextId
        let data = try! JSONSerialization.data(withJSONObject: m)
        core.handle(line: String(decoding: data, as: UTF8.self))
        return lines.last { ($0["id"] as? Int) == nextId } ?? [:]
    }
    func events(_ name: String) -> [[String: Any]] { lines.filter { $0["event"] as? String == name } }
    let botKey = String(repeating: "a", count: 32)

    /// Requests consent and has the fixture operator approve it. Returns (sessionId, surfaceId).
    func startSession(seconds: Int = 60) -> (String, String) {
        let r = send(["op": "request_consent", "botKey": botKey, "botLabel": "Pesquisa", "maxSeconds": seconds, "promptSeconds": 60])
        precondition(r["ok"] as? Bool == true)
        precondition(backend.apply("approve_consent"))
        let session = events("session_started").last!["session"] as! [String: Any]
        return (session["sessionId"] as! String, session["surfaceId"] as! String)
    }
}

@MainActor
@Suite struct HelperCoreTests {
    @Test func noSessionWithoutOperatorConsent() {
        let h = Harness()
        let observe = h.send(["op": "observe", "sessionId": "cus_" + String(repeating: "1", count: 32), "surfaceId": "srf_" + String(repeating: "1", count: 32), "maxNodes": 5])
        #expect(observe["ok"] as? Bool == false)
        #expect(observe["code"] as? String == "no_session")
        #expect(observe["effect"] as? String == "none")
        _ = h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])
        #expect(h.backend.consentShown?.botLabel == "Pesquisa")
        #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Outro", "maxSeconds": 60, "promptSeconds": 60])["code"] as? String == "busy")
        #expect(h.backend.apply("deny_consent"))
        #expect(h.events("consent_denied").count == 1)
        #expect(h.events("session_started").isEmpty)
        #expect(h.backend.indicatorVisible == false)
    }

    @Test func sessionShowsIndicatorAndOnlyActsOnSelectedSurface() {
        let h = Harness()
        let (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.indicatorVisible)
        let observed = h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 1])
        #expect(observed["ok"] as? Bool == true)
        #expect((observed["nodes"] as? [[String: Any]])?.count == 1)
        #expect(observed["truncated"] as? Bool == true)
        let wrong = h.send(["op": "control", "sessionId": sessionId, "surfaceId": "srf_" + String(repeating: "f", count: 32), "elementId": "el_1", "action": "press"])
        #expect(wrong["code"] as? String == "surface_mismatch")
        let press = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"])
        #expect(press["performed"] as? Bool == true)
        let bad = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "set_value", "value": "x"])
        #expect(bad["code"] as? String == "element_unsupported")
        let typed = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_2", "action": "set_value", "value": "olá"])
        #expect(typed["performed"] as? Bool == true)
        #expect(h.backend.performed.count == 2)
        // Raw coordinates, shell or extra fields are not part of the protocol.
        for message: [String: Any] in [
            ["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "click_xy"],
            ["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press", "x": 10],
            ["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_2", "action": "set_value", "value": "a\nb"],
            ["op": "screenshot", "sessionId": sessionId],
        ] {
            #expect(h.send(message)["ok"] as? Bool == false)
        }
        #expect(h.backend.performed.count == 2)
    }

    @Test func lockAndPermissionRefuseBeforeInputAndEndTheSession() {
        let h = Harness()
        var (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("lock"))
        #expect(h.events("session_ended").last?["reason"] as? String == "screen_locked")
        let locked = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"])
        #expect(locked["code"] as? String == "no_session")
        #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])["code"] as? String == "screen_locked")
        #expect(h.backend.apply("unlock"))
        (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("revoke_permission"))
        #expect(h.events("session_ended").last?["reason"] as? String == "permission_lost")
        #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])["code"] as? String == "permission_missing")
        #expect(h.backend.performed.isEmpty)
        #expect(h.backend.indicatorVisible == false)
    }

    @Test func stopTakeoverExpiryAndDaemonExitEndSessions() {
        let h = Harness()
        var (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("stop"))
        #expect(h.events("session_ended").last?["reason"] as? String == "operator_stop")
        #expect(h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 2])["code"] as? String == "no_session")
        (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("takeover"))
        #expect(h.events("session_ended").last?["reason"] as? String == "takeover")
        (sessionId, surfaceId) = h.startSession(seconds: 30)
        h.now = h.now.addingTimeInterval(31)
        #expect(h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 2])["code"] as? String == "no_session")
        #expect(h.events("session_ended").last?["reason"] as? String == "expired")
        (sessionId, surfaceId) = h.startSession()
        h.core.shutdown()
        #expect(h.events("session_ended").last?["reason"] as? String == "daemon")
        #expect(h.backend.indicatorVisible == false)
    }

    @Test func hiddenIndicatorOrGoneSurfaceBlocksAndUnconfirmedInputIsUnknown() {
        let h = Harness()
        #expect(h.backend.apply("break_indicator"))
        _ = h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])
        #expect(h.backend.apply("approve_consent"))
        #expect(h.events("session_started").isEmpty, "no session without a visible indicator")
        let h2 = Harness()
        let (sessionId, surfaceId) = h2.startSession()
        #expect(h2.backend.apply("fail_next_perform"))
        let r = h2.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"])
        #expect(r["effect"] as? String == "unknown")
        #expect(h2.backend.apply("close_surface"))
        #expect(h2.events("session_ended").last?["reason"] as? String == "surface_gone")
    }

    @Test func malformedLinesAndFixtureOpsOutsideFixtureModeAreRefused() {
        let backend = FixtureBackend()
        var out: [String] = []
        let core = HelperCore(backend: backend, fixtureMode: false) { out.append($0) }
        core.handle(line: "not json")
        core.handle(line: #"{"v":1,"id":1,"op":"status"}"#)
        core.handle(line: #"{"v":2,"id":true,"op":"status"}"#)
        core.handle(line: String(repeating: "x", count: 70_000))
        #expect(out.count == 4)
        #expect(out.allSatisfy { $0.contains("protocol_error") })
        core.handle(line: #"{"v":2,"id":7,"op":"fixture","command":"approve_consent"}"#)
        #expect(out.last?.contains("unsupported_op") == true)
        core.handle(line: #"{"v":2,"id":8,"op":"status"}"#)
        #expect(out.last?.contains(#""session":null"#) == true)
    }

    // MARK: - R3: polled gates without events, prompt deadline, check and cancel

    /// Each silent state is only visible by polling: no backend event fires, so only the core's own gate
    /// read before the effect can refuse it.
    @Test func silentLockPermissionAndIndicatorRefuseBeforeAnyEffect() {
        for (command, code, reason) in [("lock_silent", "screen_locked", "screen_locked"),
                                        ("lock_unknown_silent", "lock_state_unknown", "lock_state_unknown"),
                                        ("revoke_permission_silent", "permission_missing", "permission_lost"),
                                        ("hide_indicator_silent", "indicator_hidden", nil)] as [(String, String, String?)] {
            let h = Harness()
            let (sessionId, surfaceId) = h.startSession()
            let endedBefore = h.events("session_ended").count
            #expect(h.backend.apply(command))
            #expect(h.events("session_ended").count == endedBefore, "\(command) emits no event by itself")
            let control = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"])
            #expect(control["code"] as? String == code, "\(command)")
            #expect(control["effect"] as? String == "none")
            let observe = h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 2])
            #expect(observe["ok"] as? Bool == false, "\(command)")
            #expect(observe["nodes"] == nil)
            let check = h.send(["op": "check", "sessionId": sessionId, "surfaceId": surfaceId])
            #expect(check["ok"] as? Bool == false, "\(command)")
            #expect(h.backend.performed.isEmpty, "\(command)")
            if let reason { #expect(h.events("session_ended").last?["reason"] as? String == reason, "\(command)") }
        }
    }

    @Test func aRefusalReplyIsWrittenBeforeTheSessionEndItCaused() {
        let h = Harness()
        let (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("lock_silent"))
        let before = h.lines.count
        let reply = h.send(["op": "control", "sessionId": sessionId, "surfaceId": surfaceId, "elementId": "el_1", "action": "press"])
        #expect(reply["code"] as? String == "screen_locked")
        let written = Array(h.lines[before...])
        #expect(written.count == 2)
        #expect(written.first?["id"] != nil, "reply first")
        #expect(written.last?["event"] as? String == "session_ended")
    }

    @Test func lockArrivingDuringObservationReleasesNothingAndEndsTheSession() {
        let h = Harness()
        let (sessionId, surfaceId) = h.startSession()
        #expect(h.backend.apply("lock_during_observe"))
        let observe = h.send(["op": "observe", "sessionId": sessionId, "surfaceId": surfaceId, "maxNodes": 2])
        #expect(observe["ok"] as? Bool == false)
        #expect(observe["code"] as? String == "screen_locked")
        #expect(observe["nodes"] == nil)
        #expect(h.events("session_ended").last?["reason"] as? String == "screen_locked")
        #expect(h.core.hasSession == false)
    }

    @Test func silentStateWhilePromptIsOpenStartsNoSessionOnApproval() {
        for command in ["lock_silent", "lock_unknown_silent", "revoke_permission_silent"] {
            let h = Harness()
            #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])["ok"] as? Bool == true)
            #expect(h.backend.apply(command))
            #expect(h.backend.apply("approve_consent"))
            #expect(h.events("session_started").isEmpty, "\(command)")
            #expect(h.events("consent_denied").count == 1, "\(command)")
            #expect(h.backend.indicatorVisible == false)
        }
        // And a prompt is not shown at all while the lock state is unknown.
        let h = Harness()
        #expect(h.backend.apply("lock_unknown_silent"))
        #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])["code"] as? String == "lock_state_unknown")
        #expect(h.backend.consentShown == nil)
    }

    @Test func ignoredPromptExpiresAndALateApprovalStartsNothing() {
        let h = Harness()
        let reply = h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 30])
        #expect(reply["ok"] as? Bool == true)
        #expect(reply["promptExpiresAt"] as? Int == 1_000_030_000)
        // Another bot is busy only while the prompt is open.
        let other = String(repeating: "b", count: 32)
        #expect(h.send(["op": "request_consent", "botKey": other, "botLabel": "Outro", "maxSeconds": 60, "promptSeconds": 30])["code"] as? String == "busy")
        h.now = h.now.addingTimeInterval(30)
        h.core.tick()
        #expect(h.events("consent_expired").last?["botKey"] as? String == h.botKey)
        #expect(h.backend.apply("approve_consent") == false, "the prompt was withdrawn")
        #expect(h.events("session_started").isEmpty)
        #expect(h.send(["op": "request_consent", "botKey": other, "botLabel": "Outro", "maxSeconds": 60, "promptSeconds": 30])["ok"] as? Bool == true)
        // A decision delivered after the deadline but before the next tick is refused by the decision itself.
        h.now = h.now.addingTimeInterval(31)
        #expect(h.backend.apply("approve_consent"))
        #expect(h.events("session_started").isEmpty)
        #expect(h.events("consent_denied").last?["botKey"] as? String == other)
        // Prompt bounds are part of the protocol.
        for bad in [0, 301] {
            #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "P", "maxSeconds": 60, "promptSeconds": bad])["code"] as? String == "invalid_input")
        }
        #expect(h.send(["op": "request_consent", "botKey": h.botKey, "botLabel": "P", "maxSeconds": 60])["code"] as? String == "invalid_input")
    }

    @Test func checkReportsOnlyTheAskedSessionAndCancelWithdrawsOnlyThatBotsPrompt() {
        let h = Harness()
        let (sessionId, surfaceId) = h.startSession()
        let check = h.send(["op": "check", "sessionId": sessionId, "surfaceId": surfaceId])
        #expect(check["ok"] as? Bool == true)
        #expect(check["expiresAt"] as? Int == 1_000_060_000)
        #expect(Set(check.keys) == ["ok", "expiresAt", "id", "v"], "no label, app or other session")
        #expect(h.send(["op": "check", "sessionId": "cus_" + String(repeating: "0", count: 32), "surfaceId": surfaceId])["code"] as? String == "no_session")
        #expect(h.send(["op": "check", "sessionId": sessionId, "surfaceId": "srf_" + String(repeating: "f", count: 32)])["code"] as? String == "surface_mismatch")
        #expect(h.send(["op": "check", "sessionId": sessionId, "surfaceId": surfaceId, "x": 1])["code"] as? String == "invalid_input")
        #expect(h.backend.performed.isEmpty)

        let p = Harness()
        _ = p.send(["op": "request_consent", "botKey": p.botKey, "botLabel": "Pesquisa", "maxSeconds": 60, "promptSeconds": 60])
        #expect(p.send(["op": "cancel_consent", "botKey": String(repeating: "c", count: 32)])["ok"] as? Bool == true)
        #expect(p.events("consent_denied").isEmpty, "another bot's cancel leaves the prompt")
        #expect(p.send(["op": "cancel_consent", "botKey": p.botKey])["ok"] as? Bool == true)
        #expect(p.events("consent_denied").last?["botKey"] as? String == p.botKey)
        #expect(p.backend.apply("approve_consent") == false)
        #expect(p.events("session_started").isEmpty)
    }
}
