import Foundation
import Observation
import DexterNativeActions

public enum NativeActionNavigation: Equatable {
    case chooseConversation
    case thread(NativeActionDestination)
}
public enum NativeActionRouterStatus: Equatable {
    case idle, waitingForForeground, validating, ready, refused, subscriptionEnded
    public var label: String {
        switch self {
        case .idle: ""
        case .waitingForForeground: "Abra o Dexter para revisar a solicitação."
        case .validating: "Conferindo a conversa no host atual…"
        case .ready: "Solicitação aberta. Revise antes de enviar."
        case .refused: "Conversa indisponível ou solicitação obsoleta. Atualize o host e tente novamente."
        case .subscriptionEnded: "O canal de ações terminou. Reinicie o Dexter para tentar novamente."
        }
    }
}

/// One app-owned subscription. Foreground scenes elect one owner; views never create queue consumers.
@Observable @MainActor public final class NativeActionRouter {
    public private(set) var navigation: NativeActionNavigation?
    public private(set) var navigationVersion: UInt64 = 0
    public private(set) var status: NativeActionRouterStatus = .idle
    public private(set) var subscriptionStarts = 0
    @ObservationIgnored private let queue: NativeActionHandoffQueue
    @ObservationIgnored private var model: DexterAppModel?
    @ObservationIgnored private var subscription: Task<Void,Never>?
    @ObservationIgnored private var work: Task<Void,Never>?
    @ObservationIgnored private var hasSubscribed = false
    @ObservationIgnored private var scenes: [UUID] = []
    @ObservationIgnored private var waiting: [UUID] = []
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var pickerRequest: (expiresAt:Date, generation:UInt64, hostScope:UUID?)?
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private let pickerLifetime: TimeInterval
    public init(queue: NativeActionHandoffQueue = .shared, pickerLifetime:TimeInterval = 120, now:@escaping @MainActor () -> Date = { Date() }) {
        self.queue = queue; self.now = now; self.pickerLifetime = min(max(pickerLifetime,1),600)
    }
    public func attach(_ model: DexterAppModel) {
        guard self.model == nil || self.model === model else { return }
        self.model = model
        guard !hasSubscribed else { return }
        hasSubscribed = true; subscriptionStarts += 1
        subscription = Task { [weak self, queue] in
            let stream = await queue.updates()
            for await id in stream {
                guard !Task.isCancelled, let self else { break }
                if self.scenes.isEmpty { if self.waiting.count < 32 { self.waiting.append(id) }; self.status = .waitingForForeground }
                else { await self.process(id) }
            }
            guard !Task.isCancelled, let self else { return }
            self.subscription = nil; self.status = .subscriptionEnded
            // No automatic reconnect: both overflow and subscriber-limit rejection finish this stream.
        }
    }
    public func ownsScene(_ id: UUID) -> Bool { scenes.first == id }
    public func setForeground(_ active: Bool, scene id: UUID) {
        if active {
            if !scenes.contains(id), scenes.count < 8 { scenes.append(id) }
            if scenes.first == id {
                if pickerRequest != nil { publishPicker() }
                let pending = waiting; waiting.removeAll()
                if !pending.isEmpty { Task { [weak self] in for id in pending { await self?.process(id) } } }
            }
        } else {
            let wasOwner = ownsScene(id); scenes.removeAll { $0 == id }
            if wasOwner { generation &+= 1; work?.cancel(); model?.clearNativeActionDraft(); navigation = nil; navigationVersion &+= 1; pickerRequest = nil; status = .idle }
        }
    }
    /// Parameter-free app shortcut: no host query or enumeration in App Intents.
    public func requestConversationPicker() {
        pickerRequest = (now().addingTimeInterval(pickerLifetime),generation,model?.nativeComposerScope)
        if !scenes.isEmpty { publishPicker() }
    }
    private func publishPicker() {
        guard let request = pickerRequest else { return }
        pickerRequest = nil
        guard now() < request.expiresAt, request.generation == generation, request.hostScope == nil || request.hostScope == model?.nativeComposerScope else { return }
        generation &+= 1; work?.cancel(); model?.clearNativeActionDraft()
        navigation = .chooseConversation; navigationVersion &+= 1; status = .ready
    }
    private func process(_ id: UUID) async {
        guard !scenes.isEmpty, let model else { if waiting.count < 32 { waiting.append(id) }; return }
        let token = generation
        guard let handoff = await queue.consume(id), !Task.isCancelled, token == generation, !scenes.isEmpty else { return }
        pickerRequest = nil
        status = .validating
        // A separate work task allows scene changes to cancel validation without cancelling the sole subscriber.
        work?.cancel()
        let next = Task { [weak self] in
            let destination = await model.resolveNativeAction(handoff)
            guard !Task.isCancelled, let self, token == self.generation, !self.scenes.isEmpty else { return }
            if let destination { self.navigation = .thread(destination); self.navigationVersion &+= 1; self.status = .ready }
            else { self.status = .refused }
        }
        work = next; await next.value
    }
    public func teardown() async {
        generation &+= 1; scenes.removeAll(); waiting.removeAll(); pickerRequest = nil
        work?.cancel(); subscription?.cancel(); let currentWork = work, currentSubscription = subscription
        work = nil; subscription = nil; model?.clearNativeActionDraft(); navigation = nil; navigationVersion &+= 1
        await currentWork?.value; await currentSubscription?.value; _ = await queue.cancelAll()
        model = nil; hasSubscribed = false; status = .idle
    }
}
