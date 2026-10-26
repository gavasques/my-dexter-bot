#if os(macOS)
import AppKit
import DexterAppCore
import SwiftUI

private struct ChatCopyPasteboardKey: EnvironmentKey {
    static var defaultValue: NSPasteboard { .general }
}

extension EnvironmentValues {
    /// Isolated QA can inject a named pasteboard without reading or replacing the user's clipboard.
    var chatCopyPasteboard: NSPasteboard {
        get { self[ChatCopyPasteboardKey.self] }
        set { self[ChatCopyPasteboardKey.self] = newValue }
    }
}

/// One TextKit document per message: selection can cross headings, lists and code.
struct MacSelectableChatMessage: NSViewRepresentable {
    @Environment(\.chatCopyPasteboard) private var pasteboard
    let content: String
    var isLiteral = false
    var isStreaming = false
    /// Text on an accent-filled bubble reads with the dark appearance's label colors in both modes.
    var onAccent = false

    func makeNSView(context: Context) -> MacChatDocumentView {
        let view = MacChatDocumentView(pasteboard: pasteboard)
        view.appearance = onAccent ? NSAppearance(named: .darkAqua) : nil
        view.apply(content: content, isLiteral: isLiteral, isStreaming: isStreaming)
        return view
    }

    func updateNSView(_ view: MacChatDocumentView, context: Context) {
        view.setCopyPasteboard(pasteboard)
        let appearance = onAccent ? NSAppearance(named: .darkAqua) : nil
        if view.appearance?.name != appearance?.name { view.appearance = appearance }
        view.apply(content: content, isLiteral: isLiteral, isStreaming: isStreaming)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: MacChatDocumentView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        return CGSize(width: width, height: nsView.documentHeight(at: width))
    }
}

struct MacChatCodeRegion {
    let range: NSRange
    let language: String?
    let source: String
    let incomplete: Bool
    /// A closed ```chart fence that parsed: drawn natively over `plotCharacter`, its data stays selectable text.
    var chart: ChatChartSpec? = nil
    var plotCharacter: Int? = nil
    /// A ```chart fence that did not parse is shown as its literal source with this note.
    var chartRejected = false
}

struct MacChatDocument {
    let text: NSAttributedString
    let codeRegions: [MacChatCodeRegion]
    let quoteRanges: [NSRange]
    /// The document ends with a table cell terminator whose empty trailing line is not content.
    var endsWithTableTerminator = false
}

extension NSAttributedString.Key {
    /// What Copy writes for this character instead of the character itself (table cell ends, chart plot space).
    static let chatCopyReplacement = NSAttributedString.Key("DexterChatCopyReplacement")
}

