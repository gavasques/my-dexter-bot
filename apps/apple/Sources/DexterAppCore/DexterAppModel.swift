import DexterHostClient
import DexterNativeActions
import Foundation
import DexterClientIdentity
import Observation
import CryptoKit
#if os(macOS)
import AppKit
#endif

/// Ephemeral, normalized PNG selected by an explicit paste. Bytes never enter the navigation store.
public struct ChatComposerImage: Identifiable, Equatable, Sendable {
    public let id: String
    public let pngData: Data
    public let sha256: String
    public let width: Int
    public let height: Int

    public init(pngData: Data, width: Int, height: Int, id: String = UUID().uuidString.lowercased()) throws {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id,
              (33...2 * 1_024 * 1_024).contains(pngData.count), (1...4_096).contains(width),
              (1...4_096).contains(height), width * height <= 16_000_000,
              pngData.prefix(8).elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]),
              pngData[12..<16].elementsEqual([73, 72, 68, 82]) else { throw HostClientError.invalidRequest }
        func integer(_ start: Int) -> Int { pngData[start..<start + 4].reduce(0) { ($0 << 8) | Int($1) } }
        guard integer(16) == width, integer(20) == height else { throw HostClientError.invalidRequest }
        self.id = id; self.pngData = pngData; self.width = width; self.height = height
        sha256 = SHA256.hash(data: pngData).map { String(format: "%02x", $0) }.joined()
    }

    fileprivate func usingID(_ id: String) throws -> ChatComposerImage {
        try ChatComposerImage(pngData: pngData, width: width, height: height, id: id)
    }
}

public enum OutgoingMessagePreviewState: String, Sendable { case sending, accepted, uncertain, failed }

/// Immutable authority captured from the currently displayed owner proposal before scheduling a task.
/// Native drafts, Live, model output and ordinary submit calls never construct this snapshot.
public struct CommunicationConfirmationSnapshot: Equatable, Sendable {
    public let action: Action
    public let input: CommunicationConfirmationInput
    public let hostAddress: String
    public let hostScope: UUID
    public let hostID: String
    public let botID: String
    public let threadID: String
    public let presentationGeneration: UInt64
    fileprivate init(action: Action, input: CommunicationConfirmationInput, hostAddress: String, hostScope: UUID,
                     hostID: String, botID: String, threadID: String, presentationGeneration: UInt64) {
        self.action = action; self.input = input; self.hostAddress = hostAddress; self.hostScope = hostScope
        self.hostID = hostID; self.botID = botID; self.threadID = threadID; self.presentationGeneration = presentationGeneration
    }
}

public struct PendingCommunicationConfirmation: Sendable {
    public let action: Action
    public let input: CommunicationConfirmationInput
    public let hostAddress: String
    public let hostID: String
    public var isUncertain: Bool
}

/// Ephemeral composer content. Only the existing request ID/digest metadata is durable.
public struct OutgoingMessagePreview: Sendable {
    public let clientRequestID: String
    public let threadID: String
    public let hostScope: String
    public let content: String
    public let attachments: [ChatComposerImage]
    public let state: OutgoingMessagePreviewState
}

public struct PendingTurnSubmission: Sendable {
    public let threadID: String
    public let clientRequestID: String
    public let contentDigest: String
    public let content: String?
    public let isRecovered: Bool
    public let attachmentIDs: [String]
    public let attachments: [ChatComposerImage]

    public var submission: TurnSubmission? {
        content.map { TurnSubmission(content: $0, clientRequestId: clientRequestID, attachmentIds: attachmentIDs) }
    }

    public var needsTextEntry: Bool { content == nil }

    public init(threadID: String, submission: TurnSubmission, attachments: [ChatComposerImage] = []) {
        self.threadID = threadID
        clientRequestID = submission.clientRequestId
        contentDigest = DexterAppStateValidation.contentDigest(submission.content, imageDigests: attachments.map(\.sha256))
        content = submission.content
        isRecovered = false
        attachmentIDs = submission.attachmentIds ?? []
        self.attachments = attachments
    }

    fileprivate init(
        threadID: String,
        clientRequestID: String,
        contentDigest: String,
        content: String?,
        isRecovered: Bool,
        attachmentIDs: [String] = [],
        attachments: [ChatComposerImage] = []
    ) {
        self.threadID = threadID
        self.clientRequestID = clientRequestID
        self.contentDigest = contentDigest
        self.content = content
        self.isRecovered = isRecovered
        self.attachmentIDs = attachmentIDs
        self.attachments = attachments
    }
}

public enum DeviceDisplayStatus: Equatable, Sendable {
    case online
    case offline
    case unpaired
    case revoked
    case confirming
}

/// Launch composition only. A phone never silently substitutes sample bots for a missing paired Mac.
public enum DexterAppPlatform: Sendable {
    case mac, iPhone
    public static var current: Self {
        #if os(iOS)
        .iPhone
        #else
        .mac
        #endif
    }
}

public extension DeviceView {
    /// Unpaired legacy registrations are never presented as online, even if their last-seen timestamp is recent.
    var displayStatus: DeviceDisplayStatus {
        if presence == .revoked || revokedAt != nil { return .revoked }
        guard paired else { return .unpaired }
        return presence == .online ? .online : .offline
    }
}

/// The only policies this app writes. `allow` is never offered here, so the app cannot widen access.
public enum DeviceGrantChoice: String, CaseIterable, Sendable {
    case ask
    case deny
}

/// One host-listed (bot, operation, active Mac agent) pair. `revision == nil` means no grant, which the host treats as deny.
public struct DeviceGrantRow: Identifiable, Equatable, Sendable {
    public let botID: String
    public let tool: String
    public let destination: String
    public let policy: String?
    public let expiresAt: Int64?
    public let revision: Int?

    public var id: String { Self.key(botID: botID, tool: tool, destination: destination) }

    public init(_ entry: DeviceGrantEntry) {
        botID = entry.botId; tool = entry.tool; destination = entry.destination
        policy = entry.grant?.policy; expiresAt = entry.grant?.expiresAt; revision = entry.grant?.revision
    }

    init(_ grant: DeviceGrant) {
        botID = grant.botId; tool = grant.tool; destination = grant.destination
        policy = grant.policy; expiresAt = grant.expiresAt; revision = grant.revision
    }

    public func isExpired(at now: Date) -> Bool {
        guard let expiresAt else { return false }
        return Int64(now.timeIntervalSince1970 * 1_000) >= expiresAt
    }

    static func key(botID: String, tool: String, destination: String) -> String {
        "\(botID)\u{1F}\(tool)\u{1F}\(destination)"
    }
}

@MainActor
@Observable
public final class DexterAppModel {
    public let liveVoiceController: LiveVoiceController
    #if os(macOS)
    @ObservationIgnored private var codexVoiceControllers: [CodexVoiceScope: CodexNativeVoiceController] = [:]
    @ObservationIgnored private var nativeVoicePreferenceEditors: [String: NativeVoicePreferencesEditor] = [:]
    #endif
    public private(set) var liveVoiceSettings: LiveVoiceSettings?
    public private(set) var liveVoiceKeyConfigured = false
    public private(set) var liveVoiceNotice: String?
    @ObservationIgnored private var liveVoiceSettingsRead = UUID()
    @ObservationIgnored private var liveVoiceRecordingID: String?
    @ObservationIgnored private var liveVoiceOwnedRequests: [String: (scope: LiveVoiceScope, requestID: String, turnID: String?)] = [:]
    @ObservationIgnored private var liveVoiceLastDelegatedInput = ""
    public let pairing: PairedHostOnboarding
    @ObservationIgnored private var pairedBinding: PairedHostBinding?
    @ObservationIgnored private var pairedConnectionGeneration: UInt64?
    @ObservationIgnored private var attemptedPairedLaunchRestore = false
    @ObservationIgnored private var pairedConnectBusy = false
    public var hostAddress: String
    public private(set) var bots: [Bot] = []
    @ObservationIgnored private var botProfileGeneration: UInt64 = 0
    #if os(macOS)
    /// Exact owner-policy recovery survives closing its editor; no request is automatically resent.
    @ObservationIgnored var pendingBotExecutionAccessMutations: [String: BotExecutionAccessPendingMutation] = [:]
    var pendingApprovalTypeRevocations: [String: SavedApprovalTypeRevocation] = [:]
    var pendingChatApprovalModeMutations: [String: ChatApprovalModePendingMutation] = [:]
    var pendingApprovalPreferenceDecisions: [String: DecideApprovalPreferenceInput] = [:]
    public private(set) var approvalPreferenceDecisionNotices: [String: String] = [:]
    var pendingBotApprovalPolicyMutations: [String: BotApprovalPolicyPendingMutation] = [:]
    #endif
    public private(set) var teams: [Team] = []
    public private(set) var pendingTeamCreation: CreateTeamInput?
    #if os(macOS)
    /// In-memory exact request recovery survives closing the calendar, scoped to the original host.
    public var pendingAutomationMutation: AutomationPendingMutation?
    #endif
    public private(set) var selectedTeamID: String?
    public private(set) var threadsByTeam: [String: [HostThread]] = [:]
    @ObservationIgnored private var teamProfileGeneration: UInt64 = 0
    @ObservationIgnored private var teamConversationTasks: [String: DirectConversationSlot] = [:]
    @ObservationIgnored private var teamThreadRequestIDs: [String: String] = [:]
    public private(set) var threadsByBot: [String: [HostThread]] = [:]
    /// Display-only history metadata keyed by thread id, refreshed with the thread lists; never selection state.
    public private(set) var threadSummaries: [String: HostThreadSummary] = [:]
    public private(set) var selectedBotID: String?
    public private(set) var selectedThreadID: String?
    private var isThreadPresented = false

    /// Presentation is canonical here; a row highlight is only a keyboard selection intent.
    public var presentedThreadID: String? {
        guard isThreadPresented, isFixture || canUseHost, let botID = selectedBotID,
              let id = selectedThreadID, conversationThreads.contains(where: { $0.id == id && $0.botId == botID }) else { return nil }
        return id
    }
    public var threadPresentationGeneration: UInt64 { threadGeneration }
    public private(set) var messages: [Message] = []
    public private(set) var actions: [Action] = []
    public private(set) var devices: [DeviceView] = []
    public private(set) var isLoadingDevices = false
    public private(set) var deviceError: HostClientError?
    public private(set) var operatingDeviceIDs: Set<String> = []
    public private(set) var awaitingDeviceConfirmationIDs: Set<String> = []
    public private(set) var discardableDeviceMutationIDs: Set<String> = []
    /// Grant rows of `grantBotID` as last read from the current host; never synthesized locally.
    public private(set) var grantBotID: String?
    public private(set) var grantRows: [DeviceGrantRow] = []
    public private(set) var isLoadingGrants = false
    public private(set) var grantError: HostClientError?
    public private(set) var operatingGrantID: String?
    public private(set) var uncertainGrantIDs: Set<String> = []
    public private(set) var discardableGrantIDs: Set<String> = []
    public private(set) var currentTurn: Turn?
    /// Presentation fact only. A retained running turn is not proof that its observer is still alive.
    public private(set) var botActivityObservationAvailable = false
    /// UI captures this value at the click, before scheduling asynchronous work.
    public struct TurnControlIdentity: Equatable, Sendable {
        public let turnID: String
        public let threadID: String
        public let botID: String
        let hostGeneration: UInt64
        let threadGeneration: UInt64
        let hostScope: UUID
    }
    /// Captured from the rendered action; the origin is resolved by canonical GETs before a POST.
    public struct EffectControlIdentity: Equatable, Sendable {
        public let action: Action
        let hostGeneration: UInt64
        let threadGeneration: UInt64
        let hostScope: UUID
        let hostAddress: String
    }
    public private(set) var turnControlInFlight = false
    public private(set) var turnControlNotice: String?
    @ObservationIgnored private var stoppedObservationScope: ThreadScope?
    @ObservationIgnored private var turnControlToken: UUID?
    @ObservationIgnored private var stoppedTurnIDs: Set<String> = []
    @ObservationIgnored private var stoppedRequestIDs: Set<String> = []
    public private(set) var stoppedActionIDs: Set<String> = []
    public private(set) var lastStopContext: TurnControlStopContext?
    var cancelReconciliationInterval: Duration = .milliseconds(200)
    var cancelReconciliationAttempts = 8
    public private(set) var queuedReceiptResponseTurnIDs: Set<String> = []
    /// Bounded, memory-only DEBUG provenance. No input, message, URL, secret or wire-field changes.
    public private(set) var approvalInteractionTrace: [ApprovalInteractionTrace] = []
    public func traceApprovalInteraction(source: String, action: Action, focused: Bool, repeated: Bool = false, intent: String,
                                         keyCode: UInt16? = nil, modifierBits: UInt? = nil) {
        #if DEBUG
        let sequence = (approvalInteractionTrace.last?.sequence ?? 0) + 1
        approvalInteractionTrace.append(.init(sequence: sequence, source: source, action: action,
            hostScope: nativeComposerScope, generation: threadPresentationGeneration,
            focused: focused, repeated: repeated, intent: intent, keyCode: keyCode, modifierBits: modifierBits))
        if approvalInteractionTrace.count > 64 { approvalInteractionTrace.removeFirst(approvalInteractionTrace.count - 64) }
        #endif
    }
    public private(set) var streamingText = ""
    public private(set) var isLoading = false
    public private(set) var isSubmitting = false
    public private(set) var isOnline = false
    public private(set) var isFixture: Bool
    public private(set) var remotePairingPending = false
    public private(set) var nativeActionDraft: NativeActionDraft?
    public private(set) var nativeComposerScope = UUID()
    @ObservationIgnored private var retainedGroupCoordinator: GroupConversationCoordinator?
    public var groupCoordinator: GroupConversationCoordinator {
        if let retainedGroupCoordinator, retainedGroupCoordinator.isBoundToCurrentHost { return retainedGroupCoordinator }
        retainedGroupCoordinator?.invalidate()
        let value = GroupConversationCoordinator(model: self); retainedGroupCoordinator = value; return value
    }
    public private(set) var nativeConfirmationMessage: String?
    @ObservationIgnored private var nativeConsumedHandoffs: [UUID:Date] = [:]
    @ObservationIgnored private(set) var nativeProjectionHostID: String?
    @ObservationIgnored private var nativeOpeningSelectionID: UUID?
    @ObservationIgnored private var nativeDraftScope: ThreadScope?
    @ObservationIgnored private var nativeDraftVersion: UInt64 = 0
    @ObservationIgnored private var nativeDraftExpiry: Task<Void,Never>?
    @ObservationIgnored private var nativeConfirmationInFlight = false
    @ObservationIgnored private let nativeActionNow: @MainActor () -> Date
    public var errorMessage: String?
    public private(set) var persistenceNotice: String? = nil
    // Onboarding facts from the current host generation only; `clearReadinessFacts` drops them on every host change.
    private var readinessHealth: (identity: OnboardingHostIdentity, routing: OnboardingEngineRouting)?
    private var readinessHostFailure: ReadinessHostFailure?
    private var readinessEngines: [EngineID: OnboardingEngineObservation] = [:]
    /// The validated identity that was current when the loaded device list was requested, and still is.
    private var readinessDevicesIdentity: OnboardingHostIdentity?
    /// Advances whenever the validated identity changes or facts are cleared; thread reads carry the epoch of their dispatch.
    @ObservationIgnored private var readinessEpoch: UInt64 = 0
    public private(set) var engineCatalog: [EngineCatalogEntry] = []
    public private(set) var engineCatalogLookup: EngineCatalogLookup = .notLoaded
    @ObservationIgnored private var engineCatalogObservedAt: Int64?
    public var engineCatalogNotice: String? {
        if case .failed(let error) = engineCatalogLookup { return error.localizedDescription }
        return nil
    }
    public func engineReadiness(for engine: EngineID) -> EngineReadiness {
        EngineReadiness(entry: engineCatalog.first { $0.id == engine.rawValue }, lookup: engineCatalogLookup)
    }
    public private(set) var threadEngineSelection: ThreadEngineSelection?
    public private(set) var engineSelectionThreadID: String?
    public private(set) var isUpdatingEngineSelection = false
    public private(set) var engineSelectionRequiresReload = false
    public private(set) var engineSelectionNotice: String?
    @ObservationIgnored private var engineCatalogReadSequence: UInt64 = 0
    @ObservationIgnored private var engineSelectionReadSequence: UInt64 = 0
    public var canChangeThreadEngine: Bool {
        canEditBotProfiles && presentedThreadID == engineSelectionThreadID && threadEngineSelection != nil
            && !isSubmitting && pendingSubmission == nil && !isUpdatingEngineSelection && !engineSelectionRequiresReload
            && currentTurn?.state != .queued && currentTurn?.state != .running
            && !actions(for: selectedThreadID ?? "").contains { $0.state == .awaitingApproval || $0.state == .ready || $0.state == .running }
    }

    public func refreshEngineCatalog() async {
        await refreshEngineCatalog(validatedHealth: nil)
    }

    /// Metadata only. It never loads bots/threads, changes engine commands, checks accounts or starts inference.
    private func refreshEngineCatalog(validatedHealth: HostHealth?) async {
        guard canUseHost, !isFixture, let client else { return }
        let host = hostGeneration
        engineCatalogReadSequence &+= 1; var sequence = engineCatalogReadSequence
        engineCatalog = []; engineCatalogObservedAt = nil; engineCatalogLookup = .loading
        defer {
            if isCurrentHost(host), sequence == engineCatalogReadSequence, engineCatalogLookup == .loading {
                engineCatalogLookup = .notLoaded
            }
        }
        do {
            if validatedHealth == nil {
                let epoch = readinessEpoch
                let health = try await client.health()
                guard isCurrentHost(host), sequence == engineCatalogReadSequence, epoch == readinessEpoch, !Task.isCancelled else { return }
                guard health.remotePairing == (pairedBinding == nil ? "not_implemented" : "implemented") else { throw HostClientError.contractMismatch }
                recordReadinessHealth(health)
                // A newly discovered authority invalidates all earlier reads, including this read's previous sequence.
                sequence = engineCatalogReadSequence
                engineCatalogLookup = .loading
            }
            let epoch = readinessEpoch
            let observedAt = Int64(Date().timeIntervalSince1970 * 1_000)
            let entries = try await client.engineCatalog()
            guard isCurrentHost(host), sequence == engineCatalogReadSequence, epoch == readinessEpoch else { return }
            try Task.checkCancellation()
            engineCatalog = entries; engineCatalogObservedAt = observedAt; engineCatalogLookup = .loaded
        } catch is CancellationError {
            guard isCurrentHost(host), sequence == engineCatalogReadSequence else { return }
            engineCatalogLookup = .notLoaded
        } catch {
            guard isCurrentHost(host), sequence == engineCatalogReadSequence else { return }
            engineCatalogLookup = .failed((error as? HostClientError) ?? .offline)
        }
    }
    public func reloadThreadEngineSelection(threadID: String) async {
        guard presentedThreadID == threadID, !isUpdatingEngineSelection, let client else { return }
        let scope = currentThreadScope(threadID)
        engineSelectionReadSequence &+= 1; let sequence = engineSelectionReadSequence
        threadEngineSelection = nil; engineSelectionThreadID = threadID
        do {
            let value = try await client.threadEngineSelection(threadID: threadID)
            guard isCurrent(scope), presentedThreadID == threadID, sequence == engineSelectionReadSequence, !Task.isCancelled else { return }
            // Reconcile the bot revision too, so combined-scope CAS never reuses an uncertain baseline.
            if engineSelectionRequiresReload, let botID = selectedBotID {
                let fetched = try await client.getBot(id: botID)
                guard isCurrent(scope), presentedThreadID == threadID, sequence == engineSelectionReadSequence, fetched.id == botID else { return }
                if let index = bots.firstIndex(where: { $0.id == botID }), bots[index].revision <= fetched.revision { bots[index] = fetched }
            }
            threadEngineSelection = value; engineSelectionRequiresReload = false; engineSelectionNotice = nil
        } catch {
            guard isCurrent(scope), sequence == engineSelectionReadSequence else { return }
            engineSelectionNotice = String(localized: "Não foi possível carregar os modelos desta conversa.")
        }
    }
    public func changeThreadEngineSelection(threadID: String, selection: EngineSelection?, updateBotDefault: Bool = false) async {
        guard canChangeThreadEngine, engineSelectionThreadID == threadID, let baseline = threadEngineSelection, let client else { return }
        guard !updateBotDefault || selection != nil else { return }
        let bot = selectedBot
        guard !updateBotDefault || bot != nil else { return }
        let scope = currentThreadScope(threadID)
        isUpdatingEngineSelection = true; engineSelectionNotice = nil
        do {
            let updated = try await client.updateThreadEngineSelection(threadID: threadID, input: PatchThreadEngineSelection(
                expectedRevision: baseline.revision, selection: selection,
                scope: updateBotDefault ? .threadAndBot : .thread,
                expectedBotRevision: updateBotDefault ? bot?.revision : nil))
            guard isCurrent(scope), presentedThreadID == threadID else { return }
            if updateBotDefault {
                guard let changedBot = updated.updatedBot, changedBot.id == bot?.id,
                      let index = bots.firstIndex(where: { $0.id == changedBot.id }) else { throw HostClientError.mutationOutcomeUnknown }
                if bots[index].revision <= changedBot.revision { bots[index] = changedBot }
                botProfileGeneration &+= 1
            }
            threadEngineSelection = updated; isUpdatingEngineSelection = false
        } catch {
            guard isCurrent(scope), presentedThreadID == threadID else { return }
            isUpdatingEngineSelection = false; engineSelectionRequiresReload = true
            engineSelectionNotice = String(localized: "Recarregue a seleção para confirmar o estado antes de alterar novamente.")
        }
    }

    public private(set) var pendingSubmission: PendingTurnSubmission?
    /// In-memory replay metadata only. Reopening the app uses canonical host facts, never a fresh automatic approval.
    private var pendingCommunicationConfirmations: [String: PendingCommunicationConfirmation] = [:]
    public private(set) var communicationConfirmationNotice: String?

    public var pendingCommunicationConfirmationForActiveThread: PendingCommunicationConfirmation? {
        guard let threadID = selectedThreadID, let hostID = nativeProjectionHostID,
              let pending = pendingCommunicationConfirmations[communicationConfirmationKey(hostID: hostID, threadID: threadID)],
              pending.hostAddress == currentPersistenceHostKey(), pending.action.request.botId == selectedBotID else { return nil }
        return pending
    }

    public private(set) var outgoingMessagePreview: OutgoingMessagePreview?
    @ObservationIgnored private var outgoingPreviewScope: ThreadScope?
    @ObservationIgnored private var outgoingPreviewInputMessageID: String?

    public var outgoingMessagePreviewForActiveThread: OutgoingMessagePreview? {
        guard let preview = outgoingMessagePreview, let scope = outgoingPreviewScope, isCurrent(scope),
              preview.hostScope == currentPersistenceHostKey(),
              !messages.contains(where: { $0.threadId == preview.threadID && $0.role == .user && $0.id == outgoingPreviewInputMessageID }) else { return nil }
        return preview
    }

    private func previewSubmission(_ submission: TurnSubmission, content: String, attachments: [ChatComposerImage] = [], scope: ThreadScope) {
        let exactContent = outgoingMessagePreview?.clientRequestID == submission.clientRequestId
            && outgoingPreviewScope.map(isCurrent) == true ? outgoingMessagePreview!.content : content
        outgoingPreviewScope = scope
        outgoingPreviewInputMessageID = nil
        outgoingMessagePreview = OutgoingMessagePreview(clientRequestID: submission.clientRequestId,
            threadID: scope.threadID, hostScope: scope.hostAddress ?? "", content: exactContent, attachments: attachments, state: .sending)
    }

    private func updateOutgoingPreview(_ id: String, scope: ThreadScope, state: OutgoingMessagePreviewState, inputMessageID: String? = nil) {
        guard isCurrent(scope), let preview = outgoingMessagePreview, preview.clientRequestID == id,
              outgoingPreviewScope.map(isCurrent) == true else { return }
        if let inputMessageID { outgoingPreviewInputMessageID = inputMessageID }
        outgoingMessagePreview = OutgoingMessagePreview(clientRequestID: preview.clientRequestID,
            threadID: preview.threadID, hostScope: preview.hostScope, content: preview.content, attachments: preview.attachments, state: state)
        reconcileOutgoingPreview()
    }

    private func reconcileOutgoingPreview() {
        guard let preview = outgoingMessagePreview, let scope = outgoingPreviewScope, isCurrent(scope),
              messages.contains(where: { $0.threadId == preview.threadID && $0.role == .user && $0.id == outgoingPreviewInputMessageID }) else { return }
        outgoingMessagePreview = nil; outgoingPreviewScope = nil; outgoingPreviewInputMessageID = nil
    }


    @ObservationIgnored private var client: HostClient?
    @ObservationIgnored private let stateStorage: any DexterAppStateStorage
    @ObservationIgnored private var persistedMode: DexterStoredConnectionMode
    @ObservationIgnored private var lastLoopbackAddress: String?
    @ObservationIgnored private var pendingRequestRecords: [DexterPendingRequestRecord]
    @ObservationIgnored private var lastSelection: DexterLastSelectionRecord?
    @ObservationIgnored private var selectionRecoveryPending = true
    @ObservationIgnored private var recoveryRequiresExplicitConversation = false
    @ObservationIgnored private var hasCorruptStoredData = false
    /// Requests whose outcome is unknown in this process; a later definitive refusal proves nothing about them.
    @ObservationIgnored private var uncertainRequestIDs: Set<String> = []
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var pollScope: ThreadScope?
    @ObservationIgnored private var pollToken: UUID?
    @ObservationIgnored private var pollingTurnID: String?
    // Internal clock policy lets synthetic transports exercise teardown without waiting fifteen minutes.
    @ObservationIgnored var conversationObservationLifetime: Duration = .seconds(900)
    @ObservationIgnored var continuationObservationInterval: Duration = .seconds(2)
    var isObservingConversation: Bool { pollTask != nil }
    @ObservationIgnored private var threadReadSequence: UInt64 = 0
    @ObservationIgnored private var activeSubmissionID: String?
    @ObservationIgnored private var hostGeneration: UInt64 = 0
    @ObservationIgnored private var threadGeneration: UInt64 = 0
    @ObservationIgnored private var deviceGeneration: UInt64 = 0
    @ObservationIgnored private var deviceMutationSequence: UInt64 = 0
    @ObservationIgnored private var deviceMutationRevisions: [String: UInt64] = [:]
    @ObservationIgnored private var deviceOperationTokens: [String: UUID] = [:]
    @ObservationIgnored private var deviceMutationExpectations: [String: DeviceMutationExpectation] = [:]
    @ObservationIgnored private var grantGeneration: UInt64 = 0
    @ObservationIgnored private var grantOperationToken: UUID?
    @ObservationIgnored private var grantExpectations: [String: GrantExpectation] = [:]
    /// One in-flight list-then-maybe-create per host generation, address and bot; concurrent openers join it.
    /// Each waiting opener holds a lease; creation starts only while some lease is live for the current selection.
    @ObservationIgnored private var directConversationSlots: [String: DirectConversationSlot] = [:]

    private enum DirectConversationOutcome {
        case thread(String)
        case failed(Error)
        case stale
    }

