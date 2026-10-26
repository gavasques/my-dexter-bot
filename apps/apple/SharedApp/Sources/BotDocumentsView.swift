#if os(macOS)
import DexterAppCore
import DexterHostClient
import Observation
import SwiftUI

/// The sheet owns this state so switching between Profile and Memory preserves edits.
@MainActor @Observable
final class BotDocumentsEditor {
    /// A restore keeps its own wording: it is not a "save" for the owner, and its uncertain outcome is recovered alike.
    enum Notice: Equatable { case loadFailed, conflict, saveUnknown, restoreUnknown, saved, restored(from: Int, revision: Int), confirmed, hostChanged }
    let botID: String
    let hostScope: UUID
    let hostAddress: String
    /// The settings window's session (nil only outside a window); every request is checked against it.
    let session: SettingsEditorSession?
    private let model: DexterAppModel
    private let clientFactory: (@MainActor () -> HostClient?)?
    private var client: HostClient?
    private var generation = UUID()
    private var requestTask: Task<Void, Never>?
    private var active = true
    private(set) var baseline: BotDocuments?
    private(set) var busy = false
    private(set) var requiresReload = false
    private(set) var notice: Notice?
    var soul = ""
    var user = ""
    var memory = ""
    var sourceReference = ""
    var reconcileID = ""
    /// Newest-first window of at most 100 revisions; older ones stay on the host.
    private(set) var historyWindow = BotMemoryHistoryWindow()
    var history: [BotMemoryRevision] { historyWindow.items }
    var canLoadOlderHistory: Bool { historyWindow.canLoadOlder }
    var historyReachedLimit: Bool { historyWindow.reachedLimit }
    private(set) var viewedRevision: BotMemoryVersion?
    private enum Pending {
        case update(PutBotDocumentsInput)
        case restore(RestoreBotMemoryInput, BotDocuments, BotMemoryVersion)
        var id: String { switch self { case .update(let value): value.clientRequestId!; case .restore(let value, _, _): value.clientRequestId } }
    }
    private var pending: Pending?
    var pendingRequestID: String? { pending?.id }
    var canRestore: Bool { canEdit && !dirty && viewedRevision != nil && pending == nil }


    init(botID: String, model: DexterAppModel, session: SettingsEditorSession? = nil, clientFactory: (@MainActor () -> HostClient?)? = nil) {
        self.botID = botID; self.model = model; self.session = session
        self.hostScope = session?.hostScope ?? model.nativeComposerScope
        self.hostAddress = session?.hostAddress ?? model.hostAddress
        self.clientFactory = clientFactory
    }

    var scopeMatches: Bool {
        active && hostScope == model.nativeComposerScope && hostAddress == model.hostAddress && model.canEditBotProfiles
            && (session?.isCurrent(in: model) ?? true)
    }

    /// One request per call, checked against the window's session before and after it: a late answer from a base
    /// this window no longer belongs to is dropped (a write stays unconfirmed and is never replayed).
    private func call<Value: Sendable>(_ kind: SettingsEditorSession.OperationKind, _ client: HostClient,
                                       _ operation: @MainActor (HostClient) async throws -> Value) async throws -> Value {
        guard let session else { return try await operation(client) }
        // In a window, the request uses the client the session hands over for this one call (an injected
        // fixture client is kept for previews/tests); the session is checked before and after it.
        let injected = clientFactory != nil
        return try await session.perform(in: model, kind: kind) { current in try await operation(injected ? client : current) }
    }
    var dirty: Bool {
        guard let baseline else { return !soul.isEmpty || !user.isEmpty || !memory.isEmpty }
        return soul != baseline.soul || user != baseline.user || memory != baseline.memory
    }
    var withinLimit: Bool { [soul, user, memory].allSatisfy { $0.utf16.count <= BotDocuments.maximumUTF16Length } }
    var canEdit: Bool { scopeMatches && baseline != nil && !busy && !requiresReload }
    var canSave: Bool { canEdit && dirty && withinLimit && sourceReference.utf16.count <= 512 && pending == nil }

    func openIfNeeded() {
        guard scopeMatches, baseline == nil, client == nil, !busy else { return }
        client = makeClient()
        reload()
    }

