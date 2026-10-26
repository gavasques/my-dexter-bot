#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// UX-P1-13: the one voice button of a private bot conversation (teams and groups never show it). What it does comes
/// from `VoiceEntryDecision`: the native Codex call when this conversation's effective engine is Codex and the host
/// says it can call; Live when the conversation has no native call and the owner set Live up; otherwise a sheet that
/// explains both paths and their costs. Opening never touches the microphone; a session keeps its own path until it ends.
struct VoiceEntryButton: View {
    let model: DexterAppModel
    let threadID: String
    @Environment(\.locale) private var locale
    @State private var controller: CodexNativeVoiceController?
    @State private var callPresented = false
    @State private var setupGap: NativeVoiceGap?
    @State private var setupOffersLive = false
    @State private var startingLive = false
    /// The host's answer could not be read after a few tries: offer "Configurar voz" (with Conferir de novo), not a
    /// button stuck on "Conferindo…".
    @State private var nativeCheckGaveUp = false

    private var route: VoiceEntryRoute {
        var input = model.voiceEntryInput(threadID: threadID, native: controller)
        if nativeCheckGaveUp, input.native == .notRead { input.native = .failed }
        return VoiceEntryDecision.route(input)
    }
    private var conversationIsCodex: Bool { model.effectiveConversationEngine.engine == .codex }

    var body: some View {
        let route = route
        if route != .hidden {
            Button { activate(route) } label: {
                Image(systemName: route == .liveInProgress || route == .nativeInProgress ? "waveform.circle.fill" : "waveform")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(route == .liveInProgress || route == .nativeInProgress ? Color.accentColor : Color.primary)
                    .frame(width: 30, height: 30)
                    .background(DexterSurface.raisedFill, in: Circle())
                    .overlay(Circle().strokeBorder(DexterSurface.raisedStroke))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!route.isEnabled || startingLive)
            .help(Text(verbatim: VoiceEntryCopy.help(route, locale: locale)))
            .accessibilityLabel(Text("Voz"))
            .accessibilityValue(Text(verbatim: VoiceEntryCopy.help(route, locale: locale)))
            .accessibilityIdentifier("chat.voice")
            .sheet(isPresented: $callPresented) {
                if let bot = model.selectedBot {
                    NativeVoiceCallSheet(model: model, bot: bot, threadID: threadID) { callPresented = false }
                }
            }
            .sheet(item: Binding(get: { setupGap.map(VoiceSetupItem.init) }, set: { setupGap = $0?.gap })) { item in
                VoiceSetupSheet(model: model, threadID: threadID, gap: item.gap, offersLive: setupOffersLive,
                                refreshNative: conversationIsCodex ? { nativeCheckGaveUp = false; await readNativeStatus() } : nil,
                                startLive: { setupGap = nil; startLive() })
            }
            // Re-read when the base's identity arrives or the conversation's engine settles: the controller can only
            // be bound to a known host, bot and conversation.
            .task(id: "\(model.nativeComposerScope)|\(threadID)|\(conversationIsCodex)|\(model.approvalPolicyHostID ?? "-")|\(model.selectedThreadID == threadID)") {
                await prepare()
            }
        }
    }

    /// Reads only: the host's native-call status for a Codex conversation, and Live's settings. Nothing starts here.
    private func prepare() async {
        if let bot = model.selectedBot, model.selectedThreadID == threadID {
            controller = model.nativeVoiceController(bot: bot, threadID: threadID)
        } else {
            controller = nil
        }
        await model.loadLiveVoiceSettings()
        if conversationIsCodex { await readNativeStatus() }
    }

    /// GET only, a few short tries: right after the conversation's engine settles the controller may still be catching
    /// up with the base, and a read it declines changes nothing. Never starts a call.
    private func readNativeStatus() async {
        guard let controller else { return }
        for attempt in 0..<4 {
            if Task.isCancelled { return }
            if controller.status?.threadId == threadID, controller.phase != .failed { return }
            if attempt > 0 { try? await Task.sleep(for: .milliseconds(300 * attempt * attempt)) }
            await controller.refreshStatus()
        }
        if controller.status?.threadId != threadID { nativeCheckGaveUp = true }
    }

