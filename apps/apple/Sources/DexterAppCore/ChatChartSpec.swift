import Foundation

/// A closed, first-party chart description carried in a ```chart fence.
/// It is data only: nothing is evaluated, fetched or inferred, and every drawn value
/// keeps the literal token the message wrote so the textual alternative never re-rounds it.
///
///     ```chart
///     type: bar
///     title: Vendas por mês
///     unit: R$
///     x: Jan | Fev | Mar
///     series: Loja A | 10 | 12.5 | 9
///     series: Loja B | 8 | 11 | 14
///     ```
public struct ChatChartSpec: Equatable, Sendable {
    public enum Kind: String, CaseIterable, Sendable { case bar, line, area, pie }

    public struct Series: Equatable, Sendable {
        public let name: String
        public let values: [Double]
        /// The value tokens exactly as written, index-aligned with `values`.
        public let literals: [String]
    }

    public let kind: Kind
    public let title: String?
    public let unit: String?
    public let categories: [String]
    public let series: [Series]
}

public enum ChatChartIssue: Error, Equatable, Sendable {
    case sourceTooLarge
    case tooManyLines
    case malformedLine(Int)
    case unknownKey(String)
    case duplicateKey(String)
    case missingType
    case unknownType(String)
    case missingCategories
    case categoryCount(Int)
    case missingSeries
    case seriesCount(Int)
    case emptyLabel
    case labelTooLong(String)
    case valueCount(series: String, expected: Int, found: Int)
    case invalidNumber(String)
    case valueOutOfRange(String)
    case pieValue(String)
}

/// A value axis computed only from the spec's own values; ticks are scale marks, not data.
public struct ChatChartAxis: Equatable, Sendable {
    public let lower: Double
    public let upper: Double
    public let ticks: [Double]
}

public enum ChatChart {
    public static let fenceLanguage = "chart"
    public static let maximumSourceCharacters = 8_192
    public static let maximumLines = 64
    public static let maximumCategories = 24
    public static let maximumPieSlices = 8
    public static let maximumSeries = 4
    public static let maximumLabelCharacters = 48
    public static let maximumTitleCharacters = 120
    public static let maximumUnitCharacters = 12
    public static let maximumMagnitude = 1e15

    public static func isChartFence(language: String?) -> Bool {
        language?.lowercased() == fenceLanguage
    }

