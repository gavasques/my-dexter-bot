import AppKit

/// Own helper window only: no Accessibility, other applications, event monitor or screen capture.
@MainActor final class LockCalibrationPanel: NSObject, NSWindowDelegate {
    let panel: NSPanel
    private let message = NSTextField(wrappingLabelWithString: "")
    private let beginButton = NSButton(title: "", target: nil, action: nil)
    private let confirmButton = NSButton(title: "", target: nil, action: nil)
    private let cancelButton = NSButton(title: "", target: nil, action: nil)
    private let permissionsButton = NSButton(title: "", target: nil, action: nil)
    private let permissionStatus = NSTextField(wrappingLabelWithString: "")
    private var begin: (@MainActor () -> Void)?
    private var confirm: (@MainActor () -> Void)?
    private var cancel: (@MainActor () -> Void)?
    private var requestPermissions: (@MainActor () -> Bool)?
    private var completed = false

    init(begin: @escaping @MainActor () -> Void, confirm: @escaping @MainActor () -> Void, cancel: @escaping @MainActor () -> Void,
         requestPermissions: @escaping @MainActor () -> Bool = { false }) {
        self.begin = begin; self.confirm = confirm; self.cancel = cancel
        self.requestPermissions = requestPermissions
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 470, height: 320),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        panel.title = text("Dexter: preparar controle de tela", "Dexter: prepare screen control")
        panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        panel.delegate = self
        beginButton.title = text("Iniciar tentativa", "Start attempt")
        confirmButton.title = text("Fiz o bloqueio físico e voltei", "I physically locked and unlocked this Mac")
        cancelButton.title = text("Cancelar", "Cancel")
        permissionsButton.title = text("Solicitar permissões do macOS", "Request macOS permissions")
        permissionsButton.target = self; permissionsButton.action = #selector(permissionsPressed)
        beginButton.target = self; beginButton.action = #selector(beginPressed)
        confirmButton.target = self; confirmButton.action = #selector(confirmPressed)
        cancelButton.target = self; cancelButton.action = #selector(cancelPressed)
        cancelButton.keyEquivalent = "\u{1b}"
        let buttons = NSStackView(views: [permissionsButton, permissionStatus, beginButton, confirmButton, cancelButton])
        buttons.orientation = .vertical; buttons.alignment = .leading
        let stack = NSStackView(views: [message, buttons])
        stack.orientation = .vertical; stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        panel.contentView = stack
        update(.idle)
    }

    func show() { panel.center(); panel.makeKeyAndOrderFront(nil) }
    func dismiss() {
        completed = true; begin = nil; confirm = nil; cancel = nil; requestPermissions = nil
        panel.orderOut(nil)
    }

    func update(_ phase: LockCalibrationAttempt.Phase) {
        confirmButton.isEnabled = phase == .awaitingConfirmation
        if case .refused = phase { beginButton.isEnabled = true } else { beginButton.isEnabled = phase == .idle }
        switch phase {
        case .idle:
            message.stringValue = text("Esta tentativa não observa nem controla outros apps. Inicie, bloqueie fisicamente este Mac pelo menu Apple (ou ⌃⌘Q), desbloqueie e confirme aqui. A preparação vale só neste processo, por até 30 minutos.", "This attempt does not observe or control other apps. Start, physically lock this Mac using the Apple menu (or ⌃⌘Q), unlock it and confirm here. Preparation lasts only in this process, for up to 30 minutes.")
        case .waitingForLock:
            message.stringValue = text("Aguardando bloqueio físico e sinais coerentes. Bloqueie este Mac agora; depois desbloqueie para voltar a esta janela.", "Waiting for physical lock and consistent signals. Lock this Mac now, then unlock it to return to this window.")
        case .waitingForUnlock:
            message.stringValue = text("Sinais de bloqueio observados. Desbloqueie este Mac fisicamente e volte a esta janela.", "Lock signals observed. Physically unlock this Mac and return to this window.")
        case .awaitingConfirmation:
            message.stringValue = text("A sequência de sinais foi observada. Confirme somente se você fez o bloqueio e desbloqueio físico neste Mac. Isso não concede acesso a nenhum app ou bot.", "The signal sequence was observed. Confirm only if you physically locked and unlocked this Mac. This does not grant access to any app or bot.")
        case .calibrated:
            message.stringValue = text("Preparação confirmada neste processo. Consentimento, indicador e permissões de cada sessão continuam obrigatórios.", "Preparation confirmed in this process. Consent, indicator and permissions remain required for every session.")
        case .refused(let reason):
            switch reason {
            case .permissions:
                message.stringValue = text("Faltam Acessibilidade ou Monitoramento de Entrada para este helper. Use Solicitar permissões, confirme no macOS e depois inicie uma nova tentativa aqui.", "This helper lacks Accessibility or Input Monitoring. Use Request permissions, approve in macOS, then start another attempt here.")
            case .incompatible:
                message.stringValue = text("Este Mac não publicou os sinais explícitos necessários. O controle permanece bloqueado; ausência de sinal não comprova desbloqueio.", "This Mac did not publish the required explicit signals. Control remains blocked; a missing signal does not prove an unlocked screen.")
            case .timedOut:
                message.stringValue = text("A tentativa expirou sem a sequência completa. O controle permanece bloqueado. Inicie uma nova tentativa aqui.", "The attempt expired without the complete sequence. Control remains blocked. Start another attempt here.")
            case .incoherent, .expired:
                message.stringValue = text("Os sinais não foram suficientes ou a preparação expirou. O controle permanece bloqueado. Inicie uma nova tentativa aqui.", "Signals were insufficient or preparation expired. Control remains blocked. Start another attempt here.")
            case .cancelled:
                message.stringValue = text("Tentativa cancelada. O controle permanece bloqueado.", "Attempt cancelled. Control remains blocked.")
            }
        }
    }

    func windowWillClose(_ notification: Notification) { if !completed { cancelPressed() } }
    @objc private func beginPressed() { guard beginButton.isEnabled else { return }; begin?() }
    @objc private func confirmPressed() {
        // Local UI confirmation, not a programmatic performClick or a protocol/config assertion.
        guard confirmButton.isEnabled, panel.isKeyWindow, let event = NSApplication.shared.currentEvent,
              event.window === panel, event.type == .leftMouseUp || event.type == .keyDown,
              event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == 0 else { return }
        confirm?()
    }
    @objc private func permissionsPressed() {
        guard panel.isKeyWindow, let event = NSApplication.shared.currentEvent,
              event.window === panel, event.type == .leftMouseUp || event.type == .keyDown,
              event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == 0 else { return }
        let granted = requestPermissions?() ?? false
        permissionStatus.stringValue = granted
            ? text("Permissões confirmadas. Inicie a tentativa de bloqueio físico.", "Permissions confirmed. Start the physical lock attempt.")
            : text("O pedido foi enviado. Confirme Acessibilidade e Monitoramento de Entrada no macOS; depois clique novamente para conferir. Abrir um pedido não confirma a permissão.", "The request was sent. Approve Accessibility and Input Monitoring in macOS, then click again to check. Opening a request does not confirm permission.")
    }
    @objc private func cancelPressed() { let callback = cancel; dismiss(); callback?() }
    private func text(_ pt: String, _ en: String) -> String { Locale.current.language.languageCode?.identifier == "pt" ? pt : en }
}