    private struct DirectConversationSlot {
        let token: UUID
        let task: Task<DirectConversationOutcome, Never>
        var leases: [UUID: DirectConversationLease]
    }

    /// An opener's interest in a shared resolution. Cancellation is recorded synchronously from the
    /// cancellation handler, so the pre-create gate observes it without waiting for a main-actor hop.
    private final class DirectConversationLease: @unchecked Sendable {
        let id = UUID()
        let selection: UInt64
        private let lock = NSLock()
        private var cancelled = false
        init(selection: UInt64) { self.selection = selection }
        func cancel() { lock.lock(); cancelled = true; lock.unlock() }
        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    }

    private enum DeviceMutationExpectation: Equatable {
        case rename(name: String)
        case revoke

        func matches(_ device: DeviceView) -> Bool {
            switch self {
            case .rename(let name): device.name == name
            case .revoke: device.presence == .revoked && device.revokedAt != nil && !device.paired
            }
        }
    }

    /// What an ambiguous grant write asked for. Only a later read showing exactly this, at a newer revision, confirms it.
    private struct GrantExpectation: Equatable {
        let botID: String
        let policy: String
        let expiresAt: Int64?
        let previousRevision: Int?

        func matches(_ row: DeviceGrantRow) -> Bool {
            guard let revision = row.revision, row.policy == policy, row.expiresAt == expiresAt else { return false }
            return previousRevision.map { revision > $0 } ?? true
        }
    }

    private struct ThreadScope: Equatable {
        let hostGeneration: UInt64
        let threadGeneration: UInt64
        let threadID: String
        let hostAddress: String?
        let rawHostAddress: String
        let projectionHostID: String?
        /// `nil` when no identity was validated at dispatch; such reads never become readiness facts.
        let readinessEpoch: UInt64?
    }

    public init(client injectedClient: HostClient? = nil, storage injectedStorage: (any DexterAppStateStorage)? = nil, pairing injectedPairing: PairedHostOnboarding? = nil, liveVoiceController injectedLiveVoiceController: LiveVoiceController? = nil, nativeActionNow: @escaping @MainActor () -> Date = { Date() }, platform: DexterAppPlatform = .current) {
        liveVoiceController = injectedLiveVoiceController ?? (injectedClient != nil || injectedStorage != nil || injectedPairing != nil
            ? LiveVoiceController(keyStore: InMemoryLiveAPIKeyStore()) : LiveVoiceController())
        self.nativeActionNow = nativeActionNow
        pairing = injectedPairing ?? PairedHostOnboarding(journal: injectedStorage != nil || injectedClient != nil ? UnavailableClientClaimJournal() : FileClientClaimJournal.applicationArchive(), storage: injectedStorage != nil || injectedClient != nil ? EphemeralPairedHostStateStorage() : UserDefaultsPairedHostStateStorage())
        let storage = injectedStorage ?? UserDefaultsDexterAppStateStorage()
        stateStorage = storage
        var storedDataCorrupt = false
        var corruptionNotice: String?

        let savedState: DexterPersistedAppState?
        let unreadableNotice = DexterLocalization.text("The local configuration could not be read. The app opened in demo mode; review the connection before continuing.")
        switch storage.readState() {
        case .missing:
            savedState = nil
        case .data(let data):
            if let decoded = DexterAppStateValidation.decode(data) {
                savedState = decoded
            } else {
                savedState = nil
                storedDataCorrupt = true
                corruptionNotice = unreadableNotice
            }
        case .unreadable:
            savedState = nil
            storedDataCorrupt = true
            corruptionNotice = unreadableNotice
        }

        pendingRequestRecords = savedState?.pendingRequests ?? []
        lastSelection = savedState?.lastSelection
        persistedMode = savedState?.mode ?? .fixture
        lastLoopbackAddress = savedState?.loopbackAddress

        if let savedState {
            hostAddress = savedState.loopbackAddress ?? ""
            isFixture = savedState.mode == .fixture
            #if os(macOS) || targetEnvironment(simulator)
            if savedState.mode == .loopback, let address = savedState.loopbackAddress,
               let url = URL(string: address) {
                let injectedMatches = injectedClient.flatMap {
                    DexterAppStateValidation.validatedLoopbackAddress($0.baseURL.absoluteString)
                } == address
                client = injectedMatches ? injectedClient : HostClient(baseURL: url, accessPolicy: .loopbackDevelopment)
            } else {
                client = nil
            }
            remotePairingPending = false
            #else
            // On a physical iPhone, loopback is the phone itself. Keep the preference visible,
            // but do not treat it as a paired or reachable Mac host.
            client = nil
            remotePairingPending = savedState.mode == .loopback
            #endif
        } else {
            #if os(macOS) || targetEnvironment(simulator)
            let defaultURL = URL(string: "http://127.0.0.1:4317")!
            let injectedAddress = injectedClient.flatMap {
                DexterAppStateValidation.validatedLoopbackAddress($0.baseURL.absoluteString)
            }
            let initialAddress = injectedAddress ?? defaultURL.absoluteString
            let initialURL = URL(string: initialAddress) ?? defaultURL
            hostAddress = initialAddress
            lastLoopbackAddress = initialAddress
            persistedMode = .loopback
            client = injectedAddress == nil ? HostClient(baseURL: initialURL, accessPolicy: .loopbackDevelopment) : injectedClient
            isFixture = corruptionNotice != nil
            if isFixture { client = nil }
            remotePairingPending = false
            #else
            hostAddress = injectedClient?.baseURL.absoluteString ?? ""
            lastLoopbackAddress = injectedClient.flatMap {
                DexterAppStateValidation.validatedLoopbackAddress($0.baseURL.absoluteString)
            }
            client = nil
            isFixture = true
            remotePairingPending = false
            persistedMode = .fixture
            #endif
        }

        hasCorruptStoredData = storedDataCorrupt
        persistenceNotice = corruptionNotice
        // Older phone builds persisted their automatic fixture default. Reopening that preference must not
        // look like a real connection. The explicit developer-only demo gesture remains available per session.
        if platform == .iPhone, injectedClient == nil {
            client = nil; isFixture = false; remotePairingPending = true
            hostAddress = pairing.publicReference?.hostURL ?? ""
            if storedDataCorrupt {
                persistenceNotice = DexterLocalization.text("A configuração local não pôde ser lida. Revise a conexão com seu Mac.")
            }
        }
        if isFixture { installFixture() }
        if let injectedClient, case .pairedHost(let binding) = injectedClient.accessPolicy {
            pairedBinding = binding; client = injectedClient; hostAddress = binding.host.url.absoluteString
            isFixture = false; remotePairingPending = false; bots = []; actions = []; threadsByBot = [:]; threadSummaries = [:]; clearThreadProjection()
        }
    }

    /// Plain status of the connected base (UX-P0-02): the owner's own Mac is never called "development".
    public var backendLabel: String {
        if pairedBinding != nil { return isOnline ? DexterLocalization.text("Other base · connected") : DexterLocalization.text("Other base · offline") }
        if isFixture { return DexterLocalization.text("Demo (development only)") }
        if remotePairingPending {
            if DexterAppStateValidation.validatedLoopbackAddress(hostAddress) != nil {
                return DexterLocalization.text("Saved loopback · unavailable on a physical iPhone")
            }
            return DexterLocalization.text("Remote host · pairing unavailable")
        }
        if !canUseHost { return DexterLocalization.text("No base connected") }
        if isOnline { return DexterLocalization.text("On this Mac · connected") }
        return DexterLocalization.text("On this Mac · offline")
    }

    public var canUseHost: Bool {
        if let pairedBinding {
            guard !isFixture, !remotePairingPending, client != nil, hostAddress == pairedBinding.host.url.absoluteString else { return false }
            if let pairedConnectionGeneration { return pairing.generation == pairedConnectionGeneration && pairing.state == .paired }
            return true
        }
        #if os(macOS) || targetEnvironment(simulator)
        guard !isFixture, !remotePairingPending,
              let client,
              let enteredAddress = DexterAppStateValidation.validatedLoopbackAddress(hostAddress),
              let configuredAddress = DexterAppStateValidation.validatedLoopbackAddress(client.baseURL.absoluteString) else {
            return false
        }
        return enteredAddress == configuredAddress
        #else
        return false
        #endif
    }

    /// This delivery carries images only through the owner loopback API, not the paired-client body envelope.
    public var canAttachChatImages: Bool {
        canUseHost && pairedBinding == nil && DexterAppStateValidation.validatedLoopbackAddress(hostAddress) != nil
    }

    public func chatImageData(_ attachment: ChatAttachment, in threadID: String) async -> Data? {
        guard canAttachChatImages, let client, selectedThreadID == threadID,
              messages.contains(where: { $0.threadId == threadID && ($0.attachments ?? []).contains(attachment) }) else { return nil }
        let scope = currentThreadScope(threadID)
        do {
            let data = try await client.downloadChatImage(attachment, threadID: threadID)
            guard isCurrent(scope) else { return nil }
            return data
        } catch { return nil }
    }

    /// Profile administration currently belongs only to the Mac owner-loopback connection.
    public var canEditBotProfiles: Bool {
        #if os(macOS)
        guard canUseHost, !isFixture, pairedBinding == nil, let client,
              case .loopbackDevelopment = client.accessPolicy else { return false }
        return true
        #else
        return false
        #endif
    }

    public var requiresStorageReset: Bool { hasCorruptStoredData }

    /// An independent lifetime for the owner-local MCP settings sheet. Remote clients never receive
    /// administrative routes; closing this client cannot close the conversation transport.
    @ObservationIgnored private var deviceRouteSessions: [String: DeviceConversationRoutesSession] = [:]
    /// Owner technical settings only; namespace and live generation prevent a stale sheet targeting another host.
    public func makeDeviceRoutesSession() async throws -> DeviceConversationRoutesSession {
        guard canEditBotProfiles, isOnline, let hostID = approvalPolicyHostID, let client = makeLocalMcpClient() else { throw HostClientError.forbidden }
        let generation = hostGeneration, context = nativeComposerScope, address = hostAddress
        let health = try await client.health()
        guard canEditBotProfiles, isOnline, generation == hostGeneration, context == nativeComposerScope,
              address == hostAddress, health.hostId == hostID, let ownerID = bots.first?.ownerId else { throw HostClientError.contractMismatch }
        let key = "\(hostID):\(ownerID):\(context.uuidString)"
        if let retained = deviceRouteSessions[key] { await client.close().value; return retained }
        guard deviceRouteSessions.count < 128 else { throw HostClientError.notReady }
        let session = DeviceConversationRoutesSession(hostID: hostID, ownerID: ownerID, client: client,
            isCurrent: { [weak self] in
                guard let self else { return false }
                return self.canEditBotProfiles && self.isOnline && self.hostGeneration == generation
                    && self.nativeComposerScope == context && self.hostAddress == address && self.approvalPolicyHostID == hostID
            })
        deviceRouteSessions[key] = session; return session
    }
    public func makeLocalMcpClient() -> HostClient? {
        #if os(macOS)
        guard canUseHost, !isFixture, pairedBinding == nil,
              let address = DexterAppStateValidation.validatedLoopbackAddress(hostAddress),
              let url = URL(string: address) else { return nil }
        return HostClient(baseURL: url)
        #else
        return nil
        #endif
    }

    @ObservationIgnored private var mcpRegistrationSessions: [McpRegistrationNamespace: McpRegistrationSession] = [:]

    /// App-wide, memory-only consumption. Canonical history reads never arm an OAuth presentation.
    public let mcpAuthorizationHandoffs = McpAuthorizationHandoffCoordinator()
    /// Same fresh-approval rules for the computer-access panel; presenting it never prepares or grants anything.
    public let macSetupHandoffs = MacSetupHandoffCoordinator()

    public var mcpAuthorizationContext: McpAuthorizationContext? {
        #if os(macOS)
        guard canEditBotProfiles, isOnline, selectedTeamID == nil, !conversationObservationWasStopped,
              let host = approvalPolicyHostID, let bot = selectedBotID, let thread = selectedThreadID,
              presentedThreadID == thread, selectedThread?.botId == bot else { return nil }
        return McpAuthorizationContext(hostID: host, botID: bot, threadID: thread, hostAddress: hostAddress,
            composerScope: nativeComposerScope, hostGeneration: hostGeneration,
            threadGeneration: threadGeneration, readinessEpoch: readinessEpoch)
        #else
        return nil
        #endif
    }

