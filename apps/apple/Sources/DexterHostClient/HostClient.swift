import Foundation
import CryptoKit
import DexterClientIdentity

public enum HostAccessPolicy: Sendable {
    case loopbackDevelopment
    case unpairedHost
    case pairedHost(PairedHostBinding)
}

public enum HostClientError: Error, Equatable, Sendable, LocalizedError {
    case invalidConfiguration
    case remotePairingUnavailable
    case offline
    case invalidRequest
    case forbidden
    case notFound
    case conflict
    case notReady
    case hostFailure
    case contractMismatch
    case mutationOutcomeUnknown
    case deviceMutationOutcomeUnknown
    case approvalExpired

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration: String(localized: "Endereço do host inválido.")
        case .remotePairingUnavailable: String(localized: "Pareamento remoto ainda não está disponível.")
        case .offline: String(localized: "Não foi possível conectar ao host local.")
        case .invalidRequest: String(localized: "O host recusou esta solicitação.")
        case .forbidden: String(localized: "O host não autorizou esta operação.")
        case .notFound: String(localized: "O item não existe mais no host.")
        case .conflict: String(localized: "O estado mudou no host. Atualize e tente novamente.")
        case .notReady: String(localized: "O runtime do host ainda não está conectado.")
        case .hostFailure: String(localized: "O host não conseguiu concluir esta operação.")
        case .contractMismatch: String(localized: "A resposta do host não corresponde ao contrato esperado.")
        case .mutationOutcomeUnknown: String(localized: "O host pode ter aplicado a operação. Reconcilie o estado antes de tentar novamente.")
        case .deviceMutationOutcomeUnknown: String(localized: "O host pode ter aplicado a alteração. Confirme o estado antes de tentar outra vez.")
        case .approvalExpired: String(localized: "Esta aprovação expirou. Atualize a lista de ações.")
        }
    }
}

public struct TransportResponse: Sendable {
    public let statusCode: Int
    public let data: Data

    public init(statusCode: Int, data: Data) {
        self.statusCode = statusCode
        self.data = data
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> TransportResponse
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse
    func beginClose() -> Task<Void,Never>
}
public extension HTTPTransport {
    func beginClose() -> Task<Void,Never> { Task {} }
    func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse { try await send(request) }
}

public struct URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> TransportResponse {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw HostClientError.contractMismatch
        }
        return TransportResponse(statusCode: response.statusCode, data: data)
    }

    public func sendWithoutRedirects(_ request: URLRequest) async throws -> TransportResponse {
        // Attachments may never follow a redirect to another host or send bytes to a paired endpoint.
        let protected = URLSession(configuration: .ephemeral, delegate: AttachmentRedirectGuard(), delegateQueue: nil)
        defer { protected.finishTasksAndInvalidate() }
        let (data, response) = try await protected.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url else { throw HostClientError.contractMismatch }
        return TransportResponse(statusCode: response.statusCode, data: data)
    }
}

private final class AttachmentRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Read-only progress of the host's durable receipt delivery. This never authorizes or resumes work.
public struct ActionContinuationProgress: Decodable, Equatable, Sendable {
    public let originTurnId: String
    public let deliveredToEngine: Bool
    public let responseTurnId: String?
    public let responseState: TurnState?
    public let originValid: Bool
    public let resultBodyAvailable: Bool
}

/// HTTP client for the version 1 local host API. Remote host access stays closed until pairing exists.
public struct HostClient: Sendable {
    public static let protocolVersion = 1

    public let baseURL: URL
    public let accessPolicy: HostAccessPolicy
    private let transport: any HTTPTransport
    private let lifetime = HostClientLifetime()

    public init(
        baseURL: URL,
        accessPolicy: HostAccessPolicy = .loopbackDevelopment,
        transport: any HTTPTransport = URLSessionTransport()
    ) {
        self.baseURL = baseURL
        self.accessPolicy = accessPolicy
        self.transport = transport
    }

    @discardableResult public func close() -> Task<Void,Never> { lifetime.close(transport:transport) }
    public static func paired(binding: PairedHostBinding, lifecycle: ClientIdentityLifecycle) async throws -> HostClient {
        let adapter = try await PairedHTTPTransport(binding:binding,lifecycle:lifecycle)
        return HostClient(baseURL:binding.host.url,accessPolicy:.pairedHost(binding),transport:adapter)
    }
    private var pageLimit: Int { if case .pairedHost = accessPolicy { return 1 }; return 500 }
    public func health() async throws -> HostHealth {
        let value: HostHealth = try await request("/health", timeout: 15, cachePolicy: .reloadIgnoringLocalCacheData)
        guard value.protocolVersion == Self.protocolVersion else { throw HostClientError.contractMismatch }
        switch accessPolicy {
        case .pairedHost(let binding):
            guard value.mode == "paired-client", value.remotePairing == "implemented", value.installationId == binding.installationID,
                  value.client?.deviceId == binding.deviceID, value.client?.role == binding.role.rawValue,
                  value.client?.scopes == binding.scopes.map(\.rawValue), value.client?.pinGeneration == binding.pinGeneration,
                  value.client?.bindingRevision == binding.bindingRevision else { throw HostClientError.contractMismatch }
        default: guard value.mode == "local-development", value.hostId != nil, value.state != nil else { throw HostClientError.contractMismatch }
        }
        return value
    }

