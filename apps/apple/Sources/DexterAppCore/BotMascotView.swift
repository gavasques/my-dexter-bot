import DexterHostClient
import Foundation
import SwiftUI

/// Procedural mascot drawn from the host's recipe: one `Canvas`, no image assets, no network. `activity` must come from
/// host facts (`BotMascotActivity.derive`) or, in the creator, from the local "Prévia" simulation. Animation follows
/// `BotMascotAnimationLevel`: still under Reduce Motion, "Parado", when hidden or inactive, and for tiny avatars;
/// small avatars only blink on a sparse schedule. Decorative: callers label the surrounding element.
public struct BotMascotView: View {
    public enum Animation: Equatable, Sendable {
        case automatic
        /// Always one static frame (grids of options, thumbnails).
        case still
    }

    private let appearance: BotAvatarAppearance
    private let activity: BotMascotActivity
    private let size: CGFloat
    private let animation: Animation
    private let seed: UInt32
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.displayScale) private var displayScale
    @State private var isVisible = false
    @State private var activityStart = Date()

    /// - Parameter seed: any stable identifier (e.g. the bot ID) so avatars in a list do not blink in unison.
    public init(appearance: BotAvatarAppearance, activity: BotMascotActivity = .idle, size: CGFloat,
                animation: Animation = .automatic, seed: String = "") {
        self.appearance = appearance; self.activity = activity; self.size = size; self.animation = animation
        self.seed = BotMascotBlink.seed(seed.isEmpty ? appearance.colorHex + appearance.body.rawValue : seed)
    }

    private var level: BotMascotAnimationLevel {
        guard animation == .automatic else { return .still }
        return .resolve(motion: appearance.motion, side: Double(size), reduceMotion: reduceMotion, isVisible: isVisible,
                        isSceneActive: scenePhase != .background, lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    public var body: some View {
        content
            .frame(width: size, height: size)
            .onAppear { isVisible = true }
            .onDisappear { isVisible = false }
            .onChange(of: activity) { _, _ in activityStart = Date() }
            .accessibilityHidden(true)
    }

    @ViewBuilder private var content: some View {
        let style = BotMascotRenderStyle(appearance: appearance, dark: colorScheme == .dark,
                                         increasedContrast: contrast == .increased, scale: Double(displayScale))
        switch level {
        case .still:
            BotMascotCanvas(appearance: appearance, pose: .still(activity), style: style)
        case .blinkOnly:
            TimelineView(BotMascotBlinkSchedule(seed: seed)) { context in
                BotMascotCanvas(appearance: appearance, pose: pose(at: context.date, level: .blinkOnly), style: style)
            }
        case .full(_, let framesPerSecond):
            TimelineView(.animation(minimumInterval: 1 / framesPerSecond)) { context in
                BotMascotCanvas(appearance: appearance, pose: pose(at: context.date, level: level), style: style)
            }
        }
    }

    private func pose(at date: Date, level: BotMascotAnimationLevel) -> BotMascotPose {
        .resolve(activity, level: level, time: date.timeIntervalSinceReferenceDate,
                 elapsed: max(0, date.timeIntervalSince(activityStart)), seed: seed)
    }
}

/// Only the frames a blink needs; nothing is redrawn between blinks.
struct BotMascotBlinkSchedule: TimelineSchedule, Sendable {
    let seed: UInt32

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(seed: seed, cursor: startDate.timeIntervalSinceReferenceDate, lowFrequency: mode == .lowFrequency)
    }

    struct Entries: Sequence, IteratorProtocol {
        let seed: UInt32
        var cursor: Double
        let lowFrequency: Bool
        var pending: [Double] = []
        var started = false

        init(seed: UInt32, cursor: Double, lowFrequency: Bool) { self.seed = seed; self.cursor = cursor; self.lowFrequency = lowFrequency }

        mutating func next() -> Date? {
            if !started { started = true; return Date(timeIntervalSinceReferenceDate: cursor) }
            // Low-frequency (always-on/background) keeps a single static frame.
            guard !lowFrequency else { return nil }
            if pending.isEmpty {
                pending = BotMascotBlink.frames(startingAt: BotMascotBlink.nextStart(after: cursor + 0.001, seed: seed))
            }
            cursor = pending.removeFirst()
            return Date(timeIntervalSinceReferenceDate: cursor)
        }
    }
}

// MARK: - Drawing

