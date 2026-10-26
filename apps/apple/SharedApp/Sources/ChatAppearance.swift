import Foundation
import Observation
import SwiftUI
import DexterAppCore

#if os(macOS)
import AppKit
import UniformTypeIdentifiers

@MainActor @Observable final class ChatAppearanceStore {
    static let shared = ChatAppearanceStore()
    typealias Preset = ChatBackdropPreset
    typealias Direction = ChatBackdropDirection
    typealias RGB = ChatBackdropRGB
    typealias Settings = ChatAppearanceSettings
    static let storageKey = "com.dexter.apple.chat-appearance.v1"
    private let defaults: UserDefaults
    private let key: String
    private let repository: ChatWallpaperRepository
    private(set) var settings: Settings
    private(set) var image: NSImage?
    private(set) var isImporting = false
    private(set) var notice: String?
    private var revision: UInt64 = 0

    init(defaults: UserDefaults = .standard, key: String = ChatAppearanceStore.storageKey,
         repository: ChatWallpaperRepository? = nil) {
        self.defaults = defaults; self.key = key
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let appID = Bundle.main.bundleIdentifier ?? "com.dexter.apple"
        self.repository = repository ?? ChatWallpaperRepository(root: support
            .appendingPathComponent("Dexter Appearance", isDirectory: true)
            .appendingPathComponent(appID, isDirectory: true).appendingPathComponent("Wallpapers", isDirectory: true))
        settings = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Settings.self, from: $0) } ?? Settings()
        if let reference = settings.wallpaper { Task { await loadImage(reference) } }
    }

    var hasBackground: Bool { settings.hasBackground }
    var prefersDarkText: Bool { settings.usesLightAppearance }
    var stops: (RGB, RGB)? { settings.stops }
    static func presetStops(_ preset: Preset) -> (RGB, RGB)? { Settings.presetStops(preset) }
    var canvas: Color { prefersDarkText ? Color(.sRGB, white: 0.95) : Color(.sRGB, white: 0.09) }

    func update(_ change: (inout Settings) -> Void) {
        var next = settings; change(&next)
        guard next.isValid, next != settings, let data = try? JSONEncoder().encode(next) else { return }
        revision &+= 1; settings = next; defaults.set(data, forKey: key)
    }
    func reset() {
        let old = settings.wallpaper
        revision &+= 1; settings = Settings(); image = nil; notice = nil; defaults.removeObject(forKey: key)
        if let old { discard(old) }
    }
    func removeImage() {
        guard let old = settings.wallpaper else { return }
        update { $0.wallpaper = nil; if $0.preset == .image { $0.preset = .neutral } }
        image = nil; notice = nil; discard(old)
    }
    func importImage(from url: URL) async {
        guard !isImporting else { return }
        isImporting = true; notice = nil
        defer { isImporting = false }
        let captured = revision
        do {
            let worker = Task.detached(priority: .userInitiated) {
                try ChatWallpaperRepository.prepare(file: url)
            }
            defer { worker.cancel() }
            let prepared = try await withTaskCancellationHandler {
                try await worker.value
            } onCancel: {
                worker.cancel()
            }
            try Task.checkCancellation()
            guard captured == revision else { return }
            let reference = try repository.store(prepared)
            guard let replacement = NSImage(data: prepared.jpeg) else {
                try? repository.remove(reference); throw ChatWallpaperError.invalidImage
            }
            let old = settings.wallpaper
            update { $0.wallpaper = reference; $0.preset = .image }
            image = replacement
            if let old { discard(old) }
        } catch is CancellationError {
            // Closing Settings cancels before the private copy/choice is committed; the old appearance remains.
        } catch ChatWallpaperError.imageTooLarge {
            guard !Task.isCancelled else { return }
            notice = String(localized: "Imagem muito grande. Escolha uma de até 20 MB.")
        } catch ChatWallpaperError.privateCopyUnavailable {
            guard !Task.isCancelled else { return }
            notice = String(localized: "Não foi possível guardar a imagem neste Mac. Sua escolha anterior foi mantida.")
        } catch {
            guard !Task.isCancelled else { return }
            notice = String(localized: "Não foi possível abrir a imagem. Use uma foto JPG, PNG ou HEIC.")
        }
    }
    private func loadImage(_ reference: ChatWallpaperReference) async {
        let repository = repository
        do {
            let data = try await Task.detached(priority: .utility) { try repository.load(reference) }.value
            guard settings.wallpaper == reference, !Task.isCancelled else { return }
            image = NSImage(data: data)
            if image == nil { notice = String(localized: "O fundo não foi encontrado. Escolha outra imagem.") }
        } catch {
            guard settings.wallpaper == reference else { return }
            notice = String(localized: "O fundo não foi encontrado. Escolha outra imagem.")
        }
    }
    private func discard(_ reference: ChatWallpaperReference) {
        do { try repository.remove(reference) }
        catch { notice = String(localized: "A aparência foi salva, mas uma cópia local da imagem não pôde ser removida.") }
    }
}

