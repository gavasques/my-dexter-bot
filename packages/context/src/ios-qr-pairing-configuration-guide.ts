import { createHash } from "node:crypto";
import type { AppConfigurationGuideField, AppConfigurationGuidePage } from "./app-configuration-guide.js";

/** First-party progressive manual, composed by the host. No skill, tool authority or pairing grant is installed here. */
export const IOS_QR_PAIRING_GUIDE_VERSION = "1.1.0";
export const IOS_QR_PAIRING_GUIDE_REVISION = "ios-qr-pairing-2026-10-15-r7";
type PageInput = Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
const scope = "app privado do iPhone × base do Mac convidante; convite de uso único e identidade local exata";
const approval = "Somente interface humana. Nenhuma ferramenta do harness cria identidade, lê QR/câmera, prepara Keychain/TLS ou aprova o próprio aparelho. Conectar pede aprovação no Mac; documentação não concede OAuth, TCC, pareamento, scopes ou grants a bots.";
const recovery = "Convite expirado exige novo convite no Mac. Usado/cancelado não é repetido. Após reserva durável sem ACK, outcomeUnknown é conservado no journal exato, inclusive após fechar/desanexar/reiniciar; confira no Mac e nunca troque de ID/identidade para repetir. Restaurar/verificar só carrega a identidade existente e consulta o claim; nunca recria a chave nem reenvia claim.";
const sourcePaths = [
  "apps/apple/Sources/DexterAppCore/DexterAppModel.swift",
  "apps/apple/Sources/DexterAppCore/PairedHostOnboarding.swift",
  "apps/apple/Sources/DexterAppCore/PairingInvitationQR.swift",
  "apps/apple/Sources/DexterAppCore/LocalAppClientChannel.swift",
  "apps/apple/Sources/DexterAppCore/LocalHostProcess.swift",
  "apps/apple/SharedApp/Sources/IOSMacConnectionView.swift",
  "apps/apple/SharedApp/Sources/PairingQRScanner.swift",
  "apps/apple/SharedApp/Sources/PairingInvitationQRCode.swift",
  "apps/apple/SharedApp/Sources/OwnerPairingOfferViews.swift",
  "apps/apple/SharedApp/Sources/DexterRootView.swift",
  "apps/apple/SharedApp/Sources/SettingsView.swift",
];
function control(id: string, title: string, purpose: string, read: string, change: string, result: string,
  recover = recovery): AppConfigurationGuideField {
  return { id, title, purpose, scope, read, change, approval, result, recovery: recover,
    availability: "human_only", readOperation: null, changeOperation: null };
}


const macScope = "base própria iniciada pelo app deste Mac; instalação/dono e geração de custódia exatos";
const macApproval = "Gesto humano na interface owner-local deste Mac, sem conversa ou setup em execução. O harness não prepara nem renova Keychain/TLS e o bot não pode aprovar o próprio acesso. Preparar/renovar não cria convite, claim ou grant.";
const macRecovery = "Leitura de status não repete preparação. Certificado expirado, IP mudado ou custódia inacessível: Recriar conexão segura exige confirmação e gera novo pin; os aparelhos precisam escanear novo QR e ser aprovados novamente. Uma preparação interrompida só retoma a mesma geração/creationId. Startup e Apply nunca rotacionam. Falha conhecida após saída confirmada pode restaurar apenas o chat local uma vez, com aviso; parada incerta conserva o writer próprio e bloqueia outro filho. Não apague arquivos nem recrie chave para contornar incerteza.";
function macControl(id: string, title: string, purpose: string, read: string, change: string, result: string,
  recover = macRecovery): AppConfigurationGuideField {
  return { id, title, purpose, scope: macScope, read, change, approval: macApproval, result, recovery: recover,
    availability: "human_only", readOperation: null, changeOperation: null };
}

