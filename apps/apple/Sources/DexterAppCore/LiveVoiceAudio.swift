import Foundation

public struct LiveVoiceAudioChunk: Sendable {
    public let sequence: UInt64
    public let pcm: Data
    public init(sequence: UInt64, pcm: Data) { self.sequence = sequence; self.pcm = pcm }
}

@MainActor public protocol LiveVoiceAudio: AnyObject {
    var echoCancellationAvailable: Bool { get }
    var nextCaptureSequence: UInt64? { get }
    func requestMicrophonePermission() async -> Bool
    func start(onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void,
               onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws
    func play(_ pcm: Data) throws
    func setCaptureMuted(_ muted: Bool)
    func stop()
}

public extension LiveVoiceAudio {
    var nextCaptureSequence: UInt64? { nil }
}

/// Closed startup diagnostics. Never retain NSError, device labels, routes or audio samples.
public struct LiveVoiceAudioStartupError: Error, Equatable, Sendable {
    public enum Reason: String, Sendable { case inputUnavailable, outputUnavailable, inputFormat, outputFormat, duplexFormat, initialization }
    public let reason: Reason
    public let osStatus: Int32?
    public init(_ reason: Reason, osStatus: Int32? = nil) { self.reason = reason; self.osStatus = osStatus }
    public var failure: LiveVoiceFailure { .audio(reason == .inputFormat ? .inputFormat : .engineStart, osStatus: osStatus) }
    public var message: String {
        switch reason {
        case .inputUnavailable: String(localized: "O Mac não disponibilizou um microfone. Conecte ou selecione uma entrada nos ajustes de Som e inicie uma nova sessão.")
        case .outputUnavailable: String(localized: "O Mac não disponibilizou uma saída de som. Conecte ou selecione uma saída nos ajustes de Som e inicie uma nova sessão.")
        case .inputFormat: String(localized: "O formato do microfone não é compatível. Confira a entrada nos ajustes de Som e inicie uma nova sessão.")
        case .outputFormat, .duplexFormat: String(localized: "O formato da saída de som não é compatível com esta sessão. Confira a saída nos ajustes de Som e inicie uma nova sessão.")
        case .initialization: String(localized: "O sistema de áudio do Mac recusou a inicialização. Confira entrada e saída nos ajustes de Som; depois inicie uma nova sessão.")
        }
    }
}

/// Only the local, unstarted audio graph may fall back. This never resends a provider request.
enum LiveVoiceAudioBootstrap {
    static func start<T>(voiceProcessing: () throws -> T, plain: () throws -> T) throws -> T {
        do { return try voiceProcessing() }
        catch let error as LiveVoiceAudioStartupError {
            switch error.reason {
            case .duplexFormat, .initialization: return try plain()
            default: throw error
            }
        }
    }
}

#if os(macOS)
import AVFoundation

private final class LiveConverterInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    private var offset: AVAudioFrameCount = 0
    private var lastSlice: AVAudioPCMBuffer?
    private(set) var failed = false
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    // Called synchronously under LivePCMConverter's lock, with no async work or escaped buffer.
    func next(_ requested: AVAudioPacketCount,
              _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        let count = min(requested, buffer.frameLength - offset)
        guard count > 0 else { status.pointee = .noDataNow; return nil }
        guard let slice = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count) else {
            failed = true; status.pointee = .noDataNow; return nil
        }
        slice.frameLength = count
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let target = UnsafeMutableAudioBufferListPointer(slice.mutableAudioBufferList)
        let bytesPerFrame = Int(buffer.format.streamDescription.pointee.mBytesPerFrame)
        let byteOffset = Int(offset) * bytesPerFrame
        let byteCount = Int(count) * bytesPerFrame
        guard bytesPerFrame > 0, source.count == target.count,
              zip(source, target).allSatisfy({ input, output in
                  input.mData != nil && output.mData != nil &&
                  byteOffset + byteCount <= Int(input.mDataByteSize) &&
                  byteCount <= Int(output.mDataByteSize)
              }) else {
            failed = true; status.pointee = .noDataNow; return nil
        }
        for (input, output) in zip(source, target) {
            memcpy(output.mData!, input.mData!.advanced(by: byteOffset), byteCount)
        }
        offset += count
        lastSlice = slice
        status.pointee = .haveData
        return slice
    }
}

