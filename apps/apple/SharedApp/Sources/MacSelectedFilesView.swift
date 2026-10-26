#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI
import UniformTypeIdentifiers

/// Files a bot may read or append to on this Mac, chosen one by one by the owner. Kept in a private policy
/// separate from browser sites. Opening this view reads nothing and shows no panel; choosing a file records only
/// its location and identity (never its contents). Writes need the owned agent confirmed stopped and never restart it.
/// A config change (enabling files) is handed to the root through `onConfigurationChanged`.
struct MacSelectedFilesView: View {
    let agent: LocalMacAgentProcess
    let client: HostClient
    let selection: LocalMacAgentSelection
    let onConfigurationChanged: (LocalMacAgentSelection) -> Void
    @State private var generation = 0
    @State private var snapshot: LocalMacSelectedFilesSnapshot?
    @State private var loadedInstallationID: String?
    /// Selection produced by our own enable; adopting it from the root keeps the loaded state.
    @State private var producedSelection: LocalMacAgentSelection?
    @State private var bots: [Bot] = []
    @State private var botID: String?
    @State private var candidate: LocalMacSelectedFileCandidate?
    @State private var name = ""
    @State private var allowRead = true
    @State private var allowAppend = false
    @State private var removing: LocalMacSelectedFile?
    @State private var confirmEnable = false
    @State private var confirmAdd = false
    @State private var confirmRemove = false
    @State private var busy = false
    @State private var notice: String?
    @State private var saved: String?

