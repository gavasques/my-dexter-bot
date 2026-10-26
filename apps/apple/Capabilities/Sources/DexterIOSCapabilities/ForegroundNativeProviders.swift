#if os(iOS)
import AVFoundation
import Contacts
import ContactsUI
import CoreLocation
import DexterNativeActions
import EventKit
import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// Real iOS adapters. Construction performs no permission query, prompt, picker, capture, or read.
/// The local consent boundary is the only intended caller of `perform`.
@MainActor
public final class IOSForegroundNativeProvider: IOSForegroundCapabilityBackend, IOSForegroundPermissionPreparationBackend {
    public init() {}

    public func preparePermission(for capability: IOSNativeCapability) async throws {
        switch capability {
        case .calendar:
            let store = EKEventStore()
            let authorized: Bool
            switch EKEventStore.authorizationStatus(for: .event) {
            case .fullAccess: authorized = true
            case .notDetermined: authorized = try await store.requestFullAccessToEvents()
            case .writeOnly, .denied, .restricted: authorized = false
            @unknown default: authorized = false
            }
            try Task.checkCancellation()
            guard authorized else { throw IOSForegroundCapabilityError.permissionDenied }
        case .location:
            try await prepareWhenInUseLocationPermission()
        case .camera:
            let status = AVCaptureDevice.authorizationStatus(for: .video)
            let authorized: Bool
            switch status {
            case .authorized: authorized = true
            case .notDetermined: authorized = await AVCaptureDevice.requestAccess(for: .video)
            case .denied, .restricted: authorized = false
            @unknown default: authorized = false
            }
            try Task.checkCancellation()
            guard authorized else { throw IOSForegroundCapabilityError.permissionDenied }
        case .microphone:
            let status = AVAudioApplication.shared.recordPermission
            let authorized: Bool
            switch status {
            case .granted: authorized = true
            case .undetermined:
                authorized = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                    AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
                }
            case .denied: authorized = false
            @unknown default: authorized = false
            }
            try Task.checkCancellation()
            guard authorized else { throw IOSForegroundCapabilityError.permissionDenied }
        case .contacts, .files, .photos:
            // These operations use system pickers and do not request app-wide data access.
            return
        }
    }

    public func perform(_ request: IOSForegroundCapabilityRequest) async throws -> IOSForegroundCapabilityOutcome {
        try await request.checkAuthorization()
        guard UIApplication.shared.applicationState == .active else { throw IOSForegroundCapabilityError.inactive }
        switch request.capability {
        case .calendar:
            return try await readUpcomingEvents(in: request)
        case .contacts:
            return .value(.contact(name: try await selectContactName(using: request)))
        case .location:
            let coordinate = try await approximateLocation(using: request)
            return .value(.location(latitude: coordinate.latitude, longitude: coordinate.longitude))
        case .files:
            let (name, bytes) = try await selectAndReadTextFile(using: request)
            return .value(.file(name: name, bytes: bytes))
        case .photos:
            return .value(.photo(jpeg: try await selectPhotoJPEG(using: request)))
        case .camera:
            return .value(.cameraImage(jpeg: try await captureOneJPEG(using: request)))
        case .microphone:
            let (data, duration, sampleRate) = try await recordShortAudio(using: request)
            return .value(.microphone(pcm16Mono: data, duration: duration, sampleRate: sampleRate))
        }
    }

    private func readUpcomingEvents(in request: IOSForegroundCapabilityRequest) async throws -> IOSForegroundCapabilityOutcome {
        try await request.checkAuthorization()
        let store = EKEventStore()
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw IOSForegroundCapabilityError.permissionDenied
        }
        try await request.checkAuthorization()
        let predicate = store.predicateForEvents(withStart: request.calendarStart, end: request.calendarEnd, calendars: nil)
        let candidates = store.events(matching: predicate).map {
            IOSCalendarEventCandidate(title: $0.title, start: $0.startDate)
        }
        let events = IOSCalendarEventWindowPolicy.summaries(from: candidates,
                                                            start: request.calendarStart,
                                                            end: request.calendarEnd)
        return events.isEmpty ? .empty : .value(.calendar(Array(events)))
    }

    private func selectContactName(using request: IOSForegroundCapabilityRequest) async throws -> String {
        try await request.checkAuthorization()
        let session = ForegroundPickerSession<String>()
        let delegate = ContactSelectionDelegate(session: session)
        let picker = CNContactPickerViewController()
        picker.displayedPropertyKeys = [CNContactGivenNameKey, CNContactFamilyNameKey]
        picker.delegate = delegate
        session.retainedDelegate = delegate
        return try await present(picker, session: session, request: request)
    }

    private func selectAndReadTextFile(using request: IOSForegroundCapabilityRequest) async throws -> (String, Data) {
        try await request.checkAuthorization()
        let session = ForegroundPickerSession<URL>()
        let delegate = DocumentSelectionDelegate(session: session)
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.plainText], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = delegate
        session.retainedDelegate = delegate
        let url = try await present(picker, session: session, request: request)
        try Task.checkCancellation()
        try await request.checkAuthorization()
        guard url.pathExtension.lowercased() == "txt" || UTType(filenameExtension: url.pathExtension)?.conforms(to: .plainText) == true else {
            throw IOSForegroundCapabilityError.resultRejected
        }
        try await request.checkAuthorization()
        let hasScope = url.startAccessingSecurityScopedResource()
        defer { if hasScope { url.stopAccessingSecurityScopedResource() } }
        let start = ContinuousClock.now
        let name = url.lastPathComponent
        let bytes = try await Task.detached(priority: .userInitiated) {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let result = try handle.read(upToCount: IOSForegroundCapabilityBoundary.maximumFileBytes + 1) ?? Data()
            guard !result.isEmpty, result.count <= IOSForegroundCapabilityBoundary.maximumFileBytes else {
                throw IOSForegroundCapabilityError.resultRejected
            }
            return result
        }.value
        try Task.checkCancellation()
        try await request.checkAuthorization()
        guard start.duration(to: .now) <= .seconds(8) else { throw IOSForegroundCapabilityError.offline }
        return (name, bytes)
    }

    private func selectPhotoJPEG(using request: IOSForegroundCapabilityRequest) async throws -> Data {
        try await request.checkAuthorization()
        let session = ForegroundPickerSession<Data>()
        let delegate = PhotoSelectionDelegate(session: session, request: request)
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = delegate
        session.retainedDelegate = delegate
        do {
            let jpeg = try await present(picker, session: session, request: request)
            await delegate.waitForAssetLoadDrain()
            try await request.checkAuthorization()
            return jpeg
        } catch {
            await delegate.waitForAssetLoadDrain()
            throw error
        }
    }

    private func captureOneJPEG(using request: IOSForegroundCapabilityRequest) async throws -> Data {
        try await request.checkAuthorization()
        try Task.checkCancellation()
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            throw IOSForegroundCapabilityError.permissionDenied
        }
        try await request.checkAuthorization()
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else { throw IOSForegroundCapabilityError.unsupported }
        let session = ForegroundPickerSession<Data>()
        let delegate = CameraCaptureDelegate(session: session)
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.mediaTypes = [UTType.image.identifier]
        picker.delegate = delegate
        session.retainedDelegate = delegate
        return try await present(picker, session: session, request: request)
    }

    private func approximateLocation(using request: IOSForegroundCapabilityRequest) async throws -> CLLocationCoordinate2D {
        let locationRequest = ApproximateLocationRequest()
        return try await locationRequest.value(using: request)
    }

    private func recordShortAudio(using request: IOSForegroundCapabilityRequest) async throws -> (Data, TimeInterval, Double) {
        try await request.checkAuthorization()
        guard AVAudioApplication.shared.recordPermission == .granted else {
            throw IOSForegroundCapabilityError.permissionDenied
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true)
        defer { try? session.setActive(false, options: [.notifyOthersOnDeactivation]) }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        let actualRate = format.sampleRate
        guard actualRate.isFinite, actualRate >= 8_000 else { throw IOSForegroundCapabilityError.unsupported }
        let stride = max(1, Int(ceil(actualRate / 48_000)))
        let storedRate = actualRate / Double(stride)
        guard let maximumSamples = IOSForegroundAudioSamplePolicy.maximumSamples(storedSampleRate: storedRate) else {
            throw IOSForegroundCapabilityError.unsupported
        }
        let accumulator = PCM16Accumulator(maximumSamples: maximumSamples)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            guard let channel = buffer.floatChannelData?.pointee else { return }
            accumulator.append(channel, count: Int(buffer.frameLength), stride: stride)
        }
        do {
            try engine.start()
            let recordingStartedAt = ContinuousClock.now
            try await Task.sleep(for: .seconds(IOSForegroundCapabilityBoundary.maximumAudioDuration))
            let elapsed = recordingStartedAt.duration(to: .now)
            let elapsedParts = elapsed.components
            let elapsedSeconds = Double(elapsedParts.seconds) + Double(elapsedParts.attoseconds) / 1_000_000_000_000_000_000
            engine.stop()
            input.removeTap(onBus: 0)
            try Task.checkCancellation()
            let bytes = accumulator.data()
            guard !bytes.isEmpty, bytes.count <= IOSForegroundCapabilityBoundary.maximumAudioBytes else {
                throw IOSForegroundCapabilityError.resultRejected
            }
            let includedDuration = Double(bytes.count / MemoryLayout<Int16>.size) / storedRate
            let duration = min(includedDuration, elapsedSeconds, IOSForegroundCapabilityBoundary.maximumAudioDuration)
            guard elapsedSeconds > 0, elapsedSeconds.isFinite,
                  duration > 0, duration.isFinite,
                  duration <= IOSForegroundCapabilityBoundary.maximumAudioDuration,
                  abs(includedDuration - duration) <= 0.05 else {
                throw IOSForegroundCapabilityError.resultRejected
            }
            return (bytes, duration, storedRate)
        } catch {
            engine.stop()
            input.removeTap(onBus: 0)
            throw error
        }
    }

    private func prepareWhenInUseLocationPermission() async throws {
        let requester = WhenInUseLocationPermissionRequester()
        try await requester.prepare()
    }

    private func present<Value: Sendable>(_ controller: UIViewController,
                                           session: ForegroundPickerSession<Value>,
                                           request: IOSForegroundCapabilityRequest) async throws -> Value {
        try await request.checkAuthorization()
        let presenter = try visiblePresenter()
        try Task.checkCancellation()
        try await request.checkAuthorization()
        return try await session.present(controller, from: presenter)
    }

    private func visiblePresenter() throws -> UIViewController {
        let activeScenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
        guard activeScenes.count == 1,
              let window = activeScenes[0].windows.first(where: \.isKeyWindow),
              var presenter = window.rootViewController else { throw IOSForegroundCapabilityError.inactive }
        while let next = presenter.presentedViewController { presenter = next }
        return presenter
    }
}

