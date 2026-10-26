import DexterHostClient
import Foundation

/// A user-facing outcome derived from the receipt, not a replacement for its canonical state.
public enum ApprovalOutcome: Equatable, Sendable {
    case awaitingApproval
    case ready
    case running
    case completed
    case userDenied
    case hostDenied
    case expired
    case blocked
    case executionError
    case commandFailed(exitCode: Int64)
    case commandInterrupted
    case commandTimedOut
    case commandNotStarted
    case outputLimited
    /// The receipt says the call completed (transport `succeeded`), but the tool itself answered `isError: true`: an
    /// error reported by the tool. Its effect at the service may be partial or unknown; never shown as success.
    case toolReportedError
    case cancelled
    case unknown

    public var stateLabel: String {
        switch self {
        case .awaitingApproval: String(localized: "Aprovação necessária")
        case .ready: String(localized: "Aguardando execução")
        case .running: String(localized: "Em execução")
        case .completed: String(localized: "Concluída")
        case .userDenied, .hostDenied: String(localized: "Negada")
        case .expired: String(localized: "Expirada")
        case .blocked: String(localized: "Bloqueada")
        case .executionError: String(localized: "Erro na execução")
        case .commandFailed: String(localized: "Comando terminou com erro")
        case .commandInterrupted: String(localized: "Comando interrompido")
        case .commandTimedOut: String(localized: "Tempo limite atingido")
        case .commandNotStarted: String(localized: "Comando não iniciado")
        case .outputLimited: String(localized: "Saída limitada")
        case .toolReportedError: String(localized: "Ferramenta informou erro")
        case .cancelled: String(localized: "Interrompida")
        case .unknown: String(localized: "Resultado não confirmado")
        }
    }

    public var statusSymbol: String {
        switch self {
        case .awaitingApproval: "hand.raised"
        case .ready: "hourglass"
        case .running: "gearshape.2"
        case .completed: "checkmark.circle"
        case .userDenied, .hostDenied: "xmark.circle"
        case .expired: "clock.badge.exclamationmark"
        case .executionError, .commandFailed, .commandInterrupted, .commandTimedOut, .commandNotStarted, .outputLimited, .toolReportedError: "exclamationmark.circle"
        case .cancelled: "stop.circle"
        case .blocked, .unknown: "exclamationmark.triangle"
        }
    }
}

/// A snapshot of exactly what the host persisted. Display formatting is never decision authority.
public struct ApprovalPresentation: Equatable, Sendable {
    public let action: Action

    public init(action: Action) { self.action = action }

    public var id: String { action.id }
    public var tool: String { action.request.tool }
    public var destination: String { action.request.destination }
    public var arguments: [String: JSONValue] { action.request.arguments }
    public var requestHash: String { action.requestHash }
    public var grantRevision: Int { action.grantRevision }
    public var expiresAtMilliseconds: Int64? { action.approvalExpiresAt }
    public var state: ActionState { action.state }

    private var operation: String {
        tool.hasPrefix("dexter.harness.") ? String(tool.dropFirst("dexter.harness.".count)) : tool
    }

    /// The readable proposal is derived from persisted input, never model-authored prose.
    public var title: String {
        switch operation {
        case "terminal.run": String(localized: "Executar comando")
        case "cli.run": String(localized: "Executar ferramenta")
        case "files.write": String(localized: "Salvar arquivo")
        case "files.list": String(localized: "Listar arquivos")
        case "files.tree": String(localized: "Ver árvore de arquivos")
        case "files.read": String(localized: "Ler arquivo")
        case "files.search": String(localized: "Buscar nos arquivos")
        case "bots.create": String(localized: "Criar bot")
        case "bots.update": String(localized: "Atualizar bot")
        case "bots.communication.update": String(localized: "Alterar comunicação do bot")
        case "documents.update": String(localized: "Atualizar documentos do bot")
        case "skills.register": String(localized: "Adicionar skill")
        case "skills.activate": String(localized: "Alterar skill ativa")
        case "mcp.select": String(localized: "Selecionar ferramentas")
        case "mcp.add": String(localized: "Adicionar conexão MCP")
        case "mcp.add_http": String(localized: "Cadastrar endereço MCP")
        case "mcp.discover": String(localized: "Descobrir ferramentas MCP")
        case "mcp.authorize": String(localized: "Autorizar conexão MCP")
        case "mac.setup.request": String(localized: "Configurar acesso ao Mac")
        case "dexter.browseruse.run": String(localized: "Executar tarefa no navegador")
        case "dexter.automations.run": String(localized: "Rodar automação")
        default: mcpServerID == nil ? String(localized: "Usar ferramenta") : String(localized: "Usar ferramenta de uma conexão")
        }
    }

