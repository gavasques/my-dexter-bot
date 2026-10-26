#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

@MainActor
struct AssistantSetupPresentation: Identifiable {
    let id = UUID()
    let controller: AssistantSetupController
}

/// One assistant, one primary action. All preparation and receipt recovery use the real controller.
struct AssistantSetupView: View {
    @Bindable var controller: AssistantSetupController
    var onFinished: () -> Void = {}
    var finishTitle: LocalizedStringKey = "Voltar à conversa"
    var openComputerAccess: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var unlockPhrase = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image(systemName: controller.engine == .claude ? "sparkles" : "terminal")
                    .font(.title).foregroundStyle(.tint).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Preparar \(controller.engine.displayName)").font(.title2.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text("O Dexter prepara o programa e o conecta à base. O login continua no assistente oficial.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            status
            if controller.programIsPrepared {
                LabeledContent("Programa") { Text("Instalado e verificado") }
                    .accessibilityIdentifier("assistant-setup.program-state")
                LabeledContent("Escolha nesta base") { Text(controller.choiceIsApplied ? LocalizedStringKey("Aplicada") : LocalizedStringKey("Ainda não aplicada")) }
                    .accessibilityIdentifier("assistant-setup.choice-state")
                LabeledContent("Conta") { Text(controller.phase == .signInFinished ? LocalizedStringKey("Fluxo oficial concluído") : LocalizedStringKey("Login não confirmado")) }
                    .accessibilityIdentifier("assistant-setup.account-state")
            }
            if controller.needsUnlock && controller.phase == .ready {
                SecureField("Frase-senha do canal deste Mac", text: $unlockPhrase)
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("assistant-setup.unlock-phrase")
                Text("O canal já está configurado. Use a mesma frase-senha para reabri-lo; ela não é salva.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let version = controller.targetVersion {
                LabeledContent("Versão") { Text(verbatim: version).monospacedDigit() }
                    .accessibilityIdentifier("assistant-setup.version")
            }
            if controller.phase == .ready {
                Text(controller.willDownload ? LocalizedStringKey("Instalação para o seu usuário, a partir da distribuição oficial. A base deste Mac será reiniciada uma vez.")
                    : LocalizedStringKey("Foi encontrada uma instalação compatível. O Dexter vai usá-la e reiniciar apenas sua própria base neste Mac."))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let bytes = controller.downloadBytes, controller.willDownload {
                    LabeledContent("Download") { Text(verbatim: ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) }
                }
            }
            if [.prepared, .signInFinished, .signingIn].contains(controller.phase) {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sua conta").font(.headline)
                    Text("Se você já entrou neste assistente, pode voltar à conversa. Caso contrário, abra o login oficial.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Entrar no \(controller.engine.displayName)") { controller.signIn() }
                        .disabled(controller.isWorking).accessibilityIdentifier("assistant-setup.sign-in")
                }
                if let openComputerAccess {
                    Button("Configurar acesso ao Mac…") { dismiss(); openComputerAccess() }
                        .accessibilityIdentifier("assistant-setup.computer-access")
                    Text("Opcional para conversar. O macOS pede as permissões quando você configura o acesso ao computador.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Divider()
            HStack {
                Button { controller.close(); dismiss() } label: { Text(controller.isWorking ? LocalizedStringKey("Cancelar") : LocalizedStringKey("Fechar")) }
                    .keyboardShortcut(.cancelAction).accessibilityIdentifier("assistant-setup.close")
                Spacer()
                if controller.phase == .unconfirmed {
                    Button("Conferir") { controller.reconcile() }.buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("assistant-setup.reconcile")
                } else if controller.canRetry {
                    Button("Tentar novamente") { controller.retry() }.buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("assistant-setup.retry")
                } else if controller.phase == .ready {
                    Button {
                        let phrase = controller.needsUnlock ? LocalHostUnlockPassword(unlockPhrase) : nil
                        unlockPhrase = ""; controller.use(unlockPassword: phrase)
                    } label: { Text(controller.willDownload ? LocalizedStringKey("Instalar e usar") : LocalizedStringKey("Usar neste Mac")) }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(!controller.canUse || (controller.needsUnlock && !(16...1_024).contains(unlockPhrase.utf8.count)))
                    .accessibilityIdentifier("assistant-setup.use")
                } else if [.prepared, .signInFinished].contains(controller.phase) {
                    Button { onFinished(); dismiss() } label: { Text(finishTitle) }.buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("assistant-setup.finish")
                }
            }
        }
        .padding(24).frame(width: 530)
        .accessibilityElement(children: .contain).accessibilityIdentifier("assistant-setup.sheet")
        .task { controller.open() }
        .onDisappear { unlockPhrase = ""; controller.close() }
    }

    @ViewBuilder private var status: some View {
        switch controller.phase {
        case .idle, .checking: progress(stepText)
        case .ready:
            Label { Text(controller.willDownload ? LocalizedStringKey("Pronto para instalar") : LocalizedStringKey("Pronto para usar")) } icon: { Image(systemName: "checkmark.circle") }
                .foregroundStyle(.secondary).accessibilityIdentifier("assistant-setup.ready")
        case .installing: progress(stepText)
        case .applying: progress("Conectando o assistente ao Dexter…")
        case .prepared:
            Label("Programa preparado e escolha aplicada.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                .accessibilityIdentifier("assistant-setup.prepared")
        case .signingIn: progress("Conclua o login no navegador aberto pelo programa oficial…")
        case .signInFinished:
            Label("O programa oficial confirmou o login. Envie uma mensagem para testar.", systemImage: "checkmark.circle")
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("assistant-setup.sign-in-finished")
        case .unconfirmed:
            Label("A preparação não foi confirmada. Conferir consulta o resultado sem instalar novamente.", systemImage: "questionmark.circle")
                .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistant-setup.unconfirmed")
        case .blocked(let message):
            Label { Text(verbatim: message).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle") }
                .foregroundStyle(.orange).accessibilityIdentifier("assistant-setup.blocked")
        }
    }

    private var stepText: LocalizedStringKey {
        switch controller.progressStep {
        case .inspecting: "Verificando o programa instalado…"
        case .resolvingRelease: "Consultando a versão oficial para este Mac…"
        case .reusing: "Revalidando a instalação existente…"
        case .downloading: "Baixando o programa oficial…"
        case .verifying: "Verificando integridade e assinatura…"
        case .committing: "Salvando a instalação na pasta do Dexter…"
        case .reconciling: "Conferindo o resultado original…"
        }
    }

    private func progress(_ text: LocalizedStringKey) -> some View {
        HStack(spacing: 10) { ProgressView().controlSize(.small); Text(text) }
            .accessibilityIdentifier("assistant-setup.progress")
    }
}

@MainActor
struct AssistantFirstRunPresentation: Identifiable {
    let id = UUID()
    let coordinator: AssistantFirstRunCoordinator
}

/// Root's welcome entry wraps its existing bot creation UI with this preparation page.
/// Defined in the existing source membership so no new Xcode project entry is required.
struct AssistantFirstRunView<Content: View>: View {
    @AppStorage("com.dexter.apple.assistant-first-run.v1") private var completed = false
    @State private var coordinator: AssistantFirstRunCoordinator
    private let manageable: Bool
    private let openComputerAccess: (() -> Void)?
    private let content: Content

    init(model: DexterAppModel, localHost: LocalHostLaunchCoordinator?, openComputerAccess: (() -> Void)? = nil,
         @ViewBuilder content: () -> Content) {
        _coordinator = State(initialValue: AssistantFirstRunCoordinator(model: model, localHost: localHost))
        manageable = localHost?.acceptsLocalEnginePreference == true
        self.openComputerAccess = openComputerAccess; self.content = content()
    }
    var body: some View {
        if manageable && !completed {
            AssistantFirstRunChecklistView(coordinator: coordinator, onContinue: { completed = true }, openComputerAccess: openComputerAccess)
        } else { content }
    }
}

struct AssistantFirstRunChecklistView: View {
    @Bindable var coordinator: AssistantFirstRunCoordinator
    let onContinue: () -> Void
    var openComputerAccess: (() -> Void)? = nil
    @Environment(\.locale) private var locale
    @State private var setup: AssistantSetupPresentation?
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Vamos preparar o Dexter").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button { coordinator.close(); onContinue() } label: {
                        Image(systemName: "xmark").accessibilityLabel("Fechar")
                    }
                    .buttonStyle(.plain).keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("assistant-first-run.close")
                }
                Text("A base e os manuais acompanham o app. Escolha apenas o assistente que quer usar.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 12) {
                checklist("Runtime incluído", ready: coordinator.bundled.runtime, id: "runtime")
                checklist("Configuração e guias incluídos", ready: coordinator.bundled.configuration && coordinator.bundled.guides, id: "guides")
                checklist("Base deste Mac", ready: coordinator.hostIsReady, id: "host")
            }
            if coordinator.phase == .checking {
                HStack { ProgressView().controlSize(.small); Text("Preparando os componentes incluídos…") }
                    .accessibilityIdentifier("assistant-first-run.progress")
            } else if coordinator.phase == .blocked {
                Text("Um componente incluído está ausente ou não passou na verificação. Abra uma cópia completa do app ou verifique novamente.")
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("assistant-first-run.blocked")
            } else if !coordinator.hostIsReady {
                Text("A base deste Mac ainda não foi confirmada. Verifique novamente ou continue para ver o estado da conexão.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            Text("Seu assistente").font(.headline)
            HStack(alignment: .top, spacing: 12) {
                provider(.claude); provider(.codex)
            }
            Text("Um download só começa após sua confirmação. Se já houver um programa compatível, o Dexter o reutiliza. Login não confirmado não significa que você saiu da conta.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            Text("Skills e conexões opcionais podem ser adicionadas ao bot depois. Os manuais do Dexter já estão incluídos.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistant-first-run.optional-skills")
            if let openComputerAccess {
                Button("Configurar acesso ao Mac…", action: openComputerAccess)
                    .accessibilityIdentifier("assistant-first-run.computer-access")
                Text("Opcional para conversar. Pareamento e permissões do macOS exigem suas próprias confirmações.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("Verificar de novo") { coordinator.refresh() }
                    .disabled(coordinator.phase == .checking).accessibilityIdentifier("assistant-first-run.refresh")
                Spacer()
                Button("Continuar") { coordinator.close(); onContinue() }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    .disabled(coordinator.phase == .checking).accessibilityIdentifier("assistant-first-run.continue")
            }
        }
        .padding(24).frame(width: 580)
        .accessibilityElement(children: .contain).accessibilityIdentifier("assistant-first-run.sheet")
        .task { coordinator.open() }
        .onDisappear { coordinator.close() }
        .sheet(item: $setup, onDismiss: { coordinator.closeAssistant() }) { item in
            AssistantSetupView(controller: item.controller, finishTitle: "Voltar à preparação")
        }
    }
    private func checklist(_ title: LocalizedStringKey, ready: Bool, id: String) -> some View {
        HStack {
            Image(systemName: ready ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(ready ? Color.green : Color.secondary).accessibilityHidden(true)
            Text(title)
            Spacer()
            Text(ready ? LocalizedStringKey("Verificado") : LocalizedStringKey("A confirmar")).font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine).accessibilityIdentifier("assistant-first-run.\(id)")
    }
    private func provider(_ engine: EngineID) -> some View {
        let status = coordinator.status(engine)
        return VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: engine.displayName).font(.headline)
            Text(verbatim: providerStatus(status)).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("assistant-first-run.status.\(engine.rawValue)")
            Button("Preparar \(engine.displayName)…") {
                coordinator.choose(engine)
                if let controller = coordinator.assistant { setup = AssistantSetupPresentation(controller: controller) }
            }
            .disabled(!coordinator.canPrepareAssistant).accessibilityIdentifier("assistant-first-run.prepare.\(engine.rawValue)")
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
    private func providerStatus(_ status: AssistantFirstRunStatus) -> String {
        let installed = status.installed.map { $0 ? (portuguese ? "Instalado" : "Installed") : (portuguese ? "Não instalado" : "Not installed") }
            ?? (portuguese ? "Instalação a confirmar" : "Installation unconfirmed")
        let enabled = status.enabled ? (portuguese ? "Escolha ligada" : "Choice enabled") : (portuguese ? "Escolha desligada" : "Choice disabled")
        let available = status.available.map { $0 ? (portuguese ? "Disponível nesta base" : "Available on this host") : (portuguese ? "Indisponível nesta base" : "Unavailable on this host") }
            ?? (portuguese ? "Disponibilidade a confirmar" : "Availability unconfirmed")
        return [installed, enabled, available, portuguese ? "Login não confirmado" : "Sign-in unconfirmed"].joined(separator: " · ")
    }
}
#endif
