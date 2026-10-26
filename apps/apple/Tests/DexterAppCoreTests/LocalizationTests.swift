import Foundation
import XCTest
import DexterHostClient
@testable import DexterAppCore

final class LocalizationTests: XCTestCase {
    private static let appleRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private func catalog() throws -> [String: [String: Any]] {
        let data = try Data(contentsOf: Self.appleRoot.appendingPathComponent("SharedApp/Resources/Localizable.xcstrings"))
        return try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["strings"] as? [String: [String: Any]])
    }

    func testExplicitTranslationsAndFormatSignatures() throws {
        let audit = LocalizationAudit()
        for (key, entry) in try catalog() {
            let languages = try XCTUnwrap(entry["localizations"] as? [String: [String: Any]])
            var values: [String] = []
            for language in ["en", "pt-BR"] {
                let unit = try XCTUnwrap(languages[language]?["stringUnit"] as? [String: String], "\(key): \(language)")
                XCTAssertEqual(unit["state"], "translated", key)
                let value = try XCTUnwrap(unit["value"])
                XCTAssertFalse(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, key)
                values.append(value)
            }
            for problem in audit.formatProblems(key: key, english: values[0], portuguese: values[1]) { XCTFail(problem) }
        }
    }

    func testEveryCompiledTranslationAndSelectedLocaleLookup() throws {
        for variable in ["DEXTER_LOCALIZATION_MAC_BUNDLE", "DEXTER_LOCALIZATION_IOS_BUNDLE"] {
            let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "unsigned build bundle required")
            let bundle = try XCTUnwrap(Bundle(path: path))
            for (key, entry) in try catalog() {
                let languages = try XCTUnwrap(entry["localizations"] as? [String: [String: Any]])
                for language in ["en", "pt-BR"] {
                    let unit = try XCTUnwrap(languages[language]?["stringUnit"] as? [String: String])
                    XCTAssertEqual(DexterLocalization.text(key, bundle: bundle, locale: Locale(identifier: language)), unit["value"], "\(variable): \(language): \(key)")
                }
            }
            XCTAssertEqual(DexterLocalization.text("Ajustes", bundle: bundle, locale: Locale(identifier: "fr-FR")), "Settings")
            let payload = "personal / conn-A / 🧪 / %@ / 9007199254740993"
            XCTAssertEqual(DexterLocalization.format("You said: %@", payload, bundle: bundle, locale: Locale(identifier: "en")), "You said: " + payload)
            XCTAssertEqual(DexterLocalization.format("You said: %@", payload, bundle: bundle, locale: Locale(identifier: "pt-BR")), "Você disse: " + payload)
            XCTAssertEqual(DexterLocalization.text(payload, bundle: bundle, locale: Locale(identifier: "pt-BR")), payload)
        }
    }

    func testVisibleLiteralAndLookupPathsHaveCatalogCoverage() throws {
        let keys = Set(try catalog().keys)
        let audit = LocalizationAudit(catalogKeys: keys)
        var scanned = 0
        for folder in ["SharedApp/Sources", "Sources/DexterAppCore"] {
            let directory = Self.appleRoot.appendingPathComponent(folder)
            for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where file.pathExtension == "swift" {
                scanned += 1
                for problem in audit.problems(in: try String(contentsOf: file, encoding: .utf8)) { XCTFail("\(file.lastPathComponent):\(problem)") }
            }
        }
        XCTAssertGreaterThan(scanned, 40)
        // Conditional/computed labels use these existing keys; user content and protocol values are never keys.
        for key in ["Na fila", "Pensando…", "Turno na fila", "Turno em andamento", "Em execução", "Aprovação necessária", "Aguardando execução", "Concluída", "Negada", "Bloqueada", "Resultado desconhecido", "Carregando bots…", "Nenhum bot neste host."] {
            XCTAssertTrue(keys.contains(key), key)
        }
        for key in ["Abrir ajustes de Som", "Permitir microfone nos Ajustes", "Detalhes do áudio", "Formato do microfone",
                    "Conversão do microfone", "Inicialização do áudio", "Reprodução de áudio"] {
            XCTAssertTrue(keys.contains(key), key)
        }
    }

    /// The compiler's own extraction (SWIFT_EMIT_LOC_STRINGS=YES) is the exact key SwiftUI and String(localized:) look up,
    /// including typed interpolation (%lld for Int) and conditional literals a source scan cannot type.
    func testCompilerExtractedLocalizedKeysHaveCatalogCoverage() throws {
        let audit = LocalizationAudit(catalogKeys: Set(try catalog().keys))
        for variable in ["DEXTER_LOCALIZATION_MAC_STRINGSDATA", "DEXTER_LOCALIZATION_IOS_STRINGSDATA"] {
            let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "unsigned build with SWIFT_EMIT_LOC_STRINGS=YES required")
            var sharedAppFiles = Set<String>(), extracted = 0, reported = Set<String>()
            for file in try LocalizationAudit.stringsdataFiles(in: URL(fileURLWithPath: path)) {
                let extraction = try LocalizationAudit.extraction(fromStringsdata: Data(contentsOf: file))
                guard LocalizationAudit.usesAppCatalog(extraction.source) else { continue }
                if extraction.source.contains("/SharedApp/Sources/") { sharedAppFiles.insert(extraction.source) }
                extracted += extraction.keys.count
                for problem in audit.missingExtractedKeys(extraction) where reported.insert(problem).inserted { XCTFail("\(variable): \(problem)") }
            }
            // A wrong or empty directory must not pass vacuously (the iOS target compiles fewer SharedApp files than macOS).
            XCTAssertGreaterThanOrEqual(sharedAppFiles.count, 5, variable)
            XCTAssertGreaterThan(extracted, 200, variable)
        }
    }

    func testModelFallbackWithoutResourceBundleIsEnglish() {
        XCTAssertEqual(DexterLocalization.text("The decision requires an active connection to the host.", bundle: Bundle(for: Self.self), locale: Locale(identifier: "en")), "The decision requires an active connection to the host.")
    }

    // Regression fixtures: each corrected rule still reports the real failure it exists to catch.

    func testFormatRuleStillCatchesRealMismatches() {
        let audit = LocalizationAudit()
        XCTAssertTrue(LocalizationAudit.isSemanticIdentifier("connections.identity.verified"))
        XCTAssertFalse(LocalizationAudit.isSemanticIdentifier("Conta usada: %@"))
        XCTAssertFalse(LocalizationAudit.isSemanticIdentifier("Ex.: 🏡"))
        XCTAssertFalse(LocalizationAudit.isSemanticIdentifier("Versão"))
        // A semantic ID carries no text, so only English and Portuguese must agree.
        XCTAssertEqual(audit.formatProblems(key: "connections.identity.verified", english: "Email confirmed: %@", portuguese: "E-mail confirmado: %@"), [])
        XCTAssertEqual(audit.formatProblems(key: "connections.identity.verified", english: "Email confirmed: %@", portuguese: "E-mail confirmado").count, 1)
        // A natural-language key is the text SwiftUI formats: it must match English exactly, including the specifier type.
        XCTAssertEqual(audit.formatProblems(key: "Conta usada: %@", english: "Account used", portuguese: "Conta usada: %@").count, 2)
        XCTAssertEqual(audit.formatProblems(key: "%lld itens", english: "%@ items", portuguese: "%lld itens").count, 2)
        XCTAssertEqual(audit.formatProblems(key: "%lld itens", english: "%lld items", portuguese: "%lld itens"), [])
    }

    func testSourceAuditStillReportsRealGaps() {
        let audit = LocalizationAudit(catalogKeys: ["Presente", "Tem %lld itens", "Mostrar %@", "Chave existente", "Linha\nNova"])
        XCTAssertEqual(audit.problems(in: #"Text("Faltando")"#).count, 1)
        XCTAssertEqual(audit.problems(in: #"Text("Presente")"#), [])
        XCTAssertEqual(audit.problems(in: #".help("Faltando")"#).count, 1)
        // SwiftUI types the slot (%lld for Int); the exact type is enforced by the compiler-extraction test.
        XCTAssertEqual(audit.problems(in: #"Text("Tem \(itens.count) itens")"#), [])
        XCTAssertEqual(audit.problems(in: #"Text("Tem \(itens.count) coisas")"#).count, 1)
        // Balanced parsing: parentheses and strings inside an interpolation do not corrupt the key.
        XCTAssertEqual(audit.problems(in: #"Text("Tem \(lista.filter { $0.nome != ")" }.map(\.id).count) itens")"#), [])
        // Only placeholders and punctuation: nothing to translate, SwiftUI shows the formatted key in every language.
        XCTAssertEqual(audit.problems(in: #"Text("\(a) · \(b)")"#), [])
        XCTAssertEqual(audit.problems(in: #"Text("\(n)/2.000")"#).count, 1)
        // A plain literal nested in a localized interpolation is shown untranslated; a localized one is fine.
        XCTAssertEqual(audit.problems(in: #"Text("Mostrar \(flag ? "tudo" : "")")"#).count, 1)
        XCTAssertEqual(audit.problems(in: #"Text("Mostrar \(flag ? String(localized: "tudo") : "")")"#), [])
        // …and a runtime lookup nested in the interpolation is still checked against the catalog.
        XCTAssertEqual(audit.problems(in: #"Text("Mostrar \(flag ? DexterLocalization.text("tudo", locale: locale) : "")")"#), ["1: runtime lookup key missing from catalog: tudo"])
        XCTAssertEqual(audit.problems(in: "// Text(\"Comentado\")\n/* Button(\"Também\") */"), [])
        XCTAssertEqual(audit.problems(in: #"Text(verbatim: count > 99 ? "99+" : "\(count)")"#), [])
        XCTAssertEqual(audit.problems(in: #"Button(flag ? "Presente" : "Ausente") {}"#).count, 1)
        // Runtime lookups need the exact key (escapes decoded); interpolation makes the key unknowable.
        XCTAssertEqual(audit.problems(in: #"DexterLocalization.text("Chave existente", locale: locale)"#), [])
        XCTAssertEqual(audit.problems(in: #"DexterLocalization.text("Linha\nNova")"#), [])
        XCTAssertEqual(audit.problems(in: #"DexterLocalization.text(flag ? "Chave existente" : "Ausente")"#).count, 1)
        XCTAssertEqual(audit.problems(in: #"DexterLocalization.text("Olá \(nome)")"#).count, 1)
        XCTAssertEqual(audit.problems(in: #"copy.text("Ausente")"#).count, 1)
        // Inline pairs only with the file's declared text(_ pt:, _ en:) helper; both sides must carry the same values.
        let helper = "private func text(_ pt: String, _ en: String) -> String { pt }\n"
        XCTAssertEqual(audit.problems(in: helper + #"Text(text("Olá \(nome)", "Hello \(nome)"))"#), [])
        XCTAssertEqual(audit.problems(in: helper + #"Text(text("Olá \(nome)", "Hello"))"#).count, 1)
        XCTAssertEqual(audit.problems(in: helper + #"Text(text("", "Hello"))"#).count, 1)
        XCTAssertEqual(audit.problems(in: #"Text(text("Olá", "Hello"))"#).count, 1)
    }

    func testCompilerExtractionAuditRegressions() throws {
        let audit = LocalizationAudit(catalogKeys: ["%@ itens", "Presente"])
        let data = Data(#"{"source":"/x/SharedApp/Sources/V.swift","tables":{"Localizable":[{"comment":"","key":"%lld itens","location":{"startingColumn":1,"startingLine":7}},{"comment":"","key":"Presente","location":{"startingColumn":1,"startingLine":8}},{"comment":"","key":"%@ · %@","location":{"startingColumn":1,"startingLine":9}}],"Other":[{"comment":"","key":"Ignorada","location":{"startingColumn":1,"startingLine":10}}]}}"#.utf8)
        // "%@ itens" in the catalog does not cover SwiftUI's "%lld itens": the runtime lookup would miss.
        XCTAssertEqual(audit.missingExtractedKeys(try LocalizationAudit.extraction(fromStringsdata: data)), ["V.swift:7: %lld itens"])
        // Packages with their own Localizable.xcstrings look keys up with bundle: .module, not in the app catalog.
        XCTAssertTrue(LocalizationAudit.usesAppCatalog("/b/apps/apple/SharedApp/Sources/ChatView.swift"))
        XCTAssertTrue(LocalizationAudit.usesAppCatalog("/b/apps/apple/Sources/DexterAppCore/ApprovalModeMenu.swift"))
        XCTAssertFalse(LocalizationAudit.usesAppCatalog("/b/apps/apple/Capabilities/Sources/DexterIOSCapabilities/IOSForegroundCapabilitiesView.swift"))
        XCTAssertFalse(LocalizationAudit.usesAppCatalog("/b/apps/apple/NativeActions/Sources/DexterNativeActions/Intents.swift"))
    }

    // MARK: String-valued computed labels (r4)

    private func compiledBundles() throws -> [(name: String, bundle: Bundle)] {
        try ["DEXTER_LOCALIZATION_MAC_BUNDLE", "DEXTER_LOCALIZATION_IOS_BUNDLE"].map { variable in
            let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "unsigned build bundle required")
            return (variable, try XCTUnwrap(Bundle(path: path)))
        }
    }

    private func setupDiagnostic(_ code: String) throws -> McpSetupDiagnostic {
        let recoveries = ["needs_auth": "owner_authenticate_privately", "custody_unavailable": "owner_configure_private_custody",
            "native_mcp_disabled": "owner_enable_native_mcp", "oauth_client_required": "owner_supply_registered_oauth_client",
            "configuration_changed": "read_and_propose_again", "endpoint_invalid": "supply_known_http_mcp_endpoint",
            "timeout": "read_receipt_before_retry", "connect_failed": "check_known_endpoint_then_propose_discovery",
            "response_invalid": "owner_check_mcp_protocol"]
        let body = ["stage": "discovery", "code": code, "recovery": recoveries[code] ?? "future_recovery"]
        return try JSONDecoder().decode(McpSetupDiagnostic.self, from: JSONSerialization.data(withJSONObject: body))
    }

    /// Computed `String` labels (presenters, notices, failures) are resolved where they are produced. This test process
    /// has no app catalog, so each label comes back as its key: it must be a catalog key whose compiled English value is a
    /// real translation and whose Portuguese value is still the visible Portuguese text.
    func testComputedLabelsResolveInBothCompiledLanguages() throws {
        let catalog = try catalog()
        let outcomes: [ApprovalOutcome] = [.awaitingApproval, .ready, .running, .completed, .userDenied, .hostDenied, .expired, .blocked,
            .executionError, .commandFailed(exitCode: 2), .commandInterrupted, .commandTimedOut, .commandNotStarted, .outputLimited,
            .toolReportedError, .cancelled, .unknown]
        var labels = outcomes.map(\.stateLabel)
        labels += [TurnState.unknown, .interrupted].flatMap { state in
            let outcome = TurnOutcomePresentation(state: state, code: nil); return [outcome.title, outcome.detail]
        }
        for code in ["not_installed", "engine_unavailable", "unsupported", "authentication_required", "subscription_required", "usage_limit",
                     "rate_limited", "context_limit", "timeout", "busy", "tool_limit", "tool_identity_mismatch", "tool_response_failed",
                     "session_uncertain", "a_future_code"] {
            let outcome = TurnOutcomePresentation(state: .failed, code: code); labels += [outcome.title, outcome.detail]
        }
        labels += [BotDelegationState.pending, .running, .completed, .cancelled, .failed, .unknown].map(DelegationStateLabel.title)
        labels += ["mac.browser.navigate", "mac.browser.read", "mac.browser.close", "mac.file.read", "mac.file.append", "mac.cua.observe",
                   "mac.cua.control", "mac.cua.status"].map(DeviceToolLabel.title)
        labels += [nil, "ask", "deny", "allow"].map(DeviceToolLabel.policy)
        labels += [AvatarImageFailure.invalidImage, .imageTooLarge, .invalidPrompt, .invalidConfiguration, .keyMissing, .keyUnavailable,
                   .authenticationRejected, .rateLimited, .providerRejected, .outcomeUnknown, .responseInvalid].compactMap(\.errorDescription)
        labels += [LiveVoiceFailure.invalidConfiguration, .keyMissing, .keyUnavailable, .microphoneDenied, .audioUnavailable,
                   .audio(.inputFormat), .audio(.conversion), .audio(.engineStart, osStatus: -50), .audio(.playback),
                   .connectionUnavailable, .protocolRejected, .sessionTimeout, .audioBacklog, .delegationUnavailable].map(\.message)
        labels += [McpHttpDraftError.invalidName, .invalidID, .invalidURL, .secretURL, .insecureURL].compactMap(\.errorDescription)
        labels += try ["needs_auth", "custody_unavailable", "native_mcp_disabled", "oauth_client_required", "configuration_changed",
                       "endpoint_invalid", "timeout", "connect_failed", "response_invalid", "a_future_code"].map { try setupDiagnostic($0).message }
        labels += ["bossa", "tempo"].map(LiveVoiceCatalog.label)
        // English-keyed host messages work the other way round: English is the key, Portuguese is the translation.
        let englishKeyed = [LocalHostFailure.launchFailed, .startupTimedOut, .connectionNotLocal, .deviceUnlockRequired,
                            .invalidConfiguration("Port must be 1024–65535.")].map(\.message)
        XCTAssertGreaterThan(Set(labels).count, 100)
        for (name, bundle) in try compiledBundles() {
            for key in Set(labels) {
                XCTAssertNotNil(catalog[key], "\(name): computed label missing from the catalog: \(key)")
                XCTAssertEqual(DexterLocalization.text(key, bundle: bundle, locale: Locale(identifier: "pt-BR")), key, "\(name): \(key)")
                if key != "Skill" {
                    XCTAssertNotEqual(DexterLocalization.text(key, bundle: bundle, locale: Locale(identifier: "en")), key, "\(name): English shows Portuguese: \(key)")
                }
            }
            for key in englishKeyed {
                XCTAssertEqual(DexterLocalization.text(key, bundle: bundle, locale: Locale(identifier: "en")), key, "\(name): \(key)")
                XCTAssertNotEqual(DexterLocalization.text(key, bundle: bundle, locale: Locale(identifier: "pt-BR")), key, "\(name): Portuguese shows English: \(key)")
            }
            let english: (String) -> String = { DexterLocalization.text($0, bundle: bundle, locale: Locale(identifier: "en")) }
            XCTAssertEqual(english("Erro na execução"), "Run error")
            XCTAssertEqual(english("Não verificada"), "Not verified")
            XCTAssertEqual(english("Login necessário"), "Sign-in required")
            XCTAssertEqual(english("Nenhuma tarefa neste dia"), "No tasks on this day")
            XCTAssertEqual(english("Sem execuções registradas"), "No runs recorded")
            XCTAssertEqual(english("Nenhum bot encontrado."), "No bot found.")
            XCTAssertEqual(english("Coordenador"), "Coordinator")
            XCTAssertEqual(DexterLocalization.text("The local host process could not be launched.", bundle: bundle, locale: Locale(identifier: "pt-BR")),
                           "Não foi possível abrir o processo do host local.")
        }
    }

    /// Typed interpolations keep their slot type end to end: the presenter output equals the catalog format applied to the
    /// same value, and English formats the value the same way. Values coming from the host stay exactly as received.
    func testTypedValuesAndHostContentSurviveLocalizedFormats() throws {
        let catalog = try catalog()
        let commandFailed = "O comando terminou com código %lld. Confira o resultado antes de tentar novamente."
        XCTAssertNotNil(catalog[commandFailed])
        let action = try JSONDecoder().decode(Action.self, from: JSONSerialization.data(withJSONObject: [
            "id": "act-1", "request": ["botId": "bot-1", "threadId": "thread-1", "tool": "dexter.harness.terminal.run",
                "destination": "dexter-harness-owner-proposals", "idempotencyKey": "k-1", "arguments": ["command": "ls -la"]],
            "requestHash": "hash-1", "grantRevision": 1, "state": "succeeded", "createdAt": 1, "updatedAt": 2,
            "approvalExpiresAt": NSNull(), "decidedBy": NSNull(), "reason": NSNull(),
            "result": ["termination": "completed", "signal": NSNull(), "exitCode": 137, "kind": "a_future_kind", "note": "texto do host"]] as [String: Any]))
        let presentation = ApprovalPresentation(action: action)
        XCTAssertEqual(presentation.outcome(atMilliseconds: 0), .commandFailed(exitCode: 137))
        XCTAssertEqual(presentation.resultExplanation, String(format: commandFailed, locale: Locale(identifier: "pt_BR"), Int64(137)))
        // Unknown protocol values and host text are shown as received, never translated or looked up.
        XCTAssertEqual(presentation.readableResultFields.first { $0.id == "result/kind" }?.value, "a_future_kind")
        XCTAssertEqual(presentation.readableResultFields.first { $0.id == "result/note" }?.value, "texto do host")
        XCTAssertEqual(presentation.readableFields.first { $0.id == "/command" }?.value, "ls -la")
        XCTAssertEqual(DeviceToolLabel.title("mac.future.tool"), "mac.future.tool")
        XCTAssertEqual(DeviceToolLabel.policy("owner_custom"), "owner_custom")
        XCTAssertEqual(LiveVoiceCatalog.label("alloy"), "Alloy")
        for (name, bundle) in try compiledBundles() {
            let english = DexterLocalization.text(commandFailed, bundle: bundle, locale: Locale(identifier: "en"))
            XCTAssertEqual(String(format: english, locale: Locale(identifier: "en"), Int64(137)),
                           "The command exited with code 137. Check the result before trying again.", name)
            // Host/user values fill %@ slots byte for byte, even when they look like keys or format specifiers.
            let line = DexterLocalization.text("Conexão: %@ · %@ · conta não verificada · ferramenta %@", bundle: bundle, locale: Locale(identifier: "en"))
            let payload = ["Ferramentas descobertas", "personal / %@ / 🧪", "mcp.tool_x"]
            XCTAssertEqual(String(format: line, payload[0], payload[1], payload[2]),
                           "Connection: Ferramentas descobertas · personal / %@ / 🧪 · account not verified · tool mcp.tool_x", name)
            let weekly = DexterLocalization.text("Toda segunda às %@", bundle: bundle, locale: Locale(identifier: "en"))
            XCTAssertEqual(String(format: weekly, "09:30"), "Every Monday at 09:30", name)
            let group = DexterLocalization.text("Bots do grupo (%lld/%lld)", bundle: bundle, locale: Locale(identifier: "en"))
            XCTAssertEqual(String(format: group, 3, 8), "Group bots (3/8)", name)
        }
    }

    /// The compiler's extraction proves these computed labels, notices and empty states are runtime lookups
    /// (String(localized:) / LocalizedStringKey parameters) and not plain String values; typed slots are part of the key.
    func testCompilerExtractsStringValuedLabelsAndEmptyStates() throws {
        let expected: [String: [String]] = [
            "ApprovalPresentation.swift": ["Erro na execução", "Usar ferramenta de uma conexão", "Conexão MCP",
                                           "O comando terminou com código %lld. Confira o resultado antes de tentar novamente.", "Sim", "Não"],
            "FriendlyStatePresentation.swift": ["A engine pediu login.", "Abrir páginas no navegador do Mac", "Aguardando"],
            "DexterAppModel.swift": ["Consultando a origem das ações deste pedido…", "A OpenAI não confirmou a finalização do consumo."],
            "LocalHostProcess.swift": ["Port %u is already in use by a process Dexter did not start. It was not stopped or reused.",
                                       "The local host exited during startup (code %d)."],
            "LiveAPIKeyStore.swift": ["O microfone não disponibilizou um formato de áudio válido. Confira a entrada de som do Mac e tente novamente.",
                                      "Não foi possível processar o áudio do microfone. Inicie uma nova sessão de voz.",
                                      "Não foi possível reproduzir a voz. Confira a saída de som do Mac e tente novamente."],
            "McpConnections.swift": ["A descoberta não conectou ao serviço. Confira o endereço e solicite outra descoberta explicitamente."],
            "McpConnectionsView.swift": ["Mesmo endereço de %@. São conexões independentes; o Dexter não sabe qual conta cada uma usa.",
                                         "Login necessário", "Pendente"],
            "BotSettingsResourcesView.swift": ["Não verificada", "Não confirmado", "%lld ferramenta(s) deste bot"],
            "AutomationsView.swift": ["Nenhuma tarefa neste dia", "Sua primeira automação", "Sem execuções registradas",
                                      "Todo domingo às %@", "Toda segunda às %@", "A cada %lld min"],
            "TeamsView.swift": ["Função do time", "Bots e coordenador", "Ajustes do time"],
            "DexterRootView.swift": ["Criar bot ou time", "%@, %@ do time %@. %@. Abrir conversa privada do bot."],
            "GroupEditorView.swift": ["Bots do grupo (%lld/%lld)"],
            "ChatView.swift": ["Conexão: %@ · %@ · conta não verificada · ferramenta %@", "Ver outros bots"],
            "MacSelectableChatMessage.swift": ["Copiar código", "Em andamento"],
            "MemoryLearningView.swift": ["Registro %@; revisão %lld, política %lld, escopo %lld. Esquecer bloqueia uso e reaprendizagem imediatamente; histórico e backups continuam retidos."],
        ]
        // macOS-only views and #if os(macOS) code are absent from the iOS build; the shared presenters are in both.
        let crossPlatform: [String: [String]] = ["ApprovalPresentation.swift": expected["ApprovalPresentation.swift"] ?? [],
            "FriendlyStatePresentation.swift": expected["FriendlyStatePresentation.swift"] ?? [],
            "LiveAPIKeyStore.swift": expected["LiveAPIKeyStore.swift"] ?? [],
            "DexterAppModel.swift": ["Consultando a origem das ações deste pedido…"],
            "McpConnections.swift": expected["McpConnections.swift"] ?? []]
        for (variable, keysByFile) in [("DEXTER_LOCALIZATION_MAC_STRINGSDATA", expected), ("DEXTER_LOCALIZATION_IOS_STRINGSDATA", crossPlatform)] {
            let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "unsigned build with SWIFT_EMIT_LOC_STRINGS=YES required")
            var byFile: [String: Set<String>] = [:]
            for file in try LocalizationAudit.stringsdataFiles(in: URL(fileURLWithPath: path)) {
                let extraction = try LocalizationAudit.extraction(fromStringsdata: Data(contentsOf: file))
                guard LocalizationAudit.usesAppCatalog(extraction.source) else { continue }
                byFile[URL(fileURLWithPath: extraction.source).lastPathComponent, default: []].formUnion(extraction.keys.map(\.key))
            }
            for (file, keys) in keysByFile {
                let found = byFile[file] ?? []
                XCTAssertFalse(found.isEmpty, "\(variable): no extraction for \(file)")
                for key in keys { XCTAssertTrue(found.contains(key), "\(variable): \(file) does not look up \(key)") }
            }
        }
    }

    /// Portuguese text reaches the screen only through a localization path. Every literal in the app, AppCore and
    /// HostClient sources with Portuguese prose (or a translated catalog key) must be compiler-extracted, the key of a
    /// runtime lookup, one side of a locale-selected pt/en pair, a key produced for a declared render-site lookup, or
    /// declared verbatim with a reason (protocol, user-owned data, model payloads).
    func testPortugueseTextOutsideLocalizationPathsIsDeclared() throws {
        let catalog = try catalog()
        let translated = Set(catalog.compactMap { key, entry -> String? in
            let english = ((entry["localizations"] as? [String: Any])?["en"] as? [String: Any]).flatMap { ($0["stringUnit"] as? [String: String])?["value"] }
            return english != key && !LocalizationAudit.isSemanticIdentifier(key) ? key : nil
        })
        var extracted: [String: [Int: Set<String>]] = [:]
        for variable in ["DEXTER_LOCALIZATION_MAC_STRINGSDATA", "DEXTER_LOCALIZATION_IOS_STRINGSDATA"] {
            let path = try XCTUnwrap(ProcessInfo.processInfo.environment[variable], "unsigned build with SWIFT_EMIT_LOC_STRINGS=YES required")
            for file in try LocalizationAudit.stringsdataFiles(in: URL(fileURLWithPath: path)) {
                let extraction = try LocalizationAudit.extraction(fromStringsdata: Data(contentsOf: file))
                guard LocalizationAudit.usesAppCatalog(extraction.source) else { continue }
                let name = URL(fileURLWithPath: extraction.source).lastPathComponent
                for item in extraction.keys { extracted[name, default: [:]][item.line, default: []].insert(LocalizationAudit.slotless(item.key)) }
            }
        }
        let audit = LocalizationAudit(catalogKeys: Set(catalog.keys))
        var used = Set<String>(), scanned = 0, portuguese = 0, verdicts: [String] = []
        for folder in ["SharedApp/Sources", "Sources/DexterAppCore", "Sources/DexterHostClient"] {
            let directory = Self.appleRoot.appendingPathComponent(folder)
            for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where file.pathExtension == "swift" {
                scanned += 1
                let name = file.lastPathComponent
                let report = audit.portugueseOutsideLocalization(in: try String(contentsOf: file, encoding: .utf8), file: name,
                    extracted: extracted[name] ?? [:], translatedKeys: translated, declarations: .current)
                portuguese += report.portuguese; used.formUnion(report.usedDeclarations)
                verdicts += report.verdicts.map { "\(folder)/\(name)\t\($0)" }
                for problem in report.problems { XCTFail("\(name):\(problem)") }
            }
        }
        XCTAssertGreaterThan(scanned, 120)
        XCTAssertGreaterThan(portuguese, 2_000)
        // Evidence only: the per-literal verdicts, when a path is given. Never affects the result.
        if let path = ProcessInfo.processInfo.environment["DEXTER_LOCALIZATION_AUDIT_REPORT"] {
            try (verdicts.sorted().joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
        }
        // A declaration that no longer matches anything is removed, so the list cannot hide future text.
        for stale in LocalizationAudit.Declarations.current.all.subtracting(used).sorted() { XCTFail("stale declaration: \(stale)") }
    }

    func testPortugueseAuditStillReportsStringValuedGaps() {
        let audit = LocalizationAudit(catalogKeys: ["Presente", "Login necessário", "Bloqueado"])
        let check = { (source: String, extracted: [Int: Set<String>]) in
            audit.portugueseOutsideLocalization(in: source, file: "V.swift", extracted: extracted, translatedKeys: ["Bloqueado"],
                                                declarations: .init(runtimeKeyProducers: ["V.swift": ["chave"]], verbatim: ["V.swift": ["Dexter · cofre de teste": "Keychain label"]])).problems.count
        }
        // A computed String handed to Text/LabeledContent is shown as is: the class this audit exists for.
        XCTAssertEqual(check(#"var status: String { "Não verificada" }"#, [:]), 1)
        XCTAssertEqual(check(#"LabeledContent("Conta", value: "Não verificada")"#, [1: ["Conta"]]), 1)
        XCTAssertEqual(check(#"Text(flag ? "Na fila" : detail)"#, [:]), 1)
        XCTAssertEqual(check(#"notice = "Não foi possível salvar.""#, [:]), 1)
        // A single translated catalog word used verbatim is caught without any accent or function word.
        XCTAssertEqual(check(#"let state = "Bloqueado""#, [:]), 1)
        // Concatenated sentence fragments are still Portuguese text without a path.
        XCTAssertEqual(check(#"let line = "Mesmo nome de " + name"#, [:]), 1)
        // Localized at the definition (compiler-extracted at its own line) or looked up with a literal key: fine.
        XCTAssertEqual(check(#"var status: String { String(localized: "Não verificada") }"#, [1: ["Não verificada"]]), 0)
        XCTAssertEqual(check(#"Text(DexterLocalization.text("Login necessário", locale: locale))"#, [:]), 0)
        XCTAssertEqual(check(#"Text(LocalizedStringKey(flag ? "Presente" : "Login necessário"))"#, [:]), 0)
        // …but a lookup key that is not in the catalog shows Portuguese in English.
        XCTAssertEqual(check(#"Text(DexterLocalization.text("Não existe", locale: locale))"#, [:]), 1)
        // Extraction must match the literal itself, not another key on the same line.
        XCTAssertEqual(check(#"LabeledContent("Conta", value: "Não verificada")"#, [1: ["Conta", "Outra"]]), 1)
        // Locale-selected pairs are localized where they are written.
        XCTAssertEqual(check("func copy(_ p: String, _ e: String) -> String { p }\n" + #"Text(copy("Não verificada", "Not verified"))"#, [:]), 0)
        XCTAssertEqual(check(#"let title = portuguese ? "Não verificada" : "Not verified""#, [:]), 0)
        XCTAssertEqual(check(#"let title = isEnabled ? "Não verificada" : "Not verified""#, [:]), 1)
        // A nested plain literal inside a localized literal is shown untranslated, even a single word or a placeholder-only key.
        XCTAssertEqual(check(#"String(localized: "Fila \(cheia ? "sem vagas" : "")")"#, [1: ["Fila %@"]]), 1)
        XCTAssertEqual(check(#"Text("\(nome) · \(origem == "manual" ? "Manual" : "Agendada")")"#, [1: ["%@ · %@"]]), 2)
        XCTAssertEqual(check(#"Text("\(nome) · \(origem == "manual" ? String(localized: "Manual") : String(localized: "Agendada"))")"#, [1: ["%@ · %@", "Manual", "Agendada"]]), 0)
        // Declared runtime keys must exist in the catalog; declared verbatim text is exact, per file.
        XCTAssertEqual(check(#"func chave() -> String { "Login necessário" }"#, [:]), 0)
        XCTAssertEqual(check(#"func chave() -> String { "Não catalogada" }"#, [:]), 1)
        XCTAssertEqual(check(#"label = "Dexter · cofre de teste""#, [:]), 0)
        XCTAssertEqual(check(#"label = "Dexter · cofre de produção""#, [:]), 1)
        // English, identifiers, comments and protocol tokens are not Portuguese prose.
        XCTAssertEqual(check("// Text(\"Não verificada\")\nlet id = \"mcp.instance-identity\"\nlet message = \"The host rejected its arguments.\"", [:]), 0)
    }
}

/// Localization audit used only by these tests: a Swift string-literal scanner for visible SwiftUI keys, runtime lookups
/// and inline pt/en pairs, plus the compiler's extracted keys. It never changes what the app shows.
struct LocalizationAudit {
    var catalogKeys: Set<String> = []
    private let format = try! NSRegularExpression(pattern: #"%(?:\d+\$)?[-+0 #]*(?:\d+)?(?:\.\d+)?(?:hh|h|ll|l|z|t|j)?[@diuoxXfFeEgGcCsSp%]"#)
    private let call = try! NSRegularExpression(pattern: #"(?:\b(DexterLocalization)\s*\.\s*)?(?<![\w])(Text|Label|Section|Button|Picker|LabeledContent|ContentUnavailableView|TextField|SecureField|ProgressView|navigationTitle|accessibilityLabel|accessibilityValue|accessibilityHint|alert|confirmationDialog|help|Toggle|Stepper|GroupBox|DisclosureGroup|DatePicker|ColorPicker|Menu|Link|text|format|t)\(\s*"#)
    private let bilingualHelper = try! NSRegularExpression(pattern: #"func (\w+)\(_ pt: String, _ en: String\)"#)
    private var normalizedKeys: Set<String> = []

    init(catalogKeys: Set<String> = []) {
        self.catalogKeys = catalogKeys
        normalizedKeys = Set(catalogKeys.map(normalized))
    }

    // MARK: Format signatures

    func signatures(_ text: String) -> [String] {
        format.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { (text as NSString).substring(with: $0.range) }
    }

    /// Identifier keys such as `connections.identity.verified`: no spaces or text, so they carry no format of their own.
    static func isSemanticIdentifier(_ key: String) -> Bool {
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count > 1, let first = key.unicodeScalars.first, first.properties.isLowercase, first.isASCII else { return false }
        return parts.allSatisfy { !$0.isEmpty && $0.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "_") } }
    }

    func formatProblems(key: String, english: String, portuguese: String) -> [String] {
        var problems: [String] = []
        if signatures(english) != signatures(portuguese) { problems.append("\(key): en \(signatures(english)) ≠ pt-BR \(signatures(portuguese))") }
        if !Self.isSemanticIdentifier(key), signatures(key) != signatures(english) { problems.append("\(key): key \(signatures(key)) ≠ en \(signatures(english))") }
        return problems
    }

    /// Text left after removing format specifiers contains a letter or digit (placeholders and punctuation do not).
    func isTranslatable(_ key: String) -> Bool {
        format.stringByReplacingMatches(in: key, range: NSRange(key.startIndex..., in: key), withTemplate: "").unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
    }

    func normalized(_ key: String) -> String {
        format.stringByReplacingMatches(in: key, range: NSRange(key.startIndex..., in: key), withTemplate: "%@")
    }

    // MARK: Source scan

    struct Literal { var segments: [String]; var interpolations: [String]; var end: Int }

    func problems(in source: String) -> [String] {
        let units = Array(source.utf16), text = source as NSString
        let comments = Self.commentRanges(units)
        let helpers = Set(bilingualHelper.matches(in: source, range: NSRange(location: 0, length: text.length)).map { text.substring(with: $0.range(at: 1)) })
        var problems: [String] = [], line = 1, counted = 0
        for match in call.matches(in: source, range: NSRange(location: 0, length: text.length)) {
            let start = match.range.location
            let lookback = NSRange(location: max(0, start - 16), length: start - max(0, start - 16))
            if comments.contains(where: { $0.contains(start) }) || text.substring(with: lookback).range(of: #"func\s+$"#, options: .regularExpression) != nil { continue }
            let name = text.substring(with: match.range(at: 2))
            guard let (literals, end) = Self.firstArgumentLiterals(units, match.range.location + match.range.length) else { continue }
            line += units[counted..<start].filter { $0 == 0x0A }.count; counted = start
            if ["text", "format", "t"].contains(name) {
                if literals.count == 1, match.range(at: 1).location == NSNotFound, helpers.contains(name),
                   let comma = Self.skip(units, end, expecting: 0x2C), let english = Self.literal(at: Self.skipSpaces(units, comma), in: units) {
                    let portuguese = literals[0]
                    if [portuguese, english].contains(where: { $0.interpolations.isEmpty && $0.segments.joined().trimmingCharacters(in: .whitespaces).isEmpty }) { problems.append("\(line): empty side of an inline pt/en pair") }
                    if portuguese.interpolations.map(Self.trimmed).sorted() != english.interpolations.map(Self.trimmed).sorted() { problems.append("\(line): inline pt/en pair shows different values: \(portuguese.segments.joined(separator: "…"))") }
                    continue
                }
                for literal in literals {
                    let key = literal.segments.map(Self.decode).joined(separator: "%@")
                    if !literal.interpolations.isEmpty { problems.append("\(line): runtime lookup key is built at runtime and cannot be translated: \(key)") }
                    else if !catalogKeys.contains(key) { problems.append("\(line): runtime lookup key missing from catalog: \(key)") }
                }
            } else {
                for literal in literals {
                    // SwiftUI escapes a literal % only when the key is built from an interpolation.
                    let key = literal.interpolations.isEmpty ? Self.decode(literal.segments.joined())
                        : literal.segments.map { Self.decode($0).replacingOccurrences(of: "%", with: "%%") }.joined(separator: "%@")
                    guard isTranslatable(key) else { continue }
                    if !normalizedKeys.contains(normalized(key)) { problems.append("\(line): visible SwiftUI key missing from catalog: \(key)") }
                    for nested in literal.interpolations.flatMap(Self.plainNestedLiterals) { problems.append("\(line): plain literal inside a localized interpolation is shown untranslated: \(nested)") }
                }
            }
        }
        return problems
    }

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespaces) }

    private static func skipSpaces(_ units: [UInt16], _ index: Int) -> Int {
        var index = index
        while index < units.count, [0x20, 0x09, 0x0A, 0x0D].contains(units[index]) { index += 1 }
        return index
    }

    private static func skip(_ units: [UInt16], _ index: Int, expecting unit: UInt16) -> Int? {
        let index = skipSpaces(units, index)
        return index < units.count && units[index] == unit ? index + 1 : nil
    }

    /// First argument as a literal, or as `condition ? "a" : "b"`; labelled arguments (`verbatim:`, `value:`) are not keys.
    private static func firstArgumentLiterals(_ units: [UInt16], _ index: Int) -> ([Literal], Int)? {
        let start = skipSpaces(units, index)
        if let literal = literal(at: start, in: units) { return ([literal], literal.end) }
        var cursor = start
        while cursor < units.count, isIdentifier(units[cursor]) { cursor += 1 }
        if cursor > start, let colon = skip(units, cursor, expecting: 0x3A), colon >= units.count || units[colon] != 0x3A { return nil }
        cursor = start
        while cursor < units.count, ![0x2C, 0x28, 0x29, 0x22, 0x0A, 0x3F].contains(units[cursor]) { cursor += 1 }
        guard cursor < units.count, units[cursor] == 0x3F, let first = literal(at: skipSpaces(units, cursor + 1), in: units),
              let colon = skip(units, first.end, expecting: 0x3A), let second = literal(at: skipSpaces(units, colon), in: units) else { return nil }
        let after = skipSpaces(units, second.end)
        return after < units.count && [0x2C, 0x29].contains(units[after]) ? ([first, second], second.end) : nil
    }

    private static func isIdentifier(_ unit: UInt16) -> Bool {
        (0x30...0x39).contains(unit) || (0x41...0x5A).contains(unit) || (0x61...0x7A).contains(unit) || unit == 0x5F
    }

    /// Swift string literal at `start` (`"…"`, `"""…"""`, `#"…"#`): text segments and balanced `\( )` interpolations.
    static func literal(at start: Int, in units: [UInt16]) -> Literal? {
        var index = start, hashes = 0
        while index < units.count, units[index] == 0x23 { hashes += 1; index += 1 }
        guard index < units.count, units[index] == 0x22 else { return nil }
        let quotes = index + 2 < units.count && units[index + 1] == 0x22 && units[index + 2] == 0x22 ? 3 : 1
        func closes(_ at: Int) -> Bool {
            guard at + quotes + hashes <= units.count else { return false }
            return (0..<quotes).allSatisfy { units[at + $0] == 0x22 } && (0..<hashes).allSatisfy { units[at + quotes + $0] == 0x23 }
        }
        func escape(_ at: Int) -> Bool {
            units[at] == 0x5C && at + hashes < units.count && (0..<hashes).allSatisfy { units[at + 1 + $0] == 0x23 }
        }
        var cursor = index + quotes, segment: [UInt16] = [], result = Literal(segments: [], interpolations: [], end: 0)
        while cursor < units.count {
            if closes(cursor) {
                result.segments.append(String(decoding: segment, as: UTF16.self)); result.end = cursor + quotes + hashes
                return result
            }
            if escape(cursor), cursor + 1 + hashes < units.count {
                let next = cursor + 1 + hashes
                if units[next] == 0x28 {
                    var depth = 1, inner = next + 1
                    while inner < units.count, depth > 0 {
                        if units[inner] == 0x22 || units[inner] == 0x23, let nested = literal(at: inner, in: units) { inner = nested.end; continue }
                        if units[inner] == 0x28 { depth += 1 } else if units[inner] == 0x29 { depth -= 1 }
                        inner += 1
                    }
                    guard depth == 0 else { return nil }
                    result.segments.append(String(decoding: segment, as: UTF16.self)); segment = []
                    result.interpolations.append(String(decoding: units[(next + 1)..<(inner - 1)], as: UTF16.self))
                    cursor = inner; continue
                }
                if hashes == 0 { segment += [units[cursor], units[next]]; cursor = next + 1; continue }
            }
            if quotes == 1, units[cursor] == 0x0A { return nil }
            segment.append(units[cursor]); cursor += 1
        }
        return nil
    }

    /// Plain string literals with words inside an interpolation; those passed to a localization call are translated.
    private static func plainNestedLiterals(_ expression: String) -> [String] {
        let units = Array(expression.utf16)
        var found: [String] = [], index = 0
        while index < units.count {
            if units[index] == 0x22 || units[index] == 0x23, let nested = literal(at: index, in: units) {
                let before = String(decoding: units[..<index], as: UTF16.self).trimmingCharacters(in: .whitespaces)
                let localized = before.hasSuffix("localized:") || before.range(of: #"DexterLocalization\s*\.\s*(text|format)\($"#, options: .regularExpression) != nil
                let words = nested.segments.joined()
                if !localized, words.range(of: #"\p{L}{2,}"#, options: .regularExpression) != nil { found.append(words) }
                index = nested.end; continue
            }
            index += 1
        }
        return found
    }

    static func commentRanges(_ units: [UInt16]) -> [Range<Int>] {
        var ranges: [Range<Int>] = [], index = 0
        while index < units.count {
            if units[index] == 0x2F, index + 1 < units.count, units[index + 1] == 0x2F {
                let start = index
                while index < units.count, units[index] != 0x0A { index += 1 }
                ranges.append(start..<index); continue
            }
            if units[index] == 0x2F, index + 1 < units.count, units[index + 1] == 0x2A {
                let start = index; var depth = 1; index += 2
                while index < units.count, depth > 0 {
                    if units[index] == 0x2F, index + 1 < units.count, units[index + 1] == 0x2A { depth += 1; index += 2 }
                    else if units[index] == 0x2A, index + 1 < units.count, units[index + 1] == 0x2F { depth -= 1; index += 2 }
                    else { index += 1 }
                }
                ranges.append(start..<index); continue
            }
            if units[index] == 0x22 || units[index] == 0x23, let literal = literal(at: index, in: units) { index = literal.end; continue }
            index += 1
        }
        return ranges
    }

    /// Swift escapes of a non-raw literal segment: \n \t \r \0 \" \' \\ \u{…}.
    static func decode(_ segment: String) -> String {
        let scalars = Array(segment.unicodeScalars)
        var output = "", index = 0
        while index < scalars.count {
            guard scalars[index] == "\\", index + 1 < scalars.count else { output.unicodeScalars.append(scalars[index]); index += 1; continue }
            let next = scalars[index + 1]
            if next == "u", index + 2 < scalars.count, scalars[index + 2] == "{", let close = scalars[(index + 3)...].firstIndex(of: "}"),
               let value = UInt32(String(String.UnicodeScalarView(scalars[(index + 3)..<close])), radix: 16), let scalar = Unicode.Scalar(value) {
                output.unicodeScalars.append(scalar); index = close + 1; continue
            }
            switch next {
            case "n": output += "\n"
            case "t": output += "\t"
            case "r": output += "\r"
            case "0": output += "\0"
            default: output.unicodeScalars.append(next)
            }
            index += 2
        }
        return output
    }

    // MARK: Compiler extraction (.stringsdata)

    struct Extraction { var source: String; var keys: [(key: String, line: Int)] }

    static func stringsdataFiles(in directory: URL) throws -> [URL] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil))
        var files: [URL] = []
        for case let url as URL in enumerator where url.pathExtension == "stringsdata" && url.lastPathComponent != "ExtractedAppShortcutsMetadata.stringsdata" { files.append(url) }
        return files.sorted { $0.path < $1.path }
    }

    static func extraction(fromStringsdata data: Data) throws -> Extraction {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let tables = object["tables"] as? [String: [[String: Any]]] ?? [:]
        let keys = (tables["Localizable"] ?? []).compactMap { entry -> (key: String, line: Int)? in
            guard let key = entry["key"] as? String else { return nil }
            return (key, (entry["location"] as? [String: Any])?["startingLine"] as? Int ?? 0)
        }
        return Extraction(source: object["source"] as? String ?? "", keys: keys)
    }

    /// The app target and the root package (DexterAppCore, DexterHostClient) resolve keys in the app catalog; the
    /// Capabilities and NativeActions packages ship their own Localizable.xcstrings and use bundle: .module.
    static func usesAppCatalog(_ source: String) -> Bool {
        source.contains("/apps/apple/SharedApp/Sources/") || source.contains("/apps/apple/Sources/")
    }

    func missingExtractedKeys(_ extraction: Extraction) -> [String] {
        let file = URL(fileURLWithPath: extraction.source).lastPathComponent
        return extraction.keys.filter { isTranslatable($0.key) && !catalogKeys.contains($0.key) }.map { "\(file):\($0.line): \($0.key)" }
    }
}

// MARK: Portuguese text outside localization paths (r4)

extension LocalizationAudit {
    /// Declared exceptions, each by file and exact name or text, so no whole file is excluded.
    struct Declarations {
        /// Functions or properties whose Portuguese literals are runtime catalog keys, looked up where they render.
        var runtimeKeyProducers: [String: Set<String>] = [:]
        /// Exact Portuguese literals shown or sent verbatim on purpose, with the reason.
        var verbatim: [String: [String: String]] = [:]
        /// Call arguments (`callee:label`, empty label for the first unlabeled one) whose literal is a runtime lookup key.
        var lookupArguments: [String: Set<String>] = [:]
        /// Functions or properties holding the Portuguese half of a pair that a locale check selects where it renders.
        var localeSelectedPairs: [String: Set<String>] = [:]

        var all: Set<String> {
            var names = Set<String>()
            for (file, items) in runtimeKeyProducers { for item in items { names.insert("\(file) producer \(item)") } }
            for (file, items) in verbatim { for item in items.keys { names.insert("\(file) verbatim \(item)") } }
            for (file, items) in lookupArguments { for item in items { names.insert("\(file) lookup \(item)") } }
            for (file, items) in localeSelectedPairs { for item in items { names.insert("\(file) pair \(item)") } }
            return names
        }
    }

    struct PortugueseReport { var problems: [String] = []; var portuguese = 0; var usedDeclarations = Set<String>(); var verdicts: [String] = [] }

    /// Format slots are typed by the compiler (%lld, %u, …); a source literal only knows "a value goes here".
    static func slotless(_ key: String) -> String {
        key.replacingOccurrences(of: #"%(?:\d+\$)?[-+0 #]*\d*(?:\.\d+)?(?:hh|h|ll|l|z|t|j)?[@dDuUxXoOfeEgGcCsSpaA]"#, with: "%@", options: .regularExpression)
            .replacingOccurrences(of: "%%", with: "%")
    }

    static let swiftUIKeyCallees: Set<String> = ["Text", "Label", "Section", "Button", "Picker", "LabeledContent", "ContentUnavailableView",
        "TextField", "SecureField", "ProgressView", "navigationTitle", "accessibilityLabel", "accessibilityHint", "help", "Toggle", "Stepper",
        "GroupBox", "DisclosureGroup", "Menu", "Link", "alert", "confirmationDialog"]

    private static let portugueseWords: Set<String> = ["não", "nao", "uma", "para", "com", "você", "está", "são", "pelo", "pela", "então",
        "ainda", "também", "de", "da", "dos", "das", "na", "nas", "nos", "ou", "ao", "em", "um", "por", "que", "sem", "seu", "sua",
        "este", "esta", "isso", "já", "mais", "deste", "desta", "neste", "nesta"]

    /// Portuguese prose (accented letters or common function words), or a translated catalog key used as it is.
    static func looksPortuguese(_ text: String, translatedKeys: Set<String>) -> Bool {
        if translatedKeys.contains(text) { return true }
        if text.range(of: #"^[A-Za-z0-9_.:/\-]+$"#, options: .regularExpression) != nil { return false }
        if text.contains("(?") || text.contains("\\b") || text.contains("[^") { return false }
        if text.unicodeScalars.contains(where: { "ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔÀ".unicodeScalars.contains($0) }) { return true }
        let words = text.lowercased().split { !$0.isLetter }
        return words.contains { portugueseWords.contains(String($0)) }
    }

    struct Span { var start: Int; var end: Int; var text: String; var root: Int }

    /// Words a reader sees: a phrase, a non-ASCII word or a capitalized word (identifiers and values are lowercase/dotted).
    static func isHumanText(_ text: String) -> Bool {
        let trimmed = text.replacingOccurrences(of: "%@", with: "").trimmingCharacters(in: .whitespaces)
        guard trimmed.range(of: #"\p{L}{2,}"#, options: .regularExpression) != nil else { return false }
        if trimmed.contains(" ") || trimmed.unicodeScalars.contains(where: { !$0.isASCII }) { return true }
        return trimmed.range(of: #"^[A-Z][a-z]+$"#, options: .regularExpression) != nil
    }

    /// Every string literal outside comments, including literals nested in interpolations; `masked` marks literal text
    /// (not interpolation code) so context walks see only code.
    static func spans(_ units: [UInt16]) -> (spans: [Span], masked: [Bool]) {
        var masked = [Bool](repeating: false, count: units.count)
        for range in commentRanges(units) { for index in range { masked[index] = true } }
        var spans: [Span] = []
        func scan(_ range: Range<Int>, root: Int?) {
            var index = range.lowerBound
            while index < range.upperBound {
                if root == nil, masked[index] { index += 1; continue }
                guard units[index] == 0x22 || units[index] == 0x23, let literal = literal(at: index, in: units) else { index += 1; continue }
                var hashes = 0
                while units[index + hashes] == 0x23 { hashes += 1 }
                spans.append(Span(start: index, end: literal.end, text: literal.segments.map { hashes == 0 ? decode($0) : $0 }.joined(separator: "%@"), root: root ?? index))
                for cursor in index..<literal.end { masked[cursor] = true }
                for inner in interpolations(units, from: index + hashes, to: literal.end, hashes: hashes) {
                    for cursor in (inner.lowerBound - 1)...inner.upperBound { masked[cursor] = false }
                    scan(inner, root: root ?? index)
                }
                index = literal.end
            }
        }
        scan(0..<units.count, root: nil)
        return (spans, masked)
    }

    /// Ranges of the code inside each `\( … )` of the literal whose opening quote is at `from`.
    private static func interpolations(_ units: [UInt16], from: Int, to: Int, hashes: Int) -> [Range<Int>] {
        let quotes = from + 2 < units.count && units[from + 1] == 0x22 && units[from + 2] == 0x22 ? 3 : 1
        var ranges: [Range<Int>] = [], cursor = from + quotes
        while cursor < to {
            guard units[cursor] == 0x5C, cursor + 1 + hashes < to, (0..<hashes).allSatisfy({ units[cursor + 1 + $0] == 0x23 }) else { cursor += 1; continue }
            let next = cursor + 1 + hashes
            guard units[next] == 0x28 else { cursor = next + 1; continue }
            var depth = 1, inner = next + 1
            while inner < to, depth > 0 {
                if units[inner] == 0x22 || units[inner] == 0x23, let nested = literal(at: inner, in: units) { inner = nested.end; continue }
                if units[inner] == 0x28 { depth += 1 } else if units[inner] == 0x29 { depth -= 1 }
                inner += 1
            }
            ranges.append((next + 1)..<(inner - 1)); cursor = inner
        }
        return ranges
    }

    func portugueseOutsideLocalization(in source: String, file: String, extracted: [Int: Set<String>], translatedKeys: Set<String>,
                                       declarations: Declarations) -> PortugueseReport {
        let units = Array(source.utf16)
        let (spans, masked) = Self.spans(units)
        var lineStarts = [0]
        for (index, unit) in units.enumerated() where unit == 0x0A { lineStarts.append(index + 1) }
        func line(_ offset: Int) -> Int { var low = 0, high = lineStarts.count - 1; while low < high { let mid = (low + high + 1) / 2; if lineStarts[mid] <= offset { low = mid } else { high = mid - 1 } }; return low + 1 }
        func code(_ range: Range<Int>) -> String { String(decoding: range.map { masked[$0] ? 0x20 : units[$0] }, as: UTF16.self) }
        let pairHelpers = Set(Self.matches(#"func (\w+)\(_ \w+: String, _ \w+: String\)\s*->\s*String"#, in: source))
        var report = PortugueseReport(), verdicts: [Int: Bool] = [:]

        /// Index of the unmatched opener before `offset`, skipping literal text and balanced brackets.
        func opener(before offset: Int) -> Int? {
            var depth = 0, index = offset - 1
            while index >= 0 {
                if !masked[index] {
                    switch units[index] {
                    case 0x29, 0x5D, 0x7D: depth += 1
                    case 0x28, 0x5B, 0x7B: if depth == 0 { return index }; depth -= 1
                    default: break
                    }
                }
                index -= 1
            }
            return nil
        }
        func callee(before open: Int) -> String {
            var end = open
            while end > 0, units[end - 1] == 0x20 { end -= 1 }
            var start = end
            while start > 0, let scalar = Unicode.Scalar(units[start - 1]), CharacterSet.alphanumerics.contains(scalar) || scalar == "_" || scalar == "." { start -= 1 }
            return String(decoding: units[start..<end], as: UTF16.self)
        }
        /// Argument position and label of the argument starting after `open` that contains `offset`.
        func argument(open: Int, offset: Int) -> (index: Int, label: String?) {
            var depth = 0, commas = 0, start = open + 1
            for index in (open + 1)..<offset where !masked[index] {
                switch units[index] {
                case 0x28, 0x5B, 0x7B: depth += 1
                case 0x29, 0x5D, 0x7D: depth -= 1
                case 0x2C where depth == 0: commas += 1; start = index + 1
                default: break
                }
            }
            let head = code(start..<offset)
            let label = Self.matches(#"^\s*(\w+)\s*:(?!:)"#, in: head).first
            return (commas, label)
        }
        /// Whether `offset` sits in a branch of a ternary whose condition is a Portuguese-locale check, possibly through
        /// nested ternaries and grouping parentheses, within the same argument or statement.
        func inPortugueseBranch(_ offset: Int) -> Bool {
            var depth = 0, index = offset - 1
            while index > 0 {
                defer { index -= 1 }
                if masked[index] { continue }
                let unit = units[index]
                if [0x29, 0x5D, 0x7D].contains(unit) { depth += 1; continue }
                if [0x28, 0x5B, 0x7B].contains(unit) {
                    if depth > 0 { depth -= 1; continue }
                    // A grouping parenthesis (after ?, : or another opener) is transparent; a call or a block ends the search.
                    var previous = index - 1
                    while previous > 0, [0x20, 0x0A, 0x09].contains(units[previous]) { previous -= 1 }
                    if unit == 0x28, [0x3F, 0x3A, 0x28].contains(units[previous]) { continue }
                    return false
                }
                guard depth == 0 else { continue }
                if unit == 0x2C || unit == 0x3B { return false }
                if unit == 0x3D, ![0x3D, 0x21, 0x3C, 0x3E].contains(units[index - 1]), units[index + 1] != 0x3D { return false }
                if unit == 0x0A {
                    // A new line starts a new statement unless it continues the expression (?, :, ., +, &&, ||).
                    var next = index + 1
                    while next < offset, units[next] == 0x20 || units[next] == 0x09 { next += 1 }
                    if next < offset, ![0x3F, 0x3A, 0x2E, 0x2B, 0x26, 0x7C, 0x29].contains(units[next]) { return false }
                    continue
                }
                if unit == 0x3F, units[index - 1] != 0x3F, units[index + 1] != 0x3F, units[index + 1] != 0x2E,
                   code(max(0, index - 120)..<index).range(of: #"(\b(pt|portuguese|isPortuguese)|languageCode\?\.identifier\s*==\s*)\s*$"#, options: .regularExpression) != nil {
                    return true
                }
            }
            return false
        }
        /// Name of the innermost enclosing func/var/init/subscript declaration.
        func declaration(around offset: Int) -> String? {
            var cursor = offset
            while let open = opener(before: cursor) {
                if units[open] == 0x7B {
                    let header = code(max(0, open - 240)..<open)
                    if let keyword = Self.lastMatch(#"\b(func|var|init|subscript)\b"#, in: header) {
                        let tail = header[keyword.lowerBound...]
                        var depth = 0, assignment = false
                        for character in tail {
                            if character == "(" { depth += 1 } else if character == ")" { depth -= 1 } else if character == "=" && depth == 0 { assignment = true }
                        }
                        if !tail.contains("{"), !tail.contains("}"), !assignment {
                            let name = Self.matches(#"^(?:func|var|init|subscript)\s*(\w*)"#, in: String(tail)).first ?? ""
                            return name.isEmpty ? "init" : name
                        }
                    }
                }
                cursor = open
            }
            return nil
        }
        /// Number of leading arguments of the call opened at `open` that are exactly one string literal each.
        func literalArguments(open: Int) -> Int {
            var depth = 0, index = open + 1, start = open + 1, count = 0
            func check(_ range: Range<Int>) -> Bool {
                let trimmed = range.drop { [0x20, 0x0A, 0x09].contains(units[$0]) }
                guard let first = trimmed.first, let literal = Self.literal(at: first, in: units) else { return false }
                return String(decoding: units[literal.end..<range.upperBound], as: UTF16.self).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            while index < units.count {
                if !masked[index] {
                    switch units[index] {
                    case 0x28, 0x5B, 0x7B: depth += 1
                    case 0x29, 0x5D, 0x7D:
                        if depth == 0 { return check(start..<index) ? count + 1 : count }
                        depth -= 1
                    case 0x2C where depth == 0:
                        guard check(start..<index) else { return count }
                        count += 1; start = index + 1
                    default: break
                    }
                }
                index += 1
            }
            return count
        }
        func isLocalized(_ span: Span) -> (String?, String?) {
            if extracted[line(span.start)]?.contains(Self.slotless(span.text)) == true { return ("compiler-extracted", nil) }
            if let open = opener(before: span.start), units[open] == 0x28 {
                let argument = argument(open: open, offset: span.start)
                let name = callee(before: open), last = name.split(separator: ".").last.map(String.init) ?? ""
                if pairHelpers.contains(last), name == last, argument.index <= 1, literalArguments(open: open) >= 2 { return ("locale-pair \(last)()", nil) }
                if argument.index == 0, argument.label == nil, name.hasSuffix("DexterLocalization.text") || name.hasSuffix("DexterLocalization.format")
                    || ["text", "t", "format"].contains(last) || name == "LocalizedStringKey" {
                    return ("runtime-lookup \(last)()", catalogKeys.contains(span.text) ? nil : "runtime lookup key missing from catalog")
                }
                if argument.index == 0, argument.label == nil, Self.swiftUIKeyCallees.contains(last), literalArguments(open: open) >= 1 {
                    return ("swiftui-key \(last)()", normalizedKeys.contains(normalized(span.text)) ? nil : "visible SwiftUI key missing from catalog")
                }
                if declarations.lookupArguments[file]?.contains("\(last):\(argument.label ?? "")") == true {
                    report.usedDeclarations.insert("\(file) lookup \(last):\(argument.label ?? "")")
                    return ("declared-lookup-argument \(last):\(argument.label ?? "")", catalogKeys.contains(span.text) ? nil : "runtime lookup key missing from catalog")
                }
            }
            if inPortugueseBranch(span.start) { return ("locale-branch", nil) }
            return (nil, nil)
        }

        let starts = Dictionary(spans.map { ($0.start, $0) }, uniquingKeysWith: { first, _ in first })
        for span in spans {
            // Any word nested in an interpolation of a compiler-localized literal is shown as is, whatever its language.
            if span.root != span.start, let root = starts[span.root], extracted[line(root.start)]?.contains(Self.slotless(root.text)) == true,
               Self.isHumanText(span.text), isLocalized(span).0 == nil, declarations.verbatim[file]?[span.text] == nil {
                report.problems.append("\(line(span.start)): plain literal inside a localized interpolation is shown untranslated: \(span.text)")
                continue
            }
            guard Self.looksPortuguese(span.text, translatedKeys: translatedKeys) else { continue }
            report.portuguese += 1
            let result = isLocalized(span)
            var verdict = result.0
            let problem = result.1
            if verdict == nil, span.root != span.start, verdicts[span.root] == true,
               spans.first(where: { $0.start == span.root }).map({ extracted[line($0.start)]?.contains(Self.slotless($0.text)) != true }) == true { verdict = "nested-in-locale-pair" }
            verdicts[span.start] = verdict != nil
            func record(_ value: String) { report.verdicts.append("\(line(span.start))\t\(value)\t\(span.text.replacingOccurrences(of: "\n", with: "\\n"))") }
            if let verdict {
                if let problem { report.problems.append("\(line(span.start)): \(problem): \(span.text)"); record("PROBLEM \(problem)") } else { record(verdict) }
                continue
            }
            let name = declaration(around: span.start)
            if let name, declarations.runtimeKeyProducers[file]?.contains(name) == true {
                report.usedDeclarations.insert("\(file) producer \(name)")
                if !catalogKeys.contains(span.text) { report.problems.append("\(line(span.start)): declared runtime key missing from catalog: \(span.text)"); record("PROBLEM producer key missing") }
                else { record("declared-runtime-key \(name)") }
                continue
            }
            if let name, declarations.localeSelectedPairs[file]?.contains(name) == true { report.usedDeclarations.insert("\(file) pair \(name)"); record("declared-locale-pair \(name)"); continue }
            if let reason = declarations.verbatim[file]?[span.text] { report.usedDeclarations.insert("\(file) verbatim \(span.text)"); record("declared-verbatim \(reason)"); continue }
            record("PROBLEM no localization path")
            report.problems.append("\(line(span.start)): Portuguese text is shown without a localization path (in \(name ?? "top level")): \(span.text)")
        }
        return report
    }

    private static func lastMatch(_ pattern: String, in text: String) -> Range<String.Index>? {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return nil }
        return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).last.flatMap { Range($0.range, in: text) }
    }

    private static func matches(_ pattern: String, in text: String) -> [String] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            let range = match.numberOfRanges > 1 && match.range(at: match.numberOfRanges - 1).location != NSNotFound ? match.range(at: match.numberOfRanges - 1) : match.range
            return Range(range, in: text).map { String(text[$0]) }
        }
    }
}

extension LocalizationAudit.Declarations {
    /// Classified exceptions of the r4 audit (String-valued localization). Each entry names one function or one exact text.
    static let current = LocalizationAudit.Declarations(
        // Runtime keys: every literal must be a catalog key; each render site passes the value to DexterLocalization/t()/LocalizedStringKey.
        runtimeKeyProducers: [
            "ManagedConnectAppsEditor.swift": ["authorizationKey", "persistenceKey", "statusKey"],   // ManagedConnectAppsViews DexterLocalization.text
            "ManagedConnectAppsViews.swift": ["availabilityKey", "noticeKey"],                      // same file, DexterLocalization.text
            "OutputFilesSession.swift": ["availabilityKey", "locationKindKey", "noticeKey"],       // OutputFilesViews DexterLocalization.text
            "OwnerPairingClaimsSession.swift": ["kindKey", "noticeKey", "outcomeKey", "reasonKey", "statusKey"], // OwnerPairingClaimsViews t()
            "OwnerPairingOfferSession.swift": ["invitationUnavailableKey", "noticeKey", "offerStateKey", "reasonKey"], // OwnerPairingOfferViews t()
            "PairingScopes.swift": ["labelKey"],                                                    // ConnectOtherBaseSheet/OwnerPairing views t()
            "PairedHostOnboarding.swift": ["label", "claim", "restoreOrCheckApproval"],             // SettingsView/ConnectOtherBaseSheet DexterLocalization.text
            "NativeActionRouter.swift": ["label"],                                                  // DexterRootView DexterLocalization.text
            "NativeActionComposer.swift": ["completeSubmission", "invalidateHostScope", "offer", "submission"], // ChatView notice lookup
            "McpRegistrationLifecyclePresentation.swift": ["deferredStatus", "notice"],             // McpConnectionsView DexterLocalization.text
            "McpConnectionsView.swift": ["headline", "detail"],                                     // same file, DexterLocalization.text
            "LocalMacAgentProcess.swift": ["reportUnconfirmedShutdown"],                            // MacAgentSettingsView LocalizedStringKey(shutdownNotice)
            "MemoryLearning.swift": ["summary"],                                                    // MemoryLearningView DexterLocalization.text (read-only file)
            "MemoryLearningEditor.swift": ["friendly", "invalidate", "reconcileGETONLY"],           // MemoryLearningView DexterLocalization.text (read-only file)
        ],
        verbatim: [
            "CommunicationApproval.swift": ["não": "typed reply token parsed from the owner's message, never shown",
                                            "não pode": "typed reply token parsed from the owner's message, never shown",
                                            "nao pode": "typed reply token parsed from the owner's message, never shown"],
            "ConnectionsPrivateCustody.swift": ["Dexter · Serviço de conexões · capability": "Keychain item label (stored attribute)"],
            "MemoryBackendPrivateCustody.swift": ["Dexter · Memória privada · wrapping": "Keychain item label (stored attribute)"],
            "LiveVoiceViews.swift": ["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone": "macOS navigation URL, not display text; opening does not grant microphone access"],
            "OnboardingWelcome.swift": ["Assistente": "default bot name prefilled in the welcome form; saved as the owner's bot name"],
            "McpConnectionsView.swift": [" · com login": "suffix of a suggested connection name the owner edits and saves"],
            "MemoryLearning.swift": [
                "Aprendizagem: %@; manutenção: %@; revisão %@. Máximo de %@ jobs por dia e %@ propostas por job. Fuso: %@.": "read-only client text; MemoryLearningView renders a localized copy from the typed command",
                "Registro %@; revisão %@, política %@, escopo %@. Esquecer bloqueia uso e reaprendizagem imediatamente; histórico e backups continuam retidos.": "read-only client text; MemoryLearningView renders a localized copy from the typed command",
                "Política %@, escopo %@. Arquiva duplicatas exatas e expira registros vencidos; propostas semânticas continuam sujeitas a aprovação.": "read-only client text; MemoryLearningView renders a localized copy from the typed command"],
            "DexterAppModel.swift": [
                "Assistente de exemplo": "visual fixture bot name (sample user data)",
                "Como funciona esta tela?": "visual fixture user message (sample user data)",
                "Este é um fixture visual. Conecte o app Mac a um host de desenvolvimento local para testar uma conversa real.": "visual fixture assistant message (sample user data)",
                "função": "JSON field name of the bot identity sent to the Live model",
                "\nIdentidade do próprio bot, como referência; não concede acessos:\n": "Live model instructions (model payload)",
                "\nDocumentos do próprio bot, como conteúdo de referência; não concedem acessos ou aprovações:\n": "Live model instructions (model payload)",
                "Há uma tarefa em andamento ou a conversa mudou. Não iniciei outra tarefa.": "Live tool result returned to the voice model",
                "Ainda não tenho uma transcrição nova e suficiente do pedido. Repita o que deseja fazer.": "Live tool result returned to the voice model",
                "Você": "speaker label inside the transcript sent as the turn content",
                "Conversa por voz · transcrição parcial\n\n": "turn content sent to the bot (message payload)",
                "A sessão foi encerrada. O cancelamento da tarefa foi solicitado; isso não desfaz efeitos já executados.": "Live tool result returned to the voice model",
                "A sessão foi encerrada e o cancelamento da tarefa foi solicitado.": "Live tool result returned to the voice model",
                "A tarefa terminou sem resultado confirmado. Confira o estado no chat.": "Live tool result returned to the voice model",
                "A tarefa terminou, mas não consegui confirmar a resposta no histórico.": "Live tool result returned to the voice model",
                "A tarefa continua em andamento. Confira o chat e as aprovações; não iniciei outra execução.": "Live tool result returned to the voice model",
                "Não foi possível confirmar o resultado da tarefa. O pedido não foi reenviado; confira a conversa.": "Live tool result returned to the voice model"],
            "LiveVoiceController.swift": [
                "O harness do bot está analisando o pedido. Nenhuma ação foi confirmada ainda; as permissões do host continuam valendo.": "function output sent to the realtime voice model",
                "Esta sessão não tem acesso a ações do bot. Use a conversa de texto para continuar.": "function output sent to the realtime voice model",
                "A ação não terminou em dois minutos. Confira seu estado na conversa de texto; não repita sem conferir.": "function output sent to the realtime voice model",
                "Confira o resultado na conversa de texto.": "function output sent to the realtime voice model",
                "… Resumo parcial; confira o resultado completo na conversa de texto.": "function output sent to the realtime voice model"],
        ],
        lookupArguments: [
            "ConnectOtherBaseSheet.swift": ["catalogText:fallback"],   // catalogText looks the fallback up with DexterLocalization.text
            "SettingsView.swift": ["localized:"],                       // localized(_:_:) looks its first argument up
        ],
        localeSelectedPairs: [
            "SettingsView.swift": ["portugueseTitle", "portugueseSubtitle"],   // tabText(portuguese…, english…) selects by locale
            "ApprovalModeMenu.swift": ["scopeCopy"],                           // `if languageCode == "pt"` branch beside the English return
        ])
}