    private func activate(_ route: VoiceEntryRoute) {
        switch route {
        case .nativeCall, .nativeInProgress:
            callPresented = true
        case .live:
            startLive()
        case .chooseLive(let gap):
            setupOffersLive = true; setupGap = gap
        case .setup(let gap):
            setupOffersLive = false; setupGap = gap
        case .hidden, .unavailable, .checking, .liveInProgress:
            break
        }
    }

    /// The user's own gesture starts Live; the microphone is requested by the session itself, never before.
    private func startLive() {
        guard !startingLive, model.canStartLiveVoice, model.selectedThreadID == threadID, model.presentedThreadID == threadID else { return }
        startingLive = true
        Task { @MainActor in await model.startLiveVoice(); startingLive = false }
    }
}

private struct VoiceSetupItem: Identifiable {
    let gap: NativeVoiceGap
    var id: String { String(describing: gap) }
}

/// "Configurar voz": both paths, what each uses and costs, and the state of each here. In a Codex conversation that
/// cannot call while Live is set up, Live is offered as an explicit choice; nothing switches, bills or installs alone.
struct VoiceSetupSheet: View {
    let model: DexterAppModel
    let threadID: String
    let gap: NativeVoiceGap
    let offersLive: Bool
    let refreshNative: (() async -> Void)?
    let startLive: () -> Void
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @Environment(\.openSettings) private var openSettings
    @State private var refreshing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "waveform").font(.system(size: 22)).foregroundStyle(.secondary).accessibilityHidden(true)
                Text(offersLive ? "Voz nesta conversa" : "Configurar voz").font(.title2.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            Text(verbatim: VoiceEntryCopy.gap(gap, locale: locale))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("voice-setup.reason")
            option(symbol: "phone", title: "Chamada nativa do Codex",
                   detail: "Usa o programa Codex deste Mac e o login dele. Não usa chave de API.",
                   status: VoiceEntryCopy.gapStatus(gap, locale: locale), id: "voice-setup.native") {
                if let refreshNative {
                    Button("Conferir de novo") {
                        refreshing = true
                        Task { await refreshNative(); refreshing = false; dismiss() }
                    }
                    .disabled(refreshing)
                    .accessibilityIdentifier("voice-setup.native.refresh")
                }
            }
            option(symbol: "waveform", title: "Voz ao vivo (OpenAI)",
                   detail: "Funciona com qualquer bot. Usa a sua chave da API OpenAI; o uso é cobrado à parte pela OpenAI.",
                   status: VoiceEntryCopy.liveStatus(model, locale: locale), id: "voice-setup.live") {
                if offersLive {
                    Button("Usar voz ao vivo agora", action: startLive)
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.canStartLiveVoice)
                        .accessibilityIdentifier("voice-setup.live.start")
                }
            }
            Text("Nada é ligado, cobrado ou instalado sem você escolher. O microfone só é usado depois que você começa.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Abrir Ajustes de voz") { router?.settingsTab = .assistants; openSettings(); dismiss() }
                    .accessibilityIdentifier("voice-setup.open-settings")
                Spacer()
                Button("Fechar") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("voice-setup.close")
            }
        }
        .padding(22)
        .frame(width: 500)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice-setup.sheet")
    }

    private func option<Action: View>(symbol: String, title: LocalizedStringKey, detail: LocalizedStringKey, status: String, id: String,
                                      @ViewBuilder action: () -> Action) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(.secondary).frame(width: 22).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: status).font(.callout).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(id + ".status")
                action()
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