struct BotMascotRenderStyle: Equatable {
    let base: BotMascotColor
    let ink: BotMascotColor
    let edge: Bool
    let dark: Bool
    let scale: Double

    init(appearance: BotAvatarAppearance, dark: Bool, increasedContrast: Bool, scale: Double) {
        base = appearance.color; ink = base.ink; self.dark = dark; self.scale = max(scale, 1)
        edge = base.needsEdge(darkAppearance: dark, increasedContrast: increasedContrast)
    }
}

extension Color {
    init(mascot color: BotMascotColor, opacity: Double = 1) {
        let unit = color.unit
        self.init(.sRGB, red: unit.red, green: unit.green, blue: unit.blue, opacity: opacity)
    }
}

struct BotMascotCanvas: View {
    let appearance: BotAvatarAppearance
    let pose: BotMascotPose
    let style: BotMascotRenderStyle

    var body: some View {
        Canvas { context, canvasSize in
            draw(in: &context, side: min(canvasSize.width, canvasSize.height))
        }
    }

    private func draw(in context: inout GraphicsContext, side: CGFloat) {
        let unit = CGRect(x: 0, y: 0, width: side, height: side)
        let body = BotMascotShapes.body(appearance.body, in: unit)
        if side >= 64 { drawContactShadow(in: &context, side: side) }

        var figure = context
        let anchor = CGPoint(x: side / 2, y: side * 0.92)
        figure.translateBy(x: anchor.x + CGFloat(pose.bodyOffsetX) * side, y: anchor.y + CGFloat(pose.bodyOffsetY) * side)
        figure.rotate(by: .degrees(pose.tiltDegrees))
        figure.scaleBy(x: CGFloat(pose.bodyScaleX), y: CGFloat(pose.bodyScaleY))
        figure.translateBy(x: -anchor.x, y: -anchor.y)

        switch appearance.finish {
        case .flat: figure.fill(body, with: .color(Color(mascot: style.base)))
        case .glass: drawGlass(body, in: &figure, side: side)
        }
        if style.edge {
            figure.stroke(body, with: .color(Color(mascot: style.ink, opacity: style.dark ? 0.38 : 0.24)),
                          lineWidth: max(1 / CGFloat(style.scale), side * 0.012))
        }
        drawEyes(in: &figure, side: side)
        drawAccessory(in: &context, side: side)
    }

    private func drawContactShadow(in context: inout GraphicsContext, side: CGFloat) {
        let lift = CGFloat(min(max(-pose.bodyOffsetY, 0), 0.1))
        let width = side * (0.5 - lift * 1.6), height = side * 0.05
        let rect = CGRect(x: (side - width) / 2, y: side * 0.93 - height / 2, width: width, height: height)
        context.drawLayer { layer in
            layer.addFilter(.blur(radius: side * 0.018))
            layer.fill(Path(ellipseIn: rect), with: .color(.black.opacity(style.dark ? 0.32 : 0.14)))
        }
    }

    private func drawGlass(_ body: Path, in context: inout GraphicsContext, side: CGFloat) {
        let bounds = body.boundingRect
        let top = style.base.lighter(0.30), bottom = style.base.darker(0.14)
        context.fill(body, with: .linearGradient(
            Gradient(stops: [.init(color: Color(mascot: top), location: 0), .init(color: Color(mascot: style.base), location: 0.55),
                             .init(color: Color(mascot: bottom), location: 1)]),
            startPoint: CGPoint(x: bounds.midX, y: bounds.minY), endPoint: CGPoint(x: bounds.midX, y: bounds.maxY)))
        var inner = context
        inner.clip(to: body)
        // Soft sheen on the upper left and a rim that catches light on top.
        inner.fill(Path(bounds), with: .radialGradient(
            Gradient(colors: [.white.opacity(0.42), .white.opacity(0)]),
            center: CGPoint(x: bounds.minX + bounds.width * 0.32, y: bounds.minY + bounds.height * 0.2),
            startRadius: 0, endRadius: bounds.width * 0.46))
        inner.stroke(body, with: .linearGradient(
            Gradient(stops: [.init(color: .white.opacity(0.7), location: 0), .init(color: .white.opacity(0), location: 0.45),
                             .init(color: .white.opacity(0.18), location: 1)]),
            startPoint: CGPoint(x: bounds.midX, y: bounds.minY), endPoint: CGPoint(x: bounds.midX, y: bounds.maxY)),
            lineWidth: max(2 / CGFloat(style.scale), side * 0.05))
        if side >= 40 {
            // Small specular glint, placed where each body's upper surface actually is.
            let spot = BotMascotShapes.glint(appearance.body)
            let glint = CGRect(x: (spot.x - 0.08) * side, y: (spot.y - 0.035) * side, width: side * 0.16, height: side * 0.07)
            inner.fill(Path(ellipseIn: glint), with: .color(.white.opacity(0.55)))
        }
    }