@MainActor
private final class ForegroundPickerSession<Value: Sendable> {
    var retainedDelegate: AnyObject?
    private weak var presenter: UIViewController?
    private weak var controller: UIViewController?
    private var continuation: CheckedContinuation<Value, any Error>?
    private var finished = false
    private var cancelUnderlyingLoad: (() -> Void)?
    private let assetLoadDrain = IOSForegroundCallbackDrain()

    func present(_ controller: UIViewController, from presenter: UIViewController) async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Value, any Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                self.presenter = presenter
                self.controller = controller
                presenter.present(controller, animated: true)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    func finish(_ result: Result<Value, any Error>) {
        guard !finished, let continuation else { return }
        finished = true
        if case .failure = result { cancelUnderlyingLoad?() }
        cancelUnderlyingLoad = nil
        self.continuation = nil
        retainedDelegate = nil
        if let controller, controller.presentingViewController != nil {
            controller.dismiss(animated: true) { continuation.resume(with: result) }
        } else {
            continuation.resume(with: result)
        }
    }

    func ensureActive() throws {
        guard !finished else { throw CancellationError() }
    }

    func setCancellationHandler(_ handler: @escaping () -> Void) {
        if finished { handler() } else { cancelUnderlyingLoad = handler }
    }

    func beginAssetLoad() async throws {
        try ensureActive()
        await assetLoadDrain.begin()
    }

