import DexterHostClient
import Foundation

/// Pure presentation facts for the MCP registration lifecycle in Conexões MCP. Returns catalog keys and values only:
/// nothing here reads the network, changes a session, or treats the connection list as a confirmation.
public enum McpRegistrationLifecyclePresentation {
    /// The HTTP form fields of a prepared request that never left the app, so Editar dados can refill the form after
    /// `discardPrepared()`. The owner still reviews and registers again (a new request); the old request ID is not carried.
    public struct HttpRefill: Equatable, Sendable {
        public let name: String
        public let url: String
        public let authentication: McpHttpDraft.Authentication
        public let serverID: String
    }

    /// Nil for a local process (from Importar) or any definition the HTTP form cannot show.
    public static func httpRefill(_ request: McpRegistrationRequest) -> HttpRefill? {
        guard case .object(let definition) = request.definition, case .string(let name) = definition["name"],
              case .object(let transport) = definition["transport"], transport["type"] == .string("streamable_http"),
              case .string(let url) = transport["url"], case .string(let auth) = definition["auth"],
              let authentication = McpHttpDraft.Authentication(rawValue: auth) else { return nil }
        return HttpRefill(name: name, url: url, authentication: authentication, serverID: request.serverID)
    }

    /// The literal state of a request left for later. Only its own original read changes it, never the inventory.
    public static func deferredStatus(_ item: McpDeferredRegistration) -> String {
        if item.isUnresolved {
            return item.state == .legacyUnavailable ? "Esta base não confirma cadastros" : "Resultado em aberto"
        }
        switch item.state {
        case .registered: return "Cadastro confirmado pela base"
        case .removed: return "Feito; a conexão foi removida depois"
        case .replaced: return "Feito; a conexão foi substituída depois"
        case .rejected: return "A base recusou o cadastro"
        default: return "Resultado em aberto"
        }
    }

    /// Connection IDs whose own request is still open, so a list row that already reads Registrado gets human context.
    /// `openRequest` is the active request only while its outcome is open. Never a confirmation or a selection.
    public static func unconfirmedServerIDs(openRequest: McpRegistrationRequest?, deferred: [McpDeferredRegistration]) -> Set<String> {
        var ids = Set(deferred.filter(\.isUnresolved).map(\.request.serverID))
        if let openRequest { ids.insert(openRequest.serverID) }
        return ids
    }

    /// One plain sentence (catalog key) for a lifecycle action the session refused. No IDs.
    public static func notice(for error: any Error) -> String {
        if let error = error as? McpRegistrationLifecycleError {
            switch error {
            case .historyFull: return "Já há 32 consultas guardadas. Confira algumas em Consultas guardadas antes de guardar outra; nenhuma foi descartada."
            case .operationInFlight: return "Aguarde a operação em andamento terminar."
            case .instanceStillUncertain: return "Há uma consulta guardada em aberto com este ID de conexão. Confira esse pedido em Consultas guardadas antes; o Dexter não troca o ID sozinho."
            case .mutationAlreadySent: return "Este pedido já foi enviado e não pode mais ser editado. Use Conferir estado."
            case .notPrepared, .noUncertainAttempt: return "Este pedido mudou de estado. Feche e reabra o cadastro para conferir."
            }
        }
        if (error as? HostClientError) == .forbidden {
            return "A base ou o contexto do bot mudou. Feche e reabra as conexões para usar o novo contexto. Um cadastro não confirmado continua guardado enquanto o app estiver aberto."
        }
        return "Este pedido mudou de estado. Feche e reabra o cadastro para conferir."
    }
}