    private func drawEyes(in context: inout GraphicsContext, side: CGFloat) {
        let layout = BotMascotGeometry.eyes(appearance: appearance, pose: pose, side: Double(side), scale: style.scale)
        let ink = Color(mascot: style.ink)
        for rect in [layout.left, layout.right] {
            switch layout.shape {
            case .ellipse: context.fill(Path(ellipseIn: rect), with: .color(ink))
            case .roundedRect(let fraction):
                context.fill(Path(roundedRect: rect, cornerRadius: min(rect.width, rect.height) * CGFloat(fraction)), with: .color(ink))
            case .lowerHalf: context.fill(BotMascotShapes.lowerHalfEye(rect), with: .color(ink))
            case .arc:
                var arc = Path()
                arc.move(to: CGPoint(x: rect.minX, y: rect.maxY))
                arc.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY), control: CGPoint(x: rect.midX, y: rect.minY - rect.height))
                context.stroke(arc, with: .color(ink), style: StrokeStyle(lineWidth: layout.strokeWidth, lineCap: .round))
            }
        }
        if let brows = layout.brows {
            for segment in [brows.left, brows.right] {
                var brow = Path()
                brow.move(to: segment.0); brow.addLine(to: segment.1)
                context.stroke(brow, with: .color(ink), style: StrokeStyle(lineWidth: max(layout.strokeWidth * 0.75, 1), lineCap: .round))
            }
        }
        let shine = style.ink == .darkInk ? Color.white.opacity(0.92) : Color(mascot: style.base, opacity: 0.9)
        for dot in [layout.leftCatchlight, layout.rightCatchlight].compactMap({ $0 }) {
            context.fill(Path(ellipseIn: dot), with: .color(shine))
        }
    }

    // MARK: Accessories

    private var chipFill: Color { style.dark ? Color(white: 0.24) : .white }
    private var chipStroke: Color { style.dark ? .white.opacity(0.2) : .black.opacity(0.1) }
    private var chipInk: Color { style.dark ? Color(white: 0.86) : Color(white: 0.32) }

    private func drawAccessory(in context: inout GraphicsContext, side: CGFloat) {
        guard pose.accessory != .none, pose.accessoryOpacity > 0 else { return }
        var layer = context
        layer.opacity = pose.accessoryOpacity
        if side < 28 {
            // Tiny avatars keep only what asks for attention, as a dot.
            let color: BotMascotColor
            switch pose.accessory {
            case .attention: color = .attention
            case .failure: color = .failure
            default: return
            }
            let radius = max(2.5, side * 0.14)
            let dot = CGRect(x: side - radius * 2, y: 0, width: radius * 2, height: radius * 2)
            layer.fill(Path(ellipseIn: dot.insetBy(dx: -1, dy: -1)), with: .color(chipFill))
            layer.fill(Path(ellipseIn: dot), with: .color(Color(mascot: color)))
            return
        }
        let diameter = max(12, side * 0.27)
        let center = CGPoint(x: side - diameter / 2 - side * 0.01, y: diameter / 2 + side * 0.01)
        let phase = CGFloat(pose.accessoryPhase)
        switch pose.accessory {
        case .none: break
        case .attention, .failure:
            let pulse = pose.accessory == .attention ? 1 + 0.08 * sin(phase * 2 * .pi) : 1
            let d = diameter * pulse
            let rect = CGRect(x: center.x - d / 2, y: center.y - d / 2, width: d, height: d)
            layer.fill(Path(ellipseIn: rect.insetBy(dx: -1.5, dy: -1.5)), with: .color(chipFill))
            layer.fill(Path(ellipseIn: rect), with: .color(Color(mascot: pose.accessory == .attention ? .attention : .failure)))
            symbol(pose.accessory == .attention ? "exclamationmark" : "xmark", in: &layer, center: center, size: d * 0.5, color: .white)
        case .gear, .reconnecting:
            chip(in: &layer, center: center, diameter: diameter)
            var spun = layer
            spun.translateBy(x: center.x, y: center.y)
            spun.rotate(by: .radians(Double(phase) * 2 * .pi))
            symbol(pose.accessory == .gear ? "gearshape.fill" : "arrow.triangle.2.circlepath", in: &spun, center: .zero,
                   size: diameter * 0.6, color: chipInk)
        case .typingDots:
            let width = diameter * 1.45, height = diameter * 0.78
            let bubble = CGRect(x: side - width - side * 0.01, y: side * 0.02, width: width, height: height)
            layer.fill(Path(roundedRect: bubble, cornerRadius: height / 2), with: .color(chipFill))
            layer.stroke(Path(roundedRect: bubble, cornerRadius: height / 2), with: .color(chipStroke), lineWidth: 1)
            let dot = height * 0.24
            for index in 0..<3 {
                let wave = max(0, sin((phase - CGFloat(index) * 0.18) * 2 * .pi))
                let x = bubble.minX + width * (0.28 + CGFloat(index) * 0.22) - dot / 2
                let y = bubble.midY - dot / 2 - wave * height * 0.12
                layer.fill(Path(ellipseIn: CGRect(x: x, y: y, width: dot, height: dot)), with: .color(chipInk.opacity(0.45 + 0.55 * Double(wave))))
            }
        case .thinkingDots:
            let active = Int(phase * 3) % 3
            for index in 0..<3 {
                let t = CGFloat(index) / 2
                let d = diameter * (0.2 + 0.14 * CGFloat(index))
                let point = CGPoint(x: side * (0.68 + 0.2 * t), y: side * (0.3 - 0.2 * t))
                let rect = CGRect(x: point.x - d / 2, y: point.y - d / 2, width: d, height: d)
                layer.fill(Path(ellipseIn: rect), with: .color(chipFill))
                layer.stroke(Path(ellipseIn: rect), with: .color(chipStroke), lineWidth: 1)
                if index == active { layer.fill(Path(ellipseIn: rect.insetBy(dx: d * 0.3, dy: d * 0.3)), with: .color(chipInk.opacity(0.6))) }
            }
        case .sparkle:
            let grow = CGFloat(1 - pow(1 - min(max(pose.accessoryPhase, 0), 1), 3))
            let gold = Color(.sRGB, red: 1, green: 0.8, blue: 0.2, opacity: 1)
            symbol("sparkle", in: &layer, center: CGPoint(x: side * 0.85, y: side * 0.14), size: diameter * 0.95 * grow, color: gold)
            symbol("sparkle", in: &layer, center: CGPoint(x: side * 0.14, y: side * 0.26), size: diameter * 0.55 * grow, color: gold.opacity(0.85))
        }
    }

    private func chip(in context: inout GraphicsContext, center: CGPoint, diameter: CGFloat) {
        let rect = CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter)
        context.fill(Path(ellipseIn: rect), with: .color(chipFill))
        context.stroke(Path(ellipseIn: rect), with: .color(chipStroke), lineWidth: 1)
    }

    /// SF Symbol drawn aspect-fit inside a square of `size` around `center`.
    private func symbol(_ name: String, in context: inout GraphicsContext, center: CGPoint, size: CGFloat, color: Color) {
        guard size > 1 else { return }
        var image = context.resolve(Image(systemName: name))
        image.shading = .color(color)
        let natural = image.size
        guard natural.width > 0, natural.height > 0 else { return }
        let factor = min(size / natural.width, size / natural.height)
        let drawn = CGSize(width: natural.width * factor, height: natural.height * factor)
        context.draw(image, in: CGRect(x: center.x - drawn.width / 2, y: center.y - drawn.height / 2, width: drawn.width, height: drawn.height))
    }
}

