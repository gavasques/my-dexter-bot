/** Sidebar presentation only. This module grants no capability and registers no executable operation. */
export const BOT_ACTIVITY_GUIDE_REVISION = "1.0.0";
const scope = "sidebar da janela Dexter, base e conversa canônica atualmente observadas pelo app";
const approval = "Leitura/apresentação local sem mutação, decisão de ação ou concessão de acesso. Este manual não opera a UI. Permitir/Negar/Parar e receipts conservam seus fluxos próprios.";
const recovery = "Se a observação parar, falhar, vencer ou perder conexão/escopo, o indicador cessa e a atividade fica não observada. Atualizar/reabrir a conversa relê o estado pelos fluxos existentes; não reenvie mensagem, ação ou aprovação para recuperar uma animação.";
function display(id: string, title: string, purpose: string, read: string, result: string) {
  return { id, title, purpose, scope, read, change: "Somente apresentação; nenhuma operação de alteração por este indicador.",
    approval, result, recovery, availability: "read_only" as const, readOperation: null, changeOperation: null };
}

export const BOT_ACTIVITY_GUIDE_PAGE_INPUT = {
  id: "bot-activity", title: "Atividade observada dos bots na sidebar", scope, availability: "read_only" as const,
  sourcePaths: ["apps/apple/SharedApp/Sources/DexterRootView.swift", "apps/apple/SharedApp/Sources/AvatarViews.swift",
    "apps/apple/Sources/DexterAppCore/BotMascotObservedActivity.swift", "apps/apple/Sources/DexterAppCore/BotSidebarActivitySnapshot.swift",
    "apps/apple/Sources/DexterAppCore/BotActivityIndicatorView.swift", "apps/apple/Sources/DexterAppCore/BotMascotMotion.swift",
    "apps/apple/Sources/DexterAppCore/DexterAppModel.swift"],
  notes: [
    "Revisão bot-activity 1.0.0. O catálogo first-party compõe versão/hash e entrega esta página sob demanda. Animação é apresentação de observações já disponíveis; não chama provider, lê processo, faz rede, inicia tarefa ou altera o bot.",
    "Limite atual: uma conversa canônica observada pelo app. Todas as ocorrências do mesmo bot (isolado, coordenador, membro em vários Times) recebem a mesma projeção exata. Outros bots permanecem estáticos com Atividade não observada; isso não afirma que estão ociosos. Um membro trabalhando em outra conversa não é descoberto por esta sidebar. O Time reflete somente seu coordenador observado, sem marcar membros ocupados por associação.",
    "Turno running sem texto observado significa Trabalhando; texto de resposta realmente recebido significa Escrevendo; ação running iniciada neste turno ou tool.requested ainda sem tool.resolved significa Usando ferramenta. Aprovação awaiting_approval própria e não vencida significa Precisa de você. Queued/interrupted/unknown não afirmam progresso. Conclusão confirmada aparece por 2500ms; falha confirmada por 6000ms, somente com finishedAt do host e relógio não anterior ao término.",
    "Pensando não é inferido de silêncio, latência, turno running, nome da engine ou texto que diz estar pensando. O contrato Apple atual não expõe evento de raciocínio; este estado permanece prévia do criador. A UI também não fabrica Reconectando a partir de offline; o renderer suporta o estado apenas para um futuro sinal real e scoped de reconexão.",
    "A disponibilidade da observação é controlada pelo AppModel, separada da operação remota. Parar observação/indicador não confirma cancelamento do host nem reversão de efeitos. Offline, erro do observer, prazo encerrado, troca de base/conversa e cancelamento impedem spinner obsoleto. A janela usa um único agendamento finito de expiração, sem polling por linha.",
    "A imagem/receita/emoji/ícone conservam precedência e identidade/hash; o indicador sobreposto não troca nem grava avatar. O badge ocupa o quadrado existente sem aumentar a altura da linha. Formas/símbolos e texto/valor acessível PT/EN distinguem estados além da cor. Prévia do editor não é observação de produção.",
    "Não há ferramenta de consulta global de atividade nem de forçar fase/animação. Use somente aliases realmente expostos no tools/list. dexter.harness.status identifica bot/conversa/configuração disponíveis; não contém fase de reasoning nem prova de execução. dexter.harness.actions.read {action_id} consulta a ação exata própria e sua continuação quando exposta; não enumera atividade privada dos outros bots. GET /v1/threads/:id/turns, /v1/turns/:id/events e ações são leituras do cliente autorizado existente, não aliases novos do bot.",
  ],
  fields: [
    display("bot.<botID>", "Bot: estado e avatar", "Identificar a atividade realmente observada sem mudar seleção ou altura da linha.",
      "Nome/identidade existentes; subtítulo temporário, badge e valor acessível da própria projeção. ID do bot e thread devem corresponder ao turno. Sem observação disponível: Atividade não observada.",
      "A mesma ocorrência mostra o mesmo estado do bot; animação não é receipt, autenticação nem medição de progresso percentual."),
    display("sidebar.team.<teamID>", "Time: atividade do coordenador", "Mostrar o coordenador observado também quando o Time está recolhido.",
      "Badge/subtítulo do Time e valor acessível derivados apenas de coordinatorBotId observado. Imagem/emoji próprios do Time continuam visíveis; avatares agrupados conservam as identidades dos membros.",
      "Estado do coordenador, sem afirmar trabalho de todos os membros e sem abrir suas conversas."),
    display("sidebar.team.<teamID>.bot.<botID>", "Coordenador e membros", "Conservar a mesma atividade em todas as ocorrências do bot.",
      "Valor acessível e subtítulo de Coordenador/Membro usam o mesmo snapshot por bot da linha isolada, independente da origem de seleção e do Time.",
      "Nenhum clone, agregação de conversas privadas, fan-out ou grant por participação no Time."),
    display("bot-activity.observed-state", "Consultar fatos e limites", "Distinguir estado observado de configuração ou prosa do modelo.",
      "Estado visível vem de currentTurn/actions/textObserved e disponibilidade do observer na conversa canônica. Se dexter.harness.actions.read estiver exposta, consulte somente action_id já conhecido e próprio; dexter.harness.status não expõe fase interna do modelo.",
      "Fatos retornados e limites explícitos. Ferramenta ausente não autoriza inventar alias, ler banco/credenciais ou procurar outro bot."),
    display("bot-activity.observation-lifecycle", "Disponibilidade da observação", "Encerrar indicadores de trabalho quando a observação exata deixa de ser válida.",
      "botActivityObservationAvailable e conversationObservationWasStopped do AppModel, conexão atual e turno terminal fresco. Falha/prazo/cancelamento/troca de escopo não conservam running em tela. Conclusão/falha canônica fresca pode mostrar seu símbolo pelo prazo curto, se a conexão e o escopo continuarem válidos.",
      "Atividade não observada após perda da observação; isso não afirma cancelamento remoto, ausência de trabalho ou reversão de efeito."),
    { id: "bot-activity.motion", title: "Movimento da apresentação", purpose: "Respeitar a preferência visual existente do avatar.", scope,
      read: "Receita avatarAppearance.motion none/subtle/lively carregada do perfil; ausência de receita usa indicador suave. Leia bot-mascot para o editor real.",
      change: "Não existe configuração nova na sidebar. Oriente o usuário ao movimento do mascote no perfil e seu salvamento CAS existente; não há handler de UI para editar este controle pelo manual.",
      approval: "Preferência de perfil conserva a aprovação e revisão do salvamento real; documentação não autoriza mutação nem concede ferramenta.",
      result: "Parado preserva símbolo/expressão estática; outras escolhas permitem somente o orçamento local. Não altera estado operacional, engine ou velocidade.", recovery,
      availability: "ui_only" as const, readOperation: null, changeOperation: null },
    { id: "bot-activity.reduce-motion", title: "Reduzir Movimento", purpose: "Exibir estado legível sem animação conforme acessibilidade do sistema.", scope: "preferência de acessibilidade do sistema e janela atual",
      read: "Environment accessibilityReduceMotion efetivamente fornecido pelo SwiftUI. O badge e o mascote ficam estáticos quando ligado; rótulo e símbolo permanecem.",
      change: "Somente usuário nos ajustes de acessibilidade do macOS/iOS. Nenhum botão, comando ou ferramenta do harness é criado para alterar essa preferência.",
      approval: "Ação humana nas configurações do sistema. O bot pode orientar, sem inferir autorização de controle do computador.",
      result: "Apresentação estática do mesmo estado observado, sem parar ou iniciar a tarefa do bot.", recovery: "Ao mudar a preferência, o ambiente da janela recalcula a apresentação; sem reiniciar engine, reenviar ação ou mexer em permissões.",
      availability: "human_only" as const, readOperation: null, changeOperation: null },
    display("bot-activity.animation-budget", "Visibilidade e energia", "Limitar trabalho gráfico sem alterar os fatos.",
      "Badge ativo no máximo12fps,6fps em baixo consumo; sem Timeline quando oculto, cena inativa, Parado ou Reduzir Movimento. Aprovação/erro/conclusão usam símbolos estáticos. Mascotes pequenos mantêm o orçamento esparso existente.",
      "Lista estável e timers locais limitados; nenhum polling de host/provider por avatar."),
  ],
};
