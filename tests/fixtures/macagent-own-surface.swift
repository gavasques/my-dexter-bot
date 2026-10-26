import AppKit
import Foundation

/// QA app only: one owned window, synthetic controls, counters in its explicitly supplied lab file.
@MainActor final class OwnSurface: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var count = 0
    private let field = NSTextField(string: "own synthetic text")
    private let label = NSTextField(labelWithString: "QA press count: 0")
    private let output: URL
    init(output: URL) { self.output = output }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 240),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Macagent Own Surface QA"
        let press = NSButton(title: "QA Press once", target: self, action: #selector(pressed))
        press.setAccessibilityIdentifier("macagent.qa.press")
        press.setAccessibilityLabel("QA Press once")
        field.setAccessibilityIdentifier("macagent.qa.field")
        field.setAccessibilityLabel("QA Synthetic field")
        let stack = NSStackView(views: [NSTextField(labelWithString: "Owned QA window only"), field, press, label])
        stack.orientation = .vertical; stack.spacing = 16; stack.alignment = .leading
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
        window.center(); window.makeKeyAndOrderFront(nil); NSApplication.shared.activate()
        save()
    }
    @objc private func pressed() { count += 1; label.stringValue = "QA press count: \(count)"; save() }
    private func save() {
        let value: [String:Any] = ["schema":"dexter.macagent-own-surface-qa/1", "pid":ProcessInfo.processInfo.processIdentifier,
                                  "pressCount":count, "text":field.stringValue, "scope":"owned QA window only"]
        if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? bytes.write(to: output, options: .atomic)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let arguments = CommandLine.arguments
// Both paths belong to the caller's fresh private QA directory; no machine-specific default.
guard arguments.count == 3, arguments[1].hasPrefix("/"), arguments[2].hasPrefix("/") else { exit(2) }
let labRoot = URL(fileURLWithPath: arguments[1], isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
let output = URL(fileURLWithPath: arguments[2]).standardizedFileURL.resolvingSymlinksInPath()
var isDirectory: ObjCBool = false
guard FileManager.default.fileExists(atPath: labRoot.path, isDirectory: &isDirectory), isDirectory.boolValue,
      output.deletingLastPathComponent() == labRoot, output.lastPathComponent == "own-window-state.json" else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = OwnSurface(output: output)
app.delegate = delegate
app.run()
