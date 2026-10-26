import Foundation

/// A native document description. It never evaluates HTML, resolves URLs or loads resources.
public enum ChatFormattedBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case listItem(marker: String, text: String)
    case quote(String)
    case code(language: String?, source: String, incomplete: Bool)
    case table(headers: [String], rows: [[String]])
    case divider
    case literal(String)
}

public enum ChatMessageFormatting {
    public static let maximumFormattedCharacters = 262_144

    /// The visible document as readable text. Formatting syntax is removed; code is literal.
    /// This uses the same safe native parser as the transcript, without loading HTML or URLs.
    public static func plainText(_ source: String) -> String {
        let blocks = parse(source)
        var result = ""
        var previousWasList = false
        for block in blocks {
            let text: String
            let isList: Bool
            switch block {
            case .paragraph(let value), .heading(_, let value), .quote(let value):
                text = inlinePlainText(value); isList = false
            case .listItem(let marker, let value):
                text = marker + " " + inlinePlainText(value); isList = true
            case .code(_, let value, _), .literal(let value):
                text = value; isList = false
            case .table(let headers, let rows):
                text = ([headers] + rows).map { $0.map(inlinePlainText).joined(separator: "\t") }.joined(separator: "\n")
                isList = false
            case .divider:
                text = "────────"; isList = false
            }
            if !result.isEmpty { result += previousWasList && isList ? "\n" : "\n\n" }
            result += text
            previousWasList = isList
        }
        return result
    }

    public static func inlinePlainText(_ source: String) -> String {
        let parsed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        return String(parsed.characters)
    }
    private static let blockPatterns: [String: NSRegularExpression] = {
        let patterns = [
            "^ {0,3}(`{3,}|~{3,})(.*)$",
            "^ {0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$",
            "^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$",
            "^\\s*([-*+]|[0-9]+[.)])\\s+(.+)$",
            "^\\s*>\\s?(.*)$",
            "^:?-{3,}:?$"
        ]
        return Dictionary(uniqueKeysWithValues: patterns.compactMap { pattern in
            (try? NSRegularExpression(pattern: pattern)).map { (pattern, $0) }
        })
    }()

