import Foundation

public struct McpServerSummary: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let transport: String
    public let runsOn: String
    public let auth: String
    public let status: String
    public let destination: String
    public let diagnostic: McpSetupDiagnostic?
    /// Which executor this host is for the connection, when reported. Malformed values are dropped, never guessed.
    public let executor: McpServerExecutor?
    /// The base's current instance pin (64 lowercase hex), when reported; nil = not reported (older base), never a guess.
    public let instancePin: String?
    private enum CodingKeys: String, CodingKey { case id, name, transport, runsOn, auth, status, destination, diagnostic, executor, instancePin }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); name = try c.decode(String.self, forKey: .name)
        transport = try c.decode(String.self, forKey: .transport); runsOn = try c.decode(String.self, forKey: .runsOn)
        auth = try c.decode(String.self, forKey: .auth); status = try c.decode(String.self, forKey: .status)
        destination = try c.decode(String.self, forKey: .destination)
        diagnostic = try c.decodeIfPresent(McpSetupDiagnostic.self, forKey: .diagnostic)
        executor = (try? c.decodeIfPresent(McpServerExecutor.self, forKey: .executor)) ?? nil
        instancePin = try c.decodeIfPresent(String.self, forKey: .instancePin)
        // A malformed pin is a contract error: it is never shown, compared or sent.
        if let instancePin, !McpAuthorizationHandoff.validHash(instancePin) { throw HostClientError.contractMismatch }
    }
}

/// The executor that would run a native connection, as the host reports it. `reachable == true` only means that executor
/// answered THIS read; it never means the upstream server or process is online. `nil` means not reported.
public struct McpServerExecutor: Decodable, Equatable, Sendable {
    public enum Placement: String, Decodable, Sendable { case ownerMac = "owner_mac", cloud, any }
    public let hostId: String?
    public let name: String?
    public let placement: Placement
    public let reachable: Bool?
    private enum CodingKeys: String, CodingKey, CaseIterable { case hostId, name, placement, reachable }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hostId = try c.decodeIfPresent(String.self, forKey: .hostId); name = try c.decodeIfPresent(String.self, forKey: .name)
        placement = try c.decode(Placement.self, forKey: .placement); reachable = try c.decodeIfPresent(Bool.self, forKey: .reachable)
        guard hostId.map({ !$0.isEmpty && $0.utf8.count <= 128 }) ?? true,
              name.map({ !$0.isEmpty && $0.utf16.count <= 128 && !$0.unicodeScalars.contains { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) } }) ?? true,
              reachable != false else { throw HostClientError.contractMismatch }
    }
}

/// Review state of a local process' executable and arguments (`GET /v1/mcp/servers/:id/command-status`). A read only: it
/// never starts the process and never re-pins it. `changed` is recovered by restoring the reviewed executable/arguments
/// or by removing and registering again — never by discovering over the review.
public struct McpCommandStatus: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable { case unreviewed, unchanged, changed, unavailable, notStdio = "not_stdio" }
    public struct Digest: Decodable, Equatable, Sendable {
        public let path: String
        public let sha256: String
        public let argsHash: String
        public let sizeBytes: Int64?
    }
    public let reviewed: Digest?
    public let current: Digest?
    public let state: State
    var isValid: Bool {
        func valid(_ digest: Digest?) -> Bool {
            digest.map { $0.path.hasPrefix("/") && $0.path.utf8.count <= 4_096 && McpAuthorizationHandoff.validHash($0.sha256)
                && McpAuthorizationHandoff.validHash($0.argsHash) && ($0.sizeBytes.map { (0...268_435_456).contains($0) } ?? true) } ?? true
        }
        guard valid(reviewed), valid(current) else { return false }
        switch state {
        case .notStdio: return reviewed == nil && current == nil
        case .unreviewed: return reviewed == nil && current != nil
        case .unchanged: return reviewed != nil && current != nil && reviewed?.path == current?.path && reviewed?.sha256 == current?.sha256 && reviewed?.argsHash == current?.argsHash
        case .changed: return reviewed != nil && current != nil && reviewed != current
        case .unavailable: return current == nil
        }
    }
}

