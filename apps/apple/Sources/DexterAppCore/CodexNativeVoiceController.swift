#if os(macOS)
import DexterHostClient
import Foundation
import Observation

public struct CodexVoiceScope: Hashable, Sendable {
    public let hostID: String
    public let botID: String
    public let threadID: String
    public init(hostID: String, botID: String, threadID: String) {
        self.hostID = hostID; self.botID = botID; self.threadID = threadID
    }
}
public enum CodexVoicePhase: String, Sendable { case idle, checking, starting, connecting, active, stopping, unconfirmed, failed }
public enum CodexVoiceFailure: Sendable { case backend(NativeVoiceCode), media(CodexVoiceMediaFailure), offline, uncertain, scopeChanged }

@MainActor enum NativeVoiceMediaLease {
    static var holder: UUID?
}

/// Real owner SDK + native media. An uncertain POST is reconciled with its original GET receipt only.
/// This object stays bound to one host/bot/private conversation and never reparents to another window scope.
@MainActor @Observable public final class CodexNativeVoiceController {
    public let scope: CodexVoiceScope
    public private(set) var connectionScope: UUID?
    public var hasLocalMedia: Bool { media != nil }
    public private(set) var phase: CodexVoicePhase = .idle
    public private(set) var status: NativeVoiceStatus?
    public private(set) var session: NativeVoiceSession?
    public private(set) var failure: CodexVoiceFailure?
    public private(set) var muted = false
    public private(set) var transcript: [NativeVoiceEvent] = []
    public private(set) var selectedVoice: String?
    @ObservationIgnored private let client: HostClient
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let mediaFactory: @MainActor () -> any CodexVoiceMedia
    @ObservationIgnored private let canUseAudio: @MainActor () -> Bool
    @ObservationIgnored private let leaseID = UUID()
    @ObservationIgnored private var media: (any CodexVoiceMedia)?
    @ObservationIgnored private var pendingStart: StartNativeVoice?
    @ObservationIgnored private var pendingStop: StopNativeVoice?
    @ObservationIgnored private var watch: Task<Void, Never>?
    @ObservationIgnored private var stopping: Task<Void, Never>?
    @ObservationIgnored private var localConnected = false
    @ObservationIgnored private var answerAccepted = false
    @ObservationIgnored private var cursor: Int64 = 0