    /// Instance ID taken from the persisted tool name `mcp.<serverId>.<tool>`; a display key, never authority.
    /// Callers must match it exactly against the host's registered connections before showing a name.
    public var mcpServerID: String? {
        guard tool.hasPrefix("mcp.") else { return nil }
        let rest = tool.dropFirst(4)
        guard let dot = rest.firstIndex(of: ".") else { return nil }
        let id = String(rest[..<dot])
        guard id.range(of: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil,
              rest.index(after: dot) < rest.endIndex else { return nil }
        return id
    }

    public var mcpToolName: String? {
        guard let id = mcpServerID else { return nil }
        return String(tool.dropFirst(4 + id.count + 1))
    }

    /// How the host authorized an action that already left the approval queue (durable evidence, not a new decision).
    public var authorizationSummary: String? {
        switch action.authorization?.source {
        case .exactOwner: String(localized: "Aprovada por você")
        case .ownerPolicy: String(localized: "Executada sem perguntar · regra deste bot")
        case .threadPolicy: String(localized: "Executada sem perguntar · regra desta conversa")
        case .ownerType: String(localized: "Aprovada pelo tipo que você salvou")
        case .boundedGrant: String(localized: "Coberta por uma permissão limitada já concedida")
        case nil: nil
        }
    }

    /// Set only when the host recorded that "approve all" could not apply because this access is not turned on.
    public var accessNotEnabled: Bool { action.approvalRequirement?.reason == "access_not_enabled" }

    /// The execution access that would cover this action, from the closed D03 operation list.
    public var executionOperation: BotExecutionOperation? {
        switch tool {
        case "dexter.harness.terminal.run": .terminal
        case "dexter.harness.cli.run": .cli
        case "dexter.harness.files.write": .filesWrite
        case "dexter.automations.run": .automation
        default: nil
        }
    }

    /// Attested only by a closed tool identity with its fixed destination: terminal/CLI/files/configuration proposals
    /// on `dexter-harness-owner-proposals` and automations on `dexter-automations`. Any other destination, a device ID
    /// or an MCP namespace is never mapped to a place, and the base is never assumed to be this Mac.
    public var executionPlace: ApprovalExecutionPlace? {
        if tool == "dexter.automations.run" { return destination == "dexter-automations" ? .baseAutomation : nil }
        guard tool.hasPrefix("dexter.harness."), destination == "dexter-harness-owner-proposals" else { return nil }
        switch operation {
        // Navigation to the owner's own panel: nothing runs or changes on the base.
        case "mac.setup.request": return nil
        case "terminal.run", "cli.run": return .baseTerminal
        case let name where name.hasPrefix("files."): return .baseBotFiles
        default: return .baseConfiguration
        }
    }

    /// One line naming what the action touches, copied from the persisted input: the command's first line, the CLI
    /// tool, a file name, a connection being registered or the MCP tool. Display only; the exact input stays in
    /// Ver ação completa and Detalhes técnicos.
    public var shortTarget: String? {
        let input = operationalInput
        switch operation {
        case "terminal.run": return Self.headline(input["command"])
        case "cli.run": return Self.headline(input["tool"])
        case let name where name.hasPrefix("files."):
            guard case .string(let path)? = input["path"] else { return nil }
            let file = (path as NSString).lastPathComponent
            return Self.headline(.string(file == "." || file == "/" ? "" : file))
        case "mcp.add", "mcp.add_http":
            return Self.mcpRegistrationFields(input["definitionJson"])?.first { $0.id == "/name" }?.value
        case "mcp.authorize": return Self.headline(input["serverId"])
        case "mac.setup.request": return String(localized: "Controle de tela")
        default: return mcpToolName.flatMap { Self.headline(.string($0)) }
        }
    }

    private var operationalInput: [String: JSONValue] {
        if case .object(let wrapped) = arguments["input"] { return wrapped }
        return arguments
    }

    private static func headline(_ value: JSONValue?) -> String? {
        guard case .string(let text)? = value else { return nil }
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let first = lines.first else { return nil }
        return lines.count > 1 ? first + " …" : first
    }

    /// Category label kept for compatibility; the card shows `executionPlace`, which never claims this Mac.
    public var destinationLabel: String {
        if mcpServerID != nil { return String(localized: "Conexão MCP") }
        guard destination == "dexter-harness-owner-proposals" else { return destination }
        switch operation {
        case "terminal.run", "cli.run": return String(localized: "Neste Mac · terminal")
        case let name where name.hasPrefix("files."): return String(localized: "Arquivos deste bot")
        default: return String(localized: "Configuração do Dexter")
        }
    }

    public var isPendingDecision: Bool { state == .awaitingApproval }
    public var isHistorical: Bool { ![.awaitingApproval, .ready, .running].contains(state) }

    /// Expiry changes presentation only. The persisted action and host's decision gate remain untouched.
    public func isHistorical(atMilliseconds now: Int64) -> Bool {
        isHistorical || state == .awaitingApproval && isExpired(atMilliseconds: now)
    }

    public func needsDecision(atMilliseconds now: Int64) -> Bool {
        isPendingDecision && !isExpired(atMilliseconds: now)
    }

    /// A clock only expires an undecided proposal; it never invents an execution result.
    public func outcome(atMilliseconds now: Int64) -> ApprovalOutcome {
        if state == .awaitingApproval && isExpired(atMilliseconds: now) { return .expired }
        return persistedOutcome
    }

    private var persistedOutcome: ApprovalOutcome {
        switch state {
        case .awaitingApproval: return .awaitingApproval
        case .ready: return .ready
        case .running: return .running
        case .succeeded:
            if isCommand { return commandOutcome }
            // Top-level MCP `isError` is the tool's own error report; the receipt status stays the transport's.
            return toolReportedError ? .toolReportedError : .completed
        case .denied:
            if resultObject?["code"] == .string("cancelled") { return .cancelled }
            switch action.reason {
            case .approvalExpired: return .expired
            case .userDenied: return .userDenied
            default: return .hostDenied
            }
        case .blocked:
            if action.reason == .approvalExpired { return .expired }
            if action.reason == .executorError {
                // Keep typed command termination visible if the host reports it as executor_error.
                if isCommand, case .object = action.result, commandOutcome != .completed {
                    return commandOutcome
                }
                return .executionError
            }
            return .blocked
        case .unknown: return .unknown
        }
    }

    public func stateLabel(atMilliseconds now: Int64) -> String { outcome(atMilliseconds: now).stateLabel }
    public func statusSymbol(atMilliseconds now: Int64) -> String { outcome(atMilliseconds: now).statusSymbol }

    public var scopeExplanation: String? {
        switch operation {
        case "terminal.run", "cli.run":
            String(localized: "Usa as permissões do usuário do sistema da base. A pasta de trabalho não limita o acesso ao sistema.")
        case "files.write":
            String(localized: "Salva somente no espaço de arquivos deste bot. A substituição exige a versão aprovada do arquivo.")
        case "mcp.authorize":
            String(localized: "Abre a página de login; você conclui o acesso no serviço. Não libera ferramentas.")
        case "mac.setup.request":
            String(localized: "Abre o painel Controle de tela; ainda não concede controle, permissões do macOS nem sessão.")
        default: nil
        }
    }

    public var resultExplanation: String { explanation(for: persistedOutcome) }

    public func resultExplanation(atMilliseconds now: Int64) -> String { explanation(for: outcome(atMilliseconds: now)) }

    private func explanation(for outcome: ApprovalOutcome) -> String {
        if operation == "mcp.authorize", outcome == .completed, action.mcpAuthorizationHandoff != nil {
            return String(localized: "Pedido de autorização preparado. O login é concluído no navegador; ferramentas continuam sem liberação automática.")
        }
        if operation == "mac.setup.request", outcome == .completed, action.macSetupHandoff != nil {
            return String(localized: "Pedido aprovado; nada foi concedido. O painel fica em Ajustes › Este Mac › Controle de tela por bot.")
        }
        let explanation: String = switch outcome {
        case .awaitingApproval: String(localized: "A ação ainda não foi autorizada.")
        case .ready: String(localized: "Autorizada. Aguardando execução; ainda não há resultado.")
        case .running: String(localized: "Autorizada. Executando agora.")
        case .completed: String(localized: "Execução concluída.")
        case .userDenied: String(localized: "Você negou esta ação.")
        case .hostDenied: String(localized: "Esta ação foi negada pelo host. Consulte os detalhes.")
        case .expired: String(localized: "A proposta expirou sem autorização. Peça uma nova proposta.")
        case .blocked:
            if resultObject?["code"] == .string("destination_unavailable") {
                String(localized: "O destino está indisponível. O host informou que a ação não foi executada.")
            } else { switch action.reason {
            case .permissionChanged: String(localized: "As permissões mudaram. Peça uma nova proposta.")
            default: String(localized: "A execução foi bloqueada. Consulte os detalhes antes de tentar novamente.")
            } }
        case .executionError: String(localized: "A execução falhou. Confira o resultado antes de tentar novamente.")
        case .commandFailed(let code): String(localized: "O comando terminou com código \(code). Confira o resultado antes de tentar novamente.")
        case .commandInterrupted:
            String(localized: "O comando foi encerrado sem conclusão normal; o efeito pode ser parcial. Confira o resultado antes de tentar novamente. Não há nova tentativa automática.")
        case .commandTimedOut:
            String(localized: "O tempo limite foi atingido e o comando foi encerrado antes de terminar; o efeito pode ser parcial. Confira o resultado antes de tentar novamente. Não há nova tentativa automática.")
        case .commandNotStarted: String(localized: "O host informou que o comando não foi iniciado. Consulte o diagnóstico; nenhuma nova tentativa é automática.")
        case .outputLimited: String(localized: "O host limitou a saída disponível. Consulte os detalhes; a saída completa não está neste resultado. Não há nova tentativa automática.")
        case .toolReportedError:
            String(localized: "A ferramenta respondeu com erro. A chamada chegou ao serviço e o efeito pode ter sido parcial; o Dexter não confirma o que mudou lá. Confira o resultado antes de tentar novamente. Não há nova tentativa automática.")
        case .cancelled: String(localized: "O host interrompeu esta ação ao cancelar o turno. Isso não equivale a uma negação individual e não desfaz efeitos já realizados.")
        case .unknown:
            // One key per sentence; the optional sentences are joined with a space, as before.
            ([String(localized: "O resultado não foi confirmado.")]
                + (effectMayBePartial ? [String(localized: "O efeito pode ser parcial.")] : [])
                + (resultObject?["termination"] == .string("timeout") ? [String(localized: "O tempo limite foi atingido.")] : [])
                + [String(localized: "Consulte os detalhes antes de tentar novamente. Não há nova tentativa automática.")]).joined(separator: " ")
        }
        if isCommand && stderrWasDiscarded {
            switch outcome {
            case .completed, .executionError, .commandFailed, .commandInterrupted, .commandTimedOut, .commandNotStarted, .outputLimited, .unknown:
                return explanation + " " + String(localized: "O host descartou avisos e erros; eles não estão disponíveis neste resultado.")
            default: break
            }
        }
        return explanation
    }

    private var isCommand: Bool { ["terminal.run", "cli.run"].contains(operation) }
    /// Exactly `isError: true` at the top of the receipt result (the MCP tool result envelope); nothing else infers it.
    public var toolReportedError: Bool { resultObject?["isError"] == .bool(true) }

    private var resultObject: [String: JSONValue]? {
        if case .object(let object) = action.result { return object }; return nil
    }
    private var effectMayBePartial: Bool {
        guard case .object(let diagnostic) = resultObject?["diagnostic"] else { return false }
        return diagnostic["effectMayBePartial"] == .bool(true)
    }

    private var stderrWasDiscarded: Bool {
        guard case .object(let result) = action.result else { return false }
        return result["stderrDiscarded"] == .bool(true)
    }

    private var commandOutcome: ApprovalOutcome {
        guard case .object(let result) = action.result else { return .commandInterrupted }
        if result["commandOutcome"] == .string("not_started") || result["termination"] == .string("spawn_failed") { return .commandNotStarted }
        if result["termination"] == .string("timeout") { return .commandTimedOut }
        if result["termination"] == .string("stdout_limit"), result["signal"] == .null,
           case .integer = result["exitCode"] { return .outputLimited }
        // The live host emits "completed"; "exited" is also an explicit normal termination.
        guard let termination = result["termination"], [.string("completed"), .string("exited")].contains(termination),
              result["signal"] == nil || result["signal"] == .null,
              case .integer(let code) = result["exitCode"] ?? result["exit_code"] else { return .commandInterrupted }
        return code == 0 ? .completed : .commandFailed(exitCode: code)
    }

    /// Complete operational input is available on demand; envelope/pins remain in technical inspection.
    public var readableFields: [ApprovalReadableField] {
        let input: [String: JSONValue]
        if case .object(let wrapped) = arguments["input"] {
            input = wrapped
        } else { input = arguments }
        var readable = Self.withoutTechnicalMetadata(input)
        if operation == "files.write" {
            readable["operation"] = .string(input["expected_sha256"] == nil ? String(localized: "Criar arquivo novo") : String(localized: "Substituir arquivo existente"))
        }
        if ["mcp.add", "mcp.add_http"].contains(operation), let registration = Self.mcpRegistrationFields(input["definitionJson"]) {
            // The exact JSON stays in Detalhes técnicos; the readable view shows the reviewed fields.
            return registration
        }
        return Self.fields(.object(readable), path: "", label: "")
    }

    private static func mcpRegistrationFields(_ value: JSONValue?) -> [ApprovalReadableField]? {
        guard case .string(let text)? = value, text.utf8.count <= 65_536,
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
              case .object(let definition) = decoded,
              case .string(let id)? = definition["id"], case .string(let name)? = definition["name"],
              case .object(let transport)? = definition["transport"] else { return nil }
        var fields: [ApprovalReadableField] = [.init(id: "/name", label: String(localized: "Nome"), value: name)]
        if case .string(let url)? = transport["url"] { fields.append(.init(id: "/url", label: String(localized: "Endereço MCP"), value: url)) }
        else if case .string(let command)? = transport["command"] { fields.append(.init(id: "/command", label: String(localized: "Programa local"), value: command)) }
        if case .string(let auth)? = definition["auth"] {
            let label = switch auth {
            case "none": String(localized: "Nenhuma (serviço aberto)")
            case "broker": String(localized: "Token de acesso guardado no 1Password")
            case "oauth": String(localized: "Entrar com a conta do serviço (OAuth)")
            default: auth
            }
            fields.append(.init(id: "/auth", label: String(localized: "Login"), value: label))
        }
        fields.append(.init(id: "/server_id", label: String(localized: "ID da conexão"), value: id))
        return fields
    }

    /// A small preview, never used to construct or authorize a request.
    /// Full commands/content/arguments remain in the action disclosure when the preview is clipped.
    public var summaryFields: [ApprovalReadableField] {
        let preferred = ["/command", "/tool", "/executable", "/path", "/operation", "/name", "/url", "/task", "/server_id", "/skill_id", "/scope", "/cwd"]
        // The only input is the opaque configuration revision; the card names what opens instead of the raw tool.
        if operation == "mac.setup.request" {
            return [.init(id: "/target", label: String(localized: "Abre"), value: String(localized: "Painel Controle de tela"))]
        }
        let fields = readableFields
        // A connection registration is reviewed by its four fields together: the login type decides what the
        // service may receive, so it is never left behind "Ver ação completa".
        if ["mcp.add", "mcp.add_http"].contains(operation), fields.contains(where: { $0.id == "/server_id" }),
           fields.allSatisfy({ ["/name", "/url", "/command", "/auth", "/server_id"].contains($0.id) }) { return fields }
        let selected = preferred.compactMap { id in fields.first { $0.id == id } }
        if !selected.isEmpty { return Array(selected.prefix(2)) }
        // MCP calls are named by the card's connection line (registry match), not by the raw tool string.
        if mcpServerID != nil { return [] }
        // Unknown tools must not expose arbitrary raw argument trees by default.
        return [.init(id: "tool-name", label: String(localized: "Ferramenta"), value: tool.replacingOccurrences(of: ".", with: " · ").replacingOccurrences(of: "_", with: " "))]
    }

    private static func withoutTechnicalMetadata(_ input: [String: JSONValue]) -> [String: JSONValue] {
        let hidden: Set<String> = ["pin", "origin", "requestHash", "request_hash", "manifestHash", "manifest_hash",
            "schema", "inputSchema", "expected_sha256", "expectedRevision", "expected_revision", "expected_version"]
        func clean(_ value: JSONValue) -> JSONValue {
            switch value {
            case .object(let object): return .object(withoutTechnicalMetadata(object))
            case .array(let items): return .array(items.map(clean))
            default: return value
            }
        }
        return input.filter { !hidden.contains($0.key) }.mapValues(clean)
    }

    public var readableResultFields: [ApprovalReadableField] {
        action.result.map { Self.fields($0, path: "result", label: String(localized: "Resultado"), translatesResultValues: true) } ?? []
    }

    private static func fields(_ value: JSONValue, path: String, label: String,
                               translatesResultValues: Bool = false) -> [ApprovalReadableField] {
        switch value {
        case .object(let values):
            if values.isEmpty { return path.isEmpty ? [] : [.init(id: path, label: label, value: String(localized: "Sem campos"))] }
            return values.keys.sorted().flatMap { key in
                fields(values[key]!, path: path + "/" + key,
                       label: label.isEmpty ? fieldLabel(key) : label + " · " + fieldLabel(key),
                       translatesResultValues: translatesResultValues)
            }
        case .array(let values):
            if values.isEmpty { return [.init(id: path, label: label, value: String(localized: "Lista vazia"))] }
            return values.enumerated().flatMap { index, item in
                fields(item, path: path + "/" + String(index), label: label + " · " + String(index + 1),
                       translatesResultValues: translatesResultValues)
            }
        case .string(let text):
            let displayed = translatesResultValues ? resultValue(text, key: path.split(separator: "/").last.map(String.init) ?? "") : text
            return [.init(id: path, label: label, value: displayed.isEmpty ? String(localized: "Texto vazio") : displayed)]
        case .bool(let flag): return [.init(id: path, label: label, value: flag ? String(localized: "Sim") : String(localized: "Não"))]
        case .null: return [.init(id: path, label: label, value: String(localized: "Sem valor"))]
        case .integer(let number): return [.init(id: path, label: label, value: String(number))]
        case .number(let number): return [.init(id: path, label: label, value: String(number))]
        }
    }

    private static func resultValue(_ text: String, key: String) -> String {
        if key == "kind" {
            switch text {
            case "action_execution_uncertain": return String(localized: "Execução sem resultado confirmado")
            case "action_not_executed": return String(localized: "Ação não executada")
            case "mac_setup_handoff": return String(localized: "Painel Controle de tela")
            default: return text
            }
        }
        if key == "commandOutcome" {
            switch text {
            case "completed": return String(localized: "Conclusão normal")
            case "failed": return String(localized: "Terminou com erro")
            case "interrupted": return String(localized: "Interrompido; conclusão não confirmada")
            case "not_started": return String(localized: "Não iniciado")
            default: return text
            }
        }
        if key == "code" {
            switch text {
            case "command_interrupted": return String(localized: "Comando interrompido")
            case "command_exit_nonzero": return String(localized: "Código de saída indica erro")
            case "command_spawn_failed": return String(localized: "Não foi possível iniciar o comando")
            case "command_output_truncated": return String(localized: "Saída limitada pelo host")
            case "host_interrupted": return String(localized: "Host interrompido; resultado incerto")
            case "executor_error": return String(localized: "Executor sem confirmação do resultado")
            case "cancelled": return String(localized: "Turno cancelado")
            case "destination_unavailable": return String(localized: "Destino indisponível; ação não executada")
            default: return text
            }
        }
        if key == "target", text == "computer_access" { return String(localized: "Acesso ao computador") }
        if key == "executionBoundary", text == "owner_os_permissions" { return String(localized: "Permissões do usuário deste Mac") }
        if key == "termination" {
            switch text {
            case "completed", "exited": return String(localized: "Encerramento normal")
            case "timeout": return String(localized: "Tempo limite atingido")
            case "cancelled": return String(localized: "Cancelado")
            case "stdout_limit": return String(localized: "Limite da saída atingido")
            case "closed": return String(localized: "Host encerrado")
            case "spawn_failed": return String(localized: "Falha ao iniciar")
            default: return text
            }
        }
        return text
    }

    private static func fieldLabel(_ key: String) -> String {
        switch key {
        case "operation": String(localized: "Operação")
        case "diagnostic": String(localized: "Diagnóstico")
        case "commandOutcome": String(localized: "Desfecho do comando")
        case "code": String(localized: "Motivo informado pelo host")
        case "effectMayBePartial": String(localized: "O efeito pode ser parcial")
        case "effectDispatched": String(localized: "Execução iniciada")
        case "retryAutomatically": String(localized: "Nova tentativa automática")
        case "stderrAvailable": String(localized: "Avisos e erros disponíveis")
        case "stdoutAvailable": String(localized: "Saída disponível")
        case "kind": String(localized: "Tipo de resultado")
        case "stdout": String(localized: "Saída")
        case "stderr": String(localized: "Avisos e erros")
        case "stderrDiscarded": String(localized: "Avisos e erros descartados")
        case "stdoutTruncated": String(localized: "Saída truncada")
        case "cwdIsNotSandbox": String(localized: "Pasta de trabalho não limita acesso ao sistema")
        case "executionBoundary": String(localized: "Fronteira de execução")
        case "termination": String(localized: "Encerramento")
        case "signal": String(localized: "Sinal de encerramento")
        case "exitCode", "exit_code": String(localized: "Código de saída")
        case "command": String(localized: "Comando exato")
        case "runtime": String(localized: "Executar com")
        case "cwd": String(localized: "Pasta de trabalho")
        case "timeout_ms": String(localized: "Tempo limite (ms)")
        case "path": String(localized: "Arquivo")
        case "text", "content": String(localized: "Conteúdo exato")
        case "executable": String(localized: "Programa")
        case "tool": String(localized: "Ferramenta")
        case "task": String(localized: "Tarefa")
        case "server_id": String(localized: "Conexão MCP")
        case "skill_id": String(localized: "Skill")
        case "scope": String(localized: "Escopo")
        case "args", "argv", "arguments": String(localized: "Argumentos")
        case "expected_sha256": String(localized: "Versão esperada do arquivo")
        case "expectedRevision": String(localized: "Revisão esperada")
        case "target": String(localized: "Destino")
        case "configurationRevision": String(localized: "Revisão da configuração")
        case "name": String(localized: "Nome")
        case "engine": String(localized: "Motor")
        case "model": String(localized: "Modelo")
        case "reasoning_effort": String(localized: "Esforço")
        case "speed": String(localized: "Velocidade")
        case "canSeeBots": String(localized: "Ver outros bots")
        case "canSendActions": String(localized: "Enviar tarefas a outros bots")
        case "canReceiveOrders": String(localized: "Receber ordens de outros bots")
        default: key
        }
    }

    public var formattedArguments: String { JSONValue.object(arguments).formattedJSON }
    public var formattedResult: String? { action.result?.formattedJSON }
    public var expirationDate: Date? {
        expiresAtMilliseconds.map { Date(timeIntervalSince1970: TimeInterval($0) / 1_000) }
    }

    public func isExpired(atMilliseconds now: Int64) -> Bool {
        expiresAtMilliseconds.map { now >= $0 } ?? false
    }

    /// A host connection is necessary even for denial. The host still validates every submitted decision.
    public func canDecide(hostAvailable: Bool, atMilliseconds now: Int64) -> Bool {
        hostAvailable && state == .awaitingApproval && !isExpired(atMilliseconds: now)
    }
}

/// Where an action runs, as far as its persisted tool and destination prove it. "Base" is the host the app is
/// connected to, local or paired; it is not the same as this Mac.
public enum ApprovalExecutionPlace: Equatable, Sendable {
    /// The base's own process, with its system user's permissions; the working folder is not a sandbox.
    case baseTerminal
    /// This bot's own file space on the base.
    case baseBotFiles
    /// An occurrence of this bot's automation on the base.
    case baseAutomation
    /// The base applies the change to its own Dexter configuration.
    case baseConfiguration
}

public struct ApprovalReadableField: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let value: String
}

