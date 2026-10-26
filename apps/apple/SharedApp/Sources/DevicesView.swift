import DexterAppCore
import DexterHostClient
import Foundation
import SwiftUI

/// Este Mac › Aparelhos (UX-P1-07): the devices the connected base reports, with the frequent action visible
/// ("Permissões por bot", "Conferir") and the rare ones in ⋯. Linking this app to another base lives in
/// "Conectar a outra base…", not here.
struct DevicesSettingsSection: View {
    @Environment(\.locale) private var locale
    private var copy: DeviceCopy { DeviceCopy(locale: locale) }
    @Environment(DexterAppModel.self) private var model

    var body: some View {
        Section {
            if model.isFixture {
                Text(copy.text("A demonstração não tem aparelhos."))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.devices.fixture")
            } else if model.remotePairingPending {
                Text(copy.text("Este app ainda não está conectado a essa base. Use Conectar a outra base… Ligar o agente deste Mac não conecta o app."))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.devices.remote-unavailable")
            } else if !model.canUseHost {
                Text(copy.text("Sem base conectada. Os aparelhos aparecem quando o app estiver ligado a uma base."))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.devices.host-unavailable")
            } else if model.isLoadingDevices && model.devices.isEmpty {
                ProgressView(copy.text("Carregando aparelhos…"))
                    .accessibilityIdentifier("settings.devices.loading")
            } else if let error = model.deviceError, model.devices.isEmpty {
                Label(copy.error(error), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("settings.devices.error")
                Button(copy.text("Tentar de novo")) {
                    Task { await model.refreshDevices() }
                }
                .disabled(model.isLoadingDevices)
                .accessibilityIdentifier("settings.devices.retry")
            } else if model.devices.isEmpty {
                ContentUnavailableView(
                    copy.text("Nenhum aparelho"),
                    systemImage: "laptopcomputer.and.iphone",
                    description: Text(copy.text("Esta base ainda não registrou nenhum aparelho."))
                )
                .accessibilityIdentifier("settings.devices.empty")
            } else {
                ForEach(model.devices) { device in
                    DeviceSettingsRow(
                        device: device,
                        isBusy: model.operatingDeviceIDs.contains(device.id)
                    )
                }
                if let error = model.deviceError {
                    Label(copy.error(error), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("settings.devices.error")
                }
            }
        } header: {
            HStack {
                Text(copy.text("Aparelhos"))
                Spacer()
                if model.canUseHost {
                    Button {
                        Task { await model.refreshDevices() }
                    } label: {
                        Label(copy.text("Atualizar"), systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .labelStyle(.iconOnly)
                    .disabled(model.isLoadingDevices || !model.operatingDeviceIDs.isEmpty)
                    .keyboardShortcut("r", modifiers: [.command])
                    .help(copy.text("Atualizar aparelhos"))
                    .accessibilityLabel(copy.text("Atualizar aparelhos"))
                    .accessibilityIdentifier("settings.devices.refresh")
                }
            }
        } footer: {
            Text(copy.text("A lista vem da base. “Não pareado” não quer dizer que há um pedido esperando. Estar na lista não dá acesso a nada."))
        }
        .task {
            await model.refreshDevices()
        }
    }
}

private struct DeviceSettingsRow: View {
    @Environment(\.locale) private var locale
    private var copy: DeviceCopy { DeviceCopy(locale: locale) }
    private enum PendingConfirmation: Equatable {
        case revoke
        case discardExpectation
    }

    @Environment(DexterAppModel.self) private var model
    @State private var editingDevice: DeviceView?
    @State private var grantsDevice: DeviceView?
    @State private var pendingConfirmation: PendingConfirmation?

    let device: DeviceView
    let isBusy: Bool

    private var canManage: Bool {
        model.canUseHost
            && model.operatingDeviceIDs.isEmpty
            && !model.awaitingDeviceConfirmationIDs.contains(device.id)
            && device.displayStatus != .revoked
    }

    /// Only an active, paired Mac agent can be a grant destination; the host decides which operations it lists.
    private var canManageGrants: Bool {
        model.canUseHost && device.role == "agent-mac" && device.paired && device.displayStatus != .revoked
    }

    private var displayedStatus: DeviceDisplayStatus {
        model.displayStatus(for: device)
    }

    private var isAwaitingConfirmation: Bool {
        model.awaitingDeviceConfirmationIDs.contains(device.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: device.platform == .macos ? "laptopcomputer" : "iphone")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: device.name)
                        .font(.headline)
                        .accessibilityIdentifier("device.name.\(device.id)")
                    Text(DexterLocalization.format("Visto por último: %@", Date(timeIntervalSince1970: TimeInterval(device.lastSeenAt) / 1_000).formatted(date: .abbreviated, time: .shortened), locale: locale))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("device.last-seen.\(device.id)")
                }
                Spacer(minLength: 12)
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(copy.text("Atualizando aparelho"))
                }
                Label(copy.status(displayedStatus), systemImage: copy.symbol(displayedStatus))
                    .font(.subheadline)
                    .foregroundStyle(displayedStatus == .online ? .green : .secondary)
                    .accessibilityLabel(copy.status(displayedStatus))
                    .accessibilityIdentifier("device.status.\(device.id)")
                Menu {
                    Button(copy.text("Renomear…")) {
                        model.clearDeviceError()
                        editingDevice = device
                    }
                    .disabled(!canManage || isBusy)
                    .accessibilityLabel(DexterLocalization.format("Renomear %@", device.name, locale: locale))
                    .accessibilityIdentifier("device.rename.\(device.id)")
                    Divider()
                    Button(copy.text("Remover…"), role: .destructive) {
                        pendingConfirmation = .revoke
                    }
                    .disabled(!canManage || isBusy)
                    .accessibilityLabel(DexterLocalization.format("Remover %@", device.name, locale: locale))
                    .accessibilityIdentifier("device.revoke.\(device.id)")
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.button)
                .buttonStyle(.borderless)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(copy.text("Mais ações"))
                .accessibilityLabel(DexterLocalization.format("Mais ações para %@", device.name, locale: locale))
                .accessibilityIdentifier("device.more.\(device.id)")
            }

            if canManageGrants || isAwaitingConfirmation {
                HStack(spacing: 8) {
                    if canManageGrants {
                        Button {
                            grantsDevice = device
                        } label: {
                            Label(copy.text("Permissões por bot"), systemImage: "checklist")
                        }
                        .disabled(isBusy)
                        .accessibilityIdentifier("device.grants.\(device.id)")
                    }
                    if isAwaitingConfirmation {
                        Button {
                            Task { await model.confirmDeviceMutation(id: device.id) }
                        } label: {
                            Label(copy.text("Conferir"), systemImage: "arrow.clockwise")
                        }
                        .disabled(!model.operatingDeviceIDs.isEmpty)
                        .accessibilityIdentifier("device.confirm-status.\(device.id)")
                    }
                }
                .controlSize(.small)
                .padding(.leading, 34)
            }

            if isAwaitingConfirmation {
                VStack(alignment: .leading, spacing: 4) {
                    Label(copy.text("Alteração não confirmada"), systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("device.mutation-uncertain.\(device.id)")
                    DisclosureGroup(copy.text("Detalhes")) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(
                                model.discardableDeviceMutationIDs.contains(device.id)
                                    ? copy.discardExpectationNotice
                                    : copy.uncertainMutationNotice
                            )
                            .fixedSize(horizontal: false, vertical: true)
                            if model.discardableDeviceMutationIDs.contains(device.id) {
                                Button(copy.text("Descartar aviso local…"), role: .destructive) {
                                    pendingConfirmation = .discardExpectation
                                }
                                .controlSize(.small)
                                .disabled(!model.operatingDeviceIDs.isEmpty)
                                .accessibilityIdentifier("device.discard-expectation.\(device.id)")
                            }
                        }
                        .padding(.top, 2)
                    }
                    .accessibilityIdentifier("device.uncertain-details.\(device.id)")
                }
                .font(.footnote)
                .padding(.leading, 34)
            }
        }
        .padding(.vertical, 4)
        .sheet(item: $editingDevice) { selectedDevice in
            RenameDeviceSheet(device: selectedDevice)
        }
        .sheet(item: $grantsDevice) { selectedDevice in
            DeviceGrantsSheet(device: selectedDevice)
        }
        .confirmationDialog(
            confirmationTitle,
            isPresented: Binding(
                get: { pendingConfirmation != nil },
                set: { if !$0 { pendingConfirmation = nil } }
            ),
            titleVisibility: .visible
        ) {
            switch pendingConfirmation {
            case .revoke:
                Button(copy.text("Remover aparelho"), role: .destructive) {
                    Task { await model.revokeDevice(id: device.id) }
                }
                .accessibilityIdentifier("device.confirm-revoke.\(device.id)")
                Button(copy.text("Cancelar"), role: .cancel) { }
            case .discardExpectation:
                Button(copy.text("Descartar só o aviso"), role: .destructive) {
                    _ = model.discardDeviceMutationExpectation(id: device.id)
                }
                .accessibilityIdentifier("device.confirm-discard-expectation.\(device.id)")
                Button(copy.text("Manter aviso"), role: .cancel) { }
            case nil:
                EmptyView()
            }
        } message: {
            switch pendingConfirmation {
            case .revoke:
                Text(copy.text("A base passa a recusar este aparelho e grava isso. O app não cria permissões nem refaz o pareamento."))
            case .discardExpectation:
                Text(copy.discardExpectationNotice)
            case nil:
                EmptyView()
            }
        }
    }

    private var confirmationTitle: String {
        switch pendingConfirmation {
        case .revoke: DexterLocalization.format("Remover %@?", device.name, locale: locale)
        case .discardExpectation: copy.text("Descartar o aviso de alteração não confirmada?")
        case nil: ""
        }
    }
}

