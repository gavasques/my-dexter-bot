#if os(macOS)
import AppKit
import Darwin
import DexterAppCore
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// A plain-text native editor. The pasteboard is consulted only in the explicit Paste command.
struct MacChatComposer: View {
    @Binding var text: String
    @Binding var focused: Bool
    let enabled: Bool
    var placeholder = String(localized: "Mensagem para o bot")
    let pasteboard: NSPasteboard
    let remainingImages: Int
    let onImages: ([ChatComposerImage]) -> Void
    let onError: (String) -> Void
    let onSubmit: () -> Void
    @State private var height: CGFloat = 28

    var body: some View {
        MacChatTextEditor(text: $text, focused: $focused, enabled: enabled, placeholder: placeholder, pasteboard: pasteboard,
            remainingImages: remainingImages, onImages: onImages, onError: onError, onSubmit: onSubmit,
            onHeight: { value in if abs(height - value) > 0.5 { height = value } })
            .frame(height: height)
    }
}

private struct MacChatTextEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let enabled: Bool
    let placeholder: String
    let pasteboard: NSPasteboard
    let remainingImages: Int
    let onImages: ([ChatComposerImage]) -> Void
    let onError: (String) -> Void
    let onSubmit: () -> Void
    let onHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let editor = ImagePasteTextView(frame: NSRect(x: 0, y: 0, width: 100, height: 28))
        editor.delegate = context.coordinator
        editor.isRichText = false; editor.importsGraphics = false; editor.allowsUndo = true
        editor.drawsBackground = false; editor.font = .systemFont(ofSize: 14); editor.textColor = .labelColor
        editor.textContainerInset = NSSize(width: 0, height: 5)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.heightTracksTextView = false; editor.textContainer?.lineFragmentPadding = 0
        editor.minSize = NSSize(width: 0, height: 28); editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.setAccessibilityIdentifier("chat.composer"); editor.setAccessibilityLabel(String(localized: "Mensagem"))
        editor.onLayout = { [weak coordinator = context.coordinator] in coordinator?.measure() }
        scroll.documentView = editor
        configure(editor, coordinator: context.coordinator)
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? ImagePasteTextView else { return }
        configure(editor, coordinator: context.coordinator)
        if editor.string != text {
            editor.string = text
            editor.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            editor.needsDisplay = true
        }
        context.coordinator.measure()
        if enabled && focused && editor.window?.firstResponder !== editor { editor.window?.makeFirstResponder(editor) }
        else if !focused && editor.window?.firstResponder === editor { editor.window?.makeFirstResponder(nil) }
    }
    private func configure(_ editor: ImagePasteTextView, coordinator: Coordinator) {
        editor.isEditable = enabled; editor.isSelectable = true
        editor.placeholder = placeholder
        editor.pasteboard = pasteboard; editor.remainingImages = remainingImages
        editor.onImages = onImages; editor.onError = onError; editor.onSubmit = onSubmit
        coordinator.editor = editor
    }
    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacChatTextEditor
        weak var editor: ImagePasteTextView?
        init(_ parent: MacChatTextEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor else { return }; parent.text = editor.string; editor.needsDisplay = true; measure()
        }
        func textDidBeginEditing(_ notification: Notification) { parent.focused = true }
        func textDidEndEditing(_ notification: Notification) { parent.focused = false }
        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSTextView.insertNewline(_:)),
               NSApp.currentEvent?.modifierFlags.contains(.shift) != true {
                parent.onSubmit(); return true
            }
            return false
        }
        func measure() {
            guard let editor, let layout = editor.layoutManager, let container = editor.textContainer else { return }
            layout.ensureLayout(for: container)
            let line = layout.defaultLineHeight(for: editor.font ?? .systemFont(ofSize: 14))
            let target = max(line + 10, min(layout.usedRect(for: container).height + 10, line * 6 + 10))
            DispatchQueue.main.async { [weak self] in self?.parent.onHeight(target) }
        }
    }
}

/// Kept internal so the isolated fixture exercises exactly the production paste route.
final class ImagePasteTextView: NSTextView {
    var placeholder = String(localized: "Mensagem para o bot") {
        didSet { if placeholder != oldValue { needsDisplay = true } }
    }
    var pasteboard: NSPasteboard = .general
    var remainingImages = 4
    var onImages: (([ChatComposerImage]) -> Void)?
    var onError: ((String) -> Void)?
    var onSubmit: (() -> Void)?
    var onLayout: (() -> Void)?