    func endAssetLoad() async { await assetLoadDrain.end() }

    func waitForAssetLoadDrain() async { await assetLoadDrain.waitForDrain() }
}

@MainActor
private final class ContactSelectionDelegate: NSObject, @preconcurrency CNContactPickerDelegate {
    private let session: ForegroundPickerSession<String>
    init(session: ForegroundPickerSession<String>) { self.session = session }
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        let name = [contact.givenName, contact.familyName]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        session.finish(name.isEmpty ? .failure(IOSForegroundCapabilityError.empty) : .success(name))
    }
    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        session.finish(.failure(IOSForegroundCapabilityError.pickerCancelled))
    }
}

@MainActor
private final class DocumentSelectionDelegate: NSObject, UIDocumentPickerDelegate {
    private let session: ForegroundPickerSession<URL>
    init(session: ForegroundPickerSession<URL>) { self.session = session }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard urls.count == 1, let url = urls.first else {
            session.finish(.failure(IOSForegroundCapabilityError.resultRejected))
            return
        }
        session.finish(.success(url))
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        session.finish(.failure(IOSForegroundCapabilityError.pickerCancelled))
    }
}

@MainActor
private final class PhotoSelectionDelegate: NSObject, PHPickerViewControllerDelegate {
    private let session: ForegroundPickerSession<Data>
    private let request: IOSForegroundCapabilityRequest
    init(session: ForegroundPickerSession<Data>, request: IOSForegroundCapabilityRequest) {
        self.session = session
        self.request = request
    }
    func waitForAssetLoadDrain() async { await session.waitForAssetLoadDrain() }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard results.count == 1, let provider = results.first?.itemProvider,
              provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else {
            session.finish(.failure(results.isEmpty ? IOSForegroundCapabilityError.pickerCancelled : IOSForegroundCapabilityError.resultRejected))
            return
        }
        let request = self.request
        let pickerSession = self.session
        Task { @MainActor [weak pickerSession] in
            guard let pickerSession else { return }
            do {
                try await request.checkAuthorization()
                try await pickerSession.beginAssetLoad()
                try Task.checkCancellation()
                try await request.checkAuthorization()
            } catch {
                pickerSession.finish(.failure(error))
                await pickerSession.endAssetLoad()
                return
            }
            let progress = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak pickerSession] url, error in
                let encoded: Result<Data, IOSForegroundCapabilityError>
                do {
                    guard let url, error == nil else { throw IOSForegroundCapabilityError.backendUnavailable }
                    encoded = .success(try IOSForegroundPhotoFileProcessor.jpegFromTemporaryFile(at: url) {
                        try request.checkCallbackAuthorization()
                    })
                } catch let error as IOSForegroundCapabilityError {
                    encoded = .failure(error)
                } catch {
                    encoded = .failure(.backendUnavailable)
                }