    public func mcpAuthorizationIsCurrent(_ request: McpAuthorizationPresentation) -> Bool {
        request.context == mcpAuthorizationContext && !stoppedActionIDs.contains(request.handoff.actionId)
            && request.handoff.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000)
    }

    /// The computer-access panel opens only for the same live conversation, before the receipt expires or Stop.
    public func macSetupHandoffIsCurrent(_ request: MacSetupHandoffPresentation) -> Bool {
        request.context == mcpAuthorizationContext && !stoppedActionIDs.contains(request.handoff.actionId)
            && request.handoff.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000)
    }

    public func claimMcpAuthorizationLaunch(_ request: McpAuthorizationPresentation) -> Bool {
        #if os(macOS)
        guard mcpAuthorizationIsCurrent(request) else { return false }
        return mcpAuthorizationHandoffs.claimLaunch(request, context: mcpAuthorizationContext, foreground: NSApplication.shared.isActive)
        #else
        return false
        #endif
    }

    private func observeMcpAuthorizationResult(_ action: Action) {
        #if os(macOS)
        mcpAuthorizationHandoffs.receive(action, context: mcpAuthorizationContext, foreground: NSApplication.shared.isActive)
        macSetupHandoffs.receive(action, context: mcpAuthorizationContext, foreground: NSApplication.shared.isActive)
        #endif
    }

    /// One retained original intention per owner/base, bounded in this app process. No credential or disk storage.
    /// An explicit reopen may recover the same key; a stale window never adopts a new connection generation.
    public func makeMcpRegistrationSession(client suppliedClient: HostClient? = nil) async throws -> McpRegistrationSession {
        guard canEditBotProfiles, isOnline, let hostID = approvalPolicyHostID,
              let local = suppliedClient ?? makeLocalMcpClient(), local.baseURL.absoluteString == hostAddress,
              case .loopbackDevelopment = local.accessPolicy else { throw HostClientError.forbidden }
        let generation = hostGeneration, context = nativeComposerScope, address = hostAddress, epoch = readinessEpoch
        let health = try await local.health()
        guard isCurrentHost(generation), context == nativeComposerScope, address == hostAddress,
              epoch == readinessEpoch, health.hostId == hostID else { throw HostClientError.contractMismatch }
        let namespace = try McpRegistrationNamespace(baseURL: local.baseURL, health: health)
        if let existing = mcpRegistrationSessions[namespace], existing.scopeMatches { return existing }
        guard mcpRegistrationSessions[namespace] != nil || mcpRegistrationSessions.count < 32 else { throw HostClientError.notReady }
        let session = McpRegistrationSession(namespace: namespace, contextScope: context, client: local,
            previous: mcpRegistrationSessions[namespace], isCurrent: { [weak self] in
                guard let self else { return false }
                return self.canEditBotProfiles && self.isOnline && self.isCurrentHost(generation)
                    && self.nativeComposerScope == context && self.hostAddress == address
                    && self.readinessEpoch == epoch && self.approvalPolicyHostID == hostID
            })
        mcpRegistrationSessions[namespace] = session
        return session
    }

    public var inferenceLabel: String { DexterLocalization.text("Real inference: not verified") }

    /// Read-only snapshot of current facts. Missing facts stay unknown; nothing here probes engines or macOS permissions.
    public var onboardingReadinessInput: OnboardingReadinessInput {
        let host: OnboardingHostFact
        if isFixture { host = .fixture }
        else if remotePairingPending { host = .pairingUnavailable }
        else if !canUseHost { host = .unconfigured }
        else if isOnline, let health = readinessHealth { host = .online(health.identity) }
        else if isLoading || readinessHostFailure == nil { host = .checking }
        else if readinessHostFailure == .validationFailed { host = .validationFailed }
        else { host = .offline }
        let deviceFact: OnboardingDevicesFact
        if deviceError != nil { deviceFact = .failed }
        else if let identity = readinessHealth?.identity, readinessDevicesIdentity == identity { deviceFact = .loaded(devices) }
        else { deviceFact = .notLoaded }
        return OnboardingReadinessInput(
            host: host,
            routing: readinessHealth?.routing ?? .unknown,
            // The conversation's effective engine (UX-P0-01), never the bot default when the thread overrides it. While the
            // presented thread's own selection is unread, the bot default stands in provisionally and cannot block.
            selectedEngine: effectiveConversationEngine.readinessEngine,
            selectedEngineIsProvisional: effectiveConversationEngine.isProvisional,
            engines: readinessEngines,
            catalog: engineCatalogObservedAt.map { OnboardingEngineCatalog(entries: engineCatalog, observedAt: $0) },
            devices: deviceFact,
            capabilityRequests: actions.filter { $0.state == .awaitingApproval || $0.state == .ready }
                .map { OnboardingCapabilityRequest(deviceID: $0.request.destination, capability: $0.request.tool) }
        )
    }

    public var onboardingReadiness: OnboardingReadiness { OnboardingReadiness(onboardingReadinessInput) }

    public var isTurnGenerating: Bool {
        guard let threadID = selectedThreadID, stoppedObservationScope != currentThreadScope(threadID) else { return false }
        return currentTurn?.state == .queued || currentTurn?.state == .running
    }

    public var conversationObservationWasStopped: Bool {
        selectedThreadID.map { stoppedObservationScope == currentThreadScope($0) } ?? false
    }

    public func turnControlIdentity(in threadID: String) -> TurnControlIdentity? {
        guard canUseHost, selectedThreadID == threadID, let turn = currentTurn,
              turn.threadId == threadID, turn.botId == selectedBotID, !turn.state.isTerminal else { return nil }
        return TurnControlIdentity(turnID: turn.id, threadID: threadID, botID: turn.botId,
            hostGeneration: hostGeneration, threadGeneration: threadGeneration, hostScope: nativeComposerScope)
    }

    private func acceptsTurnControl(_ identity: TurnControlIdentity) -> Bool {
        turnControlIdentity(in: identity.threadID) == identity
    }

    public func actionDecisionIsSuspended(_ action: Action) -> Bool {
        stoppedActionIDs.contains(action.id) || (action.request.threadId == selectedThreadID && conversationObservationWasStopped)
    }

    public func effectControlIdentity(for action: Action) -> EffectControlIdentity? {
        guard canEditBotProfiles, isOnline, selectedThreadID == action.request.threadId, selectedBotID == action.request.botId,
              [.ready, .running].contains(action.state), actions.first(where: { $0.id == action.id }) == action,
              !actionDecisionIsSuspended(action) else { return nil }
        return EffectControlIdentity(action: action, hostGeneration: hostGeneration, threadGeneration: threadGeneration,
            hostScope: nativeComposerScope, hostAddress: hostAddress)
    }

    private func acceptsEffectControl(_ identity: EffectControlIdentity) -> Bool {
        guard canEditBotProfiles, isOnline, identity.hostGeneration == hostGeneration,
              identity.threadGeneration == threadGeneration, identity.hostScope == nativeComposerScope,
              identity.hostAddress == hostAddress, selectedThreadID == identity.action.request.threadId,
              selectedBotID == identity.action.request.botId, let action = actions.first(where: { $0.id == identity.action.id }),
              !actionDecisionIsSuspended(action) else { return false }
        return sameActionIdentity(action, identity.action)
    }

    public var selectedBot: Bot? {
        bots.first { $0.id == selectedBotID }
    }

    public var selectedTeam: Team? { teams.first { $0.id == selectedTeamID } }
    public var canEditTeams: Bool { canEditBotProfiles && nativeProjectionHostID != nil }
    public var teamHostID: String? { canEditTeams ? nativeProjectionHostID : nil }
    /// Active team history belongs to its current coordinator; historic bindings stay on the host.
    public func threads(forTeam teamID: String) -> [HostThread] {
        guard let team = teams.first(where: { $0.id == teamID }), let coordinator = team.coordinatorBotId else { return [] }
        return (threadsByTeam[teamID] ?? []).filter { $0.teamID == teamID && $0.botId == coordinator }
    }
    public var conversationThreads: [HostThread] {
        if let teamID = selectedTeamID { return threads(forTeam: teamID) }
        return selectedBotID.map { threads(for: $0) } ?? []
    }
    public var selectedThread: HostThread? {
        if selectedTeamID != nil { return conversationThreads.first { $0.id == selectedThreadID } }
        return threadsByBot.values.lazy.flatMap { $0 }.first { $0.id == selectedThreadID }
    }

    public func threads(for botID: String) -> [HostThread] {
        (threadsByBot[botID] ?? []).filter(\.isPrivateConversation)
    }
    /// History rows for the bot's private conversations, most recent activity first, filtered by `query`.
    public func threadHistoryRows(for botID: String, query: String = "") -> [ThreadHistoryRow] {
        ThreadHistoryProjection.rows(threads: threads(for: botID), summaries: threadSummaries, query: query)
    }
    /// History rows for the active Team coordinator's conversations.
    public func threadHistoryRows(forTeam teamID: String, query: String = "") -> [ThreadHistoryRow] {
        ThreadHistoryProjection.rows(threads: threads(forTeam: teamID), summaries: threadSummaries, query: query)
    }

    public func actions(for threadID: String) -> [Action] {
        actions.filter { $0.request.threadId == threadID }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func selectBot(id: String?) {
        guard selectedBotID != id || selectedTeamID != nil else { return }
        selectionRecoveryPending = false
        selectedTeamID = nil
        selectedBotID = id
        invalidateThreadSelection()
        recoveryRequiresExplicitConversation = false
        persistSelectionIfValidated()
    }

    /// Same-bot sidebar selection keeps the current conversation; Back explicitly closes it.
    /// Starts selection synchronously, before SwiftUI schedules the loading task.
    @discardableResult
    public func presentThread(_ threadID: String, for botID: String, preservingNativeDraft: Bool = false) -> UInt64? {
        guard selectedTeamID == nil, selectedBotID == botID, bots.contains(where: { $0.id == botID }),
              threads(for: botID).contains(where: { $0.id == threadID }), isFixture || canUseHost else { return nil }
        if isFixture {
            threadGeneration &+= 1
            stopPolling()
            installFixture()
        } else {
            _ = beginThreadSelection(threadID, preservingNativeDraft: preservingNativeDraft)
        }
        isThreadPresented = true
        return threadGeneration
    }

    /// Back stops local polling and invalidates pending delivery, never cancels a remote turn.
    public func closeThreadPresentation() {
        invalidateThreadSelection()
    }

    public func loadPresentedThread(_ threadID: String, generation: UInt64) async {
        guard threadGeneration == generation, presentedThreadID == threadID else { return }
        guard !isFixture, let client else { return }
        await loadThread(threadID, scope: currentThreadScope(threadID), client: client)
    }

    public func refresh() async {
        guard canUseHost else {
            isOnline = false
            return
        }
        guard let client else {
            isOnline = false
            return
        }
        let currentHostGeneration = hostGeneration
        let selectionAtStart = threadGeneration
        let profilesAtStart = botProfileGeneration
        let teamsAtStart = teamProfileGeneration
        isLoading = true
        defer {
            if hostGeneration == currentHostGeneration { isLoading = false }
        }

        do {
            let health = try await client.health()
            guard isCurrentHost(currentHostGeneration) else { return }
            guard health.remotePairing == (pairedBinding == nil ? "not_implemented" : "implemented") else {
                throw HostClientError.contractMismatch
            }
            // Bind facts to this validated identity before any further await, so device work from a previous identity
            // on the same address is invalidated as early as possible.
            recordReadinessHealth(health)
            // The onboarding Retry already calls refresh. Re-read metadata even when the following projection lists fail.
            await refreshEngineCatalog(validatedHealth: health)
            guard isCurrentHost(currentHostGeneration) else { return }
            async let fetchedBots = client.listBots()
            async let fetchedActions = client.listActions()
            let (nextBots, nextActions) = try await (fetchedBots, fetchedActions)
            guard isCurrentHost(currentHostGeneration) else { return }
            let nextTeams: [Team]
            if canEditBotProfiles { nextTeams = try await client.listTeams() } else { nextTeams = [] }
            guard isCurrentHost(currentHostGeneration) else { return }
            var nextTeamThreads: [String: [HostThread]] = [:]
            var nextSummaries: [String: HostThreadSummary] = [:]
            let requestedTeams = Set([selectedTeamID, lastSelection?.teamID].compactMap { $0 })
            for team in nextTeams where requestedTeams.contains(team.id) {
                let history = try await client.listTeamThreadHistory(teamID: team.id)
                nextTeamThreads[team.id] = history.threads; nextSummaries.merge(history.summaries) { _, new in new }
                guard isCurrentHost(currentHostGeneration) else { return }
            }

            var nextThreads: [String: [HostThread]] = [:]
            for bot in nextBots {
                let history = try await client.listThreadHistory(botID: bot.id)
                nextThreads[bot.id] = history.threads; nextSummaries.merge(history.summaries) { _, new in new }
                guard isCurrentHost(currentHostGeneration) else { return }
            }

            let nextProjectionID = health.installationId ?? health.hostId
            let selectionUnchangedDuringRefresh = threadGeneration == selectionAtStart
            let profileProjectionMatches = nativeProjectionHostID == nil || nativeProjectionHostID == nextProjectionID
            if let previous = nativeProjectionHostID, previous != nextProjectionID {
                nativeComposerScope = UUID(); clearNativeActionDraft()
                invalidateThreadSelection()
                selectedBotID = nil
                selectedTeamID = nil
                pendingTeamCreation = nil; teamThreadRequestIDs = [:]; teamConversationTasks = [:]
                selectionRecoveryPending = true
            }
            nativeProjectionHostID = nextProjectionID
            let currentBots = profileProjectionMatches ? bots : []
            var reconciledBots = nextBots.map { fetched in
                if let current = currentBots.first(where: { $0.id == fetched.id }), current.revision > fetched.revision { return current }
                return fetched
            }
            if profilesAtStart != botProfileGeneration {
                reconciledBots += currentBots.filter { current in !reconciledBots.contains(where: { $0.id == current.id }) }
            }
            bots = reconciledBots
            let currentTeams = profileProjectionMatches ? teams : []
            teams = nextTeams.map { fetched in
                if let current = currentTeams.first(where: { $0.id == fetched.id }), current.revision > fetched.revision { return current }
                return fetched
            }
            if teamsAtStart != teamProfileGeneration {
                teams += currentTeams.filter { current in !teams.contains(where: { $0.id == current.id }) }
            }
            threadsByTeam = profileProjectionMatches ? threadsByTeam.filter { id, _ in teams.contains(where: { $0.id == id }) } : [:]
            for (id, values) in nextTeamThreads { threadsByTeam[id] = values }
            if selectedTeamID != nil {
                if let team = selectedTeam {
                    let coordinator = team.coordinatorBotId.flatMap { value in bots.contains(where: { $0.id == value }) ? value : nil }
                    if selectedBotID != coordinator { invalidateThreadSelection(); selectedBotID = coordinator }
                } else { self.selectedTeamID = nil; invalidateThreadSelection() }
            }
            actions = nextActions
            threadsByBot = nextThreads
            threadSummaries = nextSummaries
            isOnline = true
            await loadLiveVoiceSettings()
            guard isCurrentHost(currentHostGeneration) else { return }

            // Recovery consumes only the current, fully fetched host projection. It never creates a thread.
            if selectionRecoveryPending, selectionUnchangedDuringRefresh, !Task.isCancelled {
                selectionRecoveryPending = false
                if restoreLastSelection(identity: nextProjectionID) { return }
            }

            // Reconcile removed bots before invalidation can advance the selection generation.
            if selectedTeamID == nil && (selectedBotID == nil || !bots.contains(where: { $0.id == selectedBotID })) {
                selectBot(id: bots.first?.id)
            }
            // UI routes select the verified bot before presenting its thread. A dropped thread
            // still invalidates an opening task started during refresh.
            if let selectedThreadID,
               !conversationThreads.contains(where: { $0.id == selectedThreadID }) {
                invalidateThreadSelection()
            }
            guard threadGeneration == selectionAtStart else { return }
            if let selectedThreadID { await openThread(selectedThreadID, preservingNativeDraft:true) }
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentHost(currentHostGeneration) else { return }
            isOnline = false
            // `contractMismatch` is a failed protocol/pairing/trusted-connection validation, possibly local and before any reply;
            // everything else reads as unreachable.
            readinessHostFailure = (error as? HostClientError) == .contractMismatch ? .validationFailed : .unreachable
            errorMessage = safeMessage(for: error)
        }
    }

    public func refreshActions() async {
        guard canUseHost, let client else { return }
        let currentHostGeneration = hostGeneration
        do {
            let nextActions = try await client.listActions()
            guard isCurrentHost(currentHostGeneration) else { return }
            actions = nextActions
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentHost(currentHostGeneration) else { return }
            errorMessage = safeMessage(for: error)
        }
    }

    public func refreshDevices() async {
        deviceGeneration &+= 1
        let requestGeneration = deviceGeneration
        let currentHostGeneration = hostGeneration
        let mutationRevisionAtStart = deviceMutationSequence
        // A validated identity change on the same address advances `deviceGeneration`, so this list stays bound to it.
        let identityAtDispatch = readinessHealth?.identity
        // A new list request invalidates any prior observation used to offer a local discard.
        discardableDeviceMutationIDs.removeAll()

        guard canUseHost, let client else {
            devices = []
            isLoadingDevices = false
            deviceError = remotePairingPending ? .remotePairingUnavailable : nil
            return
        }

        isLoadingDevices = true
        deviceError = nil
        defer {
            if isCurrentDeviceRequest(host: currentHostGeneration, devices: requestGeneration) {
                isLoadingDevices = false
            }
        }

        do {
            let nextDevices = try await client.listDevices()
            guard !Task.isCancelled,
                  isCurrentDeviceRequest(host: currentHostGeneration, devices: requestGeneration) else { return }
            devices = refreshedDevicesPreservingOperations(nextDevices, mutationRevisionAtStart: mutationRevisionAtStart)
            // A list requested before any validated identity is shown but never qualifies readiness.
            readinessDevicesIdentity = identityAtDispatch != nil && identityAtDispatch == readinessHealth?.identity ? identityAtDispatch : nil
            deviceError = awaitingDeviceConfirmationIDs.isEmpty ? nil : .deviceMutationOutcomeUnknown
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentDeviceRequest(host: currentHostGeneration, devices: requestGeneration) else { return }
            deviceError = awaitingDeviceConfirmationIDs.isEmpty
                ? safeHostClientError(for: error)
                : .deviceMutationOutcomeUnknown
        }
    }

    /// Clears a stale device error when opening a new, independent rename sheet.
    public func clearDeviceError() {
        guard operatingDeviceIDs.isEmpty else { return }
        deviceError = nil
    }

    public func displayStatus(for device: DeviceView) -> DeviceDisplayStatus {
        awaitingDeviceConfirmationIDs.contains(device.id) ? .confirming : device.displayStatus
    }

    /// Clears only this app's expectation after a fresh successful GET for this device did not confirm it.
    /// The earlier ambiguous request may still apply; this never retries that write.
    @discardableResult
    public func discardDeviceMutationExpectation(id: String) -> Bool {
        guard canUseHost,
              operatingDeviceIDs.isEmpty,
              awaitingDeviceConfirmationIDs.contains(id),
              discardableDeviceMutationIDs.contains(id) else { return false }

        awaitingDeviceConfirmationIDs.remove(id)
        discardableDeviceMutationIDs.remove(id)
        deviceMutationExpectations.removeValue(forKey: id)
        recordDeviceMutationRevision(for: id)
        deviceError = awaitingDeviceConfirmationIDs.isEmpty ? nil : .deviceMutationOutcomeUnknown
        return true
    }

    /// Performs one read-only check after an ambiguous mutation. It never retries the mutation.
    @discardableResult
    public func confirmDeviceMutation(id: String) async -> Bool {
        guard awaitingDeviceConfirmationIDs.contains(id) else {
            deviceError = .notFound
            return false
        }
        guard let expectation = deviceMutationExpectations[id] else {
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
        guard let mutationRevision = deviceMutationRevisions[id] else {
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
        guard canUseHost, let client else {
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
        guard operatingDeviceIDs.isEmpty else { return false }

        let currentHostGeneration = hostGeneration
        let operationToken = UUID()
        deviceOperationTokens[id] = operationToken
        operatingDeviceIDs.insert(id)
        discardableDeviceMutationIDs.remove(id)
        deviceError = .deviceMutationOutcomeUnknown
        defer {
            if isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) {
                operatingDeviceIDs.remove(id)
                deviceOperationTokens.removeValue(forKey: id)
            }
        }

        do {
            let observed = try await client.getDevice(id: id)
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken),
                  awaitingDeviceConfirmationIDs.contains(id),
                  deviceMutationRevisions[id] == mutationRevision,
                  deviceMutationExpectations[id] == expectation else { return false }
            replaceDevice(observed)
            guard expectation.matches(observed) else {
                // A successful, ID-checked read of this device lets the operator abandon the local
                // expectation even if another actor changed its name or its presence aged meanwhile.
                // This does not establish whether the earlier ambiguous write may still apply.
                discardableDeviceMutationIDs.insert(id)
                recordDeviceMutationRevision(for: id)
                deviceError = .deviceMutationOutcomeUnknown
                return false
            }

            awaitingDeviceConfirmationIDs.remove(id)
            discardableDeviceMutationIDs.remove(id)
            deviceMutationExpectations.removeValue(forKey: id)
            recordDeviceMutationRevision(for: id)
            deviceError = awaitingDeviceConfirmationIDs.isEmpty ? nil : .deviceMutationOutcomeUnknown
            return true
        } catch {
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken),
                  awaitingDeviceConfirmationIDs.contains(id),
                  deviceMutationRevisions[id] == mutationRevision else { return false }
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
    }

    @discardableResult
    public func renameDevice(id: String, name: String) async -> Bool {
        guard canUseHost, let client,
              let current = devices.first(where: { $0.id == id }),
              current.displayStatus != .revoked else {
            deviceError = canUseHost ? .notFound : .remotePairingUnavailable
            return false
        }
        guard !awaitingDeviceConfirmationIDs.contains(id) else {
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
        guard operatingDeviceIDs.isEmpty else { return false }

        let normalizedName = DeviceNameNormalizer.normalize(name)
        guard DeviceNameNormalizer.isValid(normalizedName) else {
            deviceError = .invalidRequest
            return false
        }
        guard normalizedName != current.name else { return false }

        let currentHostGeneration = hostGeneration
        let operationToken = UUID()
        recordDeviceMutationRevision(for: id)
        deviceOperationTokens[id] = operationToken
        operatingDeviceIDs.insert(id)
        deviceError = nil
        defer {
            if isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) {
                operatingDeviceIDs.remove(id)
                deviceOperationTokens.removeValue(forKey: id)
            }
        }

        do {
            let updated = try await client.renameDevice(id: id, name: normalizedName)
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            replaceDevice(updated)
            deviceMutationExpectations.removeValue(forKey: id)
            awaitingDeviceConfirmationIDs.remove(id)
            discardableDeviceMutationIDs.remove(id)
            recordDeviceMutationRevision(for: id)
            deviceError = awaitingDeviceConfirmationIDs.isEmpty ? nil : .deviceMutationOutcomeUnknown
            return true
        } catch is CancellationError {
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            markDeviceMutationUnknown(id: id, expectation: .rename(name: normalizedName))
            return false
        } catch {
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            if isAmbiguousDeviceMutationError(error) {
                markDeviceMutationUnknown(id: id, expectation: .rename(name: normalizedName))
            } else {
                deviceError = safeHostClientError(for: error)
            }
            return false
        }
    }

    @discardableResult
    public func revokeDevice(id: String) async -> Bool {
        if pairedBinding?.deviceID == id {
            await revokeThisClient(); return pairing.state == .revoked
        }
        guard canUseHost, let client,
              let current = devices.first(where: { $0.id == id }),
              current.displayStatus != .revoked else {
            deviceError = canUseHost ? .notFound : .remotePairingUnavailable
            return false
        }
        guard !awaitingDeviceConfirmationIDs.contains(id) else {
            deviceError = .deviceMutationOutcomeUnknown
            return false
        }
        guard operatingDeviceIDs.isEmpty else { return false }

        let currentHostGeneration = hostGeneration
        let operationToken = UUID()
        recordDeviceMutationRevision(for: id)
        deviceOperationTokens[id] = operationToken
        operatingDeviceIDs.insert(id)
        deviceError = nil
        defer {
            if isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) {
                operatingDeviceIDs.remove(id)
                deviceOperationTokens.removeValue(forKey: id)
            }
        }

        do {
            let revoked = try await client.revokeDevice(id: id)
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            replaceDevice(revoked)
            deviceMutationExpectations.removeValue(forKey: id)
            awaitingDeviceConfirmationIDs.remove(id)
            discardableDeviceMutationIDs.remove(id)
            recordDeviceMutationRevision(for: id)
            deviceError = awaitingDeviceConfirmationIDs.isEmpty ? nil : .deviceMutationOutcomeUnknown
            return true
        } catch is CancellationError {
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            markDeviceMutationUnknown(id: id, expectation: .revoke)
            return false
        } catch {
            guard isCurrentDeviceOperation(host: currentHostGeneration, id: id, token: operationToken) else { return false }
            if isAmbiguousDeviceMutationError(error) {
                markDeviceMutationUnknown(id: id, expectation: .revoke)
            } else {
                deviceError = safeHostClientError(for: error)
            }
            return false
        }
    }

    /// Read-only. Lists the host's rows for `botID` and checks any uncertain write of that bot against them;
    /// it never resends a write. A late reply for another bot, read or host is dropped.
    public func loadDeviceGrants(botID: String) async {
        guard operatingGrantID == nil else { return }
        if grantBotID != botID { grantRows = []; grantError = nil }
        grantBotID = botID
        grantGeneration &+= 1
        let requestGeneration = grantGeneration
        let currentHostGeneration = hostGeneration
        discardableGrantIDs = discardableGrantIDs.filter { grantExpectations[$0]?.botID != botID }

        guard canUseHost, let client else {
            grantRows = []
            isLoadingGrants = false
            grantError = remotePairingPending ? .remotePairingUnavailable : nil
            return
        }
        guard bots.contains(where: { $0.id == botID }) else {
            grantRows = []
            isLoadingGrants = false
            grantError = .notFound
            return
        }

        isLoadingGrants = true
        grantError = nil
        defer {
            if isCurrentGrantRequest(host: currentHostGeneration, grants: requestGeneration) { isLoadingGrants = false }
        }

        do {
            let page = try await client.deviceGrants(botID: botID)
            guard !Task.isCancelled,
                  isCurrentGrantRequest(host: currentHostGeneration, grants: requestGeneration),
                  grantBotID == botID else { return }
            grantRows = page.items.map(DeviceGrantRow.init)
            for (id, expectation) in grantExpectations where expectation.botID == botID {
                if let row = grantRows.first(where: { $0.id == id }), expectation.matches(row) {
                    grantExpectations.removeValue(forKey: id)
                    uncertainGrantIDs.remove(id)
                    discardableGrantIDs.remove(id)
                } else {
                    discardableGrantIDs.insert(id)
                }
            }
            grantError = grantExpectations.values.contains(where: { $0.botID == botID }) ? .mutationOutcomeUnknown : nil
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentGrantRequest(host: currentHostGeneration, grants: requestGeneration) else { return }
            grantError = safeHostClientError(for: error)
        }
    }

    /// Writes one ask/deny decision with the revision the app last read (`nil` creates only if absent), no expiry.
    /// A conflict re-reads without resending. An ambiguous outcome keeps the expectation and re-reads once.
    @discardableResult
    public func setDeviceGrant(id: String, to choice: DeviceGrantChoice, renewExisting: Bool = false) async -> Bool {
        guard canUseHost, let client, let botID = grantBotID,
              let row = grantRows.first(where: { $0.id == id }), row.botID == botID else {
            grantError = canUseHost ? .notFound : .remotePairingUnavailable
            return false
        }
        guard !uncertainGrantIDs.contains(id) else {
            grantError = .mutationOutcomeUnknown
            return false
        }
        guard operatingGrantID == nil else { return false }
        guard renewExisting || row.revision == nil || row.policy != choice.rawValue || row.expiresAt != nil else { return true }

        let input = DeviceGrantInput(
            botId: row.botID, tool: row.tool, destination: row.destination,
            policy: choice.rawValue, expiresAt: nil, expectedRevision: row.revision
        )
        let expectation = GrantExpectation(botID: botID, policy: choice.rawValue, expiresAt: nil, previousRevision: row.revision)
        let currentHostGeneration = hostGeneration
        let operationToken = UUID()
        // Any read dispatched before this write is now stale.
        grantGeneration &+= 1
        isLoadingGrants = false
        grantOperationToken = operationToken
        operatingGrantID = id
        grantError = nil
        func finishOperation() -> Bool {
            guard isCurrentGrantOperation(host: currentHostGeneration, token: operationToken) else { return false }
            operatingGrantID = nil
            grantOperationToken = nil
            return true
        }

        do {
            let grant = try await client.putDeviceGrant(input)
            guard finishOperation() else { return false }
            let updated = DeviceGrantRow(grant)
            guard updated.id == id, expectation.matches(updated) else {
                markGrantMutationUnknown(id: id, expectation: expectation)
                await loadDeviceGrants(botID: botID)
                return !uncertainGrantIDs.contains(id)
            }
            if let index = grantRows.firstIndex(where: { $0.id == id }), grantBotID == botID { grantRows[index] = updated }
            return true
        } catch is CancellationError {
            guard finishOperation() else { return false }
            markGrantMutationUnknown(id: id, expectation: expectation)
            return false
        } catch {
            guard finishOperation() else { return false }
            let failure = safeHostClientError(for: error)
            switch failure {
            case .conflict:
                // Someone else changed this grant. Show the host's current value; never repeat the write.
                await loadDeviceGrants(botID: botID)
                if grantError == nil { grantError = .conflict }
            case .offline, .hostFailure, .contractMismatch, .mutationOutcomeUnknown, .deviceMutationOutcomeUnknown:
                markGrantMutationUnknown(id: id, expectation: expectation)
                await loadDeviceGrants(botID: botID)
                return !uncertainGrantIDs.contains(id)
            case .invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden,
                 .notFound, .notReady, .approvalExpired:
                // Rejected before any write (503 means grants are not configured on this host).
                grantError = failure
            }
            return false
        }
    }

    /// Clears only the local expectation after a successful read did not confirm it. It never resends the write.
    @discardableResult
    public func discardGrantExpectation(id: String) -> Bool {
        guard operatingGrantID == nil, discardableGrantIDs.contains(id) else { return false }
        grantExpectations.removeValue(forKey: id)
        uncertainGrantIDs.remove(id)
        discardableGrantIDs.remove(id)
        if let botID = grantBotID, !grantExpectations.values.contains(where: { $0.botID == botID }),
           grantError == .mutationOutcomeUnknown {
            grantError = nil
        }
        return true
    }

    private func markGrantMutationUnknown(id: String, expectation: GrantExpectation) {
        grantExpectations[id] = expectation
        uncertainGrantIDs.insert(id)
        discardableGrantIDs.remove(id)
        grantError = .mutationOutcomeUnknown
    }

    private func isCurrentGrantRequest(host: UInt64, grants: UInt64) -> Bool {
        isCurrentHost(host) && grantGeneration == grants
    }

    private func isCurrentGrantOperation(host: UInt64, token: UUID) -> Bool {
        isCurrentHost(host) && grantOperationToken == token
    }

    public func reloadBotProfile(botID: String) async throws -> Bot {
        guard canEditBotProfiles, let client else { throw HostClientError.forbidden }
        let host = hostGeneration
        let fetched = try await client.getBot(id: botID)
        guard isCurrentHost(host), !Task.isCancelled, fetched.id == botID else { throw HostClientError.contractMismatch }
        if let index = bots.firstIndex(where: { $0.id == botID }) {
            if bots[index].revision > fetched.revision { return bots[index] }
            bots[index] = fetched
        }
        botProfileGeneration &+= 1
        return fetched
    }

    public var approvalPolicyHostID: String? { canEditBotProfiles ? nativeProjectionHostID : nil }

    /// Per-request boundary for a retained settings window; this never creates or transfers authority.
    public func performSettingsOperation<Value: Sendable>(session: SettingsEditorSession, kind: SettingsEditorSession.OperationKind = .read,
        operation: @MainActor (HostClient) async throws -> Value) async throws -> Value {
        guard session.isCurrent(in: self), let client else { throw HostClientError.forbidden }
        do {
            let value = try await operation(client)
            guard session.isCurrent(in: self), !Task.isCancelled else {
                throw kind == .mutation ? HostClientError.mutationOutcomeUnknown : .contractMismatch
            }
            return value
        } catch {
            // A mutation already sent to the old base stays uncertain; a new base never receives a replay.
            guard session.isCurrent(in: self), !Task.isCancelled else {
                throw kind == .mutation ? HostClientError.mutationOutcomeUnknown : .contractMismatch
            }
            throw error
        }
    }

    public func loadBotApprovalPolicy(botID: String, ownerID: String, session: SettingsEditorSession? = nil) async throws -> BotApprovalPolicy {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, let hostID = approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let value = try await client.botApprovalPolicy(botID: botID)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, value.hostId == hostID, value.ownerId == ownerID else {
            throw HostClientError.contractMismatch
        }
        return value
    }

    public func updateBotApprovalPolicy(botID: String, ownerID: String, input: PatchBotApprovalPolicyInput, session: SettingsEditorSession? = nil) async throws -> BotApprovalPolicyReceipt {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, input.expectedHostId == approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let receipt = try await client.updateBotApprovalPolicy(botID: botID, input: input)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, receipt.ownerId == ownerID else { throw HostClientError.mutationOutcomeUnknown }
        return receipt
    }

    public func reconcileBotApprovalPolicy(botID: String, ownerID: String, input: PatchBotApprovalPolicyInput, session: SettingsEditorSession? = nil) async throws -> BotApprovalPolicyReceipt {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, input.expectedHostId == approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let receipt = try await client.botApprovalPolicyReceipt(botID: botID, input: input)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, receipt.ownerId == ownerID else { throw HostClientError.contractMismatch }
        return receipt
    }

    /// CAS profile edit. Never changes selection and never retries a mutation.
    public func loadBotExecutionAccess(botID: String, ownerID: String, session: SettingsEditorSession? = nil) async throws -> BotExecutionAccess {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, let hostID = approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let value = try await client.botExecutionAccess(botID: botID)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, value.hostId == hostID, value.ownerId == ownerID else {
            throw HostClientError.contractMismatch
        }
        return value
    }

    public func updateBotExecutionAccess(botID: String, ownerID: String, input: PatchBotExecutionAccessInput, session: SettingsEditorSession? = nil) async throws -> BotExecutionAccessReceipt {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, input.expectedHostId == approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let receipt = try await client.updateBotExecutionAccess(botID: botID, input: input)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, receipt.ownerId == ownerID else { throw HostClientError.mutationOutcomeUnknown }
        return receipt
    }

    public func reconcileBotExecutionAccess(botID: String, ownerID: String, input: PatchBotExecutionAccessInput, session: SettingsEditorSession? = nil) async throws -> BotExecutionAccessReceipt {
        guard session.map({ $0.matches(botID: botID, ownerID: ownerID, in: self) }) ?? true else { throw HostClientError.forbidden }
        guard canEditBotProfiles, let client, input.expectedHostId == approvalPolicyHostID,
              bots.contains(where: { $0.id == botID && $0.ownerId == ownerID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let receipt = try await client.botExecutionAccessReceipt(botID: botID, input: input)
        guard isCurrentHost(host), !Task.isCancelled, session.map({ $0.isCurrent(in: self) }) ?? true, receipt.ownerId == ownerID else { throw HostClientError.contractMismatch }
        return receipt
    }

    /// CAS profile edit. Never changes selection and never retries a mutation.
    public func updateBotProfile(botID: String, input: PatchBotInput) async throws -> Bot {
        guard canEditBotProfiles, let client, bots.contains(where: { $0.id == botID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let updated = try await client.updateBot(id: botID, input: input)
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.mutationOutcomeUnknown }
        botProfileGeneration &+= 1
        if let index = bots.firstIndex(where: { $0.id == botID }), bots[index].revision <= updated.revision { bots[index] = updated }
        // Read the resulting owner list without resending PATCH or changing selection.
        let profilesBeforeRead = botProfileGeneration
        if let fetched = try? await client.listBots(), isCurrentHost(host) {
            let current = bots
            bots = fetched.map { value in
                if let newer = current.first(where: { $0.id == value.id }), newer.revision > value.revision { return newer }
                return value
            }
            if profilesBeforeRead != botProfileGeneration {
                bots += current.filter { value in !bots.contains(where: { $0.id == value.id }) }
            }
            if !bots.contains(where: { $0.id == updated.id }) { bots.append(updated) }
        }
        guard isCurrentHost(host) else { throw HostClientError.mutationOutcomeUnknown }
        if input.defaultSelection != nil, selectedBotID == botID, let threadID = presentedThreadID {
            await reloadThreadEngineSelection(threadID: threadID)
            guard isCurrentHost(host) else { throw HostClientError.mutationOutcomeUnknown }
        }
        return updated
    }

    /// Selection keeps the coordinator as the action identity and the team as the conversation identity.
    public func selectTeam(id: String?) {
        guard let id, canEditTeams, let team = teams.first(where: { $0.id == id }) else { return }
        let coordinator = team.coordinatorBotId.flatMap { value in bots.contains(where: { $0.id == value }) ? value : nil }
        guard selectedTeamID != id || selectedBotID != coordinator else { return }
        selectionRecoveryPending = false
        invalidateThreadSelection()
        selectedTeamID = id; selectedBotID = coordinator
        recoveryRequiresExplicitConversation = false
        persistSelectionIfValidated()
    }

    @discardableResult
    public func presentTeamThread(_ threadID: String, teamID: String) -> UInt64? {
        guard canEditTeams, selectedTeamID == teamID,
              threads(forTeam: teamID).contains(where: { $0.id == threadID && $0.botId == selectedBotID }) else { return nil }
        _ = beginThreadSelection(threadID)
        isThreadPresented = true
        return threadGeneration
    }

    public func reloadTeams() async throws -> [Team] {
        guard canEditTeams, let client else { throw HostClientError.forbidden }
        let host = hostGeneration, generation = teamProfileGeneration
        let fetched = try await client.listTeams()
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.contractMismatch }
        let current = teams
        teams = fetched.map { value in
            current.first(where: { $0.id == value.id && $0.revision > value.revision }) ?? value
        }
        if generation != teamProfileGeneration {
            teams += current.filter { item in !teams.contains(where: { $0.id == item.id }) }
        }
        if let selectedTeamID, !teams.contains(where: { $0.id == selectedTeamID }) { selectBot(id: selectedBotID) }
        return teams
    }

    public func reloadTeam(teamID: String) async throws -> Team {
        guard canEditTeams, let client else { throw HostClientError.forbidden }
        let host = hostGeneration
        let fetched = try await client.getTeam(id: teamID)
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.contractMismatch }
        applyTeam(fetched)
        return teams.first(where: { $0.id == teamID }) ?? fetched
    }

    public func createTeam(input: CreateTeamInput) async throws -> Team {
        guard canEditTeams, input.expectedHostID == nativeProjectionHostID, let client else { throw HostClientError.forbidden }
        guard pendingTeamCreation == nil || pendingTeamCreation == input else { throw HostClientError.conflict }
        let host = hostGeneration
        let wasUncertain = pendingTeamCreation != nil
        pendingTeamCreation = input
        do {
            let created = try await client.createTeam(input)
            guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.mutationOutcomeUnknown }
            applyTeam(created); pendingTeamCreation = nil
            return created
        } catch {
            if isCurrentHost(host), !wasUncertain, (error as? HostClientError) != .mutationOutcomeUnknown,
               !(error is CancellationError) { pendingTeamCreation = nil }
            throw error
        }
    }

    public func updateTeam(teamID: String, input: PatchTeamInput) async throws -> Team {
        guard canEditTeams, input.expectedHostID == nativeProjectionHostID, let client,
              teams.contains(where: { $0.id == teamID }) else { throw HostClientError.forbidden }
        let host = hostGeneration
        let updated = try await client.patchTeam(id: teamID, input: input)
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.mutationOutcomeUnknown }
        applyTeam(updated)
        return updated
    }

    private func applyTeam(_ value: Team) {
        if let index = teams.firstIndex(where: { $0.id == value.id }) {
            guard teams[index].revision <= value.revision else { return }
            teams[index] = value
        } else { teams.append(value) }
        teamProfileGeneration &+= 1
        if selectedTeamID == value.id {
            if selectedBotID != value.coordinatorBotId ||
                (selectedThreadID != nil && !threads(forTeam: value.id).contains(where: { $0.id == selectedThreadID })) {
                invalidateThreadSelection()
            }
            selectedBotID = value.coordinatorBotId
            persistSelectionIfValidated()
        }
    }

    /// A history screen refreshes only its own list, retaining the transcript and draft.
    public func reloadPrivateThreadHistory(botID: String) async throws {
        guard canUseHost, bots.contains(where: { $0.id == botID }), let client else { throw HostClientError.forbidden }
        let host = hostGeneration
        let knownIDs = Set((threadsByBot[botID] ?? []).map(\.id))
        let history = try await client.listThreadHistory(botID: botID)
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.contractMismatch }
        for thread in threadsByBot[botID] ?? [] where thread.isPrivateConversation && knownIDs.contains(thread.id) { threadSummaries.removeValue(forKey: thread.id) }
        threadsByBot[botID] = ThreadHistoryProjection.retainingNewThreads(snapshot: history.threads, knownIDs: knownIDs, current: threadsByBot[botID] ?? [])
        threadSummaries.merge(history.summaries) { _, new in new }
    }

    public func reloadTeamThreads(teamID: String) async throws -> [HostThread] {
        guard canEditTeams, let client else { throw HostClientError.forbidden }
        let host = hostGeneration
        let knownIDs = Set((threadsByTeam[teamID] ?? []).map(\.id))
        let history = try await client.listTeamThreadHistory(teamID: teamID)
        guard isCurrentHost(host), !Task.isCancelled else { throw HostClientError.contractMismatch }
        for thread in threadsByTeam[teamID] ?? [] where knownIDs.contains(thread.id) { threadSummaries.removeValue(forKey: thread.id) }
        threadsByTeam[teamID] = ThreadHistoryProjection.retainingNewThreads(snapshot: history.threads, knownIDs: knownIDs, current: threadsByTeam[teamID] ?? [])
        threadSummaries.merge(history.summaries) { _, new in new }
        return threads(forTeam: teamID)
    }

    /// Always reads the current coordinator and its team history before creating. Ambiguous POSTs keep
    /// their request identity until an explicit opener reads again; no write is automatically retried.
    @discardableResult
    public func openConversationForSelectedTeam(_ teamID: String, createNew: Bool = false) async -> Bool {
        guard selectedTeamID == teamID, canEditTeams, let client, !Task.isCancelled else { return false }
        if !createNew, presentedThreadID != nil { return true }
        let host = hostGeneration, selection = threadGeneration, address = hostAddress
        let key = "\(host)|\(teamID)|\(selection)"
        let lease = DirectConversationLease(selection: selection)
        let task: Task<DirectConversationOutcome, Never>
        if let existing = teamConversationTasks[key] {
            task = existing.task
            teamConversationTasks[key]?.leases[lease.id] = lease
        } else {
            let token = UUID()
            task = Task { [weak self] in
                guard let self else { return .stale }
                let result = await self.resolveTeamConversation(teamID, key: key, host: host, selection: selection,
                    address: address, client: client, createNew: createNew)
                if self.teamConversationTasks[key]?.token == token { self.teamConversationTasks[key] = nil }
                return result
            }
            teamConversationTasks[key] = DirectConversationSlot(token: token, task: task, leases: [lease.id: lease])
        }
        let outcome = await withTaskCancellationHandler { await task.value } onCancel: { lease.cancel() }
        teamConversationTasks[key]?.leases[lease.id] = nil
        guard !Task.isCancelled, isCurrentHost(host), hostAddress == address, selectedTeamID == teamID,
              threadGeneration == selection, canEditTeams else { return false }
        switch outcome {
        case .thread(let id): return presentTeamThread(id, teamID: teamID) != nil
        case .failed(let error): errorMessage = safeMessage(for: error); return false
        case .stale: return false
        }
    }

    private func resolveTeamConversation(_ teamID: String, key: String, host: UInt64, selection: UInt64,
                                         address: String, client: HostClient, createNew: Bool) async -> DirectConversationOutcome {
        func current() -> Bool {
            isCurrentHost(host) && hostAddress == address && selectedTeamID == teamID && canEditTeams
                && threadGeneration == selection && !Task.isCancelled
        }
        do {
            let team = try await client.getTeam(id: teamID)
            guard current(), let coordinator = team.coordinatorBotId,
                  bots.contains(where: { $0.id == coordinator }), let hostID = nativeProjectionHostID else { return .stale }
            // Revalidate the coordinator without reopening its private conversation.
            applyTeam(team)
            guard current(), selectedBotID == coordinator else { return .stale }
            let listed = try await client.listTeamThreads(teamID: teamID)
            guard current() else { return .stale }
            threadsByTeam[teamID] = listed
            let requestKey = "\(host)|\(teamID)|\(team.revision)"
            let uncertainRequest = teamThreadRequestIDs[requestKey]
            if (!createNew || uncertainRequest != nil), let latest = Self.mostRecent(threads(forTeam: teamID)) {
                teamThreadRequestIDs[requestKey] = nil
                return .thread(latest.id)
            }
            let requestID = uncertainRequest ?? UUID().uuidString.lowercased()
            teamThreadRequestIDs[requestKey] = requestID
            guard current(), teamConversationTasks[key]?.leases.values.contains(where: { !$0.isCancelled && $0.selection == threadGeneration }) == true else { return .stale }
            let response = try await client.createTeamThread(teamID: teamID,
                input: CreateTeamThreadInput(expectedHostID: hostID, expectedRevision: team.revision, clientRequestId: requestID))
            guard current() else { return .stale }
            guard response.thread.botId == coordinator else { throw HostClientError.mutationOutcomeUnknown }
            teamThreadRequestIDs[requestKey] = nil
            if !threadsByTeam[teamID, default: []].contains(where: { $0.id == response.thread.id }) {
                threadsByTeam[teamID, default: []].append(response.thread)
            }
            return .thread(response.thread.id)
        } catch { return current() ? .failed(error) : .stale }
    }

    @discardableResult
    public func createBot(name: String, engine: EngineID, avatarAppearance: BotAvatarAppearance? = nil) async -> BotCreationOutcome {
        guard canUseHost, let client else {
            errorMessage = DexterLocalization.text("Creating bots requires a connection to the local host.")
            return .refused
        }
        let currentHostGeneration = hostGeneration
        let selectionAtStart = threadGeneration
        do {
            let bot = try await client.createBot(CreateBotInput(name: name, profileId: "default", engine: engine, avatarAppearance: avatarAppearance))
            guard isCurrentHost(currentHostGeneration) else { return .unconfirmed }
            botProfileGeneration &+= 1
            bots.append(bot)
            threadsByBot[bot.id] = []
            isOnline = true
            if threadGeneration == selectionAtStart { selectBot(id: bot.id) }
            return .created(botID: bot.id)
        } catch is CancellationError {
            return .unconfirmed
        } catch {
            guard isCurrentHost(currentHostGeneration) else { return .unconfirmed }
            errorMessage = safeMessage(for: error)
            switch error as? HostClientError {
            case .invalidConfiguration?, .remotePairingUnavailable?, .invalidRequest?, .forbidden?, .notFound?, .conflict?, .approvalExpired?:
                return .refused
            default:
                return .unconfirmed
            }
        }
    }

    public func createThread(for botID: String) async {
        guard canUseHost, let client else {
            errorMessage = DexterLocalization.text("Creating conversations requires a connection to the local host.")
            return
        }
        let currentHostGeneration = hostGeneration
        let selectionAtStart = threadGeneration
        do {
            let thread = try await client.createThread(botID: botID)
            guard isCurrentHost(currentHostGeneration) else { return }
            threadsByBot[botID, default: []].append(thread)
            if threadGeneration == selectionAtStart {
                selectBot(id: botID)
                await openThread(thread.id)
            }
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentHost(currentHostGeneration) else { return }
            errorMessage = safeMessage(for: error)
        }
    }

    /// Mac direct chat: reopens the bot's most recent conversation, or creates the first one when the host's
    /// current list is empty. The caller already selected `botID`; this never selects a bot or loads messages.
    /// Returns true only when a conversation of that bot is presented. A failed or ambiguous create is not
    /// retried here: `createThread` is not idempotent, so a later explicit call re-reads the list first.
    @discardableResult
    public func openConversationForSelectedBot(_ botID: String) async -> Bool {
        guard selectedTeamID == nil, selectedBotID == botID, bots.contains(where: { $0.id == botID }), !Task.isCancelled else { return false }
        if presentedThreadID.map({ id in threads(for: botID).contains { $0.id == id } }) == true { return true }
        if recoveryRequiresExplicitConversation, threads(for: botID).isEmpty {
            errorMessage = DexterLocalization.text("The previous conversation is unavailable. Choose a bot or create a new conversation.")
            return false
        }
        if isFixture {
            guard let latest = Self.mostRecent(threads(for: botID)) else { return false }
            return presentThread(latest.id, for: botID) != nil
        }
        guard canUseHost, let client else { return false }
        let host = hostGeneration, selection = threadGeneration, address = hostAddress
        let key = "\(host)|\(address)|\(botID)"
        let lease = DirectConversationLease(selection: selection)
        let task: Task<DirectConversationOutcome, Never>
        if let slot = directConversationSlots[key] {
            task = slot.task
            directConversationSlots[key]?.leases[lease.id] = lease
        } else {
            let token = UUID()
            task = Task { [weak self] in
                guard let self else { return .stale }
                let outcome = await self.resolveDirectConversation(botID, key: key, host: host, address: address, client: client)
                if self.directConversationSlots[key]?.token == token { self.directConversationSlots[key] = nil }
                return outcome
            }
            directConversationSlots[key] = DirectConversationSlot(token: token, task: task, leases: [lease.id: lease])
        }
        // Cancelling this opener withdraws its lease; a create already sent is still drained, never repeated.
        let outcome = await withTaskCancellationHandler { await task.value } onCancel: { lease.cancel() }
        directConversationSlots[key]?.leases[lease.id] = nil
        guard !Task.isCancelled, isCurrentHost(host), hostAddress == address, selectedBotID == botID, canUseHost else { return false }
        // A sibling opener of the same resolution may already have presented it; that is success, not staleness.
        if case .thread(let id) = outcome, presentedThreadID == id { return true }
        guard threadGeneration == selection else { return false }
        switch outcome {
        case .thread(let id):
            return presentThread(id, for: botID) != nil
        case .failed(let error):
            errorMessage = safeMessage(for: error)
            return false
        case .stale:
            return false
        }
    }

    /// Shared by every opener of the same scope. Creation needs a fresh empty list, the bot still selected on the
    /// same host and at least one uncancelled opener of the current selection generation, so late replies for
    /// another bot or host, cancelled openers, Back or an unattended A→B→A never start a POST.
    private func resolveDirectConversation(_ botID: String, key: String, host: UInt64, address: String, client: HostClient) async -> DirectConversationOutcome {
        func current() -> Bool {
            isCurrentHost(host) && hostAddress == address && canUseHost && selectedTeamID == nil && bots.contains(where: { $0.id == botID })
        }
        do {
            let listed = try await client.listThreads(botID: botID)
            guard current() else { return .stale }
            guard listed.allSatisfy({ $0.botId == botID && $0.isPrivateConversation && !$0.id.isEmpty }) else { throw HostClientError.contractMismatch }
            mergeThreads(listed, for: botID)
            if let latest = Self.mostRecent(listed) { return .thread(latest.id) }
            guard selectedBotID == botID, !Task.isCancelled,
                  directConversationSlots[key]?.leases.values.contains(where: { !$0.isCancelled && $0.selection == threadGeneration }) == true
            else { return .stale }
            let created = try await client.createThread(botID: botID)
            guard current() else { return .stale }
            guard created.botId == botID, created.isPrivateConversation, !created.id.isEmpty else { throw HostClientError.contractMismatch }
            mergeThreads([created], for: botID)
            return .thread(created.id)
        } catch is CancellationError {
            return .stale
        } catch {
            return current() ? .failed(error) : .stale
        }
    }

    private func mergeThreads(_ incoming: [HostThread], for botID: String) {
        var known = (threadsByBot[botID] ?? []).filter(\.isPrivateConversation)
        for thread in incoming where thread.isPrivateConversation && !known.contains(where: { $0.id == thread.id }) { known.append(thread) }
        threadsByBot[botID] = known
    }

    private static func mostRecent(_ threads: [HostThread]) -> HostThread? {
        threads.filter { $0.audience != .group && $0.groupID == nil }.max { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// IDs identify a destination only. Revalidate against the current host and its current projection.
    private func validateNativeThread(_ threadID: String, host: UInt64, selection: UInt64) async throws -> HostThread {
        guard canUseHost, isOnline, !isFixture, let client, !Task.isCancelled else { throw HostClientError.offline }
        let address = hostAddress
        func current() -> Bool { !Task.isCancelled && isCurrentHost(host) && threadGeneration == selection && canUseHost && isOnline && hostAddress == address }
        let health = try await client.health()
        guard current(), let projectionID = nativeProjectionHostID, (health.installationId ?? health.hostId) == projectionID, health.remotePairing == (pairedBinding == nil ? "not_implemented" : "implemented") else { throw HostClientError.contractMismatch }
        let thread = try await client.getThread(id:threadID)
        guard current(), thread.id == threadID, thread.isPrivateConversation, bots.contains(where:{$0.id == thread.botId}),
              threadsByBot[thread.botId]?.contains(where:{$0.id == thread.id && $0.botId == thread.botId}) == true else { throw HostClientError.notFound }
        return thread
    }
    /// UI route entry reads the canonical thread before selecting its expected bot. The route is
    /// navigation only; it creates no client, grant, tool authority or backend mutation.
    public func enterPresentedThread(_ threadID: String, for botID: String) async -> UInt64? {
        // Demo navigation has its own closed, in-memory projection; it never performs canonical host reads.
        if isFixture {
            guard !Task.isCancelled, bots.contains(where: { $0.id == botID }),
                  threads(for: botID).contains(where: { $0.id == threadID && $0.botId == botID }) else { return nil }
            selectBot(id: botID)
            return presentThread(threadID, for: botID)
        }
        let host = hostGeneration, address = hostAddress, startingSelection = threadGeneration
        let composerScope = nativeComposerScope
        var ownedGeneration: UInt64?
        func hostIsCurrent() -> Bool {
            isCurrentHost(host) && hostAddress == address && nativeComposerScope == composerScope && canUseHost
        }
        func ownsPresentation() -> Bool {
            guard let ownedGeneration else { return false }
            return hostIsCurrent() && threadGeneration == ownedGeneration && selectedBotID == botID && selectedThreadID == threadID
        }
        do {
            let thread = try await validateNativeThread(threadID, host: host, selection: startingSelection)
            guard !Task.isCancelled, hostIsCurrent(), threadGeneration == startingSelection,
                  thread.id == threadID, thread.botId == botID else { throw HostClientError.contractMismatch }
            // No await between the guarded starting selection and these two owned transitions.
            let preserveDraft = selectedBotID == botID && selectedTeamID == nil && selectedThreadID == threadID
                && nativeActionDraft?.threadID == threadID
                && nativeActionDraft.map { nativeActionNow() < $0.expiresAt } == true
                && nativeDraftScope.map(isCurrent) == true
            selectBot(id: botID)
            guard let generation = presentThread(threadID, for: botID, preservingNativeDraft: preserveDraft) else { throw HostClientError.notFound }
            ownedGeneration = generation
            await loadPresentedThread(threadID, generation: generation)
            guard !Task.isCancelled, ownsPresentation(), presentedThreadID == threadID,
                  isOnline, errorMessage == nil else { throw HostClientError.contractMismatch }
            return generation
        } catch {
            let canReport = !Task.isCancelled && hostIsCurrent()
                && (threadGeneration == startingSelection || ownsPresentation())
            if ownsPresentation() { closeThreadPresentation() }
            if canReport {
                errorMessage = DexterLocalization.text("The requested conversation could not be opened. Reopen the visible conversation before sending; your text has been kept.")
            }
            return nil
        }
    }

    public func resolveNativeAction(_ handoff: NativeActionHandoff) async -> NativeActionDestination? {
        var ownedSelection: ThreadScope?
        var resolved = false
        defer {
            // Refresh may reload this selection, but cannot acquire UI authority for it.
            // Only a newer explicit selection clears this ownership token.
            if let ownedSelection, nativeOpeningSelectionID == handoff.id {
                nativeOpeningSelectionID = nil
                if !resolved, isCurrentHost(ownedSelection.hostGeneration), selectedThreadID == ownedSelection.threadID {
                    invalidateThreadSelection()
                    errorMessage = DexterLocalization.text("The requested conversation could not be opened. Reopen the visible conversation before sending; your text has been kept.")
                }
            }
        }
        let host = hostGeneration, selection = threadGeneration
        let instant = nativeActionNow()
        nativeConsumedHandoffs = nativeConsumedHandoffs.filter { $0.value > instant }
        guard instant < handoff.expiresAt, nativeConsumedHandoffs[handoff.id] == nil, nativeConsumedHandoffs.count < 64 else { return nil }
        nativeConsumedHandoffs[handoff.id] = handoff.expiresAt
        do {
            let thread = try await validateNativeThread(handoff.route.threadID.rawValue,host:host,selection:selection)
            guard !Task.isCancelled, nativeActionNow() < handoff.expiresAt else { return nil }
            selectBot(id:thread.botId)
            guard let client, canUseHost else { return nil }
            let scope = beginThreadSelection(thread.id)
            ownedSelection = scope
            nativeOpeningSelectionID = handoff.id
            let expectedSelection = scope.threadGeneration
            await loadThread(thread.id, scope:scope, client:client)
            guard !Task.isCancelled, isCurrentHost(host), threadGeneration == expectedSelection,
                  selectedThreadID == thread.id, selectedBotID == thread.botId, canUseHost, isOnline,
                  errorMessage == nil, nativeActionNow() < handoff.expiresAt else { return nil }
            if case .prepareMessage(_,let draft) = handoff.route {
                nativeDraftVersion &+= 1
                let value = NativeActionDraft(id:handoff.id,version:nativeDraftVersion,threadID:thread.id,draft:draft,expiresAt:handoff.expiresAt)
                nativeDraftScope = currentThreadScope(thread.id); nativeActionDraft = value
                nativeDraftExpiry?.cancel()
                let delay = max(0,handoff.expiresAt.timeIntervalSince(nativeActionNow()))
                nativeDraftExpiry = Task { [weak self] in
                    do { try await Task.sleep(for:.seconds(delay)) } catch { return }
                    guard let self, self.nativeActionDraft?.id == handoff.id else { return }
                    self.expireNativeActionDraft()
                }
            }
            resolved = true
            return NativeActionDestination(botID:thread.botId,threadID:thread.id,handoffID:handoff.id)
        } catch { return nil }
    }
    public func expireNativeActionDraft() {
        guard let nativeActionDraft, nativeActionNow() >= nativeActionDraft.expiresAt else { return }
        clearNativeActionDraft()
    }
    public func clearNativeActionDraft() {
        nativeDraftExpiry?.cancel(); nativeDraftExpiry = nil; nativeActionDraft = nil; nativeDraftScope = nil
        nativeDraftVersion &+= 1
    }
    /// Only the explicit composer confirmation calls this; the router never submits.
    public func confirmNativeActionDraft(id: UUID, version: UInt64, content: BoundedDraft, expectedThreadID: String? = nil) async -> Bool {
        nativeConfirmationMessage = nil
        if let expectedThreadID, !validateVisibleThread(expectedThreadID) {
            nativeConfirmationMessage = errorMessage
            return false
        }
        guard !nativeConfirmationInFlight, !isSubmitting else {
            nativeConfirmationMessage = DexterLocalization.text("A submission is already in progress. Your text has been kept.")
            return false
        }
        guard let value = nativeActionDraft, value.id == id, value.version == version,
              nativeActionNow() < value.expiresAt, let scope = nativeDraftScope,
              isCurrent(scope), selectedThreadID == value.threadID else {
            if nativeActionDraft?.id == id { clearNativeActionDraft() }
            nativeConfirmationMessage = DexterLocalization.text("The request expired or its destination changed. Review your edits as a manual message.")
            return false
        }
        nativeConfirmationInFlight = true; defer { nativeConfirmationInFlight = false }
        do {
            _ = try await validateNativeThread(value.threadID,host:scope.hostGeneration,selection:scope.threadGeneration)
            guard nativeActionDraft?.id == id, nativeActionDraft?.version == version, isCurrent(scope),
                  nativeActionNow() < value.expiresAt, !Task.isCancelled else {
                if !isCurrent(scope) || nativeActionNow() >= value.expiresAt {
                    if nativeActionDraft?.id == id { clearNativeActionDraft() }
                }
                nativeConfirmationMessage = DexterLocalization.text("The request is no longer valid. Your text was not sent.")
                return false
            }
            let accepted = await submit(content.text, expectedThreadID:expectedThreadID ?? value.threadID)
            if accepted {
                if nativeActionDraft?.id == id && nativeActionDraft?.version == version { clearNativeActionDraft() }
            } else {
                nativeConfirmationMessage = errorMessage ?? DexterLocalization.text("The submission was not confirmed. Your text has been kept; review it before retrying.")
            }
            return accepted
        } catch {
            if error as? HostClientError == .offline { isOnline = false }
            let transient = error as? HostClientError == .offline || error as? HostClientError == .hostFailure || error as? HostClientError == .notReady || error is CancellationError
            if error as? HostClientError == .contractMismatch { nativeComposerScope = UUID(); nativeProjectionHostID = nil; isOnline = false }
            if !transient, nativeActionDraft?.id == id && nativeActionDraft?.version == version { clearNativeActionDraft() }
            nativeConfirmationMessage = transient
                ? DexterLocalization.text("The host is unavailable. Your text has been kept; review the connection before retrying.")
                : DexterLocalization.text("The host or conversation changed. Authorization was removed; your edits remain as a manual message.")
            return false
        }
    }

    public func openThread(_ threadID: String, preservingNativeDraft: Bool = false) async {
        guard !isFixture else {
            selectedThreadID = threadID
            return
        }
        guard canUseHost, let client else { return }
        let scope = beginThreadSelection(threadID, preservingNativeDraft:preservingNativeDraft)
        await loadThread(threadID, scope: scope, client: client)
    }

    private func loadThread(_ threadID: String, scope: ThreadScope, client: HostClient) async {
        threadReadSequence &+= 1
        let sequence = threadReadSequence
        func current() -> Bool { !Task.isCancelled && isCurrent(scope) && threadReadSequence == sequence }
        do {
            let turns = try await client.allTurns(threadID: threadID)
            guard current() else { return }
            observeReadiness(turns, scope: scope)
            if let pending = pendingRequestRecord(hostAddress: scope.hostAddress, threadID: threadID),
               turns.contains(where: { $0.threadId == threadID && $0.clientRequestId == pending.clientRequestID }) {
                removePendingRequest(pending)
                pendingSubmission = nil
            } else {
                restorePendingSubmission(hostAddress: scope.hostAddress, threadID: threadID)
            }
            let nextMessages = try await client.allMessages(threadID: threadID)
            guard current() else { return }
            var nextActions = actions
            var actionsWereRead = false
            do {
                nextActions = try await client.listActions()
                actionsWereRead = true
            } catch is CancellationError {
                return
            } catch {
                guard current() else { return }
                errorMessage = safeMessage(for: error)
            }
            guard current() else { return }

            messages = nextMessages
            reconcileOutgoingPreview()
            actions = nextActions
            var newest = turns.last(where: { !$0.state.isTerminal }) ?? turns.last
            // A manual read can start before the observer sees a host-created turn or its terminal
            // version. Preserve the newer projection rather than restarting an old event drain.
            if let observed = currentTurn, observed.threadId == threadID,
               newest == nil || observed.cursor > newest!.cursor
                || (observed.id == newest?.id && observed.state.isTerminal && !newest!.state.isTerminal) {
                newest = observed
            }
            currentTurn = newest
            // Only an explicit canonical reload clears a stopped/uncertain control. No automatic retry.
            if !turnControlInFlight && actionsWereRead {
                stoppedObservationScope = nil; turnControlNotice = nil
                stoppedTurnIDs = []; stoppedRequestIDs = []; stoppedActionIDs = []; lastStopContext = nil
            }
            queuedReceiptResponseTurnIDs = []
            if let newest, newest.state == .queued {
                // Bounded origin lookup, solely for truthful UI labeling. Missing origin stays unknown.
                for action in nextActions.filter({ $0.request.threadId == threadID && $0.request.botId == newest.botId }).suffix(32) {
                    let progress = try await client.actionContinuation(actionID: action.id)
                    guard current() else { return }
                    if progress?.originValid == true, progress?.responseTurnId == newest.id {
                        queuedReceiptResponseTurnIDs.insert(newest.id); break
                    }
                }
            }
            if let newest, !newest.state.isTerminal {
                beginPolling(newest, scope: scope, client: client)
            } else {
                beginContinuationObservation(scope: scope, client: client)
            }
        } catch is CancellationError {
            return
        } catch {
            guard current() else { return }
            errorMessage = safeMessage(for: error)
        }
    }

    /// The visible view supplies its destination; current selection alone is not UI authority.
    private func validateVisibleThread(_ expectedThreadID: String) -> Bool {
        guard selectedThreadID == expectedThreadID else {
            errorMessage = DexterLocalization.text("The selected conversation changed. Reopen the visible conversation before sending; your text has been kept.")
            return false
        }
        return true
    }

    /// Called by the manual chat send event while the exact proposal is still displayed.
    public func captureCommunicationConfirmation(action: Action, text: String, expectedThreadID: String) -> CommunicationConfirmationSnapshot? {
        guard CommunicationApprovalText.decision(for: text) != nil,
              let proposal = BotCommunicationProposal(action: action), canEditBotProfiles, isOnline,
              presentedThreadID == expectedThreadID, selectedThreadID == expectedThreadID,
              selectedBotID == action.request.botId, selectedThread?.botId == action.request.botId,
              action.request.threadId == expectedThreadID, let hostID = nativeProjectionHostID,
              proposal.hostID == hostID, let hostAddress = currentPersistenceHostKey(),
              bots.first(where: { $0.id == action.request.botId })?.revision == proposal.expectedRevision,
              actions(for: expectedThreadID).filter({ $0.state == .awaitingApproval }).count == 1,
              actions.first(where: { $0.id == action.id }) == action,
              ApprovalPresentation(action: action).canDecide(hostAvailable: canUseHost,
                  atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)),
              !isSubmitting, pendingSubmission == nil else {
            errorMessage = String(localized: "A proposta mudou ou não está disponível. Atualize a conversa e revise o cartão antes de autorizar; seu texto foi mantido.")
            return nil
        }
        let key = communicationConfirmationKey(hostID: hostID, threadID: expectedThreadID)
        guard pendingCommunicationConfirmations[key] == nil else {
            errorMessage = String(localized: "Há uma autorização com resultado incerto. Use Repetir autorização para manter o ID e o hash originais.")
            return nil
        }
        return CommunicationConfirmationSnapshot(action: action,
            input: CommunicationConfirmationInput(actionId: action.id, requestHash: action.requestHash,
                clientRequestId: UUID().uuidString.lowercased(), text: text),
            hostAddress: hostAddress, hostScope: nativeComposerScope, hostID: hostID,
            botID: action.request.botId, threadID: expectedThreadID, presentationGeneration: threadPresentationGeneration)
    }

    /// Explicit retry rebinds navigation only. The approved proposal, reply, hash and request ID remain exact.
    public func capturePendingCommunicationConfirmation(expectedThreadID: String) -> CommunicationConfirmationSnapshot? {
        guard let pending = pendingCommunicationConfirmationForActiveThread,
              pending.action.request.threadId == expectedThreadID, presentedThreadID == expectedThreadID,
              canEditBotProfiles, isOnline, !isSubmitting, pendingSubmission == nil else {
            errorMessage = String(localized: "Atualize a conversa deste host antes de repetir a autorização.")
            return nil
        }
        return CommunicationConfirmationSnapshot(action: pending.action, input: pending.input,
            hostAddress: pending.hostAddress, hostScope: nativeComposerScope, hostID: pending.hostID,
            botID: pending.action.request.botId, threadID: expectedThreadID, presentationGeneration: threadPresentationGeneration)
    }

    private func communicationConfirmationKey(hostID: String, threadID: String) -> String { "\(hostID)|\(threadID)" }

    private func isCurrentCommunicationConfirmation(_ snapshot: CommunicationConfirmationSnapshot) -> Bool {
        snapshot.hostAddress == currentPersistenceHostKey() && snapshot.hostScope == nativeComposerScope
            && snapshot.hostID == nativeProjectionHostID && snapshot.botID == selectedBotID
            && snapshot.threadID == selectedThreadID && snapshot.threadID == presentedThreadID
            && snapshot.presentationGeneration == threadPresentationGeneration
    }

    @discardableResult
    private func confirmCommunication(_ snapshot: CommunicationConfirmationSnapshot) async -> Bool {
        guard isCurrentCommunicationConfirmation(snapshot), canEditBotProfiles, isOnline, let client,
              !isSubmitting, !isUpdatingEngineSelection, pendingSubmission == nil else {
            errorMessage = String(localized: "A conversa ou o host mudou. Revise a proposta atual; seu texto foi mantido.")
            return false
        }
        let key = communicationConfirmationKey(hostID: snapshot.hostID, threadID: snapshot.threadID)
        if let pending = pendingCommunicationConfirmations[key] {
            guard pending.action == snapshot.action, pending.input == snapshot.input else {
                errorMessage = String(localized: "Repita a autorização original para preservar o ID e o hash.")
                return false
            }
        } else {
            guard actions.first(where: { $0.id == snapshot.action.id }) == snapshot.action,
                  actions(for: snapshot.threadID).filter({ $0.state == .awaitingApproval }).count == 1,
                  ApprovalPresentation(action: snapshot.action).canDecide(hostAvailable: canUseHost,
                      atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000)) else {
                errorMessage = String(localized: "A proposta mudou. Atualize e escolha o cartão correto; seu texto foi mantido.")
                return false
            }
            pendingCommunicationConfirmations[key] = PendingCommunicationConfirmation(action: snapshot.action,
                input: snapshot.input, hostAddress: snapshot.hostAddress, hostID: snapshot.hostID, isUncertain: false)
        }
        let scope = currentThreadScope(snapshot.threadID)
        previewSubmission(TurnSubmission(content: snapshot.input.text, clientRequestId: snapshot.input.clientRequestId),
            content: snapshot.input.text, scope: scope)
        beginSubmission(snapshot.input.clientRequestId)
        communicationConfirmationNotice = nil; errorMessage = nil
        defer { endSubmission(snapshot.input.clientRequestId) }
        do {
            let response = try await client.confirmCommunication(action: snapshot.action, input: snapshot.input)
            // A response to an old host or conversation never modifies the new presentation.
            guard isCurrent(scope), isCurrentCommunicationConfirmation(snapshot) else { return false }
            pendingCommunicationConfirmations.removeValue(forKey: key)
            mergeCommunicationResponse(response)
            let inputMessageID = response.messages.first(where: { $0.role == .user && $0.content == snapshot.input.text })?.id
            updateOutgoingPreview(snapshot.input.clientRequestId, scope: scope, state: .accepted, inputMessageID: inputMessageID)
            communicationConfirmationNotice = response.receipt.applied
                ? String(localized: "Comunicação atualizada. As novas permissões valem no próximo turno.")
                : String(localized: "Alteração negada. As permissões do bot foram mantidas.")
            await refreshCommunicationProjection(botID: snapshot.botID, scope: scope, client: client)
            return true
        } catch {
            let mayHaveCommitted = mayHaveAcceptedSubmission(error) || error is CancellationError
            if mayHaveCommitted { pendingCommunicationConfirmations[key]?.isUncertain = true }
            let wasUncertain = pendingCommunicationConfirmations[key]?.isUncertain == true
            if !wasUncertain { pendingCommunicationConfirmations.removeValue(forKey: key) }
            guard isCurrent(scope), isCurrentCommunicationConfirmation(snapshot) else { return false }
            updateOutgoingPreview(snapshot.input.clientRequestId, scope: scope, state: wasUncertain ? .uncertain : .failed)
            communicationConfirmationNotice = wasUncertain
                ? String(localized: "O host pode ter aplicado a autorização. Atualize a conversa ou use Repetir autorização; o ID, o texto e o hash serão preservados.")
                : String(localized: "A autorização não foi aplicada. Atualize a conversa e revise a proposta.")
            errorMessage = safeMessage(for: error)
            return false
        }
    }

    private func mergeCommunicationResponse(_ response: CommunicationConfirmationResponse) {
        if let index = actions.firstIndex(where: { $0.id == response.action.id }) { actions[index] = response.action }
        else { actions.append(response.action) }
        if let index = bots.firstIndex(where: { $0.id == response.bot.id }), bots[index].revision <= response.bot.revision {
            bots[index] = response.bot; botProfileGeneration &+= 1
        }
        var merged = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for message in response.messages { merged[message.id] = message }
        messages = merged.values.sorted { $0.cursor < $1.cursor }
        reconcileOutgoingPreview()
    }

    /// Reads only canonical messages/actions/profile. It does not restart or replace the current turn.
    private func refreshCommunicationProjection(botID: String, scope: ThreadScope, client: HostClient) async {
        do {
            async let fetchedMessages = client.allMessages(threadID: scope.threadID)
            async let fetchedBot = client.getBot(id: botID)
            async let fetchedActions = client.listActions()
            let (canonicalMessages, bot, canonicalActions) = try await (fetchedMessages, fetchedBot, fetchedActions)
            guard isCurrent(scope), bot.id == botID, selectedBotID == botID else { return }
            messages = canonicalMessages; actions = canonicalActions
            if let index = bots.firstIndex(where: { $0.id == bot.id }), bots[index].revision <= bot.revision {
                bots[index] = bot; botProfileGeneration &+= 1
            }
            reconcileOutgoingPreview()
        } catch {
            guard isCurrent(scope) else { return }
            communicationConfirmationNotice = String(localized: "A decisão já foi confirmada, mas a atualização da conversa falhou. Use Atualizar conversa para reler o estado do host.")
        }
    }

    /// Returns true only after the host accepted the request. Failed requests leave the draft editable.
    @discardableResult
    public func submit(_ content: String, attachments inputAttachments: [ChatComposerImage] = [], expectedThreadID: String? = nil,
                       communicationConfirmation: CommunicationConfirmationSnapshot? = nil) async -> Bool {
        if let expectedThreadID, !validateVisibleThread(expectedThreadID) { return false }
        if let communicationConfirmation {
            guard inputAttachments.isEmpty, content == communicationConfirmation.input.text,
                  expectedThreadID == communicationConfirmation.threadID else {
                errorMessage = String(localized: "Esta autorização precisa do texto exato, sem anexos, na conversa da proposta.")
                return false
            }
            return await confirmCommunication(communicationConfirmation)
        }
        guard canUseHost, let client, let threadID = selectedThreadID else {
            errorMessage = DexterLocalization.text("Send messages through the connected local host.")
            return false
        }
        guard !isSubmitting, !isUpdatingEngineSelection, !engineSelectionRequiresReload else { return false }
        guard inputAttachments.count <= 4, Set(inputAttachments.map(\.id)).count == inputAttachments.count else {
            errorMessage = String(localized: "Cole até quatro imagens por mensagem."); return false
        }
        guard inputAttachments.isEmpty || canAttachChatImages else {
            errorMessage = String(localized: "Anexos de imagem estão disponíveis no host local deste Mac. O envio ao host pareado ainda não aceita imagens."); return false
        }
        let entered = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard entered.utf8.count <= 64 * 1_024 else { errorMessage = String(localized: "A mensagem excede o limite de 64 KiB."); return false }
        let trimmed = entered.isEmpty && !inputAttachments.isEmpty ? "Analise as imagens anexadas." : entered
        guard !trimmed.isEmpty else { return false }
        let submittingBotID = selectedBotID
        let scope = currentThreadScope(threadID)
        let digest = DexterAppStateValidation.contentDigest(trimmed, imageDigests: inputAttachments.map(\.sha256))
        var attachments = inputAttachments
        let submission: TurnSubmission
        if let pending = pendingSubmission, pending.threadID == threadID {
            guard pending.contentDigest == digest, pending.attachmentIDs.count == attachments.count else {
                errorMessage = String(localized: "O envio anterior ainda não foi confirmado. Reescreva o mesmo texto e cole as mesmas imagens, na mesma ordem, para repetir o ID original.")
                return false
            }
            do { attachments = try zip(attachments, pending.attachmentIDs).map { try $0.0.usingID($0.1) } }
            catch { errorMessage = String(localized: "Os anexos do envio anterior não puderam ser recuperados."); return false }
            submission = TurnSubmission(content: trimmed, clientRequestId: pending.clientRequestID, attachmentIds: attachments.map(\.id))
            pendingSubmission = PendingTurnSubmission(
                threadID: threadID,
                clientRequestID: pending.clientRequestID,
                contentDigest: pending.contentDigest,
                content: trimmed,
                isRecovered: pending.isRecovered,
                attachmentIDs: attachments.map(\.id),
                attachments: attachments
            )
        } else {
            submission = TurnSubmission(content: trimmed, attachmentIds: attachments.map(\.id))
            pendingSubmission = PendingTurnSubmission(threadID: threadID, submission: submission, attachments: attachments)
        }

        // Publish synchronously before persistence or the first network suspension.
        previewSubmission(submission, content: entered.isEmpty ? trimmed : content, attachments: attachments, scope: scope)
        guard let hostAddress = scope.hostAddress,
              let requestMetadata = pendingSubmission,
              persistPendingSubmission(requestMetadata, hostAddress: hostAddress) else {
            pendingSubmission = nil
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: .failed)
            errorMessage = DexterLocalization.text("The local submission ID could not be saved. The message was not sent.")
            return false
        }

        beginSubmission(submission.clientRequestId)
        defer { endSubmission(submission.clientRequestId) }
        do {
            try await uploadPendingImages(requestMetadata, client: client)
            guard isCurrentHost(scope.hostGeneration) else { throw CancellationError() }
            let turn = try await client.startTurn(threadID: threadID, submission: submission)
            guard isCurrentHost(scope.hostGeneration) else { return false }
            guard turn.threadId == threadID,
                  turn.botId == submittingBotID else { throw HostClientError.contractMismatch }
            guard turn.clientRequestId == submission.clientRequestId else { throw HostClientError.contractMismatch }
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: .accepted, inputMessageID: turn.inputMessageId)
            clearPendingSubmission(ifMatching: requestMetadata, hostAddress: hostAddress)
            isOnline = true
            guard isCurrent(scope) else { return true }
            resumeObservationForAcceptedSubmission(turn, scope: scope)
            currentTurn = turn
            streamingText = ""
            beginPolling(turn, scope: scope, client: client)
            return true
        } catch is CancellationError {
            // The POST may have committed before the task was cancelled: never treat as a refusal.
            uncertainRequestIDs.insert(requestMetadata.clientRequestID)
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: .uncertain)
            return false
        } catch {
            if error as? HostClientError == .mutationOutcomeUnknown { uncertainRequestIDs.insert(submission.clientRequestId) }
            guard isCurrentHost(scope.hostGeneration) else { return false }
            let refused = canClearAfterFailure(error, pending: requestMetadata)
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: refused ? .failed : .uncertain)
            if refused { clearPendingSubmission(ifMatching: requestMetadata, hostAddress: hostAddress) }
            errorMessage = safeMessage(for: error)
            return false
        }
    }

    @discardableResult
    public func retryPendingSubmission(expectedThreadID: String? = nil) async -> Bool {
        if let expectedThreadID, !validateVisibleThread(expectedThreadID) { return false }
        guard let pending = pendingSubmission, let submission = pending.submission,
              canUseHost, let client,
              selectedThreadID == pending.threadID, !isSubmitting, !isUpdatingEngineSelection, !engineSelectionRequiresReload else { return false }
        let submittingBotID = selectedBotID
        let scope = currentThreadScope(pending.threadID)
        guard pending.attachmentIDs.count == pending.attachments.count else {
            errorMessage = String(localized: "Cole novamente as imagens originais para repetir este envio."); return false
        }
        previewSubmission(submission, content: submission.content, attachments: pending.attachments, scope: scope)
        beginSubmission(submission.clientRequestId)
        defer { endSubmission(submission.clientRequestId) }

        do {
            try await uploadPendingImages(pending, client: client)
            guard isCurrentHost(scope.hostGeneration) else { throw CancellationError() }
            let turn = try await client.startTurn(threadID: pending.threadID, submission: submission)
            guard isCurrentHost(scope.hostGeneration) else { return false }
            guard turn.threadId == pending.threadID,
                  turn.botId == submittingBotID else { throw HostClientError.contractMismatch }
            guard turn.clientRequestId == submission.clientRequestId else { throw HostClientError.contractMismatch }
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: .accepted, inputMessageID: turn.inputMessageId)
            clearPendingSubmission(ifMatching: pending, hostAddress: scope.hostAddress)
            isOnline = true
            guard isCurrent(scope) else { return true }
            if nativeActionDraft?.threadID == pending.threadID { clearNativeActionDraft() }
            resumeObservationForAcceptedSubmission(turn, scope: scope)
            currentTurn = turn
            streamingText = ""
            beginPolling(turn, scope: scope, client: client)
            return true
        } catch is CancellationError {
            // The POST may have committed before the task was cancelled: never treat as a refusal.
            uncertainRequestIDs.insert(pending.clientRequestID)
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: .uncertain)
            return false
        } catch {
            if error as? HostClientError == .mutationOutcomeUnknown { uncertainRequestIDs.insert(submission.clientRequestId) }
            guard isCurrentHost(scope.hostGeneration) else { return false }
            let refused = canClearAfterFailure(error, pending: pending)
            updateOutgoingPreview(submission.clientRequestId, scope: scope, state: refused ? .failed : .uncertain)
            if refused { clearPendingSubmission(ifMatching: pending, hostAddress: scope.hostAddress) }
            errorMessage = safeMessage(for: error)
            return false
        }
    }

    private func uploadPendingImages(_ pending: PendingTurnSubmission, client: HostClient) async throws {
        guard pending.attachmentIDs.count == pending.attachments.count else { throw HostClientError.invalidRequest }
        for attachment in pending.attachments {
            _ = try await client.uploadChatImage(threadID: pending.threadID, clientAttachmentID: attachment.id, data: attachment.pngData)
        }
    }

    /// A replay of the stopped turn never restores reads. Only a newly accepted identity in this
    /// exact host/presentation does; old control ACKs and proposal snapshots remain quarantined.
    private func resumeObservationForAcceptedSubmission(_ turn: Turn, scope: ThreadScope) {
        guard isCurrent(scope), stoppedObservationScope == scope || turnControlInFlight,
              !stoppedTurnIDs.contains(turn.id), !stoppedRequestIDs.contains(turn.clientRequestId) else { return }
        threadReadSequence &+= 1
        turnControlToken = nil; turnControlInFlight = false; turnControlNotice = nil
        stoppedObservationScope = nil; queuedReceiptResponseTurnIDs = []
    }

    public func cancelCurrentTurn(in threadID: String) async {
        guard let identity = turnControlIdentity(in: threadID) else { return }
        await cancelTurn(identity)
    }

    public func cancelTurn(_ identity: TurnControlIdentity) async {
        guard acceptsTurnControl(identity), !turnControlInFlight, !conversationObservationWasStopped, let client,
              let snapshotTurn = currentTurn else { return }
        let scope = currentThreadScope(identity.threadID), token = UUID()
        let snapshots = Array(actions(for: identity.threadID).filter {
            $0.request.botId == identity.botID && [.awaitingApproval, .ready, .running].contains($0.state)
        }.suffix(32))
        suspendObservationForControl(scope: scope, turn: snapshotTurn, actions: snapshots, token: token)
        defer { finishTurnControl(token) }
        guard isOnline else {
            turnControlNotice = String(localized: "Observação interrompida neste app. O host está offline; o cancelamento não foi confirmado. Atualize a conversa após reconectar.")
            return
        }
        do {
            try await validateControlHost(scope: scope, token: token, client: client)
            guard controlIsCurrent(scope, token: token), acceptsTurnControl(identity) else { return }
            let acknowledgment = try await client.cancelTurn(id: identity.turnID)
            guard controlIsCurrent(scope, token: token), currentTurn?.id == identity.turnID else { return }
            guard acknowledgment.threadId == identity.threadID, acknowledgment.botId == identity.botID else {
                throw HostClientError.mutationOutcomeUnknown
            }
            currentTurn = acknowledgment
            await reconcileCancellation(turn: acknowledgment, snapshots: snapshots, scope: scope, token: token,
                client: client, stoppingEffects: false)
        } catch is CancellationError {
            return
        } catch {
            guard controlIsCurrent(scope, token: token) else { return }
            turnControlNotice = String(localized: "Observação interrompida neste app. O cancelamento não foi confirmado pelo host. Atualize a conversa para conferir; a solicitação não foi repetida.")
        }
    }

    /// Human-only. The existing origin cancellation stops ALL sibling actions, including effects
    /// admitted after a terminal origin/RPC. A terminal turn ACK is never proof of effect completion.
    public func cancelEffects(_ identity: EffectControlIdentity) async {
        guard [.ready, .running].contains(identity.action.state), acceptsEffectControl(identity),
              !turnControlInFlight, let client else { return }
        let scope = currentThreadScope(identity.action.request.threadId), token = UUID()
        turnControlToken = token; turnControlInFlight = true
        defer { finishTurnControl(token) }
        turnControlNotice = String(localized: "Consultando a origem das ações deste pedido…")
        do {
            try await validateControlHost(scope: scope, token: token, client: client)
            guard controlIsCurrent(scope, token: token), acceptsEffectControl(identity) else { return }
            let action = try await client.getAction(id: identity.action.id)
            guard controlIsCurrent(scope, token: token), acceptsEffectControl(identity) else { return }
            guard sameActionIdentity(action, identity.action) else { throw HostClientError.contractMismatch }
            guard [.ready, .running].contains(action.state) else {
                updateCanonicalAction(action)
                turnControlNotice = String(localized: "Esta ação já terminou no host. Confira seu recibo; nenhum cancelamento foi enviado.")
                return
            }
            guard let progress = try await client.actionContinuation(actionID: action.id), progress.originValid else {
                guard controlIsCurrent(scope, token: token) else { return }
                turnControlNotice = String(localized: "O host não confirmou a origem deste pedido. A parada não foi enviada; atualize a conversa para conferir.")
                return
            }
            guard controlIsCurrent(scope, token: token), acceptsEffectControl(identity) else { return }
            let origin = try await client.getTurn(id: progress.originTurnId)
            guard controlIsCurrent(scope, token: token), acceptsEffectControl(identity) else { return }
            guard origin.id == progress.originTurnId, origin.threadId == action.request.threadId,
                  origin.botId == action.request.botId else { throw HostClientError.contractMismatch }
            var siblings = [action]
            for snapshot in actions(for: origin.threadId).filter({
                $0.id != action.id && $0.request.botId == origin.botId && [.awaitingApproval, .ready, .running].contains($0.state)
            }).suffix(31) {
                let siblingProgress = try await client.actionContinuation(actionID: snapshot.id)
                guard controlIsCurrent(scope, token: token), acceptsEffectControl(identity) else { return }
                if siblingProgress?.originValid == true, siblingProgress?.originTurnId == origin.id { siblings.append(snapshot) }
            }
            let detachesCurrentTurn = currentTurn?.id == origin.id
                || (progress.responseTurnId != nil && currentTurn?.id == progress.responseTurnId)
            suspendObservationForControl(scope: scope, turn: origin, actions: siblings, token: token,
                detachConversation: detachesCurrentTurn, representative: action)
            if let responseID = progress.responseTurnId { stoppedTurnIDs.insert(responseID) }
            let acknowledgment = try await client.cancelTurn(id: origin.id)
            guard controlIsCurrent(scope, token: token) else { return }
            guard acknowledgment.threadId == origin.threadId, acknowledgment.botId == origin.botId else {
                throw HostClientError.mutationOutcomeUnknown
            }
            await reconcileCancellation(turn: acknowledgment, snapshots: siblings, scope: scope, token: token,
                client: client, stoppingEffects: true)
        } catch is CancellationError {
            return
        } catch {
            guard controlIsCurrent(scope, token: token) else { return }
            turnControlNotice = String(localized: "A parada das ações deste pedido não foi confirmada. O efeito pode ser parcial. Atualize a conversa para conferir; a solicitação não foi repetida.")
        }
    }

    private func controlIsCurrent(_ scope: ThreadScope, token: UUID) -> Bool {
        !Task.isCancelled && isCurrent(scope) && turnControlToken == token
    }

    private func validateControlHost(scope: ThreadScope, token: UUID, client: HostClient) async throws {
        let health = try await client.health()
        guard controlIsCurrent(scope, token: token) else { throw CancellationError() }
        guard let expected = scope.projectionHostID, (health.installationId ?? health.hostId) == expected else {
            throw HostClientError.contractMismatch
        }
    }

    private func finishTurnControl(_ token: UUID) {
        if turnControlToken == token { turnControlInFlight = false; turnControlToken = nil }
    }

    private func suspendObservationForControl(scope: ThreadScope, turn: Turn, actions snapshots: [Action], token: UUID,
                                              detachConversation: Bool = true, representative: Action? = nil) {
        mcpAuthorizationHandoffs.invalidate()
        macSetupHandoffs.invalidate()
        turnControlToken = token; turnControlInFlight = true
        if detachConversation {
            stopPolling(); threadReadSequence &+= 1
            stoppedObservationScope = scope
        }
        stoppedTurnIDs.insert(turn.id); stoppedRequestIDs.insert(turn.clientRequestId)
        stoppedActionIDs.formUnion(snapshots.map(\.id))
        lastStopContext = TurnControlStopContext(origin: turn, actions: snapshots, representative: representative, requestedAt: nativeActionNow())
        turnControlNotice = detachConversation
            ? String(localized: "Observação interrompida neste app. Solicitando o cancelamento ao host…")
            : String(localized: "Solicitando a parada das ações deste pedido; a conversa atual continua sendo acompanhada…")
    }

    private func sameActionIdentity(_ action: Action, _ snapshot: Action) -> Bool {
        action.id == snapshot.id && action.request == snapshot.request && action.requestHash == snapshot.requestHash
            && action.grantRevision == snapshot.grantRevision
    }

    private func updateCanonicalAction(_ action: Action) {
        if let index = actions.firstIndex(where: { $0.id == action.id }), actions[index].updatedAt <= action.updatedAt {
            actions[index] = action
        }
    }

    /// Finite GET-only confirmation, detached from the old stream. No cancel/approval/send retry.
    private func reconcileCancellation(turn acknowledgment: Turn, snapshots: [Action], scope: ThreadScope, token: UUID,
                                       client: HostClient, stoppingEffects: Bool) async {
        var canonicalTurn = acknowledgment
        var unresolvedEffects = true
        var unknownEffects = false
        do {
            for attempt in 0..<max(1, cancelReconciliationAttempts) {
                try await validateControlHost(scope: scope, token: token, client: client)
                canonicalTurn = try await client.getTurn(id: acknowledgment.id)
                guard controlIsCurrent(scope, token: token) else { return }
                guard canonicalTurn.id == acknowledgment.id, canonicalTurn.threadId == scope.threadID,
                      canonicalTurn.botId == acknowledgment.botId else { throw HostClientError.contractMismatch }
                if currentTurn?.id == canonicalTurn.id { currentTurn = canonicalTurn }
                unresolvedEffects = false; unknownEffects = false
                for snapshot in snapshots {
                    let action = try await client.getAction(id: snapshot.id)
                    guard controlIsCurrent(scope, token: token) else { return }
                    guard sameActionIdentity(action, snapshot) else { throw HostClientError.contractMismatch }
                    updateCanonicalAction(action)
                    unresolvedEffects = unresolvedEffects || [.awaitingApproval, .ready, .running].contains(action.state)
                    unknownEffects = unknownEffects || action.state == .unknown
                }
                if canonicalTurn.state.isTerminal && (!stoppingEffects || !unresolvedEffects) { break }
                if attempt + 1 < cancelReconciliationAttempts { try await Task.sleep(for: cancelReconciliationInterval) }
            }
            guard controlIsCurrent(scope, token: token) else { return }
            if stoppingEffects {
                turnControlNotice = unresolvedEffects || unknownEffects
                    ? String(localized: "Parada solicitada para todas as ações deste pedido. O resultado ainda não foi confirmado e o efeito pode ser parcial. Atualize a conversa para conferir; não houve nova tentativa.")
                    : String(localized: "O host registrou a parada das ações deste pedido. Confira os recibos; efeitos já realizados não foram desfeitos.")
            } else {
                turnControlNotice = canonicalTurn.state == .interrupted
                    ? String(localized: "O host confirmou a interrupção. Isso não desfaz efeitos já realizados.")
                    : String(localized: "Cancelamento solicitado ao host; a interrupção ainda não foi confirmada. Use Atualizar conversa para conferir; não houve nova tentativa.")
            }
        } catch {
            guard controlIsCurrent(scope, token: token) else { return }
            turnControlNotice = String(localized: "O cancelamento foi solicitado, mas a leitura do resultado não foi concluída. O efeito pode ser parcial. Atualize a conversa para conferir; a solicitação não foi repetida.")
        }
    }

    /// The existing endpoint releases ALL held queued turns in this conversation, not one turn.
    /// GET turns has no held flag: a queued snapshot is never represented as confirmed held work.
    public func resumeQueuedTurns(_ identity: TurnControlIdentity) async {
        guard acceptsTurnControl(identity), currentTurn?.state == .queued, !turnControlInFlight,
              !conversationObservationWasStopped, isOnline, let client else { return }
        let scope = currentThreadScope(identity.threadID), token = UUID()
        turnControlToken = token; turnControlInFlight = true
        defer { if turnControlToken == token { turnControlInFlight = false; turnControlToken = nil } }
        stopPolling()
        threadReadSequence &+= 1
        do {
            let health = try await client.health()
            guard !Task.isCancelled, isCurrent(scope), acceptsTurnControl(identity) else { return }
            if let expected = scope.projectionHostID {
                guard (health.installationId ?? health.hostId) == expected else { throw HostClientError.contractMismatch }
            }
            // Read immediately before the mutation, and never resume an old card/thread/base.
            let selected = try await client.getTurn(id: identity.turnID)
            guard !Task.isCancelled, isCurrent(scope), acceptsTurnControl(identity) else { return }
            guard selected.id == identity.turnID, selected.state == .queued, selected.threadId == identity.threadID, selected.botId == identity.botID else {
                throw HostClientError.conflict
            }
            let acknowledgment = try await client.resumeQueued(threadID: identity.threadID)
            guard !Task.isCancelled, isCurrent(scope), acceptsTurnControl(identity) else { return }
            await loadThread(identity.threadID, scope: scope, client: client)
            guard isCurrent(scope) else { return }
            turnControlNotice = acknowledgment.resumed > 0
                ? String(localized: "Retomada aceita pelo host. Nenhuma mensagem foi reenviada. Acompanhe o resultado nesta conversa.")
                : String(localized: "O host não liberou nenhum turno retido. A fila foi relida; nenhuma mensagem foi reenviada.")
        } catch {
            guard isCurrent(scope) else { return }
            stoppedObservationScope = scope
            turnControlNotice = String(localized: "A retomada não foi confirmada. Use Atualizar conversa para reler a fila antes de decidir; não houve reenvio automático.")
        }
    }

    #if os(macOS)
    /// Recovery only queries the exact receipt; a proved missing receipt permits an explicit exact replay.
    public func recoverApprovalPreferenceDecision(_ action: Action, retryExact: Bool = false) async {
        guard canEditBotProfiles, let client, let hostID = approvalPolicyHostID,
              let bot = bots.first(where: { $0.id == action.request.botId }) else { return }
        let key = "\(hostAddress)\u{1F}\(hostID)\u{1F}\(bot.ownerId)\u{1F}\(action.id)"
        guard let input = pendingApprovalPreferenceDecisions[key], input.expectedHostId == hostID else { await refreshActions(); return }
        let host = hostGeneration
        do {
            if retryExact {
                guard approvalPreferenceDecisionNotices[action.id] == "receipt_missing" else { return }
                _ = try await client.decideApprovalPreference(action: action, ownerID: bot.ownerId, input: input)
            } else {
                _ = try await client.approvalPreferenceReceipt(botID: bot.id, ownerID: bot.ownerId, kind: "decision", targetID: action.id,
                                                              clientRequestID: input.clientRequestId, input: input)
            }
            guard isCurrentHost(host), !Task.isCancelled else { return }
            pendingApprovalPreferenceDecisions.removeValue(forKey: key)
            approvalPreferenceDecisionNotices[action.id] = input.decision == .deny ? "denied" : input.alwaysAccept ? "type_saved" : "allowed"
        } catch {
            guard isCurrentHost(host), !Task.isCancelled else { return }
            approvalPreferenceDecisionNotices[action.id] = error as? HostClientError == .notFound ? "receipt_missing" : "unknown"
        }
        await refreshActions()
    }
    #endif

    public func decide(_ action: Action, as decision: ApprovalDecision, alwaysAccept: Bool = false) async {
        guard !actionDecisionIsSuspended(action) else { return }
        guard canUseHost, let client else {
            errorMessage = DexterLocalization.text("The decision requires an active connection to the host.")
            return
        }
        let currentHostGeneration = hostGeneration
        let decisionScope = presentedThreadID == action.request.threadId ? currentThreadScope(action.request.threadId) : nil
        let communicationScope = BotCommunicationProposal(action: action) != nil && selectedThreadID == action.request.threadId
            ? currentThreadScope(action.request.threadId) : nil
        #if os(macOS)
        // Only a fresh explicit Allow click may arm browser presentation. Reconciliation/receipt reads never do.
        let mcpKey = canEditBotProfiles && approvalPolicyHostID != nil
            ? "\(hostAddress)\u{1F}\(approvalPolicyHostID!)\u{1F}\(bots.first(where: { $0.id == action.request.botId })?.ownerId ?? "")\u{1F}\(action.id)" : nil
        if decision == .allow, !alwaysAccept, mcpKey.map({ pendingApprovalPreferenceDecisions[$0] == nil }) == true {
            mcpAuthorizationHandoffs.arm(action, context: mcpAuthorizationContext, foreground: NSApplication.shared.isActive)
            macSetupHandoffs.arm(action, context: mcpAuthorizationContext, foreground: NSApplication.shared.isActive)
        } else if decision == .deny {
            mcpAuthorizationHandoffs.abandon(actionID: action.id, hostID: approvalPolicyHostID)
            macSetupHandoffs.abandon(actionID: action.id, hostID: approvalPolicyHostID)
        }
        #endif
        do {
            let updated: Action
            #if os(macOS)
            if canEditBotProfiles, let hostID = approvalPolicyHostID, let bot = bots.first(where: { $0.id == action.request.botId }) {
                let key = "\(hostAddress)\u{1F}\(hostID)\u{1F}\(bot.ownerId)\u{1F}\(action.id)"
                if let pending = pendingApprovalPreferenceDecisions[key] {
                    // A second gesture only queries the original receipt. Never resend an uncertain POST.
                    _ = try await client.approvalPreferenceReceipt(botID: bot.id, ownerID: bot.ownerId, kind: "decision", targetID: action.id,
                                                                  clientRequestID: pending.clientRequestId, input: pending)
                    updated = try await client.getAction(id: action.id)
                    pendingApprovalPreferenceDecisions.removeValue(forKey: key)
                } else {
                    let input = DecideApprovalPreferenceInput(hostID: hostID, clientRequestID: UUID().uuidString.lowercased(), action: action,
                                                              decision: decision, alwaysAccept: alwaysAccept)
                    pendingApprovalPreferenceDecisions[key] = input
                    do {
                        let result = try await client.decideApprovalPreference(action: action, ownerID: bot.ownerId, input: input)
                        updated = result.action; pendingApprovalPreferenceDecisions.removeValue(forKey: key)
                    } catch {
                        if [.conflict, .forbidden, .invalidRequest, .approvalExpired].contains(error as? HostClientError ?? .hostFailure) {
                            pendingApprovalPreferenceDecisions.removeValue(forKey: key)
                        }
                        approvalPreferenceDecisionNotices[action.id] = "unknown"; throw error
                    }
                }
                approvalPreferenceDecisionNotices[action.id] = decision == .deny ? "denied" : alwaysAccept ? "type_saved" : "allowed"
            } else {
                guard !alwaysAccept else { throw HostClientError.forbidden }
                updated = try await client.decide(action: action, decision: decision)
            }
            #else
            guard !alwaysAccept else { throw HostClientError.forbidden }
            updated = try await client.decide(action: action, decision: decision)
            #endif
            guard !Task.isCancelled, isCurrentHost(currentHostGeneration) else { return }
            if let decisionScope, !isCurrent(decisionScope) { return }
            if let communicationScope, !isCurrent(communicationScope) { return }
            if let index = actions.firstIndex(where: { $0.id == updated.id }) { actions[index] = updated }
            observeMcpAuthorizationResult(updated)
            if let decisionScope { beginContinuationObservation(scope: decisionScope, client: client) }
            if let communicationScope {
                communicationConfirmationNotice = updated.state == .succeeded
                    ? String(localized: "Comunicação atualizada. As novas permissões valem no próximo turno.")
                    : String(localized: "Alteração negada. As permissões do bot foram mantidas.")
                await refreshCommunicationProjection(botID: action.request.botId, scope: communicationScope, client: client)
            } else { await refreshActions() }
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentHost(currentHostGeneration) else { return }
            if let decisionScope, !isCurrent(decisionScope) { return }
            if let error = error as? HostClientError, [.conflict, .forbidden, .invalidRequest, .approvalExpired].contains(error) {
                mcpAuthorizationHandoffs.abandon(actionID: action.id, hostID: approvalPolicyHostID)
                macSetupHandoffs.abandon(actionID: action.id, hostID: approvalPolicyHostID)
            }
            errorMessage = safeMessage(for: error)
            // An ambiguous decision is reconciled by GET only; the observer never retries its POST.
            if let decisionScope { beginContinuationObservation(scope: decisionScope, client: client) }
            await refreshActions()
        }
    }

    public func connectPairedHost() async {
        guard !hasCorruptStoredData, !pairedConnectBusy else { return }
        pairedConnectBusy = true; defer { pairedConnectBusy = false }
        invalidateHostWork(); client = nil; isOnline = false; let token = hostGeneration
        await pairing.restoreOrCheckApproval()
        guard hostGeneration == token, let approved = pairing.binding, let next = pairing.activeClient else {
            if hostGeneration == token { errorMessage = pairing.state == .pendingApproval ? nil : pairing.state.label }
            return
        }
        client = next; pairedBinding = approved; pairedConnectionGeneration = pairing.generation
        hostAddress = approved.host.url.absoluteString; isFixture = false; remotePairingPending = false; isOnline = true
        bots = []; actions = []; threadsByBot = [:]; threadSummaries = [:]; selectedBotID = nil; selectedThreadID = nil; clearThreadProjection(); errorMessage = nil
        await refresh()
    }
    /// A launch restores only the already selected identity and claim. It never imports an offer or provisions a key.
    public func restorePairedHostAtLaunch() async {
        guard !attemptedPairedLaunchRestore else { return }
        attemptedPairedLaunchRestore = true
        guard pairing.publicReference != nil, !isFixture else { return }
        await connectPairedHost()
    }
    public func importPairingBundle(_ data: Data) {
        invalidateHostWork(); client = nil
        isOnline = false; isFixture = false; remotePairingPending = true
        bots = []; actions = []; threadsByBot = [:]; threadSummaries = [:]; clearThreadProjection()
        do { try pairing.importBundle(data); errorMessage = nil } catch { errorMessage = pairing.state.label }
    }
    public func disconnectPairedHost() { invalidateHostWork(); client = nil; isOnline = false; isFixture = false; remotePairingPending = true; clearThreadProjection() }
    public func detachPairedHost() { disconnectPairedHost(); do { try pairing.detach() } catch { errorMessage = pairing.state.label } }
    public func revokeThisClient() async {
        guard canUseHost, let id = pairedBinding?.deviceID else { return }
        guard !awaitingDeviceConfirmationIDs.contains(id) else { deviceError = .deviceMutationOutcomeUnknown; return }
        guard operatingDeviceIDs.isEmpty else { return }
        let token = hostGeneration, operationToken = UUID()
        recordDeviceMutationRevision(for:id); deviceOperationTokens[id] = operationToken; operatingDeviceIDs.insert(id)
        nativeProjectionHostID = nil; nativeComposerScope = UUID(); clearNativeActionDraft()
        await pairing.revokeThisClient()
        guard token == hostGeneration, deviceOperationTokens[id] == operationToken else { return }
        operatingDeviceIDs.remove(id); deviceOperationTokens.removeValue(forKey:id)
        if pairing.state == .outcomeUnknown { markDeviceMutationUnknown(id:id,expectation:.revoke) }
        if pairing.state != .paired {
            client?.close(); client = nil; pairedBinding = nil; pairedConnectionGeneration = nil
            hostGeneration &+= 1; invalidateThreadSelection(); isOnline = false; clearReadinessFacts(); invalidateGrantWork()
            if pairing.state == .revoked { devices = [] }
        }; errorMessage = pairing.state.label
    }
    private func currentPersistenceHostKey() -> String? {
        if let binding = pairedBinding { return "paired:\(binding.installationID)|\(binding.deviceID)" }
        return DexterAppStateValidation.validatedLoopbackAddress(hostAddress)
    }

    public func configureHost() {
        guard !hasCorruptStoredData else {
            errorMessage = DexterLocalization.text("The local configuration is unreadable. Confirm the reset in Settings before connecting.")
            return
        }

        let enteredAddress = hostAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedAddress = DexterAppStateValidation.validatedLoopbackAddress(enteredAddress),
           let url = URL(string: normalizedAddress) {
            let previousAddress = hostAddress
            let previousMode = persistedMode
            let previousLoopbackAddress = lastLoopbackAddress
            hostAddress = normalizedAddress
            persistedMode = .loopback
            lastLoopbackAddress = normalizedAddress
            guard persistCurrentState() else {
                hostAddress = previousAddress
                persistedMode = previousMode
                lastLoopbackAddress = previousLoopbackAddress
                errorMessage = DexterLocalization.text("The local configuration could not be saved. The host was not connected.")
                return
            }

            invalidateHostWork()
            #if os(macOS) || targetEnvironment(simulator)
            client = HostClient(baseURL: url, accessPolicy: .loopbackDevelopment)
            remotePairingPending = false
            #else
            client = nil
            remotePairingPending = true
            #endif
            isFixture = false
            isOnline = false
            bots = []
            threadsByBot = [:]
            actions = []
            clearThreadProjection()
            selectedBotID = nil
            selectedThreadID = nil
            errorMessage = nil
            return
        }

        guard isValidUnpairedAddress(enteredAddress),
              let url = URL(string: enteredAddress) else {
            errorMessage = DexterLocalization.text("Use a local loopback HTTP address without credentials, a path or parameters.")
            return
        }
        invalidateHostWork()
        client = HostClient(baseURL: url, accessPolicy: .unpairedHost)
        remotePairingPending = true
        isFixture = false
        isOnline = false
        bots = []
        threadsByBot = [:]
        actions = []
        clearThreadProjection()
        selectedBotID = nil
        selectedThreadID = nil
        errorMessage = DexterLocalization.text("Remote pairing is unavailable. This address was not saved or accessed.")
    }

    public func useFixture() {
        invalidateHostWork()
        client = nil
        isFixture = true
        remotePairingPending = false
        isOnline = false
        errorMessage = nil
        persistedMode = .fixture
        if !hasCorruptStoredData, !persistCurrentState() {
            persistenceNotice = DexterLocalization.text("Demo mode is active, but the preference could not be saved.")
        }
        installFixture()
    }

    /// Explicitly replaces an unreadable local snapshot with a clean fixture preference.
    /// The UI asks the user to confirm because unreadable bytes may contain an unrecoverable pending ID.
    @discardableResult
    public func resetCorruptStorage(usesDemo: Bool = true) -> Bool {
        guard hasCorruptStoredData else { return true }
        invalidateHostWork()
        stateStorage.removeData()
        hasCorruptStoredData = false
        pendingRequestRecords = []
        lastSelection = nil
        uncertainRequestIDs = []
        pendingSubmission = nil
        persistedMode = .fixture
        lastLoopbackAddress = nil
        hostAddress = ""
        persistenceNotice = nil
        isFixture = usesDemo
        remotePairingPending = !usesDemo
        client = nil
        isOnline = false
        if usesDemo { installFixture() }
        else {
            bots = []; actions = []; teams = []; threadsByBot = [:]; threadsByTeam = [:]; threadSummaries = [:]
            selectedBotID = nil; selectedTeamID = nil; selectedThreadID = nil; clearThreadProjection()
        }
        guard persistCurrentState() else {
            persistenceNotice = DexterLocalization.text("The damaged storage was removed, but the new preference could not be saved.")
            return false
        }
        return true
    }

    func stopPolling() {
        botActivityObservationAvailable = false
        pollTask?.cancel()
        pollTask = nil
        pollScope = nil
        pollToken = nil
        pollingTurnID = nil
    }

    private func beginPolling(_ turn: Turn, scope: ThreadScope, client: HostClient) {
        if pollTask != nil, pollScope == scope, pollingTurnID == turn.id { return }
        startConversationObservation(turn: turn, scope: scope, client: client)
    }

    private func beginContinuationObservation(scope: ThreadScope, client: HostClient) {
        guard stoppedObservationScope != scope, presentedThreadID == scope.threadID, !actions(for: scope.threadID).isEmpty else { return }
        if pollTask != nil, pollScope == scope { return }
        startConversationObservation(turn: nil, scope: scope, client: client)
    }

    /// One owner per presentation, shared by known-turn streaming and late receipt continuations.
    private func startConversationObservation(turn: Turn?, scope: ThreadScope, client: HostClient) {
        guard stoppedObservationScope != scope else { return }
        stopPolling()
        let token = UUID()
        let deadline = ContinuousClock.now.advanced(by: conversationObservationLifetime)
        pollScope = scope; pollToken = token; pollingTurnID = turn?.id
        pollTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.pollToken == token {
                    self.botActivityObservationAvailable = false
                    self.pollTask = nil; self.pollScope = nil; self.pollToken = nil; self.pollingTurnID = nil
                }
            }
            if let turn { await self.poll(turnID: turn.id, threadID: scope.threadID, scope: scope, client: client, deadline: deadline) }
            guard !Task.isCancelled, self.pollToken == token, self.isCurrent(scope) else { return }
            self.pollingTurnID = nil
            await self.observeContinuations(scope: scope, token: token, client: client, deadline: deadline)
        }
    }

    private func poll(turnID: String, threadID: String, scope: ThreadScope, client: HostClient,
                      deadline: ContinuousClock.Instant) async {
        let observationToken = pollToken
        defer {
            if pollToken == observationToken, pollScope == scope { botActivityObservationAvailable = false }
        }
        func current() -> Bool { !Task.isCancelled && isCurrent(scope) && ContinuousClock.now < deadline }
        let pageLimit = pairedBinding == nil ? 500 : 1
        var cursor: Int64 = 0
        var terminalTurn: Turn?
        var lastActionRefresh = Date.distantPast
        var observedActionIDs = Set<String>()
        var actionIDs = Set(actions(for: threadID).filter { $0.state == .awaitingApproval || $0.state == .ready || $0.state == .running }.map(\.id))
        // Confirm the accepted user message early, rather than waiting for the assistant's terminal event.
        if outgoingMessagePreviewForActiveThread?.state == .accepted,
           let nextMessages = try? await client.allMessages(threadID: threadID), current() {
            messages = nextMessages
            reconcileOutgoingPreview()
        }

        while current() {
            do {
                let terminalWasObservedBeforePage = terminalTurn != nil
                let requestedCursor = cursor
                let page = try await client.turnEvents(turnID: turnID, after: cursor, limit: pageLimit)
                guard current() else { return }
                guard page.items.allSatisfy({ $0.threadId == threadID && $0.turnId == turnID }) else { throw HostClientError.contractMismatch }
                if !page.items.isEmpty && page.nextCursor <= requestedCursor {
                    throw HostClientError.contractMismatch
                }
                cursor = max(cursor, page.nextCursor)
                for event in page.items where event.kind == .textDelta {
                    if let text = event.text { streamingText += text }
                }
                for event in page.items where event.kind == .toolRequested {
                    if case .object(let data) = event.data, case .string(let id) = data["actionId"], !id.isEmpty {
                        actionIDs.insert(id); observedActionIDs.insert(id)
                    }
                }

                let turn = try await client.getTurn(id: turnID)
                guard current() else { return }
                guard turn.id == turnID, turn.threadId == threadID else { throw HostClientError.contractMismatch }
                if presentedThreadID == threadID { guard turn.botId == selectedBotID else { throw HostClientError.contractMismatch } }
                currentTurn = turn
                botActivityObservationAvailable = true
                if turn.state.isTerminal { terminalTurn = turn; observeReadiness([turn], scope: scope) }

                if Date().timeIntervalSince(lastActionRefresh) > 1 {
                    if let expectedHostID = scope.projectionHostID {
                        let health = try await client.health()
                        guard current() else { return }
                        guard (health.installationId ?? health.hostId) == expectedHostID else { throw HostClientError.contractMismatch }
                    }
                    do {
                        if presentedThreadID == threadID, scope.projectionHostID != nil {
                            // Tool events discover exact IDs; subsequent refreshes stay inside this chat.
                            // Initial/manual loads keep their existing owner projection read.
                            for id in actionIDs.sorted() {
                                let action = try await client.getAction(id: id)
                                guard current() else { return }
                                guard action.request.threadId == threadID, action.request.botId == selectedBotID else { throw HostClientError.contractMismatch }
                                if let index = actions.firstIndex(where: { $0.id == id }) {
                                    if actions[index].updatedAt <= action.updatedAt { actions[index] = action }
                                } else { actions.append(action) }
                                observeMcpAuthorizationResult(action)
                                if action.state != .awaitingApproval && action.state != .ready && action.state != .running { actionIDs.remove(id) }
                            }
                        } else {
                            let nextActions = try await client.listActions()
                            guard current() else { return }
                            actions = nextActions
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        guard current() else { return }
                        errorMessage = safeMessage(for: error)
                    }
                    lastActionRefresh = Date()
                }

                if page.items.count == pageLimit {
                    continue
                }

                if let terminalTurn {
                    // The current page may have been read before the host committed its final event.
                    // After the first terminal observation, fetch a fresh event page before finalizing.
                    guard terminalWasObservedBeforePage else { continue }
                    // One finite final pass over IDs emitted by THIS turn. A failed GET never
                    // authorizes a retry, invents an outcome, or revives a stopped G2 origin.
                    if let expectedHostID = scope.projectionHostID, !observedActionIDs.isEmpty {
                        do {
                            let health = try await client.health()
                            guard current() else { return }
                            guard (health.installationId ?? health.hostId) == expectedHostID else { throw HostClientError.contractMismatch }
                            for id in observedActionIDs.sorted() where !stoppedActionIDs.contains(id) && !stoppedTurnIDs.contains(turnID) {
                                do {
                                    let action = try await client.getAction(id: id)
                                    guard current(), !stoppedActionIDs.contains(id), !stoppedTurnIDs.contains(turnID) else { return }
                                    guard action.id == id, action.request.threadId == threadID, action.request.botId == selectedBotID else { throw HostClientError.contractMismatch }
                                    if let old = actions.first(where: { $0.id == id }), !sameActionIdentity(action, old) { throw HostClientError.contractMismatch }
                                    if let index = actions.firstIndex(where: { $0.id == id }) {
                                        if actions[index].updatedAt <= action.updatedAt { actions[index] = action }
                                    } else { actions.append(action) }
                                } catch is CancellationError { return }
                                catch { guard current() else { return }; errorMessage = safeMessage(for: error) }
                            }
                        } catch is CancellationError { return }
                        catch { guard current() else { return }; errorMessage = safeMessage(for: error) }
                    }
                    let nextMessages = try await client.allMessages(threadID: threadID)
                    guard current() else { return }
                    messages = nextMessages
                    reconcileOutgoingPreview()
                    currentTurn = terminalTurn
                    if terminalTurn.state == .completed { streamingText = "" }
                    return
                }

                try await Task.sleep(for: .milliseconds(400))
            } catch is CancellationError {
                return
            } catch {
                guard current() else { return }
                errorMessage = safeMessage(for: error)
                return
            }
        }
    }

    /// Read exact action progress instead of scanning other bots/threads or replaying an approval.
    /// A finished origin can precede creation of responseTurnId; stay attached until durable delivery,
    /// invalidation, a finite retry budget, or the presentation's absolute deadline.
    private func observeContinuations(scope: ThreadScope, token: UUID, client: HostClient,
                                      deadline: ContinuousClock.Instant) async {
        guard let botID = selectedBotID, let hostID = scope.projectionHostID else { return }
        func scopeIsCurrent() -> Bool {
            !Task.isCancelled && pollToken == token && isCurrent(scope)
                && presentedThreadID == scope.threadID && selectedBotID == botID
                && nativeProjectionHostID == hostID
        }
        func current() -> Bool { scopeIsCurrent() && ContinuousClock.now < deadline }
        defer {
            if scopeIsCurrent(), ContinuousClock.now >= deadline {
                errorMessage = String(localized: "A observação automática atingiu o limite de tempo. Use Atualizar conversa para reler o resultado do host; nenhuma ação será repetida.")
            }
        }
        var settled = Set<String>()
        var failures = 0
        var observationFailure: String?
        while current() {
            let candidates = actions(for: scope.threadID).filter { $0.request.botId == botID && !settled.contains($0.id) }
            guard !candidates.isEmpty else { return }
            do {
                let health = try await client.health()
                guard current() else { return }
                guard (health.installationId ?? health.hostId) == hostID else { throw HostClientError.contractMismatch }
                for snapshot in candidates {
                    let action = try await client.getAction(id: snapshot.id)
                    guard current() else { return }
                    guard action.request == snapshot.request, action.requestHash == snapshot.requestHash,
                          action.grantRevision == snapshot.grantRevision else { throw HostClientError.contractMismatch }
                    if let index = actions.firstIndex(where: { $0.id == action.id }), actions[index].updatedAt <= action.updatedAt {
                        actions[index] = action
                    }
                    observeMcpAuthorizationResult(action)
                    let progress = try await client.actionContinuation(actionID: action.id)
                    guard current() else { return }
                    guard let progress else {
                        if action.state != .awaitingApproval && action.state != .ready && action.state != .running { settled.insert(action.id) }
                        continue
                    }
                    guard progress.originValid else { settled.insert(action.id); continue }
                    let turnID = progress.responseTurnId ?? progress.originTurnId
                    // New submission observation may refresh old receipts, but never attach to a
                    // cancelled origin/response or restore its stale stream/proposal authority.
                    if stoppedTurnIDs.contains(turnID) || stoppedTurnIDs.contains(progress.originTurnId)
                        || stoppedActionIDs.contains(action.id) { settled.insert(action.id); continue }
                    let turn = try await client.getTurn(id: turnID)
                    guard current() else { return }
                    guard turn.id == turnID, turn.threadId == scope.threadID, turn.botId == botID else {
                        throw HostClientError.contractMismatch
                    }
                    if progress.responseTurnId != nil, turn.state == .queued { queuedReceiptResponseTurnIDs.insert(turn.id) }
                    // The host alone selects and creates this turn. No submit/start/resume path is called here.
                    if !turn.state.isTerminal {
                        // Each event drain starts at cursor zero; a reconnect replaces its partial projection.
                        streamingText = ""
                        currentTurn = turn; pollingTurnID = turn.id
                        await poll(turnID: turn.id, threadID: scope.threadID, scope: scope, client: client, deadline: deadline)
                        guard current() else { return }
                        pollingTurnID = nil
                        guard currentTurn?.id == turn.id, currentTurn?.state.isTerminal == true else { throw HostClientError.offline }
                    }
                    if progress.responseTurnId != nil || progress.deliveredToEngine {
                        // Fetch after the terminal snapshot, so an empty earlier load cannot hide the answer.
                        let canonicalMessages = try await client.allMessages(threadID: scope.threadID)
                        guard current() else { return }
                        messages = canonicalMessages; reconcileOutgoingPreview()
                        if currentTurn == nil || currentTurn!.cursor <= turn.cursor {
                            if currentTurn?.id != turn.id { streamingText = "" }
                            // poll may have fetched a later terminal version of the same turn.
                            if currentTurn?.id != turn.id || (turn.state.isTerminal && turn.updatedAt >= currentTurn!.updatedAt) { currentTurn = turn }
                            if currentTurn?.state == .completed { streamingText = "" }
                        }
                        settled.insert(action.id)
                    }
                }
                guard current() else { return }
                isOnline = true
                botActivityObservationAvailable = true
                if let observationFailure, errorMessage == observationFailure { errorMessage = nil }
                observationFailure = nil
                failures = 0
                if actions(for: scope.threadID).allSatisfy({ settled.contains($0.id) }) { return }
                try await Task.sleep(for: continuationObservationInterval)
                guard current() else { return }
            } catch is CancellationError {
                return
            } catch {
                guard current() else { return }
                observationFailure = safeMessage(for: error)
                botActivityObservationAvailable = false
                errorMessage = observationFailure
                let failure = error as? HostClientError
                guard failure == .offline || failure == .hostFailure || failure == .notReady else {
                    isOnline = false
                    return
                }
                isOnline = false
                failures += 1
                guard failures < 5 else { return }
                do { try await Task.sleep(for: continuationObservationInterval * (1 << (failures - 1))) }
                catch { return }
                guard current() else { return }
            }
        }
    }

    private func beginSubmission(_ id: String) {
        isSubmitting = true
        activeSubmissionID = id
    }

    private func endSubmission(_ id: String) {
        guard activeSubmissionID == id else { return }
        activeSubmissionID = nil
        isSubmitting = false
    }

    /// Only a first, unambiguous refusal proves the host never accepted the request.
    /// Once any attempt was uncertain (including cancellation, or any non-HostClientError), or the request was recovered, the ID is kept until the host confirms it.
    private func canClearAfterFailure(_ error: Error, pending: PendingTurnSubmission) -> Bool {
        if mayHaveAcceptedSubmission(error) {
            uncertainRequestIDs.insert(pending.clientRequestID)
            return false
        }
        return !pending.isRecovered && !uncertainRequestIDs.contains(pending.clientRequestID)
    }

    private func mayHaveAcceptedSubmission(_ error: Error) -> Bool {
        guard let error = error as? HostClientError else { return true }
        switch error {
        case .offline, .notReady, .hostFailure, .contractMismatch, .deviceMutationOutcomeUnknown, .mutationOutcomeUnknown:
            return true
        case .invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden, .notFound, .conflict, .approvalExpired:
            return false
        }
    }

    private func isValidUnpairedAddress(_ address: String) -> Bool {
        guard address.utf8.count <= 512,
              let components = URLComponents(string: address),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              components.host != nil,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { return false }
        if let port = components.port, !(1...65_535).contains(port) { return false }
        return true
    }

    private func persistCurrentState() -> Bool {
        persistState(mode: persistedMode, loopbackAddress: lastLoopbackAddress, pending: pendingRequestRecords)
    }

    private func persistSelectionIfValidated() {
        guard !isFixture, pairedBinding == nil, canUseHost, isOnline,
              let address = DexterAppStateValidation.validatedLoopbackAddress(hostAddress),
              let identity = nativeProjectionHostID,
              let botID = selectedBotID, bots.contains(where: { $0.id == botID }) else { return }
        let threadID = selectedThreadID.flatMap { id in
            conversationThreads.contains(where: { $0.id == id }) ? id : nil
        }
        let record = DexterLastSelectionRecord(hostAddress: address, hostIdentity: identity,
            botID: botID, threadID: threadID, teamID: selectedTeamID)
        guard record.isValid(), lastSelection != record else { return }
        lastSelection = record
        if !persistCurrentState() {
            persistenceNotice = DexterLocalization.text("The current conversation could not be saved for the next launch.")
        }
    }

    /// Runs once after a validated refresh. IDs are resolved against its current lists, never replayed as writes.
    private func restoreLastSelection(identity: String?) -> Bool {
        guard !isFixture, pairedBinding == nil, let saved = lastSelection,
              let address = DexterAppStateValidation.validatedLoopbackAddress(hostAddress) else { return false }
        let sameHost = saved.hostAddress == address && saved.hostIdentity == identity
        if sameHost, let teamID = saved.teamID, let team = teams.first(where: { $0.id == teamID }),
           let coordinator = team.coordinatorBotId, bots.contains(where: { $0.id == coordinator }) {
            selectTeam(id: teamID)
            recoveryRequiresExplicitConversation = true
            let available = threads(forTeam: teamID)
            if let thread = available.first(where: { $0.id == saved.threadID }) ?? Self.mostRecent(available) {
                _ = presentTeamThread(thread.id, teamID: teamID)
            }
            persistSelectionIfValidated()
            return true
        }
        let savedBot = sameHost ? bots.first(where: { $0.id == saved.botID }) : nil
        guard let bot = savedBot ?? bots.first else { return false }
        let available = threads(for: bot.id)
        let savedThread = savedBot == nil ? nil : available.first(where: { $0.id == saved.threadID })
        let fallback = Self.mostRecent(available)
        selectBot(id: bot.id)
        // An empty/missing restored conversation must require an explicit New conversation action.
        recoveryRequiresExplicitConversation = true
        if let thread = savedThread ?? fallback { _ = presentThread(thread.id, for: bot.id) }
        if !sameHost || savedBot == nil || (saved.threadID != nil && savedThread == nil) {
            persistenceNotice = DexterLocalization.text("The previous selection is unavailable on this host. An available bot or conversation was selected.")
        }
        persistSelectionIfValidated()
        return true
    }

    private func persistState(
        mode: DexterStoredConnectionMode,
        loopbackAddress: String?,
        pending: [DexterPendingRequestRecord]
    ) -> Bool {
        guard !hasCorruptStoredData else { return false }
        let state = DexterPersistedAppState(
            version: DexterPersistedAppState.currentVersion,
            mode: mode,
            loopbackAddress: loopbackAddress,
            pendingRequests: pending,
            lastSelection: lastSelection
        )
        guard let data = DexterAppStateValidation.encode(state) else { return false }
        stateStorage.writeData(data)
        return true
    }

    private func persistPendingSubmission(_ pending: PendingTurnSubmission, hostAddress: String) -> Bool {
        if let binding = pairedBinding {
            guard hostAddress == currentPersistenceHostKey() else { return false }
            do { try pairing.recordPending(PairedPendingTurn(installationID:binding.installationID,deviceID:binding.deviceID,threadID:pending.threadID,clientRequestID:pending.clientRequestID,contentDigest:pending.contentDigest)); return true } catch { return false }
        }
        guard DexterAppStateValidation.validatedLoopbackAddress(hostAddress) == hostAddress,
              DexterAppStateValidation.isSafeThreadID(pending.threadID),
              DexterAppStateValidation.isCanonicalRequestID(pending.clientRequestID),
              DexterAppStateValidation.isSHA256Digest(pending.contentDigest) else { return false }

        var nextRecords = pendingRequestRecords
        if let index = nextRecords.firstIndex(where: {
            $0.hostAddress == hostAddress && $0.threadID == pending.threadID
        }) {
            guard nextRecords[index].clientRequestID == pending.clientRequestID,
                  nextRecords[index].contentDigest == pending.contentDigest,
                  (nextRecords[index].attachmentIDs ?? []) == pending.attachmentIDs else { return false }
        } else {
            guard nextRecords.count < DexterPersistedAppState.maxPendingRequests else { return false }
            nextRecords.append(DexterPendingRequestRecord(
                hostAddress: hostAddress,
                threadID: pending.threadID,
                clientRequestID: pending.clientRequestID,
                contentDigest: pending.contentDigest,
                attachmentIDs: pending.attachmentIDs.isEmpty ? nil : pending.attachmentIDs
            ))
        }

        guard persistState(mode: persistedMode, loopbackAddress: lastLoopbackAddress, pending: nextRecords) else {
            return false
        }
        pendingRequestRecords = nextRecords
        return true
    }

    private func pendingRequestRecord(hostAddress: String?, threadID: String) -> DexterPendingRequestRecord? {
        guard let hostAddress else { return nil }
        if let binding = pairedBinding, let record = pairing.pending(installation:binding.installationID,device:binding.deviceID,thread:threadID) {
            return DexterPendingRequestRecord(hostAddress:hostAddress,threadID:record.threadID,clientRequestID:record.clientRequestID,contentDigest:record.contentDigest)
        }
        return pendingRequestRecords.first { $0.hostAddress == hostAddress && $0.threadID == threadID }
    }

    private func restorePendingSubmission(hostAddress: String?, threadID: String) {
        guard let record = pendingRequestRecord(hostAddress: hostAddress, threadID: threadID) else {
            pendingSubmission = nil
            return
        }
        if let current = pendingSubmission,
           current.threadID == threadID,
           current.clientRequestID == record.clientRequestID {
            return
        }
        pendingSubmission = PendingTurnSubmission(
            threadID: record.threadID,
            clientRequestID: record.clientRequestID,
            contentDigest: record.contentDigest,
            content: nil,
            isRecovered: true,
            attachmentIDs: record.attachmentIDs ?? []
        )
    }

    private func removePendingRequest(_ record: DexterPendingRequestRecord) {
        if let binding = pairedBinding, let paired = pairing.pending(installation:binding.installationID,device:binding.deviceID,thread:record.threadID) {
            do { try pairing.clearPending(paired) } catch { return }
            uncertainRequestIDs.remove(record.clientRequestID); if pendingSubmission?.clientRequestID == record.clientRequestID { pendingSubmission = nil }; return
        }
        uncertainRequestIDs.remove(record.clientRequestID)
        let nextRecords = pendingRequestRecords.filter { $0 != record }
        guard nextRecords.count != pendingRequestRecords.count else { return }
        pendingRequestRecords = nextRecords
        _ = persistCurrentState()
        if pendingSubmission?.threadID == record.threadID,
           pendingSubmission?.clientRequestID == record.clientRequestID {
            pendingSubmission = nil
        }
    }

    private func clearPendingSubmission(ifMatching pending: PendingTurnSubmission?, hostAddress: String?) {
        guard let pending,
              let record = pendingRequestRecord(hostAddress: hostAddress, threadID: pending.threadID),
              record.clientRequestID == pending.clientRequestID else { return }
        removePendingRequest(record)
    }

    private func beginThreadSelection(_ threadID: String, preservingNativeDraft: Bool = false) -> ThreadScope {
        mcpAuthorizationHandoffs.invalidate()
        macSetupHandoffs.invalidate()
        turnControlToken = nil; turnControlInFlight = false; turnControlNotice = nil
        stoppedObservationScope = nil; queuedReceiptResponseTurnIDs = []
        stoppedTurnIDs = []; stoppedRequestIDs = []; stoppedActionIDs = []; lastStopContext = nil
        if selectedThreadID != threadID { stopLiveVoice() }
        resetThreadEngineSelection()
        if !preservingNativeDraft { nativeOpeningSelectionID = nil }
        let preserve = preservingNativeDraft && selectedThreadID == threadID
            && nativeActionDraft?.threadID == threadID && nativeActionDraft.map { nativeActionNow() < $0.expiresAt } == true
            && nativeDraftScope.map(isCurrent) == true
        if !preserve { clearNativeActionDraft() }
        threadGeneration &+= 1
        stopPolling()
        selectedThreadID = threadID
        messages = []
        currentTurn = nil
        streamingText = ""
        errorMessage = nil
        communicationConfirmationNotice = nil
        restorePendingSubmission(hostAddress: currentPersistenceHostKey(), threadID: threadID)
        recoveryRequiresExplicitConversation = false
        persistSelectionIfValidated()
        let scope = currentThreadScope(threadID)
        if preserve { nativeDraftScope = scope }
        return scope
    }

    private func invalidateThreadSelection() {
        mcpAuthorizationHandoffs.invalidate()
        macSetupHandoffs.invalidate()
        stopLiveVoice()
        resetThreadEngineSelection()
        nativeOpeningSelectionID = nil
        clearNativeActionDraft()
        isThreadPresented = false
        threadGeneration &+= 1
        stopPolling()
        selectedThreadID = nil
        pendingSubmission = nil
        clearThreadProjection()
    }

    private func clearThreadProjection() {
        botActivityObservationAvailable = false
        turnControlToken = nil; turnControlInFlight = false; turnControlNotice = nil
        stoppedObservationScope = nil; queuedReceiptResponseTurnIDs = []
        stoppedTurnIDs = []; stoppedRequestIDs = []; stoppedActionIDs = []; lastStopContext = nil
        messages = []
        currentTurn = nil
        streamingText = ""
        communicationConfirmationNotice = nil
    }

    private func invalidateHostWork() {
        mcpAuthorizationHandoffs.invalidate()
        macSetupHandoffs.invalidate()
        stopLiveVoice()
        liveVoiceSettingsRead = UUID(); liveVoiceSettings = nil; liveVoiceKeyConfigured = false
        selectionRecoveryPending = true
        recoveryRequiresExplicitConversation = false
        nativeOpeningSelectionID = nil
        nativeProjectionHostID = nil
        nativeComposerScope = UUID()
        clearNativeActionDraft()
        isThreadPresented = false
        selectedThreadID = nil
        selectedTeamID = nil; teams = []; threadsByTeam = [:]; pendingTeamCreation = nil
        teamConversationTasks = [:]; teamThreadRequestIDs = [:]; teamProfileGeneration &+= 1
        clearThreadProjection()
        client?.close(); pairing.disconnect(); pairedBinding = nil; pairedConnectionGeneration = nil
        hostGeneration &+= 1
        threadGeneration &+= 1
        stopPolling()
        activeSubmissionID = nil
        isSubmitting = false
        isLoading = false
        invalidateDeviceWork()
        pendingSubmission = nil
        outgoingMessagePreview = nil; outgoingPreviewScope = nil; outgoingPreviewInputMessageID = nil
        clearReadinessFacts()
    }

    /// Drops the device list and makes every pending device read or mutation stale: list responses fail the
    /// `deviceGeneration` check and operations lose their token, so nothing merges into later facts.
    private func invalidateDeviceWork() {
        deviceGeneration &+= 1
        deviceMutationSequence &+= 1
        isLoadingDevices = false
        deviceError = nil
        devices = []
        operatingDeviceIDs = []
        awaitingDeviceConfirmationIDs = []
        discardableDeviceMutationIDs = []
        deviceMutationRevisions = [:]
        deviceOperationTokens = [:]
        deviceMutationExpectations = [:]
        readinessDevicesIdentity = nil
        invalidateGrantWork()
    }

    /// Grant rows, writes and uncertain expectations belong to the host authority that produced them.
    private func invalidateGrantWork() {
        grantGeneration &+= 1
        grantBotID = nil
        grantRows = []
        isLoadingGrants = false
        grantError = nil
        operatingGrantID = nil
        grantOperationToken = nil
        uncertainGrantIDs = []
        discardableGrantIDs = []
        grantExpectations = [:]
    }

    private enum ReadinessHostFailure { case unreachable, validationFailed }

    private func resetThreadEngineSelection() {
        engineSelectionReadSequence &+= 1
        threadEngineSelection = nil; engineSelectionThreadID = nil; isUpdatingEngineSelection = false
        engineSelectionRequiresReload = false; engineSelectionNotice = nil
    }
    private func clearReadinessFacts() {
        engineCatalogReadSequence &+= 1; engineCatalog = []; engineCatalogObservedAt = nil; engineCatalogLookup = .notLoaded; resetThreadEngineSelection()
        readinessEpoch &+= 1
        readinessHealth = nil
        readinessHostFailure = nil
        readinessEngines = [:]
        readinessDevicesIdentity = nil
    }

    /// Callers have already checked the host generation. A different host identity on the same address drops facts
    /// from the previous one, including pending device work whose names, roles or presence belong to that authority.
    private func recordReadinessHealth(_ health: HostHealth) {
        let identity: OnboardingHostIdentity
        if pairedBinding != nil {
            identity = OnboardingHostIdentity(hostID: health.installationId ?? "", mode: .pairedClient, clientDeviceID: health.client?.deviceId)
        } else {
            identity = OnboardingHostIdentity(hostID: health.hostId ?? "", mode: .localDevelopment, clientDeviceID: nil)
        }
        if let previous = readinessHealth?.identity, previous != identity {
            invalidateDeviceWork()
            engineCatalogReadSequence &+= 1; engineCatalog = []; engineCatalogObservedAt = nil; engineCatalogLookup = .notLoaded
        }
        if readinessHealth?.identity != identity {
            readinessEpoch &+= 1
            readinessEngines = [:]
            readinessDevicesIdentity = nil
        }
        readinessHealth = (identity, Self.readinessRouting(health))
        readinessHostFailure = nil
    }

    nonisolated static func readinessRouting(_ health: HostHealth) -> OnboardingEngineRouting {
        switch health.engineRouting {
        case "not_connected": return .notConnected
        case "connected":
            // Driver keys only say what is routed, never whether the engine is signed in.
            guard case .object(let runtime)? = health.runtime, case .array(let keys)? = runtime["engines"] else {
                return .connected(routedEngines: nil)
            }
            return .connected(routedEngines: Set(keys.compactMap { if case .string(let key) = $0 { EngineID(rawValue: key) } else { nil } }))
        default: return .unknown
        }
    }

    /// Only turns read under the still-current validated identity, of a bot listed by the current host and run by that
    /// bot's engine, are correlated. The same address and coincident bot/thread IDs do not prove the same authority.
    private func observeReadiness(_ turns: [Turn], scope: ThreadScope) {
        guard readinessHealth != nil, scope.readinessEpoch == readinessEpoch else { return }
        for turn in turns {
            guard let bot = bots.first(where: { $0.id == turn.botId }), bot.engine == turn.engine else { continue }
            readinessEngines[turn.engine] = (readinessEngines[turn.engine] ?? OnboardingEngineObservation()).observing(turn)
        }
    }

    private func isCurrentDeviceRequest(host: UInt64, devices: UInt64) -> Bool {
        isCurrentHost(host) && deviceGeneration == devices
    }

    private func replaceDevice(_ updated: DeviceView) {
        guard let index = devices.firstIndex(where: { $0.id == updated.id }) else { return }
        devices[index] = updated
    }

    private func refreshedDevicesPreservingOperations(
        _ refreshed: [DeviceView],
        mutationRevisionAtStart: UInt64
    ) -> [DeviceView] {
        var merged = refreshed
        let changedSinceRequest = Set(
            deviceMutationRevisions.compactMap { id, revision in
                revision > mutationRevisionAtStart ? id : nil
            }
        )
        let preserveIDs = operatingDeviceIDs
            .union(awaitingDeviceConfirmationIDs)
            .union(changedSinceRequest)

        for id in preserveIDs {
            guard let current = devices.first(where: { $0.id == id }) else { continue }
            if let index = merged.firstIndex(where: { $0.id == id }) {
                merged[index] = current
            } else {
                merged.append(current)
            }
        }
        return merged
    }

    /// Internal so adversarial tests can model a newer same-host device revision during a suspended response.
    func recordDeviceMutationRevision(for id: String) {
        deviceMutationSequence &+= 1
        deviceMutationRevisions[id] = deviceMutationSequence
    }

    private func markDeviceMutationUnknown(id: String, expectation: DeviceMutationExpectation) {
        deviceMutationExpectations[id] = expectation
        awaitingDeviceConfirmationIDs.insert(id)
        discardableDeviceMutationIDs.remove(id)
        recordDeviceMutationRevision(for: id)
        deviceError = .deviceMutationOutcomeUnknown
    }

    private func isCurrentDeviceOperation(host: UInt64, id: String, token: UUID) -> Bool {
        isCurrentHost(host) && deviceOperationTokens[id] == token
    }

    private func isAmbiguousDeviceMutationError(_ error: Error) -> Bool {
        switch safeHostClientError(for: error) {
        case .offline, .notReady, .hostFailure, .contractMismatch, .deviceMutationOutcomeUnknown, .mutationOutcomeUnknown:
            true
        case .invalidConfiguration, .remotePairingUnavailable, .invalidRequest, .forbidden,
             .notFound, .conflict, .approvalExpired:
            false
        }
    }

    private func currentThreadScope(_ threadID: String) -> ThreadScope {
        ThreadScope(
            hostGeneration: hostGeneration,
            threadGeneration: threadGeneration,
            threadID: threadID,
            hostAddress: currentPersistenceHostKey(),
            rawHostAddress: hostAddress,
            projectionHostID: nativeProjectionHostID,
            readinessEpoch: readinessHealth == nil ? nil : readinessEpoch
        )
    }

    private func isCurrentHost(_ generation: UInt64) -> Bool {
        hostGeneration == generation && (pairedConnectionGeneration.map { pairing.generation == $0 && pairing.state == .paired } ?? true)
    }

    private func isCurrent(_ scope: ThreadScope) -> Bool {
        isCurrentHost(scope.hostGeneration)
            && threadGeneration == scope.threadGeneration
            && selectedThreadID == scope.threadID
            && hostAddress == scope.rawHostAddress
            && currentPersistenceHostKey() == scope.hostAddress
            && nativeProjectionHostID == scope.projectionHostID
            && canUseHost
    }

    private func installFixture() {
        let now: Int64 = 1_791_331_200_000
        let bot = Bot(id: "fixture-bot", name: "Assistente de exemplo", profileId: "fixture-profile", engine: .claude, ownerId: "fixture-owner", createdAt: now)
        let thread = HostThread(id: "fixture-thread", botId: bot.id, createdAt: now)
        let sampleMessages = [
            Message(cursor: 1, id: "fixture-message-1", threadId: thread.id, clientMessageId: "fixture-client-1", role: .user, content: "Como funciona esta tela?", createdAt: now),
            Message(cursor: 2, id: "fixture-message-2", threadId: thread.id, clientMessageId: "fixture-client-2", role: .assistant, content: "Este é um fixture visual. Conecte o app Mac a um host de desenvolvimento local para testar uma conversa real.", createdAt: now + 1),
        ]
        let request = ActionRequest(
            botId: bot.id,
            threadId: thread.id,
            tool: "browser.open",
            destination: "browser local",
            arguments: ["url": .string("https://example.invalid"), "newTab": .bool(true)],
            idempotencyKey: "fixture-action-key"
        )
        let sampleAction = Action(
            id: "fixture-action",
            request: request,
            requestHash: String(repeating: "a", count: 64),
            grantRevision: 1,
            state: .awaitingApproval,
            createdAt: now,
            updatedAt: now,
            approvalExpiresAt: now + 3_600_000,
            decidedBy: nil,
            result: nil,
            reason: nil
        )
        bots = [bot]
        threadsByBot = [bot.id: [thread]]
        selectedBotID = bot.id
        selectedThreadID = thread.id
        messages = sampleMessages
        actions = [sampleAction]
        currentTurn = nil
        streamingText = ""
    }

    private func safeMessage(for error: Error) -> String {
        if let error = error as? HostClientError { return DexterLocalization.text(error.localizedDescription) }
        return DexterLocalization.text("The host could not complete this operation.")
    }

    private func safeHostClientError(for error: Error) -> HostClientError {
        error as? HostClientError ?? .hostFailure
    }
}