private struct RenameDeviceSheet: View {
    @Environment(\.locale) private var locale
    private var copy: DeviceCopy { DeviceCopy(locale: locale) }
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var isSaving = false

    let device: DeviceView

    init(device: DeviceView) {
        self.device = device
        _name = State(initialValue: device.name)
    }

    private var trimmedName: String {
        DeviceNameNormalizer.normalize(name)
    }

    private var canSave: Bool {
        !isSaving
            && model.canUseHost
            && model.operatingDeviceIDs.isEmpty
            && !model.awaitingDeviceConfirmationIDs.contains(device.id)
            && DeviceNameNormalizer.isValid(trimmedName)
            && trimmedName != device.name
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField(copy.text("Nome do aparelho"), text: $name)
                    .accessibilityLabel(copy.text("Nome do aparelho"))
                    .accessibilityIdentifier("device.rename-name")
                    .onSubmit(save)

                Text(copy.text("O novo nome é gravado pela base atual."))
                .font(.footnote)
                .foregroundStyle(.secondary)

                if let error = model.deviceError,
                   error != .deviceMutationOutcomeUnknown || model.awaitingDeviceConfirmationIDs.contains(device.id) {
                    Label(copy.error(error), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("device.rename-error")
                }
            }
            .navigationTitle(copy.text("Renomear aparelho"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(copy.text("Cancelar")) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(copy.text("Salvar"), action: save)
                        .disabled(!canSave)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("device.rename-save")
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        #if os(macOS)
        .frame(minWidth: 380, minHeight: 220)
        #endif
    }

    private func save() {
        guard canSave else { return }
        isSaving = true
        Task {
            let updated = await model.renameDevice(id: device.id, name: trimmedName)
            isSaving = false
            if updated { dismiss() }
        }
    }
}

/// Per-bot decisions for one Mac agent. Rows come only from the host; a missing grant is shown as blocked.
/// `initialBotID` only preselects the picker (for the screen-control panel); nothing is checked or granted on open.
struct DeviceGrantsSheet: View {
    @Environment(\.locale) private var locale
    private var copy: DeviceCopy { DeviceCopy(locale: locale) }
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var botID: String?

    let device: DeviceView
    var initialBotID: String? = nil

    private var rows: [DeviceGrantRow] {
        guard let botID, model.grantBotID == botID else { return [] }
        return model.grantRows.filter { $0.botID == botID && $0.destination == device.id }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if model.bots.isEmpty {
                    ContentUnavailableView(
                        copy.text("Nenhum bot"),
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text(copy.text("Crie um bot nesta base primeiro."))
                    )
                    .accessibilityIdentifier("device.grants.no-bots")
                } else {
                    Picker(copy.text("Bot"), selection: $botID) {
                        ForEach(model.bots) { bot in
                            Text(bot.name).tag(Optional(bot.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .disabled(model.operatingGrantID != nil)
                    .accessibilityIdentifier("device.grants.bot")

                    content
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }

                Text(copy.text("Uma permissão aqui só decide se este bot pode pedir a operação neste Mac. Ela não abre sessão, não escolhe janela nem site e não liga permissões de privacidade do macOS."))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding()
            .navigationTitle(DexterLocalization.format("Permissões em %@", device.name, locale: locale))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(copy.text("Concluir")) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        guard let botID else { return }
                        Task { await model.loadDeviceGrants(botID: botID) }
                    } label: {
                        Label(copy.text("Atualizar"), systemImage: "arrow.clockwise")
                    }
                    .disabled(botID == nil || model.isLoadingGrants || model.operatingGrantID != nil)
                    .keyboardShortcut("r", modifiers: [.command])
                    .accessibilityIdentifier("device.grants.refresh")
                }
            }
        }
        .interactiveDismissDisabled(model.operatingGrantID != nil)
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 380)
        #endif
        .onAppear {
            let ids = model.bots.map(\.id)
            botID = [initialBotID, model.grantBotID, model.selectedBotID].compactMap { $0 }.first(where: ids.contains) ?? ids.first
        }
        .task(id: botID) {
            guard let botID else { return }
            await model.loadDeviceGrants(botID: botID)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoadingGrants && rows.isEmpty {
            ProgressView(copy.text("Carregando permissões…"))
                .accessibilityIdentifier("device.grants.loading")
        } else if let error = model.grantError, rows.isEmpty, error != .mutationOutcomeUnknown {
            Label(copy.grantError(error), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("device.grants.error")
        } else if rows.isEmpty {
            ContentUnavailableView(
                copy.text("Nenhuma operação"),
                systemImage: "checklist",
                description: Text(copy.text("A base não lista operações deste Mac para este bot."))
            )
            .accessibilityIdentifier("device.grants.empty")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                List(rows) { row in
                    DeviceGrantRowView(row: row)
                }
                .listStyle(.inset)
                #if os(macOS)
                if let botID, model.canEditBotProfiles {
                    DeviceConversationRoutesView(device: device, botID: botID, operations: rows.map(\.tool).sorted())
                }
                #endif
                if let error = model.grantError {
                    Label(copy.grantError(error), systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("device.grants.error")
                }
            }
        }
    }
}

private struct DeviceGrantRowView: View {
    @Environment(\.locale) private var locale
    private var copy: DeviceCopy { DeviceCopy(locale: locale) }
    @Environment(DexterAppModel.self) private var model

    let row: DeviceGrantRow

    private var isUncertain: Bool { model.uncertainGrantIDs.contains(row.id) }
    private var isBusy: Bool { model.operatingGrantID == row.id }
    private var canWrite: Bool { model.canUseHost && model.operatingGrantID == nil && !isUncertain }

    private func isCurrent(_ choice: DeviceGrantChoice) -> Bool {
        row.revision != nil && row.policy == choice.rawValue && row.expiresAt == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.tool)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("device.grant.tool.\(row.id)")
                Spacer(minLength: 8)
                Text(copy.policy(row))
                    .font(.subheadline)
                    .foregroundStyle(row.policy == "allow" && !row.isExpired(at: Date()) ? .green : .secondary)
                    .accessibilityIdentifier("device.grant.policy.\(row.id)")
            }

            if let detail = copy.grantDetail(row, locale: locale) {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                Button(copy.text("Pedir aprovação")) {
                    Task { await model.setDeviceGrant(id: row.id, to: .ask) }
                }
                .disabled(!canWrite || isCurrent(.ask))
                .accessibilityIdentifier("device.grant.ask.\(row.id)")

                // The catalog's "Bloquear" key means lock elsewhere; this English key already reads "Bloquear" in pt-BR.
                Button(copy.text("Block")) {
                    Task { await model.setDeviceGrant(id: row.id, to: .deny) }
                }
                .disabled(!canWrite || isCurrent(.deny))
                .accessibilityIdentifier("device.grant.deny.\(row.id)")

                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(copy.text("Atualizando permissão"))
                }
            }
            .controlSize(.small)

            if isUncertain {
                VStack(alignment: .leading, spacing: 4) {
                    Label(copy.text("Alteração não confirmada"), systemImage: "exclamationmark.triangle.fill")
                    Text(copy.text("A base pode ter aplicado. Conferir só lê a base e nunca reenvia a alteração."))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button(copy.text("Conferir")) {
                            guard let botID = model.grantBotID else { return }
                            Task { await model.loadDeviceGrants(botID: botID) }
                        }
                        .disabled(model.isLoadingGrants || model.operatingGrantID != nil)
                        .accessibilityIdentifier("device.grant.check.\(row.id)")
                        if model.discardableGrantIDs.contains(row.id) {
                            Button(copy.text("Descartar aviso local"), role: .destructive) {
                                model.discardGrantExpectation(id: row.id)
                            }
                            .accessibilityIdentifier("device.grant.discard.\(row.id)")
                        }
                    }
                    .controlSize(.small)
                }
                .font(.footnote)
                .foregroundStyle(.orange)
                .accessibilityIdentifier("device.grant.uncertain.\(row.id)")
            }
        }
        .padding(.vertical, 2)
    }
}