/// Closed, value-free diagnosis; unknown or mismatched values are discarded, never displayed.
public struct McpSetupDiagnostic: Decodable, Sendable {
    public enum Stage: String, Sendable { case registration, configuration, host, discovery, authentication, selection }
    public let stage: Stage?
    public let code: String?
    public let recovery: String?
    private enum CodingKeys: String, CodingKey { case stage, code, recovery }
    private static let recoveries: [String: String] = [
        "invalid_definition": "correct_definition",
        "invalid_request": "correct_input",
        "secret_refused": "use_private_authentication",
        "endpoint_invalid": "supply_known_http_mcp_endpoint",
        "endpoint_secret_refused": "remove_url_credentials_query_fragment",
        "server_unknown": "read_known_receipt",
        "server_exists": "inspect_existing_registration",
        "server_limit": "owner_manage_inventory",
        "native_mcp_disabled": "owner_enable_native_mcp",
        "placement_unavailable": "use_configured_host",
        "unbound": "owner_enable_native_mcp",
        "closed": "read_receipt_before_retry",
        "store_conflict": "owner_recover_configuration",
        "busy": "read_pending_action",
        "configuration_changed": "read_and_propose_again",
        "catalog_unavailable": "owner_approve_discovery",
        "tool_not_allowed": "select_current_publishable_tools",
        "tool_changed": "owner_review_catalog_again",
        "scope_mismatch": "read_own_scope",
        "bot_unknown": "read_own_scope",
        "arguments_refused": "correct_input",
        "needs_auth": "owner_authenticate_privately",
        "credential_missing": "owner_authenticate_privately",
        "credential_locked": "owner_unlock_privately",
        "custody_unavailable": "owner_configure_private_custody",
        "credential_refused": "owner_check_private_authentication",
        "oauth_unavailable": "owner_configure_oauth",
        "oauth_client_required": "owner_supply_registered_oauth_client",
        "oauth_metadata_invalid": "owner_check_oauth_metadata",
        "oauth_flow_failed": "owner_check_private_authentication",
        "oauth_denied": "owner_authenticate_privately",
        "oauth_state_mismatch": "owner_restart_private_authorization",
        "oauth_expired": "owner_authenticate_privately",
        "spawn_failed": "owner_check_program",
        "connect_failed": "check_known_endpoint_then_propose_discovery",
        "timeout": "read_receipt_before_retry",
        "aborted": "read_receipt_before_retry",
        "transport_failed": "check_known_endpoint_then_propose_discovery",
        "upstream_redirect": "supply_known_http_mcp_endpoint",
        "origin_refused": "supply_known_http_mcp_endpoint",
        "upstream_status": "check_known_endpoint_then_propose_discovery",
        "upstream_error": "read_receipt_before_retry",
        "response_too_large": "owner_check_server_limits",
        "response_invalid": "owner_check_mcp_protocol",
        "metadata_quarantined": "owner_correct_upstream_metadata",
        "schema_unsupported": "owner_check_supported_schema",
        "validation_resource_limit": "owner_check_server_limits",
        "input_schema_invalid": "correct_input",
        "output_schema_invalid": "read_receipt_before_retry",
        "egress_refused": "owner_review_executor_network",
        "protocol_unsupported": "owner_check_mcp_protocol",
        "header_mismatch": "owner_check_mcp_protocol",
        "input_required": "owner_review_private_form",
        "circuit_open": "check_service_after_backoff",
        "command_changed": "owner_review_program_again"
    ]
    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let stageValue = try? values.decode(String.self, forKey: .stage)
        let codeValue = try? values.decode(String.self, forKey: .code)
        let recoveryValue = try? values.decode(String.self, forKey: .recovery)
        if let stageValue, let recognizedStage = Stage(rawValue: stageValue), let codeValue,
           let expected = Self.recoveries[codeValue], expected == recoveryValue {
            stage = recognizedStage; code = codeValue; recovery = expected
        } else { stage = nil; code = nil; recovery = nil }
    }

    public var message: String {
        switch code {
        case "needs_auth", "credential_missing", "credential_locked": String(localized: "Autorização pendente. Desbloqueie ou autorize no fluxo privado; depois escolha descobrir ferramentas.")
        case "custody_unavailable", "credential_refused": String(localized: "A custódia privada não está disponível. Confira o 1Password nas opções do host.")
        case "placement_unavailable": String(localized: "Esta conexão pertence a outro host. Abra-a no host configurado.")
        case "native_mcp_disabled", "unbound", "oauth_unavailable": String(localized: "Ative as ferramentas e a autorização apropriada nas opções do host local.")
        case "oauth_client_required": String(localized: "O serviço exige um ID de aplicativo registrado. Informe somente o ID fornecido pelo serviço.")
        case "oauth_metadata_invalid": String(localized: "O serviço não forneceu autorização compatível. Confira o endereço MCP conhecido.")
        case "configuration_changed", "store_conflict", "tool_changed": String(localized: "A configuração mudou. Consulte o estado e proponha novamente os dados atuais.")
        case "endpoint_invalid", "endpoint_secret_refused", "origin_refused", "upstream_redirect": String(localized: "Confira o endereço HTTP MCP fornecido pelo serviço, sem credenciais, consulta ou fragmento.")
        case "timeout", "aborted", "upstream_error", "closed": String(localized: "O resultado precisa de conferência. Consulte o estado ou receipt antes de qualquer nova tentativa.")
        case "connect_failed", "transport_failed", "upstream_status": String(localized: "A descoberta não conectou ao serviço. Confira o endereço e solicite outra descoberta explicitamente.")
        case "response_invalid", "response_too_large": String(localized: "O servidor respondeu fora do contrato MCP ou dos limites. Confira o protocolo e a configuração.")
        case "metadata_quarantined": String(localized: "O servidor publicou uma definição de ferramenta com dados sensíveis. Ela foi bloqueada antes de ser salva; peça ao serviço para corrigir e descubra de novo.")
        case "schema_unsupported": String(localized: "O servidor usa um formato de ferramenta que o Dexter ainda não aceita. Nada foi exposto aos bots.")
        case "validation_resource_limit": String(localized: "A validação atingiu o limite de trabalho. Confira o recibo antes de tentar novamente; nenhuma ação será repetida automaticamente.")
        case "input_schema_invalid": String(localized: "Os dados enviados não seguem o formato da ferramenta. Corrija e proponha de novo.")
        case "output_schema_invalid": String(localized: "A resposta do servidor não seguiu o formato prometido. O efeito pode ter acontecido; confira o recibo antes de repetir.")
        case "egress_refused": String(localized: "A política de rede desta base recusou o destino. Nada foi enviado a ele; revise a rede permitida do executor.")
        case "protocol_unsupported": String(localized: "O servidor respondeu numa versão do protocolo MCP que o Dexter não aceita aqui. Confira o protocolo do serviço.")
        case "header_mismatch": String(localized: "Os cabeçalhos da resposta não correspondem ao pedido, e a resposta foi recusada. Confira o servidor.")
        case "input_required": String(localized: "O servidor pediu dados durante a ação. Responda no formulário privado ou cancele; nada é reenviado.")
        case "circuit_open": String(localized: "O serviço falhou várias vezes seguidas. O Dexter espera antes de consultá-lo de novo; nenhuma ação é repetida.")
        case "command_changed": String(localized: "O programa local mudou desde a revisão. Revise o executável de novo antes de iniciá-lo.")
        default: String(localized: "Não foi possível concluir esta etapa. Consulte o estado e confira a configuração antes de continuar.")
        }
    }
}

