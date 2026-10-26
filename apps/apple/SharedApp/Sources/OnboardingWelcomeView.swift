#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// "Quem vai conversar com você?" (UX-P0-04). One question, the assistants this base or this Mac really reports, and one
/// action each. Nothing here installs a program, signs in, asks for a credential or prompts for a macOS permission.
struct OnboardingWelcomeView: View {
    @Bindable var controller: OnboardingWelcomeController
    let onFinished: (String) -> Void
    let onDismiss: () -> Void
    let openAssistants: () -> Void
    var localHost: LocalHostLaunchCoordinator? = nil
    @Environment(DexterAppModel.self) private var model
    @State private var setup: AssistantSetupPresentation?

    var body: some View {
        VStack(spacing: 18) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable().frame(width: 64, height: 64).accessibilityHidden(true)
            VStack(spacing: 6) {
                Text("Quem vai conversar com você?").font(.title.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Text("Escolha um assistente. O Dexter prepara o programa; você entra com sua conta no fluxo oficial.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(controller.cards) { card in cardView(card) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("welcome.cards")
            HStack(spacing: 8) {
                Text("Nome do bot").font(.callout).foregroundStyle(.secondary)
                TextField("Nome do bot", text: $controller.botName)
                    .textFieldStyle(.roundedBorder).frame(width: 220)
                    .disabled(controller.isWorking)
                    .accessibilityIdentifier("welcome.bot-name")
            }
            phaseView
            Divider()
            HStack {
                Button("Agora não") { controller.dismiss(); onDismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(controller.isWorking)
                    .accessibilityIdentifier("welcome.later")
                Spacer()
                Text("Você pode abrir de novo em Ajustes › Geral.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .frame(width: 580)
        .task {
            controller.recomputeCards()
            await controller.refresh()
        }
        .onChange(of: controller.phase) { _, phase in
            if case .finished(let botID) = phase { onFinished(botID) }
        }
        .sheet(item: $setup, onDismiss: { Task { await controller.refresh() } }) { item in
            AssistantSetupView(controller: item.controller, onFinished: { Task { await controller.refresh(); await controller.choose(item.controller.engine) } }, finishTitle: "Criar bot")
        }
    }

    private var primaryEngine: EngineID? { controller.cards.first(where: \.canChoose)?.engine }

    private func symbol(_ engine: EngineID) -> String { engine == .claude ? "sparkles" : "terminal" }

    private func cardView(_ card: OnboardingWelcomeController.Card) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: symbol(card.engine)).font(.system(size: 18)).foregroundStyle(.secondary).accessibilityHidden(true)
                Text(verbatim: card.engine.displayName).font(.headline)
            }
            Text(stateText(card.state)).font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 36, alignment: .topLeading)
            cardAction(card)
        }
        .padding(14)
        .frame(width: 250, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome.card.\(card.engine.rawValue)")
    }

    @ViewBuilder private func cardAction(_ card: OnboardingWelcomeController.Card) -> some View {
        switch card.state {
        case .ready, .foundOnThisMac:
            let button = Button("Usar \(card.engine.displayName)") {
                if let localHost, let preparer = localHost.makeAssistantSetupController(engine: card.engine, model: model) {
                    setup = AssistantSetupPresentation(controller: preparer)
                } else { Task { await controller.choose(card.engine) } }
            }
                .disabled(controller.isWorking)
                .accessibilityIdentifier("welcome.use.\(card.engine.rawValue)")
            if card.engine == primaryEngine { button.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction) } else { button }
        case .savedChoiceDiffers:
            prepareButton(card)
        case .checking:
            ProgressView().controlSize(.small)
        case .notInstalled, .unavailable:
            prepareButton(card)
        case .alreadyChosen, .notReported:
            Button("Verificar de novo") { Task { await controller.refresh() } }
                .disabled(controller.isWorking)
                .accessibilityIdentifier("welcome.check.\(card.engine.rawValue)")
        }
    }

    @ViewBuilder private func prepareButton(_ card: OnboardingWelcomeController.Card) -> some View {
        if let localHost, localHost.acceptsLocalEnginePreference {
            Button("Preparar \(card.engine.displayName)") {
                if let controller = localHost.makeAssistantSetupController(engine: card.engine, model: model) {
                    setup = AssistantSetupPresentation(controller: controller)
                }
            }
            .disabled(controller.isWorking || localHost.localRuntimeSetupRefusal(model: model) != nil)
            .accessibilityIdentifier("welcome.prepare.\(card.engine.rawValue)")
        } else {
            Button("Abrir Assistentes", action: openAssistants).accessibilityIdentifier("welcome.open-assistants.\(card.engine.rawValue)")
        }
    }

    private func stateText(_ state: OnboardingWelcomeController.CardState) -> LocalizedStringKey {
        switch state {
        case .checking: "Verificando…"
        case .ready: "Pronto nesta base · login não confirmado"
        case .foundOnThisMac: "Encontrado neste Mac · login não confirmado"
        case .alreadyChosen: "Ligado neste Mac, mas a base ainda não confirmou"
        case .savedChoiceDiffers: "Encontrado · seus ajustes atuais não o incluem; mude em Assistentes"
        case .notInstalled: "Ainda não instalado. O Dexter pode preparar neste Mac."
        case .unavailable: "Encontrado · indisponível agora"
        case .notReported: "A base não informou o estado"
        }
    }

    @ViewBuilder private var phaseView: some View {
        switch controller.phase {
        case .choosing, .finished:
            EmptyView()
        case .preparing(let engine):
            progress("Preparando o \(engine.displayName) neste Mac. A base deste app reinicia uma vez.")
        case .checking(let engine):
            progress("Verificando o \(engine.displayName)…")
        case .creating:
            progress("Criando o bot…")
        case .failed(let failure):
            failureView(failure)
        }
    }

    private func progress(_ text: LocalizedStringKey) -> some View {
        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(text).font(.callout) }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("welcome.progress")
    }

