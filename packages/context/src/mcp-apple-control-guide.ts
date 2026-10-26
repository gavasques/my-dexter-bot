import type { AppConfigurationGuideField, AppConfigurationGuidePage } from "./app-configuration-guide.js";

// First-party operational records for every interactive accessibilityIdentifier the Apple clients (Mac/iOS) added or
// changed for connections, setup requests, private MCP forms and pairing scopes. One record per AX pattern, keyed by the
// pattern itself (`<…>` = dynamic part). Each points at the stable logical control of the same page, which is never
// replaced. Static documentation only: no IO, no host probe, no grant; the bot does not drive the UI through these IDs.

type PageInput = Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
type Field = Readonly<AppConfigurationGuideField>;
type Availability = AppConfigurationGuideField["availability"];

export const MCP_APPLE_CONTROL_GUIDE_VERSION = "1.3.2";

const sourcePaths = ["apps/apple/SharedApp/Sources/ManagedConnectAppsViews.swift", "apps/apple/SharedApp/Sources/McpConnectionsView.swift",
  "apps/apple/SharedApp/Sources/ChatView.swift", "apps/apple/SharedApp/Sources/OwnerPairingOfferViews.swift", "apps/apple/SharedApp/Sources/ConnectOtherBaseSheet.swift",
  "apps/apple/Sources/DexterAppCore/ManagedConnectAppsEditor.swift", "apps/apple/Sources/DexterAppCore/ConnectionsPresentation.swift",
  "apps/apple/Sources/DexterAppCore/McpPrivateInputEditor.swift", "apps/apple/Sources/DexterAppCore/PairingScopes.swift",
  "apps/apple/Sources/DexterHostClient/Connections.swift", "apps/apple/Sources/DexterHostClient/ConnectionWorkflows.swift",
  "apps/apple/Sources/DexterHostClient/McpPrivateInput.swift", "apps/apple/Sources/DexterHostClient/PairedHTTPTransport.swift"];
const note = `Módulo de controles Apple, versão ${MCP_APPLE_CONTROL_GUIDE_VERSION}. Controles Apple (Mac/iOS) por accessibilityIdentifier: cada registro usa o ID estável do padrão AX (<…> = parte dinâmica: conta, servidor, bot, ferramenta, pedido, conexão, formulário, campo ou escopo) e indica o controle lógico desta página, que continua valendo. Fechar/Voltar/Esc/Concluir são navegação; marcações e presets são seleção local; Conferir é só GET do mesmo pedido, sem reenvio. Os IDs servem a QA/automação e para o bot orientar o humano; o bot não aciona a interface por eles e eles não concedem acesso.`;

const navOnly = "Somente navegação/apresentação local: não envia POST/PATCH, não cancela pedido, não responde formulário, não desfaz login nem altera acesso.";
const navApproval = "Nenhuma: gesto local na janela. O bot não aciona a interface por este manual e documentação não concede acesso.";
const navRecovery = "Reabra pela mesma linha/cartão; o estado exibido vem do host por GET. Fechar não comprova cancelamento nem desfaz efeito já registrado.";
const localOnly = "Muda somente a seleção local desta folha/painel; nada é enviado até o botão de confirmação indicado.";
const localRecovery = "Desmarque/marque de novo ou feche a folha sem confirmar; a seleção local é descartada e nada foi enviado.";
const getOnly = "Somente GET do mesmo pedido/receipt (mesmo id ou clientRequestId originais). Nunca reenvia POST/PATCH, não gera novo ID e não repete efeito.";
const readApproval = "Leitura autorizada da mesma janela: dono no app deste Mac (owner-loopback) ou app pareado com o escopo de leitura correspondente (connections.read ou mcp.read). Não concede nada.";
const checkRecovery = "Se continuar incerto, o pedido segue pendente e as mudanças concorrentes ficam bloqueadas; Conferir de novo depois. Nada é reenviado automaticamente.";
const manageConnections = "Gesto humano explícito: dono no app deste Mac (owner-loopback) ou app pareado com connections.manage. O bot não aciona este controle; pode apenas propor connections.request com aprovação exact_owner. Documentação não concede acesso.";
const manageMcp = "Gesto humano explícito: dono no app deste Mac ou app pareado com mcp.manage. O bot não responde por você; nunca há autoresposta, e a resposta não amplia grant nem aprova outros efeitos.";
const ownerOnly = "Gesto humano owner-local no app deste Mac. Não existe ferramenta do bot nem rota pareada para este controle; documentação não concede acesso.";
const accessTerminal = "Receipt terminal: applied = acesso salvo; not_applied (nada gravado, revisão anterior, 0 ferramentas) ou superseded (gravado, mas a conta ou as permissões mudaram depois) encerram a pendência, relêem a conta e mostram aviso honesto — nunca \"acesso salvo\". Uma nova mudança exige novo gesto humano com novo clientRequestId; nenhum PATCH é repetido automaticamente.";
const uncertain = (check: string, what: string): string => `Resultado incerto (rede, timeout,503 outcome_unknown,409 legado outcome_unknown ou resposta divergente): o pedido fica pendente e só ${check} (GET do mesmo ${what}) o resolve; nada é reenviado automaticamente. Conflito de revisão: releia e decida de novo com um novo gesto.`;

const account = "conta gerenciada da base escolhida (Mac dono ou base pareada)";
const accountBot = `${account} × bot explícito desta base`;
const request = "pedido de setup (id, bot, conversa, alvo) da base escolhida";
const review = "folha de revisão de um pedido de setup: contas/conexões, ferramentas e pins atuais";
const input = "formulário privado ligado à ação/requestHash/conexão/bot/conversa/revisão originais";
const windowScope = "janela do app desta base (apresentação local)";
const remote = "base pareada (binding host/pin) com escopos explícitos connections.read/manage e mcp.read/manage";

