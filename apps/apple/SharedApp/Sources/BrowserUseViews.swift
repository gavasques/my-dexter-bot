#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Ajustes › Conexões › Navegador na nuvem (UX-P0-03): one card, one state, one main action. The key stays in this
/// Mac's Keychain and reaches only the base this app started, through its private channel; nothing here starts a browser.
@MainActor struct BrowserUseSettingsSection: View {
    let localHost: LocalHostLaunchCoordinator?
    @Environment(DexterAppModel.self) private var model
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @State private var editor: BrowserUseSettingsEditor?
    @State private var controller: BrowserUseConnectionController?
    @State private var showsConnect = false
    @State private var confirmsDisconnect = false
    private let keyStore: any BrowserUseAPIKeyStore
    init(localHost: LocalHostLaunchCoordinator?, keyStore: any BrowserUseAPIKeyStore = ScopedBrowserUseAPIKeychain()) {
        self.localHost = localHost; self.keyStore = keyStore
    }
    private var scope: String { "\(model.nativeComposerScope)|\(model.hostAddress)" }

    var body: some View {
        Section {
            if let controller {
                BrowserUseConnectionCard(controller: controller, connect: { showsConnect = true },
                                         disconnect: { confirmsDisconnect = true },
                                         openAdvanced: { router?.settingsTab = .advanced })
            } else {
                ProgressView().controlSize(.small)
            }
        } header: {
            Text("Navegador na nuvem")
        } footer: {
            Text("Cada bot precisa ser liberado, com seus sites, em Ajustes do bot › Navegador. Cada tarefa ainda pede Permitir ou Negar no chat.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .task(id: scope) {
            editor?.close()
            let nextEditor = BrowserUseSettingsEditor(model: model)
            let next = BrowserUseConnectionController(model: model, editor: nextEditor, keyStore: keyStore,
                bridge: LocalHostBrowserUseKeyBridge(coordinator: localHost, model: model))
            editor = nextEditor; controller = next
            nextEditor.openIfNeeded()
        }
        .onChange(of: editor?.baseline?.hostID) { _, _ in controller?.refreshKeyStatus() }
        .onDisappear { editor?.close() }
        .sheet(isPresented: $showsConnect) {
            if let controller { BrowserUseConnectSheet(controller: controller) }
        }
        .confirmationDialog("Desconectar o Browser Use?", isPresented: $confirmsDisconnect, titleVisibility: .visible) {
            Button("Desconectar", role: .destructive) { Task { await controller?.disconnect() } }
                .accessibilityIdentifier("settings.browser-use.disconnect.confirm")
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("A conexão desta base é pausada e, se a pausa for confirmada, a chave é apagada deste Mac. Outras bases não mudam. Para usar de novo, conecte com uma chave.")
        }
    }
}

@MainActor private struct BrowserUseConnectionCard: View {
    @Bindable var controller: BrowserUseConnectionController
    let connect: () -> Void
    let disconnect: () -> Void
    let openAdvanced: () -> Void

