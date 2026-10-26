#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Explicit local CUA setup and policy scopes. Host grants, calibration and surfaces stay separate.
/// Embedded in the guided screen-control panel with `fixedBotID`: the panel owns the bot choice and the overview,
/// this editor keeps the same stopped-agent rechecks, snapshot CAS and confirmations.
struct MacCuaConfigurationView: View {
    let agent: LocalMacAgentProcess
    let client: HostClient?
    let selection: LocalMacAgentSelection
    let onConfigurationChanged: (LocalMacAgentSelection) -> Void
    var fixedBotID: String? = nil
    /// Called after a confirmed local policy write so the owner of the overview can read the new state.
    var onChanged: (() -> Void)? = nil
    @Environment(\.locale) private var locale
    @State private var package: LocalMacAgentCuaPackage?
    @State private var snapshot: LocalMacAgentPolicySnapshot?
    @State private var installationID: String?
    @State private var bots: [Bot] = []
    @State private var botID = ""
    @State private var operations: Set<String> = []
    @State private var seconds = 300
    @State private var busy = false
    @State private var generation = 0
    @State private var notice: String?
    @State private var confirmingSetup = false
    @State private var confirmingPolicy = false
    @State private var confirmingRemove = false

    private var configured: Bool { LocalMacAgentCuaAuthorization.operations.allSatisfy(selection.capabilities.contains) }
    private var stopped: Bool {
        guard !agent.ownsLiveChild else { return false }
        switch agent.state { case .stopped, .exited: return true; case .running, .stopping: return false }
    }
    private var bot: Bot? { bots.first { $0.id == botID } }
    private var embedded: Bool { fixedBotID != nil }
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !embedded {
                Text(text("Controle de tela deste Mac", "Screen control on this Mac")).font(.headline)
                Text(text("Preparar o helper não concede acesso. Cada sessão exige calibração física, permissões do macOS, escolha de um app, confirmação local e indicador visível.", "Preparing the helper grants no access. Each session requires physical calibration, macOS permissions, app selection, local confirmation and a visible indicator."))
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if !configured {
                if package != nil {
                    Button(text("Preparar helper de controle…", "Prepare screen control helper…")) { confirmingSetup = true }
                        .disabled(busy || !stopped || snapshot == nil)
                        .accessibilityIdentifier("settings.mac-cua.prepare")
                    Text(text("Será copiado o helper deste pacote e adicionadas as três capacidades de controle. Browser e arquivos existentes serão preservados.", "This package’s helper will be copied and the three screen control capabilities added. Existing browser and file settings are preserved."))
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    Text(text("Este pacote não inclui o helper CUA. O browser continua disponível.", "This package does not include the CUA helper. Browser access remains available."))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                if !embedded {
                    Text(text("Helper configurado. Novo pareamento pode ser necessário para anunciar estas capacidades; isso não comprova presença ou calibração.", "Helper configured. New pairing may be needed to announce these capabilities; this does not prove presence or calibration."))
                        .font(.footnote).foregroundStyle(.secondary)
                    Picker(text("Bot", "Bot"), selection: $botID) {
                        Text(text("Escolha um bot", "Choose a bot")).tag("")
                        ForEach(bots) { Text($0.name).tag($0.id) }
                    }.disabled(busy)
                    .accessibilityIdentifier("settings.mac-cua.bot")
                }
                ForEach(LocalMacAgentCuaAuthorization.operations, id: \.self) { operation in
                    Toggle(label(operation), isOn: Binding(get: { operations.contains(operation) }, set: {
                        if $0 { operations.insert(operation) } else { operations.remove(operation) }
                    })).disabled(busy || bot == nil)
                }
                Picker(text("Duração máxima da sessão", "Maximum session duration"), selection: $seconds) {
                    ForEach([60, 300, 600, 900], id: \.self) { Text("\($0 / 60) min").tag($0) }
                    if ![60, 300, 600, 900].contains(seconds) { Text("\(seconds) s").tag(seconds) }
                }.disabled(busy || bot == nil)
                Text(text("A política vale somente para este bot neste Mac. Grants do host, aprovação da chamada e consentimento por superfície continuam necessários.", "This policy applies only to this bot on this Mac. Host grants, call approval and per-surface consent remain required."))
                    .font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Button(text("Salvar autorização local…", "Save local authorization…")) { confirmingPolicy = true }
                        .disabled(busy || !stopped || bot == nil || snapshot == nil || operations.isEmpty)
                        .accessibilityIdentifier("settings.mac-cua.save")
                    Button(text("Remover autorização CUA…", "Remove CUA authorization…"), role: .destructive) { confirmingRemove = true }
                        .disabled(busy || !stopped || snapshot?.cuaAuthorizations.contains(where: { $0.botID == botID }) != true)
                        .accessibilityIdentifier("settings.mac-cua.remove")
                }
            }
            if !stopped { Text(text("Pare o agente e aguarde sua parada para alterar a configuração.", "Stop the agent and wait for it to exit before changing configuration.")).font(.footnote) }
            if !embedded {
                Button(text("Recarregar e conferir", "Reload and verify")) { load() }.disabled(busy)
                    .accessibilityIdentifier("settings.mac-cua.reload")
            }
            if busy { ProgressView().controlSize(.small) }
            if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
        }
        .task(id: selection) { load() }
        .onDisappear { generation += 1 }
        .onChange(of: botID) { _, _ in fill() }
        .onChange(of: fixedBotID) { _, _ in adoptFixedBot() }
        .confirmationDialog(text("Preparar controle de tela?", "Prepare screen control?"), isPresented: $confirmingSetup) {
            Button(text("Preparar", "Prepare")) { mutate(kind: .setup) }
        } message: { Text(text("O agente deve estar parado. Nada será iniciado e nenhuma autorização será criada.", "The agent must be stopped. Nothing will start and no authorization will be created.")) }
        .confirmationDialog(text("Salvar autorização CUA deste bot?", "Save this bot’s CUA authorization?"), isPresented: $confirmingPolicy) {
            Button(text("Salvar", "Save")) { mutate(kind: .save) }
        } message: { Text(operations.sorted().map(label).joined(separator: ", ") + " · \(seconds) s") }
        .confirmationDialog(text("Remover autorização CUA?", "Remove CUA authorization?"), isPresented: $confirmingRemove) {
            Button(text("Remover", "Remove"), role: .destructive) { mutate(kind: .remove) }
        } message: { Text(text("Browser e arquivos continuam com suas políticas próprias.", "Browser and files retain their own policies.")) }
    }

    private func label(_ operation: String) -> String {
        switch operation {
        case "mac.cua.status": text("Consultar estado", "Check status")
        case "mac.cua.observe": text("Observar o app escolhido", "Observe the selected app")
        default: text("Controlar o app escolhido", "Control the selected app")
        }
    }
    /// The overview's bot, only when the connected host lists it; otherwise nothing is scoped.
    private func adoptFixedBot() {
        guard let fixedBotID else { return }
        botID = bots.contains(where: { $0.id == fixedBotID }) ? fixedBotID : ""
    }
    private func fill() {
        let current = snapshot?.cuaAuthorizations.first { $0.botID == botID }
        operations = Set(current?.operations ?? []); seconds = current?.maxSessionSeconds ?? 300
    }
    private func load() {
        guard !busy else { return }
        generation += 1; let token = generation
        package = try? LocalMacAgentCuaPackage.packaged()
        guard let client else { snapshot = nil; notice = text("Conecte ao host local para conferir esta configuração.", "Connect to the local host to verify this configuration."); return }
        busy = true; notice = nil
        Task { @MainActor in
            do {
                let id = try await client.localMacAgentInstallationID()
                let hostBots = try await client.listBots()
                guard token == generation else { return }
                let read = try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: id)
                snapshot = read; installationID = id; bots = hostBots
                if embedded { adoptFixedBot() } else if !hostBots.contains(where: { $0.id == botID }) { botID = "" }
                fill()
            } catch {
                guard token == generation else { return }
                snapshot = nil; installationID = nil
                notice = text("Não foi possível conferir a configuração. Recarregue antes de alterar.", "Could not verify configuration. Reload before making changes.")
            }
            if token == generation { busy = false }
        }
    }
    private enum Mutation { case setup, save, remove }
    private func mutate(kind: Mutation) {
        guard !busy, let client, let expected = snapshot, let id = installationID else { return }
        agent.refresh(); guard stopped else { return }
        let selectedBot = bot, selectedOperations = operations.sorted(), duration = seconds, token = generation
        busy = true; notice = nil
        Task { @MainActor in
            do {
                let currentID = try await client.localMacAgentInstallationID()
                let currentBots = try await client.listBots()
                guard token == generation, currentID == id else { throw LocalMacAgentPolicyError.hostMismatch }
                if kind != .setup { guard let selectedBot, currentBots.contains(where: { $0.id == selectedBot.id }) else { throw LocalMacAgentPolicyError.hostMismatch } }
                agent.refresh(); guard stopped else { throw LocalMacAgentPolicyError.agentMustBeStopped }
                // No suspension from final stopped/host/bot check through synchronous mutations.
                switch kind {
                case .setup:
                    guard let package, try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: id) == expected else { throw LocalMacAgentCuaSetupError.conflict }
                    let next = try LocalMacAgentCuaSetup.configure(package: package, selection: selection, expectedInstallationID: id, agentStopped: true)
                    snapshot = nil; onConfigurationChanged(next)
                case .save:
                    guard let selectedBot else { throw LocalMacAgentPolicyError.hostMismatch }
                    let clean = String(selectedBot.name.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || " ._-".unicodeScalars.contains($0) }.prefix(48))
                    let authorization = try LocalMacAgentCuaAuthorization(botID: selectedBot.id, label: clean.isEmpty ? "Bot" : clean,
                                                                         operations: selectedOperations, maxSessionSeconds: duration)
                    snapshot = try LocalMacAgentPolicy.replaceCua(authorization, expectedSnapshot: expected, agentStopped: true); fill()
                    onChanged?()
                case .remove:
                    guard let selectedBot else { throw LocalMacAgentPolicyError.hostMismatch }
                    snapshot = try LocalMacAgentPolicy.removeCua(botID: selectedBot.id, expectedSnapshot: expected, agentStopped: true); fill()
                    onChanged?()
                }
                notice = text("Salvo localmente. Inicie o agente explicitamente; pareamento, grants e calibração ainda são etapas separadas.", "Saved locally. Start the agent explicitly; pairing, grants and calibration remain separate steps.")
            } catch {
                guard token == generation else { return }
                snapshot = nil; installationID = nil
                notice = text("Não foi possível confirmar a alteração. Recarregue e confira os arquivos antes de tentar novamente; nada será repetido automaticamente.", "Could not confirm the change. Reload and verify the files before trying again; nothing will be retried automatically.")
            }
            if token == generation { busy = false }
        }
    }
}
#endif
