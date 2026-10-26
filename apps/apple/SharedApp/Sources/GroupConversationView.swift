import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// One collective conversation: you and the group's bots. There is no coordinator. Each message goes to the
/// recipients you choose, and each chosen bot answers at most once (one finite round). Every state shown here
/// comes from the host; nothing is presented as answered, stopped or resumed until the host says so.
@MainActor struct GroupConversationView: View {
    let group: BotGroup
    let coordinator: GroupConversationCoordinator
    let model: DexterAppModel
    let onEdit: () -> Void
    /// Opens a bot's own conversation, where its tool approvals are decided.
    let onOpenBot: (String) -> Void

    @State private var draft = ""
    /// Empty means everyone in the group; one bot sends `.one`, several send `.selected`.
    @State private var picked: Set<String> = []
    @State private var sending = false
    @State private var expandedDispatches: Set<String> = []
    /// Follow/read state of the transcript; local presentation only.
    @State private var transcriptScroll = ChatTranscriptScrollController()
    @FocusState private var composerFocused: Bool

    private var members: [Bot] { group.activeBotIDs.compactMap { id in model.bots.first { $0.id == id } } }
    private func bot(_ id: String?) -> Bot? { id.flatMap { id in model.bots.first { $0.id == id } } }
    private var recipients: GroupRecipients? {
        let ids = members.map(\.id).filter(picked.contains)
        switch ids.count {
        case 0: return members.isEmpty ? nil : .all
        case 1: return .one(ids[0])
        default: return .selected(ids)
        }
    }
    private var canSend: Bool {
        !sending && coordinator.canSend && coordinator.selectedGroupID == group.id && recipients != nil
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.utf16.count <= 8_192
    }
    private var hasActiveDispatch: Bool { coordinator.dispatches.contains { Self.isActive($0.state) } }

