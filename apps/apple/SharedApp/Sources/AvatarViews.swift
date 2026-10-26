#if os(macOS)
import AppKit
import DexterAppCore
import DexterHostClient
import SwiftUI
import UniformTypeIdentifiers

/// Avatar bytes are fetched from the canonical host. Precedence follows the host fields: image, then the mascot
/// recipe, then emoji, then the icon; an image that cannot be loaded falls back to the mascot when there is one.
/// `activity` must be derived from host facts (`BotMascotActivity.derive`); it defaults to resting.
@MainActor struct DexterAvatarView: View {
    let image: AvatarImage?
    let emoji: String?
    let fallbackSystemImage: String
    let model: DexterAppModel
    let size: CGFloat
    var appearance: BotAvatarAppearance? = nil
    var activity: BotMascotActivity = .idle
    var showsActivityIndicator = false
    /// A sidebar with no current observation keeps even the resting mascot still, without claiming idle work.
    var isActivityObserved = true
    /// Stable identifier (e.g. the bot ID) so mascots in a list do not blink together.
    var mascotSeed: String = ""
    @State private var imageData: Data?
    @State private var imageUnavailable = false
    @State private var isVisible = false
    @Environment(\.scenePhase) private var scenePhase

    private var mascot: BotAvatarAppearance? {
        guard let appearance, appearance.isValid, imageData == nil, image == nil || imageUnavailable else { return nil }
        return appearance
    }