const R = {
  accounts: "GET /v1/connections/accounts", account: "GET /v1/connections/accounts/:accountId", catalog: "GET /v1/connections/catalog", status: "GET /v1/connections/status",
  receipt: "GET /v1/connections/receipts/:clientRequestId", authorization: "GET /v1/connections/authorizations/:clientRequestId",
  startAuthorization: "POST /v1/connections/authorizations", access: "PATCH /v1/connections/accounts/:accountId/access", label: "PATCH /v1/connections/accounts/:accountId/label",
  disconnect: "POST /v1/connections/accounts/:accountId/disconnect", requests: "GET /v1/connections/setup-requests", request: "GET /v1/connections/setup-requests/:id",
  choices: "GET /v1/connections/setup-requests/:id/choices", complete: "POST /v1/connections/setup-requests/:id/complete", cancel: "POST /v1/connections/setup-requests/:id/cancel",
  inputs: "GET /v1/mcp/input-requests", input: "GET /v1/mcp/input-requests/:id", respond: "POST /v1/mcp/input-requests/:id/respond", servers: "GET /v1/mcp/servers",
  pairingStatus: "GET /v1/owner/app-client-pairing/status", pairingOffer: "POST /v1/owner/app-client-pairing/offers",
} as const;

function control(id: string, logical: string, title: string, purpose: string, scope: string, read: string, change: string, approval: string,
  result: string, recovery: string, availability: Availability, readOperation: string | null, changeOperation: string | null): Field {
  return Object.freeze({ id, title, purpose: `${purpose} Controle lógico: ${logical}.`, scope, read, change, approval, result, recovery, availability, readOperation, changeOperation });
}
/** Close/back/open: presentation only. */
function nav(id: string, logical: string, title: string, purpose: string, scope: string, read: string, change: string, result: string, readOperation: string | null = null): Field {
  return control(id, logical, title, purpose, scope, read, `${change} ${navOnly}`, navApproval, result, navRecovery, "ui_only", readOperation, null);
}
/** Local selection, never sent by itself. */
function local(id: string, logical: string, title: string, purpose: string, scope: string, read: string, change: string, result: string, readOperation: string | null = null): Field {
  return control(id, logical, title, purpose, scope, read, `${change} ${localOnly}`, navApproval, result, localRecovery, "ui_only", readOperation, null);
}
/** Conferir: GET of the same pending request; terminal outcomes settle it, nothing is resubmitted. */
function check(id: string, logical: string, title: string, scope: string, read: string, result: string, readOperation: string, recovery = checkRecovery,
  purpose = "Resolver um resultado incerto lendo o mesmo pedido."): Field {
  return control(id, logical, title, purpose, scope, read, getOnly, readApproval, result, recovery, "read_only", readOperation, null);
}

