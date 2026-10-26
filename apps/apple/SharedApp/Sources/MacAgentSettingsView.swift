#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct MacAutoSetupPresentation: Identifiable {
    let id = UUID()
    let controller: MacAutoSetupController
}

/// Keep dismissal outside the scrolling form; closing preserves the running agent and saved setup.
struct MacAdvancedSettingsSheet: View {
    let agent: LocalMacAgentProcess
    var client: HostClient? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Configuração avançada do Mac…")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Fechar")
                .accessibilityLabel("Fechar")
                .accessibilityIdentifier("settings.mac-agent.advanced.close")
                .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            Divider()
            Form { MacAgentSettingsSection(agent: agent, client: client) }
                .formStyle(.grouped)
        }
        .frame(width: 740, height: 700)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings.mac-agent.advanced.sheet")
    }
}

struct MacAutoSetupView: View {
    @Bindable var controller: MacAutoSetupController
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("Preparar este Mac", systemImage: "desktopcomputer").font(.title2.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text("O Dexter prepara a conexão e seus auxiliares. Você autoriza o macOS na janela do auxiliar; nenhum bot recebe acesso nesta etapa.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            switch controller.phase {
            case .idle, .ready:
                Text(controller.pendingCreationID == nil ? LocalizedStringKey("Será criada uma identidade privada para este Mac, se ainda não existir. O canal protegido será guardado no Keychain e reaberto por este app.")
                    : LocalizedStringKey("Há uma preparação incompleta. Retomar usa a mesma chave do pedido original, sem criar outra."))
                    .fixedSize(horizontal: false, vertical: true)
            case .preparing, .checking:
                HStack { ProgressView().controlSize(.small); Text("Preparando e conferindo a conexão…") }
                    .accessibilityIdentifier("mac-auto-setup.progress")
            case .awaitingApproval:
                Label("Este Mac pediu para se conectar à sua base.", systemImage: "link")
                Text("Conectar pareia apenas este dispositivo. O acesso de cada bot continua separado.").foregroundStyle(.secondary)
                if let fingerprint = controller.fingerprint {
                    DisclosureGroup("Identidade deste Mac") { Text(verbatim: fingerprint).font(.caption.monospaced()).textSelection(.enabled) }
                        .accessibilityIdentifier("mac-auto-setup.fingerprint")
                }
            case .connected:
                Label("A base confirmou este Mac conectado.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    .accessibilityIdentifier("mac-auto-setup.connected")
                Text("Agora conclua as permissões e a verificação de bloqueio na janela Dexter Control. Depois, escolha nos ajustes do bot se ele pode usar o Mac.")
                    .fixedSize(horizontal: false, vertical: true)
                Button("Mostrar auxiliar") { controller.showControlPanel() }.accessibilityIdentifier("mac-auto-setup.show-helper")
            case .unconfirmed:
                Label("O resultado ainda não foi confirmado. Conferir consulta o estado sem repetir a preparação ou a aprovação.", systemImage: "questionmark.circle")
                    .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("mac-auto-setup.unconfirmed")
            case .blocked(let text):
                Label { Text(verbatim: text).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: "exclamationmark.triangle") }
                    .foregroundStyle(.orange).accessibilityIdentifier("mac-auto-setup.blocked")
            }
            if let detail = controller.preparationDetail {
                Text(verbatim: detail).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("mac-auto-setup.preparation-detail")
            }
            if let notice = controller.panelNotice { Text(verbatim: notice).font(.caption).foregroundStyle(.secondary) }
            Divider()
            HStack {
                Button("Fechar") { controller.close(); dismiss() }.keyboardShortcut(.cancelAction).accessibilityIdentifier("mac-auto-setup.close")
                Spacer()
                if controller.phase == .ready {
                    Button(controller.pendingCreationID == nil ? LocalizedStringKey("Preparar este Mac") : LocalizedStringKey("Retomar preparação")) { controller.prepare() }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction).accessibilityIdentifier("mac-auto-setup.prepare")
                } else if controller.phase == .awaitingApproval {
                    Button("Conectar este Mac") { controller.approve() }.buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction).accessibilityIdentifier("mac-auto-setup.approve")
                } else if controller.phase == .unconfirmed || controller.phase == .connected {
                    Button("Conferir") { controller.reconcile() }.accessibilityIdentifier("mac-auto-setup.reconcile")
                    Button("Parar auxiliar") { controller.stop() }.accessibilityIdentifier("mac-auto-setup.stop")
                }
                if controller.canReconnect {
                    Button("Reconectar auxiliar") { controller.reconnect() }
                        .accessibilityIdentifier("mac-auto-setup.reconnect")
                }
            }
        }
        .padding(24).frame(width: 550).accessibilityElement(children: .contain).accessibilityIdentifier("mac-auto-setup.sheet")
        .task { controller.open() }
        .onChange(of: model.hostAddress) { _, _ in controller.close(); dismiss() }
        .onChange(of: model.nativeComposerScope) { _, _ in controller.close(); dismiss() }
        .onDisappear { controller.close() }
    }
}

