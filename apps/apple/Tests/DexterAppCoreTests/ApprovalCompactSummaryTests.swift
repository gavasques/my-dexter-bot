import DexterHostClient
import Foundation
import XCTest
@testable import DexterAppCore

/// The compact pending card copies concrete values from the persisted input and keeps one honest scope line.
final class ApprovalCompactSummaryTests: XCTestCase {
    private let pt = Locale(identifier: "pt-BR"), en = Locale(identifier: "en")
    private func action(_ tool: String, _ input: [String: JSONValue], destination: String = "dexter-harness-owner-proposals",
                        wrapped: Bool = true) -> Action {
        Action(id: "act-compact", request: .init(botId: "bot-1", threadId: "thread-1", tool: tool, destination: destination,
            arguments: wrapped ? ["input": .object(input)] : input, idempotencyKey: "k"),
            requestHash: String(repeating: "a", count: 64), grantRevision: 1, state: .awaitingApproval, createdAt: 1, updatedAt: 1,
            approvalExpiresAt: 60_000, decidedBy: nil, result: nil, reason: nil, authorization: nil)
    }

    func testTerminalShowsTheExactCommandAndNeverPresentsTheFolderAsASandbox() {
        let summary = ApprovalCompactSummary(action: action("dexter.harness.terminal.run",
            ["command": .string("git status\ngit log -1"), "cwd": .string("projetos/app")]), locale: pt)
        XCTAssertEqual(summary.title, "Executar comando")
        XCTAssertEqual(summary.preview, "git status\ngit log -1")
        XCTAssertTrue(summary.previewIsLiteral)
        XCTAssertTrue(summary.scope.contains("projetos/app"))
        XCTAssertTrue(summary.scope.contains("permissões do seu usuário do sistema"))
        XCTAssertTrue(summary.scope.contains("a pasta não isola o computador"))
        let noFolder = ApprovalCompactSummary(action: action("dexter.harness.terminal.run", ["command": .string("ls")]), locale: en)
        XCTAssertTrue(noFolder.scope.contains("this bot’s working folder"))
        XCTAssertTrue(noFolder.scope.contains("does not isolate the computer"))
    }

    func testCliShowsTheFullArgvNotJustTheToolOrFolder() {
        let summary = ApprovalCompactSummary(action: action("dexter.harness.cli.run",
            ["tool": .string("gh"), "args": .array([.string("pr"), .string("list"), .string("--limit"), .string("5")])]), locale: pt)
        XCTAssertEqual(summary.title, "Usar GitHub")
        XCTAssertEqual(summary.preview, "gh pr list --limit 5")
        XCTAssertTrue(summary.scope.contains("não faz login"))
        XCTAssertTrue(summary.scope.contains("a pasta não isola o computador"), "Arbitrary code via CLI keeps the sandbox warning visible")
        let python = ApprovalCompactSummary(action: action("dexter.harness.cli.run", ["tool": .string("python3"), "args": .array([.string("-V")])]), locale: pt)
        XCTAssertEqual(python.title, "Executar Python")
        XCTAssertEqual(python.preview, "python3 -V")
    }

    func testFilesBrowserAndDeviceToolsKeepTheirConcreteTargetAndCost() {
        let create = ApprovalCompactSummary(action: action("dexter.harness.files.write", ["path": .string("notas/a.md"), "content": .string("x")]), locale: pt)
        XCTAssertEqual(create.preview, "notas/a.md")
        XCTAssertTrue(create.scope.hasPrefix("Cria o arquivo"))
        let replace = ApprovalCompactSummary(action: action("dexter.harness.files.write",
            ["path": .string("notas/a.md"), "content": .string("x"), "expected_sha256": .string(String(repeating: "b", count: 64))]), locale: pt)
        XCTAssertTrue(replace.scope.hasPrefix("Substitui"))
        let browser = ApprovalCompactSummary(action: action("dexter.browseruse.run",
            ["task": .string("Encontre o horário da farmácia"), "start_url": .string("https://exemplo.test")], destination: "browser-use"), locale: pt)
        XCTAssertEqual(browser.preview, "Encontre o horário da farmácia")
        XCTAssertFalse(browser.previewIsLiteral)
        XCTAssertTrue(browser.scope.contains("https://exemplo.test"))
        XCTAssertTrue(browser.scope.contains("pode cobrar"), "Paid provider cost stays visible")
        let append = ApprovalCompactSummary(action: action("mac.file.append", ["name": .string("diario.txt"), "line": .string("oi")],
                                                           destination: "dev-mac", wrapped: false), locale: pt)
        XCTAssertEqual(append.title, "Acrescentar ao arquivo")
        XCTAssertEqual(append.preview, "diario.txt")
        let observe = ApprovalCompactSummary(action: action("mac.cua.observe", ["surface": .string("srf_" + String(repeating: "0", count: 32))],
                                                            destination: "dev-mac", wrapped: false), locale: pt)
        XCTAssertNil(observe.preview, "Opaque surface IDs are not shown as the preview")
        XCTAssertFalse(observe.scope.contains("dev-mac"))
    }

    func testMacSetupConnectionsAndUnknownToolsNeverLeadWithRawDestinations() {
        let setup = ApprovalCompactSummary(action: action("dexter.harness.mac.setup.request",
            ["expected_revision": .string(String(repeating: "c", count: 64))]), botName: "Alfa", locale: pt)
        XCTAssertEqual(setup.title, "Configurar acesso ao Mac")
        XCTAssertEqual(setup.preview, "Controle de tela para Alfa")
        XCTAssertTrue(setup.scope.contains("ainda não concede controle"))
        XCTAssertFalse([setup.title, setup.preview ?? "", setup.scope].contains { $0.contains("dexter-harness") || $0.contains(String(repeating: "c", count: 64)) })
        let mcp = ApprovalCompactSummary(action: action("mcp.github.list_issues", ["repo": .string("a/b")], destination: "mcp-github"),
                                         connectionName: "GitHub", locale: pt)
        XCTAssertEqual(mcp.preview, "list_issues")
        XCTAssertTrue(mcp.scope.contains("GitHub"))
        XCTAssertTrue(mcp.scope.contains("conta não verificada"))
        let unknown = ApprovalCompactSummary(action: action("dexter.future.tool", [:], destination: "dexter-future"), locale: pt)
        XCTAssertNil(unknown.preview, "No raw tool/destination preview for an unknown tool")
        XCTAssertTrue(unknown.scope.contains("não foi confirmado"))
        let communication = ApprovalCompactSummary(action: action("dexter.harness.bots.communication.update", ["canSeeBots": .bool(true)]), locale: pt)
        XCTAssertNil(communication.preview, "The card shows the communication flags themselves")
    }
}