export const IOS_QR_PAIRING_GUIDE_PAGE_INPUT: PageInput = {
  id: "ios-qr-pairing", title: "Conectar o iPhone ao Mac por QR", scope, availability: "human_only", sourcePaths,
  notes: [
    `Revisão ${IOS_QR_PAIRING_GUIDE_REVISION}, versão ${IOS_QR_PAIRING_GUIDE_VERSION}.`,
    "O iPhone abre Conecte ao seu Mac sem bots de exemplo. Preferências fixture automáticas de versões antigas não retomam uma demonstração. A demonstração só entra por gesto explícito de desenvolvimento e não prova host/inferência. Uma identidade e claim previamente selecionados são restaurados automaticamente no lançamento, com loadOnly, TLS pinado, mTLS e health reais; não há chave nova nem aprovação nova por abrir o app.",
    "No Mac: Ajustes › Este Mac › Conectar aparelhos › Convidar outro aparelho. Canal indisponível não vira convite fictício. Preparar conexão segura é gesto humano separado: coordinator só reinicia o filho que este app possui, sem conversa/operação ativa, prepara custódia privada e listener TLS1.3 no endereço Tailscale específico. Os aparelhos precisam alcançar essa rede. A disponibilidade final vem de GET owner-local /v1/owner/app-client-pairing/status, nunca apenas da configuração salva. Certificado expirado (validade365dias), IP privado mudado, instalação substituída ou custódia inacessível têm recuperação humana Recriar conexão segura: geração/caminho/item Keychain novos, sem sobrescrever a custódia anterior, pin antigo deixa de ser servido e aparelhos exigem novo QR/aprovação. Startup e Apply só tentam unlock existente; falha opcional não bloqueia o chat local nem mudança de engine. Nenhuma preferência salva comprova login/ACL/alcance Tailscale.",
    "Conectar iPhone é a escolha explícita client-ios e cria uma única oferta pelo mesmo contrato/receipt/revisão/journalPin/dedupe existentes. O resumo visível mostra scopes atuais e validade; a sheet começa com até5min (mínimo da base respeitado). Outro aparelho e permissões mantém client-mac e opt-ins individuais. Preparar/abrir a sheet não envia POST de oferta.",
    "O QR contém EXATAMENTE invitationText já verificado contra o SHA256 do receipt: JSON existente dexter-app-client-v1, certificado/pin/instalação/role/scopes/TTL/code. CoreImage local, correctionL, até2953 bytes; acima disso há fallback privado Copiar/Colar. Nenhuma URL pública/encurtador/upload é criado. QR/code/texto ficam só na UI privada em memória, não em chat, eventos, logs, analytics, defaults ou arquivos.",
    "A câmera é solicitada somente ao tocar Escanear. AVFoundation lê apenas metadata QR; não captura nem retém foto/áudio. Uma leitura fecha o gate e para a sessão. Cancelar/fechar/background para a sessão própria e impede callback tardio; voltar ao foreground não reinicia câmera sem novo gesto. Negada/indisponível: explique e ofereça Colar, sem mudar TCC nem abrir Settings sozinho.",
    "Inspeção/review é só leitura: máximo8192 bytes, shape fechado, role client-ios, scopes fechados/ordenados, code43base64url, certificado/pin/URL existentes e TTL válido. Nenhum key provision/claim antes de Conectar. O QR recebido ainda exige confiança no Mac/canal que o entregou; um QR hostil não ganha autoridade por ser legível.",
    "Conectar importa o mesmo bundle, provisiona explicitamente a identidade privada local apenas se ausente e envia um claim pelo transporte TLS/mTLS pinado. O journal conserva a reserva antes do handoff e o ACK antes da preferência. pending mostra o mesmo PairingVerificationCode.text(clientFingerprint) nos dois aparelhos. Aprovação humana Mac usa os handlers/receipts existentes de owner-pairing-claims, sem autoaprovação nem grants a bots.",
    "Enquanto pending e em foreground, o iPhone consulta o claim a cada3s; o Mac consulta o receipt da oferta aberta a cada2s e abre a revisão quando claimed. Esses observers apenas leem e param ao fechar/background/terminal. HostClient real só entra no model após binding aprovado, pins/scopes/identidade conferidos e health real; bots/conversas vêm dessa base. Offline, revoked, identidade ausente/bloqueada e unknown continuam estados honestos.",
    "R5-05: a entrada de rota nativa preserva draft somente na mesma base/composerScope, bot, thread e geração atuais, com TTL válido; atualiza apenas o scope da apresentação após as leituras canônicas. Navegação/host/expiração invalidam. R5-06: demo explícita abre somente a projeção fixture fechada em memória, sem GET/POST do host. Envio real continua dependendo do gesto humano e do escopo exato.",
  ],
  fields: [
    control("ios-pairing.title", "Conecte ao seu Mac", "Identificar a tela inicial sem conexão.",
      "Título exibido quando não há review ou claim pending.", "Somente leitura; não inicia conexão, câmera ou demo.", "Primeiro uso real identificado claramente."),
    control("ios-pairing.onboarding", "Conecte ao seu Mac", "Mostrar o primeiro uso real do iPhone.",
      "Sem fixture e sem canUseHost, DexterRootView mostra esta página. PairedHostOnboarding.state/publicReference descrevem a conexão; bots vazios não são substituídos por samples.",
      "Abrir só apresenta instruções e tenta uma vez a restauração loadOnly da referência já selecionada.",
      "Primeiro uso sem identidade/rede: conexão ainda não iniciada. Referência aprovada só conecta após transporte/health reais."),
    control("ios-pairing.scan", "Escanear QR do Mac", "Ler o convite privado exibido no Mac.",
      "Botão visível fora de review/pending/unknown; câmera ainda não foi solicitada.",
      "Gesto abre ios-pairing.scanner e só então solicita permissão video pelo iOS.", "Scanner real de metadata QR, sem imagem persistida."),
    control("ios-pairing.scanner", "Câmera do convite", "Localizar um QR usando AVFoundation.",
      "Preview local, estado de autorização video e gate aceita um resultado. Código recebido limitado a8192bytes.",
      "Uma leitura para sessão e entrega somente o texto ao review privado. Fechar/background fecha gate e sessão.", "Review do convite ou aviso de shape/role/pin/TTL inválidos; nenhuma identidade criada."),
    control("ios-pairing.scanner.close", "Cancelar câmera", "Encerrar a leitura solicitada.", "Folha de scanner aberta.",
      "Para a sessão própria, impede resultado tardio e fecha a folha.", "Câmera parada; nenhuma chave, claim ou concessão."),
    control("ios-pairing.scanner.unavailable", "Câmera negada ou indisponível", "Explicar por que não há leitura.",
      "authorizationStatus negado/restrito ou erro de câmera/configuração.", "Voltar fecha a folha; humano pode usar Colar ou alterar TCC no fluxo privado do iOS.",
      "Nenhum bypass de permissão nem fallback simulado."),
    control("ios-pairing.advanced", "Colar convite (avançado)", "Oferecer entrada privada quando câmera não está disponível.",
      "Disclosure recolhido por padrão; texto só no estado local desta view.", "Expandir, colar e tocar Revisar convite. Abrir o disclosure não lê clipboard sozinho.", "Mesmo parser/role/TTL/limites do QR."),
    control("settings.paired-bundle", "Convite privado", "Receber JSON de oferta existente sem transformá-lo em texto de chat.",
      "Texto local não persistido; máximo8192bytes antes da inspeção. A UI manual histórica mantém este ID.",
      "Humano cola no TextEditor; Revisar limpa o editor e guarda o bundle apenas para o review privado.", "Shape inválido/role diferente/TTL vencido não alteram o host nem a identidade."),
    control("settings.import-pairing", "Revisar convite", "Validar antes de mudar a conexão.",
      "Texto não vazio e operação não ocupada.", "PairingInvitationPreview.inspect(data, clientIOS), sem writes/keys/rede.", "Review code-free ou erro específico de expiração/inválido."),
    control("ios-pairing.review", "Conectar a este Mac?", "Revisar a origem e a solicitação antes de criar identidade.",
      "Host e detalhes code-free derivados do JSON validado. Code não aparece como texto nem entra no preview.",
      "Apenas Conectar importa/provisiona/solicita; Voltar descarta os bytes locais.", "Nenhum efeito só por exibir o review."),
    control("ios-pairing.review.host", "Mac convidante", "Identificar o destino que será acessado.", "host de URL TLS pinada do convite.",
      "Somente leitura/seleção de texto; não permite trocar URL/certificado.", "Destino exato do bundle; ainda requer confiança no canal de origem."),
    control("settings.paired-client-name", "Nome deste iPhone", "Identificar o pedido no Mac.", "Sugestão iPhone; string local editável.",
      "Editar antes de Conectar; host valida não vazio, limites UTF16/UTF8 e ausência de controles.", "Nome legível no pedido; nome não é prova de identidade."),
    control("ios-pairing.review.details", "Detalhes do convite", "Revisar validade, pin e escopos exatos.",
      "expiresAt, hostFingerprint e scopes fechados do bundle; nenhuma scope é inferida de manage/read.",
      "Expandir só exibe dados; não edita nem amplia escopos.", "Scopes do aparelho visíveis; nenhum grant de bot."),
    control("ios-pairing.connect", "Conectar", "Criar explicitamente a identidade local e pedir aprovação ao Mac.",
      "Review válido, nome não vazio, sem operação local em andamento; TTL revalidado no gesto.",
      "importPairingInvitation → provisionIdentity se readyToProvision → claim(name). POST /app-client/v1/pair/claim usa o bundle exato, TLS/mTLS e journal durável.",
      "pendingApproval após ACK durável. Nunca conectado antes da aprovação/health; falhas preservam missing/locked/offline/unknown."),
    control("ios-pairing.review.back", "Voltar do review", "Descartar um convite antes de solicitar.", "Review aberto e sem operação em andamento.",
      "Limpa Data/review da memória da view.", "Primeira tela; nenhum provision/claim por esta ação."),
    control("ios-pairing.pending-approval", "Confirme no seu Mac", "Aguardar consentimento humano da base.",
      "Claim acknowledged no journal; state pendingApproval.", "Observer foreground consulta status a cada3s. Não reenvia claim nem aprova.",
      "Código para comparação e pending real; somente binding aprovado e health real abrem os bots."),
    control("settings.paired-verification-code", "Código de verificação", "Comparar a identidade do pedido nos dois aparelhos.",
      "PairingVerificationCode.text do clientFingerprint local; mesmo valor no pedido Mac.", "Somente leitura; humano compara antes de aprovar no Mac.", "Identidade comparada, sem autorização concedida por mostrar o código."),
    control("settings.restore-pairing", "Verificar conexão", "Restaurar identidade existente ou ler aprovação sem repetir claim.",
      "Referência selecionada, host/pin/scopes e claim público durável; não basta metadata para autoridade.",
      "loadOnly e journal.statusAndResolve pelo transporte pinado; ClientConnectionFactory.restore/HostClient.paired e health reais.",
      "paired somente após identidade/binding/health conferidos; missing/locked/offline/revoked/unknown conservados."),
    control("ios-pairing.connection-state", "Estado da conexão", "Mostrar falha/recuperação sem simular uma base.",
      "state, publicReference e invitationExpired; used/cancelled sem ACK fica unknown conservador.", "Somente indicador; use Verificar ou novo convite quando o estado permite.", "Nenhum sucesso fabricado; unknown não admite repetição automática."),
    control("ios-pairing.notice", "Aviso do convite", "Explicar formato/expiração/limite antes do efeito.",
      "Mensagens fixas: oversized, inválido, expirado ou resultado não confirmado. Nunca erro bruto/código.", "Nenhuma mutação por indicador.", "Revisão recusada sem elevar poderes ou vazar convite."),
    control("settings.pairing-qr.open", "Conectar ao Mac por QR", "Reabrir o mesmo onboarding em Ajustes.",
      "Settings iOS › Host pareado.", "Abre folha com IOSMacConnectionView; não solicita câmera até Escanear.", "Mesmo fluxo e identidade; nenhuma segunda implementação de pairing."),
    control("settings.pairing-advanced", "Conexão manual e recuperação", "Manter controles históricos acessíveis sob demanda.",
      "Disclosure em Host pareado com import/provision/claim/restore/disconnect/detach/revoke existentes.",
      "Expandir só navega. Cada mutação preserva seu contrato/aprovação e os IDs settings.* históricos.", "Nenhum wrapper concede acesso novo; fluxo privado existente continua disponível."),
    control("ios-pairing.close", "Fechar conexão em Ajustes", "Encerrar somente a folha do onboarding.", "Folha aberta; dismiss bloqueado durante pedido explícito em andamento.",
      "Fecha folha; onDisappear limpa convite/texto e para scanner/observer próprios.", "Claim já enviado permanece na base/journal; fechar não revoga nem desfaz o efeito."),
    control("ios-pairing.developer-demo", "Demonstração para desenvolvedores", "Permitir fixture explícita para inspeção de desenvolvimento.",
      "Controle presente somente em DEBUG; primeiro uso real nunca chama useFixture automaticamente.", "Gesto humano useFixture; navegação fixture resolve somente fixture-bot/fixture-thread locais.",
      "Samples claramente demo, sem rede/inferência/grants. Novo lançamento do iPhone volta à conexão real."),
  ],
};

