import type { AppConfigurationGuideField } from './app-configuration-guide.js';

/** Focused page revision; the global guide version remains Root-owned. Static documentation, not a probe. */
export const ENGINE_READINESS_GUIDE_REVISION = 'engine-readiness-r1';
type Update = Partial<Omit<AppConfigurationGuideField, 'id'>>;
const queryState = 'Consulta da base atual: não consultada, consultando, catálogo lido ou consulta falhou com código seguro. Falha, timeout, cancelamento, catálogo vazio ou engine ausente da resposta não confirmam CLI ausente. Não encontrada exige installed:false explícito de um catálogo válido; available:true/adapterSupported não falso informa Encontrada · login não confirmado. A UI não consulta conta, assinatura ou authfiles. Consulta falha retira a certeza do catálogo anterior; mostra estado não informado e o motivo seguro em settings.engines.lookup-error, junto de Atualizar estado. A identidade e geração da conexão invalidam respostas tardias e dados da base anterior.';
const queryRecovery = 'Atualizar estado e Tentar de novo fazem novas leituras GET na mesma conexão; não instalam CLI, não trocam executable/default/modelo, não autenticam, não reiniciam o host e não iniciam inferência. O catálogo SDK tem timeout de15s e ignora cache HTTP local; o host pode conservar seu próprio snapshot por30s. Cancelamento volta a não consultado. Falha mantém estado desconhecido; só uma resposta válida confirma ausência. Não reenvie mensagens ou ações para testar disponibilidade. Trocar a base limpa a observação; um resultado da base antiga não pode reparentear Groups ou voz.';
export const ENGINE_READINESS_GUIDE_OVERLAYS: readonly {
  pageID: string; fields: Readonly<Record<string, Update>>;
}[] = [
  { pageID: 'settings-general', fields: {
    readiness: { purpose: 'Distinguir consulta de catálogo, disponibilidade anunciada, roteamento, login e agente sem declarar ausência por falha de leitura.', read: queryState + ' Um catálogo atual pode substituir engine_unavailable de turno anterior; falha de turno posterior e authentication_required conservam sua evidência própria. Modelo disponível para chat não prova suporte a native voice V3: são contratos separados.', change: 'Somente consulta e orientação. Nenhuma configuração é alterada por esta linha.', approval: 'Leitura não concede ferramenta, conta, audiência ou permissão.', result: 'Fatos da base consultada e estados desconhecidos explícitos; sem prova de inferência.', recovery: queryRecovery, availability: 'read_only', readOperation: 'dexter.harness.models', changeOperation: null },
    'retry-host': { purpose: 'Reler a saúde, o catálogo de engines e as projeções da base atual.', scope: 'cliente e base capturada na conexão atual', read: queryState, change: 'O botão existente Tentar de novo chama refresh, que relê GET /health e GET /v1/engines/catalog antes das listas e de dispositivos. Erro de uma lista não transforma catálogo válido em engine ausente.', approval: 'Ação owner na UI; leitura sem aprovação de efeito. Não há handler para bots clicarem no botão.', result: 'Novo resultado da consulta e erro seguro separado. Não confirma conta, assinatura ou prontidão para áudio.', recovery: queryRecovery, availability: 'ui_only', readOperation: null, changeOperation: null },
  } },
  { pageID: 'settings-models', fields: {
    'engine-readiness': { read: queryState + ' Linhas settings.engines.state.<engine>; detalhes settings.engines.details preservam installed/adapterSupported/available, versão/modelos do catálogo. Login sempre não confirmado; Codex0.141 pode anunciar chat enquanto native voice V3 está unsupported.', change: 'Somente leitura da disponibilidade anunciada. Escolha e ativação continuam nos controles humanos próprios.', approval: 'Leitura não concede inferência, MCP, ferramentas, conta ou acesso a outros bots.', result: 'Estado simples da consulta atual, incluindo consultando e desconhecido por falha, separado de ausência confirmada e de suporte a voz.', recovery: queryRecovery, availability: 'read_only', readOperation: 'dexter.harness.models', changeOperation: null },
    'engine-readiness-refresh': { read: queryState, change: 'Atualizar estado (settings.engines.refresh) relê GET /health e GET /v1/engines/catalog. É leitura owner na UI; não altera CLI salvo, login, default, engine de bot ou sessão.', approval: 'Sem aprovação de efeito para esta leitura owner. Não há handler para bot operar a UI; dexter.harness.models é leitura real quando anunciado pelo harness.', result: 'Atualiza as linhas apenas se a mesma conexão/identidade ainda é atual. Erro seguro é mostrado sem prosa bruta do provider.', recovery: queryRecovery, availability: 'ui_only', readOperation: null, changeOperation: null },
  } },
];
export const ENGINE_READINESS_GUIDE_SOURCE_PATHS = [
  'apps/apple/Sources/DexterAppCore/DexterAppModel.swift',
  'apps/apple/Sources/DexterAppCore/OnboardingReadiness.swift',
  'apps/apple/Sources/DexterAppCore/FriendlyStatePresentation.swift',
  'apps/apple/Sources/DexterHostClient/HostClient.swift',
  'packages/context/src/engine-readiness-configuration-guide.ts',
] as const;
