#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// The team settings window: one team (or one new team) at a time, chosen by the router. A member's settings open
/// in the bot settings window, never as a sheet on top of this one.
@MainActor struct TeamSettingsWindowRoot: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(DexterWindowRouter.self) private var router
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    /// Taken once per router target on the base it was asked on, with the team snapshot of that moment (or a new
    /// team). The editor lives as long as this session, never as long as `model.teams`.
    @State private var session: SettingsEditorSession?

    private func onCurrentBase(_ target: TeamSettingsTarget) -> Bool {
        target.matches(hostScope: model.nativeComposerScope, hostAddress: model.hostAddress)
    }

    var body: some View {
        Group {
            if let session, session.id == router.teamTarget?.id {
                TeamEditorView(team: session.team, model: model, session: session,
                    request: router.teamRequest,
                    openBotSettings: { bot in
                        guard session.isCurrent(in: model), model.bots.contains(where: { $0.id == bot.id }) else { return }
                        router.requestBotSettings(botID: bot.id, section: .profile, hostScope: session.hostScope, hostAddress: session.hostAddress)
                        openWindow(id: DexterMacWindowID.botSettings)
                    },
                    onAcceptSwitch: { token in router.acceptTeamSwitch(token) },
                    onDeclineSwitch: { token in router.declineTeamSwitch(token) },
                    onClose: {
                        session.close()
                        router.closeTeamSettings(session.id)
                        dismissWindow(id: DexterMacWindowID.teamSettings)
                    })
                    .id(session.id)
            } else if let target = router.teamTarget, !onCurrentBase(target) {
                VStack(spacing: 14) {
                    ContentUnavailableView("Estes ajustes eram de outra base", systemImage: "arrow.triangle.2.circlepath",
                        description: Text("A conexão com a base mudou depois do pedido. Nada foi aberto nem criado aqui. Feche e abra os ajustes do time de novo pela janela principal."))
                    Button("Fechar") {
                        router.closeTeamSettings(target.id)
                        dismissWindow(id: DexterMacWindowID.teamSettings)
                    }.keyboardShortcut(.defaultAction).accessibilityIdentifier("team-settings-window.stale-close")
                }
                .frame(minWidth: 480, minHeight: 320)
                .accessibilityIdentifier("team-settings-window.stale")
            } else {
                ContentUnavailableView("Nenhum time escolhido", systemImage: "person.3",
                    description: Text("Abra Ajustes do time pelo botão direito num time ou crie um com + › Novo time."))
                    .frame(minWidth: 480, minHeight: 320)
                    .accessibilityIdentifier("team-settings-window.empty")
            }
        }
        // Current name while the session is valid (a saved rename shows); the snapshot's name once it retired.
        .navigationTitle(session.flatMap { session in
            session.team.map { team in (session.isCurrent(in: model) ? model.teams.first(where: { $0.id == team.id })?.name : nil) ?? team.name }
        } ?? String(localized: "Ajustes do time"))
        .errorAlert(model: model, isActive: Binding(get: { router.errorPresenter == .teamSettings }, set: { _ in }))
        .modifier(DexterWindowRoleTracker(role: .teamSettings))
        .onAppear { router.teamWindowAppeared(); adoptTarget(); answerWithoutEditor() }
        .onDisappear { session?.close(); session = nil; router.teamWindowDisappeared() }
        .onChange(of: router.teamRequest?.token) { _, _ in answerWithoutEditor() }
        .onChange(of: router.teamTarget?.id) { _, _ in adoptTarget(); answerWithoutEditor() }
        .onChange(of: model.teams.map(\.id)) { _, _ in if session == nil { adoptTarget(); answerWithoutEditor() } }
    }

    /// One session per router target, only on the base it was asked on and only with the team visible there now
    /// (or a new team). A new target retires the previous session first; a list or host change never replaces it.
    private func adoptTarget() {
        guard let target = router.teamTarget else { session?.close(); session = nil; return }
        if session?.id == target.id { return }
        session?.close(); session = nil
        guard onCurrentBase(target), model.canEditTeams else { return }
        let kind: SettingsEditorSession.Target
        if let teamID = target.teamID {
            guard let team = model.teams.first(where: { $0.id == teamID }) else { return }
            kind = .team(team)
        } else { kind = .newTeam }
        session = SettingsEditorSession(target: kind, model: model, id: target.id, hostScope: target.hostScope, hostAddress: target.hostAddress)
    }

    /// No editor, no drafts: accept a switch to a target on the current base, decline anything else.
    private func answerWithoutEditor() {
        guard session == nil, let request = router.teamRequest else { return }
        if onCurrentBase(request.target) { router.acceptTeamSwitch(request.token) } else { router.declineTeamSwitch(request.token) }
    }
}