@MainActor
enum MacChatDocumentBuilder {
    static func make(content: String, isLiteral: Bool = false, isStreaming: Bool = false) -> MacChatDocument {
        let result = NSMutableAttributedString()
        var codes: [MacChatCodeRegion] = []
        var quotes: [NSRange] = []
        let bodyFont = NSFont.systemFont(ofSize: 14)
        let blocks: [ChatFormattedBlock] = isLiteral ? [.literal(content)] : ChatMessageFormatting.parse(content)
        var previousWasList = false
        var previousWasTable = false
        for block in blocks {
            let isList: Bool
            if case .listItem = block { isList = true } else { isList = false }
            if result.length > 0 {
                // A native table already ends with its last cell's paragraph terminator.
                let separator = previousWasTable || (previousWasList && isList) ? "\n" : "\n\n"
                result.append(NSAttributedString(string: separator, attributes: [.font: bodyFont]))
            }
            previousWasTable = false
            switch block {
            case .paragraph(let source):
                result.append(inline(source, font: bodyFont))
            case .heading(let level, let source):
                let size: CGFloat = level == 1 ? 24 : level == 2 ? 21 : level == 3 ? 18 : 16
                result.append(inline(source, font: .systemFont(ofSize: size, weight: .semibold)))
            case .listItem(let marker, let source):
                let start = result.length
                result.append(NSAttributedString(string: marker + "\t", attributes: [.font: bodyFont, .foregroundColor: NSColor.secondaryLabelColor]))
                result.append(inline(source, font: bodyFont))
                let style = paragraphStyle()
                style.headIndent = 26
                style.firstLineHeadIndent = 4
                style.tabStops = [NSTextTab(textAlignment: .left, location: 26)]
                result.addAttribute(.paragraphStyle, value: style, range: NSRange(location: start, length: result.length - start))
            case .quote(let source):
                let start = result.length
                result.append(inline(source, font: bodyFont, color: .secondaryLabelColor))
                let range = NSRange(location: start, length: result.length - start)
                let style = paragraphStyle()
                style.headIndent = 14; style.firstLineHeadIndent = 14
                result.addAttribute(.paragraphStyle, value: style, range: range)
                quotes.append(range)
            case .code(let language, let source, let incomplete) where !incomplete && ChatChart.isChartFence(language: language):
                if case .success(let spec) = ChatChart.parse(source) {
                    codes.append(appendChart(spec, source: source, language: language, to: result, bodyFont: bodyFont))
                } else {
                    codes.append(appendCode(language: language, source: source, incomplete: false, rejectedChart: true, to: result, bodyFont: bodyFont))
                }
            case .code(let language, let source, let incomplete):
                codes.append(appendCode(language: language, source: source, incomplete: incomplete, rejectedChart: false, to: result, bodyFont: bodyFont))
            case .table(let headers, let rows):
                if (!isStreaming || rows.count <= 12), let layout = ChatTableLayout.make(headers: headers, rows: rows) {
                    appendTable(layout, to: result)
                    previousWasTable = true
                } else {
                    appendTableFallback(headers: headers, rows: rows, to: result)
                }
            case .divider:
                result.append(NSAttributedString(string: "────────", attributes: [.font: bodyFont, .foregroundColor: NSColor.separatorColor]))
            case .literal(let source):
                result.append(NSAttributedString(string: source, attributes: [.font: bodyFont, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraphStyle()]))
            }
            previousWasList = isList
        }
        return MacChatDocument(text: result, codeRegions: codes, quoteRanges: quotes, endsWithTableTerminator: previousWasTable)
    }

