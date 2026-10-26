import AppKit
import Foundation
import MacCapabilitiesCore
import MacCapabilitiesNative

// dexter-cua-helper [--fixture]
// Spawned by the paired Mac daemon. One JSON object per line on stdin/stdout (see HelperCore). stderr is
// unused. Closing stdin ends every session and exits once backend work already handed off has come back.
// `--fixture` uses the synthetic backend: no Accessibility, screen, consent window or input monitoring.
// Native mode offers an explicit, process-local empirical lock/unlock preparation panel. Starting this
// helper grants no surface. Without a complete signal sequence and operator confirmation it stays
// unknown; absence of the undocumented lock key never proves unlocked. No calibration flag exists.

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.isEmpty || arguments == ["--fixture"] else { exit(2) }
let fixtureMode = arguments == ["--fixture"]

let stdout = FileHandle.standardOutput

@MainActor
final class CalibrationMenu: NSObject {
    static var retained: CalibrationMenu?
    private let backend: NativeBackend
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    init(backend: NativeBackend) {
        self.backend = backend
        super.init()
        item.button?.title = "Dexter CUA"
        let menu = NSMenu()
        let title = Locale.current.language.languageCode?.identifier == "pt" ? "Preparar controle de tela…" : "Prepare screen control…"
        let action = NSMenuItem(title: title, action: #selector(prepare), keyEquivalent: "")
        action.target = self
        menu.addItem(action)
        item.menu = menu
    }
    @objc private func prepare() { backend.presentLockCalibration() }
}

@MainActor
func start() -> HelperCore {
    let backend: CuaBackend = fixtureMode ? FixtureBackend() : NativeBackend()
    let core = HelperCore(backend: backend, fixtureMode: fixtureMode) { line in
        stdout.write(Data((line + "\n").utf8))
    }
    if let native = backend as? NativeBackend {
        CalibrationMenu.retained = CalibrationMenu(backend: native)
        DispatchQueue.main.async { MainActor.assumeIsolated { native.presentLockCalibration() } }
    }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in MainActor.assumeIsolated { core.tick() } }
    return core
}

let core = MainActor.assumeIsolated { start() }

// stdin is read on its own thread; each complete line is handled on the main actor, in order.
let reader = Thread {
    var buffer = Data()
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0a) {
            let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...newline)
            DispatchQueue.main.async { MainActor.assumeIsolated { core.handle(line: line) } }
        }
        if buffer.count > 64 * 1024 { break }
    }
    // Exit only after any backend read or action already handed off has come back.
    DispatchQueue.main.async {
        MainActor.assumeIsolated { core.shutdown { exit(0) } }
    }
}
reader.start()

if fixtureMode {
    RunLoop.main.run()
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
