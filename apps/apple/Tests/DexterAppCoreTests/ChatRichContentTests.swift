import XCTest
@testable import DexterAppCore

final class ChatRichContentTests: XCTestCase {
    private let bars = "type: bar\ntitle: Vendas por mês\nunit: R$\nx: Jan | Fev | Mar\nseries: Loja A | 10 | 12.5 | 9\nseries: Loja B | 8 | 11 | -14\n"

    func testChartFenceArrivesAsLiteralCodeFromTheExistingParser() {
        XCTAssertEqual(ChatMessageFormatting.parse("Antes\n\n```chart\n" + bars + "```\n"), [
            .paragraph("Antes"),
            .code(language: "chart", source: bars, incomplete: false)
        ])
        XCTAssertTrue(ChatChart.isChartFence(language: "Chart"))
        XCTAssertFalse(ChatChart.isChartFence(language: "vega"))
        XCTAssertFalse(ChatChart.isChartFence(language: nil))
    }

    func testBarChartKeepsLiteralTokensAndValues() throws {
        let spec = try ChatChart.parse(bars).get()
        XCTAssertEqual(spec.kind, .bar)
        XCTAssertEqual(spec.title, "Vendas por mês")
        XCTAssertEqual(spec.unit, "R$")
        XCTAssertEqual(spec.categories, ["Jan", "Fev", "Mar"])
        XCTAssertEqual(spec.series.map(\.name), ["Loja A", "Loja B"])
        XCTAssertEqual(spec.series[0].values, [10, 12.5, 9])
        XCTAssertEqual(spec.series[1].literals, ["8", "11", "-14"])
        let rows = ChatChart.rows(spec)
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[1].category, "Fev")
        XCTAssertEqual(rows[1].values.map(\.literal), ["12.5", "11"])
    }

    func testCRLFSourceAndCaseInsensitiveKeys() throws {
        let spec = try ChatChart.parse("TYPE: Line\r\nX: a | b\r\nSeries: s | 1 | 2\r\n").get()
        XCTAssertEqual(spec.kind, .line)
        XCTAssertEqual(spec.series[0].values, [1, 2])
    }

    func testRejectsAmbiguousOrNonFiniteNumbers() {
        for token in ["1,5", "1e3", "NaN", "inf", "0x10", "", "1.", ".5", "R$ 10", "10%"] {
            let result = ChatChart.parse("type: bar\nx: a\nseries: s | \(token)")
            XCTAssertNotNil(failure(result), "accepted \(token)")
        }
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a\nseries: s | 1e3")), .invalidNumber("1e3"))
    }

    func testClosedGrammarRejectsUnknownKeysTypesAndDuplicates() {
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nurl: https://example.invalid\nx: a\nseries: s | 1")), .unknownKey("url"))
        XCTAssertEqual(failure(ChatChart.parse("type: scatter\nx: a\nseries: s | 1")), .unknownType("scatter"))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\ntype: line\nx: a\nseries: s | 1")), .duplicateKey("type"))
        XCTAssertEqual(failure(ChatChart.parse("x: a\nseries: s | 1")), .missingType)
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nseries: s | 1")), .missingCategories)
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a")), .missingSeries)
        XCTAssertEqual(failure(ChatChart.parse("type: bar\njust text\n")), .malformedLine(2))
        XCTAssertEqual(failure(ChatChart.parse("<script>alert(1)</script>")), .malformedLine(1))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\n<img src: https://example.invalid/x.png>\nx: a\nseries: s | 1")), .unknownKey("<img src"))
    }

    func testValueCountMustMatchCategoriesNoPaddingOrInvention() {
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a | b | c\nseries: s | 1 | 2")), .valueCount(series: "s", expected: 3, found: 2))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a\nseries: s | 1 | 2")), .valueCount(series: "s", expected: 1, found: 2))
    }

    func testLimits() {
        let many = (1...25).map { "c\($0)" }.joined(separator: " | ")
        let values = (1...25).map(String.init).joined(separator: " | ")
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: \(many)\nseries: s | \(values)")), .categoryCount(25))
        let fiveSeries = (1...5).map { "series: s\($0) | 1" }.joined(separator: "\n")
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a\n" + fiveSeries)), .seriesCount(5))
        XCTAssertEqual(failure(ChatChart.parse("type: line\nx: a\nseries: s | 1")), .categoryCount(1))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a\nseries: s | 10000000000000000")), .invalidNumber("10000000000000000"))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a\nseries: s | 9999999999999999")), .valueOutOfRange("9999999999999999"))
        XCTAssertEqual(failure(ChatChart.parse(String(repeating: "x", count: ChatChart.maximumSourceCharacters + 1))), .sourceTooLarge)
        let label = String(repeating: "a", count: ChatChart.maximumLabelCharacters + 1)
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: \(label)\nseries: s | 1")), .labelTooLong(label))
        XCTAssertEqual(failure(ChatChart.parse("type: bar\nx: a |  | c\nseries: s | 1 | 2 | 3")), .emptyLabel)
        let lines = "type: bar\nx: a\n" + (1...63).map { _ in "series: s | 1" }.joined(separator: "\n")
        XCTAssertEqual(failure(ChatChart.parse(lines)), .tooManyLines)
    }

    func testPieAcceptsOneNonNegativeSeriesWithPositiveTotal() throws {
        let spec = try ChatChart.parse("type: pie\nx: A | B | C\nseries: Participação | 50 | 30 | 20").get()
        XCTAssertEqual(spec.series.count, 1)
        XCTAssertEqual(failure(ChatChart.parse("type: pie\nx: A | B\nseries: s | 1 | -1")), .pieValue("-1"))
        XCTAssertEqual(failure(ChatChart.parse("type: pie\nx: A | B\nseries: s | 0 | 0")), .pieValue("0 | 0"))
        XCTAssertEqual(failure(ChatChart.parse("type: pie\nx: A\nseries: s | 1\nseries: t | 2")), .seriesCount(2))
        let nine = (1...9).map { "c\($0)" }.joined(separator: " | ")
        XCTAssertEqual(failure(ChatChart.parse("type: pie\nx: \(nine)\nseries: s | " + (1...9).map(String.init).joined(separator: " | "))), .categoryCount(9))
    }

    func testAxisContainsZeroForBarsAndDataRangeForLines() throws {
        let barAxis = ChatChart.axis(try ChatChart.parse(bars).get())
        XCTAssertLessThanOrEqual(barAxis.lower, -14)
        XCTAssertGreaterThanOrEqual(barAxis.upper, 12.5)
        XCTAssertTrue(barAxis.ticks.contains(0))
        XCTAssertEqual(barAxis.ticks.first, barAxis.lower)
        XCTAssertEqual(barAxis.ticks.last, barAxis.upper)

        let lineAxis = ChatChart.axis(try ChatChart.parse("type: line\nx: a | b\nseries: s | 1000 | 1010").get())
        XCTAssertGreaterThan(lineAxis.lower, 0)
        XCTAssertLessThanOrEqual(lineAxis.lower, 1000)
        XCTAssertGreaterThanOrEqual(lineAxis.upper, 1010)

        let flat = ChatChart.axis(try ChatChart.parse("type: bar\nx: a | b\nseries: s | 0 | 0").get())
        XCTAssertEqual(flat.lower, 0)
        XCTAssertGreaterThan(flat.upper, 0)
        let flatLine = ChatChart.axis(try ChatChart.parse("type: line\nx: a | b\nseries: s | 5 | 5").get())
        XCTAssertLessThan(flatLine.lower, 5)
        XCTAssertGreaterThan(flatLine.upper, 5)
        XCTAssertLessThanOrEqual(flatLine.ticks.count, 12)
    }

    func testTableLayoutPadsRaggedRowsWithoutDroppingCells() throws {
        let layout = try XCTUnwrap(ChatTableLayout.make(headers: ["Nome", "Total"], rows: [["Bot"], ["Ana", "3", "extra"]]))
        XCTAssertEqual(layout.columnCount, 3)
        XCTAssertEqual(layout.header, ["Nome", "Total", ""])
        XCTAssertEqual(layout.rows, [["Bot", "", ""], ["Ana", "3", "extra"]])
        XCTAssertEqual(layout.widthFractions.reduce(0, +), 1, accuracy: 1e-9)
    }

    func testTableLayoutAlignsNumericColumnsAndWeightsLongColumns() throws {
        let layout = try XCTUnwrap(ChatTableLayout.make(
            headers: ["Item", "Descrição", "Valor"],
            rows: [["A", "Uma descrição bem mais longa que as outras colunas da tabela", "R$ 1.234,56"], ["B", "Curta", "-3%"], ["C", "", ""]]
        ))
        XCTAssertEqual(layout.alignments, [.leading, .leading, .trailing])
        XCTAssertGreaterThan(layout.widthFractions[1], layout.widthFractions[0])
        XCTAssertGreaterThan(layout.widthFractions[1], layout.widthFractions[2])
        XCTAssertGreaterThanOrEqual(layout.widthFractions.min() ?? 0, 0.5 / 3 / 1.5)
    }

    func testTableLayoutLimitsFallBack() {
        XCTAssertNil(ChatTableLayout.make(headers: (0...12).map(String.init), rows: []))
        XCTAssertNotNil(ChatTableLayout.make(headers: ["a", "b"], rows: Array(repeating: ["1", "2"], count: ChatTableLayout.maximumRows)))
        XCTAssertNil(ChatTableLayout.make(headers: ["a", "b"], rows: Array(repeating: ["1", "2"], count: ChatTableLayout.maximumRows + 1)))
        XCTAssertNotNil(ChatTableLayout.make(headers: (1...12).map(String.init), rows: Array(repeating: (1...12).map(String.init), count: 49)))
        XCTAssertNil(ChatTableLayout.make(headers: (1...12).map(String.init), rows: Array(repeating: (1...12).map(String.init), count: 50)))
        XCTAssertNil(ChatTableLayout.make(headers: [], rows: []))
    }

    func testNumericDetection() {
        for value in ["10", "-3", "1.234,56", "1,234.56", "R$ 10", "US$ 3.5", "€4", "12%", "3x", "−2"] { XCTAssertTrue(ChatTableLayout.isNumeric(value), value) }
        for value in ["abc", "10 itens", "v1.2-beta", "", "R$"] { XCTAssertFalse(ChatTableLayout.isNumeric(value), value) }
    }

    private func failure(_ result: Result<ChatChartSpec, ChatChartIssue>) -> ChatChartIssue? {
        if case .failure(let issue) = result { return issue }
        return nil
    }
}