    private static func appendCode(language: String?, source: String, incomplete: Bool, rejectedChart: Bool, to result: NSMutableAttributedString, bodyFont: NSFont) -> MacChatCodeRegion {
        let start = result.length
        // An empty, reserved header line belongs to the same selectable document.
        // Its native controls are overlays, so copying never adds a synthetic language label.
        result.append(headerLine(bodyFont))
        let codeStyle = paragraphStyle()
        codeStyle.headIndent = 12; codeStyle.firstLineHeadIndent = 12; codeStyle.tailIndent = -12
        codeStyle.lineBreakMode = .byCharWrapping
        result.append(NSAttributedString(string: source.isEmpty ? "\n" : source, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: codeStyle
        ]))
        return MacChatCodeRegion(range: NSRange(location: start, length: result.length - start), language: language, source: source, incomplete: incomplete, chartRejected: rejectedChart)
    }

    private static func headerLine(_ font: NSFont) -> NSAttributedString {
        let style = paragraphStyle()
        style.minimumLineHeight = 34; style.maximumLineHeight = 34
        return NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: style])
    }

    static let chartPlotHeight: CGFloat = 196

    /// The chart's frame, title and data are one region of the same text document:
    /// a reserved plot line carries the native drawing, and every value follows as selectable text.
    private static func appendChart(_ spec: ChatChartSpec, source: String, language: String?, to result: NSMutableAttributedString, bodyFont: NSFont) -> MacChatCodeRegion {
        let start = result.length
        result.append(headerLine(bodyFont))
        let textStyle = paragraphStyle()
        textStyle.headIndent = 12; textStyle.firstLineHeadIndent = 12; textStyle.tailIndent = -12
        if let title = spec.title {
            result.append(NSAttributedString(string: title + "\n", attributes: [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: NSColor.labelColor, .paragraphStyle: textStyle]))
        }
        let plotStyle = NSMutableParagraphStyle()
        plotStyle.minimumLineHeight = chartPlotHeight; plotStyle.maximumLineHeight = chartPlotHeight
        let plot = result.length
        result.append(NSAttributedString(string: "\n", attributes: [.font: bodyFont, .paragraphStyle: plotStyle, .chatCopyReplacement: ""]))
        var lines: [String] = []
        if let unit = spec.unit { lines.append(String(localized: "Unidade: \(unit)")) }
        for row in ChatChart.rows(spec) {
            let values = spec.series.count == 1
                ? row.values[0].literal
                : row.values.map { "\($0.series) \($0.literal)" }.joined(separator: " · ")
            lines.append("\(row.category): \(values)")
        }
        let altStyle = textStyle.mutableCopy() as! NSMutableParagraphStyle
        altStyle.lineSpacing = 2
        result.append(NSAttributedString(string: lines.joined(separator: "\n"), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
            .paragraphStyle: altStyle
        ]))
        return MacChatCodeRegion(range: NSRange(location: start, length: result.length - start), language: language, source: source, incomplete: false, chart: spec, plotCharacter: plot)
    }

    /// One native text-table cell per Markdown cell, inside the message's single text view.
    /// Selection runs across cells; Copy writes tabs between cells and a newline after each row.
    private static func appendTable(_ layout: ChatTableLayout, to result: NSMutableAttributedString) {
        let table = NSTextTable()
        table.numberOfColumns = layout.columnCount
        table.layoutAlgorithm = .fixedLayoutAlgorithm
        table.collapsesBorders = true
        table.hidesEmptyCells = false
        for (rowIndex, row) in ([layout.header] + layout.rows).enumerated() {
            let isHeader = rowIndex == 0
            for (column, cell) in row.enumerated() {
                let block = NSTextTableBlock(table: table, startingRow: rowIndex, rowSpan: 1, startingColumn: column, columnSpan: 1)
                block.setValue(CGFloat(layout.widthFractions[column] * 100), type: .percentageValueType, for: .width)
                block.setWidth(8, type: .absoluteValueType, for: .padding, edge: .minX)
                block.setWidth(8, type: .absoluteValueType, for: .padding, edge: .maxX)
                block.setWidth(isHeader ? 6 : 5, type: .absoluteValueType, for: .padding, edge: .minY)
                block.setWidth(isHeader ? 6 : 5, type: .absoluteValueType, for: .padding, edge: .maxY)
                block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxY)
                block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxX)
                if column == 0 { block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .minX) }
                if isHeader { block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .minY) }
                block.setBorderColor(.separatorColor)
                if isHeader { block.backgroundColor = NSColor.labelColor.withAlphaComponent(0.06) }
                let style = paragraphStyle()
                style.lineSpacing = 2
                style.textBlocks = [block]
                style.alignment = layout.alignments[column] == .trailing && !isHeader ? .right : .left
                let font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: isHeader ? .semibold : .regular)
                let start = result.length
                let text = cell.replacingOccurrences(of: "\n", with: " ")
                // Most cells are plain words or numbers; skip the Markdown parser for them.
                result.append(ChatTableLayout.hasInlineSyntax(text) ? inline(text, font: font) : NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
                result.append(NSAttributedString(string: "\n", attributes: [
                    .font: font,
                    .chatCopyReplacement: column < layout.columnCount - 1 ? "\t" : "\n"
                ]))
                result.addAttribute(.paragraphStyle, value: style, range: NSRange(location: start, length: result.length - start))
            }
        }
    }

    /// Beyond the native table limits every cell is still shown, as wrapped monospaced rows.
    private static func appendTableFallback(headers: [String], rows: [[String]], to result: NSMutableAttributedString) {
        let start = result.length
        for (index, row) in ([headers] + rows).enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n")) }
            result.append(inline(row.joined(separator: " | "), font: .monospacedSystemFont(ofSize: 12, weight: index == 0 ? .semibold : .regular)))
        }
        let style = paragraphStyle()
        style.lineBreakMode = .byCharWrapping
        style.headIndent = 8; style.firstLineHeadIndent = 8
        result.addAttribute(.paragraphStyle, value: style, range: NSRange(location: start, length: result.length - start))
    }

    private static func paragraphStyle() -> NSMutableParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = 3
        style.lineBreakMode = .byWordWrapping
        return style
    }

    private static func inline(_ source: String, font: NSFont, color: NSColor = .labelColor) -> NSAttributedString {
        let parsed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        let result = NSMutableAttributedString(string: String(parsed.characters), attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraphStyle()])
        for run in parsed.runs {
            let beginning = String(parsed.characters[..<run.range.lowerBound]).utf16.count
            let length = String(parsed.characters[run.range]).utf16.count
            let range = NSRange(location: beginning, length: length)
            guard length > 0, let intent = run.inlinePresentationIntent else { continue }
            var runFont = font
            if intent.contains(.code) { runFont = .monospacedSystemFont(ofSize: font.pointSize, weight: .regular) }
            if intent.contains(.stronglyEmphasized) { runFont = NSFontManager.shared.convert(runFont, toHaveTrait: .boldFontMask) }
            if intent.contains(.emphasized) { runFont = NSFontManager.shared.convert(runFont, toHaveTrait: .italicFontMask) }
            result.addAttribute(.font, value: runFont, range: range)
            if intent.contains(.strikethrough) { result.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: range) }
            // No .link attribute is installed: URLs remain selectable, inert text.
        }
        return result
    }
}

