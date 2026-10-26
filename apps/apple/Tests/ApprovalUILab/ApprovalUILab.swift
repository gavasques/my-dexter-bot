import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// TEST ONLY. Compile with the unmodified ChatView and its four UI dependencies.
/// The root owns the fresh synthetic host/runtime; this app never launches a host or an engine.
@main
struct ApprovalUILabApp: App {
    var body: some Scene {
        WindowGroup("Dexter D02 · sintético") {
            ApprovalUILabSurface().frame(minWidth: 620, minHeight: 520)
        }
        .defaultSize(width: 940, height: 720)
        .windowResizability(.contentSize)
    }
}

@MainActor
private final class ApprovalUILabMemory: DexterAppStateStorage {
    private var bytes: Data?
    func readData() -> Data? { bytes }
    func writeData(_ data: Data) { bytes = data }
    func removeData() { bytes = nil }
}

private struct ApprovalUILabSurface: View {
    @State private var model: DexterAppModel?
    @State private var generation: UInt64?
    @State private var threadID = ""
    @State private var notice = "Verificando a identidade do host sintético…"
    @State private var accessibilityAudit: String?
    private let pasteboard = NSPasteboard.withUniqueName()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("QA D02 · host/driver sintéticos · sem conta pessoal").font(.caption)
                Spacer()
                if let model {
                    Button("Atualizar dados sintéticos") { Task { await model.refresh() } }
                        .accessibilityIdentifier("qa.d02.refresh")
                    Button("Conferir IDs AX", action: auditAccessibility)
                        .accessibilityIdentifier("qa.d02.ax-audit")
                    Text("\(model.actions(for: threadID).count) ações carregadas").font(.caption)
                }
            }.padding(8)
            if let accessibilityAudit {
                Text(verbatim: accessibilityAudit).font(.caption).textSelection(.enabled)
                    .accessibilityIdentifier("qa.d02.ax-audit.result")
            }
            Divider()
            if let model, let generation {
                ChatView(threadID: threadID, presentationGeneration: generation, composerPasteboard: pasteboard)
                    .environment(model)
                    .environment(\.chatCopyPasteboard, pasteboard)
            } else {
                Text(notice).padding().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await prepare() }
    }

    /// Read only, scoped to this fixture's own window. Run manually in the next GUI review.
    /// Building the fixture does not execute this audit or certify the SwiftUI AX tree.
    private func auditAccessibility() {
        guard let model, let root = NSApp.keyWindow?.contentView else {
            accessibilityAudit = "AX não consultável: abra a janela do fixture."
            return
        }
        var found: Set<String> = []
        var values: [String: String] = [:]
        var visited: Set<ObjectIdentifier> = []
        func collect(_ object: AnyObject, depth: Int) {
            guard depth < 80, visited.insert(ObjectIdentifier(object)).inserted,
                  let element = object as? any NSAccessibilityProtocol else { return }
            if let id = element.accessibilityIdentifier(), !id.isEmpty {
                found.insert(id)
                if let text = element.accessibilityValue() as? String { values[id] = text }
                else if let text = element.accessibilityValue() as? NSAttributedString { values[id] = text.string }
            }
            for child in element.accessibilityChildren() ?? [] { collect(child as AnyObject, depth: depth + 1) }
        }
        collect(root, depth: 0)
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        let actions = model.actions(for: threadID)
        let pending = actions.filter { ApprovalPresentation(action: $0).needsDecision(atMilliseconds: now) }
        let resolved = actions.filter { ApprovalPresentation(action: $0).isHistorical(atMilliseconds: now) }
        // One compact pending card: position/navigation only with several approvals; details behind Ver ação.
        var required = pending.isEmpty ? [] : ["approval.queue", "approval.review", "approval.decision-bar"]
        if let latest = resolved.max(by: { ($0.updatedAt, $0.id) < ($1.updatedAt, $1.id) }) {
            required += ["approval.summary.\(latest.id)", "approval.inspect.\(latest.id)"]
        }
        if resolved.count > 1 { required += ["chat.action-history"] }
        if pending.count > 1 { required += ["approval.position", "approval.previous", "approval.next"] }
        if let visible = pending.first(where: { found.contains("approval.allow.\($0.id)") }) {
            required += ["approval.allow.\(visible.id)", "approval.deny.\(visible.id)", "approval.compact.\(visible.id)",
                "approval.compact.title.\(visible.id)", "approval.compact.scope.\(visible.id)",
                "approval.summary.\(visible.id)", "approval.inspect.\(visible.id)"]
        } else if !pending.isEmpty {
            required += ["approval.allow.<candidata>", "approval.deny.<candidata>"]
        }
        let missing = required.filter { !found.contains($0) }
        var mismatches: [String] = []
        for action in actions {
            let presentation = ApprovalPresentation(action: action)
            for (id, expected) in [("approval.arguments.\(action.id)", presentation.formattedArguments),
                ("approval.hash.\(action.id)", presentation.requestHash)] where found.contains(id) {
                if values[id] != expected { mismatches.append(id) }
            }
            if found.contains("approval.summary.\(action.id)"), !pending.contains(action) {
                let id = "approval.inspect.\(action.id)"
                if !found.contains(id) { mismatches.append(id) }
            }
        }
        accessibilityAudit = "AX: " + (missing.isEmpty ? "IDs consultados presentes." : "IDs ausentes: " + missing.joined(separator: ", "))
            + (mismatches.isEmpty ? "" : " Valores/folhas divergentes: " + mismatches.joined(separator: ", "))
            + (pending.isEmpty ? " Sem candidata vigente." : "")
            + " Abra Ver ação para conferir JSON e hash; expanda o histórico para conferir suas folhas."
    }

    private func prepare() async {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["DEXTER_P0_D02_HOST"], let url = URL(string: address),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port,
              port != 4317, port != 4318, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              let expectedHost = env["DEXTER_P0_D02_HOST_ID"], !expectedHost.isEmpty,
              let bot = env["DEXTER_P0_D02_BOT"], !bot.isEmpty,
              let thread = env["DEXTER_P0_D02_THREAD"], !thread.isEmpty else {
            notice = "Fixture bloqueado: defina o host loopback temporário, sua identidade, bot e conversa sintéticos."
            return
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let client = HostClient(baseURL: url, transport: URLSessionTransport(session: URLSession(configuration: configuration)))
        do {
            // No bot/message fetch occurs until the root's newly created host identity matches.
            let health = try await client.health()
            guard health.hostId == expectedHost, health.mode == "local-development" else {
                await client.close().value
                notice = "Fixture bloqueado: a identidade do host não corresponde à base sintética preparada."
                return
            }
            let candidate = DexterAppModel(client: client, storage: ApprovalUILabMemory())
            await candidate.refresh()
            guard candidate.isOnline, candidate.bots.contains(where: { $0.id == bot }),
                  candidate.threads(for: bot).contains(where: { $0.id == thread }) else {
                await client.close().value
                notice = "Fixture bloqueado: o host não devolveu o bot e a conversa preparados."
                return
            }
            candidate.selectBot(id: bot)
            guard let next = candidate.presentThread(thread, for: bot) else {
                await client.close().value
                notice = "Fixture bloqueado: não foi possível apresentar a conversa sintética."
                return
            }
            threadID = thread
            model = candidate
            generation = next
        } catch {
            await client.close().value
            notice = "Fixture indisponível: confira o host temporário preparado pelo root."
        }
    }
}