    override func layout() { super.layout(); onLayout?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 && event.modifierFlags.contains(.command) { onSubmit?(); return }
        super.keyDown(with: event)
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty {
            (placeholder as NSString).draw(at: NSPoint(x: 0, y: 5), withAttributes: [
                .font: font ?? NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.placeholderTextColor])
        }
    }
    override func paste(_ sender: Any?) {
        guard isEditable else { return }
        do {
            let images = try MacPastedImages.read(from: pasteboard, maximumCount: remainingImages)
            if !images.isEmpty { onImages?(images); return }
            if let value = pasteboard.string(forType: .string), value.utf8.count > 64 * 1_024 { throw MacPastedImages.Failure.text }
            // The private fixture pasteboard never reads or writes the user's general clipboard.
            if pasteboard !== NSPasteboard.general {
                if let value = pasteboard.string(forType: .string), value.utf8.count <= 64 * 1_024 {
                    insertText(value, replacementRange: selectedRange())
                }
            } else { super.paste(sender) }
        } catch { onError?(error.localizedDescription) }
    }
}

@MainActor
enum MacPastedImages {
    enum Failure: LocalizedError {
        case count, file, invalid, size, text
        var errorDescription: String? {
            switch self {
            case .count: String(localized: "Cole até quatro imagens por mensagem. Remova um anexo para adicionar outro.")
            case .file: String(localized: "Cole uma imagem local regular. Links remotos, aliases e arquivos especiais não são aceitos.")
            case .invalid: String(localized: "Não foi possível ler esta imagem. Use PNG, TIFF ou uma imagem local estática.")
            case .size: String(localized: "A imagem excede os limites: PNG de até 2 MiB, 4096 pixels por lado e 16 milhões de pixels.")
            case .text: String(localized: "O texto colado excede o limite de 64 KiB. Divida a mensagem antes de enviar.")
            }
        }
    }
    static func read(from pasteboard: NSPasteboard, maximumCount: Int) throws -> [ChatComposerImage] {
        let items = pasteboard.pasteboardItems ?? []
        let imageItems = items.filter { $0.types.contains(.png) || $0.types.contains(.tiff) || $0.types.contains(.fileURL) }
        guard imageItems.count <= maximumCount else { throw Failure.count }
        var result: [ChatComposerImage] = []
        for item in imageItems {
            let data: Data
            if item.types.contains(.png), let value = item.data(forType: .png) { data = value }
            else if item.types.contains(.tiff), let value = item.data(forType: .tiff) { data = value }
            else if let raw = item.string(forType: .fileURL), let url = URL(string: raw), url.isFileURL,
                    url.query == nil, url.fragment == nil, url.user == nil, url.password == nil,
                    url.path.utf8.count <= 4_096, !url.path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                    url.host == nil || url.host == "" || url.host == "localhost" { data = try localFile(url) }
            else { throw Failure.file }
            result.append(try normalize(data))
        }
        return result
    }
    private static func localFile(_ url: URL) throws -> Data {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw Failure.file }; defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
              info.st_size > 0, info.st_size <= 16 * 1_024 * 1_024 else { throw Failure.file }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
        let data = try handle.read(upToCount: Int(info.st_size) + 1) ?? Data()
        guard data.count == Int(info.st_size) else { throw Failure.file }
        return data
    }
    static func normalize(_ data: Data) throws -> ChatComposerImage {
        guard !data.isEmpty, data.count <= 16 * 1_024 * 1_024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw Failure.invalid }
        // Dimensions are checked from metadata before allocating decoded pixels (at most 64 MB).
        guard (1...4_096).contains(width), (1...4_096).contains(height), width * height <= 16_000_000,
              (properties[kCGImagePropertyDepth] as? Int ?? 8) <= 8 else { throw Failure.size }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                       kCGImageSourceCreateThumbnailWithTransform: true,
                       kCGImageSourceThumbnailMaxPixelSize: max(width, height),
                       kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              image.width <= 4_096, image.height <= 4_096, image.width * image.height <= 16_000_000,
              image.bitsPerPixel <= 32 else { throw Failure.invalid }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else { throw Failure.invalid }
        CGImageDestinationAddImage(destination, image, [:] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw Failure.invalid }
        let png = output as Data
        guard png.count <= 2 * 1_024 * 1_024 else { throw Failure.size }
        return try ChatComposerImage(pngData: png, width: image.width, height: image.height)
    }
    static func thumbnail(_ data: Data) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 256, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
#endif