@MainActor
final class MacChatDocumentView: NSView {
    let textView: MacChatSelectionTextView
    private let documentLayout: MacChatLayoutManager
    private let documentContainer: NSTextContainer
    private var source: String?
    private var literal = false
    private var streaming = false
    private var codeRegions: [MacChatCodeRegion] = []
    private var codeControls: [MacChatCodeControls] = []
    private var chartViews: [(plot: Int, view: MacChatChartView)] = []
    private var endsWithTableTerminator = false
    private var copyPasteboard: NSPasteboard

    override var isFlipped: Bool { true }

    init(pasteboard: NSPasteboard = .general) {
        copyPasteboard = pasteboard
        let storage = NSTextStorage()
        documentLayout = MacChatLayoutManager()
        documentContainer = NSTextContainer(size: CGSize(width: 1, height: CGFloat.greatestFiniteMagnitude))
        documentContainer.lineFragmentPadding = 0
        documentContainer.widthTracksTextView = false
        storage.addLayoutManager(documentLayout)
        documentLayout.addTextContainer(documentContainer)
        textView = MacChatSelectionTextView(frame: .zero, textContainer: documentContainer)
        super.init(frame: .zero)
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = true
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.isVerticallyResizable = false
        textView.isHorizontallyResizable = false
        textView.allowsUndo = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.isAutomaticDataDetectionEnabled = false
        textView.copyPasteboard = pasteboard
        textView.setAccessibilityIdentifier("chat.message.text-selectable")
        textView.setAccessibilityLabel(String(localized: "Texto da mensagem; seleção contínua"))
        addSubview(textView)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    required init?(coder: NSCoder) { nil }

    func setCopyPasteboard(_ pasteboard: NSPasteboard) {
        copyPasteboard = pasteboard
        textView.copyPasteboard = pasteboard
        for control in codeControls { control.copyPasteboard = pasteboard }
    }

    func apply(content: String, isLiteral: Bool, isStreaming: Bool = false) {
        guard content != source || isLiteral != literal || isStreaming != streaming else { return }
        let selection = textView.selectedRange()
        source = content; literal = isLiteral; streaming = isStreaming
        let document = MacChatDocumentBuilder.make(content: content, isLiteral: isLiteral, isStreaming: isStreaming)
        textView.originalSource = content
        textView.textStorage?.setAttributedString(document.text)
        let count = document.text.length
        let location = min(selection.location == NSNotFound ? 0 : selection.location, count)
        textView.setSelectedRange(NSRange(location: location, length: min(selection.length, count - location)))
        codeRegions = document.codeRegions
        documentLayout.codeRanges = codeRegions.map(\.range)
        documentLayout.quoteRanges = document.quoteRanges
        endsWithTableTerminator = document.endsWithTableTerminator
        for control in codeControls { control.removeFromSuperview() }
        for chart in chartViews { chart.view.removeFromSuperview() }
        chartViews = codeRegions.compactMap { region in
            guard let spec = region.chart, let plot = region.plotCharacter else { return nil }
            let view = MacChatChartView(spec: spec)
            addSubview(view)
            return (plot, view)
        }
        codeControls = codeRegions.map { region in
            let control = MacChatCodeControls(region: region, pasteboard: copyPasteboard)
            addSubview(control)
            return control
        }
        invalidateIntrinsicContentSize()
        needsLayout = true
        textView.needsDisplay = true
    }

    func documentHeight(at width: CGFloat) -> CGFloat {
        setDocumentWidth(width)
        documentLayout.ensureLayout(for: documentContainer)
        var used = documentLayout.usedRect(for: documentContainer).maxY
        // A table's last cell terminator leaves an empty line fragment that is not message content.
        if endsWithTableTerminator, documentLayout.extraLineFragmentTextContainer != nil {
            used -= documentLayout.extraLineFragmentRect.height
        }
        return max(22, ceil(used) + (codeRegions.isEmpty ? 1 : 10))
    }

    override var intrinsicContentSize: NSSize {
        CGSize(width: NSView.noIntrinsicMetric, height: documentHeight(at: max(1, bounds.width)))
    }

    override func layout() {
        super.layout()
        setDocumentWidth(max(1, bounds.width))
        textView.frame = bounds
        documentLayout.ensureLayout(for: documentContainer)
        for (region, controls) in zip(codeRegions, codeControls) {
            let glyphs = documentLayout.glyphRange(forCharacterRange: NSRange(location: region.range.location, length: 1), actualCharacterRange: nil)
            let rect = documentLayout.boundingRect(forGlyphRange: glyphs, in: documentContainer)
            controls.frame = CGRect(x: 10, y: rect.minY + 3, width: max(0, bounds.width - 20), height: 28)
        }
        for chart in chartViews {
            let glyph = documentLayout.glyphIndexForCharacter(at: chart.plot)
            let line = documentLayout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            chart.view.frame = CGRect(x: 12, y: line.minY + 4, width: max(0, bounds.width - 24), height: max(0, line.height - 8))
        }
    }

    private func setDocumentWidth(_ width: CGFloat) {
        let value = max(1, width)
        if abs(documentContainer.size.width - value) > 0.5 {
            documentContainer.size = CGSize(width: value, height: CGFloat.greatestFiniteMagnitude)
            documentLayout.invalidateLayout(forCharacterRange: NSRange(location: 0, length: textView.textStorage?.length ?? 0), actualCharacterRange: nil)
        }
    }
}

@MainActor
final class MacChatSelectionTextView: NSTextView {
    var originalSource = ""
    var copyPasteboard: NSPasteboard = .general