/// Guided preparation writes only public trust, a deny-by-default policy and the private config.
/// Opening Settings never invokes the daemon or the identity helper; each step is an explicit action.
/// `client` is the owner-loopback host selected in the app; enrollment never runs through a paired client.
struct MacAgentSettingsSection: View {
    let agent: LocalMacAgentProcess
    var client: HostClient? = nil
    @State private var selection: LocalMacAgentSelection?
    @State private var location: LocalMacAgentSetupLocation?
    @State private var prepared = false
    @State private var conflict = false
    @State private var helper: LocalMacAgentHelperPackage?
    /// Pairing offer: memory only; cleared on start, disappear and new import.
    @State private var offer: LocalMacAgentPairingOffer?
    /// Host-issued setup (installation ID validated against the connected host). Memory only, like `offer`.
    @State private var setupBundle: LocalMacAgentSetupBundle?
    @State private var claims: [LocalMacAgentClaim] = []
    @State private var claimsChecked = false
    @State private var claimsPoll = 0
    @State private var approving: LocalMacAgentClaim?
    @State private var installationID = ""
    @State private var agentName = "Mac"
    @State private var browser: URL?
    @State private var enabled = Set(LocalMacAgentSetupPlan.browserCapabilities)
    @State private var confirmIdentity = false
    @State private var identityFingerprint: String?
    @State private var needsPairing = false
    @State private var offerID = ""
    @State private var pairingCode = ""
    @State private var busy = false
    @State private var notice: String?

    private var hasChild: Bool { agent.ownsLiveChild }
    private var status: LocalizedStringKey {
        switch agent.state {
        case .stopped: "Parado"
        case .running: "Processo iniciado"
        case .stopping: "Aguardando parada"
        case .exited(let code): code == 0 ? "Parado" : "O agente encerrou com falha"
        }
    }
    private var orderedCapabilities: [String] { LocalMacAgentSetupPlan.browserCapabilities.filter(enabled.contains) }
    private var canStart: Bool {
        guard let selection, !busy, !hasChild else { return false }
        if needsPairing { return !offerID.isEmpty && !pairingCode.isEmpty }
        return offer != nil || selection.hasSavedPairing
    }