    var body: some View {
        ZStack {
            if let mascot {
                BotMascotView(appearance: mascot, activity: activity, size: size,
                              animation: isVisible && scenePhase == .active && isActivityObserved ? .automatic : .still, seed: mascotSeed)
            } else {
                RoundedRectangle(cornerRadius: max(8, size * 0.24)).fill(Color.accentColor.opacity(0.08))
                if let imageData, let nativeImage = NSImage(data: imageData) {
                    Image(nsImage: nativeImage).resizable().scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(RoundedRectangle(cornerRadius: max(8, size * 0.24)))
                } else if let emoji, !emoji.isEmpty {
                    Text(verbatim: emoji).font(.system(size: size * 0.58))
                } else {
                    Image(systemName: fallbackSystemImage).font(.system(size: size * 0.44, weight: .medium))
                }
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if showsActivityIndicator {
                BotActivityIndicatorView(activity: activity, motion: appearance?.motion ?? .subtle,
                                         size: min(12, max(10, size * 0.38)))
            }
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .accessibilityHidden(true)
        .task(id: "\(model.nativeComposerScope)|\(image?.id ?? "none")|\(image?.sha256 ?? "none")") {
            imageData = nil; imageUnavailable = false
            guard let image else { return }
            let scope = model.nativeComposerScope
            let bytes = await model.avatarImageData(image)
            guard !Task.isCancelled, scope == model.nativeComposerScope else { return }
            imageData = bytes; imageUnavailable = bytes.flatMap(NSImage.init(data:)) == nil
        }
    }
}

/// Shared draft editor: picking/generating an image or building a mascot does not save a bot or create a team.
/// With `appearance` (bots only) the owner can also build a procedural mascot. Image and mascot are exclusive by the
/// last explicit choice: choosing the mascot drops the image draft/removes the stored image, importing or generating
/// an image clears the mascot draft; the profile's Save sends both changes in one CAS PATCH.
@MainActor struct AvatarEditorView: View {
    let controller: AvatarEditorController
    let existingImage: AvatarImage?
    @Binding var removedExistingImage: Bool
    @Binding var emoji: String
    let model: DexterAppModel
    let fallbackSystemImage: String
    let idPrefix: String
    let emojiID: String
    var appearance: Binding<BotAvatarAppearanceDraft>? = nil
    @Environment(\.locale) private var locale
    @State private var showingImporter = false
    @State private var showingMascot = false
    /// Editor state when the mascot sheet opened; X/Escape puts exactly this back.
    @State private var mascotSheetSnapshot: MascotSheetSnapshot?

    private struct MascotSheetSnapshot {
        let draft: BotAvatarAppearanceDraft
        let removedExistingImage: Bool
        let imageDraft: AvatarImageDraft?
        let imageDraftSetAside: AvatarImageDraft?
    }
    @State private var showingGeneration = false
    @State private var showingEmoji = false
    @State private var prompt = ""
    @State private var privateKey = ""
    @State private var localMessage: String?
    @State private var generationTask: Task<Void, Never>?
    @State private var confirmingRemoveKey = false
    @State private var viewScope = UUID()

    private var hostID: String? { model.avatarHostID }
    private var hasImage: Bool { controller.imageDraft != nil || (!removedExistingImage && existingImage != nil) }
    private var mascotShown: Bool { appearance?.wrappedValue.isSelected == true && !hasImage }
    private func pair(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var emojiValid: Bool {
        let value = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || (value.count == 1 && value.utf16.count <= 16 && value.unicodeScalars.contains { $0.value > 127 && $0.properties.isEmoji })
    }
    private var promptValid: Bool {
        let value = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return !value.isEmpty && value.utf16.count <= 2_000
    }
    private var keyStatusLabel: String {
        switch controller.keyStatus {
        case .configured: String(localized: "Configurada")
        case .missing: String(localized: "Não configurada")
        case .unavailable: String(localized: "Indisponível neste Mac")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 18) {
                preview
                VStack(alignment: .leading, spacing: 9) {
                    Text("Avatar").font(.headline)
                    if appearance != nil {
                        Text(pair("Crie um mascote, escolha uma imagem ou use um emoji para identificar este perfil.",
                                  "Create a mascot, choose an image or use an emoji to identify this profile."))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("Escolha uma imagem ou use um emoji para identificar este perfil.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { avatarButtons }
                        VStack(alignment: .leading, spacing: 8) { avatarButtons }
                    }
                    Text("PNG, JPEG, WebP ou GIF estático · até 10 MB")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if hasImage {
                        Button("Remover imagem", role: .destructive) {
                            controller.removeImage(); removedExistingImage = true; localMessage = nil
                            // An explicit image decision (the controller also drops any set-aside draft): a later
                            // "Remover mascote" does not bring this image back.
                            appearance?.wrappedValue.forgetDisplacedImage()
                        }.buttonStyle(.borderless).disabled(controller.isGenerating)
                            .accessibilityIdentifier(idPrefix + ".remove")
                    }
                    if mascotShown, let appearance {
                        Button(pair("Remover mascote", "Remove mascot"), role: .destructive) { removeMascot(appearance) }
                            .buttonStyle(.borderless).disabled(controller.isGenerating)
                            .help(appearance.wrappedValue.displaced.isEmpty
                                  ? pair("Tira o mascote deste rascunho.", "Removes the mascot from this draft.")
                                  : pair("Tira o mascote e traz de volta a imagem que ele substituiu neste rascunho.",
                                         "Removes the mascot and brings back the image it replaced in this draft."))
                            .accessibilityIdentifier(idPrefix + ".mascot-remove")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            if showingEmoji || (!hasImage && !emoji.isEmpty) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Emoji (opcional)").font(.subheadline.weight(.medium))
                    TextField("Ex.: 🏡", text: $emoji).textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 170).accessibilityLabel("Emoji do avatar").accessibilityIdentifier(emojiID)
                    if mascotShown {
                        Text(pair("O mascote aparece primeiro; o emoji serve como alternativa.", "The mascot shows first; the emoji is a fallback."))
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text(hasImage ? "A imagem aparece primeiro; o emoji serve como alternativa." : "Use um único emoji. O nome do perfil fica no campo Nome.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if !emojiValid {
                        Text("Digite um emoji, como 🏡, ou deixe o campo vazio.").font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            if showingGeneration { generationPanel }
            if mascotShown, existingImage != nil, removedExistingImage, appearance?.wrappedValue.displaced.contains(.storedImage) == true {
                Label(pair("Ao salvar, o mascote substitui a imagem atual. “Remover mascote” mantém a imagem.",
                           "When you save, the mascot replaces the current image. “Remove mascot” keeps the image."),
                      systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(idPrefix + ".mascot-replaces-image")
            }
            if let message = localMessage ?? controller.safeMessage {
                Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(idPrefix + ".message")
            }
            if controller.imageDraft != nil {
                Label("Imagem pronta. Salve para aplicá-la.", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier(idPrefix + ".draft-ready")
            } else if mascotShown, appearance?.wrappedValue.isDirty == true {
                Label(pair("Mascote pronto. Salve para aplicá-lo.", "Mascot ready. Save to apply it."), systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier(idPrefix + ".mascot-draft-ready")
            }
        }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            selectFile(result)
        }
        .confirmationDialog("Remover a chave OpenAI para imagens?", isPresented: $confirmingRemoveKey, titleVisibility: .visible) {
            Button("Remover chave", role: .destructive) { removeKey() }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A geração ficará indisponível até você salvar uma chave novamente. Os avatares já salvos serão mantidos.") }
        .sheet(isPresented: mascotSheetPresented) { mascotSheet }
        // The sheet exists only while the mascot is the chosen avatar with no image above it (Descartar/Recarregar close it).
        .onChange(of: mascotShown) { _, shown in if !shown { showingMascot = false; mascotSheetSnapshot = nil } }
        .onChange(of: hostID) { _, _ in invalidatePrivateWork() }
        .onDisappear { privateKey = ""; generationTask?.cancel(); controller.cancelGeneration() }
    }

    @ViewBuilder private var avatarButtons: some View {
        if let appearance {
            Button { openMascot(appearance) } label: {
                Label(mascotShown ? pair("Editar mascote", "Edit mascot") : pair("Mascote", "Mascot"), systemImage: "paintpalette")
            }
                .disabled(controller.isGenerating)
                .help(pair("Monte um mascote com corpo, olhos, cor e movimento. Sem IA e sem custo.",
                           "Build a mascot from body, eyes, color and motion. No AI and no cost."))
                .accessibilityAddTraits(mascotShown ? [.isSelected] : [])
                .accessibilityIdentifier(idPrefix + ".mascot-option")
        }
        Button { showingEmoji.toggle() } label: { Label("Emoji", systemImage: "face.smiling") }
            .disabled(controller.isGenerating).accessibilityIdentifier(idPrefix + ".emoji-option")
        Button { localMessage = nil; showingImporter = true } label: { Label("Enviar imagem", systemImage: "photo.badge.plus") }
            .disabled(controller.isGenerating).accessibilityIdentifier(idPrefix + ".upload")
        Button {
            showingGeneration.toggle(); privateKey = ""; localMessage = nil
            if let hostID { controller.refreshKeyStatus(hostID: hostID) }
        } label: { Label("Gerar com IA", systemImage: "sparkles") }
            .disabled(controller.isGenerating).accessibilityIdentifier(idPrefix + ".generate")
    }

    private var preview: some View {
        Group {
            if let draft = controller.imageDraft, let image = NSImage(data: draft.pngData) {
                Image(nsImage: image).resizable().scaledToFill().frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
            } else {
                DexterAvatarView(image: removedExistingImage ? nil : existingImage, emoji: emojiValid ? emoji : nil,
                                 fallbackSystemImage: fallbackSystemImage, model: model, size: 84,
                                 appearance: appearance?.wrappedValue.selected, mascotSeed: idPrefix)
            }
        }.accessibilityLabel("Prévia do avatar").accessibilityIdentifier(idPrefix + ".preview")
    }

    private var generationPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Divider()
            HStack {
                Label("Gerar avatar com OpenAI", systemImage: "sparkles").font(.subheadline.weight(.semibold))
                Spacer()
                Button { privateKey = ""; showingGeneration = false } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).disabled(controller.isGenerating).accessibilityLabel("Fechar geração de avatar")
                    .accessibilityIdentifier(idPrefix + ".close-generation")
            }
            LabeledContent("Modelo", value: AvatarImageGenerationCatalog.modelLabel).font(.caption)
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Chave OpenAI para imagens").font(.caption.weight(.semibold))
                    Spacer()
                    Text(keyStatusLabel).font(.caption).foregroundStyle(.secondary)
                }
                SecureField(controller.keyStatus == .configured ? "Cole para substituir a chave" : "Cole sua chave OpenAI", text: $privateKey)
                    .textFieldStyle(.roundedBorder).disabled(controller.isGenerating)
                    .accessibilityIdentifier(idPrefix + ".key")
                HStack(spacing: 12) {
                    Button("Salvar chave", action: saveKey).disabled(privateKey.isEmpty || controller.isGenerating || hostID == nil)
                        .accessibilityIdentifier(idPrefix + ".key-save")
                    if controller.keyStatus == .configured {
                        Button("Remover chave", role: .destructive) { confirmingRemoveKey = true }
                            .disabled(controller.isGenerating).accessibilityIdentifier(idPrefix + ".key-remove")
                    }
                }
                Text("A chave fica no armazenamento privado deste Mac, vinculada à base. Ela não aparece na conversa nem acompanha o avatar.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack { Text("Descreva o avatar").font(.caption.weight(.semibold)); Spacer(); Text("\(prompt.utf16.count)/2.000").font(.caption).foregroundStyle(.secondary) }
                TextEditor(text: $prompt).font(.body).scrollContentBackground(.hidden)
                    .padding(8).frame(minHeight: 90, idealHeight: 110)
                    .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.18)))
                    .disabled(controller.isGenerating).accessibilityLabel("Descrição do avatar")
                    .accessibilityIdentifier(idPrefix + ".prompt")
                Text("Ex.: uma casinha simpática, minimalista, com cores verdes e fundo claro.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(alignment: .center, spacing: 12) {
                Text("Cada geração usa a API OpenAI e pode gerar cobrança na sua conta. O resultado fica como rascunho até você salvar.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if controller.isGenerating {
                    ProgressView().controlSize(.small)
                    Button("Cancelar") { generationTask?.cancel(); controller.cancelGeneration() }
                        .accessibilityIdentifier(idPrefix + ".cancel-generation")
                } else {
                    Button("Gerar avatar", action: generate).buttonStyle(.borderedProminent)
                        .disabled(!promptValid || controller.keyStatus != .configured || hostID == nil)
                        .accessibilityIdentifier(idPrefix + ".generate-submit")
                }
            }
        }.padding(14)
            .background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }

    private func selectFile(_ result: Result<[URL], Error>) {
        guard !controller.isGenerating else { return }
        do {
            guard let url = try result.get().first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= 10 * 1_024 * 1_024 else {
                localMessage = String(localized: "Escolha um arquivo de imagem de até 10 MB."); return
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            guard let bytes = try handle.read(upToCount: 10 * 1_024 * 1_024 + 1), bytes.count <= 10 * 1_024 * 1_024 else {
                localMessage = String(localized: "A imagem excede o limite de 10 MB."); return
            }
            try controller.selectImage(bytes)
            removedExistingImage = false; localMessage = nil
            // Image import: the mascot draft is cleared; Save sends the image and the cleared recipe together.
            appearance?.wrappedValue.clear(); showingMascot = false
        } catch { localMessage = String(localized: "Não foi possível abrir essa imagem. Use PNG, JPEG, WebP ou GIF estático de até 10 MB.") }
    }
    private func saveKey() {
        guard let hostID, !controller.isGenerating else { return }
        let value = privateKey; privateKey = ""
        do { try controller.saveKey(value, hostID: hostID); localMessage = String(localized: "Chave OpenAI salva no armazenamento privado deste Mac.") }
        catch { localMessage = String(localized: "Não foi possível salvar a chave. Confira o valor e o armazenamento privado do Mac.") }
    }
    private func removeKey() {
        guard let hostID, !controller.isGenerating else { return }; privateKey = ""
        do { try controller.removeKey(hostID: hostID); localMessage = String(localized: "Chave para imagens removida.") }
        catch { localMessage = String(localized: "Não foi possível remover a chave. Tente novamente no armazenamento privado do Mac.") }
    }
    private func generate() {
        guard let hostID, !controller.isGenerating, promptValid, controller.keyStatus == .configured else { return }
        privateKey = ""; localMessage = nil
        let requestScope = viewScope
        generationTask = Task { @MainActor in
            let generated = await controller.generate(prompt: prompt, hostID: hostID)
            guard !Task.isCancelled, viewScope == requestScope, hostID == self.hostID else { return }
            if generated { removedExistingImage = false; appearance?.wrappedValue.clear(); showingMascot = false }
            generationTask = nil
        }
    }
    private var mascotSheetPresented: Binding<Bool> {
        Binding(get: { showingMascot && mascotShown }, set: { if !$0 { showingMascot = false } })
    }

    /// Opens the creator. The first time it is also the explicit mascot choice (`chooseMascot`).
    private func openMascot(_ appearance: Binding<BotAvatarAppearanceDraft>) {
        guard !controller.isGenerating else { return }
        mascotSheetSnapshot = MascotSheetSnapshot(draft: appearance.wrappedValue, removedExistingImage: removedExistingImage,
                                                  imageDraft: controller.imageDraft, imageDraftSetAside: controller.setAsideImageDraft)
        if !mascotShown { chooseMascot(appearance) }
        showingGeneration = false; privateKey = ""; localMessage = nil
        showingMascot = true
    }

    /// Explicit mascot choice: an image draft is set aside and a visible stored image is marked for removal, both in the
    /// same Save. The draft remembers what was displaced so "Remover mascote" can give exactly that back; an image the
    /// owner had already removed by hand stays removed.
    private func chooseMascot(_ appearance: Binding<BotAvatarAppearanceDraft>) {
        let displaced = BotAvatarAppearanceDraft.displacement(hasImageDraft: controller.imageDraft != nil, hasStoredImage: existingImage != nil,
                                                              storedImageAlreadyRemoved: removedExistingImage)
        // The controller keeps the set-aside draft for the whole window, so a page switch does not lose it.
        controller.setAsideImageDraftForMascot()
        if existingImage != nil { removedExistingImage = true }
        appearance.wrappedValue.select(displacing: displaced)
    }

    private func removeMascot(_ appearance: Binding<BotAvatarAppearanceDraft>) {
        localMessage = nil
        let restore = appearance.wrappedValue.removeMascot()
        if restore.contains(.storedImage) { removedExistingImage = false }
        // Same bytes as before (no new upload or paid generation); say so plainly when nothing can be given back.
        if restore.contains(.imageDraft), !controller.restoreSetAsideImageDraft() {
            localMessage = pair("Não foi possível trazer de volta a imagem escolhida antes. Escolha-a de novo.",
                                "Could not bring back the image chosen before. Choose it again.")
        }
        controller.forgetSetAsideImageDraft()
        showingMascot = false; mascotSheetSnapshot = nil
    }

    /// X/Escape: the mascot choice, the image marks and the image draft go back to what they were when the sheet opened.
    private func cancelMascotSheet(_ appearance: Binding<BotAvatarAppearanceDraft>) {
        if let snapshot = mascotSheetSnapshot {
            appearance.wrappedValue = snapshot.draft
            removedExistingImage = snapshot.removedExistingImage
            controller.restoreDrafts(imageDraft: snapshot.imageDraft, setAside: snapshot.imageDraftSetAside)
        }
        mascotSheetSnapshot = nil; showingMascot = false
    }

    @ViewBuilder private var mascotSheet: some View {
        if let appearance {
            BotMascotCreatorSheet(
                appearance: Binding(get: { appearance.wrappedValue.working }, set: { appearance.wrappedValue.edit($0) }),
                title: pair("Mascote do bot", "Bot mascot"),
                footnote: pair("Desenhado no app, sem IA e sem custo. Concluído mantém no rascunho; vai para a base quando você salvar o perfil.",
                               "Drawn by the app, no AI and no cost. Done keeps it in the draft; it reaches the host when you save the profile."),
                closeHelp: pair("Fechar sem aplicar as mudanças deste painel (Esc). O avatar volta ao que era antes de abrir.",
                                "Close without applying this panel’s changes (Esc). The avatar goes back to what it was before opening."),
                baseline: appearance.wrappedValue.baseline, restorePoint: .saved, idPrefix: idPrefix + ".mascot",
                closeID: idPrefix + ".mascot-close", doneID: idPrefix + ".mascot-done",
                onCancel: { cancelMascotSheet(appearance) },
                onDone: { mascotSheetSnapshot = nil; showingMascot = false })
        }
    }

    private func invalidatePrivateWork() {
        showingMascot = false; mascotSheetSnapshot = nil; controller.forgetSetAsideImageDraft()
        viewScope = UUID(); privateKey = ""; generationTask?.cancel(); generationTask = nil
        controller.cancelGeneration(); localMessage = nil; showingGeneration = false
    }
}
// MARK: - Main window surfaces

/// Presentation-only tokens of the main window. Dark values follow the team window reference; light values stay
/// close to the system palette. Nothing here reads or changes host state.
enum DexterSurface {
    static func adaptive(dark: NSColor, light: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua, .accessibilityHighContrastDarkAqua, .accessibilityHighContrastAqua])
                .map { $0 == .darkAqua || $0 == .accessibilityHighContrastDarkAqua } == true ? dark : light
        })
    }
    private static func white(_ alpha: CGFloat) -> NSColor { NSColor(white: 1, alpha: alpha) }
    private static func black(_ alpha: CGFloat) -> NSColor { NSColor(white: 0, alpha: alpha) }
    static let panelFill = adaptive(dark: white(0.045), light: black(0.028))
    static let panelStroke = adaptive(dark: white(0.07), light: black(0.08))
    static let raisedFill = adaptive(dark: white(0.07), light: black(0.045))
    static let raisedStroke = adaptive(dark: white(0.12), light: black(0.12))
    static let bubbleFill = adaptive(dark: white(0.07), light: black(0.045))
    static let bubbleStroke = adaptive(dark: white(0.06), light: black(0.06))
    static let insetFill = adaptive(dark: black(0.24), light: black(0.045))
    static let chipFill = adaptive(dark: white(0.08), light: black(0.06))
    static let attention = adaptive(dark: NSColor(red: 0.992, green: 0.729, blue: 0.455, alpha: 1),
                                    light: NSColor(red: 0.761, green: 0.255, blue: 0.047, alpha: 1))
    static let positive = adaptive(dark: NSColor(red: 0.369, green: 0.918, blue: 0.831, alpha: 1),
                                   light: NSColor(red: 0.059, green: 0.463, blue: 0.431, alpha: 1))
    /// Ring behind overlapped avatars, matching the surface they sit on.
    static let avatarRing = Color(nsColor: .windowBackgroundColor)

    /// Stable display tint for a bot name in a conversation; derived from the id only, never persisted.
    static func speakerTint(for id: String) -> Color {
        let pairs: [(UInt32, UInt32)] = [(0xC4B5FD, 0x6D28D9), (0x5EEAD4, 0x0F766E), (0xFDBA74, 0xC2410C),
                                         (0x93C5FD, 0x1D4ED8), (0x86EFAC, 0x15803D), (0xFDA4AF, 0xBE123C)]
        var hash: UInt32 = 2_166_136_261
        for byte in id.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
        let pair = pairs[Int(hash % UInt32(pairs.count))]
        func color(_ rgb: UInt32) -> NSColor {
            NSColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
        }
        return adaptive(dark: color(pair.0), light: color(pair.1))
    }
}

/// Rounded inset panel used by the inspector and other floating regions. Increased contrast strengthens the edge.
struct DexterPanelBackground: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    var cornerRadius: CGFloat = 18
    var fill: Color = DexterSurface.panelFill
    var stroke: Color = DexterSurface.panelStroke
    func body(content: Content) -> some View {
        content
            .background(fill, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(contrast == .increased ? Color.primary.opacity(0.45) : stroke))
    }
}

