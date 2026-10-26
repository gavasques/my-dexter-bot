#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Opens the guided screen-control panel. Settings preselects a draft bot the owner may change; a later
/// owner handoff may lock it to the requesting bot. Opening never checks, grants, publishes or prepares anything.
struct MacScreenControlPresentation: Identifiable {
    let id = UUID()
    let botID: String?
    let locksBot: Bool
    /// Set by an owner handoff: the panel shows nothing from a base other than the one that issued the receipt.
    var hostID: String? = nil
}

/// Este Mac › Controle de tela: one bot, the real state of each layer and the single action that moves it forward.
/// Opening and Verificar de novo only read (this Mac's private files, owner-loopback GETs and the device projection).
/// Preparation, grants, publication and the local policy keep their existing sheets, confirmations and gates.
/// macOS permissions, the lock check and each session belong to Dexter Control and are never reported as done here.
struct MacScreenControlSheet: View {
    let presentation: MacScreenControlPresentation
    let localHost: LocalHostLaunchCoordinator?
    let agent: LocalMacAgentProcess
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    private enum Inspection: Equatable { case notPrepared, prepared(LocalMacAgentSelection), conflict }
    @State private var client: HostClient?
    @State private var generation = 0
    @State private var loading = false
    @State private var packageAvailable = true
    @State private var location: LocalMacAgentSetupLocation?
    @State private var inspection: Inspection?
    @State private var bots: [Bot] = []
    @State private var botsLoaded = false
    @State private var botID = ""
    @State private var snapshot: LocalMacAgentPolicySnapshot?
    @State private var grants: [DeviceGrantRow]?
    @State private var routes: [DeviceConversationRoute]?
    @State private var notice: String?
    @State private var confirmingStop = false
    @State private var stopping = false
    @State private var setup: MacAutoSetupPresentation?
    @State private var accessDevice: DeviceView?
    @State private var showsAdvanced = false
    @State private var showsDetails = false
    @State private var editingLocal = false
    @State private var hostMismatch = false

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }

    // MARK: - Facts

    private var selection: LocalMacAgentSelection? { if case .prepared(let value) = inspection { value } else { nil } }
    private var bot: Bot? { bots.first { $0.id == botID } }
    private var botName: String { bot?.name ?? text("o bot", "the bot") }
    private var agentFact: MacScreenControlFacts.Agent {
        if agent.ownsLiveChild { return .running }
        switch agent.state {
        case .running: return .running
        case .stopping: return .stopping
        case .stopped, .exited: return .stopped
        }
    }
    private var device: DeviceView? {
        guard let id = snapshot?.boundDeviceID else { return nil }
        return model.devices.first { $0.id == id }
    }
    private var preparationAllowed: Bool {
        guard let localHost, localHost.acceptsLocalEnginePreference else { return false }
        return model.isOnline && !model.localRuntimeSetupBusy && localHost.localRuntimeSetupRefusal(model: model) == nil
    }
    private var facts: MacScreenControlFacts {
        let setupFact: MacScreenControlFacts.Setup = {
            guard packageAvailable else { return .packageMissing }
            switch inspection {
            case .none: return .unverified
            case .conflict: return .conflict
            case .notPrepared: return .notPrepared
            case .prepared(let selection):
                guard snapshot != nil else { return .unverified }
                return .prepared(screenControl: LocalMacAgentCuaAuthorization.operations.allSatisfy(selection.capabilities.contains))
            }
        }()
        let deviceFact: MacScreenControlFacts.Device = {
            guard snapshot?.boundDeviceID != nil else { return .notBound }
            return device.map { .bound($0) } ?? .unknown
        }()
        let local: MacScreenControlFacts.Local = {
            guard let snapshot else { return .unknown }
            guard let current = snapshot.cuaAuthorizations.first(where: { $0.botID == botID }) else { return .missing }
            return .authorized(operations: current.operations, maxSessionSeconds: current.maxSessionSeconds)
        }()
        let access = MacScreenControlHostAccess.read(botID: botID, deviceID: device?.id ?? "", grants: device == nil ? nil : grants,
                                                     routes: device == nil ? nil : routes, now: Date())
        return MacScreenControlFacts(setup: setupFact, agent: agentFact, device: deviceFact, botID: bot?.id,
                                     hostAccess: access, local: local, preparationAllowed: preparationAllowed)
    }

    // MARK: - Body

    var body: some View {
        let guide = MacScreenControlGuide(facts)
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    botRow
                    if let unavailable = scopeUnavailable {
                        Label { Text(verbatim: unavailable).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle") }
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("mac-screen-control.unavailable")
                    } else {
                        summary(guide)
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(guide.steps) { step in
                                stepRow(step, guide: guide)
                                if step.kind != guide.steps.last?.kind { Divider().padding(.leading, 36) }
                            }
                        }
                        .padding(.vertical, 4)
                        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
                    }
                    if let notice {
                        Label { Text(verbatim: notice).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "info.circle") }
                            .font(.callout).foregroundStyle(.secondary)
                            .accessibilityIdentifier("mac-screen-control.notice")
                    }
                    Text(text("Concluir estas etapas não continua automaticamente um pedido já em andamento.",
                              "Finishing these steps does not automatically continue a request already in progress."))
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if scopeUnavailable == nil { details(guide) }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            footer
        }
        .frame(minWidth: 540, idealWidth: 640, maxWidth: 860, minHeight: 460, idealHeight: 660, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mac-screen-control.sheet")
        .task {
            client = model.makeLocalMcpClient()
            botID = presentation.botID ?? model.selectedBotID ?? ""
            load()
        }
        .task {
            // Same cheap process-state poll as the advanced section; it never starts or stops anything.
            while !Task.isCancelled {
                agent.refresh()
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .onChange(of: botID) { _, _ in editingLocal = false; loadAccess() }
        .onChange(of: model.hostAddress) { _, _ in dismiss() }
        .onChange(of: model.nativeComposerScope) { _, _ in dismiss() }
        .onDisappear { generation += 1; client?.close(); client = nil }
        .confirmationDialog(text("Parar o agente deste Mac?", "Stop this Mac's agent?"), isPresented: $confirmingStop) {
            Button(text("Parar o agente", "Stop the agent"), role: .destructive) { stopAgent() }
        } message: {
            Text(text("Os bots não usam este Mac enquanto ele estiver parado. Nada é iniciado de novo automaticamente.",
                      "Bots cannot use this Mac while it is stopped. Nothing restarts automatically."))
        }
        .sheet(item: $setup, onDismiss: load) { item in MacAutoSetupView(controller: item.controller) }
        .sheet(item: $accessDevice, onDismiss: loadAccess) { device in DeviceGrantsSheet(device: device, initialBotID: bot?.id) }
        .sheet(isPresented: $showsAdvanced, onDismiss: load) { MacAdvancedSettingsSheet(agent: agent, client: client) }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(text("Controle de tela", "Screen control")).font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Text(text("Para um bot usar apps deste Mac, com a sua confirmação a cada uso.",
                          "For a bot to use apps on this Mac, with your confirmation each time."))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(text("Fechar", "Close"))
            .accessibilityLabel(text("Fechar", "Close"))
            .accessibilityIdentifier("mac-screen-control.close")
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    /// A handoff for another base, or a locked bot this base does not list: nothing is scoped, read further or offered.
    private var scopeUnavailable: String? {
        if hostMismatch {
            return text("Este pedido é de outra base. Nada deste Mac foi mostrado ou alterado.",
                        "This request is from another base. Nothing on this Mac was shown or changed.")
        }
        if presentation.locksBot, botsLoaded, bot == nil {
            return text("Este bot não está nesta base. Nada foi preparado ou alterado.",
                        "This bot is not on this base. Nothing was prepared or changed.")
        }
        return nil
    }

    @ViewBuilder private var botRow: some View {
        if presentation.locksBot {
            LabeledContent(text("Bot", "Bot")) { Text(verbatim: bot?.name ?? "—") }
                .accessibilityIdentifier("mac-screen-control.bot")
        } else {
            Picker(text("Bot", "Bot"), selection: $botID) {
                Text(text("Escolha um bot", "Choose a bot")).tag("")
                ForEach(bots) { Text(verbatim: $0.name).tag($0.id) }
            }
            .disabled(loading && !botsLoaded)
            .accessibilityIdentifier("mac-screen-control.bot")
        }
    }

    private func summary(_ guide: MacScreenControlGuide) -> some View {
        let (icon, color, headline): (String, Color, String) = {
            switch guide.summary {
            case .unavailable:
                return ("xmark.octagon", .secondary, text("Este pacote do Dexter não inclui o controle de tela.", "This Dexter package does not include screen control."))
            case .attention:
                return ("exclamationmark.triangle.fill", .orange, text("A configuração deste Mac precisa de revisão antes de continuar.", "This Mac's setup needs review before continuing."))
            case .chooseBot:
                return ("person.crop.circle.badge.questionmark", .secondary, text("Escolha qual bot poderá pedir para usar a tela.", "Choose which bot may ask to use the screen."))
            case .remaining(let count):
                let name = botName
                return ("circle.dashed", .secondary, count == 1
                    ? text("Falta 1 etapa para \(name) poder pedir para usar a tela.", "1 step left before \(name) can ask to use the screen.")
                    : text("Faltam \(count) etapas para \(name) poder pedir para usar a tela.", "\(count) steps left before \(name) can ask to use the screen."))
            case .configured(let control):
                let name = botName
                return ("checkmark.seal", .green, control
                    ? text("\(name) pode pedir para ver e controlar o app que você escolher.", "\(name) can ask to see and control the app you choose.")
                    : text("\(name) pode pedir para ver o app que você escolher. Controlar não está permitido.", "\(name) can ask to see the app you choose. Control is not allowed."))
            }
        }()
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title2).foregroundStyle(color).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: headline).font(.headline).fixedSize(horizontal: false, vertical: true)
                if case .configured = guide.summary {
                    Text(text("Permissões do macOS e o bloqueio da tela são conferidos pelo Dexter Control. Cada uso pede a sua confirmação neste Mac.",
                              "macOS permissions and the screen lock are checked by Dexter Control. Each use asks for your confirmation on this Mac."))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("mac-screen-control.summary")
    }

    // MARK: - Steps

    private func stepRow(_ step: MacScreenControlGuide.Step, guide: MacScreenControlGuide) -> some View {
        let isNext = step.kind == guide.next
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: symbol(step.state, isNext: isNext))
                    .foregroundStyle(tint(step.state))
                    .frame(width: 24).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title(step.kind)).font(.body.weight(isNext ? .semibold : .regular))
                    Text(verbatim: detail(step)).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Text(verbatim: stateLabel(step)).font(.callout).foregroundStyle(tint(step.state))
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityElement(children: .combine)
            if isNext { nextContent(step, guide: guide).padding(.leading, 36) }
            else if step.state == .done { revisit(step).padding(.leading, 36) }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("mac-screen-control.step.\(step.kind.rawValue)")
    }

    @ViewBuilder private func nextContent(_ step: MacScreenControlGuide.Step, guide: MacScreenControlGuide) -> some View {
        switch step.action {
        case .editLocalAuthorization, .prepareHelper:
            // The reviewed editor keeps its stopped-agent rechecks, CAS write and confirmations.
            if let selection, let client {
                MacCuaConfigurationView(agent: agent, client: client, selection: selection,
                                        onConfigurationChanged: { _ in load() }, fixedBotID: bot?.id, onChanged: load)
            }
        case .chooseBot, nil:
            EmptyView()
        case .some(let action):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Button(actionLabel(action)) { perform(action) }
                        .buttonStyle(.borderedProminent)
                        // Return never stops the agent; that path always goes through its own confirmation.
                        .keyboardShortcut(action == .stopAgent ? nil : .defaultAction)
                        .disabled(guide.actionBlockedByRuntime || loading || stopping || (action == .reviewBotAccess && device == nil))
                        .accessibilityIdentifier("mac-screen-control.action")
                    if stopping { ProgressView().controlSize(.small) }
                }
                if guide.actionBlockedByRuntime {
                    Text(text("Disponível quando nenhuma conversa estiver respondendo e a base deste Mac estiver pronta.",
                              "Available when no conversation is answering and this Mac's base is ready."))
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if action == .showControlPanel {
                    Text(text("Se a janela não aparecer, use o menu Dexter CUA na barra de menus › Preparar controle de tela…",
                              "If the window does not appear, use the Dexter CUA menu in the menu bar › Prepare screen control…"))
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A finished layer can still be reviewed through the same existing editors; nothing changes until confirmed there.
    @ViewBuilder private func revisit(_ step: MacScreenControlGuide.Step) -> some View {
        switch step.kind {
        case .hostAccess:
            Button(text("Revisar acessos…", "Review access…")) { accessDevice = device }
                .buttonStyle(.link).disabled(device == nil)
                .accessibilityIdentifier("mac-screen-control.review-access")
        case .localAuthorization:
            if editingLocal, let selection, let client {
                MacCuaConfigurationView(agent: agent, client: client, selection: selection,
                                        onConfigurationChanged: { _ in load() }, fixedBotID: bot?.id, onChanged: load)
            } else {
                Button(text("Alterar…", "Change…")) { editingLocal = true }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("mac-screen-control.change-local")
            }
        default: EmptyView()
        }
    }

    private func title(_ kind: MacScreenControlGuide.StepKind) -> String {
        let name = botName
        switch kind {
        case .mac: return text("Este Mac conectado", "This Mac connected")
        case .hostAccess: return text("Acesso de \(name) na base", "\(name)'s access on the base")
        case .localAuthorization: return text("Autorização de \(name) neste Mac", "\(name)'s authorization on this Mac")
        case .macPermissions: return text("Permissões do macOS e bloqueio da tela", "macOS permissions and screen lock")
        case .eachUse: return text("Confirmação a cada uso", "Confirmation each time")
        }
    }

    private func detail(_ step: MacScreenControlGuide.Step) -> String {
        switch step.detail {
        case .ready:
            switch step.kind {
            case .mac: return text("A base confirma a conexão e o agente anuncia o controle de tela. Isso não confirma permissões do macOS.",
                                   "The base confirms the connection and the agent advertises screen control. This does not confirm macOS permissions.")
            case .hostAccess:
                let operations = operationList(step.operations)
                return text("Publicado nas conversas e permitido na base: \(operations).", "Published in conversations and allowed on the base: \(operations).")
            default:
                let operations = operationList(step.operations)
                return text("Permitido neste Mac: \(operations).", "Allowed on this Mac: \(operations).")
            }
        case .packageMissing: return text("Use um pacote do Dexter que inclua o Dexter Control. O navegador continua disponível.",
                                          "Use a Dexter package that includes Dexter Control. The browser remains available.")
        case .conflict: return text("Há arquivos do agente que não formam uma configuração válida. Nada foi alterado; revise na configuração avançada.",
                                    "Agent files do not form a valid configuration. Nothing was changed; review it in advanced setup.")
        case .unverified: return text("Não foi possível conferir a configuração deste Mac com a base. Verifique de novo antes de alterar.",
                                      "This Mac's setup could not be checked against the base. Check again before changing it.")
        case .notPrepared: return text("Preparar cria a conexão protegida e o Dexter Control. Nenhum bot recebe acesso nesta etapa.",
                                       "Preparing creates the protected connection and Dexter Control. No bot gets access in this step.")
        case .helperNotConfigured: return text("Esta configuração ainda não inclui o Dexter Control. Ele é preparado com o agente parado; navegador e arquivos são preservados.",
                                               "This setup does not include Dexter Control yet. It is prepared with the agent stopped; browser and files are preserved.")
        case .agentStopped: return text("O agente deste Mac está parado. A preparação retoma a conexão existente, sem novo pareamento.",
                                        "This Mac's agent is stopped. Preparation resumes the existing connection, without new pairing.")
        case .agentStopping: return text("Aguardando o agente parar.", "Waiting for the agent to stop.")
        case .pairingPending: return text("A conexão deste Mac com a base ainda não foi aprovada. Continue na preparação deste Mac.",
                                          "This Mac's connection to the base is not approved yet. Continue in this Mac's preparation.")
        case .revoked: return text("Este Mac foi revogado na base. Um novo pareamento é feito na configuração avançada.",
                                   "This Mac was revoked on the base. New pairing is done in advanced setup.")
        case .offline: return text("O agente foi iniciado, mas a base ainda não o vê online.", "The agent started, but the base does not see it online yet.")
        case .capabilitiesNotAdvertised: return text("A base não recebeu o controle de tela deste agente. Pode ser preciso um novo pareamento.",
                                                     "The base did not receive screen control from this agent. New pairing may be needed.")
        case .deviceUnknown: return text("A base ainda não listou o dispositivo deste agente.", "The base has not listed this agent's device yet.")
        case .chooseBot: return text("Escolha um bot acima. Cada bot tem acessos próprios.", "Choose a bot above. Each bot has its own access.")
        case .waitingForMac: return text("Depende deste Mac conectado à base.", "Depends on this Mac being connected to the base.")
        case .accessNeeded: return text("Na base, publique e permita para este bot consultar o estado e ver o app escolhido. Controlar é opcional.",
                                        "On the base, publish and allow this bot to check status and see the chosen app. Control is optional.")
        case .accessUnknown: return text("Não foi possível ler os acessos deste bot na base.", "This bot's access on the base could not be read.")
        case .localNeeded: return text("Escolha o que este bot pode fazer neste Mac e por quanto tempo. Começa negado para todos os bots.",
                                       "Choose what this bot may do on this Mac and for how long. It starts denied for every bot.")
        case .stopToEdit: return text("Esta autorização só muda com o agente parado. Pare-o, salve e depois inicie de novo.",
                                      "This authorization only changes while the agent is stopped. Stop it, save, then start it again.")
        case .localUnknown: return text("Não foi possível ler a autorização deste Mac.", "This Mac's authorization could not be read.")
        case .checkOnThisMac: return text("Acessibilidade, Monitoramento de Entrada e a verificação de bloqueio ficam no Dexter Control. O Dexter não lê nem concede essas permissões.",
                                          "Accessibility, Input Monitoring and the lock check live in Dexter Control. Dexter neither reads nor grants these permissions.")
        case .eachUse: return text("Quando o bot pedir, o Dexter Control mostra o pedido: você escolhe um app e confirma. Um indicador fica visível, com Parar (⌃⌥⌘.).",
                                   "When the bot asks, Dexter Control shows the request: you pick an app and confirm. An indicator stays visible, with Stop (⌃⌥⌘.).")
        }
    }

    private func stateLabel(_ step: MacScreenControlGuide.Step) -> String {
        switch step.state {
        case .done:
            switch step.kind {
            case .mac: return text("Conectado", "Connected")
            case .localAuthorization:
                let seconds = snapshot?.cuaAuthorizations.first(where: { $0.botID == botID })?.maxSessionSeconds ?? 0
                let minutes = max(1, seconds / 60), scope = scopeLabel(step.operations)
                return text("\(scope) · até \(minutes) min", "\(scope) · up to \(minutes) min")
            default: return scopeLabel(step.operations)
            }
        case .needed: return text("A fazer", "To do")
        case .waiting: return text("Aguardando", "Waiting")
        case .attention: return text("Revisar", "Review")
        case .unknown: return text("Não confirmado", "Not confirmed")
        case .notReadable: return text("Confirme neste Mac", "Confirm on this Mac")
        case .perUse: return text("A cada uso", "Each time")
        case .unavailable: return text("Indisponível", "Unavailable")
        }
    }

    private func actionLabel(_ action: MacScreenControlGuide.Action) -> String {
        switch action {
        case .prepareMac: return text("Preparar este Mac…", "Prepare this Mac…")
        case .startAgent: return text("Iniciar o agente…", "Start the agent…")
        case .stopAgent: return text("Parar o agente…", "Stop the agent…")
        case .reviewBotAccess: let name = botName; return text("Revisar acessos de \(name)…", "Review \(name)'s access…")
        case .showControlPanel: return text("Mostrar Dexter Control", "Show Dexter Control")
        case .openAdvanced: return text("Configuração avançada…", "Advanced setup…")
        case .checkAgain, .reload, .chooseBot, .editLocalAuthorization, .prepareHelper: return text("Verificar de novo", "Check again")
        }
    }

    private func symbol(_ state: MacScreenControlGuide.StepState, isNext: Bool) -> String {
        switch state {
        case .done: "checkmark.circle.fill"
        case .needed: isNext ? "arrow.right.circle.fill" : "circle"
        case .waiting: "clock"
        case .attention: "exclamationmark.triangle.fill"
        case .unknown: "questionmark.circle"
        case .notReadable: "hand.raised"
        case .perUse: "person.badge.shield.checkmark"
        case .unavailable: "xmark.circle"
        }
    }

    private func tint(_ state: MacScreenControlGuide.StepState) -> Color {
        switch state {
        case .done: .green
        case .needed: .accentColor
        case .attention: .orange
        case .waiting, .unknown, .notReadable, .perUse, .unavailable: .secondary
        }
    }

    private func operationLabel(_ operation: String) -> String {
        switch operation {
        case "mac.cua.status": text("consultar estado", "check status")
        case "mac.cua.observe": text("ver o app escolhido", "see the chosen app")
        default: text("controlar o app escolhido", "control the chosen app")
        }
    }
    private func operationList(_ operations: [String]) -> String {
        operations.isEmpty ? "—" : operations.map(operationLabel).joined(separator: ", ")
    }
    private func scopeLabel(_ operations: [String]) -> String {
        if operations.contains("mac.cua.control") && operations.contains("mac.cua.observe") { return text("Ver e controlar", "See and control") }
        if operations.contains("mac.cua.observe") { return text("Só ver", "See only") }
        return text("Nenhuma", "None")
    }

    // MARK: - Details

    private func details(_ guide: MacScreenControlGuide) -> some View {
        DisclosureGroup(text("Detalhes por operação", "Details by operation"), isExpanded: $showsDetails) {
            let facts = facts
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                GridRow {
                    Text(text("Operação", "Operation")); Text(text("Anunciada", "Advertised"))
                    Text(text("Base", "Base")); Text(text("Este Mac", "This Mac"))
                }
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(MacScreenControlGuide.operations, id: \.self) { operation in
                    GridRow {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: operationLabel(operation))
                            Text(verbatim: operation).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Text(verbatim: advertisedLabel(operation))
                        Text(verbatim: hostLabel(facts.hostAccess[operation] ?? .unknown))
                        Text(verbatim: localLabel(operation, facts.local))
                    }
                    .font(.callout)
                }
            }
            .padding(.top, 6)
            .accessibilityIdentifier("mac-screen-control.details")
            Text(text("Anunciada é o que o agente deste Mac informa à base; não é permissão do macOS nem sessão. As três camadas precisam permitir a operação.",
                      "Advertised is what this Mac's agent reports to the base; it is not a macOS permission or a session. All three layers must allow the operation."))
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            Button(text("Configuração avançada…", "Advanced setup…")) { showsAdvanced = true }
                .padding(.top, 4)
                .accessibilityIdentifier("mac-screen-control.advanced")
        }
        .font(.callout)
    }

    private func advertisedLabel(_ operation: String) -> String {
        guard let device else { return "—" }
        return device.capabilities.contains(operation) ? text("Sim", "Yes") : text("Não", "No")
    }
    private func hostLabel(_ access: MacScreenControlHostAccess) -> String {
        switch access {
        case .valid: text("Permitida", "Allowed")
        case .missing: text("Sem permissão", "No permission")
        case .denied: text("Bloqueada", "Blocked")
        case .expired: text("Expirada", "Expired")
        case .revisionRequired: text("Renovar permissão", "Renew permission")
        case .notPublished: text("Não publicada", "Not published")
        case .unknown: text("Não confirmado", "Not confirmed")
        }
    }
    private func localLabel(_ operation: String, _ local: MacScreenControlFacts.Local) -> String {
        switch local {
        case .unknown: text("Não confirmado", "Not confirmed")
        case .missing: text("Negada", "Denied")
        case .authorized(let operations, _): operations.contains(operation) ? text("Permitida", "Allowed") : text("Negada", "Denied")
        }
    }

    private var footer: some View {
        HStack {
            Button(text("Verificar de novo", "Check again")) { load() }
                .disabled(loading)
                .accessibilityIdentifier("mac-screen-control.check")
            if loading { ProgressView().controlSize(.small) }
            Spacer()
            Text(text("Abrir esta janela só consulta o estado.", "Opening this window only reads state."))
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    // MARK: - Actions

    private func perform(_ action: MacScreenControlGuide.Action) {
        notice = nil
        switch action {
        case .prepareMac, .startAgent:
            // Explicit owner gesture only, through the existing factory and its runtime gate; never on open.
            guard preparationAllowed, let localHost, let controller = localHost.makeMacAutoSetupController(model: model, agent: agent) else {
                notice = text("A preparação não está disponível agora. Conecte à base deste Mac e aguarde o fim de respostas em andamento.",
                              "Preparation is not available now. Connect to this Mac's base and wait for answers in progress to finish.")
                return
            }
            setup = MacAutoSetupPresentation(controller: controller)
        case .stopAgent: confirmingStop = true
        case .reviewBotAccess: accessDevice = device
        case .showControlPanel:
            guard let location, LocalMacAgentCuaSetup.activateRunningHelper(location: location) else {
                notice = text("O Dexter Control não está aberto. Ele abre com o agente deste Mac; nada foi iniciado agora.",
                              "Dexter Control is not open. It opens with this Mac's agent; nothing was started now.")
                return
            }
        case .openAdvanced: showsAdvanced = true
        case .checkAgain, .reload, .chooseBot, .editLocalAuthorization, .prepareHelper: load()
        }
    }

    private func stopAgent() {
        guard !stopping, agent.ownsLiveChild else { return }
        stopping = true
        Task { @MainActor in
            do { try await agent.stop() }
            catch { notice = text("A parada ainda não foi confirmada. Aguarde e verifique de novo.", "The stop is not confirmed yet. Wait and check again.") }
            stopping = false
            load()
        }
    }

    /// Read-only: package metadata, this Mac's private files, owner-loopback GETs and the device projection.
    private func load() {
        generation += 1
        let token = generation
        packageAvailable = (try? LocalMacAgentCuaPackage.packaged()) != nil
        let standard = try? LocalMacAgentSetupLocation.standard()
        location = standard
        inspection = standard.map {
            switch LocalMacAgentSetup.inspect($0) {
            case .notPrepared: .notPrepared
            case .prepared(let value): .prepared(value)
            case .conflict: .conflict
            }
        }
        guard let client else {
            snapshot = nil; bots = []; botsLoaded = false
            notice = text("Conecte à base deste Mac para conferir o controle de tela.", "Connect to this Mac's base to check screen control.")
            return
        }
        loading = true
        let selection = selection
        Task { @MainActor in
            defer { if token == generation { loading = false } }
            do {
                let id = try await client.localMacAgentInstallationID()
                guard token == generation else { return }
                if let expected = presentation.hostID, expected != id {
                    hostMismatch = true; snapshot = nil; bots = []; botsLoaded = true
                    return
                }
                hostMismatch = false
                let hostBots = try await client.listBots()
                guard token == generation else { return }
                bots = hostBots; botsLoaded = true
                if !hostBots.contains(where: { $0.id == botID }) { botID = presentation.locksBot ? presentation.botID ?? "" : "" }
                if let selection {
                    let read = try? await Task.detached { try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: id) }.value
                    guard token == generation else { return }
                    snapshot = read
                } else { snapshot = nil }
            } catch {
                guard token == generation else { return }
                snapshot = nil
                notice = text("Não foi possível consultar a base deste Mac. Confira se ela está em execução.",
                              "This Mac's base could not be read. Check that it is running.")
            }
            guard token == generation else { return }
            await model.refreshDevices()
            guard token == generation else { return }
            loadAccess()
        }
    }

    /// Host grants and conversation publication for the chosen bot only. A failed read stays unknown.
    private func loadAccess() {
        grants = nil; routes = nil
        guard let client, let botID = bot?.id else { return }
        let token = generation
        Task { @MainActor in
            let grantPage = try? await client.deviceGrants(botID: botID)
            let routePage = try? await client.deviceRoutes(botID: botID)
            guard token == generation, self.botID == botID else { return }
            grants = grantPage.map { $0.items.map(DeviceGrantRow.init) }
            routes = routePage?.botId == botID ? routePage?.routes : nil
        }
    }
}
#endif