// Live is an explicit, owner-local session. It never supplies authority or approves tools by voice.
public extension DexterAppModel {
    #if os(macOS)
    func nativeVoicePreferencesEditor(bot: Bot) -> NativeVoicePreferencesEditor? {
        guard let hostID = approvalPolicyHostID else { return nil }
        let key = hostID + ":" + bot.id
        if let editor = nativeVoicePreferenceEditors[key], editor.connectionScope == nativeComposerScope { return editor }
        guard nativeVoicePreferenceEditors[key]?.pending == nil,
              let editor = NativeVoicePreferencesEditor(bot: bot, model: self) else { return nil }
        nativeVoicePreferenceEditors = nativeVoicePreferenceEditors.filter { $0.value.pending != nil }
        nativeVoicePreferenceEditors[key] = editor
        return editor
    }
    /// Retain original call requests across sheet closes. Controllers never inherit a new host scope.
    func nativeVoiceController(bot: Bot, threadID: String) -> CodexNativeVoiceController? {
        guard let hostID = approvalPolicyHostID, selectedBotID == bot.id, selectedThreadID == threadID else { return nil }
        let scope = CodexVoiceScope(hostID: hostID, botID: bot.id, threadID: threadID)
        if let current = codexVoiceControllers[scope], current.connectionScope == nativeComposerScope { return current }
        // Retain unconfirmed old requests, keyed by controller scope, while rejecting reparenting.
        guard codexVoiceControllers[scope]?.hasUnconfirmedRequest != true else { return nil }
        guard let controller = CodexNativeVoiceController(model: self, bot: bot, threadID: threadID) else { return nil }
        codexVoiceControllers = codexVoiceControllers.filter { $0.value.hasUnconfirmedRequest || $0.value.hasLocalMedia || $0.value.session?.terminal == false }
        codexVoiceControllers[scope] = controller
        return controller
    }
    #endif
    var canStartLiveVoice: Bool {
        #if os(macOS)
        canEditBotProfiles && isOnline && liveVoiceSettings?.enabled == true && liveVoiceKeyConfigured
            && liveVoiceSettings?.hostID == nativeProjectionHostID && presentedThreadID != nil
            && !isSubmitting && pendingSubmission == nil && !isUpdatingEngineSelection
            && currentTurn?.state != .queued && currentTurn?.state != .running
            && !liveVoiceController.isSessionActive && liveVoiceOwnedRequests.isEmpty
            && NativeVoiceMediaLease.holder == nil
        #else
        false
        #endif
    }

