# Arquitetura do Dexter

O Dexter separa a base que coordena o trabalho dos clientes que a apresentam e dos executores que oferecem capacidades. A implementação atual inclui um host local no Mac. A intenção de manter uma base sempre ligada na nuvem não comprova implantação nem jobs reais entre uma VPS e o Mac.

## Base, turnos e ferramentas

| Camada | Responsabilidade no código |
|---|---|
| `packages/hub` | Bots, Times, conversas, turnos, ações, grants, aprovações, eventos e recibos; SQLite e controle do escritor |
| `packages/engines` | Drivers de conversa e tradução dos protocolos das engines; Claude CLI e Codex app-server são caminhos primários |
| `packages/gateway` | Catálogo, identidade de capability e exposição de ferramentas no turno |
| `packages/cli` | Composição confiável do host, superfícies de ferramentas e endpoints locais/pareados |
| `packages/context` | Documentos, memória, skills, artifacts e manuais operacionais versionados |
| `packages/connectors` | Runtime de MCP nativo, contas, descoberta, seleção e adapters de serviços |
| `packages/agenda` | Intenções de agendamento, ocorrências e deduplicação; executar depende do host ativo |
| `packages/devices` | Registro, canal de jobs e recibos de executores autorizados |
| `packages/connections-service` | Componente de serviço confiável para conexões gerenciadas; configuração e implantação são etapas separadas |
| `packages/relay*` | Transporte, aceitação e reconciliação de um conjunto fechado de mensagens |
| `apps/apple` | Clientes SwiftUI e módulos/helpers nativos para macOS e iOS |

O [HostStore](../packages/hub/src/store.ts) guarda a autoridade canônica. O [runtime de conversa](../packages/hub/src/runtime.ts) coordena os turnos; [HostServices](../packages/cli/src/host-services.ts) compõe os módulos. Um nome no catálogo não significa instalação, autenticação, grant ou funcionamento observado de uma integração.

## Clientes e canais

O desenvolvimento local usa HTTP em loopback. Apps pareados possuem identidade e escopos próprios em um canal HTTPS/mTLS. O executor de dispositivos tem outro canal e outro ciclo de identidade. Parear um app não o transforma em daemon nem autoriza ferramentas do computador.

O relay não substitui esses contratos. O consumer aceita `turn.submit` e `notice.received`; não é um caminho geral de execução remota de ferramentas, aprovações ou cancelamento. A [fronteira de autoridade do consumer](../packages/relay-consumer/src/ports.ts) inclui um default que nega admissão até existir o adapter confiável correspondente. Componentes e testes locais não certificam operação VPS/Mac em rede externa.

## Dados e recuperação

Conversas e autoridade pertencem ao host. Contexto e journals auxiliares têm seus próprios vínculos e ciclos de vida; um journal de execução não é outra fonte de conversas. Ações incertas conservam sua identidade e recibo para reconciliação. Interromper um processo não demonstra que um efeito foi desfeito.

Os fluxos de custódia e pareamento exigem configuração explícita. A existência de código para Keychain, certificados ou arquivo cifrado não prova persistência sob assinatura final, provisionamento de produção, não exportabilidade ou isolamento contra o mesmo usuário/root. Credenciais, chaves privadas, bancos reais e material de pareamento ficam fora da publicação.

## Permissões e manuais

A identidade de uma ferramenta vem da capability do turno, e permissões/revisões continuam sendo decisões do host. Alterações protegidas precisam do contrato executável correspondente, aprovação quando exigida e receipt/deduplicação. MCPs locais e shells aprovadas executam com a autoridade do usuário do host; mudar diretório ou limpar o ambiente não cria sandbox do sistema operacional.

Os manuais first-party são distribuídos pelo [catálogo de configuração](../packages/context/src/app-configuration-guide.ts) e pelo [índice progressivo do harness](../packages/context/src/harness-guide.ts). São carregados sob demanda. Um manual ou uma skill não instala integrações, não fornece credenciais e não amplia poderes do bot. Configurações humanas e funcionalidades ainda ausentes devem aparecer com essa disponibilidade explícita.

## Estado experimental

O código contém módulos em estágios diferentes. Evidência de fixture, compilação, conversa real, GUI, dispositivo físico, serviço externo e deploy são escopos distintos. Este documento não declara host cloud provisionado, jobs remotos de produção, release Apple assinado/notarizado ou paridade integral com outro produto.