    public static func parse(_ source: String) -> Result<ChatChartSpec, ChatChartIssue> {
        guard source.count <= maximumSourceCharacters else { return .failure(.sourceTooLarge) }
        let lines = source.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" })
        var kind: ChatChartSpec.Kind?
        var title: String?
        var unit: String?
        var categories: [String]?
        var seenKeys: Set<String> = []
        var rawSeries: [(name: String, tokens: [String])] = []
        var meaningful = 0
        for (number, rawLine) in lines.enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            meaningful += 1
            guard meaningful <= maximumLines else { return .failure(.tooManyLines) }
            guard let colon = line.firstIndex(of: ":") else { return .failure(.malformedLine(number + 1)) }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if key != "series" {
                guard !seenKeys.contains(key) else { return .failure(.duplicateKey(key)) }
                seenKeys.insert(key)
            }
            switch key {
            case "type":
                guard let parsed = ChatChartSpec.Kind(rawValue: value.lowercased()) else { return .failure(.unknownType(value)) }
                kind = parsed
            case "title":
                guard value.count <= maximumTitleCharacters else { return .failure(.labelTooLong(value)) }
                title = value.isEmpty ? nil : value
            case "unit":
                guard value.count <= maximumUnitCharacters else { return .failure(.labelTooLong(value)) }
                unit = value.isEmpty ? nil : value
            case "x":
                let cells = split(value)
                for cell in cells { if let issue = labelIssue(cell) { return .failure(issue) } }
                categories = cells
            case "series":
                let cells = split(value)
                guard let name = cells.first else { return .failure(.emptyLabel) }
                if let issue = labelIssue(name) { return .failure(issue) }
                rawSeries.append((name, Array(cells.dropFirst())))
            default:
                return .failure(.unknownKey(key))
            }
        }
        guard let kind else { return .failure(.missingType) }
        guard let categories, !categories.isEmpty else { return .failure(.missingCategories) }
        let minimumCategories = kind == .line || kind == .area ? 2 : 1
        let maximum = kind == .pie ? maximumPieSlices : maximumCategories
        guard (minimumCategories...maximum).contains(categories.count) else { return .failure(.categoryCount(categories.count)) }
        guard !rawSeries.isEmpty else { return .failure(.missingSeries) }
        guard rawSeries.count <= (kind == .pie ? 1 : maximumSeries) else { return .failure(.seriesCount(rawSeries.count)) }
        var series: [ChatChartSpec.Series] = []
        for (name, tokens) in rawSeries {
            guard tokens.count == categories.count else {
                return .failure(.valueCount(series: name, expected: categories.count, found: tokens.count))
            }
            var values: [Double] = []
            for token in tokens {
                guard let value = number(token) else { return .failure(.invalidNumber(token)) }
                guard abs(value) <= maximumMagnitude else { return .failure(.valueOutOfRange(token)) }
                if kind == .pie, value < 0 { return .failure(.pieValue(token)) }
                values.append(value)
            }
            series.append(.init(name: name, values: values, literals: tokens))
        }
        if kind == .pie, series[0].values.reduce(0, +) <= 0 { return .failure(.pieValue(series[0].literals.joined(separator: " | "))) }
        return .success(ChatChartSpec(kind: kind, title: title, unit: unit, categories: categories, series: series))
    }

    /// Readable rows for the selectable textual alternative: one row per category, literal values.
    public static func rows(_ spec: ChatChartSpec) -> [(category: String, values: [(series: String, literal: String)])] {
        spec.categories.indices.map { index in
            (spec.categories[index], spec.series.map { ($0.name, $0.literals[index]) })
        }
    }

    /// A value axis that always contains zero for bar, area and pie, and the data range for line.
    public static func axis(_ spec: ChatChartSpec, targetTickCount: Int = 4) -> ChatChartAxis {
        let values = spec.series.flatMap(\.values)
        var low = values.min() ?? 0
        var high = values.max() ?? 0
        if spec.kind != .line { low = min(low, 0); high = max(high, 0) }
        if low == high {
            // Only a line can be flat away from zero; the others are flat only when every value is zero.
            let pad = low == 0 ? 1 : abs(low) * 0.5
            if spec.kind == .line { low -= pad }
            high += pad
        }
        let step = niceStep((high - low) / Double(max(1, targetTickCount)))
        let lower = (low / step).rounded(.down) * step
        let upper = (high / step).rounded(.up) * step
        var ticks: [Double] = []
        var tick = lower
        while tick <= upper + step * 0.5, ticks.count < 12 {
            ticks.append(abs(tick) < step * 1e-9 ? 0 : tick)
            tick += step
        }
        return ChatChartAxis(lower: lower, upper: upper, ticks: ticks)
    }

    static func niceStep(_ raw: Double) -> Double {
        guard raw.isFinite, raw > 0 else { return 1 }
        let exponent = (log10(raw)).rounded(.down)
        let base = pow(10, exponent)
        let fraction = raw / base
        let nice: Double = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
        return nice * base
    }

    /// Canonical decimal only: optional minus, digits, optional dot fraction. "1,5" and "1e3" are rejected
    /// so a locale-ambiguous token is never silently reinterpreted.
    static func number(_ token: String) -> Double? {
        guard token.range(of: "^-?[0-9]{1,16}(\\.[0-9]{1,12})?$", options: .regularExpression) != nil,
              let value = Double(token), value.isFinite else { return nil }
        return value
    }

    private static func split(_ value: String) -> [String] {
        value.isEmpty ? [] : value.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func labelIssue(_ label: String) -> ChatChartIssue? {
        if label.isEmpty { return .emptyLabel }
        if label.count > maximumLabelCharacters { return .labelTooLong(label) }
        return nil
    }
}