    var body: some View {
        let state = controller.state
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "globe").font(.system(size: 18, weight: .medium))
                    .frame(width: 34, height: 34)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: "Browser Use").font(.headline)
                    statusLine(state).font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("settings.browser-use.state")
                }
                Spacer(minLength: 8)
                if controller.busy { ProgressView().controlSize(.small) }
                primaryAction(state)
                moreMenu(state)
            }
            .accessibilityElement(children: .contain)
            if let runtime = controller.editor.runtime, !runtime.available {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary).accessibilityHidden(true)
                    Text("Para os bots usarem o navegador, as Ferramentas do Dexter precisam estar ligadas nesta base.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Abrir Avançado", action: openAdvanced).controlSize(.small)
                        .accessibilityIdentifier("settings.browser-use.tools-prerequisite")
                }
            }
            if let runtime = controller.editor.runtime, runtime.activeTasks > 0 {
                let tasks = String(runtime.activeTasks)
                Text("Tarefas em execução: \(tasks)").font(.callout)
            }
            if controller.editor.runtime?.cleanupPending == true {
                Text("O encerramento de uma tarefa ainda não foi confirmado.").font(.callout).foregroundStyle(.orange)
            }
            if let outcome = controller.outcome, let text = outcomeText(outcome) {
                Text(text).font(.callout).foregroundStyle(outcomeIsWarning(outcome) ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("settings.browser-use.outcome")
            }
        }
        .padding(.vertical, 4)
        .onAppear { controller.refreshKeyStatus() }
    }

    @ViewBuilder private func statusLine(_ state: BrowserUseConnectionState) -> some View {
        switch state {
        case .checking: Text("Consultando…")
        case .unavailableHere: Text("Disponível só na base que este app inicia neste Mac.")
        case .storageUnavailable: Text("O armazenamento seguro deste Mac não respondeu.")
        case .notConnected: Text("Não conectado")
        case .needsReconnect: Text("Precisa reconectar · a conexão expira em 1 hora e quando a base reinicia")
        case .paused: Text("Pausado por você")
        case .cannotConfirm: Text("Não foi possível confirmar a conexão")
        case .needsEnable: Text("Chave conectada · desativado nesta base")
        case .connected: Text("Conectado")
        }
    }

    @ViewBuilder private func primaryAction(_ state: BrowserUseConnectionState) -> some View {
        switch state {
        case .notConnected:
            Button("Conectar…", action: connect).buttonStyle(.borderedProminent)
                .disabled(controller.busy || !controller.canDeliver)
                .accessibilityIdentifier("settings.browser-use.connect")
        case .needsReconnect, .paused:
            Button("Reconectar") { Task { await controller.reconnect() } }.buttonStyle(.borderedProminent)
                .disabled(controller.busy).accessibilityIdentifier("settings.browser-use.reconnect")
        case .needsEnable:
            Button("Ativar") { Task { await controller.enable() } }.buttonStyle(.borderedProminent)
                .disabled(controller.busy || !controller.editor.scopeMatches).accessibilityIdentifier("settings.browser-use.enable")
        case .cannotConfirm:
            Button("Conferir") { Task { await controller.check() } }
                .disabled(controller.busy).accessibilityIdentifier("settings.browser-use.check")
        case .storageUnavailable:
            Button("Tentar de novo") { controller.refreshKeyStatus() }
                .disabled(controller.busy).accessibilityIdentifier("settings.browser-use.retry-storage")
        case .checking, .unavailableHere, .connected:
            EmptyView()
        }
    }

    @ViewBuilder private func moreMenu(_ state: BrowserUseConnectionState) -> some View {
        if state != .checking && state != .unavailableHere {
            Menu {
                Button("Pausar conexão") { Task { await controller.pause() } }
                    .disabled(!(state == .connected || state == .needsEnable) || controller.busy)
                    .accessibilityIdentifier("settings.browser-use.pause")
                Button("Conferir estado") { Task { await controller.check() } }
                    .disabled(controller.busy)
                    .accessibilityIdentifier("settings.browser-use.check-menu")
                Divider()
                Button("Desconectar…", role: .destructive, action: disconnect)
                    .disabled(controller.keyStatus != .configured || controller.busy)
                    .accessibilityIdentifier("settings.browser-use.disconnect")
            } label: {
                Image(systemName: "ellipsis.circle").accessibilityLabel(Text("Mais opções do Browser Use"))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityIdentifier("settings.browser-use.more")
        }
    }

    private func outcomeIsWarning(_ outcome: BrowserUseConnectionController.Outcome) -> Bool {
        switch outcome {
        case .connected, .reconnected, .enabled, .paused, .disconnected, .checked: false
        default: true
        }
    }

    private func outcomeText(_ outcome: BrowserUseConnectionController.Outcome) -> LocalizedStringKey? {
        switch outcome {
        case .connected: "Conectado. Nenhum navegador foi iniciado; cada tarefa pede Permitir no chat."
        case .reconnected: "Reconectado. Nenhuma tarefa foi iniciada ou repetida."
        case .enabled: "Ativado nesta base. Cada bot ainda precisa ser liberado com seus sites."
        case .paused: "Pausado. A chave continua guardada neste Mac; Reconectar volta a entregá-la."
        case .disconnected: "Desconectado. A chave foi apagada deste Mac; outras bases não mudaram."
        case .checked: nil
        case .notThisMac: "Este app só entrega a chave à base que ele mesmo iniciou neste Mac."
        case .invalidKey: "Confira a chave: ela não parece uma chave privada do Browser Use."
        case .storageFailed: "O armazenamento seguro deste Mac não confirmou a operação. Nada foi entregue à base."
        case .deliveryFailed: "A base deste Mac não recebeu a chave. Nada foi ativado."
        case .deliveryUnconfirmed: "Não foi possível confirmar a entrega da chave. Nada foi reenviado; use Conferir antes de tentar de novo."
        case .enableConflict: "A configuração mudou na base. Nada foi reenviado; confira e ative de novo."
        case .enableUnconfirmed: "Não foi possível confirmar a ativação. Nada foi reenviado; use Conferir."
        case .lockUnconfirmed: "A pausa não foi confirmada pela base. A chave continua guardada; use Conferir."
        }
    }
}

