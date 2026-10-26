import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// One call for the open private conversation. Every state shown comes from the controller (host status, session,
/// media); nothing is presented as connected, muted or ended before the controller says so.
struct NativeVoiceCallSheet: View {
    let model: DexterAppModel
    let bot: Bot
    let threadID: String
    let onClose: () -> Void
    @State private var controller: CodexNativeVoiceController?
    @State private var preferences: NativeVoicePreferencesEditor?
    @State private var history: [NativeVoiceHistoryItem] = []
    @State private var historyLoaded = false
    @State private var now = Date()

    init(model: DexterAppModel, bot: Bot, threadID: String, onClose: @escaping () -> Void) {
        self.model = model; self.bot = bot; self.threadID = threadID; self.onClose = onClose
        // The model keeps the controller (and its pending request) across sheet closes; it is bound to this connection.
        _controller = State(initialValue: model.nativeVoiceController(bot: bot, threadID: threadID))
        _preferences = State(initialValue: model.nativeVoicePreferencesEditor(bot: bot))
    }

    private var inCall: Bool {
        guard let phase = controller?.phase else { return false }
        return [.starting, .connecting, .active, .stopping].contains(phase)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if let controller {
                callBody(controller)
            } else {
                Text("Ligações não estão disponíveis agora: abra a conversa privada do bot com a base local conectada.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice-call.unavailable")
            }
            Divider()
            historySection
            HStack {
                Spacer()
                Button("Fechar", action: onClose).keyboardShortcut(.cancelAction)
                    .disabled(inCall || controller?.hasUnconfirmedRequest == true)
                    .help(inCall ? "Encerre a ligação antes de fechar." : "")
                    .accessibilityIdentifier("voice-call.close")
            }
        }
        .padding(20)
        .frame(width: 440)
        .interactiveDismissDisabled(inCall || controller?.hasUnconfirmedRequest == true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-call.sheet")
        .task {
            await controller?.refreshStatus()
            await preferences?.load()
            await loadHistory()
        }
        .task(id: controller?.phase == .active) {
            while controller?.phase == .active, !Task.isCancelled {
                now = Date(); try? await Task.sleep(for: .seconds(1))
            }
        }
        .onChange(of: controller?.phase) { _, phase in
            // A call that just ended appears in the history only after the host lists it.
            if phase == .idle || phase == .failed { Task { await loadHistory() } }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                             fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 36, appearance: bot.avatarAppearance, mascotSeed: bot.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name).font(.headline)
                Text("Ligação por voz · conversa privada").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private func callBody(_ controller: CodexNativeVoiceController) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(phaseTitle(controller), systemImage: phaseSymbol(controller.phase))
                .font(.title3.weight(.semibold))
                .foregroundStyle(controller.phase == .failed || controller.phase == .unconfirmed ? Color.orange : Color.primary)
                .accessibilityIdentifier("voice-call.state")
            if let message = controller.failureMessage {
                Text(message).font(.callout).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice-call.failure")
            }
            if let status = controller.status, !status.supported, let version = status.cliVersion {
                Text("Versão encontrada: \(version). A versão escolhida não é trocada automaticamente.")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("voice-call.program-version")
            }
            if [.idle, .failed].contains(controller.phase), controller.status?.supported == true {
                voicePicker(controller)
            }
            controls(controller)
            if !controller.transcript.isEmpty { liveTranscript(controller) }
        }
    }

    private func phaseTitle(_ controller: CodexNativeVoiceController) -> String {
        switch controller.phase {
        case .idle: controller.status?.supported == false ? String(localized: "Ligação indisponível") : String(localized: "Pronto para ligar")
        case .checking: String(localized: "Conferindo…")
        case .starting, .connecting: String(localized: "Conectando…")
        case .active:
            if let started = controller.session?.startedAt {
                String(localized: "Em ligação · \(Self.duration(Int64(now.timeIntervalSince1970 * 1000) - started))")
            } else { String(localized: "Em ligação") }
        case .stopping: String(localized: "Encerrando…")
        case .unconfirmed: String(localized: "Estado não confirmado")
        case .failed: String(localized: "A ligação não continuou")
        }
    }
    private func phaseSymbol(_ phase: CodexVoicePhase) -> String {
        switch phase {
        case .idle, .checking: "phone"
        case .starting, .connecting: "phone.arrow.up.right"
        case .active: "phone.fill"
        case .stopping: "phone.down"
        case .unconfirmed, .failed: "exclamationmark.triangle"
        }
    }

    private func voicePicker(_ controller: CodexNativeVoiceController) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Voz desta ligação").font(.callout)
            VoiceChips(voices: controller.status?.voices ?? [], selected: controller.selectedVoice, idPrefix: "voice-call.voice") {
                controller.chooseVoice($0)
            }
            if let saved = preferences?.preference, saved.botId == bot.id {
                Text(saved.voice.map { String(localized: "Voz salva para este bot: \($0.capitalized). Muda em Ajustes do bot › Modelo e vale a partir da próxima ligação.") }
                     ?? String(localized: "Este bot usa a voz padrão. A voz salva muda em Ajustes do bot › Modelo e vale a partir da próxima ligação."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("voice-call.saved-voice")
            }
        }
    }

    @ViewBuilder private func controls(_ controller: CodexNativeVoiceController) -> some View {
        HStack(spacing: 10) {
            switch controller.phase {
            case .idle, .failed, .checking:
                // Shown only when the host says this program supports calls; an unsupported program offers no call button.
                if controller.status?.supported == true {
                    Button { Task { await controller.start() } } label: { Label("Ligar", systemImage: "phone.fill") }
                        .buttonStyle(.borderedProminent).tint(.green)
                        .disabled(!controller.canStart)
                        .help("Usa o microfone deste Mac e o programa Codex já configurado. Nada é trocado ou instalado.")
                        .accessibilityIdentifier("voice-call.start")
                }
                Button("Atualizar") { Task { await controller.refreshStatus() } }
                    .disabled(controller.phase == .checking)
                    .accessibilityIdentifier("voice-call.refresh")
            case .starting, .connecting, .active:
                Button { controller.setMuted(!controller.muted) } label: {
                    Label(controller.muted ? "Ativar microfone" : "Silenciar", systemImage: controller.muted ? "mic.slash.fill" : "mic.fill")
                }
                .disabled(!controller.canMute)
                .accessibilityIdentifier("voice-call.mute")
                Button(role: .destructive) { Task { await controller.stop() } } label: { Label("Encerrar", systemImage: "phone.down.fill") }
                    .buttonStyle(.borderedProminent).tint(.red)
                    .accessibilityIdentifier("voice-call.end")
            case .stopping:
                ProgressView().controlSize(.small)
            case .unconfirmed:
                Button("Conferir estado") { Task { await controller.reconcile() } }
                    .help("Só consulta a base. Não reenvia o pedido.")
                    .accessibilityIdentifier("voice-call.reconcile")
            }
        }
    }

    private func liveTranscript(_ controller: CodexNativeVoiceController) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Ao vivo (não é o registro salvo)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(controller.transcript.enumerated()), id: \.offset) { _, event in
                        if let text = event.text, !text.isEmpty {
                            Text(verbatim: (event.role == "user" ? String(localized: "Você: ") : bot.name + ": ") + text)
                                .font(.caption).textSelection(.enabled)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 120)
        }
        .accessibilityIdentifier("voice-call.live-transcript")
    }

    // MARK: History (GET only)

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ligações anteriores").font(.subheadline.weight(.semibold))
            if !historyLoaded {
                ProgressView().controlSize(.small)
            } else if history.isEmpty {
                Text("Nenhuma ligação nesta conversa.").font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("voice-call.history.empty")
            } else {
                ForEach(history.prefix(5), id: \.session.id) { item in NativeVoiceHistoryCard(item: item) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-call.history")
    }

    /// GET only. A page is shown only if host, bot, thread and connection are still the ones captured before the read.
    private func loadHistory() async {
        guard let client = model.makeLocalMcpClient(), let hostID = model.approvalPolicyHostID else { historyLoaded = true; return }
        let scope = model.nativeComposerScope, address = model.hostAddress
        defer { historyLoaded = true }
        guard let page = try? await client.nativeVoiceHistory(threadID: threadID),
              model.nativeComposerScope == scope, model.hostAddress == address, model.approvalPolicyHostID == hostID else { return }
        history = page.items.filter { $0.session.hostId == hostID && $0.session.botId == bot.id && $0.session.threadId == threadID }
            .sorted { $0.session.createdAt > $1.session.createdAt }
    }

    static func duration(_ ms: Int64) -> String {
        let s = max(0, ms / 1000)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Ajustes do bot › Modelo: the voice this bot uses in calls. Saved on the host (CAS by revision, exact receipt) and
/// used from the NEXT call; a call already running keeps its voice. "Padrão" stores nil. Read-only when the Codex
/// program cannot make calls. All writes and confirmations go through the model's NativeVoicePreferencesEditor.
struct NativeVoicePreferenceCard: View {
    let model: DexterAppModel
    let bot: Bot
    /// The voice card of the bot settings (UX-P1-13) titles this path itself.
    let showsTitle: Bool
    @State private var editor: NativeVoicePreferencesEditor?
    @State private var draft: String = ""

    init(model: DexterAppModel, bot: Bot, showsTitle: Bool = true) {
        self.model = model; self.bot = bot; self.showsTitle = showsTitle
        _editor = State(initialValue: model.nativeVoicePreferencesEditor(bot: bot))
    }

    private var savedVoice: String { editor?.preference?.voice ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsTitle { Text("Voz nas ligações").font(.headline) }
            if let editor {
                if let baseline = editor.baseline {
                    VoiceChips(voices: baseline.voices, selected: draft.isEmpty ? nil : draft, idPrefix: "bot-profile.native-voice.voice") {
                        draft = $0 ?? ""
                    }
                    .disabled(!editor.canSave)
                    HStack {
                        if editor.pending != nil {
                            Button("Conferir") { Task { await editor.reconcile() } }.disabled(editor.busy)
                                .help("Só consulta a base. Não reenvia.")
                                .accessibilityIdentifier("bot-profile.native-voice.reconcile")
                        }
                        Spacer()
                        if editor.busy { ProgressView().controlSize(.small) }
                        Button("Salvar voz") { Task { _ = await editor.save(voice: draft.isEmpty ? nil : draft) } }
                            .disabled(!editor.canSave || draft == savedVoice)
                            .accessibilityIdentifier("bot-profile.native-voice.save")
                    }
                } else if editor.busy {
                    ProgressView().controlSize(.small)
                }
                if let message = editor.message {
                    Text(message).font(.footnote).foregroundStyle(editor.pending != nil || editor.error != nil ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("bot-profile.native-voice.message")
                }
                Text("Vale a partir da próxima ligação; uma ligação em andamento mantém a voz dela. Escolher outra voz na tela da ligação vale só para aquela ligação.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Disponível com a base local deste Mac conectada.").font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("bot-profile.native-voice.unavailable")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bot-profile.native-voice")
        .task { await editor?.load(); draft = savedVoice }
        .onChange(of: editor?.preference?.revision) { _, _ in draft = savedVoice }
    }
}

/// "Padrão" plus one chip per voice the host lists. nil means the default voice.
struct VoiceChips: View {
    let voices: [String]
    let selected: String?
    let idPrefix: String
    let choose: (String?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip(String(localized: "Padrão"), value: nil, id: idPrefix + ".default")
                ForEach(voices, id: \.self) { voice in chip(voice.capitalized, value: voice, id: idPrefix + "." + voice) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(idPrefix)
    }
    private func chip(_ title: String, value: String?, id: String) -> some View {
        let isSelected = selected == value
        return Button { choose(value) } label: {
            Text(title).font(.system(size: 12, weight: isSelected ? .semibold : .regular))
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(isSelected ? Color.accentColor.opacity(0.22) : DexterSurface.raisedFill, in: Capsule())
                .overlay(Capsule().strokeBorder(isSelected ? Color.accentColor.opacity(0.6) : DexterSurface.panelStroke))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }
}

/// A finished (or unconfirmed) call as the host recorded it. Messages are the canonical turns of this conversation;
/// live fragments are never shown here as if they had been saved.
struct NativeVoiceHistoryCard: View {
    let item: NativeVoiceHistoryItem

    private var stateText: String {
        switch item.session.state {
        case .closed: String(localized: "Encerrada")
        case .failed: String(localized: "Não concluída")
        case .unknown: String(localized: "Sem confirmação")
        case .starting, .active, .stopping: String(localized: "Em andamento")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.session.state == .closed ? "phone" : "phone.badge.waveform")
                .foregroundStyle(.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(Date(timeIntervalSince1970: TimeInterval(item.session.createdAt) / 1000).formatted(date: .abbreviated, time: .shortened))
                    .font(.callout)
                Text(verbatim: [stateText, NativeVoiceCallSheet.duration(item.durationMs),
                                item.session.voice?.capitalized ?? String(localized: "voz padrão")].joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                let saved = item.transcriptRefs.filter { $0.outputMessageId != nil }.count
                Text(item.transcriptRefs.isEmpty ? String(localized: "Nenhuma mensagem registrada na conversa.")
                     : String(localized: "\(item.transcriptRefs.count) fala(s) na conversa · \(saved) com resposta registrada"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(8)
        .background(DexterSurface.insetFill, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("voice-call.history.\(item.session.id)")
    }
}
#endif
