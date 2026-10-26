# Apple UX/Mac/iOS — parcelas B/C/F do MCP completo

Estado: **implementado (autoral; não é revisão independente)**. Base `8bd73e9b`. Dono: `apps/apple/**` e este arquivo.
Canal persistente Apple → Root. Contratos consumidos: `connection-workflows.ts` (pedidos + choices), `mcp-private-input.ts`
(formulários MRTR com `approve_exact_input`), `connections.ts` (`setupRequestId`, `toolNames` no pedido/receipt e em
`bots[].toolNames`, `tools[].manifestHash`), `mcp-setup.ts` (10 códigos novos), `owner-pairing-offer.ts` (6 opt-ins, máx.
14), `command-pin.ts` (`GET …/command-status`), `executor` do resumo de servidores nativos, opções de `POST …/discover`
(`expectedInstancePin`, `httpOnly`) e o envelope de resultado MCP (`isError` no topo). Nada em `packages/**`, guias
centrais, docs raiz ou Info* foi editado.

## 1. O que a Apple entrega

### B — recuperação Mac
- **Conexões unificada** (`ManagedConnectAppsViews.swift`): busca, **Conectar app** (galeria + "Avançado: endereço MCP ou
  comando local"), **Pedidos dos bots**, **Suas contas** (conta gerenciada e MCP nativo na mesma linha, método em selo:
  "via Composio" / "MCP · servidor HTTP|processo local|roda em outro computador") e a galeria "Conectar apps".
- **Três fatos por linha** (`ConnectionsPresentation`, `DexterAppCore`): Conta · Acesso · Nesta conversa. Cada eixo vem da
  sua fonte; `unknown` é por eixo (acesso incerto não apaga conta confirmada; conta desconhecida não afirma conexão).
  "Disponível nesta conversa" só com `ConnectionAdmissionEvidence.provenInCurrentTurn` — nenhum contrato fornece essa prova
  hoje, então a UI diz no máximo "Entra no próximo turno". `needs_reconnect` = "Entre novamente para reconectar", sem
  causa/data. Cadastro MCP = "Conexão adicionada" (não existe flag disabled nativo).
