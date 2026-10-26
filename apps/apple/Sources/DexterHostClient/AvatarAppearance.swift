import Foundation

/// Host-persisted visual recipe. Invalid or unsupported host recipes fail decoding.
public struct BotAvatarAppearance: Codable, Equatable, Hashable, Sendable {
    public enum Body: String, Codable, CaseIterable, Sendable { case round, bean, square, capsule, triangle, hexagon, cloud, drop }
    public enum Eyes: String, Codable, CaseIterable, Sendable { case oval, tall, sleepy, tiny, dots, focused, glance, wide }
    public enum Finish: String, Codable, CaseIterable, Sendable { case flat, glass }
    public enum Motion: String, Codable, CaseIterable, Sendable { case none, subtle, lively }

    public let version: Int
    public let body: Body
    public let eyes: Eyes
    public let colorHex: String
    public let finish: Finish
    public let motion: Motion

    public init(version: Int = 1, body: Body, eyes: Eyes, colorHex: String, finish: Finish, motion: Motion) {
        self.version = version; self.body = body; self.eyes = eyes
        self.colorHex = colorHex.uppercased(); self.finish = finish; self.motion = motion
    }

    public var isValid: Bool { version == 1 && Self.canonicalColor(colorHex) }
    private static func canonicalColor(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        return bytes.count == 7 && bytes[0] == 35 && bytes.dropFirst().allSatisfy {
            (48...57).contains($0) || (65...70).contains($0)
        }
    }

    enum CodingKeys: String, CodingKey { case version, body, eyes, colorHex, finish, motion }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        body = try c.decode(Body.self, forKey: .body); eyes = try c.decode(Eyes.self, forKey: .eyes)
        colorHex = try c.decode(String.self, forKey: .colorHex)
        finish = try c.decode(Finish.self, forKey: .finish); motion = try c.decode(Motion.self, forKey: .motion)
        guard isValid else {
            throw DecodingError.dataCorruptedError(forKey: version != 1 ? .version : .colorHex,
                in: c, debugDescription: "Invalid bot avatar recipe")
        }
    }
    public func encode(to encoder: Encoder) throws {
        guard isValid else {
            throw EncodingError.invalidValue(self, .init(codingPath: encoder.codingPath, debugDescription: "Invalid bot avatar recipe"))
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version); try c.encode(body, forKey: .body)
        try c.encode(eyes, forKey: .eyes); try c.encode(colorHex, forKey: .colorHex)
        try c.encode(finish, forKey: .finish); try c.encode(motion, forKey: .motion)
    }
}

/// Omission preserves the stored recipe; clear encodes an explicit JSON null.
public enum BotAvatarAppearancePatch: Equatable, Sendable { case unchanged, set(BotAvatarAppearance), clear }
