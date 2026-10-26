import { createHash } from "node:crypto";
import type { AppConfigurationGuideField, AppConfigurationGuidePage } from "./app-configuration-guide.js";

/** Static first-party manual. Root composes this page/overlay before freezePage, which owns page hashes. */
export const ASSISTANT_FIRST_RUN_GUIDE_REVISION = "assistant-first-run-2026-10-14-r2";
type PageInput = Pick<AppConfigurationGuidePage, "id" | "title" | "scope" | "availability" | "sourcePaths" | "notes" | "fields">;
const scope = "app do proprietário e base própria deste Mac; escolha de provider por janela, sem acesso novo para bots";
const approval = "Interface humana somente. Não existe ferramenta do bot para preparar app/CLI, entrar em conta ou mudar esta preferência. Documentação não concede acesso, OAuth, pareamento, TCC ou poder de autoaprovação.";
const recovery = "Unknown conserva requestID/hash originais e oferece Conferir, somente leitura. Não reenvie instalação/aplicação por timeout nem troque de ID para repetir resultado incerto. Cancelar só atinge a tarefa/processo próprios e não prova rollback.";
const sourcePaths = [
  "apps/apple/Sources/DexterAppCore/AssistantFirstRunCoordinator.swift",
  "apps/apple/Sources/DexterAppCore/AssistantSetupController.swift",
  "apps/apple/SharedApp/Sources/AssistantSetupView.swift",
  "apps/apple/SharedApp/Sources/SettingsView.swift",
  "apps/apple/SharedApp/Sources/DexterRootView.swift",
  "apps/apple/AssistantRuntimeSetup/Sources/DexterAssistantRuntimeSetup/AssistantRuntimeSetup.swift",
  "apps/apple/AssistantRuntimeSetup/Sources/DexterAssistantRuntimeSetup/Metadata.swift",
  "apps/apple/AssistantRuntimeSetup/Sources/DexterAssistantRuntimeSetup/Store.swift",
];
function control(id: string, title: string, purpose: string, read: string, change: string, result: string,
  recover = recovery): AppConfigurationGuideField {
  return { id, title, purpose, scope, read, change, approval, result, recovery: recover,
    availability: "human_only", readOperation: null, changeOperation: null };
}
const bundleRead = "AssistantBundledPreparation lê somente launch.json e manifest.json do bundle e compara SHA256 do Node, entrypoint CLI e módulos app-configuration-guide/harness-guide. Nunca executa um instalador, varre dados do usuário ou lê authfiles. Manifestos/arquivos ausentes, fora do bundle ou alterados ficam a confirmar.";