const connections: readonly Field[] = [
  nav("connections.inspector.technical", "connections.account.facts", "Detalhes técnicos", "Expandir os identificadores públicos já lidos da conta.", account,
    "Snapshot autorizado da conta e conexão; nenhum token ou secret.", "Expande ou recolhe a seção localmente.", "Só a apresentação muda; não consulta outra conta, não conecta nem concede acesso.", R.account),
  nav("settings.connections.search", "connections.home.search", "Buscar suas contas (campo)", "Filtrar as contas já lidas desta base.", "janela e snapshot da base escolhida",
    "Texto digitado e contas lidas por GET /v1/connections/accounts.", "Digitar ou limpar filtra a lista localmente.", "Somente a lista exibida muda; conta, bot e grants não mudam."),
  nav("settings.connections.connect-app", "connections.home.connect-app", "Conectar app (menu)", "Abrir a escolha de serviço ou a configuração MCP avançada.", "base do dono nesta janela",
    "Catálogo atual (GET /v1/connections/catalog) com disponibilidade e pin; catálogo não prova login.",
    "Abre o menu; um serviço abre a confirmação settings.connections.connect.confirm; \"Avançado\" abre o gerenciador MCP (McpConnectionsView) da base.",
    "Nenhum login começa e nenhuma conta é criada só por abrir o menu.", R.catalog),
  nav("settings.connections.connect.<serviceId>", "connections.connect", "Serviço do catálogo", "Escolher um serviço disponível para entrar.", "serviço do catálogo pinado da base",
    "Entrada do catálogo (serviceId, disponibilidade, catalogPin).", "Abre a confirmação settings.connections.connect.confirm para este serviço.", "Nada é enviado antes da confirmação.", R.catalog),
  control("settings.connections.connect.confirm", "connections.connect", "Abrir a página oficial (confirmar Conectar)", "Iniciar um login identificado no serviço escolhido.",
    "serviço × catálogo pinado × base; pedido de setup quando aberto a partir de um cartão", "Catálogo atual com pin; pedido de setup aberto quando houver (setupRequestId).",
    "POST /v1/connections/authorizations {expectedHostID, clientRequestId:UUID novo por gesto, serviceId, catalogPin, setupRequestId?} e abre a página oficial devolvida no navegador.",
    manageConnections, "Tentativa de login consultável; conta criada só depois do consentimento no serviço, sem nenhum bot. Conectar não libera a conta para bot algum. setupRequestId só correlaciona; não concede grant nem agenda continuação.",
    uncertain("settings.connections.authorization.check", "clientRequestId"), "human_only", R.catalog, R.startAuthorization),
  nav("settings.connections.configure", "connections.platform-configuration", "Configurar a plataforma de conexões", "Abrir a configuração da plataforma gerenciada desta base.", "base do dono (owner-local)",
    "Status da plataforma (GET /v1/connections/status).", "Abre o fluxo de configuração; chaves e projeto seguem a custódia owner-local e nunca passam pelo chat.",
    "Nenhuma configuração muda até a confirmação própria do fluxo de plataforma.", R.status),
  check("settings.connections.reload", "connections.platform-status", "Atualizar conexões", "base escolhida",
    "Relê status, catálogo e contas (GET /v1/connections/status, /catalog, /accounts).", "Estado atual da base; nenhuma alteração é feita nem repetida.", R.status, "Falha de leitura mantém o último snapshot rotulado; tente de novo.",
    "Reler o estado da plataforma, do catálogo e das contas."),
  nav("settings.connections.requirements.close", "connections.platform-status", "Fechar requisitos", "Fechar a lista de requisitos da plataforma.", windowScope,
    "Requisitos já lidos do status.", "Fecha a folha.", "Nada muda na base."),
  nav("settings.connections.account.<accountId>.primary", "connections.account.facts", "Verbo principal da conta", "Executar o único próximo passo sugerido pela linha da conta.", account,
    "Fatos conta/acesso/conversa da linha (GET /v1/connections/accounts) e pendências desta janela.",
    "Reconectar… abre settings.connections.reconnect.confirm; Conferir faz só GET do pedido pendente (receipt) ou relê as contas; Escolher bots…/Ver detalhes abrem o inspetor.",
    "O verbo apenas leva ao controle real; nenhum efeito é feito diretamente pela linha.", R.accounts),
  nav("settings.connections.account.<accountId>.inspect", "connections.account.status", "Detalhes da conta", "Abrir o inspetor desta conta.", account,
    "Conta lida por GET /v1/connections/accounts.", "Abre o inspetor (connections.inspector).", "Inspetor da conta correta; nada é alterado.", R.accounts),
  nav("settings.connections.account.<accountId>.direct", "connections.account.direct-mcp", "Abrir conexão MCP própria", "Abrir no gerenciador MCP a conexão nativa projetada como conta.", "projeção de conexão MCP nativa da base",
    "Projeção da conta (nativeServerId) quando o inventário MCP não pôde ser lido.", "Abre o gerenciador MCP (McpConnectionsView) nessa conexão.", "Gerenciador aberto na conexão; login e ferramentas seguem os fluxos owner-local.", R.accounts),
  nav("settings.connections.account.<accountId>.rename", "connections.account.label", "Renomear… (abrir campo)", "Abrir o campo de nome desta conta no inspetor.", account,
    "Nome atual (label) da conta.", "Mostra connections.inspector.rename.field e connections.inspector.rename.save; Cancelar fecha o campo.", "Nome não muda até Salvar."),
  nav("settings.connections.native.<serverId>.primary", "mcp.facts", "Verbo principal da conexão MCP", "Executar o próximo passo sugerido para uma conexão MCP nativa.", "conexão MCP nativa da base",
    "Fatos da conexão (GET /v1/mcp/servers e credenciais) e executor informado.", "Conferir relê o inventário MCP (GET); os demais verbos abrem o gerenciador MCP nesta conexão.",
    "Leitura ou navegação; login, descoberta e seleção exigem os controles próprios do gerenciador.", R.servers),
  nav("settings.connections.native.<serverId>.inspect", "mcp.facts", "Abrir… (conexão MCP)", "Abrir o gerenciador MCP nesta conexão.", "conexão MCP nativa da base",
    "Inventário MCP lido.", "Abre o gerenciador MCP (McpConnectionsView) nesta conexão.", "Nada muda na conexão.", R.servers),
  control("settings.connections.reconnect.confirm", "connections.account.reconnect", "Confirmar Reconectar", "Fazer um novo login identificado que substitui esta conta.", `${account}; conta substituída`,
    "Conta atual, serviço disponível no catálogo pinado.", "POST /v1/connections/authorizations {expectedHostID, clientRequestId:UUID novo, serviceId, catalogPin, replacesAccountId} e abre a página oficial.",
    manageConnections, "Conta nova sem bots; a anterior fica replaced depois do consentimento. Nenhum acesso migra: a revisão settings.connections.reconnect-review pede nova escolha.",
    uncertain("settings.connections.authorization.check", "clientRequestId"), "human_only", R.catalog, R.startAuthorization),
  nav("settings.connections.reconnect-review.bot.<botId>.allow", "connections.reconnect.review", "Escolher ferramentas… (após reconectar)", "Abrir o inspetor da conta nova para escolher de novo as ferramentas deste bot.", "conta nova × bot que usava a conta anterior",
    "Conta nova (bots inicialmente vazios) e bots da conta substituída.", "Abre o inspetor da conta nova; a escolha usa connections.inspector.bot.<botId>.save.", "Nenhum acesso é copiado; só a escolha salva no inspetor vale."),
  nav("settings.connections.reconnect-review.close", "connections.reconnect.review", "Fechar revisão de reconexão", "Fechar o aviso da conta reconectada.", windowScope, "Revisão local da reconexão.", "Fecha o aviso.", "A conta nova continua sem os bots não escolhidos."),
  check("settings.connections.access.check", "connections.receipt.check", "Conferir acesso", accountBot, "GET /v1/connections/receipts/:clientRequestId do PATCH de acesso pendente.",
    `${accessTerminal} Receipt ausente ou de outro pedido mantém a pendência.`, R.receipt),
  check("settings.connections.disconnect.check", "connections.receipt.check", "Conferir desconexão", account, "GET /v1/connections/receipts/:clientRequestId da desconexão pendente e depois a conta.",
    "Receipt confirmado encerra a pendência e mostra disconnected/revogação pedida; ausente mantém incerto.", R.receipt),
  check("settings.connections.request.check", "connections.setup-request.card", "Conferir pedido", request, "GET /v1/connections/setup-requests/:id do complete/cancel pendente.",
    "Nova revisão ou estado encerrado resolve a pendência; mesma revisão ainda aberta = não aplicado (nada continuou).", R.request),
  check("settings.connections.label.check", "connections.receipt.check", "Conferir nome", account, "GET /v1/connections/receipts/:clientRequestId do PATCH de nome pendente.",
    "Receipt do mesmo pedido confirma o nome; ausente mantém incerto.", R.receipt),
  check("settings.connections.authorization.check", "connections.authorization.status", "Conferir login", "tentativa de login desta janela", "GET /v1/connections/authorizations/:clientRequestId da mesma tentativa.",
    "Estado real da tentativa (aguardando, conectado, expirado, cancelado…); conectado não concede acesso a bots.", R.authorization),
  control("settings.connections.authorization.reopen", "connections.authorization.status", "Abrir de novo (mesma página)", "Reabrir a página oficial da MESMA tentativa ainda aberta.", "tentativa de login desta janela",
    "Tentativa com authorizationPage e linkAvailable (GET da mesma tentativa).", "Abre no navegador a página já devolvida pelo host. Não faz POST, não cria link novo.",
    "Gesto humano; login e consentimento acontecem só na página oficial.", "Página da mesma tentativa; voltar e usar Conferir.", "Link expirado: Conferir mostra o estado; um novo login exige novo gesto Conectar.", "human_only", R.authorization, null),
  nav("settings.connections.authorization.dismiss", "connections.authorization.status", "Fechar login encerrado", "Ocultar a linha de uma tentativa já encerrada.", windowScope, "Tentativa encerrada.", "Oculta a linha.", "Nada muda no host."),
  // Inspector (Mac sheet, iOS/remote push).
  nav("connections.inspector.close", "connections.account.status", "Fechar inspetor (Esc)", "Fechar o inspetor da conta.", windowScope, "Conta exibida.", "Fecha (Esc).", "Seleções locais não salvas são descartadas; nada é enviado."),
  nav("connections.inspector.done", "connections.account.status", "Concluir inspetor", "Fechar o inspetor da conta.", windowScope, "Conta exibida.", "Fecha o inspetor.", "Concluir não salva nada; só Salvar acesso/Salvar nome enviam."),
  local("connections.inspector.rename.field", "connections.account.label", "Nome da conta (campo)", "Editar o nome local que o dono dá à conta.", account,
    "Nome atual (label); até 80 caracteres, não vazio.", "Edita o texto; Enter equivale a Salvar.", "Substitui o antigo settings.connections.label.field. Não muda a conta no serviço nem o nome que os bots veem."),
  control("connections.inspector.rename.save", "connections.account.label", "Salvar nome", "Gravar o nome da conta com CAS.", account,
    "Conta e revisão atuais (GET /v1/connections/accounts).", "PATCH /v1/connections/accounts/:accountId/label {expectedHostID, clientRequestId:UUID, expectedRevision, label}. Substitui settings.connections.label.save.",
    manageConnections, "Nome salvo pelo receipt exato do mesmo pedido; contas relidas.", uncertain("connections.inspector.label.check", "receipt"), "human_only", R.accounts, R.label),
  check("connections.inspector.label.check", "connections.receipt.check", "Conferir nome (inspetor)", account, "GET /v1/connections/receipts/:clientRequestId do nome pendente.", "Receipt do mesmo pedido confirma; ausente mantém incerto.", R.receipt),
  check("connections.inspector.access.check", "connections.receipt.check", "Conferir acesso (inspetor)", accountBot, "GET /v1/connections/receipts/:clientRequestId do acesso pendente.", accessTerminal, R.receipt),
  check("connections.inspector.disconnect.check", "connections.receipt.check", "Conferir desconexão (inspetor)", account, "GET /v1/connections/receipts/:clientRequestId da desconexão pendente e depois a conta.",
    "Receipt confirmado mostra disconnected/revogação pedida; ausente mantém incerto.", R.receipt),
  local("connections.inspector.bot.<botId>.allow", "connections.account.bot-access", "Permitir…/Ferramentas… do bot", "Abrir a escolha exata de ferramentas deste bot nesta conta.", accountBot,
    "bots[].access e bots[].toolNames (ausente = desconhecido) e ferramentas pinadas da conta.",
    "Abre o painel começando pelas ferramentas exatas atuais, ou só pelas de leitura quando a base não as informa. Atalhos Só leitura/Todas do painel também são locais.", "Nada muda até connections.inspector.bot.<botId>.save."),
  local("connections.inspector.bot.<botId>.tool.<toolName>", "connections.account.bot-access", "Ferramenta do bot (marcar)", "Marcar ou desmarcar uma ferramenta pinada para este bot.", accountBot,
    "Ferramentas pinadas da conta com efeito revisado (leitura ou altera dados).", "Alterna a ferramenta na seleção local do painel.", "Marcadas = exatamente os toolNames do próximo Salvar acesso; desmarcadas ficam negadas."),
  control("connections.inspector.bot.<botId>.save", "connections.account.bot-access", "Salvar acesso", "Gravar as ferramentas exatas deste bot nesta conta.", accountBot,
    "Conta, revisão e bots[].toolNames atuais.", "PATCH /v1/connections/accounts/:accountId/access {expectedHostID, clientRequestId:UUID, expectedRevision, botId, enabled:true, toolNames:[marcadas, ordenadas, sem duplicatas, até 32]}.",
    manageConnections, `Só as marcadas ficam permitidas (cada chamada segue o modo de aprovação do bot); bots/ferramentas futuros não entram sozinhos. ${accessTerminal}`,
    uncertain("connections.inspector.access.check", "receipt"), "human_only", R.accounts, R.access),
  control("connections.inspector.bot.<botId>.revoke", "connections.account.bot-access", "Retirar acesso do bot", "Retirar todo o acesso deste bot nesta conta.", accountBot,
    "Conta, revisão e acesso atual do bot.", "PATCH /v1/connections/accounts/:accountId/access {expectedHostID, clientRequestId:UUID, expectedRevision, botId, enabled:false} sem toolNames.",
    manageConnections, `Bot sem acesso a esta conta a partir do receipt. ${accessTerminal}`, uncertain("connections.inspector.access.check", "receipt"), "human_only", R.accounts, R.access),
  nav("connections.inspector.reconnect", "connections.account.reconnect", "Reconectar… (inspetor)", "Pedir confirmação para um novo login que substitui esta conta.", account,
    "Conta (status que oferece reconexão) e serviço disponível no catálogo.", "Abre a confirmação settings.connections.reconnect.confirm.", "Nada é enviado antes da confirmação.", R.catalog),
  nav("connections.inspector.disconnect", "connections.account.disconnect", "Desconectar… (inspetor)", "Pedir confirmação destrutiva com o impacto nos bots.", account,
    "Conta e bots afetados.", "Abre a confirmação connections.inspector.disconnect.confirm.", "Nada é enviado antes da confirmação."),
  control("connections.inspector.disconnect.confirm", "connections.account.disconnect", "Confirmar desconexão", "Desconectar a conta e pedir a revogação no serviço.", account,
    "Conta, revisão e bots afetados (texto da confirmação).", "POST /v1/connections/accounts/:accountId/disconnect {expectedHostID, clientRequestId:UUID, expectedRevision}.",
    manageConnections, "Conta disconnected e revogação pedida conforme o receipt; bots perdem o acesso a esta conta. Não comprova revogação remota além do receipt.",
    uncertain("connections.inspector.disconnect.check", "receipt"), "human_only", R.accounts, R.disconnect),
  // Setup request card (Conexões, chat, remote).
  nav("connections.request.<requestId>.connect", "connections.setup-request.card", "Conectar… (pedido)", "Entrar no serviço que o bot pediu, correlacionando ao pedido.", request,
    "Pedido aberto (GET /v1/connections/setup-requests) e serviço disponível no catálogo pinado.",
    "Abre a confirmação settings.connections.connect.confirm (ou chat.connection-requests.connect.confirm no chat) com setupRequestId.", "Nada é enviado antes da confirmação.", R.requests),
  control("connections.request.<requestId>.resume", "connections.setup-request.card", "Retomar login… (pedido)", "Reabrir a tentativa de login já começada para este pedido.", `${request} × tentativa original`,
    "authorizationRequestIds das escolhas do pedido, menos as tentativas que o app viu encerrar.", "GET /v1/connections/authorizations/:clientRequestId da mesma tentativa e abre a página dela. Nunca cria link novo.",
    manageConnections, "Página oficial da MESMA tentativa; nada é concedido.", "Tentativa encerrada: o cartão volta a oferecer Conectar… (novo POST com setupRequestId, um por gesto).", "human_only", R.authorization, null),
  nav("connections.request.<requestId>.review", "connections.setup-request.review", "Revisar e permitir… (pedido)", "Abrir a folha de revisão de contas e ferramentas do pedido.", request,
    "Pedido e escolhas (GET /v1/connections/setup-requests/:id/choices).", "Abre a folha connections.request-review.", "Nada é permitido até connections.request-review.allow.", R.choices),
  nav("connections.request.<requestId>.open", "connections.setup-request.card", "Abrir MCP… (pedido nativo)", "Abrir o gerenciador MCP do Mac no servidor e bot do pedido.", `${request}; Mac dono da base`,
    "Pedido native_mcp (setup_<actionId>).", "Abre McpConnectionsView no servidor/bot; no iPhone/remoto o botão não existe (login e ferramentas ficam no Mac dono).", "Login e seleção seguem os fluxos owner-local do executor."),
  nav("connections.request.<requestId>.decline", "connections.setup-request.decline", "Recusar… (pedido)", "Pedir confirmação para recusar o pedido.", request,
    "Pedido e revisão atuais.", "Abre a confirmação connections.request.<requestId>.decline.confirm.", "Nada é enviado antes da confirmação."),
  control("connections.request.<requestId>.decline.confirm", "connections.setup-request.decline", "Recusar pedido (confirmar)", "Tornar o pedido inerte.", request,
    "Pedido e revisão atuais.", "POST /v1/connections/setup-requests/:id/cancel {expectedHostID, clientRequestId:UUID, expectedRevision}.",
    manageConnections, "Pedido cancelled; retorno de login tardio não concede nem agenda continuação. Acessos já salvos em contas continuam como estão; login remoto feito não é desfeito.",
    uncertain("connections.request.<requestId>.check", "pedido"), "human_only", R.request, R.cancel),
  check("connections.request.<requestId>.check", "connections.setup-request.card", "Conferir (pedido)", request, "GET /v1/connections/setup-requests/:id do complete/cancel pendente.",
    "Nova revisão ou estado encerrado resolve; mesma revisão ainda aberta = não aplicado.", R.request),
  // Review sheet.
  nav("connections.request-review.close", "connections.setup-request.review", "Fechar revisão (Esc)", "Fechar a folha sem decidir.", review, "Pedido exibido.", "Fecha (Esc).", "O pedido continua aberto; nada é cancelado."),
  nav("connections.request-review.done", "connections.setup-request.review", "Concluir (fechar revisão)", "Fechar a folha.", review, "Pedido exibido.", "Fecha a folha; não é o mesmo que Permitir e continuar.", "O pedido continua no estado em que está."),
  local("connections.request-review.account.<accountId>", "connections.setup-request.review", "Escolher conta (sem escolhas do host)", "Marcar contas conectadas quando a base não oferece escolhas pinadas.", review,
    "Contas conectadas do serviço pedido (GET /v1/connections/accounts).", "Alterna a conta na seleção local.", "Com essa via, Permitir só salva acesso; não há continuação.", R.accounts),
  local("connections.request-review.connection.<connectionId>", "connections.setup-request.review", "Escolher conexão", "Marcar uma das conexões oferecidas pelo pedido (até 5).", review,
    "choices.connectionId/expectedRevision/label (GET …/choices).", "Alterna a conexão na seleção local.", "Somente conexões marcadas entram no complete.", R.choices),
  local("connections.request-review.tool.<connectionId>.<toolName>", "connections.setup-request.review", "Escolher ferramenta", "Marcar uma ferramenta exata da conexão escolhida.", review,
    "choices.tools(name, manifestHash, effect, enabled).", "Alterna a ferramenta na seleção local.", "Marcadas = exatamente as dos toolNames e das selections do complete.", R.choices),
  local("connections.request-review.presets.<connectionId>", "connections.setup-request.review", "Presets Só leitura / Todas", "Marcar de uma vez as ferramentas de leitura ou todas da conexão.", review,
    "Efeito revisado de cada ferramenta nas escolhas.", "Só leitura marca as de efeito read; Todas marca todas. Não envia nada.", "Preset nunca salva acesso nem continua o pedido.", R.choices),
  control("connections.request-review.allow", "connections.setup-request.review", "Permitir e continuar", "Salvar o acesso exato escolhido e continuar uma vez a tarefa original.", review,
    "Escolhas, revisões e pins atuais (GET …/choices); acesso atual de cada conta.",
    "Para cada conta cujo conjunto muda: PATCH /v1/connections/accounts/:accountId/access {…, toolNames exatos}; relê as escolhas; um POST /v1/connections/setup-requests/:id/complete {expectedHostID, clientRequestId:UUID, expectedRevision, selections:[{connectionId, expectedRevision, tools:[{name, manifestHash}]}]} (1..5 conexões). Sem escolhas do host, seleção explícita de conta/toolNames salva somente acesso; não há complete.",
    manageConnections, `GET da conta → PATCH exato → GET choices → complete, serializados; duplo clique não repete. Receipt de acesso separado e uma continuação canônica; retomada na fila não comprova execução. Sem pins, acesso aplicado mostra aviso de que a retomada não ocorreu. Se o acesso não for confirmado como aplicado, o fluxo para antes do complete. ${accessTerminal}`,
    `${uncertain("connections.request-review.check", "pedido")} Acesso incerto usa connections.request-review.access-check.`, "human_only", R.choices, R.complete),
  check("connections.request-review.check", "connections.setup-request.review", "Conferir pedido (revisão)", review, "GET /v1/connections/setup-requests/:id do complete pendente.",
    "Nova revisão ou estado encerrado resolve; mesma revisão aberta = não aplicado (nada continuou).", R.request),
  check("connections.request-review.access-check", "connections.setup-request.review", "Conferir acesso (revisão)", review, "GET /v1/connections/receipts/:clientRequestId do acesso pendente.", accessTerminal, R.receipt),
  check("connections.request-review.reload", "connections.setup-request.review", "Ler opções de novo", review, "GET /v1/connections/setup-requests/:id/choices depois de falha de leitura.",
    "Opções atuais ou falha explícita; nunca espera infinita.", R.choices, "Falha repetida mantém a mensagem; o pedido continua aberto.", "Ler de novo as opções do pedido quando a leitura falhou."),
  // Remote (Mac pareado e iPhone).
  nav("connections.remote.account.<accountId>", "connections.remote", "Conta da base pareada", "Abrir o inspetor da conta na base pareada.", remote,
    "Contas lidas com connections.read.", "Abre o inspetor (connections.inspector.*) com as mesmas regras; mutações exigem connections.manage.", "Nada muda na base.", R.accounts),
  check("connections.remote.refresh", "connections.remote", "Atualizar (base pareada)", remote,
    "Relê contas, pedidos, inventário MCP e formulários (GET /v1/connections/accounts, /setup-requests, /v1/mcp/servers, /v1/mcp/input-requests) conforme os escopos.",
    "Estado da base correta; sem escopo mostra a ausência; offline conserva o snapshot rotulado e recusa alterações.", R.accounts, "Offline/sem escopo: nada é tentado de novo sozinho; atualize depois ou peça ao dono novo pareamento com o escopo.",
    "Reler o estado da base pareada."),
  check("connections.remote.authorization.check", "connections.remote", "Conferir login (base pareada)", `${remote}; tentativa desta janela`,
    "GET /v1/connections/authorizations/:clientRequestId da mesma tentativa (connections.manage).", "Estado real da tentativa; conectado não concede acesso a bots.", R.authorization),
  control("connections.remote.authorization.reopen", "connections.remote", "Abrir de novo (base pareada)", "Reabrir a página oficial da mesma tentativa.", `${remote}; tentativa desta janela`,
    "Tentativa com authorizationPage (GET da mesma tentativa).", "Abre no navegador do aparelho a página já devolvida. Não faz POST nem cria link novo.",
    "Gesto humano; o consentimento acontece só na página oficial.", "Página da mesma tentativa; voltar e Conferir.", "Link expirado: Conferir mostra o estado; novo login exige novo gesto.", "human_only", R.authorization, null),
];