    func loadLiveVoiceSettings() async {
        guard canEditBotProfiles, isOnline, let client, let hostID = nativeProjectionHostID else { return }
        let token = UUID(); liveVoiceSettingsRead = token
        let generation = hostGeneration
        do {
            let settings = try await client.getLiveVoiceSettings()
            guard token == liveVoiceSettingsRead, generation == hostGeneration, nativeProjectionHostID == hostID else { return }
            guard settings.hostID == hostID else { throw HostClientError.contractMismatch }
            liveVoiceSettings = settings
            liveVoiceKeyConfigured = liveVoiceController.keyStatus(hostID: hostID) == .configured
            if !settings.enabled { stopLiveVoice() }
        } catch {
            guard token == liveVoiceSettingsRead, generation == hostGeneration else { return }
            liveVoiceSettings = nil; liveVoiceKeyConfigured = false
            liveVoiceNotice = String(localized: "Não foi possível consultar a configuração de voz nesta base. Recarregue os ajustes.")
        }
    }

    func saveLiveVoiceSettings(enabled: Bool, defaultVoice: String, expectedRevision: Int) async throws {
        guard canEditBotProfiles, let client, let hostID = nativeProjectionHostID,
              LiveVoiceCatalog.voices.contains(defaultVoice) else { throw HostClientError.forbidden }
        let generation = hostGeneration
        liveVoiceSettingsRead = UUID()
        let settings = try await client.updateLiveVoiceSettings(hostID: hostID, enabled: enabled,
            defaultVoice: defaultVoice, expectedRevision: expectedRevision)
        guard generation == hostGeneration, nativeProjectionHostID == hostID, settings.hostID == hostID else {
            throw HostClientError.mutationOutcomeUnknown
        }
        liveVoiceSettings = settings
        if !enabled { stopLiveVoice() }
        liveVoiceNotice = String(localized: "Configuração salva. A voz escolhida vale para a próxima sessão Live.")
    }