    override func copy(_ sender: Any?) {
        let range = selectedRange()
        guard range.location != NSNotFound, NSMaxRange(range) <= (string as NSString).length else { return }
        copyPasteboard.clearContents()
        copyPasteboard.setString(copiedText(in: range), forType: .string)
    }

    /// The selected characters, with table cell ends written as tabs/newlines and the chart plot line omitted.
    func copiedText(in range: NSRange) -> String {
        guard let storage = textStorage else { return (string as NSString).substring(with: range) }
        let text = storage.string as NSString
        var result = ""
        storage.enumerateAttribute(.chatCopyReplacement, in: range) { value, part, _ in
            // Equal neighbouring replacements arrive as one run (an empty cell), so expand per character.
            if let replacement = value as? String { result += String(repeating: replacement, count: part.length) } else { result += text.substring(with: part) }
        }
        // TextKit needs the final cell's paragraph terminator for layout; it is not part of the copied message.
        if storage.length > 0, NSMaxRange(range) == storage.length,
           storage.attribute(.chatCopyReplacement, at: storage.length - 1, effectiveRange: nil) as? String == "\n",
           result.hasSuffix("\n") { result.removeLast() }
        return result
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = super.menu(for: event) ?? NSMenu()
        menu.addItem(.separator())
        let original = NSMenuItem(title: String(localized: "Copiar mensagem original"), action: #selector(copyOriginal), keyEquivalent: "")
        original.target = self
        original.setAccessibilityIdentifier("chat.message.copy-original")
        menu.addItem(original)
        return menu
    }

    @objc private func copyOriginal() {
        copyPasteboard.clearContents()
        copyPasteboard.setString(originalSource, forType: .string)
    }
}

private final class MacChatLayoutManager: NSLayoutManager {
    var codeRanges: [NSRange] = []
    var quoteRanges: [NSRange] = []

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        if let container = textContainers.first {
            for range in codeRanges {
                let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                guard NSIntersectionRange(glyphs, glyphsToShow).length > 0 else { continue }
                let content = boundingRect(forGlyphRange: glyphs, in: container)
                let rect = CGRect(x: origin.x, y: origin.y + content.minY, width: container.size.width, height: content.height + 8)
                let shape = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
                NSColor.labelColor.withAlphaComponent(0.055).setFill(); shape.fill()
                NSColor.separatorColor.setStroke(); shape.lineWidth = 0.5; shape.stroke()
            }
            for range in quoteRanges {
                let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
                guard NSIntersectionRange(glyphs, glyphsToShow).length > 0 else { continue }
                let content = boundingRect(forGlyphRange: glyphs, in: container)
                NSColor.secondaryLabelColor.withAlphaComponent(0.4).setFill()
                NSBezierPath(roundedRect: CGRect(x: origin.x + 2, y: origin.y + content.minY, width: 3, height: content.height), xRadius: 1.5, yRadius: 1.5).fill()
            }
        }
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    }
}

@MainActor
private final class MacChatCodeControls: NSView {
    private let label: NSTextField
    private let copyButton: NSButton
    private let source: String
    private let idleTitle: String
    var copyPasteboard: NSPasteboard
    private var resetTask: Task<Void, Never>?