extension ChatBackdropRGB {
    var color: Color { Color(.sRGB, red: r, green: g, blue: b) }
    init(_ color: Color) {
        let ns = NSColor(color).usingColorSpace(.sRGB) ?? .black
        self.init(r: Double(ns.redComponent), g: Double(ns.greenComponent), b: Double(ns.blueComponent))
    }
}
extension ChatBackdropPreset {
    var title: String {
        switch self {
        case .neutral: String(localized: "Neutro")
        case .teal: String(localized: "Azul-petróleo")
        case .graphite: String(localized: "Grafite")
        case .plum: String(localized: "Ameixa")
        case .forest: String(localized: "Floresta")
        case .sand: String(localized: "Areia")
        case .custom: String(localized: "Personalizado")
        case .image: String(localized: "Imagem")
        }
    }
}
extension ChatBackdropDirection {
    var title: String { self == .vertical ? String(localized: "Vertical") : String(localized: "Diagonal") }
}

/// A single clipped window canvas, shared by the sidebar, transcript, inspector and native header.
private struct ChatWindowBackground: View {
    var store: ChatAppearanceStore = .shared
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        if store.hasBackground {
            GeometryReader { geometry in
                ZStack {
                    store.canvas
                    if !reduceTransparency {
                        Group {
                            if store.settings.preset == .image, let image = store.image {
                                Image(nsImage: image).resizable().scaledToFill()
                                    .frame(width: geometry.size.width, height: geometry.size.height)
                                    .blur(radius: store.settings.imageBlur, opaque: true).clipped()
                            } else if let (top, bottom) = store.stops {
                                LinearGradient(colors: [top.color, bottom.color], startPoint: .topLeading,
                                    endPoint: store.settings.direction == .vertical ? .bottom : .bottomTrailing)
                                RadialGradient(colors: [top.color.opacity(0.42), .clear], center: .topTrailing,
                                    startRadius: 0, endRadius: max(geometry.size.width, geometry.size.height) * 0.75)
                            }
                        }
                        .opacity(store.settings.backgroundOpacity)
                        // Photos need a stronger scrim because their local luminance can vary independently of text.
                        (store.prefersDarkText ? Color.white : Color.black)
                            .opacity(store.settings.readabilityScrim)
                    }
                }
                .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

private struct ChatWindowHeader: View {
    var store: ChatAppearanceStore = .shared
    var height: CGFloat = 64
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        if store.hasBackground {
            LinearGradient(colors: [store.canvas.opacity(reduceTransparency ? 1 : 0.55),
                store.canvas.opacity(reduceTransparency ? 1 : 0.25), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: height).allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

/// Public AppKit canvas properties only. SwiftUI owns the window's preferred color scheme and its restoration.
private struct ChatWindowStyle: NSViewRepresentable {
    let enabled: Bool
    let light: Bool
    final class Probe: NSView {
        private weak var styledWindow: NSWindow?
        private var previousBackground: NSColor?
        private var previousOpaque = true
        var enabled = false
        var light = false
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); apply() }
        func apply() {
            guard let window else { restore(); return }
            if styledWindow !== window {
                restore(); styledWindow = window
                previousBackground = window.backgroundColor; previousOpaque = window.isOpaque
            }
            if enabled {
                let canvas = NSColor(srgbRed: light ? 0.95 : 0.09, green: light ? 0.95 : 0.09, blue: light ? 0.95 : 0.09, alpha: 1)
                if window.isOpaque { window.isOpaque = false }
                if window.backgroundColor != canvas { window.backgroundColor = canvas }
            } else { restore() }
        }
        func restore() {
            guard let styledWindow else { return }
            if let previousBackground { styledWindow.backgroundColor = previousBackground }
            styledWindow.isOpaque = previousOpaque
            self.styledWindow = nil; previousBackground = nil
        }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.enabled = enabled; view.light = light; view.apply() }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.restore() }
}

private struct ChatWindowAppearanceModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    func body(content: Content) -> some View {
        content
            .background {
                ChatWindowBackground(store: store)
                    .overlay(alignment: .top) { ChatWindowHeader(store: store) }
                    .ignoresSafeArea()
            }
            .background(ChatWindowStyle(enabled: store.hasBackground, light: store.prefersDarkText).frame(width: 0, height: 0))
            .toolbarBackground(store.hasBackground ? .hidden : .automatic, for: .windowToolbar)
            .toolbarColorScheme(store.hasBackground ? (store.prefersDarkText ? .light : .dark) : nil, for: .windowToolbar)
            .preferredColorScheme(store.hasBackground ? (store.prefersDarkText ? .light : .dark) : nil)
    }
}

private struct ChatPanelBackground: View {
    var store: ChatAppearanceStore = .shared
    var material = true
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        if store.hasBackground {
            Group {
                if material { Rectangle().fill(.ultraThinMaterial) } else { Color.clear }
            }
                .overlay(store.canvas.opacity(reduceTransparency ? 1 : max(contrast == .increased ? 0.85 : 0, store.settings.panelOpacity)))
                .allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}
private struct ChatSidePanelModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    func body(content: Content) -> some View {
        content.background { ChatPanelBackground(store: store, material: false).ignoresSafeArea() }
    }
}
private struct ChatInspectorPanelModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        content
            .background { ChatPanelBackground(store: store) }
            .background(store.hasBackground ? Color.clear : DexterSurface.panelFill)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(contrast == .increased ? Color.primary.opacity(0.45) : DexterSurface.panelStroke))
    }
}