    func saveLiveVoiceKey(_ key: String) throws {
        guard canEditBotProfiles, let hostID = nativeProjectionHostID else { throw HostClientError.forbidden }
        stopLiveVoice()
        try liveVoiceController.saveKey(key, hostID: hostID)
        liveVoiceKeyConfigured = liveVoiceController.keyStatus(hostID: hostID) == .configured
        liveVoiceNotice = String(localized: "Chave guardada no Keychain deste Mac. O acesso ao GPT-Live será confirmado ao iniciar uma conversa.")
    }

    func removeLiveVoiceKey() throws {
        guard canEditBotProfiles, let hostID = nativeProjectionHostID else { throw HostClientError.forbidden }
        stopLiveVoice()
        try liveVoiceController.removeKey(hostID: hostID)
        liveVoiceKeyConfigured = false
        liveVoiceNotice = String(localized: "Chave removida deste Mac. Nenhuma chave de outras bases foi alterada.")
    }

    func startLiveVoice() async {
        #if os(macOS)
        guard canStartLiveVoice, let client, let threadID = presentedThreadID,
              let botID = selectedBotID, let hostID = nativeProjectionHostID else { return }
        let generation = hostGeneration, presentation = threadGeneration
        do {
            let context = try await client.getLiveVoiceContext(threadID: threadID)
            guard generation == hostGeneration, presentation == threadGeneration,
                  presentedThreadID == threadID, selectedBotID == botID, nativeProjectionHostID == hostID,
                  context.hostID == hostID, context.threadID == threadID, context.bot.id == botID,
                  context.settings.hostID == hostID, context.settings.enabled,
                  NativeVoiceMediaLease.holder == nil else { return }
            let scope = LiveVoiceScope(hostID: hostID, botID: botID, threadID: threadID)
            let recordingID = UUID().uuidString.lowercased()
            liveVoiceRecordingID = recordingID; liveVoiceLastDelegatedInput = ""; liveVoiceNotice = nil
            liveVoiceController.onDelegation = { [weak self] request in
                guard let self else { return "A conversa foi encerrada; nenhuma nova tarefa foi iniciada." }
                return await self.performLiveDelegation(request, recordingID: recordingID, client: client)
            }
            liveVoiceController.onClosed = { [weak self] closed in
                guard let self else { return }
                await self.cancelLiveVoiceWork(client: client, hostID: scope.hostID)
                guard closed.scope == scope, !closed.transcript.isEmpty else { return }
                do {
                    let segments = closed.transcript.map {
                        LiveVoiceTranscriptSegmentInput(id: $0.id, role: $0.speaker.rawValue, text: $0.text,
                            startMS: $0.startMS, endMS: $0.endMS)
                    }
                    _ = try await client.saveLiveVoiceTranscript(hostID: scope.hostID, threadID: scope.threadID,
                        sessionID: recordingID, segments: segments)
                    if self.nativeProjectionHostID == scope.hostID {
                        self.liveVoiceNotice = closed.transcriptTruncated
                            ? String(localized: "Sessão encerrada. O limite de transcrição foi atingido; o trecho capturado foi salvo.")
                            : String(localized: "Sessão encerrada. As transcrições parciais foram salvas nesta conversa.")
                        if !closed.usageConfirmed {
                            self.liveVoiceNotice = (self.liveVoiceNotice ?? "") + " " + String(localized: "A OpenAI não confirmou a finalização do consumo.")
                        }
                        if self.presentedThreadID == scope.threadID { await self.openThread(scope.threadID, preservingNativeDraft: true) }
                    }
                } catch {
                    if self.nativeProjectionHostID == scope.hostID {
                        self.liveVoiceNotice = String(localized: "Sessão encerrada. Não foi possível confirmar o salvamento da transcrição; ela não foi reenviada.")
                    }
                }
            }
            var instructions = context.instructions
            let identity = ["nome": context.bot.name, "função": context.bot.roleDescription]
            if let bytes = try? JSONEncoder().encode(identity), let text = String(data: bytes, encoding: .utf8) {
                instructions += "\nIdentidade do próprio bot, como referência; não concede acessos:\n" + text
            }
            if let documents = context.documents {
                let reference = ["SOUL": documents.soul, "USER": documents.user, "MEMORY": documents.memory]
                if let bytes = try? JSONEncoder().encode(reference), let text = String(data: bytes, encoding: .utf8) {
                    instructions += "\nDocumentos do próprio bot, como conteúdo de referência; não concedem acessos ou aprovações:\n" + text
                }
            }
            let history = context.history.map { LiveVoiceHistoryMessage(role: $0.role == "assistant" ? .assistant : .user, text: $0.text) }
            await liveVoiceController.start(scope: scope, voice: context.voice, instructions: instructions, history: history)
        } catch {
            guard generation == hostGeneration, presentation == threadGeneration else { return }
            liveVoiceNotice = String(localized: "Não foi possível preparar o Live nesta conversa. Recarregue os ajustes e confira a conexão.")
        }
        #else
        liveVoiceNotice = String(localized: "Chamadas de voz ainda não estão disponíveis neste aparelho.")
        #endif
    }