public struct McpToolSummary: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let effect: String
    public let state: String
}

public struct McpBotSelection: Codable, Sendable {
    public let botId: String
    public let toolIds: [String]
    public let policy: String
}

public struct McpCredentialSlot: Decodable, Sendable {
    public let key: String
    public let target: String
    public let name: String
    public let from: String
}

public struct McpImportedServer: Decodable, Identifiable, Sendable {
    public var id: String { sourceName }
    public let sourceName: String
    public let proposedId: String?
    public let transport: String
    public let status: String
    public let command: String?
    public let endpoint: String?
    public let credentialSlots: [McpCredentialSlot]
    public let notes: [String]
    public let draft: JSONValue?
}

public struct McpImportPreview: Decodable, Sendable {
    public let format: String
    public let servers: [McpImportedServer]
    public let notes: [String]
}

/// Public connection metadata only. Credentials and OAuth tokens never enter the app.
public struct McpCredentialStatus: Codable, Sendable {
    public let serverId: String
    public let auth: String
    public let custody: String?
    public let slots: [String]
    public let state: String
    public let expiresAt: Double?
    public let issuer: String?
    public let lastError: String?

    public var isReady: Bool { state == "not_required" || state == "unlocked" }
}

public struct McpOAuthAuthorization: Codable, Sendable {
    public let authorizationUrl: URL
    public let issuer: String
    public let expiresAt: Double
}

