import DexterHostClient
import Foundation
import SwiftUI

public struct ApprovalSimpleSummary: Equatable, Sendable {
    public let purpose: String
    public let target: String
    public let effect: String
    public init(action: Action, connectionName: String? = nil, botName: String? = nil, locale: Locale = .current) {
        let pt = locale.language.languageCode?.identifier == "pt"
        func copy(_ ptText: String, _ enText: String) -> String { pt ? ptText : enText }
        let input: [String: JSONValue]
        if case .object(let value)? = action.request.arguments["input"] { input = value } else { input = action.request.arguments }
        func literal(_ key: String) -> String? { if case .string(let value)? = input[key], !value.isEmpty { value } else { nil } }
        switch action.request.tool {
        case "dexter.harness.terminal.run":
            purpose = copy("Executar um comando no computador da base", "Run a command on the host computer")
            target = literal("cwd") ?? copy("Pasta de trabalho deste bot", "This bot’s working folder")
            effect = copy("O comando pode ler ou alterar o que seu usuário do sistema permite. A pasta não isola o computador.",
                          "The command can read or change what the system user permits. The folder does not isolate the computer.")
        case "dexter.harness.cli.run":
            purpose = literal("tool") == "python3" ? copy("Executar Python no computador da base", "Run Python on the host computer")
                : copy("Usar GitHub no computador da base", "Use GitHub on the host computer")
            target = literal("cwd") ?? copy("Pasta de trabalho deste bot", "This bot’s working folder")
            effect = copy("Pode executar operações com as permissões já disponíveis. Esta aprovação não faz login.", "Can perform operations using existing permissions. This approval does not sign in.")
        case "dexter.harness.files.write", "mac.file.append":
            purpose = copy("Salvar um arquivo", "Save a file")
            target = literal("path") ?? copy("Arquivo indicado no pedido", "The file specified in the request")
            effect = action.request.tool == "mac.file.append" ? copy("Adiciona conteúdo ao final desse arquivo.", "Adds content to the end of this file.")
                : copy("Cria o arquivo ou substitui seu conteúdo, dentro da pasta permitida para este bot.", "Creates the file or replaces its content within this bot’s allowed folder.")
        case "mac.file.read":
            purpose = copy("Ler um arquivo", "Read a file"); target = literal("path") ?? action.request.destination
            effect = copy("Lê o conteúdo permitido desse arquivo.", "Reads the allowed content of this file.")
        case "dexter.browseruse.run":
            purpose = copy("Fazer uma tarefa no navegador", "Perform a browser task")
            target = literal("startUrl") ?? copy("Navegador configurado para este bot", "This bot’s configured browser")
            effect = copy("A tarefa pode interagir com o site dentro dos limites já permitidos.", "The task may interact with the site within the existing limits.")
        case "dexter.automations.run":
            purpose = copy("Iniciar uma rotina", "Start a routine"); target = literal("scheduleId") ?? copy("Rotina deste bot", "This bot’s routine")
            effect = copy("Inicia a rotina; as ações que ela pedir continuam seguindo os acessos e o modo efetivo.", "Starts the routine; its actions still follow existing access and the effective mode.")
        case "dexter.harness.mac.setup.request":
            purpose = copy("Configurar acesso ao Mac", "Set up Mac access")
            target = botName.map { copy("Controle de tela para \($0)", "Screen control for \($0)") }
                ?? copy("Controle de tela para este bot", "Screen control for this bot")
            effect = copy("Abre o painel Controle de tela para você conferir; ainda não concede controle, permissões do macOS nem sessão.",
                          "Opens the Screen control panel for you to review; it does not grant control, macOS permissions or a session yet.")
        case "dexter.harness.mcp.add", "dexter.harness.mcp.add_http":
            purpose = copy("Adicionar uma conexão", "Add a connection"); target = connectionName ?? copy("Conexão descrita no pedido", "The connection described in the request")
            effect = copy("Salva o cadastro. Login e acesso às ferramentas são etapas separadas.", "Saves the connection definition. Sign-in and tool access are separate steps.")
        default:
            purpose = copy("Usar esta ferramenta", "Use this tool")
            target = connectionName ?? action.request.destination
            effect = copy("O efeito exato não foi confirmado. Confira o pedido nos detalhes antes de permitir.", "The exact effect is unconfirmed. Review the request in the details before allowing it.")
        }
    }
}

/// The default pending card: what the action is, the concrete thing it touches (copied from the persisted input) and one
/// honest scope line. The full input, hash, pins, policy and saved types stay behind "Ver ação". Display only; it never
/// decides, authorizes or builds a request, and it never presents the working folder as an operating-system sandbox.
public struct ApprovalCompactSummary: Equatable, Sendable {
    public let title: String
    /// Command, argv, file, URL, task or connection from the input; nil when the tool has nothing concrete to show.
    public let preview: String?
    /// Monospaced, selectable literal (commands, argv, paths, URLs) rather than prose.
    public let previewIsLiteral: Bool
    public let scope: String

