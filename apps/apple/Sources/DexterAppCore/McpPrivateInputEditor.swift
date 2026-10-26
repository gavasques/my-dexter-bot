import DexterHostClient
import Foundation
import Observation

/// Private inputs that MCP servers asked during running actions of this base (owner loopback, or a paired base granted
/// `mcp.read` to see them and `mcp.manage` to answer). Answering is one POST bound to the same action and request hash;
/// an uncertain answer is settled only by reading the same input (GET), never by sending it again. Nothing here starts,
/// retries or grants an action, and the server's text is shown as untrusted content.
@MainActor @Observable public final class McpPrivateInputEditor {
    public enum Notice: Equatable, Sendable {
        case loadFailed, unavailable, hostChanged
        /// The host recorded this answer; the action continues on the host.
        case answered(McpPrivateInputState)
        /// The answer's outcome is open: Conferir reads the same input.
        case unknown
        /// A GET showed the input still pending at the same revision: nothing was applied.
        case notApplied
        /// A GET showed the input ended another way (expired, interrupted, answered elsewhere).
        case ended(McpPrivateInputState)
        case conflict, refused, invalidAnswer
    }
    public struct PendingResponse: Equatable, Sendable {
        public let inputID: String, threadID: String, connectionID: String, botID: String
        public let actionID: String, requestHash: String, clientRequestID: String, expectedHostID: String
        public let expectedRevision: Int

        /// Reconciliation needs only identity/revision/UUID. Never retain the submitted values or POST body here.
        fileprivate init(input: McpPrivateInput, request: RespondMcpPrivateInputInput) {
            inputID = input.id; threadID = input.threadId; connectionID = input.connectionId; botID = input.botId
            actionID = input.actionId; requestHash = input.requestHash; clientRequestID = request.clientRequestId
            expectedHostID = request.expectedHostID
            expectedRevision = request.expectedRevision
        }
        fileprivate func matches(_ input: McpPrivateInput) -> Bool {
            input.id == inputID && input.threadId == threadID && input.connectionId == connectionID
                && input.botId == botID && input.actionId == actionID && input.requestHash == requestHash
        }
    }

    private struct InputVersion: Equatable {
        let revision: Int
        let state: McpPrivateInputState
        let action: String, hash: String, connection: String, bot: String, thread: String
        init(_ input: McpPrivateInput) {
            revision = input.revision; state = input.state; action = input.actionId; hash = input.requestHash
            connection = input.connectionId; bot = input.botId; thread = input.threadId
        }
        init(_ summary: McpPrivateInputSummary) {
            revision = summary.revision; state = summary.state; action = summary.actionId; hash = summary.requestHash
            connection = summary.connectionId; bot = summary.botId; thread = summary.threadId
        }
    }

    public private(set) var inputs: [McpPrivateInput] = []
    public private(set) var summaries: [McpPrivateInputSummary] = []
    public private(set) var nextCursor: String?
    public private(set) var showingHistory = false
    public private(set) var retainedRequestCount = 0
    public private(set) var activeRequestCount = 0
    /// False when this base answered that private inputs are unavailable (503); nil until read.
    public private(set) var supported: Bool?
    public private(set) var listIncomplete = false
    public private(set) var invalidRequestCount = 0
    public private(set) var quarantinedRequestCount = 0
    public private(set) var omittedRequestCount = 0
    public private(set) var pending: PendingResponse?
    public private(set) var busy = false
    /// Metadata reads do not block a reviewed answer. Only list navigation waits for its current page.
    public private(set) var listBusy = false
    public private(set) var notice: Notice?
    public let scope: String
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let ownsClient: Bool
    @ObservationIgnored private var hostID: String?
    @ObservationIgnored private var closed = false
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var listGeneration = UUID()
    @ObservationIgnored private var hasLoadedMore = false
    /// High-water metadata for hydrated forms only; an observed changed/terminal request cannot become actionable again.
    private var observedVersions: [String: InputVersion] = [:]
    private var invalidatedInputs: Set<String> = []

    public init(client: HostClient, ownsClient: Bool, scope: String) {
        self.client = client; self.ownsClient = ownsClient; self.scope = scope
    }

    public var canRead: Bool { client.connectionsAccess.mcpRead }
    public var canAnswer: Bool { client.connectionsAccess.mcpManage }

    /// Navigation belongs to the base, even when a page has no summaries from the current conversation.
    public var hasListNavigation: Bool { retainedRequestCount > 0 || showingHistory || nextCursor != nil }
    public func hasVisibleContent(threadID: String? = nil) -> Bool {
        hasListNavigation || !open(threadID: threadID).isEmpty || !visibleSummaries(threadID: threadID).isEmpty
            || pending != nil || listIncomplete
    }

