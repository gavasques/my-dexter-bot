import CryptoKit
import DexterHostClient
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Temporary normalized pixels. This value is deliberately not Codable or persisted in app defaults.
public struct AvatarImageDraft: Equatable, Identifiable, Sendable {
    public let id: String
    public let pngData: Data
    public let width: Int
    public let height: Int
    public let sha256: String

    public init(pngData: Data, width: Int, height: Int, id: String = UUID().uuidString.lowercased()) throws {
        let digest = SHA256.hash(data: pngData).map { String(format: "%02x", $0) }.joined()
        let image = AvatarImage(id: id, sha256: digest, bytes: pngData.count, width: width, height: height, createdAt: 0)
        guard image.matchesPNG(pngData) else { throw AvatarImageFailure.invalidImage }
        self.id = id; self.pngData = pngData; self.width = width; self.height = height; self.sha256 = digest
    }
}

public enum AvatarImageFailure: Error, Equatable, Sendable, LocalizedError {
    case invalidImage, imageTooLarge, invalidPrompt, invalidConfiguration, keyMissing, keyUnavailable
    case authenticationRejected, rateLimited, providerRejected, outcomeUnknown, responseInvalid

    public var errorDescription: String? {
        switch self {
        case .invalidImage: String(localized: "Não foi possível ler esta imagem. Escolha PNG, JPEG, GIF ou WebP estático.")
        case .imageTooLarge: String(localized: "Escolha uma imagem de até 10 MiB, 8192 pixels por lado e 32 milhões de pixels.")
        case .invalidPrompt: String(localized: "Descreva o avatar em até 2.000 caracteres.")
        case .invalidConfiguration: String(localized: "Confira a chave e o host antes de gerar o avatar.")
        case .keyMissing: String(localized: "Adicione uma chave OpenAI no campo privado de geração de avatar.")
        case .keyUnavailable: String(localized: "A chave OpenAI está indisponível. Desbloqueie o Mac ou salve a chave novamente.")
        case .authenticationRejected: String(localized: "A OpenAI recusou a chave ou o acesso ao Sunburst 2.5. Confira a conexão.")
        case .rateLimited: String(localized: "A OpenAI informou um limite de uso. Confira sua conta e tente novamente quando estiver disponível.")
        case .providerRejected: String(localized: "A OpenAI recusou esta geração. Revise a descrição e o acesso ao modelo.")
        case .outcomeUnknown: String(localized: "A geração foi interrompida sem confirmação. Ela pode ter sido cobrada; não será repetida automaticamente.")
        case .responseInvalid: String(localized: "A resposta da OpenAI não contém uma imagem válida. Não repetimos a geração automaticamente.")
        }
    }
}

public enum AvatarImageNormalizer {
    public static let maximumInputBytes = 10 * 1_024 * 1_024
    public static func normalize(_ data: Data) throws -> AvatarImageDraft {
        guard !data.isEmpty else { throw AvatarImageFailure.invalidImage }
        guard data.count <= maximumInputBytes else { throw AvatarImageFailure.imageTooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1, let sourceType = CGImageSourceGetType(source) as String?,
              [UTType.png.identifier, UTType.jpeg.identifier, UTType.gif.identifier, UTType.webP.identifier].contains(sourceType),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw AvatarImageFailure.invalidImage }
        // Bound encoded bytes and dimensions before allocating decoded pixels.
        guard (1...8_192).contains(width), (1...8_192).contains(height), width * height <= 32_000_000,
              (properties[kCGImagePropertyDepth] as? Int ?? 8) <= 8 else { throw AvatarImageFailure.imageTooLarge }
        for maximumSide in [1_024, 512] {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maximumSide,
                kCGImageSourceShouldCacheImmediately: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
                  (1...maximumSide).contains(image.width), (1...maximumSide).contains(image.height),
                  image.bitsPerPixel <= 32 else { throw AvatarImageFailure.invalidImage }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)
            else { throw AvatarImageFailure.invalidImage }
            // Re-encode only decoded pixels: EXIF, filenames, GPS and input text chunks are discarded.
            CGImageDestinationAddImage(destination, image, [:] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw AvatarImageFailure.invalidImage }
            let png = output as Data
            if png.count <= 2 * 1_024 * 1_024 {
                return try AvatarImageDraft(pngData: png, width: image.width, height: image.height)
            }
        }
        throw AvatarImageFailure.imageTooLarge
    }
}

extension DexterAppModel {
    public var avatarHostID: String? { canEditBotProfiles ? nativeProjectionHostID : nil }

    /// Upload is immutable and deduplicated by the draft ID; attaching it still requires the profile CAS save.
    public func uploadAvatarImage(_ draft: AvatarImageDraft, expectedHostID: String) async throws -> AvatarImage {
        guard avatarHostID == expectedHostID, let client = makeLocalMcpClient() else { throw HostClientError.forbidden }
        let scope = nativeComposerScope
        defer { client.close() }
        let image = try await client.uploadAvatarImage(expectedHostID: expectedHostID, clientRequestID: draft.id, data: draft.pngData)
        guard !Task.isCancelled, avatarHostID == expectedHostID, scope == nativeComposerScope
        else { throw HostClientError.mutationOutcomeUnknown }
        return image
    }

    public func avatarImageData(_ image: AvatarImage, expectedHostID: String? = nil) async -> Data? {
        guard let hostID = avatarHostID, expectedHostID == nil || expectedHostID == hostID,
              let client = makeLocalMcpClient() else { return nil }
        let scope = nativeComposerScope
        defer { client.close() }
        do {
            let data = try await client.downloadAvatarImage(image, expectedHostID: hostID)
            guard !Task.isCancelled, avatarHostID == hostID, scope == nativeComposerScope else { return nil }
            return data
        } catch { return nil }
    }
}