const chat: readonly Field[] = [
  control("chat.connection-requests", "connections.setup-request.card (página connections)", "Pedidos de conexão da conversa", "Mostrar acima do composer os pedidos de setup abertos desta conversa privada.",
    "conversa privada × base do dono no Mac", "GET /v1/connections/setup-requests filtrado pela conversa; status/catálogo/contas só quando há pedido aberto.",
    "Sem alteração própria; cada cartão usa connections.request.<requestId>.*.", readApproval, "Cartões do mesmo pedido; nenhuma mensagem \"ok\" é necessária e nada é repetido.",
    "Fechar/trocar de conversa não cancela pedidos; reabra a conversa ou Conexões.", "read_only", R.requests, null),
  control("chat.connection-requests.connect.confirm", "connections.connect (página connections)", "Abrir a página oficial (pedido no chat)", "Confirmar o login correlacionado a um pedido do bot nesta conversa.",
    "pedido × serviço × base do dono", "Pedido aberto e catálogo pinado.",
    "POST /v1/connections/authorizations {expectedHostID, clientRequestId:UUID novo, serviceId, catalogPin, setupRequestId} e abre a página oficial.",
    manageConnections, "Login correlacionado ao pedido; nada é concedido. A escolha de ferramentas continua em Revisar e permitir.",
    `${uncertain("Conferir do cartão/Conexões", "clientRequestId")} Tentativa ainda aberta: Retomar login… (connections.request.<requestId>.resume).`, "human_only", R.catalog, R.startAuthorization),
  control("chat.mcp-private-inputs", "mcp.input.status (página mcp-private-input)", "Formulários MCP da conversa", "Mostrar os pedidos privados de dados das ações em execução desta conversa.",
    "conversa privada × base (dono ou pareada com mcp.read)", "GET /v1/mcp/input-requests?view=active retorna resumos de esperas vivas; a apresentação filtra a conversa. Abrir formulário faz GET do registro exato, antes de mostrar campos. Consulta periódica conserva filtro, páginas e formulários abertos; histórico/volta permanecem visíveis quando a página não contém itens desta conversa.",
    "Sem alteração própria; resumos usam mcp.private-inputs.open.<id> e cada formulário hidratado usa mcp.private-input.<inputId>.*.", readApproval, "Resumos e detalhes carregados são distintos; nada é respondido sozinho nem declarado válido antes de abrir.",
    "Expirado/encerrado aparece como tal; nada é reenviado. Pendência de envio conserva Conferir do ID original, mesmo sem o cartão na página atual.", "read_only", R.inputs, null),
];