    var body: some View {
        VStack(spacing: 0) {
            GroupRosterBar(group: group, model: model, onEdit: onEdit, canEdit: coordinator.canEdit)
            Divider().chatGroupSeparator()
            transcript
            if let unconfirmed = coordinator.unconfirmed { unconfirmedBanner(unconfirmed) }
            if let error = coordinator.error {
                HStack {
                    Text(error).font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Fechar aviso") { coordinator.clearError() }.controlSize(.small)
                }
                .padding(.horizontal, 16).padding(.vertical, 6)
                .accessibilityIdentifier("group.error")
            }
            Divider().chatGroupSeparator()
            if group.archived {
                Label("Grupo arquivado. A conversa fica para leitura; não é possível enviar novas mensagens.", systemImage: "archivebox")
                    .font(.callout).foregroundStyle(.secondary).padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("group.archived")
            } else {
                composer
            }
        }
        .navigationTitle(group.name)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("group.conversation")
        .task(id: group.id) {
            // The coordinator ignores a selection while another read is running; wait briefly for it to finish.
            for _ in 0..<50 where coordinator.busy {
                try? await Task.sleep(for: .milliseconds(100))
                if Task.isCancelled { return }
            }
            await coordinator.open(groupID: group.id)
        }
        // Status is read from the host while a round is still open; it stops on its own when every round ends.
        .task(id: "\(group.id)|\(hasActiveDispatch)") {
            while hasActiveDispatch, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                await coordinator.refreshDispatches()
            }
        }
        .onChange(of: group.activeBotIDs) { _, ids in picked.formIntersection(ids) }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if coordinator.messages.isEmpty {
                        emptyState
                    }
                    ForEach(coordinator.messages) { message in
                        messageRow(message).id(message.id)
                        if message.origin == .human, let dispatch = coordinator.dispatches.first(where: { $0.inputMessageId == message.id }) {
                            dispatchStatus(dispatch)
                        }
                    }
                    // Pages load forward in time (after the last cursor), so newer messages appear below.
                    // The next page appears below without moving the reading position.
                    if coordinator.hasMore {
                        Button("Mostrar mais mensagens") {
                            transcriptScroll.preserveReadingPosition()
                            Task { await coordinator.loadMore() }
                        }
                            .controlSize(.small).disabled(coordinator.busy).frame(maxWidth: .infinity)
                            .accessibilityIdentifier("group.load-more")
                    }
                    Color.clear.frame(height: 1).id("group.bottom")
                }
                .padding(16)
                .chatTranscriptContentProbe()
            }
            .chatTranscriptEdge(fadesUnderToolbar: false)
            // Bot replies and dispatch status follow only while at the end; this person's own send follows again.
            .chatTranscriptFollowing(transcriptScroll, proxy: proxy, bottomID: "group.bottom",
                scope: { ChatScrollScope(host: model.hostAddress, hostScope: model.nativeComposerScope,
                    conversation: "group:\(group.id):\(coordinator.selectedConversationID ?? "")", generation: nil) },
                change: ChatTranscriptChange(count: coordinator.messages.count, lastID: coordinator.messages.last?.id),
                hasContent: !coordinator.messages.isEmpty,
                humanSendID: sending ? coordinator.messages.last(where: { $0.origin == .human })?.id : nil)
        }
    }

    @ViewBuilder private var emptyState: some View {
        VStack(spacing: 6) {
            if coordinator.busy && coordinator.conversation == nil {
                ProgressView("Abrindo a conversa do grupo…").controlSize(.small)
            } else {
                Text("Nenhuma mensagem ainda.").font(.headline)
                Text("Escreva abaixo e escolha quem deve responder. Cada bot escolhido responde uma vez, como ele mesmo.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("group.empty")
    }

    @ViewBuilder private func messageRow(_ message: GroupMessage) -> some View {
        if message.origin == .human {
            HStack {
                Spacer(minLength: 80)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("Você").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(message.content).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("group.message.\(message.id)")
        } else {
            let author = bot(message.authorBotId)
            HStack(alignment: .top, spacing: 10) {
                DexterAvatarView(image: author?.avatarImage, emoji: author?.avatarEmoji,
                                 fallbackSystemImage: author?.engine == .claude ? "sparkles" : "terminal", model: model, size: 28, appearance: author?.avatarAppearance, mascotSeed: author?.id ?? "")
                VStack(alignment: .leading, spacing: 3) {
                    // A bot removed from this host keeps its message; its name is simply no longer known here.
                    Text(author?.name ?? String(localized: "Bot removido")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(message.content).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(DexterSurface.bubbleFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .chatMessageBackdrop(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(DexterSurface.bubbleStroke))
                }
                Spacer(minLength: 80)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("group.message.\(message.id)")
        }
    }

    // MARK: Dispatch status

    /// Host reason codes in plain words; an unknown code is shown as such, never guessed.
    static func reasonText(_ code: String) -> String {
        switch code {
        case "engine_failed": String(localized: "O motor deste bot falhou ao responder.")
        case "owner_stop": String(localized: "Parado por você.")
        case "host_stopped", "host_locked": String(localized: "A base foi encerrada ou bloqueada antes da resposta.")
        case "host_interrupted_no_redrive", "restart_no_automatic_round":
            String(localized: "A base reiniciou. Nada é reenviado automaticamente.")
        case "membership_revoked": String(localized: "O bot saiu do grupo antes de responder.")
        case "membership_or_authority_changed", "admission_or_authority_changed":
            String(localized: "O grupo ou as permissões mudaram antes de o bot começar.")
        case "admission_refused_before_engine": String(localized: "A base recusou iniciar este bot.")
        default: String(localized: "Código técnico: \(code)")
        }
    }

    static func isActive(_ state: GroupDispatchState) -> Bool {
        switch state {
        case .queued, .held, .running, .awaitingApproval: true
        case .completed, .partial, .cancelled, .failed, .unknown: false
        }
    }
    private func summary(_ dispatch: GroupDispatch) -> String {
        let done = dispatch.recipients.filter { $0.state == .completed }.count, total = dispatch.recipients.count
        switch dispatch.state {
        case .queued: return String(localized: "Na fila. Ainda não começou.")
        case .held: return String(localized: "Pausada. Nada novo será iniciado até você retomar.")
        case .running: return String(localized: "Respondendo: \(done) de \(total) concluídas.")
        case .awaitingApproval: return String(localized: "Um bot aguarda sua aprovação para continuar.")
        case .completed: return String(localized: "Rodada concluída.")
        case .partial: return String(localized: "Rodada encerrada: \(done) de \(total) responderam.")
        case .cancelled: return String(localized: "Rodada parada por você.")
        case .failed: return String(localized: "A rodada falhou. Nenhuma resposta nova virá dela.")
        case .unknown: return String(localized: "Resultado não confirmado pela base. Nada será repetido automaticamente.")
        }
    }
    private func label(_ state: GroupRecipientState) -> String {
        switch state {
        case .queued: String(localized: "Na fila")
        case .admitting: String(localized: "Começando")
        case .running: String(localized: "Respondendo")
        case .awaitingApproval: String(localized: "Aguarda sua aprovação")
        case .completed: String(localized: "Respondeu")
        case .cancelled: String(localized: "Parado")
        case .revoked: String(localized: "Saiu do grupo")
        case .failed: String(localized: "Falhou")
        case .unknown: String(localized: "Sem confirmação")
        }
    }
    private func symbol(_ state: GroupRecipientState) -> (String, Color) {
        switch state {
        case .queued, .admitting: ("clock", .secondary)
        case .running: ("ellipsis.bubble", .accentColor)
        case .awaitingApproval: ("hand.raised", .orange)
        case .completed: ("checkmark.circle", .green)
        case .cancelled, .revoked: ("stop.circle", .secondary)
        case .failed: ("xmark.octagon", .red)
        case .unknown: ("questionmark.circle", .orange)
        }
    }

    @ViewBuilder private func dispatchStatus(_ dispatch: GroupDispatch) -> some View {
        let expanded = expandedDispatches.contains(dispatch.id)
        VStack(alignment: .trailing, spacing: 6) {
            HStack(spacing: 8) {
                Spacer()
                if Self.isActive(dispatch.state) { ProgressView().controlSize(.mini) }
                Text(summary(dispatch)).font(.caption).foregroundStyle(dispatch.state == .unknown || dispatch.state == .failed ? .orange : .secondary)
                    .accessibilityIdentifier("group.dispatch.\(dispatch.id).summary")
                if coordinator.canStop(dispatch) {
                    Button("Parar") { Task { await coordinator.stop(dispatchID: dispatch.id) } }
                        .controlSize(.small).disabled(coordinator.busy || dispatch.stopRequested)
                        .help("Para só esta rodada. Respostas que já chegaram ficam na conversa.")
                        .accessibilityIdentifier("group.dispatch.\(dispatch.id).stop")
                }
                if coordinator.canResume(dispatch) {
                    Button("Retomar") { Task { await coordinator.resume(dispatchID: dispatch.id) } }
                        .controlSize(.small).disabled(coordinator.busy)
                        .help("Inicia somente os bots que ainda estavam na fila. Nada que já começou é repetido.")
                        .accessibilityIdentifier("group.dispatch.\(dispatch.id).resume")
                }
                Button {
                    if expanded { expandedDispatches.remove(dispatch.id) } else { expandedDispatches.insert(dispatch.id) }
                } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .frame(width: 24, height: 24).contentShape(Rectangle())
                }
                    .buttonStyle(.borderless).controlSize(.small)
                    .accessibilityLabel(expanded ? "Ocultar detalhes da rodada" : "Mostrar detalhes da rodada")
                    .accessibilityIdentifier("group.dispatch.\(dispatch.id).details")
            }
            if dispatch.stopRequested && Self.isActive(dispatch.state) {
                Text("Parada pedida. Aguardando a base confirmar.").font(.caption2).foregroundStyle(.secondary)
            }
            if expanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(dispatch.recipients) { recipient in
                        let (icon, tint) = symbol(recipient.state)
                        HStack(spacing: 6) {
                            Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
                            Text(bot(recipient.botId)?.name ?? String(localized: "Bot removido")).font(.caption.weight(.medium))
                            Text(label(recipient.state)).font(.caption).foregroundStyle(.secondary)
                            if recipient.state == .awaitingApproval {
                                Button("Abrir conversa do bot") { onOpenBot(recipient.botId) }.controlSize(.mini)
                                    .disabled(bot(recipient.botId) == nil)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("group.dispatch.\(dispatch.id).recipient.\(recipient.botId)")
                        if let reason = recipient.reason, recipient.state != .completed {
                            Text(Self.reasonText(reason)).font(.caption2).foregroundStyle(.secondary).padding(.leading, 22)
                                .fixedSize(horizontal: false, vertical: true)
                                .help(reason)
                        }
                    }
                }
                .padding(10)
                .background(DexterSurface.insetFill, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("group.dispatch.\(dispatch.id)")
    }

    private func unconfirmedBanner(_ request: GroupUnconfirmedRequest) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).accessibilityHidden(true)
            Text("Não foi possível confirmar o último pedido. Nada será reenviado automaticamente; use Conferir para ler o resultado na base.")
                .font(.footnote).fixedSize(horizontal: false, vertical: true)
            Spacer()
            if coordinator.receiptMissing {
                // Only after the host said it has no record of it: the very same request and ID, sent once more on your click.
                Button("Repetir o mesmo pedido") { Task { await coordinator.retryExactRequest() } }
                    .controlSize(.small).disabled(coordinator.busy)
                    .help("A base não tem registro deste pedido. Repete exatamente os mesmos dados e o mesmo ID (\(request.clientRequestId)); não cria um pedido novo.")
                    .accessibilityIdentifier("group.retry-exact")
            }
            Button("Conferir") { Task { await coordinator.reconcile() } }
                .controlSize(.small).disabled(coordinator.busy)
                .help("Apenas consulta o recibo deste pedido (\(request.clientRequestId)). Não envia nada de novo.")
                .accessibilityIdentifier("group.reconcile")
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Color.orange.opacity(0.08))
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Para:").font(.caption).foregroundStyle(.secondary)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        recipientChip(String(localized: "Todos"), selected: picked.isEmpty, id: "group.recipients.all") { picked = [] }
                        ForEach(members) { bot in
                            recipientChip(bot.name, selected: picked.contains(bot.id), id: "group.recipients.pick.\(bot.id)") {
                                if picked.contains(bot.id) { picked.remove(bot.id) } else { picked.insert(bot.id) }
                            }
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Quem responde")
                .accessibilityIdentifier("group.recipients")
                Spacer(minLength: 8)
                if coordinator.activeDispatch != nil {
                    Text("Aguarde a rodada atual terminar, ou pare-a, para enviar outra mensagem.").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("group.send.waiting")
                } else {
                    Text("Cada bot escolhido responde uma vez.").font(.caption).foregroundStyle(.tertiary)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Mensagem para o grupo", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...8).focused($composerFocused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(DexterSurface.raisedFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(DexterSurface.panelStroke))
                    .accessibilityIdentifier("group.composer")
                Button { send() } label: {
                    Image(systemName: sending ? "hourglass" : "arrow.up").font(.system(size: 13, weight: .bold))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.borderedProminent).clipShape(Circle())
                .disabled(!canSend).keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("Enviar ao grupo")
                .accessibilityIdentifier("group.send")
            }
        }
        .padding(12)
    }

    private func recipientChip(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: selected ? .semibold : .regular)).lineLimit(1)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(selected ? Color.accentColor.opacity(0.22) : DexterSurface.raisedFill, in: Capsule())
                .overlay(Capsule().strokeBorder(selected ? Color.accentColor.opacity(0.6) : DexterSurface.panelStroke))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }

    private func send() {
        guard canSend, let recipients else { return }
        let content = draft
        sending = true
        Task {
            defer { sending = false }
            // The draft is cleared only once the host accepted the message; a failure or unconfirmed send keeps it.
            if await coordinator.send(content: content, recipients: recipients), draft == content { draft = "" }
        }
    }
}
#endif