/// The scroll viewport, not the chat container, fades as pixels enter the header. Extra top content margin leaves
/// the first message fully readable at scroll start. No transcript or composer identity is replaced by appearance changes.
private struct ChatTranscriptEdgeModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    var fadesUnderToolbar = true
    func body(content: Content) -> some View {
        let fade: CGFloat = fadesUnderToolbar ? 64 : 12
        content
            .contentMargins(.top, store.hasBackground && fadesUnderToolbar ? 20 : 0, for: .scrollContent)
            .contentMargins(.top, 0, for: .scrollIndicators)
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [store.hasBackground ? .clear : .white, .white], startPoint: .top, endPoint: .bottom)
                        .frame(height: store.hasBackground ? fade : 0)
                    Color.white
                }.ignoresSafeArea(edges: .top)
            }
    }
}
private struct ChatSidebarListModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    func body(content: Content) -> some View { content.scrollContentBackground(store.hasBackground ? .hidden : .automatic) }
}
private struct ChatGroupSeparatorModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    func body(content: Content) -> some View { content.opacity(store.hasBackground ? 0 : 1) }
}
private struct ChatMessageBackdropModifier<S: Shape>: ViewModifier {
    let shape: S
    let enabled: Bool
    var store: ChatAppearanceStore = .shared
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        content.background {
            if enabled, store.hasBackground {
                shape.fill(.regularMaterial).overlay(shape.fill(store.canvas.opacity(reduceTransparency ? 1 : 0.20)))
            }
        }
    }
}
private struct ChatCaptionBackdropModifier: ViewModifier {
    var store: ChatAppearanceStore = .shared
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, store.hasBackground ? 10 : 0)
            .padding(.vertical, store.hasBackground ? 3 : 0)
            .background { if store.hasBackground { Capsule().fill(store.canvas.opacity(0.65)) } }
    }
}
extension View {
    func chatWindowAppearance() -> some View { modifier(ChatWindowAppearanceModifier()) }
    func chatSidePanel() -> some View { modifier(ChatSidePanelModifier()) }
    func chatInspectorPanel() -> some View { modifier(ChatInspectorPanelModifier()) }
    func chatTranscriptEdge(fadesUnderToolbar: Bool = true) -> some View { modifier(ChatTranscriptEdgeModifier(fadesUnderToolbar: fadesUnderToolbar)) }
    func chatSidebarList() -> some View { modifier(ChatSidebarListModifier()) }
    func chatGroupSeparator() -> some View { modifier(ChatGroupSeparatorModifier()) }
    func chatMessageBackdrop<S: Shape>(in shape: S, enabled: Bool = true) -> some View { modifier(ChatMessageBackdropModifier(shape: shape, enabled: enabled)) }
    func chatCaptionBackdrop() -> some View { modifier(ChatCaptionBackdropModifier()) }
}

