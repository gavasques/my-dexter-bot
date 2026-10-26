#if os(iOS)
import DexterAppCore
import DexterClientIdentity
import DexterHostClient
import SwiftUI
import UIKit

/// Private onboarding only: the invitation remains in local view memory until the explicit Connect gesture.
struct IOSMacConnectionView: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var scanning = false
    @State private var advanced = false
    @State private var pasted = ""
    @State private var invitation = Data()
    @State private var review: PairingInvitationPreview?
    @State private var clientName = "iPhone"
    @State private var notice: String?
    @State private var busy = false

    private var pairing: PairedHostOnboarding { model.pairing }
    private func t(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var pollKey: String { scenePhase == .active ? pairing.publicReference?.claimID ?? "none" : "paused" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: review == nil ? "laptopcomputer.and.iphone" : "checkmark.shield")
                    .font(.system(size: 48, weight: .light)).foregroundStyle(Color.accentColor).accessibilityHidden(true)
                if let review { reviewContent(review) }
                else if pairing.state == .pendingApproval { approvalContent }
                else {
                    Text(t("Conecte ao seu Mac", "Connect your Mac")).font(.largeTitle.bold())
                        .accessibilityIdentifier("ios-pairing.title")
                    Text(t("Seus bots e conversas ficam no Mac. Abra o Dexter nele e escolha Ajustes › Este Mac › Conectar aparelhos.",
                           "Your bots and conversations live on your Mac. Open Dexter there and choose Settings › This Mac › Connect devices."))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if pairing.publicReference != nil { savedConnectionContent }
                    if pairing.state != .outcomeUnknown {
                        Button { notice = nil; scanning = true } label: {
                            Label(t("Escanear QR do Mac", "Scan your Mac’s QR code"), systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity).padding(.vertical, 7)
                        }
                        .buttonStyle(.borderedProminent).disabled(busy)
                        .accessibilityIdentifier("ios-pairing.scan")
                        DisclosureGroup(t("Colar convite (avançado)", "Paste invitation (advanced)"), isExpanded: $advanced) {
                            VStack(alignment: .leading, spacing: 12) {
                                TextEditor(text: $pasted).font(.callout.monospaced()).frame(height: 110)
                                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                                    .accessibilityLabel(t("Convite privado recebido do Mac", "Private invitation from your Mac"))
                                    .accessibilityIdentifier("settings.paired-bundle")
                                Button(t("Revisar convite", "Review invitation")) { inspect(pasted); pasted = "" }
                                    .disabled(pasted.isEmpty || busy).accessibilityIdentifier("settings.import-pairing")
                            }.padding(.top, 12)
                        }.accessibilityIdentifier("ios-pairing.advanced")
                    }
                    Text(t("Use somente o QR mostrado no seu próprio Mac ou enviado pelo dono por um canal confiável.",
                           "Only use a QR code shown on your own Mac or sent privately by its owner."))
                        .font(.footnote).foregroundStyle(.secondary)
                    #if DEBUG
                    Button(t("Demonstração para desenvolvedores", "Developer demo")) { clearInvitation(); model.useFixture() }
                        .font(.footnote).accessibilityIdentifier("ios-pairing.developer-demo")
                    #endif
                }
                if let notice {
                    Label(notice, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("ios-pairing.notice")
                }
                if busy { ProgressView().accessibilityLabel(t("Conectando", "Connecting")) }
            }
            .frame(maxWidth: 480, alignment: .leading).padding(28).frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("ios-pairing.onboarding")
        .sheet(isPresented: $scanning) {
            PairingQRScannerSheet { code in scanning = false; inspect(code) }
        }
        .task(id: pollKey) {
            // Only reads a durable, acknowledged claim. Backgrounding/closing cancels this view's observer.
            guard scenePhase == .active, pairing.state == .pendingApproval else { return }
            while !Task.isCancelled, pairing.state == .pendingApproval {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard !Task.isCancelled else { return }
                await model.connectPairedHost()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { scanning = false; clearInvitation(); pasted = "" }
        }
        .onChange(of: pairing.state) { _, state in if state == .paired && model.canUseHost { dismiss() } }
        .onDisappear { clearInvitation(); pasted = ""; scanning = false }
        .interactiveDismissDisabled(busy)
    }

    private func reviewContent(_ value: PairingInvitationPreview) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(t("Conectar a este Mac?", "Connect to this Mac?")).font(.largeTitle.bold())
            Text(value.hostURL.host ?? value.hostURL.absoluteString).font(.headline)
                .textSelection(.enabled).accessibilityIdentifier("ios-pairing.review.host")
            Text(t("Ao conectar, este iPhone cria uma identidade privada local e pede aprovação ao Mac. Compare o código nos dois aparelhos antes de aprovar.",
                   "Connect creates this iPhone’s private local identity and asks your Mac to approve it. Compare the verification code on both devices before approving."))
                .foregroundStyle(.secondary)
            TextField(t("Nome deste iPhone", "This iPhone’s name"), text: $clientName)
                .textContentType(.nickname).textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("settings.paired-client-name")
            DisclosureGroup(t("Detalhes do convite", "Invitation details")) {
                VStack(alignment: .leading, spacing: 10) {
                    LabeledContent(t("Validade", "Expires"), value: value.expiresAt.formatted(date: .omitted, time: .shortened))
                    Text(value.hostFingerprint).font(.caption.monospaced()).textSelection(.enabled)
                    ForEach(value.scopes, id: \.self) { scope in
                        Text(DexterLocalization.text(PairingScopeCatalog.labelKey(scope.rawValue), locale: locale)).font(.callout)
                    }
                    Text(t("Conectar não concede permissões a nenhum bot.", "Connecting grants no permissions to any bot.")).font(.footnote)
                }.padding(.top, 10)
            }.accessibilityIdentifier("ios-pairing.review.details")
            Button(t("Conectar", "Connect")) { requestConnection() }
                .buttonStyle(.borderedProminent).disabled(busy || clientName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("ios-pairing.connect")
            Button(t("Voltar", "Back")) { clearInvitation(); notice = nil }.disabled(busy)
                .accessibilityIdentifier("ios-pairing.review.back")
        }.accessibilityIdentifier("ios-pairing.review")
    }

    private var approvalContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(t("Confirme no seu Mac", "Confirm on your Mac")).font(.largeTitle.bold())
            Text(t("No Dexter do Mac, abra o pedido deste iPhone e compare este código. A conexão só começa depois da sua aprovação.",
                   "Open this iPhone’s request in Dexter on your Mac and compare this code. The connection starts after you approve it."))
                .foregroundStyle(.secondary)
            if let fingerprint = pairing.publicReference?.clientFingerprint {
                Text(PairingVerificationCode.text(fingerprint)).font(.title2.monospaced().bold()).textSelection(.enabled)
                    .accessibilityIdentifier("settings.paired-verification-code")
            }
            ProgressView(t("Aguardando aprovação…", "Waiting for approval…"))
            checkButton
        }.accessibilityIdentifier("ios-pairing.pending-approval")
    }

    private var savedConnectionContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(connectionMessage, systemImage: pairing.state == .outcomeUnknown ? "exclamationmark.shield" : "wifi.slash")
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("ios-pairing.connection-state")
            checkButton
        }
    }
    private var connectionMessage: String {
        if pairing.invitationExpired { return t("Este convite expirou. Crie outro no Mac.", "This invitation expired. Create another on your Mac.") }
        return switch pairing.state {
        case .outcomeUnknown: t("O Mac precisa confirmar o resultado deste pedido. Confira nele se o convite foi usado ou cancelado; não envie outro pedido para repetir.", "Your Mac needs to confirm this request’s outcome. Check whether the invitation was used or cancelled there; do not submit another request to retry it.")
        case .revoked: t("O pedido foi recusado, expirou ou foi revogado. Crie um novo convite no Mac.", "The request was rejected, expired or revoked. Create a new invitation on your Mac.")
        case .identityMissing: t("A identidade local está ausente. Ela não será recriada automaticamente.", "The local identity is missing. It will not be recreated automatically.")
        case .identityLocked: t("Desbloqueie o iPhone para usar sua identidade local.", "Unlock your iPhone to use its local identity.")
        case .invalidMetadata: t("Os dados locais de conexão não puderam ser validados. Revise a conexão em Ajustes.", "The local connection data could not be validated. Review the connection in Settings.")
        default: t("Seu Mac ainda não está conectado. Verifique se o Dexter está aberto e se os aparelhos alcançam a mesma rede segura.", "Your Mac is not connected yet. Check that Dexter is open and both devices can reach the same secure network.")
        }
    }
    private var checkButton: some View {
        Button(t("Verificar conexão", "Check connection")) {
            busy = true
            Task { await model.connectPairedHost(); busy = false }
        }.disabled(busy).accessibilityIdentifier("settings.restore-pairing")
    }
    private func inspect(_ text: String) {
        clearInvitation(); notice = nil
        guard text.utf8.count <= PairingInvitationPreview.maximumBytes else {
            notice = t("O convite é grande demais. Peça um novo QR ao Mac.", "This invitation is too large. Ask your Mac for a new QR code."); return
        }
        let data = Data(text.utf8)
        do { review = try PairingInvitationPreview.inspect(data, platform: .clientIOS); invitation = data }
        catch ClientIdentityFailure.expired { notice = t("Este convite expirou. Crie outro no Mac.", "This invitation expired. Create another on your Mac.") }
        catch { notice = t("Este QR não é um convite válido do Dexter para iPhone.", "This QR code is not a valid Dexter invitation for iPhone.") }
    }
    private func requestConnection() {
        guard !busy, review != nil else { return }
        let data = invitation, name = clientName.trimmingCharacters(in: .whitespacesAndNewlines)
        clearInvitation(); busy = true; notice = nil
        Task {
            do { _ = try PairingInvitationPreview.inspect(data, platform: .clientIOS) }
            catch ClientIdentityFailure.expired {
                notice = t("Este convite expirou. Crie outro no Mac.", "This invitation expired. Create another on your Mac."); busy = false; return
            } catch {
                notice = t("O convite não pôde ser validado.", "The invitation could not be validated."); busy = false; return
            }
            guard model.importPairingInvitation(data) == .accepted else {
                notice = connectionMessage; busy = false; return
            }
            if pairing.state == .readyToProvision { await pairing.provisionIdentity() }
            guard pairing.state == .identityReady else { busy = false; return }
            await pairing.claim(name: name)
            // Approval is still a human decision on the Mac. This call only reads the status if a claim was acknowledged.
            if pairing.state == .pendingApproval { await model.connectPairedHost() }
            busy = false
        }
    }
    private func clearInvitation() { invitation = Data(); review = nil }
}
#endif