- **Inspetor compacto reutilizável** (`ConnectionAccountInspector`, Mac e iOS): identidade confirmada × nome dado,
  serviço, onde fica o acesso, base, três fatos, pendências com **Conferir**, **Quem pode usar** (seleção exata de
  ferramentas por bot, inline, presets Só leitura/Todas, `toolNames` exatos; não marcadas ficam negadas), ferramentas com
  efeito do catálogo, **Reconectar…**, **Desconectar…** (confirmação lista bots afetados; revogação "pedida, não
  confirmada"), **Renomear** inline (sem folha sobre folha), Detalhes técnicos. Fechar visível (`xmark`) + Esc
  (`.cancelAction`) + Concluir.
- **Reconectar** = novo login identificado com `replacesAccountId` (mesmo perfil e nome). A conta nova começa sem bots;
  painel "Conta reconectada" lista os bots da anterior com "Escolher ferramentas…" (abre o inspetor). Equivalência =
  `.unproven` (o `identityChanged` compara só nome de exibição); nada é transferido (decisão R1 do Root: revisão nova).
- **Desconectar / acesso / nome**: CAS na revisão + receipt exato; resultado incerto (inclusive cancelamento da Task)
  vira pendente e só **Conferir** (GET do receipt; desconexão: depois GET da conta) resolve. Nenhum POST repetido.
- **Diagnóstico OAuth fechado**: uma frase + um verbo por `McpAuthenticationDiagnosticError.Code`; `oauth_client_required`
  mostra o campo **Client ID** fora do disclosure com "o que pedir ao serviço" (app nativo, PKCE, redirect do Dexter);
  nenhum código sugere chave de API/token. 10 códigos novos de `mcp-setup.ts` com frase/recuperação fechadas.
- **stdio**: aviso de fronteira ("roda neste Mac com o seu usuário… não são sandbox") no detalhe, no Importar e no
  plano de descoberta; revisão do executável escolhido (caminho, tamanho, SHA-256 lido agora) com a frase explícita de
  que a base guarda o caminho, não o conteúdo; origem/versão/licença "não informadas".
- **Plano de descoberta**: o diálogo "Conectar e descobrir" mostra destino, credencial/sem login, máquina, e que o serviço
  percebe o acesso; stdio = execução de código.
- **Executor (R7)**: `McpServerSummary.executor` decodificado estrito (`reachable` só `true|null`; valor fora do contrato é
  descartado). Texto: "{lugar} · executor {nome} respondeu esta leitura (não indica se o serviço está no ar)" ou "outro
  executor; o estado dele não foi informado". Nunca "online". Linhas nativas mostram o nome do executor só quando ele
  respondeu.
- **Revisão do programa stdio (R9)**: `GET /v1/mcp/servers/:id/command-status` (dono e pareado `mcp.read`), DTO validado
  por estado (`unchanged` com digests diferentes = contrato inválido). `changed` bloqueia **Descobrir** e diz: restaure o
  executável/argumentos revisados ou remova e cadastre de novo; "Descobrir não substitui a revisão". `unchanged` diz "não
  é assinatura nem sandbox"; não informado fica desconhecido. Digests (caminho, SHA-256, hash dos args, tamanho) só em
  "Detalhes do programa"; nunca argv/env/script.
- **Ferramentas atuais por bot (R12)**: `bots[].toolNames` validado (subconjunto das ferramentas fixadas, únicas, ≤ 32);
  o inspetor mostra "Permitidas agora: …" e começa a edição por elas; ausente = não informado (a edição parte das de
  leitura e avisa que salvar define exatamente as marcadas). `tools[].manifestHash` validado quando presente.
- **Erro informado pela ferramenta**: `ApprovalPresentation` lê `isError: true` só no topo do resultado do receipt (o
  envelope do adapter MCP: `{isError, content, structuredContent?}`), mantendo o estado de transporte `succeeded`. Novo
  desfecho `toolReportedError` ("Ferramenta informou erro"): "a chamada chegou ao serviço e o efeito pode ter sido
  parcial; o Dexter não confirma o que mudou lá… Não há nova tentativa automática". `isError` aninhado ou string não conta.

### C — conectar e continuar
- `ConnectionWorkflows.swift` (HostClient): lista `{requests}`, GET por id, GET `choices` (com
  `authorizationRequestIds`), complete, cancel; validação estrita; incerteza → `mutationOutcomeUnknown`.
- **Cartões de pedido** (`ConnectionSetupRequestCard`) no chat (faixa acima do composer, só a conversa atual), em
  Conexões (Mac) e na seção remota (iOS/Mac pareado): "{bot} pede acesso a {serviço}", prazo do DTO, ação conforme o
  alvo: **Conectar {serviço}…** (login correlacionado com `setupRequestId`), **Retomar login…** (GET do mesmo
  `authorizationRequestIds.last`, nunca outro link), **Revisar e permitir…**, **Abrir {servidor}…** (MCP nativo),
  **Recusar…** (inerte; não desfaz acessos).
- **Revisar acesso** (`ConnectionSetupRequestSheet`): bot fixo; conexões exatas das choices (1…5, "uma, algumas ou todas
  as listadas agora"; uma única opção vem marcada, várias não); ferramentas exatas por conexão (sugestão = já permitidas
  ou só leitura revisada; o dono edita); **Permitir e continuar** = para conta gerenciada cujo conjunto difere, `PATCH
  access` com `toolNames` exatos → GET choices de novo → um `complete` com exatamente as ferramentas escolhidas nos pins
  frescos (revision do gateway, `manifestHash`). Nativo: só ferramentas já concedidas no gerenciador; a folha nunca
  concede. Unknown/conflict param a cadeia; Conferir = GET do pedido (mesma revisão aberta = "nada foi aplicado").
- **`mcp.authorize` nativo** (handoff antigo inalterado, 9 chaves, 5 min): o gerenciador MCP aberto pelo handoff mostra o
  painel do pedido derivado `setup_<actionId>` (`NativeSetupCompletionPanel`, GET por id). Depois de entrar, descobrir e
  salvar as ferramentas deste bot, **Permitir e continuar** conclui com exatamente as ferramentas que o bot tem na
  instância (pins frescos das choices), sem pedir mensagem nova; **Recusar pedido**; Conferir. A folha de revisão também
  serve pedidos nativos vindos do chat (só ferramentas já concedidas; nunca concede).
- **Leitura consentida após o login (HTTP)**: no gerenciador MCP, para conexão HTTP com OAuth ainda não pronto, o
  interruptor **"Depois de entrar, ler as ferramentas uma vez"** (desligado por padrão, inclusive quando o handoff de um
  `mcp.authorize` aprovado abriu a janela e iniciou o login sozinho) com o plano exato ao lado: destino, credencial nova,
  nenhuma ferramenta executada, o serviço percebe, só esta conexão/base, 10 min, mudança/Stop anula, incerteza não se
  repete, processo local nunca. **Pin exato obrigatório** (o host recusa `httpOnly` sem `expectedInstancePin`): o pin vem
  do handoff do bot (mesmo servidor) e/ou de `McpServerSummary.instancePin` (64 hex validado; malformado = contrato
  inválido; ausente = desconhecido); com os dois, precisam coincidir. Sem pin ou com divergência o interruptor fica
  desligado com a frase do motivo (`mcp.oauth-read-tools-unavailable`). Ligar cria `McpConsentedDiscoveryPlan` (servidor,
  pin, contexto da janela/conversa incluindo Stop, prazo). Ao observar o login pronto do MESMO servidor, se o pin mais
  recente informado pela base ainda é o do plano, um único `POST discover {expectedInstancePin, httpOnly:true}`; pin
  diferente antes do fim do login → nada é enviado. Depois só GETs (servidores, seleção). Recusado → nada lido; incerto →
  "Atualize para consultar", nunca reenviado; prazo/base/pin/Stop/fechar/desligar → inerte. "Descobrir ferramentas…"
  manual retira o plano (CAS de pin e `httpOnly` nunca são removidos). stdio continua com confirmação separada.
- **Sem prova de pins** (`choices` 503): "Permitir" salva só o acesso, o pedido fica aberto, sem retomada automática.
- **Formulários privados MCP (MRTR)** (`McpPrivateInput.swift`, `McpPrivateInputEditor`, `McpPrivateInputCard`): chat
  (conversa atual, polling GET 3 s só com ação em execução), Conexões e gerenciador MCP. Só `elicitation/create` modo form
  com campos primitivos (texto, escolha, número/inteiro com limites, booleano); URL mode, objetos aninhados, `format`,
  sampling e outros métodos ficam "formato não aceito" (só Recusar/Cancelar). Mostra ação/ferramenta/conexão/conta,
  revisão e prazo, mensagem do servidor como "não verificada", disclosure com o pedido original quando a ação está
  carregada. **Revisar e enviar…** mostra os valores exatos para esta ação e revisão; **Enviar estes valores** só com a
  mesma revisão e envia `approval:"approve_exact_input"`. Recusar/Cancelar não levam valores nem approval. Unknown →
  Conferir (GET): nosso `clientRequestId` = registrado; mesma revisão pendente = não aplicado; outro estado = encerrado.

### F — remoto/iOS
- **Escopos pareados opt-in**: `ClientScope` + `connections.read|manage`, `mcp.read|manage`; rotas fechadas em
  `ClientRoute` (com corpo estrito por rota, inclusive `toolNames`, `setupRequestId`, `approval`), mapeadas em
  `PairedHTTPTransport`; `HostClient.requireConnections(scope)` (loopback = dono; pareado = escopo exato). Rotas de
  custódia (oauth/start, unlock/lock/disconnect de credenciais, platform-configuration) continuam fora do canal pareado.
- **Oferta de pareamento**: 4 toggles novos, desligados por padrão, labels pt/en, aviso "mudar sem ver"; `OwnerPairingScopes`
  com 6 opt-ins (máx. 14); históricos 8 inalterados.
- **iOS / Mac pareado** (`RemoteConnectionsContent`, `RemoteConnectionsSection` em Ajustes do iPhone e em Conexões do Mac
  ligado a outra base): sem escopo → frase honesta; com `connections.read` → contas com três fatos e inspetor (ações só
  com `connections.manage`); pedidos dos bots; login gerenciado abre a página do provedor via `openURL` e volta por
  Conferir; MCP nativo em leitura ("login e ferramentas são geridos no Mac dono"); formulários privados (responder só com
  `mcp.manage`). **Base offline**: a última leitura fica visível com "Base offline · última leitura HH:MM", toda mudança
  recusada (`reachable=false`).
- **Grupos**: nenhum controle (não há campos armazenados). **API key**: nenhum SecureField novo; 1Password (`broker`)
  permanece; SecureField do operador da plataforma inalterado.

## 1b. Respostas da Apple à revisão Opus R1 (autoria; a revisão R2 é independente)

| Achado | Correção Apple | Regressão |
|---|---|---|
| OR-08 | `McpPrivateInputEditor.load()` usa `health.installationId ?? health.hostId` (o `/health` pareado traz `installationId`, já ligado ao binding aprovado por `health()`); `expectedHostID` do respond = a instalação | `testPairedPrivateInputsLoadAndDeclineWithTheInstallationAsExpectedHost`: `HostClient` + `PairedHTTPTransport` falso (`/health` com `hostId:null`), load popula, `respond(.decline)` envia `expectedHostID == "host_mc"` sem `approval` |
| OR-10 | `checkWorkflow()`: revisão mais nova **ou** estado não aberto na mesma revisão (`expired`/`stopped`) limpa `pendingWorkflow` e dá `.workflowEnded(estado)`; mesma revisão aberta = `.workflowNotApplied`; o POST incerto nunca é reenviado | `testUncertainCompleteSettlesWhenTheRequestEndsAtTheSameRevisionAndFreesOtherCards` (expired e stopped): cancel de outro pedido bloqueado enquanto incerto e liberado depois; 1 único complete |
| OR-11 | O editor registra as tentativas que viu terminar (`endedAuthorizationIDs`: connected/failed/expired/cancelled/mismatch e 404); `resumableAuthorizationID(for:)` = a mais nova listada que não terminou; o cartão usa isso, senão volta "Conectar…" (novo POST com o mesmo `setupRequestId`, 1 por gesto). Independe da ordem do host | `testEndedLoginIsNeverResumedAgainAndConnectStartsOneNewAttempt` (cancelled/expired/failed): GET da antiga sem link novo (0 POST), depois 1 POST novo, 2º gesto bloqueado |
| OR-20 | `bot-settings.mcp.global` mantido: abre o gerenciador nativo "Conexões MCP" no bot da janela (contexto do bot; a Conexões unificada fica em Ajustes › Conexões). Linha corrigida na seção 4. IDs de rename atuais documentados como substitutos de `settings.connections.label.*`. Linhas de 8 campos para `mcp.setup-request`, `chat.connection-requests`, `chat.connection-requests.connect.confirm`, `chat.mcp-private-inputs`, presets, reload, resume. Seção 5 lista todos os identificadores novos/alterados | `testEveryNewAccessibilityIdentifierIsDocumented`: varre `ManagedConnectAppsViews.swift` (+ sufixos concatenados), confere os IDs novos do gerenciador e da oferta no código e exige cada um neste documento |
| OR-28 (parcial, Apple) | GETs novos marcados como não-mutação em `PairedHTTPTransport.mutating`; "Base pareada (outra máquina)" no inspetor remoto; "Abrir servidor…" não aparece no remoto (frase: é feito no Mac dono); falha de choices ≠ 503 mostra "Ler de novo" em vez de spinner; aviso quando > 5 conexões no painel nativo; "Descobrir ferramentas…" manual envia `expectedInstancePin` quando a base o informa (sem `httpOnly`) | coberto por build + suíte focada; sem teste dedicado para os textos |

## 2. Pedidos ao Root ainda abertos

| # | Pedido | Estado |
|---|---|---|
| R1 | Equivalência de identidade para pré-marcar bots ao reconectar | **Resolvido pelo Root: revisão nova conservadora.** Apple não transfere nem afirma equivalência |
| R5 | Prova de admissão no turno ("Disponível nesta conversa") | **Aberto.** Sem campo; UI nunca afirma |
| R7 | Executor do MCP nativo ("Roda no Mac X") | **Fechado.** `executor` consumido; "respondeu esta leitura" nunca vira "serviço no ar" |
| R9 | Revisão do executável stdio | **Fechado.** `command-status` consumido; `changed` bloqueia Descobrir com recuperação correta. Versão/origem/licença continuam não informadas pelo host |
| R10 | Entrada privada de API key | Mantido 1Password; aguarda decisão de custódia |
| R11 | Guia first-party | Seção 4 traz IDs + 8 campos para `app-configuration-guide.ts` (Root) |
| R12 | Ferramentas atuais por bot/conta | **Fechado.** `bots[].toolNames` consumido; ausência = desconhecido |
| R13 | Limite do corpo de `complete` | **Fechado pelo Root:** 64 KiB local = pareado (mesmo limite do `ClientRequest`) |

## 3. Arquivos

Novos: `Sources/DexterAppCore/ConnectionsPresentation.swift`, `Sources/DexterAppCore/McpPrivateInputEditor.swift`,
`Sources/DexterAppCore/McpConsentedDiscovery.swift`,
`Sources/DexterHostClient/ConnectionWorkflows.swift`, `Sources/DexterHostClient/McpPrivateInput.swift`,
`Tests/DexterAppCoreTests/ConnectionsMcpCompleteTests.swift`.
Alterados: `ManagedConnectAppsEditor.swift` (agora multiplataforma), `DexterAppModel.swift` (fábricas de conexões),
`ApprovalPresentation.swift` (`toolReportedError`),
`PairingScopes.swift`, `Connections.swift`, `McpConnections.swift`, `OwnerPairingOffers.swift`, `PairedHTTPTransport.swift`,
`ClientIdentity/.../Identity.swift` + `Request.swift`, `ManagedConnectAppsViews.swift`, `McpConnectionsView.swift`,
`SettingsView.swift`, `ChatView.swift`, `OwnerPairingOfferViews.swift`, `ConnectOtherBaseSheet.swift`,
`Localizable.xcstrings` (3326 → 3350 chaves, +24, nenhuma removida), `DexterApple.xcodeproj/project.pbxproj` (só: `ManagedConnectAppsViews.swift` também
no target iOS; `Project.yml` já inclui `SharedApp/Sources` nos dois), testes existentes ajustados ao novo contrato
(`LocalizationTests` declarações, `UXFilesConnectionsTests`, `UXPhase2MainTests`, `OutputFilesStatusContractTests`, três
fixtures de oferta com 6 opt-ins).

## 4. Controles para o guia first-party (8 campos + disponibilidade)

Disponibilidade: **UI** = só interface; **Bot** = ferramenta real do harness; **UI remota** = app pareado com escopo.
Página `connections` salvo indicação. IDs existentes reutilizados; novos marcados (novo).

| ID | Finalidade | Escopo | Estado consultável | Operação | Aprovação | Resultado | Recuperação | Disponível |
|---|---|---|---|---|---|---|---|---|
| connections.home.search (novo) | Filtrar Suas contas | janela | texto local | nenhuma (local) | — | lista filtrada | limpar busca | UI |
| connections.home.connect-app (novo) | Entrar num app da galeria ou abrir MCP avançado | base do dono | catálogo `GET /catalog` | `connections.connect` / abre gerenciador MCP | gesto + página oficial | conta conectada sem bots | Conferir | UI |
| connections.account.facts (novo, leitura) | Três fatos: conta, acesso, nesta conversa | conta/conexão | `GET /accounts`, credenciais MCP | nenhuma | — | texto por eixo | unknown por eixo → Conferir | UI, UI remota |
| connections.account.status | Inspetor da conta | conta | `GET /accounts/:id` | — | — | — | Conferir | UI, UI remota |
| connections.account.bot-access | Ferramentas exatas por bot | conta × bot | `account.bots[].access` + `bots[].toolNames` (ausente = desconhecido); receipt `access.toolNames` | `PATCH /accounts/:id/access {enabled, toolNames}` CAS | gesto do dono | bot com só as marcadas (ask); outras deny | unknown → GET receipt | UI, UI remota (`connections.manage`); Bot via `connections.request` + complete |
| connections.account.reconnect | Novo login que substitui a conta | conta antiga | `ConnectionAuthorization.replacesAccountId` | `POST /authorizations {replacesAccountId}` | gesto + página oficial | conta nova sem bots; anterior `replaced` | Conferir (GET mesmo pedido) | UI, UI remota (link aberto no navegador) |
| connections.reconnect.review (novo) | Escolher de novo quem usa a conta nova | conta nova | `reconnectReview` local | abre inspetor | — | nenhuma migração | Fechar | UI |
| connections.account.disconnect | Desconectar e pedir revogação | conta | receipt `disconnect` / status | `POST /accounts/:id/disconnect` CAS | confirmação destrutiva com bots afetados | `disconnected`; revogação pedida | unknown → GET receipt, depois conta | UI, UI remota |
| connections.account.label | Renomear (inline) | conta | `label`, receipt | `PATCH /label` CAS | gesto | nome salvo | Conferir | UI, UI remota |
| connections.receipt.check | Conferir | pedido original | receipt/conta/pedido | só GET | — | estado confirmado | — | UI, UI remota |
| connections.setup-request.card (novo) | Pedido do bot no chat/Conexões | conversa × bot × alvo | `GET /setup-requests` | Conectar (`setupRequestId`) / Retomar (GET) / Revisar / Abrir MCP | gesto | — | Conferir | UI, UI remota; criado por Bot `connections.request`/`mcp.authorize` |
| connections.setup-request.review (novo) | Escolher conexões e ferramentas exatas | pedido | `GET /setup-requests/:id/choices` | `PATCH access {toolNames}` + `POST complete {selections}` | revisão + Permitir e continuar | uma continuação do pedido original | unknown → GET pedido; mesma revisão aberta = não aplicado | UI, UI remota |
| connections.setup-request.decline (novo) | Recusar pedido | pedido | estado | `POST cancel` CAS | confirmação | pedido inerte | GET pedido | UI, UI remota |
| connections.remote (novo) | Conexões da base pareada | app pareado | escopos do binding | rotas `connections.*`/`mcp.*` | escopos opt-in do dono | conforme rota | offline = snapshot só leitura | UI remota |
| pairing.scope.connections (novo) | Oferecer escopos de conexões/MCP | oferta de pareamento | `OwnerPairingScopes` | toggles opt-in | gesto do dono | oferta com escopos exatos | parear de novo | UI (página de pareamento) |
| mcp.facts (novo, leitura) | Três fatos da conexão nativa | conexão MCP | `GET /mcp/servers`, credenciais | nenhuma | — | — | Conferir | UI (mcp-connections) |
| mcp.credential-error (novo, leitura) | Frase específica por código OAuth | conexão MCP | `credentials.lastError` | nenhuma | — | — | verbo do código | UI (mcp-authentication) |
| mcp.oauth-client-required (novo) | Client ID visível quando o serviço o exige | conexão MCP | `lastError = oauth_client_required` | `POST oauth/start {clientId}` | gesto + login | OAuth inicia | erro específico | UI (mcp-authentication) |
| mcp.stdio-boundary / mcp.import-stdio-review (novo, leitura) | Fronteira real e executável revisado antes de iniciar | Mac | definição + SHA-256 lido agora | nenhuma | — | — | revisar de novo (`command_changed`) | UI (mcp-registration) |
| mcp.discover-confirm | Confirmar descoberta com o plano exato | conexão | servidor/credencial/máquina; `command-status` | `POST discover` (bloqueado se o programa stdio mudou) | confirmação explícita | ferramentas listadas | diagnóstico | UI (mcp-connections) |
| mcp.oauth-read-tools-after-login (novo) | Ler metadados/ferramentas uma vez logo após o login | conexão HTTP × instância (pin) × janela × pedido do bot | plano local (`McpConsentedDiscoveryPlan.phase`), `servers[].instancePin`, `GET /mcp/servers/:id/tools` | `POST discover {expectedInstancePin, httpOnly:true}` uma vez | interruptor do dono com o plano exato (nunca só a aprovação de `mcp.authorize`); exige pin acordado (handoff e/ou resumo, iguais) | ferramentas listadas, nenhuma executada | sem pin/divergente → indisponível com motivo; pin mudou → nada enviado; incerto → só GET, sem reenvio; prazo/Stop/base → inerte | UI (mcp-authentication) |
| mcp.placement / executor (novo, leitura) | Onde a conexão roda e se o executor respondeu esta leitura | conexão MCP | `servers[].executor` | nenhuma | — | — | — | UI, UI remota (`mcp.read`) |
| mcp.command-review (novo, leitura) | Programa/argumentos ainda são os revisados? | conexão stdio | `GET /mcp/servers/:id/command-status` | nenhuma (GET não inicia nem refixa) | — | `changed` bloqueia descobrir | restaurar executável/args ou remover e cadastrar de novo | UI, UI remota (`mcp.read`) |
| approval.tool-reported-error (novo, leitura) | Resultado em que a ferramenta informou erro | ação | `Action.result.isError` (topo) | nenhuma | — | "Ferramenta informou erro", efeito possivelmente parcial | conferir o resultado; sem retry automático | UI (cartões/histórico de ações) |
| mcp.setup-request (novo; AX `mcp.setup-request`, `.allow`, `.decline`, `.check`) | Concluir o pedido derivado de um `mcp.authorize` aprovado | pedido `setup_<actionId>` × instância × bot | `GET /setup-requests/setup_<actionId>` + choices | `POST complete` com exatamente as ferramentas já concedidas (≤ 5 conexões; aviso se houver mais) / `POST cancel` | Permitir e continuar / Recusar pedido (gesto do dono) | uma continuação do pedido original | unknown → GET (mesma revisão encerrada = encerrado; aberta = não aplicado) | UI (gerenciador MCP aberto pelo handoff) |
| chat.connection-requests (novo) | Pedidos de conexão abertos desta conversa, acima do composer | conversa × base do dono | `GET /setup-requests` (só da conversa) | os do cartão `connections.setup-request.card` | gesto em cada cartão | — | Conferir | UI (Mac, base própria) |
| chat.connection-requests.connect.confirm (novo) | Confirmar Conectar de um pedido no chat | pedido × serviço | catálogo + pedido | `POST /authorizations {setupRequestId}` e abre a página oficial | confirmação do dono | login correlacionado; nada concedido | Conferir / Retomar login (só tentativa não encerrada) | UI |
| chat.mcp-private-inputs (novo) | Formulários privados MRTR desta conversa | conversa | `GET /mcp/input-requests` (polling 3 s só com ação em execução) | os do `mcp.private-input` | — | — | Conferir | UI, UI remota (`mcp.read`/`mcp.manage`) |
| connections.request-review.presets (novo) | Presets "Só leitura" / "Todas" das ferramentas de uma conexão no pedido | conexão escolhida × bot | choices (efeito revisado, `enabled`) | só altera a seleção local; nada é enviado | — | marcadas = exatamente as que irão no `toolNames`/`complete` | desmarcar manualmente | UI, UI remota |
| connections.request-review.reload (novo) | Ler de novo as opções quando a leitura falhou | pedido | `GET …/choices` | só GET | — | opções ou falha honesta (nunca spinner infinito) | — | UI, UI remota |
| connections.request.resume (novo; AX `connections.request.<id>.resume`) | Retomar a tentativa de login ainda aberta deste pedido | pedido × tentativa | `choices.authorizationRequestIds` menos as que o app viu encerrar | só GET da mesma tentativa (nunca link novo) | gesto | página oficial da MESMA tentativa | tentativa encerrada → volta "Conectar…" (novo POST com `setupRequestId`, 1 por gesto) | UI, UI remota |
| settings.connections.reconnect.confirm (novo) | Confirmar Reconectar | conta antiga | conta | `POST /authorizations {replacesAccountId}` | confirmação | conta nova sem bots | Conferir | UI |
| bot-settings.mcp.global (correção) | **Abre o gerenciador nativo "Conexões MCP"** (`McpConnectionsView`) no bot desta janela — não a Conexões unificada nem "Avançado" | bot da janela × MCP nativo da base do dono | lista de servidores nativos + seleção deste bot | navegação (folha); as operações são as do gerenciador | — | — | fechar a folha relê a seleção do bot (GET) | UI (Mac) |
| mcp.private-input (novo) | Responder dados pedidos pelo servidor numa ação | ação em execução | `GET /mcp/input-requests` | `POST respond {approval:"approve_exact_input"}` (aceitar) / recusar / cancelar | revisão dos valores exatos | ação continua com receipt original | unknown → GET mesmo input | UI (chat, Conexões, mcp-connections), UI remota (`mcp.manage`) |

## 5. Inventário de `accessibilityIdentifier` (novos/alterados pela Apple)

`*` = parte dinâmica (id da conta, conexão, pedido, input, bot, ferramenta ou campo). **I** = interativo; **C** =
contêiner/leitura. O teste `testEveryNewAccessibilityIdentifierIsDocumented` falha se um identificador destes arquivos
não estiver nesta lista. IDs lógicos do guia (seção 4) não mudam: o Root mantém `connections.account.label` etc.

| Identificador | Tipo | Controle lógico / nota |
|---|---|---|
| `settings.connections.accounts` · `settings.connections.accounts.empty` | C | Suas contas |
| `settings.connections.search` | I | connections.home.search |
| `settings.connections.connect-app` | I | connections.home.connect-app |
| `settings.connections.requests` | C | Pedidos dos bots |
| `settings.connections.account.*` · `settings.connections.account.*.facts` | C | linha de conta gerenciada / connections.account.facts |
| `settings.connections.account.*.primary` · `settings.connections.account.*.inspect` | I | verbo principal / abre o inspetor (connections.account.status) |
| `settings.connections.account.*.direct` | I | projeção nativa → gerenciador MCP |
| `settings.connections.account.*.rename` | I | connections.account.label (abre o campo inline) |
| `settings.connections.native.*` · `settings.connections.native.*.facts` | C | linha MCP nativa / mcp.facts |
| `settings.connections.native.*.primary` · `settings.connections.native.*.inspect` | I | abre o gerenciador MCP na conexão |
| `settings.connections.reconnect.confirm` | I | connections.account.reconnect |
| `settings.connections.reconnect-review` | C | connections.reconnect.review |
| `settings.connections.reconnect-review.bot.*.allow` · `settings.connections.reconnect-review.close` | I | escolher ferramentas (abre inspetor) / fechar |
| `settings.connections.access.check` · `settings.connections.disconnect.check` · `settings.connections.request.check` · `settings.connections.label.check` · `settings.connections.authorization.check` | I | connections.receipt.check (GET) |
| `settings.connections.authorization` · `settings.connections.notice` | C | estado do login / aviso |
| `settings.connections.authorization.reopen` · `settings.connections.authorization.dismiss` | I | reabrir a mesma página / fechar |
| `settings.connections.paired` | C | contêiner da seção remota no Mac pareado (antes: frase fixa) |
| `settings.connections.platform` · `settings.connections.unconfigured` · `settings.connections.unavailable` · `settings.connections.requirements` · `settings.connections.requirements.list` | C | pré-existentes (galeria/plataforma) |
| `settings.connections.configure` · `settings.connections.reload` · `settings.connections.connect.*` · `settings.connections.connect.confirm` · `settings.connections.requirements.close` | I | pré-existentes (galeria/plataforma) |
| `settings.connections.service.*` | C | pré-existente (linha do catálogo) |
| `connections.fact.*` | C | um fato (account/access/admission) |
| `connections.inspector` · `connections.inspector.facts` · `connections.inspector.access` · `connections.inspector.technical` | C | connections.account.status |
| `connections.inspector.close` · `connections.inspector.done` | I | fechar (Esc) / concluir |
| `connections.inspector.rename.field` · `connections.inspector.rename.save` | I | connections.account.label — **substituem** `settings.connections.label.field` e `settings.connections.label.save` (removidos com a folha de nome) |
| `connections.inspector.label.check` · `connections.inspector.access.check` · `connections.inspector.disconnect.check` | I | connections.receipt.check |
| `connections.inspector.bot.*.allow` · `connections.inspector.bot.*.revoke` · `connections.inspector.bot.*.save` · `connections.inspector.bot.*.tool.*` | I | connections.account.bot-access (seleção exata) |
| `connections.inspector.bot.*.tools` · `connections.inspector.bot.*.current` | C | painel de ferramentas / "Permitidas agora" |
| `connections.inspector.reconnect` · `connections.inspector.disconnect` · `connections.inspector.disconnect.confirm` | I | connections.account.reconnect / connections.account.disconnect |
| `connections.request.*` | C | connections.setup-request.card |
| `connections.request.*.connect` · `connections.request.*.resume` · `connections.request.*.review` · `connections.request.*.open` · `connections.request.*.decline` · `connections.request.*.decline.confirm` · `connections.request.*.check` | I | connections.setup-request.card / connections.request.resume / connections.setup-request.decline |
| `connections.request-review` · `connections.request-review.notice` · `connections.request-review.pins-unavailable` · `connections.request-review.native-no-tools` | C | connections.setup-request.review |
| `connections.request-review.close` · `connections.request-review.done` · `connections.request-review.allow` · `connections.request-review.check` · `connections.request-review.access-check` · `connections.request-review.reload` | I | connections.setup-request.review / connections.request-review.reload |
| `connections.request-review.account.*` · `connections.request-review.connection.*` · `connections.request-review.tool.*.*` · `connections.request-review.presets.*` | I | escolha de contas/conexões, ferramentas exatas e presets Só leitura/Todas |
| `connections.remote` · `connections.remote.no-scope` · `connections.remote.offline` · `connections.remote.notice` · `connections.remote.native.*` | C | connections.remote |
| `connections.remote.account.*` · `connections.remote.refresh` · `connections.remote.authorization.check` · `connections.remote.authorization.reopen` | I | connections.remote |
| `chat.connection-requests` · `chat.mcp-private-inputs` · `chat.mcp-private-inputs.notice` | C | chat.connection-requests / chat.mcp-private-inputs |
| `chat.connection-requests.connect.confirm` | I | chat.connection-requests.connect.confirm |
| `mcp.private-inputs.history` · `mcp.private-inputs.refresh` · `mcp.private-inputs.more` · `mcp.private-inputs.summaries` | I | mcp-private-input — filtro, atualização, próxima página e resumos, somente GET |
| `mcp.private-inputs.open.*` | I | mcp-private-input — GET do formulário exato antes de revisar |
| `mcp.private-input.*` · `mcp.private-input.*.review` · `mcp.private-input.*.original` | C | mcp.private-input |
| `mcp.private-input.*.field.*` · `mcp.private-input.*.review-button` · `mcp.private-input.*.send` · `mcp.private-input.*.back` · `mcp.private-input.*.decline` · `mcp.private-input.*.cancel` · `mcp.private-input.*.check` | I | mcp.private-input |
| `mcp.facts` · `mcp.placement` · `mcp.credential-error` · `mcp.stdio-boundary` · `mcp.command-review` · `mcp.import-stdio-review` · `mcp.oauth-client-required` · `mcp.oauth-read-tools-plan` · `mcp.oauth-read-tools-unavailable` · `mcp.setup-request` | C | gerenciador MCP (leitura) |
| `mcp.discover-confirm` · `mcp.oauth-read-tools-after-login` · `mcp.setup-request.allow` · `mcp.setup-request.decline` · `mcp.setup-request.check` | I | mcp.discover-confirm / mcp.oauth-read-tools-after-login / mcp.setup-request |
| `pairing-offer.scope.*` · `owner-pairing-offer.scope.*` | I | pairing.scope.connections (valores novos: connections.read, connections.manage, mcp.read, mcp.manage) |

## 6. Verificação (14/10, HEAD `8bd73e9b`, sem commit)

Ambiente: Xcode do sistema, Node `v24.20.0` (`~/.nvm`) só para os fixtures TLS sintéticos locais. Nada instalado, nenhum
app aberto/encerrado, nenhuma conta/OAuth/provedor/Keychain real, `CFBundleVersion` intocado. Derivados em
`/private/tmp/dexter-apple-ux/` (fora do repo).

| Verificação | Comando (resumo) | Resultado | Saída |
|---|---|---|---|
| Build Mac (última) | `xcodebuild -scheme DexterMac -configuration Debug -destination platform=macOS -derivedDataPath /private/tmp/dexter-apple-ux/mac-dd CODE_SIGNING_ALLOWED=NO SWIFT_EMIT_LOC_STRINGS=YES SWIFT_STRICT_CONCURRENCY=complete SWIFT_TREAT_WARNINGS_AS_ERRORS=YES OTHER_SWIFT_FLAGS='$(inherited) -strict-concurrency=complete -warnings-as-errors' build` | BUILD SUCCEEDED | `r5-Mac.log` |
| Build iOS Simulator | idem `-scheme DexterIOS -destination 'generic/platform=iOS Simulator' -derivedDataPath …/ios-dd` | BUILD SUCCEEDED | `r5-IOS.log` |
| Pacote + testes focados | `swift build --scratch-path /private/tmp/dexter-apple-ux/spm --build-tests`; `DEXTER_TEST_NODE=… DEXTER_LOCALIZATION_{MAC,IOS}_BUNDLE=…/Dexter.app DEXTER_LOCALIZATION_{MAC,IOS}_STRINGSDATA=…/Build/Intermediates.noindex swift test --skip-build --filter "LocalizationTests\|ConnectionsMcpCompleteTests\|UXFilesConnectionsTests\|OwnerPairingOffersTests\|OwnerPairingOfferEditorTests\|UXPairingOfferTests\|UXPhase2PairingScopeTests\|UXPhase2OtherBaseTests\|OutputFilesStatusContractTests\|OutputFilesPairedTests\|ConnectionsHostClientTests\|McpHostClientTests\|PairedHTTPTransportTests\|ClientR3ControlContractTests\|McpAuthorizationHandoffTests\|McpLifecycleUIR4Tests\|McpOAuthCustodyTests\|McpRegistrationClientR4Tests\|PairedAppModelTests\|SettingsScopeR5Tests\|ApprovalCompactSummaryTests\|ApprovalPresentationTests\|ApprovalModesAndSummaryTests"` | DexterAppCoreTests 151 executados, 0 falhas, 4 pulados (live, exigem ambiente real); DexterHostClientTests 37, 0 falhas, 1 pulado | `test-final-5.log` |
| ClientIdentity | `cd ClientIdentity && swift test --filter "RequestTests\|IdentityTests\|BindingTests"` (com `DEXTER_TEST_NODE`); sem mudança desde então | 36 executados, 0 falhas | `test-ci-2.log` |
| Novos testes | `ConnectionsMcpCompleteTests` | 41/41 | `test-final-5.log` |

`ConnectionsMcpCompleteTests` cobre: três fatos e unknown por eixo; needs_reconnect sem data; fatos nativos (cadastro ≠
desativado, credencial de outra conexão ignorada); um texto por código OAuth sem chave de API; fronteira stdio e plano de
descoberta; Reconectar = 1 POST com `replacesAccountId`, conta nova sem bots, 0 PATCH; desconexão incerta resolvida por
receipt / conta ainda `disconnecting` permanece aberta; CAS + cancelamento da Task = unknown + Conferir; acesso exige conta
conectada e fica preso ao primeiro host; pedidos sem pins não concluem; Permitir e continuar = PATCH com `toolNames` → GET
choices → 1 complete com pins do gateway; incerto → Conferir; mesma revisão aberta = não aplicado; Recusar inerte;
nativo nunca concede; base sem rota = não suportado; **snapshot de 5 contas** (IDs materializados, 6ª conta não recebe
nada, >5 recusado antes de qualquer leitura); login ligado ao pedido não concede nada e reabrir lê a mesma tentativa;
`toolNames` ordenados/únicos no hash e no receipt; handoff nativo conclui `setup_<actionId>` só com ferramentas já
concedidas; formulários MRTR só primitivos (URL mode, aninhado, `format`, sampling recusados); aceitar exige
`approve_exact_input`, recusar/cancelar sem valores; 1 POST e incerteza resolvida por GET; mesma revisão = não aplicado;
base sem recurso = não suportado; rotas pareadas com escopo exato e corpo fechado (aceitar sem approval recusado; rotas de
custódia fora; `command-status` com escopo `mcp.read`); oferta opt-in até 14 escopos; auditoria de fechar visível + Esc
nas folhas de conexões; `isError` no topo vira "Ferramenta informou erro" (aninhado/string não); executor
"respondeu esta leitura" sem afirmar serviço no ar e valor fora do contrato descartado; `command-status` por estado
(`changed` bloqueia, `unchanged` falso recusado, `null` = desconhecido, só GET); `bots[].toolNames` exatos ou
desconhecidos e `manifestHash` validado; leitura consentida: nunca stdio, um único POST com pin + `httpOnly` só depois do
login pronto do mesmo servidor, tardia/parada/retirada inerte, incerta não reenviada, recusada sem leitura; corpo de
`discover` = `{}` legado ou exatamente as duas opções; o interruptor é o único lugar que arma o plano; `instancePin` do
resumo exato/ausente/malformado recusado; resolução de pin (handoff, resumo, iguais, divergentes, nenhum); plano exige
pin e não aceita pin diferente do resumo; pin trocado antes do fim do login = nada enviado; leitura manual sem handoff
usa o pin do resumo num único POST válido.

Não executado: suíte Swift completa, testes de UI do app, composição real host/agente, OAuth/Composio/ExampleMCP real,
servidor MCP real com MRTR, aparelho iOS. Esses são gates de runtime, não ausência de controle: os controles existem e
mostram o estado honesto até a prova real.

## 7. Pins (SHA-256 após a última alteração)

| Arquivo (`apps/apple/…`) | SHA-256 |
|---|---|
| `ClientIdentity/Sources/DexterClientIdentity/Identity.swift` | `68fbf4ee4d422768afc6cab0f9f3fa5c6cbfc1b9153fef3dcfee8caf4c459033` |
| `ClientIdentity/Sources/DexterClientIdentity/Request.swift` | `d7a34716c75db3a9f9b8eb90acf176307873e76cb855d846d5db121ba3851d20` |
| `DexterApple.xcodeproj/project.pbxproj` | `0f13cd6392eaacbc7aeafc07af14f108dadba20bee10582e7ef5f19bf4f88dd6` |
| `SharedApp/Resources/Localizable.xcstrings` | `dbe8ae3a93c4d87346a60b27818ad324bb9f8cea8560046956f9bc6310432754` |
| `SharedApp/Sources/ChatView.swift` | `85f0fd5df0f0f70f9a20d64533b1ad830e83f091d703f254e8baaa09e2f95950` |
| `SharedApp/Sources/ConnectOtherBaseSheet.swift` | `a4ac0cfa0640ec144a39cf7037d0130cdd82f6b14f25b684f94af250951866e5` |
| `SharedApp/Sources/ManagedConnectAppsViews.swift` | `f6b7daac3c3b63abd3e71b62538dccd1c5889fbaf7ce3e5867fc43861f2230e1` |
| `SharedApp/Sources/McpConnectionsView.swift` | `6c314c506184da010aced5ee38e1406fdddf2098baf8f9c0d9e71fe354617dde` |
| `SharedApp/Sources/OwnerPairingOfferViews.swift` | `c21ce073998bb5664b4aa56adda1d274dc66f368032a802c6b1db3f7346bb4b5` |
| `SharedApp/Sources/SettingsView.swift` | `7a5fcac25ff5255701d89be191e2ff5a9cfa895f6ac000dd94ac40cb72bbd5be` |
| `Sources/DexterAppCore/ApprovalPresentation.swift` | `6bb3bca0e79f5a96faa6b7d0c6388d1f1ba12720d2ce454e4d54dc758a58288f` |
| `Sources/DexterAppCore/DexterAppModel.swift` | `6c5bdf9cf77355d7cd8027335bd39ad735b8d543ee164ae5f5fa0f7808cf9052` |
| `Sources/DexterAppCore/ManagedConnectAppsEditor.swift` | `f9da661b943ddc176c912b60309c68d1caef3285f25de658acaa29362e2d1c6a` |
| `Sources/DexterAppCore/PairingScopes.swift` | `4264088a7407857a2a14f8dee62e3df478123b73dafcb58182e833e62a14c22d` |
| `Sources/DexterHostClient/Connections.swift` | `904d13bf0d48752f443c6b20b29503deb20e0918f5c5edeb635212da85cce7c8` |
| `Sources/DexterHostClient/McpConnections.swift` | `8d5da0604fde727d9979f990d9e61178b1026f13574ad953161b1e0cbb9f288b` |
| `Sources/DexterHostClient/OwnerPairingOffers.swift` | `23f15bcf345fb65b3208f310d1a5a61d2fdcc59218fceda990059a6c3417af58` |
| `Sources/DexterHostClient/PairedHTTPTransport.swift` | `6dd1b58ad6fd3317d416444bc77f0d993c0e3b42d7760d4730b09caeec42cdb4` |
| `Tests/DexterAppCoreTests/LocalizationTests.swift` | `26fa24b7dc05e3f168d453eb1ed43cd86b02943c48c618f710d471fc93aef550` |
| `Tests/DexterAppCoreTests/OwnerPairingOfferEditorTests.swift` | `e2e4036cd674454932b8e409fdbe25107876a6d1144ee9549c59feeab66ef4cf` |
| `Tests/DexterAppCoreTests/UXFilesConnectionsTests.swift` | `d4f699b3df35b3ff58f770c1196c627602bd5c74bfdf3b1d11f8ae84adfc853b` |
| `Tests/DexterAppCoreTests/UXPairingOfferTests.swift` | `b4610cd03c73678ae6d404d152c119976879b7fffbb867739cc6341b5ad28946` |
| `Tests/DexterAppCoreTests/UXPhase2MainTests.swift` | `475f3f8db963814016933ea3e8203305ab8b16d20571fb95156eb65edc15e55d` |
| `Tests/DexterHostClientTests/ConnectionsHostClientTests.swift` | `06e31fe903c0032fe86123cce00d69c928a84a5832f0851af39057d1feec9755` |
| `Tests/DexterHostClientTests/OutputFilesStatusContractTests.swift` | `0af7c7a2f9df3c3e416e3ba20d7ca6cce374c0b316294990f1ee124a8d8afb8f` |
| `Tests/DexterHostClientTests/OwnerPairingOffersTests.swift` | `ac8aa666eece10881dc7f213dfcd12a5905ffd9f624c52da6e7ee3c2c29b17e3` |
| `Sources/DexterAppCore/ConnectionsPresentation.swift` | `a95de95cf514880b448498c787b41009a446b18395f6a786494959c8445c9385` |
| `Sources/DexterAppCore/McpConsentedDiscovery.swift` | `5c65e02bc519d9cf595a78548be4b9242e7d72f3475e53dcba9b0bc9d0af028e` |
| `Sources/DexterAppCore/McpPrivateInputEditor.swift` | `dab6ebf59ccb1b391a73a8cb6c71a4b90759514225d02209fbab219caa576892` |
| `Sources/DexterHostClient/ConnectionWorkflows.swift` | `26407c60684b8d298f10f27a9a599c7f08b94dc98f65928a891ef59e6f31c1de` |
| `Sources/DexterHostClient/McpPrivateInput.swift` | `835ec563929d3e8cbd754b8b8c23e160382d8ac7937d363b4187e9c536e391ac` |
| `Tests/DexterAppCoreTests/ConnectionsMcpCompleteTests.swift` | `d59cb4ab224b1b1414da06e94c76f50b8fe7f6c0e5225e7138f43247a769a6f6` |


## R6 — formulários privados incompletos e QR real

Os indicadores `chat.mcp-private-inputs.incomplete` e `mcp.private-inputs.incomplete` apresentam as contagens invalidRequestCount/quarantinedRequestCount/omittedRequestCount da base selecionada e o estado incomplete, sem omitir silenciosamente pedidos válidos irmãos. Linha inválida ou em quarentena não oferece Accept/Decline/Cancel POST. O GET é puro e não saneia o store live. Só a cópia de backup pode substituir as classes históricas fechadas por auditoria hash-only inerte, preservando referências/revisões/UUID reservation; corrupção fora dessas classes continua recusada.

O pareamento Mac/iPhone por QR é documentado em configuration `ios-qr-pairing`; novo primeiro uso físico não entra em demo. A preparação de canal exige gesto humano e base própria ociosa. A identidade esperada da instalação/dono é capturada no ready do filho anterior e conferida pelo CLI antes de ler/criar custódia ou abrir listener. Identidade divergente mantém o filho próprio sob cleanup/stopUncertain. Uma falha remota opcional só permite recuperar chat local SEM canal depois da saída efetivamente observada do filho; sem repetir create/chave/offer/claim/grant ou trocar a seleção. QR/código ficam privados e voláteis, fora de logs, chat e AX text. Provas físicas ainda são separadas dos builds/sintéticos.


## R7 — recuperação e renovação do canal opcional

Controles humanos Mac: `owner-pairing-offer.renew.open` abre confirmação; `owner-pairing-offer.renew.confirm` inicia a renovação exata; `owner-pairing-offer.renew.cancel` só fecha a confirmação; `owner-pairing-offer.resume-channel` retoma a geração pending/creationId original. A renovação existe para certificado expirado, IP privado novo ou custódia anterior inacessível; gera novo caminho versionado, item Keychain e pin sem sobrescrever/apagar o sealed antigo. Só depois da saída confirmada do writer próprio; stopUncertain conserva referência e recusa outro filho. Não cria oferta, claim ou grant; aparelhos anteriores precisam de novo QR e aprovação.

Startup/Apply não rotacionam. Canal opcional ausente/bloqueado/metadata ilegível ou obsoleto permite chat local e mudança de engine com aviso. Unlock obrigatório de dispositivo é independente e não é contornado. Fallback local de startup/Apply aceita a identidade que a partida local normal aceita; preparação/renovação explícitas continuam presas ao host E dono capturados. A fonte de configuração, cada controle, recuperação e limites ficam em configuration `ios-qr-pairing`/`owner-pairing-offer`, catálogo first-party1.69.0. Validação física foi adiada pelo usuário ao desconectar o iPhone.

## R8 — consentimento por plataforma e formulários privados paginados

O propósito do microfone no Mac descreve voz ao vivo com envio à OpenAI durante a sessão, em EN e PT-BR. O usuário inicia Live, concede TCC e pode Silenciar ou Parar; o bot não inicia captura ou concede a permissão. A tabela Mac tem somente microfone e rede local e fica separada dos purposes do iPhone. O guia operacional é `configuration/chat-live`.

A mesma declaração de microfone cobre a chamada nativa Codex quando iniciada pelo proprietário: o áudio segue para a OpenAI pelo fluxo oficial Codex. Assinatura CLI e API Live têm configuração/cobrança próprias; ambas exigem sessão humana e consentimento macOS. Consulte também `configuration/native-codex-voice`.

A lista privada MCP usa resumos version2 sem campos; resumo não é um formulário respondível. O default mostra esperas vivas. Histórico é paginado por chave, sem garantia de snapshot ou ordem cronológica. Abrir busca e valida o registro exato antes de mostrar os campos; Enviar/Recusar/Cancelar conservam a revisão, o actionId/hash e as decisões do host. O guia operacional é `configuration/mcp-private-input`.

| ID estável | Controle | Operação |
| --- | --- | --- |
| `mcp.private-inputs.summaries` | Resumos sem campos | GET privado; apenas leitura com `mcp.read` |
| `mcp.private-inputs.history` | Ver histórico retido / Ver pendentes ativos | Troca local do filtro e primeira página |
| `mcp.private-inputs.refresh` | Atualizar formulários | Reinicia cursor; não reenvia POST |
| `mcp.private-inputs.more` | Carregar mais resumos | Usa `nextCursor` para outra página limitada |
| `mcp.private-inputs.open.<id>` | Abrir formulário | Hidrata o ID exato pelo GET; resposta exige decisão separada |

`invalidRequestCount` conta envelopes inválidos da página, enquanto quarentena e histórico retido são contados na base. Corpo não carregado continua não verificado, sem anúncio de schema válido. Leituras não podam nem alteram o journal; retenção durável append-only continua explícita. O limite HTTP maior é exclusivo das rotas privadas autorizadas, sem ampliar grants ou o subconjunto de schemas. A QA física do iPhone continua adiada pelo usuário.

## R9 — catálogo e continuidade dos formulários

Os quatro aliases fixos de resumos/histórico/atualização/página e o padrão dinâmico de abertura pertencem à página `mcp-private-input` no catálogo first-party e constam do inventário da seção 5. Seus registros conservam os oito campos operacionais; nenhum deles concede uma ferramenta de mutação ao bot.

Consulta periódica conserva filtro, páginas/cursor e formulários exatos abertos. O botão Atualizar formulários reinicia explicitamente a janela de resumos; campos abertos seguem sujeitos à revisão, ao prazo e ao desfecho real. O chat conserva controles de navegação mesmo sem itens desta conversa na página atual. Um GET em andamento não descarta o gesto Enviar nem consome a revisão. Se o resultado do POST for incerto, `mcp.private-input.<id>.check` continua disponível na lista independentemente do cartão/filtro/conversa apresentada no mesmo editor/base. A linha mostra somente metadados da conexão/ação/conversa/pedido originais, sem guardar valores respondidos; só consulta o pedido original e não navega ou muda seleção. Nenhum POST é repetido e troca de base/geração invalida a leitura antiga.

O histórico canônico continua append-only. Os limites gerais do backup são128MiB por membro de banco e50.000 linhas meta na validação dos journals; outros dados da base também consomem esses limites. Não existe limpeza/compactação de formulários no produto. Uma recusa de quota não se resolve com Atualizar/reinstalar/repetir captura. Preserve o último backup válido e solicite diagnóstico ao operador, sem apagar linhas ou perder reservas de UUID/receipts.