struct ChatAppearanceSettingsSection: View {
    @Bindable var store: ChatAppearanceStore = .shared
    @State private var imageTask: Task<Void, Never>?
    @State private var imagePanel: NSOpenPanel?
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Fundo")
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72, maximum: 84), spacing: 8)], spacing: 10) {
                    ForEach(ChatAppearanceStore.Preset.allCases) { preset in swatch(preset) }
                }
            }
            .accessibilityElement(children: .contain).accessibilityIdentifier("appearance.chat-background.preset")
            HStack {
                Button(LocalizedStringKey(store.settings.wallpaper == nil ? "Escolher imagem…" : "Trocar imagem…")) { chooseImage() }
                    .accessibilityIdentifier("appearance.chat-background.image.choose")
                if store.settings.wallpaper != nil {
                    Button("Remover imagem") { store.removeImage() }
                        .accessibilityIdentifier("appearance.chat-background.image.remove")
                }
                if store.isImporting { ProgressView().controlSize(.small).accessibilityLabel("Preparando imagem") }
            }.disabled(store.isImporting)
            if let notice = store.notice {
                Text(verbatim: notice).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("appearance.chat-background.notice")
            }
            if store.settings.preset == .custom {
                ColorPicker("Cor de cima", selection: Binding(get: { store.settings.top.color },
                    set: { value in store.update { $0.top = .init(value) } }), supportsOpacity: false)
                    .accessibilityIdentifier("appearance.chat-background.top").disabled(store.isImporting)
                ColorPicker("Cor de baixo", selection: Binding(get: { store.settings.bottom.color },
                    set: { value in store.update { $0.bottom = .init(value) } }), supportsOpacity: false)
                    .accessibilityIdentifier("appearance.chat-background.bottom").disabled(store.isImporting)
                Picker("Direção", selection: Binding(get: { store.settings.direction }, set: { value in store.update { $0.direction = value } })) {
                    ForEach(ChatAppearanceStore.Direction.allCases) { d in Text(d.title).tag(d) }
                }.pickerStyle(.segmented).accessibilityIdentifier("appearance.chat-background.direction").disabled(store.isImporting)
            }
            if store.settings.preset != .neutral {
                opacityRow(Text("Opacidade do fundo"), id: "appearance.chat-background.opacity",
                    value: Binding(get: { store.settings.backgroundOpacity }, set: { value in store.update { $0.backgroundOpacity = value } }))
                opacityRow(Text("Opacidade das barras laterais"), id: "appearance.chat-background.panel-opacity",
                    value: Binding(get: { store.settings.panelOpacity }, set: { value in store.update { $0.panelOpacity = value } }), minimum: 0.25)
                if store.settings.preset == .image {
                    opacityRow(Text("Desfoque da imagem"), id: "appearance.chat-background.blur",
                        value: Binding(get: { store.settings.imageBlur / 24 }, set: { value in store.update { $0.imageBlur = value * 24 } }))
                }
                if reduceTransparency {
                    Text("Reduzir transparência está ativo no macOS. O Dexter usa fundos sólidos para manter a leitura.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            windowPreview
            Button("Voltar ao padrão") { store.reset() }
                .disabled(store.settings == .init() || store.isImporting)
                .accessibilityIdentifier("appearance.chat-background.reset")
        } header: { Text("Aparência da conversa") }
        footer: {
            Text("O fundo acompanha a janela e as barras laterais. Imagens ficam só neste Mac; não são enviadas aos bots.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onDisappear { imageTask?.cancel(); imagePanel?.cancel(nil); imagePanel = nil }
    }

    private func opacityRow(_ title: Text, id: String, value: Binding<Double>, minimum: Double = 0) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                title; Spacer()
                Text(value.wrappedValue, format: .percent.precision(.fractionLength(0))).monospacedDigit().foregroundStyle(.secondary)
            }
            Slider(value: value, in: minimum...1, step: 0.01) { title }
                .labelsHidden()
                .accessibilityIdentifier(id).accessibilityValue(Text(value.wrappedValue, format: .percent.precision(.fractionLength(0))))
        }.disabled(reduceTransparency || store.isImporting)
    }
    private func swatch(_ preset: ChatAppearanceStore.Preset) -> some View {
        let selected = store.settings.preset == preset
        let colors: [Color] = switch preset {
        case .neutral: [Color(nsColor: .windowBackgroundColor), Color(nsColor: .underPageBackgroundColor)]
        case .custom: [store.settings.top.color, store.settings.bottom.color]
        case .image: [Color.secondary.opacity(0.30), Color.secondary.opacity(0.10)]
        default: ChatAppearanceStore.presetStops(preset).map { [$0.0.color, $0.1.color] } ?? [.clear]
        }
        return Button {
            if preset == .image, store.settings.wallpaper == nil { chooseImage() }
            else { store.update { $0.preset = preset } }
        } label: {
            VStack(spacing: 5) {
                Circle().fill(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom)).frame(width: 30, height: 30)
                    .overlay {
                        if preset == .image, let image = store.image {
                            Image(nsImage: image).resizable().scaledToFill().frame(width: 30, height: 30).clipShape(Circle())
                        } else if preset == .custom || preset == .image {
                            Image(systemName: preset == .custom ? "paintpalette" : "photo").font(.system(size: 12)).foregroundStyle(.primary)
                        }
                    }
                    .overlay(Circle().strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.35), lineWidth: selected ? 3 : 1))
                Text(preset.title).font(.caption2).foregroundStyle(selected ? .primary : .secondary)
                    .multilineTextAlignment(.center).lineLimit(2).frame(height: 28, alignment: .top)
            }.frame(maxWidth: .infinity).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(store.isImporting)
            .help(preset.title).accessibilityLabel(preset.title).accessibilityAddTraits(selected ? [.isSelected] : [])
            .accessibilityIdentifier("appearance.chat-background.preset.\(preset.rawValue)")
    }
    private var windowPreview: some View {
        GeometryReader { geometry in
            ZStack {
                Color(nsColor: .windowBackgroundColor)
                ChatWindowBackground(store: store)
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 11) {
                        Image(systemName: "bubble.left.and.bubble.right")
                        ForEach(0..<3) { index in Capsule().fill(Color.primary.opacity(index == 0 ? 0.3 : 0.12)).frame(height: 6) }
                        Spacer()
                    }.padding(12).frame(width: geometry.size.width * 0.23).background { ChatPanelBackground(store: store, material: false) }
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Conversa").font(.caption.weight(.semibold))
                        Text("Olá").font(.caption).padding(8).background(Color.accentColor.opacity(0.7), in: Capsule()).frame(maxWidth: .infinity, alignment: .trailing)
                        Capsule().fill(Color.primary.opacity(0.12)).frame(width: geometry.size.width * 0.35, height: 7)
                        Spacer()
                    }.padding(14).frame(maxWidth: .infinity)
                    VStack(spacing: 10) { Image(systemName: "person.crop.circle"); Capsule().fill(Color.primary.opacity(0.15)).frame(height: 6); Spacer() }
                        .padding(12).frame(width: geometry.size.width * 0.18).background { ChatPanelBackground(store: store) }
                }.padding(.top, 14)
                VStack { ChatWindowHeader(store: store, height: 22); Spacer() }
            }.clipShape(RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.secondary.opacity(0.2)))
                .environment(\.colorScheme, store.hasBackground ? (store.prefersDarkText ? .light : .dark) : systemScheme)
        }.frame(height: 145).accessibilityElement(children: .ignore).accessibilityLabel("Prévia da janela").accessibilityValue(store.settings.preset.title)
            .accessibilityIdentifier("appearance.chat-background.preview")
    }
    private func chooseImage() {
        guard !store.isImporting, imagePanel == nil else { return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.jpeg, .png, .heic]
        panel.allowsMultipleSelection = false; panel.canChooseDirectories = false; panel.canChooseFiles = true
        panel.title = String(localized: "Escolher imagem de fundo")
        imagePanel = panel
        panel.begin { response in
            imagePanel = nil
            guard response == .OK, let url = panel.url else { return }
            imageTask?.cancel(); imageTask = Task { await store.importImage(from: url) }
        }
    }
}
#endif