/// Ajustes › Assistentes › Voz: the state of each path. The key and Live's own settings live in a private sheet.
struct VoiceSettingsSection: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var liveSheet = false

    /// The Codex program as this base reports it; whether it makes calls is checked in each Codex conversation.
    private var codexLine: String {
        let entry = model.engineCatalog.first { $0.id == EngineID.codex.rawValue }
        let readiness = EngineReadiness(entry: entry).label(portuguese: locale.language.languageCode?.identifier == "pt")
        guard let version = entry?.version, !version.isEmpty else { return readiness }
        return DexterLocalization.format("Codex %@", version, locale: locale) + " · " + readiness
    }

    var body: some View {
        Section {
            LabeledContent {
                Text(verbatim: codexLine).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                    .accessibilityIdentifier("settings.voice.native.status")
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Chamada nativa do Codex")
                        Text("Usa o programa Codex deste Mac e o login dele, sem chave de API. Cada conversa com Codex confere se o programa faz ligações.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                } icon: { Image(systemName: "phone") }
            }
            LabeledContent {
                VStack(alignment: .trailing, spacing: 6) {
                    Text(verbatim: VoiceEntryCopy.liveStatus(model, locale: locale)).foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .accessibilityIdentifier("settings.voice.live.status")
                    Button("Configurar…") { liveSheet = true }
                        .disabled(!model.canEditBotProfiles || model.isFixture)
                        .accessibilityIdentifier("settings.voice.live.configure")
                }
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Voz ao vivo (OpenAI)")
                        Text("Funciona com qualquer bot. Usa a sua chave da API OpenAI; o uso é cobrado à parte pela OpenAI.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                } icon: { Image(systemName: "waveform") }
            }
            Text("No chat, o botão de voz liga pela chamada nativa numa conversa com Codex que faz ligações; nas outras conversas, usa a voz ao vivo, se estiver pronta. Uma sessão nunca troca de caminho no meio.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Voz")
        }
        .task(id: "\(model.nativeComposerScope)|\(model.hostAddress)") { await model.loadLiveVoiceSettings() }
        .sheet(isPresented: $liveSheet) { LiveVoiceSetupSheet() }
    }
}

/// Private sheet for Live: enable, global voice and the OpenAI key. The key field is cleared when the sheet closes.
struct LiveVoiceSetupSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form { LiveVoiceSettingsSection() }
                .formStyle(.grouped)
                .navigationTitle("Voz ao vivo (OpenAI)")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Concluir") { dismiss() }
                            .keyboardShortcut(.defaultAction)
                            .accessibilityIdentifier("settings.voice.live.done")
                    }
                }
        }
        .frame(minWidth: 540, idealWidth: 560, minHeight: 440, idealHeight: 520)
    }
}