const privateInput: readonly Field[] = [
  control("chat.mcp-private-inputs.incomplete", "mcp.input.status", "Formulários do chat: lista incompleta", "Informar itens recusados sem bloquear os válidos.",
    "lista privada autorizada da base; cartões filtrados pela conversa selecionada", "GET /v1/mcp/input-requests version2 retorna resumos: invalidRequestCount conta envelopes inválidos desta página; quarantinedRequestCount é da base e omittedRequestCount é histórico fora da janela. Corpos não carregados permanecem unverified, não válidos.",
    "Somente indicador: não escreve nem saneia o store em GET.", readApproval, "Aviso e contagens legíveis; irmãos válidos continuam respondíveis. Itens inválidos ou em quarentena não oferecem Accept/Decline/Cancel POST.",
    "Releia a mesma base; não responda um item inválido. Corrupção histórica elegível só é saneada na cópia de backup, com auditoria hash-only inerte.", "read_only", R.inputs, null),
  control("mcp.private-inputs.incomplete", "mcp.input.status", "Conexões: lista de formulários incompleta", "Exibir aviso e contagens sem simular uma lista vazia.",
    "snapshot privado da base escolhida", "Mesma página version2 e contagens do GET /v1/mcp/input-requests, com isolamento por envelope. Schema só é validado no GET exato ao abrir.",
    "Somente indicador; conserva pedidos válidos e não altera registros.", readApproval, "Lista incompleta explícita; pedidos malformados são não acionáveis.",
    "Atualize a mesma base; não envie resposta nem Cancel/Decline para um pedido inválido ou em quarentena.", "read_only", R.inputs, null),
  nav("mcp.private-input.<inputId>.original", "mcp.input.status", "Pedido original", "Expandir a referência pública da ação à qual o formulário pertence.", input,
    "actionId, requestHash, ferramenta e conta do mesmo pedido; requestState e _meta permanecem privados.", "Expande ou recolhe a seção localmente.", "Só mostra a origem já recebida; não envia respostas nem repete a ação.", R.input),
  local("mcp.private-input.<inputId>.field.<fieldName>", "mcp.input.respond", "Campo do formulário", "Preencher um campo primitivo não secreto pedido pelo servidor.", input,
    "Formulário (texto, escolha, número, booleano) com limites, obrigatoriedade e prazo; texto do servidor é conteúdo não confiável.", "Edita o valor local do campo.", "Valores só seguem depois de Revisar e Enviar.", R.input),
  local("mcp.private-input.<inputId>.review-button", "mcp.input.respond", "Revisar respostas", "Mostrar exatamente o que será enviado antes de Enviar.", input,
    "Valores locais validados contra o formulário.", "Monta e exibe conta, ferramenta, ação e valores exatos; valor inválido não monta nada.", "Nada é enviado; Enviar fica disponível só na revisão."),
  control("mcp.private-input.<inputId>.send", "mcp.input.respond", "Enviar respostas", "Entregar os valores revisados ao mesmo round da ação.", input,
    "Formulário e revisão atuais (GET /v1/mcp/input-requests/:id).",
    "POST /v1/mcp/input-requests/:id/respond {expectedHostID, clientRequestId:UUID, expectedRevision, actionId, requestHash, approval:'approve_exact_input', responses:{chave:{action:'accept', content:{…}}}}.",
    manageMcp, "answered com responseHash; continua só a chamada original dentro do prazo e dos gates.", uncertain("mcp.private-input.<inputId>.check", "formulário"), "human_only", R.input, R.respond),
  nav("mcp.private-input.<inputId>.back", "mcp.input.respond", "Voltar (editar respostas)", "Voltar da revisão para os campos.", input, "Revisão local.", "Volta aos campos mantendo os valores locais.", "Nada é enviado."),
  control("mcp.private-input.<inputId>.decline", "mcp.input.decline", "Recusar formulário", "Não fornecer os dados pedidos.", input, "Formulário e revisão atuais.",
    "POST /v1/mcp/input-requests/:id/respond com action:'decline' em cada pedido, sem conteúdo nem approval.", manageMcp,
    "declined; o servidor recebe a recusa. Não aprova escrita nem revoga acessos.", uncertain("mcp.private-input.<inputId>.check", "formulário"), "human_only", R.input, R.respond),
  control("mcp.private-input.<inputId>.cancel", "mcp.input.cancel", "Cancelar formulário", "Interromper este pedido de dados.", input, "Formulário e revisão atuais.",
    "POST /v1/mcp/input-requests/:id/respond com action:'cancel' em cada pedido, sem conteúdo nem approval.", manageMcp,
    "cancelled; efeito upstream anterior permanece conforme o receipt, sem promessa de rollback.", uncertain("mcp.private-input.<inputId>.check", "formulário"), "human_only", R.input, R.respond),
  check("mcp.private-input.<inputId>.check", "mcp.input.status", "Conferir formulário", input, "GET /v1/mcp/input-requests/:id da resposta pendente. O controle permanece na lista mesmo se o cartão sumir da página, expirar ou outro filtro/conversa estiver aberto no mesmo editor/base. A linha identifica conexão, ação, conversa e pedido originais, sem conservar os valores respondidos. Usa somente o ID/escopo originais; não navega para outra conversa nem repete o POST.",
    "Revisão nova com o mesmo clientRequestId confirma; estado encerrado (expired, interrupted…) encerra; mesma revisão pendente mantém incerto.", R.input),
];