                Task { @MainActor [weak pickerSession] in
                    guard let pickerSession else { return }
                    do {
                        try await request.checkAuthorization()
                        try pickerSession.ensureActive()
                        switch encoded {
                        case .success(let data): pickerSession.finish(.success(data))
                        case .failure(let error): pickerSession.finish(.failure(error))
                        }
                    } catch {
                        pickerSession.finish(.failure(error))
                    }
                    await pickerSession.endAssetLoad()
                }
            }
            pickerSession.setCancellationHandler { progress.cancel() }
        }
    }
}

@MainActor
private final class CameraCaptureDelegate: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
    private let session: ForegroundPickerSession<Data>
    init(session: ForegroundPickerSession<Data>) { self.session = session }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        guard let image = info[.originalImage] as? UIImage else {
            session.finish(.failure(IOSForegroundCapabilityError.empty))
            return
        }
        guard let target = IOSForegroundImagePixelPolicy.outputSize(pointWidth: Double(image.size.width),
                                                                     pointHeight: Double(image.size.height)) else {
            session.finish(.failure(IOSForegroundCapabilityError.resultRejected))
            return
        }
        let outputSize = CGSize(width: target.width, height: target.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
        let resized = renderer.image { _ in
            // UIImage.draw applies the source image orientation before encoding.
            image.draw(in: CGRect(origin: .zero, size: outputSize))
        }
        guard let rendered = resized.cgImage,
              rendered.width <= 2_048, rendered.height <= 2_048,
              let jpeg = resized.jpegData(compressionQuality: 0.82),
              jpeg.count <= IOSForegroundCapabilityBoundary.maximumImageBytes else {
            session.finish(.failure(IOSForegroundCapabilityError.resultRejected))
            return
        }
        session.finish(.success(jpeg))
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        session.finish(.failure(IOSForegroundCapabilityError.pickerCancelled))
    }
}

