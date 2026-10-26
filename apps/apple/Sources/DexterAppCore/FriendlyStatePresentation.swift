import DexterHostClient
import Foundation

/// Display-only translations of states the host already reports. Unknown values are shown verbatim, never guessed;
/// none of these labels confirms login, inference or a completed effect.

/// Ladder of what the host catalog says about one engine. The contract has no login field, so every found
/// engine still reads "login não confirmado".
public enum EngineCatalogLookup: Equatable, Sendable {
    case notLoaded
    case loading
    case loaded
    /// Safe client failure only; never provider stderr, account details or a claim that a CLI is absent.
    case failed(HostClientError)
}

public enum EngineReadiness: Equatable, Sendable {
    case checking
    case notReported
    case notFound
    case foundUnsupported
    case foundUnavailable
    case availableLoginUnconfirmed

    public init(entry: EngineCatalogEntry?) {
        guard let entry else { self = .notReported; return }
        if entry.available && entry.adapterSupported != false { self = .availableLoginUnconfirmed; return }
        if entry.installed == false { self = .notFound; return }
        if entry.adapterSupported == false { self = .foundUnsupported; return }
        self = .foundUnavailable
    }

    public init(entry: EngineCatalogEntry?, lookup: EngineCatalogLookup) {
        switch lookup {
        case .loading: self = .checking
        case .notLoaded, .failed: self = .notReported
        case .loaded: self.init(entry: entry)
        }
    }

    public func label(portuguese: Bool = true) -> String {
        switch self {
        case .checking: portuguese ? "Consultando a base…" : "Checking the host…"
        case .notReported: portuguese ? "Estado não informado pela base" : "State not reported by the host"
        case .notFound: portuguese ? "Não encontrada nesta base" : "Not found on this host"
        case .foundUnsupported: portuguese ? "Encontrada · o Dexter ainda não tem suporte" : "Found · Dexter does not support it yet"
        case .foundUnavailable: portuguese ? "Encontrada · indisponível agora" : "Found · unavailable right now"
        case .availableLoginUnconfirmed: portuguese ? "Encontrada · login não confirmado" : "Found · sign-in not confirmed"
        }
    }

    public var symbol: String {
        switch self {
        case .checking: "clock"
        case .notReported: "questionmark.circle"
        case .notFound: "xmark.circle"
        case .foundUnsupported, .foundUnavailable: "exclamationmark.circle"
        case .availableLoginUnconfirmed: "person.crop.circle.badge.questionmark"
        }
    }

    /// Usable for a new bot or a selection; still not a promise that the engine will answer.
    public var canRun: Bool { self == .availableLoginUnconfirmed }

    /// First engine the catalog reports as runnable, then the first one found; nil keeps the caller's default.
    public static func preferredEngine(in catalog: [EngineCatalogEntry]) -> EngineID? {
        let ordered = EngineID.allCases
        if let runnable = ordered.first(where: { id in EngineReadiness(entry: catalog.first { $0.id == id.rawValue }).canRun }) { return runnable }
        return ordered.first { id in catalog.first { $0.id == id.rawValue }?.installed == true }
    }
}

/// Friendly names for effort/speed values that came from the current catalog. The value sent to the host is
/// always the catalog value itself; an unknown value is shown as it is.
public enum EngineChoiceLabel {
    public static func effort(_ raw: String, portuguese: Bool = true) -> String {
        switch raw {
        case "none": portuguese ? "Nenhum" : "None"
        case "minimal": portuguese ? "Mínimo" : "Minimal"
        case "low": portuguese ? "Baixo" : "Low"
        case "medium": portuguese ? "Médio" : "Medium"
        case "high": portuguese ? "Alto" : "High"
        case "xhigh": portuguese ? "Muito alto" : "Very high"
        case "max": portuguese ? "Máximo" : "Maximum"
        case "ultra": "Ultra"
        default: raw
        }
    }

    public static func speed(_ raw: String, portuguese: Bool = true) -> String {
        switch raw {
        case "fast": portuguese ? "Rápida" : "Fast"
        case "flex": portuguese ? "Flexível" : "Flexible"
        case "priority": portuguese ? "Prioritária" : "Priority"
        case "standard", "default": portuguese ? "Normal" : "Standard"
        default: raw
        }
    }

    public static func engine(_ raw: String) -> String {
        EngineID(rawValue: raw)?.displayName ?? raw
    }
}

/// Plain-language reading of a turn that ended without an answer. The code stays available for details.
public struct TurnOutcomePresentation: Equatable, Sendable {
    public enum Suggestion: Equatable, Sendable {
        /// Open this bot's Model section (an existing route); nothing is changed automatically.
        case chooseModel
        /// Read-only reload of the conversation.
        case refreshConversation
        case none
    }

    public let title: String
    public let detail: String
    public let suggestion: Suggestion

    public init(state: TurnState, code: String?) {
        switch state {
        case .unknown:
            title = String(localized: "Não foi possível confirmar se a resposta terminou.")
            detail = String(localized: "Nada será reenviado sozinho. Atualize a conversa para ver o que a base registrou.")
            suggestion = .refreshConversation
        case .interrupted:
            switch code {
            case "shutdown", "host_interrupted":
                title = String(localized: "A base foi reiniciada ou desligada durante a resposta.")
                detail = String(localized: "O que já foi feito não é desfeito. Envie de novo se ainda precisar da resposta.")
            default:
                title = String(localized: "Esta resposta foi parada.")
                detail = String(localized: "O que já foi feito não é desfeito.")
            }
            suggestion = .none
        default:
            (title, detail, suggestion) = Self.failure(code)
        }
    }

