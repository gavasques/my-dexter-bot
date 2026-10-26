import DexterAppCore
import Foundation
import SwiftUI

/// Hashable summary of what a transcript shows; any change asks the follow policy, which decides whether to move.
struct ChatTranscriptChange: Hashable {
    var count: Int
    var lastID: String?
    var streamingLength: Int = 0
    var previewID: String?
}

/// Owns the follow/read policy for one transcript and at most one deferred scroll task.
/// Local presentation only: never touches the host, the draft, the selection or the composer.
@MainActor @Observable final class ChatTranscriptScrollController {
    /// Observed separately so geometry ticks do not re-render the transcript.
    private(set) var showsLatestButton = false
    @ObservationIgnored private var policy = ChatScrollFollowPolicy()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var context: Context?

    struct Context {
        let scope: @MainActor () -> ChatScrollScope
        let isPaused: @MainActor () -> Bool
        let reduceMotion: Bool
        let scrollToBottom: @MainActor (_ animated: Bool) -> Void
    }

    private static var now: Double { ProcessInfo.processInfo.systemUptime }

    func attach(_ context: Context) {
        self.context = context
        if policy.sync(scope: context.scope()) { cancelTask() }
        refresh()
    }

    func contentChanged(hasContent: Bool) {
        guard let context else { return }
        arm(policy.contentChanged(hasContent: hasContent, paused: context.isPaused(), now: Self.now))
    }

    /// Human send: follow again, still respecting the approval review gate.
    func followHumanSend() { arm(policy.requestLatest(now: Self.now, bypassesPause: false)) }

    /// The "Voltar ao fim" button: explicit local navigation.
    func jumpToLatest() { arm(policy.requestLatest(now: Self.now, bypassesPause: true)); refresh() }

    /// Forward pagination keeps the reading position.
    func preserveReadingPosition() { cancelTask(); policy.preserveReadingPosition(); refresh() }

    func phaseChanged(_ phase: ChatScrollPhase) {
        if phase.isHuman { cancelTask() }
        arm(policy.phaseChanged(phase, now: Self.now))
        refresh()
    }

    func geometryChanged(_ metrics: ChatScrollMetrics) {
        let deadline = policy.geometryChanged(metrics, now: Self.now)
        if policy.pendingDeadline == nil { cancelTask() }
        arm(deadline)
        refresh()
    }

    func disappear() { cancelTask(); policy.reset(); context = nil; refresh() }

    private func refresh() {
        if showsLatestButton != policy.showsLatestButton { showsLatestButton = policy.showsLatestButton }
    }

    private func cancelTask() { task?.cancel(); task = nil }

    /// A new deadline only exists when nothing was pending or an explicit request moved it earlier; a stream of
    /// updates therefore never cancels and re-arms the same wait.
    private func arm(_ deadline: Double?) {
        guard let deadline else { return }
        cancelTask()
        task = Task { @MainActor [weak self] in
            let delay = deadline - Self.now
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) } else { await Task.yield() }
            guard !Task.isCancelled else { return }
            self?.fire()
        }
    }

    private func fire() {
        task = nil
        guard let context else { policy.cancelPending(); return }
        switch policy.fire(now: Self.now, currentScope: context.scope(), paused: context.isPaused(), reduceMotion: context.reduceMotion) {
        case .none: break
        case .retry(let deadline): arm(deadline)
        case .move(let move): context.scrollToBottom(move.animated)
        }
        refresh()
    }
}

/// Coordinate space of the fallback geometry probe (macOS 14 / iOS 17).
private enum ChatTranscriptSpace { static let name = "chat.transcript.scroll" }

private struct ChatTranscriptContentFrameKey: PreferenceKey {
    static let defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() ?? value }
}

private struct ChatTranscriptViewportKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Fallback measurement for the scroll content; a no-op where onScrollGeometryChange exists.
private struct ChatTranscriptContentProbe: ViewModifier {
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content
        } else {
            content.background {
                GeometryReader { proxy in
                    Color.clear.preference(key: ChatTranscriptContentFrameKey.self, value: proxy.frame(in: .named(ChatTranscriptSpace.name)))
                }
            }
        }
    }
}