    private var stopped: Bool {
        guard !agent.ownsLiveChild else { return false }
        switch agent.state {
        case .stopped, .exited: return true
        case .running, .stopping: return false
        }
    }
    private var files: [LocalMacSelectedFile] { botID.map { snapshot?.files(for: $0) ?? [] } ?? [] }
    private var operations: [String] { (allowRead ? ["mac.file.read"] : []) + (allowAppend ? ["mac.file.append"] : []) }
    private var validName: Bool { name.range(of: "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil }

    var body: some View {
        DisclosureGroup("Arquivos permitidos") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Escolha arquivos específicos que cada bot pode ler ou complementar neste Mac. Pastas não são aceitas e o conteúdo não é lido ao escolher.")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Button(LocalizedStringKey(snapshot == nil ? "Carregar arquivos permitidos" : "Recarregar"), action: load)
                        .disabled(busy)
                        .accessibilityIdentifier("settings.mac-agent.files.load")
                    if busy { ProgressView().controlSize(.small) }
                }
                if let snapshot {
                    if !snapshot.enabled { enableSection } else { botSection }
                }
                if let saved { Text(verbatim: saved).font(.footnote).foregroundStyle(.secondary) }
                if let notice { Text(verbatim: notice).font(.footnote).foregroundStyle(.orange) }
            }
            .padding(.top, 4)
        }
        .onChange(of: selection) { _, new in if new != producedSelection { reset() } }
        .onDisappear { reset() }
        .confirmationDialog("Ativar arquivos permitidos?", isPresented: $confirmEnable) {
            Button("Ativar", action: enable)
        } message: {
            Text("A configuração do agente passa a oferecer leitura e acréscimo em arquivos, sem nenhum arquivo escolhido. Nenhum bot ganha acesso até você escolher um arquivo para ele.")
        }
        .confirmationDialog("Permitir este arquivo?", isPresented: $confirmAdd) {
            Button("Permitir", action: add)
        } message: {
            Text("O bot poderá \(operationSummary(operations)) o arquivo \(candidate?.displayName ?? "") com o nome \(name). O host continua pedindo aprovação de cada ferramenta.")
        }
        .confirmationDialog("Remover este arquivo do bot?", isPresented: $confirmRemove, presenting: removing) { file in
            Button("Remover", role: .destructive) { remove(file) }
        } message: { file in
            Text("O bot deixa de acessar \(file.displayName). O arquivo não é apagado.")
        }
    }

    @ViewBuilder private var enableSection: some View {
        Text("Os arquivos ainda não estão ativados neste agente.").font(.footnote).foregroundStyle(.secondary)
        if !stopped { stoppedHint }
        Button("Ativar arquivos permitidos…") { confirmEnable = true }
            .disabled(busy || !stopped)
            .accessibilityIdentifier("settings.mac-agent.files.enable")
    }

    @ViewBuilder private var botSection: some View {
        Text("Os bots só usam arquivos quando o agente anuncia as ferramentas de arquivo ao host. Um agente já pareado pode precisar de um novo pareamento explícito; o app não repara isso sozinho, e o host continua exigindo permissão e aprovação.")
            .font(.footnote).foregroundStyle(.secondary)
        if bots.isEmpty {
            Text("Nenhum bot neste host.").font(.footnote).foregroundStyle(.secondary)
        } else {
            Picker("Bot", selection: $botID) {
                Text("Escolha um bot").tag(String?.none)
                ForEach(bots) { Text($0.name).tag(Optional($0.id)) }
            }
            .disabled(busy)
            .accessibilityIdentifier("settings.mac-agent.files.bot")
            .onChange(of: botID) { _, _ in clearDraft() }
        }
        if botID != nil {
            VStack(alignment: .leading, spacing: 4) {
                if files.isEmpty { Text("Nenhum arquivo para este bot.").font(.footnote).foregroundStyle(.secondary) }
                ForEach(files, id: \.name) { file in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(verbatim: file.name).font(.callout.weight(.medium))
                            Text(verbatim: "\(file.displayName) · \(operationList(file.operations))").font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remover…") { removing = file; confirmRemove = true }
                            .buttonStyle(.borderless).disabled(busy || !stopped)
                    }
                }
            }
            Divider()
            addSection
        }
    }

    @ViewBuilder private var addSection: some View {
        Text("Adicionar arquivo").font(.callout.weight(.medium))
        HStack {
            Button("Escolher arquivo…", action: choose).disabled(busy || files.count >= LocalMacSelectedFiles.maximumFilesPerBot)
                .accessibilityIdentifier("settings.mac-agent.files.choose")
            if let candidate { Text(verbatim: candidate.displayName).font(.callout).lineLimit(1).truncationMode(.middle) }
        }
        if candidate != nil {
            TextField("Nome para o bot", text: $name)
                .autocorrectionDisabled()
                .accessibilityIdentifier("settings.mac-agent.files.name")
            Text(LocalizedStringKey(name.isEmpty || validName
                 ? "O bot usa este nome para pedir o arquivo. Letras, números e . _ - até 64 caracteres."
                 : "Nome recusado. Comece com letra ou número; use só letras, números e . _ -, sem \"..\"."))
                .font(.footnote).foregroundStyle(name.isEmpty || validName ? Color.secondary : Color.orange)
            Toggle("Permitir ler", isOn: $allowRead).disabled(busy)
            Toggle("Permitir acrescentar linhas ao final", isOn: $allowAppend).disabled(busy)
            Text("Acrescentar nunca cria, apaga ou reescreve o arquivo.").font(.footnote).foregroundStyle(.secondary)
            if !stopped { stoppedHint }
            Button("Salvar…") { confirmAdd = true }
                .disabled(busy || !stopped || !validName || operations.isEmpty || files.contains { $0.name == name })
                .accessibilityIdentifier("settings.mac-agent.files.save")
        }
    }

    private var stoppedHint: some View {
        Text("Pare o agente para salvar. Depois de salvar, inicie-o novamente para aplicar.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    // MARK: - Actions

    private func reset() {
        generation += 1; snapshot = nil; loadedInstallationID = nil; producedSelection = nil; bots = []; botID = nil
        busy = false; notice = nil; saved = nil; confirmEnable = false; confirmAdd = false; confirmRemove = false; removing = nil
        clearDraft()
    }

    private func clearDraft() { candidate = nil; name = ""; allowRead = true; allowAppend = false }

    /// Explicit read: host identity and bots, then the local files policy bound to that installation.
    private func load() {
        guard !busy else { return }
        generation += 1
        let token = generation, client = client, selection = selection
        busy = true; notice = nil; saved = nil
        Task { @MainActor in
            do {
                let installationID = try await client.localMacAgentInstallationID()
                let hostBots = try await client.listBots()
                let read = try await Task.detached {
                    try LocalMacSelectedFiles.read(selection: selection, expectedInstallationID: installationID)
                }.value
                guard token == generation else { return }
                snapshot = read; loadedInstallationID = installationID; bots = hostBots
                if let botID, !hostBots.contains(where: { $0.id == botID }) { self.botID = nil; clearDraft() }
            } catch {
                guard token == generation else { return }
                snapshot = nil; loadedInstallationID = nil; bots = []; botID = nil; clearDraft()
                notice = message(for: error)
            }
            if token == generation { busy = false }
        }
    }

    /// Owner panel: one existing file, no folders. Only metadata is inspected.
    private func choose() {
        guard let snapshot else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false; panel.resolvesAliases = false
        panel.allowedContentTypes = [.text, .data]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let chosen = try LocalMacSelectedFiles.inspect(url, selection: snapshot.selection)
            candidate = chosen; notice = nil; saved = nil
            if name.isEmpty { name = suggestedName(chosen.displayName) }
        } catch {
            candidate = nil
            notice = String(localized: "Arquivo recusado. Escolha um arquivo comum seu, fora da pasta do agente, sem atalhos, links ou pastas com link.")
        }
    }

    private func enable() {
        mutate(botID: nil) { expected, stopped in
            let result = try LocalMacSelectedFiles.enable(expectedSnapshot: expected, agentStopped: stopped)
            return (result.snapshot, result.selection)
        }
    }

    private func add() {
        guard let botID, let candidate else { return }
        let name = name, operations = operations
        mutate(botID: botID) { expected, stopped in
            (try LocalMacSelectedFiles.addFile(botID: botID, name: name, candidate: candidate, operations: operations,
                                               expectedSnapshot: expected, agentStopped: stopped), nil)
        }
    }

    private func remove(_ file: LocalMacSelectedFile) {
        guard let botID else { return }
        mutate(botID: botID) { expected, stopped in
            (try LocalMacSelectedFiles.removeFile(botID: botID, name: file.name, expectedSnapshot: expected, agentStopped: stopped), nil)
        }
    }

    /// Fresh host identity and bot check; then the final process check and the write run on this actor with no
    /// suspension in between (Start uses the same actor). Never stops or starts the agent.
    private func mutate(botID: String?, _ write: @escaping @Sendable (LocalMacSelectedFilesSnapshot, Bool) throws
                        -> (LocalMacSelectedFilesSnapshot, LocalMacAgentSelection?)) {
        guard !busy, let expected = snapshot, let expectedInstallationID = loadedInstallationID else { return }
        guard expected.selection == selection else {
            notice = String(localized: "A configuração do agente mudou. Recarregue os arquivos antes de salvar."); return
        }
        agent.refresh()
        guard stopped else { notice = String(localized: "Pare o agente e aguarde a parada antes de salvar."); return }
        let token = generation
        busy = true; notice = nil; saved = nil
        Task { @MainActor in
            do {
                let installationID = try await client.localMacAgentInstallationID()
                let hostBots = try await client.listBots()
                guard token == generation else { return }
                guard expected == snapshot, expected.selection == selection else { throw LocalMacSelectedFilesError.conflict }
                guard installationID == expectedInstallationID,
                      botID.map({ id in hostBots.contains { $0.id == id } }) ?? true else {
                    throw LocalMacSelectedFilesError.hostMismatch
                }
                agent.refresh()
                guard stopped else { throw LocalMacSelectedFilesError.agentMustBeStopped }
                let (result, newSelection) = try write(expected, true)
                snapshot = result; bots = hostBots; clearDraft()
                if let newSelection {
                    producedSelection = newSelection
                    saved = String(localized: "Arquivos ativados. Escolha os arquivos de cada bot e inicie o agente para aplicar.")
                    onConfigurationChanged(newSelection)
                } else {
                    saved = String(localized: "Salvo. Inicie o agente para aplicar.")
                }
            } catch {
                guard token == generation else { return }
                switch error {
                case LocalMacSelectedFilesError.outcomeUnknown, LocalMacSelectedFilesError.writeFailed:
                    snapshot = nil; loadedInstallationID = nil; clearDraft()
                    notice = String(localized: "Não foi possível confirmar a alteração. Recarregue os arquivos e confira o estado antes de tentar de novo.")
                default:
                    notice = message(for: error)
                    if error as? LocalMacSelectedFilesError == .conflict { snapshot = nil; loadedInstallationID = nil; clearDraft() }
                }
            }
            if token == generation { busy = false }
        }
    }

    private func message(for error: Error) -> String {
        switch error {
        case LocalMacSelectedFilesError.agentMustBeStopped:
            String(localized: "Pare o agente e aguarde a parada antes de salvar.")
        case LocalMacSelectedFilesError.conflict:
            String(localized: "A configuração mudou desde a leitura. Nada foi salvo; recarregue e revise.")
        case LocalMacSelectedFilesError.hostMismatch:
            String(localized: "A configuração local pertence a outro host ou foi alterada. Nada foi salvo.")
        case LocalMacSelectedFilesError.unsafeFile:
            String(localized: "O arquivo mudou ou não é mais aceito. Escolha-o novamente.")
        case LocalMacSelectedFilesError.duplicateName:
            String(localized: "Este bot já tem um arquivo com esse nome ou esse mesmo arquivo. Remova o anterior primeiro.")
        case LocalMacSelectedFilesError.limitReached:
            String(localized: "Limite de arquivos ou de capacidades atingido. Nada foi salvo.")
        case LocalMacSelectedFilesError.unsafeLocation, LocalMacSelectedFilesError.invalidInput:
            String(localized: "A configuração local não está no formato preparado por este app. Nada foi alterado.")
        case HostClientError.notReady:
            String(localized: "O host local ainda não ativou o canal cifrado de dispositivos.")
        default:
            String(localized: "Não foi possível consultar o host local. Confira se ele está em execução.")
        }
    }

    /// Alias suggestion from the file name; the owner can edit it before saving.
    private func suggestedName(_ fileName: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in fileName.unicodeScalars where scalar.isASCII {
            let character = Character(scalar)
            scalars.append(character.isLetter || character.isNumber || "._-".contains(character) ? scalar : "-")
        }
        var value = String(scalars)
        while value.contains("..") { value = value.replacingOccurrences(of: "..", with: ".") }
        while let first = value.first, !(first.isLetter || first.isNumber) { value.removeFirst() }
        return String(value.prefix(64))
    }

    private func operationSummary(_ operations: [String]) -> String {
        switch (operations.contains("mac.file.read"), operations.contains("mac.file.append")) {
        case (true, true): String(localized: "ler e acrescentar linhas ao final de")
        case (false, true): String(localized: "acrescentar linhas ao final de")
        default: String(localized: "ler")
        }
    }

    private func operationList(_ operations: [String]) -> String {
        operations.map { $0 == "mac.file.read" ? String(localized: "leitura") : String(localized: "acréscimo") }
            .joined(separator: ", ")
    }
}
#endif