    public init(action: Action, connectionName: String? = nil, botName: String? = nil, locale: Locale = .current) {
        let pt = locale.language.languageCode?.identifier == "pt"
        func copy(_ ptText: String, _ enText: String) -> String { pt ? ptText : enText }
        let input: [String: JSONValue]
        if case .object(let value)? = action.request.arguments["input"] { input = value } else { input = action.request.arguments }
        func literal(_ key: String) -> String? {
            guard case .string(let value)? = input[key] else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        let presentation = ApprovalPresentation(action: action)
        let folder = literal("cwd") ?? copy("pasta de trabalho deste bot", "this bot’s working folder")
        var literalPreview = true
        switch action.request.tool {
        case "dexter.harness.terminal.run":
            title = copy("Executar comando", "Run command"); preview = literal("command")
            scope = copy("Na base, em \(folder) · com as permissões do seu usuário do sistema; a pasta não isola o computador",
                         "On the base, in \(folder) · with your system user’s permissions; the folder does not isolate the computer")
        case "dexter.harness.cli.run":
            let tool = literal("tool")
            title = tool == "python3" ? copy("Executar Python", "Run Python") : copy("Usar GitHub", "Use GitHub")
            var argv = tool.map { [$0] } ?? []
            if case .array(let items)? = input["args"] { argv += items.compactMap { if case .string(let value) = $0 { value } else { nil } } }
            preview = argv.isEmpty ? nil : argv.joined(separator: " ")
            scope = copy("Na base, em \(folder) · com as permissões do seu usuário do sistema; a pasta não isola o computador; não faz login",
                         "On the base, in \(folder) · with your system user’s permissions; the folder does not isolate the computer; does not sign in")
        case "dexter.harness.files.write":
            title = copy("Salvar arquivo", "Save file"); preview = literal("path")
            scope = input["expected_sha256"] == nil
                ? copy("Cria o arquivo, só na pasta de arquivos deste bot", "Creates the file, only in this bot’s file space")
                : copy("Substitui o conteúdo deste arquivo, só na pasta de arquivos deste bot", "Replaces this file’s content, only in this bot’s file space")
        case "mac.file.append":
            title = copy("Acrescentar ao arquivo", "Append to file"); preview = literal("name") ?? literal("path")
            scope = copy("Uma linha ao final de um arquivo permitido, no Mac pareado", "One line at the end of an allowed file, on the paired Mac")
        case "mac.file.read":
            title = copy("Ler arquivo", "Read file"); preview = literal("name") ?? literal("path")
            scope = copy("Só este arquivo permitido, no Mac pareado", "Only this allowed file, on the paired Mac")
        case "dexter.browseruse.run":
            title = copy("Tarefa no navegador", "Browser task"); preview = literal("task"); literalPreview = false
            let start = literal("start_url") ?? literal("startUrl") ?? copy("o site inicial do pedido", "the requested start site")
            scope = copy("Começa em \(start) · só nos sites permitidos; o serviço pode cobrar esta tarefa",
                         "Starts at \(start) · allowed sites only; the provider may bill this task")
        case "dexter.automations.run":
            title = copy("Iniciar rotina", "Start routine"); preview = literal("scheduleId")
            scope = copy("As ações da rotina seguem os acessos e o modo atuais", "The routine’s actions follow the current access and mode")
        case "dexter.harness.mcp.add", "dexter.harness.mcp.add_http":
            title = copy("Adicionar conexão", "Add connection")
            preview = connectionName ?? presentation.summaryFields.first { ["/name", "/url", "/command"].contains($0.id) }?.value
            scope = copy("Só salva o cadastro; login e ferramentas são etapas separadas", "Only saves the definition; sign-in and tools are separate steps")
        case "dexter.harness.mcp.authorize":
            title = presentation.title; preview = literal("serverId")
            scope = copy("Abre o login no navegador; não libera ferramentas", "Opens sign-in in the browser; does not enable tools")
        case "dexter.harness.mac.setup.request":
            title = presentation.title; literalPreview = false
            preview = botName.map { copy("Controle de tela para \($0)", "Screen control for \($0)") }
                ?? copy("Controle de tela para este bot", "Screen control for this bot")
            scope = copy("Abre o painel Controle de tela; ainda não concede controle, permissões do macOS nem sessão",
                         "Opens the Screen control panel; it does not grant control, macOS permissions or a session yet")
        case "dexter.harness.bots.communication.update":
            title = presentation.title; preview = nil
            scope = copy("Só a comunicação deste bot com outros bots", "Only this bot’s communication with other bots")
        case let tool where tool.hasPrefix("mac."):
            title = DeviceToolLabel.title(tool); preview = literal("url"); literalPreview = true
            scope = copy("No Mac pareado · segue as permissões e a sessão desse Mac", "On the paired Mac · follows that Mac’s permissions and session")
        default:
            title = presentation.title
            if let server = presentation.mcpServerID {
                preview = presentation.mcpToolName
                let name = connectionName ?? server
                scope = copy("Conexão \(name) · conta não verificada; confira em Ver ação", "Connection \(name) · account not verified; review in View action")
            } else {
                let field = presentation.summaryFields.first { $0.id != "tool-name" }
                preview = field?.value
                scope = copy("O efeito exato não foi confirmado; confira em Ver ação antes de permitir",
                             "The exact effect is unconfirmed; review it in View action before allowing")
            }
        }
        previewIsLiteral = literalPreview && preview != nil
    }
}

extension ApprovalPresentation {
    public func preferenceDecisionMessage(_ notice: String, locale: Locale = .current) -> String {
        let pt = locale.language.languageCode?.identifier == "pt"
        if notice == "unknown" || notice == "receipt_missing" { return pt ? "A decisão ainda não foi confirmada. Confira antes de tentar novamente." : "The decision is unconfirmed. Check before trying again." }
        if notice == "denied" { return pt ? "Pedido negado." : "Request denied." }
        if notice == "type_saved" {
            if action.state == .blocked { return pt ? "Tipo salvo. A execução deste pedido foi bloqueada." : "Type saved. Execution of this request was blocked." }
            if action.state == .unknown { return pt ? "Tipo salvo. O resultado da execução não foi confirmado." : "Type saved. The execution result is unconfirmed." }
            return pt ? "Tipo salvo. Pedido autorizado." : "Type saved. Request authorized."
        }
        return pt ? "Pedido autorizado." : "Request authorized."
    }

