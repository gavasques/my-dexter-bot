#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// "Novo bot" (UX-P2-24): three role suggestions fill the name and the role (both editable), the assistants this base
/// reports available come first and the rest sit under "Outros (não instalados)". Nothing is created until Criar.
/// Creation is the same single POST as before; a role, when given, is saved afterwards by the profile's own CAS PATCH on
/// the new bot's revision, never retried, and its outcome is said plainly. The optional mascot recipe rides the same
/// creation POST (atomic, no second CAS); without it the bot keeps the engine icon as before.
struct NewBotView: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var role = ""
    @State private var engine: EngineID = .claude
    @State private var engineTouched = false
    @State private var showsOthers = false
    @State private var isCreating = false
    @State private var creationFailure: String?
    /// Set once the host confirmed the bot: Criar is gone, only Fechar remains (nothing is created twice).
    @State private var createdBotID: String?
    /// The host may have created the bot (outcome not confirmed): Criar stays blocked for this presentation.
    @State private var creationUnconfirmed = false
    @State private var roleNotice: String?
    @State private var isVisible = true
    @State private var presentationToken = UUID()
    /// Local draft only; the recipe reaches the host solely inside the creation request.
    @State private var usesMascot = true
    /// Each new bot starts from a different look from the curated options; the owner can re-roll or customize.
    @State private var appearance: BotAvatarAppearance = {
        var generator = SystemRandomNumberGenerator()
        return BotMascotRandomizer.next(after: .dexterDefault, using: &generator)
    }()
    @State private var showsMascotCreator = false
    /// Look and toggle when the creator sheet opened: X/Escape put them back; only Concluído keeps the sheet's edits.
    @State private var mascotBeforeSheet: (appearance: BotAvatarAppearance, usesMascot: Bool)?
    @FocusState private var isNameFocused: Bool

    private struct Suggestion: Identifiable {
        let id: String
        let name: String
        let role: String
        let symbol: String
    }

    private var suggestions: [Suggestion] {
        [Suggestion(id: "assistant", name: text("Assistente pessoal"), role: text("Organiza tarefas, lembretes e mensagens do dia a dia."), symbol: "person.crop.circle"),
         Suggestion(id: "research", name: text("Pesquisador"), role: text("Pesquisa assuntos e entrega resumos com as fontes."), symbol: "magnifyingglass"),
         Suggestion(id: "writer", name: text("Redator"), role: text("Escreve e revisa textos, e-mails e publicações."), symbol: "pencil.line")]
    }

    private func text(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }
    private func pair(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var isPortuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedRole: String { role.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func readiness(_ option: EngineID) -> EngineReadiness { model.engineReadiness(for: option) }

    /// Available first; the catalog's own state decides, nothing claims a sign-in. Not found, unavailable and not
    /// reported by this base all go under "Outros", each with its own status line.
    private var available: [EngineID] { EngineID.allCases.filter { readiness($0) == .availableLoginUnconfirmed } }
    private var others: [EngineID] { EngineID.allCases.filter { !available.contains($0) } }
    /// While the lookup is running, nothing can be called "not installed": one plain list.
    private var catalogKnown: Bool { !model.engineCatalog.isEmpty && !EngineID.allCases.contains { readiness($0) == .checking } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Novo bot").font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
            suggestionRow
            VStack(alignment: .leading, spacing: 8) {
                Text("Nome do bot").font(.callout.weight(.medium))
                TextField("Nome do bot", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .focused($isNameFocused)
                    .disabled(isCreating || createdBotID != nil)
                    .onSubmit(create)
                    .accessibilityLabel("Nome do bot")
                    .accessibilityIdentifier("bot.name")
                Text("Função (opcional)").font(.callout.weight(.medium)).padding(.top, 4)
                TextField("O que este bot faz por você", text: $role, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...3)
                    .disabled(isCreating || createdBotID != nil || !model.canEditBotProfiles)
                    .accessibilityLabel("Função do bot")
                    .accessibilityIdentifier("bot.role")
                if !model.canEditBotProfiles {
                    Text("Nesta base, a função é definida depois, em Ajustes do bot.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            mascotRow
            enginePicker
            if creationUnconfirmed {
                Label(pair("Não foi possível confirmar se o bot foi criado. Confira a lista de bots antes de criar de novo; aqui o Criar fica bloqueado.",
                           "Could not confirm whether the bot was created. Check the bot list before creating again; Create stays blocked here."),
                      systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot.create.unconfirmed")
            } else if let creationFailure {
                Label(DexterLocalization.text(creationFailure, locale: locale), systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot.create.error")
            }
            if let roleNotice {
                Label(roleNotice, systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot.role.notice")
            }
            Divider()
            HStack(spacing: 12) {
                if isCreating {
                    ProgressView().controlSize(.small)
                    Text("Criando bot…").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if createdBotID != nil {
                    Button("Fechar") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("bot.close")
                } else {
                    Button("Cancelar") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                    Button("Criar", action: create)
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                        .disabled(isCreating || trimmedName.isEmpty || !model.canUseHost || creationUnconfirmed)
                        .accessibilityIdentifier("bot.save")
                }
            }
        }
        .padding(24)
        .frame(minWidth: 460, idealWidth: 500, maxWidth: 540)
        .fixedSize(horizontal: false, vertical: true)
        .sheet(isPresented: $showsMascotCreator) { mascotCreatorSheet }
        .onAppear { isVisible = true; isNameFocused = true }
        .onDisappear { isVisible = false; presentationToken = UUID() }
        .task {
            await model.refreshEngineCatalog()
            // Convenience only, before the owner chooses: the first engine the catalog reports; never a login check.
            if !engineTouched, let preferred = EngineReadiness.preferredEngine(in: model.engineCatalog) { engine = preferred }
            if catalogKnown, others.contains(engine) || available.isEmpty { showsOthers = true }
        }
    }

    private var suggestionRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Comece por uma sugestão").font(.callout.weight(.medium))
            HStack(alignment: .top, spacing: 8) {
                ForEach(suggestions) { suggestion in
                    let chosen = trimmedName == suggestion.name && trimmedRole == suggestion.role
                    Button {
                        name = suggestion.name
                        if model.canEditBotProfiles { role = suggestion.role }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Image(systemName: suggestion.symbol).foregroundStyle(.secondary)
                                .frame(height: 18, alignment: .leading).accessibilityHidden(true)
                            Text(verbatim: suggestion.name).font(.callout.weight(.semibold)).lineLimit(1)
                            Text(verbatim: suggestion.role).font(.caption).foregroundStyle(.secondary)
                                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, minHeight: 92, maxHeight: .infinity, alignment: .topLeading)
                        .background(chosen ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(chosen ? Color.accentColor.opacity(0.6) : Color.secondary.opacity(0.15)))
                        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(isCreating || createdBotID != nil)
                    .accessibilityAddTraits(chosen ? [.isSelected] : [])
                    .accessibilityHint(Text("Preenche nome e função; você pode editar antes de criar."))
                    .accessibilityIdentifier("bot.suggestion.\(suggestion.id)")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var mascotRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(pair("Aparência", "Appearance")).font(.callout.weight(.medium))
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    if usesMascot {
                        BotMascotView(appearance: appearance, size: 52, seed: "new-bot")
                    } else {
                        RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.08))
                        Image(systemName: EngineSymbol.systemName(engine.rawValue)).font(.system(size: 22, weight: .medium)).foregroundStyle(.secondary)
                    }
                }
                .frame(width: 52, height: 52)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(usesMascot ? appearance.accessibilityDescription(portuguese: isPortuguese) : pair("Ícone do assistente", "Assistant icon"))
                .accessibilityIdentifier("bot.avatar.preview")
                VStack(alignment: .leading, spacing: 3) {
                    Toggle(pair("Criar com mascote", "Create with a mascot"), isOn: $usesMascot)
                        .toggleStyle(.checkbox)
                        .accessibilityIdentifier("bot.avatar.mascot-toggle")
                    Text(pair("Desenhado no app, sem IA e sem custo. Imagem ou emoji podem ser escolhidos depois, em Ajustes do bot.",
                              "Drawn by the app, no AI and no cost. An image or emoji can be chosen later in Bot settings."))
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button {
                    // Visible effect only: the dice also turns the mascot on, so the preview shows the new look.
                    var generator = SystemRandomNumberGenerator()
                    appearance = BotMascotRandomizer.next(after: appearance, using: &generator); usesMascot = true
                } label: { Image(systemName: "dice") }
                    .help(usesMascot ? pair("Aleatório", "Random") : pair("Aleatório (liga o mascote)", "Random (turns the mascot on)"))
                    .accessibilityLabel(pair("Mascote aleatório", "Random mascot"))
                    .accessibilityIdentifier("bot.avatar.random")
                Button(pair("Personalizar…", "Customize…")) {
                    mascotBeforeSheet = (appearance, usesMascot); showsMascotCreator = true
                }
                    .accessibilityIdentifier("bot.avatar.customize")
            }
            .disabled(isCreating || createdBotID != nil)
        }
    }

    private var mascotCreatorSheet: some View {
        BotMascotCreatorSheet(
            appearance: $appearance,
            title: pair("Mascote do bot", "Bot mascot"),
            footnote: pair("O mascote é salvo quando você criar o bot.", "The mascot is saved when you create the bot."),
            closeHelp: pair("Fechar sem aplicar as mudanças deste painel (Esc). O bot ainda não foi criado.",
                            "Close without applying this panel’s changes (Esc). The bot has not been created yet."),
            // Restaurar returns to the look this sheet opened with (the initial look is random, not Dexter's default).
            baseline: mascotBeforeSheet?.appearance, restorePoint: .opening, idPrefix: "bot.avatar.mascot",
            closeID: "bot.avatar.close", doneID: "bot.avatar.done",
            onCancel: cancelMascotSheet,
            onDone: { usesMascot = true; mascotBeforeSheet = nil; showsMascotCreator = false })
    }

    /// X / Escape: the creation draft goes back to the look and toggle it had when the sheet opened. Nothing is sent.
    private func cancelMascotSheet() {
        if let previous = mascotBeforeSheet { appearance = previous.appearance; usesMascot = previous.usesMascot }
        mascotBeforeSheet = nil; showsMascotCreator = false
    }

    private var enginePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Assistente").font(.callout.weight(.medium))
            if catalogKnown {
                if available.isEmpty {
                    Text("Esta base não informou nenhum assistente disponível agora.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(available, id: \.self) { engineRow($0) }
                }
                if !others.isEmpty {
                    DisclosureGroup(isExpanded: $showsOthers) {
                        VStack(alignment: .leading, spacing: 2) { ForEach(others, id: \.self) { engineRow($0) } }
                    } label: {
                        Text("Outros (não instalados)").font(.callout).foregroundStyle(.secondary)
                    }
                    .accessibilityIdentifier("bot.engine.others")
                }
            } else {
                ForEach(EngineID.allCases, id: \.self) { engineRow($0) }
            }
            Text(engineHint)
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bot.engine.hint")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot.engine")
    }

    private func engineRow(_ option: EngineID) -> some View {
        let selected = engine == option
        return Button {
            engine = option; engineTouched = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary).accessibilityHidden(true)
                Image(systemName: EngineSymbol.systemName(option.rawValue)).foregroundStyle(.secondary).frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: option.displayName)
                    Text(readiness(option).label(portuguese: isPortuguese)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isCreating || createdBotID != nil)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier("bot.engine.\(option.rawValue)")
    }

    private var engineHint: String {
        switch readiness(engine) {
        case .checking:
            return text("Consultando os assistentes desta base… O bot pode ser criado enquanto a consulta termina.")
        case .availableLoginUnconfirmed:
            return text("A base encontrou este assistente. O login fica no programa oficial dele; o Dexter não o confirma.")
        case .notReported:
            return text("A base ainda não informou o estado dos assistentes. O bot pode ser criado; confira o modelo depois em Ajustes do bot.")
        case .notFound, .foundUnsupported, .foundUnavailable:
            return text("O bot pode ser criado, mas só responderá quando este assistente estiver disponível nesta base. Confira em Ajustes › Assistentes.")
        }
    }

    private func create() {
        guard !isCreating, createdBotID == nil, !creationUnconfirmed, isVisible, model.canUseHost, !trimmedName.isEmpty else { return }
        let requestedName = trimmedName, requestedRole = trimmedRole, requestedEngine = engine
        let requestedAppearance = usesMascot ? appearance : nil
        let host = model.hostAddress, hostScope = model.nativeComposerScope
        let token = presentationToken
        isCreating = true
        creationFailure = nil; roleNotice = nil
        Task {
            defer { isCreating = false }
            // One creation request: the optional recipe is part of it, never a follow-up PATCH.
            let outcome = await model.createBot(name: requestedName, engine: requestedEngine, avatarAppearance: requestedAppearance)
            // Closing the sheet never retries or cancels a mutation that has already been dispatched.
            guard !Task.isCancelled, isVisible, presentationToken == token else { return }
            let currentHost = model.hostAddress == host && model.nativeComposerScope == hostScope && model.canUseHost
            let created: Bot?
            switch outcome {
            case .created(let botID):
                created = currentHost ? model.bots.first { $0.id == botID && $0.avatarAppearance == requestedAppearance } : nil
            case .refused:
                // The host refused before creating anything: the owner may correct and send again.
                creationFailure = model.errorMessage ?? pair("A base recusou a criação. Ajuste e tente de novo.",
                                                              "The host refused the creation. Adjust and try again.")
                return
            case .unconfirmed:
                created = nil
            }
            guard let created else {
                // Possibly created (unknown outcome, other host, or not found in the list): never offer a second send here.
                creationUnconfirmed = true; creationFailure = nil
                return
            }
            createdBotID = created.id
            guard !requestedRole.isEmpty, model.canEditBotProfiles else { dismiss(); return }
            // The role rides the profile's own CAS on the new bot's revision; one attempt, never resent.
            do {
                _ = try await model.updateBotProfile(botID: created.id,
                                                     input: PatchBotInput(expectedRevision: created.revision, roleDescription: requestedRole))
                guard isVisible, presentationToken == token else { return }
                dismiss()
            } catch HostClientError.mutationOutcomeUnknown {
                roleNotice = text("O bot foi criado. Não foi possível confirmar se a função foi salva; confira em Ajustes do bot › Perfil. Nada foi reenviado.")
            } catch {
                roleNotice = text("O bot foi criado, mas a função não foi salva. Defina em Ajustes do bot › Perfil.")
            }
        }
    }
}
#endif
