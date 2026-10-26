#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

/// UX-P2-21: the simple frequencies of the editor, read back from the five-field cron the editor itself writes
/// ("m h * * *", "m h * * 1-5", "m h * * d", "m h d * *"). Pure and exact: anything else stays "personalizada" and
/// keeps its cron; nothing here is sent, and a schedule is shown as simple only if it would be saved unchanged.
enum AutomationRecurrence: Equatable, Sendable {
    case daily(hour: Int, minute: Int)
    case weekdays(hour: Int, minute: Int)
    case weekly(weekday: Int, hour: Int, minute: Int)
    case monthly(day: Int, hour: Int, minute: Int)

    init?(cron: String) {
        let fields = cron.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard fields.count == 5, let minute = Self.number(fields[0], 0...59), let hour = Self.number(fields[1], 0...23),
              fields[3] == "*" else { return nil }
        switch (fields[2], fields[4]) {
        case ("*", "*"): self = .daily(hour: hour, minute: minute)
        case ("*", "1-5"): self = .weekdays(hour: hour, minute: minute)
        case ("*", let day): guard let weekday = Self.number(day, 0...6) else { return nil }; self = .weekly(weekday: weekday, hour: hour, minute: minute)
        case (let day, "*"): guard let monthDay = Self.number(day, 1...28) else { return nil }; self = .monthly(day: monthDay, hour: hour, minute: minute)
        default: return nil
        }
    }

    /// The exact expression the editor writes for this recurrence.
    var cron: String {
        switch self {
        case .daily(let hour, let minute): "\(minute) \(hour) * * *"
        case .weekdays(let hour, let minute): "\(minute) \(hour) * * 1-5"
        case .weekly(let weekday, let hour, let minute): "\(minute) \(hour) * * \(weekday)"
        case .monthly(let day, let hour, let minute): "\(minute) \(hour) \(day) * *"
        }
    }

    var frequency: AutomationDraftEditor.Frequency {
        switch self { case .daily: .daily; case .weekdays: .weekdays; case .weekly: .weekly; case .monthly: .monthly }
    }
    var hour: Int { switch self { case .daily(let h, _), .weekdays(let h, _), .weekly(_, let h, _), .monthly(_, let h, _): h } }
    var minute: Int { switch self { case .daily(_, let m), .weekdays(_, let m), .weekly(_, _, let m), .monthly(_, _, let m): m } }

    /// "Todos os dias às 09:00", "Dias úteis às 09:00", "Toda segunda às 09:00", "Todo dia 5 às 09:00".
    var label: String {
        let time = String(format: "%02d:%02d", hour, minute)
        switch self {
        case .daily: return String(localized: "Todos os dias às \(time)")
        case .weekdays: return String(localized: "Dias úteis às \(time)")
        case .weekly(let weekday, _, _): return Self.weeklyLabel(weekday, time: time)
        case .monthly(let day, _, _): return String(localized: "Todo dia \(day) às \(time)")
        }
    }

    /// One whole phrase per weekday, so each language keeps its own grammar (Todo/Toda, "Every Monday").
    private static func weeklyLabel(_ weekday: Int, time: String) -> String {
        switch weekday {
        case 0: String(localized: "Todo domingo às \(time)")
        case 1: String(localized: "Toda segunda às \(time)")
        case 2: String(localized: "Toda terça às \(time)")
        case 3: String(localized: "Toda quarta às \(time)")
        case 4: String(localized: "Toda quinta às \(time)")
        case 5: String(localized: "Toda sexta às \(time)")
        default: String(localized: "Todo sábado às \(time)")
        }
    }

    /// Plain decimal only (no sign, no leading zero), so the text written back is identical to the text read.
    private static func number(_ field: String, _ range: ClosedRange<Int>) -> Int? {
        guard !field.isEmpty, field.allSatisfy(\.isASCII), field.allSatisfy(\.isNumber),
              field == "0" || !field.hasPrefix("0"), let value = Int(field), range.contains(value) else { return nil }
        return value
    }

    /// Shows an existing cron schedule with its simple frequency when the editor would write back exactly the same
    /// expression and time zone; otherwise the editor stays on "Personalizada (cron)". Local only: nothing is sent.
    @MainActor static func adopt(into editor: AutomationDraftEditor) {
        guard editor.frequency == .cron, let recurrence = AutomationRecurrence(cron: editor.cron),
              TimeZone(identifier: editor.timeZone) != nil else { return }
        let original = editor.when
        let previous = (editor.frequency, editor.time, editor.weekday, editor.monthDay)
        let calendar = editor.timezoneCalendar
        var parts = calendar.dateComponents([.year, .month, .day], from: Date())
        parts.hour = recurrence.hour; parts.minute = recurrence.minute
        guard let time = calendar.date(from: parts) else { return }
        editor.frequency = recurrence.frequency; editor.time = time
        if case .weekly(let weekday, _, _) = recurrence { editor.weekday = weekday }
        if case .monthly(let day, _, _) = recurrence { editor.monthDay = day }
        // A time that does not exist today in that zone (DST gap) would shift; keep the cron untouched then.
        if editor.when != original { (editor.frequency, editor.time, editor.weekday, editor.monthDay) = previous }
    }

