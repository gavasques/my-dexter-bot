#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// The key stays in this private input until the model writes it to secure custody.
/// Settings use the connected host's revision; a failed save is never retried silently.
@MainActor struct LiveVoiceSettingsSection: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var baseline: LiveVoiceSettings?
    @State private var enabled = false
    @State private var defaultVoice = "bossa"
    @State private var keyDraft = ""
    @State private var loading = false
    @State private var saving = false
    @State private var requiresReload = false
    @State private var notice: String?
    @State private var keyNotice: String?
    @State private var generation = UUID()

    private func text(_ pt: String, _ en: String) -> String {
        locale.language.languageCode?.identifier == "pt" ? pt : en
    }
    private var scope: String { "\(model.nativeComposerScope)|\(model.hostAddress)" }
    private var editable: Bool { model.canEditBotProfiles && !model.isFixture }
    private var dirty: Bool {
        guard let baseline else { return false }
        return enabled != baseline.enabled || defaultVoice != baseline.defaultVoice
    }
    private var hasKeyDraft: Bool { !keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        Section(text("Voz ao vivo · OpenAI", "Live voice · OpenAI")) {
            HStack(spacing: 8) {
                Label("GPT-Live 1", systemImage: "waveform")
                Spacer()
                if loading || saving { ProgressView().controlSize(.small) }
            }
            Toggle(text("Habilitar Live no chat", "Enable Live in chat"), isOn: $enabled)
                .disabled(!editable || baseline == nil || loading || saving || requiresReload)
                .accessibilityIdentifier("settings.live-voice.enabled")
            Text(text("Depois de habilitar e salvar a chave, o botão de voz do chat usa a voz ao vivo nas conversas sem chamada nativa. O microfone só é usado quando você inicia uma sessão.", "Once enabled and the key is saved, the chat's voice button uses live voice in conversations without a native call. The microphone is used only when you start a session."))
                .font(.footnote).foregroundStyle(.secondary)

            Picker(text("Voz geral", "Global voice"), selection: $defaultVoice) {
                ForEach(LiveVoiceCatalog.voices, id: \.self) { voice in
                    Text(LiveVoiceCatalog.label(voice)).tag(voice)
                }
            }
            .disabled(!editable || baseline == nil || loading || saving || requiresReload)
            .accessibilityIdentifier("settings.live-voice.default-voice")
            Text(text("Os bots usam esta voz até você escolher outra nos ajustes deles. Mudanças de voz valem para a próxima sessão.", "Bots use this voice until you choose another in their settings. Voice changes apply to the next session."))
                .font(.footnote).foregroundStyle(.secondary)

            HStack {
                Button(text("Salvar voz ao vivo", "Save live voice"), action: saveSettings)
                    .disabled(!editable || loading || saving || requiresReload || !dirty)
                    .accessibilityIdentifier("settings.live-voice.save")
                if requiresReload || baseline == nil {
                    Button(text("Recarregar", "Reload")) { Task { await loadSettings() } }
                        .disabled(loading || saving || !editable)
                        .accessibilityIdentifier("settings.live-voice.reload")
                }
            }
            if let notice {
                Text(notice).font(.footnote).foregroundStyle(requiresReload ? Color.orange : Color.secondary)
                    .accessibilityIdentifier("settings.live-voice.notice")
            }

            LabeledContent(text("Chave OpenAI", "OpenAI key")) {
                Label(model.liveVoiceKeyConfigured ? text("Configurada", "Configured") : text("Não configurada", "Not configured"),
                      systemImage: model.liveVoiceKeyConfigured ? "checkmark.shield" : "key")
                    .foregroundStyle(model.liveVoiceKeyConfigured ? Color.green : Color.secondary)
            }
            .accessibilityIdentifier("settings.live-voice.key-status")
            SecureField(model.liveVoiceKeyConfigured ? text("Cole para substituir a chave", "Paste to replace the key") : text("Cole sua chave da API OpenAI", "Paste your OpenAI API key"), text: $keyDraft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .disabled(!editable || loading || saving)
                .accessibilityLabel(text("Chave privada da API OpenAI", "Private OpenAI API key"))
                .accessibilityIdentifier("settings.live-voice.key-input")
            HStack(spacing: 12) {
                Button(text("Salvar chave", "Save key"), action: saveKey)
                    .disabled(!editable || loading || saving || !hasKeyDraft)
                    .accessibilityIdentifier("settings.live-voice.key-save")
                if model.liveVoiceKeyConfigured {
                    Button(text("Remover chave", "Remove key"), role: .destructive, action: removeKey)
                        .disabled(!editable || loading || saving)
                        .accessibilityIdentifier("settings.live-voice.key-remove")
                }
            }
            Text(text("A chave é guardada de forma segura neste Mac e nunca aparece no contexto dos bots. Live usa a API OpenAI, com cobrança separada da assinatura do ChatGPT.", "The key is securely stored on this Mac and never appears in bot context. Live uses the OpenAI API, billed separately from a ChatGPT subscription."))
                .font(.footnote).foregroundStyle(.secondary)
            if let keyNotice {
                Text(keyNotice).font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.live-voice.key-notice")
            }
            if !editable {
                Text(text("Configure o host local deste Mac para ajustar Live. Este fluxo ainda não administra chaves de um host remoto.", "Configure this Mac’s local host to manage Live. This flow does not yet administer a remote host’s keys."))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .task(id: scope) { await loadSettings() }
        .onDisappear { generation = UUID(); keyDraft = "" }
    }

    private func loadSettings() async {
        let requestedScope = scope
        let token = UUID()
        generation = token
        keyDraft = ""; keyNotice = nil; notice = nil
        loading = true; saving = false
        baseline = nil
        await model.loadLiveVoiceSettings()
        guard !Task.isCancelled, requestedScope == scope, generation == token else { return }
        loading = false
        guard let settings = model.liveVoiceSettings else {
            requiresReload = true
            // A local draft is not a substitute for a revision returned by the host.
            notice = text("Os ajustes Live não estão disponíveis. Confira a conexão com a base.", "Live settings are unavailable. Check the host connection.")
            return
        }
        baseline = settings; enabled = settings.enabled; defaultVoice = settings.defaultVoice
        requiresReload = false
    }

    private func saveSettings() {
        guard editable, !loading, !saving, !requiresReload, dirty,
              let baseline, LiveVoiceCatalog.voices.contains(defaultVoice) else { return }
        let requestedScope = scope, token = generation
        let nextEnabled = enabled, nextVoice = defaultVoice
        saving = true; notice = nil
        Task { @MainActor in
            do {
                try await model.saveLiveVoiceSettings(enabled: nextEnabled, defaultVoice: nextVoice, expectedRevision: baseline.revision)
                guard !Task.isCancelled, requestedScope == scope, token == generation else { return }
                saving = false
                if let settings = model.liveVoiceSettings {
                    self.baseline = settings; enabled = settings.enabled; defaultVoice = settings.defaultVoice
                    notice = text("Ajustes Live salvos.", "Live settings saved.")
                } else {
                    requiresReload = true
                    notice = text("Recarregue para confirmar os ajustes salvos.", "Reload to confirm the saved settings.")
                }
            } catch {
                guard !Task.isCancelled, requestedScope == scope, token == generation else { return }
                saving = false; requiresReload = true
                notice = text("Não foi possível confirmar o salvamento. Recarregue antes de tentar novamente; a alteração não foi reenviada.", "Could not confirm the save. Reload before trying again; the change was not resent.")
            }
        }
    }

    private func saveKey() {
        guard editable, !loading, !saving, hasKeyDraft else { return }
        let value = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        keyDraft = ""; keyNotice = nil
        do {
            try model.saveLiveVoiceKey(value)
            keyNotice = text("Chave salva no armazenamento seguro. Nenhuma sessão foi iniciada.", "Key saved in secure storage. No session was started.")
        } catch {
            keyNotice = text("Não foi possível salvar a chave. Confira o acesso ao armazenamento seguro e cole a chave novamente.", "Could not save the key. Check secure storage access and paste the key again.")
        }
    }

    private func removeKey() {
        guard editable, !loading, !saving else { return }
        keyDraft = ""; keyNotice = nil
        do {
            try model.removeLiveVoiceKey()
            keyNotice = text("Chave removida. Live fica indisponível até você salvar outra chave.", "Key removed. Live is unavailable until you save another key.")
        } catch {
            keyNotice = text("Não foi possível confirmar a remoção da chave. Confira o armazenamento seguro antes de tentar novamente.", "Could not confirm key removal. Check secure storage before trying again.")
        }
    }
}

/// Live has its own visible session controls and never changes the text/image composer. Starting lives in the single
/// voice button of the composer (UX-P1-13); this strip shows only a session in progress, its stop, or its outcome.
@MainActor struct ChatLiveVoiceControls: View {
    let model: DexterAppModel
    let threadID: String
    @Environment(\.locale) private var locale

    private var controller: LiveVoiceController { model.liveVoiceController }
    private var configured: Bool { model.liveVoiceSettings?.enabled == true && model.liveVoiceKeyConfigured }
    private var notice: String? {
        if controller.state == .failed { return controller.safeMessage ?? model.liveVoiceNotice }
        return model.liveVoiceNotice ?? controller.safeMessage
    }
    private func text(_ pt: String, _ en: String) -> String {
        locale.language.languageCode?.identifier == "pt" ? pt : en
    }
    private var stateLabel: String {
        switch controller.state {
        case .idle: return "Live"
        case .starting: return text("Conectando Live…", "Connecting Live…")
        case .listening: return text("Live ativo", "Live is on")
        case .stopping: return text("Encerrando Live…", "Closing Live…")
        case .failed: return text("Live indisponível", "Live unavailable")
        }
    }

    var body: some View {
        content
            .task(id: "\(model.nativeComposerScope)|\(model.hostAddress)") { await model.loadLiveVoiceSettings() }
    }

    @ViewBuilder private var content: some View {
        if controller.isSessionActive || controller.state == .failed || (configured && model.liveVoiceNotice != nil) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    if controller.isSessionActive {
                        if controller.state == .starting || controller.state == .stopping {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: controller.microphoneMuted ? "mic.slash.fill" : "waveform")
                                .foregroundStyle(controller.microphoneMuted ? Color.secondary : Color.accentColor)
                        }
                        Text(stateLabel).font(.system(size: 13, weight: .semibold))
                        if let voice = controller.voice {
                            Text(LiveVoiceCatalog.label(voice)).font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Button {
                            model.setLiveVoiceMuted(!controller.microphoneMuted)
                        } label: {
                            Label(controller.microphoneMuted ? text("Ativar microfone", "Unmute") : text("Silenciar", "Mute"),
                                  systemImage: controller.microphoneMuted ? "mic.slash" : "mic")
                        }
                        .disabled(controller.state != .listening)
                        .accessibilityIdentifier("chat.live-voice.mute")
                        .accessibilityValue(controller.microphoneMuted ? text("Microfone silenciado", "Microphone muted") : text("Microfone ativo", "Microphone active"))
                        Button(text("Parar", "Stop"), role: .destructive) { model.stopLiveVoice() }
                            .disabled(controller.state == .stopping)
                            .accessibilityIdentifier("chat.live-voice.stop")
                    } else if controller.state == .failed {
                        Label(text("A voz ao vivo não continuou", "Live voice did not continue"), systemImage: "exclamationmark.triangle")
                            .font(.system(size: 13, weight: .semibold))
                            .accessibilityIdentifier("chat.live-voice.failed")
                        Spacer(minLength: 0)
                    }
                }

                if controller.isSessionActive || controller.state == .failed {
                    if !controller.inputCaption.isEmpty {
                        caption(controller.inputCaption, label: text("Você", "You"), identifier: "chat.live-voice.input-caption")
                    }
                    if !controller.outputCaption.isEmpty {
                        caption(controller.outputCaption, label: model.selectedBot?.name ?? text("Bot", "Bot"), identifier: "chat.live-voice.output-caption")
                    }
                    if controller.state == .listening && controller.inputCaption.isEmpty && controller.outputCaption.isEmpty {
                        Text(controller.microphoneMuted ? text("Microfone silenciado.", "Microphone muted.") : text("Pode falar com seu bot.", "You can speak to your bot."))
                            .font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                    if controller.state == .stopping {
                        Text(text("Áudio interrompido. Aguardando o encerramento da conexão.", "Audio stopped. Waiting for the connection to close."))
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    if !controller.inputCaption.isEmpty || !controller.outputCaption.isEmpty {
                        Text(text("Transcrições parciais da sessão ao vivo.", "Partial transcripts from the live session."))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    if controller.state == .listening && !controller.echoCancellationAvailable {
                        Text(text("Use fones de ouvido para evitar eco.", "Use headphones to avoid echo."))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                if let notice {
                    Text(DexterLocalization.text(notice, locale: locale)).font(.system(size: 12)).foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat.live-voice.notice")
                }
                if controller.state == .failed, let sessionNotice = model.liveVoiceNotice,
                   let failureNotice = controller.safeMessage, sessionNotice != failureNotice {
                    Text(DexterLocalization.text(sessionNotice, locale: locale)).font(.system(size: 12)).foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat.live-voice.persistence-notice")
                }
                failureRecovery
            }
            .padding(controller.isSessionActive || controller.state == .failed ? 12 : 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if controller.isSessionActive || controller.state == .failed {
                    RoundedRectangle(cornerRadius: 12).fill(Color.accentColor.opacity(0.06))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat.live-voice.session")
        }
    }

    @ViewBuilder private var failureRecovery: some View {
        if controller.state == .failed {
            switch controller.failure {
            case .audio, .audioUnavailable:
                Button(text("Abrir ajustes de Som", "Open Sound settings")) {
                    openSystemSettings("x-apple.systempreferences:com.apple.Sound-Settings.extension")
                }
                .accessibilityIdentifier("chat.live-voice.audio-settings")
            case .microphoneDenied:
                Button(text("Permitir microfone nos Ajustes", "Allow microphone in Settings")) {
                    openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
                }
                .accessibilityIdentifier("chat.live-voice.microphone-settings")
            default:
                EmptyView()
            }
            if case let .audio(stage, osStatus) = controller.failure {
                DisclosureGroup(text("Detalhes do áudio", "Audio details")) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(audioStageLabel(stage)).font(.system(size: 12))
                        if let osStatus {
                            HStack(spacing: 6) {
                                Text(verbatim: "OSStatus")
                                Text(verbatim: String(osStatus)).textSelection(.enabled)
                            }
                            .font(.system(size: 12, design: .monospaced))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }
                .font(.system(size: 12))
                .accessibilityIdentifier("chat.live-voice.audio-diagnostic")
            }
        }
    }

    private func audioStageLabel(_ stage: LiveVoiceAudioStage) -> String {
        switch stage {
        case .inputFormat: return text("Formato do microfone", "Microphone format")
        case .conversion: return text("Conversão do microfone", "Microphone conversion")
        case .engineStart: return text("Inicialização do áudio", "Audio startup")
        case .playback: return text("Reprodução de áudio", "Audio playback")
        }
    }

    private func openSystemSettings(_ address: String) {
        guard let url = URL(string: address) else { return }
        // This is navigation only: the owner changes devices or permissions in macOS.
        NSWorkspace.shared.open(url)
    }

    private func caption(_ value: String, label: String, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 13)).lineLimit(4).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}
#endif
