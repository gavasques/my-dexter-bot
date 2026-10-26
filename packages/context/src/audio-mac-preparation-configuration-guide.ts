import type { AppConfigurationGuideField, AppConfigurationGuidePage } from './app-configuration-guide.js';

/** First-party, progressive operational delta. Static documentation never opens audio or prepares a Mac. */
export const AUDIO_MAC_PREPARATION_GUIDE_VERSION = '1.0.0';
type PageInput = Pick<AppConfigurationGuidePage, 'id' | 'title' | 'scope' | 'availability' | 'sourcePaths' | 'notes' | 'fields'>;
type Field = Readonly<AppConfigurationGuideField>;
const macScope = 'app assinado, configuração privada e instalação owner-local deste Mac, janela/geração atuais';
const voiceScope = 'tentativa Live do bot/conversa/base locais capturados, com áudio pertencente à sessão';
const human = 'Somente gesto humano no fluxo privado do app. Não existe handler do bot para preparar, conectar, reconectar, ativar microfone ou mudar TCC. Documentação não concede acesso.';
const getOnly = 'Conferir só lê o journal/intenção originais, registros públicos nativos e GETs da mesma base. Preserva requestID/hash/claimID/installation/fingerprint; nunca reenvia POST de setup/aprovação, provisiona chave ou lança auxiliar.';
const fields: Record<string, readonly Field[]> = {
  'chat-live': [
    { id: 'chat.live-voice.notice', title: 'Falha local antes da primeira voz', purpose: 'Separar recusa de microfone, dispositivo ausente, formato inválido e falha interna na inicialização.', scope: voiceScope,
      read: 'Leia a mensagem segura da tentativa e, sob demanda, a etapa e OSStatus numérico. inputUnavailable e outputUnavailable indicam a respectiva entrada/saída ausente; inputFormat/outputFormat/duplexFormat indicam incompatibilidade; initialization é falha do sistema de áudio. Recusa TCC permanece microphoneDenied, sem fingir aparelho ausente.',
      change: 'Somente leitura do resultado. A captura começa após gesto Live, permissão oficial do macOS e session.started. O app valida entrada e saída nativas separadamente, usa 24 kHz só no transporte/player e deixa o mixer converter para o hardware.',
      approval: human, result: 'Falha antes de ouvir voz não significa conversa concluída. Fallback de Voice Processing reconstrói somente o grafo local uma vez; não reenvia sessão ao provedor e não muda ajustes do sistema. Sem cancelamento de eco confirmado a UI orienta usar fones.',
      recovery: 'Em dispositivo/formato: o proprietário confere entrada/saída em Som. Em recusa: usa o fluxo oficial Privacidade › Microfone do app assinado. Nova sessão exige novo clique; não contornar TCC, trocar dispositivos, repetir ferramentas ou declarar áudio físico validado por build.',
      availability: 'ui_only', readOperation: null, changeOperation: null },
    { id: 'chat.live-voice.audio-diagnostic', title: 'Detalhes do áudio', purpose: 'Conservar a etapa conhecida e o status numérico sem expor informações privadas.', scope: voiceScope,
      read: 'Disclosure existente: Formato do microfone, Conversão do microfone, Inicialização do áudio ou Reprodução de áudio. Somente OSStatus Int32 de domínio reconhecido; sem NSError/userInfo, nome de dispositivo, áudio ou transcript.',
      change: 'Expandir ou recolher a apresentação local. Não há API do bot para consultar o diagnóstico nem controle para tentar novamente por este disclosure.', approval: human,
      result: 'A causa segura sobrevive ao encerramento e callbacks antigos não alteram a sessão nova. A etapa pode ser conhecida sem status numérico; não inventar um código.',
      recovery: 'Relatar apenas etapa e código disponíveis. A validação sintética não comprova microfone, TCC, saída audível ou provedor real.', availability: 'ui_only', readOperation: null, changeOperation: null },
  ],
  'mac-auto-setup': [
    { id: 'reconcile', title: 'Conferir', purpose: 'Recuperar a correlação de uma preparação existente sem repetir seus efeitos.', scope: macScope,
      read: 'Reabre configuração/política e fingerprint de native-device.json; compara intenção imutável e binding públicos. GET /v1/local-mac-agent/connection deve confirmar instalação, URL, pin e DER já autorizados. A presença vem de um GET de dispositivos desta consulta, sem promover uma projeção online antiga após erro.',
      change: getOnly, approval: 'Leitura pelo proprietário no app; não solicita nem aprova pareamento, grant, identidade, TCC ou CUA.',
      result: 'connected somente com vínculo do mesmo Mac, agente-mac pareado e online, não revogado e capabilities exigidas. Claim único válido só volta a awaitingApproval quando nunca houve tentativa de aprovação. Dados ausentes ou divergentes continuam incertos.',
      recovery: 'Conferir novamente conserva a tentativa. Se o executor já pareado estiver parado, o proprietário pode usar Reconectar auxiliar quando elegível; isso é um gesto separado. Nunca repetir aprovação incerta ou criar outro ID.', availability: 'human_only', readOperation: null, changeOperation: null },
    { id: 'preparation-detail', title: 'Etapa e recuperação da preparação', purpose: 'Mostrar o impedimento real sem confundir conexão com as três confirmações de acesso.', scope: macScope,
      read: 'Controller expõe stage inspection/channel/configuration/identity/agent/claim/approval/presence e preparationDetail seguro. Assinatura inválida, proteção de identidade não confirmada, bloqueio e conflito são causas separadas. O texto não inclui bytes privados, stderr ou configurações pessoais.',
      change: 'Somente apresentação; mac-auto-setup.preparation-detail no painel privado. Não há ferramenta do bot para alterar etapa ou marcar prontidão.', approval: 'Leitura na interface do proprietário; nenhum consentimento é substituído.',
      result: 'Conectado confirma apenas vínculo/presença. Grant/rota do host, autorização local do bot, TCC/calibração e sessão física continuam independentes.',
      recovery: 'Identidade bloqueada exige desbloqueio privado; assinatura/proteção exigem pacote oficial e diagnóstico privado, sem recriar chave, reduzir política ou substituir vínculo. Resultado de aprovação incerto fica em GET-only.', availability: 'read_only', readOperation: null, changeOperation: null },
    { id: 'reconnect', title: 'Reconectar auxiliar', purpose: 'Iniciar explicitamente o executor com um vínculo já confirmado, quando o processo está parado.', scope: macScope,
      read: 'Elegível apenas com configuração preparada, fingerprint/deviceId públicos correlacionados, binding existente, escopo atual e nenhum processo próprio vivo; não é prova de permissões do macOS.',
      change: 'Gesto humano mac-auto-setup.reconnect faz GET da conexão, compara instalação/URL/pin/DER e política, carrega somente a identidade existente pelo auxiliar assinado e inicia o daemon próprio com pairing:nil. Não cria oferta, chave ou aprovação.',
      approval: human, result: 'Conexão confirmada só após GET fresco do dispositivo online. Abrir a janela Dexter Control não concede TCC, calibração, superfície ou grant a bot.',
      recovery: 'Falha mantém vínculo/intenção e informa causa segura. Conferir é apenas leitura; nova reconexão continua humana. Não usar reconnect para resolver POST ainda incerto sem binding validado.', availability: 'human_only', readOperation: null, changeOperation: null },
    { id: 'stop', title: 'Parar auxiliar', purpose: 'Parar somente o executor possuído e pausar sua reconexão automática.', scope: macScope,
      read: 'Estado do processo próprio e fase do controller. stopping não significa encerrado nem rollback.', change: 'Gesto humano chama a parada graciosa existente e salva somente a preferência própria de pausa; mantém a intenção imutável da aprovação.', approval: human,
      result: 'Parado permanece incerto quando já existe fingerprint, vínculo ou aprovação. Parar não converte aprovação incerta em permissão para novo setup POST.',
      recovery: 'Conferir conserva pedido/vínculo; Reconectar auxiliar exige elegibilidade e gesto separados. Não parar processos do usuário, excluir identidade, resetar TCC ou presumir reversão.', availability: 'human_only', readOperation: null, changeOperation: null },
  ],
};
const sourcePaths = ['apps/apple/Sources/DexterAppCore/LiveVoiceAudio.swift', 'apps/apple/Sources/DexterAppCore/LiveVoiceController.swift',
  'apps/apple/Sources/DexterAppCore/MacAutoSetupController.swift', 'apps/apple/SharedApp/Sources/LiveVoiceViews.swift',
  'apps/apple/SharedApp/Sources/MacAgentSettingsView.swift', 'packages/context/src/audio-mac-preparation-configuration-guide.ts'];
const note = 'Audio/Mac preparation 1.0.0: inicialização local de áudio, correlação read-only da preparação e reconexão humana explícita são caminhos distintos. Nenhum build ou fixture certifica áudio físico, TCC, identidade real, CUA ou provedor.';

/** Apply before freezePage so the host computes versioned markdown/hash and progressive summaries. */
export function applyAudioMacPreparationGuideOverlay(page: PageInput): PageInput {
  const additions = fields[page.id];
  if (!additions) return page;
  const merged = new Map(page.fields.map(field => [field.id, field]));
  for (const field of additions) merged.set(field.id, Object.freeze(field));
  return { ...page, sourcePaths: [...new Set([...page.sourcePaths, ...sourcePaths])],
    notes: page.notes.includes(note) ? page.notes : [...page.notes, note], fields: [...merged.values()] };
}