    override var isFlipped: Bool { true }

    init(region: MacChatCodeRegion, pasteboard: NSPasteboard) {
        copyPasteboard = pasteboard
        source = region.source
        label = NSTextField(labelWithString: Self.title(for: region))
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        idleTitle = region.chart == nil ? String(localized: "Copiar código") : String(localized: "Copiar dados")
        copyButton = NSButton(title: idleTitle, target: nil, action: nil)
        super.init(frame: .zero)
        copyButton.target = self; copyButton.action = #selector(copyCode)
        copyButton.bezelStyle = .inline
        copyButton.font = .systemFont(ofSize: 12)
        copyButton.setAccessibilityIdentifier(region.chart == nil ? "chat.code.copy" : "chat.chart.copy-data")
        addSubview(label); addSubview(copyButton)
    }

    required init?(coder: NSCoder) { nil }

    private static func title(for region: MacChatCodeRegion) -> String {
        if let chart = region.chart { return MacChatChartView.kindName(chart.kind) }
        if region.chartRejected { return "chart · " + String(localized: "Não deu para desenhar; mostrando os dados") }
        return (region.language ?? "code") + (region.incomplete ? " · " + String(localized: "Em andamento") : "")
    }

    override func layout() {
        super.layout()
        let width = min(112, bounds.width)
        copyButton.frame = CGRect(x: max(0, bounds.width - width), y: 1, width: width, height: 24)
        label.frame = CGRect(x: 1, y: 5, width: max(0, bounds.width - width - 8), height: 18)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return copyButton.frame.contains(local) ? copyButton : nil
    }

    @objc private func copyCode() {
        copyPasteboard.clearContents()
        copyPasteboard.setString(source, forType: .string)
        copyButton.title = String(localized: "Copiado")
        resetTask?.cancel()
        resetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            guard let self else { return }
            self.copyButton.title = self.idleTitle
        }
    }
}

/// A native drawing of a parsed chart. It owns no data of its own: values come from the spec,
/// the same data is selectable text beneath it, and it passes every click through to the text.
@MainActor
final class MacChatChartView: NSView {
    let spec: ChatChartSpec
    private let axis: ChatChartAxis

