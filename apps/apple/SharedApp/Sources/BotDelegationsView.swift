#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Owner-local observation and cancellation; this sheet never starts a delegation.
struct BotDelegationsView: View {
    let bot: Bot
    let model: DexterAppModel
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss
    @State private var client: HostClient?
    @State private var items: [BotDelegation] = []
    @State private var busy = false
    @State private var loaded = false
    @State private var featureUnavailable = false
    @State private var notice: String?
    @State private var confirming: BotDelegation?
    @State private var requiresRefresh: Set<String> = []
    @State private var requestTask: Task<Void, Never>?
    @State private var generation = UUID()

    private func text(_ pt: String, _ en: String) -> String {
        locale.language.languageCode?.identifier == "pt" ? pt : en
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(bot.name).font(.headline)
                    Text(text("Chamadas enviadas e recebidas por este bot. Parar solicita o cancelamento; a confirmação depende do host.", "Calls sent and received by this bot. Stop requests cancellation; confirmation depends on the host."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if client == nil {
                    Section {
                        Text(text("Disponível somente para o proprietário conectado ao host local deste Mac.", "Available only to the owner connected to this Mac’s local host."))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("bot-delegations.local-only")
                    }
                } else {
                    if busy {
                        Section {
                            ProgressView(text("Consultando o host…", "Contacting host…"))
                                .accessibilityIdentifier("bot-delegations.loading")
                        }
                    }
                    if featureUnavailable {
                        Section {
                            Text(text("A comunicação entre bots está desativada ou indisponível neste host.", "Bot communication is disabled or unavailable on this host."))
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("bot-delegations.unavailable")
                        }
                    }
                    if let notice {
                        Section {
                            Text(notice).foregroundStyle(.orange)
                                .accessibilityIdentifier("bot-delegations.notice")
                        }
                    }
                    if loaded && items.isEmpty && !featureUnavailable {
                        Section {
                            Text(text("Nenhuma chamada entre bots registrada.", "No bot calls recorded."))
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("bot-delegations.empty")
                        }
                    }
                    ForEach(items) { item in delegationSection(item) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(text("Chamadas entre bots", "Bot calls"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(text("Concluir", "Done")) { dismiss() }
                        .accessibilityIdentifier("bot-delegations.done")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(text("Atualizar", "Refresh")) { refresh() }
                        .disabled(busy || client == nil || !model.canEditBotProfiles)
                        .accessibilityIdentifier("bot-delegations.refresh")
                }
            }
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 420, idealHeight: 620)
        .confirmationDialog(text("Parar esta chamada?", "Stop this call?"), isPresented: Binding(
            get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
                if let item = confirming {
                    Button(text("Solicitar cancelamento", "Request cancellation"), role: .destructive) {
                        confirming = nil
                        cancel(item)
                    }
                }
                Button(text("Voltar", "Back"), role: .cancel) { confirming = nil }
            } message: {
                Text(text("O host pode ainda estar executando a chamada. Atualize para conferir o estado após a solicitação.", "The host may still be running the call. Refresh to check its state after the request."))
            }
        .task(id: model.hostAddress + "|" + model.backendLabel) { open() }
        .onDisappear { close() }
    }

    private func delegationSection(_ item: BotDelegation) -> some View {
        Section {
            Text(verbatim: "\(botName(item.sourceBotId)) → \(botName(item.targetBotId))")
                .font(.headline)
            LabeledContent(text("Estado", "State"), value: stateLabel(item.state))
            LabeledContent(text("Prazo", "Deadline")) {
                Text(Date(timeIntervalSince1970: Double(item.deadlineAt) / 1000), format: .dateTime)
            }
            if let result = item.result, !result.isEmpty {
                Text(verbatim: String(result.prefix(300))).lineLimit(3)
            }
            if item.state == .unknown {
                Text(text("O resultado desta chamada é desconhecido. Atualize para conferir o estado; o cancelamento está bloqueado.", "This call’s outcome is unknown. Refresh to check its state; cancellation is blocked."))
                    .font(.footnote).foregroundStyle(.orange)
            }
            DisclosureGroup(text("Detalhes", "Details")) {
                detail(text("ID", "ID"), item.id)
                detail(text("Conversa de origem", "Source thread"), item.sourceThreadId)
                detail(text("Conversa de destino", "Target thread"), item.targetThreadId)
                detail(text("Turno de origem", "Source turn"), item.sourceTurnId)
                detail(text("Turno de destino", "Target turn"), item.targetTurnId)
                detail(text("Raiz", "Root"), item.rootId)
                if let parent = item.parentId { detail(text("Chamada anterior", "Parent call"), parent) }
                LabeledContent(text("Profundidade", "Depth"), value: String(item.depth))
                if let result = item.result, !result.isEmpty {
                    Text(verbatim: String(result.prefix(4000)))
                        .textSelection(.enabled)
                    if result.count > 4000 {
                        Text(text("Resultado abreviado.", "Result abbreviated."))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityIdentifier("bot-delegations.details.\(item.id)")
            if item.state.canCancel {
                Button(text("Parar", "Stop"), role: .destructive) { confirming = item }
                    .disabled(busy || requiresRefresh.contains(item.id) || featureUnavailable || !model.canEditBotProfiles)
                    .accessibilityIdentifier("bot-delegations.stop.\(item.id)")
            }
        }
        .accessibilityIdentifier("bot-delegations.item.\(item.id)")
    }

    private func detail(_ title: String, _ value: String) -> some View {
        LabeledContent(title) { Text(verbatim: String(value.prefix(200))).textSelection(.enabled) }
    }

    private func botName(_ id: String) -> String {
        String((model.bots.first { $0.id == id }?.name ?? id).prefix(120))
    }

    private func stateLabel(_ state: BotDelegationState) -> String {
        switch state {
        case .pending: text("Pendente", "Pending")
        case .running: text("Em execução", "Running")
        case .completed: text("Concluída", "Completed")
        case .cancelled: text("Cancelada", "Cancelled")
        case .failed: text("Falhou", "Failed")
        case .unknown: text("Desconhecido", "Unknown")
        }
    }

    private func open() {
        close()
        items = []; loaded = false; featureUnavailable = false; notice = nil; requiresRefresh = []
        client = model.canEditBotProfiles ? model.makeLocalMcpClient() : nil
        refresh()
    }

    private func close() {
        generation = UUID()
        requestTask?.cancel(); requestTask = nil
        client?.close(); client = nil
        busy = false; confirming = nil
    }

    private func refresh() {
        guard !busy, model.canEditBotProfiles, let client else { return }
        busy = true
        let expected = generation
        requestTask = Task { @MainActor in
            do {
                let fetched = try await client.listBotDelegations(botID: bot.id)
                guard !Task.isCancelled, expected == generation else { return }
                items = fetched.sorted { $0.createdAt > $1.createdAt }
                loaded = true; featureUnavailable = false; notice = nil; requiresRefresh = []
            } catch {
                guard !Task.isCancelled, expected == generation else { return }
                featureUnavailable = (error as? HostClientError) == .notReady
                notice = featureUnavailable ? nil : text("Não foi possível atualizar. Os últimos dados foram mantidos. Confira a conexão e use Atualizar.", "Could not refresh. The last data was retained. Check the connection and use Refresh.")
            }
            busy = false; requestTask = nil
        }
    }

    private func cancel(_ item: BotDelegation) {
        guard !busy, !featureUnavailable, model.canEditBotProfiles, let client,
              items.contains(where: { $0.id == item.id && $0.state.canCancel }),
              !requiresRefresh.contains(item.id) else { return }
        busy = true; requiresRefresh.insert(item.id)
        let expected = generation
        requestTask = Task { @MainActor in
            do {
                let updated = try await client.cancelBotDelegation(id: item.id)
                guard !Task.isCancelled, expected == generation else { return }
                if let index = items.firstIndex(where: { $0.id == updated.id }) { items[index] = updated }
                notice = updated.state.canCancel || updated.state == .unknown
                    ? text("Solicitação recebida; o encerramento ainda não foi confirmado. Use Atualizar antes de outra ação.", "Request received; completion is not confirmed yet. Use Refresh before another action.")
                    : text("O host respondeu com o estado atualizado.", "The host returned the updated state.")
            } catch {
                guard !Task.isCancelled, expected == generation else { return }
                featureUnavailable = (error as? HostClientError) == .notReady
                notice = text("Não foi possível confirmar o cancelamento. A solicitação não foi reenviada. Os últimos dados foram mantidos; use Atualizar antes de tentar novamente.", "Could not confirm cancellation. The request was not resent. The last data was retained; use Refresh before trying again.")
            }
            busy = false; requestTask = nil
        }
    }
}
#endif
