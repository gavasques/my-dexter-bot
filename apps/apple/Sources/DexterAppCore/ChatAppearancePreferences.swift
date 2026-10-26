import Foundation

/// Local appearance data only. No original paths, bookmarks, photo bytes, host or bot identifiers.
public enum ChatBackdropPreset: String, CaseIterable, Identifiable, Codable, Sendable {
    case neutral, teal, graphite, plum, forest, sand, custom, image
    public var id: String { rawValue }
}

public enum ChatBackdropDirection: String, CaseIterable, Identifiable, Codable, Sendable {
    case vertical, diagonal
    public var id: String { rawValue }
}

public struct ChatBackdropRGB: Codable, Equatable, Sendable {
    public var r: Double
    public var g: Double
    public var b: Double
    public init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
    public var isValid: Bool { [r, g, b].allSatisfy { $0.isFinite && (0...1).contains($0) } }
    public var luminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
}

public struct ChatWallpaperReference: Codable, Equatable, Sendable {
    public let id: UUID
    public let sha256: String
    public let width: Int
    public let height: Int
    public let byteCount: Int
    public init(id: UUID, sha256: String, width: Int, height: Int, byteCount: Int) {
        self.id = id; self.sha256 = sha256; self.width = width; self.height = height; self.byteCount = byteCount
    }
    public var isValid: Bool {
        sha256.count == 64 && sha256.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        && (1...4096).contains(width) && (1...4096).contains(height) && (1...16_777_216).contains(byteCount)
    }
    public var filename: String { id.uuidString.lowercased() + ".jpg" }
}

public struct ChatAppearanceSettings: Codable, Equatable, Sendable {
    public var preset: ChatBackdropPreset = .neutral
    public var top = ChatBackdropRGB(r: 0.06, g: 0.33, b: 0.36)
    public var bottom = ChatBackdropRGB(r: 0.02, g: 0.10, b: 0.13)
    public var direction: ChatBackdropDirection = .vertical
    public var backgroundOpacity: Double = 1
    public var panelOpacity: Double = 0.30
    public var imageBlur: Double = 0
    public var wallpaper: ChatWallpaperReference?
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case preset, top, bottom, direction, backgroundOpacity, panelOpacity, imageBlur, wallpaper
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = try c.decode(ChatBackdropPreset.self, forKey: .preset)
        top = try c.decode(ChatBackdropRGB.self, forKey: .top)
        bottom = try c.decode(ChatBackdropRGB.self, forKey: .bottom)
        direction = try c.decode(ChatBackdropDirection.self, forKey: .direction)
        // Existing v1 preferences keep their selected colors and direction, with safe defaults for new controls.
        backgroundOpacity = try c.decodeIfPresent(Double.self, forKey: .backgroundOpacity) ?? 1
        panelOpacity = try c.decodeIfPresent(Double.self, forKey: .panelOpacity) ?? 0.30
        imageBlur = try c.decodeIfPresent(Double.self, forKey: .imageBlur) ?? 0
        wallpaper = try c.decodeIfPresent(ChatWallpaperReference.self, forKey: .wallpaper)
        guard isValid else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid local appearance preference"))
        }
    }
    public var isValid: Bool {
        top.isValid && bottom.isValid && backgroundOpacity.isFinite && (0...1).contains(backgroundOpacity)
        && panelOpacity.isFinite && (0.25...1).contains(panelOpacity) && imageBlur.isFinite && (0...24).contains(imageBlur)
        && (wallpaper?.isValid ?? true) && (preset != .image || wallpaper != nil)
    }
    public var hasBackground: Bool { preset != .neutral }
    /// Photos use a consistent dark canvas and a protective scrim. Light gradients retain dark text across the window.
    public var usesLightAppearance: Bool {
        guard preset != .image, let (a, b) = stops else { return false }
        return (a.luminance + b.luminance) / 2 > 0.50
    }
    public var stops: (ChatBackdropRGB, ChatBackdropRGB)? {
        preset == .custom ? (top, bottom) : Self.presetStops(preset)
    }
    /// Keep primary text at least 4.5:1 over either gradient endpoint, including arbitrary custom colors.
    /// A photo can contain white/black anywhere, so it uses the conservative dark-canvas bound.
    public var readabilityScrim: Double {
        guard let (a, b) = stops else { return preset == .image ? 0.56 : 0 }
        let light = usesLightAppearance
        let worst = ChatBackdropRGB(r: light ? min(a.r, b.r) : max(a.r, b.r),
            g: light ? min(a.g, b.g) : max(a.g, b.g), b: light ? min(a.b, b.b) : max(a.b, b.b))
        let canvas = light ? 0.95 : 0.09
        func channel(_ value: Double, _ alpha: Double) -> Double {
            let before = value * backgroundOpacity + canvas * (1 - backgroundOpacity)
            return light ? before * (1 - alpha) + alpha : before * (1 - alpha)
        }
        for step in 6...84 {
            let alpha = Double(step) / 100
            let color = ChatBackdropRGB(r: channel(worst.r, alpha), g: channel(worst.g, alpha), b: channel(worst.b, alpha))
            let contrast = light ? (color.luminance + 0.05) / 0.05 : 1.05 / (color.luminance + 0.05)
            if contrast >= 4.5 { return alpha }
        }
        return 0.84
    }
    public static func presetStops(_ preset: ChatBackdropPreset) -> (ChatBackdropRGB, ChatBackdropRGB)? {
        switch preset {
        case .neutral, .custom, .image: nil
        case .teal: (.init(r: 0.06, g: 0.33, b: 0.36), .init(r: 0.02, g: 0.10, b: 0.13))
        case .graphite: (.init(r: 0.20, g: 0.21, b: 0.23), .init(r: 0.07, g: 0.07, b: 0.08))
        case .plum: (.init(r: 0.28, g: 0.14, b: 0.30), .init(r: 0.09, g: 0.05, b: 0.11))
        case .forest: (.init(r: 0.10, g: 0.28, b: 0.18), .init(r: 0.03, g: 0.09, b: 0.06))
        case .sand: (.init(r: 0.95, g: 0.91, b: 0.83), .init(r: 0.86, g: 0.80, b: 0.70))
        }
    }
}
