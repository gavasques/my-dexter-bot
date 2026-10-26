/** Owner UI projection and navigation; no document grants physical computer access. */
const scope = "bot escolhido, este Mac e base owner-local atuais";
const recovery = "Use Verificar de novo para reler o mesmo escopo. Erro ou estado desconhecido não permite repetir efeitos, criar identidade, trocar base ou presumir autorização.";
function read(id: string, title: string, purpose: string, state: string) {
  return {id, title, purpose, scope, read: state, change: "Somente apresentação; não altera configuração.",
    approval: "Consulta na interface do proprietário; sem concessão de acesso.", result: "Projeção das fontes realmente lidas; desconhecido continua desconhecido.",
    recovery, availability: "read_only" as const, readOperation: null, changeOperation: null};
}
function ui(id: string, title: string, purpose: string, state: string, change: string, result: string) {
  return {id, title, purpose, scope, read: state, change,
    approval: "Gesto humano na UI; confirmações de preparação, grants, política local e consentimento físico permanecem separadas. Handler do bot ausente para este controle.",
    result, recovery, availability: "human_only" as const, readOperation: null, changeOperation: null};
}
export const MAC_SCREEN_CONTROL_GUIDE_PAGE_INPUT = {
  id: "mac-screen-control", title: "Controle de tela: preparação guiada", scope, availability: "human_only" as const,
  sourcePaths: ["apps/apple/SharedApp/Sources/MacScreenControlSheet.swift", "apps/apple/SharedApp/Sources/SettingsView.swift",
    "apps/apple/SharedApp/Sources/MacCuaConfigurationView.swift", "apps/apple/SharedApp/Sources/DevicesView.swift",
    "apps/apple/Sources/DexterAppCore/MacScreenControlGuide.swift", "apps/apple/Sources/DexterAppCore/MacSetupHandoffCoordinator.swift"],
  notes: [
    "O painel mostra o próximo passo confirmado e mantém detalhes sob demanda. Abrir/Verificar de novo só inspeciona metadados públicos do pacote, configuração/política locais privadas e GETs owner de health, bots, dispositivos, grants e rotas do bot escolhido. Não cria controller de preparação, identidade, pairing, grant, rota, processo ou prompt TCC ao abrir.",
    "A conexão do agente, capacidades anunciadas, grant/rota da base, autorização local do bot e sessão física são camadas distintas. Configurado não significa permissão do macOS ou sessão ativa. Grant negado/expirado prevalece sobre revisão fresca. Nenhuma etapa é completada por um texto do bot.",
    "O receipt mac_setup_handoff abre uma vez o mesmo painel, fixo no bot/conversa/base originais, somente depois de aprovação humana nova, hash/identidade/revisão/prazo válidos. Histórico, consulta, replay e restart não navegam. Leia mac-auto-setup para os schemas reais mac.setup.status/request. Encaminhar é navegação; não prepara nem concede controle.",
    "Preparação pode reiniciar o host próprio: fica bloqueada durante turno, envio, seleção ou voz ativa/incerta. Abrir o painel pelo chat não retira esse gate. Cada uso continua no Dexter Control, com permissão física AX/Input Monitoring, calibração, app escolhido, indicador e Parar. Não presumir Gravação de Tela, nova lease automática ou continuação de setup ainda não implementada.",
  ], fields: [
    ui("settings.computer-access.screen-control", "Controle de tela…", "Abrir a preparação guiada em Ajustes › Este Mac.", "Disponibilidade da base/pacote e bot escolhido na UI.", "Abra MacScreenControlSheet; escolha de bot é rascunho.", "Painel aberto sem preparação ou concessão."),
    ui("mac-screen-control.close", "Fechar (× / Esc)", "Fechar o painel com controle fixo fora da rolagem.", "Cabeçalho do painel.", "Dispensar somente o painel.", "Nenhuma autorização é alterada; reabrir consulta estado salvo."),
    ui("mac-screen-control.bot", "Bot", "Consultar a configuração de um bot específico.", "Lista canônica de bots da base; handoff mostra bot fixo.", "Selecionar rascunho relê grants/rotas desse bot; handoff não permite trocar alvo.", "Configuração de outro bot não é aplicada ou compartilhada."),
    read("mac-screen-control.summary", "Estado da preparação", "Mostrar o próximo impedimento confirmado.", "Resumo unavailable/attention/chooseBot/remaining/configured, sem inferir TCC ou sessão."),
    read("mac-screen-control.step.mac", "Este Mac conectado", "Distinguir preparação, pairing e presença.", "Configuração preparada, agente próprio, binding e capacidades anunciadas; processo vivo sozinho não basta."),
    read("mac-screen-control.step.hostAccess", "Acesso do bot na base", "Conferir grants e rotas das três operações próprias.", "mac.cua.status/observe/control: valid/missing/denied/expired/revision_required/not_published/unknown; deny/expiry antes da revisão."),
    read("mac-screen-control.step.localAuthorization", "Autorização neste Mac", "Conferir a política privada por bot.", "Operações e duração máxima no arquivo de política local; deny é o padrão."),
    read("mac-screen-control.step.macPermissions", "Permissões neste Mac", "Indicar o passo físico sem fingir leitura de TCC.", "Confirme neste Mac; Acessibilidade/Input Monitoring são verificados no Dexter Control, não neste painel."),
    read("mac-screen-control.step.eachUse", "A cada uso", "Explicar o consentimento para uma sessão específica.", "Escolha do app, confirmação, indicador e Parar / ⌃⌥⌘. são requisitos físicos de cada sessão."),
    ui("mac-screen-control.action", "Próximo passo", "Abrir uma única operação útil conforme o estado real.", "Ação derivada das etapas lidas; preparação desabilitada enquanto localRuntimeSetupRefusal/busy estiver ativo.", "Preparar/Iniciar abre MacAutoSetupView por gesto explícito; Parar confirma agente próprio; Revisar acessos abre DeviceGrantsSheet no bot; Mostrar Dexter Control ativa só helper já aberto; Avançado abre editor existente; Verificar só relê.", "Somente o fluxo realmente escolhido e suas confirmações produzem efeitos; sem auto-retry."),
    ui("mac-screen-control.review-access", "Revisar acessos…", "Abrir grants/rotas do bot correto.", "Bot e dispositivo atuais.", "Abrir DeviceGrantsSheet preselecionado; leia device-grants/device-routes para operações e decisões.", "Navegação; abrir não concede grant nem rota."),
    ui("mac-screen-control.change-local", "Alterar autorização local", "Editar a política já existente.", "Snapshot da política local do bot.", "Expandir MacCuaConfigurationView com bot fixo; Salvar/Remover conservam confirmação e agente parado.", "Rascunho ainda não é política salva."),
    read("mac-screen-control.details", "Detalhes do acesso", "Comparar as camadas por operação.", "Grade separa Anunciado, Base e Este Mac; não soma camadas como permissão pronta."),
    ui("mac-screen-control.advanced", "Configuração avançada…", "Abrir controles privados existentes.", "Configuração local atual.", "Abrir MacAdvancedSettingsSheet; leia mac-agent-setup, mac-cua, mac-browser e mac-selected-files sob demanda.", "Navegação; cada controle conserva aprovação própria."),
    ui("mac-screen-control.check", "Verificar de novo", "Recuperar a projeção sem repetir mutações.", "Estado das leituras atuais.", "Reler somente as fontes/GETs do mesmo bot/base.", "Estado confirmado ou erro seguro; nenhum provision/start/grant/pairing."),
    read("mac-screen-control.notice", "Aviso", "Explicar a falha ou indisponibilidade concreta.", "Aviso seguro de leitura, helper não aberto ou preparação bloqueada; sem diagnóstico inferido."),
    read("mac-setup.handoff.sheet", "Painel aberto pelo chat", "Identificar a navegação de um encaminhamento aprovado novo.", "Mesmo painel, bot fixo no host/bot/thread/hash da aprovação nova dentro do prazo; histórico fica inerte."),
    ...(["bot", "save", "remove", "reload"] as const).map(control => ui(`settings.mac-cua.${control}`,
      ({bot: "Bot (avançado)", save: "Salvar autorização", remove: "Remover autorização", reload: "Recarregar"})[control],
      "Usar o controle existente da política CUA no escopo fixo.", "Snapshot privado do bot e revisão atuais.",
      "Leia mac-cua: bot seleciona rascunho; Salvar/Remover confirmam com agente parado e CAS; Recarregar só relê.",
      "Confirmação da política local não concede grant/rota/TCC nem abre sessão física.")),
  ],
};
