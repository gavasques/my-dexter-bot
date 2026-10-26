import CoreGraphics
import DexterHostClient
import Foundation

/// Presentation of the host-persisted mascot recipe (`BotAvatarAppearance`). Everything here is local and pure: names,
/// palette, presets, color math and pixel geometry. Nothing reads or writes the host, generates images or calls an API;
/// a recipe only changes when the owner edits a draft and saves it through the bot profile's own CAS PATCH.

// MARK: - Names

extension BotAvatarAppearance.Body {
    public func label(portuguese pt: Bool) -> String {
        switch self {
        case .round: pt ? "Redondo" : "Round"
        case .bean: pt ? "Feijão" : "Bean"
        case .square: pt ? "Quadrado" : "Square"
        case .capsule: pt ? "Cápsula" : "Capsule"
        case .triangle: pt ? "Triângulo" : "Triangle"
        case .hexagon: pt ? "Hexágono" : "Hexagon"
        case .cloud: pt ? "Nuvem" : "Cloud"
        case .drop: pt ? "Gota" : "Drop"
        }
    }
}

extension BotAvatarAppearance.Eyes {
    public func label(portuguese pt: Bool) -> String {
        switch self {
        case .oval: pt ? "Ovais" : "Oval"
        case .tall: pt ? "Altos" : "Tall"
        case .sleepy: pt ? "Sonolentos" : "Sleepy"
        case .tiny: pt ? "Miúdos" : "Tiny"
        case .dots: pt ? "Pontos" : "Dots"
        case .focused: pt ? "Focados" : "Focused"
        case .glance: pt ? "De lado" : "Glance"
        case .wide: pt ? "Grandes" : "Wide"
        }
    }
}

extension BotAvatarAppearance.Finish {
    public func label(portuguese pt: Bool) -> String {
        switch self {
        case .flat: pt ? "Liso" : "Flat"
        case .glass: pt ? "Vidro" : "Glass"
        }
    }
}

extension BotAvatarAppearance.Motion {
    public func label(portuguese pt: Bool) -> String {
        switch self {
        case .none: pt ? "Parado" : "Still"
        case .subtle: pt ? "Suave" : "Subtle"
        case .lively: pt ? "Animado" : "Lively"
        }
    }
}

// MARK: - Recipe helpers

extension BotAvatarAppearance {
    /// First recipe offered when the owner opens the creator without a saved one.
    public static let dexterDefault = BotAvatarAppearance(body: .round, eyes: .oval, colorHex: "#7C5CFF", finish: .glass, motion: .subtle)

    /// Copies with one field replaced; the color is canonicalized by the DTO's own initializer. (Non-optional on
    /// purpose: an optional `motion` parameter would read `.none` as "keep the current value".)
    public func with(body: Body) -> BotAvatarAppearance { copy(body: body) }
    public func with(eyes: Eyes) -> BotAvatarAppearance { copy(eyes: eyes) }
    public func with(colorHex: String) -> BotAvatarAppearance { copy(colorHex: colorHex) }
    public func with(finish: Finish) -> BotAvatarAppearance { copy(finish: finish) }
    public func with(motion: Motion) -> BotAvatarAppearance {
        BotAvatarAppearance(version: version, body: body, eyes: eyes, colorHex: colorHex, finish: finish, motion: motion)
    }

    private func copy(body: Body? = nil, eyes: Eyes? = nil, colorHex: String? = nil, finish: Finish? = nil) -> BotAvatarAppearance {
        BotAvatarAppearance(version: version, body: body ?? self.body, eyes: eyes ?? self.eyes, colorHex: colorHex ?? self.colorHex,
                            finish: finish ?? self.finish, motion: motion)
    }

    /// Body color; an invalid recipe never reaches the renderer (the DTO rejects it), this is only a safe fallback.
    public var color: BotMascotColor { BotMascotColor(hex: colorHex) ?? BotMascotColor(hex: Self.dexterDefault.colorHex)! }