/// Body outlines in a square, shared by the renderer and mirrored in the HTML prototype.
enum BotMascotShapes {
    static func body(_ body: BotAvatarAppearance.Body, in rect: CGRect) -> Path {
        let s = rect.width
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        switch body {
        case .round:
            return Path(ellipseIn: CGRect(origin: p(0.08, 0.08), size: CGSize(width: 0.84 * s, height: 0.84 * s)))
        case .bean:
            var path = Path()
            path.move(to: p(0.5, 0.13))
            path.addCurve(to: p(0.93, 0.57), control1: p(0.79, 0.13), control2: p(0.93, 0.33))
            path.addCurve(to: p(0.5, 0.9), control1: p(0.93, 0.81), control2: p(0.77, 0.9))
            path.addCurve(to: p(0.07, 0.57), control1: p(0.23, 0.9), control2: p(0.07, 0.81))
            path.addCurve(to: p(0.5, 0.13), control1: p(0.07, 0.33), control2: p(0.21, 0.13))
            path.closeSubpath()
            return path
        case .square:
            return Path(roundedRect: CGRect(origin: p(0.1, 0.1), size: CGSize(width: 0.8 * s, height: 0.8 * s)),
                        cornerRadius: 0.24 * s, style: .continuous)
        case .capsule:
            return Path(roundedRect: CGRect(origin: p(0.22, 0.06), size: CGSize(width: 0.56 * s, height: 0.88 * s)),
                        cornerRadius: 0.28 * s, style: .continuous)
        case .triangle:
            return roundedPolygon([p(0.5, 0.1), p(0.93, 0.88), p(0.07, 0.88)], radius: 0.15 * s)
        case .hexagon:
            let points = (0..<6).map { index -> CGPoint in
                let angle = (-90 + Double(index) * 60) * .pi / 180
                return p(0.5 + 0.44 * CGFloat(cos(angle)), 0.5 + 0.44 * CGFloat(sin(angle)))
            }
            return roundedPolygon(points, radius: 0.1 * s)
        case .cloud:
            let base = Path(roundedRect: CGRect(origin: p(0.07, 0.42), size: CGSize(width: 0.86 * s, height: 0.48 * s)),
                            cornerRadius: 0.24 * s, style: .continuous)
            let bumps = [(0.32, 0.5, 0.21), (0.56, 0.36, 0.26), (0.77, 0.53, 0.17)].map { x, y, r in
                Path(ellipseIn: CGRect(x: rect.minX + (x - r) * s, y: rect.minY + (y - r) * s, width: 2 * r * s, height: 2 * r * s))
            }
            return bumps.reduce(base) { $0.union($1) }
        case .drop:
            var path = Path()
            path.move(to: p(0.5, 0.06))
            path.addCurve(to: p(0.82, 0.6), control1: p(0.57, 0.18), control2: p(0.82, 0.37))
            path.addCurve(to: p(0.5, 0.92), control1: p(0.82, 0.78), control2: p(0.68, 0.92))
            path.addCurve(to: p(0.18, 0.6), control1: p(0.32, 0.92), control2: p(0.18, 0.78))
            path.addCurve(to: p(0.5, 0.06), control1: p(0.18, 0.37), control2: p(0.43, 0.18))
            path.closeSubpath()
            return path
        }
    }

