import AppKit
import Foundation
import MacCapabilitiesCore
import MacCapabilitiesNative

// cua-presentation-probe <evidence-dir>
// Owned synthetic UI probe for the production consent panel and session indicator. Its only surface is its
// own window; the consent candidates are only that window's own process. Clicks are mouse events posted to
// this process's own event queue and dispatched by its main run loop: UI mechanics only, not physical input,
// takeover, lock calibration or all-Spaces coverage. It installs no global input monitor and makes no
// Accessibility, screen-capture, TCC or other-app call; images are its own views rendered to bitmaps.
// Writes probe.json and PNGs into <evidence-dir>; exits 0 only if every check passed.

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 1 else { exit(2) }
let evidence = URL(fileURLWithPath: arguments[0], isDirectory: true)

@MainActor
final class Probe {
    var checks: [[String: Any]] = []
    var notes: [String: Any] = [:]
    let surfaceLabel = "Dexter Fixture Surface"
    let botLabel = "Bot Sintético"
    lazy var ownCandidate = CuaSurfaceCandidate(label: surfaceLabel, handle: ProcessInfo.processInfo.processIdentifier)

    func check(_ name: String, _ passed: Bool, _ detail: String = "") {
        checks.append(["name": name, "passed": passed, "detail": detail])
    }

