import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import MacCapabilitiesCore

/// Native macOS backend of the CUA helper.
///
/// - Permission: Accessibility (`AXIsProcessTrusted()`) **and** Input Monitoring
///   (`CGPreflightListenEventAccess()`), because the takeover and stop-chord monitor needs global key events.
///   Preflight never prompts. The helper's own physical owner button requests them; without both the core refuses.
/// - Lock (fail closed): `lockState` is `.unlocked` only on positive evidence. macOS documents no "screen is
///   unlocked" signal, so the documented signals (console session on console and login done,
///   `NSWorkspace` session active, displays awake) are necessary but not sufficient, and the undocumented
///   lock key and `com.apple.screenIsLocked` notification are only ever evidence of *locked* (an absent key
///   never means unlocked). Native mode requires an explicit empirical lock/unlock attempt and local
///   operator confirmation in this process. Calibration lasts at most 30 minutes and only authorizes an
///   unlocked state while the current lock key is explicitly false and all other signals agree. Macs
///   without this undocumented true/false signal stay unknown. This is not a public OS attestation.
/// - Consent: a non-activating panel listing running regular apps; the operator picks one or declines.
/// - Indicator: a floating panel on every Space naming the bot and the app, with a Stop button. The
///   session exists only while it is actually visible. The window server reports a newly ordered-in panel as
///   visible asynchronously, so `beginSession` reports readiness when the panel's occlusion state says it is
///   visible, and gives up (false) after `indicatorReadySeconds`; it never assumes visibility from a delay.
/// - Stop/takeover: the Stop button or ⌃⌥⌘. is an operator stop; any other physical mouse or keyboard
///   input seen by the global monitor is a takeover. Accessibility actions do not generate such events.
/// - Observation reads accessibility attributes of the selected app's focused window only. Secure text
///   fields never report their value and never accept `set_value`. There are no screenshots.
/// - AX reads and actions run on one serial lane off the main actor (`BackendLane`, `SurfaceReader`), so
///   Stop, takeover, lock events, the timer and stdin are handled while a slow app answers. Before the first
///   AX read and immediately before an input is handed off, the lane asks the core's authorization, which
///   re-reads every gate on the main actor, so a lock, lost permission, hidden indicator or gone app seen only
///   by polling still refuses before the effect. Ending the session invalidates the lane: a read stops before
///   its next AX call and an action that has not been handed off is not sent. An action already handed off
///   cannot be recalled; the indicator stays up, marked as stopping, until the lane has drained.
@MainActor
public final class NativeBackend: NSObject, CuaBackend {
    public var onEvent: (@MainActor (CuaBackendEvent) -> Void)?
    private var consentPanel: CuaConsentPanel?
    private var indicator: CuaSessionIndicator?
    /// The ended session's indicator, kept up while lane work it accepted may still act.
    private var stoppingIndicator: CuaSessionIndicator?
    private var inputMonitor: Any?
    /// pid of the selected app while a session runs; only its termination ends the session.
    var selectedPid: pid_t?
    private let lane = BackendLane(label: "dexter.cua.ax")
    private let reader: SurfaceReader
    private let permissionPreparation: NativePermissionPreparation
    private var lockedByNotification = false
    private var sessionActive = true
    private var screensAsleep = false
    /// Internal synthetic seam only; the shipped constructor never accepts a calibration boolean.
    private let syntheticCalibration: Bool
    private var calibrationAttempt = LockCalibrationAttempt()
    private var calibrationPanel: LockCalibrationPanel?
    private var calibrationTimer: Timer?
    private var lockEvents: UInt64 = 0
    private var observers: [NSObjectProtocol] = []
    /// Pending readiness of the current indicator; withdrawn by `endSession` or a new `beginSession`.
    private var readiness: (@MainActor (Bool) -> Void)?
    private var readinessObserver: NSObjectProtocol?
    private var readinessTimer: Timer?
    private var readinessGeneration = 0
    /// Bound on waiting for the window server to report the indicator visible; below the core's own bound.
    static let indicatorReadySeconds: TimeInterval = 3

    /// Production starts uncalibrated; no config, argv or stored preference can assert calibration.
    public convenience override init() {
        self.init(lockSignalsCalibrated: false, access: AXSurfaceAccess())
    }