/// AVAudioEngine callbacks have one serialized converter. Only copied PCM leaves the callback.
final class LivePCMConverter: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let inputFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat
    private let lock = NSLock()
    private var sequence: UInt64 = 0
    private var muted = false

    init(inputFormat: AVAudioFormat) throws {
        guard inputFormat.sampleRate.isFinite, inputFormat.sampleRate > 0,
              inputFormat.sampleRate <= 192_000,
              inputFormat.channelCount > 0, inputFormat.channelCount <= 8,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000,
                                         channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: output) else {
            throw LiveVoiceFailure.audio(.inputFormat)
        }
        self.converter = converter; self.inputFormat = inputFormat; outputFormat = output
    }

    func setMuted(_ value: Bool) { lock.lock(); muted = value; lock.unlock() }
    var nextSequence: UInt64 { lock.lock(); defer { lock.unlock() }; return sequence }

    func convert(_ input: AVAudioPCMBuffer) throws -> [LiveVoiceAudioChunk] {
        lock.lock(); defer { lock.unlock() }
        guard !muted, input.frameLength > 0 else { return [] }
        // A tap's requested size is a hint. Bound actual input independently of the wire chunk limit.
        guard input.format == inputFormat, input.frameLength <= input.frameCapacity,
              Double(input.frameLength) / inputFormat.sampleRate <= 1 else {
            throw LiveVoiceFailure.audio(.conversion)
        }
        let inputBuffers = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let inputBytes = inputBuffers.reduce(0) { $0 + UInt64($1.mDataByteSize) }
        guard inputBytes > 0, inputBytes <= 8 * 1_024 * 1_024,
              inputBuffers.allSatisfy({ $0.mData != nil }) else {
            throw LiveVoiceFailure.audio(.conversion)
        }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 24_000 / inputFormat.sampleRate) + 64)
        guard capacity > 0, capacity <= 24_064,
              let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw LiveVoiceFailure.audio(.conversion)
        }
        let source = LiveConverterInput(input)
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { requested, inputStatus in
            source.next(requested, inputStatus)
        }
        guard status != .error, conversionError == nil, !source.failed else {
            throw liveAudioFailure(.conversion, error: conversionError)
        }
        guard output.frameLength > 0 else { return [] }
        guard let bytes = output.audioBufferList.pointee.mBuffers.mData else {
            throw LiveVoiceFailure.audio(.conversion)
        }
        var chunks: [LiveVoiceAudioChunk] = []
        let byteCount = Int(output.frameLength) * 2
        for offset in stride(from: 0, to: byteCount, by: 16_384) {
            let data = Data(bytes: bytes.advanced(by: offset), count: min(16_384, byteCount - offset))
            chunks.append(LiveVoiceAudioChunk(sequence: sequence, pcm: data))
            sequence &+= 1
        }
        return chunks
    }
}

/// Keep numeric Core Audio status only; descriptions and userInfo can contain private device details.
private func liveAudioFailure(_ stage: LiveVoiceAudioStage, error: NSError?) -> LiveVoiceFailure {
    let status = error.flatMap { $0.domain == NSOSStatusErrorDomain ? Int32(exactly: $0.code) : nil }
    return .audio(stage, osStatus: status)
}

/// Native PCM16 mono 24 kHz duplex audio. No microphone access happens during initialization.
@MainActor public final class NativeLiveVoiceAudio: LiveVoiceAudio {
    public private(set) var echoCancellationAvailable = false
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var converter: LivePCMConverter?
    private var tapInstalled = false
    private var queuedFrames = 0
    private var generation: UInt64 = 0
    public init() {}
    public var nextCaptureSequence: UInt64? { converter?.nextSequence }

    public func requestMicrophonePermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    public func start(onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void,
                      onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws {
        stop()
        // TCC remains the official app prompt. A stale/revoked grant never opens an engine.
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw LiveVoiceFailure.microphoneDenied }
        try LiveVoiceAudioBootstrap.start(voiceProcessing: {
            try startGraph(voiceProcessing: true, onInput: onInput, onFailure: onFailure)
        }, plain: {
            try startGraph(voiceProcessing: false, onInput: onInput, onFailure: onFailure)
        })
    }