    /// Pending inputs still inside their deadline, optionally of one conversation.
    public func open(threadID: String? = nil, now: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)) -> [McpPrivateInput] {
        inputs.filter { input in input.state == .pending && input.expiresAt > now && isCurrent(input)
            && (threadID.map { input.threadId == $0 } ?? true) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    /// Explicit refresh restarts the metadata window, retaining exact forms the human already opened.
    public func load() async {
        await readPage(.refresh)
    }

    /// Background GET: keep the selected view, loaded pages/cursor and opened forms. No answer or review is consumed.
    public func poll() async {
        await readPage(.poll)
    }

    private enum PageRead: Equatable { case refresh, more, poll }
    private func readPage(_ kind: PageRead) async {
        guard !closed, !busy, !listBusy, canRead else { return }
        let after = kind == .more ? nextCursor : nil
        if kind == .more, after == nil { return }
        let token = listGeneration, history = showingHistory
        listBusy = true
        defer { listBusy = false }
        do {
            if hostID == nil {
                // A paired base answers with its installation id (health() already bound it to the approved binding);
                // the owner loopback answers with its host id. The same id the other editors use for `expectedHostID`.
                let health = try await client.health()
                guard !closed, token == listGeneration, !Task.isCancelled else { return }
                guard let id = health.installationId ?? health.hostId else { notice = .loadFailed; return }
                hostID = id
            }
            let value = try await client.mcpPrivateInputPage(history: history, after: after)
            guard !closed, token == listGeneration, !Task.isCancelled else { return }
            apply(value, kind: kind); supported = true
            if notice == .loadFailed { notice = nil }
        } catch HostClientError.notReady {
            guard !closed, token == listGeneration, !Task.isCancelled else { return }
            supported = false
        } catch {
            guard !closed, token == listGeneration, !Task.isCancelled else { return }
            if pending == nil { notice = .loadFailed }
        }
    }

    private func apply(_ page: McpPrivateInputPage, kind: PageRead) {
        for summary in page.summaries where observedVersions[summary.id] != nil {
            let incoming = InputVersion(summary)
            if incoming.revision >= (observedVersions[summary.id]?.revision ?? 0) {
                if let input = inputs.first(where: { $0.id == summary.id }), incoming != InputVersion(input) { invalidatedInputs.insert(summary.id) }
                observedVersions[summary.id] = incoming
            }
        }
        if kind == .more || (kind == .poll && hasLoadedMore) {
            for summary in page.summaries {
                if let index = summaries.firstIndex(where: { $0.id == summary.id }) {
                    if summary.revision >= summaries[index].revision { summaries[index] = summary }
                } else { summaries.append(summary) }
            }
            summaries.sort { $0.id > $1.id }
        } else {
            summaries = page.summaries
        }
        // Metadata is not an exact detail read and cannot evict an opened form. Legacy hosts already return details.
        for input in page.legacyRequests { replace(input) }
        if kind != .poll || !hasLoadedMore { nextCursor = page.nextCursor }
        if kind == .refresh { hasLoadedMore = false }
        if kind == .more { hasLoadedMore = true }
        retainedRequestCount = page.retainedRequestCount; activeRequestCount = page.activeRequestCount
        listIncomplete = page.incomplete; invalidRequestCount = page.invalidRequestCount
        quarantinedRequestCount = page.quarantinedRequestCount; omittedRequestCount = page.omittedRequestCount
    }

    /// Metadata only; opening one live input performs its exact GET. No bulk schema hydration.
    public func visibleSummaries(threadID:String? = nil) -> [McpPrivateInputSummary] {
        summaries.filter { summary in (threadID.map { summary.threadId == $0 } ?? true)
            && !inputs.contains { $0.id == summary.id && $0.revision == summary.revision && isCurrent($0) } }
    }
    public func open(_ summary:McpPrivateInputSummary) async {
        guard !closed, !busy, canRead, summaries.contains(summary) else { return }
        let metadata = InputVersion(summary)
        if metadata.revision >= (observedVersions[summary.id]?.revision ?? 0) { observedVersions[summary.id] = metadata }
        let token = generation
        busy = true
        listGeneration = UUID()
        defer { busy = false }
        do {
            let value = try await client.mcpPrivateInput(id:summary.id)
            guard !closed, token == generation, !Task.isCancelled else { return }
            guard replace(value) else { notice = pending == nil ? .conflict : .unknown; return }
            if value.state != .pending, pending == nil { notice = .ended(value.state) }
        } catch { if !closed, token == generation, !Task.isCancelled, pending == nil { notice = .loadFailed } }
    }
    public func more() async {
        await readPage(.more)
    }
    public func showHistory(_ history:Bool) async {
        guard !closed, !busy, !listBusy else { return }
        showingHistory = history; nextCursor = nil; hasLoadedMore = false
        await load()
    }

    /// Enviar / Recusar / Cancelar: one POST for this input's current revision with exactly the owner's answer.
    @discardableResult public func respond(_ input: McpPrivateInput, answer: McpPrivateInputAnswer) async -> Bool {
        guard !closed, !busy, canAnswer, pending == nil, input.state == .pending, let hostID,
              inputs.contains(input), isCurrent(input) else { return false }
        guard let request = RespondMcpPrivateInputInput(input: input, hostID: hostID, answer: answer) else { notice = .invalidAnswer; return false }
        let token = generation
        // An already-in-flight page predates this human gesture and cannot replace its exact result or notice.
        listGeneration = UUID()
        pending = PendingResponse(input: input, request: request)
        busy = true
        defer { busy = false }
        do {
            let value = try await client.respondMcpPrivateInput(id: input.id, request)
            guard !closed, token == generation else { return true }
            guard let pending, pending.matches(value), replace(value) else { notice = .unknown; return true }
            self.pending = nil; notice = .answered(value.state)
        } catch HostClientError.mutationOutcomeUnknown {
            if !closed, token == generation { notice = .unknown }
        } catch HostClientError.conflict {
            guard !closed, token == generation else { return true }
            pending = nil
            if let value = try? await client.mcpPrivateInput(id: input.id), !closed, token == generation { replace(value) }
            if !closed, token == generation { notice = .conflict }
        } catch HostClientError.invalidRequest {
            // The host checked the original pattern/format and left this private input pending. A fresh exact
            // review may correct the values on the same action; no automatic repeat or saved values are used.
            if !closed, token == generation { pending = nil; notice = .invalidAnswer }
        } catch HostClientError.forbidden {
            if !closed, token == generation { pending = nil; notice = .refused }
        } catch is CancellationError {
            if !closed, token == generation { notice = .unknown }
        } catch {
            if !closed, token == generation { pending = nil; notice = .loadFailed }
        }
        return true
    }

    /// GET of the same input. Our own answer recorded settles it; the same pending revision means nothing was applied;
    /// any other ended state is shown as it is. Nothing is re-sent.
    public func check() async {
        guard !closed, !busy, canRead, let pending, hostID == pending.expectedHostID else { return }
        let token = generation
        listGeneration = UUID()
        busy = true
        defer { busy = false }
        let value = try? await client.mcpPrivateInput(id: pending.inputID)
        guard !closed, token == generation, !Task.isCancelled else { return }
        guard let value, pending.matches(value), replace(value) else { notice = .unknown; return }
        if value.clientRequestId == pending.clientRequestID {
            self.pending = nil; notice = .answered(value.state)
        } else if value.state == .pending, value.revision == pending.expectedRevision {
            self.pending = nil; notice = .notApplied
        } else if value.state != .pending {
            self.pending = nil; notice = .ended(value.state)
        } else {
            notice = .unknown
        }
    }

    private func isCurrent(_ value: McpPrivateInput) -> Bool {
        !invalidatedInputs.contains(value.id) && (observedVersions[value.id].map { $0 == InputVersion(value) } ?? true)
    }

    @discardableResult private func replace(_ value: McpPrivateInput) -> Bool {
        let version = InputVersion(value)
        if let seen = observedVersions[value.id], seen.revision > version.revision || (seen.revision == version.revision && seen != version) {
            invalidatedInputs.insert(value.id); return false
        }
        observedVersions[value.id] = version
        invalidatedInputs.remove(value.id)
        if let index = inputs.firstIndex(where: { $0.id == value.id }) {
            if value.revision >= inputs[index].revision { inputs[index] = value }
        } else { inputs.append(value) }
        return true
    }

    public func close() {
        guard !closed else { return }
        closed = true
        generation = UUID(); listGeneration = UUID()
        if ownsClient { client.close() }
    }
}

public extension DexterAppModel {
    /// Private MCP inputs of the base this window shows: this Mac's own base over owner loopback, or the paired base when
    /// its owner granted `mcp.read`. Nil otherwise.
    func makeMcpPrivateInputEditor() -> McpPrivateInputEditor? {
        #if os(macOS)
        if !connectionsArePaired, let local = makeLocalMcpClient() {
            return McpPrivateInputEditor(client: local, ownsClient: true, scope: connectionsScope)
        }
        #endif
        guard let remote = remoteConnectionsClient, remote.connectionsAccess.mcpRead else { return nil }
        return McpPrivateInputEditor(client: remote, ownsClient: false, scope: connectionsScope)
    }
}
