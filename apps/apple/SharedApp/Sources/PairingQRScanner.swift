#if os(iOS)
@preconcurrency import AVFoundation
import DexterAppCore
import SwiftUI
import UIKit

/// No image is captured or retained. Only one QR string is handed to the private review, never to logs or chat.
struct PairingQRScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.locale) private var locale
    let read: (String) -> Void
    @State private var camera: PairingQRCamera?
    @State private var failure: PairingQRCamera.Failure?

    private func t(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let camera { PairingQRPreview(session: camera.session).ignoresSafeArea(edges: .bottom) }
                VStack {
                    Text(t("Aponte para o QR no Dexter do Mac", "Point at the QR code in Dexter on your Mac"))
                        .font(.headline).multilineTextAlignment(.center).padding(18)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                    Spacer()
                    if let failure {
                        VStack(spacing: 12) {
                            Text(failure == .permission ? t("Permita a câmera nos Ajustes do iPhone ou use Colar convite.", "Allow camera access in iPhone Settings or use Paste invitation.")
                                : t("A câmera não está disponível. Use Colar convite.", "The camera is unavailable. Use Paste invitation."))
                            Button(t("Voltar", "Back")) { dismiss() }.buttonStyle(.borderedProminent)
                        }.padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                        .accessibilityIdentifier("ios-pairing.scanner.unavailable")
                    }
                }.padding(24)
            }
            .navigationTitle(t("Escanear QR", "Scan QR code")).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(t("Cancelar", "Cancel")) { camera?.stop(); dismiss() }
                        .accessibilityIdentifier("ios-pairing.scanner.close")
                }
            }
        }
        .accessibilityIdentifier("ios-pairing.scanner")
        .task {
            // This view is created only by Scan's explicit gesture. No permission request occurs at app launch.
            let next = PairingQRCamera(read: { text in camera?.stop(); read(text) }, failed: { failure = $0 })
            camera = next
            await next.start()
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { camera?.stop(); dismiss() } }
        .onDisappear { camera?.stop(); camera = nil }
    }
}

@MainActor private final class PairingQRCamera {
    enum Failure: Sendable { case permission, unavailable }
    private lazy var capture = PairingQRCapture(read: { [weak self] text in
        Task { @MainActor in guard let self, self.active else { return }; self.readResult(text) }
    }, failed: { [weak self] in
        Task { @MainActor in guard let self, self.active else { return }; self.failed(.unavailable) }
    })
    private var active = true
    private let readResult: @MainActor (String) -> Void
    private let failed: @MainActor (Failure) -> Void
    var session: AVCaptureSession { capture.session }
    init(read: @escaping @MainActor (String) -> Void, failed: @escaping @MainActor (Failure) -> Void) {
        self.failed = failed; readResult = read
    }
    func start() async {
        let allowed: Bool
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: allowed = true
        case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
        default: allowed = false
        }
        guard active, !Task.isCancelled else { return }
        guard allowed else { failed(.permission); return }
        capture.start()
    }
    func stop() { active = false; capture.stop() }
}

/// AVFoundation graph/start/stop are serialized on this owned queue. The preview only attaches the session;
/// metadata is delivered on the same queue. The lock closes the result gate synchronously on dismissal.
private final class PairingQRCapture: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.dexter.pairing.qr-camera")
    private let gate = NSLock()
    private var acceptsResult = true
    private let read: @Sendable (String) -> Void
    private let failed: @Sendable () -> Void
    init(read: @escaping @Sendable (String) -> Void, failed: @escaping @Sendable () -> Void) {
        self.read = read; self.failed = failed
    }
    func start() {
        queue.async { [self] in
            guard gate.withLock({ acceptsResult }) else { return }
            do {
                guard let device = AVCaptureDevice.default(for: .video) else { failed(); return }
                let input = try AVCaptureDeviceInput(device: device), output = AVCaptureMetadataOutput()
                session.beginConfiguration()
                guard session.canAddInput(input), session.canAddOutput(output) else {
                    session.commitConfiguration(); failed(); return
                }
                session.addInput(input); session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: queue)
                guard output.availableMetadataObjectTypes.contains(.qr) else {
                    session.commitConfiguration(); failed(); return
                }
                output.metadataObjectTypes = [.qr]
                session.commitConfiguration()
                guard gate.withLock({ acceptsResult }) else { return }
                session.startRunning()
            } catch { failed() }
        }
    }
    func stop() {
        gate.withLock { acceptsResult = false }
        queue.async { [self] in if session.isRunning { session.stopRunning() } }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first(where: { $0.type == .qr })?.stringValue,
              code.utf8.count <= PairingInvitationPreview.maximumBytes else { return }
        let accepted = gate.withLock { guard acceptsResult else { return false }; acceptsResult = false; return true }
        guard accepted else { return }
        if session.isRunning { session.stopRunning() }
        read(code)
    }
}

private final class PairingQRPreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}
private struct PairingQRPreview: UIViewRepresentable {
    let session: AVCaptureSession
    func makeUIView(context: Context) -> PairingQRPreviewView {
        let view = PairingQRPreviewView(); view.preview.videoGravity = .resizeAspectFill; view.preview.session = session
        view.isAccessibilityElement = false
        return view
    }
    func updateUIView(_ view: PairingQRPreviewView, context: Context) {}
    static func dismantleUIView(_ view: PairingQRPreviewView, coordinator: ()) { view.preview.session = nil }
}
#endif
