import DexterAppCore
import SwiftUI

/// Projection of metadata returned by the scoped host query. No thread/message fetch occurs while drawing rows.
struct ConversationHistoryItem: Identifiable, Equatable {
    let id: String
    let title: String
    let preview: String?
    let activityAt: Int64
    let messageCount: Int?
    let activityKnown: Bool
    let isSearchable: Bool
    let hasImage: Bool

    init(row: ThreadHistoryRow, botName: String) {
        id = row.id; activityAt = row.activityAt; messageCount = row.messageCount; activityKnown = row.activityKnown
        switch row.title {
        case .text(let value): title = value
        case .noMessages: title = String(localized: "Nova conversa")
        case .untitled: title = String(localized: "Conversa sem título")
        case .unavailable: title = String(localized: "Conversa")
        }
        switch row.preview {
        case .text(let value, let fromBot, let image):
            preview = (fromBot ? botName : String(localized: "Você")) + ": " + value; hasImage = image
        case .image: preview = String(localized: "Imagem"); hasImage = true
        case .none, .unavailable: preview = nil; hasImage = false
        }
        isSearchable = row.title != .unavailable
    }
}

/// Shared presentation for private bot and team histories; callers supply their existing scoped actions.
struct ConversationHistoryList: View {
    @Environment(\.locale) private var locale
    let ownerName: String
    let items: [ConversationHistoryItem]
    let idPrefix: String
    let canCreate: Bool
    let creating: Bool
    let loading: Bool
    var failure: String? = nil
    let create: () -> Void
    let activate: (String) -> Void
    @State private var query = ""
    @State private var selection = DexterThreadListSelection()
    #if os(macOS)
    @FocusState private var listFocused: Bool
    @State private var didFocusList = false
    #endif

    private var visible: [ConversationHistoryItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
        return items.filter { item in
            words.isEmpty || (item.isSearchable && words.allSatisfy { word in
                (item.title + " " + (item.preview ?? "")).range(of: word, options: [.caseInsensitive, .diacriticInsensitive], locale: locale) != nil
            })
        }
            .sorted { $0.activityAt == $1.activityAt ? $0.id < $1.id : $0.activityAt > $1.activityAt }
    }
    private var ids: [String] { visible.map(\.id) }
    private var selectedID: Binding<String?> {
        Binding(get: { selection.selectedID }, set: { selection.select($0, in: ids) })
    }
    private var groups: [(key: Int, rows: [ConversationHistoryItem])] {
        let calendar = Calendar.current
        let grouped = Dictionary(grouping: visible) { item in
            let date = Date(timeIntervalSince1970: TimeInterval(item.activityAt) / 1_000)
            if calendar.isDateInToday(date) { return 0 }
            if calendar.isDateInYesterday(date) { return 1 }
            return 2
        }
        return grouped.keys.sorted().map { ($0, grouped[$0] ?? []) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Conversas").font(.system(size: 26, weight: .semibold))
                    Text(verbatim: ownerName).font(.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: 16)
                if !items.isEmpty { createButton }
            }.padding(.horizontal, 24).padding(.top, 22)
            if items.contains(where: \.isSearchable) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                    TextField("Buscar conversas", text: $query).textFieldStyle(.plain)
                        .accessibilityIdentifier("\(idPrefix).search")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain).accessibilityLabel("Limpar busca")
                            .accessibilityIdentifier("\(idPrefix).search.clear")
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 24)
            }
            if visible.isEmpty {
                VStack(spacing: 14) {
                    if loading && items.isEmpty {
                        ProgressView("Carregando conversas…")
                    } else if let failure {
                        ContentUnavailableView("Conversas indisponíveis", systemImage: "wifi.exclamationmark", description: Text(verbatim: failure))
                    } else if !query.isEmpty {
                        ContentUnavailableView.search(text: query)
                    } else {
                        ContentUnavailableView("Sem conversas", systemImage: "bubble.left.and.bubble.right",
                            description: Text("Comece uma conversa. Cada uma mantém seu próprio histórico."))
                        createButton
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("\(idPrefix).empty")
            } else {
                List(selection: selectedID) {
                    ForEach(groups, id: \.key) { group in
                        Section {
                            ForEach(group.rows) { item in row(item).tag(item.id) }
                        } header: {
                            switch group.key {
                            case 0: Text("Hoje")
                            case 1: Text("Ontem")
                            default: Text("Anteriores")
                            }
                        }
                    }
                }
                .listStyle(.inset).scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                #if os(macOS)
                .focused($listFocused).focusEffectDisabled()
                .onAppear { if !didFocusList && query.isEmpty { didFocusList = true; listFocused = true } }
                .onKeyPress(.upArrow) { selection.move(-1, in: ids); return .handled }
                .onKeyPress(.downArrow) { selection.move(1, in: ids); return .handled }
                .onKeyPress(.return) {
                    if let id = selection.activation(in: ids) { activate(id) }
                    return .handled
                }
                #endif
                .onChange(of: ids) { _, ids in selection.reconcile(in: ids) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle(ownerName)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(idPrefix).history")
    }
    private var createButton: some View {
        Button(action: create) {
            Label(LocalizedStringKey(creating ? "Criando conversa…" : "Nova conversa"), systemImage: "plus.bubble")
        }
        .buttonStyle(.borderedProminent).controlSize(.large)
        .disabled(!canCreate || creating)
        .accessibilityIdentifier("\(idPrefix).create")
    }
    private func row(_ item: ConversationHistoryItem) -> some View {
        Button { selection.select(item.id, in: ids); activate(item.id) } label: {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: item.hasImage ? "photo" : "bubble.left.and.bubble.right")
                .font(.system(size: 18)).foregroundStyle(.secondary)
                .frame(width: 40, height: 40)
                .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: item.title).font(.system(size: 14, weight: .semibold)).lineLimit(1).accessibilityIdentifier("\(idPrefix).\(item.id).title")
                    Spacer(minLength: 12)
                    Group {
                        if item.activityKnown {
                            Text(Date(timeIntervalSince1970: TimeInterval(item.activityAt) / 1_000), format: .dateTime.day().month(.abbreviated).hour().minute())
                        } else {
                            Text("Criada em \(Date(timeIntervalSince1970: TimeInterval(item.activityAt) / 1_000).formatted(.dateTime.day().month(.abbreviated)))")
                        }
                    }.font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("\(idPrefix).\(item.id).activity")
                }
                if let preview = item.preview, !preview.isEmpty {
                    Text(verbatim: preview).font(.callout).foregroundStyle(.secondary).lineLimit(2).accessibilityIdentifier("\(idPrefix).\(item.id).preview")
                } else if item.messageCount == 0 {
                    Text("Sem mensagens ainda").font(.callout).foregroundStyle(.secondary)
                } else { Text("Abra para ver as mensagens").font(.callout).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).padding(.top, 5).accessibilityHidden(true)
        }
        .padding(.vertical, 10).padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("\(idPrefix).\(item.id)")
    }
}
