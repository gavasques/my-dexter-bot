#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// What the owner sees for the private connections service setup of THIS Mac's base: one readable stage, one next action.
/// Derived only from the controller's published state; it never decides that something is connected. `ready` is credential
/// custody on the base, and reachability is the catalog in Conectar apps.
struct ConnectionsPlatformSetupPresentation: Equatable {
    enum Stage: String, CaseIterable, Sendable {
        case loading, working, unreadable, otherBase, configuredExternally, confirmSettings, confirmPrivate, chooseService
        case needsEngines, channelUnavailable, exclusiveUpstream, originBound, configurationUnavailable, restartRequired
        case signingUnavailable, custodyUnavailable, enterCredential, hostStillHolds, deliver, ready
    }
    /// The single next step offered next to the stage text. `save` and `store` live in their forms, next to their fields.
    enum Action: String, Sendable { case none, reload, check, save, store, deliver, lock, showServices }

    struct Snapshot: Equatable {
        var status: ConnectionsConfigurationStatus?
        var notice: ConnectionsPlatformSettingsController.Notice?
        var scopeMatches: Bool
        var busy: Bool
        var pendingSettings: Bool
        var pendingPrivate: Bool
        var capability: ConnectionsCapabilityStatus
    }

    let stage: Stage

    @MainActor init(_ controller: ConnectionsPlatformSettingsController) {
        self.init(Snapshot(status: controller.status, notice: controller.notice, scopeMatches: controller.scopeMatches, busy: controller.busy,
                           pendingSettings: controller.pendingSettings != nil, pendingPrivate: controller.pendingPrivate != nil,
                           capability: controller.capabilityStatus))
    }

    init(_ s: Snapshot) { stage = Self.stage(s) }

    static func stage(_ s: Snapshot) -> Stage {
        if s.busy && (s.pendingSettings || s.pendingPrivate) { return .working }
        if s.pendingSettings { return .confirmSettings }
        if s.pendingPrivate { return .confirmPrivate }
        guard let status = s.status else {
            if s.notice == .hostChanged { return .otherBase }
            return s.notice == .loadFailed ? .unreadable : .loading
        }
        if !s.scopeMatches || s.notice == .hostChanged { return .otherBase }
        switch status.runtime.state {
        case .configuredExternally: return .configuredExternally
        case .restartRequired: return .restartRequired
        case .inactive:
            switch status.runtime.reason {
            case .privateChannelUnavailable?: return .channelUnavailable
            case .requiresMcpEngines?: return .needsEngines
            case .exclusiveUpstream?: return .exclusiveUpstream
            case .originBoundToOtherConnections?: return .originBound
            case .configurationUnavailable?: return .configurationUnavailable
            case .disabled?, nil: return .chooseService
            }
        case .active:
            if status.custody.channel == .unavailable { return .channelUnavailable }
            if status.custody.state == .ready { return s.capability == .missing ? .hostStillHolds : .ready }
            switch s.capability {
            case .configured: return .deliver
            case .missing: return .enterCredential
            case .unavailable: return .custodyUnavailable
            case .signingIdentityUnavailable: return .signingUnavailable
            }
        }
    }

    var titleKey: String { "connections.platform.stage.\(stage.rawValue).title" }
    var bodyKey: String {
        stage == .originBound ? "connections.platform.reason.originBound"
            : stage == .channelUnavailable ? "connections.platform.reason.privateChannelUnavailable"
            : "connections.platform.stage.\(stage.rawValue).body"
    }
    var primary: Action {
        switch stage {
        case .loading, .working, .otherBase, .configuredExternally, .signingUnavailable: .none
        case .unreadable, .needsEngines, .channelUnavailable, .exclusiveUpstream, .originBound, .configurationUnavailable, .restartRequired, .custodyUnavailable: .reload
        case .confirmSettings, .confirmPrivate: .check
        case .chooseService: .save
        case .enterCredential: .store
        case .deliver: .deliver
        case .hostStillHolds: .lock
        case .ready: .showServices
        }
    }
    /// Orange only where the owner must act on a problem; `ready` is never green (it is custody, not a connection).
    var needsAttention: Bool {
        [.unreadable, .otherBase, .confirmSettings, .confirmPrivate, .needsEngines, .channelUnavailable, .exclusiveUpstream, .originBound,
         .configurationUnavailable, .signingUnavailable, .custodyUnavailable, .hostStillHolds].contains(stage)
    }
    var symbol: String {
        switch stage {
        case .loading, .working: "hourglass"
        case .confirmSettings, .confirmPrivate: "questionmark.circle"
        case .chooseService: "link.badge.plus"
        case .restartRequired: "arrow.clockwise"
        case .configuredExternally: "lock"
        case .needsEngines: "sparkles"
        case .signingUnavailable, .custodyUnavailable, .enterCredential, .deliver: "key"
        case .ready: "checkmark.circle"
        default: "exclamationmark.triangle"
        }
    }
    /// Stages that show the credential block (entry, delivery, lock, forget, new generation).
    var showsCredential: Bool { [.enterCredential, .deliver, .ready, .hostStillHolds].contains(stage) }