/// Team edits are atomic owner-local CAS operations; they do not change bot grants or communication flags.
@MainActor struct TeamEditorView: View {
    let model: DexterAppModel
    let onClose: () -> Void
    let request: TeamSettingsRequest?
    let openBotSettings: (Bot) -> Void
    let onAcceptSwitch: (UUID) -> Void
    let onDeclineSwitch: (UUID) -> Void
    /// The window's session, kept for this editor's lifetime (`init` re-runs on parent updates; the first value stays).
    @State private var session: SettingsEditorSession
    @State private var baseline: Team?
    @State private var name: String
    @State private var avatarEmoji: String
    @State private var avatar: AvatarEditorController
    @State private var removedAvatarImage = false
    @State private var roleDescription: String
    @State private var memberIDs: Set<String>
    @State private var coordinatorID: String
    @State private var rules: String
    @State private var memory: String
    @State private var creationID: String
    @State private var pendingCreate: CreateTeamInput?
    @State private var section: EditorSection = .profile
    @State private var busy = false
    @State private var requiresReload = false
    @State private var notice: String?
    @State private var active = true
    @State private var generation = UUID()
    @State private var requestTask: Task<Void, Never>?
    @State private var confirmingDiscard = false
    @State private var confirmingReload = false
    /// A switch to another team waits here until the owner decides about drafts or the pending creation.
    @State private var pendingSwitch: UUID?
    private enum EditorSection: String, CaseIterable { case profile, members, instructions }