    /// The time zone said in plain words; the IANA identifier stays in Avançado and in the help tag.
    static func zoneName(_ identifier: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard let zone = TimeZone(identifier: identifier) else { return identifier }
        return zone.localizedName(for: .generic, locale: locale) ?? identifier
    }
}

extension AutomationWhen {
    /// The cron text of a recurring rule (to start a custom expression from the chosen simple frequency).
    var cronExpression: String? { if case .cron(let expression, _) = self { return expression }; return nil }
}

/// Internal task calendar with host-projected occurrences; no EventKit or account-calendar access.
@MainActor struct AutomationsView: View {
    let model: DexterAppModel
    let initialBotID: String?
    let onOpenConversation: () -> Void
    let onRequestOpenThread: ((String, String) -> Void)?
    @State private var session: AutomationsSession
    @State private var section: SectionChoice = .list
    @State private var editor: EditorPresentation?
    @State private var confirmingRun: AutomationSchedule?
    @State private var hasExpandedPages = false
    private enum SectionChoice: String, CaseIterable { case list, calendar, history }
    private enum TabPresentation { case labelled, compact, icons }
    private struct EditorPresentation: Identifiable { let id = UUID(); let editor: AutomationDraftEditor }
    init(model: DexterAppModel, botID: String? = nil, onOpenConversation: @escaping () -> Void = {},
         onRequestOpenThread: ((String, String) -> Void)? = nil) {
        self.model = model; initialBotID = botID; self.onOpenConversation = onOpenConversation
        self.onRequestOpenThread = onRequestOpenThread
        _session = State(initialValue: AutomationsSession(model: model, botID: botID))
    }
    var body: some View {
        @Bindable var session = session
        VStack(spacing: 0) {
            header
            Divider()
            if !session.scopeMatches { ContentUnavailableView("Base indisponível", systemImage: "wifi.slash", description: Text("Reabra Automações quando estiver conectado ao host local deste Mac.")) }
            else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        statusBanner
                        if let notice = session.notice { noticeView(notice) }
                        if session.busy { ProgressView("Consultando o host…").controlSize(.small) }
                        ViewThatFits(in: .horizontal) {
                            sectionTabs(.labelled)
                            sectionTabs(.compact)
                            sectionTabs(.icons)
                        }
                        if session.status?.configured == false {
                            Text("O host não informou rotinas, próximos horários ou histórico de execuções.")
                                .font(.caption).foregroundStyle(.secondary)
                                .accessibilityIdentifier("automations.disabled")
                        } else if section == .calendar { calendarContent }
                        else if section == .list { schedulesContent }
                        else { historyContent }
                    }.padding(.horizontal, 16).padding(.vertical, 18)
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            await session.refresh()
            // The host remains the only scheduler. Refresh its projections while this
            // surface is visible; never derive execution or success from a client timer.
            while !Task.isCancelled && session.scopeMatches {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard !Task.isCancelled, session.scopeMatches else { return }
                if editor == nil && confirmingRun == nil && !session.busy && session.pending == nil && !hasExpandedPages {
                    await session.refresh()
                }
            }
        }
        .onChange(of: section) { _, _ in
            guard session.scopeMatches, !session.busy else { return }
            hasExpandedPages = false
            Task { await session.refresh() }
        }
        .onChange(of: model.nativeComposerScope) { _, _ in session.invalidate(); editor = nil }
        .onChange(of: model.hostAddress) { _, _ in session.invalidate(); editor = nil }
        .onDisappear { session.close() }
        .sheet(item: $editor) { presentation in
            AutomationEditorView(editor: presentation.editor)
        }
        .confirmationDialog("Executar esta automação agora?", isPresented: Binding(get: { confirmingRun != nil }, set: { if !$0 { confirmingRun = nil } }), titleVisibility: .visible) {
            if let value = confirmingRun {
                Button("Executar agora") { confirmingRun = nil; Task { await session.runNow(value) } }
            }
            Button("Cancelar", role: .cancel) { confirmingRun = nil }
        } message: { Text("O host inicia uma solicitação na conversa vinculada. O próximo horário da rotina será mantido. As ferramentas continuam exigindo suas permissões e aprovações.") }
    }
    private func sectionTabs(_ presentation: TabPresentation) -> some View {
        HStack(spacing: 8) {
            ForEach(SectionChoice.allCases, id: \.self) { choice in
                Button { section = choice } label: {
                    Group {
                        switch presentation {
                        case .labelled: Label(sectionTitle(choice), systemImage: sectionIcon(choice))
                        case .compact: Text(sectionTitle(choice))
                        case .icons: Image(systemName: sectionIcon(choice))
                        }
                    }
                    .font(.system(size: 13, weight: .medium)).lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, presentation == .labelled ? 14 : 10).padding(.vertical, 9)
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .background(section == choice ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel(sectionTitle(choice)).help(sectionTitle(choice))
                    .accessibilityIdentifier("automations.tab.\(choice.rawValue)")
                    .accessibilityAddTraits(section == choice ? [.isSelected] : [])
            }
            Spacer(minLength: 0)
        }
    }
    @ViewBuilder private var header: some View {
        // Inside a bot's settings the page already names the bot and "Automações": only the actions remain.
        if initialBotID != nil {
            HStack(spacing: 12) { Spacer(minLength: 0); refreshButton; createButton }.padding(16)
        } else { standaloneHeader }
    }
    private var standaloneHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                headerHeading
                Spacer(minLength: 12)
                botFilter
                refreshButton
                createButton
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) { headerHeading; Spacer(minLength: 0); refreshButton }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { botFilter; Spacer(minLength: 0); createButton }
                    VStack(alignment: .leading, spacing: 10) { botFilter; createButton }
                }
            }
        }.padding(16)
    }
    private var headerHeading: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Automações").font(.title2.bold()).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                .accessibilityIdentifier("automations.page")
            Text("Escolha uma rotina, acompanhe a execução e abra seus resultados.")
                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    @ViewBuilder private var botFilter: some View {
        if initialBotID == nil {
            Picker("Bot", selection: Binding(get: { session.botFilter ?? "" }, set: { value in
                hasExpandedPages = false; session.botFilter = value.isEmpty ? nil : value; Task { await session.refresh() }
            })) {
                Text("Todos os bots").tag("")
                ForEach(model.bots) { Text($0.name).tag($0.id) }
            }.labelsHidden().frame(minWidth: 145, maxWidth: 180).fixedSize(horizontal: true, vertical: false)
                .disabled(session.busy || !session.scopeMatches)
                .accessibilityLabel("Filtrar automações por bot")
                .help(session.botFilter.map(session.botName) ?? String(localized: "Todos os bots"))
                .accessibilityIdentifier("automations.bot-filter")
        } else {
            Text(session.botName(initialBotID!)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                .help(session.botName(initialBotID!))
        }
    }
    private var refreshButton: some View {
        Button { hasExpandedPages = false; Task { await session.refresh() } } label: { Label("Atualizar", systemImage: "arrow.clockwise") }
            .labelStyle(.iconOnly).disabled(session.busy || !session.scopeMatches)
            .help("Atualizar automações").accessibilityIdentifier("automations.refresh")
    }
    private var createButton: some View {
        Button { editor = EditorPresentation(editor: AutomationDraftEditor(session: session)) } label: {
            Label("Nova automação", systemImage: "plus").lineLimit(1).fixedSize(horizontal: true, vertical: false)
        }
        .buttonStyle(.borderedProminent).disabled(!session.canMutate || model.bots.isEmpty)
        .fixedSize(horizontal: true, vertical: false).accessibilityIdentifier("automations.create")
    }
    @ViewBuilder private var statusBanner: some View {
        if let status = session.status {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: status.running ? "checkmark.circle" : "pause.circle").foregroundStyle(status.running ? Color.green : Color.orange)
                VStack(alignment: .leading, spacing: 4) {
                    Text(status.running ? "Agenda ativa no host" : "Agenda desativada neste host").font(.system(size: 13, weight: .semibold))
                    Text(status.running ? "Com a base neste Mac, as rotinas executam enquanto o host está ligado. Este calendário pertence ao host atual." : (status.configured ? "A agenda está configurada, mas não está em execução. Atualize para consultar o estado do host; horários salvos não comprovam execução." : "Este host não configurou a agenda. Nenhuma próxima execução ou histórico foi informado."))
                        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityIdentifier("automations.host-status")
        }
    }
    private func noticeView(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Label { Text(message).fixedSize(horizontal: false, vertical: true) } icon: { Image(systemName: session.pending == nil ? "info.circle" : "exclamationmark.triangle") }
                .font(.system(size: 12)).foregroundStyle(.orange)
            if session.pending != nil {
                Button("Confirmar solicitação") { Task { await session.retryPending() } }
                    .disabled(session.busy || !session.scopeMatches).accessibilityIdentifier("automations.retry-exact")
                Text("A confirmação reutiliza os mesmos dados e o mesmo ID. Não envia outra tarefa.").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color.orange.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
    private var calendarContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button { moveWeek(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Semana anterior")
                Text(session.selectedDate, format: .dateTime.month(.wide).year()).font(.headline)
                Button { moveWeek(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Próxima semana")
                Spacer()
                Button("Hoje") { session.selectedDate = Date(); Task { await session.refresh() } }
                DatePicker("Dia", selection: Binding(get: { session.selectedDate }, set: { value in session.selectedDate = value; Task { await session.refresh() } }), displayedComponents: .date)
                    .labelsHidden().frame(maxWidth: 150).accessibilityIdentifier("automations.calendar.date")
            }.disabled(session.busy)
            HStack(spacing: 8) {
                ForEach(session.weekDates, id: \.self) { day in
                    let selected = session.dateCalendar.isDate(day, inSameDayAs: session.selectedDate)
                    Button { session.selectedDate = day } label: {
                        VStack(spacing: 5) {
                            Text(day, format: .dateTime.weekday(.abbreviated)).font(.system(size: 11)).foregroundStyle(.secondary)
                            Text(day, format: .dateTime.day()).font(.system(size: 20, weight: selected ? .semibold : .regular))
                            Text("\(session.count(on: day)) tarefa(s)").font(.system(size: 10)).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity).padding(.vertical, 11)
                    }.buttonStyle(.plain)
                        .background(selected ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 9))
                        .overlay(RoundedRectangle(cornerRadius: 9).stroke(selected ? Color.accentColor.opacity(0.4) : .clear))
                        .accessibilityLabel(day.formatted(date: .complete, time: .omitted))
                        .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            HStack { Text(session.selectedDate, format: .dateTime.weekday(.wide).day().month(.wide)).font(.headline); Spacer(); Text(TimeZone.current.identifier).font(.caption).foregroundStyle(.secondary) }
            if session.loaded, session.dayItems.isEmpty {
                emptyCard("Nenhuma tarefa neste dia", detail: "As próximas ocorrências são calculadas pelo host. Crie uma automação ou escolha outro dia.")
            }
            ForEach(session.dayItems) { item in
                HStack(alignment: .top, spacing: 12) {
                    Text(date(item.scheduledAt), format: .dateTime.hour().minute()).font(.system(size: 13, weight: .medium)).monospacedDigit().frame(width: 58, alignment: .leading)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.system(size: 14, weight: .medium)).lineLimit(2)
                        Text(session.botName(item.botId)).font(.caption).foregroundStyle(.secondary)
                        Label(calendarState(item), systemImage: item.source == "projected" ? "clock" : "bubble.left").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let schedule = session.schedules.first(where: { $0.id == item.scheduleId }) {
                        Button("Editar") { edit(schedule) }.disabled(!session.canMutate)
                    }
                    Button { open(threadID: item.threadId, botID: item.botId) } label: { Image(systemName: "bubble.left") }
                        .accessibilityLabel("Abrir conversa").disabled(session.busy)
                }.padding(14).background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
            }
            if session.calendarTruncated { Text("O calendário alcançou o limite de 1.000 ocorrências nesta semana. Filtre por bot ou reduza a frequência para consultar menos tarefas.").font(.caption).foregroundStyle(.orange) }
            Text("Calendário interno do Dexter. Seus calendários pessoais não são acessados.").font(.caption).foregroundStyle(.secondary)
        }.accessibilityElement(children: .contain).accessibilityIdentifier("automations.calendar")
    }
    private var schedulesContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.loaded, !session.schedules.isEmpty {
                HStack {
                    Text(session.scheduleCursor == nil ? "\(session.schedules.count) rotina(s)" : "\(session.schedules.count) rotina(s) carregada(s)")
                    Spacer()
                    Text("Os resultados ficam na conversa de cada rotina.")
                }.font(.caption).foregroundStyle(.secondary)
            }
            if session.loaded, session.schedules.isEmpty {
                emptyCard("Sua primeira automação", detail: "Escolha um bot, escreva o pedido e defina quando executar. O host guarda a rotina e os resultados ficam na conversa vinculada.")
            }
            askBotNote
            ForEach(session.schedules.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }) { schedule in scheduleCard(schedule) }
            if session.scheduleCursor != nil {
                Button("Carregar mais automações") { hasExpandedPages = true; Task { await session.refresh(appendSchedules: true) } }.disabled(session.busy)
            }
            if hasExpandedPages { Text("Atualize para consultar novos resultados. As páginas carregadas ficam preservadas enquanto você lê.").font(.caption).foregroundStyle(.secondary) }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("automations.list")
    }
    private func scheduleCard(_ schedule: AutomationSchedule) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(schedule.title).font(.headline).lineLimit(2)
                    Text("\(session.botName(schedule.botId)) · \(frequencyLabel(schedule))").font(.caption).foregroundStyle(.secondary)
                        .help(frequencyDetail(schedule))
                }
                Spacer()
                Text(schedule.state == "active" ? "Ativa" : schedule.state == "disabled" ? "Pausada" : "Concluída")
                    .font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.secondary.opacity(0.08), in: Capsule())
            }
            Text(schedule.content).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(3)
            HStack(spacing: 14) {
                if let nextAt = schedule.nextAt {
                    Label("Próxima: \(date(nextAt).formatted(date: .abbreviated, time: .shortened))", systemImage: "clock")
                }
                if let latest = latestOccurrence(schedule) {
                    Label(historyState(latest), systemImage: historyIcon(latest))
                        .foregroundStyle(latest.turnState == "failed" || latest.turnState == "unknown" ? Color.orange : Color.secondary)
                        .accessibilityIdentifier("automations.schedule.\(schedule.id).last-run")
                }
            }.font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Editar") { edit(schedule) }.disabled(!session.canMutate)
                Button(schedule.state == "active" ? "Pausar" : "Retomar") { Task { await session.changeState(schedule) } }
                    .disabled(!session.canMutate || schedule.state == "completed")
                Button("Executar agora") { confirmingRun = schedule }
                    .disabled(!session.canMutate || session.status?.running != true || executionInProgress(schedule))
                Spacer()
                Button { open(threadID: schedule.threadId, botID: schedule.botId) } label: { Label("Ver resultados", systemImage: "bubble.left") }.disabled(session.busy)
            }.font(.system(size: 12))
        }.padding(16).background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .contain).accessibilityIdentifier("automations.schedule.\(schedule.id)")
    }
    private var historyContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Aceita pelo host significa que o pedido entrou na conversa. Conclusão, falha e estado incerto vêm do turno real.").font(.caption).foregroundStyle(.secondary)
            if session.loaded, session.history.isEmpty { emptyCard("Sem execuções registradas", detail: "As ocorrências aparecerão aqui quando o host processar uma automação.") }
            ForEach(session.history.sorted { ($0.scheduledAt, $0.id) > ($1.scheduledAt, $1.id) }) { item in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: historyIcon(item)).foregroundStyle(item.turnState == "failed" || item.turnState == "unknown" ? Color.orange : Color.secondary).frame(width: 18)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                        Text("\(session.botName(item.botId)) · \(date(item.scheduledAt).formatted(date: .abbreviated, time: .shortened)) · \(item.source == "manual" ? String(localized: "Manual") : String(localized: "Agendada"))").font(.caption).foregroundStyle(.secondary)
                        Text(historyState(item)).font(.caption)
                        if item.turnState == "unknown" { Text("Resultado incerto. Confira a conversa antes de executar de novo.").font(.caption).foregroundStyle(.orange) }
                    }
                    Spacer()
                    Button("Abrir conversa") { open(threadID: item.threadId, botID: item.botId) }.disabled(session.busy)
                }.padding(14).background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
            }
            if session.historyCursor != nil { Button("Carregar mais histórico") { hasExpandedPages = true; Task { await session.refresh(appendHistory: true) } }.disabled(session.busy) }
            if hasExpandedPages { Text("Atualize para consultar novas execuções. As páginas carregadas ficam preservadas enquanto você lê.").font(.caption).foregroundStyle(.secondary) }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("automations.history")
    }
    /// Honest pointer to the chat path: the harness exposes dexter.automations.* to the bot only when its tools are
    /// on this base, and every create/update still waits for your approval of the exact request. No composer
    /// prefill or scheduling by plain text is promised here.
    private var askBotNote: some View {
        Label {
            Text("Também dá para pedir na conversa com o bot, por exemplo “todo dia às 9h, me mande um resumo”. Se o bot puder usar as ferramentas do Dexter nesta base, ele propõe a automação e ela só passa a existir depois que você aprova o pedido exato. Se não, use Nova automação.")
                .fixedSize(horizontal: false, vertical: true)
        } icon: { Image(systemName: "bubble.left.and.text.bubble.right") }
            .font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("automations.ask-bot")
    }
    private func emptyCard(_ title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.headline); Text(detail).font(.system(size: 12)).foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity, alignment: .leading).padding(22).background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
    private func latestOccurrence(_ schedule: AutomationSchedule) -> AutomationOccurrence? {
        session.history.filter { $0.scheduleId == schedule.id }.max { ($0.scheduledAt, $0.id) < ($1.scheduledAt, $1.id) }
    }
    private func executionInProgress(_ schedule: AutomationSchedule) -> Bool {
        session.history.contains { $0.scheduleId == schedule.id && ($0.turnState == "queued" || $0.turnState == "running") }
    }
    private func sectionTitle(_ section: SectionChoice) -> String { switch section { case .calendar: String(localized: "Calendário"); case .list: String(localized: "Rotinas"); case .history: String(localized: "Execuções") } }
    private func sectionIcon(_ section: SectionChoice) -> String { switch section { case .calendar: "calendar"; case .list: "checklist"; case .history: "clock.arrow.circlepath" } }
    private func date(_ value: Int64) -> Date { Date(timeIntervalSince1970: Double(value) / 1000) }
    private func frequencyLabel(_ schedule: AutomationSchedule) -> String {
        switch schedule.kind {
        case "once": return String(localized: "Uma vez")
        case "interval": return String(localized: "A cada \((schedule.intervalMs ?? 0) / 60_000) min")
        default:
            let zone = schedule.timeZone ?? ""
            let suffix = zone.isEmpty || zone == TimeZone.current.identifier ? "" : " · " + AutomationRecurrence.zoneName(zone)
            guard let recurrence = schedule.cron.flatMap(AutomationRecurrence.init(cron:)) else { return String(localized: "Personalizada") + suffix }
            return recurrence.label + suffix
        }
    }
    /// Exact recurrence for the help tag: the cron and the IANA zone the host stored.
    private func frequencyDetail(_ schedule: AutomationSchedule) -> String {
        schedule.kind == "cron" ? "cron \(schedule.cron ?? "—") · \(schedule.timeZone ?? "—")" : frequencyLabel(schedule)
    }
    private func turnState(_ value: String?) -> String {
        switch value { case "queued": String(localized: "Na fila"); case "running": String(localized: "Em execução"); case "completed": String(localized: "Resposta concluída"); case "interrupted": String(localized: "Interrompida"); case "failed": String(localized: "Falhou"); case "unknown": String(localized: "Resultado incerto"); default: String(localized: "Turno ainda não confirmado") }
    }
    private func calendarState(_ item: AutomationCalendarItem) -> String { item.source == "projected" ? String(localized: "Planejada pelo host") : turnState(item.turnState) }
    private func historyState(_ item: AutomationOccurrence) -> String {
        if item.turnState != nil { return turnState(item.turnState) }
        return switch item.state { case "prepared": String(localized: "Preparada para envio"); case "accepted": String(localized: "Aceita; conclusão ainda não confirmada"); case "withdrawn": String(localized: "Retirada antes do envio"); case "blocked": String(localized: "Bloqueada no host"); default: String(localized: "Estado não confirmado") }
    }
    private func historyIcon(_ item: AutomationOccurrence) -> String { switch item.turnState { case "completed": "checkmark.circle"; case "failed", "unknown": "exclamationmark.triangle"; case "running": "arrow.triangle.2.circlepath"; default: "clock" } }
    private func moveWeek(_ offset: Int) { if let next = session.dateCalendar.date(byAdding: .day, value: offset * 7, to: session.selectedDate) { session.selectedDate = next; Task { await session.refresh() } } }
    private func edit(_ schedule: AutomationSchedule) {
        let draft = AutomationDraftEditor(session: session, schedule: schedule)
        AutomationRecurrence.adopt(into: draft)
        editor = EditorPresentation(editor: draft)
    }
    private func open(threadID: String, botID: String) {
        guard session.scopeMatches, !session.busy else { return }
        // Embedded settings must confirm unsaved drafts before changing bot/thread selection.
        if let onRequestOpenThread { onRequestOpenThread(threadID, botID); return }
        Task { if await session.openConversation(threadID: threadID, botID: botID) { onOpenConversation() } }
    }
}