/// Plain Portuguese keys (UX-P1-07); the catalog carries the English text. "Base" is the word the rest of the app uses.
private struct DeviceCopy {
    let locale: Locale
    func text(_ key: String) -> String {
        DexterLocalization.text(key, locale: locale)
    }

    var uncertainMutationNotice: String {
        text("O pedido anterior pode ter sido aplicado. Conferir só lê a base e não reenvia a alteração.")
    }

    var discardExpectationNotice: String {
        text("Uma consulta recente deste aparelho não confirmou a alteração. Isso não prova que o pedido anterior não vai mais valer. Descartar só apaga este aviso neste app e não reenvia nada.")
    }

    func policy(_ row: DeviceGrantRow) -> String {
        guard row.revision != nil, let policy = row.policy else { return text("Bloqueado (sem permissão)") }
        if row.isExpired(at: Date()) { return text("Expirada") }
        switch policy {
        case "allow": return text("Permitido")
        case "ask": return text("Pede aprovação")
        case "deny": return text("Bloqueado")
        default: return policy
        }
    }

    func grantDetail(_ row: DeviceGrantRow, locale: Locale) -> String? {
        guard let revision = row.revision else { return nil }
        let revisionText = DexterLocalization.format("Revisão %@", String(revision), locale: locale)
        guard let expiresAt = row.expiresAt else {
            return revisionText + " · " + text("Sem prazo")
        }
        let date = Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1_000).formatted(date: .abbreviated, time: .shortened)
        return revisionText + " · " + DexterLocalization.format(row.isExpired(at: Date()) ? "Expirou em %@" : "Expira em %@", date, locale: locale)
    }

    func grantError(_ error: HostClientError) -> String {
        switch error {
        case .notReady: text("Esta base não oferece permissões de aparelho agora.")
        case .conflict: text("Esta permissão mudou na base. O valor atual foi recarregado; nada foi reenviado.")
        case .notFound: text("O bot ou a operação não existe mais nesta base.")
        case .invalidRequest: text("A base recusou esta permissão.")
        case .mutationOutcomeUnknown, .deviceMutationOutcomeUnknown:
            text("Uma alteração não foi confirmada. Confira antes de tentar de novo.")
        default: self.error(error)
        }
    }

    func status(_ status: DeviceDisplayStatus) -> String {
        switch status {
        case .online: text("Conectado")
        case .offline: text("Desconectado")
        case .unpaired: text("Não pareado")
        case .revoked: text("Removido")
        case .confirming: text("Confirmando")
        }
    }

    func symbol(_ status: DeviceDisplayStatus) -> String {
        switch status {
        case .online: "checkmark.circle.fill"
        case .offline: "wifi.slash"
        case .unpaired: "link.badge.plus"
        case .revoked: "xmark.shield.fill"
        case .confirming: "questionmark.circle"
        }
    }

    func error(_ error: HostClientError) -> String {
        switch error {
        case .invalidConfiguration: text("O endereço da base é inválido.")
        case .remotePairingUnavailable: text("O acesso deste app a outra base ainda não está disponível.")
        case .offline: text("A base está offline ou indisponível.")
        case .invalidRequest: text("A base recusou a alteração. Confira o nome e tente de novo.")
        case .forbidden: text("A base não autorizou esta operação.")
        case .notFound: text("Este aparelho não existe mais na base. Atualize a lista.")
        case .conflict: text("O estado do aparelho mudou. Atualize a lista.")
        case .notReady: text("O serviço de aparelhos da base ainda não está pronto.")
        case .hostFailure: text("A base não conseguiu concluir a operação.")
        case .contractMismatch: text("A resposta da base não é a esperada para aparelhos.")
        case .deviceMutationOutcomeUnknown, .mutationOutcomeUnknown:
            text("A base pode ter aplicado a alteração. Confira antes de tentar de novo.")
        case .approvalExpired: text("A aprovação expirou. Atualize a lista de ações.")
        }
    }
}
