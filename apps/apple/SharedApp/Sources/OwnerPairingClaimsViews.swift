#if os(macOS)
import AppKit
import DexterAppCore
import DexterClientIdentity
import DexterHostClient
import SwiftUI

/// Opens one `OwnerPairingClaimsSession` for the window's base and drops it when the base changes or the sheet closes.
@MainActor @Observable final class OwnerPairingClaimsHolder {
    private(set) var session: OwnerPairingClaimsSession?
    private(set) var attemptedScope: String?

    func open(_ model: DexterAppModel) async {
        let scope = model.pairingOfferScope
        if session?.scope == scope { return }
        session?.close()
        session = model.makeOwnerPairingClaimsSession()
        attemptedScope = scope
        await session?.editor.reload()
    }

    func close() { session?.close(); session = nil; attemptedScope = nil }
}

/// Ajustes › Este Mac › Conectar aparelhos: the entry to the requests of devices that used one of this base's invitations.
struct OwnerPairingClaimsEntry: View {
    @Environment(DexterAppModel.self) private var model
    @State private var presenting = false

    var body: some View {
        if model.canEditBotProfiles {
            Button("Pedidos de aparelhos…") { presenting = true }
                .accessibilityIdentifier("settings.pairing-claims.open")
                .sheet(isPresented: $presenting) { OwnerPairingClaimsSheet(focusOfferRequestID: nil) }
            Text("Depois que o outro aparelho usa o convite, você aprova ou recusa o pedido aqui. Compare o código de verificação antes.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// "Pedidos de aparelhos": the base's real pending requests. Each is reviewed as it is (name as an unconfirmed label, kind,
/// device type, exact permissions, verification code) and decided by the owner's own gesture through the controller. An
/// unknown outcome is settled only by reading (Conferir); repeating the same decision is a separate, confirmed gesture.
struct OwnerPairingClaimsSheet: View {
    /// The invitation just used (opened from the invitation sheet): its request is shown first and opened for review.
    let focusOfferRequestID: String?
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var holder = OwnerPairingClaimsHolder()
    @State private var selectedID: String?
    @State private var focusApplied = false
    @State private var confirmApprove = false
    @State private var confirmReject = false
    @State private var confirmRetry = false
    /// Set when the last decision was refused before anything was applied (the controller re-read and cleared its notice).
    @State private var refusedNotice = false

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Pedidos de aparelhos").font(.title2.weight(.semibold))
                Text("Aprove só aparelhos que você conhece. Aprovar não dá permissão a nenhum bot.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let session = holder.session, session.scope == model.pairingOfferScope {
                        content(session.editor)
                    } else if holder.attemptedScope == model.pairingOfferScope {
                        Label("Pedidos só podem ser decididos na base deste Mac.", systemImage: "lock")
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(22)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack {
                Spacer()
                Button("Concluir") { dismiss() }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("owner-pairing-claims.close")
            }
            .padding(14)
        }
        // Fits inside the Settings window and on top of the invitation sheet; the content scrolls.
        .frame(width: 580).frame(minHeight: 400, idealHeight: 470)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-claims.sheet")
        .task(id: model.pairingOfferScope) {
            await holder.open(model)
            applyFocus()
        }
        .onDisappear { holder.close() }
    }

    /// Opens the request tied to the invitation the owner came from, once, if the base lists it.
    private func applyFocus() {
        guard !focusApplied, let focusOfferRequestID, let editor = holder.session?.editor else { return }
        focusApplied = true
        selectedID = editor.claims.first { $0.offerClientRequestId == focusOfferRequestID }?.claimId
    }

    @ViewBuilder private func content(_ editor: OwnerPairingClaimsEditor) -> some View {
        statusBlock(editor)
        resultBlock(editor)
        if let list = editor.list, list.availability == .available {
            if let selectedID, let claim = editor.claims.first(where: { $0.claimId == selectedID }) {
                detail(claim, editor: editor)
            } else {
                listBlock(editor)
            }
        }
    }

    // MARK: Status

    @ViewBuilder private func statusBlock(_ editor: OwnerPairingClaimsEditor) -> some View {
        Group {
            if let list = editor.list {
                if list.availability == .available {
                    HStack {
                        Text(verbatim: list.items.isEmpty ? t("Nenhum pedido esperando.")
                             : list.items.count == 1 ? t("1 pedido esperando você.")
                             : String(format: t("%@ pedidos esperando você."), locale: locale, String(list.items.count)))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Atualizar") { refusedNotice = false; Task { await editor.reload() } }
                            .disabled(editor.busy)
                            .accessibilityIdentifier("owner-pairing-claims.reload")
                    }
                    if list.truncated {
                        Text("Há mais pedidos do que esta lista mostra. Decida estes e atualize.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(t(OwnerPairingClaimsPresentation.reasonKey(list.reason)), systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                        if list.reason == .channelUnconfigured {
                            Text("Para receber pedidos, a base deste Mac precisa ser iniciada com a conexão segura para outros aparelhos. Esta versão do app ainda não inicia a base assim; nada é simulado no lugar.")
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Button("Atualizar") { Task { await editor.reload() } }
                            .disabled(editor.busy)
                            .accessibilityIdentifier("owner-pairing-claims.reload")
                    }
                }
            } else if let notice = editor.notice {
                VStack(alignment: .leading, spacing: 8) {
                    Label(t(OwnerPairingClaimsPresentation.noticeKey(notice)), systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Button("Tentar de novo") { Task { await editor.reload() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("owner-pairing-claims.reload")
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-claims.status")
    }

    // MARK: Outcome

    @ViewBuilder private func resultBlock(_ editor: OwnerPairingClaimsEditor) -> some View {
        if editor.pendingDecision != nil {
            VStack(alignment: .leading, spacing: 8) {
                Label(t(OwnerPairingClaimsPresentation.noticeKey(.outcomeUnknown)), systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Button("Conferir") { Task { await editor.settlePending() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("owner-pairing-claims.confirm")
                    Button("Repetir a mesma decisão…") { confirmRetry = true }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("owner-pairing-claims.retry-exact")
                    Button("Desistir") { editor.abandonPendingDecision() }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("owner-pairing-claims.abandon")
                }
                Text("Conferir só lê a base. Se você desistir, o pedido continua na lista com o estado verdadeiro.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("owner-pairing-claims.uncertain")
            .confirmationDialog(Text("Repetir exatamente a mesma decisão?"), isPresented: $confirmRetry, titleVisibility: .visible) {
                Button("Repetir a mesma decisão") { Task { await editor.retryPendingDecision() } }
                Button("Cancelar", role: .cancel) {}
            } message: {
                Text("É a mesma decisão, com o mesmo identificador. Se a base já a aplicou, ela devolve o mesmo resultado; nada é decidido duas vezes.")
            }
        } else if refusedNotice {
            Label(t(OwnerPairingClaimsPresentation.noticeKey(.conflict)), systemImage: "arrow.clockwise")
                .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("owner-pairing-claims.notice")
        } else if let notice = editor.notice, editor.list != nil {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: t(OwnerPairingClaimsPresentation.noticeKey(notice)))
                    .font(.callout)
                    .foregroundStyle(isCalm(notice) ? Color.secondary : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                if case .decided = notice, let claim = editor.lastDecision?.receipt.claim {
                    Text(verbatim: "\(t(OwnerPairingOfferPresentation.roleKey(claim.role))) · “\(claim.name)”")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("owner-pairing-claims.notice")
        }
    }

    private func isCalm(_ notice: OwnerPairingClaimsEditor.Notice) -> Bool {
        if case .decided(let outcome) = notice { return outcome == .approved || outcome == .rejected || outcome == .notApplied }
        return false
    }

    // MARK: List

    private func listBlock(_ editor: OwnerPairingClaimsEditor) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(OwnerPairingClaimsPresentation.ordered(editor.claims, focusOfferRequestID: focusOfferRequestID)) { claim in
                Button { selectedID = claim.claimId } label: {
                    HStack(spacing: 12) {
                        Image(systemName: claim.role == .clientIOS ? "iphone" : "laptopcomputer")
                            .font(.title3).foregroundStyle(.tint).frame(width: 26).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: "\(t(OwnerPairingOfferPresentation.roleKey(claim.role))) · \(t(OwnerPairingClaimsPresentation.kindKey(claim.kind)))")
                            Text(verbatim: "“\(claim.name)” · \(t("nome informado pelo aparelho"))")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text("Revisar").foregroundStyle(.tint)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
                    }
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("owner-pairing-claims.claim.\(claim.claimId)")
                Divider()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-claims.list")
    }

    // MARK: Review

    private func detail(_ claim: OwnerPairingClaim, editor: OwnerPairingClaimsEditor) -> some View {
        let code = OwnerPairingClaimsPresentation.verificationCode(claim.clientFingerprint)
        return VStack(alignment: .leading, spacing: 14) {
            Button { selectedID = nil } label: { Label("Todos os pedidos", systemImage: "chevron.backward") }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("owner-pairing-claims.back")
            VStack(alignment: .leading, spacing: 4) {
                Text("Nome informado pelo aparelho").font(.headline)
                Text(verbatim: "“\(claim.name)”").font(.title3)
                    .accessibilityIdentifier("owner-pairing-claims.detail.name")
                Text("Qualquer um pode escrever esse nome. O que identifica o aparelho é o código de verificação.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                GridRow {
                    Text("Tipo").foregroundStyle(.secondary)
                    Text(verbatim: t(OwnerPairingOfferPresentation.roleKey(claim.role)))
                }
                GridRow {
                    Text("Pedido").foregroundStyle(.secondary)
                    Text(verbatim: t(OwnerPairingClaimsPresentation.kindKey(claim.kind)))
                }
                GridRow {
                    Text("Situação").foregroundStyle(.secondary)
                    Text(verbatim: t(OwnerPairingClaimsPresentation.statusKey(claim.status)))
                }
                GridRow {
                    Text("Vale até").foregroundStyle(.secondary)
                    Text(verbatim: time(claim.expiresAt))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("owner-pairing-claims.detail.facts")
            VStack(alignment: .leading, spacing: 6) {
                Text("Código de verificação").font(.headline)
                Text(verbatim: code)
                    .font(.system(.title3, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityLabel(Text("Código de verificação"))
                    .accessibilityValue(Text(verbatim: code.replacingOccurrences(of: "\n", with: " ")))
                    .accessibilityIdentifier("owner-pairing-claims.detail.code")
                Text("No outro aparelho, abra Conectar a outra base: o mesmo código aparece lá. Só aprove se for igual do começo ao fim.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("O que o aparelho poderá fazer").font(.headline)
                ForEach(PairingScopeCatalog.rows(for: claim.scopes), id: \.scope) { row in
                    Label {
                        Text(verbatim: t(PairingScopeCatalog.labelKey(row.scope)))
                            .foregroundStyle(row.included ? Color.primary : Color.secondary)
                    } icon: {
                        Image(systemName: row.included ? "checkmark.circle.fill" : "minus.circle")
                            .foregroundStyle(row.included ? Color.green : Color.secondary)
                    }
                    .font(.callout)
                    .accessibilityValue(Text(row.included ? "Incluída" : "Não incluída"))
                    .accessibilityIdentifier("owner-pairing-claims.detail.scope.\(row.scope)")
                }
                Text("Essas permissões vieram do convite. Aprovar não muda nenhuma delas nem dá permissão a nenhum bot.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Spacer()
                Button("Recusar…", role: .destructive) { confirmReject = true }
                    .disabled(!editor.canDecide || claim.status != .pending)
                    .accessibilityIdentifier("owner-pairing-claims.reject")
                Button("Aprovar…") { confirmApprove = true }
                    .buttonStyle(.borderedProminent)
                    .disabled(!editor.canDecide || claim.status != .pending)
                    .accessibilityIdentifier("owner-pairing-claims.approve")
            }
        }
        .padding(14)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("owner-pairing-claims.detail")
        .confirmationDialog(Text("Aprovar este aparelho?"), isPresented: $confirmApprove, titleVisibility: .visible) {
            Button("Aprovar") { decide { await editor.approve(claim) } }
                .accessibilityIdentifier("owner-pairing-claims.approve.confirm")
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text(verbatim: String(format: t("Esse aparelho passa a usar esta base com as permissões mostradas. Confira o código mais uma vez:\n%@"), locale: locale, code))
        }
        .confirmationDialog(Text("Recusar este pedido?"), isPresented: $confirmReject, titleVisibility: .visible) {
            Button("Recusar", role: .destructive) { decide { await editor.reject(claim) } }
                .accessibilityIdentifier("owner-pairing-claims.reject.confirm")
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Esse aparelho não entra nesta base. Para tentar de novo, ele precisa de um convite novo.")
        }
    }

    /// One owner decision through the controller; back to the list once the outcome is known (still shown above).
    private func decide(_ action: @escaping @MainActor () async -> Void) {
        guard let editor = holder.session?.editor else { return }
        let previous = editor.lastDecision?.receipt.clientRequestId
        refusedNotice = false
        Task {
            await action()
            refusedNotice = OwnerPairingClaimsPresentation.nothingDecided(editor, previousReceiptRequestID: previous)
            if editor.pendingDecision == nil { selectedID = nil }
        }
    }

    private func time(_ milliseconds: Int64) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened); style.locale = locale
        return Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000).formatted(style)
    }
}
#endif