/// Shared by the native first responder and focal tests. Only an exact, non-repeated
/// Command-Shift-P/D key down can request a decision; navigation never falls through to Send.
public enum ApprovalReviewGesture: Equatable, Sendable {
    case up, down, escape, enter, character(String)
}
public enum ApprovalReviewIntent: Equatable, Sendable {
    case move(Int), exit, decide(ApprovalDecision), consume, ignore
    public static func route(_ gesture: ApprovalReviewGesture, command: Bool, shift: Bool,
                             option: Bool, control: Bool, repeated: Bool, focused: Bool,
                             eligible: Bool) -> Self {
        guard focused else { return .ignore }
        if command && shift && !option && !control {
            if case .character(let character) = gesture, ["p", "d"].contains(character.lowercased()) {
                guard eligible, !repeated else { return .consume }
                return .decide(character.lowercased() == "p" ? .allow : .deny)
            }
        }
        guard !command && !shift && !option && !control else { return .ignore }
        switch gesture {
        case .up: return eligible ? .move(-1) : .consume
        case .down: return eligible ? .move(1) : .consume
        case .escape: return .exit
        case .enter: return .consume
        case .character: return .ignore
        }
    }
}

public struct ApprovalInteractionTrace: Codable, Equatable, Sendable {
    public let sequence: Int
    public let source: String
    public let actionID: String
    public let requestHash: String
    public let botID: String
    public let threadID: String
    public let grantRevision: Int
    public let hostScope: UUID
    public let presentationGeneration: UInt64
    public let focused: Bool
    public let repeated: Bool
    public let intent: String
    public let keyCode: UInt16?
    public let modifierBits: UInt?
    public init(sequence: Int, source: String, action: Action, hostScope: UUID, generation: UInt64,
                focused: Bool, repeated: Bool, intent: String, keyCode: UInt16? = nil, modifierBits: UInt? = nil) {
        self.sequence = sequence; self.source = source; actionID = action.id; requestHash = action.requestHash
        botID = action.request.botId; threadID = action.request.threadId; grantRevision = action.grantRevision
        self.hostScope = hostScope; presentationGeneration = generation; self.focused = focused
        self.repeated = repeated; self.intent = intent
        self.keyCode = keyCode; self.modifierBits = modifierBits
    }
}