extension View {
    func dexterPanel(cornerRadius: CGFloat = 18, fill: Color = DexterSurface.panelFill, stroke: Color = DexterSurface.panelStroke) -> some View {
        modifier(DexterPanelBackground(cornerRadius: cornerRadius, fill: fill, stroke: stroke))
    }
}

/// Small status capsule (state only; it is not a control).
struct DexterStatusChip: View {
    let text: LocalizedStringKey
    var tint: Color? = nil
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold)).lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .foregroundStyle(tint ?? Color.secondary)
            .background((tint ?? Color.primary).opacity(tint == nil ? 0.08 : 0.16), in: Capsule())
    }
}

/// Count badge for items that wait for the user.
struct DexterCountBadge: View {
    let count: Int
    var onAccent = false
    var body: some View {
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .bold)).monospacedDigit()
            .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
            .foregroundStyle(onAccent ? Color.black.opacity(0.85) : Color.primary)
            .background(onAccent ? Color.white : DexterSurface.chipFill, in: Capsule())
    }
}

/// Capsule buttons of the main window: prominent uses the accent; plain is a raised neutral capsule.
struct DexterCapsuleButtonStyle: ButtonStyle {
    var prominent = false
    var height: CGFloat = 30
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.colorSchemeContrast) private var contrast
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: prominent ? .semibold : .medium))
            .padding(.horizontal, prominent ? 16 : 12).frame(minHeight: height)
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .background(prominent ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(DexterSurface.raisedFill), in: Capsule())
            .overlay(Capsule().strokeBorder(prominent ? Color.clear : (contrast == .increased ? Color.primary.opacity(0.5) : DexterSurface.raisedStroke)))
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
            .contentShape(Capsule())
    }
}