    init(team: Team?, model: DexterAppModel, session: SettingsEditorSession? = nil,
         avatarController: AvatarEditorController? = nil,
         request: TeamSettingsRequest? = nil,
         openBotSettings: @escaping (Bot) -> Void = { _ in },
         onAcceptSwitch: @escaping (UUID) -> Void = { _ in },
         onDeclineSwitch: @escaping (UUID) -> Void = { _ in },
         onClose: @escaping () -> Void) {
        self.model = model; self.onClose = onClose; self.request = request; self.openBotSettings = openBotSettings
        self.onAcceptSwitch = onAcceptSwitch; self.onDeclineSwitch = onDeclineSwitch
        _session = State(initialValue: session ?? SettingsEditorSession(target: team.map { .team($0) } ?? .newTeam, model: model))
        let recovered = team == nil ? model.pendingTeamCreation : nil
        let preferred = model.bots.first(where: { !$0.isMaster }) ?? model.bots.first
        let members = team?.botIds ?? recovered?.botIds ?? preferred.map { [$0.id] } ?? []
        _baseline = State(initialValue: team)
        _name = State(initialValue: team?.name ?? recovered?.name ?? "")
        _avatarEmoji = State(initialValue: team?.avatarEmoji ?? recovered?.avatarEmoji ?? "")
        _avatar = State(initialValue: avatarController ?? AvatarEditorController())
        _roleDescription = State(initialValue: team?.roleDescription ?? recovered?.roleDescription ?? "")
        _memberIDs = State(initialValue: Set(members))
        _coordinatorID = State(initialValue: team?.coordinatorBotId ?? recovered?.coordinatorBotId ?? preferred?.id ?? "")
        _rules = State(initialValue: team?.rules ?? recovered?.rules ?? "")
        _memory = State(initialValue: team?.memory ?? recovered?.memory ?? "")
        _creationID = State(initialValue: recovered?.clientRequestId ?? UUID().uuidString.lowercased())
        _pendingCreate = State(initialValue: recovered)
        _requiresReload = State(initialValue: recovered != nil)
        _notice = State(initialValue: recovered == nil ? nil : String(localized: "A criação anterior não foi confirmada. Recarregue os times e repita a mesma solicitação para recuperar o resultado."))
    }
    /// False for good once the base, address, host identity or this team changed since the window opened.
    private var scopeMatches: Bool { session.isCurrent(in: model) }
    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var cleanEmoji: String { avatarEmoji.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var emojiValid: Bool {
        cleanEmoji.isEmpty || (cleanEmoji.count == 1 && cleanEmoji.utf16.count <= 16 && cleanEmoji.unicodeScalars.contains { $0.value > 127 && $0.properties.isEmoji })
    }
    private var selectedMembers: [Bot] { model.bots.filter { memberIDs.contains($0.id) } }
    private var avatarHasImage: Bool { avatar.imageDraft != nil || (!removedAvatarImage && baseline?.avatarImage != nil) || pendingCreate?.avatarImageId != nil }
    private var avatarDirty: Bool { avatar.imageDraft != nil || (removedAvatarImage && baseline?.avatarImage != nil) }
    private var working: Bool { busy || avatar.isGenerating }
    private var valid: Bool {
        scopeMatches && model.canEditTeams && !cleanName.isEmpty && cleanName.utf16.count <= 120 && (emojiValid || avatarHasImage)
        && roleDescription.utf16.count <= 2_000 && rules.utf16.count <= 8_192 && memory.utf16.count <= 8_192
        && !memberIDs.isEmpty && memberIDs.count <= Team.maximumMembers && selectedMembers.count == memberIDs.count
        && memberIDs.contains(coordinatorID)
    }
    private var dirty: Bool {
        guard let baseline else { return !cleanName.isEmpty || !cleanEmoji.isEmpty || avatarDirty || !roleDescription.isEmpty || !rules.isEmpty || !memory.isEmpty }
        return cleanName != baseline.name || cleanEmoji != (baseline.avatarEmoji ?? "") || roleDescription != baseline.roleDescription
        || memberIDs != Set(baseline.botIds) || coordinatorID != (baseline.coordinatorBotId ?? "") || rules != baseline.rules || memory != baseline.memory || avatarDirty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(baseline == nil ? "Novo time" : "Ajustes do time").font(.title3.bold())
                    Text(verbatim: baseline?.name ?? String(localized: "Reúna bots com um coordenador e contexto próprio."))
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                if scopeMatches {
                    Button("Concluir", action: requestClose).keyboardShortcut("w", modifiers: .command)
                    .disabled(working).accessibilityIdentifier("team-editor.cancel")
                }
            }.padding(20)
            Divider()
            // A retired session freezes the editor before anything else can read or write.
            if scopeMatches { editorContent } else { frozenContent }
        }
        .frame(minWidth: 600, idealWidth: 760, minHeight: 520, idealHeight: 700)
        // A window, not a sheet: its close button and ⌘W wait while drafts, a request or a pending creation exist.
        .background(MacWindowCloseGuard(blocksClose: working || dirty || pendingCreate != nil))
        .confirmationDialog(pendingSwitch == nil ? "Fechar os ajustes?" : "Fechar e abrir outro time?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button(scopeMatches ? "Fechar" : "Descartar e fechar", role: .destructive, action: finish)
            Button(scopeMatches ? "Continuar editando" : "Cancelar", role: .cancel) {
                if let token = pendingSwitch { onDeclineSwitch(token) }
                pendingSwitch = nil
            }
        } message: {
            Text(pendingCreate != nil ? "A criação pode ter sido aplicada. A solicitação será mantida para recuperar o resultado ao abrir Novo time novamente."
                 : scopeMatches ? "As edições não salvas serão descartadas." : "Esta janela não pode mais salvar. Os rascunhos serão descartados; nada é salvo nem reenviado.")
        }
        .confirmationDialog("Recarregar e descartar edições?", isPresented: $confirmingReload, titleVisibility: .visible) {
            Button("Recarregar", role: .destructive, action: reload)
            Button("Manter edições", role: .cancel) {}
        }
        .onChange(of: request?.token) { _, _ in
            guard let request, active, !working else { if let request { onDeclineSwitch(request.token) }; return }
            pendingSwitch = request.token
            if dirty || pendingCreate != nil { confirmingDiscard = true } else { finish() }
        }
        .onChange(of: scopeMatches) { _, current in if !current { invalidate() } }
        .onDisappear { active = false; requestTask?.cancel(); avatar.cancelGeneration() }
    }

    @ViewBuilder private var editorContent: some View {
        HStack(spacing: 8) {
            tab(.profile, title: "Perfil", image: "person.3")
            tab(.members, title: "Bots e coordenador", image: "arrow.triangle.branch")
            tab(.instructions, title: "Regras e memória", image: "brain")
        }.padding(.horizontal, 20).padding(.vertical, 12)
        Divider()
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                switch section {
                case .profile: profileContent
                case .members: membersContent
                case .instructions: instructionsContent
                }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }.disabled(busy || pendingCreate != nil)
        if let notice {
            Divider()
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: requiresReload ? "exclamationmark.triangle" : "info.circle")
                Text(notice).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                if requiresReload {
                    Button("Recarregar") { if dirty && baseline != nil { confirmingReload = true } else { reload() } }
                        .disabled(working).accessibilityIdentifier("team-editor.reload")
                }
            }.foregroundStyle(requiresReload ? Color.orange : Color.secondary).padding(16)
        }
        Divider()
        HStack {
            Text("O time mantém suas regras e memória; cada bot mantém suas permissões.")
                .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            if busy { ProgressView().controlSize(.small) }
            Button(pendingCreate == nil ? (baseline == nil ? "Criar time" : "Salvar time") : "Recuperar criação", action: save)
                .buttonStyle(.borderedProminent)
                .disabled(working || !valid || requiresReload || (baseline != nil && !dirty))
                .accessibilityIdentifier("team-editor.save")
        }.padding(20)
    }

    /// Shown once the session retired (another base, address or host, or the team is gone): nothing is read or
    /// saved; drafts stay selectable to be copied; one explicit button closes after confirming the discard.
    private var frozenContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Label("Esta janela não pode mais salvar", systemImage: "exclamationmark.lock")
                    .font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text("A conexão do app mudou depois que estes ajustes abriram: outra base, outro endereço, ou este time não aparece mais nela. Para não ler nem gravar no time errado, esta janela parou. Nada daqui foi lido nem salvo na base atual, e voltar ao endereço anterior não a reativa.")
                    .fixedSize(horizontal: false, vertical: true)
                if dirty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Rascunhos não salvos deste time. Eles ficam aqui só para consulta: selecione e copie o que quiser manter. Nada será salvo sozinho.")
                            .font(.callout).fixedSize(horizontal: false, vertical: true)
                        frozenValue("Nome do time", cleanName)
                        if !roleDescription.isEmpty { frozenValue("Função do time", roleDescription) }
                        if !rules.isEmpty { frozenValue("Regras do time", rules) }
                        if !memory.isEmpty { frozenValue("Memória do time", memory) }
                    }
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("team-editor.frozen.drafts")
                }
                if pendingCreate != nil {
                    Text("A criação deste time não foi confirmada. A solicitação continua guardada no app para ser recuperada em Novo time, na base em que foi feita; nada será reenviado aqui.")
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                }
                Text("Para editar um time da base atual, feche esta janela e abra os ajustes pela janela principal.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button(dirty ? "Descartar rascunhos e fechar…" : "Fechar", role: dirty ? .destructive : nil, action: requestClose)
                        .keyboardShortcut("w", modifiers: .command)
                        .accessibilityIdentifier("team-editor.frozen.close")
                }
            }.padding(20)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("team-editor.frozen")
    }

    private func frozenValue(_ label: LocalizedStringKey, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(verbatim: value.isEmpty ? "—" : value).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func tab(_ value: EditorSection, title: LocalizedStringKey, image: String) -> some View {
        Button { section = value } label: { Label(title, systemImage: image).frame(maxWidth: .infinity, minHeight: 36) }
            .buttonStyle(.plain).font(.system(size: 13, weight: .medium))
            .background(section == value ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .disabled(working).accessibilityIdentifier("team-editor.tab.\(value.rawValue)")
            .accessibilityAddTraits(section == value ? [.isSelected] : [])
    }
    private var profileContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Nome do time").font(.subheadline.bold())
                TextField("Ex.: Casa, Social ou ExampleMCP", text: $name).textFieldStyle(.roundedBorder).accessibilityIdentifier("team-editor.name")
                if cleanName.utf16.count > 120 { Text("O nome pode ter até 120 caracteres.").font(.footnote).foregroundStyle(.orange) }
            }
            AvatarEditorView(controller: avatar, existingImage: baseline?.avatarImage, removedExistingImage: $removedAvatarImage,
                             emoji: $avatarEmoji, model: model, fallbackSystemImage: "person.3", idPrefix: "team-editor.avatar", emojiID: "team-editor.avatar-emoji")
                .padding(16).background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.10)))
            VStack(alignment: .leading, spacing: 8) {
                editor("Função do time", text: $roleDescription, limit: 2_000, id: "team-editor.role", height: 130)
                Text("Descreva a finalidade do time e o que o coordenador deve organizar.").font(.footnote).foregroundStyle(.secondary)
            }
            if let team = baseline, scopeMatches {
                BotSettingsGroup(title: DexterLocalization.text("Arquivos"),
                                 note: DexterLocalization.text("Os bots do time salvam aqui o que criam para o time. Mudar onde ficam os arquivos novos nunca move nem apaga os que já existem."),
                                 id: "team-settings.files") {
                    OutputFilesNamespaceRows(model: model, ref: .team(team.id), owner: .team, idPrefix: "team-settings.files")
                }
            }
        }
    }
    private var membersContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Coordenador").font(.subheadline.bold())
            Picker("Coordenador", selection: $coordinatorID) {
                if !memberIDs.contains(coordinatorID) { Text("Escolha um membro").tag("") }
                ForEach(selectedMembers) { bot in Text(bot.name + (bot.isMaster ? " · Master" : "")).tag(bot.id) }
            }.labelsHidden().accessibilityIdentifier("team-editor.coordinator")
            Text("A conversa do time é conduzida por este bot. O Master pode coordenar quando participa do time.")
                .font(.footnote).foregroundStyle(.secondary)
            if selectedMembers.first(where: { $0.id == coordinatorID })?.isMaster == true {
                Text("A conversa direta com este time funciona. Para delegar pelo Master global, escolha outro coordenador: o Master não pode delegar para si mesmo nem criar um ciclo.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Divider()
            HStack { Text("Membros").font(.subheadline.bold()); Spacer(); Text("\(memberIDs.count)/32").font(.caption).foregroundStyle(.secondary) }
            ForEach(model.bots) { bot in
                HStack(alignment: .top, spacing: 10) {
                    Toggle(isOn: Binding(get: { memberIDs.contains(bot.id) }, set: { changeMember(bot, selected: $0) })) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(bot.name + (bot.isMaster ? " · Master" : ""))
                            Text(readiness(bot)).font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(!memberIDs.contains(bot.id) && memberIDs.count >= Team.maximumMembers)
                        .accessibilityIdentifier("team-editor.member-\(bot.id)")
                    Button("Ajustes do bot…") { openBotSettings(bot) }.buttonStyle(.borderless)
                        .disabled(!model.canEditBotProfiles)
                        .help("Abre os ajustes deste bot na janela Ajustes do bot")
                        .accessibilityIdentifier("team-editor.bot-settings-\(bot.id)")
                }
            }
            if memberIDs.count != selectedMembers.count {
                Text("Há membros indisponíveis. Recarregue ou remova essas referências antes de salvar.").font(.footnote).foregroundStyle(.orange)
                Button("Remover membros indisponíveis") { memberIDs = Set(selectedMembers.map(\.id)); reconcileCoordinator() }
            }
            Text("Adicionar ao time não ativa comunicação ou ferramentas. O coordenador precisa ver bots e enviar ações; os destinatários precisam receber ordens. Ative as Ferramentas do Dexter em Modelos e confira as permissões de cada bot.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
    private var instructionsContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            editor("Regras do time", text: $rules, limit: 8_192, id: "team-editor.rules", height: 150)
            Text("Regras compartilhadas para a coordenação deste time.").font(.footnote).foregroundStyle(.secondary)
            editor("Memória do time", text: $memory, limit: 8_192, id: "team-editor.memory", height: 150)
            Text("Contexto próprio do time. A memória e as instruções individuais dos bots são editadas nos ajustes de cada bot.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
    private func editor(_ title: LocalizedStringKey, text: Binding<String>, limit: Int, id: String, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack { Text(title).font(.subheadline.bold()); Spacer(); Text("\(text.wrappedValue.utf16.count)/\(limit)").font(.caption).foregroundStyle(text.wrappedValue.utf16.count > limit ? Color.orange : Color.secondary) }
            TextEditor(text: text).font(.body).frame(minHeight: height)
                .padding(6).background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25)))
                .accessibilityLabel(title).accessibilityIdentifier(id)
        }
    }
    private func readiness(_ bot: Bot) -> String {
        if bot.id == coordinatorID { return bot.canSeeBots && bot.canSendActions ? String(localized: "Pode ver bots e enviar ações") : String(localized: "Confira Ver bots e Enviar ações nos ajustes") }
        return bot.canReceiveOrders ? String(localized: "Pode receber ordens") : String(localized: "Receber ordens está desativado")
    }
    private func changeMember(_ bot: Bot, selected: Bool) {
        if selected { memberIDs.insert(bot.id) } else { memberIDs.remove(bot.id) }
        reconcileCoordinator()
    }
    private func reconcileCoordinator() {
        if !memberIDs.contains(coordinatorID) {
            coordinatorID = selectedMembers.first(where: { !$0.isMaster })?.id ?? selectedMembers.first?.id ?? ""
        }
    }
    private func save() {
        guard active, valid, !working, !requiresReload, let hostID = model.teamHostID else { return }
        busy = true; notice = nil
        let token = generation
        let draftImage = avatar.imageDraft
        let removeImage = removedAvatarImage
        requestTask = Task { @MainActor in
            do {
                let imagePatch: AvatarImageIDPatch
                let imageID: String?
                if let recovered = pendingCreate {
                    imageID = recovered.avatarImageId; imagePatch = .unchanged
                } else if let draftImage {
                    let uploaded = try await session.perform(in: model, kind: .mutation) { _ in try await model.uploadAvatarImage(draftImage, expectedHostID: hostID) }
                    guard active, scopeMatches, generation == token, !Task.isCancelled else { return }
                    imageID = uploaded.id; imagePatch = .set(uploaded.id)
                } else {
                    imageID = removeImage ? nil : baseline?.avatarImage?.id
                    imagePatch = removeImage ? .clear : .unchanged
                }
                let input = pendingCreate ?? CreateTeamInput(expectedHostID: hostID, clientRequestId: creationID, name: cleanName,
                    avatarEmoji: cleanEmoji.isEmpty || !emojiValid ? nil : cleanEmoji, avatarImageId: imageID,
                    roleDescription: roleDescription, coordinatorBotId: coordinatorID,
                    botIds: model.bots.filter { memberIDs.contains($0.id) }.map(\.id), rules: rules, memory: memory)
                let patch = baseline.map { PatchTeamInput(expectedHostID: hostID, expectedRevision: $0.revision, name: cleanName,
                    avatarEmoji: cleanEmoji.isEmpty || !emojiValid ? .clear : .set(cleanEmoji), avatarImageId: imagePatch,
                    roleDescription: roleDescription, coordinatorBotId: coordinatorID, botIds: input.botIds, rules: rules, memory: memory) }
                let updated: Team
                if let baseline, let patch { updated = try await session.perform(in: model, kind: .mutation) { _ in try await model.updateTeam(teamID: baseline.id, input: patch) } }
                else { updated = try await session.perform(in: model, kind: .mutation) { _ in try await model.createTeam(input: input) } }
                guard active, scopeMatches, generation == token, !Task.isCancelled else { return }
                let wasNew = baseline == nil
                apply(updated); pendingCreate = nil; busy = false; requestTask = nil; notice = String(localized: "Time salvo.")
                if wasNew { model.selectTeam(id: updated.id); finish() }
            } catch {
                guard active, scopeMatches, generation == token, !Task.isCancelled else { return }
                busy = false; requestTask = nil; requiresReload = true
                if baseline == nil { pendingCreate = model.pendingTeamCreation }
                notice = (error as? HostClientError) == .conflict
                    ? String(localized: "O time mudou no host. Recarregue antes de salvar; a alteração não foi reenviada.")
                    : String(localized: "Não foi possível confirmar o salvamento. Recarregue para conferir o estado antes de tentar novamente.")
            }
        }
    }
    private func reload() {
        guard active, scopeMatches, !working, model.canEditTeams else { return }
        busy = true
        let token = generation
        requestTask = Task { @MainActor in
            do {
                let fetched: Team?
                if let baseline { fetched = try await session.perform(in: model) { _ in try await model.reloadTeam(teamID: baseline.id) } }
                else { try await session.perform(in: model) { _ in _ = try await model.reloadTeams() }; fetched = nil }
                guard active, scopeMatches, generation == token, !Task.isCancelled else { return }
                if let fetched { apply(fetched) }
                busy = false; requiresReload = false; requestTask = nil
                notice = pendingCreate == nil ? String(localized: "Estado atual recarregado.") : String(localized: "Times recarregados. Recuperar criação repete a mesma solicitação e o mesmo identificador; os campos estão preservados.")
            } catch {
                guard active, scopeMatches, generation == token, !Task.isCancelled else { return }
                busy = false; requiresReload = true; requestTask = nil; notice = String(localized: "Não foi possível recarregar o time. Confira a conexão com o host.")
            }
        }
    }
    private func apply(_ team: Team) {
        baseline = team; name = team.name; avatarEmoji = team.avatarEmoji ?? ""; roleDescription = team.roleDescription
        memberIDs = Set(team.botIds); coordinatorID = team.coordinatorBotId ?? ""; rules = team.rules; memory = team.memory
        avatar.removeImage(); removedAvatarImage = false
    }
    private func requestClose() {
        guard !working else { return }
        if let token = pendingSwitch { onDeclineSwitch(token); pendingSwitch = nil }
        if dirty || pendingCreate != nil { confirmingDiscard = true } else { finish() }
    }
    private func finish() {
        active = false; requestTask?.cancel(); avatar.cancelGeneration()
        if let token = pendingSwitch { pendingSwitch = nil; onAcceptSwitch(token) } else { onClose() }
    }
    /// The session retired: requests stop and nothing new starts; drafts stay for the frozen panel.
    private func invalidate() {
        if let token = pendingSwitch { onDeclineSwitch(token); pendingSwitch = nil }
        generation = UUID(); requestTask?.cancel(); requestTask = nil; busy = false; requiresReload = true
        confirmingReload = false
        avatar.cancelGeneration()
    }
}