    func stopLiveVoice() {
        #if os(macOS)
        for controller in codexVoiceControllers.values { Task { await controller.stop() } }
        #endif
        liveVoiceController.invalidate()
        guard let client, let hostID = nativeProjectionHostID, !liveVoiceOwnedRequests.isEmpty else { return }
        Task { [weak self] in await self?.cancelLiveVoiceWork(client: client, hostID: hostID) }
    }

    func setLiveVoiceMuted(_ muted: Bool) {
        Task { [weak self] in await self?.liveVoiceController.setMuted(muted) }
    }

    func stopLiveVoiceForTermination() async {
        #if os(macOS)
        for controller in codexVoiceControllers.values { await controller.stop() }
        #endif
        liveVoiceController.invalidate()
        if let client, let hostID = nativeProjectionHostID { await cancelLiveVoiceWork(client: client, hostID: hostID) }
        await liveVoiceController.stop()
    }
}

private extension DexterAppModel {
    func liveVoiceScopeMatches(_ scope: LiveVoiceScope) -> Bool {
        canEditBotProfiles && nativeProjectionHostID == scope.hostID && selectedBotID == scope.botID
            && presentedThreadID == scope.threadID && liveVoiceController.scope == scope
            && liveVoiceController.state == .listening
    }

    func performLiveDelegation(_ request: LiveVoiceDelegationRequest, recordingID: String, client: HostClient) async -> String {
        guard liveVoiceScopeMatches(request.scope), liveVoiceRecordingID == recordingID, !Task.isCancelled,
              !isSubmitting, pendingSubmission == nil, liveVoiceOwnedRequests.isEmpty,
              currentTurn?.state != .queued && currentTurn?.state != .running else {
            return "Há uma tarefa em andamento ou a conversa mudou. Não iniciei outra tarefa."
        }
        let segments = request.transcript.filter { segment in
            request.offsetMS.map { offset in segment.startMS.map { $0 <= offset } ?? true } ?? true
        }
        let userInput = segments.filter { $0.speaker == .user }.map(\.text).joined(separator: "\n")
        guard !userInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              userInput != liveVoiceLastDelegatedInput, !request.transcriptTruncated else {
            return "Ainda não tenho uma transcrição nova e suficiente do pedido. Repita o que deseja fazer."
        }
        liveVoiceLastDelegatedInput = userInput
        let quoted = segments.suffix(12).map {
            "\($0.speaker == .user ? "Você" : "Bot"): \($0.text.prefix(1_200))"
        }.joined(separator: "\n\n")
        let content = "Conversa por voz · transcrição parcial\n\n" + String(quoted.suffix(8_000))
        let digest = SHA256.hash(data: Data("\(recordingID)|\(request.scope.hostID)|\(request.scope.threadID)|\(request.id)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let hex = String(digest.prefix(32))
        let requestID = [String(hex.prefix(8)), String(hex.dropFirst(8).prefix(4)), String(hex.dropFirst(12).prefix(4)),
            String(hex.dropFirst(16).prefix(4)), String(hex.dropFirst(20))].joined(separator: "-")
        liveVoiceOwnedRequests[request.id] = (request.scope, requestID, nil)
        do {
            let turn = try await client.startTurn(threadID: request.scope.threadID,
                submission: TurnSubmission(content: content, clientRequestId: requestID))
            guard turn.clientRequestId == requestID, turn.threadId == request.scope.threadID,
                  turn.botId == request.scope.botID else { throw HostClientError.contractMismatch }
            liveVoiceOwnedRequests[request.id] = (request.scope, requestID, turn.id)
            guard liveVoiceScopeMatches(request.scope), !Task.isCancelled else {
                _ = try? await client.cancelTurn(id: turn.id)
                liveVoiceOwnedRequests.removeValue(forKey: request.id)
                return "A sessão foi encerrada. O cancelamento da tarefa foi solicitado; isso não desfaz efeitos já executados."
            }
            currentTurn = turn; streamingText = ""
            beginPolling(turn, scope: currentThreadScope(request.scope.threadID), client: client)
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                guard liveVoiceScopeMatches(request.scope), !Task.isCancelled else {
                    _ = try? await client.cancelTurn(id: turn.id)
                    liveVoiceOwnedRequests.removeValue(forKey: request.id)
                    return "A sessão foi encerrada e o cancelamento da tarefa foi solicitado."
                }
                let observed = try await client.getTurn(id: turn.id)
                guard observed.clientRequestId == requestID, observed.threadId == request.scope.threadID,
                      observed.botId == request.scope.botID else { throw HostClientError.contractMismatch }
                if observed.state.isTerminal {
                    liveVoiceOwnedRequests.removeValue(forKey: request.id)
                    guard observed.state == .completed, let outputID = observed.outputMessageId else {
                        return "A tarefa terminou sem resultado confirmado. Confira o estado no chat."
                    }
                    let history = try await client.allMessages(threadID: request.scope.threadID)
                    guard let reply = history.first(where: { $0.id == outputID && $0.role == .assistant }) else {
                        return "A tarefa terminou, mas não consegui confirmar a resposta no histórico."
                    }
                    return String(reply.content.prefix(4_500))
                }
                try await Task.sleep(for: .milliseconds(750))
            }
            return "A tarefa continua em andamento. Confira o chat e as aprovações; não iniciei outra execução."
        } catch {
            // An uncertain POST may already have committed. Keep its request ID for cancellation/reconciliation.
            return "Não foi possível confirmar o resultado da tarefa. O pedido não foi reenviado; confira a conversa."
        }
    }

    func cancelLiveVoiceWork(client: HostClient, hostID: String) async {
        let owned = liveVoiceOwnedRequests.filter { $0.value.scope.hostID == hostID }
        for (id, item) in owned {
            do {
                let turn: Turn?
                if let turnID = item.turnID { turn = try await client.getTurn(id: turnID) }
                else { turn = try await client.listTurns(threadID: item.scope.threadID, limit: 100).items.first { $0.clientRequestId == item.requestID } }
                if let turn {
                    guard turn.clientRequestId == item.requestID, turn.threadId == item.scope.threadID,
                          turn.botId == item.scope.botID else { continue }
                    if !turn.state.isTerminal { _ = try await client.cancelTurn(id: turn.id) }
                    liveVoiceOwnedRequests.removeValue(forKey: id)
                }
            } catch {
                if nativeProjectionHostID == hostID {
                    liveVoiceNotice = String(localized: "Não foi possível confirmar o cancelamento de uma tarefa Live. Confira seu estado no chat.")
                }
            }
        }
    }
}

// MARK: - Effective engine and storage recovery (UX-P0-01/02)

/// A first-use bot creation the app could not confirm. `POST /v1/bots` has no client request ID or receipt, so an
/// uncertain outcome is never re-sent: only a read of the bot list, compared with the IDs read before the POST,
/// can confirm it.
public struct FirstUseBotAttempt: Equatable, Sendable {
    public let name: String
    public let engine: EngineID
    let knownBotIDs: Set<String>
    let hostScope: UUID
    let hostAddress: String
}

public enum FirstUseBotOutcome: Equatable, Sendable {
    case created(botID: String)
    /// The host answered with a definitive refusal; nothing was created.
    case refused(message: String)
    /// Sent, outcome unknown. Only `reconcileFirstUseBot` may follow.
    case unconfirmed(FirstUseBotAttempt)
    /// A fresh list shows no new bot for the attempt. A new POST is a new explicit owner decision.
    case notFound(FirstUseBotAttempt)
    /// More than one new bot matches; the owner picks one in the sidebar.
    case ambiguous(count: Int)
    /// The base, connection or owner changed; the result belongs to a previous context.
    case stale
}


extension DexterAppModel {
    /// The engine of the conversation on screen, bound to the selected bot on this host; never another thread's
    /// selection and never the bot default while the presented thread's own selection is still unread.
    public var effectiveConversationEngine: EffectiveConversationEngine {
        guard let bot = selectedBot else { return .none }
        guard let threadID = presentedThreadID else { return .known(bot.engine, source: .botDefault, botDefault: bot.engine) }
        guard engineSelectionThreadID == threadID, let state = threadEngineSelection,
              let engine = EngineID(rawValue: state.selection.engine) else { return .loading(botDefault: bot.engine) }
        return .known(engine, source: state.override == nil ? .botDefault : .conversation, botDefault: bot.engine)
    }

