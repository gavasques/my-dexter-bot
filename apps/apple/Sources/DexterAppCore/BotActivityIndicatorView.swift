import DexterHostClient
import SwiftUI

/// A fixed-footprint activity badge shared by all avatar representations. The containing row supplies the spoken
/// status. A symbol/shape always carries meaning as well as color, including with Reduce Motion or "Parado".
public struct BotActivityIndicatorView: View {
    private let activity: BotMascotActivity
    private let motion: BotAvatarAppearance.Motion
    private let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme
    @State private var isVisible = false

    public init(activity: BotMascotActivity, motion: BotAvatarAppearance.Motion = .subtle, size: CGFloat = 12) {
        self.activity = activity; self.motion = motion; self.size = size
    }

    private var framesPerSecond: Double? {
        BotActivityIndicatorMotion.framesPerSecond(activity: activity, motion: motion, reduceMotion: reduceMotion,
            isVisible: isVisible, isSceneActive: scenePhase == .active,
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    public var body: some View {
        Group {
            if activity != .idle {
                if let framesPerSecond {
                    TimelineView(.animation(minimumInterval: 1 / framesPerSecond)) { context in
                        badge(time: context.date.timeIntervalSinceReferenceDate)
                    }
                } else {
                    badge(time: nil)
                }
            }
        }
        .frame(width: size, height: size)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var ink: Color {
        switch activity {
        case .error: .red
        case .needsYou: .orange
        case .finished: .green
        default: .accentColor
        }
    }

    private func badge(time: Double?) -> some View {
        ZStack {
            Circle().fill(colorScheme == .dark ? Color(white: 0.16) : .white)
            Circle().strokeBorder(Color.primary.opacity(0.18), lineWidth: 0.75)
            mark(time: time).foregroundStyle(ink).padding(2.5)
        }
        .frame(width: size, height: size)
    }

    @ViewBuilder private func mark(time: Double?) -> some View {
        switch activity {
        case .idle: EmptyView()
        case .working:
            if let time {
                Circle().trim(from: 0.08, to: 0.78).stroke(style: StrokeStyle(lineWidth: 1.3, lineCap: .round))
                    .rotationEffect(.degrees(time.truncatingRemainder(dividingBy: 1.8) / 1.8 * 360))
            } else { symbol("hourglass") }
        case .thinking:
            symbol("brain").opacity(time.map { 0.72 + 0.28 * sin($0 * .pi) } ?? 1)
        case .writing:
            HStack(spacing: 1) {
                ForEach(0..<3) { index in
                    Circle().frame(width: 1.5, height: 1.5)
                        .opacity(time.map { 0.4 + 0.6 * max(0, sin($0 * 5 - Double(index) * 1.1)) } ?? 1)
                }
            }
        case .tool:
            symbol("gearshape.fill")
                .rotationEffect(.degrees(time.map { $0.truncatingRemainder(dividingBy: 5) / 5 * 360 } ?? 0))
        case .needsYou: symbol("exclamationmark")
        case .reconnecting:
            symbol("arrow.clockwise")
                .rotationEffect(.degrees(time.map { $0.truncatingRemainder(dividingBy: 2.5) / 2.5 * 360 } ?? 0))
        case .error: symbol("xmark")
        case .finished: symbol("checkmark")
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name).resizable().scaledToFit()
    }
}