    private static func failure(_ code: String?) -> (String, String, Suggestion) {
        switch code {
        case "not_installed":
            (String(localized: "A engine deste bot não foi encontrada nesta base."), String(localized: "Escolha outra engine em Modelo, nos ajustes do bot, ou instale a engine pelo instalador oficial."), .chooseModel)
        case "engine_unavailable", "no_driver":
            (String(localized: "A engine deste bot está indisponível nesta base."), String(localized: "Confira o estado da engine em Ajustes › Modelos ou escolha outra em Modelo, nos ajustes do bot."), .chooseModel)
        case "unsupported":
            (String(localized: "A engine não aceitou o modelo, o esforço ou a velocidade escolhidos."), String(localized: "Escolha uma opção listada em Modelo, nos ajustes do bot, e envie de novo."), .chooseModel)
        case "authentication_required":
            (String(localized: "A engine pediu login."), String(localized: "Faça login no programa oficial da engine e envie de novo. O Dexter não faz login nem lê suas credenciais."), .none)
        case "subscription_required":
            (String(localized: "A assinatura da engine não permite este uso."), String(localized: "Confira o plano no serviço da engine. O Dexter não altera assinaturas."), .none)
        case "usage_limit":
            (String(localized: "O limite de uso da assinatura foi atingido."), String(localized: "Tente de novo mais tarde ou escolha outra engine em Modelo."), .chooseModel)
        case "rate_limited":
            (String(localized: "A engine pediu para esperar um pouco."), String(localized: "Envie de novo em instantes. Nada foi reenviado sozinho."), .none)
        case "context_limit":
            (String(localized: "A conversa ficou longa demais para este modelo."), String(localized: "Comece uma nova conversa ou escolha outro modelo em Modelo."), .chooseModel)
        case "timeout", "driver_unresponsive", "executor_unresponsive":
            (String(localized: "A engine demorou demais e a resposta foi encerrada."), String(localized: "Envie de novo se ainda precisar. O que já foi feito não é desfeito."), .none)
        case "busy":
            (String(localized: "A engine estava ocupada com outra resposta."), String(localized: "Envie de novo quando a resposta anterior terminar."), .none)
        case "tool_limit":
            (String(localized: "O bot pediu ferramentas demais nesta resposta."), String(localized: "O limite é de 32 pedidos por resposta. Divida a tarefa em partes menores."), .none)
        case "tool_identity_mismatch":
            (String(localized: "Uma ferramenta não correspondeu ao pedido aprovado."), String(localized: "Nada foi repetido. Atualize a conversa antes de pedir de novo."), .refreshConversation)
        case "tool_response_failed":
            (String(localized: "O resultado de uma ferramenta não chegou à engine."), String(localized: "Nada foi repetido. Atualize a conversa para conferir o que foi feito."), .refreshConversation)
        case "session_uncertain", "session_closed":
            (String(localized: "A sessão da engine foi encerrada sem confirmação."), String(localized: "Atualize a conversa antes de enviar de novo. Nada foi reenviado sozinho."), .refreshConversation)
        default:
            (String(localized: "A engine encerrou esta resposta com erro."), String(localized: "Envie de novo se ainda precisar. O código está em Detalhes técnicos."), .none)
        }
    }
}

/// Mac device tools registered by the capabilities agent; unknown IDs are shown verbatim.
public enum DeviceToolLabel {
    public static func title(_ tool: String) -> String {
        switch tool {
        case "mac.browser.navigate": String(localized: "Abrir páginas no navegador do Mac")
        case "mac.browser.read": String(localized: "Ler a página aberta no navegador do Mac")
        case "mac.browser.close": String(localized: "Fechar páginas do navegador do Mac")
        case "mac.file.read": String(localized: "Ler arquivos escolhidos por você")
        case "mac.file.append": String(localized: "Acrescentar texto em arquivos escolhidos por você")
        case "mac.cua.observe": String(localized: "Ver a tela do app escolhido")
        case "mac.cua.control": String(localized: "Controlar o app escolhido")
        case "mac.cua.status": String(localized: "Consultar o controle de tela")
        default: tool
        }
    }

    public static func policy(_ policy: String?) -> String {
        switch policy {
        case nil: String(localized: "Sem decisão")
        case "ask": String(localized: "Pede aprovação")
        case "deny": String(localized: "Bloqueado")
        case "allow": String(localized: "Permitido")
        case let value?: value
        }
    }
}

public enum DelegationStateLabel {
    public static func title(_ state: BotDelegationState) -> String {
        switch state {
        case .pending: String(localized: "Aguardando")
        case .running: String(localized: "Em andamento")
        case .completed: String(localized: "Concluída")
        case .cancelled: String(localized: "Cancelada")
        case .failed: String(localized: "Falhou")
        case .unknown: String(localized: "Resultado não confirmado")
        }
    }
}