/// Conectar Browser Use: what it is, its own cost and the absence of this Mac's logins, before the key field. Each step
/// shows its own confirmed result; there is no rollback across steps and nothing is re-sent automatically.
@MainActor private struct BrowserUseConnectSheet: View {
    @Bindable var controller: BrowserUseConnectionController
    @Environment(\.dismiss) private var dismiss
    @State private var keyDraft = ""
    @State private var started = false
    @FocusState private var keyFocused: Bool

    private var finished: Bool { controller.outcome == .connected }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Conectar Browser Use").font(.title2.weight(.semibold))
            Text("Um navegador na nuvem, operado pelo serviço Browser Use, para as tarefas que seus bots pedirem.")
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                fact("dollarsign.circle", "Tem cobrança própria do Browser Use, separada da sua assinatura.")
                fact("person.crop.circle.badge.xmark", "Não usa seus logins, cookies nem o navegador deste Mac.")
                fact("hand.raised", "Cada tarefa ainda pede Permitir ou Negar no chat, e cada bot precisa ser liberado com seus sites.")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("browser-use.connect.facts")
            VStack(alignment: .leading, spacing: 6) {
                Text("Chave privada").font(.callout.weight(.medium))
                SecureField("Cole a chave da sua conta Browser Use", text: $keyDraft)
                    .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                    .focused($keyFocused)
                    .disabled(controller.busy || finished)
                    .accessibilityIdentifier("settings.browser-use.key-input")
                Text("Fica no Keychain deste Mac e vai só para a base que este app iniciou, por um canal privado. Não aparece na conversa.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if started {
                VStack(alignment: .leading, spacing: 6) {
                    step(.keySaved, "Guardada neste Mac")
                    step(.delivered, "Entregue à base deste Mac")
                    step(.enabled, "Ativado nesta base")
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("browser-use.connect.steps")
            }
            HStack {
                if controller.busy { ProgressView().controlSize(.small) }
                Spacer()
                if finished {
                    Button("Concluir") { dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("settings.browser-use.connect.done")
                } else {
                    Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction).disabled(controller.busy)
                    Button("Conectar") {
                        let key = keyDraft; keyDraft = ""; started = true
                        Task { await controller.connect(key: key) }
                    }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(controller.busy || keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("settings.browser-use.key-save")
                }
            }
        }
        .padding(24)
        .frame(width: 460)
        .onAppear { keyFocused = true }
        .onDisappear { keyDraft = "" }
    }

    private func fact(_ icon: String, _ text: LocalizedStringKey) -> some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: icon).foregroundStyle(.secondary) }
            .font(.callout)
    }

    @ViewBuilder private func step(_ step: BrowserUseConnectionController.Step, _ title: LocalizedStringKey) -> some View {
        let state = controller.steps[step] ?? .pending
        Label {
            HStack(spacing: 6) {
                Text(title)
                Text(stepLabel(state)).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: stepSymbol(state)).foregroundStyle(stepTint(state))
        }
        .font(.callout)
        .accessibilityIdentifier("browser-use.connect.step.\(step.rawValue)")
    }

    private func stepSymbol(_ state: BrowserUseConnectionController.StepState) -> String {
        switch state {
        case .pending: "circle"
        case .running: "circle.dotted"
        case .confirmed, .alreadyDone: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .uncertain: "questionmark.circle.fill"
        }
    }
    private func stepTint(_ state: BrowserUseConnectionController.StepState) -> Color {
        switch state {
        case .confirmed, .alreadyDone: .green
        case .failed, .uncertain: .orange
        default: .secondary
        }
    }
    private func stepLabel(_ state: BrowserUseConnectionController.StepState) -> LocalizedStringKey {
        switch state {
        case .pending: "aguardando"
        case .running: "em andamento…"
        case .confirmed: "confirmado"
        case .alreadyDone: "já estava assim"
        case .failed: "não feito"
        case .uncertain: "não confirmado"
        }
    }
}

