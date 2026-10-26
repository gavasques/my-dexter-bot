#if os(macOS)
import DexterHostClient
import Foundation
import Observation

public struct AutomationPendingMutation: Equatable, Sendable {
    public let id: String?
    public let operation: String
    public let input: AutomationMutation
}

/// Owner-local task calendar, pinned to host identity and the native connection generation.
@MainActor @Observable public final class AutomationsSession {
    public let model: DexterAppModel
    public let hostScope: UUID
    public let hostAddress: String
    public let expectedHostID: String?
    public var botFilter: String?
    public var selectedDate = Date()
    public private(set) var schedules: [AutomationSchedule] = []
    public private(set) var history: [AutomationOccurrence] = []
    public private(set) var calendarItems: [AutomationCalendarItem] = []
    public private(set) var status: AutomationStatus?
    public private(set) var busy = false
    public private(set) var loaded = false
    public private(set) var notice: String?
    public private(set) var pending: AutomationPendingMutation?
    public private(set) var lastReceipt: AutomationReceipt?
    public private(set) var calendarTruncated = false
    public private(set) var scheduleCursor: AutomationScheduleCursor?
    public private(set) var historyCursor: AutomationHistoryCursor?
    @ObservationIgnored private var client: HostClient?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation = UUID()
    public init(model: DexterAppModel, botID: String? = nil) {
        self.model = model; botFilter = botID
        hostScope = model.nativeComposerScope; hostAddress = model.hostAddress; expectedHostID = model.teamHostID
        pending = model.pendingAutomationMutation.flatMap { $0.input.hostId == model.teamHostID ? $0 : nil }
        if pending != nil { notice = String(localized: "Uma solicitação anterior aguarda confirmação. Use Confirmar solicitação com os mesmos dados e ID.") }
    }
    public var scopeMatches: Bool {
        active && hostScope == model.nativeComposerScope && hostAddress == model.hostAddress &&
        expectedHostID != nil && expectedHostID == model.teamHostID && model.canEditBotProfiles
    }
    public var canMutate: Bool { scopeMatches && status?.configured == true && !busy && pending == nil }
    public var availableBots: [Bot] { model.bots }
    public var dateCalendar: Calendar { var value = Calendar(identifier: .gregorian); value.locale = Locale(identifier: "pt_BR"); value.timeZone = .current; value.firstWeekday = 2; return value }
    public var weekDates: [Date] {
        let c = dateCalendar, start = c.dateInterval(of: .weekOfYear, for: selectedDate)?.start ?? c.startOfDay(for: selectedDate)
        return (0..<7).compactMap { c.date(byAdding: .day, value: $0, to: start) }
    }
    public var dayItems: [AutomationCalendarItem] {
        calendarItems.filter { dateCalendar.isDate(Date(timeIntervalSince1970: Double($0.scheduledAt) / 1000), inSameDayAs: selectedDate) }
            .sorted { ($0.scheduledAt, $0.id) < ($1.scheduledAt, $1.id) }
    }
    public func count(on day: Date) -> Int { calendarItems.filter { dateCalendar.isDate(Date(timeIntervalSince1970: Double($0.scheduledAt) / 1000), inSameDayAs: day) }.count }
    public func botName(_ id: String) -> String { model.bots.first { $0.id == id }?.name ?? String(localized: "Bot indisponível") }
    public func close() { active = false; generation = UUID(); client?.close(); client = nil; busy = false }
    public func invalidate() { close(); notice = String(localized: "A base mudou. Reabra Automações para consultar e alterar o host correto.") }
    private func accepts(_ token: UUID) -> Bool { token == generation && scopeMatches && !Task.isCancelled }
    public func refresh(appendSchedules: Bool = false, appendHistory: Bool = false) async {
        guard scopeMatches, !busy, let hostID = expectedHostID else { return }
        if client == nil { client = model.makeLocalMcpClient() }
        guard let client else { notice = String(localized: "Automações administrativas estão disponíveis no host local deste Mac."); return }
        busy = true; if pending == nil { notice = nil }; let token = generation, filter = botFilter
        defer { if accepts(token) { busy = false } }
        do {
            let newStatus = try await client.automationStatus()
            guard accepts(token), newStatus.hostId == hostID, filter == botFilter else { return }
            status = newStatus
            guard newStatus.configured else { loaded = true; schedules = []; history = []; calendarItems = []; return }
            if appendSchedules {
                guard let scheduleCursor else { return }
                let page = try await client.listAutomations(hostID: hostID, botID: filter, after: scheduleCursor)
                guard accepts(token), filter == botFilter else { return }
                mergeSchedules(page.items); self.scheduleCursor = page.nextCursor
            } else if appendHistory {
                guard let historyCursor else { return }
                let page = try await client.automationHistory(hostID: hostID, botID: filter, after: historyCursor)
                guard accepts(token), filter == botFilter else { return }
                let existing = Set(history.map(\.id)); history += page.items.filter { !existing.contains($0.id) }; self.historyCursor = page.nextCursor
            } else {
                let page = try await client.listAutomations(hostID: hostID, botID: filter)
                guard accepts(token), filter == botFilter else { return }; schedules = page.items; scheduleCursor = page.nextCursor
                let past = try await client.automationHistory(hostID: hostID, botID: filter)
                guard accepts(token), filter == botFilter else { return }; history = past.items; historyCursor = past.nextCursor
                let c = dateCalendar, week = c.dateInterval(of: .weekOfYear, for: selectedDate)!
                let from = Int64(week.start.timeIntervalSince1970 * 1000), to = Int64(week.end.timeIntervalSince1970 * 1000)
                let upcoming = try await client.automationCalendar(hostID: hostID, from: from, to: to, botID: filter)
                guard accepts(token), filter == botFilter else { return }
                calendarItems = upcoming.items; calendarTruncated = upcoming.truncated
            }
            loaded = true
        } catch {
            guard accepts(token) else { return }
            notice = error as? HostClientError == .notFound ? String(localized: "Este host ainda não oferece o calendário de automações. Atualize o Dexter Local.") : String(localized: "Não foi possível carregar as automações. Atualize para tentar novamente.")
        }
    }
    private func mergeSchedules(_ items: [AutomationSchedule]) {
        for value in items { if let index = schedules.firstIndex(where: { $0.id == value.id }) { schedules[index] = value } else { schedules.append(value) } }
    }
    @discardableResult public func submit(_ request: AutomationPendingMutation) async -> Bool {
        guard scopeMatches, !busy, request.input.hostId == expectedHostID, pending == nil || pending == request else { return false }
        if client == nil { client = model.makeLocalMcpClient() }; guard let client else { return false }
        pending = request; model.pendingAutomationMutation = request; busy = true; notice = nil; let token = generation
        do {
            let receipt = try await client.mutateAutomation(id: request.id, operation: request.operation, input: request.input)
            guard accepts(token) else { return false }
            lastReceipt = receipt; pending = nil; model.pendingAutomationMutation = nil; mergeSchedules([receipt.schedule]); busy = false
            notice = request.operation == "run" ? String(localized: "Execução solicitada. O histórico mostra o estado real da conversa; aceitação não significa conclusão.") : String(localized: "Automação salva no host.")
            return true
        } catch {
            guard accepts(token) else { return false }; busy = false
            if (error as? HostClientError) == .mutationOutcomeUnknown {
                notice = String(localized: "A confirmação não chegou. A mesma solicitação e seu ID foram mantidos; use Confirmar solicitação para reconciliar sem criar outra execução.")
            } else {
                pending = nil; model.pendingAutomationMutation = nil
                notice = (error as? HostClientError) == .conflict ? String(localized: "A automação mudou no host. Atualize antes de editar ou executar; a solicitação não foi repetida.") : String(localized: "O host recusou a alteração. Confira os campos e atualize o estado.")
            }
            return false
        }
    }
    public func retryPending() async { guard let pending else { return }; _ = await submit(pending) }
    public func changeState(_ schedule: AutomationSchedule) async {
        guard canMutate, let hostID = expectedHostID, schedule.state != "completed" else { return }
        _ = await submit(AutomationPendingMutation(id: schedule.id, operation: "state", input: AutomationMutation(hostId: hostID, expectedRevision: schedule.revision, state: schedule.state == "active" ? "disabled" : "active")))
    }
    public func runNow(_ schedule: AutomationSchedule) async {
        guard canMutate, let hostID = expectedHostID else { return }
        _ = await submit(AutomationPendingMutation(id: schedule.id, operation: "run", input: AutomationMutation(hostId: hostID, expectedRevision: schedule.revision)))
    }
    public func editorClient() -> HostClient? { scopeMatches ? (client ?? model.makeLocalMcpClient()) : nil }
    public func openConversation(threadID: String, botID: String) async -> Bool {
        guard scopeMatches, !busy, let client = editorClient() else { return false }
        let token = generation
        do {
            let thread = try await client.getThread(id: threadID)
            guard accepts(token), thread.botId == botID else { return false }
            if let teamID = thread.teamID { model.selectTeam(id: teamID) } else { model.selectBot(id: botID) }
            await model.refresh()
            guard accepts(token) else { return false }
            if let teamID = thread.teamID { return model.presentTeamThread(threadID, teamID: teamID) != nil }
            return model.presentThread(threadID, for: botID) != nil
        } catch { if accepts(token) { notice = String(localized: "A conversa desta automação não está disponível. Atualize o host para conferir.") }; return false }
    }
}

