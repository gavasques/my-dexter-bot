# Dexter Bot auto Test

> No código o produto se chama **Dexter** (pacotes `@dexter/*`, `DexterApple.xcodeproj`, bundle ids `com.dexter.bot.mac` / `com.dexter.bot.ios`).

## Como instalar

**Ainda não há binário, DMG, PKG, IPA, versão na App Store ou link do TestFlight para baixar.** O repositório disponibiliza o código do experimento. A página de [Releases](https://github.com/gavasques/my-dexter-bot/releases) não tem instalador publicado; baixar o ZIP do código não instala o aplicativo.

### Preparar e iniciar a base local

Você precisa de um Mac para os apps Apple, Node.js `>=24.14.0 <25`, pnpm `11.0.9`, Git e Xcode completo com suporte a Swift 6.

```sh
git clone https://github.com/gavasques/my-dexter-bot.git
cd my-dexter-bot
npm install --global pnpm@11.0.9
pnpm install --frozen-lockfile
pnpm build
pnpm dexter serve --data-dir .dexter --port 4317
```

Deixe esse terminal aberto enquanto usa a base local. A CLI roda a partir desta cópia do repositório; ela não é um binário independente. Para respostas reais dos modelos, instale e faça login nas CLIs oficiais do Claude/Codex separadamente e use as opções de engines da seção [Build e execução](#build-e-execução). Não compartilhe a pasta `.dexter/` nem as credenciais dessas CLIs.

### Executar o app no Mac (macOS 14+)

1. Abra `apps/apple/DexterApple.xcodeproj` no Xcode.
2. Selecione o scheme **DexterMac** e o destino **My Mac**.
3. Em **Signing & Capabilities**, selecione seu próprio time de desenvolvimento se o Xcode exigir assinatura. O projeto não fornece time nem certificado.
4. Use **Product → Run**. Para a base iniciada no terminal, confirme **Usar host local** com `http://127.0.0.1:4317` nos ajustes do app.
5. Para manter sua própria compilação, encontre **Dexter.app** em Products no Xcode, use **Show in Finder** e copie para **Aplicativos**. Mantenha o repositório e a base compilada disponíveis: copiar o app não empacota Node, a base nem as CLIs dos modelos.

Essa é uma compilação local de desenvolvimento, não um instalador assinado e notarizado para distribuição. Se o macOS rejeitar um app baixado, não desative o Gatekeeper nem remova quarentena indiscriminadamente; compile o código localmente.

### Executar no iPhone (iOS 17+)

No Xcode, selecione **DexterIOS**, conecte seu iPhone, escolha-o como destino, configure seu próprio time de assinatura e use **Product → Run**. Siga os pedidos da Apple para confiar no dispositivo e ativar o Modo de Desenvolvedor, quando necessário. A assinatura de desenvolvimento pode exigir recompilações periódicas. Não há IPA distribuível nem TestFlight publicado.

O iPhone precisa ser pareado com o Mac; `127.0.0.1` no telefone aponta para o próprio telefone. Use o fluxo de pareamento do app em vez de expor a porta 4317 na internet.

## Contexto

Isto foi um teste usando o Grok Bot orquestrando ações dentro do T3 Code na minha VPS. Os agentes podiam escolher entre Claude e Codex, limitados a Opus 5.5 e Sol 6.1; Astra e Fable não eram permitidos. Foram 64 horas de trabalho autônomo, com muitas idas e vindas e muitas decisões erradas. Mas no fim eles chegaram a algo funcional: um app Desktop para Mac e outro para iOS.

Publicado como está, como experimento. Não é um produto mantido.

## Aviso

Este sistema foi criado pelo Grok Bot orquestrando o Claude e o Codex. O código foi gerado por agentes de IA.

- Não sabemos de onde vem todo o código. Os modelos podem ter reproduzido trechos de código existente protegido por direitos autorais ou sob outra licença.
- Não nos responsabilizamos por cópias, forks, redistribuição ou qualquer outro uso deste código, incluindo eventuais violações de direitos autorais ou de licenças. Quem reutilizar qualquer parte é responsável por verificar direitos e licenças.
- É fornecido "como está", sem garantia de qualquer tipo (veja `LICENSE`).
- É apenas um exemplo do que é possível fazer com agentes de IA. Não é um produto nem uma implementação de referência.

Se você tem direitos sobre algum código deste repositório e quer que ele seja removido ou atribuído, entre em contato com o dono do repositório pelo GitHub.

## Contribuições

Este projeto não é mantido e não terá continuidade. Pull requests, issues e pedidos de funcionalidade não são aceitos. Se quiser evoluir o código, faça um fork.

## Capturas de tela

| Mac | iOS |
|---|---|
| ![Mac home (fixture)](docs/screenshots/mac-home-fixture.png) | ![iOS bots (fixture)](docs/screenshots/ios-bots-fixture.png) |
| ![Mac settings: Connections](docs/screenshots/mac-settings-connections.png) | ![iOS chat with approval card (fixture)](docs/screenshots/ios-chat-approval-fixture.png) |
| | ![iOS pairing screen](docs/screenshots/ios-pairing.png) |

## Stack

- Monorepo pnpm (`pnpm@11.0.9`), Node `>=24.14.0 <25`, TypeScript 5.9 (ESM, `tsc -b`).
- `packages/`: hub (autoridade, bots, Times, conversas, runtime de turnos; API Hono), engines (Claude CLI, Codex app-server, ACP e outros adapters), gateway (ferramentas MCP por turno, permissões, revisão, recibos), connectors (cliente MCP), connections-service, context, contracts (zod), cli (`dexter`), agenda (croner), devices e relay*, operations.
- Persistência: SQLite via `node:sqlite` nativo do Node.
- Transporte: API HTTP em loopback. O relay restrito atende os dispositivos pareados.
- `apps/apple`: SwiftUI, Swift 6, macOS 14+ e iOS 17+, só com pacotes Swift locais.
- `third_party/NoodleVoice`: licença Apache-2.0 e NOTICE do código de voz adaptado.
- Visão geral da arquitetura: [docs/architecture.md](docs/architecture.md).

## Build e execução

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm dexter serve --data-dir .dexter --port 4317 --enable-engines --claude-command /caminho/claude --codex-command /caminho/codex
```

Para os apps, abra `apps/apple/DexterApple.xcodeproj` no Xcode e configure o seu próprio time de assinatura.

## Testes

`pnpm typecheck`. A suíte completa (`pnpm test`) exige macOS, Xcode e fixtures preparados.

## Limitações

O projeto é experimental e só foi observado funcionando em instalação local no Mac. VPS, assinatura e distribuição não foram validadas. Não há sandbox do sistema operacional.

## Licença

0BSD. Os componentes de terceiros mantêm suas licenças (veja `THIRD_PARTY_NOTICES.md`).