@MainActor struct BrowserUseBotSettingsView: View {
    @Bindable var editor: BrowserUseSettingsEditor
    @Environment(\.locale) private var locale
    @State private var domains = ""
    @State private var profileID = ""
    @State private var confirmingReload = false
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("Browser Use · Cloud") {
                    Toggle(text("Permitir navegador Cloud para este bot", "Allow Cloud browser for this bot"), isOn: $editor.policy.enabled)
                        .accessibilityIdentifier("bot.browser-use.enabled")
                    if editor.baseline?.enabled != true {
                        Text(text("Browser Use está desativado nesta base. Conecte e ative em Ajustes › Conexões.", "Browser Use is off on this host. Connect and turn it on in Settings › Connections.")).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text(text("Domínios permitidos", "Allowed domains")).font(.subheadline)
                    TextField("example.com, docs.example.com", text: $domains, axis: .vertical)
                        .lineLimit(2...5).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                        .accessibilityIdentifier("bot.browser-use.allowed-domains")
                    Text(text("Use domínios exatos, sem https:// ou caminhos, separados por vírgulas ou linhas. Domínios locais e IPs não são aceitos. Cada tarefa completa será apresentada para Permitir ou Negar.", "Use exact domains, without https:// or paths, separated by commas or lines. Local domains and IPs are not accepted. Each whole task will be presented for Allow or Deny."))
                        .font(.footnote).foregroundStyle(.secondary)
                    Stepper(text("Máximo de passos: \(editor.policy.maxSteps)", "Maximum steps: \(editor.policy.maxSteps)"), value: $editor.policy.maxSteps, in: 1...100)
                        .accessibilityIdentifier("bot.browser-use.max-steps")
                    Stepper(text("Prazo local: \(editor.policy.timeoutSeconds) segundos", "Local deadline: \(editor.policy.timeoutSeconds) seconds"), value: $editor.policy.timeoutSeconds, in: 30...240, step: 30)
                        .accessibilityIdentifier("bot.browser-use.timeout")
                    Text(text("O prazo solicita o encerramento da tarefa e do navegador. Não é um teto de custo garantido pelo provedor; um envio incerto nunca é repetido automaticamente.", "The deadline requests task and browser shutdown. It is not a provider-guaranteed cost cap; an uncertain submission is never repeated automatically."))
                        .font(.footnote).foregroundStyle(.secondary)
                    TextField(text("Perfil Cloud dedicado (UUID opcional)", "Dedicated Cloud profile (optional UUID)"), text: $profileID)
                        .textFieldStyle(.roundedBorder).autocorrectionDisabled().accessibilityIdentifier("bot.browser-use.profile")
                    Text(text("Vazio: navegador novo por tarefa. Um perfil existente pode manter logins na nuvem e só pode pertencer a um bot habilitado. Este controle não copia cookies deste Mac.", "Empty: a new browser for each task. An existing profile may retain cloud logins and may belong to only one enabled bot. This control does not copy this Mac’s cookies."))
                        .font(.footnote).foregroundStyle(.secondary)
                    if editor.dirty && !editor.policy.isValid {
                        Text(text("Confira os domínios e o UUID. Um bot habilitado precisa de pelo menos um domínio permitido.", "Check domains and the UUID. An enabled bot needs at least one allowed domain.")).font(.footnote).foregroundStyle(.orange)
                    }
                }.disabled(!editor.canEdit)
                BrowserUseNotice(editor: editor)
            }.formStyle(.grouped)
            Divider()
            HStack {
                Button(text("Recarregar", "Reload")) { if editor.dirty { confirmingReload = true } else { editor.reload() } }
                    .disabled(!editor.scopeMatches || editor.busy).accessibilityIdentifier("bot.browser-use.reload")
                Spacer()
                if editor.busy { ProgressView().controlSize(.small) }
                Button(text("Salvar navegador do bot", "Save bot browser"), action: editor.save)
                    .buttonStyle(.borderedProminent).disabled(!editor.canSave).accessibilityIdentifier("bot.browser-use.save")
            }.padding(20)
        }
        .task { editor.openIfNeeded(); syncDraft() }
        .onChange(of: editor.baseline) { _, _ in syncDraft() }
        .onChange(of: domains) { _, value in
            editor.policy.allowedDomains = Array(Set(value.split(whereSeparator: { $0 == "," || $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty })).sorted()
        }
        .onChange(of: profileID) { _, value in
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(); editor.policy.profileId = clean.isEmpty ? nil : clean
        }
        .confirmationDialog(text("Descartar edições do navegador?", "Discard browser edits?"), isPresented: $confirmingReload, titleVisibility: .visible) {
            Button(text("Recarregar", "Reload"), role: .destructive) { editor.reload() }
            Button(text("Manter edições", "Keep edits"), role: .cancel) {}
        }
    }
    private func syncDraft() { domains = editor.policy.allowedDomains.joined(separator: ", "); profileID = editor.policy.profileId ?? "" }
}

