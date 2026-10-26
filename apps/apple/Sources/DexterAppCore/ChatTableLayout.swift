import Foundation

/// Column geometry for a Markdown table drawn as native text-table cells.
/// Widths come from the readable length of each column, so short columns stay narrow
/// and long prose columns wrap instead of colliding with fixed tab stops.
public struct ChatTableLayout: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, trailing }

    public let columnCount: Int
    /// Header and rows padded with empty cells to `columnCount`; no cell text is changed or dropped.
    public let header: [String]
    public let rows: [[String]]
    public let alignments: [Alignment]
    /// Fractions of the available width, summing to 1.
    public let widthFractions: [Double]

    public static let maximumColumns = 12
    /// TextKit 1 lays out a text table in super-linear time (measured in the parcel REPORT),
    /// so longer tables use the plain-text fallback, which still shows every cell.
    public static let maximumRows = 60
    public static let maximumCells = 600

    /// `nil` when the table exceeds the native limits; callers then render every cell as plain text.
    public static func make(headers: [String], rows: [[String]]) -> ChatTableLayout? {
        let columns = max(headers.count, rows.map(\.count).max() ?? 0)
        guard columns > 0, columns <= maximumColumns, rows.count <= maximumRows, columns * (rows.count + 1) <= maximumCells else { return nil }
        func pad(_ row: [String]) -> [String] { row + Array(repeating: "", count: columns - row.count) }
        let header = pad(headers)
        let body = rows.map(pad)
        let plainHeader = header.map(plainText)
        let plainBody = body.map { $0.map(plainText) }
        var alignments: [Alignment] = []
        var weights: [Double] = []
        for column in 0..<columns {
            let values = plainBody.map { $0[column] }
            let filled = values.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            alignments.append(!filled.isEmpty && filled.allSatisfy(isNumeric) ? .trailing : .leading)
            let texts = [plainHeader[column]] + values
            let longest = Double(min(texts.map(\.count).max() ?? 0, 60))
            let longestWord = Double(min(texts.flatMap { $0.split(whereSeparator: \.isWhitespace) }.map(\.count).max() ?? 0, 16))
            // A column first needs room for its longest word (+2 for cell padding); longer text earns a quarter
            // of its extra length, so prose columns wrap while short labels and numbers stay on one line.
            weights.append(longestWord + 2 + 0.25 * max(0, longest - longestWord))
        }
        let total = weights.reduce(0, +)
        let floor = 0.5 / Double(columns)
        let raw = weights.map { max($0 / total, floor) }
        let sum = raw.reduce(0, +)
        return ChatTableLayout(columnCount: columns, header: header, rows: body, alignments: alignments, widthFractions: raw.map { $0 / sum })
    }

    /// Whether a cell may contain inline Markdown, an entity or an escape; otherwise its text is already plain.
    public static func hasInlineSyntax(_ cell: String) -> Bool {
        cell.contains { "*_`~[]<>&\\!".contains($0) }
    }

    static func plainText(_ cell: String) -> String {
        hasInlineSyntax(cell) ? ChatMessageFormatting.inlinePlainText(cell) : cell
    }

    /// Numbers, money and percentages in either decimal convention, e.g. `1.234,56`, `R$ 10`, `-3%`.
    static func isNumeric(_ cell: String) -> Bool {
        cell.trimmingCharacters(in: .whitespaces).range(
            of: "^[+\\-−]?\\s?(?:R\\$|US\\$|\\$|€|£)?\\s?[+\\-−]?[0-9][0-9.,\\s]*(?:%|x|×)?$",
            options: .regularExpression
        ) != nil
    }
}