    var body: some View {
        Section("Capacidades deste Mac") {
            LabeledContent("Estado") { Text(status) }
                .accessibilityIdentifier("settings.mac-agent.status")
            Text("Requer um host com canal de capacidades cifrado (HTTPS com pin). O host local de conversa em HTTP não oferece esse canal.")
                .font(.footnote).foregroundStyle(.secondary)
            if prepared { preparedSteps } else if conflict {
                Text("Há arquivos no diretório privado do agente que não formam uma configuração válida. Nada foi alterado; revise em Detalhes avançados.")
                    .font(.footnote).foregroundStyle(.orange)
            } else { guidedSetup }
            if let selection {
                LabeledContent("Host", value: selection.hostURL)
                LabeledContent("Configuração", value: selection.configurationURL.lastPathComponent)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Capacidades solicitadas").font(.callout.weight(.medium))
                    ForEach(selection.capabilities, id: \.self) { capability in
                        Text(capabilityLabel(capability)).font(.callout)
                    }
                }
            }
            HStack {
                Button("Iniciar agente", action: start)
                    .disabled(!canStart)
                    .accessibilityIdentifier("settings.mac-agent.start")
                Button("Parar agente") {
                    busy = true; notice = nil
                    Task { @MainActor in
                        do { try await agent.stop() }
                        catch { notice = String(localized: "A parada ainda não foi confirmada. Aguarde e tente Parar novamente.") }
                        busy = false
                    }
                }
                .disabled(busy || !hasChild)
                .accessibilityIdentifier("settings.mac-agent.stop")
                if busy { ProgressView().controlSize(.small) }
            }
            if let selection, !hasChild, !needsPairing, offer == nil, !selection.hasSavedPairing {
                Text("Cole uma oferta válida para concluir o primeiro pareamento antes de iniciar.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let notice { Text(verbatim: notice).font(.footnote).foregroundStyle(.orange) }
            if let shutdownNotice = agent.shutdownNotice {
                Text(LocalizedStringKey(shutdownNotice)).font(.footnote).foregroundStyle(.orange)
            }
            if client != nil { claimsReview }
            if let client, let selection {
                if prepared, selection.configurationURL == location?.configuration {
                    capabilityPolicies(client: client, selection: selection)
                } else {
                    Text("Sites permitidos só podem ser editados na configuração preparada por este app.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Text("Iniciar não concede permissões a bots. A presença e o pareamento são confirmados pelo host.")
                .font(.footnote).foregroundStyle(.secondary)
            DisclosureGroup("Detalhes avançados") {
                Text("Importar uma configuração nativa de produção já preparada, com identidade e política local por bot. O app não altera grants.")
                Button("Selecionar configuração…", action: chooseConfiguration)
                    .disabled(busy || hasChild)
                    .accessibilityIdentifier("settings.mac-agent.select")
                Toggle("Novo pareamento", isOn: $needsPairing)
                    .disabled(busy || hasChild || selection == nil)
                    .onChange(of: needsPairing) { _, enabled in if !enabled { clearManualPairing() } }
                if needsPairing {
                    TextField("ID da oferta", text: $offerID)
                        .autocorrectionDisabled().disabled(busy || hasChild)
                    SecureField("Código de pareamento", text: $pairingCode)
                        .autocorrectionDisabled().disabled(busy || hasChild)
                        .accessibilityIdentifier("settings.mac-agent.pairing-code")
                }
                Text("O controle de tela nativo permanece indisponível até a validação de tela desbloqueada. Permissões do macOS não são solicitadas ao abrir esta seção.")
                if let selection { Text(selection.capabilities.joined(separator: ", ")).textSelection(.enabled) }
            }.font(.footnote)
        }
        .task { reload() }
        .task {
            while !Task.isCancelled {
                agent.refresh()
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .task(id: claimsPoll) { await pollClaims() }
        .onChange(of: client?.baseURL) { _, _ in clearEnrollment() }
        .onDisappear { offer = nil; clearManualPairing(); clearEnrollment() }
        .confirmationDialog("Aprovar este Mac no host?", isPresented: Binding(get: { approving != nil },
                                                                               set: { if !$0 { approving = nil } }),
                            presenting: approving) { claim in
            Button("Aprovar pareamento") { approve(claim) }
        } message: { claim in
            Text("Confira se a impressão digital \(grouped(claim.clientFingerprint)) é a identidade deste Mac. Aprovar apenas pareia o dispositivo; nenhum bot recebe permissões.")
        }
        .confirmationDialog("Criar identidade deste Mac?", isPresented: $confirmIdentity) {
            Button("Criar identidade", action: createIdentity)
        } message: {
            Text("O auxiliar cria uma chave protegida no Keychain para esta instalação. Uma identidade existente nunca é substituída.")
        }
    }

    // MARK: - Steps

    @ViewBuilder private var guidedSetup: some View {
        if helper == nil {
            Text("Este pacote do app não inclui o auxiliar de identidade. Use Detalhes avançados para importar uma configuração já preparada.")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
            if client != nil {
                Text("1. Gere o pareamento a partir do host local conectado.").font(.callout)
                HStack {
                    Button("Preparar pareamento deste host", action: loadSetup)
                        .disabled(busy || hasChild)
                        .accessibilityIdentifier("settings.mac-agent.load-setup")
                    Button("Colar oferta do dispositivo", action: pasteOffer)
                        .disabled(busy || hasChild)
                        .accessibilityIdentifier("settings.mac-agent.paste-offer")
                }
                Text("Colar é só para um host operado em outro lugar; nesse caso informe o ID de instalação manualmente.")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("1. Cole a oferta de dispositivo gerada pelo dono no host.").font(.callout)
                Button("Colar oferta do dispositivo", action: pasteOffer)
                    .disabled(busy || hasChild)
                    .accessibilityIdentifier("settings.mac-agent.paste-offer")
            }
            if let offer {
                offerSummary(offer)
                Text("2. Confirme os dados deste Mac.").font(.callout)
                if let setupBundle {
                    LabeledContent("ID de instalação", value: setupBundle.installationID).textSelection(.enabled)
                        .accessibilityIdentifier("settings.mac-agent.installation-id")
                } else {
                    TextField("ID de instalação confiável", text: $installationID)
                        .autocorrectionDisabled().accessibilityIdentifier("settings.mac-agent.installation-id")
                }
                TextField("Nome do agente", text: $agentName).autocorrectionDisabled()
                LabeledContent("Chrome") {
                    Button(browser?.path ?? String(localized: "Escolher executável…"), action: chooseBrowser)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Capacidades oferecidas").font(.callout.weight(.medium))
                    ForEach(LocalMacAgentSetupPlan.browserCapabilities, id: \.self) { capability in
                        Toggle(isOn: Binding(get: { enabled.contains(capability) },
                                             set: { if $0 { enabled.insert(capability) } else { enabled.remove(capability) } })) {
                            Text(capabilityLabel(capability))
                        }
                    }
                    Text("Controle de tela fica desligado até a calibração.").font(.footnote).foregroundStyle(.secondary)
                }
                Text("3. Preparar grava apenas o certificado público do host, uma política que nega tudo e a configuração privada. Não inicia o agente nem concede permissões.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Preparar configuração", action: prepare)
                    .disabled(busy || hasChild || browser == nil || (setupBundle == nil && installationID.isEmpty) || enabled.isEmpty)
                    .accessibilityIdentifier("settings.mac-agent.prepare")
            }
        }
    }

    @ViewBuilder private func capabilityPolicies(client: HostClient, selection: LocalMacAgentSelection) -> some View {
        MacAgentBrowserSitesView(agent: agent, client: client, selection: selection)
            .id(client.baseURL.absoluteString + "|" + selection.configurationURL.path)
        MacSelectedFilesView(agent: agent, client: client, selection: selection,
                             onConfigurationChanged: adoptConfiguration)
        MacCuaConfigurationView(agent: agent, client: client, selection: selection,
                                onConfigurationChanged: adoptConfiguration)
    }

    @ViewBuilder private var preparedSteps: some View {
        Text("Configuração preparada neste Mac. Reabrir não redefine identidade nem pareamento.")
            .font(.footnote).foregroundStyle(.secondary)
        HStack {
            Button("Criar identidade…") { confirmIdentity = true }
                .disabled(busy || hasChild)
                .accessibilityIdentifier("settings.mac-agent.create-identity")
            if client != nil {
                Button("Preparar pareamento deste host", action: loadSetup)
                    .disabled(busy || hasChild)
                    .accessibilityIdentifier("settings.mac-agent.load-setup")
            }
            Button("Colar oferta do dispositivo", action: pasteOffer)
                .disabled(busy || hasChild)
                .accessibilityIdentifier("settings.mac-agent.paste-offer")
        }
        if let identityFingerprint { LabeledContent("Identidade", value: grouped(identityFingerprint)).textSelection(.enabled) }
        if let offer {
            offerSummary(offer)
            Text("Iniciar enviará esta oferta ao agente para um novo pareamento.").font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func offerSummary(_ offer: LocalMacAgentPairingOffer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Destino", value: offer.hostURL)
            LabeledContent("Pin do host", value: grouped(offer.hostFingerprint)).textSelection(.enabled)
            LabeledContent("Oferta expira") { Text(offer.expiresAt, style: .relative) }
        }.font(.callout)
    }

    /// Owner review of the claim sent by the agent. Nothing is approved automatically.
    @ViewBuilder private var claimsReview: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Pedidos de pareamento").font(.callout.weight(.medium))
                Spacer()
                Button("Verificar pedidos") { Task { await refreshClaims() } }
                    .disabled(busy)
                    .accessibilityIdentifier("settings.mac-agent.check-claims")
            }
            if claims.isEmpty {
                if claimsChecked {
                    Text("Nenhum pedido pendente. Depois de iniciar o agente com uma oferta, o pedido aparece aqui.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else {
                ForEach(claims) { claim in
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledContent("Nome", value: claim.name)
                        LabeledContent("Impressão digital", value: grouped(claim.clientFingerprint)).textSelection(.enabled)
                        if let identityFingerprint {
                            Text(LocalizedStringKey(identityFingerprint == claim.clientFingerprint
                                 ? "Corresponde à identidade criada neste Mac."
                                 : "Não corresponde à identidade criada neste Mac. Rejeite se não reconhecer."))
                                .font(.footnote)
                                .foregroundStyle(identityFingerprint == claim.clientFingerprint ? Color.secondary : Color.orange)
                        }
                        LabeledContent("Pedido expira") { Text(claim.expiry, style: .relative) }
                        ForEach(claim.capabilities, id: \.self) { Text(capabilityLabel($0)).font(.footnote) }
                        HStack {
                            Button("Aprovar…") { approving = claim }
                                .disabled(busy)
                                .accessibilityIdentifier("settings.mac-agent.approve-claim")
                            Button("Rejeitar", role: .destructive) { reject(claim) }
                                .disabled(busy)
                                .accessibilityIdentifier("settings.mac-agent.reject-claim")
                        }
                    }.font(.callout)
                }
            }
        }
    }

    // MARK: - Actions

    /// Explicit owner action: the selected loopback host issues a one-time offer for its own installation.
    private func loadSetup() {
        guard let client, !busy, !hasChild else { return }
        busy = true; notice = nil; offer = nil; setupBundle = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let expected = try await client.localMacAgentInstallationID()
                let bundle = try LocalMacAgentSetupBundle(json: try await client.localMacAgentSetupEnvelope(),
                                                          expectedInstallationID: expected)
                setupBundle = bundle; offer = bundle.offer; installationID = bundle.installationID
            } catch HostClientError.notReady {
                notice = String(localized: "O host local ainda não ativou o canal cifrado de dispositivos. Ative-o e tente novamente.")
            } catch LocalMacAgentSetupError.offerExpired {
                notice = String(localized: "A oferta expirou. Gere uma nova no host.")
            } catch is LocalMacAgentSetupError {
                notice = String(localized: "A oferta do host não corresponde ao host conectado. Nada foi preparado.")
            } catch {
                notice = String(localized: "Não foi possível obter o pareamento do host local. Confira se ele está em execução.")
            }
        }
    }

    /// Short read-only wait after an explicit start with a pairing offer; stops at the first claim.
    private func pollClaims() async {
        guard claimsPoll > 0 else { return }
        for _ in 0..<30 {
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            await refreshClaims()
            if !claims.isEmpty || !hasChild { return }
        }
    }

    private func refreshClaims() async {
        guard let client else { return }
        do { claims = try await client.localMacAgentClaims(); claimsChecked = true }
        catch is CancellationError { return }
        catch HostClientError.notReady {
            claims = []; notice = String(localized: "O host local ainda não ativou o canal cifrado de dispositivos.")
        } catch {
            claims = []; notice = String(localized: "Não foi possível consultar os pedidos de pareamento.")
        }
    }

    private func approve(_ claim: LocalMacAgentClaim) {
        guard let client, !busy else { return }
        busy = true; notice = nil; approving = nil
        Task { @MainActor in
            do {
                _ = try await client.approveLocalMacAgentClaim(claim)
                notice = String(localized: "Mac pareado. Nenhum bot recebeu permissões: conceda cada capacidade por bot em Dispositivos.")
            } catch HostClientError.mutationOutcomeUnknown {
                notice = String(localized: "O host pode ter aprovado o pedido. Verifique os pedidos e os dispositivos antes de repetir.")
            } catch {
                notice = String(localized: "O pedido não foi aprovado. Ele pode ter expirado; verifique novamente.")
            }
            busy = false
            await refreshClaims()
        }
    }

    private func reject(_ claim: LocalMacAgentClaim) {
        guard let client, !busy else { return }
        busy = true; notice = nil
        Task { @MainActor in
            do { try await client.rejectLocalMacAgentClaim(claim) }
            catch { notice = String(localized: "O pedido não foi rejeitado. Verifique os pedidos novamente.") }
            busy = false
            await refreshClaims()
        }
    }

    private func reload() {
        helper = try? LocalMacAgentHelperPackage.packaged()
        guard let standard = try? LocalMacAgentSetupLocation.standard() else { return }
        location = standard
        switch LocalMacAgentSetup.inspect(standard) {
        case .notPrepared: prepared = false; conflict = false
        case .prepared(let value): prepared = true; conflict = false; selection = value
        case .conflict: prepared = false; conflict = true
        }
    }

    private func pasteOffer() {
        notice = nil; offer = nil; setupBundle = nil
        guard let text = NSPasteboard.general.string(forType: .string) else {
            notice = String(localized: "A área de transferência não contém uma oferta."); return
        }
        do { offer = try LocalMacAgentPairingOffer(json: text) }
        catch LocalMacAgentSetupError.offerExpired { notice = String(localized: "A oferta expirou. Gere uma nova no host.") }
        catch { notice = String(localized: "Oferta recusada. Cole o pacote de pareamento de dispositivo completo gerado pelo host.") }
    }

    private func chooseBrowser() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.application, .unixExecutable]; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false; panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let executable = url.pathExtension == "app" ? Bundle(url: url)?.executableURL : url
        browser = executable?.resolvingSymlinksInPath()
    }

    private func prepare() {
        guard let offer, let browser, let location, let helper, !busy else { return }
        notice = nil
        do {
            let plan = try setupBundle.map { try $0.plan(name: agentName, browserExecutable: browser, capabilities: orderedCapabilities) }
                ?? LocalMacAgentSetupPlan(offer: offer, installationID: installationID, name: agentName,
                                          browserExecutable: browser, capabilities: orderedCapabilities)
            selection = try LocalMacAgentSetup.prepare(plan, helper: helper, location: location)
            prepared = true
        } catch LocalMacAgentSetupError.invalidInput {
            notice = String(localized: "Dados recusados. Confira o ID de instalação, o nome (até 48 caracteres) e o executável do Chrome.")
        } catch LocalMacAgentSetupError.offerExpired {
            notice = String(localized: "A oferta expirou. Gere uma nova no host.")
        } catch LocalMacAgentSetupError.alreadyPrepared {
            reload()
        } catch {
            notice = String(localized: "A configuração não foi preparada. Nenhum arquivo existente foi alterado.")
        }
    }

    private func createIdentity() {
        guard let location, !busy else { return }
        busy = true; notice = nil
        Task { @MainActor in
            do { identityFingerprint = try await LocalMacAgentSetup.provisionIdentity(location) }
            catch LocalMacAgentSetupError.identityExists { notice = String(localized: "Existe estado de identidade para esta instalação ou um item parcial. Ele não será substituído; confira o estado no escopo original antes de outra operação.") }
            catch LocalMacAgentSetupError.signingIdentityUnavailable { notice = String(localized: "O auxiliar precisa de identidade de assinatura autorizada para o Keychain. Use o pacote assinado apropriado; não repita a criação para contornar esse requisito.") }
            catch LocalMacAgentSetupError.identityPolicyUnavailable { notice = String(localized: "O Keychain não confirmou a política de exportação exigida. Um item parcial pode ter sido criado; não remova nem recrie a identidade para contornar essa recusa.") }
            catch { notice = String(localized: "O resultado da criação não pôde ser confirmado. Confira o estado da identidade antes de outra operação; não repita a criação por inferência.") }
            busy = false
        }
    }

    private func chooseConfiguration() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        clearManualPairing(); offer = nil; setupBundle = nil; notice = nil
        do { selection = try LocalMacAgentSelection(configurationURL: url) }
        catch {
            selection = nil
            notice = String(localized: "Configuração recusada. Selecione o JSON privado de um agente nativo de produção já preparado.")
        }
    }