    /// Tests pass a synthetic `access` so the lane and reader wiring runs without Accessibility.
    init(lockSignalsCalibrated: Bool, access: any SurfaceAccess,
         permissionRequester: any NativePermissionRequesting = SystemNativePermissionRequester()) {
        self.syntheticCalibration = lockSignalsCalibrated
        permissionPreparation = NativePermissionPreparation(requester: permissionRequester)
        reader = SurfaceReader(access: access)
        super.init()
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.lockedByNotification = true
                self?.lockEvents &+= 1
                self?.onEvent?(.screenLocked)
            }
        })
        observers.append(distributed.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.lockedByNotification = false }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.sessionActive = false
                self?.onEvent?(.screenLocked)
            }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sessionActive = true }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.screensAsleep = true
                self?.onEvent?(.screenLocked)
            }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screensAsleep = false }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated { if let pid { self?.applicationTerminated(pid) } }
        })
    }

    /// Another app quitting is not the selected surface going away.
    func applicationTerminated(_ pid: pid_t) {
        if let selectedPid, pid == selectedPid { onEvent?(.surfaceGone) }
    }

    // MARK: - state

    public var permissionsGranted: Bool { permissionPreparation.current().granted }

    public var lockState: CuaLockState {
        if lockedByNotification || !sessionActive || screensAsleep { return .locked }
        guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else { return .unknown }
        // Undocumented key: `true` is evidence of a lock; absent or anything else proves nothing.
        if (dictionary["CGSSessionScreenIsLocked"] as? Bool) == true { return .locked }
        guard let onConsole = dictionary[kCGSessionOnConsoleKey as String] as? Bool,
              let loginDone = dictionary[kCGSessionLoginDoneKey as String] as? Bool
        else { return .unknown }
        if !onConsole || !loginDone { return .locked }
        if syntheticCalibration { return .unlocked }
        let sample = calibrationSample()
        return calibrationAttempt.permitsUnlocked(sample, permissions: permissionsGranted, now: ProcessInfo.processInfo.systemUptime) ? .unlocked : .unknown
    }

    public var indicatorVisible: Bool { indicator?.isVisible ?? false }

    // MARK: - explicit process-local calibration (no sessions, AX reads or input effects)

    public func presentLockCalibration() {
        guard selectedPid == nil, !lane.isBusy, consentPanel == nil, stoppingIndicator == nil, calibrationPanel == nil else { return }
        calibrationAttempt = LockCalibrationAttempt()
        let panel = LockCalibrationPanel(begin: { [weak self] in self?.beginCalibration() },
                                         confirm: { [weak self] in self?.confirmCalibration() },
                                         cancel: { [weak self] in self?.cancelCalibration() },
                                         requestPermissions: { [weak self] in self?.requestPermissionsForOwner() ?? false })
        calibrationPanel = panel
        panel.show()
    }

    private func requestPermissionsForOwner() -> Bool {
        guard calibrationPanel != nil, selectedPid == nil, !lane.isBusy, consentPanel == nil, stoppingIndicator == nil else { return false }
        return permissionPreparation.requestAfterHumanAction().granted
    }

    private func beginCalibration() {
        guard selectedPid == nil, !lane.isBusy, consentPanel == nil, stoppingIndicator == nil else { cancelCalibration(); return }
        calibrationAttempt = LockCalibrationAttempt()
        calibrationAttempt.begin(calibrationSample(), permissions: permissionsGranted, expectedUID: getuid(), now: ProcessInfo.processInfo.systemUptime)
        calibrationPanel?.update(calibrationAttempt.phase)
        guard calibrationAttempt.phase == .waitingForLock else { return }
        calibrationTimer?.invalidate()
        calibrationTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollCalibration() }
        }
    }

    private func pollCalibration() {
        guard selectedPid == nil, !lane.isBusy, consentPanel == nil, stoppingIndicator == nil else { cancelCalibration(); return }
        calibrationAttempt.observe(calibrationSample(), permissions: permissionsGranted, now: ProcessInfo.processInfo.systemUptime)
        calibrationPanel?.update(calibrationAttempt.phase)
        if case .refused = calibrationAttempt.phase { calibrationTimer?.invalidate(); calibrationTimer = nil }
    }

    private func confirmCalibration() {
        guard selectedPid == nil, !lane.isBusy, consentPanel == nil, stoppingIndicator == nil else { cancelCalibration(); return }
        if calibrationAttempt.confirm(calibrationSample(), permissions: permissionsGranted, now: ProcessInfo.processInfo.systemUptime) {
            calibrationTimer?.invalidate(); calibrationTimer = nil
            calibrationPanel?.dismiss(); calibrationPanel = nil
        } else { calibrationPanel?.update(calibrationAttempt.phase) }
    }

    private func cancelCalibration() {
        calibrationTimer?.invalidate(); calibrationTimer = nil
        calibrationAttempt.cancel()
        calibrationPanel?.dismiss(); calibrationPanel = nil
    }

    private func calibrationSample() -> LockCalibrationSample {
        let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any]
        var displayCount: UInt32 = 0
        var displaysAwake = false
        if CGGetActiveDisplayList(0, nil, &displayCount) == .success, (1...16).contains(displayCount) {
            var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
            let result = displays.withUnsafeMutableBufferPointer { CGGetActiveDisplayList(displayCount, $0.baseAddress, &displayCount) }
            displaysAwake = result == .success && displayCount > 0 && displays.prefix(Int(displayCount)).allSatisfy {
                CGDisplayIsActive($0) != 0 && CGDisplayIsAsleep($0) == 0
            }
        }
        return LockCalibrationSample(uid: dictionary?[kCGSessionUserIDKey as String] as? UInt32,
                                     console: dictionary?[kCGSessionConsoleSetKey as String] as? UInt32,
                                     onConsole: dictionary?[kCGSessionOnConsoleKey as String] as? Bool,
                                     loginDone: dictionary?[kCGSessionLoginDoneKey as String] as? Bool,
                                     lockKey: dictionary?["CGSSessionScreenIsLocked"] as? Bool,
                                     displaysAwake: displaysAwake && !screensAsleep, sessionActive: sessionActive,
                                     notificationLocked: lockedByNotification, lockEvents: lockEvents)
    }

    // MARK: - consent

    public func presentConsent(_ request: ConsentRequest, surfaceId: String, decide: @escaping @MainActor (CuaSurface?) -> Void) {
        guard calibrationPanel == nil else { decide(nil); return }
        cancelConsent()
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let candidates = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.processIdentifier != ownPid && !$0.isTerminated }
            .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }
            .map { CuaSurfaceCandidate(label: $0.localizedName ?? $0.bundleIdentifier ?? "App", handle: $0.processIdentifier) }
        let panel = CuaConsentPanel(botLabel: request.botLabel, maxSeconds: request.maxSeconds, candidates: candidates) { [weak self] decision in
            self?.consentPanel = nil
            switch decision {
            case .allow(let candidate): decide(CuaSurface(surfaceId: surfaceId, label: candidate.label, handle: candidate.handle))
            case .deny: decide(nil)
            }
        }
        consentPanel = panel
        panel.show()
    }

    public func cancelConsent() {
        consentPanel?.close()
        consentPanel = nil
    }

    // MARK: - session

    public func beginSession(on surface: CuaSurface, botLabel: String, shown: @escaping @MainActor (Bool) -> Void) {
        guard calibrationPanel == nil else { shown(false); return }
        cancelReadiness()
        lane.invalidate()
        retireStoppingIndicator()
        let panel = CuaSessionIndicator(botLabel: botLabel, surfaceLabel: surface.label) { [weak self] in
            self?.onEvent?(.operatorStop)
        }
        panel.show()
        indicator = panel
        selectedPid = surface.handle
        inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
            let isStopChord = event.type == .keyDown && event.charactersIgnoringModifiers == "."
                && event.modifierFlags.intersection(.deviceIndependentFlagsMask).isSuperset(of: [.control, .option, .command])
            MainActor.assumeIsolated { self?.onEvent?(isStopChord ? .operatorStop : .takeover) }
        }
        // Stop and takeover work from here on; visibility is only reported, it grants nothing by itself.
        readinessGeneration += 1
        let generation = readinessGeneration
        readiness = shown
        readinessObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                                                                   object: panel.panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resolveReadiness(generation, giveUp: false) }
        }
        readinessTimer = Timer.scheduledTimer(withTimeInterval: Self.indicatorReadySeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.resolveReadiness(generation, giveUp: true) }
        }
        resolveReadiness(generation, giveUp: false)
    }

    /// Reports the current indicator once: true as soon as it is actually visible, false when the bound ran
    /// out first. A stale generation (ended or replaced session) reports nothing.
    private func resolveReadiness(_ generation: Int, giveUp: Bool) {
        guard generation == readinessGeneration, let report = readiness else { return }
        let visible = indicatorVisible
        guard visible || giveUp else { return }
        cancelReadiness()
        report(visible)
    }

    private func cancelReadiness() {
        readinessGeneration += 1
        readiness = nil
        if let observer = readinessObserver { NotificationCenter.default.removeObserver(observer) }
        readinessObserver = nil
        readinessTimer?.invalidate()
        readinessTimer = nil
    }

    public func endSession() {
        cancelReadiness()
        lane.invalidate()
        if let monitor = inputMonitor { NSEvent.removeMonitor(monitor) }
        inputMonitor = nil
        selectedPid = nil
        guard let ended = indicator else { return }
        indicator = nil
        if lane.isBusy {
            ended.showStopping()
            stoppingIndicator = ended
        } else {
            ended.dismiss()
        }
    }

    private func retireStoppingIndicator() {
        stoppingIndicator?.dismiss()
        stoppingIndicator = nil
    }

    /// Lane work came back; once nothing else is queued the stopping indicator can go.
    private func laneReturned() {
        if !lane.isBusy { retireStoppingIndicator() }
    }

    public func surfaceAlive(_ surface: CuaSurface) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: surface.handle) else { return false }
        return !app.isTerminated
    }

    // MARK: - observe / perform

    public func observe(_ surface: CuaSurface, maxNodes: Int, authorization: CuaAuthorization,
                        completion: @escaping @MainActor (CuaObserveResult) -> Void) {
        guard calibrationPanel == nil else { completion(.refused("lock_state_unknown")); return }
        let reader = reader, pid = surface.handle
        lane.submit(skipped: .refused("session_ended"), { ticket in
            reader.observe(pid: pid, maxNodes: maxNodes, ticket: ticket, authorization: authorization)
        }, completion: { [weak self] result in
            self?.laneReturned()
            completion(result)
        })
    }

    public func perform(_ surface: CuaSurface, elementId: String, action: CuaAction, value: String?, authorization: CuaAuthorization,
                        completion: @escaping @MainActor (CuaPerformResult) -> Void) {
        guard calibrationPanel == nil else { completion(.refused("lock_state_unknown")); return }
        let reader = reader, pid = surface.handle
        lane.submit(skipped: .refused("session_ended"), { ticket in
            reader.perform(pid: pid, elementId: elementId, action: action, value: value, ticket: ticket, authorization: authorization)
        }, completion: { [weak self] result in
            self?.laneReturned()
            completion(result)
        })
    }
}

