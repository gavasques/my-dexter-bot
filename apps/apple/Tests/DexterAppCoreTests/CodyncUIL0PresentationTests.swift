import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

/// L0-A (short approval card) and L0-C (bot settings groups): presentation only. Nothing here decides, routes or saves.
final class CodyncUIL0PresentationTests: XCTestCase {
    private let proposals = "dexter-harness-owner-proposals"

    func testPlaceComesOnlyFromClosedToolAndFixedDestination() throws {
        func place(_ tool: String, _ destination: String) throws -> ApprovalExecutionPlace? {
            ApprovalPresentation(action: try hostAction(tool: tool, destination: destination)).executionPlace
        }
        XCTAssertEqual(try place("dexter.harness.terminal.run", proposals), .baseTerminal)
        XCTAssertEqual(try place("dexter.harness.cli.run", proposals), .baseTerminal)
        XCTAssertEqual(try place("dexter.harness.files.write", proposals), .baseBotFiles)
        XCTAssertEqual(try place("dexter.harness.files.read", proposals), .baseBotFiles)
        XCTAssertEqual(try place("dexter.automations.run", "dexter-automations"), .baseAutomation)
        XCTAssertEqual(try place("dexter.harness.bots.update", proposals), .baseConfiguration)
        XCTAssertEqual(try place(BotCommunicationProposal.tool, proposals), .baseConfiguration)
        // Same tool on another destination, automations elsewhere, MCP namespaces, devices and unknown tools: no place.
        XCTAssertNil(try place("dexter.harness.terminal.run", "device-mac-1"))
        XCTAssertNil(try place("dexter.harness.files.write", "dexter-automations"))
        XCTAssertNil(try place("dexter.automations.run", proposals))
        XCTAssertNil(try place("mcp.github-1.search_issues", "mcp-github-1"))
        XCTAssertNil(try place("mcp.github-1.search_issues", proposals))
        XCTAssertNil(try place("dexter.browseruse.run", "dexter-browser-use"))
        XCTAssertNil(try place("commerce.publish", "this-mac"))
    }

    func testTerminalScopeNoLongerClaimsThisMac() throws {
        for tool in ["dexter.harness.terminal.run", "dexter.harness.cli.run"] {
            let scope = try XCTUnwrap(ApprovalPresentation(action: try hostAction(tool: tool, destination: proposals)).scopeExplanation)
            XCTAssertFalse(scope.contains("deste Mac"), tool)
            XCTAssertTrue(scope.contains("não limita o acesso"), tool)
        }
    }

    func testShortTargetIsCopiedFromPersistedInputOnly() throws {
        func target(_ tool: String, _ input: [String: JSONValue], wrapped: Bool = true) throws -> String? {
            let arguments: [String: JSONValue] = wrapped ? ["input": .object(input), "requestHash": .string("h")] : input
            return ApprovalPresentation(action: try hostAction(tool: tool, destination: proposals, arguments: arguments)).shortTarget
        }
        XCTAssertEqual(try target("dexter.harness.terminal.run", ["command": .string("git status --short")]), "git status --short")
        XCTAssertEqual(try target("dexter.harness.terminal.run", ["command": .string("\n  cd work  \nrm -rf build\n")]), "cd work …")
        XCTAssertNil(try target("dexter.harness.terminal.run", ["command": .string(" \n\t\n")]))
        XCTAssertEqual(try target("dexter.harness.cli.run", ["tool": .string("gh"), "args": .array([.string("pr"), .string("list")])]), "gh")
        XCTAssertEqual(try target("dexter.harness.files.write", ["path": .string("notes/today.md"), "text": .string("x")]), "today.md")
        XCTAssertEqual(try target("dexter.harness.files.read", ["path": .string("plan.txt")], wrapped: false), "plan.txt")
        XCTAssertNil(try target("dexter.harness.files.list", ["path": .string(".")]))
        XCTAssertNil(try target("dexter.harness.files.tree", [:]))
        let definition = #"{"id":"linear","name":"Linear","transport":{"url":"https://mcp.example.test/sse"},"auth":"oauth"}"#
        XCTAssertEqual(try target("dexter.harness.mcp.add_http", ["definitionJson": .string(definition)]), "Linear")
        XCTAssertNil(try target("dexter.harness.bots.update", ["name": .string("Scout")]))
        let mcp = ApprovalPresentation(action: try hostAction(tool: "mcp.github-1.search_issues", destination: "mcp-github-1"))
        XCTAssertEqual(mcp.shortTarget, "search_issues")
        XCTAssertNil(ApprovalPresentation(action: try hostAction(tool: "commerce.publish", destination: "conn-A")).shortTarget)
    }

