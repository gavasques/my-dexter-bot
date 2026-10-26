import Foundation
import Observation

public enum LiveVoiceState: String, Sendable { case idle, starting, listening, stopping, failed }
public enum LiveVoiceSpeaker: String, Codable, Sendable { case user, assistant }

public struct LiveVoiceScope: Equatable, Sendable {
    public let hostID: String
    public let botID: String
    public let threadID: String
    public init(hostID: String, botID: String, threadID: String) {
        self.hostID = hostID; self.botID = botID; self.threadID = threadID
    }
}

public struct LiveVoiceHistoryMessage: Sendable {
    public let role: LiveVoiceSpeaker
    public let text: String
    public init(role: LiveVoiceSpeaker, text: String) { self.role = role; self.text = text }
}

/// Caption segments are provisional temporal groups, never provider-completed canonical turns.
public struct LiveVoiceTranscriptSegment: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let speaker: LiveVoiceSpeaker
    public var text: String
    public var startMS: Int?
    public var endMS: Int?
    public init(id: String = UUID().uuidString.lowercased(), speaker: LiveVoiceSpeaker,
                text: String, startMS: Int? = nil, endMS: Int? = nil) {
        self.id = id; self.speaker = speaker; self.text = text; self.startMS = startMS; self.endMS = endMS
    }
}

public struct LiveVoiceDelegationRequest: Sendable {
    public let id: String
    public let scope: LiveVoiceScope
    public let offsetMS: Int?
    public let transcript: [LiveVoiceTranscriptSegment]
    public let transcriptTruncated: Bool
    /// The primary Live event supplies an ID/offset only; this is not an invented task string.
    public var contextIsPartial: Bool { true }
}

public struct LiveVoiceClosedSession: Sendable {
    public let scope: LiveVoiceScope
    public let sessionID: String?
    public let voice: String
    public let transcript: [LiveVoiceTranscriptSegment]
    public let usageSeconds: Double?
    public let usageConfirmed: Bool
    public let transcriptTruncated: Bool
}

/// Trusted Mac key custody and audio. Bot work remains in the host callback, with its own grants.
@MainActor @Observable public final class LiveVoiceController {
    public private(set) var state: LiveVoiceState = .idle
    public private(set) var microphoneMuted = false
    public private(set) var inputCaption = ""
    public private(set) var outputCaption = ""
    public private(set) var safeMessage: String?
    public private(set) var failure: LiveVoiceFailure?
    public private(set) var audioStartupFailure: LiveVoiceAudioStartupError?
    public private(set) var voice: String?
    public private(set) var sessionID: String?
    public private(set) var scope: LiveVoiceScope?
    public private(set) var transcriptSnapshot: [LiveVoiceTranscriptSegment] = []
    public private(set) var transcriptTruncated = false
    public private(set) var closedUsageSeconds: Double?
    public private(set) var finalUsageConfirmed = false
    public private(set) var echoCancellationAvailable = false
    public var isSessionActive: Bool { state == .starting || state == .listening || state == .stopping }

    @ObservationIgnored public var onDelegation: (@MainActor (LiveVoiceDelegationRequest) async -> String)?
    @ObservationIgnored public var onClosed: (@MainActor (LiveVoiceClosedSession) async -> Void)?
    @ObservationIgnored private let keyStore: any LiveAPIKeyStore
    @ObservationIgnored private let transportFactory: LiveVoiceTransportFactory
    @ObservationIgnored private let audio: any LiveVoiceAudio
    @ObservationIgnored private var transport: (any LiveVoiceTransport)?
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var receiveTask: Task<Void, Never>?
    @ObservationIgnored private var inputTask: Task<Void, Never>?
    @ObservationIgnored private var inputPumpID: UUID?
    @ObservationIgnored private var startupDeadline: Task<Void, Never>?
    @ObservationIgnored private var closeDeadline: Task<Void, Never>?
    @ObservationIgnored private var sessionDeadline: Task<Void, Never>?
    @ObservationIgnored private var inputChunks: [UInt64: Data] = [:]
    @ObservationIgnored private var nextInputSequence: UInt64 = 0
    @ObservationIgnored private var delegationTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var delegationDeadlines: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var seenDelegations: Set<String> = []
    @ObservationIgnored private var closedEmitted = false
    @ObservationIgnored private var transcriptCharacters = 0
    @ObservationIgnored private var closeWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var closeCallbackTasks: [UUID: Task<Void, Never>] = [:]