    /// NativeMCP2 registration. The caller owns one stable original request and recovery; no legacy fallback.
    public func registerMcpServer(_ original: McpRegistrationRequest, namespace: McpRegistrationNamespace) async throws -> McpRegistrationReceipt {
        guard baseURL == namespace.baseURL else { throw HostClientError.invalidConfiguration }
        let value: McpRegistrationPostResponse = try await mcpRegistrationRequest("/v1/mcp/registrations", method: "POST", body: original.bodyData)
        try value.receipt.validate(for: original, namespace: namespace)
        return value.receipt
    }

    /// Only reads this owner's original request key. A missing receipt is not proof that an uncertain effect did not occur.
    public func mcpRegistrationReceipt(_ original: McpRegistrationRequest, namespace: McpRegistrationNamespace) async throws -> McpRegistrationObservation? {
        guard baseURL == namespace.baseURL else { throw HostClientError.invalidConfiguration }
        let value: McpRegistrationReadResponse = try await mcpRegistrationRequest("/v1/mcp/registrations/\(original.requestID)")
        if let registration = value.registration { try registration.receipt.validate(for: original, namespace: namespace) }
        return value.registration
    }

    private func mcpRegistrationRequest<Value: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Value {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        try lifetime.admit(); defer { lifetime.finish() }
        var request = URLRequest(url: try makeURL(path, query: []))
        request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let response: TransportResponse
        do { response = try await transport.sendWithoutRedirects(request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as HostClientError { throw error }
        catch { throw HostClientError.offline }
        do { try lifetime.assertOpen() } catch { throw method == "POST" ? HostClientError.mutationOutcomeUnknown : .contractMismatch }
        guard (200..<300).contains(response.statusCode) else { throw Self.safeError(for: response.statusCode) }
        guard response.data.count <= 4096 else { throw HostClientError.contractMismatch }
        do { return try JSONDecoder().decode(Value.self, from: response.data) }
        catch { throw HostClientError.contractMismatch }
    }

    public func contracts() async throws -> HostContracts {
        let value: HostContracts = try await request("/v1/contracts")
        guard value.protocolVersion == Self.protocolVersion else { throw HostClientError.contractMismatch }; return value
    }
    public func engineCatalog() async throws -> [EngineCatalogEntry] {
        let value: EngineCatalog = try await request("/v1/engines/catalog", timeout: 15, cachePolicy: .reloadIgnoringLocalCacheData)
        guard value.items.count <= 32, Set(value.items.map(\.id)).count == value.items.count else { throw HostClientError.contractMismatch }
        return value.items
    }
    public func threadEngineSelection(threadID: String) async throws -> ThreadEngineSelection {
        let value: ThreadEngineSelection = try await request("/v1/threads/\(pathSegment(threadID))/engine-selection")
        guard value.revision >= 0 else { throw HostClientError.contractMismatch }; return value
    }
    public func updateThreadEngineSelection(threadID: String, input: PatchThreadEngineSelection) async throws -> ThreadEngineSelection {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.expectedRevision >= 0, input.expectedRevision < Int.max else { throw HostClientError.invalidRequest }
        if input.scope == .threadAndBot {
            guard input.selection != nil, let revision = input.expectedBotRevision, revision >= 0, revision < Int.max else { throw HostClientError.invalidRequest }
        }
        let value: ThreadEngineSelection
        do { value = try await request("/v1/threads/\(pathSegment(threadID))/engine-selection", method: "PATCH", body: input) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.revision == input.expectedRevision + 1 else { throw HostClientError.mutationOutcomeUnknown }
        if input.scope == .threadAndBot {
            guard let bot = value.updatedBot, let revision = input.expectedBotRevision,
                  bot.revision == revision + 1, bot.defaultSelection == input.selection,
                  value.selection == input.selection, value.override == input.selection else { throw HostClientError.mutationOutcomeUnknown }
        }
        return value
    }
    public func getBot(id: String) async throws -> Bot { try await request("/v1/bots/\(pathSegment(id))") }
    public func appendMessage(threadID: String, input: AppendMessageInput) async throws -> Message {
        let value: Message = try await request("/v1/threads/\(pathSegment(threadID))/messages",method:"POST",body:input)
        guard value.threadId == threadID, value.clientMessageId == input.clientMessageId else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func resumeQueued(threadID: String) async throws -> ResumeQueuedAcknowledgment {
        let value: ResumeQueuedAcknowledgment
        do { value = try await request("/v1/threads/\(pathSegment(threadID))/resume-queued",method:"POST",body:EmptyBody()) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.resumed >= 0 else { throw HostClientError.mutationOutcomeUnknown }; return value
    }
    public func listBots() async throws -> [Bot] {
        try await listOwned("/v1/bots",as:Bot.self)
    }

    public func createBot(_ input: CreateBotInput) async throws -> Bot {
        guard input.avatarImageId.map(avatarImageUUID) ?? true,
              input.avatarAppearance?.isValid ?? true else { throw HostClientError.invalidRequest }
        let bot: Bot = try await request("/v1/bots", method: "POST", body: input)
        guard bot.avatarImage?.id == input.avatarImageId else { throw HostClientError.mutationOutcomeUnknown }
        guard bot.avatarAppearance == input.avatarAppearance else { throw HostClientError.mutationOutcomeUnknown }
        return bot
    }

    public func updateBot(id: String, input: PatchBotInput) async throws -> Bot {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard input.expectedRevision >= 0, input.expectedRevision < Int.max else { throw HostClientError.invalidRequest }
        if case .set(let appearance) = input.avatarAppearance, !appearance.isValid { throw HostClientError.invalidRequest }
        let updated: Bot
        do { updated = try await request("/v1/bots/\(pathSegment(id))", method: "PATCH", body: input) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard updated.id == id, updated.revision == input.expectedRevision + 1,
              !updated.isMaster || updated.canSeeBots else { throw HostClientError.mutationOutcomeUnknown }
        switch input.avatarImageId {
        case .unchanged: break
        case .set(let imageID): guard updated.avatarImage?.id == imageID else { throw HostClientError.mutationOutcomeUnknown }
        case .clear: guard updated.avatarImage == nil else { throw HostClientError.mutationOutcomeUnknown }
        }
        switch input.avatarAppearance {
        case .unchanged: break
        case .set(let appearance): guard updated.avatarAppearance == appearance else { throw HostClientError.mutationOutcomeUnknown }
        case .clear: guard updated.avatarAppearance == nil else { throw HostClientError.mutationOutcomeUnknown }
        }
        return updated
    }

    public func listBotDelegations(botID: String) async throws -> [BotDelegation] {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let response: ItemEnvelope<BotDelegation> = try await request(
            "/v1/bot-delegations", query: [URLQueryItem(name: "botId", value: botID)], timeout: 15)
        guard response.items.count <= 500,
              Set(response.items.map(\.id)).count == response.items.count,
              response.items.allSatisfy({ $0.sourceBotId == botID || $0.targetBotId == botID }) else {
            throw HostClientError.contractMismatch
        }
        return response.items
    }

    public func getBotDelegation(id: String) async throws -> BotDelegation {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BotDelegation = try await request("/v1/bot-delegations/\(pathSegment(id))", timeout: 15)
        guard value.id == id else { throw HostClientError.contractMismatch }
        return value
    }

    public func cancelBotDelegation(id: String) async throws -> BotDelegation {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        let value: BotDelegation
        do {
            value = try await request("/v1/bot-delegations/\(pathSegment(id))/cancel", method: "POST", body: EmptyBody(), timeout: 15)
        } catch is CancellationError {
            throw HostClientError.mutationOutcomeUnknown
        } catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        guard value.id == id else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }

    public func listSkills(skillID: String? = nil, after: String? = nil) async throws -> SkillsPage {
        try requireLocalSkillsAccess()
        if let skillID, !SkillRegistrationInput.validID(skillID) { throw HostClientError.invalidRequest }
        try validateSkillCursor(after)
        var query = [URLQueryItem(name: "limit", value: "50")]
        if let skillID { query.append(URLQueryItem(name: "skillId", value: skillID)) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        let page: SkillsPage = try await request("/v1/skills", query: query, timeout: 15)
        guard page.items.count <= 50, page.items.allSatisfy(\.isValid), Set(page.items.map(\.identity)).count == page.items.count,
              skillID.map({ id in page.items.allSatisfy { $0.id == id } }) ?? true else { throw HostClientError.contractMismatch }
        try validateSkillCursor(page.next)
        guard page.next == nil || (!page.items.isEmpty && page.next != after) else { throw HostClientError.contractMismatch }
        return page
    }
    public func getSkillVersion(id: String, version: String) async throws -> SkillVersion {
        try requireLocalSkillsAccess()
        guard SkillRegistrationInput.validID(id), SkillRegistrationInput.validVersion(version) else { throw HostClientError.invalidRequest }
        let value: SkillVersion = try await request("/v1/skills/\(pathSegment(id))/versions/\(pathSegment(version))", timeout: 15)
        guard value.lock.isValid, value.lock.id == id, value.lock.version == version,
              !value.markdown.isEmpty, value.markdown.utf16.count <= 32768 else { throw HostClientError.contractMismatch }
        return value
    }
    public func registerSkill(_ input: SkillRegistrationInput) async throws -> SkillLock {
        try requireLocalSkillsAccess()
        guard input.isValid else { throw HostClientError.invalidRequest }
        let value: SkillLock = try await skillsMutation("/v1/skills", method: "POST", body: input)
        guard value.isValid, value.id == input.id, value.version == input.version else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    public func listSkillActivations(scope: SkillScope, after: String? = nil) async throws -> SkillActivationsPage {
        try requireLocalSkillsAccess()
        guard scope.isValid else { throw HostClientError.invalidRequest }; try validateSkillCursor(after)
        var query = [URLQueryItem(name: "scopeKind", value: scope.kind), URLQueryItem(name: "limit", value: "50")]
        if let botID = scope.botID { query.append(URLQueryItem(name: "botId", value: botID)) }
        if let after { query.append(URLQueryItem(name: "after", value: after)) }
        let page: SkillActivationsPage = try await request("/v1/skill-activations", query: query, timeout: 15)
        guard page.items.count <= 50, page.items.allSatisfy({ $0.isValid && $0.scope == scope && $0.lock != nil }),
              Set(page.items.map(\.skillId)).count == page.items.count else { throw HostClientError.contractMismatch }
        try validateSkillCursor(page.next)
        guard page.next == nil || (!page.items.isEmpty && page.next != after) else { throw HostClientError.contractMismatch }
        return page
    }
    public func setSkillActivation(skillID: String, input: SkillActivationInput) async throws -> SkillActivation {
        try requireLocalSkillsAccess()
        guard SkillRegistrationInput.validID(skillID), input.scope.isValid,
              input.version.map(SkillRegistrationInput.validVersion) ?? true,
              input.expected.map({ SkillRegistrationInput.validVersion($0.version) && $0.sha256.range(of: "^[0-9a-f]{64}\\z", options: .regularExpression) != nil }) ?? true else { throw HostClientError.invalidRequest }
        let value: SkillActivation = try await skillsMutation("/v1/skill-activations/\(pathSegment(skillID))", method: "PUT", body: input)
        guard value.isValid, value.scope == input.scope, value.skillId == skillID, value.lock?.version == input.version else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
    private func requireLocalSkillsAccess() throws {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
    }
    private func validateSkillCursor(_ cursor: String?) throws {
        if let cursor, cursor.isEmpty || cursor.utf8.count > 4096 || cursor.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { throw HostClientError.invalidRequest }
    }
    private func skillsMutation<Value: Decodable & Sendable>(_ path: String, method: String, body: any Encodable) async throws -> Value {
        do { return try await request(path, method: method, body: body, timeout: 15) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
    }

    public func getThread(id: String) async throws -> HostThread {
        try await request("/v1/threads/\(pathSegment(id))")
    }

    public func createThread(botID: String) async throws -> HostThread {
        try await request("/v1/bots/\(pathSegment(botID))/threads", method: "POST", body: EmptyBody())
    }

    public func listThreads(botID: String) async throws -> [HostThread] {
        var cursor: Int64 = 0
        var ids: [String] = []
        var seen: Set<String> = []
        var pages = 0
        while true {
            pages += 1; guard pages <= 1000 else { throw HostClientError.contractMismatch }
            let page: HostEventsPage = try await request(
                "/v1/events",
                query: [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(pageLimit))]
            )
            for event in page.items where event.kind == .threadCreated && event.botId == botID && event.audience != .group && event.groupId == nil {
                if seen.insert(event.entityId).inserted { ids.append(event.entityId) }
            }
            guard page.nextCursor > cursor, page.items.count == pageLimit else { break }
            cursor = page.nextCursor
        }
        return try await withThrowingTaskGroup(of: HostThread.self) { group in
            for id in ids { group.addTask { try await getThread(id: id) } }
            var result: [HostThread] = []
            for try await thread in group { result.append(thread) }
            return result.filter(\.isPrivateConversation).sorted { $0.createdAt < $1.createdAt }
        }
    }

    public func listMessages(threadID: String, after cursor: Int64 = 0, limit: Int = 100) async throws -> MessagesPage {
        let page: MessagesPage = try await request(
            "/v1/threads/\(pathSegment(threadID))/messages",
            query: [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(limit))]
        )
        try validatePage(page.items.map(\.cursor),after:cursor,next:page.nextCursor,limit:limit)
        guard page.items.allSatisfy({ message in
            let images = message.attachments ?? []
            return message.threadId == threadID && images.count <= 4 && Set(images.map(\.id)).count == images.count
                && images.allSatisfy { validAttachment($0, threadID: threadID) }
        }) else { throw HostClientError.contractMismatch }
        return page
    }

    public func allMessages(threadID: String) async throws -> [Message] {
        var cursor: Int64 = 0
        var result: [Message] = []
        var pages = 0
        while true {
            pages += 1; guard pages <= 1000 else { throw HostClientError.contractMismatch }
            let page = try await listMessages(threadID: threadID, after: cursor, limit: pageLimit)
            result.append(contentsOf: page.items)
            guard page.nextCursor > cursor, page.items.count == pageLimit else { break }
            cursor = page.nextCursor
        }
        return result
    }

    public func listTurns(threadID: String, after cursor: Int64 = 0, limit: Int = 100) async throws -> TurnsPage {
        let page: TurnsPage = try await request(
            "/v1/threads/\(pathSegment(threadID))/turns",
            query: [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(limit))]
        )
        try validatePage(page.items.map(\.cursor),after:cursor,next:page.nextCursor,limit:limit)
        guard page.items.allSatisfy({$0.threadId == threadID}) else { throw HostClientError.contractMismatch }
        return page
    }

    public func allTurns(threadID: String) async throws -> [Turn] {
        var cursor: Int64 = 0
        var result: [Turn] = []
        var pages = 0
        while true {
            pages += 1; guard pages <= 1000 else { throw HostClientError.contractMismatch }
            let page = try await listTurns(threadID: threadID, after: cursor, limit: pageLimit)
            result.append(contentsOf: page.items)
            guard page.nextCursor > cursor, page.items.count == pageLimit else { break }
            cursor = page.nextCursor
        }
        return result
    }

    public func startTurn(threadID: String, submission: TurnSubmission) async throws -> Turn {
        if submission.attachmentIds?.isEmpty == false { try requireLocalImageAccess() }
        return try await request("/v1/threads/\(pathSegment(threadID))/turns", method: "POST", body: submission)
    }

    public func uploadChatImage(threadID: String, clientAttachmentID: String, data: Data) async throws -> ChatAttachment {
        try requireLocalImageAccess()
        guard canonicalAttachmentID(clientAttachmentID), let dimensions = pngDimensions(data) else { throw HostClientError.invalidRequest }
        let value: ChatAttachment = try await request("/v1/threads/\(pathSegment(threadID))/attachments", method: "POST",
            body: ChatAttachmentUpload(clientAttachmentId: clientAttachmentID, data: data), localAttachmentRequest: true)
        guard validAttachment(value, threadID: threadID), value.id == clientAttachmentID, value.bytes == data.count,
              value.width == dimensions.0, value.height == dimensions.1, value.sha256 == imageDigest(data) else { throw HostClientError.contractMismatch }
        return value
    }

    public func downloadChatImage(_ attachment: ChatAttachment, threadID: String) async throws -> Data {
        try requireLocalImageAccess()
        guard validAttachment(attachment, threadID: threadID) else { throw HostClientError.contractMismatch }
        try lifetime.admit(); defer { lifetime.finish() }
        var request = URLRequest(url: try makeURL("/v1/threads/\(pathSegment(threadID))/attachments/\(pathSegment(attachment.id))", query: []))
        request.setValue("image/png", forHTTPHeaderField: "Accept"); request.timeoutInterval = 30
        let response: TransportResponse
        do { response = try await transport.sendWithoutRedirects(request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as HostClientError { throw error }
        catch { throw HostClientError.offline }
        try lifetime.assertOpen()
        guard (200..<300).contains(response.statusCode) else { throw Self.safeError(for: response.statusCode) }
        guard let dimensions = pngDimensions(response.data), response.data.count == attachment.bytes,
              dimensions.0 == attachment.width, dimensions.1 == attachment.height,
              imageDigest(response.data) == attachment.sha256 else { throw HostClientError.contractMismatch }
        return response.data
    }

    private func requireLocalImageAccess() throws {
        guard case .loopbackDevelopment = accessPolicy, isLoopbackHTTPBase(baseURL) else { throw HostClientError.remotePairingUnavailable }
    }

    public func getTurn(id: String) async throws -> Turn {
        try await request("/v1/turns/\(pathSegment(id))")
    }

    public func cancelTurn(id: String) async throws -> Turn {
        let value: Turn
        do { value = try await request("/v1/turns/\(pathSegment(id))/cancel", method: "POST", body: EmptyBody()) }
        catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error { case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown; default: throw error }
        }
        guard value.id == id else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }

    public func turnEvents(turnID: String, after cursor: Int64 = 0, limit: Int = 100) async throws -> TurnEventsPage {
        let page: TurnEventsPage = try await request(
            "/v1/turns/\(pathSegment(turnID))/events",
            query: [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(limit))]
        )
        try validatePage(page.items.map(\.cursor),after:cursor,next:page.nextCursor,limit:limit)
        guard page.items.allSatisfy({$0.turnId == turnID}) else { throw HostClientError.contractMismatch }
        return page
    }

    public func hostEvents(after cursor: Int64 = 0, limit: Int = 100) async throws -> HostEventsPage {
        let page: HostEventsPage = try await request(
            "/v1/events",
            query: [URLQueryItem(name: "after", value: String(cursor)), URLQueryItem(name: "limit", value: String(limit))]
        )
        try validatePage(page.items.map(\.cursor),after:cursor,next:page.nextCursor,limit:limit)
        return page
    }

    public func listActions() async throws -> [Action] {
        try await listOwned("/v1/actions",as:Action.self)
    }

    public func actionContinuation(actionID: String) async throws -> ActionContinuationProgress? {
        struct Envelope: Decodable { let continuation: ActionContinuationProgress? }
        let value: Envelope = try await request("/v1/actions/\(pathSegment(actionID))/continuation", timeout: 15)
        if let progress = value.continuation {
            guard !progress.originTurnId.isEmpty,
                  progress.responseTurnId.map({ !$0.isEmpty }) ?? true,
                  (progress.responseTurnId == nil) == (progress.responseState == nil) else {
                throw HostClientError.contractMismatch
            }
        }
        return value.continuation
    }

    public func listDevices() async throws -> [DeviceView] {
        try await listOwned("/v1/devices",as:DeviceView.self)
    }

    public func getDevice(id: String) async throws -> DeviceView {
        let device: DeviceView = try await request("/v1/devices/\(pathSegment(id))")
        guard device.id == id else { throw HostClientError.contractMismatch }
        return device
    }

    public func renameDevice(id: String, name: String) async throws -> DeviceView {
        let normalizedName = DeviceNameNormalizer.normalize(name)
        guard DeviceNameNormalizer.isValid(normalizedName) else {
            throw HostClientError.invalidRequest
        }

        let device: DeviceView = try await request(
            "/v1/devices/\(pathSegment(id))",
            method: "PATCH",
            body: RenameDeviceInput(name: normalizedName)
        )
        guard device.id == id, device.name == normalizedName else {
            if case .pairedHost = accessPolicy { throw HostClientError.mutationOutcomeUnknown }
            throw HostClientError.contractMismatch
        }
        return device
    }

    public func revokeDevice(id: String) async throws -> DeviceView {
        let device: DeviceView = try await request(
            "/v1/devices/\(pathSegment(id))/revoke",
            method: "POST",
            body: EmptyBody()
        )
        guard device.id == id,
              device.presence == .revoked,
              device.revokedAt != nil,
              !device.paired else {
            if case .pairedHost = accessPolicy { throw HostClientError.mutationOutcomeUnknown }
            throw HostClientError.contractMismatch
        }
        return device
    }

    public func presence() async throws {
        let reply: PairedPresence = try await request("/app-client/v1/presence",method:"POST",body:ForegroundPresence())
        guard case .pairedHost(let binding) = accessPolicy, reply.deviceId == binding.deviceID, reply.presence == "online" else { throw HostClientError.contractMismatch }
    }
    public func revokeOwnDevice() async throws -> SelfRevokeAcknowledgment {
        guard case .pairedHost(let binding) = accessPolicy else { throw HostClientError.invalidConfiguration }
        let ack: SelfRevokeAcknowledgment = try await request("/v1/devices/\(pathSegment(binding.deviceID))/revoke",method:"POST",body:EmptyBody())
        guard ack.deviceId == binding.deviceID, ack.status == "revoked" else { throw HostClientError.mutationOutcomeUnknown }
        await close().value; return ack
    }
    public func deviceGrants(botID: String) async throws -> DeviceGrantsPage {
        let reply: DeviceGrantsPage = try await request("/v1/device-grants",query:[URLQueryItem(name:"botId",value:botID)])
        guard reply.botId == botID, reply.items.allSatisfy({$0.botId == botID}) else { throw HostClientError.contractMismatch }; return reply
    }
    public func putDeviceGrant(_ input: DeviceGrantInput) async throws -> DeviceGrant {
        let grant: DeviceGrant = try await request("/v1/device-grants",method:"PUT",body:input)
        guard grant.botId == input.botId, grant.tool == input.tool, grant.destination == input.destination, grant.policy == input.policy else { throw HostClientError.mutationOutcomeUnknown }; return grant
    }

    public func getAction(id: String) async throws -> Action {
        let value: Action = try await request("/v1/actions/\(pathSegment(id))", timeout: 15)
        guard value.id == id else { throw HostClientError.contractMismatch }
        return value
    }

    /// Owner endpoint: an exact manual reply records a decision, never a new engine turn.
    /// Replays intentionally skip GET/state checks: the original action may already be terminal.
    public func confirmCommunication(action displayedAction: Action, input: CommunicationConfirmationInput) async throws -> CommunicationConfirmationResponse {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard let proposal = BotCommunicationProposal(action: displayedAction),
              let decision = CommunicationApprovalText.decision(for: input.text),
              input.actionId == displayedAction.id, input.requestHash == displayedAction.requestHash,
              UUID(uuidString: input.clientRequestId)?.uuidString.lowercased() == input.clientRequestId else {
            throw HostClientError.invalidRequest
        }
        let response: CommunicationConfirmationResponse
        do {
            response = try await request("/v1/threads/\(pathSegment(displayedAction.request.threadId))/communication-confirmations", method: "POST", body: input)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        let receipt = response.receipt
        guard response.action.id == displayedAction.id,
              response.action.request == displayedAction.request,
              response.action.requestHash == displayedAction.requestHash,
              response.bot.id == displayedAction.request.botId,
              receipt.actionId == displayedAction.id, receipt.requestHash == displayedAction.requestHash,
              receipt.clientRequestId == input.clientRequestId, receipt.decision == decision,
              receipt.changes == proposal.changes, receipt.appliesNextTurn,
              receipt.revision == response.bot.revision, receipt.previousRevision >= 0,
              receipt.applied == (decision == .allow),
              response.messages.count >= 1, response.messages.count <= 4,
              Set(response.messages.map(\.id)).count == response.messages.count,
              response.messages.allSatisfy({ $0.threadId == displayedAction.request.threadId && ($0.attachments ?? []).isEmpty }),
              response.messages.contains(where: { $0.role == .user && $0.content == input.text }) else {
            throw HostClientError.mutationOutcomeUnknown
        }
        if decision == .allow {
            guard response.action.state == .succeeded,
                  receipt.previousRevision == proposal.expectedRevision,
                  receipt.revision == proposal.expectedRevision + 1, proposal.changes.matches(response.bot) else {
                throw HostClientError.mutationOutcomeUnknown
            }
        } else {
            guard response.action.state == .denied, receipt.revision == receipt.previousRevision else {
                throw HostClientError.mutationOutcomeUnknown
            }
        }
        return response
    }

    /// Re-fetches the action and compares the displayed request before sending its host-issued hash.
    public func decide(action displayedAction: Action, decision: ApprovalDecision) async throws -> Action {
        let current = try await getAction(id: displayedAction.id)
        guard current.requestHash == displayedAction.requestHash,
              current.request == displayedAction.request,
              current.state == .awaitingApproval else {
            throw HostClientError.conflict
        }
        if let expiresAt = current.approvalExpiresAt,
           Int64(Date().timeIntervalSince1970 * 1_000) >= expiresAt {
            throw HostClientError.approvalExpired
        }
        let input = ApprovalDecisionInput(decision: decision, requestHash: current.requestHash)
        return try await request("/v1/actions/\(pathSegment(current.id))/decisions", method: "POST", body: input)
    }

    private func listOwned<T: Codable & Sendable>(_ path: String, as: T.Type) async throws -> [T] {
        guard case .pairedHost = accessPolicy else { return try await request(path,as:ItemEnvelope<T>.self).items }
        var result: [T] = [], cursor: String?, seen = Set<String>()
        for _ in 0..<1000 {
            var query = [URLQueryItem(name:"limit",value:"25")]; if let cursor { query.append(URLQueryItem(name:"after",value:cursor)) }
            let page: PairedIDPage<T> = try await request(path,query:query)
            guard page.items.count <= 25 else { throw HostClientError.contractMismatch }; result += page.items
            guard let next = page.nextCursor else { return result }
            guard !page.items.isEmpty, (try? ClientResourceID(next)) != nil, seen.insert(next).inserted else { throw HostClientError.contractMismatch }; cursor = next
        }
        throw HostClientError.contractMismatch
    }

    private func validatePage(_ cursors: [Int64], after: Int64, next: Int64, limit: Int) throws {
        guard case .pairedHost = accessPolicy else { return }
        guard cursors.count <= limit, next == (cursors.last ?? after), cursors.allSatisfy({$0 > after}), zip(cursors,cursors.dropFirst()).allSatisfy({$0 < $1}) else { throw HostClientError.contractMismatch }
    }
    func request<Response: Decodable & Sendable>(
        _ path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil,
        timeout: TimeInterval = 60,
        cachePolicy: URLRequest.CachePolicy = .useProtocolCachePolicy,
        localAttachmentRequest: Bool = false,
        mcpPrivateAuthenticationErrors: Bool = false,
        connectionMutationErrors: Bool = false,
        beforeDispatch: (@MainActor @Sendable () throws -> Void)? = nil,
        as responseType: Response.Type = Response.self
    ) async throws -> Response {
        try lifetime.admit(); defer { lifetime.finish() }
        let url = try makeURL(path, query: query)
        var request = URLRequest(url: url)
        request.cachePolicy = cachePolicy
        request.timeoutInterval = timeout
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                let encoder = JSONEncoder()
                // The private-answer envelope uses the host's compact JSON budget, including slash-rich text.
                // Keep every other body on its existing Foundation representation.
                if body is RespondMcpPrivateInputInput { encoder.outputFormatting = .withoutEscapingSlashes }
                request.httpBody = try encoder.encode(AnyEncodable(body))
            }
            catch { throw HostClientError.invalidRequest }
        }

        // Optional owner-editor seam, after URL/body admission and immediately before transport entry.
        // A preflight, serialization, lifetime or cancellation failure cannot mark a mutation as dispatched.
        if let beforeDispatch {
            try lifetime.assertOpen()
            try Task.checkCancellation()
            try await beforeDispatch()
        }
        let response: TransportResponse
        do {
            if localAttachmentRequest { response = try await transport.sendWithoutRedirects(request) }
            else { response = try await transport.send(request) }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as HostClientError {
            throw error
        } catch {
            throw HostClientError.offline
        }

        do { try lifetime.assertOpen() } catch { if method != "GET" { throw HostClientError.mutationOutcomeUnknown }; throw error }
        guard (200..<300).contains(response.statusCode) else {
            // Explicit uncertainty takes precedence over historical 409 mapping. Parse only the bounded code;
            // messages/metadata are neither displayed nor logged. GET remains a read failure, never a mutation.
            if connectionMutationErrors, method != "GET", Self.isUnconfirmedMutation(response) { throw HostClientError.mutationOutcomeUnknown }
            // Domain-specific, closed diagnostics only on explicitly opted-in private owner MCP calls.
            // A generic 409 or stale instance pin stays a conflict.
            if mcpPrivateAuthenticationErrors, case .loopbackDevelopment = accessPolicy,
               Self.isPrivateMcpAuthenticationRoute(path, method: method),
               let diagnostic = McpAuthenticationDiagnosticError.decode(response) { throw diagnostic }
            throw Self.safeError(for: response.statusCode)
        }
        do {
            return try JSONDecoder().decode(responseType, from: response.data)
        } catch {
            if case .pairedHost = accessPolicy, method != "GET" { throw HostClientError.mutationOutcomeUnknown }
            throw HostClientError.contractMismatch
        }
    }

    /// Raw body of one bounded binary GET (output folder export). Same URL admission, lifetime and error mapping as
    /// `request`; no redirect is followed and nothing is decoded, cached, logged or retried here.
    func requestBytes(_ path: String, query: [URLQueryItem], timeout: TimeInterval = 120) async throws -> Data {
        try lifetime.admit(); defer { lifetime.finish() }
        var request = URLRequest(url: try makeURL(path, query: query))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = timeout
        request.httpMethod = "GET"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        let response: TransportResponse
        do { response = try await transport.sendWithoutRedirects(request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch let error as HostClientError { throw error }
        catch { throw HostClientError.offline }
        try lifetime.assertOpen()
        guard (200..<300).contains(response.statusCode) else { throw Self.safeError(for: response.statusCode) }
        return response.data
    }

    private func makeURL(_ path: String, query: [URLQueryItem]) throws -> URL {
        switch accessPolicy {
        case .pairedHost(let binding):
            guard baseURL == binding.host.url, let adapter = transport as? PairedHTTPTransport,
                  adapter.binding.clientFingerprint == binding.clientFingerprint, adapter.binding.installationID == binding.installationID,
                  adapter.binding.deviceID == binding.deviceID, adapter.binding.ownerID == binding.ownerID,
                  adapter.binding.role == binding.role, adapter.binding.scopes == binding.scopes,
                  adapter.binding.pinGeneration == binding.pinGeneration, adapter.binding.bindingRevision == binding.bindingRevision else { throw HostClientError.invalidConfiguration }
        case .unpairedHost:
            throw HostClientError.remotePairingUnavailable
        case .loopbackDevelopment:
            guard isLoopbackHTTPBase(baseURL) else { throw HostClientError.remotePairingUnavailable }
        }

        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw HostClientError.invalidConfiguration
        }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        components.fragment = nil
        guard let url = components.url else { throw HostClientError.invalidConfiguration }
        return url
    }

    private static func safeError(for status: Int) -> HostClientError {
        switch status {
        case 400, 413, 415: .invalidRequest
        case 403: .forbidden
        case 404: .notFound
        case 409: .conflict
        case 503: .notReady
        default: .hostFailure
        }
    }

    private static func isUnconfirmedMutation(_ response: TransportResponse) -> Bool {
        guard response.data.count <= 4_096,
              let object = try? JSONDecoder().decode([String: JSONValue].self, from: response.data),
              object["error"] == .string("outcome_unknown") else { return false }
        return true
    }

    private static func isPrivateMcpAuthenticationRoute(_ path: String, method: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count >= 6, parts[0].isEmpty, parts[1] == "v1", parts[2] == "mcp", parts[3] == "servers",
              !parts[4].isEmpty else { return false }
        if parts.count == 6 { return method == "GET" && parts[5] == "credentials" }
        guard parts.count == 7, method == "POST" else { return false }
        return (parts[5] == "oauth" && parts[6] == "start")
            || (parts[5] == "credentials" && ["unlock", "lock", "disconnect"].contains(String(parts[6])))
    }
}

private func isLoopbackHTTPBase(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme?.lowercased() == "http",
          components.user == nil, components.password == nil,
          components.query == nil, components.fragment == nil,
          components.path.isEmpty || components.path == "/",
          let urlHost = components.host?.lowercased() else {
        return false
    }
    let host = urlHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

private struct EmptyBody: Encodable {}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init(_ value: any Encodable) {
        encodeValue = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}

private func pathSegment(_ value: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
}

private func canonicalAttachmentID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
}

private func validAttachment(_ value: ChatAttachment, threadID: String) -> Bool {
    value.threadId == threadID && canonicalAttachmentID(value.id) && value.mediaType == "image/png"
        && (1...2 * 1_024 * 1_024).contains(value.bytes) && (1...4_096).contains(value.width)
        && (1...4_096).contains(value.height) && value.width * value.height <= 16_000_000
        && value.sha256.utf8.count == 64 && value.sha256.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

private func imageDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func pngDimensions(_ data: Data) -> (Int, Int)? {
    guard (33...2 * 1_024 * 1_024).contains(data.count),
          data.prefix(8).elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]),
          data[12..<16].elementsEqual([73, 72, 68, 82]) else { return nil }
    func integer(_ start: Int) -> Int { data[start..<start + 4].reduce(0) { ($0 << 8) | Int($1) } }
    let width = integer(16), height = integer(20)
    guard (1...4_096).contains(width), (1...4_096).contains(height), width * height <= 16_000_000 else { return nil }
    return (width, height)
}

private struct PairedIDPage<T: Decodable & Sendable>: Decodable, Sendable { let items: [T]; let nextCursor: String? }
private final class HostClientLifetime: @unchecked Sendable {
    private let lock = NSLock(); private var closed = false, active = 0
    private var closeTask: Task<Void,Never>?, waiters: [CheckedContinuation<Void,Never>] = []
    func admit() throws { lock.lock(); defer { lock.unlock() }; guard !closed else { throw CancellationError() }; active += 1 }
    func assertOpen() throws { lock.lock(); defer { lock.unlock() }; guard !closed else { throw CancellationError() } }
    func finish() {
        lock.lock(); active -= 1; let completed = active == 0 ? waiters : []; if active == 0 { waiters = [] }; lock.unlock()
        for c in completed { c.resume() }
    }
    func drain() async { await withCheckedContinuation { c in lock.lock(); if active == 0 { lock.unlock(); c.resume() } else { waiters.append(c); lock.unlock() } } }
    func close(transport: any HTTPTransport) -> Task<Void,Never> {
        lock.lock(); if let closeTask { lock.unlock(); return closeTask }; closed = true
        let native = transport.beginClose(), task = Task { await native.value; await self.drain() }; closeTask = task; lock.unlock(); return task
    }
}

private struct ForegroundPresence: Encodable { let state = "foreground" }
private struct PairedPresence: Decodable, Sendable { let deviceId: String, presence: String }