/// Public SwiftUI observation only: geometry + phase on macOS 15 / iOS 18, a named-space probe otherwise.
/// No event monitor, no scrollWheel override, no delegate replacement, no gesture that competes with native inertia.
private struct ChatTranscriptScrollObservation: ViewModifier {
    let controller: ChatTranscriptScrollController
    @State private var probeFrame: CGRect?
    @State private var viewport: CGFloat = 0

    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content
                .onScrollGeometryChange(for: ChatScrollMetrics.self) { geometry in
                    ChatScrollMetrics(offset: geometry.contentOffset.y + geometry.contentInsets.top,
                        contentHeight: geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom,
                        viewportHeight: geometry.containerSize.height)
                } action: { _, metrics in
                    controller.geometryChanged(metrics)
                }
                .onScrollPhaseChange { _, phase in controller.phaseChanged(ChatScrollPhase(phase)) }
        } else {
            content
                .coordinateSpace(.named(ChatTranscriptSpace.name))
                .background {
                    GeometryReader { proxy in Color.clear.preference(key: ChatTranscriptViewportKey.self, value: proxy.size.height) }
                }
                .onPreferenceChange(ChatTranscriptViewportKey.self) { height in viewport = height; report() }
                .onPreferenceChange(ChatTranscriptContentFrameKey.self) { frame in probeFrame = frame; report() }
        }
    }

    private func report() {
        guard let probeFrame, viewport > 0 else { return }
        controller.geometryChanged(ChatScrollMetrics(offset: -probeFrame.minY, contentHeight: probeFrame.height, viewportHeight: viewport))
    }
}

@available(macOS 15, iOS 18, *)
private extension ChatScrollPhase {
    init(_ phase: ScrollPhase) {
        switch phase {
        case .idle: self = .idle
        case .tracking: self = .tracking
        case .interacting: self = .interacting
        case .decelerating: self = .decelerating
        case .animating: self = .animating
        }
    }
}

private struct ChatTranscriptFollowing: ViewModifier {
    let controller: ChatTranscriptScrollController
    let proxy: ScrollViewProxy
    let bottomID: String
    let scope: @MainActor () -> ChatScrollScope
    let change: ChatTranscriptChange
    let hasContent: Bool
    let humanSendID: String?
    let isPaused: @MainActor () -> Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        let current = scope()
        content
            .modifier(ChatTranscriptScrollObservation(controller: controller))
            .overlay(alignment: .bottom) {
                if controller.showsLatestButton {
                    ChatTranscriptLatestButton { controller.jumpToLatest() }
                }
            }
            // onAppear (not onChange initial) so a re-appearance after onDisappear positions once again.
            .onAppear {
                controller.attach(context)
                controller.contentChanged(hasContent: hasContent)
            }
            .onChange(of: current) { _, _ in
                controller.attach(context)
                controller.contentChanged(hasContent: hasContent)
            }
            .onChange(of: change) { _, _ in
                controller.attach(context)
                controller.contentChanged(hasContent: hasContent)
            }
            .onChange(of: humanSendID) { old, new in
                guard let new, new != old else { return }
                controller.attach(context)
                controller.followHumanSend()
            }
            .onChange(of: reduceMotion) { _, _ in controller.attach(context) }
            .onDisappear { controller.disappear() }
    }

    private var context: ChatTranscriptScrollController.Context {
        let proxy = proxy, bottomID = bottomID
        return .init(scope: scope, isPaused: isPaused, reduceMotion: reduceMotion) { animated in
            if animated {
                withAnimation(.smooth(duration: 0.16)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            } else {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
        }
    }
}

/// Local navigation to the end of the loaded transcript. No host mutation.
private struct ChatTranscriptLatestButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Label("Voltar ao fim", systemImage: "arrow.down")
                .font(.callout.weight(.medium))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.separator))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 12)
        .help("Mostra a última mensagem e volta a acompanhar a conversa.")
        .accessibilityHint("Mostra a última mensagem e volta a acompanhar a conversa.")
        .accessibilityIdentifier("chat.scroll.latest")
    }
}

extension View {
    /// Apply to the transcript's scroll content (inside the ScrollView). Measures geometry on macOS 14 / iOS 17 only.
    func chatTranscriptContentProbe() -> some View { modifier(ChatTranscriptContentProbe()) }

    /// Apply to the transcript ScrollView inside its ScrollViewReader. Replaces unconditional scrollTo observers.
    func chatTranscriptFollowing(_ controller: ChatTranscriptScrollController, proxy: ScrollViewProxy, bottomID: String,
                                 scope: @escaping @MainActor () -> ChatScrollScope, change: ChatTranscriptChange,
                                 hasContent: Bool, humanSendID: String?,
                                 isPaused: @escaping @MainActor () -> Bool = { false }) -> some View {
        modifier(ChatTranscriptFollowing(controller: controller, proxy: proxy, bottomID: bottomID, scope: scope, change: change,
                                         hasContent: hasContent, humanSendID: humanSendID, isPaused: isPaused))
    }
}