/// A UI reservation, never host authority. Kept above individual cards so paging cannot duplicate POSTs.
public struct ApprovalDecisionGate: Equatable, Sendable {
    public private(set) var actionIDs: Set<String> = []
    public init() {}
    public mutating func reserve(_ action: Action, expectedHostScope: UUID, currentHostScope: UUID,
                                 expectedGeneration: UInt64, currentGeneration: UInt64,
                                 visibleThread: String, selectedThread: String?, currentAction: Action?,
                                 hostAvailable: Bool, atMilliseconds now: Int64) -> Bool {
        guard expectedHostScope == currentHostScope, expectedGeneration == currentGeneration, visibleThread == selectedThread,
              action.request.threadId == visibleThread, currentAction == action, !actionIDs.contains(action.id),
              ApprovalPresentation(action: action).canDecide(hostAvailable: hostAvailable, atMilliseconds: now) else { return false }
        actionIDs.insert(action.id); return true
    }
    public mutating func release(_ actionID: String) { actionIDs.remove(actionID) }
}

/// UX-P2-20: consecutive finished actions that read the same (same tool and destination, same outcome and same reason)
/// shown as one row ("3× Executar comando · Bloqueada"), newest first. Display only: every member keeps its own card,
/// receipt and details; nothing here decides, retries or hides an action that still needs the owner.
public struct ApprovalHistoryGroup: Identifiable, Equatable, Sendable {
    /// Newest first; never empty.
    public let actions: [Action]
    public let title: String
    public let outcome: ApprovalOutcome
    public let explanation: String

