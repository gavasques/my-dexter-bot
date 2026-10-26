import CryptoKit
import Foundation

/// Immutable media metadata. Pixels are fetched separately and never enter chat or configuration documents.
public struct AvatarImage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let mediaType: String
    public let sha256: String
    public let bytes: Int
    public let width: Int
    public let height: Int
    public let createdAt: Int64

    public init(id: String, mediaType: String = "image/png", sha256: String, bytes: Int,
                width: Int, height: Int, createdAt: Int64) {
        self.id = id; self.mediaType = mediaType; self.sha256 = sha256; self.bytes = bytes
        self.width = width; self.height = height; self.createdAt = createdAt
    }
    public var isValid: Bool {
        avatarImageUUID(id) && mediaType == "image/png" && (33...2 * 1_024 * 1_024).contains(bytes)
        && (1...1_024).contains(width) && (1...1_024).contains(height) && createdAt >= 0
        && sha256.utf8.count == 64 && sha256.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    public func matchesPNG(_ data: Data) -> Bool {
        guard isValid, let dimensions = avatarPNGDimensions(data) else { return false }
        return data.count == bytes && dimensions.0 == width && dimensions.1 == height
            && avatarImageDigest(data) == sha256
    }
}

/// Explicit omission, attach or clear; an absent patch never removes an existing image.
public enum AvatarImageIDPatch: Equatable, Sendable { case unchanged, set(String), clear }

private struct AvatarImageUpload: Encodable, Sendable {
    let expectedHostID: String
    let clientRequestId: String
    let mediaType = "image/png"
    let dataBase64: String
}
private struct AvatarImageDownload: Decodable, Sendable {
    let avatarImage: AvatarImage
    let dataBase64: String
}

extension HostClient {
    public func uploadAvatarImage(expectedHostID: String, clientRequestID: String, data: Data) async throws -> AvatarImage {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard avatarHostIdentity(expectedHostID), avatarImageUUID(clientRequestID),
              let dimensions = avatarPNGDimensions(data) else { throw HostClientError.invalidRequest }
        let image: AvatarImage
        do {
            image = try await request("/v1/avatars", method: "POST",
                body: AvatarImageUpload(expectedHostID: expectedHostID, clientRequestId: clientRequestID,
                                        dataBase64: data.base64EncodedString()),
                timeout: 30, localAttachmentRequest: true)
        } catch is CancellationError { throw HostClientError.mutationOutcomeUnknown }
        catch let error as HostClientError {
            switch error {
            case .offline, .hostFailure, .contractMismatch: throw HostClientError.mutationOutcomeUnknown
            default: throw error
            }
        }
        // Content dedup may reuse a canonical image ID from an earlier upload; the submitted
        // request ID remains the replay key, while the returned media ID is the profile reference.
        guard image.width == dimensions.0, image.height == dimensions.1,
              image.matchesPNG(data) else { throw HostClientError.mutationOutcomeUnknown }
        return image
    }

    public func downloadAvatarImage(_ image: AvatarImage, expectedHostID: String) async throws -> Data {
        guard case .loopbackDevelopment = accessPolicy else { throw HostClientError.forbidden }
        guard image.isValid, avatarHostIdentity(expectedHostID) else { throw HostClientError.invalidRequest }
        let value: AvatarImageDownload = try await request("/v1/avatars/\(image.id)",
            query: [URLQueryItem(name: "expectedHostID", value: expectedHostID)],
            timeout: 30, localAttachmentRequest: true)
        guard value.avatarImage == image, value.dataBase64.utf8.count <= 2_796_208,
              let data = Data(base64Encoded: value.dataBase64), data.base64EncodedString() == value.dataBase64,
              image.matchesPNG(data) else { throw HostClientError.contractMismatch }
        return data
    }
}

func avatarImageUUID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
}
private func avatarHostIdentity(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func avatarImageDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func avatarPNGDimensions(_ data: Data) -> (Int, Int)? {
    guard (33...2 * 1_024 * 1_024).contains(data.count),
          data.prefix(8).elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]),
          data[12..<16].elementsEqual([73, 72, 68, 82]) else { return nil }
    func integer(_ start: Int) -> Int { data[start..<start + 4].reduce(0) { ($0 << 8) | Int($1) } }
    let width = integer(16), height = integer(20)
    guard (1...1_024).contains(width), (1...1_024).contains(height) else { return nil }
    return (width, height)
}
