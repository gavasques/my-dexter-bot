import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

final class ApprovalPresentationTests: XCTestCase {
    func testR3ActualUnknownTimeoutWarnsPartialAndTranslatesBoundedDiagnostics() throws {
        let result: JSONValue = .object(["termination": .string("timeout"), "commandOutcome": .string("interrupted"),
            "cwd": .string("."), "exitCode": .null, "signal": .string("SIGTERM"),
            "diagnostic": .object(["code": .string("command_interrupted"), "effectMayBePartial": .bool(true),
                "stderrAvailable": .bool(false), "retryAutomatically": .bool(false)])])
        let action = try persistedAction(state: .unknown, tool: "dexter.harness.terminal.run", result: result, reason: .executorError)
        let display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.outcome(atMilliseconds: 0), .unknown)
        XCTAssertNotEqual(display.statusSymbol(atMilliseconds: 0), "checkmark.circle")
        XCTAssertTrue(display.resultExplanation.contains("O efeito pode ser parcial"))
        XCTAssertTrue(display.resultExplanation.contains("O tempo limite foi atingido"))
        XCTAssertTrue(display.resultExplanation.contains("Não há nova tentativa automática"))
        let fields = display.readableResultFields
        XCTAssertEqual(fields.first { $0.id == "result/commandOutcome" }?.value, "Interrompido; conclusão não confirmada")
        XCTAssertEqual(fields.first { $0.id == "result/diagnostic/code" }?.value, "Comando interrompido")
        XCTAssertEqual(fields.first { $0.id == "result/diagnostic/effectMayBePartial" }?.label, "Resultado · Diagnóstico · O efeito pode ser parcial")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(try XCTUnwrap(display.formattedResult).utf8)), result)
    }

    func testR3StopReceiptIsNotIndividualUserDenialAndMissingBodyStaysUnknown() throws {
        let stopped = ApprovalPresentation(action: try persistedAction(state: .denied, result: .object(["code": .string("cancelled")]), reason: .userDenied))
        XCTAssertEqual(stopped.outcome(atMilliseconds: 0), .cancelled)
        XCTAssertFalse(stopped.resultExplanation.contains("Você negou"))
        let denied = ApprovalPresentation(action: try persistedAction(state: .denied, reason: .userDenied))
        XCTAssertEqual(denied.outcome(atMilliseconds: 0), .userDenied)
        let missing = ApprovalPresentation(action: try persistedAction(state: .unknown, tool: "dexter.harness.terminal.run", reason: .executorError))
        XCTAssertEqual(missing.outcome(atMilliseconds: 0), .unknown)
        XCTAssertTrue(missing.resultExplanation.contains("Não há nova tentativa automática"))
    }

    func testR3NotStartedOutputLimitAndUnknownFutureDiagnosticKeepLiteralReceipt() throws {
        let notStarted = ApprovalPresentation(action: try persistedAction(state: .succeeded, tool: "dexter.harness.cli.run",
            result: .object(["commandOutcome": .string("not_started"), "termination": .string("spawn_failed"), "effectDispatched": .bool(false)])))
        XCTAssertEqual(notStarted.outcome(atMilliseconds: 0), .commandNotStarted)
        let limited = ApprovalPresentation(action: try persistedAction(state: .succeeded, tool: "dexter.harness.terminal.run",
            result: .object(["commandOutcome": .string("completed"), "termination": .string("stdout_limit"), "signal": .null, "exitCode": .integer(0)])))
        XCTAssertEqual(limited.outcome(atMilliseconds: 0), .outputLimited)
        let future: JSONValue = .object(["commandOutcome": .string("future_status"), "diagnostic": .object(["code": .string("future_code")])])
        let unknown = ApprovalPresentation(action: try persistedAction(state: .unknown, result: future))
        XCTAssertEqual(unknown.readableResultFields.first { $0.id == "result/diagnostic/code" }?.value, "future_code")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(try XCTUnwrap(unknown.formattedResult).utf8)), future)
        XCTAssertEqual(unknown.outcome(atMilliseconds: 0), .unknown)
    }
    private func persistedAction(expiry: Int64? = 1_800_000_000_123, state: ActionState = .awaitingApproval,
                                 arguments: [String: JSONValue]? = nil, tool: String = "commerce.publish",
                                 destination: String = "conn-A", result: JSONValue? = nil,
                                 reason: ActionReason? = nil) throws -> Action {
        // Decode a host-shaped response rather than building expected values from the presentation.
        let defaultArguments: [String: Any] = ["accountId": "  seller-é-3  ", "payload": ["text": "line\n\"quoted\" 🌎",
            "items": [true, NSNull(), ["amount": 12.5, "large": Int64(9_007_199_254_740_993)]]]]
        let persistedArguments = try arguments.map {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(JSONValue.object($0)))
        } ?? defaultArguments
        var object: [String: Any] = [
            "id": "act-host-42", "request": ["botId": "bot-7", "threadId": "thread-8",
                "tool": tool, "destination": destination, "idempotencyKey": "intent-10",
                "arguments": persistedArguments],
            "requestHash": "host-issued-hash-kept-verbatim", "grantRevision": 17, "state": state.rawValue,
            "createdAt": Int64(1_799_999_000_111), "updatedAt": Int64(1_799_999_000_222),
            "approvalExpiresAt": expiry.map { $0 as Any } ?? NSNull(),
            "decidedBy": NSNull(), "reason": reason.map { $0.rawValue as Any } ?? NSNull()
        ]
        object["result"] = try result.map {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode($0), options: .fragmentsAllowed)
        } ?? NSNull()
        // Result/reason/arguments are decoded from the same JSON receipt as all authority fields.
        return try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testHostResponseSnapshotPreservesAuthorityAndNestedArgumentDisplayRoundTrip() throws {
        let action = try persistedAction(), display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.id, "act-host-42")
        XCTAssertEqual(display.tool, "commerce.publish")
        XCTAssertEqual(display.destination, "conn-A")
        XCTAssertEqual(display.requestHash, "host-issued-hash-kept-verbatim")
        XCTAssertEqual(display.grantRevision, 17)
        XCTAssertEqual(display.expiresAtMilliseconds, 1_800_000_000_123)
        XCTAssertEqual(try XCTUnwrap(display.expirationDate).timeIntervalSince1970, 1_800_000_000.123, accuracy: 0.000_001)
        let visible = try JSONDecoder().decode(JSONValue.self, from: Data(display.formattedArguments.utf8))
        XCTAssertEqual(visible, .object(action.request.arguments))
        XCTAssertEqual(display.action, action, "decisions use the original complete action, never display text")
        XCTAssertEqual(display.action.request.idempotencyKey, "intent-10")
    }

    func testCanonicalDestinationAndCompleteArgumentsRemainDistinct() throws {
        // Bot-authored account claims stay in arguments; the persisted destination is the target.
        for args: [String: JSONValue] in [["accountId": .string("personal")], [:], ["accountId": .string("")],
            ["accountId": .null], ["accountId": .integer(7)],
            ["payload": .object(["accountId": .string("nested")])], ["account": .string("ambiguous")]] {
            let action = try persistedAction(arguments: args)
            let display = ApprovalPresentation(action: action)
            XCTAssertEqual(display.destination, "conn-A")
            XCTAssertEqual(display.arguments, args)
            XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(display.formattedArguments.utf8)), .object(args))
            XCTAssertEqual(display.action, action)
            XCTAssertEqual(display.action.request.destination, "conn-A")
        }
    }

    func testExplicitClockBoundaryAndNoDeadline() throws {
        let display = ApprovalPresentation(action: try persistedAction(expiry: 1_234))
        XCTAssertFalse(display.isExpired(atMilliseconds: 1_233))
        XCTAssertTrue(display.canDecide(hostAvailable: true, atMilliseconds: 1_233))
        for now: Int64 in [1_234, 1_235, Int64.max] {
            XCTAssertTrue(display.isExpired(atMilliseconds: now))
            XCTAssertFalse(display.canDecide(hostAvailable: true, atMilliseconds: now))
        }
        let noDeadline = ApprovalPresentation(action: try persistedAction(expiry: nil))
        XCTAssertNil(noDeadline.expiresAtMilliseconds); XCTAssertNil(noDeadline.expirationDate)
        XCTAssertFalse(noDeadline.isExpired(atMilliseconds: Int64.max))
        XCTAssertTrue(noDeadline.canDecide(hostAvailable: true, atMilliseconds: Int64.max))
    }

    func testOfflineAndEveryPersistedStateGateBothDecisions() throws {
        for state in [ActionState.awaitingApproval, .ready, .running, .succeeded, .denied, .blocked, .unknown] {
            let display = ApprovalPresentation(action: try persistedAction(expiry: nil, state: state))
            XCTAssertFalse(display.canDecide(hostAvailable: false, atMilliseconds: 0))
            XCTAssertEqual(display.canDecide(hostAvailable: true, atMilliseconds: 0), state == .awaitingApproval)
            XCTAssertEqual(display.state, state)
        }
    }
    func testReadableProposalKeepsExactInputAndSeparatesTechnicalPins() throws {
        let command = "printf '%s\\n' 'synthetic only'\nexit 0"
        let arguments: [String: JSONValue] = ["input": .object([
            "command": .string(command), "runtime": .string("zsh"),
            "cwd": .string("fixture"), "timeout_ms": .integer(5000)
        ]), "pin": .object(["hostId": .string("private-pin")])]
        let original = try persistedAction(arguments: arguments)
        let action = Action(id: original.id, request: .init(botId: original.request.botId,
            threadId: original.request.threadId, tool: "dexter.harness.terminal.run", destination: "dexter-harness-owner-proposals",
            arguments: arguments, idempotencyKey: original.request.idempotencyKey),
            requestHash: original.requestHash, grantRevision: original.grantRevision, state: original.state,
            createdAt: original.createdAt, updatedAt: original.updatedAt, approvalExpiresAt: original.approvalExpiresAt,
            decidedBy: nil, result: nil, reason: nil)
        let display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.title, "Executar comando")
        XCTAssertEqual(display.readableFields.first { $0.label == "Comando exato" }?.value, command)
        XCTAssertFalse(display.readableFields.contains { $0.value == "private-pin" })
        XCTAssertTrue(display.formattedArguments.contains("private-pin"))
        XCTAssertEqual(display.action, action, "Readable display cannot alter exact consent identity")
        XCTAssertNotNil(display.scopeExplanation)
    }

    func testApprovedIsNotPresentedAsCompletedAndHistoryExcludesLiveActions() throws {
        for state in [ActionState.awaitingApproval, .ready, .running] {
            XCTAssertFalse(ApprovalPresentation(action: try persistedAction(state: state)).isHistorical)
        }
        for state in [ActionState.succeeded, .denied, .blocked, .unknown] {
            XCTAssertTrue(ApprovalPresentation(action: try persistedAction(state: state)).isHistorical)
        }
        let ready = ApprovalPresentation(action: try persistedAction(state: .ready))
        XCTAssertTrue(ready.resultExplanation.contains("ainda não há resultado"))
        XCTAssertFalse(ready.isPendingDecision)
    }

    func testLiveHarnessNamesHaveReadableTitlesAndEffectiveScope() throws {
        let terminal = ApprovalPresentation(action: try persistedAction(tool: "dexter.harness.terminal.run", destination: "dexter-harness-owner-proposals"))
        XCTAssertEqual(terminal.title, "Executar comando")
        XCTAssertEqual(terminal.destinationLabel, "Neste Mac · terminal")
        XCTAssertTrue(try XCTUnwrap(terminal.scopeExplanation).contains("não limita o acesso"))
        let file = ApprovalPresentation(action: try persistedAction(tool: "dexter.harness.files.write", destination: "dexter-harness-owner-proposals"))
        XCTAssertEqual(file.title, "Salvar arquivo")
        XCTAssertEqual(file.destinationLabel, "Arquivos deste bot")
        let communication = ApprovalPresentation(action: try persistedAction(tool: BotCommunicationProposal.tool))
        XCTAssertEqual(communication.title, "Alterar comunicação do bot")
    }

    func testAnyDestinationUnwrapsInputAndHidesMetadataWithoutChangingDecision() throws {
        let hash = String(repeating: "a", count: 64)
        let input: [String: JSONValue] = ["command": .string("printf synthetic"), "cwd": .string("work"),
            "args": .array([.string("exact argument")]), "payload": .object(["manifestHash": .string(hash), "text": .string("keep this")])]
        let action = try persistedAction(arguments: ["input": .object(input), "pin": .object(["manifestHash": .string(hash)]),
            "origin": .object(["turnId": .string("internal-turn")]), "requestHash": .string(hash)])
        let display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.readableFields.first(where: { $0.id == "/command" })?.value, "printf synthetic")
        XCTAssertEqual(display.readableFields.first(where: { $0.id == "/args/0" })?.value, "exact argument")
        XCTAssertEqual(display.readableFields.first(where: { $0.id == "/payload/text" })?.value, "keep this")
        XCTAssertFalse(display.readableFields.contains(where: { $0.value == hash || $0.value == "internal-turn" }))
        XCTAssertLessThanOrEqual(display.summaryFields.count, 2)
        XCTAssertFalse(display.summaryFields.contains(where: { $0.id.hasPrefix("/args") }))
        XCTAssertTrue(display.formattedArguments.contains(hash))
        XCTAssertEqual(display.action, action)
        XCTAssertEqual(display.requestHash, action.requestHash)
    }

    func testFileReplacementExplainsEffectWithoutExposingVersionHash() throws {
        let hash = String(repeating: "b", count: 64)
        let display = ApprovalPresentation(action: try persistedAction(arguments: ["input": .object([
            "path": .string("notes.txt"), "text": .string("new synthetic content"), "expected_sha256": .string(hash)])],
            tool: "dexter.harness.files.write", destination: "dexter-harness-owner-proposals"))
        XCTAssertEqual(display.summaryFields.map(\.value), ["notes.txt", "Substituir arquivo existente"])
        XCTAssertTrue(display.readableFields.contains(where: { $0.value == "new synthetic content" }))
        XCTAssertFalse(display.readableFields.contains(where: { $0.value == hash }))
        XCTAssertTrue(display.formattedArguments.contains(hash))
    }

    func testNaturalExpiryLeavesDecisionQueueWithoutChangingPersistedState() throws {
        let display = ApprovalPresentation(action: try persistedAction(expiry: 1000))
        XCTAssertTrue(display.needsDecision(atMilliseconds: 999))
        XCTAssertFalse(display.isHistorical(atMilliseconds: 999))
        XCTAssertFalse(display.needsDecision(atMilliseconds: 1000))
        XCTAssertTrue(display.isHistorical(atMilliseconds: 1000))
        XCTAssertEqual(display.stateLabel(atMilliseconds: 1000), "Expirada")
        XCTAssertEqual(display.outcome(atMilliseconds: 1000), .expired)
        XCTAssertEqual(display.statusSymbol(atMilliseconds: 1000), "clock.badge.exclamationmark")
        XCTAssertEqual(display.state, .awaitingApproval)
        XCTAssertTrue(display.resultExplanation(atMilliseconds: 1000).contains("sem autorização"))
    }

    func testTerminalErrorAndUnknownNeverLookSuccessful() throws {
        let command = try persistedAction(state: .succeeded, tool: "dexter.harness.terminal.run",
            result: .object(["exitCode": .integer(3), "termination": .string("completed"), "signal": .null,
                "stdout": .string("synthetic"), "stderrDiscarded": .bool(true)]))
        let commandDisplay = ApprovalPresentation(action: command)
        XCTAssertEqual(commandDisplay.stateLabel(atMilliseconds: 0), "Comando terminou com erro")
        XCTAssertTrue(commandDisplay.resultExplanation.contains("código 3"))
        XCTAssertEqual(commandDisplay.outcome(atMilliseconds: 0), .commandFailed(exitCode: 3))
        XCTAssertEqual(commandDisplay.statusSymbol(atMilliseconds: 0), "exclamationmark.circle")
        XCTAssertEqual(commandDisplay.state, .succeeded, "A command exit status is separate from the receipt state")
        for (state, reason, expected) in [(ActionState.blocked, ActionReason.executorError, "Erro na execução"),
                                          (.unknown, .executorError, "Resultado não confirmado")] {
            let display = ApprovalPresentation(action: try persistedAction(state: state, reason: reason))
            XCTAssertEqual(display.stateLabel(atMilliseconds: 0), expected)
            XCTAssertTrue(display.isHistorical(atMilliseconds: 0))
            XCTAssertFalse(display.canDecide(hostAvailable: true, atMilliseconds: 0))
        }
    }

    func testRealHostTimeoutReceiptNeverPresentsSuccessAndPreservesCanonicalAction() throws {
        let result: JSONValue = .object(["runtime": .string("zsh"), "cwd": .string("."),
            "termination": .string("timeout"), "exitCode": .null, "signal": .string("SIGTERM"),
            "stdout": .string(""), "stdoutTruncated": .bool(false), "stderrDiscarded": .bool(true),
            "executionBoundary": .string("owner_os_permissions"), "cwdIsNotSandbox": .bool(true)])
        for tool in ["dexter.harness.terminal.run", "dexter.harness.cli.run"] {
            for state in [ActionState.succeeded, .blocked] {
                let action = try persistedAction(state: state, tool: tool, result: result,
                    reason: state == .blocked ? .executorError : nil)
                let display = ApprovalPresentation(action: action)
                XCTAssertEqual(display.outcome(atMilliseconds: 0), .commandTimedOut)
                XCTAssertEqual(display.stateLabel(atMilliseconds: 0), "Tempo limite atingido")
                XCTAssertEqual(display.statusSymbol(atMilliseconds: 0), "exclamationmark.circle")
                XCTAssertTrue(display.resultExplanation.contains("efeito pode ser parcial"))
                XCTAssertTrue(display.resultExplanation.contains("Não há nova tentativa automática"))
                XCTAssertTrue(display.resultExplanation.contains("descartou avisos e erros"))
                XCTAssertEqual(display.action, action)
                XCTAssertEqual(display.state, state)
                XCTAssertEqual(display.action.result, result)
                XCTAssertEqual(display.requestHash, "host-issued-hash-kept-verbatim")
                XCTAssertEqual(display.grantRevision, 17)
                XCTAssertEqual(display.action.request.idempotencyKey, "intent-10")
            }
        }
    }

    func testRealHostPersistedExpiryIsNotHumanDenial() throws {
        let action = try persistedAction(state: .denied, reason: .approvalExpired)
        let display = ApprovalPresentation(action: action)
        XCTAssertEqual(display.state, .denied)
        XCTAssertEqual(display.outcome(atMilliseconds: 0), .expired)
        XCTAssertEqual(display.stateLabel(atMilliseconds: 0), "Expirada")
        XCTAssertEqual(display.statusSymbol(atMilliseconds: 0), "clock.badge.exclamationmark")
        XCTAssertEqual(display.resultExplanation, "A proposta expirou sem autorização. Peça uma nova proposta.")
        XCTAssertEqual(display.action, action)
        XCTAssertFalse(display.needsDecision(atMilliseconds: 0))
        XCTAssertFalse(display.canDecide(hostAvailable: true, atMilliseconds: 0))

        let humanDenial = ApprovalPresentation(action: try persistedAction(state: .denied, reason: .userDenied))
        XCTAssertEqual(humanDenial.outcome(atMilliseconds: 0), .userDenied)
        XCTAssertEqual(humanDenial.resultExplanation, "Você negou esta ação.")
        XCTAssertEqual(humanDenial.statusSymbol(atMilliseconds: 0), "xmark.circle")
        for reason: ActionReason? in [nil, .permissionChanged, .executorError] {
            let hostDenial = ApprovalPresentation(action: try persistedAction(state: .denied, reason: reason))
            XCTAssertEqual(hostDenial.outcome(atMilliseconds: 0), .hostDenied)
            XCTAssertFalse(hostDenial.resultExplanation.contains("Você negou"))
        }
    }

    func testCommandReceiptsRequireNormalTerminationNoSignalAndExitCode() throws {
        let interrupted: [[String: JSONValue]] = [
            ["termination": .string("completed"), "exitCode": .null, "signal": .null],
            ["termination": .string("completed"), "signal": .null],
            ["exitCode": .integer(0), "signal": .null],
            ["termination": .string("completed"), "exitCode": .integer(0), "signal": .string("SIGTERM")],
            ["termination": .string("spawn_failed"), "exitCode": .null, "signal": .null],
            ["termination": .string("cancelled"), "exitCode": .integer(0), "signal": .null],
            ["termination": .string("closed"), "exitCode": .integer(0), "signal": .null],
            ["termination": .string("stdout_limit"), "exitCode": .integer(0), "signal": .null]
        ]
        for tool in ["dexter.harness.terminal.run", "dexter.harness.cli.run"] {
            for result in interrupted {
                let display = ApprovalPresentation(action: try persistedAction(state: .succeeded, tool: tool, result: .object(result)))
                if result["termination"] == .string("spawn_failed") {
                    XCTAssertEqual(display.outcome(atMilliseconds: 0), .commandNotStarted)
                    XCTAssertEqual(display.stateLabel(atMilliseconds: 0), "Comando não iniciado")
                    XCTAssertFalse(display.resultExplanation.contains("efeito pode ser parcial"))
                    XCTAssertTrue(display.resultExplanation.contains("nenhuma nova tentativa é automática"))
                } else if result["termination"] == .string("stdout_limit"),
                          result["exitCode"] == .integer(0), result["signal"] == .null {
                    XCTAssertEqual(display.outcome(atMilliseconds: 0), .outputLimited)
                    XCTAssertEqual(display.stateLabel(atMilliseconds: 0), "Saída limitada")
                    XCTAssertFalse(display.resultExplanation.contains("efeito pode ser parcial"))
                    XCTAssertTrue(display.resultExplanation.contains("Não há nova tentativa automática"))
                } else {
                    XCTAssertEqual(display.outcome(atMilliseconds: 0), .commandInterrupted)
                    XCTAssertEqual(display.stateLabel(atMilliseconds: 0), "Comando interrompido")
                    XCTAssertTrue(display.resultExplanation.contains("efeito pode ser parcial"))
                    XCTAssertTrue(display.resultExplanation.contains("Não há nova tentativa automática"))
                }
                XCTAssertEqual(display.statusSymbol(atMilliseconds: 0), "exclamationmark.circle")
            }
            for termination in ["completed", "exited"] {
                for code: Int64 in [0, 3] {
                    let action = try persistedAction(state: .succeeded, tool: tool, result: .object([
                        "termination": .string(termination), "exitCode": .integer(code), "signal": .null,
                        "stdout": .string("synthetic"), "stderrDiscarded": .bool(true)]))
                    let display = ApprovalPresentation(action: action)
                    XCTAssertEqual(display.outcome(atMilliseconds: 0), code == 0 ? .completed : .commandFailed(exitCode: code))
                    XCTAssertEqual(display.statusSymbol(atMilliseconds: 0), code == 0 ? "checkmark.circle" : "exclamationmark.circle")
                    XCTAssertEqual(display.action, action)
                }
            }
        }
    }

    func testUnknownAndLiveStatesNeverClaimReceiptSuccessOrTimeout() throws {
        let result: JSONValue = .object(["termination": .string("timeout"), "exitCode": .null, "signal": .string("SIGTERM")])
        for (state, outcome) in [(ActionState.ready, ApprovalOutcome.ready), (.running, .running), (.unknown, .unknown)] {
            let display = ApprovalPresentation(action: try persistedAction(state: state,
                tool: "dexter.harness.terminal.run", result: result, reason: .executorError))
            XCTAssertEqual(display.outcome(atMilliseconds: Int64.max), outcome)
            XCTAssertNotEqual(display.statusSymbol(atMilliseconds: Int64.max), "checkmark.circle")
            XCTAssertEqual(display.state, state)
        }
    }

    func testReadableResultLabelsExplainHostBoundaryAndRetainRawTechnicalReceipt() throws {
        let result: JSONValue = .object(["termination": .string("timeout"), "signal": .string("SIGTERM"),
            "exitCode": .null, "stdout": .string(""), "stdoutTruncated": .bool(false),
            "stderrDiscarded": .bool(true), "executionBoundary": .string("owner_os_permissions"),
            "cwdIsNotSandbox": .bool(true)])
        let display = ApprovalPresentation(action: try persistedAction(state: .succeeded,
            tool: "dexter.harness.terminal.run", result: result))
        let fields = Dictionary(uniqueKeysWithValues: display.readableResultFields.map { ($0.id, $0) })
        XCTAssertEqual(fields["result/termination"]?.label, "Resultado · Encerramento")
        XCTAssertEqual(fields["result/termination"]?.value, "Tempo limite atingido")
        XCTAssertEqual(fields["result/signal"]?.label, "Resultado · Sinal de encerramento")
        XCTAssertEqual(fields["result/signal"]?.value, "SIGTERM")
        XCTAssertEqual(fields["result/stderrDiscarded"]?.label, "Resultado · Avisos e erros descartados")
        XCTAssertEqual(fields["result/stderrDiscarded"]?.value, "Sim")
        XCTAssertEqual(fields["result/stdoutTruncated"]?.label, "Resultado · Saída truncada")
        XCTAssertEqual(fields["result/cwdIsNotSandbox"]?.label, "Resultado · Pasta de trabalho não limita acesso ao sistema")
        XCTAssertEqual(fields["result/executionBoundary"]?.value, "Permissões do usuário deste Mac")
        XCTAssertNil(fields["result/stderr"], "A discarded stderr must never be invented")
        let rawJSON = try XCTUnwrap(display.formattedResult)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: Data(rawJSON.utf8)), result)
        XCTAssertTrue(rawJSON.contains("owner_os_permissions"))
        XCTAssertEqual(display.action.result, result)
    }

    // MARK: UX-P2-20 history grouping (display only)

    private func historyAction(_ id: String, tool: String = "dexter.harness.terminal.run", state: ActionState = .blocked,
                               reason: ActionReason? = .permissionChanged, updated: Int64, bot: String = "bot_a",
                               expiry: Int64? = nil) -> Action {
        Action(id: id, request: ActionRequest(botId: bot, threadId: "thr_1", tool: tool, destination: "dexter-harness-owner-proposals",
            arguments: ["command": .string("ls")], idempotencyKey: "k-\(id)"), requestHash: "h-\(id)", grantRevision: 0, state: state,
            createdAt: updated - 10, updatedAt: updated, approvalExpiresAt: expiry, decidedBy: nil, result: nil, reason: reason,
            authorization: nil, approvalRequirement: nil, approvalType: nil)
    }

    func testP220ConsecutiveSameOutcomesGroupNewestFirstWithReason() {
        let actions = [
            historyAction("a1", updated: 100), historyAction("a2", updated: 300), historyAction("a3", updated: 200),
            historyAction("b1", state: .denied, reason: .userDenied, updated: 400),
            historyAction("c1", tool: "dexter.harness.files.write", updated: 50),
        ]
        let groups = ApprovalHistoryGrouping.groups(actions, atMilliseconds: 1_000)
        XCTAssertEqual(groups.map(\.count), [1, 3, 1])
        XCTAssertEqual(groups[0].actions.map(\.id), ["b1"])
        XCTAssertEqual(groups[1].actions.map(\.id), ["a2", "a3", "a1"], "Newest first inside the group")
        XCTAssertEqual(groups[1].title, "Executar comando")
        XCTAssertEqual(groups[1].stateLabel, "Bloqueada")
        XCTAssertEqual(groups[1].explanation, "As permissões mudaram. Peça uma nova proposta.")
        XCTAssertEqual(groups[1].newestUpdatedAt, 300); XCTAssertEqual(groups[1].oldestUpdatedAt, 100)
        XCTAssertEqual(groups[1].id, "a2")
        XCTAssertEqual(groups[2].title, "Salvar arquivo", "Another tool never merges")
        XCTAssertEqual(groups.flatMap(\.actions).count, actions.count, "Every finished action stays listed once")
    }

    func testP220OnlyConsecutiveItemsMergeAndOtherReasonsOrBotsStayApart() {
        let actions = [
            historyAction("x1", updated: 500), historyAction("y1", state: .denied, reason: .userDenied, updated: 400),
            historyAction("x2", updated: 300),
            historyAction("z1", state: .blocked, reason: .executorError, updated: 200),
            historyAction("w1", updated: 100, bot: "bot_b"),
        ]
        let groups = ApprovalHistoryGrouping.groups(actions, atMilliseconds: 1_000)
        XCTAssertEqual(groups.map(\.count), [1, 1, 1, 1, 1], "Separated by another outcome, reason or bot: no merge")
        XCTAssertEqual(groups.map(\.id), ["x1", "y1", "x2", "z1", "w1"])
    }

    func testP220PendingAndRunningAreNeverGroupedOrHiddenHere() {
        let actions = [
            historyAction("p1", state: .awaitingApproval, reason: nil, updated: 900, expiry: 5_000),
            historyAction("r1", state: .running, reason: nil, updated: 800),
            historyAction("d1", updated: 700), historyAction("d2", updated: 600),
            historyAction("e1", state: .awaitingApproval, reason: nil, updated: 500, expiry: 900),
        ]
        let groups = ApprovalHistoryGrouping.groups(actions, atMilliseconds: 1_000)
        let ids = groups.flatMap(\.actions).map(\.id)
        XCTAssertFalse(ids.contains("p1"), "A proposal still awaiting the owner is shown where it is decided, not in history")
        XCTAssertFalse(ids.contains("r1"))
        XCTAssertEqual(groups.first?.actions.map(\.id), ["d1", "d2"])
        XCTAssertEqual(groups.last?.actions.map(\.id), ["e1"], "An expired, undecided proposal is history, with its own reason")
        XCTAssertEqual(groups.last?.stateLabel, "Expirada")
    }
}
