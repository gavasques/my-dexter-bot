#if os(macOS)
import AppKit
import DexterAppCore
import DexterClientIdentity
import DexterHostClient
import SwiftUI

/// Opens one `OwnerPairingOfferSession` for the window's base and drops it (with any invitation text) when the base
/// changes or the sheet closes.
@MainActor @Observable final class OwnerPairingOfferHolder {
    private(set) var session: OwnerPairingOfferSession?
    private(set) var attemptedScope: String?

    func open(_ model: DexterAppModel) async {
        let scope = model.pairingOfferScope
        if session?.scope == scope { return }
        session?.close()
        session = model.makeOwnerPairingOfferSession()
        attemptedScope = scope
        await session?.editor.reload()
        if let editor = session?.editor, let ttl = editor.status?.ttl, editor.ttlSeconds == nil {
            editor.ttlSeconds = max(ttl.minSeconds, min(300, ttl.defaultSeconds))
        }
    }

    func close() { session?.close(); session = nil; attemptedScope = nil }
}

/// Ajustes › Este Mac › Conectar aparelhos: the entry to invite an iPhone or another Mac to THIS Mac's base.
struct OwnerPairingOfferSettingsSection: View {
    @Environment(DexterAppModel.self) private var model
    @State private var presenting = false
    var localHost: LocalHostLaunchCoordinator? = nil