    static func noticeKey(_ notice: ConnectionsPlatformSettingsController.Notice) -> String? {
        switch notice {
        // The stage already says these; showing the controller sentence again would only repeat it.
        case .settingsUnknown, .privateUnknown, .restartRequired, .hostChanged: nil
        case .loadFailed: "connections.platform.notice.loadFailed"
        case .conflict: "connections.platform.notice.conflict"
        case .saved: "connections.platform.notice.saved"
        case .ready: "connections.platform.notice.ready"
        case .locked: "connections.platform.notice.locked"
        case .refused: "connections.platform.notice.refused"
        case .capabilityExists: "connections.platform.notice.capabilityExists"
        case .capabilityMissing: "connections.platform.notice.capabilityMissing"
        case .capabilityUnavailable: "connections.platform.notice.capabilityUnavailable"
        case .signingUnavailable: "connections.platform.notice.signingUnavailable"
        case .channelUnavailable: "connections.platform.notice.channelUnavailable"
        case .invalidCapability: "connections.platform.notice.invalidCapability"
        }
    }
    static func noticeIsProblem(_ notice: ConnectionsPlatformSettingsController.Notice) -> Bool { ![.saved, .ready, .locked].contains(notice) }

    static func validOrigin(_ value: String) -> Bool { (try? connectionsPlatformOrigin(value.trimmingCharacters(in: .whitespacesAndNewlines))) != nil }

    /// Every catalog key this presentation can return (checked against Localizable.xcstrings by the focused tests).
    static var allKeys: [String] {
        Stage.allCases.flatMap { [ConnectionsPlatformSetupPresentation(stage: $0).titleKey, ConnectionsPlatformSetupPresentation(stage: $0).bodyKey] }
            + [ConnectionsPlatformSettingsController.Notice.loadFailed, .hostChanged, .conflict, .settingsUnknown, .privateUnknown, .saved, .restartRequired, .ready,
               .locked, .refused, .capabilityExists, .capabilityMissing, .capabilityUnavailable, .signingUnavailable, .channelUnavailable, .invalidCapability]
                .compactMap(noticeKey)
    }
    init(stage: Stage) { self.stage = stage }
}

/// Keeps the controller of the window's own base. The factory retains it per host/scope/address/owned child lifetime, so an
/// uncertain save or delivery survives closing and reopening Ajustes inside this app process; nothing is persisted.
@MainActor @Observable final class ConnectionsPlatformSetupHolder {
    private(set) var controller: ConnectionsPlatformSettingsController?

    /// GET of the status and, only when the running service waits for a credential this Mac already keeps for that exact
    /// scope, the controller's single documented restore. Never a save, a retry or a replay of an uncertain request.
    func open(localHost: LocalHostLaunchCoordinator?, model: DexterAppModel) {
        let next = (model.isFixture || model.showsPairedBase) ? nil : localHost?.makeConnectionsPlatformController(model: model)
        if let controller, controller !== next { controller.close() }
        controller = next
        next?.open()
    }

    func close() { controller?.close(); controller = nil }
}