    /// Fixed order, never cycled: a series keeps its color whatever else is in the chart.
    /// Light/dark steps were checked for lightness, chroma and colour-blind separation (parcel logs/palette-validation.txt);
    /// marks below 3:1 contrast are always backed by the legend and the selectable values under the plot.
    static let palette: [NSColor] = [
        (0x2a78d6, 0x3987e5), (0xeb6834, 0xd95926), (0x1baf7a, 0x199e70), (0xeda100, 0xc98500),
        (0xe87ba4, 0xd55181), (0x008300, 0x008300), (0x6250d6, 0x9085e9), (0xe34948, 0xe66767)
    ].map { light, dark in
        NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: 1)
        }
    }

    override var isFlipped: Bool { true }

    init(spec: ChatChartSpec) {
        self.spec = spec
        axis = ChatChart.axis(spec)
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityIdentifier("chat.chart.plot")
        setAccessibilityLabel([Self.kindName(spec.kind), spec.title].compactMap { $0 }.joined(separator: ": "))
        setAccessibilityValue(ChatChart.rows(spec).map { row in
            row.category + ": " + row.values.map { spec.series.count == 1 ? $0.literal : "\($0.series) \($0.literal)" }.joined(separator: ", ")
        }.joined(separator: "; "))
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    static func kindName(_ kind: ChatChartSpec.Kind) -> String {
        switch kind {
        case .bar: String(localized: "Gráfico de barras")
        case .line: String(localized: "Gráfico de linhas")
        case .area: String(localized: "Gráfico de área")
        case .pie: String(localized: "Gráfico de pizza")
        }
    }

    private var labelAttributes: [NSAttributedString.Key: Any] {
        [.font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .regular), .foregroundColor: NSColor.secondaryLabelColor]
    }

    override func draw(_ dirtyRect: NSRect) {
        guard bounds.width > 40, bounds.height > 40 else { return }
        if spec.kind == .pie { drawPie() } else { drawCartesian() }
    }

    private func legend(at origin: CGPoint, maxWidth: CGFloat) {
        var x = origin.x
        for (index, series) in spec.series.enumerated() {
            let name = series.name as NSString
            let width = min(name.size(withAttributes: labelAttributes).width, 140)
            guard x + 12 + width <= origin.x + maxWidth else { break }
            Self.palette[index].setFill()
            NSBezierPath(roundedRect: CGRect(x: x, y: origin.y + 3, width: 8, height: 8), xRadius: 2, yRadius: 2).fill()
            name.draw(with: CGRect(x: x + 12, y: origin.y, width: width, height: 14), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: labelAttributes)
            x += 12 + width + 14
        }
    }

    private func tickLabel(_ value: Double) -> String {
        value.formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
    }

    private func drawCartesian() {
        let top: CGFloat = spec.series.count > 1 ? 20 : 6
        if spec.series.count > 1 { legend(at: CGPoint(x: 0, y: 0), maxWidth: bounds.width) }
        let labels = axis.ticks.map(tickLabel)
        let axisWidth = (labels.map { ($0 as NSString).size(withAttributes: labelAttributes).width }.max() ?? 0) + 8
        let plot = CGRect(x: axisWidth, y: top, width: max(1, bounds.width - axisWidth - 4), height: max(1, bounds.height - top - 20))
        let span = axis.upper - axis.lower
        func y(_ value: Double) -> CGFloat { plot.maxY - CGFloat((value - axis.lower) / (span == 0 ? 1 : span)) * plot.height }

        for (tick, label) in zip(axis.ticks, labels) {
            let lineY = (y(tick) * 2).rounded() / 2
            (tick == 0 ? NSColor.labelColor.withAlphaComponent(0.35) : NSColor.separatorColor).setStroke()
            let rule = NSBezierPath(); rule.lineWidth = tick == 0 ? 1 : 0.5
            rule.move(to: CGPoint(x: plot.minX, y: lineY)); rule.line(to: CGPoint(x: plot.maxX, y: lineY)); rule.stroke()
            let size = (label as NSString).size(withAttributes: labelAttributes)
            (label as NSString).draw(at: CGPoint(x: axisWidth - 6 - size.width, y: lineY - size.height / 2), withAttributes: labelAttributes)
        }

        let count = spec.categories.count
        let band = plot.width / CGFloat(count)
        let baseline = y(min(max(0, axis.lower), axis.upper))
        switch spec.kind {
        case .bar:
            let seriesCount = CGFloat(spec.series.count)
            let barWidth = max(2, min(28, (band * 0.72 - 2 * (seriesCount - 1)) / seriesCount))
            let groupWidth = barWidth * seriesCount + 2 * (seriesCount - 1)
            for (seriesIndex, series) in spec.series.enumerated() {
                Self.palette[seriesIndex].setFill()
                for (index, value) in series.values.enumerated() {
                    let x = plot.minX + band * CGFloat(index) + (band - groupWidth) / 2 + CGFloat(seriesIndex) * (barWidth + 2)
                    let end = y(value)
                    let rect = CGRect(x: x, y: min(end, baseline), width: barWidth, height: abs(baseline - end))
                    guard rect.height > 0 else { continue }
                    // Rounded at the data end, square on the baseline.
                    let radius = min(3, barWidth / 2, rect.height / 2)
                    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
                    let square = value >= 0 ? CGRect(x: rect.minX, y: rect.maxY - radius, width: rect.width, height: radius) : CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: radius)
                    square.fill()
                }
            }
        case .line, .area:
            for (seriesIndex, series) in spec.series.enumerated() {
                let points = series.values.enumerated().map { CGPoint(x: plot.minX + band * (CGFloat($0.offset) + 0.5), y: y($0.element)) }
                guard let first = points.first, let last = points.last else { continue }
                let color = Self.palette[seriesIndex]
                if spec.kind == .area {
                    let fill = NSBezierPath()
                    fill.move(to: CGPoint(x: first.x, y: baseline))
                    for point in points { fill.line(to: point) }
                    fill.line(to: CGPoint(x: last.x, y: baseline)); fill.close()
                    color.withAlphaComponent(0.16).setFill(); fill.fill()
                }
                let line = NSBezierPath()
                line.lineWidth = 2; line.lineJoinStyle = .round; line.lineCapStyle = .round
                line.move(to: first)
                for point in points.dropFirst() { line.line(to: point) }
                color.setStroke(); line.stroke()
                if count <= 16 {
                    color.setFill()
                    for point in points { NSBezierPath(ovalIn: CGRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7)).fill() }
                }
            }
        case .pie:
            break
        }

        // Category labels thin out when they would collide; every category stays in the text below.
        let widest = spec.categories.map { ($0 as NSString).size(withAttributes: labelAttributes).width }.max() ?? 0
        let stride = max(1, Int(ceil((min(widest, 120) + 6) / max(1, band))))
        for index in Swift.stride(from: 0, to: count, by: stride) {
            let rect = CGRect(x: plot.minX + band * CGFloat(index) - band * CGFloat(stride - 1) / 2, y: plot.maxY + 4, width: band * CGFloat(stride), height: 14)
            let style = NSMutableParagraphStyle(); style.alignment = .center; style.lineBreakMode = .byTruncatingTail
            var attributes = labelAttributes; attributes[.paragraphStyle] = style
            (spec.categories[index] as NSString).draw(with: rect.insetBy(dx: 2, dy: 0), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
        }
    }

    private func drawPie() {
        guard let series = spec.series.first else { return }
        let total = series.values.reduce(0, +)
        guard total > 0 else { return }
        let radius = max(10, min(bounds.height / 2 - 6, bounds.width * 0.22))
        let center = CGPoint(x: radius + 8, y: bounds.midY)
        var angle: CGFloat = -90
        for (index, value) in series.values.enumerated() where value > 0 {
            let sweep = CGFloat(value / total) * 360
            // A small angular gap separates neighbouring slices without a surface-colored stroke.
            let gap = series.values.filter { $0 > 0 }.count > 1 ? min(1.2, sweep / 4) : 0
            let path = NSBezierPath()
            path.appendArc(withCenter: center, radius: radius, startAngle: angle + gap / 2, endAngle: angle + sweep - gap / 2, clockwise: false)
            path.appendArc(withCenter: center, radius: radius * 0.58, startAngle: angle + sweep - gap / 2, endAngle: angle + gap / 2, clockwise: true)
            path.close()
            Self.palette[index].setFill(); path.fill()
            angle += sweep
        }
        let legendX = center.x + radius + 20
        let rowHeight: CGFloat = 18
        var rowY = bounds.midY - CGFloat(spec.categories.count) * rowHeight / 2
        for (index, category) in spec.categories.enumerated() {
            Self.palette[index].setFill()
            NSBezierPath(roundedRect: CGRect(x: legendX, y: rowY + 3, width: 8, height: 8), xRadius: 2, yRadius: 2).fill()
            let text = "\(category)  \(series.literals[index])" as NSString
            text.draw(with: CGRect(x: legendX + 14, y: rowY, width: max(0, bounds.width - legendX - 14), height: 14), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: labelAttributes)
            rowY += rowHeight
        }
    }
}
#endif