@MainActor
private final class ApproximateLocationRequest: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, any Error>?
    private var timeout: Task<Void, Never>?
    private var authorizationRequest: IOSForegroundCapabilityRequest?
    private var locationRequestStarted = false

    func value(using request: IOSForegroundCapabilityRequest) async throws -> CLLocationCoordinate2D {
        try await request.checkAuthorization()
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else {
            throw IOSForegroundCapabilityError.permissionDenied
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CLLocationCoordinate2D, any Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                authorizationRequest = request
                manager.delegate = self
                manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
                timeout = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled else { return }
                    self?.finish(.failure(IOSForegroundCapabilityError.offline))
                }
                authorizationChanged(manager)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { authorizationChanged(manager) }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else {
            finish(.failure(IOSForegroundCapabilityError.empty))
            return
        }
        guard let authorizationRequest else { finish(.failure(IOSForegroundCapabilityError.consentMissing)); return }
        Task { @MainActor in
            do {
                try await authorizationRequest.checkAuthorization()
                guard let rounded = IOSForegroundLocationPrecisionPolicy.rounded(
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude
                ) else { throw IOSForegroundCapabilityError.resultRejected }
                self.finish(.success(CLLocationCoordinate2D(latitude: rounded.latitude, longitude: rounded.longitude)))
            } catch {
                self.finish(.failure(error))
            }
        }
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        finish(.failure(IOSForegroundCapabilityError.offline))
    }

    private func authorizationChanged(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            guard !locationRequestStarted, let authorizationRequest else { return }
            locationRequestStarted = true
            Task { @MainActor in
                do {
                    try await authorizationRequest.checkAuthorization()
                    try Task.checkCancellation()
                    manager.requestLocation()
                } catch {
                    self.finish(.failure(error))
                }
            }
        case .denied, .restricted:
            finish(.failure(IOSForegroundCapabilityError.permissionDenied))
        case .notDetermined: break
        @unknown default: finish(.failure(IOSForegroundCapabilityError.permissionDenied))
        }
    }

    private func finish(_ result: Result<CLLocationCoordinate2D, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timeout?.cancel()
        timeout = nil
        authorizationRequest = nil
        manager.delegate = nil
        manager.stopUpdatingLocation()
        continuation.resume(with: result)
    }
}

private final class PCM16Accumulator: @unchecked Sendable {
    private let lock = NSLock()
    private let maximumSamples: Int
    private var samples = [Int16]()
    init(maximumSamples: Int) { self.maximumSamples = maximumSamples }

    func append(_ source: UnsafePointer<Float>, count: Int, stride: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard samples.count < maximumSamples else { return }
        var index = 0
        while index < count && samples.count < maximumSamples {
            let value = max(-1, min(1, source[index]))
            samples.append(Int16(value * Float(Int16.max)))
            index += stride
        }
    }

    func data() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return samples.withUnsafeBytes { Data($0) }
    }
}

@MainActor
private final class WhenInUseLocationPermissionRequester: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<Void, any Error>?

    func prepare() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            guard !Task.isCancelled else {
                continuation.resume(throwing: CancellationError())
                return
            }
            self.continuation = continuation
            manager.delegate = self
            switch manager.authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways:
                finish(.success(()))
            case .notDetermined:
                manager.requestWhenInUseAuthorization()
            case .denied, .restricted:
                finish(.failure(IOSForegroundCapabilityError.permissionDenied))
            @unknown default:
                finish(.failure(IOSForegroundCapabilityError.permissionDenied))
            }
        }
        try Task.checkCancellation()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: finish(.success(()))
        case .denied, .restricted: finish(.failure(IOSForegroundCapabilityError.permissionDenied))
        case .notDetermined: break
        @unknown default: finish(.failure(IOSForegroundCapabilityError.permissionDenied))
        }
    }

    private func finish(_ result: Result<Void, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        manager.delegate = nil
        continuation.resume(with: result)
    }
}
#endif
