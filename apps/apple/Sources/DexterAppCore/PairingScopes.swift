import Foundation

/// What a paired app may do on a base, in plain words (UX-P1-07). Raw scope strings only: the eight historical scopes
/// are named explicitly (never `ClientScope.allCases`), and the two output-folder scopes exist only when the owner put
/// them in the offer by hand. Nothing here grants, infers or restores a scope; it describes or drafts one.
public enum PairingScopeCatalog {
    public static let outputsRead = "outputs.read"
    public static let outputsManage = "outputs.manage"
    public static let connectionsRead = "connections.read"
    public static let connectionsManage = "connections.manage"
    public static let mcpRead = "mcp.read"
    public static let mcpManage = "mcp.manage"
    /// The scopes every app-client offer carried before output folders; listed one by one on purpose.
    public static let historical: [String] = [
        "approvals.decide", "approvals.read", "chat.read", "chat.write",
        "devices.manage", "devices.read", "grants.manage", "grants.read",
    ]
    public static let outputs: [String] = [outputsRead, outputsManage]
    /// Connections and native MCP of the base, each its own opt-in. Credentials, keys and native OAuth custody never
    /// cross the paired channel, whatever is granted here.
    public static let connections: [String] = [connectionsRead, connectionsManage, mcpRead, mcpManage]
    /// Display order: conversations, approvals, devices, permissions, then output folders.
    public static let displayOrder: [String] = [
        "chat.read", "chat.write", "approvals.read", "approvals.decide",
        "devices.read", "devices.manage", "grants.read", "grants.manage",
        outputsRead, outputsManage,
        connectionsRead, connectionsManage, mcpRead, mcpManage,
    ]

    /// Portuguese key of the plain label; the catalog carries English. Unknown scopes are shown as they are.
    public static func labelKey(_ scope: String) -> String {
        switch scope {
        case "chat.read": "Ler as conversas"
        case "chat.write": "Enviar mensagens"
        case "approvals.read": "Ver pedidos de aprovação"
        case "approvals.decide": "Permitir ou negar pedidos"
        case "devices.read": "Ver aparelhos"
        case "devices.manage": "Gerenciar aparelhos"
        case "grants.read": "Ver as permissões dos bots"
        case "grants.manage": "Mudar as permissões dos bots"
        case outputsRead: "Ver e baixar arquivos"
        case outputsManage: "Alterar pasta de arquivos"
        case connectionsRead: "Ver conexões e pedidos dos bots"
        case connectionsManage: "Conectar contas e mudar acessos"
        case mcpRead: "Ver servidores MCP e seus pedidos"
        case mcpManage: "Responder pedidos de servidores MCP"
        default: scope
        }
    }

    /// Each known scope, in display order, with whether the given set includes it. Unknown ones are appended as-is.
    public static func rows(for scopes: [String]) -> [(scope: String, included: Bool)] {
        let known = displayOrder.map { (scope: $0, included: scopes.contains($0)) }
        let unknown = scopes.filter { !displayOrder.contains($0) }.sorted().map { (scope: $0, included: true) }
        return known + unknown
    }

    /// `outputs.manage` does not include reading: changing the folder without seeing it is allowed but worth saying.
    public static func managesWithoutReading(_ scopes: [String]) -> Bool {
        scopes.contains(outputsManage) && !scopes.contains(outputsRead)
    }

    /// `connections.manage` / `mcp.manage` without their read scope: allowed, but the app cannot list what it changes.
    public static func connectionsManageWithoutReading(_ scopes: [String]) -> Bool {
        (scopes.contains(connectionsManage) && !scopes.contains(connectionsRead)) || (scopes.contains(mcpManage) && !scopes.contains(mcpRead))
    }
}

/// Draft of the owner's offer for a paired app: the historical eight, plus each output-folder, connections or MCP scope
/// only after a human turns it on. `init()` never turns them on; "Selecionar todos" is its own explicit call.
public struct PairingScopeSelection: Equatable, Sendable {
    public private(set) var outputsRead = false
    public private(set) var outputsManage = false
    public private(set) var connectionsRead = false
    public private(set) var connectionsManage = false
    public private(set) var mcpRead = false
    public private(set) var mcpManage = false

    public init() {}

    public mutating func set(_ scope: String, on: Bool) {
        switch scope {
        case PairingScopeCatalog.outputsRead: outputsRead = on
        case PairingScopeCatalog.outputsManage: outputsManage = on
        case PairingScopeCatalog.connectionsRead: connectionsRead = on
        case PairingScopeCatalog.connectionsManage: connectionsManage = on
        case PairingScopeCatalog.mcpRead: mcpRead = on
        case PairingScopeCatalog.mcpManage: mcpManage = on
        default: break // the historical eight are always offered; nothing else can be added here
        }
    }

    /// Explicit gesture only.
    public mutating func selectAllOutputs() { outputsRead = true; outputsManage = true }

    /// Sorted, as the offer contract requires.
    public var scopes: [String] {
        (PairingScopeCatalog.historical
            + (outputsRead ? [PairingScopeCatalog.outputsRead] : [])
            + (outputsManage ? [PairingScopeCatalog.outputsManage] : [])
            + (connectionsRead ? [PairingScopeCatalog.connectionsRead] : [])
            + (connectionsManage ? [PairingScopeCatalog.connectionsManage] : [])
            + (mcpRead ? [PairingScopeCatalog.mcpRead] : [])
            + (mcpManage ? [PairingScopeCatalog.mcpManage] : [])).sorted()
    }

    public var managesWithoutReading: Bool { outputsManage && !outputsRead }
    public var connectionsManageWithoutReading: Bool { PairingScopeCatalog.connectionsManageWithoutReading(scopes) }
}
