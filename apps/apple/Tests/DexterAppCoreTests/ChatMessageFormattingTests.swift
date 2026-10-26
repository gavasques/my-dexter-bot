import XCTest
@testable import DexterAppCore

final class ChatMessageFormattingTests: XCTestCase {
    func testFencedHTMLRemainsLiteralAndPreservesCodeLineEndings() {
        let source = "Antes\n\n```html\r\n<script>alert('literal')</script>\r\n<div>hello</div>\r\n```\r\nDepois"
        XCTAssertEqual(ChatMessageFormatting.parse(source), [
            .paragraph("Antes"),
            .code(language: "html", source: "<script>alert('literal')</script>\r\n<div>hello</div>\r\n", incomplete: false),
            .paragraph("Depois")
        ])
    }

    func testCarriageReturnOnlyFencePreservesLiteralUnicodeCode() {
        XCTAssertEqual(ChatMessageFormatting.parse("```html\r<div>👩🏽‍💻 é</div>\r```\r"), [
            .code(language: "html", source: "<div>👩🏽‍💻 é</div>\r", incomplete: false)
        ])
    }

    func testIncompleteStreamingFenceIsAStableCodeBlock() {
        XCTAssertEqual(ChatMessageFormatting.parse("## Resultado\n```swift\nlet value = 1\n"), [
            .heading(level: 2, text: "Resultado"),
            .code(language: "swift", source: "let value = 1\n", incomplete: true)
        ])
    }

    func testNativeHTMLDropsActiveContentAndDecodesPreformattedSource() {
        let source = "<html><head><script>doNotExecute()</script></head><body><h2>Resumo</h2><p>Olá <strong>mundo</strong> &amp; amigos.</p><img src='https://example.invalid/pixel'><pre><code class='language-html'>&lt;script&gt;literal&lt;/script&gt;\n</code></pre></body></html>"
        XCTAssertEqual(ChatMessageFormatting.parse(source), [
            .heading(level: 2, text: "Resumo"),
            .paragraph("Olá **mundo** & amigos."),
            .code(language: "html", source: "<script>literal</script>\n", incomplete: false)
        ])
    }

    func testMarkdownListsQuoteAndTableHaveNativeStructure() {
        XCTAssertEqual(ChatMessageFormatting.parse("# Plano\n\n- **Primeiro**\n2. Segundo\n\n> Contexto\n> recente\n\n| Nome | Total |\n| --- | ---: |\n| Bot | `3` |"), [
            .heading(level: 1, text: "Plano"),
            .listItem(marker: "•", text: "**Primeiro**"),
            .listItem(marker: "2.", text: "Segundo"),
            .quote("Contexto\nrecente"),
            .table(headers: ["Nome", "Total"], rows: [["Bot", "`3`"]])
        ])
    }

    func testFormattingBoundPreservesUnformattedRemainder() {
        let source = String(repeating: "a", count: ChatMessageFormatting.maximumFormattedCharacters) + "trailing source"
        let blocks = ChatMessageFormatting.parse(source)
        XCTAssertEqual(blocks.last, .literal("trailing source"))
    }

    func testReadableCopyRemovesFormattingButPreservesLiteralCodeAndLinksAsText() {
        let source = "<h2>Resumo</h2><p>Olá <strong>mundo</strong>.</p><script>doNotExecute()</script>\n\n- **Primeiro**\n- [Segundo](https://example.invalid)\n\n```html\r\n<div>**literal**</div>\r\n```\r\n\n| Nome | Total |\n| --- | --- |\n| Bot | `3` |"
        let copied = ChatMessageFormatting.plainText(source)
        XCTAssertTrue(copied.contains("Resumo\n\nOlá mundo."))
        XCTAssertTrue(copied.contains("• Primeiro\n• Segundo"))
        XCTAssertTrue(copied.contains("<div>**literal**</div>\r\n"))
        XCTAssertTrue(copied.contains("Nome\tTotal\nBot\t3"))
        XCTAssertFalse(copied.contains("doNotExecute"))
        XCTAssertFalse(copied.contains("```"))
        XCTAssertFalse(copied.contains("https://example.invalid"))
    }
}