    public func alwaysAcceptExplanation(locale: Locale = .current) -> String {
        let pt = locale.language.languageCode?.identifier == "pt"
        func copy(_ p: String, _ e: String) -> String { pt ? p : e }
        guard let type = action.approvalType, type.eligible else {
            switch action.approvalType?.reason {
            case "access_not_enabled": return copy("Ative este acesso antes de salvar uma regra.", "Enable this access before saving a rule.")
            case "private_flow": return copy("Esta etapa exige sua participação a cada pedido.", "This step requires your participation for each request.")
            case "pins_unavailable": return copy("Esta ferramenta ainda não fornece uma identidade estável para salvar o tipo.", "This tool does not yet provide a stable identity for a saved type.")
            case "authority_changed": return copy("O acesso ou a revisão mudou. Atualize o pedido.", "The access or revision changed. Refresh the request.")
            default: return copy("Este tipo ainda não oferece aprovação permanente.", "This type does not yet support a saved approval.")
            }
        }
        if tool.hasPrefix("mcp.") { return copy("Só esta ferramenta nesta conexão, com os mesmos dados de entrada, conta e revisão. Mudanças pedem nova aprovação.", "Only this tool on this connection, with the same input, account and revision. Changes ask again.") }
        if type.category == "commands" { return copy("Outros comandos da mesma ferramenta, runtime e pasta, para este bot e com os mesmos acessos e limites. Revogável nos ajustes.", "Other commands using the same tool, runtime and folder, for this bot and with the same access and limits. Revocable in settings.") }
        return copy("Só esta operação, alvo, acesso e revisão deste bot. Mudanças pedem nova aprovação. Revogável nos ajustes.", "Only this operation, target, access and revision for this bot. Changes ask again. Revocable in settings.")
    }
}

/// Real reusable summary. It is visible as soon as a proposal is shown; literals remain selectable.
public struct ApprovalRequestSummary: View {
    @Environment(\.locale) private var locale
    public let action: Action
    public var connectionName: String?
    /// The requesting bot's display name, from the host projection; never authority.
    public var botName: String?
    public init(action: Action, connectionName: String? = nil, botName: String? = nil) {
        self.action = action; self.connectionName = connectionName; self.botName = botName
    }
    public var body: some View {
        let copy = ApprovalSimpleSummary(action: action, connectionName: connectionName, botName: botName, locale: locale)
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: copy.purpose).font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("approval.simple.purpose.\(action.id)")
            Text(verbatim: copy.target).textSelection(.enabled)
                .accessibilityIdentifier("approval.simple.target.\(action.id)")
            Text(verbatim: copy.effect).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("approval.simple.effect.\(action.id)")
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approval.simple.\(action.id)")
    }
}