    func testCardPresentationLeavesDecisionIdentityUntouched() throws {
        let arguments: [String: JSONValue] = ["input": .object(["command": .string("printf ok\nprintf two")]), "requestHash": .string("h")]
        let action = try hostAction(tool: "dexter.harness.terminal.run", destination: proposals, arguments: arguments)
        let display = ApprovalPresentation(action: action)
        _ = (display.shortTarget, display.executionPlace)
        XCTAssertEqual(display.action, action)
        XCTAssertEqual(display.requestHash, "host-issued-hash")
        XCTAssertEqual(display.arguments, arguments)
        XCTAssertTrue(display.canDecide(hostAvailable: true, atMilliseconds: 0))
        XCTAssertFalse(display.canDecide(hostAvailable: false, atMilliseconds: 0))
    }

    func testBotSettingsGroupsKeepEverySectionAndItsStableID() {
        XCTAssertEqual(BotSettingsSectionGroup.allCases.map(\.rawValue), ["bot", "work", "permissions", "activity"])
        XCTAssertEqual(BotSettingsSectionGroup.bot.sections, [.profile, .memory])
        XCTAssertEqual(BotSettingsSectionGroup.work.sections, [.model, .skills, .mcp, .browser])
        XCTAssertEqual(BotSettingsSectionGroup.permissions.sections, [.access, .communication])
        XCTAssertEqual(BotSettingsSectionGroup.activity.sections, [.routines, .history])
        let order = BotSettingsSectionGroup.sidebarOrder
        XCTAssertEqual(order.count, BotSettingsSection.allCases.count)
        XCTAssertEqual(Set(order), Set(BotSettingsSection.allCases))
        for section in BotSettingsSection.allCases {
            XCTAssertTrue(BotSettingsSectionGroup(section: section).sections.contains(section))
        }
        // Routing IDs are unchanged; no folder section exists before its contract.
        XCTAssertEqual(BotSettingsSection.allCases.map(\.rawValue),
                       ["profile", "model", "memory", "skills", "mcp", "access", "communication", "browser", "routines", "history"])
    }

    func testNewL0StringsAreTranslatedInTheCatalog() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("SharedApp/Resources/Localizable.xcstrings"))
        let strings = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["strings"] as? [String: [String: Any]])
        let keys = ["Nesta base · terminal com as permissões do usuário do sistema · a pasta de trabalho não é sandbox",
                    "Nesta base · arquivos deste bot", "Nesta base · automação deste bot", "Nesta base · configuração do Dexter",
                    "Confira a ação completa para ver todos os valores.", "Mais opções da conversa",
                    "Abre uma conversa separada, com histórico próprio.",
                    "Mais opções da conversa. Nova conversa: ⌘N. Conversas anteriores: ⌘[.",
                    "Bot", "Trabalho", "Permissões", "Atividade", "Dispositivos",
                    "Abre Ajustes › Dispositivos, onde ficam as permissões de cada bot por aparelho. Abrir não muda nada."]
        for key in keys {
            let languages = try XCTUnwrap(strings[key]?["localizations"] as? [String: [String: Any]], key)
            for language in ["en", "pt-BR"] {
                let unit = try XCTUnwrap(languages[language]?["stringUnit"] as? [String: String], "\(key) \(language)")
                XCTAssertEqual(unit["state"], "translated", key)
                XCTAssertFalse(unit["value"]?.isEmpty ?? true, key)
            }
            XCTAssertEqual((languages["pt-BR"]?["stringUnit"] as? [String: String])?["value"], key)
            if key.hasPrefix("Nesta base") {
                for language in ["en", "pt-BR"] {
                    let value = (languages[language]?["stringUnit"] as? [String: String])?["value"] ?? ""
                    XCTAssertFalse(value.contains("Mac"), "a place line never names this Mac: \(language) \(key)")
                }
            }
        }
    }

    private func hostAction(tool: String, destination: String, arguments: [String: JSONValue]? = nil) throws -> Action {
        // Host-shaped JSON decoded like a real response; expected values never come from the presentation.
        let persisted = try JSONSerialization.jsonObject(with: JSONEncoder().encode(JSONValue.object(arguments ?? [:])))
        let object: [String: Any] = [
            "id": "act-l0", "request": ["botId": "bot-l0", "threadId": "thread-l0", "tool": tool,
                "destination": destination, "idempotencyKey": "intent-l0", "arguments": persisted],
            "requestHash": "host-issued-hash", "grantRevision": 3, "state": ActionState.awaitingApproval.rawValue,
            "createdAt": Int64(1_799_999_000_111), "updatedAt": Int64(1_799_999_000_222),
            "approvalExpiresAt": NSNull(), "decidedBy": NSNull(), "reason": NSNull(), "result": NSNull(),
        ]
        return try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
