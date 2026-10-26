#if os(macOS)
import AVFoundation
import XCTest
@testable import DexterAppCore

final class LiveVoiceAudioTests: XCTestCase {
    func testHardwareTapMayDeliver400MillisecondsAt48kHz() throws {
        try assertConversion(sampleRate: 48_000, channels: 1, frames: 19_200, chunkCount: 2)
    }

    func testHardwareTapMayDeliver400MillisecondsAt44kHzInStereo() throws {
        try assertConversion(sampleRate: 44_100, channels: 2, frames: 17_640, chunkCount: 2)
    }

    func testHardwareTapMayDeliver400MillisecondsAt48kHzInStereo() throws {
        try assertConversion(sampleRate: 48_000, channels: 2, frames: 19_200, chunkCount: 2)
    }

    func testHardwareTapMayDeliver400MillisecondsAt44kHzInMono() throws {
        try assertConversion(sampleRate: 44_100, channels: 1, frames: 17_640, chunkCount: 2)
    }

    func test100MillisecondTapAt48kHzInMono() throws {
        try assertConversion(sampleRate: 48_000, channels: 1, frames: 4_800, chunkCount: 1)
    }

    func test100MillisecondTapAt48kHzInStereo() throws {
        try assertConversion(sampleRate: 48_000, channels: 2, frames: 4_800, chunkCount: 1)
    }

    func test100MillisecondTapAt44kHzInMono() throws {
        try assertConversion(sampleRate: 44_100, channels: 1, frames: 4_410, chunkCount: 1)
    }

    func test100MillisecondTapAt44kHzInStereo() throws {
        try assertConversion(sampleRate: 44_100, channels: 2, frames: 4_410, chunkCount: 1)
    }

    func testInterleavedStereoTapAt48kHzPreservesSamples() throws {
        try assertConversion(sampleRate: 48_000, channels: 2, frames: 19_200,
                             chunkCount: 2, interleaved: true)
    }

    func testInterleavedStereoTapAt44kHzPreservesSamples() throws {
        try assertConversion(sampleRate: 44_100, channels: 2, frames: 17_640,
                             chunkCount: 2, interleaved: true)
    }

    func testMultipleTapCallbacksPreserveSamplesAndContiguousSequences() throws {
        let first = try signal(sampleRate: 48_000, channels: 2, frames: 4_800)
        let second = try signal(sampleRate: 48_000, channels: 2, frames: 19_200, offset: 4_800)
        let third = try signal(sampleRate: 48_000, channels: 2, frames: 4_800, offset: 24_000)
        let converter = try LivePCMConverter(inputFormat: first.format)
        let reference = try referenceConverter(inputFormat: first.format)
        var chunks: [LiveVoiceAudioChunk] = []
        var expected = Data()
        for buffer in [first, second, third] {
            let batch = try converter.convert(buffer)
            let referenceBatch = try referencePCM(buffer, using: reference)
            chunks += batch
            expected.append(referenceBatch)
        }
        XCTAssertEqual(chunks.map(\.sequence), [0, 1, 2, 3])
        XCTAssertEqual(converter.nextSequence, 4)
        XCTAssertEqual(chunks.reduce(into: Data()) { $0.append($1.pcm) }, expected)
        XCTAssertTrue(chunks.allSatisfy { !$0.pcm.isEmpty && $0.pcm.count <= 16_384 })
    }

    func testMutedCallbacksEmitNothingAndDoNotAdvanceSequence() throws {
        let buffer = try signal(sampleRate: 48_000, channels: 1, frames: 19_200)
        let converter = try LivePCMConverter(inputFormat: buffer.format)
        XCTAssertEqual(try converter.convert(buffer).map(\.sequence), [0, 1])
        converter.setMuted(true)
        XCTAssertTrue(try converter.convert(buffer).isEmpty)
        XCTAssertTrue(try converter.convert(buffer).isEmpty)
        XCTAssertEqual(converter.nextSequence, 2)
        converter.setMuted(false)
        XCTAssertEqual(try converter.convert(buffer).map(\.sequence), [2, 3])
        XCTAssertEqual(converter.nextSequence, 4)
    }

    func testEmptyInputDoesNotEmitOrAdvanceSequence() throws {
        let buffer = try signal(sampleRate: 48_000, channels: 1, frames: 1)
        buffer.frameLength = 0
        let converter = try LivePCMConverter(inputFormat: buffer.format)
        XCTAssertTrue(try converter.convert(buffer).isEmpty)
        XCTAssertEqual(converter.nextSequence, 0)
    }

    func testInputOverOneSecondIsRejectedWithoutAdvancingSequence() throws {
        let buffer = try signal(sampleRate: 48_000, channels: 2, frames: 48_001)
        let converter = try LivePCMConverter(inputFormat: buffer.format)
        XCTAssertThrowsError(try converter.convert(buffer)) {
            self.assertAudioFailure($0, stage: .conversion)
        }
        XCTAssertEqual(converter.nextSequence, 0)
    }

    func testOneSecondInputIsConvertedIntoBoundedChunks() throws {
        try assertConversion(sampleRate: 48_000, channels: 1, frames: 48_000, chunkCount: 3)
    }

    func testChangedInputFormatIsRejectedBeforeConversion() throws {
        let original = try signal(sampleRate: 48_000, channels: 1, frames: 4_800)
        let replacement = try signal(sampleRate: 44_100, channels: 1, frames: 4_410)
        let converter = try LivePCMConverter(inputFormat: original.format)
        XCTAssertThrowsError(try converter.convert(replacement)) {
            self.assertAudioFailure($0, stage: .conversion)
        }
        XCTAssertEqual(converter.nextSequence, 0)
    }

