import DexterHostClient
import DexterAppCore
import SwiftUI
#if os(macOS)
import AppKit
import ImageIO
#elseif os(iOS)
import UIKit
#endif

struct ChatView: View {
    @Environment(\.locale) private var locale
    @Environment(DexterAppModel.self) private var model
    let threadID: String
    var routeBotID: String? = nil
    var presentationGeneration: UInt64? = nil
    /// Sidebar navigation supplies a live gate; direct conversation entry keeps the normal composer focus.
    var shouldFocusComposerOnEntry: () -> Bool = { true }
    /// Opens the settings of the action's own bot at Acessos; never changes access by itself.
    var openBotAccess: ((String) -> Void)? = nil
    /// Opens the settings of the turn's own bot at Modelo; never changes the selection by itself.
    var openBotModel: ((String) -> Void)? = nil
    #if os(macOS)
    /// Human preparation only. Never resends a failed or uncertain message.
    var prepareAssistant: ((EngineID) -> Void)? = nil
    /// UX-P0-03: Permitir on a Browser Use action first reconnects this Mac's base. nil leaves decisions unchanged.
    var browserUsePreflight: BrowserUseApprovalPreflight? = nil
    /// UX-P1-14: the inspector's "Ver no chat" shows that exact pending card in the approval queue. Navigation only.
    var approvalFocusRequest: ChatApprovalFocusRequest? = nil
    #endif
    @State private var draft = ""
    @State private var showsActionHistory = false
    /// Follow/read state of the transcript; local presentation only.
    @State private var transcriptScroll = ChatTranscriptScrollController()
    @State private var displayedApprovalID: String?
    @State private var approvalDecisionGate = ApprovalDecisionGate()
    private var decidingActionIDs: Set<String> { approvalDecisionGate.actionIDs }
    #if os(macOS)
    var composerPasteboard: NSPasteboard = .general
    @State private var draftImages: [ChatComposerImage] = []
    @State private var imagePasteFailure: String?
    @State private var isLoadingConversation = true
    @State private var loadFailure: String?
    @State private var loadToken = UUID()
    @State private var reloadRevision: UInt64 = 0
    @State private var isSending = false
    @State private var approvalReview: MacApprovalReviewSelection?
    @State private var reviewHasNativeFocus = false
    @State private var reviewStartedInComposer = false
    @State private var isComposerFocused = false
    @Environment(\.colorSchemeContrast) private var composerContrast
    @Environment(\.accessibilityReduceTransparency) private var composerReduceTransparency
    /// Registered MCP connections read from the local host only to label cards; nil = not read.
    @State private var mcpServers: [McpServerSummary]?
    /// Origins confirmed by GET continuation for the stoppable actions of `effectOriginsKey`; used only to group the
    /// stop menu. Missing entries mean "origin not confirmed", never a guess.
    @State private var effectOrigins: [String: String] = [:]
    @State private var effectOriginsKey = ""
    /// What the current control notice was about when it appeared, so a later request is never read as its subject.
    @State private var controlNoticeContext: ControlNoticeContext?
    /// Why the last Permitir on a Browser Use action was kept pending, for that action only.
    @State private var browserUseRefusal: (actionID: String, refusal: BrowserUseApprovalPreflight.Refusal)?
    private var conversationFailure: String? { loadFailure ?? model.errorMessage }
    #endif
    #if os(iOS)
    @State private var iosRouteToken = UUID()
    @State private var iosRouteAccepted = false
    @State private var iosRouteLoading = true
    @State private var iosRouteHostScope: UUID?
    @State private var iosRouteAddress: String?
    @State private var iosRouteGeneration: UInt64?
    private var iosRouteIsCurrent: Bool {
        iosRouteAccepted && iosRouteHostScope == model.nativeComposerScope && iosRouteAddress == model.hostAddress
            && model.selectedBotID == routeBotID && model.presentedThreadID == threadID
    }
    @State private var nativeComposer: NativeActionComposer?
    private var composerText: Binding<String> { Binding(get:{nativeComposer?.text ?? ""},set:{nativeComposer?.edit($0)}) }
    #else
    private var composerText: Binding<String> { $draft }
    #endif