    /// Chat banner state for the effective engine of the presented conversation.
    public var conversationEngineStatus: ConversationEngineStatus {
        let effective = effectiveConversationEngine
        return ConversationEngineStatus(engine: effective,
            hostOnline: canUseHost && isOnline && !isFixture && readinessHealth != nil,
            routing: readinessHealth?.routing ?? .unknown,
            observation: effective.engine.flatMap { readinessEngines[$0] },
            catalog: engineCatalogObservedAt.map { OnboardingEngineCatalog(entries: engineCatalog, observedAt: $0) },
            lookup: engineCatalogLookup)
    }

    /// Release recovery of an unreadable local snapshot, after the owner confirmed: the snapshot is removed and the
    /// app reconnects to this Mac's own base (`localAddress`), never to the demo fixture. Nothing is resent; a pending
    /// ID that was inside the damaged bytes stays unrecoverable, as the confirmation explains. Call `refresh()` next.
    @discardableResult
    public func recoverCorruptStorage(localAddress: String) -> Bool {
        guard hasCorruptStoredData, DexterAppStateValidation.validatedLoopbackAddress(localAddress) != nil else { return false }
        invalidateHostWork()
        stateStorage.removeData()
        hasCorruptStoredData = false
        pendingRequestRecords = []
        lastSelection = nil
        uncertainRequestIDs = []
        pendingSubmission = nil
        persistenceNotice = nil
        hostAddress = localAddress
        configureHost()
        return persistedMode == .loopback && !isFixture && client != nil
    }

    /// When the current catalog was read (Assistentes › "Verificado há…"); nil when never read on this host.
    public var engineCatalogCheckedAt: Date? {
        guard engineCatalogLookup == .loaded, let observed = engineCatalogObservedAt else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(observed) / 1_000)
    }

    public var canCreateFirstUseBot: Bool { canEditBotProfiles && isOnline }

    /// First use only. Reads the bot list, then sends exactly one `POST /v1/bots`. Definitive refusals are reported;
    /// every other failure is `.unconfirmed` and is never retried here.
    public func createFirstUseBot(name: String, engine: EngineID) async -> FirstUseBotOutcome {
        guard canCreateFirstUseBot, let client else {
            return .refused(message: DexterLocalization.text("Creating bots requires a connection to the local host."))
        }
        let scope = nativeComposerScope, address = hostAddress, host = hostGeneration
        func current() -> Bool { isCurrentHost(host) && nativeComposerScope == scope && hostAddress == address && canEditBotProfiles }
        let known: Set<String>
        do { known = Set(try await client.listBots().map(\.id)) }
        catch {
            guard current() else { return .stale }
            return .refused(message: safeMessage(for: error))
        }
        guard current(), !Task.isCancelled else { return .stale }
        let attempt = FirstUseBotAttempt(name: name, engine: engine, knownBotIDs: known, hostScope: scope, hostAddress: address)
        do {
            let bot = try await client.createBot(CreateBotInput(name: name, profileId: "default", engine: engine))
            guard current() else { return .stale }
            adoptFirstUseBot(bot)
            return .created(botID: bot.id)
        } catch let error as HostClientError where Self.firstUseRefusalIsDefinitive(error) {
            guard current() else { return .stale }
            return .refused(message: safeMessage(for: error))
        } catch {
            guard current() else { return .stale }
            return .unconfirmed(attempt)
        }
    }

    /// "Conferir": a read of the bot list only. Adopts exactly one new matching bot; never sends a POST.
    public func reconcileFirstUseBot(_ attempt: FirstUseBotAttempt) async -> FirstUseBotOutcome {
        guard canCreateFirstUseBot, let client, attempt.hostScope == nativeComposerScope, attempt.hostAddress == hostAddress else { return .stale }
        let host = hostGeneration
        func current() -> Bool { isCurrentHost(host) && attempt.hostScope == nativeComposerScope && attempt.hostAddress == hostAddress && canEditBotProfiles }
        do {
            let listed = try await client.listBots()
            guard current() else { return .stale }
            let matches = listed.filter { !attempt.knownBotIDs.contains($0.id) && $0.name == attempt.name && $0.engine == attempt.engine }
            switch matches.count {
            case 0: return .notFound(attempt)
            case 1: adoptFirstUseBot(matches[0]); return .created(botID: matches[0].id)
            default:
                for bot in matches where !bots.contains(where: { $0.id == bot.id }) { bots.append(bot); threadsByBot[bot.id] = threadsByBot[bot.id] ?? [] }
                botProfileGeneration &+= 1
                return .ambiguous(count: matches.count)
            }
        } catch {
            guard current() else { return .stale }
            return .unconfirmed(attempt)
        }
    }

    /// Statuses the host returns before admitting the write; anything else may have created the bot.
    static func firstUseRefusalIsDefinitive(_ error: HostClientError) -> Bool {
        [.invalidRequest, .forbidden, .notReady, .conflict, .invalidConfiguration, .remotePairingUnavailable].contains(error)
    }

    private func adoptFirstUseBot(_ bot: Bot) {
        botProfileGeneration &+= 1
        if !bots.contains(where: { $0.id == bot.id }) { bots.append(bot) }
        threadsByBot[bot.id] = threadsByBot[bot.id] ?? []
        isOnline = true
        selectBot(id: bot.id)
    }

    /// "Copiar relatório de diagnóstico": plain current facts for support. No address, port, path, ID, account,
    /// message, key or token is included; the owner copies it explicitly.
    public func diagnosticReport(appVersion: String, systemVersion: String, localEngines: String?, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        var lines = ["Dexter \(appVersion)", "macOS \(systemVersion)",
                     t("Base: ", "Base: ") + backendLabel,
                     t("Conexão utilizável: ", "Usable connection: ") + (canUseHost && isOnline ? t("sim", "yes") : t("não", "no")),
                     t("Armazenamento local: ", "Local storage: ") + (requiresStorageReset ? t("ilegível", "unreadable") : t("legível", "readable"))]
        if let localEngines { lines.append(t("Assistentes aplicados neste Mac: ", "Assistants applied on this Mac: ") + localEngines) }
        switch engineCatalogLookup {
        case .loaded:
            for engine in EngineID.allCases {
                lines.append("\(engine.displayName): " + EngineReadiness(entry: engineCatalog.first { $0.id == engine.rawValue }).label(portuguese: portuguese))
            }
        case .loading: lines.append(t("Assistentes: consultando", "Assistants: checking"))
        case .notLoaded: lines.append(t("Assistentes: não consultados nesta sessão", "Assistants: not read this session"))
        case .failed: lines.append(t("Assistentes: a base não respondeu", "Assistants: the base did not answer"))
        }
        switch effectiveConversationEngine {
        case .none: break
        case .loading: lines.append(t("Conversa atual: modelo ainda não lido", "Current conversation: model not read yet"))
        case .known(let engine, let source, _):
            lines.append(t("Conversa atual: ", "Current conversation: ") + engine.displayName + " · "
                + (source == .conversation ? t("escolhido nesta conversa", "chosen in this conversation") : t("padrão do bot", "bot default")))
        }
        let status: String
        switch onboardingReadiness.conversation {
        case .fixture: status = t("demonstração", "demo")
        case .blocked: status = t("algo impede responder", "something stops replies")
        case .unconfirmed: status = t("disponível; login não confirmado", "available; sign-in not confirmed")
        case .ready: status = t("pronta", "ready")
        }
        lines.append(t("Estado da conversa: ", "Conversation status: ") + status)
        return lines.joined(separator: "\n")
    }

    // MARK: Other base (UX-P1-07)

    /// Checks the invitation's shape first: pasted text that is not an invitation for this kind of app changes nothing
    /// and the current base stays connected. A valid one goes through the unchanged `importPairingBundle`.
    @discardableResult
    public func importPairingInvitation(_ data: Data) -> PairingInvitationOutcome {
        #if os(iOS)
        let role = ClientRole.clientIOS
        #else
        let role = ClientRole.clientMac
        #endif
        guard (try? ImportedClientOffer.decode(data, platform: role)) != nil else { return .notAnInvitation }
        importPairingBundle(data)
        return pairing.state == .readyToProvision || pairing.state == .identityReady ? .accepted : .refused
    }

    /// True while this app shows the base at `localAddress` (this Mac's own): not a paired base, the demo or nothing.
    public func isUsingThisMacBase(localAddress: String) -> Bool {
        guard pairedBinding == nil, !isFixture, !remotePairingPending, client != nil,
              let local = DexterAppStateValidation.validatedLoopbackAddress(localAddress) else { return false }
        return DexterAppStateValidation.validatedLoopbackAddress(hostAddress) == local
    }

    /// "Voltar à base deste Mac": the same loopback switch `configureHost` makes. The paired client is only closed here;
    /// nothing is revoked or forgotten on either base and no grant changes. Returns whether the app now uses this Mac.
    @discardableResult
    public func returnToThisMacBase(localAddress: String) async -> Bool {
        guard !hasCorruptStoredData, let local = DexterAppStateValidation.validatedLoopbackAddress(localAddress) else { return false }
        hostAddress = local
        configureHost()
        guard isUsingThisMacBase(localAddress: local) else { return false }
        await refresh()
        await refreshDevices()
        return true
    }
}

#if os(macOS)
// MARK: Voice entry (UX-P1-13)

public extension DexterAppModel {
    /// The single voice entry's inputs for the open private conversation, from real state only: the conversation's
    /// effective engine (never the bot default while it loads), the host's native-call answer, and Live's own setup.
    func voiceEntryInput(threadID: String, native controller: CodexNativeVoiceController?) -> VoiceEntryInput {
        let reading: NativeVoiceReading
        if let controller {
            if controller.phase == .checking {
                reading = .reading
            } else if let status = controller.status, status.threadId == threadID {
                reading = .read(supported: status.supported, code: status.code, cliVersion: status.cliVersion)
            } else if case .offline? = controller.failure {
                reading = .failed
            } else if case .scopeChanged? = controller.failure {
                reading = .failed
            } else {
                reading = .notRead
            }
        } else {
            reading = .notRead
        }
        let nativeOpen = controller.map { controller in
            controller.hasUnconfirmedRequest || controller.hasLocalMedia || controller.session?.terminal == false
                || [.starting, .connecting, .active, .stopping, .unconfirmed].contains(controller.phase)
        } ?? false
        let replyBusy = isSubmitting || pendingSubmission != nil || isUpdatingEngineSelection
            || currentTurn?.state == .queued || currentTurn?.state == .running
        let liveConfigured = liveVoiceSettings?.enabled == true && liveVoiceKeyConfigured
            && liveVoiceSettings?.hostID == nativeProjectionHostID
        return VoiceEntryInput(
            privateBotConversation: selectedTeamID == nil && selectedBot != nil && selectedThreadID == threadID,
            isDemo: isFixture, ownerLocalBase: canEditBotProfiles && isOnline, replyBusy: replyBusy,
            engine: effectiveConversationEngine, native: reading, nativeSessionOpen: nativeOpen,
            liveConfigured: liveConfigured, liveActive: liveVoiceController.isSessionActive)
    }
}
#endif

/// Result of pasting an invitation in "Conectar a outra base…".
public enum PairingInvitationOutcome: Equatable, Sendable {
    /// Not an invitation for this kind of app: nothing was imported and the current base is untouched.
    case notAnInvitation
    /// Imported; the next step is "Pedir aprovação".
    case accepted
    /// An invitation, but the pairing model refused it (its state says why).
    case refused
}

#if os(macOS)
// MARK: Files and managed app connections (Arquivos / Conectar apps)

public extension DexterAppModel {
    /// A local runtime restart must not interrupt queued/unknown sends, engine changes, device effects or either voice
    /// controller. Read the durable turn state directly: stopping observation alone does not stop a running turn.
    var localRuntimeSetupBusy: Bool {
        isSubmitting || pendingSubmission != nil || isUpdatingEngineSelection
            || currentTurn?.state == .queued || currentTurn?.state == .running
            || !operatingDeviceIDs.isEmpty || liveVoiceController.isSessionActive || !liveVoiceOwnedRequests.isEmpty
            || codexVoiceControllers.values.contains { controller in
                controller.hasUnconfirmedRequest || controller.hasLocalMedia || controller.session?.terminal == false
                    || [.starting, .connecting, .active, .stopping, .unconfirmed].contains(controller.phase)
            }
    }

    /// Identity of the base this window shows right now (window scope + host address + paired installation + host
    /// generation). Files and connections UIs bind to it and are rebuilt when it changes.
    var filesScope: String {
        "\(nativeComposerScope)|\(hostAddress)|\(pairedBinding?.installationID ?? "loopback")|\(hostGeneration)"
    }

    /// The base whose output folders this window may show: the paired base (VPS) whenever one is configured — even while
    /// it is offline or its pairing is not usable — otherwise this Mac's own owner base. No base or the demo → nil.
    /// Never one in place of the other: a paired base that cannot be reached shows as unreachable, not as this Mac.
    var outputFilesBase: OutputFilesBase? {
        if isFixture { return nil }
        if let pairedBinding { return .remote(hostID: pairedBinding.installationID) }
        return canEditBotProfiles ? .thisMac : nil
    }

    /// A session bound to the current base: its own loopback client for this Mac's base, or the model's paired client
    /// for a paired base (same host generation; never the local client for a VPS).
    func makeOutputFilesSession() -> OutputFilesSession? {
        switch outputFilesBase {
        case .thisMac?:
            guard let local = makeLocalMcpClient() else { return nil }
            return OutputFilesSession(base: .thisMac, client: local, ownsClient: true, scope: filesScope)
        case .remote(let hostID)?:
            guard canUseHost, let client, pairedBinding?.installationID == hostID,
                  case .pairedHost(let binding) = client.accessPolicy, binding.installationID == hostID else { return nil }
            return OutputFilesSession(base: .remote(hostID: hostID), client: client, ownsClient: false, scope: filesScope)
        case nil:
            return nil
        }
    }

    /// Managed app connections are owner-loopback only: nil for a paired base, the demo or no base.
    func makeManagedConnectAppsEditor() -> ManagedConnectAppsEditor? {
        guard pairedBinding == nil, canEditBotProfiles, let local = makeLocalMcpClient() else { return nil }
        return ManagedConnectAppsEditor(client: local, ownsClient: true, scope: filesScope)
    }

    /// True when the window shows a paired base (the files UI then needs the base's outputs.* scopes).
    var showsPairedBase: Bool { pairedBinding != nil }
}
#endif

extension DexterAppModel {
    /// Identity of the base the connections UI shows (window scope, address, paired installation, host generation).
    public var connectionsScope: String {
        "\(nativeComposerScope)|\(hostAddress)|\(pairedBinding?.installationID ?? "loopback")|\(hostGeneration)"
    }

    /// True when the connections UI reads a paired base (its owner-granted scopes decide what is shown and changed).
    public var connectionsArePaired: Bool { pairedBinding != nil }

    /// Connections of the base this window shows: this Mac's own base over owner loopback, or the paired base through the
    /// model's own paired client when its owner granted `connections.read` or `mcp.read`. Nil for the demo, no base or a
    /// paired base without those scopes; never the other base in place of this one.
    public func makeConnectionsEditor() -> ManagedConnectAppsEditor? {
        #if os(macOS)
        if pairedBinding == nil { return makeManagedConnectAppsEditor() }
        #endif
        guard let client = remoteConnectionsClient, client.connectionsAccess.read || client.connectionsAccess.mcpRead else { return nil }
        return ManagedConnectAppsEditor(client: client, ownsClient: false, scope: connectionsScope)
    }

    /// The model's own paired client for the paired base this window shows (never closed by connection editors).
    var remoteConnectionsClient: HostClient? {
        guard canUseHost, !isFixture, let client, case .pairedHost(let binding) = client.accessPolicy,
              pairedBinding?.installationID == binding.installationID else { return nil }
        return client
    }

    /// The paired base's connection scopes as the approved binding states them (nil when no paired base).
    public var pairedConnectionsAccess: (read: Bool, manage: Bool, mcpRead: Bool, mcpManage: Bool)? {
        guard let client, case .pairedHost = client.accessPolicy, pairedBinding != nil else { return nil }
        return client.connectionsAccess
    }
}