    private func start() {
        guard let selection, !busy else { return }
        notice = nil
        var pairing: LocalMacAgentPairing?
        if needsPairing { pairing = LocalMacAgentPairing(offerID: offerID, code: pairingCode) }
        else if let offer, let location {
            do { pairing = try LocalMacAgentSetup.pairing(for: offer, location: location, selection: selection) }
            catch {
                self.offer = nil
                notice = String(localized: "A oferta não corresponde ao destino preparado ou expirou. Nada foi iniciado.")
                return
            }
        } else if !selection.hasSavedPairing {
            notice = String(localized: "Cole uma oferta válida para concluir o primeiro pareamento antes de iniciar.")
            return
        }
        clearManualPairing(); offer = nil; setupBundle = nil
        do {
            let launch = try LocalMacAgentLaunchConfiguration.packaged()
            try agent.start(launch, selection: selection, pairing: pairing)
            if pairing != nil, client != nil { claimsPoll += 1 }
        } catch {
            notice = String(localized: "O agente não pôde iniciar. Confira a configuração preparada e o estado do processo.")
        }
    }

    private func clearManualPairing() { offerID = ""; pairingCode = "" }
    private func adoptConfiguration(_ updated: LocalMacAgentSelection) {
        // Configuration writes are explicit and synchronous while the owned agent is stopped.
        // Discard transient offers from the former configuration; never start or pair here.
        selection = updated
        prepared = true
        conflict = false
        clearManualPairing()
        needsPairing = false
        offer = nil
        setupBundle = nil
    }
    private func clearEnrollment() {
        if setupBundle != nil { offer = nil }
        setupBundle = nil; claims = []; claimsChecked = false; approving = nil
    }
    private func grouped(_ hex: String) -> String {
        stride(from: 0, to: hex.count, by: 4).map { start in
            let begin = hex.index(hex.startIndex, offsetBy: start)
            return String(hex[begin..<(hex.index(begin, offsetBy: 4, limitedBy: hex.endIndex) ?? hex.endIndex)])
        }.joined(separator: " ")
    }
    private func capabilityLabel(_ value: String) -> LocalizedStringKey {
        switch value {
        case "mac.browser.navigate": "Navegar no browser"
        case "mac.browser.read": "Ler página do browser"
        case "mac.browser.close": "Fechar browser"
        case "mac.cua.status": "Consultar estado do controle de tela"
        case "mac.cua.observe": "Observar tela"
        case "mac.cua.control": "Controlar tela"
        case "mac.file.read": "Ler arquivo permitido"
        case "mac.file.append": "Acrescentar ao arquivo permitido"
        default: "Capacidade desconhecida"
        }
    }
}
/// Local browser allow-list for one host bot, kept in the private policy of the guided setup.
/// Separate from host grants: nothing here grants a tool, and host grants never write this file.
/// Reads and writes are explicit actions; writes require the owned agent confirmed stopped and never restart it.
private struct MacAgentBrowserSitesView: View {
    let agent: LocalMacAgentProcess
    let client: HostClient
    let selection: LocalMacAgentSelection
    @State private var generation = 0
    @State private var snapshot: LocalMacAgentPolicySnapshot?
    @State private var loadedInstallationID: String?
    @State private var bots: [Bot] = []
    @State private var botID: String?
    @State private var operations = Set<String>()
    @State private var origins: [String] = []
    @State private var draft = ""
    @State private var draftError = false
    @State private var confirmSave = false
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
    private var bot: Bot? { bots.first { $0.id == botID } }
    private var current: LocalMacAgentBrowserAuthorization? { snapshot?.authorizations.first { $0.botID == botID } }
    private var orderedOperations: [String] { LocalMacAgentSetupPlan.browserCapabilities.filter(operations.contains) }
    private var changed: Bool {
        current?.operations != orderedOperations.sorted() || current?.browserOrigins != origins.sorted()
    }

