@preconcurrency import ApplicationServices
import CoreGraphics

struct NativePermissionState: Equatable, Sendable {
    let accessibility: Bool
    let inputMonitoring: Bool
    var granted: Bool { accessibility && inputMonitoring }
}
@MainActor protocol NativePermissionRequesting {
    func current() -> NativePermissionState
    func requestAccessibility()
    func requestInputMonitoring()
}
@MainActor struct SystemNativePermissionRequester: NativePermissionRequesting {
    func current() -> NativePermissionState {
        NativePermissionState(accessibility: AXIsProcessTrusted(), inputMonitoring: CGPreflightListenEventAccess())
    }
    func requestAccessibility() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    func requestInputMonitoring() { _ = CGRequestListenEventAccess() }
}
/// The panel is responsible for accepting only a physical action in its own key window.
/// Prompt return values are never treated as grants: re-query both actual preflight states afterwards.
@MainActor struct NativePermissionPreparation {
    let requester: any NativePermissionRequesting
    func current() -> NativePermissionState { requester.current() }
    func requestAfterHumanAction() -> NativePermissionState {
        let before = requester.current()
        if !before.accessibility { requester.requestAccessibility() }
        if !before.inputMonitoring { requester.requestInputMonitoring() }
        return requester.current()
    }
}