/// The row inside Ajustes › Conexões › Conectar apps that opens the setup sheet, with the current stage in one line.
struct ConnectionsPlatformSetupEntry: View {
    let controller: ConnectionsPlatformSettingsController?
    /// Prominent while the base has no connections service yet.
    let prominent: Bool
    let open: () -> Void
    @Environment(\.locale) private var locale

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }

    var body: some View {
        if let controller {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: t("connections.platform.title")).font(.body.weight(.medium))
                    Text(verbatim: t(ConnectionsPlatformSetupPresentation(controller).titleKey))
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if prominent {
                    Button(t("connections.platform.entry.open"), action: open).buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("settings.connections.platform-setup.open")
                } else {
                    Button(t("connections.platform.entry.manage"), action: open)
                        .accessibilityIdentifier("settings.connections.platform-setup.open")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.connections.platform-setup")
        } else if prominent {
            Text(verbatim: t("connections.platform.entry.unavailableHere"))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.connections.platform-setup.unavailable")
        }
    }
}

/// "Serviço de conexões": optional, owner-only setup of the connections service THIS Mac's base uses. Address first, then
/// the base restart (an existing app action), then the credential issued by the service's operator. Saved or ready is never
/// shown as connected. Bots, MCP and paired apps cannot read or change any of this.
struct ConnectionsPlatformSetupSheet: View {
    let controller: ConnectionsPlatformSettingsController?
    /// Closes the sheet so the owner sees the service list in Conectar apps.
    let showServices: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: t("connections.platform.title")).font(.title2.weight(.semibold))
                Text(verbatim: t("connections.platform.subtitle"))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 12)
            Divider()
            ScrollView {
                Group {
                    if let controller {
                        ConnectionsPlatformSetupContent(controller: controller, showServices: { dismiss(); showServices() })
                    } else {
                        Label(t("connections.platform.entry.unavailableHere"), systemImage: "lock").foregroundStyle(.secondary)
                    }
                }
                .padding(22).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                if controller?.busy == true { ProgressView().controlSize(.small) }
                Spacer()
                Button(t("Concluir")) { dismiss() }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("connections.platform.close")
            }
            .padding(14)
        }
        // Fits inside the Settings window; the content scrolls.
        .frame(width: 560).frame(minHeight: 400, idealHeight: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.platform.sheet")
    }
}

private enum ConnectionsPlatformConfirmation: String, Identifiable { case disable, renew, forget; var id: String { rawValue } }