    /// Short spoken description for the creator's preview and tiles (decorative avatars stay hidden).
    public func accessibilityDescription(portuguese pt: Bool) -> String {
        let colorName = BotMascotPalette.swatch(hex: colorHex)?.label(portuguese: pt) ?? colorHex
        return pt
            ? "Mascote: corpo \(body.label(portuguese: true)), olhos \(eyes.label(portuguese: true)), cor \(colorName), acabamento \(finish.label(portuguese: true))"
            : "Mascot: \(body.label(portuguese: false)) body, \(eyes.label(portuguese: false)) eyes, \(colorName) color, \(finish.label(portuguese: false)) finish"
    }
}

// MARK: - Color

/// 8-bit sRGB color parsed from the recipe's `#RRGGBB`. Used for contrast decisions and shading only.
public struct BotMascotColor: Equatable, Hashable, Sendable {
    public let red: UInt8
    public let green: UInt8
    public let blue: UInt8

    public init(red: UInt8, green: UInt8, blue: UInt8) { self.red = red; self.green = green; self.blue = blue }

    /// Accepts exactly `#` plus six hex digits (either case); anything else is nil.
    public init?(hex: String) {
        let bytes = Array(hex.utf8)
        guard bytes.count == 7, bytes[0] == 35 else { return nil }
        func nibble(_ byte: UInt8) -> UInt8? {
            switch byte {
            case 48...57: byte - 48
            case 65...70: byte - 55
            case 97...102: byte - 87
            default: nil
            }
        }
        var values: [UInt8] = []
        for index in stride(from: 1, to: 7, by: 2) {
            guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else { return nil }
            values.append(high << 4 | low)
        }
        self.init(red: values[0], green: values[1], blue: values[2])
    }

    /// Components in 0...1 (sRGB, gamma-encoded), e.g. from a color picker. Out-of-range values are clamped.
    public init(unitRed: Double, green: Double, blue: Double) {
        func byte(_ value: Double) -> UInt8 { UInt8((min(max(value.isFinite ? value : 0, 0), 1) * 255).rounded()) }
        self.init(red: byte(unitRed), green: byte(green), blue: byte(blue))
    }

