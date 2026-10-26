#if os(macOS)
import DexterAppCore
import DexterHostClient
import SwiftUI

@MainActor struct MemoryBackendSettingsSection: View {
    let localHost: LocalHostLaunchCoordinator?
    @Environment(DexterAppModel.self) private var model
    @State private var editor: MemoryBackendSettingsEditor?
    @State private var administrativeDraft = ""
    private var target: String { model.nativeComposerScope.uuidString + "|" + model.hostAddress + "|" + (localHost?.supervisor?.memoryBackendLifetime.uuidString ?? "") }
    var body: some View {
        Section("Memória · OpenViking") {
            Text("Conecte um servidor existente. Esta configuração vale para o host; cada bot usa seu próprio usuário e espaço. Ela não concede permissões aos bots.")
                .font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("settings.memory-backend.scope")
            if let editor {
                MemoryBackendControls(editor:editor,administrativeDraft:$administrativeDraft)
            } else {
                Text("Disponível na base local iniciada por este app. Selecione essa base e verifique a conexão para configurar.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .accessibilityIdentifier("settings.memory-backend.availability")
            }
        }
        .task(id:target) {
            administrativeDraft = ""; editor?.close()
            editor = localHost?.makeMemoryBackendEditor(model:model); editor?.open()
        }
        .onChange(of:editor?.canInitialize) { _, allowed in if allowed != true { administrativeDraft = "" } }
        .onDisappear { administrativeDraft = ""; editor?.close() }
    }
}

@MainActor private struct MemoryBackendControls: View {
    @Bindable var editor: MemoryBackendSettingsEditor
    @Binding var administrativeDraft: String
    var body: some View {
        TextField("Endereço do servidor",text:$editor.origin)
            .textFieldStyle(.roundedBorder).autocorrectionDisabled()
            .disabled(!editor.canEdit)
            .accessibilityIdentifier("settings.memory-backend.origin")
        Text("Informe apenas a origem HTTPS, sem caminho ou credenciais. Um túnel local pode usar HTTP com IP loopback e porta explícita.")
            .font(.footnote).foregroundStyle(.secondary)
        Toggle("Usar este servidor para memória",isOn:$editor.enabled)
            .disabled(!editor.canEdit)
            .accessibilityIdentifier("settings.memory-backend.enabled")
        HStack {
            Button("Salvar configuração") { administrativeDraft = ""; editor.save() }
                .disabled(!editor.canSave).accessibilityIdentifier("settings.memory-backend.save")
            Button("Verificar estado") { administrativeDraft = ""; editor.verify() }
                .disabled(editor.busy || !editor.scopeMatches).accessibilityIdentifier("settings.memory-backend.verify")
            if editor.busy { ProgressView().controlSize(.small) }
        }
        LabeledContent("Estado",value:stateDescription)
            .accessibilityIdentifier("settings.memory-backend.state")
        LabeledContent("Chave privada neste Mac",value:wrappingDescription)
            .accessibilityIdentifier("settings.memory-backend.wrapping-status")
        if editor.status?.state == .restartRequired {
            Text("A origem mudou. Reinicie o host local após concluir suas operações em andamento; depois desbloqueie a nova origem. Os pedidos antigos perdem autoridade imediatamente.")
                .font(.footnote).foregroundStyle(.orange)
                .accessibilityIdentifier("settings.memory-backend.restart-required")
        }
        if editor.status?.state != .configuredExternally {
            Picker("Permissão da chave administrativa",selection:$editor.administrativeRole) {
                Text("Administrador do servidor (ROOT)").tag(MemoryBackendAdministrativeRole.root)
                Text("Administrador do próprio espaço").tag(MemoryBackendAdministrativeRole.workspaceAdmin)
            }.disabled(editor.busy || !editor.scopeMatches)
                .accessibilityIdentifier("settings.memory-backend.administrative-role")
            SecureField("Chave administrativa para a primeira conexão",text:$administrativeDraft)
                .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                .disabled(!editor.canInitialize)
                .accessibilityIdentifier("settings.memory-backend.administrative-key")
            HStack {
                Button("Criar custódia e conectar") {
                    let secret = MemoryBackendOwnedSecret(administrativeKey:administrativeDraft)
                    administrativeDraft = ""
                    if let secret { editor.initialize(administrative:secret) }
                }.disabled(!editor.canInitialize || administrativeDraft.isEmpty || administrativeDraft.utf8.count > 4096)
                    .accessibilityIdentifier("settings.memory-backend.create")
                Button("Desbloquear conexão") { administrativeDraft = ""; editor.unlock() }
                    .disabled(!editor.canUnlock).accessibilityIdentifier("settings.memory-backend.unlock")
                Button("Bloquear conexão") { administrativeDraft = ""; editor.lock() }
                    .disabled(!editor.canLock).accessibilityIdentifier("settings.memory-backend.lock")
            }
        }
        Text("Salvar registra somente endereço e preferência. Criar custódia grava uma chave de proteção neste Mac e entrega a chave administrativa ao host por um canal privado. A chave administrativa fica cifrada fora do banco de conteúdo. Desbloquear usa apenas a chave deste host, proprietário e origem. Bloquear mantém a custódia para um próximo desbloqueio.")
            .font(.footnote).foregroundStyle(.secondary)
        Text("Desativar corta o acesso do host imediatamente. O servidor externo permanece sob sua administração. Configuração e conexão não comprovam busca semântica.")
            .font(.footnote).foregroundStyle(.secondary)
        if let notice = editor.notice { Text(notice.message).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("settings.memory-backend.notice") }
    }
    private var wrappingDescription: String {
        switch editor.wrappingStatus { case .missing: String(localized: "Não criada neste escopo"); case .configured: String(localized: "Salva neste escopo"); case .unavailable: String(localized: "Indisponível"); case .signingIdentityUnavailable: String(localized: "Assinatura autorizada necessária") }
    }
    private var stateDescription: String {
        switch editor.status?.state {
        case .disabled: String(localized: "Desativado")
        case .privateUnlockRequired: String(localized: "Aguardando conexão privada")
        case .configuredUnverified: String(localized: "Conectado · busca ainda não comprovada")
        case .restartRequired: String(localized: "Reinício do host necessário")
        case .configuredExternally: String(localized: "Configurado externamente · administração fora deste fluxo")
        case nil: String(localized: "Consultando configuração")
        }
    }
}
#endif