    private var threadActions: [Action] { model.actions(for: threadID) }
    /// A running action in this conversation means the host is working through the queue right now.
    private var queueIsMoving: Bool { threadActions.contains { $0.state == .running } }
    private var showsControlDock: Bool {
        #if os(macOS)
        model.turnControlIdentity(in: threadID) != nil
        #else
        false
        #endif
    }
    /// Every submission path (send, retry, confirmation) is a human gesture; a new preview ID while submitting is one.
    private var transcriptHumanSendID: String? {
        #if os(macOS)
        isSending || model.isSubmitting ? model.outgoingMessagePreviewForActiveThread?.clientRequestID : nil
        #else
        model.isSubmitting ? model.outgoingMessagePreviewForActiveThread?.clientRequestID : nil
        #endif
    }
    /// Existing rule: a valid Mac approval review is never moved by the transcript.
    private var transcriptFollowPaused: Bool {
        #if os(macOS)
        if let approvalReview { return isCurrentApprovalReview(approvalReview.action.id) }
        #endif
        return false
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            GeometryReader { geometry in
                #if os(iOS)
                if iosRouteIsCurrent {
                    conversation(atMilliseconds: Int64(context.date.timeIntervalSince1970 * 1_000),
                        approvalHeightLimit: geometry.size.height * 0.45, compact: geometry.size.width < 620)
                } else if iosRouteLoading {
                    ProgressView()
                } else {
                    ContentUnavailableView("Conversa indisponível", systemImage: "bubble.left",
                        description: Text(DexterLocalization.text("The requested conversation could not be opened. Reopen the visible conversation before sending; your text has been kept.", locale: locale)))
                }
                #else
                conversation(atMilliseconds: Int64(context.date.timeIntervalSince1970 * 1_000),
                    approvalHeightLimit: geometry.size.height * 0.45, compact: geometry.size.width < 620)
                #endif
            }
        }
        #if os(macOS)
        .onChange(of: approvalFocusRequest) { _, request in focusApproval(request) }
        #endif
        #if os(iOS)
        .task(id: "\(routeBotID ?? "")|\(threadID)") { await enterIOSRoute() }
        .onChange(of: model.nativeComposerScope) { _, _ in invalidateIOSRoute() }
        .onChange(of: model.hostAddress) { _, _ in invalidateIOSRoute() }
        .onChange(of: model.nativeActionDraft) { _, value in
            if iosRouteIsCurrent { nativeComposer?.offer(value) }
        }
        .onDisappear {
            let ownsPresentation = iosRouteIsCurrent && iosRouteGeneration == model.threadPresentationGeneration
            invalidateIOSRoute()
            nativeComposer?.clearNative()
            if ownsPresentation { model.closeThreadPresentation() }
        }
        #endif
    }

    private func conversation(atMilliseconds now: Int64, approvalHeightLimit: CGFloat, compact: Bool = false) -> some View {
        let historicalActions = threadActions.filter { ApprovalPresentation(action: $0).isHistorical(atMilliseconds: now) }
        let executingActions = threadActions.filter { [.ready, .running].contains($0.state) }
        let hasPendingApproval = !pendingApprovalActions(atMilliseconds: now).isEmpty
        return VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if model.isFixture {
                            fixtureBanner
                        }
                        #if os(macOS)
                        let speaker = conversationSpeaker(atMilliseconds: now)
                        ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                            if ChatClock.startsNewDay(message.createdAt, after: index > 0 ? model.messages[index - 1].createdAt : nil) {
                                Text(verbatim: ChatClock.dayLabel(message.createdAt, locale: locale))
                                    .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                                    #if os(macOS)
                                    .chatCaptionBackdrop()
                                    #endif
                                    .frame(maxWidth: .infinity).padding(.top, index == 0 ? 0 : 6)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            MessageBubble(role: message.role, content: message.content, attachments: message.attachments ?? [], threadID: message.threadId,
                                          speaker: speaker, createdAt: message.createdAt)
                                .id(message.id)
                        }
                        #else
                        ForEach(model.messages) { message in
                            MessageBubble(role: message.role, content: message.content, attachments: message.attachments ?? [], threadID: message.threadId)
                                .id(message.id)
                        }
                        #endif
                        if let outgoing = model.outgoingMessagePreviewForActiveThread {
                            VStack(alignment: .trailing, spacing: 4) {
                                MessageBubble(role: .user, content: outgoing.content, pastedImages: outgoing.attachments)
                                Text(outgoingStatus(outgoing.state)).font(.system(size: 12)).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .trailing)
                            }
                            .id("outgoing-\(outgoing.clientRequestID)")
                        }
                        turnOutcome
                        if !model.streamingText.isEmpty {
                            #if os(macOS)
                            MessageBubble(role: .assistant, content: model.streamingText, isStreaming: model.isTurnGenerating, speaker: conversationSpeaker(atMilliseconds: now))
                                .id("streaming")
                            #else
                            MessageBubble(role: .assistant, content: model.streamingText, isStreaming: model.isTurnGenerating)
                                .id("streaming")
                            #endif
                        } else if model.isTurnGenerating, !hasPendingApproval, !showsControlDock, let turn = model.currentTurn {
                            // Status lives in the control dock when it is shown; never repeated here.
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text(LocalizedStringKey(turn.state == .queued ? "Na fila" : "Pensando…"))
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityLabel(LocalizedStringKey(turn.state == .queued ? "Turno na fila" : "Turno em andamento"))
                        }
                        #if os(macOS)
                        ForEach(executingActions, id: \.macApprovalRowID) { action in
                            approvalCard(action)
                        }
                        #else
                        ForEach(executingActions) { action in
                            approvalCard(action)
                        }
                        #endif
                        if !historicalActions.isEmpty {
                            DisclosureGroup(isExpanded: $showsActionHistory) {
                                // UX-P2-20: equal consecutive outcomes read as one row; each member keeps its own card.
                                ForEach(ApprovalHistoryGrouping.groups(historicalActions, atMilliseconds: now)) { group in
                                    if group.count == 1 {
                                        approvalCard(group.actions[0])
                                    } else {
                                        ApprovalHistoryGroupRow(group: group) { action in approvalCard(action) }
                                    }
                                }
                            } label: {
                                Label("Histórico de ações (\(historicalActions.count))", systemImage: "clock")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("chat.action-history")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    #if os(macOS)
                    .padding(.vertical, 24)
                    .modifier(MacConversationColumn())
                    #else
                    .padding()
                    .frame(maxWidth: 820, alignment: .leading)
                    #endif
                    .frame(maxWidth: .infinity)
                    .chatTranscriptContentProbe()
                }
                #if os(macOS)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay {
                    if model.messages.isEmpty && model.streamingText.isEmpty && model.currentTurn == nil && model.outgoingMessagePreviewForActiveThread == nil && threadActions.isEmpty {
                        VStack(spacing: 12) {
                            if isLoadingConversation {
                                ProgressView()
                                Text("Carregando conversa…")
                            } else if let error = conversationFailure {
                                Image(systemName: "exclamationmark.triangle")
                                    .font(.system(size: 28))
                                    .accessibilityHidden(true)
                                Text(DexterLocalization.text(error, locale: locale))
                            } else {
                                Image(systemName: "text.bubble")
                                    .font(.system(size: 28))
                                    .accessibilityHidden(true)
                                Text("Ainda não há mensagens nesta conversa.")
                            }
                        }
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(24)
                        .accessibilityIdentifier(isLoadingConversation ? "chat.loading" : (conversationFailure == nil ? "chat.empty" : "chat.unavailable"))
                        .allowsHitTesting(false)
                    }
                }
                #endif
                #if os(macOS)
                .chatTranscriptEdge()
                #endif
                // Follows new content only while at the end; reading history is never pulled down. A new preview
                // created by this person's own submission follows again; the approval review keeps its place.
                .chatTranscriptFollowing(transcriptScroll, proxy: proxy, bottomID: "bottom",
                    scope: { ChatScrollScope(host: model.hostAddress, hostScope: model.nativeComposerScope,
                        conversation: threadID, generation: model.threadPresentationGeneration) },
                    change: ChatTranscriptChange(count: model.messages.count, lastID: model.messages.last?.id,
                        streamingLength: model.streamingText.utf16.count,
                        previewID: model.outgoingMessagePreviewForActiveThread?.clientRequestID),
                    hasContent: !model.messages.isEmpty || !model.streamingText.isEmpty
                        || model.outgoingMessagePreviewForActiveThread != nil,
                    humanSendID: transcriptHumanSendID, isPaused: { transcriptFollowPaused })
            }

            #if os(macOS)
            controlDock(atMilliseconds: now)
            #else
            if model.currentTurn != nil, let control = model.turnControlIdentity(in: threadID) {
                HStack {
                    Label(LocalizedStringKey(hasPendingApproval ? "Aprovação pendente nesta conversa" : "Em execução"),
                        systemImage: hasPendingApproval ? "hand.raised" : "hourglass")
                    Spacer()
                    Button("Interromper", role: .destructive) { Task { await model.cancelTurn(control) } }
                        .accessibilityIdentifier("turn.cancel")
                }
                .font(.caption)
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            #endif
            if let notice = model.turnControlNotice {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        #if os(macOS)
                        if let earlier = controlNoticeEarlierStop {
                            Text(earlier).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("turn.control-status.earlier")
                        }
                        #endif
                        Text(notice).font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("turn.control-status")
                    }
                    #if os(macOS)
                    Button("Atualizar conversa", action: reloadConversation).font(.caption)
                        .disabled(model.turnControlInFlight || isLoadingConversation || !model.canUseHost)
                        .accessibilityIdentifier("turn.control-refresh")
                    #endif
                }.padding(.horizontal).padding(.vertical, 4)
                    .accessibilityElement(children: .contain)
            } else if model.currentTurn?.state == .queued {
                // A running action of this conversation proves the queue is moving; only otherwise mention a restart.
                Group {
                    if queueIsMoving {
                        Text("Esta mensagem está na fila e começa quando o pedido anterior terminar.")
                    } else {
                        Text("Na fila. Se o host foi reiniciado, a fila pode esperar sua retomada; o host não informa quais turnos estão retidos. Retomar libera os retidos desta conversa; Cancelar resposta encerra só o turno exibido.")
                    }
                }
                .font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.vertical, 4)
                .accessibilityIdentifier("turn.queued-explanation")
            }

            // Private inputs asked by MCP servers during a running action of this conversation (answered here, by the owner).
            McpPrivateInputStrip(scope: model.selectedTeamID == nil ? .thread(threadID) : .none,
                                 active: threadActions.contains { $0.state == .running })
            #if os(macOS)
            // Open connection setup requests of this conversation (owner's own base only); each opens its private flow.
            ConnectionSetupRequestStrip(threadID: model.selectedTeamID == nil ? threadID : nil,
                                        refreshKey: threadActions.map { "\($0.id):\($0.state.rawValue)" }.joined(separator: ","))
            #endif
            composer(atMilliseconds: now, approvalHeightLimit: approvalHeightLimit, compact: compact)
        }
        #if os(macOS)
        .navigationTitle(model.selectedTeam?.name ?? model.selectedBot?.name ?? DexterLocalization.text("Conversa", locale: locale))
        .navigationSubtitle(conversationSubtitle)
        .onChange(of: approvalReviewScope) { _, _ in clearApprovalReview() }
        .onChange(of: model.nativeComposerScope) { _, _ in draftImages = []; imagePasteFailure = nil }
        .onChange(of: threadID) { _, _ in draftImages = []; imagePasteFailure = nil }
        .onChange(of: threadActions) { _, _ in
            if let approvalReview, !isCurrentApprovalReview(approvalReview.action.id) { clearApprovalReview() }
        }
        .task(id: mcpServerKey) { await readMcpRegistry(key: mcpServerKey) }
        .task(id: effectOriginKey) { await readEffectOrigins(key: effectOriginKey) }
        .onChange(of: model.turnControlNotice, initial: true) { _, notice in captureControlNoticeContext(notice) }
        .onDisappear { clearApprovalReview() }
        #else
        .navigationTitle("Conversa")
        #endif
        .onChange(of: threadID) { _, _ in
            displayedApprovalID = nil
            showsActionHistory = false
        }
        .onChange(of: model.nativeComposerScope) { _, _ in
            displayedApprovalID = nil
            showsActionHistory = false
        }
        #if os(macOS)
        .onChange(of: model.errorMessage) { previous, current in
            guard model.presentedThreadID == threadID,
                  presentationGeneration == nil || presentationGeneration == model.threadPresentationGeneration else { return }
            // Only replace the copied host error, preserving a distinct local validation failure.
            if loadFailure == previous { loadFailure = current }
        }
        #endif
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        #if os(macOS)
        .task(id: "\(presentationGeneration.map(String.init) ?? threadID):\(reloadRevision)") {
            let token = UUID()
            loadToken = token
            isLoadingConversation = true
            loadFailure = nil
            defer {
                if !Task.isCancelled && loadToken == token { isLoadingConversation = false }
            }
            // Only a host refresh restores connectivity after an offline conversation read.
            // This task is driven by presentation/manual reload, never by the display timer.
            if !model.isOnline {
                let scope = model.nativeComposerScope
                await model.refresh()
                guard !Task.isCancelled, loadToken == token, scope == model.nativeComposerScope,
                      model.presentedThreadID == threadID else { return }
            }
            if let generation = presentationGeneration {
                await model.loadPresentedThread(threadID, generation: generation)
            } else {
                await model.openThread(threadID)
            }
            guard !Task.isCancelled, loadToken == token else { return }
            loadFailure = model.errorMessage
            if approvalReview == nil, shouldFocusComposerOnEntry() { isComposerFocused = true }
        }
        #endif
    }

    #if os(iOS)
    private func invalidateIOSRoute() {
        iosRouteToken = UUID()
        iosRouteAccepted = false
        iosRouteLoading = false
        nativeComposer?.invalidateHostScope()
    }

    /// The one entry task owns this route token. A host or navigation change never reopens an old route.
    private func enterIOSRoute() async {
        let token = UUID(), scope = model.nativeComposerScope, address = model.hostAddress
        iosRouteToken = token
        iosRouteAccepted = false
        iosRouteLoading = true
        iosRouteGeneration = nil
        defer { if iosRouteToken == token { iosRouteLoading = false } }
        guard let routeBotID else { return }
        if !model.isOnline {
            await model.refresh()
            guard !Task.isCancelled, iosRouteToken == token, scope == model.nativeComposerScope,
                  address == model.hostAddress else { return }
        }
        guard let generation = await model.enterPresentedThread(threadID, for: routeBotID),
              !Task.isCancelled, iosRouteToken == token, scope == model.nativeComposerScope,
              address == model.hostAddress, model.selectedBotID == routeBotID,
              model.presentedThreadID == threadID, model.threadPresentationGeneration == generation else { return }
        iosRouteHostScope = scope
        iosRouteAddress = address
        iosRouteGeneration = generation
        iosRouteAccepted = true
        nativeComposer = NativeActionComposer(threadID: threadID, hostScope: scope)
        nativeComposer?.offer(model.nativeActionDraft)
    }
    #endif

    #if os(macOS)
    private var approvalReviewScope: MacApprovalReviewScope {
        MacApprovalReviewScope(host: model.hostAddress, hostScope: model.nativeComposerScope,
            bot: model.selectedBotID, thread: model.selectedThreadID, displayedThread: threadID,
            generation: model.threadPresentationGeneration, hostAvailable: model.canUseHost && model.isOnline && !model.conversationObservationWasStopped)
    }

    private var reviewableActions: [Action] {
        eligibleApprovalActions(atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
    }

    private func isCurrentApprovalReview(_ id: String) -> Bool {
        guard let selection = approvalReview, selection.action.id == id,
              !decidingActionIDs.contains(id),
              selection.scope == approvalReviewScope,
              approvalReviewScope.thread == threadID,
              let current = threadActions.first(where: { $0.id == id }), current == selection.action else { return false }
        return ApprovalPresentation(action: current).canDecide(hostAvailable: approvalReviewScope.hostAvailable,
            atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
    }

    private func beginApprovalReview() {
        guard approvalReviewScope.thread == threadID,
              let action = reviewableActions.first(where: { $0.id == displayedApprovalID }) ?? reviewableActions.first else { return }
        reviewStartedInComposer = isComposerFocused
        isComposerFocused = false
        reviewHasNativeFocus = false
        model.traceApprovalInteraction(source: "review-enter", action: action, focused: false, intent: "request-native-focus")
        approvalReview = MacApprovalReviewSelection(scope: approvalReviewScope, action: action)
        displayedApprovalID = action.id
    }

    private func moveApprovalReview(_ direction: Int) {
        guard let selection = approvalReview, isCurrentApprovalReview(selection.action.id),
              let index = reviewableActions.firstIndex(where: { $0.id == selection.action.id }) else {
            clearApprovalReview(); return
        }
        let next = index + direction
        guard reviewableActions.indices.contains(next) else { return }
        approvalReview = MacApprovalReviewSelection(scope: approvalReviewScope, action: reviewableActions[next])
        displayedApprovalID = reviewableActions[next].id
    }

    private func clearApprovalReview(returnToComposer: Bool = false) {
        approvalReview = nil
        reviewHasNativeFocus = false
        if returnToComposer && shouldFocusComposerOnEntry() { isComposerFocused = true }
        reviewStartedInComposer = false
    }

    /// The thread's own bot answers here: the bot in a private conversation, the coordinator in a team.
    private func conversationSpeaker(atMilliseconds now: Int64) -> ChatSpeaker? {
        let botID = model.selectedThread.flatMap { $0.id == threadID ? $0.botId : nil } ?? model.selectedBotID
        guard let bot = model.bots.first(where: { $0.id == botID }) else { return nil }
        let activity = BotMascotObservedActivity.activity(botID: bot.id, threadID: threadID,
            currentTurn: model.currentTurn, actions: model.actions, streamingText: model.streamingText, now: now)
        return ChatSpeaker(id: bot.id, name: bot.name, avatar: AnyView(DexterAvatarView(image: bot.avatarImage, emoji: bot.avatarEmoji,
            fallbackSystemImage: bot.engine == .claude ? "sparkles" : "terminal", model: model, size: 32,
            appearance: bot.avatarAppearance, activity: activity, mascotSeed: bot.id)))
    }

    private var conversationSubtitle: String {
        if let team = model.selectedTeam {
            // Coordinator first, then the other members by name; only bots present in this host.
            let coordinator = model.bots.first { $0.id == team.coordinatorBotId }
            let others = team.botIds.filter { $0 != team.coordinatorBotId }.compactMap { id in model.bots.first { $0.id == id }?.name }
            let lead = DexterLocalization.format("Coordenador: %@", coordinator?.name ?? DexterLocalization.text("Indisponível", locale: locale), locale: locale)
            return others.isEmpty ? lead : lead + " · " + others.formatted(.list(type: .and).locale(locale))
        }
        guard let thread = model.selectedThread, thread.id == threadID else {
            return DexterLocalization.text("Conversa", locale: locale)
        }
        let date = Date(timeIntervalSince1970: TimeInterval(thread.createdAt) / 1_000)
            .formatted(date: .abbreviated, time: .shortened)
        return DexterLocalization.format("Conversa · %@", date, locale: locale)
    }
    #endif

    @ViewBuilder
    private func approvalCard(_ action: Action, atMilliseconds now: Int64 = Int64(Date().timeIntervalSince1970 * 1_000), showsDecisionControls: Bool = true,
                              queue: ApprovalQueueChrome? = nil) -> some View {
        let hostScope = model.nativeComposerScope
        #if os(macOS)
        VStack(alignment: .leading, spacing: 6) {
        ApprovalCard(action: action, hostUnavailable: !model.canUseHost || !model.isOnline || model.actionDecisionIsSuspended(action),
            decisionInFlight: decidingActionIDs.contains(action.id),
            decide: { decision in await decideAction(action, as: decision, hostScope: hostScope) },
            acceptType: approvalTypeDecisionCallback(action, hostScope: hostScope),
            preferenceNotice: model.approvalPreferenceDecisionNotices[action.id],
            recoverPreference: { await model.recoverApprovalPreferenceDecision(action) },
            retryPreference: { await model.recoverApprovalPreferenceDecision(action, retryExact: true) },
            showsDecisionControls: showsDecisionControls, queue: queue,
            communicationBotName: model.bots.first(where: { $0.id == action.request.botId })?.name,
            communicationTextAvailable: communicationTextAvailable(for: action, atMilliseconds: now),
            reviewIsSelected: reviewHasNativeFocus && approvalReview?.action.id == action.id && isCurrentApprovalReview(action.id),
            reviewIdentityIsCurrent: { isCurrentApprovalReview(action.id) },
            moveReview: moveApprovalReview,
            endReview: { returnToComposer in clearApprovalReview(returnToComposer: returnToComposer) },
            openAccess: openBotAccess.map { open in { clearApprovalReview(); open(action.request.botId) } },
            mcpConnection: mcpLookup(action))
        }
        #else
        ApprovalCard(action: action, hostUnavailable: !model.canUseHost || !model.isOnline,
            decisionInFlight: decidingActionIDs.contains(action.id),
            decide: { decision in await decideAction(action, as: decision, hostScope: hostScope) }, showsDecisionControls: showsDecisionControls, queue: queue)
        #endif
    }

    #if os(macOS)
    private func approvalTypeDecisionCallback(_ action: Action, hostScope: UUID) -> (@MainActor @Sendable () async -> Void)? {
        guard model.canEditBotProfiles else { return nil }
        return { await decideAction(action, as: .allow, hostScope: hostScope, alwaysAccept: true) }
    }
    #endif

    private func pendingApprovalActions(atMilliseconds now: Int64) -> [Action] {
        threadActions.filter { ApprovalPresentation(action: $0).needsDecision(atMilliseconds: now) }
    }

    private func eligibleApprovalActions(atMilliseconds now: Int64) -> [Action] {
        pendingApprovalActions(atMilliseconds: now).filter {
            !decidingActionIDs.contains($0.id) && !model.actionDecisionIsSuspended($0) && ApprovalPresentation(action: $0).canDecide(
                hostAvailable: model.canUseHost && model.isOnline && !model.conversationObservationWasStopped, atMilliseconds: now)
        }
    }

    #if os(macOS)
    private func communicationTextAvailable(for action: Action, atMilliseconds now: Int64) -> Bool {
        let eligible = eligibleApprovalActions(atMilliseconds: now)
        // AppModel still requires exactly one persisted awaitingApproval, including expired ones.
        // Never advertise text consent the current host/model contract will reject.
        return pendingApprovalActions(atMilliseconds: now).count == 1 && eligible.count == 1 &&
            eligible.first == action && threadActions.filter { $0.state == .awaitingApproval }.count == 1
    }
    #endif

    private func decideAction(_ action: Action, as decision: ApprovalDecision, hostScope: UUID, alwaysAccept: Bool = false) async {
        guard reserveDecision(action, hostScope: hostScope) else { return }
        // This reservation survives paging/recreation of an individual card while its HTTP request is in flight.
        defer { approvalDecisionGate.release(action.id) }
        #if os(macOS)
        guard await browserUseReady(action, decision: decision) else { return }
        #endif
        await model.decide(action, as: decision, alwaysAccept: alwaysAccept)
    }

    #if os(macOS)
    /// Runs inside the decision reservation, so a second click cannot race it. A refusal keeps the action pending and
    /// sends nothing; Negar and every other tool are untouched. "Sempre aceitar esse tipo" keeps its own atomic request.
    private func browserUseReady(_ action: Action, decision: ApprovalDecision) async -> Bool {
        guard decision == .allow, let browserUsePreflight, BrowserUseApprovalPreflight.applies(to: action) else { return true }
        if browserUseRefusal?.actionID == action.id { browserUseRefusal = nil }
        let outcome = await browserUsePreflight.prepare(action, threadID: threadID)
        guard case .refused(let refusal) = outcome else { return true }
        browserUseRefusal = (action.id, refusal)
        return false
    }
    #endif

    private func reserveDecision(_ action: Action, hostScope: UUID) -> Bool {
        guard model.selectedBotID == action.request.botId, !model.actionDecisionIsSuspended(action) else { return false }
        return approvalDecisionGate.reserve(action, expectedHostScope: hostScope, currentHostScope: model.nativeComposerScope,
            expectedGeneration: presentationGeneration ?? model.threadPresentationGeneration, currentGeneration: model.threadPresentationGeneration,
            visibleThread: threadID, selectedThread: model.selectedThreadID,
            currentAction: threadActions.first(where: { $0.id == action.id }),
            hostAvailable: model.canUseHost && model.isOnline && !model.conversationObservationWasStopped,
            atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
    }

    /// The one compact queue card: position, navigation, keyboard review and the single pinned decision bar.
    private func approvalQueueChrome(_ selected: Action, index: Int, pending: [Action], atMilliseconds now: Int64,
                                     heightLimit: CGFloat) -> ApprovalQueueChrome {
        #if os(macOS)
        let review: (() -> Void)? = beginApprovalReview
        let reviewEnabled = !reviewableActions.isEmpty && approvalReviewScope.thread == threadID
        #else
        let review: (() -> Void)? = nil, reviewEnabled = false
        #endif
        return ApprovalQueueChrome(position: index + 1, count: pending.count,
            previous: index > 0 ? { selectApproval(pending[index - 1]) } : nil,
            next: pending.indices.contains(index + 1) ? { selectApproval(pending[index + 1]) } : nil,
            review: review, reviewEnabled: reviewEnabled,
            // The whole card fits the composer's approval budget; its middle scrolls, the decision row never does.
            maxHeight: max(150, heightLimit),
            decisionBar: AnyView(pinnedDecisionBar(selected, atMilliseconds: now)))
    }

    #if os(macOS)
    /// The native review responder, exactly as before. It stays outside the card's `.id`, so ↑/↓ never remount it.
    private func approvalReviewResponder(_ selected: Action) -> some View {
        MacApprovalReviewResponder(selection: approvalReview,
            eligible: isCurrentApprovalReview(selected.id),
            focusChanged: { selection, focused in
                guard approvalReview == selection else { return }
                reviewHasNativeFocus = focused
                model.traceApprovalInteraction(source: "native-focus", action: selection.action,
                    focused: focused, intent: focused ? "focused" : "ended")
                if !focused { clearApprovalReview() }
            }, intent: { selection, intent, repeated in
                guard approvalReview == selection, isCurrentApprovalReview(selection.action.id) else { return }
                model.traceApprovalInteraction(source: "native-key", action: selection.action,
                    focused: reviewHasNativeFocus, repeated: repeated, intent: String(describing: intent))
                switch intent {
                case .move(let direction): moveApprovalReview(direction)
                case .exit: clearApprovalReview(returnToComposer: reviewStartedInComposer)
                case .decide(let decision): submitPinnedDecision(selection.action, decision: decision, source: "shortcut", requiresReview: true)
                case .consume, .ignore: break
                }
            }, keyTrace: { selection, keyCode, modifiers, repeated in
                guard approvalReview == selection else { return }
                model.traceApprovalInteraction(source: "native-key-event", action: selection.action,
                    focused: reviewHasNativeFocus, repeated: repeated, intent: "key-down",
                    keyCode: keyCode, modifierBits: modifiers)
            })
            .frame(width: 1, height: 1).accessibilityHidden(true)
    }
    #endif

    private func pinnedDecisionBar(_ action: Action, atMilliseconds now: Int64) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 8) {
                #if os(macOS)
                MacExactApprovalButton(title: DexterLocalization.text("Negar", locale: locale), identifier: "approval.deny.\(action.id)", action: { source in submitPinnedDecision(action, decision: .deny, source: source) })
                    .frame(width: 80, height: 32).accessibilityIdentifier("approval.deny.\(action.id)")
                MacExactApprovalButton(title: decidingActionIDs.contains(action.id) ? DexterLocalization.text("Enviando…", locale: locale) : DexterLocalization.text("Permitir", locale: locale),
                    identifier: "approval.allow.\(action.id)",
                    action: { source in submitPinnedDecision(action, decision: .allow, source: source) })
                    .frame(width: 100, height: 32).accessibilityIdentifier("approval.allow.\(action.id)")
                #else
                Button("Negar", role: .destructive) { submitPinnedDecision(action, decision: .deny, source: "button") }
                    .accessibilityIdentifier("approval.deny.\(action.id)")
                Button("Permitir") { submitPinnedDecision(action, decision: .allow, source: "button") }
                    .buttonStyle(.borderedProminent).accessibilityIdentifier("approval.allow.\(action.id)")
                #endif
            }
            .disabled(decidingActionIDs.contains(action.id) || model.actionDecisionIsSuspended(action) || preferenceOutcomeUnconfirmed(action) ||
                !ApprovalPresentation(action: action).canDecide(hostAvailable: model.canUseHost && model.isOnline, atMilliseconds: now))
            #if os(macOS)
            if reviewHasNativeFocus && isCurrentApprovalReview(action.id) {
                Text("↑/↓ mudar ação · ⌘⇧D negar · ⌘⇧P permitir · Esc sair")
                    .font(.caption).accessibilityIdentifier("approval.keyboard.\(action.id)")
            }
            #endif
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approval.decision-bar")
    }

    /// A saved-type decision whose outcome is unconfirmed suspends every new decision on that action until checked.
    private func preferenceOutcomeUnconfirmed(_ action: Action) -> Bool {
        #if os(macOS)
        ["unknown", "receipt_missing"].contains(model.approvalPreferenceDecisionNotices[action.id] ?? "")
        #else
        false
        #endif
    }

    private func submitPinnedDecision(_ action: Action, decision: ApprovalDecision, source: String, requiresReview: Bool = false) {
        guard !preferenceOutcomeUnconfirmed(action) else { return }
        let hostScope = model.nativeComposerScope
        let generation = presentationGeneration ?? model.threadPresentationGeneration
        #if os(macOS)
        guard !requiresReview || (reviewHasNativeFocus && isCurrentApprovalReview(action.id)) else { return }
        model.traceApprovalInteraction(source: source, action: action, focused: reviewHasNativeFocus, intent: decision.rawValue)
        #endif
        guard reserveDecision(action, hostScope: hostScope) else { return }
        // Reserve synchronously, including native button and shortcut callbacks in the same runloop.
        #if os(macOS)
        clearApprovalReview()
        #endif
        Task {
            defer { approvalDecisionGate.release(action.id) }
            guard hostScope == model.nativeComposerScope, model.selectedThreadID == threadID,
                  generation == model.threadPresentationGeneration, model.selectedBotID == action.request.botId,
                  threadActions.first(where: { $0.id == action.id }) == action,
                  !model.actionDecisionIsSuspended(action),
                  ApprovalPresentation(action: action).canDecide(hostAvailable: model.canUseHost && model.isOnline,
                    atMilliseconds: Int64(Date().timeIntervalSince1970 * 1000)) else { return }
            #if os(macOS)
            guard await browserUseReady(action, decision: decision) else { return }
            // The reconnect awaited the base: the decision still belongs to the same rendered action and conversation.
            guard hostScope == model.nativeComposerScope, model.selectedThreadID == threadID,
                  generation == model.threadPresentationGeneration, model.selectedBotID == action.request.botId,
                  threadActions.first(where: { $0.id == action.id }) == action, !model.actionDecisionIsSuspended(action) else {
                if decision == .allow, BrowserUseApprovalPreflight.applies(to: action) { browserUseRefusal = (action.id, .changed) }
                return
            }
            #endif
            await model.decide(action, as: decision)
        }
    }

    #if os(macOS)
    /// Fixed between the transcript and the composer, outside any scroll view, so it stays reachable while the
    /// approval panel is open. Two exact paths, never chained by the UI:
    /// - Parar resposta: cancelTurn on the rendered current turn (the host also withdraws actions that turn asked for).
    /// - Parar ações deste pedido: cancelEffects on one rendered ready/running action; the model resolves its origin
    ///   by canonical GETs before one POST, and stops every action of that origin.
    /// ⌘. targets Parar resposta when a turn is stoppable, otherwise the only stoppable action; with several origins
    /// and no turn there is no shortcut. It never approves, denies or confirms anything.
    @ViewBuilder
    private func controlDock(atMilliseconds now: Int64) -> some View {
        let turn = model.currentTurn
        let turnControl = model.turnControlIdentity(in: threadID)
        let effectControls = threadActions.filter { [.ready, .running].contains($0.state) }.compactMap { model.effectControlIdentity(for: $0) }
        // A pending approval alone is already the card above; the dock appears only with something to stop.
        if turnControl != nil || !effectControls.isEmpty {
            // One row when it fits; otherwise status on top and full-width buttons below. Labels never truncate.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 10) {
                    dockStatus(turn: turnControl == nil ? nil : turn, effects: effectControls)
                        .fixedSize()
                    Spacer(minLength: 8)
                    dockButtons(turn: turn, turnControl: turnControl, effectControls: effectControls)
                }
                VStack(alignment: .leading, spacing: 6) {
                    dockStatus(turn: turnControl == nil ? nil : turn, effects: effectControls)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        dockButtons(turn: turn, turnControl: turnControl, effectControls: effectControls)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    dockStatus(turn: turnControl == nil ? nil : turn, effects: effectControls)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .trailing, spacing: 6) {
                        dockButtons(turn: turn, turnControl: turnControl, effectControls: effectControls)
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
            .padding(.top, 6)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("turn.control-dock")
            .modifier(MacConversationColumn())
        }
    }

    @ViewBuilder
    private func dockButtons(turn: Turn?, turnControl: DexterAppModel.TurnControlIdentity?, effectControls: [DexterAppModel.EffectControlIdentity]) -> some View {
        if let turn, let turnControl, turn.state == .queued, !queueIsMoving {
            Button("Retomar") { Task { await model.resumeQueuedTurns(turnControl) } }
                .fixedSize()
                .disabled(model.turnControlInFlight || model.conversationObservationWasStopped || !model.isOnline)
                .help("Use se a fila não andar: depois de reiniciar o host, turnos podem ficar retidos. Libera todos os retidos desta conversa; não reenvia mensagens nem decisões.")
                .accessibilityIdentifier("turn.resume-queued")
        }
        if let turn, let turnControl {
            Button(role: .destructive) {
                // Capture the rendered turn, never resolve a different currentTurn after redraw/await.
                clearApprovalReview()
                Task { await model.cancelTurn(turnControl) }
            } label: {
                Label(model.turnControlInFlight ? "Parando…" : (turn.state == .queued ? "Cancelar resposta" : "Parar resposta"),
                      systemImage: "stop.circle")
            }
            .fixedSize()
            .modifier(StopShortcut(enabled: true))
            .disabled(model.turnControlInFlight || model.conversationObservationWasStopped)
            .help("Para a resposta atual deste bot e retira as ações que ela pediu e ainda não terminaram. O que já foi feito não é desfeito. Atalho: ⌘.")
            .accessibilityIdentifier("turn.cancel")
        }
        let choices = effectStopChoices(effectControls)
        // The queued turn has not started, so a running action shown next to it comes from the request before it.
        let earlierRequest = turn?.state == .queued
        if choices.count == 1, let choice = choices.first,
           let control = effectControls.first(where: { $0.action.id == choice.representativeActionID }) {
            let count = choice.actionIDs.count, countText = String(choice.actionIDs.count)
            Button(role: .destructive) {
                clearApprovalReview()
                Task { await model.cancelEffects(control) }
            } label: {
                if count > 1 {
                    Label(earlierRequest ? "Parar as \(countText) ações do pedido anterior" : "Parar as \(countText) ações deste pedido", systemImage: "stop.circle")
                } else {
                    Label(earlierRequest ? "Parar ações do pedido anterior" : "Parar ações deste pedido", systemImage: "stop.circle")
                }
            }
            .fixedSize()
            .modifier(StopShortcut(enabled: turnControl == nil))
            .disabled(model.turnControlInFlight)
            .help("Pede ao host para parar todas as ações do mesmo pedido de “\(ApprovalPresentation(action: control.action).title)”, inclusive as que ainda aguardam. O que já foi feito não é desfeito.\(turnControl == nil ? " " + DexterLocalization.text("Atalho: ⌘.", locale: locale) : "")")
            .accessibilityIdentifier("approval.stop.\(control.action.id)")
        } else if choices.count > 1 {
            let labels = effectStopLabels(choices, controls: effectControls)
            Menu {
                Section("Cada opção interrompe todas as ações do mesmo pedido") {
                    ForEach(choices) { choice in
                        if let control = effectControls.first(where: { $0.action.id == choice.representativeActionID }) {
                            Button(labels[choice.id] ?? choice.id, role: .destructive) {
                                clearApprovalReview()
                                Task { await model.cancelEffects(control) }
                            }
                            .accessibilityIdentifier("approval.stop.\(control.action.id)")
                        }
                    }
                }
            } label: {
                Label("Parar ações…", systemImage: "stop.circle")
            }
            .fixedSize()
            .disabled(model.turnControlInFlight)
            .help("Escolha o que parar. Cada opção pede ao host para parar o pedido de origem daquela ação, e todas as ações desse pedido param juntas. Linhas com origem não confirmada podem ser do mesmo pedido. O que já foi feito não é desfeito.")
            .accessibilityIdentifier("turn.stop-actions-menu")
        }
    }

    /// Menu lines in plain words: tool, time and, only where two lines would read the same, what the action touches
    /// (command, file) and then its order ("ação 1 de 2"). No raw ID here: the card's Detalhes técnicos keep it.
    private func effectStopLabels(_ choices: [EffectStopChoice], controls: [DexterAppModel.EffectControlIdentity]) -> [String: String] {
        let portuguese = locale.language.languageCode?.identifier == "pt"
        var details: [String: String] = [:]
        for control in controls {
            let presentation = ApprovalPresentation(action: control.action)
            guard let value = presentation.summaryFields.first?.value.split(whereSeparator: \.isNewline).first.map(String.init)?
                    .trimmingCharacters(in: .whitespaces), !value.isEmpty, value != presentation.title else { continue }
            details[control.action.id] = value.count > 36 ? String(value.prefix(35)) + "…" : value
        }
        func line(_ choice: EffectStopChoice, detailed: Bool) -> String {
            var unique: [String] = []
            for title in choice.titles where !unique.contains(title) { unique.append(title) }
            var names = unique.prefix(2).map { "“\($0)”" }.joined(separator: ", ") + (unique.count > 2 ? "…" : "")
            if detailed, choice.actionIDs.count == 1, let detail = details[choice.representativeActionID] { names += " · " + detail }
            let at = actionClock(choice.earliestCreatedAt)
            if choice.originTurnID != nil {
                let count = choice.actionIDs.count
                return portuguese ? "Pedido das \(at) · \(names) · \(count == 1 ? "1 ação" : "\(count) ações")"
                                  : "Request from \(at) · \(names) · \(count == 1 ? "1 action" : "\(count) actions")"
            }
            return portuguese ? "\(names) · \(at) · origem não confirmada" : "\(names) · \(at) · origin not confirmed"
        }
        func repeated(_ values: [String]) -> Set<Int> {
            Set(values.indices.filter { index in values.indices.contains { $0 != index && values[$0] == values[index] } })
        }
        var values = choices.map { line($0, detailed: false) }
        for index in repeated(values) { values[index] = line(choices[index], detailed: true) }
        // Still equal (same tool, second and target): number them in the order they started.
        var groups: [String: [Int]] = [:]
        for index in repeated(values).sorted() { groups[values[index], default: []].append(index) }
        for members in groups.values {
            for (position, index) in members.enumerated() {
                let unit = choices[index].originTurnID == nil ? (portuguese ? "ação" : "action") : (portuguese ? "pedido" : "request")
                values[index] += portuguese ? " · \(unit) \(position + 1) de \(members.count)" : " · \(unit) \(position + 1) of \(members.count)"
            }
        }
        return Dictionary(zip(choices.map(\.id), values), uniquingKeysWith: { first, _ in first })
    }

    /// Stoppable actions grouped by origin when the host confirmed it; otherwise one line per action.
    private func effectStopChoices(_ controls: [DexterAppModel.EffectControlIdentity]) -> [EffectStopChoice] {
        let candidates = controls.map { EffectStopCandidate(actionID: $0.action.id, title: ApprovalPresentation(action: $0.action).title, createdAt: $0.action.createdAt) }
        return EffectStopGrouping.choices(candidates, confirmedOrigins: effectOriginsKey == effectOriginKey ? effectOrigins : [:])
    }

    private func actionClock(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1_000).formatted(Date.FormatStyle(date: .omitted, time: .standard).locale(locale))
    }

    private var effectOriginKey: String {
        let ids = threadActions.filter { [.ready, .running].contains($0.state) }.compactMap { model.effectControlIdentity(for: $0)?.action.id }.sorted()
        guard ids.count > 1 else { return "" }
        return model.nativeComposerScope.uuidString + "|" + model.hostAddress + "|" + ids.joined(separator: ",")
    }

    /// Read-only GET continuation per stoppable action (at most 8), only when more than one can be stopped. The click
    /// still resolves the origin again before its single POST; nothing here is sent or retried.
    private func readEffectOrigins(key: String) async {
        guard !key.isEmpty else { effectOrigins = [:]; effectOriginsKey = ""; return }
        let ids = Array(threadActions.filter { [.ready, .running].contains($0.state) }.compactMap { model.effectControlIdentity(for: $0)?.action.id }.sorted().prefix(8))
        guard let client = model.makeLocalMcpClient() else { return }
        defer { client.close() }
        var found: [String: String] = [:]
        for id in ids {
            guard !Task.isCancelled, key == effectOriginKey else { return }
            if let progress = try? await client.actionContinuation(actionID: id), progress.originValid { found[id] = progress.originTurnId }
        }
        guard !Task.isCancelled, key == effectOriginKey else { return }
        effectOrigins = found; effectOriginsKey = key
    }

    struct ControlNoticeContext: Equatable {
        let notice: String
        let knownActionIDs: Set<String>
        let turnID: String?
        let stoppedTitle: String?
        let stoppedAt: Date?
    }

    /// The notice is labeled with the LATEST stop (`lastStopContext`: its origin and the action you stopped), never
    /// with the oldest of the stopped set, which keeps every stop of the conversation for safety.
    private func captureControlNoticeContext(_ notice: String?) {
        guard let notice else { controlNoticeContext = nil; return }
        let stop = model.lastStopContext.flatMap { $0.threadID == threadID ? $0 : nil }
        controlNoticeContext = ControlNoticeContext(notice: notice, knownActionIDs: Set(threadActions.map(\.id)), turnID: model.currentTurn?.id,
            stoppedTitle: stop?.action.map { ApprovalPresentation(action: $0).title }, stoppedAt: stop?.requestedAt)
    }

    /// Once another request appears (a new action, or another turn), the old stop notice is labeled as about the
    /// earlier request; the notice itself stays until Atualizar conversa, as before.
    private var controlNoticeEarlierStop: String? {
        guard let context = controlNoticeContext, context.notice == model.turnControlNotice, !model.turnControlInFlight else { return nil }
        let newAction = threadActions.contains { !context.knownActionIDs.contains($0.id) }
        let newTurn = model.currentTurn.map { $0.id != context.turnID } ?? false
        guard newAction || newTurn else { return nil }
        let portuguese = locale.language.languageCode?.identifier == "pt"
        if let title = context.stoppedTitle, let at = context.stoppedAt {
            let clock = at.formatted(Date.FormatStyle(date: .omitted, time: .standard).locale(locale))
            return portuguese ? "Sobre a parada que você pediu às \(clock) (“\(title)”), não sobre o pedido atual:"
                              : "About the stop you requested at \(clock) (“\(title)”), not the current request:"
        }
        return portuguese ? "Sobre a parada anterior, não sobre o pedido atual:" : "About the earlier stop, not the current request:"
    }

    @ViewBuilder
    private func dockStatus(turn: Turn?, effects: [DexterAppModel.EffectControlIdentity]) -> some View {
        Group {
            if let turn, turn.state == .queued {
                Label(LocalizedStringKey(model.queuedReceiptResponseTurnIDs.contains(turn.id) ? "Resposta na fila" : "Turno na fila · origem não confirmada"),
                      systemImage: "hourglass")
            } else if turn != nil {
                Label("Respondendo…", systemImage: "ellipsis.bubble")
            } else if effects.count == 1, let control = effects.first {
                Label("Executando: \(ApprovalPresentation(action: control.action).title)", systemImage: "gearshape.2")
            } else {
                Label("Executando \(effects.count) ações", systemImage: "gearshape.2")
            }
        }
        .font(.callout)
        .lineLimit(2)
        .accessibilityIdentifier("turn.control-status-label")
    }

    private var mcpServerKey: String {
        let ids = Set(threadActions.compactMap { ApprovalPresentation(action: $0).mcpServerID }).sorted()
        return model.nativeComposerScope.uuidString + "|" + model.hostAddress + "|" + ids.joined(separator: ",")
    }

    /// Read-only GET of the registered connections; a card names a connection only on an exact instance-ID match.
    private func readMcpRegistry(key: String) async {
        let hasMcp = threadActions.contains { ApprovalPresentation(action: $0).mcpServerID != nil }
        guard hasMcp, let client = model.makeLocalMcpClient() else { mcpServers = nil; return }
        defer { client.close() }
        do {
            let values = try await client.mcpServers()
            guard !Task.isCancelled, key == mcpServerKey else { return }
            mcpServers = values
        } catch {
            guard !Task.isCancelled, key == mcpServerKey else { return }
            mcpServers = nil
        }
    }

    private func mcpLookup(_ action: Action) -> ChatMcpConnectionLookup? {
        let presentation = ApprovalPresentation(action: action)
        guard let id = presentation.mcpServerID else { return nil }
        let tool = presentation.mcpToolName ?? ""
        guard let servers = mcpServers else { return .unread(serverID: id, tool: tool) }
        guard let server = servers.first(where: { $0.id == id }) else { return .notRegistered(serverID: id, tool: tool) }
        let shared = servers.contains { $0.id != id && ($0.name == server.name || $0.destination == server.destination) }
        return .matched(name: server.name, instance: McpInstanceLabel.short(id), tool: tool, sharesNameOrAddress: shared)
    }
    #endif

    private func composer(atMilliseconds now: Int64, approvalHeightLimit: CGFloat, compact: Bool = false) -> some View {
        let pending = pendingApprovalActions(atMilliseconds: now)
        let selected = pending.first(where: { $0.id == displayedApprovalID }) ?? pending.first
        return VStack(alignment: .leading, spacing: 6) {
            if let selected, let index = pending.firstIndex(where: { $0.id == selected.id }) {
                approvalCard(selected, atMilliseconds: now, showsDecisionControls: false,
                             queue: approvalQueueChrome(selected, index: index, pending: pending, atMilliseconds: now,
                                                        heightLimit: approvalHeightLimit))
                    .id(selected.id)
                    #if os(macOS)
                    // Outside the card's identity: moving between approvals keeps the same native responder and focus.
                    .background { approvalReviewResponder(selected) }
                    #endif
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("approval.queue")
                #if os(macOS)
                if let browserUseRefusal, browserUseRefusal.actionID == selected.id {
                    BrowserUsePreflightNotice(refusal: browserUseRefusal.refusal)
                }
                #endif
            }
            #if os(macOS)
            conversationStatus
            ConversationEngineBanner(model: model, threadID: threadID, prepareAssistant: prepareAssistant)
            if let notice = model.communicationConfirmationNotice {
                Text(notice).font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat.communication.text-confirmation")
            }
            if let pending = model.pendingCommunicationConfirmationForActiveThread,
               pending.action.request.threadId == threadID {
                HStack(alignment: .top) {
                    Text("Sua resposta à autorização não foi confirmada. Repetir envia a mesma resposta, sem criar outra.")
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("Repetir autorização") { retryCommunicationConfirmation() }
                        .disabled(isSending || model.isSubmitting || isLoadingConversation || !model.canUseHost || !model.isOnline)
                        .accessibilityIdentifier("chat.communication.retry")
                }
                .padding(10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            }
            #endif
            #if os(iOS)
            if let notice = nativeComposer?.notice {
                HStack {
                    Text(DexterLocalization.text(notice, locale: locale)).font(.caption)
                    if nativeComposer?.scopeInvalidated == true {
                        Button("Descartar texto retido") {
                            nativeComposer = NativeActionComposer(threadID:threadID,hostScope:model.nativeComposerScope)
                            model.clearNativeActionDraft()
                        }
                    }
                }.padding(.horizontal).accessibilityIdentifier("chat.nativeDraft.notice")
            }
            if nativeComposer?.pendingReplacement != nil {
                VStack(alignment:.leading,spacing:6) {
                    Text("Um rascunho chegou. Sua mensagem atual foi preservada.").font(.caption)
                    HStack {
                        Button("Substituir pela solicitação") { nativeComposer?.acceptReplacement() }.disabled(nativeComposer?.isConfirming == true)
                        Button("Manter minha mensagem") { nativeComposer?.clearNative(); model.clearNativeActionDraft() }
                    }
                }.padding(.horizontal).accessibilityIdentifier("chat.nativeDraft.replace")
            } else if nativeComposer?.receivedDraft != nil {
                HStack {
                    Text("Rascunho recebido · revise e toque Enviar para confirmar.").font(.caption)
                    Spacer()
                    Button("Descartar") { nativeComposer?.clearNative(); model.clearNativeActionDraft() }
                }.padding(.horizontal).accessibilityIdentifier("chat.nativeDraft.review")
            }
            #endif
            if let pending = model.pendingSubmission, pending.threadID == threadID, canShowPendingSubmissionBanner {
                if pending.needsTextEntry {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Sua última mensagem pode não ter chegado")
                            .font(.caption.weight(.semibold))
                        Text(pending.attachmentIDs.isEmpty
                            ? "Atualize a conversa para conferir. Se ela não aparecer, escreva de novo exatamente o mesmo texto e envie: o Dexter reconhece o envio original e não duplica. Até lá, uma mensagem diferente não é enviada."
                            : "Atualize a conversa para conferir. Se ela não aparecer, escreva o mesmo texto e cole as mesmas imagens, na mesma ordem, e envie: o Dexter reconhece o envio original e não duplica. Até lá, uma mensagem diferente não é enviada.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        #if os(macOS)
                        Button("Atualizar conversa", action: reloadConversation)
                            .buttonStyle(.bordered).controlSize(.small)
                            .disabled(!model.canUseHost || isSending || model.isSubmitting || isLoadingConversation)
                            .accessibilityIdentifier("turn.pending.refresh")
                        #endif
                        pendingSubmissionDetails(pending.clientRequestID)
                    }
                    #if os(macOS)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    #else
                    .padding(.horizontal)
                    #endif
                    .accessibilityValue(pending.clientRequestID)
                } else if let pendingContent = pending.content {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Não foi possível confirmar o envio")
                                .font(.caption.weight(.semibold))
                            Text("Tentar de novo usa o mesmo envio: se a mensagem já chegou, ela não será duplicada.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            pendingSubmissionDetails(pending.clientRequestID)
                        }
                        Spacer()
                        Button("Tentar de novo com o mesmo envio") {
                            Task {
                                #if os(iOS)
                                let composer = nativeComposer
                                let began = composer?.beginRetry(content:pendingContent) == true
                                let accepted = await model.retryPendingSubmission(expectedThreadID:threadID)
                                if began { composer?.completeSubmission(accepted:accepted,reason:model.errorMessage) }
                                #else
                                guard !isSending else { return }
                                isSending = true
                                defer { isSending = false }
                                let accepted = await model.retryPendingSubmission(expectedThreadID: threadID)
                                loadFailure = accepted ? nil : model.errorMessage
                                if accepted {
                                    let retryText = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                                    let retryContent = retryText.isEmpty && !draftImages.isEmpty ? "Analise as imagens anexadas." : retryText
                                    if retryContent == pendingContent,
                                       draftImages.map(\.sha256) == pending.attachments.map(\.sha256) { draft = ""; draftImages = [] }
                                    if approvalReview == nil { isComposerFocused = true }
                                }
                                #endif
                            }
                        }
                        #if os(macOS)
                        .disabled(isSending || model.isSubmitting || isLoadingConversation || !model.canUseHost)
                        #endif
                        .accessibilityIdentifier("turn.retry")
                    }
                    #if os(macOS)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    #else
                    .padding(.horizontal)
                    #endif
                    .accessibilityValue(pending.clientRequestID)
                }
            }
            #if os(macOS)
            if let imagePasteFailure {
                Text(imagePasteFailure).font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat.attachment.error")
            }
            if !draftImages.isEmpty {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(draftImages) { image in
                        VStack(spacing: 4) {
                            MacPastedImagePreview(data: image.pngData).frame(width: 80, height: 60)
                            Button("Remover") { draftImages.removeAll { $0.id == image.id }; imagePasteFailure = nil }
                                .font(.caption).buttonStyle(.borderless).disabled(isSending || model.isSubmitting)
                                .accessibilityIdentifier("chat.attachment.remove.\(image.id)")
                                .accessibilityLabel("Remover imagem \((draftImages.firstIndex(of: image) ?? 0) + 1)")
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityIdentifier("chat.attachments.preview")
            }
            #endif
            #if os(macOS)
            // One rounded box: the editor on top, then attach, model, approval mode and send. Narrow windows move
            // the model controls to their own line inside the box; nothing is hidden.
            VStack(alignment: .leading, spacing: 10) {
                MacChatComposer(text: composerText, focused: $isComposerFocused,
                    enabled: !isSending && !model.isSubmitting,
                    placeholder: model.selectedTeam.map { DexterLocalization.format("Escreva para o time %@…", $0.name, locale: locale) }
                        ?? DexterLocalization.format("Mensagem para %@", model.selectedBot?.name ?? DexterLocalization.text("o bot", locale: locale), locale: locale),
                    pasteboard: composerPasteboard,
                    remainingImages: 4 - draftImages.count, onImages: pastedImages, onError: { imagePasteFailure = $0 }, onSubmit: send)
                HStack(alignment: .center, spacing: 8) {
                    attachButton
                    // One voice entry (UX-P1-13), only in a private bot conversation; teams (and groups, a separate
                    // view) never show it. It picks the native call or Live from this conversation's real state.
                    if model.selectedTeamID == nil, model.selectedBot != nil {
                        VoiceEntryButton(model: model, threadID: threadID)
                            .id("voice:\(model.nativeComposerScope):\(threadID)")
                    }
                    if !compact { ChatEngineSelectionBar(model: model, threadID: threadID).frame(maxWidth: .infinity, alignment: .leading) }
                    else { Spacer(minLength: 0) }
                    if let bot = model.bots.first(where: { $0.id == model.selectedBotID }), model.canEditBotProfiles {
                        ComposerApprovalControl(bot: bot, threadID: threadID, model: model)
                            .id("\(model.nativeComposerScope):\(threadID)")
                    }
                    sendButton
                }
                if compact { ChatEngineSelectionBar(model: model, threadID: threadID) }
            }
            .padding(.leading, 16).padding(.trailing, 10).padding(.top, 12).padding(.bottom, 10)
            .background(DexterSurface.raisedFill, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(composerContrast == .increased ? Color.primary.opacity(0.5) : DexterSurface.raisedStroke))
            .shadow(color: .black.opacity(composerReduceTransparency ? 0 : 0.18), radius: 16, y: 8)
            ChatLiveVoiceControls(model: model, threadID: threadID)
            #else
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Mensagem para o bot", text: composerText, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Mensagem")
                    .accessibilityIdentifier("chat.composer")
                    .onSubmit(send)
                    .disabled(!model.canUseHost || model.isSubmitting)
                sendButton
            }
            .padding(.horizontal)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background(.bar)
            #endif
        }
        #if os(macOS)
        .padding(.top, 10)
        .padding(.bottom, 20)
        .modifier(MacConversationColumn())
        #endif
    }

    private var sendDisabled: Bool {
        !model.canUseHost || model.isSubmitting || model.isUpdatingEngineSelection || model.engineSelectionRequiresReload || composerUnavailable || !composerHasContent
    }

    private var sendButton: some View {
        Button(action: send) {
            #if os(macOS)
            Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(sendDisabled ? 0.4 : 1), in: Circle())
                .contentShape(Circle())
            #else
            Label("Enviar", systemImage: "arrow.up.circle.fill")
                .labelStyle(.iconOnly)
                .font(.title2)
            #endif
        }
        .buttonStyle(.borderless)
        .disabled(sendDisabled)
        .accessibilityLabel("Enviar mensagem")
        .accessibilityIdentifier("chat.send")
        #if os(macOS)
        .keyboardShortcut(.return, modifiers: .command)
        .help("Enviar mensagem (⌘↩)")
        #endif
    }

    #if os(macOS)
    private var attachButton: some View {
        Button(action: chooseImages) {
            Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30)
                .background(DexterSurface.raisedFill, in: Circle())
                .overlay(Circle().strokeBorder(DexterSurface.raisedStroke))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isSending || model.isSubmitting || !model.canAttachChatImages || draftImages.count >= 4)
        .help(model.canAttachChatImages ? "Anexar imagens (até quatro por mensagem). Também é possível colar com ⌘V."
              : "Anexos de imagem estão disponíveis no host local deste Mac. O host pareado ainda não aceita imagens.")
        .accessibilityLabel("Anexar imagens")
        .accessibilityIdentifier("chat.attach")
    }

    /// The chosen files go through the same reader and limits as Paste, from a private pasteboard that is
    /// released afterwards; the user's clipboard is never read or written.
    private func chooseImages() {
        guard !isSending, !model.isSubmitting, model.canAttachChatImages, draftImages.count < 4 else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true; panel.canChooseDirectories = false; panel.canChooseFiles = true
        panel.resolvesAliases = false
        panel.allowedContentTypes = [.png, .tiff, .jpeg, .heic, .image]
        panel.prompt = DexterLocalization.text("Anexar", locale: locale)
        let scope = model.nativeComposerScope, thread = threadID
        guard panel.runModal() == .OK, !panel.urls.isEmpty,
              scope == model.nativeComposerScope, thread == threadID else { return }
        let board = NSPasteboard(name: NSPasteboard.Name("dexter.composer.attach.\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        board.clearContents()
        board.writeObjects(panel.urls.map { $0 as NSURL })
        do { pastedImages(try MacPastedImages.read(from: board, maximumCount: 4 - draftImages.count)) }
        catch { imagePasteFailure = error.localizedDescription }
    }
    #endif

    #if os(macOS)
    /// Only a card that is still pending in this very conversation; anything else is ignored.
    private func focusApproval(_ request: ChatApprovalFocusRequest?) {
        guard let request, request.threadID == threadID,
              let action = pendingApprovalActions(atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
                .first(where: { $0.id == request.actionID }) else { return }
        selectApproval(action)
    }
    #endif

    private func selectApproval(_ action: Action) {
        displayedApprovalID = action.id
        #if os(macOS)
        clearApprovalReview()
        #endif
    }

    private func outgoingStatus(_ state: OutgoingMessagePreviewState) -> String {
        let isPortuguese = locale.language.languageCode?.identifier == "pt"
        switch state {
        case .sending: return isPortuguese ? "Enviando…" : "Sending…"
        case .accepted: return isPortuguese ? "Aceita pelo host" : "Accepted by host"
        case .uncertain: return isPortuguese ? "Confirmação pendente" : "Confirmation pending"
        case .failed: return isPortuguese ? "Não enviada" : "Not sent"
        }
    }

    #if os(macOS)
    @ViewBuilder
    private var conversationStatus: some View {
        if isLoadingConversation {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Carregando conversa…").font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("chat.loadingStatus")
        } else if let failure = conversationFailure {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(DexterLocalization.text(failure, locale: locale))
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Atualizar conversa", action: reloadConversation)
                    .disabled(!model.canUseHost || isSending || model.isSubmitting)
                    .accessibilityIdentifier("chat.failure.refresh")
            }
            .accessibilityIdentifier("chat.failureStatus")
        } else if !model.canUseHost || !model.isOnline {
            HStack(alignment: .top, spacing: 8) {
                Label("Host indisponível. Sua mensagem permanece aqui.", systemImage: "wifi.slash")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Atualizar conversa", action: reloadConversation)
                    .disabled(!model.canUseHost || isSending || model.isSubmitting)
            }
            .accessibilityIdentifier("chat.offlineStatus")
        } else if isSending || model.isSubmitting {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Enviando…").font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("chat.sendingStatus")
        }
    }

    private func reloadConversation() {
        guard !isLoadingConversation, !isSending, !model.isSubmitting, model.canUseHost,
              model.presentedThreadID == threadID else { return }
        // Read only: reloading never creates a conversation or repeats an uncertain send.
        model.errorMessage = nil
        loadFailure = nil
        reloadRevision &+= 1
    }
    #endif

    private var fixtureBanner: some View {
        Label("Fixture visual · nenhuma mensagem ou aprovação é enviada", systemImage: "rectangle.on.rectangle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("fixture.banner")
    }

    /// Plain language first; the code and turn ID stay in Detalhes técnicos. Only existing, read-only or navigation
    /// actions are offered: nothing is resent and no policy, environment or credential is changed here.
    @ViewBuilder
    private var turnOutcome: some View {
        if let turn = model.currentTurn, [.failed, .interrupted, .unknown].contains(turn.state) {
            let outcome = TurnOutcomePresentation(state: turn.state, code: turn.code)
            VStack(alignment: .leading, spacing: 6) {
                Label(outcome.title, systemImage: turn.state == .interrupted ? "pause.circle" : (turn.state == .unknown ? "questionmark.circle" : "exclamationmark.triangle"))
                    .font(.callout.weight(.medium))
                    .foregroundStyle(turn.state == .interrupted ? Color.secondary : Color.orange)
                Text(outcome.detail).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                #if os(macOS)
                HStack(spacing: 8) {
                    if turn.state == .failed, ["not_installed", "engine_unavailable", "no_driver", "authentication_required"].contains(turn.code ?? ""),
                       let engine = model.effectiveConversationEngine.engine, [.claude, .codex].contains(engine), let prepareAssistant {
                        Button("Preparar \(engine.displayName)…") { prepareAssistant(engine) }
                            .accessibilityIdentifier("turn.outcome.prepare-assistant")
                    }
                    switch outcome.suggestion {
                    case .chooseModel:
                        if let openBotModel {
                            Button("Abrir Modelo do bot…") { openBotModel(turn.botId) }
                                .accessibilityIdentifier("turn.outcome.open-model")
                        }
                    case .refreshConversation:
                        Button("Atualizar conversa", action: reloadConversation)
                            .disabled(!model.canUseHost || isSending || model.isSubmitting)
                            .accessibilityIdentifier("turn.outcome.refresh")
                    case .none:
                        EmptyView()
                    }
                }
                .buttonStyle(.bordered).controlSize(.small)
                #endif
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "code: \(turn.code ?? "—") · state: \(turn.state.rawValue)")
                        Text(verbatim: "turn: \(turn.id)")
                        Text(verbatim: "clientRequestId: \(turn.clientRequestId)")
                    }
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                } label: {
                    Text("Detalhes técnicos").font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("turn.outcome.details")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(turn.state == .failed ? "turn.failed" : (turn.state == .unknown ? "turn.unknown" : "turn.interrupted"))
        }
    }

    /// The original send ID stays visible on demand; it is the same ID any retry reuses.
    private func pendingSubmissionDetails(_ clientRequestID: String) -> some View {
        DisclosureGroup {
            Text(verbatim: "clientRequestId: \(clientRequestID)")
                .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
        } label: {
            Text("Detalhes técnicos").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("turn.pending.details")
    }

    private var canShowPendingSubmissionBanner: Bool {
        #if os(macOS)
        return !model.isSubmitting && !isSending
        #else
        return !model.isSubmitting
        #endif
    }

    private var composerUnavailable: Bool {
        #if os(iOS)
        nativeComposer?.isConfirming == true || nativeComposer?.scopeInvalidated == true || nativeComposer?.hostScope != model.nativeComposerScope
        #else
        isLoadingConversation || isSending || model.presentedThreadID != threadID
        #endif
    }

    private var composerHasContent: Bool {
        #if os(macOS)
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draftImages.isEmpty
        #else
        !composerText.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        #endif
    }

    #if os(macOS)
    private func pastedImages(_ images: [ChatComposerImage]) {
        guard model.canAttachChatImages else {
            imagePasteFailure = DexterLocalization.text("Anexos de imagem estão disponíveis no host local deste Mac. O host pareado ainda não aceita imagens.", locale: locale); return
        }
        guard draftImages.count + images.count <= 4 else { imagePasteFailure = DexterLocalization.text("Cole até quatro imagens por mensagem.", locale: locale); return }
        draftImages.append(contentsOf: images); imagePasteFailure = nil
    }

    /// Capture authority synchronously from the manual composer event, never after a Task suspension.
    private func captureManualCommunicationConfirmation(text: String, images: [ChatComposerImage]) -> (handled: Bool, snapshot: CommunicationConfirmationSnapshot?) {
        guard CommunicationApprovalText.decision(for: text) != nil else { return (false, nil) }
        if let pending = model.pendingCommunicationConfirmationForActiveThread {
            guard !decidingActionIDs.contains(pending.action.id) else {
                model.errorMessage = DexterLocalization.text("A decisão está sendo enviada. Aguarde a confirmação do host; seu texto foi mantido.", locale: locale)
                return (true, nil)
            }
            guard images.isEmpty, text == pending.input.text else {
                model.errorMessage = DexterLocalization.text("Use Repetir autorização para manter o texto, o ID e o hash originais; seu rascunho foi mantido.", locale: locale)
                return (true, nil)
            }
            return (true, model.capturePendingCommunicationConfirmation(expectedThreadID: threadID))
        }
        let awaiting = threadActions.filter { $0.state == .awaitingApproval }
        guard awaiting.contains(where: { $0.request.tool == BotCommunicationProposal.tool }) else { return (false, nil) }
        guard images.isEmpty else {
            model.errorMessage = DexterLocalization.text("A autorização por texto não aceita anexos. Remova as imagens ou use Permitir/Negar no cartão.", locale: locale)
            return (true, nil)
        }
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        let eligible = eligibleApprovalActions(atMilliseconds: now)
        guard awaiting.count == 1, eligible.count == 1, let action = eligible.first,
              communicationTextAvailable(for: action, atMilliseconds: now),
              BotCommunicationProposal(action: action) != nil else {
            model.errorMessage = DexterLocalization.text("A proposta está vencida, em envio, indisponível ou há mais de uma. Confira o cartão correto; seu texto foi mantido.", locale: locale)
            return (true, nil)
        }
        return (true, model.captureCommunicationConfirmation(action: action, text: text, expectedThreadID: threadID))
    }

    private func retryCommunicationConfirmation() {
        guard !isSending, !model.isSubmitting, !composerUnavailable,
              let snapshot = model.capturePendingCommunicationConfirmation(expectedThreadID: threadID) else { return }
        isSending = true
        Task {
            defer { isSending = false }
            let accepted = await model.submit(snapshot.input.text, expectedThreadID: threadID, communicationConfirmation: snapshot)
            guard model.nativeComposerScope == snapshot.hostScope, model.presentedThreadID == threadID,
                  model.threadPresentationGeneration == snapshot.presentationGeneration else { return }
            loadFailure = accepted ? nil : model.errorMessage
            if accepted, draft == snapshot.input.text, draftImages.isEmpty { draft = "" }
            if approvalReview == nil { isComposerFocused = true }
        }
    }
    #endif

    private func send() {
        #if os(iOS)
        guard iosRouteIsCurrent, !model.isSubmitting, let nativeComposer, !nativeComposer.isConfirming,
              !nativeComposer.scopeInvalidated, nativeComposer.hostScope == model.nativeComposerScope else { return }
        do {
            guard let submission = try nativeComposer.submission() else { return }
            let routeToken = iosRouteToken
            Task {
                guard routeToken == iosRouteToken, iosRouteIsCurrent else { return }
                switch submission {
                case .manual(let value):
                    let accepted = await model.submit(value, expectedThreadID:threadID)
                    nativeComposer.completeSubmission(accepted:accepted,reason:model.errorMessage)
                case .native(let id,let version,let content):
                    let accepted = await model.confirmNativeActionDraft(id:id,version:version,content:content, expectedThreadID:threadID)
                    nativeComposer.completeSubmission(accepted:accepted,reason:model.nativeConfirmationMessage,
                        nativeAuthorityAvailable:model.nativeActionDraft?.id == id && model.nativeActionDraft?.version == version)
                }
            }
        } catch { model.errorMessage = DexterLocalization.text("The edited message exceeds the limits for a native draft.", locale: locale) }
        #else
        guard !isSending, !model.isSubmitting, !composerUnavailable, model.canUseHost else { return }
        let value = draft
        let images = draftImages
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else { return }
        guard images.isEmpty || model.canAttachChatImages else {
            imagePasteFailure = DexterLocalization.text("Este host ainda não aceita anexos de imagem. Use o host local deste Mac.", locale: locale); return
        }
        let communication = captureManualCommunicationConfirmation(text: value, images: images)
        guard !communication.handled || communication.snapshot != nil else { loadFailure = model.errorMessage; return }
        let host = model.hostAddress
        let hostScope = model.nativeComposerScope
        let presentation = model.threadPresentationGeneration
        isSending = true
        draft = ""
        draftImages = []; imagePasteFailure = nil
        Task {
            defer { isSending = false }
            let accepted = await model.submit(value, attachments: images, expectedThreadID: threadID,
                communicationConfirmation: communication.snapshot)
            guard model.hostAddress == host, model.nativeComposerScope == hostScope,
                  model.presentedThreadID == threadID, model.threadPresentationGeneration == presentation else { return }
            loadFailure = accepted ? nil : model.errorMessage
            if !accepted, draft.isEmpty && draftImages.isEmpty { draft = value; draftImages = images }
            if approvalReview == nil { isComposerFocused = true }
        }
        #endif
    }
}

#if os(macOS)
/// Approval buttons have no default/Return action. Mouse and AXPress share the same guarded callback.
struct MacExactApprovalButton: NSViewRepresentable {
    @Environment(\.isEnabled) private var enabled
    let title: String
    let identifier: String
    let action: (String) -> Void
    func makeNSView(context: Context) -> MacExactApprovalNSButton {
        let button = MacExactApprovalNSButton(title: title, target: nil, action: nil)
        button.bezelStyle = .rounded; button.target = button; button.action = #selector(MacExactApprovalNSButton.activate)
        return button
    }
    func updateNSView(_ button: MacExactApprovalNSButton, context: Context) {
        button.title = title; button.isEnabled = enabled; button.callback = action
        button.keyEquivalent = ""; button.setAccessibilityLabel(title); button.setAccessibilityIdentifier(identifier)
    }
}

final class MacExactApprovalNSButton: NSButton {
    var callback: ((String) -> Void)?
    override var acceptsFirstResponder: Bool { false }
    override func keyDown(with event: NSEvent) {} // Return, arrows and repeat are never approval.
    override func performKeyEquivalent(with event: NSEvent) -> Bool { false }
    @objc func activate() {
        guard isEnabled else { return }
        let event = NSApp?.currentEvent
        guard event?.type != .keyDown && event?.type != .keyUp else { return }
        let pointer = event?.type == .leftMouseDown || event?.type == .leftMouseUp
        // AX/programmatic cannot be distinguished reliably by AppKit. Do not fabricate provenance.
        callback?(pointer ? "mouse-button" : "AX-or-programmatic-button")
    }
}

/// The same native event adapter is compiled into the integrated focal test target.
final class MacApprovalReviewKeyView: NSView {
    var eligible = false
    var intent: ((ApprovalReviewIntent, Bool) -> Void)?
    var focusChanged: ((Bool) -> Void)?
    var keyTrace: ((UInt16, UInt, Bool) -> Void)?
    private weak var previousResponder: NSResponder?
    private var monitor: Any?
    private var activationRevision: UInt64 = 0
    private var wantsReview = false
    private var requestID: UUID?
    private var deniedRequestID: UUID?
    private var windowKeyObserver: NSObjectProtocol?
    override var acceptsFirstResponder: Bool { true }

    func setReviewActive(_ active: Bool, requestID: UUID? = nil) {
        self.requestID = requestID
        if active, let requestID, deniedRequestID == requestID { return }
        wantsReview = active; activationRevision &+= 1
        let revision = activationRevision
        if !active { finish(restoring: true); return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.activationRevision == revision, self.wantsReview,
                  let window = self.window, window.isKeyWindow else { return }
            if window.firstResponder !== self { self.previousResponder = window.firstResponder }
            guard window.makeFirstResponder(self) else { self.focusChanged?(false); return }
        }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil && wantsReview { setReviewActive(true, requestID: requestID) }
    }
    override func becomeFirstResponder() -> Bool {
        guard wantsReview else { return false }
        if monitor == nil {
            // Local app event routing, only this key window and this actual first responder.
            // Runs before the general inspector shortcut/menu and never observes other apps.
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                let handled = MainActor.assumeIsolated {
                    guard let self, event.window === self.window, self.window?.isKeyWindow == true,
                          self.window?.firstResponder === self else { return false }
                    return self.handle(event, focused: true)
                }
                return handled ? nil : event
            }
        }
        if windowKeyObserver == nil, let window {
            windowKeyObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification,
                object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish(restoring: false) }
            }
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window?.firstResponder === self, self.wantsReview else { return }
            self.focusChanged?(true)
        }
        return true
    }
    override func resignFirstResponder() -> Bool {
        deniedRequestID = requestID; wantsReview = false
        removeMonitor()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window?.firstResponder !== self else { return }
            self.focusChanged?(false)
        }
        return true
    }
    func finish(restoring: Bool) {
        activationRevision &+= 1; wantsReview = false; removeMonitor()
        if let window, window.firstResponder === self {
            // Esc/explicit completion returns to the previous list/editor. A click elsewhere
            // has already changed firstResponder, and never triggers this restoration.
            window.makeFirstResponder(restoring ? previousResponder : nil)
        }
        previousResponder = nil
    }
    private func removeMonitor() {
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        if let windowKeyObserver { NotificationCenter.default.removeObserver(windowKeyObserver); self.windowKeyObserver = nil }
    }
    static func gesture(for event: NSEvent) -> ApprovalReviewGesture {
        switch event.keyCode {
        case 126: return .up
        case 125: return .down
        case 53: return .escape
        case 36, 76: return .enter
        default: return .character(event.charactersIgnoringModifiers ?? "")
        }
    }
    @discardableResult func handle(_ event: NSEvent, focused: Bool) -> Bool {
        guard event.type == .keyDown else { return false }
        let flags = event.modifierFlags
        let routed = ApprovalReviewIntent.route(Self.gesture(for: event), command: flags.contains(.command),
            shift: flags.contains(.shift), option: flags.contains(.option), control: flags.contains(.control),
            repeated: event.isARepeat, focused: focused, eligible: eligible)
        guard routed != .ignore else { return false }
        keyTrace?(event.keyCode, flags.intersection([.command, .shift, .option, .control]).rawValue, event.isARepeat)
        if routed == .exit { finish(restoring: true) }
        intent?(routed, event.isARepeat)
        return true
    }
    override func keyDown(with event: NSEvent) {
        if !handle(event, focused: window?.isKeyWindow == true && window?.firstResponder === self) { super.keyDown(with: event) }
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        handle(event, focused: window?.isKeyWindow == true && window?.firstResponder === self)
    }
}