/// A fixed private host diagnosis, never an upstream message or proof that no external effect occurred.
public struct McpAuthenticationDiagnosticError: Error, Equatable, Sendable, LocalizedError {
    public enum Code: String, CaseIterable, Sendable {
        case custodyUnavailable = "custody_unavailable", credentialLocked = "credential_locked", credentialRefused = "credential_refused"
        case oauthUnavailable = "oauth_unavailable", oauthClientRequired = "oauth_client_required", oauthMetadataInvalid = "oauth_metadata_invalid"
        case oauthFlowFailed = "oauth_flow_failed", oauthDenied = "oauth_denied", oauthStateMismatch = "oauth_state_mismatch", oauthExpired = "oauth_expired"
        case needsAuth = "needs_auth", placementUnavailable = "placement_unavailable"
    }
    public let code: Code
    public init(code: Code) { self.code = code }
    private static let recoveries: [Code: String] = [
        .custodyUnavailable: "owner_configure_private_custody", .credentialLocked: "owner_unlock_privately",
        .credentialRefused: "owner_check_private_authentication", .oauthUnavailable: "owner_configure_oauth",
        .oauthClientRequired: "owner_supply_registered_oauth_client", .oauthMetadataInvalid: "owner_check_oauth_metadata",
        .oauthFlowFailed: "owner_check_private_authentication", .oauthDenied: "owner_authenticate_privately",
        .oauthStateMismatch: "owner_restart_private_authorization", .oauthExpired: "owner_authenticate_privately",
        .needsAuth: "owner_authenticate_privately", .placementUnavailable: "use_configured_host"
    ]
    static func decode(_ response: TransportResponse) -> Self? {
        guard response.statusCode == 409, response.data.count <= 4_096,
              let json = try? JSONDecoder().decode(JSONValue.self, from: response.data), case .object(let body) = json,
              Set(body.keys).isSubset(of: ["error", "message", "diagnostic"]), body["error"] == .string("conflict"),
              case .object(let diagnostic)? = body["diagnostic"], Set(diagnostic.keys) == ["stage", "code", "recovery"],
              diagnostic["stage"] == .string("authentication"), case .string(let rawCode)? = diagnostic["code"],
              let code = Code(rawValue: rawCode), case .string(let recovery)? = diagnostic["recovery"],
              Self.recoveries[code] == recovery else { return nil }
        return Self(code: code)
    }
    public var errorDescription: String? {
        switch code {
        case .oauthMetadataInvalid: String(localized: "Não foi possível preparar a autorização. Atualize o estado e confira as opções de login.")
        case .oauthClientRequired: String(localized: "Este serviço exige um ID de aplicativo. Informe-o nas opções de autorização.")
        case .oauthUnavailable: String(localized: "Ative a autorização desta conexão no host local e atualize.")
        case .placementUnavailable: String(localized: "Abra esta conexão no host onde ela está disponível.")
        case .custodyUnavailable, .credentialRefused: String(localized: "Não foi possível obter as chaves. Confira o acesso ao 1Password e os campos necessários.")
        case .credentialLocked, .needsAuth: String(localized: "Desbloqueie ou autorize novamente para conectar.")
        case .oauthDenied: String(localized: "A autorização não foi concedida. Você pode tentar novamente.")
        case .oauthExpired: String(localized: "O prazo para autorizar terminou. Inicie uma nova autorização.")
        case .oauthStateMismatch: String(localized: "O retorno da autorização não correspondeu ao pedido. Confira o estado antes de iniciar outro login.")
        case .oauthFlowFailed: String(localized: "O serviço não concluiu a preparação do login. Confira o estado antes de autorizar novamente.")
        }
    }
}