export const ASSISTANT_FIRST_RUN_GUIDE_PAGE_INPUT: PageInput = {
  id: "assistant-first-run", title: "Primeiro uso — preparar o Dexter neste Mac", scope, availability: "human_only", sourcePaths,
  notes: [
    "Na janela principal, o checklist abre após a primeira tentativa de iniciar a base própria deste Mac, mesmo se ela falhar e mesmo com bots existentes. Não aparece automaticamente em fixtures ou numa base remota. Continuar/Fechar registram apenas a revisão humana com.dexter.apple.assistant-first-run.v1; não comprovam runtime, login, permissões ou prontidão. O welcome/criação só abre depois e se realmente elegível. Trocar a base fecha a consulta antiga. Ajustes › Assistentes › Preparação inicial reabre o checklist sem depender da marca.",
    "A preparação automática verifica os componentes já incluídos e entra no startup one-shot existente de LocalHostLaunchCoordinator.initialRefresh. Ele prepara somente diretórios/configuração da base do app; não instala CLIs opcionais, skills externas, Homebrew, sudo, shell installer ou dependências globais. Reiniciar/verificar novamente não reenvia conversas. Base ativa de outro processo não é apropriada nem encerrada.",
    "Escolher Claude/Codex só abre o plano. Download exige Instalar e usar com versão/URL/SHA/arquitetura pinados no requestHash e fonte oficial allowlisted. Reuse mantém o launcher original e usa POSIX realpath para o mesmo alvo pinado no host, inclusive /var e /private/var. Diretórios imutáveis, assinatura do fornecedor/Gatekeeper e limites de bytes/prazo continuam obrigatórios. Ambiente limpo e pasta privada não são sandbox do SO.",
    "enabled, installed, available e authentication são fatos separados. O catálogo não tem prova de login: unknown não significa logout. Login oficial concluído indica somente exit0 daquele fluxo, sem provar assinatura ou inferência. Nenhum authfile/token/stdout privado entra no chat, log, journal ou manual.",
    "Progresso mostra inspecting/resolvingRelease/reusing/downloading/verifying/committing/reconciling; é observação e nunca receipt de êxito. Cancelamento reconhecido antes da admissão grava receipt cancelled sob o mesmo lock para preservar dedupe após reabertura. Busy antes de admissão admite gesto humano de retry com MESMO plano/ID/hash. Falha/cancelamento terminais conhecidos admitem novo pedido humano; uncertain continua somente leitura pelo pedido original.",
    "A recuperação examina todo o diretório limitado a4096 entradas antes de filtrar journals; mais de64 pendentes ou limite excedido é erro explícito, nunca uma lista silenciosamente truncada. Probes de versão/help/schema usam saída limitada por fstat e leituras limitadas, HOME scratch, sem herdar credenciais; só processos próprios são cancelados.",
    "Skills e conexões externas são opcionais e só se configuram pelos controles existentes depois de criar o bot. Os manuais first-party acompanham o host sem skill instalada. Acesso ao computador é opcional para conversar: seu atalho só navega ao fluxo privado de Este Mac e não concede permissões.",
  ],
  fields: [
    control("assistant-first-run.sheet", "Checklist de preparação", "Reunir pré-requisitos no primeiro uso.",
      "AssistantFirstRunCoordinator.phase idle/checking/ready/blocked; indicadores runtime/guides/host e fatos por assistente.",
      "Ao abrir, verifica bundle e entra uma vez no startup já existente; a abertura não escolhe provider nem baixa programas.",
      "Componentes verificados ou motivo de ausência; não prova login nem uso real."),
    control("assistant-first-run.runtime", "Runtime incluído", "Confirmar o Node incluído sem instalar outro.", bundleRead,
      "Indicador somente leitura; nenhuma alteração por este controle.", "Verificado só após SHA256 compatível com o manifesto incluído."),
    control("assistant-first-run.guides", "Configuração e guias incluídos", "Confirmar CLI e documentação operacional sem instalar skills.", bundleRead,
      "Indicador somente leitura. Configuração canônica da base continua no startup existente.", "Entry point e dois módulos de guia verificados; skills opcionais não são anunciadas como instaladas."),
    control("assistant-first-run.host", "Base deste Mac", "Confirmar que a base própria está online.",
      "hostIsReady exige acceptsLocalEnginePreference, endereço deste Mac, model.isOnline e hostID igual ao confirmedOwnedHostID.",
      "Indicador somente leitura; startup one-shot é do coordinator existente.", "Somente host próprio confirmado fica verificado; remoto, fixture ou porta ocupada não são apropriados."),
    control("assistant-first-run.progress", "Preparando componentes incluídos", "Explicar a verificação em andamento.",
      "phase checking do coordinator; sem percentual fabricado.", "Sem alteração por este indicador.", "Aguardando somente verificação local/startup próprio."),
    control("assistant-first-run.blocked", "Componente incluído indisponível", "Mostrar falha real de empacotamento ou integridade.",
      "phase blocked quando runtime, configuração ou guias não conferem.", "Não oferece bypass nem instala componente global; humano abre cópia completa e usa Verificar de novo.", "Preparação do provider bloqueada; continuar ainda permite consultar conexão."),
    ...["claude", "codex"].flatMap(provider => [
      control(`assistant-first-run.status.${provider}`, `Estado do ${provider}`, "Separar programa, escolha, disponibilidade e login.",
        "status(engine) lê escolha local salva e catálogo com lookup loaded; falha de consulta retira certeza de installed/available e authentication permanece unknown.",
        "Somente leitura; não lê conta nem faz login para verificar.", "Instalado/não instalado/desconhecido, escolha ligada/desligada, disponível/indisponível/desconhecido e login não confirmado separados."),
      control(`assistant-first-run.prepare.${provider}`, `Preparar ${provider}`, "Escolher explicitamente um assistente oficial.",
        "Habilitado somente após componentes verificados, base própria confirmada e sem atividade que bloqueie setup.",
        "Gesto humano chama choose(engine) e makeAssistantSetupController, abrindo a sheet já documentada em assistant-setup. Abrir só prepara o plano; Instalar e usar é outra decisão.",
        "Plano de reuse/download da engine escolhida. Sem CLI opcional, login ou bot criado automaticamente."),
    ]),
    control("assistant-first-run.optional-skills", "Skills e conexões opcionais", "Explicar o que já acompanha o app e o que é escolha posterior.",
      "Texto informativo do checklist; guias verificados separados de skills de bot.", "Nenhuma mutação; a instalação de skills/conexões usa as telas existentes depois de criar o bot.", "Nenhuma dependência externa é instalada por abrir o checklist."),
    control("assistant-first-run.computer-access", "Configurar acesso ao Mac", "Navegar ao setup opcional do computador.",
      "Atalho só aparece quando o chamador oferece openComputerAccess.", "Abre Ajustes › Este Mac pelo callback existente; não instala, pareia ou concede TCC por este botão.",
      "Navegação para os fluxos humanos de helper, pareamento, grants e permissões do macOS."),
    control("assistant-first-run.refresh", "Verificar de novo", "Refazer consultas locais e entrar no startup existente.",
      "phase atual e indicadores do checklist.", "Gesto humano reinicia só a consulta do checklist. O host já iniciado participa da tentativa one-shot; não nasce outro processo por renderização.",
      "Nova leitura de componentes/estado da base; sem novo pedido de instalação/login."),
    control("assistant-first-run.continue", "Continuar", "Seguir para o welcome/criação já existente, mesmo sem habilitar recursos opcionais.",
      "Desabilitado enquanto a preparação local está checking; estado pode permanecer bloqueado/desconhecido.",
      "Fecha a tarefa de consulta própria e chama onContinue. O wrapper registra apenas a revisão humana no domínio não secreto do app; Ajustes só fecha a sheet.",
      "Abre o welcome existente; não cria bot nem prova prontidão sozinho."),
    control("assistant-first-run.close", "Fechar preparação", "Sair do checklist sem conceder acesso nem iniciar instalação.",
      "Botão X ou Escape da mesma apresentação; a consulta pode estar em andamento.",
      "Cancela somente a consulta própria e chama onContinue. Na janela principal registra a revisão humana; em Ajustes fecha a sheet.",
      "Fecha a tela e permite o welcome se elegível. Instalação já admitida mantém receipt e seu fluxo próprio; fechar não confirma rollback."),
  ],
};