private struct MacApprovalReviewResponder: NSViewRepresentable {
    let selection: MacApprovalReviewSelection?
    let eligible: Bool
    let focusChanged: (MacApprovalReviewSelection, Bool) -> Void
    let intent: (MacApprovalReviewSelection, ApprovalReviewIntent, Bool) -> Void
    let keyTrace: (MacApprovalReviewSelection, UInt16, UInt, Bool) -> Void
    func makeNSView(context: Context) -> MacApprovalReviewKeyView { MacApprovalReviewKeyView() }
    func updateNSView(_ view: MacApprovalReviewKeyView, context: Context) {
        view.eligible = eligible
        view.focusChanged = { focused in if let selection { focusChanged(selection, focused) } }
        view.intent = { routed, repeated in if let selection { intent(selection, routed, repeated) } }
        view.keyTrace = { code, modifiers, repeated in if let selection { keyTrace(selection, code, modifiers, repeated) } }
        view.setReviewActive(selection != nil && eligible, requestID: selection?.sessionID)
    }
    static func dismantleNSView(_ view: MacApprovalReviewKeyView, coordinator: ()) { view.finish(restoring: false) }
}

private struct MacApprovalReviewScope: Equatable {
    let host: String
    let hostScope: UUID
    let bot: String?
    let thread: String?
    let displayedThread: String
    let generation: UInt64
    let hostAvailable: Bool
}