private struct ConnectionsPlatformSetupContent: View {
    @Bindable var controller: ConnectionsPlatformSettingsController
    let showServices: () -> Void
    @Environment(\.locale) private var locale
    /// The pasted credential lives only here until the owner's gesture; it is cleared on every stage change and on close.
    @State private var credentialDraft = ""
    @State private var credentialInvalid = false
    @State private var editingService = false
    @State private var confirming: ConnectionsPlatformConfirmation?

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }
    private var presentation: ConnectionsPlatformSetupPresentation { ConnectionsPlatformSetupPresentation(controller) }
    private var saved: ConnectionsConfiguration? { controller.status?.configuration }
    private var trimmedOrigin: String { controller.origin.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var editable: Bool {
        controller.status != nil && controller.status?.runtime.state != .configuredExternally && controller.pendingSettings == nil
            && controller.pendingPrivate == nil && controller.scopeMatches
    }
    private var showsServiceForm: Bool { editable && (presentation.stage == .chooseService || editingService) }
    private var canSaveAndUse: Bool {
        controller.canEdit && ConnectionsPlatformSetupPresentation.validOrigin(controller.origin)
            && (trimmedOrigin != saved?.origin || saved?.enabled != true)
    }
    private var canForget: Bool {
        controller.capabilityStatus == .configured && controller.scope != nil && controller.scopeMatches && !controller.busy && controller.pendingPrivate == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            stageBlock
            if editable { serviceBlock }
            if presentation.showsCredential { credentialBlock }
            if let notice = controller.notice, let key = ConnectionsPlatformSetupPresentation.noticeKey(notice) {
                Text(verbatim: t(key)).font(.callout)
                    .foregroundStyle(ConnectionsPlatformSetupPresentation.noticeIsProblem(notice) ? Color.orange : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("connections.platform.notice")
            }
            details
        }
        .onChange(of: presentation.stage) { _, _ in credentialDraft = ""; credentialInvalid = false }
        .onDisappear { credentialDraft = ""; editingService = false }
        .confirmationDialog(Text(verbatim: confirmationTitle), isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible) {
            Button(confirmationButton, role: confirming == .renew ? nil : .destructive) { confirm() }
                .accessibilityIdentifier("connections.platform.confirm")
            Button(t("Cancelar"), role: .cancel) { confirming = nil }
        } message: {
            Text(verbatim: confirmationMessage)
        }
    }

    // MARK: Stage and next action

    private var stageBlock: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: presentation.symbol).font(.title2)
                .foregroundStyle(presentation.needsAttention ? Color.orange : Color.secondary)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: t(presentation.titleKey)).font(.headline)
                Text(verbatim: t(presentation.bodyKey))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                primaryAction
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.platform.state")
        .accessibilityValue(Text(verbatim: presentation.stage.rawValue))
    }

    @ViewBuilder private var primaryAction: some View {
        switch presentation.primary {
        case .reload:
            Button(t("connections.platform.action.reload")) { controller.verify() }
                .disabled(controller.busy || !controller.scopeMatches)
                .accessibilityIdentifier("connections.platform.reload")
        case .check:
            Button(t("Conferir")) { controller.verify() }
                .buttonStyle(.borderedProminent)
                .disabled(controller.busy || !controller.scopeMatches)
                .accessibilityIdentifier("connections.platform.check")
        case .deliver:
            Button(t("connections.platform.deliver")) { controller.deliverStoredCapability() }
                .buttonStyle(.borderedProminent).disabled(!controller.canDeliver)
                .accessibilityIdentifier("connections.platform.deliver")
        case .lock:
            HStack {
                Button(t("connections.platform.lock")) { controller.lock() }
                    .buttonStyle(.borderedProminent).disabled(!controller.canLock)
                    .accessibilityIdentifier("connections.platform.lock")
                Button(t("Conferir")) { controller.verify() }
                    .disabled(controller.busy || !controller.scopeMatches)
                    .accessibilityIdentifier("connections.platform.check")
            }
        case .showServices:
            Button(t("connections.platform.action.showServices")) { showServices() }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("connections.platform.show-services")
        case .none, .save, .store:
            EmptyView()
        }
    }

    // MARK: Service address

    @ViewBuilder private var serviceBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: t("connections.platform.section.service")).font(.headline)
            if showsServiceForm {
                TextField(t("connections.platform.origin"), text: $controller.origin)
                    .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                    .disabled(!controller.canEdit)
                    .accessibilityIdentifier("connections.platform.origin")
                Text(verbatim: t("connections.platform.originHint"))
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !trimmedOrigin.isEmpty && !ConnectionsPlatformSetupPresentation.validOrigin(controller.origin) {
                    Text(verbatim: t("connections.platform.originInvalid")).font(.footnote).foregroundStyle(.orange)
                        .accessibilityIdentifier("connections.platform.origin.invalid")
                }
                HStack {
                    Button(t("connections.platform.action.saveAndUse")) { saveAndUse() }
                        .buttonStyle(.borderedProminent).disabled(!canSaveAndUse)
                        .accessibilityIdentifier("connections.platform.save")
                    if editingService {
                        Button(t("Cancelar")) { resetDraft() }
                            .accessibilityIdentifier("connections.platform.cancel-edit")
                    }
                }
            } else if let origin = saved?.origin {
                LabeledContent(t("connections.platform.address")) { Text(verbatim: origin).textSelection(.enabled) }
                    .accessibilityIdentifier("connections.platform.address")
                if saved?.enabled == false {
                    Text(verbatim: t("connections.platform.disabledNote")).font(.footnote).foregroundStyle(.secondary)
                }
                HStack {
                    Button(t("connections.platform.action.changeService")) { editingService = true }
                        .disabled(!controller.canEdit)
                        .accessibilityIdentifier("connections.platform.change")
                    if saved?.enabled == true {
                        Button(t("connections.platform.action.disable")) { confirming = .disable }
                            .disabled(!controller.canEdit)
                            .accessibilityIdentifier("connections.platform.disable")
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.platform.service")
    }

    private func saveAndUse() {
        controller.origin = trimmedOrigin
        controller.enabled = true
        editingService = false
        controller.save()
    }

    private func resetDraft() {
        controller.origin = saved?.origin ?? ""
        controller.enabled = saved?.enabled ?? false
        editingService = false
    }

    // MARK: Credential

    @ViewBuilder private var credentialBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: t("connections.platform.credential")).font(.headline)
            if presentation.stage == .enterCredential {
                SecureField(t("connections.platform.credential"), text: $credentialDraft)
                    .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                    .disabled(!controller.canStoreCapability)
                    .accessibilityIdentifier("connections.platform.credential")
                Text(verbatim: t("connections.platform.credentialHint"))
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if credentialInvalid {
                    Text(verbatim: t("connections.platform.credentialInvalid")).font(.footnote).foregroundStyle(.orange)
                        .accessibilityIdentifier("connections.platform.credential.invalid")
                }
                Button(t("connections.platform.action.store")) { store() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!controller.canStoreCapability || credentialDraft.isEmpty || credentialDraft.utf8.count > 4096)
                    .accessibilityIdentifier("connections.platform.store")
            }
            HStack {
                if presentation.stage == .ready {
                    Button(t("connections.platform.lock")) { controller.lock() }.disabled(!controller.canLock)
                        .accessibilityIdentifier("connections.platform.lock")
                }
                if controller.capabilityStatus == .configured {
                    Button(t("connections.platform.forget") + "…") { confirming = .forget }.disabled(!canForget)
                        .accessibilityIdentifier("connections.platform.forget")
                }
                Button(t("connections.platform.renew") + "…") { confirming = .renew }.disabled(!controller.canRenewCredential)
                    .accessibilityIdentifier("connections.platform.renew")
            }
            if presentation.stage == .ready {
                Text(verbatim: t("connections.platform.lockNote"))
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("connections.platform.credential-block")
    }

    private func store() {
        // Copied out of the field and the field cleared before the owned wrapper takes the bytes.
        let text = credentialDraft
        credentialDraft = ""
        guard let capability = ConnectionsOwnedCapability(capability: text) else { credentialInvalid = true; return }
        credentialInvalid = false
        controller.storeCapability(capability)
    }

    // MARK: Confirmations

    private var confirmationTitle: String {
        switch confirming {
        case .disable?: t("connections.platform.confirm.disable.title")
        case .renew?: t("connections.platform.confirm.renew.title")
        case .forget?: t("connections.platform.confirm.forget.title")
        case nil: ""
        }
    }
    private var confirmationMessage: String {
        switch confirming {
        case .disable?: t("connections.platform.confirm.disable.message")
        case .renew?: t("connections.platform.confirm.renew.message")
        case .forget?: t("connections.platform.confirm.forget.message")
        case nil: ""
        }
    }
    private var confirmationButton: String {
        switch confirming {
        case .disable?: t("connections.platform.confirm.disable.button")
        case .renew?: t("connections.platform.confirm.renew.button")
        case .forget?: t("connections.platform.confirm.forget.button")
        case nil: ""
        }
    }
    private func confirm() {
        let choice = confirming
        confirming = nil
        switch choice {
        case .disable?:
            controller.origin = saved?.origin ?? ""
            controller.enabled = false
            controller.save()
        case .renew?: controller.save(renewCredential: true)
        case .forget?: controller.forgetCapability()
        case nil: break
        }
    }

    // MARK: Technical details (on demand)

    private var details: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                if let status = controller.status {
                    row("connections.platform.details.runtime", [status.runtime.state.rawValue, status.runtime.reason?.rawValue,
                        status.runtime.generation.map { "generation \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    row("connections.platform.details.configuration", "revision \(status.configuration.revision) · generation \(status.configuration.generation) · "
                        + (status.configuration.enabled ? "enabled" : "disabled"))
                    row("connections.platform.details.custody", [status.custody.channel.rawValue, status.custody.state.rawValue,
                        status.custody.generation.map { "generation \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    if let request = status.privateRequest {
                        row("connections.platform.details.request", "\(request.operation.rawValue) · \(request.state.rawValue) · \(request.requestId)")
                    }
                }
                row("connections.platform.details.keychain", controller.capabilityStatus.rawValue)
                row("connections.platform.details.host", controller.hostID)
            }
            .font(.caption.monospaced()).textSelection(.enabled)
        } label: {
            Text(verbatim: t("Detalhes técnicos")).font(.callout).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("connections.platform.details")
    }

    private func row(_ key: String, _ value: String) -> some View {
        LabeledContent(t(key)) { Text(verbatim: value) }
    }
}
#endif
