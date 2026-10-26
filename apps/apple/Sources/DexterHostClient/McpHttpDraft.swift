import Foundation

/// A reviewed, deterministic HTTP definition. Constructing a draft never contacts its address.
public struct McpHttpDraft: Equatable, Sendable {
    public enum Authentication: String, CaseIterable, Sendable { case none, broker, oauth }
    public let serverID: String
    public let name: String
    public let url: String
    public let authentication: Authentication
    public let definition: JSONValue

    public init(name: String, url: String, authentication: Authentication, serverID: String) throws {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty, cleanName.utf16.count <= 120,
              cleanName.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { throw McpHttpDraftError.invalidName }
        let canonicalURL = try Self.normalizeURL(url)
        let id = serverID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard id.range(of: "^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$", options: .regularExpression) != nil else { throw McpHttpDraftError.invalidID }
        self.serverID = id; self.name = cleanName; self.url = canonicalURL; self.authentication = authentication
        let headers: [String: JSONValue] = authentication == .broker
            ? ["authorization": .object(["kind": .string("secret"), "key": .string("token"), "prefix": .string("Bearer ")])] : [:]
        definition = .object([
            "id": .string(id), "name": .string(cleanName),
            "transport": .object(["type": .string("streamable_http"), "url": .string(canonicalURL), "headers": .object(headers)]),
            "runsOn": .string("any"), "auth": .string(authentication.rawValue),
            "readOnlyTools": .array([]), "enabledTools": .null, "disabledTools": .array([]),
            "limits": .object(["connectTimeoutMs": .integer(15_000), "callTimeoutMs": .integer(60_000),
                               "maxResultBytes": .integer(1_048_576), "maxMessageBytes": .integer(4_194_304)]),
            "source": .object(["format": .string("manual"), "name": .string(id)])
        ])
    }

    public func matches(_ summary: McpServerSummary) -> Bool {
        summary.id == serverID && summary.name == name && summary.transport == "streamable_http" &&
            summary.runsOn == "any" && summary.auth == authentication.rawValue && summary.destination == url
    }

    private static func normalizeURL(_ raw: String) throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 2048,
              text.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value != 127 }), !text.contains("\\") else { throw McpHttpDraftError.invalidURL }
        // Reject even empty query/fragment markers; no credential-shaped URL ever enters a draft or error.
        guard !text.contains("?"), !text.contains("#") else { throw McpHttpDraftError.secretURL }
        guard var components = URLComponents(string: text), let scheme = components.scheme?.lowercased(),
              text.lowercased().hasPrefix(scheme + "://"), let host = components.host?.lowercased(), !host.isEmpty else { throw McpHttpDraftError.invalidURL }
        guard components.user == nil, components.password == nil else { throw McpHttpDraftError.secretURL }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { throw McpHttpDraftError.insecureURL }
        if let port = components.port { guard (1...65535).contains(port) else { throw McpHttpDraftError.invalidURL } }
        components.scheme = scheme; components.host = host
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) { components.port = nil }
        // WHATWG removes dot segments, including percent-encoded dots. Preserve every other path byte.
        let input = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        var parts: [String] = []
        let segments = input.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        for (index, segment) in segments.enumerated() {
            let rawSegment = String(segment)
            let dot = rawSegment.replacingOccurrences(of: "%2e", with: ".", options: .caseInsensitive)
            if dot == "." { if index == segments.count - 1 { parts.append("") } }
            else if dot == ".." { if !parts.isEmpty { parts.removeLast() }; if index == segments.count - 1 { parts.append("") } }
            else { parts.append(rawSegment) }
        }
        components.percentEncodedPath = "/" + parts.joined(separator: "/")
        guard let value = components.url?.absoluteString, value.utf16.count <= 2048 else { throw McpHttpDraftError.invalidURL }
        return value
    }
}

public enum McpHttpDraftError: String, Error, LocalizedError, Sendable {
    case invalidName, invalidID, invalidURL, secretURL, insecureURL
    public var errorDescription: String? {
        switch self {
        case .invalidName: String(localized: "Informe um nome de até 120 caracteres, sem caracteres de controle.")
        case .invalidID: String(localized: "Use um ID de até 40 caracteres: comece com uma letra minúscula e use letras, números ou hífens.")
        case .invalidURL: String(localized: "Informe o endereço HTTP MCP completo fornecido pelo serviço.")
        case .secretURL: String(localized: "O endereço não pode conter usuário, senha, consulta (?) ou fragmento (#). Use a autorização privada.")
        case .insecureURL: String(localized: "Use HTTPS. HTTP simples só é aceito para localhost, 127.0.0.1 ou ::1.")
        }
    }
}

/// Readiness depends on public host state and the saved selection, never on a successful HTTP query alone.
public enum McpSetupStep: String, Sendable {
    case registered, authorizationRequired, discoveryRequired, toolsAvailable, selectionRequired, ready, unavailable, discoveryFailed, checking

    public static func derive(server: McpServerSummary, credentials: McpCredentialStatus?, tools: [McpToolSummary], savedToolIDs: Set<String>, selectedBotID: String) -> Self {
        guard server.status != "unavailable_here" else { return .unavailable }
        guard let credentials, credentials.serverId == server.id, credentials.auth == server.auth else { return .checking }
        guard credentials.isReady else { return credentials.state == "unavailable" ? .unavailable : .authorizationRequired }
        if server.status == "needs_auth" { return server.auth == "none" ? .authorizationRequired : .discoveryRequired }
        if server.status == "failed" { return .discoveryFailed }
        guard server.status == "ready" else { return .discoveryRequired }
        let publishable = Set(tools.filter { $0.state == "publishable" }.map(\.id))
        guard !publishable.isEmpty else { return .toolsAvailable }
        guard !selectedBotID.isEmpty, !savedToolIDs.intersection(publishable).isEmpty else { return .selectionRequired }
        return .ready
    }
}

public extension HostClient {
    /// Owner UI registration: no fetch, unlock, discovery or selection is implicit in this POST.
    func addHttpMcpServer(_ draft: McpHttpDraft) async throws -> McpServerSummary {
        let result: McpServerSummary
        do { result = try await addMcpServer(definition: draft.definition) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard draft.matches(result) else { throw HostClientError.mutationOutcomeUnknown }
        return result
    }

    /// Reconcile only the original reviewed identity. Missing/mismatched public metadata cannot prove an unapplied POST.
    func readHttpMcpRegistration(_ draft: McpHttpDraft) async throws -> McpServerSummary? {
        let result = try await mcpServers().first { $0.id == draft.serverID }
        guard let result else { return nil }
        guard draft.matches(result) else { throw HostClientError.conflict }
        return result
    }
}