private struct MacApprovalReviewSelection: Equatable {
    let sessionID = UUID()
    let scope: MacApprovalReviewScope
    let action: Action
}

/// ForEach identity of an approval row, typed apart from message, streaming and bottom ids.
private struct MacApprovalRowID: Hashable {
    let actionID: String
}

private extension Action {
    var macApprovalRowID: MacApprovalRowID { MacApprovalRowID(actionID: id) }
}

#endif

/// "3× Executar comando · Bloqueada" with the shared reason and when; "Ver as 3" opens the individual cards, which keep
/// their own details, results and receipts. Nothing here decides or retries.
private struct ApprovalHistoryGroupRow<Card: View>: View {
    @Environment(\.locale) private var locale
    let group: ApprovalHistoryGroup
    @ViewBuilder let card: (Action) -> Card
    @State private var expanded = false

    private var countText: String { String(group.count) }
    private var when: String {
        let newest = ApprovalTimeLabel.text(group.newestUpdatedAt, locale: locale)
        let oldest = ApprovalTimeLabel.text(group.oldestUpdatedAt, locale: locale)
        return oldest == newest ? newest : oldest + "–" + newest
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: group.statusSymbol)
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                Text(verbatim: DexterLocalization.format("%@×", countText, locale: locale) + " " + DexterLocalization.text(group.title, locale: locale))
                    .font(.callout.weight(.medium))
                Spacer(minLength: 4)
                Text(LocalizedStringKey(group.stateLabel)).font(.caption).foregroundStyle(.secondary)
                Button(expanded ? "Ocultar" : "Ver as \(countText)") { expanded.toggle() }
                    .font(.caption).buttonStyle(.borderless)
                    .accessibilityIdentifier("chat.action-history.group.toggle.\(group.id)")
            }
            Text(verbatim: when + " · " + group.explanation)
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(group.actions) { action in card(action) }
                }
                .padding(.leading, 12)
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.action-history.group.\(group.id)")
    }
}