    func testUnsupportedSampleRateHasInputFormatFailure() throws {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 384_000,
                                               channels: 1, interleaved: false))
        XCTAssertThrowsError(try LivePCMConverter(inputFormat: format)) {
            self.assertAudioFailure($0, stage: .inputFormat)
        }
    }

    func testLargestSupportedCaptureFormatStillProducesBoundedChunks() throws {
        try assertConversion(sampleRate: 192_000, channels: 8, frames: 192_000, chunkCount: 3)
    }

    func testUnsupportedChannelCountHasInputFormatFailure() throws {
        let buffer = try signal(sampleRate: 48_000, channels: 9, frames: 1)
        XCTAssertThrowsError(try LivePCMConverter(inputFormat: buffer.format)) {
            self.assertAudioFailure($0, stage: .inputFormat)
        }
    }

    private func assertAudioFailure(_ error: Error, stage: LiveVoiceAudioStage,
                                    file: StaticString = #filePath, line: UInt = #line) {
        guard let failure = error as? LiveVoiceFailure, case .audio(let actualStage, let status) = failure else {
            return XCTFail("Expected typed native audio failure", file: file, line: line)
        }
        XCTAssertEqual(actualStage.rawValue, stage.rawValue, file: file, line: line)
        XCTAssertNil(status, file: file, line: line)
    }

    private func assertConversion(sampleRate: Double, channels: AVAudioChannelCount,
                                  frames: AVAudioFrameCount, chunkCount: Int,
                                  interleaved: Bool = false,
                                  file: StaticString = #filePath, line: UInt = #line) throws {
        let buffer = try signal(sampleRate: sampleRate, channels: channels, frames: frames, interleaved: interleaved)
        let converter = try LivePCMConverter(inputFormat: buffer.format)
        let chunks = try converter.convert(buffer)
        XCTAssertEqual(chunks.count, chunkCount, file: file, line: line)
        XCTAssertEqual(chunks.map(\.sequence), (0..<UInt64(chunkCount)).map { $0 }, file: file, line: line)
        XCTAssertEqual(converter.nextSequence, UInt64(chunkCount), file: file, line: line)
        XCTAssertTrue(chunks.allSatisfy {
            !$0.pcm.isEmpty && $0.pcm.count <= 16_384 && $0.pcm.count.isMultiple(of: 2)
        }, file: file, line: line)
        let actual = chunks.reduce(into: Data()) { $0.append($1.pcm) }
        let reference = try referenceConverter(inputFormat: buffer.format)
        let expected = try referencePCM(buffer, using: reference)
        XCTAssertEqual(actual, expected, file: file, line: line)
        XCTAssertTrue(actual.contains { $0 != 0 }, file: file, line: line)
    }

    private func signal(sampleRate: Double, channels: AVAudioChannelCount,
                        frames: AVAudioFrameCount, offset: Int = 0,
                        interleaved: Bool = false) throws -> AVAudioPCMBuffer {
        let format: AVAudioFormat
        if channels > 2 {
            let tag = channels == 8 ? kAudioChannelLayoutTag_MPEG_7_1_A : kAudioChannelLayoutTag_DiscreteInOrder | channels
            let layout = try XCTUnwrap(AVAudioChannelLayout(layoutTag: tag))
            format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                                interleaved: interleaved, channelLayout: layout))
        } else {
            format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                               sampleRate: sampleRate, channels: channels,
                                               interleaved: interleaved))
        }
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData)
        for channel in 0..<Int(channels) {
            for frame in 0..<Int(frames) {
                let amplitude: Float = channel == 0 ? 0.25 : -0.125
                let value = amplitude * sin(Float(frame + offset) * 2 * .pi * 440 / Float(sampleRate))
                if interleaved { samples[0][frame * Int(channels) + channel] = value }
                else { samples[channel][frame] = value }
            }
        }
        return buffer
    }

    private func referenceConverter(inputFormat: AVAudioFormat) throws -> AVAudioConverter {
        let output = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000,
                                               channels: 1, interleaved: true))
        return try XCTUnwrap(AVAudioConverter(from: inputFormat, to: output))
    }

    // Independent unsplit native conversion catches dropped/reordered PCM at our wire chunk boundary.
    private func referencePCM(_ input: AVAudioPCMBuffer, using converter: AVAudioConverter) throws -> Data {
        let output = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 24_064))
        let source = ReferenceInput(input)
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { requested, inputStatus in source.next(requested, inputStatus) }
        XCTAssertNotEqual(status, .error)
        XCTAssertNil(error)
        let bytes = try XCTUnwrap(output.audioBufferList.pointee.mBuffers.mData)
        return Data(bytes: bytes, count: Int(output.frameLength) * 2)
    }
}

private final class ReferenceInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    private var offset: AVAudioFrameCount = 0
    private var lastSlice: AVAudioPCMBuffer?
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func next(_ requested: AVAudioPacketCount, _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        let count = min(requested, buffer.frameLength - offset)
        guard count > 0, let slice = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: count),
              let source = buffer.floatChannelData, let target = slice.floatChannelData else {
            status.pointee = .noDataNow; return nil
        }
        slice.frameLength = count
        let channels = Int(buffer.format.channelCount)
        if buffer.format.isInterleaved {
            target[0].update(from: source[0].advanced(by: Int(offset) * channels), count: Int(count) * channels)
        } else {
            for channel in 0..<channels {
                target[channel].update(from: source[channel].advanced(by: Int(offset)), count: Int(count))
            }
        }
        offset += count
        lastSlice = slice
        status.pointee = .haveData
        return slice
    }
}
#endif