/// A team shown by its members: up to three overlapped avatars inside one square, like a group icon.
/// A team with its own image or emoji keeps that identity instead.
@MainActor struct DexterTeamAvatar: View {
    let team: Team
    let members: [Bot]
    let model: DexterAppModel
    var size: CGFloat = 32
    var ring: Color = DexterSurface.avatarRing
    var activity: BotMascotActivity = .idle
    var memberActivities: [String: BotMascotActivity] = [:]
    var showsActivityIndicator = false

    var body: some View {
        Group {
            if team.avatarImage != nil || !(team.avatarEmoji ?? "").isEmpty || members.isEmpty {
                DexterAvatarView(image: team.avatarImage, emoji: team.avatarEmoji, fallbackSystemImage: "person.3", model: model, size: size)
            } else if members.count == 1 {
                avatar(members[0], size: size)
            } else if members.count == 2 {
                ZStack(alignment: .topLeading) {
                    avatar(members[0], size: size * 0.625).offset(x: 0, y: size * 0.125)
                    avatar(members[1], size: size * 0.625).offset(x: size * 0.375, y: size * 0.31)
                }.frame(width: size, height: size, alignment: .topLeading)
            } else {
                ZStack(alignment: .topLeading) {
                    avatar(members[0], size: size * 0.5625).offset(x: 0, y: size * 0.03)
                    avatar(members[1], size: size * 0.5625).offset(x: size * 0.4375, y: size * 0.03)
                    avatar(members[2], size: size * 0.5625).offset(x: size * 0.22, y: size * 0.4375)
                }.frame(width: size, height: size, alignment: .topLeading)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if showsActivityIndicator {
                BotActivityIndicatorView(activity: activity,
                    motion: members.first(where: { $0.id == team.coordinatorBotId })?.avatarAppearance?.motion ?? .subtle)
            }
        }
        .accessibilityHidden(true)
    }

    private func avatar(_ bot: Bot, size: CGFloat) -> some View {
        DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
                         fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: size,
                         appearance: bot.avatarAppearance, activity: memberActivities[bot.id] ?? .idle,
                         isActivityObserved: !showsActivityIndicator || memberActivities[bot.id] != nil, mascotSeed: bot.id)
            .background(RoundedRectangle(cornerRadius: max(8, size * 0.24) + 2).fill(ring).padding(-2))
    }
}

/// Reserved place for the conversation approval-mode selector next to the composer. The selector, its modes and
/// their policy belong to the approvals component; until it is connected this slot only says it is not available.
struct ChatApprovalModeSlot: View {
    var body: some View {
        Button {} label: {
            HStack(spacing: 6) {
                Image(systemName: "lock").font(.system(size: 12, weight: .medium))
                Text("Modo de aprovação").font(.system(size: 12))
            }
            .padding(.horizontal, 10).frame(height: 30)
            .foregroundStyle(.secondary)
            .background(DexterSurface.raisedFill, in: Capsule())
            .overlay(Capsule().strokeBorder(DexterSurface.raisedStroke))
        }
        .buttonStyle(.plain)
        .disabled(true)
        .help("Os modos de aprovação ainda não estão disponíveis nesta versão. As aprovações seguem os acessos atuais de cada bot.")
        .accessibilityLabel("Modo de aprovação")
        .accessibilityValue("Ainda não disponível")
        .accessibilityIdentifier("chat.approval-mode.unavailable")
    }
}
#endif