/// When an action last changed: the time today, otherwise the date and time.
enum ApprovalTimeLabel {
    static func text(_ milliseconds: Int64, locale: Locale) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        var style = Date.FormatStyle(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened)
        style.locale = locale
        return date.formatted(style)
    }
}

#if os(macOS)
private struct StopShortcut: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled { content.keyboardShortcut(".", modifiers: .command) } else { content }
    }
}

/// How a card names an MCP connection: only an exact registered instance gets a name; otherwise it says so.
enum ChatMcpConnectionLookup: Equatable {
    case matched(name: String, instance: String, tool: String, sharesNameOrAddress: Bool)
    case notRegistered(serverID: String, tool: String)
    case unread(serverID: String, tool: String)
}

/// One flexible column for transcript, turn controls, pending notice and composer.
private struct MacConversationColumn: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: 820, alignment: .leading)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
    }
}
#endif

private struct MessageBubble: View {
    @Environment(\.locale) private var locale
    #if os(macOS)
    @Environment(\.chatCopyPasteboard) private var copyPasteboard
    @Environment(\.colorSchemeContrast) private var contrast
    #endif
    let role: MessageRole
    let content: String
    var attachments: [ChatAttachment] = []
    var threadID: String? = nil
    var pastedImages: [ChatComposerImage] = []
    var isStreaming = false
    #if os(macOS)
    /// The bot that answers in this conversation (the coordinator in a team). Display only.
    var speaker: ChatSpeaker? = nil
    var createdAt: Int64? = nil
    #endif
    @State private var copiedText = false
    @State private var copyRequestID: UUID?

    private var readableText: String { role == .user ? content : ChatMessageFormatting.plainText(content) }

    private var copyButton: some View {
        Button {
            #if os(macOS)
            copyChatSource(readableText, to: copyPasteboard)
            #else
            copyChatSource(readableText)
            #endif
            copiedText = true
            copyRequestID = UUID()
        } label: {
            Label(copiedText ? (locale.language.languageCode?.identifier == "pt" ? "Copiado" : "Copied") : (locale.language.languageCode?.identifier == "pt" ? "Copiar texto" : "Copy text"), systemImage: copiedText ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.plain)
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("chat.message.copy-text")
        .disabled(content.isEmpty)
        .task(id: copyRequestID) {
            guard copyRequestID != nil else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            copiedText = false
        }
        .onChange(of: content) { _, _ in copiedText = false; copyRequestID = nil }
    }

    private var copyOriginalMenu: some View {
        Button(locale.language.languageCode?.identifier == "pt" ? "Copiar mensagem original" : "Copy original message") {
            #if os(macOS)
            copyChatSource(content, to: copyPasteboard)
            #else
            copyChatSource(content)
            #endif
        }
        .accessibilityIdentifier("chat.message.copy-original")
    }

    var body: some View {
        #if os(macOS)
        macBody
        #else
        phoneBody
        #endif
    }

    #if os(macOS)
    private var bubbleShape: UnevenRoundedRectangle {
        role == .user
            ? UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18, style: .continuous)
            : UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 18, bottomTrailingRadius: 18, topTrailingRadius: 18, style: .continuous)
    }

    private var macBody: some View {
        HStack(alignment: .top, spacing: 10) {
            if role == .user { Spacer(minLength: 64) }
            if role == .assistant, let speaker {
                speaker.avatar.frame(width: 32, height: 32)
            }
            VStack(alignment: role == .user ? .trailing : .leading, spacing: 6) {
                if role == .assistant, let speaker {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: speaker.name).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(DexterSurface.speakerTint(for: speaker.id))
                        if let createdAt { Text(verbatim: ChatClock.time(createdAt)).font(.system(size: 11)).foregroundStyle(.secondary) }
                    }
                    .accessibilityElement(children: .combine)
                }
                if !pastedImages.isEmpty {
                    ForEach(pastedImages) { image in
                        MacPastedImagePreview(data: image.pngData).frame(maxWidth: 320, maxHeight: 220)
                    }
                }
                if let threadID {
                    ForEach(attachments) { attachment in MacTranscriptImage(attachment: attachment, threadID: threadID) }
                }
                if !content.isEmpty || isStreaming {
                    MacSelectableChatMessage(content: content, isLiteral: role == .user, isStreaming: isStreaming, onAccent: role == .user)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, role == .user ? 9 : 10)
                        .background(role == .user ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(DexterSurface.bubbleFill), in: bubbleShape)
                        .chatMessageBackdrop(in: bubbleShape, enabled: role != .user)
                        .overlay(bubbleShape.strokeBorder(role == .user ? Color.clear : (contrast == .increased ? Color.primary.opacity(0.45) : DexterSurface.bubbleStroke)))
                        .fixedSize(horizontal: false, vertical: true)
                        .contextMenu { copyOriginalMenu }
                }
                HStack(spacing: 10) {
                    if role == .user, let createdAt {
                        Text(verbatim: ChatClock.time(createdAt)).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    copyButton
                }
            }
            .frame(maxWidth: role == .user ? 560 : 640, alignment: role == .user ? .trailing : .leading)
            if role == .assistant { Spacer(minLength: 32) }
        }
        .overlay(alignment: .bottomTrailing) {
            if isStreaming { ProgressView().controlSize(.mini).padding(5) }
        }
        // Keep native code Copy controls reachable to accessibility instead of collapsing the rich document.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role == .user ? Text(DexterLocalization.text("You", locale: locale))
            : Text(verbatim: speaker?.name ?? DexterLocalization.text("Assistant", locale: locale)))
    }
    #else
    private var phoneBody: some View {
        HStack(alignment: .top) {
            if role == .user { Spacer(minLength: 44) }
            VStack(alignment: role == .user ? .trailing : .leading, spacing: 10) {
                if !attachments.isEmpty { Label("Imagem anexada", systemImage: "photo") }
                if role == .user {
                    Text(verbatim: content).textSelection(.enabled)
                } else {
                    RichAssistantMessage(content: content)
                }
                copyButton
            }
            .padding(12)
            .background(role == .user ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 14))
            .frame(maxWidth: 680, alignment: role == .user ? .trailing : .leading)
            .contextMenu { copyOriginalMenu }
            if role == .assistant { Spacer(minLength: 44) }
        }
        .overlay(alignment: .bottomTrailing) {
            if isStreaming { ProgressView().controlSize(.mini).padding(5) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(role == .user ? DexterLocalization.text("You", locale: locale) : DexterLocalization.text("Assistant", locale: locale))
    }
    #endif
}

#if os(macOS)
/// Who answers in the conversation, for display only (name, tint and avatar of the thread's bot).
struct ChatSpeaker {
    let id: String
    let name: String
    let avatar: AnyView
}

enum ChatClock {
    static func date(_ milliseconds: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000) }
    static func time(_ milliseconds: Int64) -> String { date(milliseconds).formatted(date: .omitted, time: .shortened) }
    /// "Hoje · 10:06", "Ontem · 18:02" or the abbreviated date, shown once when the day changes.
    static func dayLabel(_ milliseconds: Int64, locale: Locale) -> String {
        let value = date(milliseconds), calendar = Calendar.current
        if calendar.isDateInToday(value) { return DexterLocalization.format("Hoje · %@", time(milliseconds), locale: locale) }
        if calendar.isDateInYesterday(value) { return DexterLocalization.format("Ontem · %@", time(milliseconds), locale: locale) }
        return value.formatted(date: .abbreviated, time: .shortened)
    }
    static func startsNewDay(_ milliseconds: Int64, after previous: Int64?) -> Bool {
        guard let previous else { return true }
        return !Calendar.current.isDate(date(milliseconds), inSameDayAs: date(previous))
    }
}
#endif

#if os(macOS)
private struct MacPastedImagePreview: View {
    let data: Data
    var body: some View {
        Group {
            if let image = MacPastedImages.thumbnail(data) {
                Image(nsImage: image).resizable().scaledToFit()
            } else { Image(systemName: "photo").foregroundStyle(.secondary) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel("Imagem anexada")
    }
}

private struct MacTranscriptImage: View {
    @Environment(DexterAppModel.self) private var model
    let attachment: ChatAttachment
    let threadID: String
    @State private var image: NSImage?
    @State private var failed = false
    @State private var showingImage = false
    private var thumbnailSize: CGSize {
        guard attachment.width > 0, attachment.height > 0 else { return CGSize(width: 320, height: 180) }
        let scale = min(320 / Double(attachment.width), 220 / Double(attachment.height))
        return CGSize(width: max(44, Double(attachment.width) * scale), height: max(44, Double(attachment.height) * scale))
    }
    var body: some View {
        Group {
            if let image {
                Button { showingImage = true } label: {
                    Image(nsImage: image).resizable().scaledToFit()
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 12, weight: .semibold)).padding(7)
                                .background(.regularMaterial, in: Circle()).padding(6)
                                .accessibilityHidden(true)
                        }
                }
                .buttonStyle(.plain).help("Ampliar imagem")
                .accessibilityLabel("Ampliar imagem anexada")
                .accessibilityIdentifier("chat.message.attachment.open.\(attachment.id)")
            } else if failed {
                Label("Imagem indisponível", systemImage: "photo.badge.exclamationmark")
                    .help("Não foi possível carregar a imagem. Reabra a conversa para tentar novamente.")
                    .font(.caption).foregroundStyle(.secondary)
            } else { ProgressView("Carregando imagem…").controlSize(.small) }
        }
        // Dimensions come from the canonical attachment, reserving the same space while pixels load.
        .frame(width: thumbnailSize.width, height: thumbnailSize.height)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.message.attachment.\(attachment.id)")
        .accessibilityLabel("Imagem anexada à mensagem")
        .task(id: "\(model.nativeComposerScope):\(threadID):\(attachment.id):\(attachment.sha256)") {
            image = nil; failed = false
            guard let data = await model.chatImageData(attachment, in: threadID), !Task.isCancelled else { failed = !Task.isCancelled; return }
            let raster = await Task.detached(priority: .userInitiated) { ChatImageRaster.decode(data, maximumSide: 640) }.value
            guard !Task.isCancelled, model.selectedThreadID == threadID else { return }
            image = raster.map { NSImage(cgImage: $0.image, size: .zero) }; failed = image == nil
        }
        .sheet(isPresented: $showingImage) { MacTranscriptImageDetail(attachment: attachment, threadID: threadID) }
    }
}

/// CGImage is an immutable decoded raster. The worker transfers it once and never mutates it.
private struct ChatImageRaster: @unchecked Sendable {
    let image: CGImage
    static func decode(_ data: Data, maximumSide: Int) -> ChatImageRaster? {
        guard !Task.isCancelled, data.count <= 2 * 1_024 * 1_024,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 4096, height <= 4096, width <= 16_000_000 / height,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumSide,
                kCGImageSourceShouldCacheImmediately: true] as CFDictionary), !Task.isCancelled else { return nil }
        return ChatImageRaster(image: image)
    }
}

