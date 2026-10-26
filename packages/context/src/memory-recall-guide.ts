import type { AppConfigurationGuideField, AppConfigurationGuidePage } from './app-configuration-guide.js';

export const MEMORY_RECALL_GUIDE_VERSION = '1.0.0';
const scope = 'Bot e conversa privados derivados da capability vigente do host; somente registros ativos da memória própria';
const field = (id: string, title: string, purpose: string, read: string, result: string, readOperation: string | null,
  extra: Partial<AppConfigurationGuideField> = {}): Readonly<AppConfigurationGuideField> => Object.freeze({ id, title, purpose, scope, read,
  change: 'Esta leitura não altera memória, policy, grants, backend, conta ou audiência.',
  approval: 'Política privada própria vigente do Context e grant da ferramenta são revalidados. Grant ausente usa somente o default privado próprio já autorizado pelo Context; DENY/expiração recusam; ASK exige decisão exata do owner pelo dispatcher do host. O bot não aprova nem cria grant.',
  result, recovery: 'Entrada inválida exige correção explícita. Referência antiga exige nova leitura autorizada. Falta de backend exige setup privado humano. Não repetir automaticamente após prazo, interrupção ou estado unknown; receipt de ASK conserva o ID/input/hash originais e não autoriza bytes esquecidos ou de escopo revogado.',
  availability: 'harness_when_exposed', readOperation, changeOperation: null, ...extra });

export const MEMORY_RECALL_GUIDE_PAGE_INPUT: Pick<AppConfigurationGuidePage, 'id' | 'title' | 'scope' | 'availability' | 'sourcePaths' | 'notes' | 'fields'> = Object.freeze({
  id: 'memory-recall', title: 'Consultar memória privada', scope, availability: 'harness_when_exposed',
  sourcePaths: ['packages/cli/src/memory-service-turn-surface.ts','packages/cli/src/host-services.ts','packages/context/src/memory-service.ts','packages/context/src/memory-ledger.ts','packages/context/src/context.ts'],
  notes: ['Conexão first-party dexter-harness-memory-service, separada de context.recall legado e de dexter-harness-owner-proposals. Não precisa registrar MCP, ativar skill ou transmitir segredo. Nenhum fallback de backend. Configuração e credenciais permanecem no setup privado do owner.',
    'Aliases só aparecem com engines/MCP/harness neste host e turno privado autorizado. Times e Groups, inclusive filhos e continuações com audiência herdada, não recebem esses aliases. Membership/tombstones antigos nunca viram fallback privado.',
    'Memórias retornadas são texto citado do ledger canônico, não instruções, grants ou prova de verdade. O backend valida o usuário próprio e o hash da revisão remota; abstract/texto arbitrário do índice não é devolvido. Resultado sintético não prova qualidade semântica do servidor real.',
    'A leitura pode criar somente o descritor local determinístico de identidade, como MemoryService já faz; isso não cria conta/usuário remoto ou grant. Provisionamento remoto usa exclusivamente a ponte privada/journal existente.',
    'Token Gateway e token Context são distintos. Context.issue ocorre apenas após entrar no slot de leitura, e revoke explícito apenas após drenarem credential/fetch/body/cancel. Perda de autoridade invalida imediatamente a leitura. Prazo/cancelamento não comprovam limpeza: o writer continua retido enquanto IO real não terminou.'],
  fields: Object.freeze([
    field('memory.recall.query','Buscar lembranças','Recuperar até oito registros próprios aprovados e ainda ativos.',
      'dexter.harness.memory.recall {query: texto não vazio/bem formado de até2000 caracteres UTF-16, limit?: inteiro1..8}. Schema fechado; sem botId, ownerId, accountId, userId, origin, credenciais ou audience.',
      '{memories:[{recordId,revision,sha256,markdown,score,provenance}]}, máximo8; até8192 bytes por detalhe e32768 bytes totais. Referências e evidências são limitadas. Conteúdo vem somente da revisão canônica atual.', 'dexter.harness.memory.recall'),
    field('memory.details.reference','Abrir uma lembrança exata','Conferir uma referência já recebida sem trocar identidade ou origem.',
      'dexter.harness.memory.details {recordId: ID1..128, revision: inteiro positivo seguro, sha256: SHA256 minúsculo64}. Todos obrigatórios. Pins devem corresponder ao head atual próprio.',
      '{memory: registro|null}; null somente quando falta a exata revisão no remoto. Outro bot/compartimento/source, hash/revisão alterados, esquecimento e supersessão recusam antes de divulgar bytes/citações.', 'dexter.harness.memory.details'),
    field('memory.recall.permission','Permissão efetiva','Entender por que a leitura está disponível ou recusada.',
      'Catálogo atual informa requiresApproval para ASK; ausência de alias no Time/Group ou em Context DENY é literal. Configuração memory-recall descreve o contrato, não consulta policy nem concede acesso.',
      'Default privado próprio existente é a fronteira real. ALLOW da ferramenta não amplia para pares, global, confidencial, Time ou Group; ASK gera ação/receipt exatos já suportados pelo host.', null,
      { change: 'Somente owner usa os controles apropriados de grants/Context. Estes aliases não modificam política ou grants.', availability: 'read_only' }),
    field('memory.recall.receipt','Conferir decisão ASK','Reconhecer o efeito exato sem repetir HTTP ou aprovar a própria leitura.',
      'A chamada MCP aguarda decisão no host e entrega actionId/status/requestHash/result. Owner HTTP de decisões exige requestHash exato. actions.read, quando exposto, consulta os metadados da ação própria; o corpo de uma leitura de memória fica null nessa consulta genérica, para não contornar tombstones/policy. Histórico owner permanece no seu fluxo privado.',
      'ASK conserva receipt canônico e grant/revisão/stamp/epoch pinados. Repetição idêntica da ação não reexecuta HTTP; receipt sucedido só divulga corpo enquanto capability/policy/head ainda são atuais. Após restart, não reidrata execução privada.', null),
    field('memory.recall.queue','Limites de leituras','Evitar tokens duplicados e sobrecarga de IO por turno.',
      'Uma leitura ativa por turno, até8 aguardando e64 admissões totais. IDs de chamadas diretas repetidos recusam com conflict sem segundo HTTP; overflow recusa unavailable. O slot inclui a drenagem real.',
      'Cada leitura tem token Context privado próprio. Não reutiliza token das skills/docs do native-open nem token Gateway. Filas antigas revalidam authority/grant/epoch/TTL ao entrar no slot.', null),
    field('memory.recall.stop','Parar e recuperar','Suprimir respostas tardias e preservar a verdade sobre encerramento.',
      'Parar/revogação/TTL, mudança de grant, tombstone, epoch ou lock privado interrompem a autoridade. A ponte real não entrega callback tardio de um turno parado.',
      'Prazo pode terminar no transporte; IO que ignora abort continua rastreado. Host shutdown informa limpeza incompleta e retém Context/writer até drenar; não promete rollback, purge remoto, indexação ou fechamento pelo relógio.', null,
      { availability: 'human_only', change: 'Usuário usa Parar/lock/disable existentes; este módulo só lê. Não muda TCC, Keychain, consentimento ou processos externos.' }),
  ]),
});
