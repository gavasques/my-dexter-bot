import type { AppConfigurationGuidePage } from "./app-configuration-guide.js";

/** Static progressive documentation. This is not executable authority. */
export const deviceRoutesGuidePage: Pick<AppConfigurationGuidePage,"id"|"title"|"scope"|"availability"|"sourcePaths"|"notes"|"fields"> = {
  "id": "device-routes",
  "title": "Operações do Mac na conversa",
  "scope": "owner local: bot × dispositivo × operação",
  "availability": "human_only",
  "sourcePaths": [
    "apps/apple/SharedApp/Sources/DeviceConversationRoutesView.swift",
    "apps/apple/Sources/DexterAppCore/DeviceConversationRoutesSession.swift",
    "apps/apple/Sources/DexterHostClient/DeviceConversationRoutes.swift",
    "packages/cli/src/device-turn-surface.ts",
    "packages/cli/src/local-device-route-port.ts",
    "packages/cli/src/host-services.ts",
    "packages/hub/src/http-routes.ts",
    "packages/operations/src/exact.ts"
  ],
  "notes": [
    "O diagnóstico first-party dexter.harness.mac.setup.status consulta somente a projeção de setup do próprio bot. Publicação, grant válido e operações admitidas neste turno são diferentes; TCC, helper, política local e sessão física não observados ficam unknown. O encaminhamento mac.setup.request abre somente o fluxo humano contextual, sem publicar rota ou conceder acesso.",
    "Após publicação humana, novos aliases de dispositivo precisam de uma lease/turno novo. Não altere o catálogo congelado da conversa nem prometa retomada automática só pelo receipt de navegação. O fluxo pode oferecer uma continuação humana explícita; documente apenas o controle realmente implementado.",
    "Limites: IDs de até 128 caracteres, até 256 rotas por padrão (teto configurável 1024), até 10000 receipts sem descarte automático. Ao esgotar, recusa antes da alteração; operador deve planejar manutenção apropriada. Rota publica metadados, não concede grants. Execução exige grant vigente, pin/schema atuais, presença TLS autenticada e políticas locais. Arquivos selecionados, CUA, TCC, calibração, superfície consentida, indicador, Parar e takeover são gates separados.",
    "API owner-loopback real: GET /v1/device-routes?botId; PATCH /v1/device-routes; GET /v1/device-routes/receipts/:requestId. Não está registrada no tools/list das engines nem no router paired-client.",
    "PATCH corpo exato expectedHostId/clientRequestId/botId/deviceId/tool/expectedRevision:null|N/status:active|suspended|revoked. SHA256 canonical request; CAS; rota + receipt atômicos no device-tools.sqlite schema3. Schema2 migra em transação e continua aceito em backup/inspeção.",
    "Retry idêntico retorna receipt original; ID com corpo diferente conflita. GET do receipt recupera lost ACK após mudanças posteriores/restart, sem nova mutação. Revogada não volta a active. Pin/schema trocados demandam grant com revisão estritamente maior que os anteriores.",
    "Sessão da UI é retida ao reabrir a folha no mesmo processo/base; mudança de base/generation congela a sessão. Após encerramento completo do cliente, receipt e ID continuam no host; não se presume que a expectativa da UI sobreviveu. Não reenviar alteração incerta com ID novo.",
    "Processo iniciado ou pareamento não prova presença online atual; lastSeenAt histórico não é TTL autenticada. Unknown de escrita nunca autoriza replay do efeito; parar processo próprio não comprova rollback."
  ],
  "fields": [
    {
      "id":"device.routes.renew-grant", "title":"Renovar permissão com aprovação", "purpose":"Emitir grant ask com revisão nova após troca de pin/schema ou grant ausente.",
      "scope":"owner local bot × dispositivo × operação", "read":"needsFreshGrant da rota e revisão do grant corrente; não supor permissão pela rota.",
      "change":"Clique humano escreve ask via PUT /v1/device-grants com expectedRevision lida. Mesmo ask anterior exige escrita explícita para elevar revisão. Nunca allow implícito.",
      "approval":"Clique explícito do proprietário; engine não renova seu próprio grant.", "result":"Grant ask com revisão suficiente; ação concreta continua exigindo autorização aplicável e gates locais.",
      "recovery":"Conflito/lost ACK usa recuperação do editor de grants; rota e grant têm receipts/expectativas distintos. Verificar o grant antes de nova alteração.",
      "availability":"human_only", "readOperation":null, "changeOperation":null
    },

    {
      "id": "device.routes.operation",
      "title": "Operação",
      "purpose": "Escolher a operação deste Mac para o bot selecionado.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "Lista de operações do host + GET routes do bot.",
      "change": "Selecionar na UI. A seleção não escreve rota/grant.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Alvo explícito bot/device/tool.",
      "recovery": "Se base/bot/operação mudar, recarregar antes de publicar.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "device.routes.status",
      "title": "Estado e revisão",
      "purpose": "Distinguir publicada, suspensa, revogada e exige grant novo.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "GET /v1/device-routes?botId. needsFreshGrant é diagnóstico, não aprovação.",
      "change": "Somente leitura.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Estado atual e revisão CAS, sem promessa de execução/offline.",
      "recovery": "Verificar estado; estado de lista sozinho não confirma uma mutação incerta.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "device.routes.publish",
      "title": "Publicar na conversa",
      "purpose": "Associar operação pareada ao bot para ferramentas da conversa.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "Rota atual, pin/schema e revisão.",
      "change": "Clique gera ID estável e PATCH owner-local status active com revisão lida.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Receipt original e nova revisão; grant permanece separado.",
      "recovery": "Conflito relê sem reenviar. Lost ACK mantém requestId; Verificar lê receipt. Revogada recusa reativação.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "device.routes.suspend",
      "title": "Suspender",
      "purpose": "Retirar a operação das novas admissões do bot.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "Rota ativa e revisão.",
      "change": "Clique PATCH status suspended com CAS.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Receipt durável; ações pendentes ficam bloqueadas e guards de voo recusam rota antiga. Não desfaz efeitos.",
      "recovery": "Confirme receipt; para retomar publique com a nova revisão e confira grant/pin/schema.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "device.routes.check",
      "title": "Verificar estado",
      "purpose": "Resolver resultado incerto pela intenção original.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "Com pendência, GET receipts/:requestId; sem pendência, GET routes.",
      "change": "Somente GET; nunca PATCH automático.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Receipt original validado por host/owner/body/hash e depois lista atual.",
      "recovery": "404 ou falha não apaga pendência nem prova que uma requisição ainda em voo não aplicará. Preserve ID, não invente sucesso e não crie nova intenção.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "device.routes.request-id",
      "title": "ID da alteração sem confirmação",
      "purpose": "Permitir recuperação exata do receipt.",
      "scope": "owner local: bot × dispositivo × operação",
      "read": "ID público da intenção, sem secrets.",
      "change": "Seleção/cópia humana; não altera host.",
      "approval": "Clique explícito do proprietário local. Nunca engine, paired-client ou self-grant.",
      "result": "Identidade estável da intenção original.",
      "recovery": "Operador consulta receipt no owner local; nunca troca ID para reenviar uma alteração incerta.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  ]
};
