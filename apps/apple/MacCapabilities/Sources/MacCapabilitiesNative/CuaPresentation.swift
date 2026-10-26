import AppKit

/// One app the operator may pick in the consent panel. `handle` is a pid; the panel never looks it up.
public struct CuaSurfaceCandidate: Sendable, Equatable {
    public let label: String
    public let handle: Int32

    public init(label: String, handle: Int32) {
        self.label = label
        self.handle = handle
    }
}

/// The consent panel the operator answers. It shows exactly the candidates it is given and reports one
/// decision, at most once: the chosen candidate or a refusal. `close()` withdraws it without a decision.
/// It reads no other app, installs no input monitor and calls no Accessibility API.
@MainActor
public final class CuaConsentPanel: NSObject {
    public enum Decision: Equatable {
        case allow(CuaSurfaceCandidate)
        case deny
    }

    public let panel: NSPanel
    public let message: NSTextField
    public let popup: NSPopUpButton
    public let allowButton: NSButton
    public let denyButton: NSButton
    private let candidates: [CuaSurfaceCandidate]
    private var decide: (@MainActor (Decision) -> Void)?

    public init(botLabel: String, maxSeconds: Int, candidates: [CuaSurfaceCandidate],
                decide: @escaping @MainActor (Decision) -> Void) {
        self.candidates = candidates
        self.decide = decide
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 170),
                        styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        let minutes = max(1, maxSeconds / 60)
        message = NSTextField(wrappingLabelWithString:
            "“\(botLabel)” pede para usar um app deste Mac por até \(minutes) min. Escolha um app; nada mais será visto ou controlado. Mexer no mouse ou teclado encerra a sessão.")
        popup = NSPopUpButton(frame: .zero, pullsDown: false)
        allowButton = NSButton(title: "Permitir", target: nil, action: nil)
        denyButton = NSButton(title: "Recusar", target: nil, action: nil)
        super.init()
        panel.title = "Dexter: controle do computador"
        panel.level = .modalPanel
        panel.isReleasedWhenClosed = false
        for candidate in candidates { popup.addItem(withTitle: candidate.label) }
        allowButton.target = self
        allowButton.action = #selector(allowPressed)
        allowButton.keyEquivalent = "\r"
        allowButton.isEnabled = !candidates.isEmpty
        denyButton.target = self
        denyButton.action = #selector(denyPressed)
        denyButton.keyEquivalent = "\u{1b}"
        let buttons = NSStackView(views: [denyButton, allowButton])
        let stack = NSStackView(views: [message, popup, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        panel.contentView = stack
    }

    public func show() {
        panel.center()
        panel.orderFrontRegardless()
    }

    /// Withdraws the panel; no decision is reported.
    public func close() {
        decide = nil
        panel.orderOut(nil)
    }

    @objc private func allowPressed() {
        let index = popup.indexOfSelectedItem
        guard index >= 0, index < candidates.count else { denyPressed(); return }
        finish(.allow(candidates[index]))
    }

    @objc private func denyPressed() { finish(.deny) }

    private func finish(_ decision: Decision) {
        guard let decide else { return }
        close()
        decide(decision)
    }
}

/// The session indicator: a floating panel on every Space naming the bot and the app, with a Stop button.
/// It installs no input monitor; the native backend owns the global stop chord and takeover monitor.
@MainActor
public final class CuaSessionIndicator: NSObject {
    public let panel: NSPanel
    public let label: NSTextField
    public let stopButton: NSButton
    private let onStop: @MainActor () -> Void

    public init(botLabel: String, surfaceLabel: String, onStop: @escaping @MainActor () -> Void) {
        self.onStop = onStop
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 44),
                        styleMask: [.titled, .nonactivatingPanel, .utilityWindow], backing: .buffered, defer: false)
        label = NSTextField(labelWithString: "“\(botLabel)” controla \(surfaceLabel)")
        stopButton = NSButton(title: "Parar (⌃⌥⌘.)", target: nil, action: nil)
        super.init()
        panel.title = "Dexter"
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        stopButton.target = self
        stopButton.action = #selector(stopPressed)
        let stack = NSStackView(views: [label, stopButton])
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        panel.contentView = stack
    }

    public func show() {
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameTopLeftPoint(NSPoint(x: frame.maxX - panel.frame.width - 16, y: frame.maxY - 16))
        }
        panel.orderFrontRegardless()
    }

    /// True only while the panel is ordered in and the window server reports it at least partly visible.
    public var isVisible: Bool { panel.isVisible && panel.occlusionState.contains(.visible) }

    /// The session has ended but work already handed to the OS may still land: the panel stays up and says so.
    public func showStopping() {
        label.stringValue = "Parando: aguardando a ação já enviada terminar"
        stopButton.isEnabled = false
    }

    public func dismiss() { panel.orderOut(nil) }

    @objc private func stopPressed() { onStop() }
}