    var body: some View {
        DisclosureGroup("Sites permitidos no browser") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Escolha em quais sites cada bot pode usar o browser deste Mac. O host ainda pede aprovação de cada ferramenta conforme as permissões em Dispositivos.")
                    .font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Button(LocalizedStringKey(snapshot == nil ? "Carregar sites permitidos" : "Recarregar"), action: load)
                        .disabled(busy)
                        .accessibilityIdentifier("settings.mac-agent.sites.load")
                    if busy { ProgressView().controlSize(.small) }
                }
                if snapshot != nil {
                    if bots.isEmpty {
                        Text("Nenhum bot neste host.").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Picker("Bot", selection: $botID) {
                            Text("Escolha um bot").tag(String?.none)
                            ForEach(bots) { Text($0.name).tag(Optional($0.id)) }
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("settings.mac-agent.sites.bot")
                        .onChange(of: botID) { _, _ in fillEditor() }
                    }
                    if botID != nil { editor }
                }
                if let saved { Text(verbatim: saved).font(.footnote).foregroundStyle(.secondary) }
                if let notice { Text(verbatim: notice).font(.footnote).foregroundStyle(.orange) }
            }
            .padding(.top, 4)
        }
        .onChange(of: selection) { _, _ in reset() }
        .onDisappear { reset() }
        .confirmationDialog("Salvar sites permitidos?", isPresented: $confirmSave) {
            Button("Salvar", action: save)
        } message: {
            Text("O bot poderá usar o browser em: \(origins.joined(separator: ", ")). O host continua pedindo aprovação de cada ferramenta.")
        }
        .confirmationDialog("Remover sites deste bot?", isPresented: $confirmRemove) {
            Button("Remover", role: .destructive, action: remove)
        } message: {
            Text("O bot deixa de usar o browser deste Mac. As permissões do host não mudam.")
        }
    }

    @ViewBuilder private var editor: some View {
        Text(LocalizedStringKey(current == nil ? "Este bot ainda não pode usar o browser deste Mac." : "Este bot já tem sites permitidos neste Mac."))
            .font(.footnote).foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 4) {
            Text("Ações permitidas").font(.callout.weight(.medium))
            ForEach(LocalMacAgentSetupPlan.browserCapabilities, id: \.self) { operation in
                Toggle(isOn: Binding(get: { operations.contains(operation) },
                                     set: { if $0 { operations.insert(operation) } else { operations.remove(operation) } })) {
                    Text(operationLabel(operation))
                }
                .disabled(busy)
            }
        }
        VStack(alignment: .leading, spacing: 4) {
            Text("Sites").font(.callout.weight(.medium))
            if origins.isEmpty { Text("Nenhum site.").font(.footnote).foregroundStyle(.secondary) }
            ForEach(origins, id: \.self) { origin in
                HStack {
                    Text(verbatim: origin).textSelection(.enabled)
                    Spacer()
                    Button("Remover site") { origins.removeAll { $0 == origin } }
                        .buttonStyle(.borderless).disabled(busy)
                }.font(.callout)
            }
            HStack {
                TextField("https://exemplo.com", text: $draft)
                    .autocorrectionDisabled().onSubmit(addOrigin)
                    .onChange(of: draft) { _, _ in draftError = false }
                    .accessibilityIdentifier("settings.mac-agent.sites.origin")
                Button("Adicionar", action: addOrigin)
                    .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty || origins.count >= 32)
            }
            Text(LocalizedStringKey(draftError
                 ? "Site recusado. Use só protocolo e domínio, como https://exemplo.com ou http://localhost:8080, sem caminho, curinga, parâmetros ou usuário."
                 : "Informe só protocolo e domínio, com porta opcional. Caminhos e curingas não são aceitos."))
                .font(.footnote).foregroundStyle(draftError ? Color.orange : Color.secondary)
        }
        if !stopped {
            Text("Pare o agente para salvar. Depois de salvar, inicie-o novamente para aplicar.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        HStack {
            Button("Salvar…") { confirmSave = true }
                .disabled(busy || !stopped || !changed || operations.isEmpty || origins.isEmpty)
                .accessibilityIdentifier("settings.mac-agent.sites.save")
            if current != nil {
                Button("Remover acesso do bot…", role: .destructive) { confirmRemove = true }
                    .disabled(busy || !stopped)
                    .accessibilityIdentifier("settings.mac-agent.sites.remove")
            }
        }
    }

    // MARK: - Actions

    private func reset() {
        generation += 1; snapshot = nil; loadedInstallationID = nil; bots = []; botID = nil; busy = false; notice = nil; saved = nil
        confirmSave = false; confirmRemove = false
        fillEditor()
    }

    private func fillEditor() {
        operations = Set(current?.operations ?? []); origins = current?.browserOrigins ?? []
        draft = ""; draftError = false; saved = nil
    }

    /// Explicit read: host identity and bots from the connected host, then the local policy bound to that installation.
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
                    try LocalMacAgentPolicy.read(selection: selection, expectedInstallationID: installationID)
                }.value
                guard token == generation else { return }
                snapshot = read; loadedInstallationID = installationID; bots = hostBots
                if let botID, !hostBots.contains(where: { $0.id == botID }) { self.botID = nil }
                fillEditor()
            } catch {
                guard token == generation else { return }
                snapshot = nil; loadedInstallationID = nil; bots = []; botID = nil; fillEditor()
                notice = message(for: error)
            }
            if token == generation { busy = false }
        }
    }

    private func addOrigin() {
        let value = draft.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, origins.count < 32 else { return }
        // Same validation and normalization as the saved policy.
        guard let origin = (try? LocalMacAgentBrowserAuthorization(botID: "probe", label: "probe", operations: [],
                                                                   browserOrigins: [value]))?.browserOrigins.first else {
            draftError = true; return
        }
        if !origins.contains(origin) { origins.append(origin) }
        draft = ""
    }

    private func save() {
        guard let bot, let snapshot else { return }
        let authorization: LocalMacAgentBrowserAuthorization
        do {
            authorization = try LocalMacAgentBrowserAuthorization(botID: bot.id, label: label(bot.name),
                                                                  operations: orderedOperations, browserOrigins: origins)
        } catch {
            notice = String(localized: "Os dados não formam uma autorização válida. Revise as ações e os sites."); return
        }
        mutate(snapshot, botID: bot.id) { try LocalMacAgentPolicy.replaceBot(authorization, expectedSnapshot: $0, agentStopped: $1) }
    }

    private func remove() {
        guard let botID, let snapshot else { return }
        mutate(snapshot, botID: botID) { try LocalMacAgentPolicy.removeBot(botID: botID, expectedSnapshot: $0, agentStopped: $1) }
    }

    /// Rechecks the owned process at the moment of the action; never stops or starts it.
    private func mutate(_ expected: LocalMacAgentPolicySnapshot, botID: String,
                        _ write: @escaping @Sendable (LocalMacAgentPolicySnapshot, Bool) throws -> LocalMacAgentPolicySnapshot) {
        guard !busy, let expectedInstallationID = loadedInstallationID else { return }
        agent.refresh()
        guard stopped else { notice = String(localized: "Pare o agente e aguarde a parada antes de salvar."); return }
        let token = generation
        busy = true; notice = nil; saved = nil
        Task { @MainActor in
            do {
                let installationID = try await client.localMacAgentInstallationID()
                let hostBots = try await client.listBots()
                guard token == generation else { return }
                guard installationID == expectedInstallationID, hostBots.contains(where: { $0.id == botID }) else {
                    throw LocalMacAgentPolicyError.hostMismatch
                }
                agent.refresh()
                guard stopped else { throw LocalMacAgentPolicyError.agentMustBeStopped }
                // No suspension between the final process check and replacement: Start uses this same actor.
                let result = try write(expected, true)
                snapshot = result; fillEditor()
                saved = String(localized: "Salvo. Inicie o agente para aplicar os sites permitidos.")
            } catch {
                guard token == generation else { return }
                snapshot = nil; loadedInstallationID = nil
                notice = String(localized: "Não foi possível confirmar a alteração. Recarregue os sites e confira o estado antes de salvar novamente.")
            }
            if token == generation { busy = false }
        }
    }

    private func message(for error: Error) -> String {
        switch error {
        case LocalMacAgentPolicyError.agentMustBeStopped:
            String(localized: "Pare o agente e aguarde a parada antes de salvar.")
        case LocalMacAgentPolicyError.conflict:
            String(localized: "A configuração mudou desde a leitura. Nada foi salvo; recarregue e revise.")
        case LocalMacAgentPolicyError.hostMismatch:
            String(localized: "A configuração local pertence a outro host ou foi alterada. Nada foi salvo.")
        case LocalMacAgentPolicyError.unsafeLocation, LocalMacAgentPolicyError.invalidPolicy:
            String(localized: "A política local não está no formato preparado por este app. Nada foi alterado.")
        case LocalMacAgentPolicyError.writeFailed:
            String(localized: "Não foi possível confirmar a alteração. Recarregue os sites e confira o estado antes de salvar novamente.")
        case HostClientError.notReady:
            String(localized: "O host local ainda não ativou o canal cifrado de dispositivos.")
        default:
            String(localized: "Não foi possível consultar o host local. Confira se ele está em execução.")
        }
    }

    /// Policy labels accept letters, digits, space and `._-` up to 48 characters.
    private func label(_ name: String) -> String {
        let kept: Set<Unicode.GeneralCategory> = [.uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter,
                                                  .otherLetter, .decimalNumber, .letterNumber, .otherNumber]
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: name.unicodeScalars.filter { kept.contains($0.properties.generalCategory) || " ._-".unicodeScalars.contains($0) })
        let allowed = String(scalars).trimmingCharacters(in: .whitespaces)
        return allowed.isEmpty ? "Bot" : String(allowed.prefix(48))
    }

    private func operationLabel(_ value: String) -> LocalizedStringKey {
        switch value {
        case "mac.browser.navigate": "Navegar no browser"
        case "mac.browser.read": "Ler página do browser"
        case "mac.browser.close": "Fechar browser"
        default: "Capacidade desconhecida"
        }
    }
}
#endif