    public var id: String { actions[0].id }
    public var count: Int { actions.count }
    public var newestUpdatedAt: Int64 { actions[0].updatedAt }
    public var oldestUpdatedAt: Int64 { actions[actions.count - 1].updatedAt }
    public var stateLabel: String { outcome.stateLabel }
    public var statusSymbol: String { outcome.statusSymbol }
}

public enum ApprovalHistoryGrouping {
    /// Groups only actions that are finished at `now`; anything still pending, ready or running is left out (it is
    /// shown, undimmed, where the owner acts on it). Order: `updatedAt` then `id`, newest first.
    public static func groups(_ actions: [Action], atMilliseconds now: Int64) -> [ApprovalHistoryGroup] {
        let finished = actions
            .filter { ApprovalPresentation(action: $0).isHistorical(atMilliseconds: now) }
            .sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
        var groups: [ApprovalHistoryGroup] = []
        var current: [Action] = []
        var currentKey: Key?
        for action in finished {
            let key = Key(action: action, now: now)
            if key == currentKey {
                current.append(action)
            } else {
                if let currentKey { groups.append(currentKey.group(current)) }
                current = [action]; currentKey = key
            }
        }
        if let currentKey { groups.append(currentKey.group(current)) }
        return groups
    }

    private struct Key: Equatable {
        let tool: String
        let destination: String
        let botID: String
        let title: String
        let outcome: ApprovalOutcome
        let explanation: String

        init(action: Action, now: Int64) {
            let presentation = ApprovalPresentation(action: action)
            tool = action.request.tool; destination = action.request.destination; botID = action.request.botId
            title = presentation.title; outcome = presentation.outcome(atMilliseconds: now)
            explanation = presentation.resultExplanation(atMilliseconds: now)
        }

        func group(_ actions: [Action]) -> ApprovalHistoryGroup {
            ApprovalHistoryGroup(actions: actions, title: title, outcome: outcome, explanation: explanation)
        }
    }
}
