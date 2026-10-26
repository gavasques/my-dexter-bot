import type { AppConfigurationGuideField, AppConfigurationGuidePage } from "./app-configuration-guide.js";

type PageInput=Pick<AppConfigurationGuidePage,"id"|"title"|"scope"|"availability"|"sourcePaths"|"notes"|"fields">;

/** First-party static documentation composed from frozen author modules, never executable authority. */
export const COMPLETION_ADDITIONAL_PAGES:readonly PageInput[] = [
  {
    "id": "memory-backend",
    "title": "Memória: servidor OpenViking e custódia privada no Mac",
    "scope": "Configuração global do host proprietário, com usuários e espaços próprios por bot; administração local humana",
    "availability": "human_only",
    "sourcePaths": [
      "apps/apple/Sources/DexterHostClient/MemoryBackend.swift",
      "apps/apple/Sources/DexterAppCore/MemoryBackendPrivateCustody.swift",
      "apps/apple/Sources/DexterAppCore/MemoryBackendSettingsEditor.swift",
      "apps/apple/Sources/DexterAppCore/LocalHostProcess.swift",
      "apps/apple/SharedApp/Sources/MemoryBackendSettingsView.swift",
      "apps/apple/SharedApp/Sources/SettingsView.swift",
      "apps/apple/KeychainRuntime/Sources/DexterKeychainRuntime/RuntimeSigningIdentity.swift"
    ],
    "notes": [
      "Ajustes › Integrações › Memória · OpenViking. Usa servidor externo existente; não instala, inicia ou encerra servidor OpenViking. O endpoint não é modelo de engine nem altera quotas de captura.",
      "Owner-loopback somente; pareados e engines não configuram sua própria autoridade. Documentação não concede acesso, grants ou autoaprovação. O bot pode consultar este manual sob demanda e orientar o proprietário; não há ferramenta de mutação administrativa no harness.",
      "HTTP transmite somente metadados. Chave administrativa é digitada em SecureField local, removida do campo ao confirmar e enviada uma vez pelo Pipe herdado do processo que este app iniciou. Sem chat, argv, env, clipboard, logs ou corpo HTTP de secret. 1Password opcional ainda não integrado neste controle.",
      "Wrapping de 32 bytes exige criação humana explícita, serviço dedicado por host+owner+SHA da origem, Data Protection Keychain não sincronizável, WhenUnlockedThisDeviceOnly. Status consulta somente atributos da entrada exata, sem enumeração/valor/interação; desbloquear não cria, gira, apaga ou usa fallback legado. O app precisa de assinatura/identidade apta ao Keychain; uma build ad-hoc sem identidade compatível não prova funcionamento.",
      "Host recebe admin somente no create; guarda ciphertext fora do banco de conteúdo. Unlock envia wrapping e papel administrativo, sem admin. Lock não contém secret. Buffers próprios são limpos; Swift/Foundation/Security podem ter cópias internas e não se promete zeroização de toda a memória do SO.",
      "Antes de ler valores privados, o editor relê /health host+owner e status de origem/revisão habilitada, verifica a seleção e a vida exata do child. ACK fixo exige requestId/hostID/campos fechados. Timeout/cancelamento/saída após envio é unknown; nenhuma criação privada é repetida automaticamente.",
      "A expectativa pública de settings/request fica em memória enquanto o app vive e atravessa fechar/reabrir Ajustes. Encerrar o app perde essa expectativa; o receipt do host permanece. Não inferir falha nem repetir criação após reinício. Bloquear é uma nova ação explícita para cortar a autoridade incerta.",
      "Configuração ou ACK ready significa custódia configurada, não autenticação comprovada, provisionamento real de conta nem busca semântica. semanticRecall continua unproven. Provas sintéticas usam namespace próprio e wrapping em memória; Keychain real e conta real são provas separadas do operador.",
      "SigningRuntime preflight lê somente identidade pública do próprio executable, exige bundle/code identity e Team de assinatura autorizada; cada query/add inclui grupo exato derivado da assinatura. Ad-hoc/local App-ID claims não são fallback. Main app precisa de contexto próprio, independente do helper EC. Não há wrapping32 persistido provado neste QA."
    ],
    "fields": [
      {
        "id": "settings.memory-backend.scope",
        "title": "Escopo do servidor",
        "purpose": "Explicar impacto global e isolamento por bot.",
        "scope": "host proprietário",
        "read": "Texto desta seção e status.scope=host_owned_account_per_bot_users.",
        "change": "Sem alteração.",
        "approval": "Leitura não concede acesso.",
        "result": "Configuração do host distinguida dos grants e namespaces de cada bot.",
        "recovery": "Reabrir na base correta se a seleção mudou.",
        "availability": "read_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.availability",
        "title": "Disponibilidade local",
        "purpose": "Informar quando o fluxo privado não pertence a este app.",
        "scope": "seleção e child proprietário",
        "read": "Ausência do editor, disponibilidade local e estado de conexão.",
        "change": "Selecionar a base local iniciada por este app; abrir Ajustes não inicia host.",
        "approval": "Ação humana; outro listener não é adotado.",
        "result": "Editor disponível somente na conexão própria.",
        "recovery": "Verificar conexão e reabrir a seção; nunca mover credentials para outra base.",
        "availability": "human_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.origin",
        "title": "Endereço do servidor",
        "purpose": "Escolher origem explícita antes de entrega privada.",
        "scope": "rascunho de metadados do host",
        "read": "settings.origin, revisão e rascunho.",
        "change": "Digitar origem HTTPS sem caminho/query/credentials ou HTTP IP loopback com porta explícita. Edição só vira configuração em Salvar.",
        "approval": "Escolha humana owner-local.",
        "result": "Rascunho; sem entrega de secret ou instalação.",
        "recovery": "Origem inválida desabilita Salvar. Mudança de origem confirmada requer reinício/drain do host.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": "PATCH owner-local /v1/memory-backend/settings"
      },
      {
        "id": "settings.memory-backend.enabled",
        "title": "Usar este servidor para memória",
        "purpose": "Habilitar/desabilitar autoridade do backend escolhido.",
        "scope": "host global; não concede grants por bot",
        "read": "settings.enabled e estado disabled/private_unlock_required/configured_unverified.",
        "change": "Marcar rascunho e Salvar com revisão esperada.",
        "approval": "Gesto humano owner-local; engine não auto-habilita.",
        "result": "Desativar confirmado corta autoridade imediatamente, mantendo metadados/custódia. Serviço externo continua administrado pelo usuário.",
        "recovery": "Receipt original confirma resultado; reativação exige conexão privada conforme estado.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": "PATCH owner-local /v1/memory-backend/settings"
      },
      {
        "id": "settings.memory-backend.save",
        "title": "Salvar configuração",
        "purpose": "Confirmar origem e preferência sem transmitir secret.",
        "scope": "hostId+ownerId+clientRequestId+expectedRevision capturados",
        "read": "Revisão inicial 0 e GET receipt original.",
        "change": "PATCH estrito {expectedHostId,clientRequestId,expectedRevision,origin,enabled}; nenhuma chave extra.",
        "approval": "Botão humano owner-loopback; pareados recusados.",
        "result": "{receipt,status}; receipt atômico com host/owner/hash/previousRevision/settings+1/committedAt. Mesmo ID e input deduplica; input diferente conflita.",
        "recovery": "ACK perdido conserva input/ID e bloqueia novo PATCH. Verificar estado faz GET /receipts/:id -> {receipt:...|null} e valida hash/escopo/revisão. Null não é retry automático; conflito exige releitura.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/receipts/:requestId",
        "changeOperation": "PATCH owner-local /v1/memory-backend/settings"
      },
      {
        "id": "settings.memory-backend.verify",
        "title": "Verificar estado",
        "purpose": "Reconciliar resultado sem repetir alteração ou entrega privada.",
        "scope": "original host/owner/request/revisão",
        "read": "/health + status + receipt original de settings; privateRequest para pedido privado.",
        "change": "Somente GET. Nenhum PATCH/create/unlock é reenviado.",
        "approval": "Consulta humana limitada; não cria grant.",
        "result": "Receipt settings ou request privado id/op/revisão/estado exatos confirma o resultado. Estado parecido/ID diferente não resolve unknown.",
        "recovery": "Sem receipt/request correspondente conserva incerteza; Bloquear pode cortar a autoridade privada incerta por ação nova explícita.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status e /receipts/:requestId",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.state",
        "title": "Estado do backend",
        "purpose": "Distinguir configuração, bloqueio, reinício e prova semântica.",
        "scope": "metadados confirmados do host",
        "read": "disabled, private_unlock_required, configured_unverified, restart_required ou configured_externally; generation/privateRequest; semanticRecall=unproven.",
        "change": "Sem alteração neste rótulo.",
        "approval": "Leitura não comprova autenticação ou resultado semântico.",
        "result": "Externamente configurado indisponibiliza controles de administração deste fluxo.",
        "recovery": "Verificar estado na base original; seguir resultado confirmado, não o rascunho.",
        "availability": "read_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.wrapping-status",
        "title": "Chave privada neste Mac",
        "purpose": "Mostrar existência da entrada exata sem revelar o valor.",
        "scope": "serviço dedicado host+owner+originSHA",
        "read": "missing/configured/unavailable/signingIdentityUnavailable; atributos da entrada exata sem valor. Assinatura autorizada necessária é estado próprio, não chave ausente.",
        "change": "Sem alteração neste rótulo; criação somente no botão explícito.",
        "approval": "Consulta de metadados sem interação do Keychain.",
        "result": "Existência local; não confirma decriptação nem servidor.",
        "recovery": "Sem contexto de assinatura autorizado, status recusa antes da query; Security ainda decide entitlement real. Root fornece assinatura/perfil apropriados; sem enumeração, fake Team, outro grupo, rotação ou login-Keychain fallback.",
        "availability": "read_only",
        "readOperation": "NativeScopedWrappingKeychain.status(scope:)",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.administrative-role",
        "title": "Permissão da chave administrativa",
        "purpose": "Declarar ROOT ou administrador do próprio workspace.",
        "scope": "pedido privado humano da origem confirmada",
        "read": "Seleção local root/workspace_admin.",
        "change": "Escolher o papel real; capturado no create/unlock, sem token em UI pública.",
        "approval": "Escolha humana; seleção não cria privilégios.",
        "result": "Host valida o papel ao usar a conta. ROOT não é usuário de leitura de dados de bot.",
        "recovery": "Recusa exige conferir papel/conta; não ampliar para ROOT por inferência.",
        "availability": "human_only",
        "readOperation": null,
        "changeOperation": "Pipe privado create/unlock"
      },
      {
        "id": "settings.memory-backend.administrative-key",
        "title": "Chave administrativa para a primeira conexão",
        "purpose": "Receber secret somente no app.",
        "scope": "SecureField transitório da origem/host/owner selecionados",
        "read": "Sem operação de leitura pelo bot; não retorna valor.",
        "change": "Digitar diretamente no app, 1..4096 bytes UTF-8 sem NUL; ao confirmar o campo é limpo antes da Task. Desaparecer/mudar escopo também limpa.",
        "approval": "Entrada e confirmação humanas privadas. Não pedir no chat.",
        "result": "Buffer transitório entregue uma vez ao frame create; sem HTTP/admin defaults/argv/env/clipboard/logs.",
        "recovery": "Recusado/unknown não repete secret automaticamente. Verificar estado primeiro; não usar outro host ou chave legado.",
        "availability": "human_only",
        "readOperation": null,
        "changeOperation": "SecureField local -> OWN inherited Pipe"
      },
      {
        "id": "settings.memory-backend.create",
        "title": "Criar custódia e conectar",
        "purpose": "Criar proteção local e custódia cifrada inicial da origem escolhida.",
        "scope": "host+owner+origem/revisão e vida exata do child próprio",
        "read": "Preflight /health + status antes de Keychain valor; metadados de wrapping.",
        "change": "Se falta wrapping, cria explicitamente 32B não sincronizáveis. Se já existe, carrega somente entrada exata, sem recriar. Frame dexter.memory-backend-key/1 operation=create inclui wrappingBase64/admin/role, requestId lowerUUID, hostID, origin e expectedRevision.",
        "approval": "Botão humano explícito; exige host próprio atual e settings enabled salvos. Sem auto-grant.",
        "result": "ACK ready confirma custódia em memória; admin cifrado fora do content DB. Não provisiona conta por inferência nem comprova busca.",
        "recovery": "Timeout/cancelamento/saída é unknown: GET status original, sem novo create. Keychain e arquivo cifrado são fronteiras distintas; não apagar/rotacionar wrapping após incerteza. Recusa pode deixar wrapping já criado.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": "OWN inherited Pipe dexter.memory-backend-key/1 create"
      },
      {
        "id": "settings.memory-backend.unlock",
        "title": "Desbloquear conexão",
        "purpose": "Reabrir custódia cifrada da mesma origem sem entrada de admin.",
        "scope": "Keychain exato e child proprietário",
        "read": "Preflight de host/owner/origem/revisão e existência da chave.",
        "change": "Carrega wrapping exato e envia frame unlock com wrappingBase64 e role; admin ausente. Nunca cria chave neste botão.",
        "approval": "Botão humano explícito; origem habilitada salva e estado private_unlock_required.",
        "result": "ACK ready; configured_unverified. Após restart wrapping/ciphertext continuam, conexão em memória deve ser explicitamente desbloqueada.",
        "recovery": "Chave ausente/incompatível recusa, sem enumeração/fallback. ACK incerto usa GET original e não reenvia automaticamente.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": "OWN inherited Pipe dexter.memory-backend-key/1 unlock"
      },
      {
        "id": "settings.memory-backend.lock",
        "title": "Bloquear conexão",
        "purpose": "Cortar autoridade privada e fechar conexão administrada.",
        "scope": "host/owner/origem/revisão atual",
        "read": "ACK locked e status/privateRequest correspondente.",
        "change": "Novo frame lock fechado sem wrapping/admin/role. Permitido explicitamente também para superseder pedido incerto.",
        "approval": "Botão humano; só processo próprio.",
        "result": "Custódia bloqueada em memória; Keychain/ciphertext preservados para novo unlock. Não encerra servidor externo nem promete rollback.",
        "recovery": "ACK incerto faz GET somente. Após confirmação, novo desbloqueio humano usa mesma chave exata.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": "OWN inherited Pipe dexter.memory-backend-key/1 lock"
      },
      {
        "id": "settings.memory-backend.restart-required",
        "title": "Reinício do host necessário",
        "purpose": "Explicar mudança de origem e drenagem do writer.",
        "scope": "host local próprio",
        "read": "status.state=restart_required depois de mudar origem já vinculada.",
        "change": "Não há botão de reinício neste controle. Concluir operações próprias e reiniciar o host pelo fluxo local apropriado; depois desbloquear a nova origem.",
        "approval": "Ação humana pelo fluxo de lifecycle do host; nenhuma parada de processo externo.",
        "result": "Nova vida do host pode vincular origem nova; autoridade antiga já foi cortada.",
        "recovery": "Operações em andamento/unknown não são repetidas. Não reutilizar wrapping de outra origem; cada escopo tem entrada própria.",
        "availability": "human_only",
        "readOperation": "GET owner-local /v1/memory-backend/status",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.notice",
        "title": "Resultado da operação",
        "purpose": "Mostrar salvamento, recusa ou incerteza em frase simples.",
        "scope": "estado confirmado/intenção original deste editor",
        "read": "Aviso visible e pendingSettings/pendingPrivate não secretos.",
        "change": "Sem alteração pelo rótulo; Verificar estado ou Bloquear são ações separadas.",
        "approval": "Rótulo não aprova operação.",
        "result": "Sem conexão confirmada por rascunho ou ACK de outro host/lifetime.",
        "recovery": "Mudança de base invalida callbacks. Reabrir conserva intenção enquanto app vive; encerramento não cria retry automático.",
        "availability": "read_only",
        "readOperation": null,
        "changeOperation": null
      }
    ]
  },
  {
    "id": "native-keychain-signing",
    "title": "Mac: identidade de assinatura, Keychain e auxiliares como apps",
    "scope": "Main app e processos auxiliares próprios; administração local humana",
    "availability": "human_only",
    "sourcePaths": [
      "apps/apple/KeychainRuntime/Sources/DexterKeychainRuntime/RuntimeSigningIdentity.swift",
      "apps/apple/DeviceIdentity/Sources/DexterDeviceIdentity/KeychainStorage.swift",
      "apps/apple/Sources/DexterAppCore/NativeHelperApplication.swift",
      "apps/apple/Sources/DexterAppCore/LocalMacAgentSetup.swift",
      "apps/apple/Sources/DexterAppCore/LocalMacAgentCuaSetup.swift",
      "apps/apple/Sources/DexterAppCore/LocalMacAgentPolicy.swift",
      "apps/apple/Sources/DexterAppCore/MemoryBackendPrivateCustody.swift",
      "scripts/package-native-helper-app.mjs",
      "scripts/stage-signed-native-helper-apps.mjs"
    ],
    "notes": [
      "Assinatura de pai não concede entitlements ao filho. Main app mantém wrapping; DexterDeviceIdentity.app mantém EC; DexterControl.app mantém janela/indicador/Parar. Cada processo exige sua identidade própria e grupo exato.",
      "Helpers completos foram construídos por Xcode com Apple Development autorizado, Team HWPF6ZVMK4 e perfis de desenvolvimento incorporados. IDs fixos com.dexter.device-identity.helper e com.dexter.control.helper; entitlements têm somente o grupo exato do respectivo helper. Perfis expiram em 2026-10-20 UTC; assinatura de desenvolvimento não equivale a distribuição notarizada.",
      "stage-signed-native-helper-apps.mjs valida assinatura, identidade Info/code, grupo, perfil vigente e conteúdo regular limitado. Copia app inteiro com assinatura/perfil, metadata v2 e automaticStart false. Não assina, instala, inicia, consulta Keychain ou concede TCC. Root compõe e assina o parent após staging; sem sobrescrita ou flatten para CLI.",
      "RuntimeSigningIdentity lê somente metadados públicos do próprio processo. Queries Keychain DP têm serviço/tag/label e grupo exatos; sem enumeração, fallback login-Keychain, geração durante load, rotação, deleção ou export privado.",
      "No namespace QA cb06a1b98b1e477f941e6b4acd01871d, NativeScopedWrappingKeychain real armazenou 32 bytes e dois processos separados load-only comprovaram AES-GCM. Grupo pertence ao QA assinado dedicado: não prova item pessoal/main-app, credenciais OpenViking ou backend ativo.",
      "Identidade EC agora usa custódia Secure Enclave (secure_enclave_data_protection_keychain_device_only), sem fallback de software. No QA assinado do namespace 9f99f1ced7849718d7883989e3d9058e, o helper de produção criou chave e certificado; outro processo carregou a mesma identidade (load-only), e houve TLS 1.3 com pino nos dois lados, sem retomada de sessão, em dois processos. O caminho do app cliente fez o mesmo com NativeHostTransport. Não houve prova com tela bloqueada.",
      "A proteção gravada é conferida por igualdade exata do SecAccessControl com WhenUnlockedThisDeviceOnly + privateKeyUsage. Itens Secure Enclave informam pdmn \"dk\" em qualquer classe, então kSecAttrAccessible não serve de prova. A validação reconheceu a classe correta e recusou outras classes, flags a mais e chave de software, na criação e em outro processo. Chave antiga de software ou parcial continua quarentenada: os atributos vivos dela nunca são lidos, e ela não é migrada, recriada nem apagada.",
      "Staging Swift preservou bytes, Info/profile e assinatura dos dois apps. CUA não foi iniciado, instalado, calibrado ou autorizado neste lab. Root mantém consentimento da superfície, TCC atual, calibration TTL e gate físico; assinatura não comprova presence, grants ou controle.",
      "Nenhum prompt privado OS/Xcode ficou pendente. O bloqueio EC é de política/atributo observado. Operador/Root resolve esse contrato explicitamente antes de declarar identidade ou TLS prontos. Configuração/admin de memória permanece em botão humano e Pipe privado, sem secrets HTTP/argv/env/chat.",
      "D2 implementado em fonte e QA próprio assinado. A integração e o release ficam com o Root. O produto instalado continua bloqueado até o Root compor, assinar e provar o release. Não existe nova opção para o usuário: é custódia interna.",
      "Root compôs a fonte Secure Enclave e os seis controles no candidato privado. A prova assinada continua pertencendo aos namespaces QA próprios; build/composição não certificam o app instalado. Ainda exigem empacotamento e assinatura finais, canal seguro configurado e qualificação no produto instalado. Não migrar, regenerar ou apagar identidades antigas."
    ],
    "fields": [
      {
        "id": "settings.mac-agent.prepare",
        "title": "Preparar configuração",
        "purpose": "Registrar trust público, política deny e preservar a identidade do helper .app.",
        "scope": "root privado próprio e instalação selecionada",
        "read": "Metadata mac-agent-helper/2 seleciona Helpers/DexterDeviceIdentity.app completo e executable interno. Assinatura/perfil/pins são públicos; readiness EC é separado.",
        "change": "Ação humana stages bundle completo em helper/DexterDeviceIdentity.app e grava executable interno na configuração privada. Targets existentes ou symlinks recusam; nada preexistente é sobrescrito.",
        "approval": "Botão humano após conferir host/pin. Preparação não cria identidade, grant ou pareamento.",
        "result": "Bundle assinado preservado e configuração deny; preparação não cria identidade, grant ou pareamento.",
        "recovery": "Target existente ou staging parcial recusa. Consultar pins/config no escopo original, sem sobrescrever. Root integra os helpers antes de assinar parent.",
        "availability": "human_only",
        "readOperation": "Owner UI / configuração privada selecionada",
        "changeOperation": "LocalMacAgentSetup.prepare"
      },
      {
        "id": "settings.mac-agent.create-identity",
        "title": "Criar identidade deste Mac",
        "purpose": "Criar identidade Secure Enclave permanente somente com assinatura autorizada e política conferida.",
        "scope": "instalação + namespace e grupo exatos do helper",
        "read": "load-only devolve missing, conflict ou falha fixa; fingerprint e certificado só depois de provision completo. No QA assinado: provision ok; outro processo carregou o mesmo fingerprint; TLS 1.3 com pino. Negativos: ad-hoc signingIdentityUnavailable, escopo invalidInput, parcial conflict, software ou proteção errada nonExportabilityUnconfirmed, certificado divergente conflict, fingerprint trocado conflict sem conexão.",
        "change": "Helper próprio exige assinatura, grupo exato, Secure Enclave e controle de acesso exato. provision explícito nunca substitui estado existente. Sem Secure Enclave: nonExportabilityUnconfirmed antes de tocar no Keychain.",
        "approval": "Confirmação humana. Não aceita documentos/engine como concessão de entitlement ou export policy.",
        "result": "Identidade com custódia de hardware comprovada em fonte e QA próprio, agora composta no candidato privado. O app instalado continua sem qualificação: depende de empacotamento/assinatura finais, canal seguro configurado e prova no produto instalado.",
        "recovery": "Não repetir provision nem regenerar namespace parcial. Estado antigo de software fica quarentenado para decisão humana exata. Sem delete, migração, fallback ou export.",
        "availability": "human_only",
        "readOperation": "Helper próprio load-only",
        "changeOperation": "Helper próprio provision explícito"
      },
      {
        "id": "settings.mac-cua.prepare",
        "title": "Preparar controle de tela",
        "purpose": "Preservar app auxiliar identificável sem conceder controle.",
        "scope": "agente próprio parado; bundle DexterControl.app",
        "read": "mac-cua-helper/2; bundle ID com.dexter.control.helper; pins completos do .app.",
        "change": "Stages app inteiro e usa executable Contents/MacOS/dexter-cua-helper. Não usa open/LaunchServices para perder o Pipe: daemon continua dono do processo e stdin.",
        "approval": "Gesto humano de configuração; TCC/calibração/superfície exigem decisões humanas independentes.",
        "result": "Bundle completo e assinatura preservados. CUA não foi iniciado nesta prova. TCC, consentimento e calibração TTL atuais continuam gates humanos independentes.",
        "recovery": "Staging/pins divergentes recusam. Root controla instalação/start e gestos humanos; não inferir TCC de assinatura ou presença de histórico.",
        "availability": "human_only",
        "readOperation": "Config/policy próprios e status CUA quando realmente exposto",
        "changeOperation": "LocalMacAgentCuaSetup.configure"
      },
      {
        "id": "settings.memory-backend.wrapping-status",
        "title": "Chave privada neste Mac",
        "purpose": "Distinguir item ausente de contexto de assinatura indisponível sem valor.",
        "scope": "host+owner+originSHA e grupo exato do main app",
        "read": "missing/configured/unavailable/signingIdentityUnavailable. Metadados públicos do próprio runtime e atributos exatos do item; sem valor/enumeração.",
        "change": "Sem alteração neste rótulo.",
        "approval": "Leitura não concede assinatura ou credencial. Estado mostra Assinatura autorizada necessária quando o gate falha.",
        "result": "Status sem valor distingue assinatura indisponível de item ausente. QA com assinatura legítima comprova configured após criação32; não representa namespace pessoal/main-app.",
        "recovery": "Root fornece identidade/perfil legitimamente autorizados. Não usar outro grupo, login-Keychain ou chave de outra origem.",
        "availability": "read_only",
        "readOperation": "NativeScopedWrappingKeychain.status(scope:)",
        "changeOperation": null
      },
      {
        "id": "settings.memory-backend.create",
        "title": "Criar custódia e conectar",
        "purpose": "Criar wrapping32 próprio sem contornar o gate de assinatura.",
        "scope": "main app, host/owner/origem/revisão e child próprios",
        "read": "Status signingIdentityUnavailable desabilita criação; metadados HTTP não são acesso Keychain.",
        "change": "Continua exigindo owner button, preflight e canal privado. Query/add/load têm grupo derivado da assinatura do main app; helper EC não compartilha privilégios por ser filho.",
        "approval": "Ação humana exata, depois de assinatura adequada; sem secret em chat/argv/env/log/HTTP.",
        "result": "Classe NativeScopedWrappingKeychain real comprovou wrapping de 32 bytes nonsync, grupo exato e reopen em 2 processos no QA dedicado. Fluxo pessoal/backend/admin permanece em owner button e Pipe privado.",
        "recovery": "Existing/unknown não autoriza create retry. Consultar status/receipt do escopo original, sem rekey/fallback/deleção. QA não provisiona credencial real de backend.",
        "availability": "human_only",
        "readOperation": "GET owner-local status + status Keychain sem valor",
        "changeOperation": "NativeScopedWrappingKeychain.create + OWN private Pipe"
      },
      {
        "id": "settings.mac-agent.start",
        "title": "Iniciar agente",
        "purpose": "Executar somente os auxiliares da configuração própria com bundles preservados.",
        "scope": "child do daemon proprietário",
        "read": "Config executable contém caminho interno de .app; assinatura privada e presença são fatos separados.",
        "change": "Inicia daemon próprio por ação humana. CUA mantém Pipe e janela própria; assinatura/TCC não são concedidos por start.",
        "approval": "Ação humana; identidade, host pins, grants, TCC e consentimento continuam independentes.",
        "result": "Assinatura dos helpers foi comprovada; start, presença, pairing e grants continuam distintos. Identidade EC deste QA ainda bloqueia readiness. Sem prova CUA/TLS persistido nesta entrega.",
        "recovery": "Falha não adota listener externo; assinatura unavailable é bloqueio fixo. Nova cópia/bundle não reaproveita permissão por inferência.",
        "availability": "human_only",
        "readOperation": "Estado do supervisor próprio",
        "changeOperation": "LocalMacAgentProcess.start"
      }
    ]
  },
  {
    "id": "conversation-appearance",
    "title": "Fundo das conversas",
    "scope": "Preferência visual local deste app Mac, compartilhada por conversas privadas e Grupos",
    "availability": "ui_only",
    "sourcePaths": [
      "apps/apple/SharedApp/Sources/ChatAppearance.swift",
      "apps/apple/Sources/DexterAppCore/ChatAppearancePreferences.swift",
      "apps/apple/Sources/DexterAppCore/ChatWallpaperRepository.swift",
      "apps/apple/SharedApp/Sources/SettingsView.swift",
      "apps/apple/SharedApp/Sources/ChatView.swift",
      "apps/apple/SharedApp/Sources/GroupConversationView.swift",
      "apps/apple/SharedApp/Sources/DexterRootView.swift"
    ],
    "notes": [
      "UserDefaults com.dexter.apple.chat-appearance.v1; configuração local deste app Mac, não é configuração do bot nem do host. Sem handler de mutação no harness.",
      "O fundo cobre a janela inteira: área da conversa, barras laterais e cabeçalho. Neutro restaura a aparência nativa do macOS. Presets: Azul-petróleo, Grafite, Ameixa, Floresta, Areia e Personalizado (duas cores e direção); Imagem usa foto local.",
      "Imagem local: arquivo regular, sem link, até 20 MB em PNG, JPG ou HEIC, uma única imagem estática e até 50 milhões de pixels na origem. O app guarda uma cópia privada reencodificada em JPG com no máximo 4096 px, sem metadados pessoais do EXIF nem GPS (JPEG pode conter dimensões e espaço de cor novos). O UserDefaults guarda só referência (UUID, hash e dimensões), nunca bytes nem caminho original. A escolha não concede acesso a arquivos e não vira ferramenta do harness.",
      "Remover imagem e Voltar ao padrão apagam somente a cópia própria verificada; o arquivo original nunca é alterado. Se a cópia não puder ser apagada, a aparência já salva é mantida e aparece aviso honesto.",
      "Opacidade do fundo: 0 a 100%. Opacidade das barras laterais: 25 a 100%. Desfoque da imagem: 0 a 100%, gravado como 0 a 24 px. Com 'Reduzir transparência' ativo no macOS, os sliders de opacidade e desfoque ficam desabilitados e o fundo usa cor sólida; presets e seleção de imagem continuam disponíveis.",
      "A opacidade zero oculta a arte sem trocar a aparência da janela durante o arraste; Neutro restaura o tema nativo. Barra lateral usa o vidro nativo com tinta; o inspetor e balões têm material próprio. A camada de proteção limita o contraste primário sobre gradientes e fotos. Aumentar contraste reforça os painéis; isso não certifica toda foto arbitrária.",
      "Falha/arquivo ausente conserva a preferência e avisa para escolher outra imagem. Uma queda entre gravar cópia e preferência pode deixar cópia privada órfã; não há varredura automática nem alegação de purga total. A proteção por descritor/UID/hash é consistência local, não isolamento de software com o mesmo usuário do SO."
    ],
    "fields": [
      {
        "id": "appearance.chat-background.preset",
        "title": "Fundo da conversa",
        "purpose": "Escolher um fundo para a janela: Neutro (padrão), Azul-petróleo, Grafite, Ameixa, Floresta, Areia, Personalizado ou Imagem.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Preferência local; a seleção aparece no traço e no estado acessível do botão. Rótulos admitem até duas linhas e a dica mostra o nome completo. IDs dos presets são preservados.",
        "change": "Clique o preset desejado; grava a escolha localmente. IDs appearance.chat-background.preset.<neutral|teal|graphite|plum|forest|sand|custom|image>. Imagem sem foto abre o seletor de arquivos. Personalizado expõe duas cores e direção; não concede acesso ao host ou aos bots.",
        "approval": "Nenhuma (preferência visual local).",
        "result": "O fundo cobre a janela inteira, incluindo barras e cabeçalho; o texto alterna claro/escuro para manter contraste. Com 'Reduzir transparência', usa cor sólida.",
        "recovery": "Voltar ao padrão.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.image.choose",
        "title": "Escolher ou trocar imagem",
        "purpose": "Escolher uma foto local como fundo da janela.",
        "scope": "Somente este app neste Mac; a cópia privada fica no Application Support deste app. Não vai para o host nem para bots.",
        "read": "Referência local (UUID, hash e dimensões) e aviso atual de importação, quando houver.",
        "change": "Abre o seletor de arquivos do macOS (arquivo regular sem link, PNG, JPG ou HEIC até 20 MB, uma imagem estática e até 50 milhões de pixels na origem). O app cria uma cópia JPG de até 4096 px sem metadados pessoais do EXIF nem GPS, grava a referência e só depois apaga a cópia anterior. Enquanto prepara, os controles ficam desabilitados. Fechar Ajustes cancela cooperativamente o preparo e impede salvar a escolha cancelada.",
        "approval": "Escolha humana no seletor do macOS. Escolher ou ler a imagem não concede acesso a arquivos, host ou bots.",
        "result": "Preset Imagem ativo; a foto cobre a janela inteira com o desfoque e a opacidade escolhidos.",
        "recovery": "Se a imagem exceder tamanho ou pixels, tiver várias imagens/animação, for link, ilegível ou não puder ser guardada, aparece aviso e a escolha anterior é mantida. Escolha uma imagem estática menor ou exporte uma cópia regular. Use Remover imagem para apagar a cópia atual.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.image.remove",
        "title": "Remover imagem",
        "purpose": "Apagar a imagem de fundo deste Mac.",
        "scope": "Somente este app neste Mac. A foto original, o host e os bots não são alterados.",
        "read": "Presença da referência local; o botão aparece somente quando há imagem.",
        "change": "Limpa a referência no UserDefaults, troca o preset Imagem por Neutro e apaga somente a cópia privada verificada (UUID, tamanho e SHA-256).",
        "approval": "Ação humana local. A foto original não é tocada e pode ser escolhida de novo.",
        "result": "Se o preset ativo era Imagem, volta para Neutro (aparência nativa). A cópia privada sai do disco quando a verificação passa.",
        "recovery": "Aviso honesto: a aparência já foi salva sem a imagem; se a cópia local não puder ser apagada, o app não tenta de novo automaticamente.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.top",
        "title": "Cor de cima (Personalizado)",
        "purpose": "Definir a primeira cor do degradê.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Preferência local.",
        "change": "Grava a cor localmente (sRGB).",
        "approval": "Nenhuma.",
        "result": "Atualiza o fundo e a prévia.",
        "recovery": "Voltar ao padrão.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.bottom",
        "title": "Cor de baixo (Personalizado)",
        "purpose": "Definir a segunda cor do degradê.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Preferência local.",
        "change": "Grava a cor localmente (sRGB).",
        "approval": "Nenhuma.",
        "result": "Atualiza o fundo e a prévia.",
        "recovery": "Voltar ao padrão.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.direction",
        "title": "Direção do degradê",
        "purpose": "Vertical ou diagonal.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Preferência local.",
        "change": "Grava a direção localmente.",
        "approval": "Nenhuma.",
        "result": "Atualiza o fundo.",
        "recovery": "Voltar ao padrão.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.opacity",
        "title": "Opacidade do fundo",
        "purpose": "Controlar quanto o fundo aparece atrás da janela.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Valor local de backgroundOpacity (0 a 1) exibido como 0 a 100%.",
        "change": "Ajusta backgroundOpacity de 0% a 100%, em passos de 1%. Desabilitado com 'Reduzir transparência' ativo ou durante o preparo de imagem.",
        "approval": "Nenhuma (preferência visual local).",
        "result": "O fundo fica mais discreto ou presente; em 0% a arte some, mas a janela mantém seu tema para não saltar durante o arraste. Neutro restaura o visual nativo.",
        "recovery": "Voltar ao padrão restaura 100%.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.panel-opacity",
        "title": "Opacidade das barras laterais",
        "purpose": "Controlar a força da cor do fundo sobre as barras laterais e o painel de detalhes.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Valor local de panelOpacity (0,25 a 1) exibido como 25 a 100%.",
        "change": "Ajusta panelOpacity de 25% a 100%. O painel mantém seu material nativo e a tinta acompanha este valor; aumentar contraste aplica piso visual de 85%. Voltar ao padrão restaura 30%.",
        "approval": "Nenhuma (preferência visual local).",
        "result": "Com menos opacidade, o material do macOS aparece atrás da cor do fundo; em 100%, a cor fica sólida.",
        "recovery": "Voltar ao padrão restaura 30%.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.blur",
        "title": "Desfoque da imagem",
        "purpose": "Suavizar a foto de fundo para facilitar a leitura.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Valor local de imageBlur (0 a 24 px) exibido como 0 a 100%.",
        "change": "Ajusta o desfoque de 0% a 100%, mapeado para imageBlur de 0 a 24 px. Aparece somente com o preset Imagem; durante importação e Reduzir transparência fica desabilitado.",
        "approval": "Nenhuma (preferência visual local).",
        "result": "0% mantém a foto nítida; valores maiores suavizam a imagem.",
        "recovery": "Voltar ao padrão restaura 0%.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.preview",
        "title": "Prévia da janela",
        "purpose": "Mostrar como ficam fundo, barras e texto antes de sair dos Ajustes.",
        "scope": "Somente visualização local; não envia nada e não guarda estado próprio.",
        "read": "Estado atual de preset, imagem, opacidades e desfoque.",
        "change": "Sem alteração por este controle; a prévia atualiza com os outros controles.",
        "approval": "Nenhuma.",
        "result": "Mostra uma miniatura da janela com a aparência escolhida. Não é a janela real.",
        "recovery": "Voltar ao padrão.",
        "availability": "read_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "appearance.chat-background.reset",
        "title": "Voltar ao padrão",
        "purpose": "Retornar ao fundo Neutro e aos valores padrão dos controles.",
        "scope": "Somente este app neste Mac (UserDefaults, chave com.dexter.apple.chat-appearance.v1). Não vai para o host nem para bots.",
        "read": "Preferência local.",
        "change": "Apaga a preferência local e, se houver imagem, apaga somente a cópia privada verificada. O original nunca é tocado.",
        "approval": "Nenhuma.",
        "result": "A janela volta ao visual nativo do macOS.",
        "recovery": "Se a cópia não puder ser apagada, a aparência padrão fica salva e aparece aviso honesto.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      }
    ]
  },
  {
    "id": "chat-rich-content",
    "title": "Chat: tabelas e gráficos nas respostas",
    "scope": "mensagens do bot apresentadas no Mac; iPhone mostra tabela simples e a fonte do gráfico como código",
    "availability": "ui_only",
    "sourcePaths": [
      "apps/apple/SharedApp/Sources/MacSelectableChatMessage.swift",
      "apps/apple/SharedApp/Sources/ChatView.swift",
      "apps/apple/Sources/DexterAppCore/ChatChartSpec.swift",
      "apps/apple/Sources/DexterAppCore/ChatTableLayout.swift",
      "apps/apple/Sources/DexterAppCore/ChatMessageFormatting.swift"
    ],
    "notes": [
      "Para o bot: tabelas usam Markdown GFM comum (linha de cabeçalho | a | b | e separador |---|---|). Gráfico usa somente um bloco cercado com a linguagem exatamente chart (```chart); outra linguagem continua código. Nada é executado, buscado na rede ou inferido: o app desenha só os números escritos. Consulte esta página quando for emitir um gráfico; não repita a gramática nas respostas.",
      "Gramática ```chart fechada: uma linha por chave no formato chave: valor. Chaves somente type, title, unit, x e series (maiúsculas indiferentes). type obrigatório: bar | line | area | pie. title opcional ≤120 caracteres. unit opcional ≤12 caracteres, exibida como Unidade: …. x obrigatório: categorias separadas por |, cada rótulo não vazio ≤48. series: Nome | v1 | v2 …, repetível; nome não vazio ≤48 e exatamente um valor por categoria, sem preenchimento nem invenção. type, title, unit e x não podem repetir. Linhas vazias são ignoradas; linha sem dois-pontos, chave desconhecida ou chave repetida rejeita o bloco inteiro. Sem comentários: # … ou texto depois do valor invalidam.",
      "Números: somente decimal canônico com ponto, -?[0-9]{1,16}(\\.[0-9]{1,12})?, finito e |v| ≤ 1e15. Recusados: 1,5 · 1e3 · .5 · +2 · NaN · R$ 10 · 10% · 1.234,56. Moeda ou percentual vão em unit. Nada é reinterpretado por localidade.",
      "Limites: fonte ≤8192 caracteres e ≤64 linhas não vazias; 1–24 categorias (line e area ≥2; pie ≤8); 1–4 séries (pie exatamente 1, valores ≥0 e soma >0).",
      "Exemplo válido:\n```chart\ntype: bar\ntitle: Vendas por mês\nunit: R$\nx: Jan | Fev | Mar\nseries: Loja A | 10 | 12.5 | 9\nseries: Loja B | 8 | 11 | -14\n```",
      "Bloco inválido mostra a fonte literal como código com o rótulo chart · Não deu para desenhar; mostrando os dados — nunca um gráfico parcial ou corrigido. Bloco ainda aberto durante o streaming continua código Em andamento até fechar.",
      "Mac: desenho CoreGraphics próprio, sem WebView, rede ou Swift Charts, dentro do mesmo texto selecionável: rótulo do tipo com Copiar dados, título, área do desenho de 196 pt e, abaixo, a alternativa textual com os valores literais (Categoria: Série valor · …). Todos os valores ficam selecionáveis, copiáveis e no valor de acessibilidade; sem tooltip. iPhone mostra o bloco ```chart como código: não prometa gráfico no iPhone.",
      "Tabelas no Mac: grade nativa dentro do mesmo texto selecionável, até 60 linhas, 12 colunas e 600 células (cabeçalho incluído); coluna só de números/moeda/percentual alinha à direita; alinhamento :---: explícito é ignorado. Acima dos limites, um fallback em texto monoespaçado a | b | c mostra todas as células. Durante o streaming, tabela com mais de 12 linhas fica no fallback até a resposta terminar. Sem ordenação, dobra, salvar CSV ou exportar arquivo. iPhone mantém a grade simples com rolagem horizontal."
    ],
    "fields": [
      {
        "id": "chat.table.native",
        "title": "Tabela na resposta",
        "purpose": "Mostrar tabelas Markdown como grade legível sem perder seleção nem dados.",
        "scope": "mensagem do bot apresentada no Mac (mesmo texto de chat.message.text-selectable)",
        "read": "Grade com cabeçalho em semibold, bordas finas e colunas proporcionais ao conteúdo; células vazias preservadas. Até 60 linhas, 12 colunas e 600 células; acima disso, ou com mais de 12 linhas durante o streaming, linhas de texto a | b | c com todas as células.",
        "change": "Arraste para selecionar: a seleção atravessa células e o texto ao redor. Copiar texto, ou ⌘C na seleção, gera TSV (tab entre células, quebra por linha) que cola em planilhas; Copiar mensagem original preserva a fonte Markdown literal.",
        "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
        "result": "Apresentação e cópia locais; a mensagem e sua fonte não mudam. Clipboard é ação humana, sem receipt do harness.",
        "recovery": "Se aparecer em texto, aguarde o fim da resposta ou leia todas as células no fallback; use Copiar mensagem original para a fonte exata. Não há ordenação nem exportação para pedir.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "chat.chart.native",
        "title": "Gráfico na resposta",
        "purpose": "Desenhar barras, linhas, área ou pizza a partir de um bloco ```chart válido escrito na própria mensagem.",
        "scope": "mensagem do bot apresentada no Mac",
        "read": "Área chat.chart.plot com nome acessível tipo + título e valor com todos os números literais; abaixo, o texto selecionável com os mesmos valores. Inválido mostra a fonte literal com chart · Não deu para desenhar; mostrando os dados.",
        "change": "Sem alteração; o desenho não recebe cliques (seleção passa para o texto). Para corrigir dados, o bot precisa escrever outra resposta com o bloco correto.",
        "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
        "result": "Apresentação local, sem rede nem execução; o desenho não é prova de que os dados estão corretos, apenas de que seguem a gramática.",
        "recovery": "Bloco recusado: confira a gramática nesta página (chaves, números canônicos, mesma quantidade de valores) e responda de novo; nada é corrigido automaticamente.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      },
      {
        "id": "chat.chart.copy-data",
        "title": "Copiar dados (gráfico)",
        "purpose": "Copiar o bloco de dados do gráfico exatamente como foi escrito.",
        "scope": "um gráfico desenhado → clipboard local do sistema",
        "read": "Botão Copiar dados no rótulo do gráfico; mostra Copiado brevemente.",
        "change": "Clique Copiar dados.",
        "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
        "result": "Clipboard recebe a fonte literal do bloco ```chart daquele gráfico; não exporta arquivo nem CSV.",
        "recovery": "Para a mensagem inteira use Copiar mensagem original; o sistema pode compartilhar o clipboard fora do Dexter.",
        "availability": "ui_only",
        "readOperation": null,
        "changeOperation": null
      }
    ]
  }
];
export const COMPLETION_UI_FIELD_OVERLAYS:readonly {pageId:string;field:AppConfigurationGuideField}[] = [
  {
    "pageId": "chat",
    "field": {
      "id": "chat.approval-mode",
      "title": "Modo de aprovação (menu)",
      "purpose": "Escolher como as ferramentas do Dexter pedem aprovação nesta conversa.",
      "scope": "Conversa aberta deste bot, no host atual.",
      "read": "GET da política efetiva da conversa (ChatApprovalModeEditor).",
      "change": "PATCH da política da conversa com revisão esperada (CAS); 'Usar padrão do bot' remove a escolha da conversa. Quatro modos: Supervisionado, Aceitar edições, Automático, Acesso completo.",
      "approval": "Escolha do dono na própria janela.",
      "result": "Vale para pedidos novos; não amplia acessos nem muda o provider.",
      "recovery": "Se não confirmar, aparece 'Não confirmado · Conferir' (só lê); recibo ausente oferece 'Repetir o mesmo pedido' com o mesmo ID.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat",
    "field": {
      "id": "chat.composer.details",
      "title": "Detalhes (ⓘ)",
      "purpose": "Ver, sem poluir o composer, de onde vêm o modelo e o modo e o que eles não fazem.",
      "scope": "Conversa aberta deste bot, no host atual.",
      "read": "Estado já carregado (seleção de modelo da conversa e política efetiva).",
      "change": "Nenhuma, exceto 'Voltar ao modelo padrão do bot'.",
      "approval": "Nenhuma.",
      "result": "Mostra: modelo padrão do bot ou só desta conversa; modo e seu escopo; descrição; 'Ferramentas do Dexter · detalhes' recolhível com o limite e as revisões técnicas.",
      "recovery": "Fechar o popover não altera nada.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat",
    "field": {
      "id": "chat.engine.use-bot-default",
      "title": "Voltar ao modelo padrão do bot",
      "purpose": "Desfazer a escolha de modelo feita só para esta conversa.",
      "scope": "Conversa aberta deste bot, no host atual.",
      "read": "Seleção atual da conversa.",
      "change": "Remove a substituição da conversa (mesma chamada de antes).",
      "approval": "Ação do dono.",
      "result": "A conversa volta a usar o modelo padrão do bot.",
      "recovery": "Se falhar, o aviso e 'Recarregar' continuam no composer.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat",
    "field": {
      "id": "chat.engine.model-picker",
      "title": "Modelo (harness e modelo)",
      "purpose": "Escolher engine e modelo da conversa.",
      "scope": "Conversa aberta deste bot, no host atual.",
      "read": "Catálogo de engines do host.",
      "change": "Mesmo seletor de antes; nada mudou no comportamento.",
      "approval": "Ação do dono.",
      "result": "Vale a partir da próxima mensagem.",
      "recovery": "Engine indisponível e falhas de carga seguem aparecendo no composer.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "groups.sidebar.section",
      "title": "Seção Grupos na barra lateral",
      "purpose": "Abrir uma conversa coletiva com vários bots.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "GET /v1/groups?after=<cursor>&limit≤50 ao abrir o app e ao trocar de host.",
      "change": "Nenhuma; só seleciona.",
      "approval": "Nenhuma.",
      "result": "Abre a conversa do grupo no painel principal. Times e Bots continuam como estão (Grupos fica acima de Times).",
      "recovery": "Se a lista não carregar, troque de host ou reabra o app; nada é inferido de Times.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.create",
      "title": "Novo grupo (menu +)",
      "purpose": "Criar um grupo com nome e até 8 bots.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Lista de bots do host.",
      "change": "POST /v1/groups {expectedHostId, clientRequestId, expectedRevision:0, name, botIds, historyBotIds}.",
      "approval": "Ação do dono na própria janela; sem aprovação extra. Entrar no grupo não dá ferramentas, documentos, memória nem histórico 1:1.",
      "result": "O grupo só aparece depois que a base confirma.",
      "recovery": "Se não houver confirmação, use Conferir (GET do recibo pelo clientRequestId). Nunca há reenvio automático.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.edit",
      "title": "Editar grupo",
      "purpose": "Renomear e mudar quem participa.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "GET /v1/groups/:id.",
      "change": "PATCH /v1/groups/:id com expectedRevision (CAS) e clientRequestId.",
      "approval": "Ação do dono.",
      "result": "Bots que já estavam mantêm o ponto de entrada; quem entra agora lê todo o histórico só se você marcar.",
      "recovery": "Se a revisão mudou, recarregue e edite de novo.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.roster",
      "title": "Participantes do grupo",
      "purpose": "Mostrar sempre quem está no grupo e o que cada um lê.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Membros ativos do grupo.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Avatar e nome de cada bot; dica diz se lê todo o histórico ou a partir da entrada.",
      "recovery": "Atualize o grupo se um bot foi removido do host.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.recipients",
      "title": "Para: Todos ou bots escolhidos",
      "purpose": "Escolher um bot, alguns ou todos.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Membros ativos.",
      "change": "Fichas ao lado de 'Para:': Todos (padrão) → {kind:all}; uma ficha marcada → {kind:one,botId}; várias → {kind:selected,botIds}. Vai junto com a mensagem.",
      "approval": "Nenhuma.",
      "result": "Cada bot escolhido responde uma vez (rodada finita), como ele mesmo. Só os escolhidos recebem.",
      "recovery": "Desmarcar todas as fichas volta para Todos. Bot que sai do grupo é desmarcado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.send",
      "title": "Enviar ao grupo",
      "purpose": "Mandar sua mensagem para os escolhidos.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador. Mensagem até 8192 caracteres.",
      "read": "GET /v1/group-conversations/:id/messages?after=<cursor>&limit≤50 (ordem cronológica, para frente).",
      "change": "POST /v1/group-conversations/:id/send {content, recipients, expectedRevision, clientRequestId}.",
      "approval": "Ferramentas de cada bot continuam pedindo a aprovação daquele bot, na conversa dele.",
      "result": "O texto só sai da caixa quando a base aceita. Enquanto uma rodada está aberta, o envio fica bloqueado com aviso.",
      "recovery": "Sem confirmação: o texto fica na caixa e aparece Conferir; não reenviar por conta própria.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.dispatch.status",
      "title": "Andamento da rodada",
      "purpose": "Ver quem está na fila, respondendo, aguardando aprovação, concluiu, falhou ou está sem confirmação.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "GET /v1/group-dispatches/:id enquanto a rodada está aberta.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Resumo curto; detalhes por bot ao expandir (motivo em palavras simples; código técnico só se desconhecido). 'Aguarda sua aprovação' abre a conversa do bot.",
      "recovery": "Estado desconhecido nunca vira sucesso; use Conferir.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.dispatch.stop",
      "title": "Parar",
      "purpose": "Parar só esta rodada.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Estado da rodada.",
      "change": "POST /v1/group-dispatches/:id/stop.",
      "approval": "Ação do dono.",
      "result": "Respostas que já chegaram ficam. Mostra 'Parada pedida' até a base confirmar.",
      "recovery": "Se não confirmar, use Conferir.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.dispatch.resume",
      "title": "Retomar",
      "purpose": "Iniciar os bots que ainda estavam na fila.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Estado da rodada.",
      "change": "POST /v1/group-dispatches/:id/resume; só aparece quando a base diz que é seguro.",
      "approval": "Ação do dono.",
      "result": "Nada que já começou é repetido.",
      "recovery": "Botão some se não for seguro retomar.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.reconcile",
      "title": "Conferir",
      "purpose": "Ler o resultado de um pedido sem confirmação.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "GET do recibo pelo clientRequestId.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Mostra o que de fato aconteceu.",
      "recovery": "Nunca reenvia. Se a base disser que não tem registro, aparece 'Repetir o mesmo pedido', que reenvia exatamente os mesmos dados e o mesmo ID, só com seu clique.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.load-more",
      "title": "Mostrar mais mensagens",
      "purpose": "Carregar as próximas mensagens da conversa (páginas de até 50).",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "GET .../messages?after=<último cursor>&limit≤50.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Mensagens mais novas entram abaixo, em ordem; o botão some quando não há mais.",
      "recovery": "Se falhar, tente de novo; nada é alterado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group.retry-exact",
      "title": "Repetir o mesmo pedido",
      "purpose": "Concluir um pedido sem recibo na base.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Só aparece depois que Conferir mostrou recibo ausente.",
      "change": "Reenvia o mesmo pedido com o mesmo clientRequestId (idempotente).",
      "approval": "Clique explícito do dono.",
      "result": "A base aplica uma única vez ou devolve o recibo existente.",
      "recovery": "Se continuar sem confirmação, use Conferir de novo; nada é repetido sozinho.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "groups-conversations",
    "field": {
      "id": "group-editor.archive",
      "title": "Arquivar grupo",
      "purpose": "Encerrar o uso do grupo mantendo a leitura.",
      "scope": "Grupo do host atual; o dono vê seus grupos. O grupo é uma entidade própria, não é Time e não tem coordenador.",
      "read": "Grupo atual com sua revisão.",
      "change": "Arquivamento do grupo (CAS por revisão, clientRequestId).",
      "approval": "Confirmação explícita do dono.",
      "result": "A conversa fica só para leitura; ninguém envia novas mensagens. Conversas 1:1 não mudam.",
      "recovery": "Sem confirmação: Conferir. (Verificação visual do arquivamento ainda pendente no laboratório.)",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.refresh",
      "title": "Atualizar",
      "purpose": "Ler o estado atual.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Mostra ligado/desligado, propostas, lembranças e atividade.",
      "recovery": "Se a janela expirou, reabra os ajustes do bot.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.enabled",
      "title": "Aprender com as conversas",
      "purpose": "Deixar o bot propor lembranças.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono policy.update {expectedRevision, enabled, maintenanceEnabled, dreamingEnabled, minIdleMs≥120000, maxJobsPerDay≤8, maxProposalsPerJob≤4, timezone, nightHour}.",
      "approval": "Aprovar o pedido exato.",
      "result": "Gera propostas; nunca grava sozinho.",
      "recovery": "Indisponível sem motor configurado; desligar também desliga Manutenção e Sonhar.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.maintenance",
      "title": "Manutenção",
      "purpose": "Expirar o que passou da validade e organizar.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige sua aprovação exata policy.update / maintenance.run.",
      "approval": "Aprovar.",
      "result": "Determinística; não inventa conteúdo.",
      "recovery": "Só com aprendizado ligado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.dreaming",
      "title": "Sonhar",
      "purpose": "Revisar em pausas e propor mudanças.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige sua aprovação exata policy.update.",
      "approval": "Aprovar.",
      "result": "Só propostas; sem ferramentas, sem outros bots, sem publicar sozinho.",
      "recovery": "Só com aprendizado ligado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.budget",
      "title": "Limites (pausa, rodadas por dia, propostas por rodada, fuso, horário noturno)",
      "purpose": "Controlar quando e quanto o bot trabalha.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono policy.update (pausa ≥2 min, ≤8 rodadas/dia, ≤4 propostas por rodada).",
      "approval": "Aprovar.",
      "result": "Vale a partir da próxima rodada.",
      "recovery": "Valores fora do limite não são enviados.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.candidate.accept",
      "title": "Aceitar proposta",
      "purpose": "Guardar exatamente o texto proposto.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Proposta com tipo, confiança e trechos de origem (expandir).",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono candidate.accept {id, expectedRevision, policyRevision, scopeEpoch}.",
      "approval": "Aprovar o pedido exato.",
      "result": "Cria uma nova versão na memória de longo prazo.",
      "recovery": "Se a política ou a memória mudou, a base recusa; atualize.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.candidate.reject",
      "title": "Rejeitar proposta",
      "purpose": "Descartar a proposta.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Proposta.",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono candidate.reject {id, expectedRevision, policyRevision, scopeEpoch}.",
      "approval": "Aprovar.",
      "result": "Ela não é sugerida de novo.",
      "recovery": "Atualize em caso de conflito.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.record.archive",
      "title": "Arquivar",
      "purpose": "Tirar da lembrança ativa.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Lembranças.",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono record.archive {id, expectedRevision, policyRevision, scopeEpoch}.",
      "approval": "Aprovar.",
      "result": "Sai do uso; fica no histórico; pode ser desfeito.",
      "recovery": "Desfazer cria nova versão.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.record.undo",
      "title": "Desfazer (reativar)",
      "purpose": "Reativar uma lembrança arquivada.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Lembranças arquivadas.",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono record.undo {id, expectedRevision, policyRevision, scopeEpoch}.",
      "approval": "Aprovar.",
      "result": "Volta a ficar ativa como nova versão; o histórico fica como está.",
      "recovery": "Só existe para itens arquivados; nunca para esquecidos.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.record.forget",
      "title": "Esquecer",
      "purpose": "Parar de usar e de reaprender.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Lembranças.",
      "change": "POST .../memory-learning/proposals {clientRequestId, command:{operation,input}} → pedido que exige aprovação exata do dono record.forget {id, expectedRevision, policyRevision, scopeEpoch}.",
      "approval": "Confirmar e aprovar.",
      "result": "Bloqueio imediato; remoção das cópias ativas por reconciliação.",
      "recovery": "Não pode ser desfeito. Histórico interno e backups já feitos ficam retidos até expirarem — a tela diz isso.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.purge.status",
      "title": "Situação de item esquecido",
      "purpose": "Mostrar o que acontece com o que foi esquecido.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Item esquecido aparece como 'Lembrança esquecida', sem conteúdo: bloqueado para uso e reaprendizagem; remoção das cópias ativas concluída pela base; histórico interno e backups retidos até expirarem.",
      "recovery": "Atualizar.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.action.approve",
      "title": "Aprovar / Recusar pedido",
      "purpose": "Decidir o pedido aberto.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "Resumo e detalhes vêm do próprio pedido (MemoryLearningPendingAction.summary/details) com o ID do pedido.",
      "change": "Aprovar aplica; Recusar não muda nada.",
      "approval": "É a aprovação do dono.",
      "result": "Mostra Feito, Recusado ou Não aplicado.",
      "recovery": "Um pedido por vez.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.reconcile",
      "title": "Conferir estado",
      "purpose": "Ler o resultado de um pedido sem confirmação.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET .../receipts/:actionID ou .../requests/:clientRequestId.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Resultado real.",
      "recovery": "Nunca reenvia.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "bot-memory-learning",
    "field": {
      "id": "memory.learning.jobs",
      "title": "Atividade recente",
      "purpose": "Ver rodadas de aprendizado e sonho.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática. SOUL/USER/MEMORY continuam iguais.",
      "read": "GET /v1/owner-configuration/sessions/:id/memory-learning/{status,candidates,records,jobs}",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Na fila, em andamento, gerou propostas, nada novo, sem confirmação, conflito, cancelado.",
      "recovery": "Sem confirmação nunca é tratado como sucesso.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "chat.voice-call.open",
      "title": "Ligar (abrir ligação)",
      "purpose": "Abrir a folha de ligação desta conversa.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Nada além de abrir a folha.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Abre a folha; o controlador vem do modelo e mantém pedido pendente entre aberturas. Nada inicia sem 'Ligar'. Desativado para bots que não usam Codex, em times, sem base local ou offline.",
      "recovery": "—",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.state",
      "title": "Estado da ligação",
      "purpose": "Mostrar o estado real: conferindo, pronto, indisponível, conectando, em ligação (tempo), encerrando, não confirmado, não continuou.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "GET /v1/threads/:id/native-voice/status e a sessão do controlador.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Texto vem do controlador: programa conhecido sem suporte → atualizar o programa (com a versão encontrada); sem versão → modelo Codex compatível. Nada é trocado automaticamente.",
      "recovery": "Atualizar.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.voice",
      "title": "Voz desta ligação (fichas)",
      "purpose": "Escolher a voz só para a próxima ligação iniciada nesta folha.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Vozes informadas pelo host (status.voices).",
      "change": "Escolha explícita só para esta ligação (chooseVoice); 'Padrão' = nil. IDs voice-call.voice.default e voice-call.voice.<voz>.",
      "approval": "Nenhuma.",
      "result": "Usada ao iniciar; a voz salva do bot continua igual.",
      "recovery": "Escolher Padrão.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.saved-voice",
      "title": "Voz salva do bot",
      "purpose": "Informar a voz salva para este bot.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Editor de preferência do modelo (nativeVoicePreferencesEditor), GET validado para host/bot.",
      "change": "Nenhuma nesta folha; muda em Ajustes do bot › Modelo.",
      "approval": "—",
      "result": "Vale a partir da próxima ligação; nil = voz padrão.",
      "recovery": "—",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.start",
      "title": "Ligar",
      "purpose": "Iniciar a ligação pelo programa Codex já configurado.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Status suportado.",
      "change": "POST de início pelo controlador (sessão, SDP efêmero, recibo exato).",
      "approval": "Ação do dono; usa o microfone do Mac.",
      "result": "Conectando → Em ligação. Só aparece quando o programa suporta ligações.",
      "recovery": "Se não confirmar: Conferir estado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.mute",
      "title": "Silenciar / Ativar microfone",
      "purpose": "Silenciar o microfone durante a ligação.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Estado da mídia.",
      "change": "Local (setMuted).",
      "approval": "Nenhuma.",
      "result": "O bot deixa de ouvir até reativar.",
      "recovery": "Repetir o botão.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.end",
      "title": "Encerrar",
      "purpose": "Encerrar a ligação.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Sessão ativa.",
      "change": "POST de encerramento pelo controlador.",
      "approval": "Ação do dono.",
      "result": "Encerrando → encerrada; a folha só fecha depois disso.",
      "recovery": "Se não confirmar: Conferir estado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.reconcile",
      "title": "Conferir estado",
      "purpose": "Ler o resultado de um pedido de ligação sem confirmação.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "GET do recibo do pedido original.",
      "change": "Nenhuma; não reenvia.",
      "approval": "Nenhuma.",
      "result": "Mostra o estado real.",
      "recovery": "Nunca reenvia; aguarde e confira de novo.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.live-transcript",
      "title": "Ao vivo (não é o registro salvo)",
      "purpose": "Acompanhar o que está sendo dito.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "Eventos da sessão.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Fragmentos ao vivo; não são apresentados como registro durável.",
      "recovery": "—",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.history",
      "title": "Ligações anteriores",
      "purpose": "Ver ligações desta conversa.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "GET /v1/threads/:id/native-voice/history; só exibido se host, bot, conversa e conexão capturados antes da leitura ainda forem os mesmos.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Data, estado, duração, voz e quantas falas viraram mensagens na conversa (referências a turnos canônicos).",
      "recovery": "—",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "voice-call.close",
      "title": "Fechar",
      "purpose": "Fechar a folha.",
      "scope": "Conversa PRIVADA aberta de um bot Codex no host local; times e grupos não têm ligação. Ajuste de interface: não é ferramenta do bot nem do harness.",
      "read": "—",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Bloqueado durante a ligação ou com pedido não confirmado.",
      "recovery": "Encerre ou confira primeiro.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "bot-profile.native-voice.voice",
      "title": "Voz nas ligações (fichas)",
      "purpose": "Escolher a voz salva deste bot para as próximas ligações.",
      "scope": "Bot Codex no host local; ajuste de interface (sem ferramenta do bot/harness).",
      "read": "nativeVoicePreferencesEditor.load() (GET validado).",
      "change": "Rascunho local até 'Salvar voz'. IDs bot-profile.native-voice.voice.default e .<voz>.",
      "approval": "Nenhuma.",
      "result": "Mostra a voz salva; somente leitura quando o programa não suporta ligações.",
      "recovery": "Escolher de novo.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "bot-profile.native-voice.save",
      "title": "Salvar voz",
      "purpose": "Salvar a voz das próximas ligações.",
      "scope": "Bot Codex no host local; ajuste de interface (sem ferramenta do bot/harness).",
      "read": "Revisão atual da preferência e do bot.",
      "change": "PATCH com expectedHostId/BotId/BotRevision/Revision e clientRequestId (CAS) pelo editor; 'Padrão' grava nil.",
      "approval": "Ação do dono.",
      "result": "Vale a partir da próxima ligação; ligação em andamento mantém a voz.",
      "recovery": "Sem confirmação: aparece 'Conferir'.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "bot-profile.native-voice.reconcile",
      "title": "Conferir",
      "purpose": "Confirmar uma voz salva cuja resposta se perdeu.",
      "scope": "Bot Codex no host local; ajuste de interface (sem ferramenta do bot/harness).",
      "read": "GET do recibo do pedido original (validado: hash/escopo/revisão).",
      "change": "Nenhuma; nunca reenvia.",
      "approval": "Nenhuma.",
      "result": "Mostra a voz realmente salva.",
      "recovery": "Repetir Conferir.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "native-codex-voice",
    "field": {
      "id": "bot-profile.native-voice.message",
      "title": "Mensagem da voz salva",
      "purpose": "Explicar o estado: salva, não confirmada, programa sem suporte.",
      "scope": "Bot Codex no host local; ajuste de interface (sem ferramenta do bot/harness).",
      "read": "Editor.",
      "change": "Nenhuma.",
      "approval": "Nenhuma.",
      "result": "Texto do editor.",
      "recovery": "—",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat-images",
    "field": {
      "id": "chat.message.attachment.open.<id>",
      "title": "Ampliar imagem (miniatura na mensagem)",
      "purpose": "Ver em tamanho maior uma imagem já aceita numa mensagem da conversa.",
      "scope": "anexo canônico de uma mensagem da conversa apresentada; somente Mac com conexão owner-loopback",
      "read": "Miniatura na mensagem (chat.message.attachment.<id>), com ícone de expandir, dica Ampliar imagem e nome acessível Ampliar imagem anexada. O espaço segue as dimensões canônicas do anexo (até 320×220 pt) enquanto carrega; mostra Carregando imagem… ou o aviso de falha.",
      "change": "Clique na miniatura para abrir a folha chat.image.preview. Não abre URL, outro app, editor nem novo envio.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Abre a folha da mesma imagem. Os bytes vêm do download autenticado do anexo da própria conversa na base atual e são decodificados localmente (miniatura ≤640 px). Clique não reenvia a imagem ao modelo nem prova leitura pela engine.",
      "recovery": "Falha mostra Não foi possível carregar a imagem. Reabra a conversa para tentar novamente.; reabra a conversa. Sem reenvio, troca de anexo ou fallback por URL.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat-images",
    "field": {
      "id": "chat.image.preview",
      "title": "Imagem ampliada (folha)",
      "purpose": "Mostrar a imagem anexada em tamanho maior, ajustada à janela.",
      "scope": "um anexo da conversa aberta; somente Mac owner-loopback",
      "read": "Folha Imagem anexada (mínimo 560×400, ideal 820×620) com a imagem em escala, Carregando imagem… ou Imagem indisponível. Só aceita os bytes canônicos do host atual: um único PNG estático ≤2 MiB, ≤4096 px por eixo e ≤16M pixels, decodificado localmente até 2048 px.",
      "change": "Sem alteração; feche com chat.image.close ou Esc.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Só apresentação: não copia, salva, exporta nem envia a imagem de novo. Trocar de base/escopo ou de conversa fecha a folha automaticamente.",
      "recovery": "Imagem indisponível: feche e abra de novo. Bytes fora dos limites continuam indisponíveis, sem reduzir, converter ou buscar outra fonte.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat-images",
    "field": {
      "id": "chat.image.close",
      "title": "Fechar (imagem ampliada)",
      "purpose": "Fechar a folha da imagem ampliada.",
      "scope": "folha chat.image.preview",
      "read": "Botão Fechar no topo da folha; Esc tem o mesmo efeito.",
      "change": "Clique Fechar ou pressione Esc.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Volta ao chat; nada é apagado, salvo ou alterado.",
      "recovery": "Reabra pela miniatura (chat.message.attachment.open.<id>).",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "app-navigation",
    "field": {
      "id": "thread.history",
      "title": "Conversas (histórico do bot)",
      "purpose": "Listar as conversas privadas do bot com título, prévia e última atividade reais, sem abri-las.",
      "scope": "conversas privadas do bot selecionado na base conectada (sem Times nem Grupos); Mac",
      "read": "Ao abrir ou reabrir a lista o app faz um GET de lista owner-local /v1/bots/:botId/threads, que responde {items, summaries}; items mantém o formato legado. Cada linha acionável (thread.<id>, com título, prévia e atividade combinados para acessibilidade) mostra: título = primeira mensagem humana com texto (≤80, uma linha, sem Markdown/cercas, tokens óbvios mascarados como ••••; nunca do assistente); prévia = última mensagem com texto de qualquer papel (≤160), prefixada Você: ou nome do bot; ícone de foto quando a última mensagem tem imagem (só o vínculo, nunca bytes); data da última atividade. A contagem de mensagens só decide Sem mensagens ainda. Seções Hoje/Ontem/Anteriores, mais recente primeiro; até 500 conversas escolhidas pela atividade mais recente. Metadados de exibição inválidos são ignorados nessa linha; a conversa continua disponível.",
      "change": "A lista recarrega sozinha ao abrir (por base + dono). Título é derivado e somente leitura: não há renomear nem título salvo. Clique, ou ↑/↓ e Return, abre a conversa.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Projeção de metadados do host; desenhar as linhas não lê mensagens, turnos, ações nem bytes. A lista pode ficar defasada até ser reaberta.",
      "recovery": "Falha mostra Conversas indisponíveis (Não foi possível carregar as conversas.); reabra a lista. Host sem a rota, ou cliente pareado, cai na descoberta legada sem summaries (linha Conversa · Criada em …; ver thread.titles-pending). Nada é criado ou reenviado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "app-navigation",
    "field": {
      "id": "thread.search",
      "title": "Buscar conversas",
      "purpose": "Filtrar as conversas já carregadas por título e prévia.",
      "scope": "lista local de conversas privadas do bot",
      "read": "Campo Buscar conversas, visível quando há conversas.",
      "change": "Digite palavras: todas precisam aparecer no título ou na prévia, sem diferenciar maiúsculas nem acentos. Conversa sem summary não casa com busca. A ordem continua por atividade.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Filtro local; não consulta o host nem procura no conteúdo completo das mensagens.",
      "recovery": "Sem resultado use o único botão Limpar busca junto ao campo (thread.search.clear). A busca fica oculta quando nenhuma linha tem metadados pesquisáveis, como no caminho legado ou pareado. A lista não toma o foco do campo quando os resultados reaparecem.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "app-navigation",
    "field": {
      "id": "thread.search.clear",
      "title": "Limpar busca",
      "purpose": "Voltar à lista completa.",
      "scope": "campo de busca da lista",
      "read": "Botão ⊗ no campo e Limpar busca no estado sem resultado; aparecem só com texto digitado.",
      "change": "Clique Limpar busca.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Mostra todas as conversas carregadas; nada é recarregado ou alterado.",
      "recovery": "Se a lista continuar vazia, confira o estado vazio/falha (thread.empty).",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "app-navigation",
    "field": {
      "id": "thread.create",
      "title": "Nova conversa (lista Conversas)",
      "purpose": "Começar outra conversa do bot a partir da lista.",
      "scope": "bot selecionado na base conectada; Mac",
      "read": "Botão Nova conversa no cabeçalho da lista ou no estado vazio; desabilitado sem host, durante envio ou enquanto mostra Criando conversa….",
      "change": "Clique Nova conversa. É o mesmo comando de ⋯ › Nova conversa e Arquivo › Nova conversa (⌘N).",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Uma criação por vez; a conversa confirmada pela base passa a ser a apresentada.",
      "recovery": "Criação incerta: confira a lista na mesma base antes de repetir; não troque de ID para tentar de novo.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "app-navigation",
    "field": {
      "id": "thread.empty",
      "title": "Sem conversas / estados da lista",
      "purpose": "Explicar por que a lista não mostra linhas.",
      "scope": "lista de conversas privadas do bot",
      "read": "Mostra Carregando conversas…, Conversas indisponíveis, a busca sem resultado ou Sem conversas (Comece uma conversa. Cada uma mantém seu próprio histórico.) com Nova conversa.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura apenas; não cria nem concede nada.",
      "result": "Lista vazia não prova ausência de conversas no host (pode ser falha, carga ou busca).",
      "recovery": "Reabra a lista ou limpe a busca; para começar use Nova conversa.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "team-chat",
    "field": {
      "id": "team-thread.history",
      "title": "Conversas do time (histórico)",
      "purpose": "Listar as conversas do Time (coordenador atual) com título, prévia e última atividade reais, sem abri-las.",
      "scope": "conversas do Time com o coordenador atual na base local do proprietário; Mac",
      "read": "Ao abrir ou reabrir a lista o app faz um GET de lista owner-local /v1/teams/:teamId/threads, que responde {items, summaries}; items mantém o formato legado. Cada linha acionável (team-thread.<id>, com título, prévia e atividade combinados para acessibilidade) mostra: título = primeira mensagem humana com texto (≤80, uma linha, sem Markdown/cercas, tokens óbvios mascarados como ••••; nunca do assistente); prévia = última mensagem com texto de qualquer papel (≤160), prefixada Você: ou nome do Time; ícone de foto quando a última mensagem tem imagem (só o vínculo, nunca bytes); data da última atividade. A contagem de mensagens só decide Sem mensagens ainda. Seções Hoje/Ontem/Anteriores, mais recente primeiro; até 500 conversas escolhidas pela atividade mais recente. Metadados de exibição inválidos são ignorados nessa linha; a conversa continua disponível. Summaries do Time só vêm na lista do Time, nunca na lista privada do bot; a rota é owner-local.",
      "change": "A lista recarrega sozinha ao abrir (por base + dono). Título é derivado e somente leitura: não há renomear nem título salvo. Clique, ou ↑/↓ e Return, abre a conversa.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Projeção de metadados do host; desenhar as linhas não lê mensagens, turnos, ações nem bytes. A lista pode ficar defasada até ser reaberta.",
      "recovery": "Falha mostra Conversas indisponíveis (Não foi possível carregar as conversas do time.); reabra a lista. Host sem a rota, ou cliente pareado, cai na descoberta legada sem summaries (linha Conversa · Criada em …; ver thread.titles-pending). Nada é criado ou reenviado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "team-chat",
    "field": {
      "id": "team-thread.search",
      "title": "Buscar conversas",
      "purpose": "Filtrar as conversas já carregadas por título e prévia.",
      "scope": "lista local de conversas do Time (coordenador atual)",
      "read": "Campo Buscar conversas, visível quando há conversas.",
      "change": "Digite palavras: todas precisam aparecer no título ou na prévia, sem diferenciar maiúsculas nem acentos. Conversa sem summary não casa com busca. A ordem continua por atividade.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Filtro local; não consulta o host nem procura no conteúdo completo das mensagens.",
      "recovery": "Sem resultado use o único botão Limpar busca junto ao campo (team-thread.search.clear). A busca fica oculta quando nenhuma linha tem metadados pesquisáveis. A lista não toma o foco do campo quando os resultados reaparecem.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "team-chat",
    "field": {
      "id": "team-thread.search.clear",
      "title": "Limpar busca",
      "purpose": "Voltar à lista completa.",
      "scope": "campo de busca da lista",
      "read": "Botão ⊗ no campo e Limpar busca no estado sem resultado; aparecem só com texto digitado.",
      "change": "Clique Limpar busca.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Mostra todas as conversas carregadas; nada é recarregado ou alterado.",
      "recovery": "Se a lista continuar vazia, confira o estado vazio/falha (team-thread.empty).",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "team-chat",
    "field": {
      "id": "team-thread.empty",
      "title": "Sem conversas / estados da lista",
      "purpose": "Explicar por que a lista não mostra linhas.",
      "scope": "lista de conversas do Time (coordenador atual)",
      "read": "Mostra Carregando conversas…, Conversas indisponíveis, a busca sem resultado ou Sem conversas (Comece uma conversa. Cada uma mantém seu próprio histórico.) com Nova conversa.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura apenas; não cria nem concede nada.",
      "result": "Lista vazia não prova ausência de conversas no host (pode ser falha, carga ou busca).",
      "recovery": "Reabra a lista ou limpe a busca; para começar use Nova conversa.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat",
    "field": {
      "id": "chat.scroll.follow",
      "title": "Rolagem da conversa (acompanhar / ler histórico)",
      "purpose": "Manter a última mensagem visível só enquanto a pessoa está no fim; quem lê mensagens antigas não é puxado para baixo.",
      "scope": "conversa apresentada (base, conversa e geração atuais); vale também para conversas em Grupo",
      "read": "Estado local de apresentação: acompanhando quando a vista está a até 80 pt do fim; lendo depois que a pessoa rola para cima mais que isso. Nada é lido do host para isto.",
      "change": "Rolar para cima passa a ler. Voltar ao fim rolando, enviar uma mensagem própria ou usar Voltar ao fim (chat.scroll.latest) retoma o acompanhamento. Mostrar mais mensagens no Grupo carrega para a frente preservando a posição de leitura.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Ao abrir, posiciona uma vez no fim sem animação. Novas respostas, streaming, imagens, tabelas e cartões só acompanham quando já está no fim: pedidos agrupados a cada 100 ms, animação suave de 0,16 s só para até 1,5 tela (mais longe salta sem animar) e nenhuma animação com Reduzir movimento. Durante a revisão de uma aprovação no Mac a conversa não se move sozinha. Rolagem não prova entrega nem execução.",
      "recovery": "Se a lista parecer desatualizada use Atualizar conversa; a posição de leitura é mantida. Trocar de conversa, base ou escopo cancela o pedido pendente e recomeça o posicionamento.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "pageId": "chat",
    "field": {
      "id": "chat.scroll.latest",
      "title": "Voltar ao fim",
      "purpose": "Ir à última mensagem carregada e voltar a acompanhar a conversa.",
      "scope": "conversa apresentada; aparece só enquanto se lê o histórico longe do fim",
      "read": "Botão Voltar ao fim (seta para baixo), visível no estado lendo a mais de 80 pt do fim.",
      "change": "Clique no botão: rola até o fim da conversa carregada e retoma o acompanhamento, mesmo que a pessoa tenha pausado lendo. No Grupo não carrega páginas adicionais.",
      "approval": "Navegação/apresentação local, sem concessão nem mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "A última mensagem carregada fica visível e as novas voltam a ser acompanhadas. Clique não envia nada ao host.",
      "recovery": "Se mensagens novas não aparecerem, use Atualizar conversa ou Mostrar mais mensagens; nada é reenviado.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  }
];
