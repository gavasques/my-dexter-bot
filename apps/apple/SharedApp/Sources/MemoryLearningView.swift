import DexterAppCore
import DexterHostClient
import SwiftUI

#if os(macOS)
/// "Memória de longo prazo": what this bot proposes to remember from its own private conversations.
/// It is separate from the Instruções / Sobre você / Memória documents, which stay exactly as they are.
/// Nothing is remembered, archived, forgotten or restored until you approve that exact request.
/// Reading (Atualizar, Conferir) never changes anything.
@MainActor struct MemoryLearningView: View {
    let editor: MemoryLearningEditor
    @Environment(\.locale) private var locale
    @State private var draft: MemoryLearningPolicyInput?
    @State private var showsSettings = false
    @State private var showsJobs = false
    @State private var showsActionDetails = false
    @State private var expandedEvidence: Set<String> = []
    @State private var forgetting: MemoryLearningRecord?

    private var status: MemoryLearningStatus? { editor.status }
    private var pendingCandidates: [MemoryLearningCandidate] { editor.candidates.filter { $0.state == .pending } }
    private var awaitingDecision: Bool { editor.pendingAction?.state == .awaitingDecision }
    /// One request at a time: a new proposal waits until the current one is decided and settled.
    private var canPropose: Bool {
        guard !editor.busy, status != nil else { return false }
        switch editor.pendingAction?.state {
        case nil, .applied?, .denied?, .failed?: return true
        case .awaitingDecision?, .running?, .unknown?: return false
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Label("Memória de longo prazo", systemImage: "brain").font(.headline)
                Spacer()
                if let status { stateChip(status) }
                Button("Atualizar") { Task { await editor.load() } }
                    .controlSize(.small).disabled(editor.busy)
                    .help("Só consulta a base. Não muda nada.")
                    .accessibilityIdentifier("memory.learning.refresh")
            }
            Text("O bot pode propor lembranças a partir das suas conversas privadas com ele. Você revisa cada proposta; nada entra na memória sem seu aceite. Personalidade, Sobre você e Memória, acima, continuam como estão.")
                .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let action = editor.pendingAction { actionPanel(action) }
            if let status {
                if status.extractor == .unconfigured || status.backend == .unavailable {
                    Text(status.extractor == .unconfigured
                         ? "Aprender com as conversas está indisponível nesta base: nenhum motor foi configurado para propor lembranças. Você ainda pode revisar e gerenciar o que já existe."
                         : "A memória de longo prazo está indisponível nesta base agora. Nada foi alterado.")
                        .font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("memory.learning.unavailable")
                }
                if let reason = status.reason, !status.effectiveEnabled, status.policy.enabled {
                    Text(reason).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                learningSwitch(status)
                suggestions(status)
                remembered(status)
                settings(status)
            } else if editor.busy {
                ProgressView("Lendo a memória de longo prazo…").controlSize(.small)
            } else if editor.error == nil {
                Text("Ainda não lido.").font(.footnote).foregroundStyle(.secondary)
            }
            if let error = editor.error {
                Text(verbatim: DexterLocalization.text(error, locale: locale)).font(.footnote).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("memory.learning.error")
            }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.18)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.learning")
        .task { await editor.load() }
        .confirmationDialog("Esquecer esta lembrança?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
                            titleVisibility: .visible, presenting: forgetting) { record in
            Button("Pedir aprovação para esquecer", role: .destructive) {
                if let target = target(record) { propose(.recordForget(target)) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in
            Text("O bot para de usar esta lembrança e não volta a aprendê-la das mesmas conversas. Ela é removida da memória ativa. O histórico interno e os backups já feitos continuam guardados até expirarem. Esquecer não pode ser desfeito.")
        }
    }

    // MARK: Pieces

    private func target(_ record: MemoryLearningRecord) -> MemoryLearningCommand.Target? {
        guard let policy = status?.policy else { return nil }
        return .init(id: record.id, expectedRevision: record.revision, policyRevision: policy.revision, scopeEpoch: policy.scopeEpoch)
    }
    private func target(_ candidate: MemoryLearningCandidate) -> MemoryLearningCommand.Target {
        .init(id: candidate.id, expectedRevision: candidate.expectedRevision, policyRevision: candidate.policyRevision, scopeEpoch: candidate.scopeEpoch)
    }
    private func propose(_ command: MemoryLearningCommand) {
        guard canPropose else { return }
        Task { await editor.propose(command: command) }
    }

    @ViewBuilder private func stateChip(_ status: MemoryLearningStatus) -> some View {
        let on = status.policy.enabled
        Group {
            if !on { Text("Desligado") } else if status.effectiveEnabled { Text("Ligado") } else { Text("Ligado, sem efeito") }
        }
        .font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 3)
        .background((on ? (status.effectiveEnabled ? Color.accentColor : .orange) : .secondary).opacity(0.14), in: Capsule())
        .accessibilityIdentifier("memory.learning.state")
    }

    /// Always a short summary first; the exact request is one click away.
    @ViewBuilder private func actionPanel(_ action: MemoryLearningPendingAction) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(actionHeadline(action)).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(showsActionDetails ? "Ocultar detalhes" : "Ver detalhes") { showsActionDetails.toggle() }
                    .buttonStyle(.link).font(.caption).accessibilityIdentifier("memory.learning.action.details")
            }
            Text(verbatim: DexterLocalization.text(action.summary, locale: locale)).font(.footnote).fixedSize(horizontal: false, vertical: true)
            if showsActionDetails {
                Text(verbatim: MemoryLearningText.details(action.command) + "\n" + String(localized: "Pedido \(action.actionID)"))
                    .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                switch action.state {
                case .awaitingDecision:
                    Button("Recusar") { Task { await editor.denyCurrent() } }.disabled(editor.busy)
                        .accessibilityIdentifier("memory.learning.action.deny")
                    Button("Aprovar") { Task { await editor.approveCurrent() } }.buttonStyle(.borderedProminent).disabled(editor.busy)
                        .accessibilityIdentifier("memory.learning.action.approve")
                case .unknown:
                    Button("Conferir estado") { Task { await editor.reconcile() } }.disabled(editor.busy)
                        .help("Só lê o resultado deste pedido na base. Não envia de novo.")
                        .accessibilityIdentifier("memory.learning.reconcile")
                case .running:
                    ProgressView().controlSize(.small)
                case .applied, .denied, .failed:
                    EmptyView()
                }
            }
        }
        .padding(10)
        .background((action.state == .unknown || action.state == .failed ? Color.orange : Color.accentColor).opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memory.learning.action")
    }
    private func actionHeadline(_ action: MemoryLearningPendingAction) -> String {
        switch action.state {
        case .awaitingDecision: String(localized: "Aguardando sua aprovação")
        case .running: String(localized: "Aplicando…")
        case .applied: String(localized: "Feito.")
        case .denied: String(localized: "Recusado. Nada mudou.")
        case .failed: String(localized: "Não foi aplicado. Nada mudou.")
        case .unknown: String(localized: "Resultado não confirmado. Nada será reenviado automaticamente.")
        }
    }

    @ViewBuilder private func suggestions(_ status: MemoryLearningStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: String(localized: "Propostas para revisar (\(pendingCandidates.count))")).font(.subheadline.weight(.semibold))
            if pendingCandidates.isEmpty {
                Text("Nenhuma proposta esperando você.").font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("memory.learning.candidates.empty")
            }
            ForEach(pendingCandidates) { candidate in
                VStack(alignment: .leading, spacing: 6) {
                    Text(candidate.content).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text(MemoryLearningText.friendly(candidate)).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button(expandedEvidence.contains(candidate.id) ? "Ocultar de onde veio" : "De onde veio") {
                            if expandedEvidence.contains(candidate.id) { expandedEvidence.remove(candidate.id) } else { expandedEvidence.insert(candidate.id) }
                        }.buttonStyle(.link).font(.caption)
                            .accessibilityIdentifier("memory.learning.candidate.evidence.\(candidate.id)")
                        Spacer()
                        Button("Rejeitar") {
                            propose(.candidateReject(target(candidate)))
                        }.controlSize(.small).disabled(!canPropose)
                            .accessibilityIdentifier("memory.learning.candidate.reject")
                        Button("Aceitar…") {
                            propose(.candidateAccept(target(candidate)))
                        }.controlSize(.small).buttonStyle(.borderedProminent).disabled(!canPropose)
                            .help("Pede sua aprovação para guardar exatamente este texto.")
                            .accessibilityIdentifier("memory.learning.candidate.accept")
                    }
                    if expandedEvidence.contains(candidate.id) {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(candidate.evidence.enumerated()), id: \.offset) { _, evidence in
                                Text(MemoryLearningText.evidence(evidence)).font(.caption2.monospaced()).foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding(10)
                .background(DexterSurface.raisedFill, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("memory.learning.candidate.\(candidate.id)")
            }
        }
    }

    @ViewBuilder private func remembered(_ status: MemoryLearningStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("O que o bot lembra").font(.subheadline.weight(.semibold))
            if editor.records.isEmpty {
                Label("Nada guardado ainda. As lembranças que você aprovar aparecem aqui.", systemImage: "brain")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("memory.learning.records.empty")
            }
            ForEach(editor.records) { record in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(record.state == .forgotten ? String(localized: "Lembrança esquecida") : (record.content ?? ""))
                            .font(.callout).foregroundStyle(record.state == .active ? .primary : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Text(MemoryLearningText.recordState(record.state)).font(.caption).foregroundStyle(.secondary)
                    }
                    if record.state == .forgotten {
                        Text(MemoryLearningText.forgotten).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("memory.learning.purge.status")
                    } else {
                        HStack {
                            if record.state == .active {
                                Button("Arquivar…") {
                                    if let target = target(record) { propose(.recordArchive(target)) }
                                }.controlSize(.small).disabled(!canPropose)
                                    .help("Tira da lembrança ativa e mantém no histórico. Pode ser desfeito.")
                                    .accessibilityIdentifier("memory.learning.record.archive")
                            }
                            // Undo reactivates an archived item as a new revision; a forgotten item never reaches this branch.
                            if record.state == .archived {
                                Button("Desfazer…") {
                                    if let target = target(record) { propose(.recordUndo(target)) }
                                }.controlSize(.small).disabled(!canPropose)
                                    .help("Reativa a lembrança arquivada como uma nova versão. O histórico fica como está.")
                                    .accessibilityIdentifier("memory.learning.record.undo")
                            }
                            Button("Esquecer…", role: .destructive) { forgetting = record }
                                .controlSize(.small).disabled(!canPropose)
                                .accessibilityIdentifier("memory.learning.record.forget")
                        }
                    }
                }
                .padding(8)
                .background(DexterSurface.insetFill, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("memory.learning.record.\(record.id)")
            }
            Text("Arquivar tira da lembrança ativa e pode ser desfeito. Esquecer bloqueia o uso na hora e não pode ser desfeito; o histórico interno e backups já feitos continuam guardados até expirarem.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The confirmed policy as an exact request input; drafts and the one-click switch both start from it.
    private func policyInput(_ policy: MemoryLearningPolicy) -> MemoryLearningPolicyInput {
        MemoryLearningPolicyInput(expectedRevision: policy.revision, enabled: policy.enabled, maintenanceEnabled: policy.maintenanceEnabled,
            dreamingEnabled: policy.dreamingEnabled, minIdleMs: policy.minIdleMs, maxJobsPerDay: policy.maxJobsPerDay,
            maxProposalsPerJob: policy.maxProposalsPerJob, timezone: policy.timezone, nightHour: policy.nightHour)
    }

    /// Everyday control: one request that only flips learning on or off, from the confirmed policy (revision and
    /// limits unchanged). Turning off also turns maintenance and dreaming off, as the host requires. It waits for
    /// your approval in the panel above; nothing changes on the click alone.
    @ViewBuilder private func learningSwitch(_ status: MemoryLearningStatus) -> some View {
        let policy = status.policy
        let hasDraft = draft != nil && draft != policyInput(policy)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Aprender com as conversas").font(.subheadline.weight(.semibold))
                Group {
                    if policy.enabled { Text("Ligado: o bot propõe lembranças para você revisar. Nunca grava sozinho.") }
                    else { Text("Desligado: o bot não propõe lembranças novas. O que já foi guardado continua.") }
                }
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if hasDraft {
                    Text("Envie ou descarte os ajustes avançados antes de ligar ou desligar.").font(.caption).foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 8)
            Button { proposeLearning(enabled: !policy.enabled, policy: policy) } label: {
                if policy.enabled { Text("Desligar…") } else { Text("Ligar…") }
            }
            .disabled(!canPropose || hasDraft || (!policy.enabled && status.extractor == .unconfigured))
            .help("Cria um pedido com só esta mudança. Nada muda até você aprovar o pedido.")
            .accessibilityIdentifier("memory.learning.enabled")
        }
    }

    private func proposeLearning(enabled: Bool, policy: MemoryLearningPolicy) {
        var input = policyInput(policy)
        input.enabled = enabled
        if !enabled { input.maintenanceEnabled = false; input.dreamingEnabled = false }
        propose(.policyUpdate(input))
    }

    @ViewBuilder private func settings(_ status: MemoryLearningStatus) -> some View {
        DisclosureGroup(isExpanded: $showsSettings) {
            let policy = status.policy
            let base = policyInput(policy)
            // Maintenance and dreaming only exist while learning is on; the host refuses otherwise. Learning itself
            // is switched above, so a draft here never changes it.
            let value = Binding(get: { draft ?? base }, set: { new in
                var next = new
                next.enabled = policy.enabled
                if !next.enabled { next.maintenanceEnabled = false; next.dreamingEnabled = false }
                draft = next
            })
            VStack(alignment: .leading, spacing: 8) {
                if !policy.enabled {
                    Text("Ligue o aprendizado acima para usar estes ajustes.").font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Organizar a memória (manutenção)", isOn: value.maintenanceEnabled).disabled(!value.wrappedValue.enabled).accessibilityIdentifier("memory.learning.maintenance")
                Text("Expira o que passou da validade e organiza a memória, sem inventar conteúdo.").font(.caption).foregroundStyle(.secondary)
                Toggle("Revisar nas pausas (sonhar)", isOn: value.dreamingEnabled).disabled(!value.wrappedValue.enabled).accessibilityIdentifier("memory.learning.dreaming")
                Text("Em momentos de pausa, revisa o que já sabe e só propõe mudanças. Sem ferramentas e sem acesso a outros bots.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Stepper(value: Binding(get: { value.wrappedValue.minIdleMs / 60_000 }, set: { value.wrappedValue.minIdleMs = max(2, $0) * 60_000 }), in: 2...1_440) {
                    Text(verbatim: String(localized: "Esperar \(value.wrappedValue.minIdleMs / 60_000) min sem conversa antes de trabalhar"))
                }.accessibilityIdentifier("memory.learning.idle")
                Stepper(value: value.maxJobsPerDay, in: 1...MemoryLearningPolicyInput.maximumJobsPerDay) {
                    Text(verbatim: String(localized: "Até \(value.wrappedValue.maxJobsPerDay) rodadas por dia"))
                }.accessibilityIdentifier("memory.learning.budget")
                Stepper(value: value.maxProposalsPerJob, in: 1...MemoryLearningPolicyInput.maximumProposalsPerJob) {
                    Text(verbatim: String(localized: "Até \(value.wrappedValue.maxProposalsPerJob) propostas por rodada"))
                }.accessibilityIdentifier("memory.learning.proposals")
                TextField("Fuso horário", text: value.timezone).accessibilityIdentifier("memory.learning.timezone")
                Picker("Horário noturno", selection: value.nightHour) {
                    Text("Qualquer hora").tag(Int?.none)
                    ForEach(0..<24, id: \.self) { hour in Text(verbatim: String(format: "%02d:00", hour)).tag(Int?.some(hour)) }
                }.accessibilityIdentifier("memory.learning.night")
                HStack {
                    Button("Descartar") { draft = nil }.disabled(draft == nil || draft == base)
                    Spacer()
                    Button("Pedir aprovação…") {
                        if let draft { propose(.policyUpdate(draft)); self.draft = nil }
                    }
                    .buttonStyle(.borderedProminent).disabled(!canPropose || draft == nil || draft == base)
                    .accessibilityIdentifier("memory.learning.policy.propose")
                }
                Divider()
                HStack {
                    Text("Rodar a manutenção agora").font(.caption)
                    Spacer()
                    Button("Pedir aprovação…") {
                        propose(.maintenanceRun(policyRevision: policy.revision, scopeEpoch: policy.scopeEpoch))
                    }.controlSize(.small).disabled(!canPropose || !policy.maintenanceEnabled)
                        .accessibilityIdentifier("memory.learning.maintenance.run")
                }
                Divider()
                jobs
            }.padding(.top, 6)
        } label: {
            Text("Avançado").font(.subheadline.weight(.semibold)).accessibilityIdentifier("memory.learning.advanced")
        }
        .onChange(of: status.policy.revision) { _, _ in draft = nil }
    }

    private var jobs: some View {
        DisclosureGroup(isExpanded: $showsJobs) {
            VStack(alignment: .leading, spacing: 4) {
                if editor.jobs.isEmpty { Text("Nenhuma atividade recente.").font(.caption).foregroundStyle(.secondary) }
                ForEach(editor.jobs) { job in
                    HStack(alignment: .firstTextBaseline) {
                        Text(job.kind == .dreaming ? "Sonho" : "Aprendizado").font(.caption.weight(.medium))
                        Text(MemoryLearningText.jobState(job.state)).font(.caption).foregroundStyle(job.state == .unknown || job.state == .conflict ? .orange : .secondary)
                    }
                    .accessibilityIdentifier("memory.learning.job.\(job.id)")
                }
            }.padding(.top, 4)
        } label: {
            Text("Atividade recente").font(.subheadline.weight(.semibold))
        }
        .accessibilityIdentifier("memory.learning.jobs")
    }
}

/// Plain-language Portuguese text for the memory screen; exact identifiers only inside expandable details.
enum MemoryLearningText {
    /// The same facts as `MemoryLearningCommand.details`, written through the catalog with typed values.
    static func details(_ command: MemoryLearningCommand) -> String {
        switch command {
        case .policyUpdate(let p):
            let maintenance = String(p.maintenanceEnabled)
            return p.enabled
                ? String(localized: "Aprendizagem: ativa; manutenção: \(maintenance); revisão \(p.expectedRevision). Máximo de \(p.maxJobsPerDay) jobs por dia e \(p.maxProposalsPerJob) propostas por job. Fuso: \(p.timezone).")
                : String(localized: "Aprendizagem: desligada; manutenção: \(maintenance); revisão \(p.expectedRevision). Máximo de \(p.maxJobsPerDay) jobs por dia e \(p.maxProposalsPerJob) propostas por job. Fuso: \(p.timezone).")
        case .candidateAccept(let t), .candidateReject(let t), .recordArchive(let t), .recordForget(let t), .recordUndo(let t):
            return String(localized: "Registro \(t.id); revisão \(t.expectedRevision), política \(t.policyRevision), escopo \(t.scopeEpoch). Esquecer bloqueia uso e reaprendizagem imediatamente; histórico e backups continuam retidos.")
        case .maintenanceRun(let revision, let epoch):
            return String(localized: "Política \(revision), escopo \(epoch). Arquiva duplicatas exatas e expira registros vencidos; propostas semânticas continuam sujeitas a aprovação.")
        }
    }
    static func kind(_ kind: MemoryLearningCandidate.Kind) -> String {
        switch kind {
        case .preference: String(localized: "uma preferência sua")
        case .fact: String(localized: "um fato")
        case .procedure: String(localized: "um jeito de fazer algo")
        case .hypothesis: String(localized: "uma suposição a confirmar")
        case .contradiction: String(localized: "algo que contradiz o que já sabe")
        }
    }
    static func confidence(_ confidence: MemoryLearningCandidate.Confidence) -> String {
        switch confidence {
        case .explicit: String(localized: "você disse isso diretamente")
        case .supported: String(localized: "aparece nas conversas")
        case .uncertain: String(localized: "pouco certo")
        }
    }
    static func friendly(_ candidate: MemoryLearningCandidate) -> String {
        let sources = candidate.evidence.count
        var text = String(localized: "Parece \(kind(candidate.kind)); \(confidence(candidate.confidence)). Baseado em \(sources) trecho(s) de conversa.")
        if candidate.expectedRevision > 0 { text += " " + String(localized: "Substitui uma lembrança existente.") }
        return text
    }
    static func evidence(_ evidence: MemoryLearningEvidence) -> String {
        let who: String = switch evidence.role { case .user: String(localized: "você"); case .assistant: String(localized: "o bot"); case .memory: String(localized: "memória") }
        return "\(who) · \(evidence.sourceId) · \(evidence.start)–\(evidence.end)"
    }
    static func recordState(_ state: MemoryLearningRecord.State) -> String {
        switch state {
        case .active: String(localized: "Ativa")
        case .archived: String(localized: "Arquivada")
        case .expired: String(localized: "Expirada")
        case .forgotten: String(localized: "Esquecida")
        }
    }
    static let forgotten = String(localized: "Bloqueada para uso e para reaprender das mesmas conversas. A remoção das cópias ativas é concluída pela base; o histórico interno e backups já feitos continuam guardados até expirarem.")
    static func jobState(_ state: MemoryLearningJob.State) -> String {
        switch state {
        case .queued: String(localized: "na fila")
        case .claimed, .dispatched: String(localized: "em andamento")
        case .proposed: String(localized: "gerou propostas")
        case .empty: String(localized: "nada novo")
        case .unknown: String(localized: "sem confirmação")
        case .conflict: String(localized: "não aplicado: a memória mudou")
        case .withdrawn: String(localized: "cancelado")
        }
    }
}
#endif