/** Patch existing stable owner controls and add the new QR/preparation controls before the central freeze/hash. */
export function applyIOSQRPairingGuideOverlay(input: PageInput): PageInput {
  if (input.id !== "owner-pairing-offer") return input;
  const fields = new Map(input.fields.map(value => [value.id, value]));
  const values = [
    macControl("owner-pairing-offer.prepare-channel", "Preparar conexão segura", "Preparar o listener real da base própria do app para o iPhone.",
      "GET owner-local status, identidade atual da própria base e metadata local ausente ou da geração existente; coordinator injetado e sem conversa/operação ativa.",
      "Gesto nativo chama LocalHostLaunchCoordinator.prepareAppClientChannel(model:). Custódia privada Keychain/TLS e reinício somente do filho próprio; recarrega status real. Não cria oferta junto.",
      "Retorna listening somente após ready/GET reais; localChatOnly significa que o chat foi recuperado sem conexão remota, não sucesso do pareamento. Rede ausente/busy/custodyUnavailable/unknown ficam explícitos."),
    macControl("owner-pairing-offer.channel-notice", "Aviso da conexão segura", "Exibir falha fixa sem dados privados.",
      "Resultado listening/localChatOnly e falhas tipadas de preparação/retomada/renovação, sem erro bruto ou segredo.",
      "Somente indicador; Atualizar consulta status sem apropriar/parar host alheio.", "Nenhum segredo bruto ou sucesso presumido."),
    macControl("owner-pairing-offer.iphone-summary", "Acesso do iPhone", "Revisar o escopo da oferta antes do gesto de criação.",
      "draftScopes explícitos e effectiveTTLSeconds; defaults históricos preservados e opt-ins só após escolha humana.",
      "Somente resumo; Outro aparelho e permissões permite editar o rascunho pelos controles históricos.", "Mesmos scopes mostrados no review iPhone e no pedido Mac, sem grants de bot."),
    macControl("owner-pairing-offer.create-iphone-qr", "Conectar iPhone", "Escolher client-ios e criar uma única oferta real.",
      "Canal disponível, resumo/TTL revisados, nenhuma mutação pendente; default UI até300s limitado pelo mínimo/default da base.",
      "Gesto define role client-ios e chama editor.create com CAS host/revision/journalPin/requestID, receipt e dedupe existentes.",
      "QR real só após invitationText verificado pelo SHA256 do receipt. Unknown conserva pedido; nenhum novo ID automático."),
    macControl("owner-pairing-offer.advanced", "Outro aparelho e permissões", "Manter Mac, validade e opt-ins sob demanda.",
      "Rascunho atual de role/scopes/TTL; picker sem escolha default antes de gesto explícito.", "Expandir só navega; controles estáveis existentes alteram só o rascunho até Criar convite.",
      "Convite para client-mac ou escopos escolhidos, sem autoPOST por abrir."),
    macControl("owner-pairing-offer.invitation.qr", "QR privado do convite", "Transferir os bytes exatos do convite para o iPhone.",
      "invitationText validado e limitado a2953bytes para QR correctionL; somente oferta open.", "Render CoreImage local, sem upload, logs, texto no AX ou sidecars. Escanear no iPhone é outro gesto.",
      "Mesmo bundle/nonce de uso único; fecha/expira/claimed/cancelled esquece o QR local."),
    macControl("owner-pairing-offer.invitation.qr-unavailable", "QR indisponível", "Explicar convites que excedem a capacidade do QR.",
      "Texto válido maior que2953bytes ou falha CoreImage.", "Copiar convite e Colar permanecem fallback humano privado.", "Nenhuma truncagem, QR parcial ou transporte fictício."),

    macControl("owner-pairing-offer.renew.open", "Recriar conexão segura…", "Abrir a confirmação de substituição da identidade TLS do canal opcional.",
      "Base própria e identidade atual confirmadas; status real, endereço privado atual único, metadata anterior pode estar expirada, inacessível, em outro IP ou ilegível.",
      "Abre confirmação local. Ainda não para host, cria senha/certificado ou altera preferência.", "Aviso explica que aparelhos conectados perderão o pin antigo e precisarão de novo QR/aprovação."),
    macControl("owner-pairing-offer.renew.confirm", "Confirmar recriação segura", "Recuperar o canal após expiração, troca de IP ou custódia indisponível.",
      "Mesmo host/dono/seleção/endereço e preferência esperada capturados no gesto; comparação CAS exata inclui metadata ilegível sem interpretá-la como autorização.",
      "renewAppClientChannel(model:) para e drena somente o filho próprio. Após saída confirmada, reserva geração UUID/caminho novos e creationId para criação Keychain própria; salva metadata pending antes de criar/lançar. CLI create-only confere host/dono antes de consumir segredo e ready exige a identidade capturada. Não remove nem sobrescreve o sealed/item antigo e não usa a senha antiga do canal app-client; o unlock separado de dispositivo existente continua obrigatório quando configurado.",
      "Novo certificado/pin só fica ativo após listener confirmado; aparelhos anteriores precisam escanear novo QR e receber aprovação humana. Nenhum convite, claim, escopo ou grant é criado por renovar."),
    macControl("owner-pairing-offer.renew.cancel", "Cancelar recriação", "Desistir antes de substituir o canal.", "Confirmação local aberta, sem mutação em andamento.",
      "Fecha a confirmação; nenhum restart, geração, custódia ou preferência é alterado.", "Canal e pareamentos atuais permanecem como estavam.", "Reabra a confirmação se desejar recuperar o canal; cancelar não modifica nem comprova efeito remoto."),
    macControl("owner-pairing-offer.resume-channel", "Retomar preparação", "Concluir somente a geração cuja criação já foi reservada pelo gesto humano.",
      "Metadata pending com generationUUID/creationId e instalação/dono exatos; estado público de custódia, sem leitura de segredo pelo manual.",
      "Gesto explícito retoma os mesmos bytes e creationId; não escolhe outro ID, não recria senha e não migra pin silenciosamente.", "Listening confirmado ou localChatOnly/erro explícito; não é convite nem aprovação."),
  ];
  for (const value of values) fields.set(value.id, value);
  const invitation = fields.get("owner-pairing-offer.invitation");
  if (invitation) fields.set(invitation.id, { ...invitation,
    title: "QR e convite privado", purpose: "Exibir o QR local ou copiar a oferta exata para o aparelho convidado.",
    read: "invitationText em memória, verificado contra invitationSha256 do receipt; QR local só até2953bytes, fallback copiar/colar até8192bytes. Texto/código não entram em logs, chat, analytics, defaults ou arquivos.",
    change: "No iPhone toque Escanear QR do Mac. Copiar usa clipboard sensível; Esconder/fechar limpa o texto/QR. Estado da oferta é consultado a cada2s enquanto a folha fica aberta; claimed abre revisão humana do pedido, sem aprovar sozinho.",
    result: "Transferência privada de uma única oferta; não é conexão ou concessão. Aprovar no Mac exige comparar o código dos dois aparelhos.", recovery });
  const status = fields.get("owner-pairing-offer.status");
  if (status) fields.set(status.id, { ...status,
    recovery: macRecovery });
  return { ...input, sourcePaths: [...new Set([...input.sourcePaths, ...sourcePaths])], fields: [...fields.values()],
    notes: [...input.notes.map(note => note.replace("sem desenhá-lo na tela", "exibido somente como QR privado local")),
      `Revisão ${IOS_QR_PAIRING_GUIDE_REVISION}, versão ${IOS_QR_PAIRING_GUIDE_VERSION}. Consulte ios-qr-pairing para câmera, review, conexão real, restore e recuperação.`] };
}
export const IOS_QR_PAIRING_GUIDE_CONTENT_SHA256 = createHash("sha256")
  .update(JSON.stringify({ page: IOS_QR_PAIRING_GUIDE_PAGE_INPUT,
    ownerOverlay: applyIOSQRPairingGuideOverlay({ id: "owner-pairing-offer", title: "Owner pairing", scope: macScope,
      availability: "human_only", sourcePaths: [], notes: [], fields: [] }) })).digest("hex");