    func close(clearDrafts: Bool = false) {
        generation = UUID(); active = false; requestTask?.cancel(); requestTask = nil
        client?.close(); client = nil; busy = false
        if clearDrafts {
            baseline = nil; soul = ""; user = ""; memory = ""
            requiresReload = true; notice = .hostChanged
        }
    }

    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }
    private func makeClient() -> HostClient? {
        if let clientFactory { return clientFactory() }
        return model.makeLocalMcpClient()
    }

    func reload() {
        guard scopeMatches, !busy else { return }
        if client == nil { client = makeClient() }
        guard let client else { notice = .loadFailed; requiresReload = true; return }
        let token = generation
        busy = true; notice = nil
        requestTask = Task { @MainActor in
            do {
                let value = try await call(.read, client) { try await $0.getBotDocuments(botID: botID) }
                guard accepts(token) else { return }
                baseline = value; soul = value.soul; user = value.user; memory = value.memory
                requiresReload = pending != nil
            } catch {
                guard accepts(token) else { return }
                requiresReload = true; notice = .loadFailed
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }

    func save() {
        guard canSave, let baseline, let client else { return }
        let input = PutBotDocumentsInput(expectedRevision: baseline.revision, soul: soul, user: user, memory: memory,
            clientRequestId: UUID().uuidString, sourceReference: sourceReference.isEmpty ? nil : sourceReference)
        pending = .update(input); reconcileID = input.clientRequestId!
        let token = generation
        busy = true; notice = nil
        requestTask = Task { @MainActor in
            do {
                let value = try await call(.mutation, client) { try await $0.updateBotDocuments(botID: botID, input: input) }
                guard accepts(token) else { return }
                self.baseline = value; pending = nil; sourceReference = ""; historyWindow.reset(); viewedRevision = nil; notice = .saved
            } catch {
                guard accepts(token) else { return }
                requiresReload = true
                if (error as? HostClientError) == .mutationOutcomeUnknown { notice = .saveUnknown }
                else { pending = nil; notice = (error as? HostClientError) == .conflict ? .conflict : .loadFailed }
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
    /// `more` reads the next older page only while the window has room; a full window never issues another GET.
    func loadHistory(more: Bool = false) {
        guard scopeMatches, !busy, let client else { return }
        let cursor = more ? historyWindow.nextCursor : nil
        guard !more || (cursor != nil && historyWindow.canLoadOlder) else { return }
        let token = generation
        busy = true
        requestTask = Task { @MainActor in
            do {
                let page = try await call(.read, client) { try await $0.getBotMemoryHistory(botID: botID, before: cursor) }
                guard accepts(token) else { return }
                if let cursor { historyWindow.appendOlder(page, requestedWith: cursor) } else { historyWindow.replace(with: page) }
            } catch { guard accepts(token) else { return }; notice = .loadFailed }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
    func readRevision(_ revision: Int) {
        guard scopeMatches, !busy, let client else { return }
        let token = generation; busy = true
        requestTask = Task { @MainActor in
            do {
                let value = try await call(.read, client) { try await $0.getBotMemoryRevision(botID: botID, revision: revision) }
                guard accepts(token) else { return }; viewedRevision = value
            } catch { guard accepts(token) else { return }; notice = .loadFailed }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
    /// Called only by the exact human confirmation for the visible version and current baseline.
    func restore(_ version: BotMemoryVersion, expected: Int, reference: String) {
        guard canRestore, let baseline, baseline.revision == expected, viewedRevision == version, sourceReference == reference, reference.utf16.count <= 512, let client else { return }
        let input = RestoreBotMemoryInput(expectedRevision: expected, fromRevision: version.revision, clientRequestId: UUID().uuidString,
            sourceReference: reference.isEmpty ? nil : reference)
        pending = .restore(input, baseline, version); reconcileID = input.clientRequestId
        let token = generation; busy = true; notice = nil
        requestTask = Task { @MainActor in
            do {
                let value = try await call(.mutation, client) { try await $0.restoreBotMemory(botID: botID, input: input) }
                guard accepts(token) else { return }
                guard value.soul == baseline.soul, value.user == baseline.user, value.memory == version.markdown else { throw HostClientError.mutationOutcomeUnknown }
                self.baseline = value; memory = value.memory; pending = nil; sourceReference = ""; historyWindow.reset(); viewedRevision = nil
                notice = .restored(from: version.revision, revision: value.revision)
            } catch {
                guard accepts(token) else { return }; requiresReload = true
                if (error as? HostClientError) == .mutationOutcomeUnknown { notice = .restoreUnknown }
                else { pending = nil; notice = (error as? HostClientError) == .conflict ? .conflict : .loadFailed }
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }
    /// No disk client journal: the original ID may be entered after reopening. This never creates an ID or retries.
    func reconcile() {
        guard scopeMatches, !busy, let client else { return }
        let requestID = pending?.id ?? reconcileID, original = pending, token = generation
        guard !requestID.isEmpty else { return }; busy = true
        requestTask = Task { @MainActor in
            do {
                let effect = try await call(.read, client) { try await $0.getBotDocumentReceipt(botID: botID, clientRequestID: requestID) }
                guard accepts(token) else { return }
                if let original {
                    switch original {
                    case .update(let input):
                        guard effect.revision == input.expectedRevision + 1, effect.soul == input.soul, effect.user == input.user, effect.memory == input.memory else { throw HostClientError.contractMismatch }
                    case .restore(let input, let prior, let version):
                        guard effect.revision == input.expectedRevision + 1, effect.memoryHead?.restoredFrom == input.fromRevision,
                              effect.soul == prior.soul, effect.user == prior.user, effect.memory == version.markdown else { throw HostClientError.contractMismatch }
                    }
                }
                let current = try await call(.read, client) { try await $0.getBotDocuments(botID: botID) }
                guard accepts(token) else { return }
                pending = nil; requiresReload = false
                switch original {
                case .restore(let input, _, _)?: notice = .restored(from: input.fromRevision, revision: effect.revision)
                case .update?: notice = .saved
                case nil: notice = .confirmed
                }
                baseline = current; soul = current.soul; user = current.user; memory = current.memory
                sourceReference = ""; historyWindow.reset(); viewedRevision = nil
            } catch {
                guard accepts(token) else { return }
                if case .restore? = original { notice = .restoreUnknown } else { notice = .saveUnknown }
                requiresReload = true
            }
            guard accepts(token) else { return }; busy = false; requestTask = nil
        }
    }

}

@MainActor struct BotDocumentsView: View {
    enum Document: String, CaseIterable { case soul, user, memory }
    private enum MemoryChange { case changed, unchanged, unknown }
    @Bindable var editor: BotDocumentsEditor
    /// UI R1: the window's owner-configuration presenter for "Trechos sugeridos para guardar" (nil outside a window).
    var owner: BotOwnerConfigurationPresenter? = nil
    var botName = ""
    var onOpenMcp: () -> Void = {}
    /// Long-term memory proposals for this bot (nil outside the settings window). The documents stay unchanged.
    var learning: MemoryLearningEditor? = nil
    @Environment(\.locale) private var locale
    @State private var selected: Document = .soul
    @State private var confirmingReload = false
    @State private var restoreConfirmation: BotMemoryVersion?
    @State private var restoreExpected: Int?
    @State private var restoreReference = ""
    @State private var historyRequestedAt: Int?
    @State private var showsVersionDetails = false
    @State private var showsRecovery = false
    @State private var showsTechnical = false

    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private func title(_ document: Document) -> String {
        switch document {
        case .soul: text("Personalidade", "Personality")
        case .user: text("Sobre você", "About you")
        case .memory: text("Memória", "Memory")
        }
    }
    private var documentText: Binding<String> {
        switch selected { case .soul: $editor.soul; case .user: $editor.user; case .memory: $editor.memory }
    }
    private var explanation: String {
        switch selected {
        case .soul: text("Como este bot fala e trabalha: personalidade, função e instruções que valem sempre.", "How this bot talks and works: personality, role and instructions that always apply.")
        case .user: text("Preferências e informações sobre você que deseja compartilhar somente com este bot.", "Preferences and information about you to share only with this bot.")
        case .memory: text("Notas duradouras para este bot lembrar nas próximas conversas. Edite e salve quando quiser.", "Lasting notes for this bot to remember in future conversations. Edit and save whenever you want.")
        }
    }
    private func automationLabel(_ mode: BotDocumentsAutomation.Mode) -> String {
        switch mode {
        case .automatic: text("Automática", "Automatic")
        case .ask: text("Pede aprovação", "Requires approval")
        case .denied: text("Bloqueada", "Blocked")
        case .expired: text("Permissão expirada", "Permission expired")
        }
    }

    /// A read-only snapshot from this window's own-bot GET. It never changes a grant or overrides the host.
    private var automationStatus: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(text("Gravação pelo bot", "Saving by the bot")).font(.subheadline.weight(.semibold))
            if editor.scopeMatches, !editor.requiresReload, let status = editor.baseline?.automation {
                HStack(alignment: .firstTextBaseline) {
                    Text(text("Personalidade, Sobre você e Memória", "Personality, About you and Memory"))
                    Spacer()
                    Text(automationLabel(status.updates)).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("bot-documents.automation.updates")
                HStack(alignment: .firstTextBaseline) {
                    Text(text("Adicionar notas à Memória", "Append notes to Memory"))
                    Spacer()
                    Text(automationLabel(status.append)).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("bot-documents.automation.append")
                Text(text("Automática permite ao bot gravar durante suas conversas privadas sem pedir um novo clique. Aprovação, bloqueio ou expiração definidos na base continuam valendo.", "Automatic lets the bot save during your private conversations without asking for another click. Approval requirements, blocks or expiry set on the host still apply."))
                    .foregroundStyle(.secondary)
            } else {
                Text(text("Esta base não confirmou o estado da gravação automática pelo bot. Use Recarregar para consultar; a falta deste estado não concede permissão.", "This host has not confirmed the bot’s automatic saving status. Use Reload to check; missing status grants no permission."))
                    .foregroundStyle(.secondary)
            }
            Text(text("Somente documentos privados deste bot, guardados na base conectada. Apagar um documento ou restaurar uma versão exige sua confirmação. Estes textos não liberam ferramentas, contas ou permissões.", "Only this bot’s private documents, saved on the connected host. Clearing a document or restoring a version requires your confirmation. These texts grant no tools, accounts or permissions."))
                .foregroundStyle(.secondary).accessibilityIdentifier("bot-documents.automation.boundaries")
        }
        .font(.footnote).fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-documents.automation")
    }
    /// The protocol name of each document. Shown only in Detalhes técnicos; the IDs and the API keep it.
    private func fileName(_ document: Document) -> String { document.rawValue.uppercased() + ".md" }
    private var noticeText: String? {
        switch editor.notice {
        case .none: nil
        case .loadFailed: text("Não foi possível concluir a consulta ou o salvamento. Confira a conexão e use Recarregar.", "Could not complete the lookup or save. Check the connection and use Reload.")
        case .conflict: text("Os documentos mudaram na base. Suas edições foram mantidas; recarregue para conferir antes de salvar novamente.", "The documents changed on the host. Your edits were retained; reload to check before saving again.")
        case .saveUnknown: text("Não foi possível confirmar se o salvamento terminou. Nada será reenviado automaticamente. Na aba Memória, use Recuperar pedido não confirmado (já aberto em Versões e detalhes técnicos). O app não guarda este pedido ao fechar: se precisar fechar antes de conferir, use Copiar ID.", "Could not confirm whether the save finished. Nothing will be resent automatically. On the Memory tab, use Recover an unconfirmed request (already open under Versions and technical details). The app does not keep this request after closing: if you need to close before checking, use Copy ID.")
        case .restoreUnknown: text("Não foi possível confirmar se a restauração terminou. Nada será reenviado automaticamente. Na aba Memória, use Recuperar pedido não confirmado (já aberto em Versões e detalhes técnicos). O app não guarda este pedido ao fechar: se precisar fechar antes de conferir, use Copiar ID.", "Could not confirm whether the restore finished. Nothing will be resent automatically. On the Memory tab, use Recover an unconfirmed request (already open under Versions and technical details). The app does not keep this request after closing: if you need to close before checking, use Copy ID.")
        // The host takes the documents when a response starts running, not when the message was sent.
        case .saved: text("Salvo. Vale para cada resposta que começar depois disto, inclusive mensagens que ainda estão na fila; uma resposta já em andamento continua com a versão anterior.", "Saved. It applies to every response that starts after this, including messages still in the queue; a response already running keeps the previous version.")
        case .restored(let from, let revision): text("Restaurado: a memória da versão \(from) agora é a versão \(revision). Vale para cada resposta que começar depois disto, inclusive mensagens na fila; uma resposta já em andamento continua com a versão anterior.", "Restored: the memory from version \(from) is now version \(revision). It applies to every response that starts after this, including queued messages; a response already running keeps the previous version.")
        case .confirmed: text("Pedido confirmado pela base. Vale para cada resposta que começar depois disto.", "Request confirmed by the host. It applies to every response that starts after this.")
        case .hostChanged: text("A conexão com a base mudou. Feche e abra novamente os ajustes deste bot.", "The host connection changed. Close and reopen this bot’s settings.")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView { editorContent.padding(20) }
            Divider()
            HStack {
                Button(text("Recarregar", "Reload")) {
                    if editor.dirty { confirmingReload = true } else { editor.reload() }
                }
                .disabled(editor.busy || !editor.scopeMatches)
                .accessibilityIdentifier("bot-documents.reload")
                Spacer()
                Text(text("Salvar guarda Personalidade, Sobre você e Memória juntos.", "Save keeps Personality, About you and Memory together."))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                if editor.busy { ProgressView().controlSize(.small) }
                Button(text("Salvar alterações", "Save changes"), action: editor.save)
                    .buttonStyle(.borderedProminent).disabled(!editor.canSave)
                    .accessibilityIdentifier("bot-documents.save")
            }.padding(20)
        }
        .task { editor.openIfNeeded() }
        .confirmationDialog(text("Recarregar e descartar suas edições?", "Reload and discard your edits?"), isPresented: $confirmingReload, titleVisibility: .visible) {
            Button(text("Recarregar", "Reload"), role: .destructive) { editor.reload() }
            Button(text("Manter edições", "Keep edits"), role: .cancel) {}
                .keyboardShortcut(.defaultAction)
        } message: {
            Text(text("Personalidade, Sobre você e Memória serão substituídos pelo estado atual da base. Esta ação não salva nem repete o envio anterior.", "Personality, About you and Memory will be replaced with the host’s current state. This action does not save or repeat the previous request."))
        }
    }

    private func memorySourceLabel(_ kind: String) -> String {
        switch kind {
        case "owner_ui": text("Você", "You")
        case "harness_action": text("Bot", "Bot")
        default: text("não registrada", "not recorded")
        }
    }

    private func revisionTimestamp(_ milliseconds: Double) -> String {
        guard milliseconds.isFinite, milliseconds >= 0 else { return text("Data não registrada", "Time not recorded") }
        return Date(timeIntervalSince1970: milliseconds / 1000)
            .formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale))
    }

    /// Compares MEMORY pins only with the adjacent revision actually loaded; otherwise the change is unknown.
    private func memoryChange(_ item: BotMemoryRevision) -> MemoryChange {
        guard let previous = editor.history.first(where: { $0.revision == item.revision - 1 }) else { return .unknown }
        return item.pin.sha256 == previous.pin.sha256 ? .unchanged : .changed
    }

    private func historyHeadline(_ item: BotMemoryRevision, change: MemoryChange) -> String {
        switch change {
        case .changed:
            // A changed MEMORY with restoredFrom can only come from a restore; updates clear restoredFrom.
            if let from = item.restoredFrom {
                switch item.source.kind {
                case "owner_ui": return text("Você restaurou a memória da versão \(from)", "You restored the memory from version \(from)")
                case "harness_action": return text("O bot restaurou a memória da versão \(from)", "The bot restored the memory from version \(from)")
                default: return text("Memória restaurada da versão \(from)", "Memory restored from version \(from)")
                }
            }
            switch item.source.kind {
            case "owner_ui": return text("Você alterou a memória", "You changed the memory")
            case "harness_action": return text("O bot alterou a memória", "The bot changed the memory")
            default: return text("Memória alterada · origem não registrada", "Memory changed · source not recorded")
            }
        case .unchanged: return text("Memória sem mudança", "Memory unchanged")
        case .unknown: return text("Versão \(item.revision)", "Version \(item.revision)")
        }
    }

    private func historyDetail(_ item: BotMemoryRevision, change: MemoryChange) -> String {
        let time = revisionTimestamp(item.updatedAt)
        return change == .unknown ? time : time + " · " + text("versão \(item.revision)", "version \(item.revision)")
    }

    private func historyExtra(_ item: BotMemoryRevision, change: MemoryChange) -> String? {
        let restored = item.restoredFrom.map { text("conteúdo restaurado da versão \($0)", "content restored from version \($0)") }
        switch change {
        case .changed: return nil
        case .unchanged: return [text("Igual à versão \(item.revision - 1)", "Same as version \(item.revision - 1)"), restored].compactMap { $0 }.joined(separator: " · ")
        case .unknown: return [text("Origem da memória: ", "Memory source: ") + memorySourceLabel(item.source.kind), restored].compactMap { $0 }.joined(separator: " · ")
        }
    }

    private var memoryOriginContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text("Origem da memória atual: ", "Current memory source: ") + memorySourceLabel(editor.baseline?.memoryHead?.source.kind ?? "legacy_unknown"))
                .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("bot-documents.memory.source")
            if let reference = editor.baseline?.memoryHead?.source.reference {
                Text(text("Nota registrada: ", "Recorded note: ") + reference).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            TextField(text("Nota sobre a origem (opcional)", "Note about the source (optional)"), text: $editor.sourceReference)
                .textFieldStyle(.roundedBorder)
                .disabled(!editor.canEdit).accessibilityIdentifier("bot-documents.memory.reference")
            Text(text("Ex.: “combinado na conversa de 10/out”. Vai junto com o próximo salvamento ou restauração. É só uma anotação: não comprova a origem.", "E.g. “agreed in the Oct 10 chat”. Sent with the next save or restore. It is only a note: it does not prove the source."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if editor.sourceReference.utf16.count > 512 {
                Text(text("A nota aceita até 512 caracteres.", "The note accepts up to 512 characters.")).font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func historyRow(_ item: BotMemoryRevision) -> some View {
        let change = memoryChange(item)
        let open = editor.viewedRevision?.revision == item.revision
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(historyHeadline(item, change: change)).font(.callout)
                Text(historyDetail(item, change: change)).font(.caption).foregroundStyle(.secondary)
                if let extra = historyExtra(item, change: change) {
                    Text(extra).font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if open {
                Text(text("Aberta abaixo", "Open below")).font(.caption).foregroundStyle(.secondary)
            } else {
                Button(text("Ver", "View")) { editor.readRevision(item.revision) }.disabled(editor.busy)
                    .accessibilityLabel(text("Ver versão \(item.revision)", "View version \(item.revision)"))
                    .accessibilityIdentifier("bot-documents.memory.read-revision")
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(open ? Color.accentColor.opacity(0.10) : Color.clear)
    }

    private func viewedVersion(_ version: BotMemoryVersion) -> some View {
        let lines = version.markdown.split(separator: "\n", omittingEmptySubsequences: false).count
        return VStack(alignment: .leading, spacing: 8) {
            Text(text("Memória da versão \(version.revision)", "Memory from version \(version.revision)")).font(.subheadline.weight(.semibold))
            Text(revisionTimestamp(version.updatedAt) + " · " + text("Origem: ", "Source: ") + memorySourceLabel(version.source.kind))
                .font(.caption).foregroundStyle(.secondary)
            ScrollView {
                Text(version.markdown.isEmpty ? text("(memória vazia)", "(empty memory)") : version.markdown)
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    .accessibilityIdentifier("bot-documents.memory.version")
            }
            .frame(height: min(200, max(56, CGFloat(lines) * 15 + 18)))
            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
            DisclosureGroup(text("Detalhes técnicos", "Technical details"), isExpanded: $showsVersionDetails) {
                Text("SHA-256 \(version.pin.sha256)").font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
            }.font(.caption)
            Button(text("Restaurar esta versão da memória…", "Restore this memory version…")) {
                restoreConfirmation = version; restoreExpected = editor.baseline?.revision; restoreReference = editor.sourceReference
            }.disabled(!editor.canRestore).accessibilityIdentifier("bot-documents.memory.restore")
            if editor.dirty {
                Text(text("Salve ou descarte suas edições antes de restaurar.", "Save or discard your edits before restoring.")).font(.caption).foregroundStyle(.secondary)
            }
            Text(text("Restaurar cria uma nova versão com esta memória. Personalidade e Sobre você continuam como estão.", "Restoring creates a new version with this memory. Personality and About you stay as they are."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
    }

    private var restoreMessage: String {
        let version = restoreConfirmation?.revision ?? 0
        var message = restoreExpected.map {
            text("A memória atual (versão \($0)) será trocada pelo texto da versão \(version). Isso cria a versão \($0 + 1); a atual continua no histórico.", "The current memory (version \($0)) will be replaced by the text from version \(version). This creates version \($0 + 1); the current one stays in the history.")
        } ?? text("A memória atual será trocada pelo texto da versão \(version).", "The current memory will be replaced by the text from version \(version).")
        message += " " + text("Personalidade, Sobre você e permissões não mudam. Não afeta backups.", "Personality, About you and permissions do not change. Backups are not affected.")
        if !restoreReference.isEmpty { message += " " + text("Nota: ", "Note: ") + "“\(restoreReference)”." }
        return message
    }

    private var memoryHistoryContent: some View {
        let target = restoreConfirmation, expected = restoreExpected, reference = restoreReference
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(text("Versões anteriores", "Previous versions")).font(.headline)
                Spacer()
                Button(editor.history.isEmpty ? text("Mostrar versões", "Show versions") : text("Atualizar lista", "Refresh list")) {
                    historyRequestedAt = editor.baseline?.revision; editor.loadHistory()
                }
                .disabled(editor.busy || !editor.scopeMatches || editor.baseline?.revision == 0)
                .accessibilityIdentifier("bot-documents.memory.history")
            }
            Text(text("Cada versão guarda Personalidade, Sobre você e Memória juntas. A lista conta o que aconteceu com a Memória.", "Each version keeps Personality, About you and Memory together. The list tells what happened to Memory."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if editor.baseline?.revision == 0 {
                Text(text("As versões aparecem depois do primeiro salvamento.", "Versions appear after the first save.")).font(.caption).foregroundStyle(.secondary)
            } else if editor.history.isEmpty, historyRequestedAt != nil, historyRequestedAt == editor.baseline?.revision, !editor.busy, editor.notice != .loadFailed {
                Text(text("Nenhuma versão encontrada nesta consulta.", "No versions found in this lookup.")).font(.caption).foregroundStyle(.secondary)
            }
            if !editor.history.isEmpty {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(editor.history, id: \.revision) { item in
                            historyRow(item)
                            if item.revision != editor.history.last?.revision { Divider() }
                        }
                    }
                }
                .frame(height: min(240, max(56, CGFloat(editor.history.count) * 56)))
                .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
            }
            if editor.canLoadOlderHistory {
                Button(text("Mostrar versões mais antigas", "Show older versions")) { editor.loadHistory(more: true) }.disabled(editor.busy)
                    .accessibilityIdentifier("bot-documents.memory.history-more")
            }
            if editor.historyReachedLimit {
                Text(text("A lista mostra as 100 versões mais recentes. As mais antigas continuam guardadas na base; Atualizar lista relê a partir da mais nova.", "The list shows the 100 most recent versions. Older ones stay on the host; Refresh list reads again from the newest."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("bot-documents.memory.history-limit")
            }
            if let version = editor.viewedRevision { viewedVersion(version) }
        }
        .confirmationDialog(text("Restaurar a memória da versão \(restoreConfirmation?.revision ?? 0)?", "Restore the memory from version \(restoreConfirmation?.revision ?? 0)?"),
            isPresented: Binding(get: { restoreConfirmation != nil }, set: { if !$0 { restoreConfirmation = nil } }), titleVisibility: .visible) {
                Button(text("Restaurar memória", "Restore memory"), role: .destructive) {
                    if let version = target, let expected { editor.restore(version, expected: expected, reference: reference) }
                    restoreConfirmation = nil
                }.accessibilityIdentifier("bot-documents.memory.restore-confirm")
                Button(text("Cancelar", "Cancel"), role: .cancel) { restoreConfirmation = nil }
                    .keyboardShortcut(.defaultAction)
            } message: {
                Text(restoreMessage)
            }
    }

    /// Request IDs stay collapsed until the user asks or a save/restore outcome is unconfirmed.
    private var memoryRecoveryContent: some View {
        let required = editor.pendingRequestID != nil || editor.notice == .saveUnknown || editor.notice == .restoreUnknown
        return DisclosureGroup(isExpanded: Binding(get: { showsRecovery || required }, set: { showsRecovery = $0 })) {
            VStack(alignment: .leading, spacing: 8) {
                if let id = editor.pendingRequestID {
                    HStack(spacing: 8) {
                        Text(text("ID do pedido: ", "Request ID: ") + id).font(.caption.monospaced()).textSelection(.enabled)
                        // Only on the owner's click; this is the one way to keep the ID if the app has to close.
                        Button(text("Copiar ID", "Copy ID")) {
                            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(id, forType: .string)
                        }.font(.caption).controlSize(.small).accessibilityIdentifier("bot-documents.memory.copy-id")
                    }
                }
                TextField(text("ID original do pedido", "Original request ID"), text: $editor.reconcileID)
                    .textFieldStyle(.roundedBorder)
                    .disabled(editor.pendingRequestID != nil || editor.busy).accessibilityIdentifier("bot-documents.memory.receipt-id")
                Button(text("Consultar resultado (somente leitura)", "Check result (read only)"), action: editor.reconcile)
                    .disabled(editor.busy || !editor.scopeMatches || editor.reconcileID.isEmpty).accessibilityIdentifier("bot-documents.memory.reconcile")
                Text(text("Use quando o app não confirmar um salvamento ou uma restauração. A consulta só lê o resultado na base; nada é reenviado. O app não guarda o pedido ao fechar; depois de reabrir, cole aqui o ID copiado.", "Use this when the app cannot confirm a save or restore. The check only reads the result on the host; nothing is resent. The app does not keep the request after closing; after reopening, paste the copied ID here."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(.top, 6)
        } label: {
            Label(text("Recuperar pedido não confirmado", "Recover an unconfirmed request"), systemImage: required ? "exclamationmark.triangle" : "lifepreserver")
                .font(.callout).foregroundStyle(required ? Color.orange : Color.primary)
        }
    }

    /// Versions, origin note, request IDs and the read-only recovery. Collapsed until asked, and opened by itself
    /// whenever something needs the owner: an unconfirmed save/restore, a pending request or a version being viewed.
    private var technicalContent: some View {
        let alert = editor.pendingRequestID != nil || editor.notice == .saveUnknown || editor.notice == .restoreUnknown
        let required = alert || editor.viewedRevision != nil || !editor.sourceReference.isEmpty
        return DisclosureGroup(isExpanded: Binding(get: { showsTechnical || required }, set: { showsTechnical = $0 })) {
            VStack(alignment: .leading, spacing: 14) {
                Text(text("Arquivos do bot: \(fileName(.soul)) (Personalidade), \(fileName(.user)) (Sobre você) e \(fileName(.memory)) (Memória).", "Bot files: \(fileName(.soul)) (Personality), \(fileName(.user)) (About you) and \(fileName(.memory)) (Memory)."))
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .accessibilityIdentifier("bot-documents.technical.files")
                memoryOriginContent
                Divider()
                memoryHistoryContent
                Divider()
                memoryRecoveryContent
            }.padding(.top, 8)
        } label: {
            // The ID sits on the label: on the group it would replace every child's own ID.
            Label(text("Versões e detalhes técnicos", "Versions and technical details"), systemImage: alert ? "exclamationmark.triangle" : "clock.arrow.circlepath")
                .font(.callout).foregroundStyle(alert ? Color.orange : Color.primary)
                .accessibilityIdentifier("bot-documents.technical")
        }
    }

    private var editorContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                ForEach(Document.allCases, id: \.self) { document in
                    Button { selected = document } label: {
                        Text(title(document)).font(.system(size: 13, weight: .medium))
                            .frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.plain)
                    .background(selected == document ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected == document ? Color.accentColor.opacity(0.4) : .clear))
                    .accessibilityIdentifier("bot-documents.tab.\(document.rawValue)")
                    .accessibilityAddTraits(selected == document ? [.isSelected] : [])
                }
            }
            Text(explanation).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !editor.scopeMatches {
                Text(text("A edição exige conexão de proprietário à base local deste Mac.", "Editing requires an owner connection to this Mac’s local host."))
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if editor.baseline == nil && editor.busy {
                ProgressView(text("Lendo documentos…", "Reading documents…"))
            }
            TextEditor(text: documentText)
                .font(.system(.body, design: .monospaced))
                .padding(8)
                .scrollContentBackground(.hidden)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
                .frame(height: 240)
                .disabled(!editor.canEdit)
                .accessibilityLabel(title(selected))
                .accessibilityIdentifier("bot-documents.editor.\(selected.rawValue)")
            HStack {
                Text(text("Texto simples; Markdown é aceito como instrução.", "Plain text; Markdown is accepted as instruction."))
                Spacer()
                Text("\(documentText.wrappedValue.utf16.count) / \(BotDocuments.maximumUTF16Length)")
                    .foregroundStyle(documentText.wrappedValue.utf16.count > BotDocuments.maximumUTF16Length ? .orange : .secondary)
                    .accessibilityIdentifier("bot-documents.length")
            }.font(.caption).foregroundStyle(.secondary)
            if !editor.withinLimit {
                Text(text("Cada documento aceita até 8192 unidades de texto. Reduza o conteúdo antes de salvar.", "Each document accepts up to 8192 text units. Shorten the content before saving."))
                    .font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if let noticeText {
                Text(noticeText).font(.footnote).foregroundStyle(editor.requiresReload ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("bot-documents.notice")
            }
            if selected == .memory {
                #if os(macOS)
                if let learning { MemoryLearningView(editor: learning) }
                #endif
                // Suggestions stay apart from the saved text above until the owner approves appending one.
                if let owner {
                    BotMemorySuggestionsView(presenter: owner, documents: editor, botName: botName, onOpenMcp: onOpenMcp)
                }
                technicalContent
            }
            automationStatus
        }
    }
}

/// UI R1: "Trechos sugeridos para guardar". A suggestion is a LITERAL excerpt of a finished answer of this bot, kept
/// apart from the saved memory until the owner approves appending it. This panel does not summarize, interpret or
/// automatically save these excerpts; direct own-document writes have a separate host policy. Duplicate removal is a deterministic preview the owner approves;
/// undo is the existing memory history (restore a version).
@MainActor struct BotMemorySuggestionsView: View {
    let presenter: BotOwnerConfigurationPresenter
    let documents: BotDocumentsEditor
    let botName: String
    let onOpenMcp: () -> Void
    @State private var sheet: Sheet?
    /// The suggestion under review travels in the sheet item itself; nothing is sent until Pedir aprovação.
    private enum Sheet: Identifiable {
        case policy, capture(MemoryRoutineJob), maintenance
        var id: String { switch self { case .policy: "policy"; case .capture(let job): "capture." + job.id; case .maintenance: "maintenance" } }
    }

    private var status: MemoryRoutinePolicyStatus? { presenter.editor.memoryPolicy }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label("Trechos sugeridos para guardar", systemImage: "text.quote").font(.headline)
                Spacer()
                if let status { policyChip(MemorySuggestionsPresentation.policy(status)) }
                Button("Atualizar") { Task { await presenter.refreshMemory() } }
                    .controlSize(.small).disabled(presenter.busy || !presenter.windowCurrent)
                    .accessibilityIdentifier("bot-memory-suggestions.refresh")
            }
            if let context = presenter.context, context.isMcp, presenter.stage.isOpen {
                Label { Text("Há uma mudança de MCPs aberta nesta janela. Conclua-a antes de mudar a Memória.") } icon: { Image(systemName: "hourglass") }
                    .font(.footnote).foregroundStyle(.orange)
                Button("Abrir MCPs", action: onOpenMcp).controlSize(.small).accessibilityIdentifier("bot-memory-suggestions.open-mcp")
            }
            if presenter.needsRenew {
                HStack {
                    Text("O acesso desta janela expirou ou a base reiniciou.").font(.footnote).foregroundStyle(.orange)
                    Button("Reabrir acesso") { Task { await presenter.renew() } }.controlSize(.small)
                        .disabled(presenter.busy).accessibilityIdentifier("bot-memory-suggestions.renew")
                }
            }
            if let status {
                availability(status)
                if presenter.context != nil, presenter.context?.isMcp == false { pendingBanner }
                candidates(status)
                if MemorySuggestionsPresentation.maintenanceAvailable(status) { duplicates }
            } else if presenter.notice == .unavailable {
                Text("Esta base não abriu as sugestões para esta janela. A memória continua editável acima.")
                    .font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("bot-memory-suggestions.unavailable")
            } else {
                ProgressView("Lendo as sugestões…").controlSize(.small)
            }
            noticeLine
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.18)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-memory-suggestions")
        .task { await presenter.refreshMemory() }
        .sheet(item: $sheet) { which in
            switch which {
            case .policy: MemoryPolicySheet(presenter: presenter, onClose: close)
            case .capture(let job): MemoryCaptureSheet(presenter: presenter, job: job, botName: botName, onClose: close)
            case .maintenance: MemoryMaintenanceSheet(presenter: presenter, onClose: close)
            }
        }
        .onChange(of: presenter.windowCurrent) { _, current in if !current { presenter.latchIfRetired(); sheet = nil } }
        .onChange(of: presenter.stage) { _, stage in
            // A memory effect that finished changes MEMORY.md: reload the editor only if it has no unsaved edit.
            guard stage == .succeeded, let context = presenter.context else { return }
            switch context { case .capture, .maintenance: presenter.memoryEffectApplied(documents: documents); default: break }
        }
    }
    private func close() { sheet = nil }

    @ViewBuilder private func policyChip(_ policy: MemorySuggestionsPresentation.Policy) -> some View {
        Group {
            switch policy {
            case .off: Text("Desligado")
            case .on: Text("Ligado")
            case .onWithoutEffect: Text("Ligado, sem efeito")
            }
        }
        .font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 3)
        .background((policy == .on ? Color.accentColor : policy == .off ? Color.secondary : Color.orange).opacity(0.14), in: Capsule())
        .accessibilityIdentifier("bot-memory-suggestions.policy")
    }

    @ViewBuilder private func availability(_ status: MemoryRoutinePolicyStatus) -> some View {
        let kind = MemorySuggestionsPresentation.availability(status)
        let policy = MemorySuggestionsPresentation.policy(status)
        VStack(alignment: .leading, spacing: 6) {
            Group {
                switch kind {
                case .literalExcerpt: Text("Quando ligado, o Dexter copia um trecho literal de uma resposta já terminada deste bot e sugere guardá-lo. Não resume nem interpreta, e nada é guardado sem sua aprovação.")
                case .injected: Text("As sugestões vêm de um extrator configurado nesta base. São contexto não verificado para você revisar; nada é guardado sem sua aprovação.")
                case .unconfigured: Text("Sugestões indisponíveis nesta base: nenhum extrator foi configurado. A memória continua editável acima.")
                }
            }
            .font(.footnote).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("bot-memory-suggestions.availability")
            Text("Este painel não resume nem guarda estes trechos automaticamente. Ele é separado das atualizações dos documentos feitas pelo bot na conversa e das propostas de aprendizagem em segundo plano.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if policy == .onWithoutEffect {
                Text("Ligado, mas sem efeito agora: a permissão ou o bot mudou depois da aprovação. Revise para ligar de novo.")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if kind != .unconfigured {
                Button { sheet = .policy } label: { if policy == .off { Text("Ligar sugestões…") } else { Text("Ajustar sugestões…") } }
                    .disabled(!presenter.canStartReview).accessibilityIdentifier("bot-memory-suggestions.policy-edit")
            }
        }
    }

    @ViewBuilder private var pendingBanner: some View {
        HStack {
            Group {
                if presenter.stage == .awaitingDecision { Text("Uma mudança da Memória aguarda sua decisão.") }
                else if presenter.stage.isTerminal { Text("A última mudança da Memória terminou. Abra para ver o resultado.") }
                else { Text("Uma mudança da Memória está sem resultado confirmado. Abra e use Conferir estado.") }
            }
            .font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button("Abrir") {
                switch presenter.context {
                case .policy?: sheet = .policy
                case .capture(let job)?: sheet = .capture(job)
                case .maintenance?: sheet = .maintenance
                default: break
                }
            }.accessibilityIdentifier("bot-memory-suggestions.open-pending")
        }
        .padding(8).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private func candidates(_ status: MemoryRoutinePolicyStatus) -> some View {
        let listed = MemorySuggestionsPresentation.listed(presenter.editor.jobs)
        if listed.isEmpty {
            if MemorySuggestionsPresentation.policy(status) == .on {
                Text("Nenhuma sugestão agora. Elas aparecem depois de respostas terminadas deste bot.")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("bot-memory-suggestions.empty")
            }
        } else {
            Text("Ainda não guardados: aparecem aqui até você decidir.").font(.caption).foregroundStyle(.secondary)
            ForEach(listed) { job in candidateCard(job) }
        }
    }

    @ViewBuilder private func candidateCard(_ job: MemoryRoutineJob) -> some View {
        let fact = MemorySuggestionsPresentation.candidate(job)
        VStack(alignment: .leading, spacing: 6) {
            Text("Trecho sugerido para guardar").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if let note = job.note {
                Text(verbatim: note).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor.opacity(0.5)).frame(width: 3) }
                    .accessibilityIdentifier("bot-memory-suggestions.note.\(job.id)")
            }
            sourceLine(job)
            HStack {
                Group {
                    switch fact {
                    case .suggested?: Text("Ainda não guardado")
                    case .proposed?: Text("Pedido criado; veja a decisão")
                    case .saved?: Text("Guardado na memória")
                    case .withdrawn?: Text("Retirado: as sugestões foram desligadas ou mudaram")
                    case .conflict?: Text("A memória mudou antes; esta sugestão não pode mais ser guardada")
                    case .unknown?: Text("Resultado não confirmado pela base")
                    case .extracting?: Text("Preparando a sugestão…")
                    case nil: EmptyView()
                    }
                }.font(.caption).foregroundStyle(fact == .unknown || fact == .conflict ? Color.orange : Color.secondary)
                Spacer()
                if fact == .suggested {
                    Button("Revisar e guardar…") { sheet = .capture(job) }
                    .disabled(!presenter.canStartReview).accessibilityIdentifier("bot-memory-suggestions.capture.\(job.id)")
                }
            }
        }
        .padding(10)
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-memory-suggestions.candidate.\(job.id)")
    }

    @ViewBuilder private func sourceLine(_ job: MemoryRoutineJob) -> some View {
        if let source = job.source {
            let finished = Date(timeIntervalSince1970: Double(source.finishedAt) / 1000).formatted(date: .abbreviated, time: .shortened)
            Text("De uma resposta de \(botName) terminada em \(finished)").font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("bot-memory-suggestions.source.\(job.id)")
            DisclosureGroup("Detalhes técnicos") {
                Text(verbatim: "thread \(source.threadId) · turn \(source.turnId) · msg \(source.outputMessageId) · \(source.outputCharacters) chars · sha256 \(source.outputHash.prefix(16))…")
                    .font(.caption2.monospaced()).textSelection(.enabled)
            }.font(.caption2)
        }
    }

    @ViewBuilder private var duplicates: some View {
        Divider()
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Repetições na memória").font(.subheadline.weight(.medium))
                Text("Procura trechos idênticos repetidos e mostra o que sairia. Nada muda sem sua aprovação.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Procurar repetições…") {
                Task { await presenter.previewMaintenance(); if presenter.maintenancePreview != nil { sheet = .maintenance } }
            }
            .disabled(!presenter.canStartReview).accessibilityIdentifier("bot-memory-suggestions.maintenance-preview")
        }
    }

    @ViewBuilder private var noticeLine: some View {
        switch presenter.notice {
        case .memoryChangedReload?:
            Text("A memória mudou na base. Suas edições não salvas foram mantidas; use Recarregar para ver a versão nova.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-memory-suggestions.notice")
        case .readFailed?:
            Text("Não foi possível confirmar a leitura. Os dados anteriores foram mantidos; use Atualizar.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-memory-suggestions.notice")
        case .planRefused?:
            Text("A base recusou este pedido. Atualize e revise de novo; nada foi enviado.")
                .font(.footnote).foregroundStyle(.orange).accessibilityIdentifier("bot-memory-suggestions.notice")
        default: EmptyView()
        }
    }
}

/// Opt-in policy: off by default; turning it off withdraws the suggestions that were not saved.
@MainActor struct MemoryPolicySheet: View {
    let presenter: BotOwnerConfigurationPresenter
    let onClose: () -> Void
    @State private var enabled = false
    @State private var maintenance = false
    @State private var loaded = false

    private var shown: (MemoryRoutinePolicyInput, MemoryRoutinePolicy)? {
        if case .policy(let input, let previous)? = presenter.context { return (input, previous) }
        return nil
    }

    var body: some View {
        let policy = presenter.editor.memoryPolicy?.policy
        VStack(alignment: .leading, spacing: 14) {
            Text("Sugestões de trechos").font(.title2.weight(.semibold))
            if let shown {
                summary(enabled: shown.0.enabled, maintenance: shown.0.maintenanceEnabled, previous: shown.1)
            } else if let policy {
                Toggle("Sugerir trechos para guardar", isOn: $enabled).accessibilityIdentifier("bot-memory-policy.enabled")
                // Off while suggestions are off: the request never asks for it then, so it is not shown as on either.
                Toggle("Também procurar repetições na memória", isOn: Binding(get: { enabled && maintenance }, set: { maintenance = $0 })).disabled(!enabled)
                    .accessibilityIdentifier("bot-memory-policy.maintenance")
                limits(policy)
                if policy.enabled && !enabled {
                    Text("Desligar retira as sugestões que ainda não foram guardadas.").font(.footnote).foregroundStyle(.orange)
                }
            }
            Divider()
            OwnerProposalStagePanel(presenter: presenter, approveTitle: "Aprovar", requestTitle: "Pedir aprovação",
                onRequest: { Task { await presenter.requestPolicy(enabled: enabled, maintenance: maintenance) } },
                onCancel: { if presenter.context != nil { presenter.discardPrepared() }; onClose() },
                onDone: onClose, outcome: outcome)
            .disabled(shown == nil && policy.map { $0.enabled == enabled && $0.maintenanceEnabled == (enabled && maintenance) } ?? true)
        }
        .padding(24).frame(minWidth: 500, idealWidth: 540)
        .accessibilityElement(children: .contain)
        .onAppear {
            guard !loaded, let policy else { return }
            loaded = true; enabled = policy.enabled; maintenance = policy.maintenanceEnabled
        }
        .accessibilityIdentifier("bot-memory-policy.sheet")
    }

    private var outcome: Text? {
        guard let read = presenter.policyReceiptRead else { return nil }
        guard let receipt = read.policyReceipt else { return Text("Aprovado; a base ainda não mostra o recibo. Conferir estado só lê.") }
        if receipt.withdrawnJobIds.isEmpty {
            return receipt.policy.enabled ? Text("Sugestões ligadas para este bot.") : Text("Sugestões desligadas para este bot.")
        }
        let count = String(receipt.withdrawnJobIds.count)
        return Text("Sugestões desligadas. \(count) sugestão(ões) não guardada(s) foram retiradas.")
    }

    @ViewBuilder private func summary(enabled: Bool, maintenance: Bool, previous: MemoryRoutinePolicy) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Group { if enabled { Text("Ligar sugestões de trechos para este bot.") } else { Text("Desligar sugestões de trechos para este bot.") } }.font(.headline)
            if enabled { Group { if maintenance { Text("Procurar repetições: permitido.") } else { Text("Procurar repetições: não.") } }.font(.callout) }
            limits(previous)
            if previous.enabled && !enabled { Text("As sugestões ainda não guardadas serão retiradas.").font(.footnote).foregroundStyle(.orange) }
        }
    }
    @ViewBuilder private func limits(_ policy: MemoryRoutinePolicy) -> some View {
        let perDay = String(policy.maxNotesPerDay), minutes = String(max(1, policy.minIntervalMs / 60000)), characters = String(policy.maxNoteCharacters)
        Text("Até \(perDay) sugestões por dia, no máximo uma a cada \(minutes) min, com até \(characters) caracteres cada.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

/// The exact literal text that would be appended to MEMORY.md, its source, then the decision on the real action.
@MainActor struct MemoryCaptureSheet: View {
    let presenter: BotOwnerConfigurationPresenter
    let job: MemoryRoutineJob?
    let botName: String
    let onClose: () -> Void
    private var shown: MemoryRoutineJob? { if case .capture(let job)? = presenter.context { return job }; return job }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Guardar trecho na memória").font(.title2.weight(.semibold))
            if let job = shown {
                Text("Será acrescentado ao fim da memória deste bot exatamente assim:").font(.subheadline).foregroundStyle(.secondary)
                ScrollView {
                    Text(verbatim: job.note ?? "").font(.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                }.frame(maxHeight: 220)
                if let source = job.source {
                    let finished = Date(timeIntervalSince1970: Double(source.finishedAt) / 1000).formatted(date: .abbreviated, time: .shortened)
                    Text("Origem: uma resposta de \(botName) terminada em \(finished).")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Personalidade e Sobre você não mudam. Se o trecho já estiver na memória, nada é duplicado.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            OwnerProposalStagePanel(presenter: presenter, approveTitle: "Aprovar e guardar", requestTitle: "Pedir aprovação",
                onRequest: { if let job = shown { Task { await presenter.requestCapture(job) } } },
                onCancel: { if presenter.context != nil { presenter.discardPrepared() }; onClose() }, onDone: onClose, outcome: outcome)
        }
        .padding(24).frame(minWidth: 520, idealWidth: 580)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-memory-capture.sheet")
    }
    private var outcome: Text? {
        guard let read = presenter.captureRead else { return nil }
        if read.job.state == "committed" || read.job.receipt != nil {
            return Text("Guardado na memória. Para desfazer, use Histórico da memória e restaure a versão anterior.")
        }
        return Text("A base ainda não mostra o recibo deste trecho. Conferir estado só lê; nada é reenviado.")
    }
}

/// Deterministic duplicate removal: what leaves (first occurrence stays), then the decision on the real action.
@MainActor struct MemoryMaintenanceSheet: View {
    let presenter: BotOwnerConfigurationPresenter
    let onClose: () -> Void
    private var preview: MemoryMaintenancePreview? {
        if case .maintenance(let preview)? = presenter.context { return preview }
        return presenter.maintenancePreview
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Remover repetições da memória").font(.title2.weight(.semibold))
            if let preview {
                if preview.removed.isEmpty {
                    Text("Nenhum trecho repetido. Nada a remover.").font(.callout).accessibilityIdentifier("bot-memory-maintenance.empty")
                } else {
                    let count = String(preview.removed.count)
                    Text("\(count) trecho(s) repetido(s) sairiam. A primeira ocorrência de cada um fica, na mesma ordem.")
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(preview.removed.enumerated()), id: \.offset) { _, item in
                                Text(verbatim: item.sample + (item.sampleTruncated ? "…" : ""))
                                    .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(8).background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }.frame(maxHeight: 220)
                    Text("Para desfazer depois, use Histórico da memória e restaure a versão anterior.")
                        .font(.footnote).foregroundStyle(.secondary)
                    DisclosureGroup("Detalhes técnicos") {
                        Text(verbatim: "revision \(preview.expectedRevision) · \(preview.memoryHash.prefix(12))… → \(preview.nextMemoryHash.prefix(12))…")
                            .font(.caption.monospaced()).textSelection(.enabled)
                    }.font(.caption)
                }
            }
            Divider()
            if preview?.removed.isEmpty == false || presenter.context != nil {
                OwnerProposalStagePanel(presenter: presenter, approveTitle: "Aprovar e remover", requestTitle: "Pedir aprovação",
                    onRequest: { Task { await presenter.requestMaintenance() } },
                    onCancel: { if presenter.context != nil { presenter.discardPrepared() }; onClose() },
                    onDone: onClose,
                    outcome: presenter.stage == .succeeded ? Text("Repetições removidas. Para desfazer, restaure a versão anterior no Histórico da memória.") : nil)
            } else {
                HStack { Spacer(); Button("Fechar", action: onClose).keyboardShortcut(.defaultAction) }
            }
        }
        .padding(24).frame(minWidth: 520, idealWidth: 580)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-memory-maintenance.sheet")
    }
}
#endif