@MainActor struct TeamInspectorView: View {
    let team: Team
    let model: DexterAppModel
    let onClose: () -> Void
    let openEditor: () -> Void
    let openBotSettings: (Bot) -> Void
    let openDelegations: (Bot) -> Void
    /// Opens Automações filtered to one bot; nil hides the shortcut.
    var openAutomations: ((Bot) -> Void)? = nil
    /// Opens the exact bot's Acessos section; nil hides the link.
    var openBotAccess: ((Bot) -> Void)? = nil
    @Environment(\.locale) private var locale
    private var coordinator: Bot? { model.bots.first { $0.id == team.coordinatorBotId } }
    /// Coordinator first, then members in the team's order; each bot once.
    private var memberIDs: [String] {
        var seen = Set<String>()
        return ([team.coordinatorBotId].compactMap { $0 } + team.botIds).filter { seen.insert($0).inserted }
    }
    private var members: [Bot] { memberIDs.compactMap { id in model.bots.first { $0.id == id } } }
    /// Approvals waiting in this team's open conversation, by the bot that asked. Nothing else is read.
    private func waitingApprovals(for botID: String) -> Int {
        guard model.selectedTeamID == team.id, let threadID = model.presentedThreadID else { return 0 }
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        return model.actions(for: threadID).filter {
            $0.request.botId == botID && ApprovalPresentation(action: $0).needsDecision(atMilliseconds: now)
        }.count
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                membersSection
                documentsSection
                if let coordinator { coordinatorSection(coordinator) }
                accessNote
            }
            .padding(.horizontal, 16).padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("team-inspector")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                HStack(spacing: -8) {
                    ForEach(Array(members.prefix(3))) { bot in
                        DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                                         fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 32, appearance: bot.avatarAppearance, mascotSeed: bot.id)
                            .background(RoundedRectangle(cornerRadius: 11).fill(DexterSurface.avatarRing).padding(-3))
                    }
                    if members.isEmpty {
                        DexterAvatarView(image: team.avatarImage, emoji: team.avatarEmoji, fallbackSystemImage: "person.3", model: model, size: 32)
                    }
                }
                .padding(.leading, 3)
                .accessibilityHidden(true)
                Spacer()
                Button("Editar", action: openEditor)
                    .buttonStyle(DexterCapsuleButtonStyle(height: 28))
                    .disabled(!model.canEditTeams)
                    .help("Abrir os ajustes do time")
                    .accessibilityLabel("Ajustes do time")
                    .accessibilityIdentifier("team-inspector.edit")
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).frame(width: 24, height: 24) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Fechar detalhes do time")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: team.name).font(.system(size: 17, weight: .semibold)).lineLimit(2)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: DexterLocalization.format("Time com %@ bots", "\(team.botIds.count)", locale: locale)).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if !team.roleDescription.isEmpty {
                Text(verbatim: team.roleDescription).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).lineLimit(5).textSelection(.enabled)
            }
        }
    }

    private func sectionTitle(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader).padding(.bottom, 4)
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionTitle("Quem está aqui")
            ForEach(memberIDs, id: \.self) { id in
                if let bot = model.bots.first(where: { $0.id == id }) { memberRow(bot) }
                else {
                    Text("Bot indisponível").font(.system(size: 12)).foregroundStyle(.secondary).frame(minHeight: 32)
                }
            }
            Button(action: openEditor) {
                HStack(spacing: 10) {
                    Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                        .frame(width: 32, height: 32)
                        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3])))
                    Text("Adicionar ou remover bots").font(.system(size: 13))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.canEditTeams)
            .help("Abre os ajustes do time em Bots e coordenador")
            .accessibilityIdentifier("team-inspector.members.edit")
        }
    }

    private func memberRow(_ bot: Bot) -> some View {
        let isCoordinator = bot.id == team.coordinatorBotId
        let waiting = waitingApprovals(for: bot.id)
        return HStack(spacing: 10) {
            DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                             fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 32, appearance: bot.avatarAppearance, mascotSeed: bot.id)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: bot.name + (bot.isMaster ? " · Master" : "")).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Group {
                    if isCoordinator, !bot.canSeeBots || !bot.canSendActions {
                        Text("Confira Ver bots e Enviar ações")
                    } else if !isCoordinator, !bot.canReceiveOrders {
                        Text("Receber ordens desativado")
                    } else if bot.roleDescription.isEmpty {
                        Text(verbatim: bot.engine.displayName)
                    } else {
                        Text(verbatim: bot.roleDescription)
                    }
                }
                .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 4)
            if waiting > 0 {
                DexterStatusChip(text: "Espera você", tint: DexterSurface.attention).fixedSize()
                    .help("Há aprovações deste bot na conversa aberta")
            } else {
                DexterStatusChip(text: isCoordinator ? "Coordenador" : "Membro", tint: isCoordinator ? DexterSurface.positive : nil).fixedSize()
            }
            Menu {
                Button("Ajustes do bot") { openBotSettings(bot) }.disabled(!model.canEditBotProfiles)
                Button("Chamadas entre bots") { openDelegations(bot) }.disabled(!model.canEditBotProfiles)
                if let openAutomations {
                    Button("Automações") { openAutomations(bot) }.disabled(!model.canEditBotProfiles)
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).frame(width: 22, height: 28)
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .foregroundStyle(.secondary)
            .accessibilityLabel("Opções de \(bot.name)")
            .accessibilityIdentifier("team-inspector.member.\(bot.id)")
        }
        .frame(minHeight: 46)
        .accessibilityElement(children: .contain)
    }

    private var documentsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Regras e memória do time")
            document("Regras do time", value: team.rules, empty: "Nenhuma regra definida.")
            document("Memória do time", value: team.memory, empty: "Nenhuma memória definida.")
            Text("A memória do time é independente dos documentos individuais dos bots.").font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func coordinatorSection(_ coordinator: Bot) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionTitle("Coordenação")
            shortcut("Ajustes do coordenador", icon: "gearshape") { openBotSettings(coordinator) }
            shortcut("Chamadas do coordenador", icon: "arrow.triangle.branch") { openDelegations(coordinator) }
            if let openAutomations {
                shortcut("Automações do coordenador", icon: "calendar.badge.clock") { openAutomations(coordinator) }
            }
            Text("Inclui as chamadas deste bot em outras conversas e times.").font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 4)
        }
    }

    private func shortcut(_ title: LocalizedStringKey, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 13)).frame(width: 28, height: 28)
                    .background(DexterSurface.chipFill, in: RoundedRectangle(cornerRadius: 8))
                Text(title).font(.system(size: 13))
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary)
            }
            .frame(minHeight: 38).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.canEditBotProfiles)
    }

    private var accessNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "shield.lefthalf.filled").foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text("Participar do time não concede permissões nem ativa comunicação entre bots.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let coordinator, let openBotAccess {
                    Button("Ajustar acessos do coordenador") { openBotAccess(coordinator) }
                        .buttonStyle(.link).font(.system(size: 12))
                        .disabled(!model.canEditBotProfiles)
                        .accessibilityIdentifier("team-inspector.access")
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .dexterPanel(cornerRadius: 14)
    }

    private func document(_ title: LocalizedStringKey, value: String, empty: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 13, weight: .semibold))
            Group {
                if value.isEmpty { Text(empty).foregroundStyle(.secondary) }
                else { Text(verbatim: value).foregroundStyle(.primary) }
            }
            .font(.system(size: 12)).lineLimit(8).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(DexterSurface.insetFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

@MainActor struct TeamThreadsView: View {
    let team: Team
    let model: DexterAppModel
    let onSelectThread: (String) -> Void
    let createConversation: () -> Void
    @State private var notice: String?
    var body: some View {
        ConversationHistoryList(ownerName: team.name,
            items: model.threadHistoryRows(forTeam: team.id).map { ConversationHistoryItem(row: $0, botName: team.name) }, idPrefix: "team-thread", canCreate: !model.isSubmitting && model.canEditTeams,
            creating: model.isSubmitting, loading: model.isLoading, failure: notice,
            create: createConversation, activate: onSelectThread)
            .id("\(model.nativeComposerScope):\(team.id)")
            .task(id: "\(model.nativeComposerScope):\(team.id)") {
                do { _ = try await model.reloadTeamThreads(teamID: team.id); notice = nil }
                catch { if !Task.isCancelled { notice = String(localized: "Não foi possível carregar as conversas do time.") } }
            }
    }
}
#endif