const mcpConnections: readonly Field[] = [
  control("mcp.setup-request", "connections.setup.status (página connection-setup)", "Pedido do bot para este MCP", "Mostrar no gerenciador o pedido derivado de um mcp.authorize aprovado.",
    "pedido setup_<actionId> × instância × bot", "GET /v1/connections/setup-requests/setup_<actionId> e escolhas; ferramentas já concedidas ao bot nesta instância.",
    "Sem alteração própria; usa mcp.setup-request.allow, .decline e .check.", readApproval, "Mostra até 5 conexões com ferramentas concedidas; acima disso avisa que o restante fica de fora.",
    "Pedido encerrado some do painel; nada é repetido.", "read_only", R.request, null),
  control("mcp.setup-request.allow", "connections.setup.continue (página connection-setup)", "Permitir e continuar (MCP)", "Continuar uma vez a tarefa original com as ferramentas já concedidas.", "pedido setup_<actionId> × instância × bot",
    "Pedido, escolhas e seleção atual do bot (só ferramentas já concedidas).",
    "POST /v1/connections/setup-requests/:id/complete {expectedHostID, clientRequestId:UUID, expectedRevision, selections:[{connectionId, expectedRevision, tools:[{name, manifestHash}]}]} com exatamente as ferramentas já concedidas (≤ 5 conexões).",
    "Gesto humano owner-local no gerenciador; o complete não concede grant nem descobre ferramentas.", "Uma continuação canônica do pedido original; sem ferramenta concedida o botão não continua nada.",
    uncertain("mcp.setup-request.check", "pedido"), "human_only", R.choices, R.complete),
  control("mcp.setup-request.decline", "connections.setup.cancel (página connection-setup)", "Recusar pedido (MCP)", "Tornar inerte o pedido derivado do mcp.authorize.", "pedido setup_<actionId>",
    "Pedido e revisão atuais.", "POST /v1/connections/setup-requests/:id/cancel {expectedHostID, clientRequestId:UUID, expectedRevision}.",
    "Gesto humano owner-local.", "Pedido cancelled; login/seleção já feitos continuam como estão.", uncertain("mcp.setup-request.check", "pedido"), "human_only", R.request, R.cancel),
  check("mcp.setup-request.check", "connections.setup.status (página connection-setup)", "Conferir pedido (MCP)", "pedido setup_<actionId>", "GET /v1/connections/setup-requests/:id do complete/cancel pendente.",
    "Nova revisão ou estado encerrado resolve; mesma revisão aberta = não aplicado.", R.request),
];