/// `SurfaceAccess` over Accessibility. Stateless. `read` and `act` are one AX message each, bounded by the
/// element's messaging timeout; `setTimeout` and `pid` are local.
struct AXSurfaceAccess: SurfaceAccess {
    func application(pid: Int32) -> AnyObject { AXUIElementCreateApplication(pid) }

    func setTimeout(_ element: AnyObject, seconds: Float) -> Bool {
        guard seconds > 0, let ax = Self.ax(element) else { return false }
        return AXUIElementSetMessagingTimeout(ax, seconds) == .success
    }

    func read(_ element: AnyObject, _ attribute: SurfaceAttribute) -> SurfaceValue? {
        guard let ax = Self.ax(element) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, Self.name(attribute) as CFString, &value) == .success, let value else { return nil }
        switch attribute {
        case .focusedWindow: return Self.ax(value).map { .element($0) }
        case .windows, .children: return (value as? [AXUIElement]).map { list in .elements(list.map { $0 as AnyObject }) }
        case .enabled: return (value as? Bool).map { .flag($0) }
        case .role, .subrole, .title, .description, .value: return (value as? String).map { .text($0) }
        }
    }

    func pid(of element: AnyObject) -> Int32? {
        var pid: pid_t = 0
        guard let ax = Self.ax(element), AXUIElementGetPid(ax, &pid) == .success else { return nil }
        return pid
    }

    func act(_ element: AnyObject, _ action: CuaAction, value: String?) -> SurfaceActOutcome {
        guard let ax = Self.ax(element) else { return .invalidElement }
        let error: AXError
        switch action {
        case .press: error = AXUIElementPerformAction(ax, kAXPressAction as CFString)
        case .focus: error = AXUIElementSetAttributeValue(ax, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        case .setValue: error = AXUIElementSetAttributeValue(ax, kAXValueAttribute as CFString, (value ?? "") as CFString)
        }
        switch error {
        case .success: return .success
        case .actionUnsupported, .attributeUnsupported, .illegalArgument: return .unsupported
        case .invalidUIElement: return .invalidElement
        case .apiDisabled, .notImplemented: return .disabled
        default: return .failed
        }
    }

    private static func ax(_ object: AnyObject) -> AXUIElement? {
        CFGetTypeID(object) == AXUIElementGetTypeID() ? unsafeDowncast(object, to: AXUIElement.self) : nil
    }

    private static func name(_ attribute: SurfaceAttribute) -> String {
        switch attribute {
        case .focusedWindow: kAXFocusedWindowAttribute
        case .windows: kAXWindowsAttribute
        case .role: kAXRoleAttribute
        case .subrole: kAXSubroleAttribute
        case .title: kAXTitleAttribute
        case .description: kAXDescriptionAttribute
        case .value: kAXValueAttribute
        case .enabled: kAXEnabledAttribute
        case .children: kAXChildrenAttribute
        }
    }
}
