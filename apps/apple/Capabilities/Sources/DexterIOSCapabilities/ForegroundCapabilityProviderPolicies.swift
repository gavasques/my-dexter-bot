import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct IOSCalendarEventCandidate: Sendable, Equatable {
    let title: String?
    let start: Date
}

enum IOSCalendarEventWindowPolicy {
    static func summaries(from candidates: [IOSCalendarEventCandidate],
                          start: Date,
                          end: Date,
                          limit: Int = 10) -> [IOSCalendarEventSummary] {
        guard start.timeIntervalSince1970.isFinite,
              end.timeIntervalSince1970.isFinite,
              start <= end,
              limit > 0 else { return [] }

        return candidates
            .filter { $0.start.timeIntervalSince1970.isFinite && $0.start >= start && $0.start <= end }
            .sorted { $0.start < $1.start }
            .compactMap { candidate -> IOSCalendarEventSummary? in
                guard let title = candidate.title else { return nil }
                let minimized = String(title.prefix(200))
                guard !minimized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return IOSCalendarEventSummary(title: minimized, start: candidate.start)
            }
            .prefix(limit)
            .map { $0 }
    }
}

struct IOSForegroundImagePixelSize: Sendable, Equatable {
    let width: Int
    let height: Int
}

enum IOSForegroundImagePixelPolicy {
    static func outputSize(pointWidth: Double,
                           pointHeight: Double,
                           maximumPixelDimension: Int = 2_048) -> IOSForegroundImagePixelSize? {
        guard pointWidth.isFinite, pointHeight.isFinite,
              pointWidth > 0, pointHeight > 0, maximumPixelDimension > 0 else { return nil }
        let scale = min(1, Double(maximumPixelDimension) / max(pointWidth, pointHeight))
        return IOSForegroundImagePixelSize(width: max(1, Int((pointWidth * scale).rounded(.down))),
                                           height: max(1, Int((pointHeight * scale).rounded(.down))))
    }
}

enum IOSForegroundPhotoFileProcessor {
    static let maximumSourceBytes = 32 * 1_024 * 1_024

    /// Reads a selected provider URL only while its callback-scoped file is alive.
    /// The returned source is bounded memory data; this helper never creates a persistent copy.
    static func jpegFromTemporaryFile(at url: URL,
                                      authorize: () throws -> Void = {}) throws -> Data {
        try authorize()
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var source = Data()
        while source.count <= maximumSourceBytes {
            try authorize()
            let count = min(64 * 1_024, maximumSourceBytes + 1 - source.count)
            guard count > 0 else { break }
            let chunk = try handle.read(upToCount: count) ?? Data()
            guard !chunk.isEmpty else { break }
            source.append(chunk)
        }
        try authorize()
        guard !source.isEmpty, source.count <= maximumSourceBytes else {
            throw IOSForegroundCapabilityError.resultRejected
        }
        return try jpeg(fromBoundedSource: source)
    }

    static func jpeg(fromBoundedSource source: Data) throws -> Data {
        guard !source.isEmpty, source.count <= maximumSourceBytes,
              let imageSource = CGImageSourceCreateWithData(source as CFData, nil) else {
            throw IOSForegroundCapabilityError.resultRejected
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 2_048,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, options as CFDictionary),
              image.width > 0, image.height > 0,
              image.width <= 2_048, image.height <= 2_048 else {
            throw IOSForegroundCapabilityError.resultRejected
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw IOSForegroundCapabilityError.backendUnavailable
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(destination),
              output.length > 0,
              output.length <= IOSForegroundCapabilityBoundary.maximumImageBytes else {
            throw IOSForegroundCapabilityError.resultRejected
        }
        return output as Data
    }
}

enum IOSForegroundLocationPrecisionPolicy {
    static func rounded(latitude: Double, longitude: Double) -> (latitude: Double, longitude: Double)? {
        guard latitude.isFinite, longitude.isFinite,
              (-90...90).contains(latitude), (-180...180).contains(longitude) else { return nil }
        return ((latitude * 100).rounded() / 100, (longitude * 100).rounded() / 100)
    }
}

enum IOSForegroundAudioSamplePolicy {
    static func maximumSamples(storedSampleRate: Double) -> Int? {
        guard storedSampleRate.isFinite, (8_000...48_000).contains(storedSampleRate) else { return nil }
        let durationBound = Int((IOSForegroundCapabilityBoundary.maximumAudioDuration * storedSampleRate).rounded(.down))
        return min(durationBound, IOSForegroundCapabilityBoundary.maximumAudioBytes / MemoryLayout<Int16>.size)
    }
}

actor IOSForegroundCallbackDrain {
    private var activeCallbacks = 0
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiterObservers: [CheckedContinuation<Void, Never>] = []

    func begin() { activeCallbacks += 1 }

    func end() {
        guard activeCallbacks > 0 else { return }
        activeCallbacks -= 1
        guard activeCallbacks == 0 else { return }
        let waiters = drainWaiters
        drainWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    func waitForDrain() async {
        guard activeCallbacks > 0 else { return }
        await withCheckedContinuation { continuation in
            drainWaiters.append(continuation)
            let observers = waiterObservers
            waiterObservers.removeAll()
            observers.forEach { $0.resume() }
        }
    }

    func waitUntilDrainWaiterRegistered() async {
        guard drainWaiters.isEmpty else { return }
        await withCheckedContinuation { waiterObservers.append($0) }
    }

    var activeCallbackCount: Int { activeCallbacks }
}
