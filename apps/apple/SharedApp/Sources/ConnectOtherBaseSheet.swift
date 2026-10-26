#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// "Conectar a outra base…" (UX-P1-07): the whole flow that links this app to a base on another Mac or server, out of
/// Este Mac. Same pairing contract as before: the invitation is imported only when the user continues, the key of this
/// Mac is created only by "Pedir aprovação", the owner approves on the other base, and "Conferir aprovação" only reads.
/// Connecting grants nothing to any bot. Technical facts (address, installation, permissions) stay under Detalhes.
struct ConnectOtherBaseSheet: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// This Mac's own base, when the app runs one; nil hides "Voltar à base deste Mac".
    let localAddress: String?
    /// Suggested client name. The app passes the computer name; QA passes a synthetic one.
    let suggestedName: String

    @State private var invitation = ""
    @State private var clientName = ""
    @State private var busy = false
    @State private var showsNewInvitation = false
    @State private var invitationRejected = false
    @State private var confirmation: Confirmation?

    private enum Confirmation: Identifiable {
        case forget, remove
        var id: Self { self }
    }

    private var pairing: PairedHostOnboarding { model.pairing }
    private var state: PairedHostConnectionState { pairing.state }
    private var hasReference: Bool { pairing.publicReference != nil }
    private var trimmedName: String { clientName.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameIsValid: Bool { !trimmedName.isEmpty && trimmedName.utf16.count <= 120 }
    private var asksForName: Bool { state == .readyToProvision || state == .identityReady }
    private var onThisMac: Bool { localAddress.map { model.isUsingThisMacBase(localAddress: $0) } ?? false }
    /// A new invitation is the first step without a selected base, after a revocation, or on request.
    private var asksForInvitation: Bool {
        !hasReference || state == .revoked || state == .disconnected || showsNewInvitation
    }

    var body: some View {
        NavigationStack {
            Form {
                header
                if hasReference { statusSection }
                if let reference = pairing.publicReference { scopesSection(reference) }
                if asksForInvitation { invitationSection }
                if asksForName { requestSection }
                if state == .pendingApproval || (hasReference && state == .offline) { approvalSection }
                if let notice = pairing.notice, notice != state.label {
                    Section {
                        Label(DexterLocalization.text(notice, locale: locale), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                            .accessibilityIdentifier("connect-other-base.notice")
                    }
                }
                if let reference = pairing.publicReference { detailsSection(reference) }
                Section {
                    Text("Conectar não dá permissão a nenhum bot. O que cada bot pode fazer continua sendo decidido na base onde ele está.")
                        .font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("connect-other-base.no-grants")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Conectar a outra base")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(state == .paired ? "Concluir" : "Fechar") { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("connect-other-base.close")
                }
                ToolbarItem(placement: .primaryAction) { moreMenu }
            }
        }
        // No taller than the Settings window it sits on; the form scrolls.
        .frame(minWidth: 560, idealWidth: 600, minHeight: 440, idealHeight: 520)
        .interactiveDismissDisabled(busy)
        .onAppear { if clientName.isEmpty { clientName = suggestedName } }
        .confirmationDialog(confirmationTitle, isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
                            titleVisibility: .visible) {
            switch confirmation {
            case .forget:
                Button("Esquecer esta base", role: .destructive) { model.detachPairedHost(); showsNewInvitation = false }
                    .accessibilityIdentifier("connect-other-base.confirm-forget")
            case .remove:
                Button("Remover este Mac", role: .destructive) { run { await model.revokeThisClient() } }
                    .accessibilityIdentifier("connect-other-base.confirm-remove")
            case nil:
                EmptyView()
            }
            Button("Cancelar", role: .cancel) { }
        } message: {
            switch confirmation {
            case .forget:
                Text("Este app deixa de mostrar essa base. Na outra base, este Mac continua registrado até o dono removê-lo.")
            case .remove:
                Text("A outra base deixa de aceitar este Mac. Para voltar, será preciso um novo convite. Nada muda nos bots.")
            case nil:
                EmptyView()
            }
        }
    }

    private var header: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "server.rack").font(.system(size: 26)).foregroundStyle(.secondary)
                    .frame(width: 34).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Use os bots que estão em outro Mac ou servidor.").font(.headline)
                    Text("O dono daquela base cria um convite para você e aprova este Mac. A base deste Mac continua do jeito que está.")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var statusSection: some View {
        Section("Situação") {
            Label(ConnectOtherBaseCopy.status(state, locale: locale), systemImage: Self.symbol(state))
                .foregroundStyle(state == .paired ? .green : (Self.needsAttention(state) ? .orange : .primary))
                .accessibilityIdentifier("connect-other-base.state")
            if state == .paired {
                Text("Os bots dessa base aparecem na janela principal.").font(.callout).foregroundStyle(.secondary)
            }
            if !asksForInvitation, state != .paired, state != .pendingApproval, state != .offline {
                Button("Usar outro convite…") { showsNewInvitation = true }
                    .disabled(busy)
                    .accessibilityIdentifier("connect-other-base.new-invitation")
            }
        }
    }

    private var invitationSection: some View {
        Section {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $invitation)
                    .font(.callout.monospaced())
                    .frame(minHeight: 72, maxHeight: 110)
                    .accessibilityLabel("Convite recebido do dono")
                    .accessibilityIdentifier("settings.paired-bundle")
                if invitation.isEmpty {
                    Text("Cole aqui o convite que o dono da outra base enviou.")
                        .font(.callout).foregroundStyle(.tertiary)
                        .padding(.top, 1).padding(.leading, 5)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            HStack {
                Button("Colar") {
                    if let text = NSPasteboard.general.string(forType: .string) { invitation = text }
                }
                .disabled(busy)
                .accessibilityIdentifier("connect-other-base.paste")
                Spacer()
                Button("Continuar") { importInvitation() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(asksForName ? nil : .defaultAction)
                .disabled(busy || invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("settings.import-pairing")
            }
            if invitationRejected {
                Label("Esse texto não é um convite para este app. Nada mudou. Peça um novo convite ao dono.", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("connect-other-base.invitation-rejected")
            }
            Text(onThisMac
                 ? "Ao continuar, este app passa a mostrar a outra base. Você pode voltar à base deste Mac pelo menu ⋯."
                 : "O convite identifica a outra base. O código dele só fica na memória até o pedido ser enviado.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("1. Convite")
        }
    }

    private var requestSection: some View {
        Section {
            TextField("Nome deste Mac", text: $clientName)
                .disabled(busy)
                .accessibilityIdentifier("settings.paired-client-name")
            Text("O dono vê esse nome ao aprovar. Ao pedir aprovação, este Mac cria uma chave própria, guardada só neste Mac.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button("Pedir aprovação") { requestApproval() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || !nameIsValid)
                    .accessibilityIdentifier("settings.begin-pairing")
            }
        } header: {
            Text("2. Este Mac")
        }
    }

    private var approvalSection: some View {
        Section {
            Text(state == .pendingApproval
                 ? "Peça ao dono da outra base para aprovar este Mac. Depois, toque em Conferir aprovação."
                 : "Esta base já foi usada neste app. Conecte de novo para ver os bots dela.")
                .fixedSize(horizontal: false, vertical: true)
            if state == .pendingApproval, let fingerprint = model.pairing.publicReference?.clientFingerprint {
                // The owner compares this with the code in Pedidos de aparelhos before approving.
                LabeledContent {
                    Text(verbatim: PairingVerificationCode.text(fingerprint))
                        .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                } label: {
                    Text("Código de verificação deste Mac")
                    Text("O dono vê o mesmo código ao aprovar.")
                }
                .accessibilityIdentifier("connect-other-base.verification-code")
            }
            HStack {
                Spacer()
                if busy { ProgressView().controlSize(.small) }
                Button(state == .pendingApproval ? "Conferir aprovação" : "Conectar") {
                    run { await model.connectPairedHost() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .accessibilityIdentifier("settings.restore-pairing")
            }
        } header: {
            Text(state == .pendingApproval ? "3. Aprovação" : "Conectar")
        }
    }

    /// What the invitation lets this app do, in plain words. The owner decides it when creating the invitation; the two
    /// output-folder permissions are off unless the owner turned them on there. Nothing here changes a permission.
    private func scopesSection(_ reference: PairedHostReference) -> some View {
        let granted = reference.scopes.map(\.rawValue)
        return Section {
            ForEach(PairingScopeCatalog.rows(for: granted), id: \.scope) { row in
                Label {
                    Text(verbatim: DexterLocalization.text(PairingScopeCatalog.labelKey(row.scope), locale: locale))
                        .foregroundStyle(row.included ? Color.primary : Color.secondary)
                } icon: {
                    Image(systemName: row.included ? "checkmark.circle.fill" : "minus.circle")
                        .foregroundStyle(row.included ? Color.green : Color.secondary)
                }
                .accessibilityValue(Text(row.included ? "Incluída" : "Não incluída"))
                .accessibilityIdentifier("connect-other-base.scope.\(row.scope)")
            }
            if PairingScopeCatalog.managesWithoutReading(granted) {
                Text("Alterar a pasta de arquivos não inclui ver os arquivos; são permissões separadas.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text(verbatim: ConnectOtherBaseCopy.catalogText("pairing.scope.outputsHint",
                fallback: "Desligado por padrão. Escolha só se este app deve ver ou mudar os arquivos gerados na base.", locale: locale))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Quem escolhe é o dono da outra base, ao criar o convite. Para mudar, peça um novo convite.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } header: {
            Text(pairing.binding == nil ? "O convite pede" : "Aprovado para este app")
        }
        .accessibilityIdentifier("connect-other-base.scopes")
    }

    private func detailsSection(_ reference: PairedHostReference) -> some View {
        Section {
            DisclosureGroup("Detalhes técnicos") {
                LabeledContent("Endereço") { Text(verbatim: reference.hostURL).textSelection(.enabled) }
                LabeledContent("Instalação") { Text(verbatim: reference.installationID).textSelection(.enabled) }
                LabeledContent("Tipo de cliente") { Text(verbatim: reference.role.rawValue) }
                LabeledContent(pairing.binding == nil ? "Acesso pedido" : "Acesso aprovado") {
                    Text(verbatim: reference.scopes.isEmpty ? DexterLocalization.text("none", locale: locale)
                                                            : reference.scopes.map(\.rawValue).joined(separator: ", "))
                }
            }
            .accessibilityIdentifier("connect-other-base.details")
        }
    }

    private var moreMenu: some View {
        Menu {
            if let localAddress, !onThisMac {
                Button("Voltar à base deste Mac") { run { await model.returnToThisMacBase(localAddress: localAddress) } }
                    .accessibilityIdentifier("connect-other-base.return-local")
            }
            if hasReference, !asksForInvitation {
                Button("Usar outro convite…") { showsNewInvitation = true }
            }
            Divider()
            Button("Desconectar") { model.disconnectPairedHost() }
                .disabled(!hasReference)
                .accessibilityIdentifier("settings.disconnect-pairing")
            Button("Esquecer esta base…") { confirmation = .forget }
                .disabled(!hasReference)
                .accessibilityIdentifier("settings.detach-pairing")
            Button("Remover este Mac da outra base…", role: .destructive) { confirmation = .remove }
                .disabled(state != .paired)
                .accessibilityIdentifier("settings.revoke-pairing")
        } label: {
            Label("Mais", systemImage: "ellipsis.circle")
        }
        .disabled(busy)
        .help("Mais ações")
        .accessibilityIdentifier("connect-other-base.more")
    }

    private var confirmationTitle: String {
        switch confirmation {
        case .forget: DexterLocalization.text("Esquecer esta base neste app?", locale: locale)
        case .remove: DexterLocalization.text("Remover este Mac da outra base?", locale: locale)
        case nil: ""
        }
    }

    /// Nothing changes for text that is not an invitation; the code itself is never kept in the field after Continuar.
    private func importInvitation() {
        let data = Data(invitation.utf8); invitation = ""
        let outcome = model.importPairingInvitation(data)
        invitationRejected = outcome == .notAnInvitation
        if outcome == .accepted { showsNewInvitation = false }
        clearMirroredError()
    }

    /// The sheet shows the pairing state itself; the same text in the window alert behind it would only repeat it.
    private func clearMirroredError() {
        if model.errorMessage == model.pairing.state.label { model.errorMessage = nil }
    }

    /// The key is created only here, by the user's explicit request, and only then is the request sent.
    private func requestApproval() {
        let name = trimmedName
        run {
            if model.pairing.state == .readyToProvision { await model.pairing.provisionIdentity() }
            guard model.pairing.state == .identityReady else { return }
            await model.pairing.claim(name: name)
        }
    }

    private func run(_ work: @escaping @MainActor () async -> Void) {
        guard !busy else { return }
        busy = true; invitationRejected = false
        Task { await work(); busy = false; clearMirroredError() }
    }

    private static func symbol(_ state: PairedHostConnectionState) -> String {
        switch state {
        case .paired: "checkmark.circle.fill"
        case .pendingApproval: "hourglass"
        case .offline, .disconnected: "wifi.slash"
        case .readyToProvision, .identityReady: "arrow.right.circle"
        case .revoked: "xmark.shield"
        case .identityMissing, .identityLocked, .outcomeUnknown, .admissionBlocked, .invalidMetadata: "exclamationmark.triangle"
        }
    }

    private static func needsAttention(_ state: PairedHostConnectionState) -> Bool {
        switch state {
        case .identityMissing, .identityLocked, .outcomeUnknown, .admissionBlocked, .invalidMetadata, .revoked: true
        default: false
        }
    }
}

/// The computer name the owner will recognize, used only to pre-fill "Nome deste Mac" (editable).
enum ConnectOtherBaseDefaults {
    static var computerName: String { Host.current().localizedName ?? "Mac" }
}

/// Plain words for the pairing states; the technical state label stays in the model and in the diagnostic report.
enum ConnectOtherBaseCopy {
    /// A key delivered by another lane's fragment (applied by Root); until it is in the catalog, the Portuguese text.
    static func catalogText(_ key: String, fallback: String, locale: Locale) -> String {
        let value = DexterLocalization.text(key, locale: locale)
        return value == key ? DexterLocalization.text(fallback, locale: locale) : value
    }

    static func status(_ state: PairedHostConnectionState, locale: Locale) -> String {
        switch state {
        case .disconnected: DexterLocalization.text("Nenhuma outra base", locale: locale)
        case .readyToProvision: DexterLocalization.text("Convite aceito · falta pedir aprovação", locale: locale)
        case .identityReady: DexterLocalization.text("Pronto para pedir aprovação", locale: locale)
        case .pendingApproval: DexterLocalization.text("Aguardando aprovação do dono", locale: locale)
        case .paired: DexterLocalization.text("Conectado", locale: locale)
        case .offline: DexterLocalization.text("Desconectado", locale: locale)
        case .revoked: DexterLocalization.text("Este Mac foi removido dessa base", locale: locale)
        case .identityMissing: DexterLocalization.text("A chave deste Mac não foi encontrada. Use um novo convite.", locale: locale)
        case .identityLocked: DexterLocalization.text("A chave deste Mac está bloqueada. Desbloqueie o Mac e tente de novo.", locale: locale)
        case .outcomeUnknown: DexterLocalization.text("Não foi possível confirmar o pedido. Confirme com o dono antes de tentar de novo.", locale: locale)
        case .admissionBlocked: DexterLocalization.text("O pedido não foi enviado: o armazenamento local está ocupado. Tente mais tarde.", locale: locale)
        case .invalidMetadata: DexterLocalization.text("Os dados salvos dessa base estão ilegíveis. A conexão está bloqueada.", locale: locale)
        }
    }
}
/// Slot for the owner's "convidar outro app" flow (UX-P1-07): the historical eight are always in the offer, and each
/// output-folder permission starts off and is turned on only by the owner's own gesture. The app has no owner offer
/// route today (offers are created with `dexter app-client offer --scope …`), so Root wires this when one exists.
struct PairingOfferScopesView: View {
    @Binding var selection: PairingScopeSelection
    @Environment(\.locale) private var locale

    var body: some View {
        Section {
            ForEach(PairingScopeCatalog.historical.sorted { lhs, rhs in
                (PairingScopeCatalog.displayOrder.firstIndex(of: lhs) ?? 0) < (PairingScopeCatalog.displayOrder.firstIndex(of: rhs) ?? 0)
            }, id: \.self) { scope in
                Label(DexterLocalization.text(PairingScopeCatalog.labelKey(scope), locale: locale), systemImage: "checkmark.circle")
                    .foregroundStyle(.secondary)
            }
            Toggle(DexterLocalization.text(PairingScopeCatalog.labelKey(PairingScopeCatalog.outputsRead), locale: locale),
                   isOn: Binding(get: { selection.outputsRead }, set: { selection.set(PairingScopeCatalog.outputsRead, on: $0) }))
                .accessibilityIdentifier("pairing-offer.scope.outputs-read")
            Toggle(DexterLocalization.text(PairingScopeCatalog.labelKey(PairingScopeCatalog.outputsManage), locale: locale),
                   isOn: Binding(get: { selection.outputsManage }, set: { selection.set(PairingScopeCatalog.outputsManage, on: $0) }))
                .accessibilityIdentifier("pairing-offer.scope.outputs-manage")
            if selection.managesWithoutReading {
                Text("Alterar a pasta de arquivos não inclui ver os arquivos; são permissões separadas.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Button("Selecionar todos") { selection.selectAllOutputs() }
                .disabled(selection.outputsRead && selection.outputsManage)
                .accessibilityIdentifier("pairing-offer.scope.select-all")
            ForEach(PairingScopeCatalog.connections, id: \.self) { scope in
                Toggle(DexterLocalization.text(PairingScopeCatalog.labelKey(scope), locale: locale),
                       isOn: Binding(get: { selection.scopes.contains(scope) }, set: { selection.set(scope, on: $0) }))
                    .accessibilityIdentifier("pairing-offer.scope.\(scope)")
            }
            Text(verbatim: DexterLocalization.text("pairing.scope.connectionsHint", locale: locale))
                .font(.callout).foregroundStyle(.secondary)
            if selection.connectionsManageWithoutReading {
                Text(verbatim: DexterLocalization.text("pairing.scope.connectionsManageWithoutRead", locale: locale))
                    .font(.callout).foregroundStyle(.secondary)
            }
            Text(verbatim: ConnectOtherBaseCopy.catalogText("pairing.scope.outputsHint",
                fallback: "Desligado por padrão. Escolha só se este app deve ver ou mudar os arquivos gerados na base.", locale: locale))
                .font(.callout).foregroundStyle(.secondary)
            Text(verbatim: ConnectOtherBaseCopy.catalogText("pairing.scope.rotateKeeps",
                fallback: "Trocar a chave mantém as mesmas permissões. Para dar outra, pareie de novo.", locale: locale))
                .font(.callout).foregroundStyle(.secondary)
        } header: {
            Text("O que o outro app poderá fazer")
        }
        .accessibilityIdentifier("pairing-offer.scopes")
    }
}
#endif