@MainActor private struct AutomationEditorView: View {
    let editor: AutomationDraftEditor
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDiscard = false
    @State private var showsAdvancedSchedule = false
    private var titleText: String { editor.baseline == nil ? String(localized: "Nova automação") : String(localized: "Editar automação") }
    private var zoneIsValid: Bool { TimeZone(identifier: editor.timeZone) != nil }
    private var zoneIsThisMac: Bool { editor.timeZone == TimeZone.current.identifier }
    /// Cron, an invalid zone or a zone other than this Mac's are never hidden behind the disclosure.
    private var advancedRequired: Bool { editor.frequency == .cron || !zoneIsValid || !zoneIsThisMac }
    var body: some View {
        @Bindable var editor = editor
        VStack(spacing: 0) {
            HStack { Text(titleText).font(.title3.bold()); Spacer(); Button("Cancelar", action: close).disabled(editor.busy || editor.session.busy) }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Nome da rotina").font(.system(size: 13, weight: .semibold))
                        TextField("Ex.: Resumo da minha semana", text: $editor.title).textFieldStyle(.roundedBorder).accessibilityIdentifier("automation-editor.title").disabled(editor.locked)
                        Text("O que o bot deve fazer?").font(.system(size: 13, weight: .semibold)).padding(.top, 4)
                        TextEditor(text: $editor.content).font(.system(size: 13)).frame(minHeight: 110, maxHeight: 180)
                            .padding(7).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
                            .accessibilityIdentifier("automation-editor.instructions").disabled(editor.locked)
                    }
                    destinationSection.disabled(editor.locked)
                    scheduleSection.disabled(editor.locked)
                    previewSection.disabled(editor.locked)
                    if editor.threadCreationUnknown {
                        Text("A criação da conversa anterior ficou incerta. Atualize e selecione uma conversa existente; não haverá outra criação automática.").font(.caption).foregroundStyle(.orange)
                    }
                    if let notice = editor.notice { Text(notice).font(.system(size: 12)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                    if editor.session.pending != nil {
                        Text("A confirmação está pendente. Os campos foram preservados. A solicitação pode ser reconciliada sem duplicar a automação.").font(.caption).foregroundStyle(.orange)
                        Button("Confirmar solicitação") { Task { await editor.session.retryPending(); if editor.session.pending == nil && editor.session.lastReceipt != nil { dismiss() } } }
                            .disabled(editor.session.busy).accessibilityIdentifier("automation-editor.retry-exact")
                    }
                }.padding(22)
            }
            Divider()
            HStack {
                Text("A rotina usa a conversa e as permissões do bot. Pausar não desfaz ações já executadas.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 20)
                if editor.busy || editor.session.busy { ProgressView().controlSize(.small) }
                Button("Salvar automação") { Task { await editor.save(); if editor.finished { dismiss() } } }
                    .buttonStyle(.borderedProminent).disabled(!editor.canSave).accessibilityIdentifier("automation-editor.save")
            }.padding(20)
        }
        .frame(minWidth: 560, idealWidth: 620, minHeight: 480, idealHeight: 620)
        .interactiveDismissDisabled(editor.busy || editor.session.busy || hasChanges)
        .task { await editor.loadThreads(); await editor.updatePreview() }
        // Simple frequencies ask the host for the next dates by themselves (a read: no schedule, approval or turn).
        // A cron expression or a zone being typed waits for Conferir datas, so half-typed text raises no error.
        .onChange(of: editor.when) { _, _ in
            guard editor.frequency != .cron, zoneIsValid else { return }
            Task { await autoPreview() }
        }
        .onChange(of: editor.botID) { _, _ in editor.threadID = ""; Task { await editor.loadThreads() } }
        .onChange(of: editor.session.model.nativeComposerScope) { _, _ in editor.close(); dismiss() }
        .onChange(of: editor.session.model.hostAddress) { _, _ in editor.close(); dismiss() }
        .onDisappear { editor.close() }
        .confirmationDialog("Descartar alterações não salvas?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Descartar e fechar", role: .destructive) { dismiss() }
            Button("Continuar editando", role: .cancel) {}
        } message: { Text(editor.session.pending == nil ? "Nenhuma rotina será criada sem salvar. Uma conversa criada ao salvar pode permanecer no host." : "A solicitação pendente permanece nesta tela de Automações. Use Confirmar solicitação para consultar seu receipt sem duplicação.") }
    }
    private var destinationSection: some View {
        @Bindable var editor = editor
        return VStack(alignment: .leading, spacing: 10) {
            Text("Bot e conversa").font(.system(size: 13, weight: .semibold))
            Picker("Bot", selection: $editor.botID) { ForEach(editor.session.availableBots) { Text($0.name).tag($0.id) } }
                .disabled(editor.baseline != nil).accessibilityIdentifier("automation-editor.bot")
            Picker("Resultados", selection: $editor.threadID) {
                if editor.baseline == nil { Text("Criar uma conversa para os resultados ao salvar").tag("") }
                ForEach(editor.threads) { thread in
                    Text("\(thread.teamID == nil ? String(localized: "Conversa") : String(localized: "Conversa do time")) · \(Date(timeIntervalSince1970: Double(thread.createdAt) / 1000).formatted(date: .abbreviated, time: .shortened)) · \(thread.id.suffix(6))").tag(thread.id)
                }
                if let baseline = editor.baseline, !editor.threads.contains(where: { $0.id == baseline.threadId }) { Text("Conversa vinculada · \(baseline.threadId.suffix(6))").tag(baseline.threadId) }
            }.disabled(editor.baseline != nil).accessibilityIdentifier("automation-editor.thread")
            HStack { Text("O bot e a conversa permanecem vinculados depois da criação.").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Atualizar conversas") { Task { await editor.loadThreads() } } }
        }.padding(14).background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
    /// Simple choices first; the cron expression and the IANA zone stay in Avançado with the same power. Every simple
    /// choice becomes the five-field cron and zone the host already validates (`AutomationDraftEditor.when`).
    private var scheduleSection: some View {
        @Bindable var editor = editor
        return VStack(alignment: .leading, spacing: 12) {
            Text("Quando executar").font(.system(size: 13, weight: .semibold))
            Picker("Repetir", selection: $editor.frequency) {
                ForEach(AutomationDraftEditor.Frequency.allCases.filter { $0 != .cron }, id: \.self) { Text(frequencyName($0)).tag($0) }
                if editor.frequency == .cron { Text(frequencyName(.cron)).tag(AutomationDraftEditor.Frequency.cron) }
            }
            .accessibilityIdentifier("automation-editor.frequency")
            switch editor.frequency {
            case .once:
                DatePicker("Data e hora", selection: $editor.date)
            case .interval:
                DatePicker("Primeira execução", selection: $editor.date)
                Stepper("A cada \(editor.intervalMinutes) minuto(s)", value: $editor.intervalMinutes, in: 1...43_200, step: 1)
            case .cron:
                Text("Personalizada: veja a expressão em Avançado, abaixo.").font(.caption).foregroundStyle(.secondary)
            case .daily, .weekdays, .weekly, .monthly:
                DatePicker("Horário", selection: $editor.time, displayedComponents: .hourAndMinute)
                if editor.frequency == .weekly {
                    Picker("Dia da semana", selection: $editor.weekday) {
                        Text("Domingo").tag(0); Text("Segunda").tag(1); Text("Terça").tag(2); Text("Quarta").tag(3); Text("Quinta").tag(4); Text("Sexta").tag(5); Text("Sábado").tag(6)
                    }
                }
                if editor.frequency == .monthly {
                    Stepper("Dia \(editor.monthDay) de cada mês", value: $editor.monthDay, in: 1...28)
                    Text("Até o dia 28, para valer em todos os meses.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Label(zoneIsThisMac ? "Horário deste Mac (\(AutomationRecurrence.zoneName(editor.timeZone)))" : "Horário de \(AutomationRecurrence.zoneName(editor.timeZone)), diferente deste Mac",
                  systemImage: "globe")
                .font(.caption).foregroundStyle(zoneIsThisMac && zoneIsValid ? Color.secondary : Color.orange)
                .help(editor.timeZone)
                .accessibilityIdentifier("automation-editor.zone-summary")
            DisclosureGroup(isExpanded: Binding(get: { showsAdvancedSchedule || advancedRequired }, set: { showsAdvancedSchedule = $0 })) {
                VStack(alignment: .leading, spacing: 10) {
                    if editor.frequency == .cron {
                        TextField("Cron de 5 campos: 0 9 * * 1-5", text: $editor.cron).font(.system(.body, design: .monospaced)).textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("automation-editor.cron")
                        Text("Minuto · hora · dia do mês · mês · dia da semana. O host valida a expressão e calcula as datas.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("Usar uma expressão cron") {
                            editor.cron = editor.when.cronExpression ?? editor.cron
                            editor.frequency = .cron
                        }
                        .accessibilityIdentifier("automation-editor.use-cron")
                        Text("Para horários que as opções acima não cobrem. Começa com a frequência escolhida.").font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        TextField("Fuso horário IANA", text: $editor.timeZone).textFieldStyle(.roundedBorder).accessibilityIdentifier("automation-editor.timezone")
                        Button("Usar o fuso deste Mac") { editor.timeZone = TimeZone.current.identifier }
                            .disabled(zoneIsThisMac).accessibilityIdentifier("automation-editor.timezone-this-mac")
                    }
                    Text(zoneIsValid ? "Ex.: America/Sao_Paulo. O calendário principal mostra as datas no fuso deste Mac." : "Fuso não reconhecido. Use um nome como America/Sao_Paulo.")
                        .font(.caption).foregroundStyle(zoneIsValid ? Color.secondary : Color.orange)
                }.padding(.top, 6)
            } label: {
                Text("Avançado: cron e fuso horário").font(.caption.weight(.medium)).accessibilityIdentifier("automation-editor.advanced")
            }
        }.padding(14).background(Color.secondary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .environment(\.timeZone, TimeZone(identifier: editor.timeZone) ?? .current)
    }

    /// Up to three tries while a busy editor finishes; each is the same read-only preview the button runs.
    private func autoPreview() async {
        for _ in 0..<3 {
            try? await Task.sleep(for: .milliseconds(350))
            guard !editor.locked else { continue }
            guard editor.frequency != .cron, zoneIsValid, editor.when.isValid, !editor.previewIsCurrent else { return }
            await editor.updatePreview()
            return
        }
    }
    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack { Text("Próximas execuções").font(.system(size: 13, weight: .semibold)); Spacer(); Button("Conferir datas") { Task { await editor.updatePreview() } }.disabled(editor.locked || !editor.when.isValid).help("Pede à base as próximas datas. Não cria nem altera nada.").accessibilityIdentifier("automation-editor.preview") }
            if editor.previewIsCurrent, let preview = editor.preview {
                ForEach(preview.dates, id: \.self) { value in Text(Date(timeIntervalSince1970: Double(value) / 1000), format: .dateTime.weekday(.abbreviated).day().month().year().hour().minute()).font(.system(size: 12)).monospacedDigit() }
            } else { Text(editor.frequency == .cron ? "Depois de alterar a expressão ou o fuso, use Conferir datas antes de salvar." : "Consultando as próximas datas na base… Se não aparecerem, use Conferir datas.").font(.caption).foregroundStyle(.secondary) }
        }.padding(14).background(Color.accentColor.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .environment(\.timeZone, TimeZone(identifier: editor.timeZone) ?? .current)
    }
    private func frequencyName(_ value: AutomationDraftEditor.Frequency) -> String { switch value { case .once: String(localized: "Uma vez"); case .interval: String(localized: "A cada X minutos"); case .daily: String(localized: "Todos os dias"); case .weekdays: String(localized: "Dias úteis (seg–sex)"); case .weekly: String(localized: "Toda semana"); case .monthly: String(localized: "Todo mês"); case .cron: String(localized: "Personalizada (cron)") } }
    /// Only real edits ask before closing: an existing automation opened and left as it was closes at once.
    private var hasChanges: Bool {
        guard let baseline = editor.baseline else { return !editor.title.isEmpty || !editor.content.isEmpty }
        return editor.title != baseline.title || editor.content != baseline.content || editor.when != baseline.when
    }
    private func close() { if hasChanges { confirmingDiscard = true } else { dismiss() } }
}
#endif