const scopeToggle = (id: string, logical: string, scope: string, read: string, change: string): Field => control(id, logical, "Escopo opcional do convite",
  "Ligar ou desligar um escopo opt-in do convite de pareamento.", scope, read,
  `${change} connections.read/connections.manage e mcp.read/mcp.manage começam desligados; manage não implica read (aviso quando falta). ${localOnly}`,
  ownerOnly, "O convite criado e o vínculo aprovado carregam exatamente os escopos ligados. Não transporta chaves, OAuth nativo, discovery nem execução stdio do Mac.",
  "Para mudar escopos depois, crie um convite novo e pareie de novo; pareamento antigo não herda escopos novos.", "human_only", R.pairingStatus, null);
const ownerPairing: readonly Field[] = [scopeToggle("owner-pairing-offer.scope.<scope>", "pairing.scope.connections", "rascunho do convite de pareamento owner-local",
  "OwnerPairingScopes do rascunho e status da oferta (historical fixos, até 6 opt-ins, limite 14).", "Alterna o escopo no rascunho; owner-pairing-offer.create envia POST /v1/owner/app-client-pairing/offers.")];
const pairedHost: readonly Field[] = [scopeToggle("pairing-offer.scope.<scope>", "pairing-offer.scopes", "rascunho do convite em Conectar outra base",
  "Seleção de escopos do convite (valores novos connections.read, connections.manage, mcp.read, mcp.manage).", "Alterna o escopo na seleção do convite; só a criação do convite envia POST /v1/owner/app-client-pairing/offers.")];