    /// Runs the main run loop's event dispatch until `condition` holds or `seconds` pass.
    @discardableResult
    func pump(_ seconds: TimeInterval, until condition: () -> Bool = { false }) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() && Date() < deadline {
            if let event = NSApp.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) {
                NSApp.sendEvent(event)
            }
        }
        return condition()
    }

    /// Posts a left click on `button` to this process's own event queue; the run loop dispatches it.
    func click(_ button: NSButton) {
        guard let window = button.window else { return }
        let point = button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1,
                                              pressure: type == .leftMouseDown ? 1 : 0) {
                NSApp.postEvent(event, atStart: false)
            }
        }
    }

    /// Draws this process's own content view (PDF drawing path, then rasterized); no screen capture.
    func capture(_ window: NSWindow, _ name: String) {
        guard let view = window.contentView, let image = NSImage(data: view.dataWithPDF(inside: view.bounds)),
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        // The panel's own appearance (light or dark) behind its content, as on screen.
        window.effectiveAppearance.performAsCurrentDrawingAppearance {
            NSColor.windowBackgroundColor.setFill()
            view.bounds.fill()
        }
        image.draw(in: view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: evidence.appendingPathComponent(name))
    }

    func run() {
        // The owned surface: a plain window with synthetic text.
        let surface = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 320, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
        surface.title = surfaceLabel
        surface.isReleasedWhenClosed = false
        surface.contentView = NSTextField(labelWithString: "Conteúdo sintético do fixture")
        surface.orderFrontRegardless()
        pump(0.3)

        // Consent: deny through the event path.
        var decisions: [CuaConsentPanel.Decision] = []
        let deny = CuaConsentPanel(botLabel: botLabel, maxSeconds: 120, candidates: [ownCandidate]) { decisions.append($0) }
        deny.show()
        check("consent.visible", pump(2) { deny.panel.isVisible && deny.panel.occlusionState.contains(.visible) })
        check("consent.namesBot", deny.message.stringValue.contains(botLabel), deny.message.stringValue)
        check("consent.onlyOwnSurface", deny.popup.itemTitles == [surfaceLabel], "\(deny.popup.itemTitles)")
        capture(deny.panel, "consent.png")
        click(deny.denyButton)
        check("consent.denyByEvent", pump(2) { !decisions.isEmpty } && decisions == [.deny], "\(decisions)")
        check("consent.denyClosed", pump(1) { !deny.panel.isVisible })
        deny.denyButton.performClick(nil)
        deny.allowButton.performClick(nil)
        check("consent.decidesOnce", decisions == [.deny], "\(decisions)")

        // Consent: allow the owned surface through the event path.
        decisions = []
        let allow = CuaConsentPanel(botLabel: botLabel, maxSeconds: 120, candidates: [ownCandidate]) { decisions.append($0) }
        allow.show()
        pump(2) { allow.panel.occlusionState.contains(.visible) }
        click(allow.allowButton)
        check("consent.allowByEvent", pump(2) { !decisions.isEmpty } && decisions == [.allow(ownCandidate)], "\(decisions)")
        check("consent.allowClosed", pump(1) { !allow.panel.isVisible })

        // Consent: withdrawn without a decision.
        decisions = []
        let withdrawn = CuaConsentPanel(botLabel: botLabel, maxSeconds: 120, candidates: [ownCandidate]) { decisions.append($0) }
        withdrawn.show()
        pump(2) { withdrawn.panel.isVisible }
        withdrawn.close()
        withdrawn.allowButton.performClick(nil)
        check("consent.cancelDisappearsWithoutDecision", pump(1) { !withdrawn.panel.isVisible } && decisions.isEmpty, "\(decisions)")

        // Indicator: visible, names bot and surface, Stop through the event path, stopping state, gone.
        var stops = 0
        let indicator = CuaSessionIndicator(botLabel: botLabel, surfaceLabel: surfaceLabel) { stops += 1 }
        indicator.show()
        check("indicator.visible", pump(3) { indicator.isVisible }, "occlusion=\(indicator.panel.occlusionState.rawValue)")
        check("indicator.namesBotAndSurface", indicator.label.stringValue.contains(botLabel) && indicator.label.stringValue.contains(surfaceLabel),
              indicator.label.stringValue)
        check("indicator.allSpacesBehavior", indicator.panel.collectionBehavior.contains(.canJoinAllSpaces), "configuration only, not observed on other Spaces")
        capture(indicator.panel, "indicator.png")
        click(indicator.stopButton)
        check("indicator.stopByEvent", pump(2) { stops == 1 }, "stops=\(stops)")
        indicator.showStopping()
        pump(0.2)
        capture(indicator.panel, "indicator-stopping.png")
        check("indicator.stoppingStillVisible", indicator.isVisible && !indicator.stopButton.isEnabled, indicator.label.stringValue)
        indicator.dismiss()
        check("indicator.dismissed", pump(1) { !indicator.isVisible })

        // The shipped native backend stays inert here: refused before any panel is shown.
        var lines: [String] = []
        let core = HelperCore(backend: NativeBackend(), fixtureMode: false) { lines.append($0) }
        core.handle(line: #"{"v":2,"id":1,"op":"request_consent","botKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","botLabel":"P","maxSeconds":60,"promptSeconds":60}"#)
        pump(0.3)
        let consentWindows = NSApp.windows.filter { $0.isVisible && $0.title == "Dexter: controle do computador" }
        check("native.inertRefusesBeforePanel", (lines.first?.contains("lock_state_unknown") == true || lines.first?.contains("screen_locked") == true)
              && consentWindows.isEmpty, lines.first ?? "")

        surface.orderOut(nil)
        notes["pid"] = ProcessInfo.processInfo.processIdentifier
        notes["clickPath"] = "NSEvent leftMouseDown/Up posted to own queue, dispatched by NSApp.sendEvent from the main run loop"
        notes["globalInputMonitor"] = false
        notes["captures"] = "own content views drawn via dataWithPDF; no screen capture API"
    }
}

let passed: Bool = MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.finishLaunching()
    let probe = Probe()
    probe.run()
    let ok = probe.checks.allSatisfy { $0["passed"] as? Bool == true }
    let report: [String: Any] = ["passed": ok, "checks": probe.checks, "notes": probe.notes]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
        try? data.write(to: evidence.appendingPathComponent("probe.json"))
        FileHandle.standardOutput.write(data)
    }
    return ok
}
exit(passed ? 0 : 1)