@MainActor @Observable public final class AutomationDraftEditor {
    public enum Frequency: String, CaseIterable, Sendable { case once, interval, daily, weekdays, weekly, monthly, cron }
    public let session: AutomationsSession
    public let baseline: AutomationSchedule?
    public var title: String
    public var content: String
    public var botID: String
    public var threadID: String
    public var frequency: Frequency = .daily
    public var date = Date().addingTimeInterval(300)
    public var time = Date()
    public var intervalMinutes = 60
    public var weekday = 1
    public var monthDay = 1
    public var cron = "0 9 * * 1-5"
    public var timeZone = TimeZone.current.identifier
    public private(set) var threads: [HostThread] = []
    public private(set) var preview: AutomationPreview?
    public private(set) var busy = false
    public private(set) var notice: String?
    public private(set) var threadCreationUnknown = false
    public private(set) var finished = false
    @ObservationIgnored private var client: HostClient?
    @ObservationIgnored private var active = true
    @ObservationIgnored private var generation = UUID()
    public init(session: AutomationsSession, schedule: AutomationSchedule? = nil) {
        self.session = session; baseline = schedule; title = schedule?.title ?? ""; content = schedule?.content ?? ""
        botID = schedule?.botId ?? session.botFilter ?? session.model.selectedBotID ?? session.model.bots.first?.id ?? ""
        threadID = schedule?.threadId ?? ""
        if let schedule {
            if schedule.kind == "once", let at = schedule.at { frequency = .once; date = Date(timeIntervalSince1970: Double(at) / 1000) }
            else if schedule.kind == "interval", let every = schedule.intervalMs { frequency = .interval; intervalMinutes = Int(every / 60_000); date = Date(timeIntervalSince1970: Double(schedule.nextAt ?? Int64(Date().timeIntervalSince1970 * 1000)) / 1000) }
            else if let expression = schedule.cron { frequency = .cron; cron = expression; timeZone = schedule.timeZone ?? TimeZone.current.identifier }
        }
    }
    public var locked: Bool { busy || session.busy || session.pending != nil || !session.scopeMatches || finished }
    public var when: AutomationWhen {
        let calendar = timezoneCalendar
        let parts = calendar.dateComponents([.hour, .minute], from: time)
        let minute = parts.minute ?? 0, hour = parts.hour ?? 9
        switch frequency {
        case .once: return .once(at: Int64(date.timeIntervalSince1970 * 1000))
        case .interval: return .interval(everyMs: Int64(intervalMinutes) * 60_000, firstAt: Int64(date.timeIntervalSince1970 * 1000))
        case .daily: return .cron(expression: "\(minute) \(hour) * * *", timeZone: timeZone)
        case .weekdays: return .cron(expression: "\(minute) \(hour) * * 1-5", timeZone: timeZone)
        case .weekly: return .cron(expression: "\(minute) \(hour) * * \(weekday)", timeZone: timeZone)
        case .monthly: return .cron(expression: "\(minute) \(hour) \(monthDay) * *", timeZone: timeZone)
        case .cron: return .cron(expression: cron.trimmingCharacters(in: .whitespacesAndNewlines), timeZone: timeZone)
        }
    }
    public var timezoneCalendar: Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: timeZone) ?? .current; return value }
    public var canSave: Bool { !locked && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= 160 && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && content.utf16.count <= 32_768 && session.availableBots.contains { $0.id == botID } && when.isValid && preview?.when == when && preview?.dates.isEmpty == false && (!threadID.isEmpty || !threadCreationUnknown) }
    public var previewIsCurrent: Bool { preview?.when == when }
    public func close() { active = false; generation = UUID(); client?.close(); client = nil }
    private func accepts(_ token: UUID) -> Bool { active && generation == token && session.scopeMatches && !Task.isCancelled }
    public func loadThreads() async {
        guard !locked else { return }; let token = UUID(); generation = token; let target = botID
        if client == nil { client = session.model.makeLocalMcpClient() }; guard let client else { return }
        busy = true; defer { if accepts(token) { busy = false } }
        do {
            let values = try await client.listThreads(botID: target)
            guard accepts(token), target == botID else { return }; threads = values
            if baseline == nil, !threadID.isEmpty, !values.contains(where: { $0.id == threadID }) { threadID = "" }
        } catch { guard accepts(token) else { return }; notice = String(localized: "Não foi possível consultar as conversas. Nenhuma conversa foi criada. Tente atualizar.") }
    }
    public func updatePreview() async {
        guard !locked, when.isValid, let hostID = session.expectedHostID else { return }
        if client == nil { client = session.model.makeLocalMcpClient() }; guard let client else { return }
        let input = when, token = generation; busy = true; notice = nil
        defer { if accepts(token) { busy = false } }
        do {
            let value = try await client.previewAutomation(hostID: hostID, when: input)
            guard accepts(token), input == when else { return }; preview = value
            if value.dates.isEmpty { notice = String(localized: "Esta configuração não tem uma próxima data futura. Ajuste a data ou frequência.") }
        } catch { guard accepts(token) else { return }; preview = nil; notice = String(localized: "O host não aceitou esta frequência ou fuso. Confira o cron e use um fuso IANA, como America/Sao_Paulo.") }
    }
    public func save() async {
        guard canSave, let hostID = session.expectedHostID else { return }
        let token = generation, target = botID, scheduleWhen = when
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines), instructions = content
        if threadID.isEmpty {
            guard let client, baseline == nil else { return }; busy = true
            do {
                let thread = try await client.createThread(botID: target)
                guard accepts(token), target == botID, thread.botId == target else { return }; threadID = thread.id
                threads.append(thread); busy = false
            } catch {
                guard accepts(token) else { return }; busy = false; threadCreationUnknown = true
                notice = String(localized: "A criação da conversa não foi confirmada. Ela não será repetida. Atualize as conversas e selecione o resultado antes de salvar.")
                return
            }
        }
        guard accepts(token), !threadID.isEmpty else { return }
        let mutation = AutomationMutation(hostId: hostID, expectedRevision: baseline?.revision ?? 0,
            botId: baseline == nil ? target : nil, threadId: baseline == nil ? threadID : nil,
            title: cleanTitle, content: instructions, when: scheduleWhen)
        let confirmed = await session.submit(AutomationPendingMutation(id: baseline?.id, operation: baseline == nil ? "create" : "update", input: mutation))
        guard accepts(token) else { return }; finished = confirmed
        if !confirmed { notice = session.notice }
    }
}
#endif