/// Body of Ajustes do bot › Modelo e voz › Voz (the BotProfile `voiceSection` slot, EARLY-01 contract): the voice
/// of this bot on each path. `liveVoice` is the page's profile draft (saved by its own footer); the native card keeps
/// its own editor, receipts and Conferir and never marks the profile draft. IDs `bot-profile.native-voice.*` and
/// `bot-profile.live-voice` are unchanged.
struct BotVoiceSettingsCard: View {
    let model: DexterAppModel
    let bot: Bot
    @Binding var liveVoice: String?
    let enabled: Bool
    @Environment(\.locale) private var locale
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                pathHeader("Chamada nativa do Codex", "Usa o programa Codex deste Mac e o login dele. Não usa chave de API.", symbol: "phone")
                if bot.engine == .codex {
                    NativeVoicePreferenceCard(model: model, bot: bot, showsTitle: false)
                } else {
                    Text("Este bot começa as conversas com \(bot.engine.displayName). A chamada nativa existe só em conversas com Codex.")
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("bot-profile.native-voice.not-codex")
                }
            }
            .padding(.vertical, 12)
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                pathHeader("Voz ao vivo (OpenAI)", "Usa a sua chave da API OpenAI; o uso é cobrado à parte pela OpenAI.", symbol: "waveform")
                if let settings = model.liveVoiceSettings, settings.enabled {
                    Picker("Voz deste bot", selection: $liveVoice) {
                        Text("Usar voz geral").tag(nil as String?)
                        ForEach(LiveVoiceCatalog.voices, id: \.self) { voice in
                            Text(verbatim: LiveVoiceCatalog.label(voice)).tag(Optional(voice))
                        }
                    }
                    .disabled(!enabled)
                    .accessibilityIdentifier("bot-profile.live-voice")
                    if liveVoice == nil {
                        LabeledContent("Voz geral") { Text(verbatim: LiveVoiceCatalog.label(settings.defaultVoice)) }
                    }
                    Text("Vale para as próximas sessões de voz ao vivo deste bot. Uma sessão aberta mantém a voz com que começou.")
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("A voz ao vivo está desligada nesta base. Ligue em Ajustes › Assistentes › Voz para escolher uma voz para este bot.")
                        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Abrir Ajustes de voz") { router?.settingsTab = .assistants; openSettings() }
                        .accessibilityIdentifier("bot-profile.voice.open-settings")
                }
            }
            .padding(.vertical, 12)
        }
        .task(id: "\(model.nativeComposerScope)|\(model.hostAddress)") { await model.loadLiveVoiceSettings() }
    }

    private func pathHeader(_ title: LocalizedStringKey, _ detail: LocalizedStringKey, symbol: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Plain words for routes, gaps and Live's state. Catalog keys are Portuguese; English comes from the catalog.
enum VoiceEntryCopy {
    private static func text(_ key: String, _ locale: Locale) -> String { DexterLocalization.text(key, locale: locale) }
    private static func format(_ key: String, _ value: String, _ locale: Locale) -> String { DexterLocalization.format(key, value, locale: locale) }

    static func help(_ route: VoiceEntryRoute, locale: Locale) -> String {
        switch route {
        case .hidden: ""
        case .nativeCall: text("Ligar para este bot · chamada nativa do Codex", locale)
        case .nativeInProgress: text("Ligação em andamento · abrir", locale)
        case .live: text("Voz ao vivo · OpenAI, cobrada na sua chave da API", locale)
        case .liveInProgress: text("Voz ao vivo em andamento. Use Parar abaixo da mensagem.", locale)
        case .chooseLive: text("A chamada nativa não está disponível nesta conversa. Ver opções de voz…", locale)
        case .setup: text("Configurar voz…", locale)
        case .checking: text("Conferindo a voz desta conversa…", locale)
        case .unavailable(.demo): text("A demonstração não tem voz.", locale)
        case .unavailable(.noLocalBase): text("A voz precisa da base deste Mac conectada.", locale)
        case .unavailable(.engineLoading): text("Conferindo o modelo desta conversa…", locale)
        case .unavailable(.replyRunning): text("Disponível quando a resposta terminar.", locale)
        }
    }

    static func gap(_ gap: NativeVoiceGap, locale: Locale) -> String {
        switch gap {
        case .notCodex(let engine): format("Esta conversa usa %@. A chamada nativa existe só em conversas com Codex.", engine.displayName, locale)
        case .programUpdate(let version?): format("O Codex deste Mac (versão %@) não faz ligações. Uma versão do programa oficial que faça ligações resolve; o Dexter não atualiza programas sozinho.", version, locale)
        case .programUpdate(nil): text("O Codex desta base não faz ligações nesta conversa.", locale)
        case .signIn: text("Entre no programa oficial do Codex neste Mac para ligar.", locale)
        case .modelUnsupported: text("O modelo escolhido nesta conversa não aceita ligação. Troque o modelo abaixo da mensagem.", locale)
        case .unavailable: text("Não foi possível conferir a chamada nativa agora.", locale)
        }
    }

    static func gapStatus(_ gap: NativeVoiceGap, locale: Locale) -> String {
        switch gap {
        case .notCodex: text("Indisponível nesta conversa", locale)
        case .programUpdate(let version?): format("Programa sem ligações · versão %@", version, locale)
        case .programUpdate(nil): text("Programa sem ligações", locale)
        case .signIn: text("Falta entrar no Codex", locale)
        case .modelUnsupported: text("Modelo desta conversa sem ligação", locale)
        case .unavailable: text("Não conferida", locale)
        }
    }

    @MainActor static func liveStatus(_ model: DexterAppModel, locale: Locale) -> String {
        guard let settings = model.liveVoiceSettings else { return text("Não consultada nesta base", locale) }
        guard settings.enabled else { return text("Desligada", locale) }
        guard model.liveVoiceKeyConfigured else { return text("Ligada, mas falta a chave", locale) }
        return format("Pronta · voz geral %@", LiveVoiceCatalog.label(settings.defaultVoice), locale)
    }
}
#endif