    public init(scope: CodexVoiceScope, client: HostClient, isCurrent: @escaping @MainActor () -> Bool,
                mediaFactory: @escaping @MainActor () -> any CodexVoiceMedia = { NativeCodexVoiceMedia() },
                canUseAudio: @escaping @MainActor () -> Bool = { true }) {
        self.scope = scope; self.client = client; self.isCurrent = isCurrent; self.mediaFactory = mediaFactory
        self.canUseAudio = canUseAudio
    }
    public convenience init?(model: DexterAppModel, bot: Bot, threadID: String,
                             mediaFactory: @escaping @MainActor () -> any CodexVoiceMedia = { NativeCodexVoiceMedia() }) {
        guard model.canEditBotProfiles, model.isOnline, let hostID = model.approvalPolicyHostID,
              let client = model.makeLocalMcpClient() else { return nil }
        let scopeID = model.nativeComposerScope, address = model.hostAddress
        self.init(scope: CodexVoiceScope(hostID: hostID, botID: bot.id, threadID: threadID), client: client,
                  isCurrent: { [weak model] in
            guard let model else { return false }
            return model.canEditBotProfiles && model.isOnline && model.nativeComposerScope == scopeID
                && model.hostAddress == address && model.approvalPolicyHostID == hostID
                && model.selectedBotID == bot.id && model.selectedThreadID == threadID
        }, mediaFactory: mediaFactory, canUseAudio: { [weak model] in
            guard let model else { return false }
            return !model.liveVoiceController.isSessionActive && !model.isSubmitting
                && model.pendingSubmission == nil && !model.isUpdatingEngineSelection
                && model.currentTurn?.state != .queued && model.currentTurn?.state != .running
        })
        connectionScope = scopeID
    }
    public var canStart: Bool { isCurrent() && status?.supported == true && [.idle, .failed].contains(phase)
        && pendingStart == nil && pendingStop == nil && media == nil && session?.terminal != false
        && (status?.activeSessionId == nil || (status?.activeSessionId == session?.id && session?.terminal == true))
        && NativeVoiceMediaLease.holder == nil && canUseAudio() }
    public var canMute: Bool { phase == .active || phase == .connecting }
    public var hasUnconfirmedRequest: Bool { pendingStart != nil || pendingStop != nil }
    public var failureMessage: String? {
        guard let failure else { return nil }
        switch failure {
        case .offline: return String(localized: "Não foi possível conectar à base. Atualize para conferir.")
        case .uncertain: return String(localized: "Não foi possível confirmar a ligação. Confira o estado antes de iniciar outra.")
        case .scopeChanged: return String(localized: "A conversa ou a base mudou. A ligação anterior está sendo encerrada.")
        case .media(.microphonePermissionRequired): return String(localized: "Permita o microfone para o Dexter nos Ajustes do macOS.")
        case .media(.cleanupPending): return String(localized: "O encerramento do microfone ainda não foi confirmado. Confira antes de iniciar outra ligação.")
        case .media: return String(localized: "Não foi possível iniciar o áudio. Confira o microfone e a saída de som.")
        case .backend(.unsupported):
            return status?.cliVersion == nil
                ? String(localized: "A ligação nativa precisa de um modelo Codex compatível. Confira o modelo desta conversa.")
                : String(localized: "Este programa Codex precisa ser atualizado para fazer ligações. Confira Ajustes › Assistentes.")
        case .backend(.authNeeded): return String(localized: "Faça login no programa oficial do Codex e tente novamente.")
        case .backend(.modelUnsupported): return String(localized: "O modelo escolhido não está disponível para esta ligação.")
        case .backend(.scopeChanged): return String(localized: "A configuração do bot mudou. Inicie uma nova ligação.")
        case .backend: return String(localized: "O Codex não conseguiu concluir a ligação. Confira o estado para continuar.")
        }
    }
    public func chooseVoice(_ voice: String?) {
        guard [.idle, .failed].contains(phase), voice == nil || status?.voices.contains(voice!) == true else { return }
        selectedVoice = voice
    }
    public func refreshStatus() async {
        guard isCurrent(), [.idle, .failed].contains(phase), !hasUnconfirmedRequest, media == nil else { return }
        phase = .checking
        do {
            let value = try await client.nativeVoiceStatus(threadID: scope.threadID)
            guard phase == .checking else { return }
            guard isCurrent(), value.hostId == scope.hostID, value.botId == scope.botID, value.threadId == scope.threadID else {
                phase = .failed; failure = .scopeChanged; return
            }
            status = value
            if let voice = selectedVoice, !value.voices.contains(voice) { selectedVoice = nil }
            if let id = value.activeSessionId {
                let active = try await client.nativeVoiceSession(id: id)
                guard phase == .checking, isCurrent() else { return }
                try validateSession(active, id: id)
                session = active
                if !active.terminal { phase = .unconfirmed; failure = .uncertain; return }
            }
            phase = .idle; failure = value.supported ? nil : .backend(value.code ?? .unsupported)
        } catch { if phase == .checking { phase = .failed; failure = .offline } }
    }
    public func start() async {
        guard [.idle, .failed].contains(phase), !hasUnconfirmedRequest, media == nil else { return }
        await refreshStatus()
        guard canStart, let status else { return }
        NativeVoiceMediaLease.holder = leaseID
        phase = .starting; failure = nil; transcript = []; cursor = 0; muted = false
        localConnected = false; answerAccepted = false
        let owned = mediaFactory(); media = owned
        owned.onFailure = { [weak self] code in
            guard let self else { return }; self.failure = .media(code)
            Task { await self.stop() }
        }
        owned.onConnected = { [weak self] in
            guard let self, self.isCurrent(), self.media != nil else { return }
            self.localConnected = true
            if self.session?.state == .active { self.phase = .active }
        }
        do {
            let offer = try await owned.prepareOffer()
            guard isCurrent(), phase == .starting else { _ = await closeMedia(); return }
            let input = StartNativeVoice(expectedHostId: scope.hostID, expectedBotId: scope.botID,
                expectedBotRevision: status.botRevision, expectedSelectionRevision: status.selectionRevision,
                clientRequestId: UUID().uuidString.lowercased(), generation: UUID().uuidString.lowercased(), sdpOffer: offer, voice: selectedVoice)
            pendingStart = input
            let result = try await client.startNativeVoice(threadID: scope.threadID, input: input)
            try client.validateNativeVoiceStartReceipt(result, threadID: scope.threadID, input: input)
            try accept(result, requestID: input.clientRequestId, sessionID: input.sessionId, generation: input.generation)
            pendingStart = nil
            if result.session.terminal {
                failure = result.session.code.map(CodexVoiceFailure.backend)
                finishStop(await closeMedia()); return
            }
            guard isCurrent(), phase == .starting else { await stop(); return }
            phase = .connecting; beginWatch()
        } catch {
            let captureClosed = await closeMedia()
            if !captureClosed { phase = .unconfirmed; failure = .media(.cleanupPending); return }
            if let error = error as? HostClientError, Self.definiteRefusal(error) {
                pendingStart = nil; phase = .failed
                failure = error == .conflict ? .backend(.scopeChanged) : .offline
            } else if pendingStart != nil { phase = .unconfirmed; failure = .uncertain }
            else { phase = .failed; failure = .media((error as? CodexVoiceMediaFailure) ?? .audioUnavailable) }
        }
    }
    private static func definiteRefusal(_ error: HostClientError) -> Bool {
        [.invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden, .notFound, .conflict, .notReady].contains(error)
    }
    private func accept(_ result: NativeVoiceMutation, requestID: String, sessionID: String, generation: String) throws {
        guard result.receipt.clientRequestId == requestID, result.receipt.sessionId == sessionID,
              result.receipt.hostId == scope.hostID, result.receipt.threadId == scope.threadID,
              result.receipt.generation == generation, result.session.id == sessionID,
              result.session.hostId == scope.hostID, result.session.botId == scope.botID,
              result.session.threadId == scope.threadID, result.session.generation == generation else { throw HostClientError.contractMismatch }
        session = result.session
    }
    public func reconcile() async {
        if let input = pendingStart {
            do {
                let result = try await client.nativeVoiceReceipt(threadID: scope.threadID, clientRequestID: input.clientRequestId)
                try client.validateNativeVoiceStartReceipt(result, threadID: scope.threadID, input: input)
                try accept(result, requestID: input.clientRequestId, sessionID: input.sessionId, generation: input.generation)
                pendingStart = nil
                // Audio was stopped after uncertainty. Never resurrect capture or reuse the old offer.
                await stop()
            } catch { phase = .unconfirmed; failure = .uncertain }
        } else if let input = pendingStop, let session {
            do {
                let result = try await client.nativeVoiceReceipt(threadID: scope.threadID, clientRequestID: input.clientRequestId)
                try client.validateNativeVoiceStopReceipt(result, sessionID: session.id, input: input)
                try accept(result, requestID: input.clientRequestId, sessionID: session.id, generation: input.generation)
                pendingStop = nil; finishStop(await closeMedia())
            } catch { phase = .unconfirmed; failure = .uncertain }
        } else if let known = session {
            do {
                let current = try await client.nativeVoiceSession(id: known.id)
                try validateSession(current, id: known.id, generation: known.generation)
                session = current
                if current.terminal { finishStop(await closeMedia()) }
                else { phase = .unconfirmed; failure = .uncertain }
            } catch { phase = .unconfirmed; failure = .uncertain }
        } else if media != nil { finishStop(await closeMedia()) }
    }
    private func validateSession(_ value: NativeVoiceSession, id: String, generation: String? = nil) throws {
        guard value.id == id, value.hostId == scope.hostID, value.botId == scope.botID,
              value.threadId == scope.threadID, generation == nil || value.generation == generation else {
            throw HostClientError.contractMismatch
        }
    }
    public func setMuted(_ value: Bool) {
        guard canMute, isCurrent() else { return }
        muted = value; media?.setMuted(value)
    }
    public func stop() async {
        if let stopping { await stopping.value; return }
        let operation = Task { [weak self] in await self?.performStop() }
        stopping = Task { await operation.value }
        await stopping?.value; stopping = nil
    }
    private func performStop() async {
        watch?.cancel(); watch = nil
        phase = .stopping
        let closed = await closeMedia()
        guard pendingStart == nil, pendingStop == nil else { phase = .unconfirmed; failure = .uncertain; return }
        guard let known = session else { finishStop(closed); return }
        do {
            let current = try await client.nativeVoiceSession(id: known.id)
            guard current.hostId == scope.hostID, current.botId == scope.botID, current.threadId == scope.threadID,
                  current.generation == known.generation else { throw HostClientError.contractMismatch }
            session = current
            if current.terminal { finishStop(closed); return }
            let input = StopNativeVoice(expectedHostId: scope.hostID, expectedBotId: scope.botID, generation: current.generation,
                clientRequestId: UUID().uuidString.lowercased(), expectedRevision: current.revision)
            pendingStop = input
            let result = try await client.stopNativeVoice(sessionID: current.id, input: input)
            try client.validateNativeVoiceStopReceipt(result, sessionID: current.id, input: input)
            try accept(result, requestID: input.clientRequestId, sessionID: current.id, generation: current.generation)
            pendingStop = nil; finishStop(closed)
        } catch {
            // A definitive rejection cannot be a lost acknowledgement. Keep the known session and
            // obtain its current revision on an explicit Stop; never replay the rejected mutation.
            if let error = error as? HostClientError, Self.definiteRefusal(error) { pendingStop = nil }
            phase = .unconfirmed; failure = .uncertain
        }
    }
    private func closeMedia() async -> Bool {
        guard let media else { if NativeVoiceMediaLease.holder == leaseID { NativeVoiceMediaLease.holder = nil }; return true }
        let stopped = await media.close()
        if stopped { self.media = nil; if NativeVoiceMediaLease.holder == leaseID { NativeVoiceMediaLease.holder = nil } }
        return stopped
    }
    private func finishStop(_ closed: Bool) {
        if !closed { phase = .unconfirmed; failure = .media(.cleanupPending) }
        else if session?.state == .unknown || session?.terminal == false { phase = .unconfirmed; failure = .uncertain }
        else { phase = .idle; localConnected = false; answerAccepted = false }
    }
    private func beginWatch() {
        watch?.cancel()
        watch = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let known = self.session else { return }
                guard self.isCurrent() else { self.failure = .scopeChanged; await self.stop(); return }
                do {
                    let current = try await self.client.nativeVoiceSession(id: known.id)
                    guard current.hostId == self.scope.hostID, current.botId == self.scope.botID,
                          current.threadId == self.scope.threadID, current.generation == known.generation else { throw HostClientError.contractMismatch }
                    self.session = current
                    if current.terminal { self.failure = current.code.map(CodexVoiceFailure.backend); self.finishStop(await self.closeMedia()); return }
                    if !self.answerAccepted {
                        do {
                            let exchange = try await self.client.nativeVoiceExchange(sessionID: current.id, expectedHostID: self.scope.hostID, generation: current.generation)
                            guard exchange.sessionId == current.id, exchange.generation == current.generation,
                                  exchange.expiresAt > Int64(Date().timeIntervalSince1970 * 1000), self.isCurrent() else { throw HostClientError.contractMismatch }
                            try await self.media?.accept(answer: exchange.sdpAnswer)
                            self.answerAccepted = true
                        } catch HostClientError.notFound { /* SDP is not ready; read again, never POST. */ }
                    }
                    let page = try await self.client.nativeVoiceEvents(sessionID: current.id, after: self.cursor)
                    for event in page.items {
                        guard event.sessionId == current.id, event.generation == current.generation, event.cursor > self.cursor else { throw HostClientError.contractMismatch }
                        self.cursor = event.cursor
                        if event.kind == "transcript", ["user", "assistant"].contains(event.role ?? ""), let text = event.text, text.utf8.count <= 16_384 {
                            self.transcript.append(event)
                            if self.transcript.count > 100 { self.transcript.removeFirst(self.transcript.count - 100) }
                        }
                    }
                    if self.localConnected, current.state == .active { self.phase = .active }
                    try await Task.sleep(for: .milliseconds(750))
                } catch {
                    if Task.isCancelled { return }
                    self.failure = .offline; await self.stop(); return
                }
            }
        }
    }
}
#endif