    @ViewBuilder private func failureView(_ failure: OnboardingWelcomeController.Failure) -> some View {
        VStack(spacing: 8) {
            switch failure {
            case .applyRefused(let message):
                Text(verbatim: DexterLocalization.text(message)).multilineTextAlignment(.center)
                HStack {
                    if let engine = controller.chosenEngine { retry(engine) }
                    Button("Abrir Assistentes", action: openAssistants)
                }
            case .engineNotReady(let engine):
                Text("A base ainda não confirmou que o \(engine.displayName) pode responder. Confira se o programa oficial está instalado e com login.")
                    .multilineTextAlignment(.center)
                Button("Verificar de novo") { Task { await controller.refresh() } }
            case .createRefused(let message):
                Text(verbatim: message).multilineTextAlignment(.center)
                if let engine = controller.chosenEngine { retry(engine) }
            case .createUnconfirmed:
                Text("Não foi possível confirmar a criação do bot. Nada foi reenviado.").multilineTextAlignment(.center)
                Button("Conferir") { Task { await controller.confirmCreation() } }
                    .buttonStyle(.borderedProminent).accessibilityIdentifier("welcome.confirm-creation")
            case .createNotFound:
                Text("Nenhum bot novo apareceu. Você pode criar de novo; se o pedido anterior chegar depois, pode surgir um segundo bot com o mesmo nome.")
                    .multilineTextAlignment(.center)
                Button("Criar de novo") { Task { await controller.createAgain() } }
                    .accessibilityIdentifier("welcome.create-again")
            case .ambiguous(let count):
                let total = String(count)
                Text("Apareceram \(total) bots novos com esse nome. Escolha um na lista.").multilineTextAlignment(.center)
                Button("Fechar", action: onDismiss)
            case .changed:
                Text("A base mudou durante a preparação. Confira e tente de novo.").multilineTextAlignment(.center)
                Button("Verificar de novo") { Task { controller.reopen(); await controller.refresh() } }
            }
        }
        .font(.callout)
        .foregroundStyle(.primary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("welcome.failure")
    }

    private func retry(_ engine: EngineID) -> some View {
        Button("Tentar de novo") { Task { controller.reopen(); await controller.choose(engine) } }
            .accessibilityIdentifier("welcome.retry")
    }
}
#endif
