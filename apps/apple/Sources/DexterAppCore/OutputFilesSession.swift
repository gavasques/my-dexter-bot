#if os(macOS)
import DexterHostClient
import Foundation

/// One window's view of the output folders of ONE base, captured when it was opened (Arquivos UI).
/// This Mac's owner base gets its own short-lived loopback client (closed with the session); a paired base (VPS) uses
/// the model's paired client, which this session never closes. A session is never re-pointed: when the base, the host
/// generation or the window scope changes, the UI drops it and opens a new one.
@MainActor public final class OutputFilesSession {
    public let editor: OutputFilesEditor
    /// `DexterAppModel.filesScope` at creation; the UI compares it before showing anything.
    public let scope: String
    private let client: HostClient
    private let ownsClient: Bool
    private var closed = false

    public init(base: OutputFilesBase, client: HostClient, ownsClient: Bool, scope: String) {
        self.editor = OutputFilesEditor(base: base, client: client)
        self.client = client; self.ownsClient = ownsClient; self.scope = scope
    }

    public var base: OutputFilesBase { editor.base }

    /// Pinned item of one file of THIS base (read scope). The host id must be the one the editor already accepted.
    public func item(namespace: OutputNamespaceRef, path: String, generation: Int?) async -> OutputItem? {
        guard !closed, editor.canBrowse, let hostID = editor.status?.hostId else { return nil }
        guard let item = try? await client.outputItem(generation: generation, namespace: namespace, path: path),
              item.hostId == hostID else { return nil }
        return item
    }

    public func close() {
        guard !closed else { return }
        closed = true
        if ownsClient { client.close() }
    }
}

/// Words and grouping for the output folders UI. Display only; every decision stays with the editor and the host.
public enum OutputFilesPresentation {
    /// Portuguese catalog key of where new files go.
    public static func locationKindKey(_ kind: OutputLocationKind) -> String {
        switch kind {
        case .hostDataLegacy: "Pastas internas da base"
        case .hostDataDefault: "Pasta de saídas da base"
        case .ownerPath: "Pasta escolhida por você"
        }
    }

    public static func availabilityKey(_ availability: OutputLocationAvailability) -> String? {
        switch availability {
        case .available: nil
        case .notCreated: "A pasta ainda não foi criada; ela aparece com o primeiro arquivo."
        case .missing: "A pasta não foi encontrada na base."
        case .replaced: "A pasta foi trocada por outra coisa no disco da base; nada é lido dela."
        case .unsafe: "A pasta não é segura (link ou permissão); nada é lido dela."
        case .unreadable: "A base não consegue ler esta pasta."
        }
    }

    /// The general folder exists only after the owner chose a folder (layout v1); before that bots and teams keep
    /// their own internal folders.
    public static func hasGeneralFolder(_ location: OutputLocation) -> Bool { location.layout == .v1 && location.namespaces.general }

    public struct Sections: Equatable, Sendable {
        public var general: OutputNamespace?
        public var bots: [OutputNamespace]
        public var teams: [OutputNamespace]
    }

    /// Only what the host lists, sorted by its display label. Nothing is derived from groups, membership or identity.
    public static func sections(_ namespaces: [OutputNamespace]) -> Sections {
        func sorted(_ items: [OutputNamespace]) -> [OutputNamespace] {
            items.sorted { ($0.label ?? $0.id ?? "", $0.identifier) < ($1.label ?? $1.id ?? "", $1.identifier) }
        }
        return Sections(general: namespaces.first { $0.kind == .general },
                        bots: sorted(namespaces.filter { $0.kind == .bot }),
                        teams: sorted(namespaces.filter { $0.kind == .team }))
    }

    /// One namespace only (bot or team settings); never another bot's, a group's or the general folder.
    public static func only(_ ref: OutputNamespaceRef, in namespaces: [OutputNamespace]) -> OutputNamespace? {
        namespaces.first { $0.ref == ref }
    }

    /// Portuguese catalog key of an editor notice for this base.
    public static func noticeKey(_ notice: OutputFilesEditor.Notice, base: OutputFilesBase) -> String {
        switch notice {
        case .loadFailed: "Não foi possível ler as pastas de arquivos desta base."
        case .baseOffline: base == .thisMac ? "A base deste Mac não está respondendo agora." : "A outra base está offline. Nada é mostrado deste Mac no lugar dela."
        case .remoteBrowsingUnavailable: "Este app não tem permissão para ver as pastas da outra base. Peça ao dono um convite com \"Ver e baixar arquivos\"."
        case .hostChanged: "A base mudou enquanto você olhava. Feche e abra de novo."
        case .conflict: "A pasta mudou na base. Os dados foram relidos; nada foi reenviado."
        case .invalidFolder: "A base recusou essa pasta. Escolha uma pasta que a base possa usar."
        case .destinationUnknown: "Não foi possível confirmar a troca da pasta. Use Conferir; nada foi reenviado."
        case .destinationSaved: "Pasta trocada. Só os arquivos novos vão para ela; nada foi movido."
        case .exportFailed: "Não foi possível baixar o arquivo. Nada ficou pela metade no seu Mac."
        }
    }
}
#endif