private struct MacTranscriptImageDetail: View {
    @Environment(DexterAppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let attachment: ChatAttachment
    let threadID: String
    @State private var image: NSImage?
    @State private var failed = false
    @State private var capturedScope: UUID?
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Imagem anexada").font(.headline)
                Spacer()
                Button("Fechar") { dismiss() }.keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("chat.image.close")
            }.padding(16)
            Group {
                if let image { Image(nsImage: image).resizable().scaledToFit().padding(16) }
                else if failed {
                    ContentUnavailableView("Imagem indisponível", systemImage: "photo.badge.exclamationmark",
                        description: Text("Feche e abra a imagem novamente para tentar carregar."))
                } else { ProgressView("Carregando imagem…") }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 560, idealWidth: 820, minHeight: 400, idealHeight: 620)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.image.preview")
        .task {
            let scope = model.nativeComposerScope; capturedScope = scope
            guard let data = await model.chatImageData(attachment, in: threadID), !Task.isCancelled else {
                failed = !Task.isCancelled; return
            }
            let raster = await Task.detached(priority: .userInitiated) { ChatImageRaster.decode(data, maximumSide: 2048) }.value
            guard !Task.isCancelled, model.nativeComposerScope == scope, model.selectedThreadID == threadID else { return }
            image = raster.map { NSImage(cgImage: $0.image, size: .zero) }; failed = image == nil
        }
        .onChange(of: model.nativeComposerScope) { _, scope in if let capturedScope, scope != capturedScope { dismiss() } }
        .onChange(of: model.selectedThreadID) { _, id in if id != threadID { dismiss() } }
    }
}
#endif

private struct RichAssistantMessage: View {
    let content: String
    @State private var blocks: [ChatFormattedBlock] = []
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks.indices, id: \.self) { index in
                RichMessageBlock(block: blocks[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: content) {
            let source = content
            let parsed = await Task.detached(priority: .userInitiated) { ChatMessageFormatting.parse(source) }.value
            guard !Task.isCancelled else { return }
            blocks = parsed
        }
    }
}

private struct RichMessageBlock: View {
    let block: ChatFormattedBlock
    var body: some View {
        switch block {
        case .paragraph(let source):
            ChatInlineText(source: source).frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let source):
            ChatInlineText(source: source).font(.system(size: level == 1 ? 24 : level == 2 ? 21 : level == 3 ? 18 : 16, weight: .semibold))
                .padding(.top, 4).accessibilityAddTraits(.isHeader)
        case .listItem(let marker, let source):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: marker).foregroundStyle(.secondary).frame(minWidth: 18, alignment: .trailing)
                ChatInlineText(source: source).frame(maxWidth: .infinity, alignment: .leading)
            }
        case .quote(let source):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Color.secondary.opacity(0.35)).frame(width: 3)
                ChatInlineText(source: source).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true).padding(.vertical, 4)
        case .code(let language, let source, let incomplete):
            ChatCodeBox(language: language, source: source, incomplete: incomplete)
        case .table(let headers, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    GridRow { ForEach(headers.indices, id: \.self) { ChatInlineText(source: headers[$0]).fontWeight(.semibold) } }
                    Divider().gridCellColumns(max(1, headers.count))
                    ForEach(rows.indices, id: \.self) { index in
                        GridRow { ForEach(headers.indices, id: \.self) { column in ChatInlineText(source: column < rows[index].count ? rows[index][column] : "") } }
                    }
                }
                .padding(12)
            }
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        case .divider:
            Divider().padding(.vertical, 4)
        case .literal(let source):
            Text(verbatim: source).textSelection(.enabled)
        }
    }
}

private struct ChatInlineText: View {
    let source: String
    @State private var attributed = AttributedString()
    var body: some View {
        Text(attributed).textSelection(.enabled)
            .task(id: source) {
                let currentSource = source
                var parsed = await Task.detached(priority: .userInitiated) {
                    (try? AttributedString(markdown: currentSource, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(currentSource)
                }.value
                guard !Task.isCancelled else { return }
                // Links are text only. Native rendering does not load HTML assets or follow URLs.
                for run in parsed.runs {
                    if run.link != nil { parsed[run.range].link = nil }
                    if run.inlinePresentationIntent?.contains(.code) == true { parsed[run.range].font = .system(.body, design: .monospaced) }
                }
                guard !Task.isCancelled else { return }
                attributed = parsed
            }
    }
}

private struct ChatCodeBox: View {
    let language: String?
    let source: String
    let incomplete: Bool
    @Environment(\.locale) private var locale
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(verbatim: language ?? "code").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                Spacer()
                if incomplete { Text(locale.language.languageCode?.identifier == "pt" ? "Em andamento" : "Streaming").font(.system(size: 11)).foregroundStyle(.secondary) }
                Button {
                    copyChatSource(source); copied = true
                } label: {
                    Label(copied ? (locale.language.languageCode?.identifier == "pt" ? "Copiado" : "Copied") : (locale.language.languageCode?.identifier == "pt" ? "Copiar" : "Copy"), systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.plain).font(.system(size: 12))
                .accessibilityIdentifier("chat.code.copy")
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            Divider()
            ScrollView(.horizontal) {
                Text(verbatim: source).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false).padding(12)
            }
        }
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.16)))
        .onChange(of: source) { _, _ in copied = false }
    }
}

#if os(macOS)
private func copyChatSource(_ source: String, to pasteboard: NSPasteboard = .general) {
    pasteboard.clearContents()
    pasteboard.setString(source, forType: .string)
}
#else
private func copyChatSource(_ source: String) {
    #if os(iOS)
    UIPasteboard.general.string = source
    #endif
}
#endif

/// Chrome the composer queue gives its single pending card. The decision bar is the queue's pinned bar, never a second one.
private struct ApprovalQueueChrome {
    let position: Int
    let count: Int
    let previous: (() -> Void)?
    let next: (() -> Void)?
    let review: (() -> Void)?
    let reviewEnabled: Bool
    /// Height budget for the whole card: title row + scrolling middle + decision row.
    let maxHeight: CGFloat
    let decisionBar: AnyView
}

/// Natural height of the compact card's scrolling middle, measured inside its scroll view.
private struct ApprovalCompactContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Title row plus decision row: the parts of the compact card that never scroll.
private struct ApprovalCompactChromeHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value += nextValue() }
}

/// Literal selectable input/result text. No Markdown, automatic links or visual hyphenation.
private struct ApprovalLiteralText: View {
    let content: String
    let label: String
    var identifier: String? = nil
    var fontSize: CGFloat = 13

    var body: some View {
        #if os(macOS)
        MacApprovalLiteralText(content: content, label: label, identifier: identifier, fontSize: fontSize)
            .frame(maxWidth: .infinity, alignment: .leading)
        #else
        ScrollView(.horizontal) {
            Text(verbatim: content).font(.system(size: fontSize, design: .monospaced))
                .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
                .accessibilityLabel(Text(verbatim: label))
                .accessibilityValue(Text(verbatim: content))
                .accessibilityIdentifier(identifier ?? "")
        }
        #endif
    }
}

#if os(macOS)
/// Reuses the selectable TextKit document and the injected copy pasteboard from chat.
private struct MacApprovalLiteralText: NSViewRepresentable {
    @Environment(\.chatCopyPasteboard) private var pasteboard
    let content: String
    let label: String
    let identifier: String?
    let fontSize: CGFloat

    func makeNSView(context: Context) -> MacChatDocumentView {
        let view = MacChatDocumentView(pasteboard: pasteboard)
        update(view)
        return view
    }

    func updateNSView(_ view: MacChatDocumentView, context: Context) { update(view) }

    private func update(_ view: MacChatDocumentView) {
        view.setCopyPasteboard(pasteboard)
        view.apply(content: content, isLiteral: true)
        let paragraph = NSMutableParagraphStyle()
        paragraph.hyphenationFactor = 0
        paragraph.lineBreakMode = .byCharWrapping
        let storage = view.textView.textStorage
        storage?.setAttributes([.font: NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
            .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph],
            range: NSRange(location: 0, length: storage?.length ?? 0))
        view.textView.layoutManager?.usesDefaultHyphenation = false
        view.textView.setAccessibilityLabel(label)
        view.textView.setAccessibilityValue(content)
        view.textView.setAccessibilityIdentifier(identifier)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: MacChatDocumentView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        return CGSize(width: width, height: nsView.documentHeight(at: width))
    }
}
#endif

private struct ApprovalCard: View {
    @Environment(\.locale) private var locale
    let action: Action
    let hostUnavailable: Bool
    let decisionInFlight: Bool
    let decide: @MainActor (ApprovalDecision) async -> Void
    var acceptType: (@MainActor () async -> Void)? = nil
    var preferenceNotice: String? = nil
    var recoverPreference: (@MainActor () async -> Void)? = nil
    var retryPreference: (@MainActor () async -> Void)? = nil
    var showsDecisionControls = true
    /// Composer queue: one compact pending card whose decision row is the queue's single pinned bar.
    var queue: ApprovalQueueChrome? = nil
    @State private var isDeciding = false
    @State private var showsAction = false
    @State private var showsTechnicalDetails = false
    @State private var compactContentHeight: CGFloat = 0
    @State private var compactChromeHeight: CGFloat = 0
    #if os(macOS)
    var communicationBotName: String?
    var communicationTextAvailable = false
    var reviewIsSelected = false
    var reviewIdentityIsCurrent: () -> Bool = { false }
    var moveReview: (Int) -> Void = { _ in }
    var endReview: (Bool) -> Void = { _ in }
    var openAccess: (() -> Void)? = nil
    var mcpConnection: ChatMcpConnectionLookup? = nil
    #endif

    private var presentation: ApprovalPresentation { ApprovalPresentation(action: action) }

    /// Verb, then the target copied from the persisted input. The verb never truncates; the target shortens in the
    /// middle and its first line is in the tooltip. The exact input stays in Ver ação completa.
    @ViewBuilder private var summaryLine: some View {
        #if os(macOS)
        let name: String? = { if case .matched(let name, _, _, _)? = mcpConnection { return name }; return nil }()
        ApprovalRequestSummary(action: action, connectionName: name, botName: communicationBotName)
            .accessibilityIdentifier("approval.summary.\(presentation.id)")
        #else
        ApprovalRequestSummary(action: action).accessibilityIdentifier("approval.summary.\(presentation.id)")
        #endif
    }

    /// Only places the persisted tool and destination prove; "base" is the connected host, not necessarily this Mac.
    private var placeKey: LocalizedStringKey? {
        switch presentation.executionPlace {
        case .baseTerminal: "Nesta base · terminal com as permissões do usuário do sistema · a pasta de trabalho não é sandbox"
        case .baseBotFiles: "Nesta base · arquivos deste bot"
        case .baseAutomation: "Nesta base · automação deste bot"
        case .baseConfiguration: "Nesta base · configuração do Dexter"
        case nil: nil
        }
    }

    private func placeLine(_ place: LocalizedStringKey) -> some View {
        Text(place).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("approval.place.\(presentation.id)")
    }

    /// The terminal's boundary is already in the place line; other operations keep their own scope sentence.
    private var scopeNote: String? {
        presentation.executionPlace == .baseTerminal ? nil : presentation.scopeExplanation
    }

    var body: some View {
        Group {
            if presentation.state == .awaitingApproval, presentation.expiresAtMilliseconds != nil {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    content(atMilliseconds: Int64(context.date.timeIntervalSince1970 * 1_000))
                }
            } else {
                content(atMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
            }
        }
    }

    @ViewBuilder private func content(atMilliseconds now: Int64) -> some View {
        if let queue, presentation.needsDecision(atMilliseconds: now) { compactCard(queue, atMilliseconds: now) }
        else { card(atMilliseconds: now) }
    }

    private var requestingBotName: String? {
        #if os(macOS)
        communicationBotName
        #else
        nil
        #endif
    }

