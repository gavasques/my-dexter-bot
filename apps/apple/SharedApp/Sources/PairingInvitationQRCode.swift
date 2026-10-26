#if os(macOS)
import AppKit
import DexterAppCore
import SwiftUI

/// Exact, already receipt-verified invitation bytes. No URL shortener, upload, file, analytics or clipboard side effect.
struct PairingInvitationQRCode: View {
    let invitation: String
    private var image: NSImage? {
        guard let cg = PairingInvitationQR.image(for: Data(invitation.utf8)) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
    var body: some View {
        if let image {
            Image(nsImage: image).resizable().interpolation(.none).scaledToFit()
                .frame(width: 286, height: 286).padding(18).background(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .privacySensitive().accessibilityLabel("QR privado de convite para conectar este aparelho")
                .accessibilityIdentifier("owner-pairing-offer.invitation.qr")
        } else {
            Text("Este convite não cabe em um QR. Use Copiar convite e cole no outro aparelho por um canal privado.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("owner-pairing-offer.invitation.qr-unavailable")
        }
    }
}
#endif
