#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI

/// Opens one `OutputFilesSession` for the window's current base and drops it when the base changes or the view leaves.
@MainActor @Observable final class OutputFilesSessionHolder {
    private(set) var session: OutputFilesSession?
    /// The scope of the last open attempt; with no session it means the base could not be reached for this window.
    private(set) var attemptedScope: String?

    func open(_ model: DexterAppModel) async {
        let scope = model.filesScope
        if session?.scope == scope { return }
        session?.close()
        session = model.makeOutputFilesSession()
        attemptedScope = scope
        await session?.editor.reload()
    }

    func close() { session?.close(); session = nil; attemptedScope = nil }

    /// Plain words when this window's base exists but no session could be opened (never this Mac in its place).
    func unreachableKey(_ model: DexterAppModel) -> String? {
        guard session == nil, attemptedScope == model.filesScope, let base = model.outputFilesBase else { return nil }
        return OutputFilesPresentation.noticeKey(.baseOffline, base: base)
    }
}

/// Ajustes › Geral › Arquivos gerados: where new files go on this base, the files themselves, and the owner's choice of
/// folder. Only new files follow a new folder; nothing is moved or copied.
struct OutputFilesSettingsSection: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var holder = OutputFilesSessionHolder()
    @State private var browsing = false
    @State private var pendingChoice: OutputDestination?
    @State private var remotePathSheet = false

    var body: some View {
        Section {
            if let session = holder.session, session.scope == model.filesScope {
                content(session)
            } else if let unreachable = holder.unreachableKey(model) {
                Label(DexterLocalization.text(unreachable, locale: locale), systemImage: "wifi.slash")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.files.unreachable")
            } else if model.outputFilesBase == nil {
                Text("Sem base conectada. Os arquivos gerados pelos bots aparecem aqui quando o app estiver ligado a uma base.")
                    .font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.files.no-base")
            } else {
                ProgressView().controlSize(.small)
            }
        } header: {
            Text("Arquivos gerados").accessibilityIdentifier("settings.files")
        } footer: {
            Text("Os bots guardam aqui o que criam com as ferramentas de arquivos. Conversas em grupo não criam arquivos.")
        }
        .task(id: model.filesScope) { await holder.open(model) }
        .onDisappear { holder.close() }
        .sheet(isPresented: $browsing) {
            if let session = holder.session { OutputFilesBrowserSheet(session: session, fixed: nil) }
        }
        .sheet(isPresented: $remotePathSheet) {
            if let session = holder.session {
                OutputFilesRemotePathSheet { path in pendingChoice = .ownerPath(path) }
                    .environment(\.locale, locale)
                    .id(session.scope)
            }
        }
        .confirmationDialog(Text("Trocar a pasta dos arquivos novos?"), isPresented: Binding(get: { pendingChoice != nil }, set: { if !$0 { pendingChoice = nil } }),
                            titleVisibility: .visible) {
            Button("Trocar a pasta") {
                guard let choice = pendingChoice, let session = holder.session else { return }
                pendingChoice = nil
                Task { await session.editor.chooseDestination(choice) }
            }
            .accessibilityIdentifier("settings.files.confirm-choose")
            Button("Cancelar", role: .cancel) { pendingChoice = nil }
        } message: {
            Text("Só os arquivos novos vão para a pasta escolhida. Os arquivos atuais ficam onde estão e continuam em Pastas anteriores. Nada é movido nem copiado.")
        }
    }

    @ViewBuilder private func content(_ session: OutputFilesSession) -> some View {
        let editor = session.editor
        if !editor.canBrowse {
            Label(DexterLocalization.text(OutputFilesPresentation.noticeKey(.remoteBrowsingUnavailable, base: session.base), locale: locale),
                  systemImage: "lock")
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.files.scope-unavailable")
        } else if let status = editor.status {
            LabeledContent {
                Text(verbatim: status.current.kind == .ownerPath ? status.current.path : DexterLocalization.text(OutputFilesPresentation.locationKindKey(status.current.kind), locale: locale))
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    .help(status.current.path)
            } label: {
                Text("Arquivos novos vão para")
            }
            .accessibilityIdentifier("settings.files.location")
            if let warning = OutputFilesPresentation.availabilityKey(status.current.availability) {
                let routine = status.current.availability == .notCreated
                Label(DexterLocalization.text(warning, locale: locale), systemImage: routine ? "info.circle" : "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(routine ? Color.secondary : Color.orange)
                    .accessibilityIdentifier("settings.files.availability")
            }
            if session.base != .thisMac {
                Text("Estes arquivos estão na outra base. Você pode ver e baixar; o Finder deste Mac não abre a pasta de lá.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                Button("Ver arquivos…") { browsing = true }
                    .accessibilityIdentifier("settings.files.open")
                if case .revealInFinder(let url) = editor.access(location: status.current) {
                    Button("Mostrar no Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                        .accessibilityIdentifier("settings.files.reveal")
                }
                Spacer()
                if editor.busy { ProgressView().controlSize(.small) }
                if editor.canManageDestination {
                    Menu("Escolher pasta…") {
                        if session.base == .thisMac {
                            Button("Escolher uma pasta neste Mac…") { chooseLocalFolder() }
                                .accessibilityIdentifier("settings.files.choose.local")
                        } else {
                            Button("Informar um caminho na outra base…") { remotePathSheet = true }
                                .accessibilityIdentifier("settings.files.choose.remote")
                        }
                        if status.current.kind != .hostDataDefault {
                            Button("Usar a pasta de saídas da base") { pendingChoice = .hostDataDefault }
                                .accessibilityIdentifier("settings.files.choose.default")
                        }
                    }
                    .fixedSize()
                    .disabled(!editor.canChooseDestination)
                    .accessibilityIdentifier("settings.files.choose")
                }
            }
            if editor.pendingDestination != nil {
                HStack {
                    Label(DexterLocalization.text(OutputFilesPresentation.noticeKey(.destinationUnknown, base: session.base), locale: locale),
                          systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                    Spacer()
                    Button("Conferir") { Task { await editor.settlePending() } }
                        .disabled(editor.busy)
                        .accessibilityIdentifier("settings.files.check")
                }
            } else if let notice = editor.notice {
                Text(verbatim: DexterLocalization.text(OutputFilesPresentation.noticeKey(notice, base: session.base), locale: locale))
                    .font(.callout).foregroundStyle(notice == .destinationSaved ? Color.secondary : Color.orange)
                    .accessibilityIdentifier("settings.files.notice")
            }
            if !editor.canManageDestination && session.base != .thisMac {
                Text("Este app pode ver, mas não mudar, a pasta de arquivos da outra base.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        } else if let notice = editor.notice {
            Label(DexterLocalization.text(OutputFilesPresentation.noticeKey(notice, base: session.base), locale: locale), systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityIdentifier("settings.files.notice")
            Button("Tentar de novo") { Task { await editor.reload() } }
                .disabled(editor.busy)
                .accessibilityIdentifier("settings.files.reload")
        } else {
            ProgressView().controlSize(.small)
        }
    }

    /// The owner's own gesture picks a folder on this Mac; the base later says whether it can use it.
    private func chooseLocalFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false; panel.resolvesAliases = false
        panel.prompt = DexterLocalization.text("Usar esta pasta", locale: locale)
        panel.message = DexterLocalization.text("Escolha onde a base deste Mac guarda os arquivos novos dos bots.", locale: locale)
        guard panel.runModal() == .OK, let url = panel.url, url.isFileURL else { return }
        pendingChoice = .ownerPath(url.standardizedFileURL.path)
    }
}

/// A folder path on the OTHER base (typed by the owner); the base validates it. Nothing on this Mac is opened.
struct OutputFilesRemotePathSheet: View {
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""

    private var valid: Bool { path.hasPrefix("/") && !path.contains("..") && path.utf8.count <= 1024 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pasta na outra base").font(.title3.weight(.semibold))
            Text("Informe o caminho completo de uma pasta na outra base (por exemplo, /home/voce/saidas). A base confere se pode usar a pasta.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("/caminho/da/pasta", text: $path)
                .textFieldStyle(.roundedBorder).font(.body.monospaced())
                .accessibilityLabel(Text("Caminho da pasta na outra base"))
                .accessibilityIdentifier("settings.files.remote-path")
            HStack {
                Spacer()
                Button("Cancelar") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Continuar") { choose(path); dismiss() }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent).disabled(!valid)
                    .accessibilityIdentifier("settings.files.remote-path.continue")
            }
        }
        .padding(22).frame(width: 460)
    }
}

/// Files of one base: Geral, Bots and Times as the host lists them (current folder or an earlier one), or ONE namespace
/// when opened from a bot's or a team's settings. Finder only for this Mac's own base; elsewhere, Baixar.
struct OutputFilesBrowserSheet: View {
    let session: OutputFilesSession
    /// Bot or team settings: only this namespace, never another bot's, a group's or the general folder.
    let fixed: OutputNamespaceRef?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    @State private var selection: OutputNamespaceRef?
    @State private var path = "."
    @State private var generation: Int?
    @State private var downloading: String?
    @State private var lastDownload: String?

    private var editor: OutputFilesEditor { session.editor }
    private var shownGeneration: Int? { generation ?? editor.status?.current.generation }
    private var location: OutputLocation? {
        let target = editor.browsing?.generation ?? shownGeneration
        return editor.locations.first { $0.generation == target } ?? editor.status?.current
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            HStack(spacing: 0) {
                if fixed == nil {
                    sidebar.frame(width: 230)
                    Divider()
                }
                detail.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            Divider()
            HStack {
                if let lastDownload {
                    Label(lastDownload, systemImage: "checkmark.circle").font(.callout).foregroundStyle(.secondary)
                        .accessibilityIdentifier("files.download.done")
                } else if let notice = editor.notice, notice != .destinationSaved {
                    Label(DexterLocalization.text(OutputFilesPresentation.noticeKey(notice, base: session.base), locale: locale),
                          systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.orange)
                        .accessibilityIdentifier("files.notice")
                }
                Spacer()
                Button("Concluir") { dismiss() }.keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("files.close")
            }
            .padding(14)
        }
        .frame(minWidth: fixed == nil ? 760 : 560, minHeight: 460)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("files.sheet")
        .task {
            if editor.status == nil { await editor.reload() }
            if let fixed { await open(fixed) }
        }
    }

    /// Title and, when the owner changed folders before, the folder being shown (current or an earlier one).
    private var topBar: some View {
        HStack(spacing: 10) {
            Text(verbatim: fixed.map { title(of: $0) } ?? DexterLocalization.text("Arquivos gerados", locale: locale))
                .font(.title3.weight(.semibold)).lineLimit(1)
            Spacer()
            if editor.locations.count > 1 {
                Menu {
                    ForEach(editor.locations.sorted { $0.generation > $1.generation }) { location in
                        Button { Task { await show(generation: location.generation) } } label: {
                            if location.generation == shownGeneration { Label(generationLabel(location), systemImage: "checkmark") }
                            else { Text(verbatim: generationLabel(location)) }
                        }
                    }
                } label: {
                    Text(verbatim: editor.locations.first { $0.generation == shownGeneration }.map(generationLabel) ?? "")
                }
                .fixedSize()
                .disabled(editor.busy)
                .help(Text("Pastas anteriores continuam com os arquivos que já estavam nelas."))
                .accessibilityLabel(Text("Pasta"))
                .accessibilityIdentifier("files.generation")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private var sections: OutputFilesPresentation.Sections { OutputFilesPresentation.sections(editor.namespaces) }

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let general = sections.general, general.exists {
                    sidebarHeader("Geral")
                    row(general, title: DexterLocalization.text("Pasta geral", locale: locale), symbol: "folder")
                }
                if !sections.bots.isEmpty {
                    sidebarHeader("Bots")
                    ForEach(sections.bots) { row($0, title: $0.label ?? $0.id ?? "", symbol: "person.crop.circle") }
                }
                if !sections.teams.isEmpty {
                    sidebarHeader("Times")
                    ForEach(sections.teams) { row($0, title: $0.label ?? $0.id ?? "", symbol: "person.2") }
                }
                if sections.general == nil && sections.bots.isEmpty && sections.teams.isEmpty {
                    Text(editor.busy ? "Carregando…" : "Nenhum bot ou time criou arquivos nesta pasta ainda.")
                        .font(.callout).foregroundStyle(.secondary).padding(8)
                }
            }
            .padding(10)
        }
        .background(.background.secondary)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("files.namespaces")
    }

    private func sidebarHeader(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.top, 8).padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    /// One namespace as a plain button (keyboard, VoiceOver and pointer alike); the open one is highlighted.
    private func row(_ namespace: OutputNamespace, title: String, symbol: String) -> some View {
        let note: LocalizedStringKey? = namespace.status == .orphan ? "Bot ou time removido" : namespace.exists ? nil : "Ainda sem arquivos"
        return Button { Task { await open(namespace.ref) } } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).foregroundStyle(.tint).frame(width: 22).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title).lineLimit(1)
                    if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 5).padding(.horizontal, 6)
            .contentShape(Rectangle())
            .background(selection == namespace.ref ? Color.accentColor.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(editor.busy)
        .accessibilityAddTraits(selection == namespace.ref ? [.isSelected] : [])
        .accessibilityIdentifier("files.namespace.\(namespace.identifier)")
    }

    private func generationLabel(_ location: OutputLocation) -> String {
        let kind = DexterLocalization.text(OutputFilesPresentation.locationKindKey(location.kind), locale: locale)
        let base = location.kind == .ownerPath ? (location.path as NSString).lastPathComponent : kind
        return location.current ? DexterLocalization.format("%@ (atual)", base, locale: locale) : DexterLocalization.format("%@ (anterior)", base, locale: locale)
    }

    private func open(_ ref: OutputNamespaceRef) async {
        selection = ref; path = "."; lastDownload = nil
        await editor.browse(namespace: ref, path: ".", generation: shownGeneration)
    }

    /// Another folder of this base (the current one or an earlier one): its own namespaces, then the same bot or team.
    private func show(generation value: Int) async {
        generation = value; path = "."; lastDownload = nil
        await editor.loadNamespaces(generation: value)
        if let ref = fixed ?? selection {
            if fixed == nil, OutputFilesPresentation.only(ref, in: editor.namespaces) == nil { selection = nil; return }
            await open(ref)
        }
    }

    @ViewBuilder private var detail: some View {
        if let selection, let entries = editor.browsing, entries.namespace == selection {
            VStack(alignment: .leading, spacing: 8) {
                header(selection, entries: entries)
                if entries.items.isEmpty {
                    Text(entries.exists ? "Esta pasta está vazia." : "Nada foi criado aqui ainda.")
                        .foregroundStyle(.secondary).padding(.top, 20).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("files.empty")
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(entries.items) { entry in
                                entryRow(entry, ref: selection, generation: entries.generation)
                                Divider()
                            }
                        }
                        .padding(.horizontal, 14)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("files.entries")
                }
                let hidden = entries.hidden.secretLike + entries.hidden.internal
                if hidden > 0 {
                    Text(hidden == 1 ? DexterLocalization.text("1 item não aparece (parece segredo ou é interno da base).", locale: locale)
                         : DexterLocalization.format("%@ itens não aparecem (parecem segredos ou são internos da base).", String(hidden), locale: locale))
                        .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14)
                        .accessibilityIdentifier("files.hidden")
                }
                if let cursor = entries.nextCursor {
                    Button("Mostrar mais") { Task { await editor.browse(namespace: selection, path: path, generation: entries.generation, after: cursor) } }
                        .padding(.horizontal, 14).disabled(editor.busy)
                        .accessibilityIdentifier("files.more")
                }
            }
            .padding(.bottom, 8)
        } else if editor.busy {
            ProgressView().padding(30)
        } else if fixed != nil {
            Text("Nada foi criado aqui ainda.").foregroundStyle(.secondary).padding(30)
                .accessibilityIdentifier("files.empty")
        } else {
            Text("Escolha Geral, um bot ou um time.").foregroundStyle(.secondary).padding(30)
        }
    }

    private func header(_ ref: OutputNamespaceRef, entries: OutputEntries) -> some View {
        HStack(spacing: 8) {
            if path != "." {
                Button { goUp(ref) } label: {
                    Label("Voltar", systemImage: "chevron.backward").labelStyle(.iconOnly)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.borderless).help(Text("Voltar"))
                .accessibilityIdentifier("files.up")
            }
            // A bot or team view already names its folder in the title bar; only a subfolder path is shown here.
            if path != "." || fixed == nil {
                Text(verbatim: path == "." ? title(of: ref) : path).font(.headline).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if let location, let namespace = editor.namespaces.first(where: { $0.ref == ref }),
               case .revealInFinder(let url) = editor.access(location: location, namespace: namespace, entryPath: path == "." ? nil : path) {
                Button("Mostrar no Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    .accessibilityIdentifier("files.reveal-folder")
            }
        }
        .frame(minHeight: 28)
        .padding(.horizontal, 14).padding(.top, 12)
    }

    private func title(of ref: OutputNamespaceRef) -> String {
        if ref == .general { return DexterLocalization.text("Pasta geral", locale: locale) }
        return editor.namespaces.first { $0.ref == ref }?.label ?? ref.rawValue
    }

    private func goUp(_ ref: OutputNamespaceRef) {
        let parent = (path as NSString).deletingLastPathComponent
        path = parent.isEmpty ? "." : parent
        Task { await editor.browse(namespace: ref, path: path, generation: editor.browsing?.generation) }
    }

    private func entryRow(_ entry: OutputEntry, ref: OutputNamespaceRef, generation: Int) -> some View {
        HStack(spacing: 10) {
            Image(systemName: entry.type == .directory ? "folder" : entry.type == .blocked ? "nosign" : "doc")
                .foregroundStyle(.secondary).frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: entry.name).lineLimit(1).truncationMode(.middle)
                Text(verbatim: detail(entry)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            switch entry.type {
            case .directory:
                Button("Abrir") {
                    path = entry.path
                    Task { await editor.browse(namespace: ref, path: entry.path, generation: generation) }
                }
                .accessibilityIdentifier("files.open.\(entry.path)")
            case .file:
                if let location, let namespace = editor.namespaces.first(where: { $0.ref == ref }),
                   case .revealInFinder(let url) = editor.access(location: location, namespace: namespace, entryPath: entry.path) {
                    Button("Mostrar no Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                        .accessibilityIdentifier("files.reveal.\(entry.path)")
                } else {
                    if downloading == entry.path { ProgressView().controlSize(.small) }
                    Button("Baixar…") { download(entry, ref: ref, generation: generation) }
                        .disabled(downloading != nil || editor.busy)
                        .accessibilityIdentifier("files.download.\(entry.path)")
                }
            case .blocked:
                Text("Não pode ser aberto").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("files.entry.\(entry.path)")
    }

    private func detail(_ entry: OutputEntry) -> String {
        var parts: [String] = []
        if let bytes = entry.bytes, entry.type == .file { parts.append(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)) }
        if let modified = entry.modifiedAt {
            var style = Date.FormatStyle(date: .abbreviated, time: .shortened); style.locale = locale
            parts.append(Date(timeIntervalSince1970: TimeInterval(modified) / 1_000).formatted(style))
        }
        return parts.joined(separator: " · ")
    }

    /// Download = a NEW local file the owner names; the bytes are pinned and verified by the SDK (create-only).
    private func download(_ entry: OutputEntry, ref: OutputNamespaceRef, generation: Int) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = entry.name
        panel.canCreateDirectories = true
        panel.message = DexterLocalization.text("O arquivo é baixado da base e conferido antes de aparecer aqui.", locale: locale)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        downloading = entry.path; lastDownload = nil
        Task {
            defer { downloading = nil }
            guard let item = await session.item(namespace: ref, path: entry.path, generation: generation) else { return }
            if let export = await editor.export(item, to: url) {
                lastDownload = DexterLocalization.format("Baixado: %@", export.url.lastPathComponent, locale: locale)
            }
        }
    }
}

/// Bot or team settings › Arquivos: the folder of THIS bot or team only (the host's own namespace, never another bot's,
/// a group's or the general folder), plus where new files go on this base. Rows in the `BotSettingsRow` style; the
/// folder choice itself stays in Ajustes › Geral › Arquivos gerados.
struct OutputFilesNamespaceRows: View {
    enum Owner { case bot, team }
    let model: DexterAppModel
    let ref: OutputNamespaceRef
    let owner: Owner
    /// "bot-profile.files" or "team-settings.files".
    let idPrefix: String
    @Environment(\.locale) private var locale
    @State private var holder = OutputFilesSessionHolder()
    @State private var browsing = false

    private func t(_ key: String) -> String { DexterLocalization.text(key, locale: locale) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BotSettingsRow(title: t(owner == .bot ? "Pasta deste bot" : "Pasta deste time"), detail: folderDetail, systemImage: "folder") {
                folderTrailing
            }
            Divider()
            BotSettingsRow(title: t("Pasta geral de saídas"),
                           detail: t("Escolhida pelo dono em Ajustes › Geral › Arquivos gerados, para todos os bots e times. Uma pasta nova recebe só os arquivos novos."),
                           systemImage: "tray.full") {
                Text(verbatim: generalState).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).frame(maxWidth: 220, alignment: .trailing)
                    .help(Text(verbatim: generalHelp))
                    .accessibilityIdentifier("\(idPrefix).general.state")
            }
        }
        .task(id: model.filesScope) { await holder.open(model) }
        .onDisappear { holder.close() }
        .sheet(isPresented: $browsing) {
            if let session = holder.session { OutputFilesBrowserSheet(session: session, fixed: ref) }
        }
    }

    private var session: OutputFilesSession? {
        guard let session = holder.session, session.scope == model.filesScope else { return nil }
        return session
    }
    private var namespace: OutputNamespace? { session.flatMap { OutputFilesPresentation.only(ref, in: $0.editor.namespaces) } }

    private var folderDetail: String {
        if let unreachable = holder.unreachableKey(model) { return t(unreachable) }
        guard model.outputFilesBase != nil else { return t("Disponível com uma base conectada.") }
        guard let session else { return t("Carregando…") }
        let editor = session.editor
        if !editor.canBrowse { return t(OutputFilesPresentation.noticeKey(.remoteBrowsingUnavailable, base: session.base)) }
        if editor.status == nil, let notice = editor.notice { return t(OutputFilesPresentation.noticeKey(notice, base: session.base)) }
        if editor.status == nil { return t("Carregando…") }
        if namespace?.exists == true {
            return t(owner == .bot ? "Os arquivos que este bot salva ficam numa pasta só dele, nesta base." : "Os arquivos do time ficam numa pasta só do time, nesta base.")
        }
        if editor.locations.count > 1 { return t("Nada na pasta atual ainda. Os arquivos anteriores continuam em Ver arquivos.") }
        return t(owner == .bot ? "Este bot ainda não salvou arquivos nesta base." : "O time ainda não salvou arquivos nesta base.")
    }

    @ViewBuilder private var folderTrailing: some View {
        if let session, let status = session.editor.status, session.editor.canBrowse {
            HStack(spacing: 8) {
                if let namespace, namespace.exists,
                   case .revealInFinder(let url) = session.editor.access(location: status.current, namespace: namespace) {
                    Button("Mostrar no Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                        .accessibilityIdentifier("\(idPrefix).reveal")
                }
                Button("Ver arquivos…") { browsing = true }
                    .disabled(namespace?.exists != true && session.editor.locations.count < 2)
                    .accessibilityIdentifier("\(idPrefix).open")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("\(idPrefix).\(owner == .bot ? "bot-folder" : "team-folder").state")
        } else if session == nil, holder.unreachableKey(model) == nil, model.outputFilesBase != nil {
            ProgressView().controlSize(.small)
        }
    }

    private var generalState: String {
        guard let status = session?.editor.status else { return "—" }
        return status.current.kind == .ownerPath ? (status.current.path as NSString).lastPathComponent : t(OutputFilesPresentation.locationKindKey(status.current.kind))
    }
    private var generalHelp: String {
        guard let status = session?.editor.status else { return "" }
        return status.current.kind == .ownerPath ? status.current.path : t(OutputFilesPresentation.locationKindKey(status.current.kind))
    }
}
#endif