/** Interactive Apple controls grouped by the guide page that documents them. */
export const MCP_APPLE_CONTROL_GUIDE_FIELDS: Readonly<Record<string, readonly Field[]>> = Object.freeze({
  connections, chat, "mcp-private-input": privateInput, "mcp-connections": mcpConnections, "owner-pairing-offer": ownerPairing, "paired-host": pairedHost,
});

/** Interactive AX patterns whose record is an existing logical control of the same ID (kept as is). */
export const MCP_APPLE_CONTROL_LOGICAL_AX: Readonly<Record<string, string>> = Object.freeze({
  "mcp.discover-confirm": "mcp-connections", "mcp.oauth-read-tools-after-login": "mcp-authentication",
  "mcp.private-inputs.history": "mcp-private-input", "mcp.private-inputs.refresh": "mcp-private-input",
  "mcp.private-inputs.more": "mcp-private-input", "mcp.private-inputs.summaries": "mcp-private-input",
  "mcp.private-inputs.open.*": "mcp-private-input",
});

/**
 * Adds the Apple control records to their page. Existing fields win (stable logical IDs are never replaced); unknown
 * pages are returned unchanged. Apply after the other overlays, before freezing.
 */
export function augmentMcpAppleControls(page: PageInput): PageInput {
  const records = MCP_APPLE_CONTROL_GUIDE_FIELDS[page.id];
  if (!records) return page;
  const present = new Set(page.fields.map(value => value.id));
  return { ...page, sourcePaths: [...new Set([...page.sourcePaths, ...sourcePaths])], notes: page.notes.includes(note) ? page.notes : [...page.notes, note],
    fields: [...page.fields, ...records.filter(value => !present.has(value.id))] };
}
