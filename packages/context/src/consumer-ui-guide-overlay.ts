import type { AppConfigurationGuideField, AppConfigurationGuidePage } from './app-configuration-guide.js';
type PageInput=Pick<AppConfigurationGuidePage,'id'|'title'|'scope'|'availability'|'sourcePaths'|'notes'|'fields'>;
type Operation={op:string;page:string;field?:string;entry?:AppConfigurationGuideField;text?:string;noteIndex?:number;values?:Partial<AppConfigurationGuideField>};
/** Static consumer UI documentation only. It performs no IO and grants no authority. */
const operations:readonly Operation[]=[
  {
    "op": "replace-note",
    "page": "bot-settings",
    "noteIndex": 0,
    "text": "UX-P1-17: seis páginas no menu lateral — Perfil, Modelo e voz, Memória (Instruções e memória · Habilidades), Conexões (Contas e ferramentas · Navegador na nuvem · Este Mac), Permissões (Acessos · Comunicação) e Atividade (Automações · Histórico). Páginas e subseções são só navegação: as rotas BotSettingsSection (rawValues profile, model, memory, skills, mcp, access, communication, browser, routines, history), os IDs bot-profile.tab.<raw>, rascunhos, salvar por seção, sessão e congelamento não mudam. Os grupos antigos (bot-profile.group.*) e o atalho lateral Dispositivos deixaram de existir; Dispositivos virou Conexões › Este Mac. Clicar numa página volta à última subseção vista nela. Deep links antigos chegam à subseção correspondente (Abrir Acessos… → Permissões › Acessos; Memória e instruções → Memória › Instruções e memória)."
  },
  {
    "op": "replace-note",
    "page": "bot-settings",
    "noteIndex": 2,
    "text": "Cada subseção diz no topo como guarda mudanças (bot-profile.save-model): rascunho até Salvar alterações (Perfil, Modelo e voz, Comunicação, Navegador na nuvem), rascunho mais pedidos que exigem aprovação do pedido exato (Instruções e memória, Contas e ferramentas), cada mudança confirmada e aplicada na hora sem botão Salvar (Habilidades, Acessos, Automações, Este Mac) ou somente consulta (Histórico). Perfil, Modelo e voz e Comunicação têm o mesmo rodapé: Descartar (local, volta ao último perfil confirmado, nada é enviado) e Salvar alterações (⌘S), que envia só os campos daquela seção com a revisão do perfil; os rascunhos das outras seções continuam. Trocar de página nunca salva, envia nem descarta. Não há Salvar tudo nem transação única entre seções."
  },
  {
    "op": "add-note",
    "page": "bot-settings",
    "text": "Arquivos: o backend e o SDK de saídas já fornecem destino, gerações, namespaces Geral/Bots/Times, listagem e download. A linha bot-profile.files desta composição ainda é um placeholder sem comando; a nova UI está em implementação. Consulte output-files para os contratos reais. Destino novo vale só para arquivos novos; nunca mover/apagar os existentes. VPS sem resposta não permite usar a pasta deste Mac."
  },
  {
    "op": "add-note",
    "page": "bot-settings",
    "text": "Hierarquia visual (referência Codync): título da página e uma linha de descrição; barra de subseções em cápsulas; grupos com título fora do cartão e linhas com divisória (rótulo e explicação à esquerda, estado ou controle à direita). Cores do sistema adaptativas (claro/escuro/Aumentar contraste); sem glass decorativo nem preto forçado."
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.profile",
    "entry": {
      "id": "bot-profile.tab.profile",
      "title": "Perfil (rota profile)",
      "purpose": "Rota estável da página Perfil; não há botão de subseção porque a página tem uma seção só.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Perfil no menu lateral (bot-profile.page.profile) ou abra por deep link .profile. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.model",
    "entry": {
      "id": "bot-profile.tab.model",
      "title": "Modelo e voz (rota model)",
      "purpose": "Rota estável da página Modelo e voz.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Modelo e voz no menu lateral (bot-profile.page.model-voice) ou abra por deep link .model. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.memory",
    "entry": {
      "id": "bot-profile.tab.memory",
      "title": "Instruções e memória (subseção de Memória)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Memória no menu lateral e depois Instruções e memória na barra de subseções; o deep link .memory chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.skills",
    "entry": {
      "id": "bot-profile.tab.skills",
      "title": "Habilidades (subseção de Memória)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Memória no menu lateral e depois Habilidades na barra de subseções; o deep link .skills chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.mcp",
    "entry": {
      "id": "bot-profile.tab.mcp",
      "title": "Contas e ferramentas (subseção de Conexões)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Conexões no menu lateral e depois Contas e ferramentas na barra de subseções; o deep link .mcp chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.browser",
    "entry": {
      "id": "bot-profile.tab.browser",
      "title": "Navegador na nuvem (subseção de Conexões)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Conexões no menu lateral e depois Navegador na nuvem na barra de subseções; o deep link .browser chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.access",
    "entry": {
      "id": "bot-profile.tab.access",
      "title": "Acessos (subseção de Permissões)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Permissões no menu lateral e depois Acessos na barra de subseções; o deep link .access chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.communication",
    "entry": {
      "id": "bot-profile.tab.communication",
      "title": "Comunicação (subseção de Permissões)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Permissões no menu lateral e depois Comunicação na barra de subseções; o deep link .communication chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.routines",
    "entry": {
      "id": "bot-profile.tab.routines",
      "title": "Automações (subseção de Atividade)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Atividade no menu lateral e depois Automações na barra de subseções; o deep link .routines chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.tab.history",
    "entry": {
      "id": "bot-profile.tab.history",
      "title": "Histórico (subseção de Atividade)",
      "purpose": "Abrir esta subseção mantendo o alvo e os rascunhos deste bot.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Atividade no menu lateral e depois Histórico na barra de subseções; o deep link .history chega direto aqui. Um ponto ao lado indica rascunho. Navegação não aplica alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.page.<page>",
      "title": "Perfil / Modelo e voz / Memória / Conexões / Permissões / Atividade",
      "purpose": "Escolher uma das seis páginas.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Clique a página no menu lateral (page = profile, model-voice, memory, connections, permissions, activity). Volta à última subseção vista nela. Um ponto e o valor acessível 'Alterações não salvas' indicam rascunho em qualquer subseção da página.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.tab.this-mac",
      "title": "Este Mac (subseção de Conexões)",
      "purpose": "Ver as decisões deste bot para as ferramentas deste Mac e o caminho para preparar o Mac.",
      "scope": "navegação do editor; não é rota BotSettingsSection",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha Conexões e depois Este Mac. Não tem rascunho nem salvar próprio.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.subsections",
      "title": "Barra de subseções",
      "purpose": "Mostrar as subseções da página e qual está aberta.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.save-model",
      "title": "Como esta subseção guarda mudanças",
      "purpose": "Dizer antes de editar se há rascunho, aprovação do pedido exato, mudança confirmada na hora ou só consulta.",
      "scope": "subseção visível",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.unsaved",
    "entry": {
      "id": "bot-profile.unsaved",
      "title": "Alterações não salvas em … · trocar de página mantém os rascunhos",
      "purpose": "Dizer em quais subseções ainda há rascunhos e que nada é salvo sozinho.",
      "scope": "editor local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings",
    "field": "bot-profile.link.devices",
    "entry": {
      "id": "bot-profile.link.devices",
      "title": "Permissões por aparelho… (Conexões › Este Mac)",
      "purpose": "Levar às permissões de cada bot por aparelho, que ficam nos Ajustes do app.",
      "scope": "Ajustes do app da base atual (aba Dispositivos; com os cinco panes do Opus principal, Este Mac)",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Conexões › Este Mac, clique Permissões por aparelho…; abre os Ajustes do app (router.settingsTab = devices). Abrir não muda nada nem toca os rascunhos desta janela. Desligado quando a sessão da janela aposentou.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.link.this-mac",
      "title": "Abrir ajustes deste Mac…",
      "purpose": "Levar aos sites, arquivos e tela por bot e ao estado real do agente deste Mac.",
      "scope": "Ajustes do app da base atual (aba Mac)",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Conexões › Este Mac, clique Abrir ajustes deste Mac…; abre os Ajustes do app (router.settingsTab = mac). Abrir não muda nada. Esta janela não afirma que o Mac está pareado ou pronto.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.this-mac.permissions",
      "title": "Permissões deste bot (Ferramentas do Mac)",
      "purpose": "Mostrar as decisões reais da base para as ferramentas do Mac deste bot.",
      "scope": "grants do bot fixo",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Os controles internos são os de bot-settings-access (bot-settings.access.*), mesmas operações e confirmações.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.this-mac.availability",
      "title": "Preparar este Mac · disponibilidade",
      "purpose": "Dizer com honestidade que esta janela não confirma agente, pareamento nem permissões do macOS e que dá para configurar depois.",
      "scope": "este Mac e esta base",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.files",
      "title": "Arquivos · Pasta deste bot / Pasta geral de saídas",
      "purpose": "Mostrar onde ficam os arquivos que o bot salva e o que ainda não existe.",
      "scope": "Namespace privado do bot na base capturada; backend/SDK implementados, UI de navegação ainda em composição.",
      "read": "A linha mostra Local ainda não mostrado. Para o contrato real, consulte output-files: GET de localização/namespaces e arquivos na base com audiência e escopos válidos.",
      "change": "Não existe ação nesta linha ainda. Não executar shell como substituto de um botão nem mudar o destino automaticamente.",
      "approval": "Nenhum gesto disponível nesta linha; a mudança real de destino usa o fluxo owner/outputs.manage com CAS e receipt, documentado em output-files.",
      "result": "Indisponibilidade desta linha não significa que o backend de saídas está ausente.",
      "recovery": "Aguardar composição da UI; não afirmar uma pasta local para uma base remota.",
      "availability": "unavailable",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings",
    "entry": {
      "id": "bot-profile.voice",
      "title": "Voz (slot da página Modelo e voz)",
      "purpose": "Agrupar a voz nas ligações (card nativo, bots Codex) e a voz ao vivo deste bot.",
      "scope": "bot fixo",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Os controles internos mantêm seus IDs e páginas: bot-profile.native-voice.* (native-codex-voice) e bot-profile.live-voice (bot-voice). Lugar reservado à revisão de voz da lane principal (UX-P1-13).",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-profile",
    "field": "save-profile",
    "entry": {
      "id": "save-profile",
      "title": "Salvar alterações (⌘S) · Perfil / Modelo e voz / Comunicação",
      "purpose": "Persistir só os campos da subseção visível com a revisão esperada do perfil.",
      "scope": "bot selecionado",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Mesmo botão nas três subseções (ID bot-profile.save): em Perfil envia nome, função, emoji e avatar; em Modelo e voz envia modelo padrão e voz ao vivo; em Comunicação envia Master e os três flags. A frase ao lado diz o que vai. Os rascunhos das outras subseções continuam. A proposta bots.update do harness só contém nome/função/emoji e liveVoice próprios, sempre aprovada pelo proprietário.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-profile",
    "entry": {
      "id": "bot-profile.discard",
      "title": "Descartar (rodapé) / Descartar · Continuar editando",
      "purpose": "Voltar os campos da subseção visível ao último perfil confirmado pela base.",
      "scope": "rascunho local do perfil",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Clique Descartar e confirme (bot-profile.discard.confirm). Só os campos daquela subseção voltam; nada é enviado; as outras subseções não mudam. Desligado sem rascunho, durante pedido ou com a sessão aposentada.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-profile",
    "field": "bot-profile.notice",
    "entry": {
      "id": "bot-profile.notice",
      "title": "Resultado do salvamento da subseção",
      "purpose": "Dizer 'Perfil salvo…', 'Modelo e voz salvos…' ou 'Comunicação salva…' confirmados pela base, ou conflito/resultado incerto.",
      "scope": "subseção visível",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "bot-settings-access",
    "text": "UX-P1-17: Ferramentas do Mac (bot-settings.access.*) saiu de Acessos e fica em Conexões › Este Mac, mesma view, mesmas confirmações e reconciliação. Acessos mostra a linha 'Navegador, arquivos e tela deste Mac têm decisões próprias em Conexões › Este Mac' com o botão Abrir Este Mac (bot-profile.access.open-this-mac), que só navega. Comunicação virou subseção de Permissões com o rodapé Descartar / Salvar alterações; os 4 modos de aprovação, Tipos que você sempre aceita, acessos e detalhes técnicos continuam iguais."
  },
  {
    "op": "add-field",
    "page": "bot-settings-access",
    "entry": {
      "id": "bot-profile.access.open-this-mac",
      "title": "Abrir Este Mac",
      "purpose": "Levar às decisões deste bot para as ferramentas do Mac.",
      "scope": "navegação do editor",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Clique Abrir Este Mac em Permissões › Acessos; abre Conexões › Este Mac. Navegação não aplica nada.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings-access",
    "field": "bot-profile.communication.save-hint",
    "entry": {
      "id": "bot-profile.communication.save-hint",
      "title": "Comunicação entre bots: vale depois de Salvar alterações",
      "purpose": "Explicar que Master/Ver/Receber/Enviar são campos do perfil, não acessos de execução, e só valem depois de Salvar alterações.",
      "scope": "perfil do bot fixo",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "bot-settings-skills",
    "text": "UX-P2-23: primeiro nível em linguagem simples — Ativas neste bot (bot-settings.skills.own: nome legível, versão, Desativar…), Disponíveis para ativar (bot-settings.skills.available: a versão mais nova entre as páginas carregadas de cada habilidade, Ativar… ou Usar esta versão… quando a ativa é mais antiga; nunca oferece versão mais antiga) e Também ativas pela base (bot-settings.skills.inherited, só consulta). Ativar uma habilidade existente leva dois cliques: Ativar… e Ativar habilidade (bot-settings.skills.confirm), com a versão exata na confirmação. Versão registrada, conteúdo Markdown, id/sha256/commit/path (bot-settings.skills.technical), Carregar mais e o catálogo global ficam em Avançado (bot-settings.skills.advanced). O nome legível só troca '-'/'_' por espaço; o ID registrado continua no protocolo, na dica e em Avançado. Habilidades não concedem ferramentas, contas, arquivos nem permissões."
  },
  {
    "op": "add-field",
    "page": "bot-settings-skills",
    "entry": {
      "id": "bot-settings.skills.activate.<id>",
      "title": "Ativar… / Usar esta versão… (Disponíveis para ativar)",
      "purpose": "Ativar a versão mais nova carregada de uma habilidade somente para este bot.",
      "scope": "ativação própria; audiência derivada do host",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Na UI: Ativar… e confirme Ativar habilidade; a base confere versão/hash (CAS). Pelo harness use skills.activate exposta, como em bot-settings.skills.activate.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": null,
      "changeOperation": "dexter.harness.skills.activate"
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings-skills",
    "entry": {
      "id": "bot-settings.skills.own / available / inherited",
      "title": "Ativas neste bot / Disponíveis para ativar / Também ativas pela base",
      "purpose": "Mostrar o que este bot usa, o que pode ativar e o que vem da base.",
      "scope": "bot fixo; herança global só consulta",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-settings-skills",
    "entry": {
      "id": "bot-settings.skills.advanced",
      "title": "Avançado: versões, conteúdo e catálogo",
      "purpose": "Abrir os controles de registro (versão, Ler conteúdo, Ativar para este bot, Carregar mais, Gerenciar catálogo global, detalhes técnicos).",
      "scope": "navegação local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Abra a divulgação; os controles internos mantêm seus IDs e comportamento.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-settings-skills",
    "field": "bot-settings.skills.deactivate.<id>",
    "entry": {
      "id": "bot-settings.skills.deactivate.<id>",
      "title": "Desativar… / Desativar habilidade / Cancelar",
      "purpose": "Remover somente a ativação própria observada.",
      "scope": "habilidade deste bot; audiência derivada do host",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Confirme na UI ou proponha skills.activate com version nula e expected versão/hash. Preserva versões registradas e heranças global/Time.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": null,
      "changeOperation": "dexter.harness.skills.activate"
    }
  },
  {
    "op": "add-note",
    "page": "skills",
    "text": "Título da folha: Catálogo de habilidades. id, versão, sha256, commit e caminho da versão lida ficam em Detalhes técnicos (skills.technical). Aberta por Memória › Habilidades › Avançado › Gerenciar catálogo global…."
  },
  {
    "op": "replace-note",
    "page": "bot-documents",
    "noteIndex": 0,
    "text": "UX-P2-22: abas Personalidade (SOUL), Sobre você (USER) e Memória (MEMORY) — IDs bot-documents.tab.soul/user/memory e o protocolo não mudam; os nomes de arquivo saíram do primeiro nível. Na aba Memória: memória de longo prazo (bot-memory-learning), Trechos sugeridos (bot-memory-routines) e Versões e detalhes técnicos (bot-documents.technical), recolhido e aberto sozinho quando há pedido pendente/incerto, versão aberta ou nota de origem escrita. Dentro: arquivos do bot (bot-documents.technical.files), origem atual e nota opcional, Versões anteriores com Ver versão e Restaurar esta versão da memória… (confirmação, Cancelar padrão) e Recuperar pedido não confirmado (ID, Copiar ID, Consultar resultado somente leitura). Salvar alterações (ID bot-documents.save) envia os três por PUT com clientRequestId e receipt Context; a frase ao lado diz que os três vão juntos."
  },
  {
    "op": "update-field",
    "page": "bot-documents",
    "field": "soul",
    "entry": {
      "id": "soul",
      "title": "Personalidade / SOUL.md",
      "purpose": "Personalidade, função e instruções permanentes do próprio bot.",
      "scope": "próprio bot; audiência derivada do host",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Proponha {expectedRevision, document:'SOUL', markdown} conforme schema. O host preserva USER/MEMORY. Texto vazio limpa somente SOUL; não escreva permissões ou secrets como concessão. Na UI é a aba Personalidade.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.harness.documents.read",
      "changeOperation": "dexter.harness.documents.update"
    }
  },
  {
    "op": "update-field",
    "page": "bot-documents",
    "field": "save-documents",
    "entry": {
      "id": "save-documents",
      "title": "Salvar alterações (documentos)",
      "purpose": "Persistir documentos na UI ou um documento por proposta no harness, com CAS e aprovação.",
      "scope": "documentos próprios; audiência derivada do host",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "A UI salva os três rascunhos (Personalidade, Sobre você, Memória) por PUT com clientRequestId e receipt Context; a nota opcional vai como sourceReference. documents.update altera apenas o documento indicado. Espere receipt; revisão alterada exige releitura própria.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.harness.documents.read",
      "changeOperation": "dexter.harness.documents.update"
    }
  },
  {
    "op": "update-field",
    "page": "bot-documents",
    "field": "tabs",
    "entry": {
      "id": "tabs",
      "title": "Abas Personalidade / Sobre você / Memória e contador",
      "purpose": "Editar um dos três rascunhos sem descartar os demais.",
      "scope": "rascunhos no cliente",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Mude a aba e edite o texto. O nome acessível do editor é só o rótulo leigo; o nome do arquivo está em Versões e detalhes técnicos. Conteúdo acima do limite (8192 UTF-16) bloqueia Salvar alterações.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-documents",
    "entry": {
      "id": "bot-documents.technical",
      "title": "Versões e detalhes técnicos",
      "purpose": "Abrir versões, nota de origem, IDs de pedido e a recuperação somente leitura.",
      "scope": "navegação local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Abra a divulgação; ela abre sozinha quando há pedido pendente ou incerto, versão aberta ou nota escrita. Os controles internos mantêm seus IDs (o identificador fica no rótulo para não substituir os dos filhos).",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "bot-memory-learning",
    "field": "memory.learning.enabled",
    "entry": {
      "id": "memory.learning.enabled",
      "title": "Aprender com as conversas · Ligar… / Desligar…",
      "purpose": "Ligar ou desligar as propostas de lembranças com um único pedido.",
      "scope": "Somente este bot; propostas vêm das conversas privadas dele. Sem ferramentas, sem acesso a outros bots, sem gravação automática.",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Na UI, Ligar… ou Desligar… cria na hora um pedido policy.update que só inverte enabled a partir da política confirmada (mesma expectedRevision, limites, fuso e horário); desligar também desliga manutenção e sonhar, como o host exige. O pedido aparece no painel acima e só vale depois de Aprovar. Desabilitado sem motor configurado (para ligar), com pedido em aberto ou com rascunho em Avançado. Harness: POST .../memory-learning/proposals {clientRequestId, command:{operation:'policy.update', input}}.",
      "approval": "Pedido exige a aprovação exata do dono; nada muda no clique. Nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.harness.memory.status",
      "changeOperation": "dexter.harness.memory.policy.update"
    }
  },
  {
    "op": "update-field",
    "page": "bot-memory-learning",
    "field": "memory.learning.maintenance",
    "entry": {
      "id": "memory.learning.maintenance",
      "title": "Organizar a memória (manutenção) — em Avançado",
      "purpose": "Expirar o que passou da validade e organizar, sem inventar conteúdo.",
      "scope": "Somente este bot.",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Avançado, marque e use Pedir aprovação… (policy.update com maintenanceEnabled). Só com o aprendizado ligado.",
      "approval": "Pedido exige a aprovação exata do dono.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.harness.memory.status",
      "changeOperation": "dexter.harness.memory.policy.update"
    }
  },
  {
    "op": "update-field",
    "page": "bot-memory-learning",
    "field": "memory.learning.dreaming",
    "entry": {
      "id": "memory.learning.dreaming",
      "title": "Revisar nas pausas (sonhar) — em Avançado",
      "purpose": "Revisar em pausas e só propor mudanças.",
      "scope": "Somente este bot. Sem ferramentas e sem acesso a outros bots.",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Avançado, marque e use Pedir aprovação… (policy.update com dreamingEnabled). Só com o aprendizado ligado.",
      "approval": "Pedido exige a aprovação exata do dono.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.harness.memory.status",
      "changeOperation": "dexter.harness.memory.policy.update"
    }
  },
  {
    "op": "add-field",
    "page": "bot-memory-learning",
    "entry": {
      "id": "memory.learning.advanced",
      "title": "Avançado (aprendizado)",
      "purpose": "Abrir manutenção, sonhar, espera, rodadas, propostas, fuso, horário noturno, Rodar a manutenção agora e Atividade recente.",
      "scope": "navegação local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Abra a divulgação; um rascunho aqui nunca muda Ligar/Desligar e é enviado só por Pedir aprovação…. scopeEpoch, policyRevision e expectedRevision continuam exatos; arquivar continua desfazível sem restoreRevision; esquecer continua irreversível e honesto.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-memory-learning",
    "entry": {
      "id": "memory.learning.records.empty",
      "title": "Nada guardado ainda",
      "purpose": "Dizer que lembranças aprovadas aparecem nesta lista.",
      "scope": "Somente este bot.",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "automations",
    "text": "UX-P2-21: dentro dos Ajustes do bot a página Atividade › Automações mostra só Atualizar e Nova automação (o título e o nome do bot já estão na página). A aba interna de execuções chama Execuções (ID automations.tab.history), para não confundir com Atividade › Histórico. O cartão diz a frequência em palavras quando o cron é um dos simples (por exemplo 'Dias úteis às 09:00'), 'Personalizada' nos demais e o fuso só quando difere deste Mac; cron e fuso IANA exatos ficam na dica. Pedir na conversa (automations.ask-bot) é só orientação: o bot recebe dexter.automations.* quando o host expõe o agendamento no turno, e create/update continuam propostas humanas exatas."
  },
  {
    "op": "add-field",
    "page": "automations",
    "entry": {
      "id": "automations.ask-bot",
      "title": "Também dá para pedir na conversa com o bot",
      "purpose": "Dizer que o bot pode propor uma automação na conversa quando as ferramentas do Dexter estão disponíveis, e que ela só existe depois da aprovação do pedido exato.",
      "scope": "conversa do próprio bot",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle; não preenche o composer nem agenda por texto.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "automation-editor",
    "field": "presets",
    "entry": {
      "id": "presets",
      "title": "Repetir: Uma vez / A cada X minutos / Todos os dias / Dias úteis (seg–sex) / Toda semana / Todo mês",
      "purpose": "Configurar calendário civil sem cron.",
      "scope": "host owner-local; harness próprio bot e conversa",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Escolha em Repetir e o horário/dia; o fuso padrão é o deste Mac, dito em palavras (automation-editor.zone-summary). A UI produz kind:cron de cinco campos com o fuso IANA real. As próximas datas são pedidas à base sozinhas para as opções simples (leitura, sem criar nada). Ao editar, uma rotina cujo cron é exatamente um dos simples abre na opção simples, e só se o editor gravaria o mesmo cron e fuso.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": null,
      "changeOperation": "dexter.automations.create"
    }
  },
  {
    "op": "update-field",
    "page": "automation-editor",
    "field": "cron",
    "entry": {
      "id": "cron",
      "title": "Cron avançado (Avançado: cron e fuso horário)",
      "purpose": "Representar regra civil específica.",
      "scope": "host owner-local; harness próprio bot e conversa",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Avançado, Usar uma expressão cron (automation-editor.use-cron) começa com a frequência escolhida; o campo automation-editor.cron recebe cinco campos minuto/hora/dia/mês/dia-da-semana. Personalizada (cron) só aparece em Repetir quando já está em uso. Use Conferir datas antes de salvar.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": null,
      "changeOperation": "dexter.automations.create"
    }
  },
  {
    "op": "update-field",
    "page": "automation-editor",
    "field": "timezone",
    "entry": {
      "id": "timezone",
      "title": "Fuso (Avançado)",
      "purpose": "Fixar interpretação entre hosts/clientes.",
      "scope": "host owner-local; harness próprio bot e conversa",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Em Avançado, Fuso horário IANA ou Usar o fuso deste Mac (automation-editor.timezone-this-mac). Fuso inválido ou diferente deste Mac mantém Avançado aberto e o resumo em laranja.",
      "approval": "Somente se o alias e schema estiverem no tools/list deste turno: proponha o input exato e espere o proprietário permitir a ação. awaiting_approval não é execução; nenhuma ferramenta aprova a própria ação.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": null,
      "changeOperation": "dexter.automations.update"
    }
  },
  {
    "op": "update-field",
    "page": "automation-editor",
    "field": "preview",
    "entry": {
      "id": "preview",
      "title": "Próximas execuções · Conferir datas",
      "purpose": "Conferir sem iniciar engine.",
      "scope": "host owner-local; harness próprio bot e conversa",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem mutação. Para opções simples a prévia é pedida sozinha depois de mudar; para cron, use Conferir datas.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "harness_when_exposed",
      "readOperation": "dexter.automations.preview",
      "changeOperation": null
    }
  },
  {
    "op": "update-field",
    "page": "automation-editor",
    "field": "cancel",
    "entry": {
      "id": "cancel",
      "title": "Cancelar",
      "purpose": "Sair sem envio.",
      "scope": "host owner-local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem mudanças reais (inclusive ao abrir uma rotina existente e não mexer) fecha direto; com mudanças pergunta Descartar e fechar / Continuar editando. Depois de resposta incerta, fechar não comprova ausência de efeito; preserve/reconcilie pedido.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "automation-editor",
    "entry": {
      "id": "automation-editor.advanced",
      "title": "Avançado: cron e fuso horário",
      "purpose": "Guardar cron e fuso IANA fora do caminho comum, com o mesmo poder.",
      "scope": "rascunho local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Abra a divulgação; abre sozinha com cron em uso, fuso inválido ou diferente deste Mac.",
      "approval": "Navegação ou rascunho local, sem concessão ou mutação administrativa. O bot não possui handler para comandar a UI por este manual.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "automation-editor",
    "entry": {
      "id": "automation-editor.zone-summary",
      "title": "Horário deste Mac (…) / Horário de …, diferente deste Mac",
      "purpose": "Dizer em palavras em que fuso as datas valem.",
      "scope": "rascunho local",
      "read": "Leia o estado exibido nesta tela da base conectada. Este manual não consulta o estado nem contém dados do proprietário.",
      "change": "Sem alteração por este controle.",
      "approval": "Leitura não concede escrita, acesso a outros bots ou prova de funcionamento.",
      "result": "Confirme o estado ou receipt retornado. Rascunho, clique ou documentação não prova aplicação nem execução.",
      "recovery": "Se houver conflito ou resultado incerto, releia o estado na mesma base antes de propor outra alteração. Não reenvie automaticamente, não troque de ID para repetir e não descarte rascunhos sem decisão do proprietário.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "settings-general",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "add-note",
    "page": "settings-models",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "add-note",
    "page": "settings-integrations",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "add-note",
    "page": "settings-mac",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "add-note",
    "page": "settings-devices",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "add-note",
    "page": "settings-advanced",
    "text": "Ajustes (⌘,) tem barra lateral: Geral, Assistentes, Conexões, Este Mac e Avançado. Só a página visível fica montada. Rotas antigas models/integrations/devices continuam como aliases; manuais antigos preservam seus IDs. Rascunhos nunca são enviados por navegar."
  },
  {
    "op": "patch-field",
    "page": "settings-general",
    "field": "readiness",
    "values": {
      "title": "Estado da conversa",
      "scope": "Conversa em tela, bot selecionado e base conectada",
      "read": "Estado considera a engine efetiva da conversa após a leitura da seleção; padrão do bot só sem seleção própria. Catálogo/online não provam login, inferência ou ferramentas.",
      "result": "Ferramentas/permissões do Mac não bloqueiam conversa por texto."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-general",
    "field": "refresh-devices",
    "values": {
      "title": "Verificar aparelhos",
      "change": "Agora em Ajustes › Este Mac › Acesso ao computador; GET /v1/devices apenas, sem parear ou conceder acesso."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-general",
    "field": "activate-engines",
    "values": {
      "title": "Ver assistentes",
      "change": "Abre Ajustes › Assistentes. Navegar não instala, ativa ou faz login."
    }
  },
  {
    "op": "add-field",
    "page": "settings-general",
    "entry": {
      "id": "effective-engine",
      "title": "Conversa atual / bot selecionado",
      "purpose": "Identificar de qual assistente o Estado fala.",
      "scope": "Conversa e base atuais",
      "read": "onboarding.effective-engine mostra seleção da conversa/padrão do bot ou modelo ainda não lido.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-general",
    "entry": {
      "id": "welcome-reopen",
      "title": "Mostrar boas-vindas",
      "purpose": "Reabrir a escolha inicial de assistente.",
      "scope": "Cliente owner-loopback",
      "read": "settings.welcome.reopen, somente quando o app administra a base.",
      "change": "Abre a folha Quem vai conversar com você?; nada é criado por abrir.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "patch-field",
    "page": "settings-models",
    "field": "allow-local-engines",
    "values": {
      "title": "Usar assistente neste Mac",
      "change": "settings.local-engines.<kind> altera rascunho; Programa e Escolher ficam em Detalhes técnicos. Só Aplicar e reiniciar salva. Não encontrado permanece indisponível.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "settings-models",
    "field": "engine-readiness",
    "values": {
      "title": "Assistentes nesta base",
      "read": "Lista à esquerda com nome, versão e estado da consulta. Encontrada/pronta não prova login ou assinatura. Detalhes à direita; verificado há mostra idade do catálogo."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-models",
    "field": "dexter-tools",
    "values": {
      "title": "Ferramentas do Dexter (movido)",
      "change": "A pausa geral agora está em Ajustes › Avançado, controle dexter-tools-pause. Este ID antigo permanece como referência.",
      "availability": "unavailable"
    }
  },
  {
    "op": "add-note",
    "page": "settings-models",
    "text": "Válido para todos os bots da base. Cada bot escolhe seu modelo em Ajustes do bot e cada conversa pode escolher outro modelo no chat. Login continua no programa oficial. Programa, 1Password e canal criptografado ficam em Detalhes/Avançado deste Mac; não há descoberta automática de conta/plano."
  },
  {
    "op": "add-note",
    "page": "settings-advanced",
    "text": "Produto empacotado mostra Diagnóstico e recuperação de armazenamento. Endereço HTTP, Usar host local e fixture existem só em build de desenvolvimento não empacotada; nunca substituir dados do proprietário por demonstração. Relatório copiado contém apenas metadados seguros, sem endereço/porta/IDs/contas/mensagens/caminhos/chaves."
  },
  {
    "op": "patch-field",
    "page": "settings-advanced",
    "field": "host-address",
    "values": {
      "availability": "unavailable",
      "change": "Somente build de desenvolvimento não empacotada; este controle não aparece no produto instalado."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-advanced",
    "field": "use-local-host",
    "values": {
      "availability": "unavailable",
      "change": "Somente build de desenvolvimento não empacotada; este controle não aparece no produto instalado."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-advanced",
    "field": "demo-fixture",
    "values": {
      "availability": "unavailable",
      "change": "Somente build de desenvolvimento não empacotada; este controle não aparece no produto instalado."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-advanced",
    "field": "reset-storage",
    "values": {
      "title": "Recuperar e reconectar a este Mac",
      "change": "settings.reset-storage.confirm exige gesto humano. Remove somente snapshot ilegível do cliente e grava base local real; não reseta o host e não usa demonstração.",
      "recovery": "Não é rollback. Pedido perdido no snapshot danificado exige conferir no host se já foi aplicado; não reenviar por inferência."
    }
  },
  {
    "op": "add-field",
    "page": "settings-advanced",
    "entry": {
      "id": "diagnostics",
      "title": "Diagnóstico: Base e versão",
      "purpose": "Ler conexão e versão em palavras simples.",
      "scope": "Cliente e base conectada",
      "read": "settings.diagnostics.base e settings.diagnostics.version.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-advanced",
    "entry": {
      "id": "diagnostics-refresh",
      "title": "Atualizar conexão",
      "purpose": "Reler a base atual.",
      "scope": "Cliente e base atual",
      "read": "settings.diagnostics.refresh.",
      "change": "Relê health/catálogo/dispositivos; não muda base nem reenvia.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-advanced",
    "entry": {
      "id": "diagnostics-copy",
      "title": "Copiar diagnóstico",
      "purpose": "Copiar metadados seguros para suporte.",
      "scope": "Cliente local",
      "read": "settings.diagnostics.copy.",
      "change": "Gesto copia versão/macOS/base/armazenamento/estado de assistentes; o proprietário decide onde colar.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-advanced",
    "entry": {
      "id": "dexter-tools-pause",
      "title": "Ferramentas do Dexter",
      "purpose": "Pausar/ligar o caminho de ferramentas desta base.",
      "scope": "Base empacotada iniciada por este app",
      "read": "settings.dexter-tools.state mostra Ligadas/Pausadas; controle indisponível se nenhum assistente habilitado ou frase-senha necessária.",
      "change": "settings.dexter-tools.toggle pede confirmação e inverte só allowsDexterTools; parada segura/reinício da base própria.",
      "approval": "Gesto humano com confirmação; nenhuma autorização nova para bots.",
      "result": "Preferência salva; catálogo relido. Não altera grants, denies, modos ou tipos aceitos.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-integrations",
    "entry": {
      "id": "services-catalog",
      "title": "Conectar apps",
      "purpose": "Informar a implementação atual do catálogo.",
      "scope": "Base conectada",
      "read": "Esta UI ainda contém nota de catálogo indisponível. Backend Connections/Composio e SDK existem; managed service sem configuração fica unconfigured.",
      "change": "Nova UI de contas em implementação; consultar connections. Não iniciar OAuth fingido.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "unavailable",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-integrations",
    "entry": {
      "id": "browser-use-card",
      "title": "Navegador na nuvem",
      "purpose": "Mostrar conexão e ação principal juntas.",
      "scope": "Base deste Mac",
      "read": "Cartão Browser Use: Consultando/Não conectado/Precisa reconectar/Pausado/Não confirmado/Desativado/Conectado; consulte browser-use-global.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "settings-integrations",
    "text": "MCP direto continua no editor Conexão personalizada (MCP), em Avançado. Composio é o adaptador gerenciado real na fonte; Nango/Pipedream são pesquisa. Sem serviço/chave confiável injetados no host, managed apps permanecem unconfigured, sem OAuth. Nenhuma identidade de conta ou login é inventada."
  },
  {
    "op": "add-field",
    "page": "settings-mac",
    "entry": {
      "id": "computer-access",
      "title": "Acesso ao computador",
      "purpose": "Consultar ou navegar nos passos do agente deste Mac.",
      "scope": "Agente deste Mac e base conectada",
      "read": "settings.computer-access.count mostra conexão do agente confirmada ou não confirmada. observe/control mostram capacidade anunciada, não anunciada ou aguardando agente. Nenhuma dessas projeções confirma TCC, autorização local/grant ou sessão. Controle de tela… abre a preparação guiada; leia mac-screen-control sob demanda.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-mac",
    "entry": {
      "id": "computer-access-check",
      "title": "Verificar de novo",
      "purpose": "Consultar ou navegar nos passos do agente deste Mac.",
      "scope": "Agente deste Mac e base conectada",
      "read": "settings.computer-access.check relê /v1/devices.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-mac",
    "entry": {
      "id": "computer-access-later",
      "title": "Configurar depois",
      "purpose": "Consultar ou navegar nos passos do agente deste Mac.",
      "scope": "Agente deste Mac e base conectada",
      "read": "settings.computer-access.later/.resume recolhe/mostra os passos nesta sessão.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "settings-mac",
    "entry": {
      "id": "computer-access-one-click",
      "title": "Preparar este Mac",
      "purpose": "Consultar ou navegar nos passos do agente deste Mac.",
      "scope": "Agente deste Mac e base conectada",
      "read": "settings.computer-access.prepare abre mac-auto-setup em pacote próprio com auxiliares assinados e base online. Leia o manual mac-auto-setup sob demanda; ausência do pacote/base permanece indisponível.",
      "change": "Gesto humano Preparar este Mac abre a sheet; preparação, pareamento e permissões seguem controles privados reais separados. Não há handler no harness.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "settings-mac",
    "text": "Os estados do agente e capacidades oferecidas não consultam TCC do macOS. Ver/controlar tela precisam do fluxo privado e consentimento humano apropriado; pareamento do app não concede grants a bots."
  },
  {
    "op": "patch-field",
    "page": "settings-devices",
    "field": "refresh",
    "values": {
      "title": "Atualizar aparelhos",
      "change": "settings.devices.refresh no cabeçalho (⌘R); relê somente o registro da base."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-devices",
    "field": "rename",
    "values": {
      "title": "Renomear aparelho",
      "change": "device.more.<id> › Renomear… abre folha; mesmo CAS/receipt existentes."
    }
  },
  {
    "op": "patch-field",
    "page": "settings-devices",
    "field": "revoke",
    "values": {
      "title": "Remover aparelho",
      "change": "device.more.<id> › Remover… exige confirmação device.confirm-revoke.<id>; mesmo contrato de revogação existente."
    }
  },
  {
    "op": "add-note",
    "page": "settings-devices",
    "text": "Permissões por bot e Conferir ficam visíveis. Detalhes de alteração incerta podem descartar só o aviso local por confirmação, sem mudar o host, repetir efeito ou provar reversão."
  },
  {
    "op": "add-note",
    "page": "paired-host",
    "text": "Conectar a outra base usa folha própria por Este Mac › Outra base, Diagnóstico ou Arquivo. Convite inválido não desconecta a base atual. Convite válido troca a base mostrada; Voltar à base deste Mac não revoga nem esquece a outra base. Chave do cliente só é criada no gesto Pedir aprovação. O app ainda não tem rota para criar convites do dono; CLI existente é distinto deste fluxo consumidor, nova API em implementação."
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "offer",
    "values": {
      "title": "Convite recebido do dono",
      "read": "settings.paired-bundle + connect-other-base.paste. Código só fica em memória durante claim.",
      "change": "Colar só no clique; Continuar decodifica antes de mudar a base. Texto inválido mostra invitation-rejected e preserva a conexão atual.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "identity",
    "values": {
      "title": "Identidade deste Mac",
      "change": "settings.begin-pairing cria a chave somente após Pedir aprovação, se readyToProvision; identityReady segue para claim(name:). Mesmos contratos e journal.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "claim",
    "values": {
      "title": "Pedir aprovação",
      "change": "settings.begin-pairing envia pedido com nome editável ≤120. Não configura grants de bots. ACK perdido fica não confirmado; não reenviar.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "restore",
    "values": {
      "title": "Conferir aprovação / Conectar",
      "change": "settings.restore-pairing consulta restoreOrCheckApproval, restauração/GET apenas. Não gera convite ou claim novo.",
      "availability": "human_only"
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "connect-other-base-open",
      "title": "Conectar a outra base…",
      "purpose": "Abrir a folha privada do vínculo.",
      "scope": "Cliente Mac",
      "read": "settings.connect-other-base; settings.diagnostics.connect-other-base; menu Arquivo.",
      "change": "Abre a folha; nada importado.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "pairing-scopes",
      "title": "O convite pede / Aprovado para este app",
      "purpose": "Ler permissões oferecidas e concedidas.",
      "scope": "Cliente Mac e convite/base capturados",
      "read": "connect-other-base.scopes e scope.<id>. outputs.read = Ver e baixar arquivos; outputs.manage = Alterar pasta de arquivos. Alterar não inclui ver; só há escopo explicitamente oferecido pelo dono.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "pairing-offer.scopes",
      "title": "Escopos para convite do dono",
      "purpose": "Descrever o slot reservado à criação privada de convite.",
      "scope": "Proprietário da base",
      "read": "PairingScopeSelection tem 8 escopos históricos explícitos e outputs.read/manage desligados no início.",
      "change": "Ainda sem rota do dono no app: componente não é controle funcional nesta composição. Não criar convite por documentação.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "unavailable",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "pairing-state",
      "title": "Situação da outra base",
      "purpose": "Ler vínculo em linguagem simples.",
      "scope": "Cliente Mac",
      "read": "connect-other-base.state: sem base, convite aceito, aguardando dono, conectado, desconectado ou removido.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "pairing-details",
      "title": "Detalhes técnicos",
      "purpose": "Ler endereço/instalação/escopos sob demanda.",
      "scope": "Cliente Mac",
      "read": "connect-other-base.details fica recolhido; não é mostrado na página principal Este Mac.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "paired-host",
    "entry": {
      "id": "return-local",
      "title": "Voltar à base deste Mac",
      "purpose": "Trocar a base mostrada de modo explícito.",
      "scope": "Cliente Mac",
      "read": "Menu ⋯ da folha.",
      "change": "connect-other-base.return-local usa configureHost para a base deste app; não revoga/forget remoto.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "detach",
    "values": {
      "title": "Esquecer esta base…",
      "change": "Menu ⋯ › settings.detach-pairing com confirmação connect-other-base.confirm-forget. Cliente local se desanexa; registro remoto permanece."
    }
  },
  {
    "op": "patch-field",
    "page": "paired-host",
    "field": "revoke",
    "values": {
      "title": "Remover este Mac da outra base…",
      "change": "Menu ⋯ › settings.revoke-pairing com confirmação confirm-remove; somente conectado. Revoga no host; resultado incerto exige Conferir."
    }
  },
  {
    "op": "add-note",
    "page": "voice-global",
    "text": "Um botão chat.voice decide pela engine EFETIVA da conversa e status real da base. Time/Grupo nunca recebe o botão. Native Codex usa programa/login oficial; voz ao vivo OpenAI usa chave da API do dono e cobrança distinta. Codex sem native pronto nunca cai automaticamente para API: só escolha explícita. Sessão em andamento conserva seu caminho. Nenhuma leitura liga microfone."
  },
  {
    "op": "add-note",
    "page": "chat-live",
    "text": "Um botão chat.voice decide pela engine EFETIVA da conversa e status real da base. Time/Grupo nunca recebe o botão. Native Codex usa programa/login oficial; voz ao vivo OpenAI usa chave da API do dono e cobrança distinta. Codex sem native pronto nunca cai automaticamente para API: só escolha explícita. Sessão em andamento conserva seu caminho. Nenhuma leitura liga microfone."
  },
  {
    "op": "add-note",
    "page": "native-codex-voice",
    "text": "Um botão chat.voice decide pela engine EFETIVA da conversa e status real da base. Time/Grupo nunca recebe o botão. Native Codex usa programa/login oficial; voz ao vivo OpenAI usa chave da API do dono e cobrança distinta. Codex sem native pronto nunca cai automaticamente para API: só escolha explícita. Sessão em andamento conserva seu caminho. Nenhuma leitura liga microfone."
  },
  {
    "op": "add-note",
    "page": "bot-voice",
    "text": "Um botão chat.voice decide pela engine EFETIVA da conversa e status real da base. Time/Grupo nunca recebe o botão. Native Codex usa programa/login oficial; voz ao vivo OpenAI usa chave da API do dono e cobrança distinta. Codex sem native pronto nunca cai automaticamente para API: só escolha explícita. Sessão em andamento conserva seu caminho. Nenhuma leitura liga microfone."
  },
  {
    "op": "patch-field",
    "page": "chat-live",
    "field": "chat.live-voice.start",
    "values": {
      "title": "Entrada de voz anterior (movida)",
      "availability": "unavailable",
      "change": "ID legado preservado no manual. Use chat.voice para abrir/configurar; não existe mais botão separado Live/telefone."
    }
  },
  {
    "op": "patch-field",
    "page": "native-codex-voice",
    "field": "chat.voice-call.open",
    "values": {
      "title": "Entrada de voz anterior (movida)",
      "availability": "unavailable",
      "change": "ID legado preservado no manual. Use chat.voice para abrir/configurar; não existe mais botão separado Live/telefone."
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "chat.voice",
      "title": "Voz",
      "purpose": "Abrir o caminho de voz compatível com esta conversa.",
      "scope": "Conversa privada e base capturadas",
      "read": "AX Voz com valor do estado. Carregando seleção/status desabilita; engine indisponível/custo são explicados.",
      "change": "Native pronto abre folha (microfone só em Ligar). Outro assistente com Live pronto inicia Live por gesto. Codex sem native mostra opções explícitas; sem caminho pronto abre Configurar voz.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Estado vem do controller/status e do caminho escolhido; nenhuma conversão silenciosa de cobrança.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "native-codex-voice",
    "entry": {
      "id": "chat.voice",
      "title": "Voz",
      "purpose": "Abrir o caminho de voz compatível com esta conversa.",
      "scope": "Conversa privada e base capturadas",
      "read": "AX Voz com valor do estado. Carregando seleção/status desabilita; engine indisponível/custo são explicados.",
      "change": "Native pronto abre folha (microfone só em Ligar). Outro assistente com Live pronto inicia Live por gesto. Codex sem native mostra opções explícitas; sem caminho pronto abre Configurar voz.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Estado vem do controller/status e do caminho escolhido; nenhuma conversão silenciosa de cobrança.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "voice-global",
    "entry": {
      "id": "settings.voice.native.status",
      "title": "Chamada nativa do Codex",
      "purpose": "Ler disponibilidade/versão.",
      "scope": "Base conectada",
      "read": "Codex versão/estado de catálogo; cada conversa consulta native-voice/status. Catálogo não prova entitlement de ligação.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "voice-global",
    "entry": {
      "id": "settings.voice.live.status",
      "title": "Voz ao vivo (OpenAI)",
      "purpose": "Ler estado do caminho por API.",
      "scope": "Base local do proprietário",
      "read": "Não consultada/Desligada/Ligada falta chave/Pronta. Chave local nunca enviada à base pareada/VPS.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "voice-global",
    "entry": {
      "id": "settings.voice.live.configure",
      "title": "Configurar voz ao vivo…",
      "purpose": "Abrir a folha privada com os controles existentes.",
      "scope": "Base local do proprietário",
      "read": "settings.voice.live.configure + settings.voice.live.done.",
      "change": "Campos settings.live-voice.* continuam os mesmos, agora na folha privada. Chave limpa ao fechar; cobrança por API explícita.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.reason",
      "title": "Motivo",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "voice-setup.reason explica impedimento atual.",
      "change": "Consulta apenas.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.native",
      "title": "Chamada nativa",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "native/status do controller capturado.",
      "change": "Consulta apenas.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.native.refresh",
      "title": "Conferir de novo",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "Atualiza native status no mesmo escopo.",
      "change": "GET apenas; não inicia chamada.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.live",
      "title": "Voz ao vivo",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "voice-setup.live.status informa chave/estado e custo distinto.",
      "change": "Consulta apenas.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.live.start",
      "title": "Iniciar voz ao vivo",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "Só oferecida como escolha explícita se pronta.",
      "change": "Gesto inicia Live por chave da API; nunca fallback automático.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.open-settings",
      "title": "Abrir Ajustes de voz",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "Abre Assistentes › Voz.",
      "change": "Navegação apenas.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "voice-setup.close",
      "title": "Fechar",
      "purpose": "Entender/escolher voz na folha de configuração.",
      "scope": "Conversa privada e base capturadas",
      "read": "Fecha configuração.",
      "change": "Não muda caminho nem preferências.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-live",
    "entry": {
      "id": "chat.live-voice.failed",
      "title": "Falha de voz ao vivo",
      "purpose": "Mostrar interrupção sem declarar conclusão.",
      "scope": "Sessão viva da conversa",
      "read": "A faixa só aparece com sessão/falha/aviso; não há Live separado na barra. Parar/mute/transcrições continuam.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "bot-voice",
    "entry": {
      "id": "bot-profile.voice.open-settings",
      "title": "Abrir Ajustes de voz",
      "purpose": "Abrir configuração global de voz.",
      "scope": "Cliente atual",
      "read": "BotVoiceSettingsCard mostra caminhos distintos, native só no Codex.",
      "change": "Quando Live desligada, abre Assistentes › Voz; rascunho do bot continua separado.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "chat-model",
    "text": "Composer tem [+] [Voz] [Modelo ▾] [Modo ▾] [ⓘ] [Enviar]. Esforço/velocidade ficam dentro do seletor chat.engine.draft-effort/draft-speed. Menus anteriores effort/speed permanecem somente no seletor do padrão do bot. AX Modelo tem valor legível; ícone por assistente. Parar, anexos e quatro modos conservam os mesmos contratos."
  },
  {
    "op": "patch-field",
    "page": "chat",
    "field": "chat.engine.model-picker",
    "values": {
      "title": "Modelo da conversa",
      "read": "AX Modelo, valor Claude Opus 5.5/Codex padrão etc.; hint informa esforço/velocidade. O padrão do bot pode ser outro.",
      "change": "Abra o seletor; esforço/velocidade só dentro dele. CAS/apply e escopo existentes permanecem."
    }
  },
  {
    "op": "add-field",
    "page": "chat-model",
    "entry": {
      "id": "engine-banner",
      "title": "Estado do assistente da conversa",
      "purpose": "Explicar por que a conversa não pode responder.",
      "scope": "Conversa efetiva",
      "read": "checking/not-reported/routing-off/unavailable/login-required; offline usa linha de conexão. Não instala/login/reenviar.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat-model",
    "entry": {
      "id": "use-alternative",
      "title": "Usar outro assistente nesta conversa",
      "purpose": "Trocar somente a conversa por escolha humana.",
      "scope": "Conversa atual",
      "read": "Só alternativa executável/roteada no catálogo atual; disabled com envio/resposta/aprovação pendente.",
      "change": "chat.engine-banner.use-alternative PATCH engine-selection com revisão esperada; padrão do bot não muda.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito/incerto marca Recarregar; nenhum replay ou troca para terceiro assistente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat",
    "entry": {
      "id": "action-reason",
      "title": "Motivo e hora",
      "purpose": "Ver o motivo sem abrir detalhes.",
      "scope": "Ação concluída desta conversa",
      "read": "approval.reason.<id> mostra hora e motivo canônicos.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat",
    "entry": {
      "id": "action-history-group",
      "title": "N× Ação · Estado",
      "purpose": "Agrupar repetições concluídas adjacentes.",
      "scope": "Conversa atual",
      "read": "Mesma ferramenta/destino/bot/desfecho/motivo; mais recentes primeiro. Pendentes/running nunca agrupadas.",
      "change": "chat.action-history.group.toggle.<id> abre os N cartões; não decide/reexecuta.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "patch-field",
    "page": "app-navigation",
    "field": "sidebar-memory",
    "values": {
      "title": "Memória do bot (movida)",
      "availability": "unavailable",
      "change": "Atalho global removido do rodapé; Memória continua no inspector/menu de contexto e Ajustes do bot."
    }
  },
  {
    "op": "patch-field",
    "page": "app-navigation",
    "field": "host-status",
    "values": {
      "title": "Estado da base",
      "read": "host.status: Neste Mac/Outra base online/offline/nenhuma base; demonstração só desenvolvimento. Popover oferece Diagnóstico e Ajustes. Online não prova login/resposta/execução."
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "connect-apps",
      "title": "Conectar apps",
      "purpose": "Abrir conexões reais desta base.",
      "scope": "Base atual",
      "read": "sidebar.connect-apps.",
      "change": "Abre Ajustes › Conexões. Não simula catálogo/login.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "empty-workspace",
      "title": "Começar / Novo bot",
      "purpose": "Dar a primeira ação sem bots.",
      "scope": "Base atual",
      "read": "workspace.empty.start owner-local ou empty.new-bot nas outras bases.",
      "change": "Abre boas-vindas/Novo bot; nada criado ao abrir.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "inspector-model",
      "title": "Nesta conversa / Modelo do bot",
      "purpose": "Mostrar qual modelo responde aqui.",
      "scope": "Conversa aberta",
      "read": "bot-inspector.thread-model; default-model só se difere. Não confundir padrão do bot e seleção da conversa.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "inspector-pending",
      "title": "Precisa de você › Ver no chat",
      "purpose": "Navegar até a ação pendente exata.",
      "scope": "Conversa atual",
      "read": "bot-inspector.pending.<id> + pending.show.<id>.",
      "change": "Seleciona aquele cartão na fila; não permite nem executa.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "inspector-activity",
      "title": "Atividade recente",
      "purpose": "Ler desfechos agrupados.",
      "scope": "Conversa atual",
      "read": "Até três grupos com motivo/hora e ações em execução separadas.",
      "change": "Somente consulta; nenhuma alteração.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "read_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "app-navigation",
    "entry": {
      "id": "inspector-connections",
      "title": "Conexões deste bot",
      "purpose": "Abrir contas/ferramentas do bot correto.",
      "scope": "Bot e base capturados",
      "read": "bot-inspector.integrations.",
      "change": "Abre Ajustes do bot › Conexões, subseção .mcp.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-note",
    "page": "new-bot",
    "text": "Três sugestões preenchem nome/função editáveis. Disponíveis primeiro; Outros não instalados recolhidos. Criação continua POST sem receipt/clientRequestId. Função é PATCH após criação confirmada com revisão do bot novo, uma vez; incerto não reenvia. Nenhum dados de usuário é substituído."
  },
  {
    "op": "add-field",
    "page": "new-bot",
    "entry": {
      "id": "bot-suggestion",
      "title": "Sugestões",
      "purpose": "Preencher nome e função.",
      "scope": "Base owner",
      "read": "bot.suggestion.assistant|research|writer.",
      "change": "Nada criado até Criar.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "new-bot",
    "entry": {
      "id": "bot-role",
      "title": "Função opcional",
      "purpose": "Definir o que o bot faz.",
      "scope": "Bot a criar na base owner",
      "read": "bot.role e role.notice; edição depende da base.",
      "change": "PATCH de perfil só após criação confirmada; uma tentativa.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Função não salva/resultado incerto são informados; não repetir nem recriar bot automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "patch-field",
    "page": "new-bot",
    "field": "create",
    "values": {
      "title": "Criar / Fechar",
      "change": "bot.save envia um POST; confirmado vira bot.close. Resultado incerto usa conferência da lista, sem replay.",
      "availability": "human_only"
    }
  },
  {
    "op": "add-note",
    "page": "browser-use-global",
    "text": "Um cartão junta estado, chave e ação. Chave guardada não é base pronta: conexão em memória expira em1h/restart. Conectar verifica separadamente guardar no Keychain→entregar pelo canal privado à base própria→ativar por revisão; não é transação nem rollback. Reconectar ocorre no gesto privado ou preflight de Permitir. Base remota/pareada nunca recebe chave local. ACK perdido exige Conferir/GET, sem retry."
  },
  {
    "op": "patch-field",
    "page": "browser-use-global",
    "field": "key",
    "values": {
      "title": "Conectar…",
      "change": "settings.browser-use.connect abre folha com custo e chave; key-input/key-save apenas fluxo privado.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "browser-use-global",
    "field": "unlock",
    "values": {
      "title": "Reconectar",
      "change": "settings.browser-use.reconnect relê estado e entrega chave uma vez à base própria no gesto humano.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "browser-use-global",
    "field": "lock",
    "values": {
      "title": "Pausar conexão",
      "change": "Menu ⋯ › settings.browser-use.pause; mantém chave.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "browser-use-global",
    "field": "remove",
    "values": {
      "title": "Desconectar…",
      "change": "settings.browser-use.disconnect.confirm pausa primeiro; chave apagada somente após pausa confirmada.",
      "availability": "human_only"
    }
  },
  {
    "op": "patch-field",
    "page": "browser-use-global",
    "field": "refresh",
    "values": {
      "title": "Conferir estado",
      "change": "settings.browser-use.check/check-menu consulta apenas; não repetir etapas incertas.",
      "availability": "human_only"
    }
  },
  {
    "op": "add-field",
    "page": "browser-use-global",
    "entry": {
      "id": "tools-prerequisite",
      "title": "Abrir Avançado",
      "purpose": "Explicar ferramentas pausadas.",
      "scope": "Base própria deste Mac",
      "read": "settings.browser-use.tools-prerequisite.",
      "change": "Abre Avançado; não liga ferramentas ou concede acesso.",
      "approval": "Leitura/navegação não concede acesso, instala programas, faz login ou inicia mídia.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "ui_only",
      "readOperation": null,
      "changeOperation": null
    }
  },
  {
    "op": "add-field",
    "page": "chat",
    "entry": {
      "id": "browser-use-preflight",
      "title": "Permitir tarefa Browser Use",
      "purpose": "Reconectar no gesto sem alterar a decisão.",
      "scope": "Ação/bot/conversa/base atuais",
      "read": "Antes de Permitir/Sempre aceitar, relê estado. Pausado/incerto/sem chave/armazenamento indisponível mantém pendente com aviso.",
      "change": "Base própria bloqueada com chave salva: entrega uma vez e confere antes da decisão existente. Negar não faz preflight; remoto não recebe chave local.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conversa/base alterada retira callback. ACK perdido mantém não confirmado e exige Conferir; sem reenvio.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  }
];
const sourcePaths:Readonly<Record<string,readonly string[]>>={
  "bot-settings": [
    "apps/apple/SharedApp/Sources/BotDocumentsView.swift",
    "apps/apple/SharedApp/Sources/MemoryLearningView.swift",
    "apps/apple/SharedApp/Sources/SkillsView.swift"
  ],
  "bot-memory-learning": [
    "apps/apple/SharedApp/Sources/MemoryLearningView.swift"
  ],
  "settings-general": [
    "apps/apple/Sources/DexterAppCore/OnboardingReadiness.swift"
  ],
  "settings-advanced": [
    "apps/apple/Sources/DexterAppCore/OnboardingReadiness.swift"
  ],
  "paired-host": [
    "apps/apple/SharedApp/Sources/ConnectOtherBaseSheet.swift",
    "apps/apple/Sources/DexterAppCore/PairingScopes.swift"
  ],
  "chat-live": [
    "apps/apple/SharedApp/Sources/VoiceEntryButton.swift",
    "apps/apple/Sources/DexterAppCore/VoiceEntry.swift"
  ],
  "chat": [
    "apps/apple/Sources/DexterAppCore/ApprovalPresentation.swift"
  ],
  "new-bot": [
    "apps/apple/SharedApp/Sources/NewBotView.swift"
  ]
};
function apply(input:PageInput):PageInput {
  const fields=new Map(input.fields.map(f=>[f.id,f])); const notes=[...input.notes];
  for(const op of operations){if(op.page!==input.id)continue;
    if(op.op==='replace-note'){if(op.noteIndex===undefined||op.noteIndex>=notes.length)throw new Error('Consumer guide note drift');notes[op.noteIndex]=op.text!;}
    else if(op.op==='add-note')notes.push(op.text!);
    else if(op.op==='patch-field'){if(!fields.has(op.field!))throw new Error(`Consumer guide control drift: ${input.id}/${op.field}`);fields.set(op.field!,Object.freeze({...fields.get(op.field!)!,...op.values}));}
    else if(op.op==='update-field'){if(!fields.has(op.field!))throw new Error(`Consumer guide control drift: ${input.id}/${op.field}`);fields.set(op.field!,Object.freeze({...op.entry!}));}
    else if(op.op==='add-field'){if(fields.has(op.entry!.id))throw new Error(`Consumer guide duplicate: ${input.id}/${op.entry!.id}`);fields.set(op.entry!.id,Object.freeze({...op.entry!}));}
    else throw new Error('Unknown consumer guide operation');
  }
  return {...input,sourcePaths:[...new Set([...input.sourcePaths,...sourcePaths[input.id]??[]])],notes,fields:[...fields.values()]};
}
export function applyConsumerUIGuideOverlays(inputs:readonly PageInput[]):readonly PageInput[]{
  const pages=inputs.map(apply); const byID=new Map(pages.map(p=>[p.id,p]));
  const clone=(id:string,title:string,sources:readonly string[])=>{
    if(byID.has(id))throw new Error('Consumer guide page duplicate');
    const first=byID.get(sources[0]!)!; const fields=new Map<string,Readonly<AppConfigurationGuideField>>();
    for(const source of sources)for(const f of byID.get(source)!.fields)fields.set(f.id,f);
    return {...first,id,title,notes:sources.flatMap(s=>byID.get(s)!.notes),sourcePaths:[...new Set(sources.flatMap(s=>byID.get(s)!.sourcePaths))],fields:[...fields.values()]};
  };
  const routes=[['settings-models','settings-assistants'],['settings-integrations','settings-connections'],['settings-mac','settings-this-mac'],['settings-devices','settings-this-mac']] as const;
  const aliases=[clone('settings-assistants','Ajustes · Assistentes',['settings-models']),clone('settings-connections','Ajustes · Conexões',['settings-integrations']),clone('settings-this-mac','Ajustes · Este Mac',['settings-mac','settings-devices'])];
  for(const [oldID,newID]of routes){const i=pages.findIndex(p=>p.id===oldID);pages[i]={...pages[i]!,notes:[`Referência estável anterior: tela movida para ${newID}. Os controles e contratos abaixo continuam válidos; use a nova página para navegação atual.`,...pages[i]!.notes]};}
  const translate=(text:string)=>text.replaceAll('Ajustes › Modelos','Ajustes › Assistentes').replaceAll('Ajustes › Integrações','Ajustes › Conexões').replaceAll('Ajustes › Dispositivos','Ajustes › Este Mac').replaceAll('Ajustes › Mac','Ajustes › Este Mac');
  return [...pages,...aliases,{
  "id": "first-use",
  "title": "Primeiro uso · Quem vai conversar com você?",
  "scope": "Base owner-loopback iniciada por este app",
  "availability": "human_only",
  "sourcePaths": [
    "apps/apple/SharedApp/Sources/OnboardingWelcomeView.swift",
    "apps/apple/SharedApp/Sources/DexterRootView.swift",
    "apps/apple/Sources/DexterAppCore/OnboardingWelcome.swift"
  ],
  "notes": [
    "Aparece sem bots se não concluída/dispensada; Agora não fica lembrado; Começar/Ajustes Geral reabrem. Catálogo e descoberta só metadados: nada instala ou confirma conta.",
    "Primeira escolha sem preferência salva habilita assistente escolhido + Ferramentas do Dexter e reinicia somente a base própria; preferência salva, inclusive pausa, é preservada. Nenhum grant concedido.",
    "POST de bot não tem receipt/clientRequestId. Conferir lê a lista/adota exatamente um novo bot com nome/engine compatíveis; nada encontrado continua incerto. Criar de novo é decisão humana distinta e avisa possível duplicata."
  ],
  "fields": [
    {
      "id": "welcome-use",
      "title": "Usar assistente",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "welcome.use.<engine>, disponibilidade real.",
      "change": "Escolha humana prepara preferência se ausente, relê catálogo e cria um bot uma vez.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "welcome-check",
      "title": "Verificar de novo",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "welcome.check.<engine>.",
      "change": "Consulta metadados da base/programas; não instala/login.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "welcome-bot-name",
      "title": "Nome do bot",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "welcome.bot-name.",
      "change": "Rascunho local.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "welcome-later",
      "title": "Agora não",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "welcome.later.",
      "change": "Dispensa sem criar/mudar bots.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "welcome-confirm-creation",
      "title": "Conferir",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "Estado de criação incerta.",
      "change": "Só GET da lista; não repetir POST.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    },
    {
      "id": "welcome-create-again",
      "title": "Criar de novo",
      "purpose": "Começar sem configuração técnica.",
      "scope": "Base owner-loopback iniciada por este app",
      "read": "Aviso explícito de duplicata possível.",
      "change": "Nova decisão humana após incerteza; nunca ação automática.",
      "approval": "Gesto humano no fluxo privado apropriado. Não existe handler de mutação no harness para este controle.",
      "result": "Confira o estado exibido na mesma base. Este manual não consulta estado nem comprova aplicação ou execução.",
      "recovery": "Conflito exige releitura; confirmação perdida preserva o pedido original e usa Conferir por GET. Não reenviar mutação, trocar de ID nem trocar de base automaticamente.",
      "availability": "human_only",
      "readOperation": null,
      "changeOperation": null
    }
  ]
} as PageInput].map(p=>({...p,notes:p.notes.map(translate),fields:p.fields.map(f=>Object.freeze({...f,read:translate(f.read),change:translate(f.change),recovery:translate(f.recovery)}))}));
}