    var body: some View {
        Section {
            if model.isFixture {
                Text("A demonstração não convida aparelhos.")
                    .font(.callout).foregroundStyle(.secondary)
            } else if model.canEditBotProfiles {
                Button("Convidar outro aparelho…") { presenting = true }
                    .accessibilityIdentifier("settings.pairing-offer.open")
                Text("Cria um convite para um iPhone ou outro Mac usar a base deste Mac. Convidar não dá permissão a nenhum bot.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                OwnerPairingClaimsEntry()
            } else if model.canUseHost {
                Text("Convites só podem ser criados na base deste Mac. Este app está ligado a outra base.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("settings.pairing-offer.other-base")
            } else {
                Text("Sem base deste Mac conectada.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        } header: {
            Text("Conectar aparelhos").accessibilityIdentifier("settings.pairing-offer")
        }
        .sheet(isPresented: $presenting) { OwnerPairingOfferSheet(localHost: localHost) }
    }
}

/// "Convidar outro aparelho": real channel status, the owner's explicit draft (device kind, the eight historical scopes,
/// output scopes off unless turned on, lifetime), one creation through the controller, and the invitation for the owner to
/// scan as a private QR or copy. The invitation lives only in memory; closing the sheet forgets it.
struct OwnerPairingOfferSheet: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var holder = OwnerPairingOfferHolder()
    @State private var confirmRetry = false
    @State private var confirmCancel = false
    @State private var copied = false
    /// The request made with this invitation, reviewed in the app (Pedidos de aparelhos).
    @State private var reviewingRequest = false
    @State private var preparingChannel = false
    @State private var channelNotice: String?
    @State private var advancedInvitation = false
    @State private var confirmRenewal = false
    var localHost: LocalHostLaunchCoordinator? = nil

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Convidar outro aparelho").font(.title2.weight(.semibold))
                Text("No iPhone, toque em Escanear QR do Mac. Depois, confirme o pedido aqui. Convidar não dá permissão a nenhum bot.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let session = holder.session, session.scope == model.pairingOfferScope {
                        content(session.editor)
                    } else if holder.attemptedScope == model.pairingOfferScope {
                        Label("Convites só podem ser criados na base deste Mac.", systemImage: "lock")
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    channelRecoveryControls
                    if let notice = channelNotice ?? localHost?.appClientChannelNotice {
                        Text(verbatim: notice).font(.callout).foregroundStyle(.orange)
                            .accessibilityIdentifier("owner-pairing-offer.channel-notice")
                    }
                }
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Spacer()
                Button("Concluir") { dismiss() }.keyboardShortcut(.cancelAction)
                    .disabled(preparingChannel)
                    .accessibilityIdentifier("owner-pairing-offer.close")
            }
            .padding(14)
        }
        // Fits inside the Settings window (588 pt); the content scrolls.
        .frame(width: 580).frame(minHeight: 420, idealHeight: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-offer.sheet")
        .task(id: model.pairingOfferScope) { await holder.open(model) }
        .onDisappear { holder.close() }
        .interactiveDismissDisabled(preparingChannel)
        .confirmationDialog("Recriar a conexão segura?", isPresented: $confirmRenewal, titleVisibility: .visible) {
            Button("Recriar conexão segura", role: .destructive) {
                if let localHost { prepareChannel(localHost, renewing: true) }
            }.accessibilityIdentifier("owner-pairing-offer.renew.confirm")
            Button("Cancelar", role: .cancel) {}.accessibilityIdentifier("owner-pairing-offer.renew.cancel")
        } message: {
            Text("Os aparelhos pareados perderão a conexão com este Mac. Será criada uma nova identidade segura no endereço atual; crie outro QR e compare o código para aprovar cada aparelho novamente. As identidades anteriores serão preservadas.")
        }
    }

    @ViewBuilder private func content(_ editor: OwnerPairingOfferEditor) -> some View {
        statusBlock(editor)
        // The outcome of the last decision comes first, so it is seen without scrolling; the draft stays below.
        resultBlock(editor)
        draftBlock(editor)
    }

    // MARK: Status

    @ViewBuilder private func statusBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        Group {
            if let status = editor.status {
                if status.availability == .available {
                    Label("Esta base está pronta para convidar outro aparelho.", systemImage: "checkmark.circle")
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(t(OwnerPairingOfferPresentation.reasonKey(status.reason)), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        if status.reason == .channelUnconfigured {
                            Text("Prepare a conexão segura deste Mac para convidar seu iPhone. O Dexter usa o endereço da rede Tailscale; os aparelhos precisam alcançar essa rede.")
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            if let localHost {
                                Button("Preparar conexão segura") { prepareChannel(localHost) }
                                    .buttonStyle(.borderedProminent).disabled(preparingChannel || editor.busy)
                                    .accessibilityIdentifier("owner-pairing-offer.prepare-channel")
                                if preparingChannel { ProgressView().controlSize(.small) }
                            } else {
                                Text("A preparação precisa da base iniciada por este app no Mac.")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                        }
                        Button("Atualizar") { Task { await editor.reload() } }
                            .disabled(editor.busy)
                            .accessibilityIdentifier("owner-pairing-offer.reload")
                    }
                }
            } else if let notice = editor.notice {
                VStack(alignment: .leading, spacing: 8) {
                    Label(t(OwnerPairingOfferPresentation.noticeKey(notice)), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Button("Tentar de novo") { Task { await editor.reload() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("owner-pairing-offer.reload")
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-offer.status")
    }

    // MARK: Draft

    private func draftBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        let editable = editor.status?.availability == .available && !editor.busy && editor.pendingCreate == nil && editor.pendingCancel == nil
        return VStack(alignment: .leading, spacing: 14) {
            Text("Confira o acesso do iPhone antes de criar o QR:").font(.headline)
            Text(editor.draftScopes.map { t(PairingScopeCatalog.labelKey($0)) }.joined(separator: " · "))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("owner-pairing-offer.iphone-summary")
            if let seconds = editor.effectiveTTLSeconds {
                Text(verbatim: lifetimeLabel(seconds, isDefault: seconds == editor.status?.ttl?.defaultSeconds))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Button(editor.record == nil ? "Conectar iPhone" : "Criar outro QR para iPhone") {
                editor.role = .clientIOS; copied = false
                Task { await editor.create() }
            }
            .buttonStyle(.borderedProminent).disabled(!editable || editor.effectiveTTLSeconds == nil)
            .accessibilityIdentifier("owner-pairing-offer.create-iphone-qr")
            DisclosureGroup("Outro aparelho e permissões", isExpanded: $advancedInvitation) {
            VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Tipo do aparelho").font(.headline)
                Picker("Tipo do aparelho", selection: Binding(get: { editor.role }, set: { editor.role = $0 })) {
                    Text(verbatim: t(OwnerPairingOfferPresentation.roleKey(.clientIOS))).tag(ClientRole?.some(.clientIOS))
                    Text(verbatim: t(OwnerPairingOfferPresentation.roleKey(.clientMac))).tag(ClientRole?.some(.clientMac))
                }
                .pickerStyle(.segmented).labelsHidden().frame(maxWidth: 260)
                .accessibilityIdentifier("owner-pairing-offer.device-kind")
                Text("O convite só funciona no tipo escolhido. Não há escolha padrão.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            scopesBlock(editor)
            lifetimeBlock(editor)
            HStack {
                Button(editor.record == nil ? "Criar convite" : "Criar outro convite") { copied = false; Task { await editor.create() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!editor.canCreate)
                    .accessibilityIdentifier("owner-pairing-offer.create")
                if editor.busy { ProgressView().controlSize(.small) }
            }
            }.padding(.top, 12)
            }.accessibilityIdentifier("owner-pairing-offer.advanced")
        }
        .disabled(!editable)
        .padding(14)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func scopesBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("O que o aparelho poderá fazer").font(.headline)
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 4) {
                ForEach(PairingScopeCatalog.displayOrder.filter { PairingScopeCatalog.historical.contains($0) }, id: \.self) { scope in
                    Label(t(PairingScopeCatalog.labelKey(scope)), systemImage: "checkmark")
                        .font(.callout)
                        .accessibilityIdentifier("owner-pairing-offer.scope.\(scope)")
                }
            }
            Divider().padding(.vertical, 2)
            ForEach(PairingScopeCatalog.outputs, id: \.self) { scope in
                Toggle(t(PairingScopeCatalog.labelKey(scope)), isOn: Binding(
                    get: { editor.selection.scopes.contains(scope) },
                    set: { editor.selection.set(scope, on: $0) }))
                    .accessibilityIdentifier("owner-pairing-offer.scope.\(scope)")
            }
            HStack {
                Text("Arquivos ficam desligados até você ligar.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Ligar os dois de arquivos") { editor.selection.selectAllOutputs() }
                    .controlSize(.small)
                    .accessibilityIdentifier("owner-pairing-offer.scope.select-all")
            }
            if editor.selection.managesWithoutReading {
                Text("Alterar a pasta de arquivos não inclui ver os arquivos; são permissões separadas.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Divider().padding(.vertical, 2)
            ForEach(PairingScopeCatalog.connections, id: \.self) { scope in
                Toggle(t(PairingScopeCatalog.labelKey(scope)), isOn: Binding(
                    get: { editor.selection.scopes.contains(scope) },
                    set: { editor.selection.set(scope, on: $0) }))
                    .accessibilityIdentifier("owner-pairing-offer.scope.\(scope)")
            }
            Text(t("pairing.scope.connectionsHint")).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if editor.selection.connectionsManageWithoutReading {
                Text(t("pairing.scope.connectionsManageWithoutRead")).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-offer.scopes")
    }

    @ViewBuilder private func lifetimeBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Validade do convite").font(.headline)
            if let ttl = editor.status?.ttl {
                Picker("Validade do convite", selection: Binding(get: { editor.ttlSeconds ?? ttl.defaultSeconds }, set: { editor.ttlSeconds = $0 })) {
                    ForEach(OwnerPairingOfferPresentation.lifetimeOptions(ttl), id: \.self) { seconds in
                        Text(verbatim: lifetimeLabel(seconds, isDefault: seconds == ttl.defaultSeconds)).tag(seconds)
                    }
                }
                .labelsHidden().fixedSize()
                .accessibilityIdentifier("owner-pairing-offer.lifetime")
            } else {
                Text("Definida pela base quando ela estiver pronta.").font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("owner-pairing-offer.lifetime")
            }
        }
    }

    private func lifetimeLabel(_ seconds: Int, isDefault: Bool) -> String {
        let minutes = seconds / 60
        let base = minutes >= 60 && minutes % 60 == 0 ? DexterLocalization.format("%@ h", String(minutes / 60), locale: locale)
            : DexterLocalization.format("%@ min", String(minutes), locale: locale)
        return isDefault ? DexterLocalization.format("%@ (padrão da base)", base, locale: locale) : base
    }

    // MARK: Result

    @ViewBuilder private func resultBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        if editor.pendingCreate != nil {
            uncertainCreate(editor)
        } else if editor.pendingCancel != nil {
            uncertainCancel(editor)
        } else if let notice = editor.notice, editor.status != nil, notice != .created {
            Text(verbatim: t(OwnerPairingOfferPresentation.noticeKey(notice)))
                .font(.callout).foregroundStyle(notice == .cancelled ? Color.secondary : Color.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("owner-pairing-offer.notice")
        }
        if editor.invitationText != nil { invitationBlock(editor) }
        if let record = editor.record { recordBlock(editor, record: record) }
    }

    private func uncertainCreate(_ editor: OwnerPairingOfferEditor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(t(OwnerPairingOfferPresentation.noticeKey(.outcomeUnknown)), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Conferir") { Task { await editor.settlePending() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.confirm")
                Button("Repetir o mesmo pedido…") { confirmRetry = true }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.retry-exact")
                Button("Desistir deste pedido") { editor.abandonPendingCreate() }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.abandon")
            }
            Text("Conferir só lê a base. Se o convite foi criado e você desistir, o texto nunca foi mostrado e o convite expira sozinho.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .confirmationDialog(Text("Repetir exatamente o mesmo pedido?"), isPresented: $confirmRetry, titleVisibility: .visible) {
            Button("Repetir o mesmo pedido") { Task { await editor.retryPendingCreate() } }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("É o mesmo pedido, com o mesmo identificador. Se a base já criou o convite, ela devolve esse mesmo resultado; nenhum convite novo é criado.")
        }
    }

    private func uncertainCancel(_ editor: OwnerPairingOfferEditor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(t(OwnerPairingOfferPresentation.noticeKey(.cancelUnknown)), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            HStack(spacing: 10) {
                Button("Conferir") { Task { await editor.settlePending() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.confirm")
                Button("Repetir o cancelamento") { Task { await editor.retryPendingCancel() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.retry-cancel")
            }
        }
    }

    private func invitationBlock(_ editor: OwnerPairingOfferEditor) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Convite pronto", systemImage: "envelope.badge")
                .font(.headline)
            if let offer = editor.record?.receipt.offer {
                Text(verbatim: expiryLine(offer)).font(.callout).foregroundStyle(.secondary)
            }
            if let text = editor.invitationText { PairingInvitationQRCode(invitation: text).frame(maxWidth: .infinity) }
            Text("Escaneie no Dexter do iPhone. Este QR é privado, vale uma vez e some ao fechar a janela. Compare o código nos dois aparelhos antes de aprovar.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Copiar convite") { copy(editor) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("owner-pairing-offer.invitation.copy")
                Button("Esconder convite") { copied = false; editor.forgetInvitation() }
                    .accessibilityIdentifier("owner-pairing-offer.invitation.forget")
                if copied {
                    Label("Copiado", systemImage: "checkmark").font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("owner-pairing-offer.invitation.copied")
                }
            }
        }
        .padding(14)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-offer.invitation")
    }

    private func recordBlock(_ editor: OwnerPairingOfferEditor, record: OwnerPairingRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(verbatim: t(OwnerPairingOfferPresentation.offerStateKey(record.live.offerState)))
                    .font(.callout)
                    .accessibilityIdentifier("owner-pairing-offer.record.state")
                Spacer()
                Button("Atualizar estado") { Task { await editor.refreshRecord() } }
                    .disabled(editor.busy)
                    .accessibilityIdentifier("owner-pairing-offer.record.refresh")
                if editor.canCancel {
                    Button("Cancelar convite…", role: .destructive) { confirmCancel = true }
                        .accessibilityIdentifier("owner-pairing-offer.cancel")
                }
            }
            if record.live.offerState == .claimed {
                HStack(spacing: 10) {
                    Text("Um aparelho usou este convite e espera sua decisão. Compare o código de verificação antes de aprovar.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Revisar pedido…") { reviewingRequest = true }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("owner-pairing-offer.review-request")
                }
                // Historical, documented id of this block (it used to point to the terminal); now it opens the request here.
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("owner-pairing-offer.approval-cli")
            }
        }
        .sheet(isPresented: $reviewingRequest, onDismiss: { Task { await editor.refreshRecord() } }) {
            OwnerPairingClaimsSheet(focusOfferRequestID: record.receipt.clientRequestId)
        }
        .task(id: record.receipt.clientRequestId) {
            while !Task.isCancelled, editor.record?.live.offerState == .open {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard !Task.isCancelled else { return }
                await editor.refreshRecord()
                if editor.record?.live.offerState == .claimed { reviewingRequest = true }
            }
        }
        .confirmationDialog(Text("Cancelar este convite?"), isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancelar convite", role: .destructive) { copied = false; Task { await editor.cancelCurrentOffer() } }
            Button("Manter", role: .cancel) {}
        } message: {
            Text("O texto deste convite deixa de funcionar. Aparelhos que já entraram não são afetados.")
        }
    }

    private func expiryLine(_ offer: OwnerPairingOffer) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened); style.locale = locale
        let when = Date(timeIntervalSince1970: TimeInterval(offer.expiresAt) / 1_000).formatted(style)
        return String(format: t("Para %@ · vale até %@ · uma vez"), locale: locale,
                      t(OwnerPairingOfferPresentation.roleKey(offer.role)), when)
    }

    @ViewBuilder private var channelRecoveryControls: some View {
        if let localHost {
            VStack(alignment: .leading, spacing: 8) {
                if localHost.hasPendingAppClientPreparation {
                    Button("Retomar preparação") { prepareChannel(localHost) }
                        .disabled(preparingChannel || localHost.appClientPreparationBusy)
                        .accessibilityIdentifier("owner-pairing-offer.resume-channel")
                }
                Button("Recriar conexão segura…") { confirmRenewal = true }
                    .disabled(preparingChannel || localHost.appClientPreparationBusy || holder.session?.editor.busy == true)
                    .accessibilityIdentifier("owner-pairing-offer.renew.open")
                Text("Use se o certificado venceu, o endereço da rede mudou ou a identidade anterior não pode mais ser aberta.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func prepareChannel(_ localHost: LocalHostLaunchCoordinator, renewing: Bool = false) {
        guard !preparingChannel else { return }
        preparingChannel = true; channelNotice = nil
        holder.close() // Forget any previously displayed invitation before changing its channel/pin.
        Task {
            defer { preparingChannel = false }
            do {
                let result = try await (renewing ? localHost.renewAppClientChannel(model: model) : localHost.prepareAppClientChannel(model: model))
                await holder.open(model)
                if result == .localChatOnly {
                    channelNotice = DexterLocalization.text("A conexão segura não ficou disponível. O chat deste Mac foi restaurado. Retome a preparação ou confirme Recriar conexão segura para usar uma identidade nova.", locale: locale)
                } else if holder.session?.editor.status?.availability == .available {
                    channelNotice = renewing
                        ? DexterLocalization.text("Conexão recriada. Crie um novo QR e aprove os aparelhos novamente após comparar o código.", locale: locale)
                        : nil
                } else {
                    channelNotice = DexterLocalization.text("A preparação terminou, mas o canal ainda não foi confirmado. Atualize o estado antes de criar um QR.", locale: locale)
                }
            } catch {
                switch error as? LocalAppClientPreparationFailure {
                case .networkUnavailable?: channelNotice = DexterLocalization.text("Conecte este Mac à rede Tailscale e tente novamente.", locale: locale)
                case .busy?: channelNotice = DexterLocalization.text("Aguarde a conversa ou operação em andamento antes de preparar a conexão.", locale: locale)
                case .custodyUnavailable?: channelNotice = DexterLocalization.text("A identidade segura deste Mac não pôde ser preparada. Revise o acesso privado no Mac.", locale: locale)
                case .outcomeUnknown?: channelNotice = DexterLocalization.text("O resultado da preparação não foi confirmado. Atualize o estado antes de tentar outra vez.", locale: locale)
                default: channelNotice = DexterLocalization.text("A conexão segura não está disponível nesta base do Mac.", locale: locale)
                }
                await holder.open(model)
            }
        }
    }

    /// Copies the invitation marked as concealed (clipboard managers that honor the convention skip it). Nothing is logged.
    private func copy(_ editor: OwnerPairingOfferEditor) {
        guard let text = editor.invitationText else { return }
        let board = NSPasteboard.general
        board.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        board.writeObjects([item])
        copied = true
    }
}
#endif
