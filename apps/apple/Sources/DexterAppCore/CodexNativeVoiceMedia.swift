#if os(macOS)
import AppKit
import AVFoundation
import Foundation
import WebKit

public enum CodexVoiceMediaFailure: String, Error, Sendable {
    case cancelled, microphonePermissionRequired, audioUnavailable, connectionLost, protocolRejected, deadline, cleanupPending
}

/// One explicit call owns one media instance. Construction never opens a microphone or a network connection.
@MainActor public protocol CodexVoiceMedia: AnyObject {
    var onFailure: (@MainActor (CodexVoiceMediaFailure) -> Void)? { get set }
    var onConnected: (@MainActor () -> Void)? { get set }
    func prepareOffer() async throws -> String
    func accept(answer: String) async throws
    func setMuted(_ muted: Bool)
    /// False means capture shutdown has not been confirmed. Retain this instance and the visible call state.
    func close() async -> Bool
}

/// WebKit's native WebRTC media path, following Noodle's Apache-2.0 implementation. The page is local,
/// nonpersistent and cannot navigate to a remote document. Only the host's private SDP exchange connects it.
@MainActor public final class NativeCodexVoiceMedia: NSObject, CodexVoiceMedia, WKNavigationDelegate, WKUIDelegate {
    public var onFailure: (@MainActor (CodexVoiceMediaFailure) -> Void)?
    public var onConnected: (@MainActor () -> Void)?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var loading: CheckedContinuation<Void, Error>?
    private var loadDeadline: Task<Void, Never>?
    private var closing: Task<Bool, Never>?
    private var closed = false
    private var captureStopped = false
    private var announcedConnection = false

    public override init() { super.init() }

    public func prepareOffer() async throws -> String {
        guard !closed, webView == nil else { throw CodexVoiceMediaFailure.cancelled }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .audio) else { throw CodexVoiceMediaFailure.microphonePermissionRequired }
        default: throw CodexVoiceMediaFailure.microphonePermissionRequired
        }
        guard !closed, !Task.isCancelled else { throw CodexVoiceMediaFailure.cancelled }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(MessageRelay(self), name: "dexterVoice")
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        // An attached view keeps native WebRTC audio running; it is neither a browser nor a consent surface.
        let mediaWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
                                   styleMask: .borderless, backing: .buffered, defer: false)
        mediaWindow.isReleasedWhenClosed = false
        mediaWindow.alphaValue = 0
        mediaWindow.ignoresMouseEvents = true
        mediaWindow.isExcludedFromWindowsMenu = true
        mediaWindow.collectionBehavior = [.canJoinAllSpaces, .transient, .ignoresCycle]
        mediaWindow.contentView = view
        mediaWindow.orderFrontRegardless()
        window = mediaWindow
        webView = view
        try await withCheckedThrowingContinuation { continuation in
            loading = continuation
            loadDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                self?.finishLoading(CodexVoiceMediaFailure.deadline)
            }
            view.loadHTMLString(CodexNativeVoicePage.page, baseURL: CodexNativeVoicePage.origin)
        }
        guard !closed, !Task.isCancelled, view === webView else { throw CodexVoiceMediaFailure.cancelled }
        let result: Any?
        do { result = try await view.callAsyncJavaScript("return await offer()", contentWorld: .page) }
        catch { throw CodexVoiceMediaFailure.audioUnavailable }
        guard !closed, !Task.isCancelled, view === webView else { throw CodexVoiceMediaFailure.cancelled }
        guard let sdp = result as? String, sdp.hasPrefix("v=0"), sdp.utf8.count <= 65_536 else {
            throw CodexVoiceMediaFailure.protocolRejected
        }
        return sdp
    }

    public func accept(answer: String) async throws {
        guard !closed, let view = webView, answer.hasPrefix("v=0"), answer.utf8.count <= 65_536 else {
            throw CodexVoiceMediaFailure.protocolRejected
        }
        do { _ = try await view.callAsyncJavaScript("await answer(sdp); return true", arguments: ["sdp": answer], contentWorld: .page) }
        catch { throw CodexVoiceMediaFailure.connectionLost }
        guard !closed, view === webView else { throw CodexVoiceMediaFailure.cancelled }
    }

    public func setMuted(_ muted: Bool) {
        guard !closed else { return }
        // The microphone remains local while muted; the gain sends silence/noise floor, never microphone samples.
        webView?.evaluateJavaScript(muted ? "mute(true)" : "mute(false)")
    }

    public func close() async -> Bool {
        if captureStopped { return true }
        if let closing { return await closing.value }
        closed = true
        onConnected = nil
        onFailure = nil
        finishLoading(CodexVoiceMediaFailure.cancelled)
        guard let view = webView else { captureStopped = true; return true }
        view.configuration.userContentController.removeScriptMessageHandler(forName: "dexterVoice")
        queuePageShutdown(view)
        let operation = Task { [weak self] in
            await withCheckedContinuation { continuation in
                var answered = false
                var timeout: Task<Void, Never>?
                // Native WebKit stop is independent of the JavaScript cleanup and confirms microphone shutdown.
                view.setMicrophoneCaptureState(.none) { [weak self] in
                    self?.captureStopped = true
                    self?.release(view)
                    timeout?.cancel()
                    if !answered { answered = true; continuation.resume(returning: true) }
                }
                timeout = Task {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    if !answered { answered = true; continuation.resume(returning: false) }
                }
            }
        }
        closing = operation
        return await operation.value
    }

    private func release(_ view: WKWebView) {
        guard view === webView else { return }
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        webView = nil
    }
    private func queuePageShutdown(_ view: WKWebView) {
        // Queue page cleanup while the native capture-stop request independently drains below.
        view.evaluateJavaScript("hangUp(); true", completionHandler: nil)
    }

    public func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if view === webView, !closed { finishLoading(nil) }
    }
    public func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if view === webView { finishLoading(CodexVoiceMediaFailure.audioUnavailable) }
    }
    public func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if view === webView { finishLoading(CodexVoiceMediaFailure.audioUnavailable) }
    }
    public func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard view === webView, !closed, let url = action.request.url else { return .cancel }
        return url.absoluteString == "about:blank" || url == CodexNativeVoicePage.origin ? .allow : .cancel
    }
    public func webView(_ view: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
                        initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        guard view === webView, !closed, frame.isMainFrame, type == .microphone,
              origin.protocol == "https", origin.host == "voice.dexter.invalid", origin.port == 443 || origin.port == 0 else { return .deny }
        return .grant
    }
    private func finishLoading(_ error: Error?) {
        loadDeadline?.cancel()
        loadDeadline = nil
        guard let continuation = loading else { return }
        loading = nil
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }
    fileprivate func received(_ message: WKScriptMessage) {
        guard !closed, message.webView === webView, message.frameInfo.isMainFrame,
              let value = message.body as? [String: Bool], value.count == 1 else { return }
        if value["failed"] == true { onFailure?(.connectionLost) }
        else if value["connected"] == true, !announcedConnection {
            announcedConnection = true
            onConnected?()
        }
    }
    private final class MessageRelay: NSObject, WKScriptMessageHandler {
        weak var media: NativeCodexVoiceMedia?
        init(_ media: NativeCodexVoiceMedia) { self.media = media }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated { media?.received(message) }
        }
    }
}
#endif