export function applyAssistantFirstRunGuideOverlay(input: PageInput): PageInput {
  if (input.id !== "assistant-setup" && input.id !== "settings-models" && input.id !== "settings-assistants") return input;
  const fields = new Map(input.fields.map(value => [value.id, value]));
  const values = input.id === "assistant-setup" ? [
    control("assistant-setup.retry", "Tentar novamente", "Recuperar falha terminal conhecida na etapa correta.",
      "controller.recovery e canRetry; ausência em unconfirmed, durante trabalho, com login próprio ainda encerrando ou escopo alterado.",
      "inspectAgain/prepareAgain gera novo pedido apenas se sem receipt ou failed/cancelled conhecidos; applyAgain conserva receipt committed e só arma Usar; signInAgain inicia fluxo oficial humano; sameRequest conserva plano/ID/hash após busy pré-admissão.",
      "Consulta/plano ou login explicitamente repetível; instalação/aplicação unknown nunca é reenviada."),
    ...["program-state", "choice-state", "account-state"].map(id => control(`assistant-setup.${id}`, "Estado da preparação", "Separar instalação verificada, aplicação à base e conta.",
      "programIsPrepared, choiceIsApplied e phase da mesma sheet; conta não é consultada. signInFinished é apenas saída0 do fluxo oficial.",
      "Indicador somente leitura; mudança usa os controles existentes Usar/Entrar.", "Receipt de instalação, configuração real e fluxo de login aparecem como fatos distintos.")),
  ] : [
    control("settings.assistants.first-run", "Preparação inicial", "Reabrir o checklist sem procurar pré-requisitos em outras telas.",
      "Disponível na pane Assistentes gerenciável, sem aplicação ou rascunho pendente.", "Gesto humano abre AssistantFirstRunChecklistView com o mesmo coordinator.", "Checklist com ações reais; nenhuma instalação automática ao abrir."),
    ...["installed", "authentication", "enabled", "state"].map(id => control(`settings.assistants.detail.${id}`, "Estado do assistente", "Distinguir programa, escolha no Mac, disponibilidade e conta.",
      "Catálogo da base atual e escolha local; installed/available desconhecidos quando não confirmados. Toggle é rascunho para Aplicar, não conexão ou login.",
      "Somente indicadores; chaves e Aplicar mantêm seus controles humanos existentes.", "Não infere autenticação, assinatura ou inferência a partir de uma chave ligada.")),
  ];
  for (const value of values) fields.set(value.id, value);
  if (input.id === "assistant-setup") {
    const inspect = fields.get("inspect");
    if (inspect) fields.set("inspect", { ...inspect, read: `${inspect.read} O progresso detalha inspecting/resolvingRelease/reusing/downloading/verifying/committing/reconciling; não é receipt.`, recovery });
  }
  return { ...input, sourcePaths: [...new Set([...input.sourcePaths, ...sourcePaths])],
    notes: [...input.notes, `Revisão ${ASSISTANT_FIRST_RUN_GUIDE_REVISION}. Consulte assistant-first-run para o checklist, fronteiras e recuperação por etapa.`], fields: [...fields.values()] };
}
export const ASSISTANT_FIRST_RUN_GUIDE_CONTENT_SHA256 = createHash("sha256")
  .update(JSON.stringify(ASSISTANT_FIRST_RUN_GUIDE_PAGE_INPUT)).digest("hex");
