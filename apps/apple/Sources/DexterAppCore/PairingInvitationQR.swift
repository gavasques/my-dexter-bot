import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/// Local-only encoding of the exact receipt-verified invitation. This function performs no IO or transport.
public enum PairingInvitationQR {
    public static func image(for invitation: Data) -> CGImage? {
        guard !invitation.isEmpty, invitation.count <= PairingInvitationPreview.maximumQRBytes else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = invitation; filter.correctionLevel = "L"
        guard let output = filter.outputImage else { return nil }
        return CIContext(options: [.cacheIntermediates: false]).createCGImage(output, from: output.extent)
    }
}