    /// Title, the concrete thing the action touches and one honest scope line, with Negar/Permitir right below.
    /// The complete input, hash, place, policy and saved types are one "Ver ação" away; the decision row is unchanged.
    private func compactCard(_ queue: ApprovalQueueChrome, atMilliseconds now: Int64) -> some View {
        #if os(macOS)
        let connection: String? = { if case .matched(let name, _, _, _)? = mcpConnection { return name }; return nil }()
        let scope = mcpConnectionLine
        #else
        let connection: String? = nil, scope: String? = nil
        #endif
        let summary = ApprovalCompactSummary(action: action, connectionName: connection, botName: requestingBotName, locale: locale)
        // Never collapse the readable middle below two lines, even in a very short window.
        let budget = max(44, queue.maxHeight - compactChromeHeight - 12 - 24)
        let overflows = compactContentHeight > budget + 0.5
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(compactAttention).accessibilityHidden(true)
                Text(verbatim: summary.title).font(.headline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("approval.compact.title.\(action.id)")
                Spacer(minLength: 6)
                queueNavigation(queue)
            }
            .background { GeometryReader { Color.clear.preference(key: ApprovalCompactChromeHeightKey.self, value: $0.size.height) } }
            // One scrolling area for input, warnings, unconfirmed notices and Ver ação; sized to its content up to the budget.
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 6) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let preview = summary.preview {
                            Text(verbatim: preview)
                                .font(summary.previewIsLiteral ? .system(.callout, design: .monospaced) : .callout)
                                .lineLimit(3).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, summary.previewIsLiteral ? 8 : 0).padding(.vertical, summary.previewIsLiteral ? 5 : 0)
                                .background(summary.previewIsLiteral ? Color.primary.opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                                .help(preview)
                                .accessibilityIdentifier("approval.compact.preview.\(action.id)")
                        }
                        Text(verbatim: scope ?? summary.scope).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("approval.compact.scope.\(action.id)")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("approval.summary.\(presentation.id)")
                    #if os(macOS)
                    if presentation.accessNotEnabled { accessReason }
                    communicationSummary(pending: true)
                    #endif
                    preferenceControls
                    if showsAction { compactDetails(atMilliseconds: now) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background { GeometryReader { Color.clear.preference(key: ApprovalCompactContentHeightKey.self, value: $0.size.height) } }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(overflows ? .visible : .automatic)
            .frame(height: min(compactContentHeight, budget))
            // Drawn over the scroll edge, so it never adds height beyond the budget.
            .overlay(alignment: .bottom) { if overflows { Divider() } }
            .onPreferenceChange(ApprovalCompactContentHeightKey.self) { compactContentHeight = $0 }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("approval.compact.content.\(action.id)")
            // The single pinned decision row, outside the scroll view: always visible next to the content.
            HStack(alignment: .center, spacing: 8) {
                Button(showsAction ? "Ocultar" : "Ver ação") { showsAction.toggle() }
                    .buttonStyle(.borderless).font(.callout)
                    .accessibilityIdentifier("approval.inspect.\(presentation.id)")
                Spacer(minLength: 8)
                queue.decisionBar
            }
            .background { GeometryReader { Color.clear.preference(key: ApprovalCompactChromeHeightKey.self, value: $0.size.height) } }
        }
        .onPreferenceChange(ApprovalCompactChromeHeightKey.self) { compactChromeHeight = $0 }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        #if os(macOS)
        .background(DexterSurface.panelFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(DexterSurface.attention.opacity(0.45)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(reviewIsSelected ? Color.accentColor : Color.clear, lineWidth: 2))
        .onChange(of: presentation.canDecide(hostAvailable: !hostUnavailable, atMilliseconds: now)) { _, available in
            if reviewIsSelected && !available { endReview(false) }
        }
        #else
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.orange.opacity(0.35)))
        #endif
        .onChange(of: action) { _, _ in showsAction = false; showsTechnicalDetails = false }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approval.compact.\(action.id)")
    }

    private var compactAttention: Color {
        #if os(macOS)
        DexterSurface.attention
        #else
        Color.orange
        #endif
    }

    /// "1/3 ‹ ›" only when several approvals wait; review by keyboard keeps its ⌘⇧A shortcut.
    @ViewBuilder private func queueNavigation(_ queue: ApprovalQueueChrome) -> some View {
        HStack(spacing: 2) {
            if queue.count > 1 {
                Text(verbatim: "\(queue.position)/\(queue.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel(Text("Aprovação \(queue.position) de \(queue.count)"))
                    .accessibilityIdentifier("approval.position")
                Button { queue.previous?() } label: { Image(systemName: "chevron.left").frame(width: 18, height: 18) }
                    .disabled(queue.previous == nil)
                    .help(Text("Anterior")).accessibilityLabel(Text("Anterior"))
                    .accessibilityIdentifier("approval.previous")
                Button { queue.next?() } label: { Image(systemName: "chevron.right").frame(width: 18, height: 18) }
                    .disabled(queue.next == nil)
                    .help(Text("Próxima")).accessibilityLabel(Text("Próxima"))
                    .accessibilityIdentifier("approval.next")
            }
            #if os(macOS)
            if let review = queue.review {
                Button(action: review) { Image(systemName: "keyboard").frame(width: 20, height: 18) }
                    .keyboardShortcut("a", modifiers: [.command, .shift])
                    .disabled(!queue.reviewEnabled)
                    .help(Text("Revisar (⌘⇧A)")).accessibilityLabel(Text("Revisar (⌘⇧A)"))
                    .accessibilityIdentifier("approval.review")
            }
            #endif
        }
        .buttonStyle(.borderless).font(.caption)
    }

    /// Everything the compact card leaves out, on demand: place, scope, complete input, saved type and technical data.
    private func compactDetails(atMilliseconds now: Int64) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let place = placeKey { placeLine(place) }
            if let explanation = presentation.scopeExplanation {
                Text(verbatim: explanation).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            readableActionContents
            alwaysAcceptControls(atMilliseconds: now)
            technicalDetails
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("approval.details.\(presentation.id)")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }

    private func card(atMilliseconds now: Int64) -> some View {
        let pending = presentation.needsDecision(atMilliseconds: now)
        let historical = presentation.isHistorical(atMilliseconds: now)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                #if os(macOS)
                Image(systemName: presentation.statusSymbol(atMilliseconds: now))
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(pending ? DexterSurface.attention : Color.secondary)
                    .frame(width: 32, height: 32)
                    .background((pending ? DexterSurface.attention : Color.primary).opacity(pending ? 0.16 : 0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                #else
                Image(systemName: presentation.statusSymbol(atMilliseconds: now))
                    .foregroundStyle(pending ? Color.orange : Color.secondary)
                    .accessibilityHidden(true)
                #endif
                summaryLine
                Spacer(minLength: 4)
                Text(LocalizedStringKey(presentation.stateLabel(atMilliseconds: now)))
                    .font(.caption).foregroundStyle(.secondary)
                if !pending {
                    Button(showsAction ? "Ocultar" : "Ver ação") { showsAction.toggle() }
                        .font(.caption).buttonStyle(.borderless)
                        .accessibilityIdentifier("approval.inspect.\(presentation.id)")
                }
            }
            // UX-P2-20: a finished action says why and when without opening it.
            if historical && !showsAction {
                Text(verbatim: ApprovalTimeLabel.text(action.updatedAt, locale: locale) + " · " + presentation.resultExplanation(atMilliseconds: now))
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("approval.reason.\(presentation.id)")
            }
            if !pending, let authorization = presentation.authorizationSummary {
                Text(authorization).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("approval.authorization.\(presentation.id)")
            }
            #if os(macOS)
            if pending && presentation.accessNotEnabled { accessReason }
            #endif
            if pending || showsAction {
                #if os(macOS)
                if let line = mcpConnectionLine {
                    Text(line).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled).accessibilityIdentifier("approval.mcp-connection.\(presentation.id)")
                } else if let place = placeKey {
                    placeLine(place)
                }
                #else
                if let place = placeKey {
                    placeLine(place)
                } else if presentation.mcpServerID != nil {
                    Text(presentation.destinationLabel).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).textSelection(.enabled)
                }
                #endif
                #if os(macOS)
                communicationSummary(pending: pending)
                #else
                EmptyView()
                #endif
                if pending, let explanation = scopeNote {
                    Text(verbatim: explanation + " " + DexterLocalization.text("Confira todos os valores em Ver ação completa.", locale: locale))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if pending {
                    DisclosureGroup(isExpanded: $showsAction) {
                        readableActionContents
                    } label: {
                        Text("Ver ação completa").font(.caption)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("approval.inspect.\(presentation.id)")
                } else { readableAction }
                DisclosureGroup(isExpanded: $showsTechnicalDetails) {
                    if pending { technicalDetails }
                    else { ScrollView { technicalDetails }.frame(maxHeight: 140) }
                } label: {
                    Text("Detalhes técnicos").font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("approval.details.\(presentation.id)")
                if !pending {
                    Text(presentation.resultExplanation(atMilliseconds: now)).font(.caption).foregroundStyle(.secondary)
                    if action.result != nil {
                        DisclosureGroup("Resultado da execução") {
                            ScrollView {
                                VStack(alignment: .leading, spacing: 6) {
                                    ForEach(presentation.readableResultFields) { field in
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(field.label).font(.caption).foregroundStyle(.secondary)
                                            ApprovalLiteralText(content: field.value, label: field.label)
                                        }
                                    }
                                }
                            }.frame(maxHeight: 160)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("approval.result.\(presentation.id)")
                    }
                }
            }
            // READY stays visibly in progress: allowing an action is never a successful result.
            if !historical && !pending {
                Text(presentation.resultExplanation(atMilliseconds: now)).font(.caption).foregroundStyle(.secondary)
            }
            #if os(macOS)
            if showsDecisionControls && reviewIsSelected && !isDeciding && !decisionInFlight {
                Text("↑/↓ mudar ação · ⌘⇧D negar · ⌘⇧P permitir · Esc sair")
                    .font(.caption)
                    .accessibilityIdentifier("approval.keyboard.\(presentation.id)")
            }
            #endif
            preferenceControls
            if pending { alwaysAcceptControls(atMilliseconds: now) }
            if pending && showsDecisionControls {
                HStack {
                    Button("Negar", role: .destructive) { submitDecision(.deny) }
                        .accessibilityIdentifier("approval.deny.\(presentation.id)")
                    Spacer()
                    Button { submitDecision(.allow) } label: { Text(isDeciding || decisionInFlight ? "Enviando…" : Self.allowKey) }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("approval.allow.\(presentation.id)")
                }
                .disabled(preferenceNotice == "unknown" || preferenceNotice == "receipt_missing" || isDeciding || decisionInFlight || !presentation.canDecide(hostAvailable: !hostUnavailable, atMilliseconds: now))
                if hostUnavailable {
                    Text("Conecte ao host para decidir. Atualizar não aprova nem executa a ação.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        #if os(macOS)
        .padding(pending ? 14 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DexterSurface.panelFill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(pending ? DexterSurface.attention.opacity(0.45) : DexterSurface.panelStroke))
        #else
        .padding(pending ? 12 : 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(pending ? Color.orange.opacity(0.35) : Color.secondary.opacity(0.15)))
        #endif
        .onChange(of: action) { _, _ in
            showsAction = false
            showsTechnicalDetails = false
        }
        .onChange(of: showsAction) { _, expanded in
            if pending && expanded { showsTechnicalDetails = false }
        }
        .onChange(of: showsTechnicalDetails) { _, expanded in
            if pending && expanded { showsAction = false }
        }
        #if os(macOS)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(reviewIsSelected ? Color.accentColor : Color.clear, lineWidth: 2))
        .onChange(of: presentation.canDecide(hostAvailable: !hostUnavailable, atMilliseconds: now)) { _, available in
            if reviewIsSelected && !available { endReview(false) }
        }
        #endif
    }

    /// Unconfirmed saved-type decision: the notice, read-only check and exact retry, unchanged.
    @ViewBuilder private var preferenceControls: some View {
        if let preferenceNotice {
            Text(verbatim: presentation.preferenceDecisionMessage(preferenceNotice, locale: locale))
                .font(.caption).accessibilityIdentifier("approval.preference.notice.\(action.id)")
            if preferenceNotice == "unknown" || preferenceNotice == "receipt_missing", let recoverPreference {
                Button(locale.language.languageCode?.identifier == "pt" ? "Conferir resultado" : "Check result") { Task { await recoverPreference() } }
                    .disabled(isDeciding || decisionInFlight).accessibilityIdentifier("approval.preference.recover.\(action.id)")
            }
        }
        if preferenceNotice == "receipt_missing", let retryPreference {
            Button(locale.language.languageCode?.identifier == "pt" ? "Repetir o mesmo pedido" : "Retry the same request") { Task { await retryPreference() } }
                .disabled(isDeciding || decisionInFlight || hostUnavailable).accessibilityIdentifier("approval.preference.retry-exact.\(action.id)")
        }
    }

    /// "Sempre aceitar esse tipo" appears only when the host marked this type eligible; otherwise only the reason is
    /// shown. Same guard and atomic request as before; nothing here changes grants.
    @ViewBuilder private func alwaysAcceptControls(atMilliseconds now: Int64) -> some View {
        if let acceptType {
            if action.approvalType?.eligible == true {
                Button(locale.language.languageCode?.identifier == "pt" ? "Sempre aceitar esse tipo" : "Always accept this type") {
                    guard preferenceNotice != "unknown", preferenceNotice != "receipt_missing", !isDeciding, !decisionInFlight, presentation.canDecide(hostAvailable: !hostUnavailable, atMilliseconds: now), action.approvalType?.eligible == true else { return }
                    isDeciding = true
                    Task { await acceptType(); isDeciding = false }
                }
                .disabled(isDeciding || decisionInFlight || hostUnavailable || preferenceNotice == "unknown" || preferenceNotice == "receipt_missing")
                .accessibilityIdentifier("approval.always-type.\(action.id)")
            }
            Text(verbatim: presentation.alwaysAcceptExplanation(locale: locale)).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("approval.always-type.scope.\(action.id)")
        }
    }

    #if os(macOS)
    @ViewBuilder private func communicationSummary(pending: Bool) -> some View {
        if let proposal = BotCommunicationProposal(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Comunicação de \(communicationBotName ?? action.request.botId)")
                    .font(.caption.weight(.semibold)).lineLimit(1)
                communicationFlag("Ver outros bots", value: proposal.changes.canSeeBots)
                communicationFlag("Enviar tarefas a outros bots", value: proposal.changes.canSendActions)
                communicationFlag("Receber ordens de outros bots", value: proposal.changes.canReceiveOrders)
                Text("Vale no próximo turno; não altera Master ou acessos a ferramentas.")
                    .font(.caption).foregroundStyle(.secondary)
                if pending {
                    Text(communicationTextAvailable
                        ? "Responda sim/yes para permitir ou não/no para negar; ou use os botões."
                        : "Escolha Permitir ou Negar para esta proposta.")
                        .font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat.communication.text-confirmation.\(action.id)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("approval.communication.summary.\(action.id)")
        }
    }
    #endif

    private var readableAction: some View {
        ScrollView { readableActionContents }
        .frame(maxHeight: 180)
        .accessibilityElement(children: .contain)
    }

    private var readableActionContents: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(presentation.readableFields) { field in
                VStack(alignment: .leading, spacing: 3) {
                    Text(field.label).font(.caption).foregroundStyle(.secondary)
                    ApprovalLiteralText(content: field.value, label: field.label)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("approval.readable-action.\(presentation.id)")
    }

    /// The Allow button and the sentence that names it resolve the same catalog key, so both read "Permitir" in
    /// Portuguese and "Allow" in English and never disagree.
    private static var allowKey: LocalizedStringKey { "Permitir" }

    #if os(macOS)
    /// Catalog keys, so the access name follows the app language like the rest of the sentence.
    private var accessTitle: LocalizedStringKey {
        switch presentation.executionOperation {
        case .terminal: "Terminal"
        case .cli: "GitHub e Python"
        case .filesWrite: "Salvar arquivos"
        case .automation: "Rodar automações"
        case nil: "Este acesso"
        }
    }

    /// The host recorded that "Run without asking" could not apply: the access itself is off. Opening Acessos changes nothing.
    /// Turning the access on changes its grant revision, so the host blocks this very request; the card says so
    /// before the owner leaves, and points to Permitir for this one action.
    private var accessReason: some View {
        let allow = Text(Self.allowKey), access = Text(accessTitle)
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Por que pede aprovação: \(access) está desligado para este bot. “Executar sem perguntar” só vale para o que está ligado.",
                      systemImage: "info.circle")
                    .accessibilityIdentifier("approval.access-required.reason.\(presentation.id)")
                Text("Para fazer só esta ação, use \(allow) aqui. Ligar \(access) vale para os próximos pedidos e bloqueia este, que não será executado; o bot precisará pedir de novo.")
                    .accessibilityIdentifier("approval.access-required.effect.\(presentation.id)")
            }
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let openAccess {
                Button("Abrir Acessos…", action: openAccess).font(.caption)
                    .help("Abre os ajustes deste bot na seção Acessos. Nada é ligado sem a sua confirmação; ligar bloqueia este pedido.")
                    .accessibilityIdentifier("approval.access-required.\(presentation.id)")
            }
        }
    }

    private var mcpConnectionLine: String? {
        switch mcpConnection {
        case .matched(let name, let instance, let tool, let shared):
            return String(localized: "Conexão: \(name) · \(instance) · conta não verificada · ferramenta \(tool)")
                + (shared ? " · " + String(localized: "há outra conexão com o mesmo nome ou endereço; confira o ID") : "")
        case .notRegistered(let id, let tool):
            return String(localized: "Conexão \(McpInstanceLabel.short(id)) não aparece no cadastro atual · ferramenta \(tool)")
        case .unread(let id, let tool):
            return String(localized: "Conexão \(McpInstanceLabel.short(id)) · nome não consultado · ferramenta \(tool)")
        case nil:
            return nil
        }
    }
    #endif

    private var technicalDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent("Ferramenta", value: presentation.tool)
            LabeledContent("Destino", value: presentation.destination)
            LabeledContent("Expira", value: expirationText)
            if let authorization = action.authorization {
                LabeledContent("Autorização", value: authorization.source.rawValue
                    + (authorization.policyRevision.map { " · " + String(localized: "regra rev \($0)") } ?? "")
                    + (authorization.policyReceiptId.map { " · " + String(localized: "recibo \($0)") } ?? ""))
            }
            if let requirement = action.approvalRequirement {
                LabeledContent("Motivo do pedido", value: "\(requirement.reason) · " + String(localized: "regra rev \(requirement.policyRevision)"))
            }
            ApprovalLiteralText(content: presentation.formattedArguments, label: DexterLocalization.text("Argumentos da ação", locale: locale),
                identifier: "approval.arguments.\(presentation.id)", fontSize: 11)
            if let result = action.result {
                ApprovalLiteralText(content: result.formattedJSON, label: DexterLocalization.text("Resultado integral da ação", locale: locale), fontSize: 11)
            }
            ApprovalLiteralText(content: presentation.requestHash, label: DexterLocalization.text("Hash integral da solicitação", locale: locale),
                identifier: "approval.hash.\(presentation.id)", fontSize: 11)
        }
        .font(.caption)
    }

    #if os(macOS)
    private func communicationFlag(_ title: LocalizedStringKey, value: Bool?) -> some View {
        LabeledContent(title, value: value.map { $0 ? DexterLocalization.text("Ligar", locale: locale) : DexterLocalization.text("Desligar", locale: locale) } ?? DexterLocalization.text("Manter como está", locale: locale))
            .font(.caption)
    }

    #endif

    private func submitDecision(_ decision: ApprovalDecision, requiresCurrentReview: Bool = false) {
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        guard preferenceNotice != "unknown", preferenceNotice != "receipt_missing", !isDeciding, !decisionInFlight, presentation.canDecide(hostAvailable: !hostUnavailable, atMilliseconds: now) else { return }
        #if os(macOS)
        guard !requiresCurrentReview || reviewIdentityIsCurrent() else { return }
        #endif
        // Acquire before scheduling: a second button event cannot enqueue another decision.
        isDeciding = true
        Task {
            defer { isDeciding = false }
            #if os(macOS)
            // The selection/host can change before this task gets its first turn.
            guard !requiresCurrentReview || reviewIdentityIsCurrent() else { return }
            #endif
            await decide(decision)
        }
    }

    private var expirationText: String {
        guard let expiry = presentation.expirationDate else { return DexterLocalization.text("No deadline", locale: locale) }
        return expiry.formatted(date: .abbreviated, time: .shortened)
    }


}

#if os(macOS)
/// Search and choices are backed by this host's catalog; draft edits become one CAS on Apply.
struct EngineSelectionControls: View {
    let catalog: [EngineCatalogEntry]
    let selection: EngineSelection
    let enabled: Bool
    /// The chat composer (UX-P1-12) keeps effort and speed inside the picker only; other places keep the menus.
    var showsEffortAndSpeedMenus = true
    var offersBotDefaultScope = false
    var scopedChange: ((EngineSelection, Bool) -> Void)? = nil
    var refresh: (() -> Void)? = nil
    let change: (EngineSelection) -> Void
    @State private var showsPicker = false
    @State private var query = ""
    @State private var candidate: EngineSelection?
    @State private var updateBotDefault = false
    @Environment(\.locale) private var locale
    private func text(_ pt: String, _ en: String) -> String { locale.language.languageCode?.identifier == "pt" ? pt : en }
    private var portuguese: Bool { locale.language.languageCode?.identifier == "pt" }
    /// Friendly names for catalog values only; the value sent stays the catalog's own.
    private func effortLabel(_ raw: String) -> String { EngineChoiceLabel.effort(raw, portuguese: portuguese) }
    private func speedLabel(_ raw: String) -> String { EngineChoiceLabel.speed(raw, portuguese: portuguese) }
    private var entry: EngineCatalogEntry? { catalog.first { $0.id == selection.engine } }
    private var selectedModel: EngineCatalogModel? { entry?.models.first { $0.id == selection.model } }
    private var efforts: [String] { selectedModel?.reasoningEfforts ?? entry?.reasoningEfforts ?? [] }
    private var speeds: [String] { selectedModel?.speeds ?? entry?.speeds ?? [] }
    private var usable: Bool { enabled && entry?.available == true }
    private var draft: EngineSelection { candidate ?? selection }
    private var draftEntry: EngineCatalogEntry? { catalog.first { $0.id == draft.engine } }
    private var draftModel: EngineCatalogModel? { draftEntry?.models.first { $0.id == draft.model } }
    private var draftEfforts: [String] { draftModel?.reasoningEfforts ?? draftEntry?.reasoningEfforts ?? [] }
    private var draftSpeeds: [String] { draftModel?.speeds ?? draftEntry?.speeds ?? [] }
    private var providerKeys: [String] { Array(Set(catalog.map { $0.providerID ?? $0.id })).sorted() }
    private var draftIsValid: Bool {
        draftEntry?.available == true && draftEntry?.adapterSupported != false
            && (draft.model == nil || draftModel != nil)
            && (draft.reasoningEffort.map { draftEfforts.contains($0) } ?? true)
            && (draft.speed.map { draftSpeeds.contains($0) } ?? true)
    }
    private var searchResults: [EngineModelSearchResult] {
        let cleaned = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return [] }
        return catalog.flatMap { engine in
            engine.models.filter { item in
                item.id.localizedCaseInsensitiveContains(cleaned) || (item.label ?? "").localizedCaseInsensitiveContains(cleaned)
                    || engine.id.localizedCaseInsensitiveContains(cleaned) || (engine.providerLabel ?? "").localizedCaseInsensitiveContains(cleaned)
            }.map { EngineModelSearchResult(engineID: engine.id, model: $0) }
        }
    }
    private var filteredModels: [EngineCatalogModel] {
        let cleaned = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return (draftEntry?.models ?? []).filter { cleaned.isEmpty || $0.id.localizedCaseInsensitiveContains(cleaned) || ($0.label ?? "").localizedCaseInsensitiveContains(cleaned) }
    }
    private var engineName: String { EngineChoiceLabel.engine(selection.engine) }
    private var effortName: String { selection.reasoningEffort.map(effortLabel) ?? text("Esforço padrão", "Default effort") }
    private var speedName: String { selection.speed.map(speedLabel) ?? text("Velocidade padrão", "Default speed") }
    /// The host's observed default is display-only; choosing this row still sends model = nil.
    private var draftDefaultModelLabel: String {
        guard let modelID = draftEntry?.defaultModel else { return text("Padrão da engine", "Engine default") }
        let label = draftEntry?.models.first { $0.id == modelID }?.label ?? modelID
        return DexterLocalization.format("Engine default · %@", label, locale: locale)
    }
    private var draftCatalogSourceLabel: String? {
        guard let source = draftEntry?.catalogSource else { return nil }
        switch source {
        case "native_model_list": return DexterLocalization.text("Models reported by Codex", locale: locale)
        case "native_acp_initialize": return DexterLocalization.text("Models reported by the connected engine", locale: locale)
        case "installed-muse-msp-model-list-v1": return DexterLocalization.text("Models reported by Muse", locale: locale)
        case "https://code.claude.com/docs/en/model-config": return DexterLocalization.text("Official Claude model catalog", locale: locale)
        default: return text("Modelos informados pelo host", "Models reported by the host")
        }
    }
    /// What VoiceOver and the button say: "Claude Opus 5.5", or the engine plus the model when the label lacks it.
    private var displayName: String { EngineSelectionDisplay.name(selection, catalog: catalog, portuguese: portuguese) }
    /// Effort and speed, when chosen, ride along in the tooltip and the VoiceOver hint.
    private var tuningSummary: String {
        var parts: [String] = []
        if let effort = selection.reasoningEffort { parts.append(text("Esforço", "Effort") + ": " + effortLabel(effort)) }
        if let speed = selection.speed { parts.append(text("Velocidade", "Speed") + ": " + speedLabel(speed)) }
        return parts.joined(separator: " · ")
    }

    /// Full labels when they fit; in a narrow window (620) effort and speed become icons and the engine name moves to
    /// the tooltip, so the model name is never cut to two letters. The tooltip and VoiceOver keep every value.
    var body: some View {
        ViewThatFits(in: .horizontal) {
            controls(compact: false)
            controls(compact: true)
        }
        .font(.system(size: 14))
        .menuStyle(.borderlessButton)
        .fixedSize(horizontal: false, vertical: true)
        .onChange(of: enabled) { _, value in if !value { showsPicker = false } }
    }

    private func controls(compact: Bool) -> some View {
        HStack(spacing: compact ? 8 : 12) {
            Button {
                candidate = selection; query = ""; updateBotDefault = false; showsPicker = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: EngineSymbol.systemName(selection.engine)).foregroundStyle(.secondary)
                    Text(verbatim: displayName).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                        .layoutPriority(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .help(Text(verbatim: [displayName, tuningSummary].filter { !$0.isEmpty }.joined(separator: " · ")
                      + " — " + text("escolher modelo, esforço e velocidade desta conversa", "choose this conversation's model, effort and speed")))
            .accessibilityLabel(text("Modelo", "Model"))
            .accessibilityValue(displayName)
            .accessibilityHint(tuningSummary)
            .accessibilityIdentifier("chat.engine.model-picker")
            .popover(isPresented: $showsPicker, arrowEdge: .top) { picker }
            .layoutPriority(1)
            if showsEffortAndSpeedMenus, !efforts.isEmpty {
                Menu {
                    Button(text("Padrão", "Default")) { var value = selection; value.reasoningEffort = nil; change(value) }
                    ForEach(efforts, id: \.self) { effort in
                        Button(effortLabel(effort)) { var value = selection; value.reasoningEffort = effort; change(value) }
                    }
                } label: {
                    if compact { menuIcon("brain") } else { menuLabel(selection.reasoningEffort.map(effortLabel) ?? text("Esforço", "Effort"), icon: "brain") }
                }
                .fixedSize()
                .disabled(!usable)
                .accessibilityLabel(text("Esforço de raciocínio", "Reasoning effort"))
                .accessibilityValue(effortName)
                .accessibilityIdentifier("chat.engine.effort")
                .help(text("Esforço: \(effortName). Alterar só nesta conversa.", "Effort: \(effortName). Change only in this thread."))
            }
            if showsEffortAndSpeedMenus, !speeds.isEmpty {
                Menu {
                    Button(text("Padrão", "Default")) { var value = selection; value.speed = nil; change(value) }
                    ForEach(speeds, id: \.self) { speed in
                        Button(speedLabel(speed)) { var value = selection; value.speed = speed; change(value) }
                    }
                } label: {
                    if compact { menuIcon("bolt") } else { menuLabel(selection.speed.map(speedLabel) ?? text("Velocidade", "Speed"), icon: "bolt") }
                }
                .fixedSize()
                .disabled(!usable)
                .accessibilityLabel(text("Velocidade", "Speed"))
                .accessibilityValue(speedName)
                .accessibilityIdentifier("chat.engine.speed")
                .help(text("Velocidade: \(speedName). Alterar só nesta conversa.", "Speed: \(speedName). Change only in this thread."))
            }
        }
    }

    private func menuIcon(_ icon: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium))
        }
        .foregroundStyle(.secondary)
    }
    private var picker: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(text("Buscar modelos", "Search models"), text: $query)
                    .textFieldStyle(.plain).accessibilityIdentifier("chat.engine.search")
                if let refresh {
                    Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.plain).help(text("Atualizar catálogo do host", "Refresh host catalog"))
                        .accessibilityIdentifier("chat.engine.refresh")
                }
            }
            .padding(10).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(providerKeys, id: \.self) { key in
                            let entries = catalog.filter { ($0.providerID ?? $0.id) == key }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entries.first?.providerLabel ?? entries.first?.id.capitalized ?? key)
                                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                                ForEach(entries) { engine in
                                    Button {
                                        candidate = EngineSelection(engine: engine.id)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text(EngineChoiceLabel.engine(engine.id)).lineLimit(1)
                                                Spacer(minLength: 4)
                                                if draft.engine == engine.id { Image(systemName: "checkmark").font(.system(size: 11)) }
                                            }
                                            Text(EngineReadiness(entry: engine).label(portuguese: portuguese))
                                                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                        }
                                        .padding(8).contentShape(Rectangle())
                                        .background(draft.engine == engine.id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                                    }
                                    .buttonStyle(.plain).disabled(!engine.available || engine.adapterSupported == false)
                                    .help(engine.unavailableReason ?? text("Catálogo do host", "Host catalog"))
                                    .accessibilityIdentifier("chat.engine.harness.\(engine.id)")
                                }
                            }
                        }
                    }
                    .padding(.trailing, 12)
                }
                .frame(width: 150)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(EngineChoiceLabel.engine(draftEntry?.id ?? draft.engine)).font(.headline)
                        if let version = draftEntry?.version, !version.isEmpty {
                            Text(verbatim: DexterLocalization.format("CLI version %@", version, locale: locale))
                                .font(.caption).foregroundStyle(.secondary)
                                .accessibilityIdentifier("chat.engine.cli-version")
                                .padding(.bottom, 6)
                        }
                        if query.isEmpty {
                            modelRow(id: nil, label: draftDefaultModelLabel)
                        }
                        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            ForEach(filteredModels) { item in modelRow(id: item.id, label: item.label ?? item.id) }
                        } else {
                            ForEach(searchResults) { result in
                                modelRow(id: result.model.id, label: "\(EngineChoiceLabel.engine(result.engineID)) · \(result.model.label ?? result.model.id)", engineID: result.engineID)
                            }
                        }
                        if searchResults.isEmpty && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(text("Nenhum modelo encontrado neste host.", "No matching models on this host."))
                                .foregroundStyle(.secondary).padding(.vertical, 8)
                        }
                        if let sourceLabel = draftCatalogSourceLabel {
                            Text(verbatim: sourceLabel).font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 6)
                                .accessibilityIdentifier("chat.engine.catalog-source")
                        }
                        if let entry = draftEntry, !entry.available {
                            Text(entry.unavailableReason ?? text("Execução indisponível neste host.", "Execution unavailable on this host."))
                                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.leading, 12)
                }
                .frame(maxWidth: .infinity)
            }
            .frame(height: 250)
            Divider()
            HStack(spacing: 16) {
                if !draftEfforts.isEmpty {
                    Picker(text("Esforço", "Effort"), selection: Binding(get: { draft.reasoningEffort ?? "" }, set: { var value = draft; value.reasoningEffort = $0.isEmpty ? nil : $0; candidate = value })) {
                        Text(text("Padrão", "Default")).tag("")
                        ForEach(draftEfforts, id: \.self) { Text(effortLabel($0)).tag($0) }
                    }
                    .accessibilityIdentifier("chat.engine.draft-effort")
                }
                if !draftSpeeds.isEmpty {
                    Picker(text("Velocidade", "Speed"), selection: Binding(get: { draft.speed ?? "" }, set: { var value = draft; value.speed = $0.isEmpty ? nil : $0; candidate = value })) {
                        Text(text("Padrão", "Default")).tag("")
                        ForEach(draftSpeeds, id: \.self) { Text(speedLabel($0)).tag($0) }
                    }
                    .accessibilityIdentifier("chat.engine.draft-speed")
                }
            }
            if offersBotDefaultScope {
                Picker(text("Aplicar em", "Apply to"), selection: $updateBotDefault) {
                    Text(text("Só esta conversa", "Only this thread")).tag(false)
                    Text(text("Conversa + padrão do bot", "Thread + bot default")).tag(true)
                }
                .pickerStyle(.radioGroup)
                .accessibilityIdentifier("chat.engine.scope")
            }
            HStack {
                Text(text("Modelos informados pelo host", "Models reported by the host")).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button(text("Cancelar", "Cancel")) { showsPicker = false }
                Button(text("Aplicar", "Apply")) {
                    guard enabled, draftIsValid else { return }
                    if let scopedChange { scopedChange(draft, updateBotDefault) } else { change(draft) }
                    showsPicker = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(!enabled || !draftIsValid)
                .accessibilityIdentifier("chat.engine.apply")
            }
        }
        .font(.system(size: 14)).padding(16).frame(width: 500)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    private func modelRow(id: String?, label: String, engineID: String? = nil) -> some View {
        let engine = engineID ?? draft.engine
        let available = catalog.first { $0.id == engine }?.available == true
        return Button {
            var value = draft; value.engine = engine; value.model = id; value.reasoningEffort = nil; value.speed = nil; candidate = value
        } label: {
            HStack(spacing: 8) {
                Text(label).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if draft.engine == engine && draft.model == id { Image(systemName: "checkmark").font(.system(size: 11)) }
            }
            .padding(9).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            .background(draft.engine == engine && draft.model == id ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain).disabled(!available)
        .accessibilityIdentifier("chat.engine.choice.\(engine).\(id ?? "default")")
    }
    private func menuLabel(_ title: String, icon: String? = nil) -> some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon) }
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium))
        }
        .foregroundStyle(.secondary)
    }
}