    /// Fences are extracted first, so fenced HTML and incomplete streaming code remain literal.
    public static func parse(_ source: String) -> [ChatFormattedBlock] {
        let formatted = String(source.prefix(maximumFormattedCharacters))
        var blocks: [ChatFormattedBlock] = []
        var prose = ""
        var code: String?
        var delimiter: Character = "`"
        var delimiterCount = 3
        var language: String?
        for line in lines(formatted) {
            if code != nil {
                let trimmed = line.text.trimmingCharacters(in: .whitespaces)
                let count = trimmed.prefix { $0 == delimiter }.count
                if count >= delimiterCount && trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces).isEmpty {
                    blocks.append(.code(language: language, source: code ?? "", incomplete: false)); code = nil
                } else { code?.append(line.raw) }
            } else if let fence = captures("^ {0,3}(`{3,}|~{3,})(.*)$", line.text) {
                appendProse(prose, to: &blocks); prose = ""
                delimiter = fence[0].first ?? "`"; delimiterCount = fence[0].count
                let label = fence[1].trimmingCharacters(in: .whitespaces).split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
                language = label.map { String($0.prefix(64)) }; code = ""
            } else { prose += line.raw }
        }
        if let code { blocks.append(.code(language: language, source: code, incomplete: true)) }
        appendProse(prose, to: &blocks)
        let remainder = String(source.dropFirst(maximumFormattedCharacters))
        if !remainder.isEmpty { blocks.append(.literal(remainder)) }
        return blocks
    }

    private struct SourceLine { let text: String; let raw: String }
    private static func lines(_ source: String) -> [SourceLine] {
        // CRLF is one Swift Character, so scan Unicode scalars rather than grapheme clusters.
        // Raw slices retain the exact LF, CRLF or CR terminator used by copied code.
        let scalars = source.unicodeScalars
        var result: [SourceLine] = []
        var beginning = scalars.startIndex
        var index = beginning
        while index < scalars.endIndex {
            let scalar = scalars[index].value
            if scalar == 10 || scalar == 13 {
                var end = scalars.index(after: index)
                if scalar == 13, end < scalars.endIndex, scalars[end].value == 10 { end = scalars.index(after: end) }
                result.append(SourceLine(text: String(scalars[beginning..<index]), raw: String(scalars[beginning..<end])))
                beginning = end; index = end
            } else { index = scalars.index(after: index) }
        }
        if beginning < scalars.endIndex { result.append(SourceLine(text: String(scalars[beginning...]), raw: String(scalars[beginning...]))) }
        return result
    }

    private static func appendProse(_ source: String, to blocks: inout [ChatFormattedBlock]) {
        guard !source.isEmpty else { return }
        // HTML pre/code is native code, not HTML to execute. Preserve decoded literal code content.
        if let regex = try? NSRegularExpression(pattern: "(?is)<pre\\b[^>]*>(.*?)</pre\\s*>") {
            let matches = regex.matches(in: source, range: NSRange(source.startIndex..., in: source))
            if !matches.isEmpty {
                var cursor = source.startIndex
                for match in matches {
                    guard let whole = Range(match.range, in: source), let inner = Range(match.range(at: 1), in: source) else { continue }
                    appendMarkdown(nativeHTML(String(source[cursor..<whole.lowerBound])), to: &blocks)
                    let body = String(source[inner])
                    let language = captures("(?i)class\\s*=\\s*[\"'](?:language|lang)-([^\"'\\s]+)", body)?.first
                    let code = decodeEntities(replacing("(?is)<[^>]+>", in: body, with: ""))
                    blocks.append(.code(language: language, source: code, incomplete: false)); cursor = whole.upperBound
                }
                appendMarkdown(nativeHTML(String(source[cursor...])), to: &blocks)
                return
            }
        }
        appendMarkdown(nativeHTML(source), to: &blocks)
    }

    private static func appendMarkdown(_ source: String, to blocks: inout [ChatFormattedBlock]) {
        let values = lines(source).map(\.text)
        var index = 0
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        while index < values.count {
            let line = values[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); index += 1; continue }
            if index + 1 < values.count, line.contains("|"), isTableDivider(values[index + 1]) {
                flush(); let headers = cells(line); var rows: [[String]] = []; index += 2
                while index < values.count, values[index].contains("|"), !values[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(cells(values[index])); index += 1
                }
                blocks.append(.table(headers: headers, rows: rows)); continue
            }
            if let heading = captures("^ {0,3}(#{1,6})\\s+(.+?)\\s*#*\\s*$", line) {
                flush(); blocks.append(.heading(level: heading[0].count, text: heading[1]))
            } else if matches("^\\s*(?:-{3,}|\\*{3,}|_{3,})\\s*$", line) {
                flush(); blocks.append(.divider)
            } else if let item = captures("^\\s*([-*+]|[0-9]+[.)])\\s+(.+)$", line) {
                flush(); blocks.append(.listItem(marker: item[0].first?.isNumber == true ? item[0] : "•", text: item[1]))
            } else if let quote = captures("^\\s*>\\s?(.*)$", line) {
                flush(); var quoted = [quote[0]]; index += 1
                while index < values.count, let next = captures("^\\s*>\\s?(.*)$", values[index]) { quoted.append(next[0]); index += 1 }
                blocks.append(.quote(quoted.joined(separator: "\n"))); continue
            } else { paragraph.append(line) }
            index += 1
        }
        flush()
    }

    private static func cells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }
    private static func isTableDivider(_ line: String) -> Bool {
        let parts = cells(line)
        return !parts.isEmpty && parts.allSatisfy { matches("^:?-{3,}:?$", $0) }
    }

    /// An intentionally small HTML-to-native-text subset. Unknown tags and active content are removed.
    private static func nativeHTML(_ source: String) -> String {
        guard matches("(?i)</?(?:html|body|head|p|div|span|a|section|article|h[1-6]|ul|ol|li|pre|code|table|blockquote|strong|b|em|i|br|hr|script|style|img|iframe|object|embed|svg|math)\\b", source) else { return source }
        var value = source
        for tag in ["script", "style", "head", "iframe", "object", "embed", "svg", "math"] {
            value = replacing("(?is)<\(tag)\\b[^>]*>.*?(?:</\(tag)\\s*>|$)", in: value, with: "")
        }
        value = replacing("(?is)<!--.*?(?:-->|$)", in: value, with: "")
        if let regex = try? NSRegularExpression(pattern: "(?is)<table\\b[^>]*>(.*?)</table\\s*>") {
            for match in regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).reversed() {
                guard let whole = Range(match.range, in: value), let inner = Range(match.range(at: 1), in: value) else { continue }
                let tableBody = String(value[inner]); var rows: [[String]] = []
                if let rowRegex = try? NSRegularExpression(pattern: "(?is)<tr\\b[^>]*>(.*?)</tr\\s*>"),
                   let cellRegex = try? NSRegularExpression(pattern: "(?is)<t[dh]\\b[^>]*>(.*?)</t[dh]\\s*>") {
                    for row in rowRegex.matches(in: tableBody, range: NSRange(tableBody.startIndex..., in: tableBody)) {
                        guard let range = Range(row.range(at: 1), in: tableBody) else { continue }
                        let rowBody = String(tableBody[range])
                        let cells = cellRegex.matches(in: rowBody, range: NSRange(rowBody.startIndex..., in: rowBody)).compactMap { cell -> String? in
                            guard let range = Range(cell.range(at: 1), in: rowBody) else { return nil }
                            return replacing("(?is)<[^>]+>", in: String(rowBody[range]), with: "").replacingOccurrences(of: "|", with: "¦")
                        }
                        if !cells.isEmpty { rows.append(cells) }
                    }
                }
                if let header = rows.first {
                    let rendered = [header.joined(separator: " | "), Array(repeating: "---", count: header.count).joined(separator: " | ")] + rows.dropFirst().map { $0.joined(separator: " | ") }
                    value.replaceSubrange(whole, with: "\n\n" + rendered.joined(separator: "\n") + "\n\n")
                } else { value.replaceSubrange(whole, with: "") }
            }
        }
        for level in 1...6 {
            value = replacing("(?is)<h\(level)\\b[^>]*>(.*?)</h\(level)\\s*>", in: value, with: "\n\n" + String(repeating: "#", count: level) + " $1\n\n")
        }
        value = replacing("(?is)<blockquote\\b[^>]*>(.*?)</blockquote\\s*>", in: value, with: "\n\n> $1\n\n")
        value = replacing("(?i)<(?:strong|b)\\b[^>]*>", in: value, with: "**")
        value = replacing("(?i)</(?:strong|b)\\s*>", in: value, with: "**")
        value = replacing("(?i)<(?:em|i)\\b[^>]*>", in: value, with: "*")
        value = replacing("(?i)</(?:em|i)\\s*>", in: value, with: "*")
        value = replacing("(?i)</?code\\b[^>]*>", in: value, with: "`")
        if let orderedRegex = try? NSRegularExpression(pattern: "(?is)<ol\\b[^>]*>(.*?)</ol\\s*>"),
           let itemRegex = try? NSRegularExpression(pattern: "(?is)<li\\b[^>]*>(.*?)</li\\s*>") {
            for match in orderedRegex.matches(in: value, range: NSRange(value.startIndex..., in: value)).reversed() {
                guard let whole = Range(match.range, in: value), let inner = Range(match.range(at: 1), in: value) else { continue }
                let body = String(value[inner])
                let items = itemRegex.matches(in: body, range: NSRange(body.startIndex..., in: body)).enumerated().compactMap { index, item -> String? in
                    guard let range = Range(item.range(at: 1), in: body) else { return nil }
                    return "\(index + 1). " + replacing("(?i)</?(?:p|div)\\b[^>]*>", in: String(body[range]), with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                }
                value.replaceSubrange(whole, with: "\n\n" + items.joined(separator: "\n") + "\n\n")
            }
        }
        value = replacing("(?i)<hr\\b[^>]*>", in: value, with: "\n\n---\n\n")
        value = replacing("(?i)<li\\b[^>]*>", in: value, with: "\n- ")
        value = replacing("(?i)<br\\b[^>]*>", in: value, with: "\n")
        value = replacing("(?i)</?(?:p|div|section|article|ul|ol|li|body|html)\\b[^>]*>", in: value, with: "\n\n")
        value = replacing("(?is)<[^>]+>", in: value, with: "")
        return decodeEntities(value)
    }

    private static func decodeEntities(_ source: String) -> String {
        var value = source
        if let regex = try? NSRegularExpression(pattern: "&#([xX][0-9a-fA-F]+|[0-9]+);") {
            for match in regex.matches(in: value, range: NSRange(value.startIndex..., in: value)).reversed() {
                guard let whole = Range(match.range, in: value), let range = Range(match.range(at: 1), in: value) else { continue }
                let raw = String(value[range]); let number = (raw.hasPrefix("x") || raw.hasPrefix("X")) ? UInt32(raw.dropFirst(), radix: 16) : UInt32(raw)
                if let number, let scalar = UnicodeScalar(number) { value.replaceSubrange(whole, with: String(scalar)) }
            }
        }
        for (entity, decoded) in [("&nbsp;", " "), ("&copy;", "©"), ("&reg;", "®"), ("&trade;", "™"), ("&mdash;", "—"), ("&ndash;", "–"), ("&hellip;", "…"), ("&bull;", "•"), ("&laquo;", "«"), ("&raquo;", "»"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&amp;", "&")] { value = value.replacingOccurrences(of: entity, with: decoded) }
        return value
    }
    private static func matches(_ pattern: String, _ source: String) -> Bool { captures(pattern, source) != nil }
    private static func captures(_ pattern: String, _ source: String) -> [String]? {
        guard let regex = blockPatterns[pattern] ?? (try? NSRegularExpression(pattern: pattern)), let match = regex.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)) else { return nil }
        if match.numberOfRanges == 1 { return [""] }
        return (1..<match.numberOfRanges).map { index in Range(match.range(at: index), in: source).map { String(source[$0]) } ?? "" }
    }
    private static func replacing(_ pattern: String, in source: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return source }
        return regex.stringByReplacingMatches(in: source, range: NSRange(source.startIndex..., in: source), withTemplate: replacement)
    }
}
