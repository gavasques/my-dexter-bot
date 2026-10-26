#if os(macOS)
import SwiftUI
import DexterAppCore
import DexterHostClient

/// Narrow owner technical control, embedded in the existing device permissions sheet.
struct DeviceConversationRoutesView: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    let device: DeviceView
    let botID: String
    let operations: [String]
    @State private var tool = ""
    @State private var session: DeviceConversationRoutesSession?
    @State private var setupError: HostClientError?
    private func copy(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var route: DeviceConversationRoute? { session?.route(deviceID: device.id, tool: tool) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy("Publicação na conversa", "Conversation publication")).font(.headline)
            Picker(copy("Operação", "Operation"), selection: $tool) {
                ForEach(operations, id: \.self) { Text($0).tag($0) }
            }
            .disabled(session?.isBusy == true || session?.pending != nil)
            .accessibilityIdentifier("device.routes.operation")
            Text(stateLabel).font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("device.routes.status")
            HStack {
                Button(copy("Publicar na conversa", "Publish in conversation")) {
                    Task { await session?.set(deviceID: device.id, tool: tool, status: .active) }
                }
                .disabled(!canChange || route?.status == .revoked)
                .accessibilityIdentifier("device.routes.publish")
                Button(copy("Suspender", "Suspend")) {
                    Task { await session?.set(deviceID: device.id, tool: tool, status: .suspended) }
                }
                .disabled(!canChange || route?.status != .active)
                .accessibilityIdentifier("device.routes.suspend")
                Button(copy("Verificar estado", "Check status")) { Task { await session?.check() } }
                    .disabled(session == nil || session?.isBusy == true || session?.isAvailable != true)
                    .accessibilityIdentifier("device.routes.check")
            }
            .controlSize(.small)
            if route?.needsFreshGrant == true {
                Button(copy("Renovar permissão com aprovação", "Renew permission with approval")) {
                    guard let row = model.grantRows.first(where: { $0.botID == botID && $0.destination == device.id && $0.tool == tool }) else { return }
                    Task {
                        _ = await model.setDeviceGrant(id: row.id, to: .ask, renewExisting: true)
                        await session?.load(botID: botID)
                    }
                }
                .disabled(!canChange || model.grantBotID != botID || model.operatingGrantID != nil || model.isLoadingGrants || model.grantRows.contains(where: { $0.tool == tool && model.uncertainGrantIDs.contains($0.id) }))
                .accessibilityIdentifier("device.routes.renew-grant")
            }
            if session?.isBusy == true { ProgressView().controlSize(.small) }
            if let pending = session?.pending {
                Text(copy("Alteração sem confirmação. Verificar consulta o receipt original e não reenvia a alteração.",
                          "Change unconfirmed. Check reads the original receipt and never resends the change."))
                    .font(.footnote).foregroundStyle(.orange)
                    .accessibilityIdentifier("device.routes.uncertain")
                Text(pending.clientRequestId).font(.caption.monospaced()).textSelection(.enabled)
                    .accessibilityIdentifier("device.routes.request-id")
            }
            if let error = session?.error ?? setupError {
                Text(error.localizedDescription).font(.footnote).foregroundStyle(.orange)
                    .accessibilityIdentifier("device.routes.error")
            }
            Text(copy("Publicar associa esta operação ao bot selecionado. O grant, a presença autenticada e as permissões do macOS continuam sendo verificados separadamente. CUA exige também consentimento da superfície, calibração, indicador e Parar.",
                      "Publishing associates this operation with the selected bot. Its grant, authenticated presence and macOS permissions are checked separately. CUA also requires surface consent, calibration, indicator and Stop."))
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .task(id: botID) {
            setupError = nil
            if !operations.contains(tool) { tool = operations.first ?? "" }
            do { session = try await model.makeDeviceRoutesSession(); await session?.load(botID: botID) }
            catch { setupError = (error as? HostClientError) ?? .notReady }
        }
    }
    private var canChange: Bool {
        session?.canMutate == true && session?.botID == botID && model.canEditBotProfiles && operations.contains(tool)
    }
    private var stateLabel: String {
        guard let route else { return copy("Não publicada", "Unpublished") }
        let state: String
        switch route.status {
        case .active: state = copy("Publicada", "Published")
        case .suspended: state = copy("Suspensa", "Suspended")
        case .revoked: state = copy("Revogada", "Revoked")
        }
        return state + " · r\(route.revision)" + (route.needsFreshGrant ? copy(" · exige grant novo", " · fresh grant required") : "")
    }
}
#endif