    /// Canonical uppercase `#RRGGBB`, the only form sent to the host.
    public var hex: String {
        let digits = Array("0123456789ABCDEF")
        return "#" + String([red, green, blue].flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 0x0F)]] })
    }
    public var unit: (red: Double, green: Double, blue: Double) { (Double(red) / 255, Double(green) / 255, Double(blue) / 255) }

    /// WCAG 2 relative luminance.
    public var relativeLuminance: Double {
        func linear(_ channel: UInt8) -> Double {
            let value = Double(channel) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    public func contrastRatio(with other: BotMascotColor) -> Double {
        let (a, b) = (relativeLuminance, other.relativeLuminance)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// Straight sRGB mix; `amount` 0 keeps self, 1 gives `other`.
    public func mixed(with other: BotMascotColor, amount: Double) -> BotMascotColor {
        let t = min(max(amount, 0), 1)
        func channel(_ a: UInt8, _ b: UInt8) -> Double { (Double(a) + (Double(b) - Double(a)) * t) / 255 }
        return BotMascotColor(unitRed: channel(red, other.red), green: channel(green, other.green), blue: channel(blue, other.blue))
    }

    public func lighter(_ amount: Double) -> BotMascotColor { mixed(with: .white, amount: amount) }
    public func darker(_ amount: Double) -> BotMascotColor { mixed(with: .black, amount: amount) }

    public static let white = BotMascotColor(red: 255, green: 255, blue: 255)
    public static let black = BotMascotColor(red: 0, green: 0, blue: 0)
    /// Dark ink for eyes on light bodies; slightly warm so it is not a harsh pure black.
    public static let darkInk = BotMascotColor(red: 0x1A, green: 0x18, blue: 0x22)
    /// Window backgrounds the avatar sits on, used only to decide whether an edge is needed.
    public static let lightSurface = BotMascotColor(red: 0xF5, green: 0xF5, blue: 0xF7)
    public static let darkSurface = BotMascotColor(red: 0x1E, green: 0x1E, blue: 0x22)
    public static let attention = BotMascotColor(red: 0xFF, green: 0x9F, blue: 0x0A)
    public static let failure = BotMascotColor(red: 0xF0, green: 0x4E, blue: 0x45)

    /// Eye ink: dark eyes whenever they keep at least 3.6:1 against the body (above the 3:1 non-text minimum), white
    /// eyes on dark bodies; whichever is chosen is the better reading of the two near the switch point.
    public var ink: BotMascotColor {
        let dark = contrastRatio(with: .darkInk)
        return dark >= 3.6 || dark >= contrastRatio(with: .white) ? .darkInk : .white
    }

    /// A light body on a light window (or a dark body on a dark one) gets a hairline edge so its outline stays readable.
    public func needsEdge(darkAppearance: Bool, increasedContrast: Bool = false) -> Bool {
        contrastRatio(with: darkAppearance ? .darkSurface : .lightSurface) < (increasedContrast ? 2.2 : 1.45)
    }
}

// MARK: - Palette and presets

public struct BotMascotSwatch: Identifiable, Equatable, Sendable {
    public let id: String
    public let hex: String

    public func label(portuguese pt: Bool) -> String {
        switch id {
        case "violet": pt ? "Violeta" : "Violet"
        case "blue": pt ? "Azul" : "Blue"
        case "sky": pt ? "Céu" : "Sky"
        case "mint": pt ? "Menta" : "Mint"
        case "green": pt ? "Verde" : "Green"
        case "lime": pt ? "Lima" : "Lime"
        case "sun": pt ? "Sol" : "Sun"
        case "orange": pt ? "Laranja" : "Orange"
        case "coral": "Coral"
        case "pink": pt ? "Rosa" : "Pink"
        case "graphite": pt ? "Grafite" : "Graphite"
        case "cloud": pt ? "Nuvem" : "Cloud"
        default: hex
        }
    }
}

/// Curated colors that read well in light and dark windows; any other `#RRGGBB` stays available as a custom color.
public enum BotMascotPalette {
    public static let swatches: [BotMascotSwatch] = [
        BotMascotSwatch(id: "violet", hex: "#7C5CFF"),
        BotMascotSwatch(id: "blue", hex: "#3B82F6"),
        BotMascotSwatch(id: "sky", hex: "#38BDF8"),
        BotMascotSwatch(id: "mint", hex: "#2DD4BF"),
        BotMascotSwatch(id: "green", hex: "#34C759"),
        BotMascotSwatch(id: "lime", hex: "#A3E635"),
        BotMascotSwatch(id: "sun", hex: "#FBBF24"),
        BotMascotSwatch(id: "orange", hex: "#FB923C"),
        BotMascotSwatch(id: "coral", hex: "#F87171"),
        BotMascotSwatch(id: "pink", hex: "#F472B6"),
        BotMascotSwatch(id: "graphite", hex: "#4B5563"),
        BotMascotSwatch(id: "cloud", hex: "#E5E7EB"),
    ]

    public static func swatch(hex: String) -> BotMascotSwatch? {
        let canonical = BotMascotColor(hex: hex)?.hex
        return swatches.first { $0.hex == canonical }
    }
}

/// Starting points for the owner. Applying one keeps the current motion choice (a comfort setting, not a look).
public struct BotMascotPreset: Identifiable, Equatable, Sendable {
    public let id: String
    public let body: BotAvatarAppearance.Body
    public let eyes: BotAvatarAppearance.Eyes
    public let colorHex: String
    public let finish: BotAvatarAppearance.Finish

    public func label(portuguese pt: Bool) -> String {
        switch id {
        case "cloud": pt ? "Nuvem" : "Cloud"
        case "spark": pt ? "Faísca" : "Spark"
        case "drop": pt ? "Gota" : "Drop"
        case "bean": pt ? "Feijão" : "Bean"
        default: id.capitalized  // "Dexter", "Pixel": same name in both languages
        }
    }

    public func applied(to current: BotAvatarAppearance) -> BotAvatarAppearance {
        BotAvatarAppearance(version: current.version, body: body, eyes: eyes, colorHex: colorHex, finish: finish, motion: current.motion)
    }

    public func matches(_ appearance: BotAvatarAppearance) -> Bool {
        appearance.body == body && appearance.eyes == eyes && appearance.colorHex == colorHex && appearance.finish == finish
    }

    public static let all: [BotMascotPreset] = [
        BotMascotPreset(id: "dexter", body: .round, eyes: .oval, colorHex: "#7C5CFF", finish: .glass),
        BotMascotPreset(id: "cloud", body: .cloud, eyes: .sleepy, colorHex: "#E5E7EB", finish: .glass),
        BotMascotPreset(id: "pixel", body: .square, eyes: .dots, colorHex: "#34C759", finish: .flat),
        BotMascotPreset(id: "spark", body: .triangle, eyes: .focused, colorHex: "#FB923C", finish: .flat),
        BotMascotPreset(id: "drop", body: .drop, eyes: .wide, colorHex: "#38BDF8", finish: .glass),
        BotMascotPreset(id: "bean", body: .bean, eyes: .tall, colorHex: "#F472B6", finish: .flat),
    ]
}

/// "Aleatório": a new look from the closed options and the curated palette. Only the owner's draft changes; the
/// current motion choice is kept and the result always differs from the current look.
public enum BotMascotRandomizer {
    public static func next<G: RandomNumberGenerator>(after current: BotAvatarAppearance, using generator: inout G) -> BotAvatarAppearance {
        for _ in 0..<16 {
            guard let body = BotAvatarAppearance.Body.allCases.randomElement(using: &generator),
                  let eyes = BotAvatarAppearance.Eyes.allCases.randomElement(using: &generator),
                  let color = BotMascotPalette.swatches.randomElement(using: &generator),
                  let finish = BotAvatarAppearance.Finish.allCases.randomElement(using: &generator) else { break }
            let candidate = BotAvatarAppearance(version: current.version, body: body, eyes: eyes, colorHex: color.hex, finish: finish, motion: current.motion)
            if candidate.body != current.body || candidate.colorHex != current.colorHex { return candidate }
        }
        let bodies = BotAvatarAppearance.Body.allCases
        let next = bodies[((bodies.firstIndex(of: current.body) ?? 0) + 1) % bodies.count]
        return current.with(body: next)
    }
}

// MARK: - Geometry

/// Where the face sits on each body, in unit coordinates of the square canvas.
public struct BotMascotFace: Equatable, Sendable {
    public let centerY: Double
    /// Distance from the face center to each eye center.
    public let eyeSpacing: Double
    public let eyeScale: Double

    public static func of(_ body: BotAvatarAppearance.Body) -> BotMascotFace {
        switch body {
        case .round: BotMascotFace(centerY: 0.50, eyeSpacing: 0.165, eyeScale: 1)
        case .bean: BotMascotFace(centerY: 0.52, eyeSpacing: 0.155, eyeScale: 1)
        case .square: BotMascotFace(centerY: 0.48, eyeSpacing: 0.17, eyeScale: 1)
        case .capsule: BotMascotFace(centerY: 0.43, eyeSpacing: 0.12, eyeScale: 0.9)
        case .triangle: BotMascotFace(centerY: 0.62, eyeSpacing: 0.125, eyeScale: 0.86)
        case .hexagon: BotMascotFace(centerY: 0.50, eyeSpacing: 0.16, eyeScale: 0.96)
        case .cloud: BotMascotFace(centerY: 0.57, eyeSpacing: 0.16, eyeScale: 0.94)
        case .drop: BotMascotFace(centerY: 0.62, eyeSpacing: 0.14, eyeScale: 0.94)
        }
    }
}

public enum BotMascotEyeShape: Equatable, Sendable {
    case ellipse
    case roundedRect(cornerFraction: Double)
    /// Flat lid on top (sleepy).
    case lowerHalf
    /// Closed, smiling "^" stroke (happy expression).
    case arc
}

/// One frame's eyes in canvas points, already snapped to device pixels and mirrored so both sides match exactly.
public struct BotMascotEyeLayout: Equatable, Sendable {
    public let left: CGRect
    public let right: CGRect
    public let shape: BotMascotEyeShape
    public let leftCatchlight: CGRect?
    public let rightCatchlight: CGRect?
    /// Raised inner brows of the worried expression, as stroke segments (nil when too small to read).
    public let brows: (left: (CGPoint, CGPoint), right: (CGPoint, CGPoint))?

    public static func == (a: BotMascotEyeLayout, b: BotMascotEyeLayout) -> Bool {
        a.left == b.left && a.right == b.right && a.shape == b.shape
            && a.leftCatchlight == b.leftCatchlight && a.rightCatchlight == b.rightCatchlight && a.strokeWidth == b.strokeWidth
            && a.brows?.left.0 == b.brows?.left.0 && a.brows?.left.1 == b.brows?.left.1
            && a.brows?.right.0 == b.brows?.right.0 && a.brows?.right.1 == b.brows?.right.1
    }
    /// Stroke width for `.arc`.
    public let strokeWidth: CGFloat
}

public enum BotMascotGeometry {
    /// Base eye size (width, height) as a fraction of the canvas side.
    public static func eyeSize(_ eyes: BotAvatarAppearance.Eyes) -> (width: Double, height: Double) {
        switch eyes {
        case .oval: (0.10, 0.14)
        case .tall: (0.075, 0.19)
        case .sleepy: (0.13, 0.068)
        case .tiny: (0.055, 0.055)
        case .dots: (0.095, 0.095)
        case .focused: (0.125, 0.078)
        case .glance: (0.105, 0.13)
        case .wide: (0.15, 0.155)
        }
    }

    public static func baseShape(_ eyes: BotAvatarAppearance.Eyes) -> BotMascotEyeShape {
        switch eyes {
        case .oval, .tiny, .dots, .glance, .wide: .ellipse
        case .tall: .roundedRect(cornerFraction: 0.5)
        case .sleepy: .lowerHalf
        case .focused: .roundedRect(cornerFraction: 0.42)
        }
    }

    /// Snaps a length in points to whole device pixels (never below one pixel).
    public static func snap(_ value: Double, scale: Double) -> CGFloat {
        let scale = max(scale, 1)
        return CGFloat(max((value * scale).rounded(), 1) / scale)
    }

    private static func snapPosition(_ value: Double, scale: Double) -> CGFloat {
        let scale = max(scale, 1)
        return CGFloat((value * scale).rounded() / scale)
    }

    /// Eyes for one pose. `side` is the canvas side in points and `scale` the display scale. Sizes have a floor of
    /// two device pixels so tiny avatars keep two clear eyes, and the right eye mirrors the left one exactly.
    public static func eyes(appearance: BotAvatarAppearance, pose: BotMascotPose, side: Double, scale: Double) -> BotMascotEyeLayout {
        let scale = max(scale, 1)
        let snappedSide = Double((side * scale).rounded()) / scale
        let face = BotMascotFace.of(appearance.body)
        let base = eyeSize(appearance.eyes)
        var shape = baseShape(appearance.eyes)
        var width = base.width, height = base.height
        switch pose.expression {
        case .neutral: break
        case .happy: shape = .arc; height = max(width * 0.62, 0.05)
        case .wide: width *= 1.12; height *= 1.12
        case .focused: height *= 0.62; if case .ellipse = shape { shape = .roundedRect(cornerFraction: 0.45) }
        case .worried: height *= 0.7
        }
        width *= face.eyeScale * pose.eyeScale
        height *= face.eyeScale * pose.eyeScale
        let minimum = 2 / scale
        var widthPoints = max(width * snappedSide, minimum)
        var heightPoints = max(height * snappedSide, minimum)
        if shape != .arc {
            // Blink: the eye closes around its center but stays one visible pixel line.
            heightPoints = max(heightPoints * min(max(pose.eyeOpen, 0), 1), 1 / scale)
        }
        let pixel = 1 / scale
        let spacing = face.eyeSpacing * snappedSide
        if snappedSide * scale < 64, widthPoints < 3 * pixel { widthPoints = 3 * pixel }
        // Narrow faces at tiny sizes: never let the two eyes merge into one shape.
        let widest = ((2 * spacing - pixel) * scale).rounded(.down) / scale
        widthPoints = min(widthPoints, max(widest, 2 * pixel))
        let w = snap(widthPoints, scale: scale), h = snap(heightPoints, scale: scale)
        let gaze = appearance.eyes == .glance && pose.expression != .happy ? 0.028 : 0
        let centerX = snappedSide / 2 + (pose.eyeOffsetX + gaze) * snappedSide
        let centerY = (face.centerY + pose.eyeOffsetY) * snappedSide
        var leftX = snapPosition(centerX - spacing - Double(w) / 2, scale: scale)
        let topY = snapPosition(centerY - Double(h) / 2, scale: scale)
        // Mirror around the gaze center so spacing and size stay identical after snapping.
        let mirrorAxis = snapPosition(centerX * 2, scale: scale)
        while mirrorAxis - 2 * (leftX + w) < CGFloat(pixel) - 1e-9, leftX >= CGFloat(pixel) { leftX -= CGFloat(pixel) }
        let left = CGRect(x: leftX, y: topY, width: w, height: h)
        let right = CGRect(x: mirrorAxis - leftX - w, y: topY, width: w, height: h)
        var catchlights: (CGRect?, CGRect?) = (nil, nil)
        let wantsCatchlight = [.oval, .wide, .glance, .dots].contains(appearance.eyes) && shape != .arc && pose.eyeOpen > 0.6
            && pose.expression != .worried
        if wantsCatchlight, snappedSide >= 36 {
            let dot = snap(Double(min(w, h)) * 0.34, scale: scale)
            let inset = Double(w) * 0.18
            let leftDot = CGRect(x: snapPosition(Double(left.minX) + inset, scale: scale), y: snapPosition(Double(left.minY) + Double(h) * 0.16, scale: scale), width: dot, height: dot)
            let rightDot = CGRect(x: snapPosition(Double(right.minX) + inset, scale: scale), y: leftDot.minY, width: dot, height: dot)
            catchlights = (leftDot, rightDot)
        }
        let stroke = max(snap(Double(w) * 0.3, scale: scale), 1.5 / CGFloat(scale))
        var brows: (left: (CGPoint, CGPoint), right: (CGPoint, CGPoint))?
        if pose.expression == .worried, snappedSide >= 28 {
            // "/ \": the inner ends sit higher, which reads as worried rather than angry.
            let outer = snapPosition(Double(left.minY) - snappedSide * 0.05, scale: scale)
            let inner = snapPosition(Double(outer) - snappedSide * 0.035, scale: scale)
            brows = ((CGPoint(x: left.minX, y: outer), CGPoint(x: left.maxX, y: inner)),
                     (CGPoint(x: right.minX, y: inner), CGPoint(x: right.maxX, y: outer)))
        }
        return BotMascotEyeLayout(left: left, right: right, shape: shape,
                                  leftCatchlight: catchlights.0, rightCatchlight: catchlights.1, brows: brows, strokeWidth: stroke)
    }
}