    public init(keyStore: (any LiveAPIKeyStore)? = nil,
                transportFactory: LiveVoiceTransportFactory? = nil,
                audio: (any LiveVoiceAudio)? = nil) {
        self.keyStore = keyStore ?? ScopedLiveAPIKeychain()
        self.transportFactory = transportFactory ?? { try OpenAILiveWebSocketTransport(apiKey: $0) }
        #if os(macOS)
        self.audio = audio ?? NativeLiveVoiceAudio()
        #else
        self.audio = audio ?? UnavailableLiveVoiceAudio()
        #endif
    }

    public func keyStatus(hostID: String) -> LiveKeyStatus { keyStore.status(hostID: hostID) }
    public func saveKey(_ key: String, hostID: String) throws { try keyStore.save(key, hostID: hostID) }
    public func removeKey(hostID: String) throws {
        if scope?.hostID == hostID { invalidate() }
        try keyStore.remove(hostID: hostID)
    }

    public func start(scope: LiveVoiceScope, voice: String, instructions: String,
                      history: [LiveVoiceHistoryMessage] = []) async {
        guard !isSessionActive else { return }
        generation &+= 1
        let currentGeneration = generation
        self.scope = scope; self.voice = voice; state = .starting; safeMessage = nil; failure = nil; audioStartupFailure = nil
        sessionID = nil; inputCaption = ""; outputCaption = ""; microphoneMuted = false
        transcriptSnapshot = []; transcriptTruncated = false; transcriptCharacters = 0
        finalUsageConfirmed = false; closedUsageSeconds = nil; echoCancellationAvailable = false
        closedEmitted = false; nextInputSequence = 0; seenDelegations = []
        do {
            let event = try startEvent(scope: scope, voice: voice, instructions: instructions, history: history)
            let key = try keyStore.load(hostID: scope.hostID)
            guard await audio.requestMicrophonePermission() else { throw LiveVoiceFailure.microphoneDenied }
            guard generation == currentGeneration, state == .starting else { return }
            let connection = try transportFactory(key)
            transport = connection
            receiveTask = Task { [weak self] in await self?.receiveLoop(generation: currentGeneration) }
            startupDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard let self, self.generation == currentGeneration, self.state == .starting else { return }
                self.fail(.sessionTimeout)
            }
            try await connection.send(event)
        } catch {
            guard generation == currentGeneration, state == .starting else { return }
            fail(error as? LiveVoiceFailure ?? .connectionUnavailable)
        }
    }

    public func setMuted(_ muted: Bool) async {
        guard state == .listening, microphoneMuted != muted else { return }
        let currentGeneration = generation
        microphoneMuted = muted; audio.setCaptureMuted(muted)
        nextInputSequence = audio.nextCaptureSequence ?? max(nextInputSequence, (inputChunks.keys.max().map { $0 + 1 }) ?? nextInputSequence)
        inputChunks.removeAll(); inputTask?.cancel(); inputTask = nil; inputPumpID = nil
        do {
            try await sendEvent(["type": muted ? "session.input_audio.mute" : "session.input_audio.unmute"])
        } catch {
            guard generation == currentGeneration, state == .listening else { return }
            fail(.connectionUnavailable)
        }
    }

    /// Stops local capture/playback immediately, then waits for the bounded provider close receipt.
    public func stop() async {
        beginClose()
        if state == .stopping { await withCheckedContinuation { closeWaiters.append($0) } }
        await waitForCloseCallback()
    }

    /// App termination awaits the owned host-save callback, including a session that already closed.
    /// The callback must use the host client's bounded request timeout and report persistence failure.
    public func waitForCloseCallback() async {
        while !closeCallbackTasks.isEmpty {
            let pending = Array(closeCallbackTasks.values)
            for task in pending { await task.value }
        }
    }

    /// Scope/navigation changes never wait before disabling the microphone and pending bot work.
    public func invalidate() { beginClose() }

    private func beginClose() {
        guard state == .starting || state == .listening else { return }
        state = .stopping
        stopLocalWork()
        startupDeadline?.cancel(); startupDeadline = nil
        sessionDeadline?.cancel(); sessionDeadline = nil
        guard transport != nil else { finish(confirmed: false); return }
        let currentGeneration = generation
        // receiveLoop is already installed before this command. Never drop the final session.closed.
        closeDeadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            guard let self, self.generation == currentGeneration, self.state == .stopping else { return }
            self.safeMessage = String(localized: "A sessão foi parada. A OpenAI não confirmou o uso final a tempo.")
            self.finish(confirmed: false)
        }
        Task { [weak self] in
            guard let self, self.generation == currentGeneration, self.state == .stopping else { return }
            do { try await self.sendEvent(["type": "session.close"]) }
            catch {
                guard self.generation == currentGeneration, self.state == .stopping else { return }
                self.finish(confirmed: false)
            }
        }
    }

    private func stopLocalWork() {
        audio.stop()
        inputTask?.cancel(); inputTask = nil; inputPumpID = nil; inputChunks.removeAll()
        for task in delegationTasks.values { task.cancel() }
        for task in delegationDeadlines.values { task.cancel() }
        delegationTasks.removeAll(); delegationDeadlines.removeAll()
    }

    private func receiveLoop(generation currentGeneration: UInt64) async {
        while generation == currentGeneration, isSessionActive, let connection = transport {
            do {
                let data = try await connection.receive()
                guard generation == currentGeneration, isSessionActive else { return }
                guard data.count <= 1_048_576,
                      let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = event["type"] as? String else { throw LiveVoiceFailure.protocolRejected }
                try handle(event, type: type, generation: currentGeneration)
            } catch {
                guard generation == currentGeneration, isSessionActive else { return }
                if state == .stopping { finish(confirmed: false) }
                else if let startup = error as? LiveVoiceAudioStartupError {
                    fail(startup.failure)
                    audioStartupFailure = startup; safeMessage = startup.message
                } else { fail(error as? LiveVoiceFailure ?? .connectionUnavailable) }
                return
            }
        }
    }

    private func handle(_ event: [String: Any], type: String, generation currentGeneration: UInt64) throws {
        switch type {
        case "session.started":
            guard state == .starting else { return }
            let session = event["session"] as? [String: Any]
            sessionID = boundedID(session?["id"] ?? event["session_id"])
            startupDeadline?.cancel(); startupDeadline = nil
            try audio.start(onInput: { [weak self] chunk in
                Task { @MainActor [weak self] in self?.enqueueInput(chunk, generation: currentGeneration) }
            }, onFailure: { [weak self] failure in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == currentGeneration, self.state == .listening else { return }
                    self.fail(failure)
                }
            })
            echoCancellationAvailable = audio.echoCancellationAvailable
            state = .listening
            sessionDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(60 * 30)) } catch { return }
                guard let self, self.generation == currentGeneration, self.state == .listening else { return }
                self.safeMessage = String(localized: "Esta sessão atingiu 30 minutos. Inicie uma nova sessão para continuar.")
                self.beginClose()
            }
        case "session.output_audio.delta":
            guard state == .listening else { return }
            guard let encoded = event["delta"] as? String, encoded.utf8.count <= 256_000,
                  let pcm = Data(base64Encoded: encoded), !pcm.isEmpty, pcm.count.isMultiple(of: 2) else {
                throw LiveVoiceFailure.protocolRejected
            }
            try audio.play(pcm)
        case "session.input_transcript.delta", "session.output_transcript.delta":
            guard state == .listening || state == .stopping else { return }
            guard let delta = event["delta"] as? String, delta.utf8.count <= 32_768 else {
                throw LiveVoiceFailure.protocolRejected
            }
            appendTranscript(speaker: type == "session.input_transcript.delta" ? .user : .assistant,
                             delta: delta, startMS: milliseconds(event["start_ms"]), endMS: milliseconds(event["end_ms"]))
        case "session.delegation.created":
            guard state == .listening,
                  let delegation = event["delegation"] as? [String: Any], delegation["target"] as? String == "client",
                  let id = boundedID(delegation["id"]) else { return }
            startDelegation(id: id, offsetMS: milliseconds(event["offset_ms"]), generation: currentGeneration)
        case "session.usage.updated":
            if let seconds = usageSeconds(event) { closedUsageSeconds = seconds }
        case "session.closed":
            let finalSeconds = usageSeconds(event)
            if let finalSeconds { closedUsageSeconds = finalSeconds }
            finish(confirmed: finalSeconds != nil)
        case "error": throw LiveVoiceFailure.protocolRejected
        default: break // Additional backend events never become grants or direct local tool calls.
        }
    }

    private func enqueueInput(_ chunk: LiveVoiceAudioChunk, generation currentGeneration: UInt64) {
        guard generation == currentGeneration, state == .listening else { return }
        guard chunk.sequence >= nextInputSequence, chunk.pcm.count <= 16_384,
              chunk.pcm.count.isMultiple(of: 2) else { return }
        if microphoneMuted { nextInputSequence = max(nextInputSequence, chunk.sequence + 1); return }
        guard inputChunks.count < 32, inputChunks.values.reduce(0, { $0 + $1.count }) + chunk.pcm.count <= 96_000 else {
            fail(.audioBacklog); return
        }
        inputChunks[chunk.sequence] = chunk.pcm
        guard inputTask == nil else { return }
        let pumpID = UUID()
        inputPumpID = pumpID
        inputTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.generation == currentGeneration, self.inputPumpID == pumpID {
                    self.inputTask = nil; self.inputPumpID = nil
                }
            }
            while !Task.isCancelled, self.generation == currentGeneration, self.state == .listening,
                  !self.microphoneMuted, let pcm = self.inputChunks.removeValue(forKey: self.nextInputSequence) {
                self.nextInputSequence &+= 1
                do { try await self.sendEvent(["type": "session.input_audio.append", "audio": pcm.base64EncodedString()]) }
                catch {
                    guard self.generation == currentGeneration, self.state == .listening else { return }
                    self.fail(.connectionUnavailable); return
                }
            }
        }
    }

    private func startDelegation(id: String, offsetMS: Int?, generation currentGeneration: UInt64) {
        guard !seenDelegations.contains(id) else { return }
        guard seenDelegations.count < 128, delegationTasks.count < 4, let scope else {
            fail(.delegationUnavailable); return
        }
        seenDelegations.insert(id)
        let request = LiveVoiceDelegationRequest(id: id, scope: scope, offsetMS: offsetMS,
                                                transcript: transcriptSnapshot, transcriptTruncated: transcriptTruncated)
        let callback = onDelegation
        delegationTasks[id] = Task { [weak self] in
            guard let self, self.generation == currentGeneration, self.state == .listening else { return }
            do {
                try await self.sendEvent(["type": "session.thinking.append", "event_id": UUID().uuidString.lowercased(),
                                          "delegation_id": id, "content": "O harness do bot está analisando o pedido. Nenhuma ação foi confirmada ainda; as permissões do host continuam valendo."])
            } catch {
                guard self.generation == currentGeneration, self.state == .listening else { return }
                self.fail(.connectionUnavailable); return
            }
            guard !Task.isCancelled, self.generation == currentGeneration, self.state == .listening else { return }
            let content: String
            if let callback { content = await callback(request) }
            else { content = "Esta sessão não tem acesso a ações do bot. Use a conversa de texto para continuar." }
            guard !Task.isCancelled, self.generation == currentGeneration, self.state == .listening else { return }
            self.delegationDeadlines.removeValue(forKey: id)?.cancel()
            self.delegationTasks.removeValue(forKey: id)
            do {
                try await self.sendEvent(["type": "session.commentary.append", "event_id": UUID().uuidString.lowercased(),
                                          "delegation_id": id, "content": self.boundedCommentary(content)])
            } catch {
                guard self.generation == currentGeneration, self.state == .listening else { return }
                self.fail(.connectionUnavailable)
            }
        }
        delegationDeadlines[id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(120)) } catch { return }
            guard let self, self.generation == currentGeneration, self.state == .listening,
                  self.delegationTasks[id] != nil else { return }
            self.delegationTasks.removeValue(forKey: id)?.cancel()
            self.delegationDeadlines.removeValue(forKey: id)
            do {
                try await self.sendEvent(["type": "session.commentary.append", "event_id": UUID().uuidString.lowercased(),
                                          "delegation_id": id, "content": "A ação não terminou em dois minutos. Confira seu estado na conversa de texto; não repita sem conferir."])
            } catch {
                guard self.generation == currentGeneration, self.state == .listening else { return }
                self.fail(.connectionUnavailable)
            }
        }
    }

    private func appendTranscript(speaker: LiveVoiceSpeaker, delta: String, startMS: Int?, endMS: Int?) {
        guard !delta.isEmpty else { return }
        guard transcriptCharacters < 32_768 else {
            transcriptTruncated = true
            safeMessage = String(localized: "As legendas atingiram o limite desta sessão. O histórico salvo será parcial.")
            return
        }
        var remaining = utf16Prefix(delta, limit: 32_768 - transcriptCharacters)
        if remaining.utf16.count < delta.utf16.count { transcriptTruncated = true }
        while !remaining.isEmpty {
            let canAppend = transcriptSnapshot.last.map {
                $0.speaker == speaker && $0.text.utf16.count < 8_192
                    && !(startMS != nil && $0.endMS != nil && startMS! - $0.endMS! > 1_500)
            } ?? false
            if !canAppend {
                guard transcriptSnapshot.count < 128 else { transcriptTruncated = true; break }
                transcriptSnapshot.append(LiveVoiceTranscriptSegment(speaker: speaker, text: "", startMS: startMS, endMS: endMS))
            }
            let index = transcriptSnapshot.count - 1
            let addition = utf16Prefix(remaining, limit: 8_192 - transcriptSnapshot[index].text.utf16.count)
            guard !addition.isEmpty else {
                if transcriptSnapshot[index].text.isEmpty { transcriptSnapshot.removeLast() }
                transcriptTruncated = true; break
            }
            transcriptSnapshot[index].text += addition
            if let startMS { transcriptSnapshot[index].startMS = transcriptSnapshot[index].startMS.map { min($0, startMS) } ?? startMS }
            if let endMS { transcriptSnapshot[index].endMS = transcriptSnapshot[index].endMS.map { max($0, endMS) } ?? endMS }
            transcriptCharacters += addition.utf16.count
            remaining = String(remaining.dropFirst(addition.count))
        }
        let caption = transcriptSnapshot.last(where: { $0.speaker == speaker })?.text ?? ""
        if speaker == .user { inputCaption = String(caption.suffix(4_000)) }
        else { outputCaption = String(caption.suffix(4_000)) }
        if transcriptTruncated { safeMessage = String(localized: "As legendas atingiram o limite desta sessão. O histórico salvo será parcial.") }
    }

    private func fail(_ failure: LiveVoiceFailure) {
        self.failure = failure
        safeMessage = failure.message
        finish(confirmed: false, failed: true)
    }

    private func utf16Prefix(_ value: String, limit: Int) -> String {
        var units = 0
        var result = ""
        for character in value {
            let text = String(character)
            guard units + text.utf16.count <= limit else { break }
            result += text; units += text.utf16.count
        }
        return result
    }

    private func finish(confirmed: Bool, failed: Bool = false) {
        guard !closedEmitted else { return }
        closedEmitted = true
        stopLocalWork()
        startupDeadline?.cancel(); startupDeadline = nil
        closeDeadline?.cancel(); closeDeadline = nil
        sessionDeadline?.cancel(); sessionDeadline = nil
        receiveTask?.cancel(); receiveTask = nil
        transport?.cancel(); transport = nil
        finalUsageConfirmed = confirmed
        state = failed ? .failed : .idle
        let waiters = closeWaiters; closeWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        if let scope, let voice, let callback = onClosed {
            let snapshot = LiveVoiceClosedSession(scope: scope, sessionID: sessionID, voice: voice,
                                                  transcript: transcriptSnapshot, usageSeconds: closedUsageSeconds,
                                                  usageConfirmed: confirmed, transcriptTruncated: transcriptTruncated)
            let callbackID = UUID()
            closeCallbackTasks[callbackID] = Task { [weak self] in
                await callback(snapshot)
                self?.closeCallbackTasks.removeValue(forKey: callbackID)
            }
        }
    }

    private func sendEvent(_ event: [String: Any]) async throws {
        guard let transport else { throw LiveVoiceFailure.connectionUnavailable }
        try await transport.send(JSONSerialization.data(withJSONObject: event))
    }

    private func startEvent(scope: LiveVoiceScope, voice: String, instructions: String,
                            history: [LiveVoiceHistoryMessage]) throws -> Data {
        let identifiers = [scope.hostID, scope.botID, scope.threadID]
        guard identifiers.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 2_048 && !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }),
              voice.range(of: "^[a-z][a-z0-9_-]{0,63}$", options: .regularExpression) != nil,
              instructions.utf8.count <= 48_000, history.count <= 128,
              history.reduce(0, { $0 + $1.text.utf8.count }) <= 48_000 else { throw LiveVoiceFailure.invalidConfiguration }
        let input: [[String: Any]] = history.map {
            ["type": "message", "role": $0.role.rawValue,
             "content": [["type": $0.role == .user ? "input_text" : "output_text", "text": $0.text]]]
        }
        let payload: [String: Any] = [
            "type": "session.start", "event_id": UUID().uuidString.lowercased(),
            "session": ["model": "gpt-live-1", "instructions": instructions, "input": input,
                        "audio": ["format": ["type": "audio/pcm", "rate": 24_000], "output": ["voice": voice]],
                        "delegation": ["type": "client"], "store": false]
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    private func milliseconds(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value >= 0, value <= 86_400_000, value.rounded(.towardZero) == value else { return nil }
        return Int(value)
    }
    private func boundedID(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= 256,
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return value
    }
    private func usageSeconds(_ event: [String: Any]) -> Double? {
        let usage = event["usage"] as? [String: Any]
        guard let number = usage?["seconds"] as? NSNumber,
              number.doubleValue.isFinite, (0...86_400).contains(number.doubleValue) else { return nil }
        return number.doubleValue // Cumulative provider snapshots replace, never sum.
    }

    private func boundedCommentary(_ content: String) -> String {
        guard content.utf8.count > 480 else { return content.isEmpty ? "Confira o resultado na conversa de texto." : content }
        // A byte ceiling is conservative for the API's 500-token append limit, including non-Latin text.
        var prefix = ""
        for character in content {
            guard prefix.utf8.count + String(character).utf8.count <= 400 else { break }
            prefix.append(character)
        }
        return prefix + "… Resumo parcial; confira o resultado completo na conversa de texto."
    }
}