    /// Center of the glass glint in unit coordinates (upper-left surface of each body).
    static func glint(_ body: BotAvatarAppearance.Body) -> CGPoint {
        switch body {
        case .round: CGPoint(x: 0.3, y: 0.2)
        case .bean: CGPoint(x: 0.3, y: 0.24)
        case .square: CGPoint(x: 0.28, y: 0.19)
        case .capsule: CGPoint(x: 0.37, y: 0.17)
        case .triangle: CGPoint(x: 0.44, y: 0.32)
        case .hexagon: CGPoint(x: 0.3, y: 0.28)
        case .cloud: CGPoint(x: 0.47, y: 0.2)
        case .drop: CGPoint(x: 0.39, y: 0.42)
        }
    }

    static func roundedPolygon(_ points: [CGPoint], radius: CGFloat) -> Path {
        var path = Path()
        guard points.count > 2 else { return path }
        let count = points.count
        let first = CGPoint(x: (points[0].x + points[count - 1].x) / 2, y: (points[0].y + points[count - 1].y) / 2)
        path.move(to: first)
        for index in 0..<count {
            path.addArc(tangent1End: points[index], tangent2End: points[(index + 1) % count], radius: radius)
        }
        path.closeSubpath()
        return path
    }

    /// Flat lid on top, round below.
    static func lowerHalfEye(_ rect: CGRect) -> Path {
        let k: CGFloat = 0.5523, rx = rect.width / 2, h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addCurve(to: CGPoint(x: rect.midX, y: rect.maxY), control1: CGPoint(x: rect.minX, y: rect.minY + k * h),
                      control2: CGPoint(x: rect.midX - k * rx, y: rect.maxY))
        path.addCurve(to: CGPoint(x: rect.maxX, y: rect.minY), control1: CGPoint(x: rect.midX + k * rx, y: rect.maxY),
                      control2: CGPoint(x: rect.maxX, y: rect.minY + k * h))
        path.closeSubpath()
        return path
    }
}