/// Public, value-free handoff. The URL and OAuth state stay exclusively in the private owner route.
public struct McpAuthorizationHandoff: Codable, Equatable, Sendable {
    public let kind: String
    public let serverId: String
    public let instancePin: String
    public let hostId: String
    public let botId: String
    public let threadId: String
    public let actionId: String
    public let requestHash: String
    public let expiresAt: Int64
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind, serverId, instancePin, hostId, botId, threadId, actionId, requestHash, expiresAt
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    public init(from decoder: any Decoder) throws {
        let all = try decoder.container(keyedBy: AnyKey.self)
        guard Set(all.allKeys.map(\.stringValue)) == Set(CodingKeys.allCases.map(\.rawValue)) else { throw HostClientError.contractMismatch }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decode(String.self, forKey: .kind)
        serverId = try values.decode(String.self, forKey: .serverId)
        instancePin = try values.decode(String.self, forKey: .instancePin)
        hostId = try values.decode(String.self, forKey: .hostId)
        botId = try values.decode(String.self, forKey: .botId)
        threadId = try values.decode(String.self, forKey: .threadId)
        actionId = try values.decode(String.self, forKey: .actionId)
        requestHash = try values.decode(String.self, forKey: .requestHash)
        expiresAt = try values.decode(Int64.self, forKey: .expiresAt)
        guard kind == "mcp_authorization_handoff",
              serverId.range(of: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil,
              [hostId, botId, threadId, actionId].allSatisfy({ $0.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }),
              Self.validHash(instancePin), Self.validHash(requestHash), expiresAt > 0, expiresAt <= 9_007_199_254_740_991 else {
            throw HostClientError.contractMismatch
        }
    }
    public static func validHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

public extension Action {
    /// A successful exact-owner action, bound to its original normalized request; arbitrary model output is ignored.
    var mcpAuthorizationHandoff: McpAuthorizationHandoff? {
        guard state == .succeeded, authorization?.source == .exactOwner,
              decidedBy == authorization?.ownerId, decidedBy != nil,
              request.tool == "dexter.harness.mcp.authorize", request.destination == "dexter-harness-owner-proposals",
              case .object(let input)? = request.arguments["input"],
              Set(input.keys).isSubset(of: ["serverId", "expectedInstancePin", "actionId"]),
              case .string(let server)? = input["serverId"], case .string(let pin)? = input["expectedInstancePin"],
              let result, let bytes = try? JSONEncoder().encode(result),
              let handoff = try? JSONDecoder().decode(McpAuthorizationHandoff.self, from: bytes),
              handoff.serverId == server, handoff.instancePin == pin,
              handoff.actionId == id, handoff.requestHash == requestHash,
              updatedAt >= 0, updatedAt <= 9_007_199_254_440_991,
              handoff.expiresAt >= updatedAt, handoff.expiresAt <= updatedAt + 300_000,
              handoff.botId == request.botId, handoff.threadId == request.threadId else { return nil }
        return handoff
    }
}

private struct McpServersResponse: Decodable, Sendable { let servers: [McpServerSummary] }
private struct McpServerResponse: Decodable, Sendable { let server: McpServerSummary }
private struct McpToolsResponse: Decodable, Sendable { let tools: [McpToolSummary] }
private struct McpDiscoveryResponse: Decodable, Sendable { let server: McpServerSummary; let tools: [McpToolSummary] }
private struct McpImportBody: Encodable { let format: String; let content: String }
private struct McpAddBody: Encodable { let definition: JSONValue }
private struct McpSelectionBody: Encodable { let toolIds: [String]; let policy = "ask" }
private struct McpEmptyBody: Encodable {}
/// Discover options: both optional and omitted when absent, so the legacy call still sends `{}`.
private struct McpDiscoverBody: Encodable { let expectedInstancePin: String?; let httpOnly: Bool? }
private struct McpRemovedResponse: Decodable, Sendable { let removed: Bool }
private struct McpCredentialsResponse: Decodable, Sendable { let credentials: McpCredentialStatus }
private struct McpOAuthResponse: Decodable, Sendable { let authorization: McpOAuthAuthorization }
private struct McpOAuthBody: Encodable { let clientId: String?; let scope: String?; let expectedInstancePin: String? }

public extension HostClient {
    func mcpCredentials(serverID: String) async throws -> McpCredentialStatus {
        try requireConnections(.mcpRead)
        return try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/credentials", mcpPrivateAuthenticationErrors: true, as: McpCredentialsResponse.self).credentials
    }

    func unlockMcpCredentials(serverID: String) async throws -> McpCredentialStatus {
        try await changeMcpCredentials(serverID: serverID, action: "unlock")
    }

    func lockMcpCredentials(serverID: String) async throws -> McpCredentialStatus {
        try await changeMcpCredentials(serverID: serverID, action: "lock")
    }

    func disconnectMcpCredentials(serverID: String) async throws -> McpCredentialStatus {
        try await changeMcpCredentials(serverID: serverID, action: "disconnect")
    }

    func startMcpOAuth(serverID: String, clientID: String? = nil, scope: String? = nil, expectedInstancePin: String? = nil,
                       beforeDispatch: (@MainActor @Sendable () throws -> Void)? = nil) async throws -> McpOAuthAuthorization {
        try requireLocalMcpAccess()
        if let expectedInstancePin, !McpAuthorizationHandoff.validHash(expectedInstancePin) { throw HostClientError.invalidRequest }
        let visibleASCII = CharacterSet(charactersIn: "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~")
        if let clientID {
            guard !clientID.isEmpty, clientID.utf8.count <= 512,
                  clientID.unicodeScalars.allSatisfy({ visibleASCII.contains($0) }) else { throw HostClientError.invalidRequest }
        }
        if let scope {
            guard !scope.isEmpty, scope.utf8.count <= 1024, !scope.hasPrefix(" "), !scope.hasSuffix(" "), !scope.contains("  "),
                  scope.unicodeScalars.allSatisfy({ $0 == " " || visibleASCII.contains($0) }) else { throw HostClientError.invalidRequest }
        }
        let authorization = try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/oauth/start", method: "POST",
                                              body: McpOAuthBody(clientId: clientID, scope: scope, expectedInstancePin: expectedInstancePin), mcpPrivateAuthenticationErrors: true,
                                              beforeDispatch: beforeDispatch, as: McpOAuthResponse.self).authorization
        let url = authorization.authorizationUrl
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? "")
        guard url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
              url.scheme?.lowercased() == "https" || (url.scheme?.lowercased() == "http" && loopback),
              authorization.expiresAt.isFinite, authorization.expiresAt > 0,
              authorization.expiresAt <= 9_007_199_254_740_991 else { throw HostClientError.contractMismatch }
        return authorization
    }