@MainActor private struct BrowserUseNotice: View {
    let editor: BrowserUseSettingsEditor
    @Environment(\.locale) private var locale
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    var body: some View {
        if let notice = editor.notice {
            Text(message(notice)).font(.footnote).foregroundStyle(notice == .saved ? Color.secondary : Color.orange)
                .accessibilityIdentifier("browser-use.notice")
        }
    }
    private func message(_ notice: BrowserUseSettingsEditor.Notice) -> String {
        switch notice {
        case .loadFailed: text("Não foi possível consultar Browser Use. Confira a base e use Recarregar.", "Could not load Browser Use. Check the host and Reload.")
        case .hostChanged: text("A base mudou. Feche e abra novamente os ajustes.", "The host changed. Close and reopen settings.")
        case .conflict: text("A configuração mudou na base. Suas edições foram mantidas; recarregue antes de salvar novamente.", "The host configuration changed. Your edits were kept; reload before saving again.")
        case .saveUnknown: text("Não foi possível confirmar o salvamento. Recarregue antes de tentar de novo; nada foi reenviado.", "Could not confirm the save. Reload before trying again; nothing was resent.")
        case .saved: text("Configuração salva. Nenhuma tarefa foi iniciada.", "Configuration saved. No task was started.")
        }
    }
}
#endif