/// The one name a person reads for a selection (composer, inspector): "Claude Opus 5.5", "Codex · padrão".
enum EngineSelectionDisplay {
    static func name(_ selection: EngineSelection, catalog: [EngineCatalogEntry], portuguese: Bool) -> String {
        let engine = EngineChoiceLabel.engine(selection.engine)
        guard let modelID = selection.model else { return engine + " · " + (portuguese ? "padrão" : "default") }
        let label = catalog.first { $0.id == selection.engine }?.models.first { $0.id == modelID }?.label ?? modelID
        return label.localizedCaseInsensitiveContains(engine) ? label : engine + " " + label
    }

    /// Same engine and model; effort and speed are tuning, shown apart.
    static func sameModel(_ lhs: EngineSelection, _ rhs: EngineSelection) -> Bool {
        lhs.engine == rhs.engine && lhs.model == rhs.model
    }
}

/// UX-P1-14: one request from the inspector to show a pending card in this window's approval queue.
struct ChatApprovalFocusRequest: Equatable {
    let token = UUID()
    let actionID: String
    let threadID: String
}

#endif

/// One symbol per assistant, so the composer and Settings never show a terminal for every engine (UX-P1-12).
/// The terminal stays only for a generic command-line engine the app does not know by name.
enum EngineSymbol {
    static func systemName(_ engineID: String) -> String {
        switch engineID {
        case EngineID.claude.rawValue: "sparkles"
        case EngineID.codex.rawValue: "chevron.left.forwardslash.chevron.right"
        case EngineID.grok.rawValue: "bolt.horizontal"
        case EngineID.muse.rawValue: "music.note"
        case EngineID.antigravity.rawValue: "arrow.up.circle"
        default: "terminal"
        }
    }
}

#if os(macOS)
private struct EngineModelSearchResult: Identifiable {
    let engineID: String
    let model: EngineCatalogModel
    var id: String { "\(engineID)|\(model.id)" }
}

private struct ChatEngineSelectionBar: View {
    let model: DexterAppModel
    let threadID: String
    private var requestScope: String { "\(model.nativeComposerScope)|\(model.threadPresentationGeneration)|\(threadID)" }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.engineSelectionThreadID == threadID, let state = model.threadEngineSelection {
                HStack(spacing: 12) {
                    EngineSelectionControls(catalog: model.engineCatalog, selection: state.selection, enabled: model.canChangeThreadEngine,
                        showsEffortAndSpeedMenus: false, offersBotDefaultScope: true,
                        scopedChange: { selection, alsoDefault in
                            Task { await model.changeThreadEngineSelection(threadID: threadID, selection: selection, updateBotDefault: alsoDefault) }
                        }, refresh: { Task { await model.refreshEngineCatalog() } }) { selection in
                        Task { await model.changeThreadEngineSelection(threadID: threadID, selection: selection) }
                    }
                    Spacer(minLength: 0)
                    if model.isUpdatingEngineSelection { ProgressView().controlSize(.mini) }
                }
                // An unavailable engine is explained, with its one action, by ConversationEngineBanner above.
            } else {
                Text("Modelos do host").font(.system(size: 14)).foregroundStyle(.secondary)
            }
            if let notice = model.engineSelectionNotice, model.engineSelectionThreadID == threadID {
                HStack {
                    Text(notice).font(.system(size: 12)).foregroundStyle(.secondary)
                    Button("Recarregar") { Task { await model.reloadThreadEngineSelection(threadID: threadID); await model.refreshEngineCatalog() } }
                        .buttonStyle(.plain).font(.system(size: 12))
                        .disabled(model.isUpdatingEngineSelection)
                }
            }
        }
        .padding(.horizontal, 6)
        .onChange(of: model.currentTurn?.id) { _, id in
            guard id != nil, !model.engineSelectionRequiresReload, !model.isUpdatingEngineSelection,
                  model.engineSelectionThreadID == threadID else { return }
            Task { await model.reloadThreadEngineSelection(threadID: threadID) }
        }
        .onChange(of: model.currentTurn?.state) { _, state in
            guard state == .completed, !model.engineSelectionRequiresReload, !model.isUpdatingEngineSelection,
                  model.engineSelectionThreadID == threadID else { return }
            Task { await model.reloadThreadEngineSelection(threadID: threadID) }
        }
        .task(id: requestScope) {
            let scope = requestScope
            guard model.presentedThreadID == threadID else { return }
            await model.refreshEngineCatalog()
            guard !Task.isCancelled, model.presentedThreadID == threadID, scope == "\(model.nativeComposerScope)|\(model.threadPresentationGeneration)|\(threadID)" else { return }
            await model.reloadThreadEngineSelection(threadID: threadID)
        }
    }
}

/// UX-P0-01: one line about the conversation's effective engine (its own selection, else the bot default), with at
/// most one main action. "Usar X nesta conversa" goes through the existing thread selection CAS and is offered only
/// for an engine the current host catalog reports runnable. Nothing switches, signs in or resends by itself.
private struct ConversationEngineBanner: View {
    let model: DexterAppModel
    let threadID: String
    var prepareAssistant: ((EngineID) -> Void)? = nil
    @Environment(\.openSettings) private var openSettings
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?
    @State private var checking = false
    /// A routine catalog re-read is usually instant: "Verificando…" appears only when it actually takes a while.
    @State private var slowCheck = false

    var body: some View {
        let state = model.conversationEngineStatus.state
        let isChecking: Bool = { if case .checking = state { return true }; return false }()
        Group {
            if model.presentedThreadID == threadID, !isChecking || slowCheck {
                content(state)
            }
        }
        .task(id: isChecking) {
            slowCheck = false
            guard isChecking else { return }
            try? await Task.sleep(for: .milliseconds(1_200))
            if !Task.isCancelled { slowCheck = true }
        }
    }

    @ViewBuilder
    private func content(_ state: ConversationEngineStatus.State) -> some View {
        switch state {
        case .clear:
            EmptyView()
        case .checking(let engine):
            row(icon: "clock", tint: .secondary, identifier: "checking") {
                Text("Verificando o \(engine.displayName)…")
            } actions: { EmptyView() }
        case .notReported(let engine):
            row(icon: "questionmark.circle", tint: .secondary, identifier: "not-reported") {
                Text("A base ainda não informou se o \(engine.displayName) está disponível.")
            } actions: { checkAgain }
        case .routingOff:
            row(icon: "exclamationmark.triangle", tint: .orange, identifier: "routing-off") {
                Text("Os assistentes estão desligados nesta base.")
            } actions: { showAssistants(prominent: true) }
        case .unavailable(let engine, let alternative):
            row(icon: "exclamationmark.triangle", tint: .orange, identifier: "unavailable") {
                if model.canEditBotProfiles { Text("\(engine.displayName) não está disponível neste Mac.") }
                else { Text("\(engine.displayName) não está disponível nesta base.") }
            } actions: {
                if let alternative {
                    Button("Usar \(alternative.displayName) nesta conversa") {
                        Task { await model.changeThreadEngineSelection(threadID: threadID, selection: EngineSelection(engine: alternative.rawValue)) }
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .disabled(!model.canChangeThreadEngine)
                    .help("Muda só esta conversa. O padrão do bot continua o mesmo.")
                    .accessibilityIdentifier("chat.engine-banner.use-alternative")
                    showAssistants(prominent: false)
                } else {
                    showAssistants(prominent: true)
                }
            }
        case .loginRequired(let engine):
            row(icon: "person.crop.circle.badge.exclamationmark", tint: .orange, identifier: "login-required") {
                Text("Entre no \(engine.displayName) pelo programa oficial e envie de novo. O Dexter não pede sua senha.")
            } actions: { showAssistants(prominent: false) }
        }
    }

    private var checkAgain: some View {
        Button("Verificar de novo") {
            checking = true
            Task {
                await model.refreshEngineCatalog()
                if model.presentedThreadID == threadID { await model.reloadThreadEngineSelection(threadID: threadID) }
                checking = false
            }
        }
        .controlSize(.small)
        .disabled(checking || !model.canUseHost)
        .accessibilityIdentifier("chat.engine-banner.check-again")
    }

    @ViewBuilder
    private func showAssistants(prominent: Bool) -> some View {
        if let engine = model.effectiveConversationEngine.engine, [.claude, .codex].contains(engine), let prepareAssistant {
            Button("Preparar \(engine.displayName)…") { prepareAssistant(engine) }
                .controlSize(.small).buttonStyle(.borderedProminent)
                .accessibilityIdentifier("chat.engine-banner.prepare-assistant")
        } else {
        let button = Button("Ver assistentes") {
            router?.settingsTab = .assistants
            openSettings()
        }
        .controlSize(.small)
        .accessibilityIdentifier("chat.engine-banner.show-assistants")
        if prominent { button.buttonStyle(.borderedProminent) } else { button }
        }
    }

    private func row<Message: View, Actions: View>(icon: String, tint: Color, identifier: String,
                                                    @ViewBuilder message: () -> Message, @ViewBuilder actions: () -> Actions) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
                message().font(.callout).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if checking { ProgressView().controlSize(.small) }
                actions()
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon).foregroundStyle(tint).accessibilityHidden(true)
                    message().font(.callout).fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    if checking { ProgressView().controlSize(.small) }
                    actions()
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.engine-banner.\(identifier)")
    }
}

/// Shown above Permitir/Negar when the Browser Use reconnect did not happen; the task keeps waiting for a decision.
private struct BrowserUsePreflightNotice: View {
    let refusal: BrowserUseApprovalPreflight.Refusal
    @Environment(\.openSettings) private var openSettings
    @Environment(DexterWindowRouter.self) private var router: DexterWindowRouter?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).accessibilityHidden(true)
            Text(message).font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if refusal != .changed {
                Button("Abrir Conexões") { router?.settingsTab = .connections; openSettings() }
                    .controlSize(.small)
                    .accessibilityIdentifier("chat.browser-use.open-connections")
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.browser-use.preflight")
    }

    private var message: LocalizedStringKey {
        switch refusal {
        case .paused: "O navegador na nuvem está pausado. Reconecte em Ajustes › Conexões para permitir esta tarefa."
        case .uncertain: "Não foi possível confirmar a conexão do navegador na nuvem. Nada foi reenviado; confira em Ajustes › Conexões."
        case .noKey: "O Browser Use não está conectado neste Mac. Conecte em Ajustes › Conexões para permitir esta tarefa."
        case .storageUnavailable: "O armazenamento seguro deste Mac não liberou a chave. A tarefa continua aguardando sua decisão."
        case .reconnectFailed: "A base deste Mac não recebeu a chave. A tarefa continua aguardando; tente Reconectar em Ajustes › Conexões."
        case .changed: "A conversa mudou enquanto a conexão era preparada. Confira a tarefa antes de decidir."
        }
    }
}
#endif