    private func changeMcpCredentials(serverID: String, action: String) async throws -> McpCredentialStatus {
        try requireLocalMcpAccess()
        return try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/credentials/\(action)", method: "POST",
                                 body: McpEmptyBody(), mcpPrivateAuthenticationErrors: true, as: McpCredentialsResponse.self).credentials
    }

    func mcpServers() async throws -> [McpServerSummary] {
        try requireConnections(.mcpRead)
        return try await request("/v1/mcp/servers", as: McpServersResponse.self).servers
    }

    func previewMcpImport(format: String, content: String) async throws -> McpImportPreview {
        try requireLocalMcpAccess()
        guard ["claude_json", "codex_toml"].contains(format), content.utf8.count <= 1_000_000 else { throw HostClientError.invalidRequest }
        return try await request("/v1/mcp/import-preview", method: "POST", body: McpImportBody(format: format, content: content))
    }

    func addMcpServer(definition: JSONValue) async throws -> McpServerSummary {
        try requireLocalMcpAccess()
        return try await request("/v1/mcp/servers", method: "POST", body: McpAddBody(definition: definition), as: McpServerResponse.self).server
    }

    /// `expectedInstancePin`: refuse if the instance changed since the owner's plan. `httpOnly`: refuse a local process
    /// (a consented read of an HTTP server never starts code). Without options this is the legacy owner discovery.
    func discoverMcpServer(id: String, expectedInstancePin: String? = nil, httpOnly: Bool = false) async throws -> [McpToolSummary] {
        try requireLocalMcpAccess()
        if let expectedInstancePin, !McpAuthorizationHandoff.validHash(expectedInstancePin) { throw HostClientError.invalidRequest }
        let body = McpDiscoverBody(expectedInstancePin: expectedInstancePin, httpOnly: httpOnly ? true : nil)
        return try await request("/v1/mcp/servers/\(try mcpSegment(id))/discover", method: "POST", body: body, as: McpDiscoveryResponse.self).tools
    }

    /// Read-only review state of a local process (nil when this host does not report it).
    func mcpCommandStatus(serverID: String) async throws -> McpCommandStatus? {
        try requireConnections(.mcpRead)
        let value: McpCommandStatus? = try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/command-status")
        if let value, !value.isValid { throw HostClientError.contractMismatch }
        return value
    }

    func mcpTools(serverID: String) async throws -> [McpToolSummary] {
        try requireConnections(.mcpRead)
        return try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/tools", as: McpToolsResponse.self).tools
    }

    func mcpSelection(serverID: String, botID: String) async throws -> McpBotSelection {
        try requireConnections(.mcpRead)
        return try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/bots/\(try mcpSegment(botID))")
    }

    func saveMcpSelection(serverID: String, botID: String, toolIDs: [String]) async throws -> McpBotSelection {
        try requireLocalMcpAccess()
        return try await request("/v1/mcp/servers/\(try mcpSegment(serverID))/bots/\(try mcpSegment(botID))", method: "PUT", body: McpSelectionBody(toolIds: toolIDs.sorted()))
    }

    func removeMcpServer(id: String) async throws {
        try requireLocalMcpAccess()
        let result: McpRemovedResponse = try await request("/v1/mcp/servers/\(try mcpSegment(id))", method: "DELETE", body: McpEmptyBody())
        guard result.removed else { throw HostClientError.mutationOutcomeUnknown }
    }

    private func requireLocalMcpAccess() throws {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
    }
}

private func mcpSegment(_ value: String) throws -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.:")
    guard !value.isEmpty, value.utf8.count <= 256, value != ".", value != "..",
          value.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { throw HostClientError.invalidRequest }
    return value
}

public struct McpAuthorizationObservation: Sendable {
    public let credentials: McpCredentialStatus
    public let servers: [McpServerSummary]?
}

public extension HostClient {
    /// Only public GETs. Completing OAuth never authorizes discovery, selection or invocation.
    func readMcpAuthorizationStep(serverID: String) async throws -> McpAuthorizationObservation {
        let credentials = try await mcpCredentials(serverID: serverID)
        guard credentials.serverId == serverID else { throw HostClientError.contractMismatch }
        let servers = credentials.state == "authorizing" ? nil : try await mcpServers()
        return McpAuthorizationObservation(credentials: credentials, servers: servers)
    }
}