    private func startGraph(voiceProcessing: Bool,
                            onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void,
                            onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let input = engine.inputNode
        let output = engine.outputNode
        // Validate each physical side before constructing connections. Zero-rate/channel formats
        // are normal when a device is absent; passing them to AVAudioEngine can raise an assertion.
        try Self.validateDeviceFormat(input.outputFormat(forBus: 0), input: true)
        try Self.validateDeviceFormat(output.inputFormat(forBus: 0), input: false)
        if voiceProcessing {
            do { try input.setVoiceProcessingEnabled(true) }
            catch {
                engine.stop()
                throw LiveVoiceAudioStartupError(.initialization, osStatus: Self.status(error))
            }
        }
        let inputFormat = input.outputFormat(forBus: 0)
        let outputFormat = output.inputFormat(forBus: 0)
        try Self.validateDeviceFormat(inputFormat, input: true)
        try Self.validateDeviceFormat(outputFormat, input: false)
        // AVAudioIONode requires equal client formats on both Voice Processing IO sides.
        // Separate/aggregate/Bluetooth devices need not support that contract. Rebuild plain IO
        // locally instead of leaving a half-switched Voice Processing audio unit behind.
        guard !voiceProcessing || inputFormat == outputFormat else { throw LiveVoiceAudioStartupError(.duplexFormat) }
        let converter: LivePCMConverter
        do { converter = try LivePCMConverter(inputFormat: inputFormat) }
        catch { throw LiveVoiceAudioStartupError(.inputFormat) }
        guard let playbackFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000,
                                                 channels: 1, interleaved: false) else {
            throw LiveVoiceAudioStartupError(.outputFormat)
        }
        engine.attach(player)
        // 24 kHz is the wire/player format, never the hardware IO format. The mixer resamples.
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        engine.connect(engine.mainMixerNode, to: output, format: outputFormat)
        input.installTap(onBus: 0, bufferSize: 1_024, format: nil) { buffer, _ in
            do { for chunk in try converter.convert(buffer) { onInput(chunk) } }
            catch { onFailure(error as? LiveVoiceFailure ?? .audio(.conversion)) }
        }
        self.engine = engine; self.player = player; self.converter = converter; tapInstalled = true
        do {
            engine.prepare(); try engine.start(); player.play()
            echoCancellationAvailable = input.isVoiceProcessingEnabled
        } catch {
            stop()
            throw LiveVoiceAudioStartupError(.initialization, osStatus: Self.status(error))
        }
    }

    static func validateDeviceFormat(_ format: AVAudioFormat, input: Bool) throws {
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw LiveVoiceAudioStartupError(input ? .inputUnavailable : .outputUnavailable)
        }
        guard format.sampleRate.isFinite, format.sampleRate <= 192_000, format.channelCount <= 8,
              format.commonFormat != .otherFormat else {
            throw LiveVoiceAudioStartupError(input ? .inputFormat : .outputFormat)
        }
    }
    private static func status(_ error: Error) -> Int32? {
        let value = error as NSError
        return value.domain == NSOSStatusErrorDomain ? Int32(exactly: value.code) : nil
    }

    public func play(_ pcm: Data) throws {
        guard let player, let engine, engine.isRunning, !pcm.isEmpty,
              pcm.count.isMultiple(of: 2), pcm.count <= 192_000,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000,
                                        channels: 1, interleaved: false) else {
            throw LiveVoiceFailure.audio(.playback)
        }
        let count = pcm.count / 2
        guard queuedFrames + count <= 24_000 * 8 else { throw LiveVoiceFailure.audioBacklog }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let samples = buffer.floatChannelData?[0] else { throw LiveVoiceFailure.audio(.playback) }
        buffer.frameLength = AVAudioFrameCount(count)
        pcm.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for index in 0..<count {
                let bits = UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8
                samples[index] = Float(Int16(bitPattern: bits)) / 32_768
            }
        }
        queuedFrames += count
        let currentGeneration = generation
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                self.queuedFrames = max(0, self.queuedFrames - count)
            }
        }
    }

    public func setCaptureMuted(_ muted: Bool) { converter?.setMuted(muted) }
    public func stop() {
        generation &+= 1
        converter?.setMuted(true)
        if tapInstalled { engine?.inputNode.removeTap(onBus: 0) }; tapInstalled = false
        player?.stop(); engine?.stop()
        converter = nil; player = nil; engine = nil; queuedFrames = 0; echoCancellationAvailable = false
    }
}
#endif

/// Explicitly unavailable outside the delivered native Mac path.
@MainActor public final class UnavailableLiveVoiceAudio: LiveVoiceAudio {
    public var echoCancellationAvailable: Bool { false }
    public init() {}
    public func requestMicrophonePermission() async -> Bool { false }
    public func start(onInput: @escaping @Sendable (LiveVoiceAudioChunk) -> Void,
                      onFailure: @escaping @Sendable (LiveVoiceFailure) -> Void) throws { throw LiveVoiceFailure.audioUnavailable }
    public func play(_ pcm: Data) throws { throw LiveVoiceFailure.audioUnavailable }
    public func setCaptureMuted(_ muted: Bool) {}
    public func stop() {}
}
