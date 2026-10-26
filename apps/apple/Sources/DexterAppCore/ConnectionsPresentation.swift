import DexterHostClient
import Foundation

/// Conexões, one row per account or connection: three independent facts, never merged into a single "ready".
/// `account` is what the base reports about the account or connection, `access` is what the saved grants say, and
/// `admission` is whether the current turn admitted the tools. Each axis is read only from its own source, so an unknown
/// on one axis never erases or invents a fact on another. Display only: nothing here decides, grants or retries.
public enum ConnectionFactTone: String, Equatable, Sendable {
    case confirmed, attention, problem, neutral, unknown
    public var symbol: String {
        switch self {
        case .confirmed: "checkmark.circle.fill"
        case .attention: "exclamationmark.circle.fill"
        case .problem: "xmark.octagon.fill"
        case .neutral: "circle"
        case .unknown: "questionmark.circle.fill"
        }
    }
}

public struct ConnectionFact: Equatable, Sendable {
    public enum Axis: String, CaseIterable, Sendable { case account, access, admission }
    public let axis: Axis
    public let tone: ConnectionFactTone
    public let text: String

    public var symbol: String { tone.symbol }
}

/// The one primary verb a row offers. Each maps to an existing operation; none repeats an effect.
public enum ConnectionAction: String, CaseIterable, Equatable, Sendable {
    /// Start the private sign-in of a connection that has none (native OAuth).
    case signIn
    /// A new identified sign-in that replaces this managed account (`replacesAccountId`); never a retry of an action.
    case reconnect
    /// Show the Client ID field of a native OAuth connection whose service refuses automatic registration.
    case enterClientID
    /// GET of the same request/receipt/account. Never a second POST.
    case check
    /// Pick which bots may use the account (separate, reviewed change).
    case chooseBots
    /// A connection that was only registered: review and discover its tools after a separate confirmation.
    case viewTools
    /// The connection runs on another computer; manage it there.
    case openOnOtherComputer
    /// Unlock a 1Password-backed connection (private flow).
    case unlock
    /// Technical details and the specific diagnosis.
    case viewDetails

    public func title(portuguese: Bool) -> String {
        switch self {
        case .signIn: portuguese ? "Entrar…" : "Sign in…"
        case .reconnect: portuguese ? "Reconectar…" : "Reconnect…"
        case .enterClientID: portuguese ? "Informar Client ID…" : "Enter Client ID…"
        case .check: portuguese ? "Conferir" : "Check"
        case .chooseBots: portuguese ? "Escolher bots…" : "Choose bots…"
        case .viewTools: portuguese ? "Ver ferramentas…" : "View tools…"
        case .openOnOtherComputer: portuguese ? "Ver onde roda" : "See where it runs"
        case .unlock: portuguese ? "Desbloquear…" : "Unlock…"
        case .viewDetails: portuguese ? "Ver detalhes" : "View details"
        }
    }
}

public struct ConnectionRowFacts: Equatable, Sendable {
    public let account: ConnectionFact
    public let access: ConnectionFact
    public let admission: ConnectionFact
    /// At most one primary verb; nil when the row has nothing to recover.
    public let action: ConnectionAction?
    public var all: [ConnectionFact] { [account, access, admission] }
}

/// Proof that the engine/driver admitted the tools in the current turn. The current contracts carry no such proof, so
/// every caller passes `.notProven` and the row never says "Disponível nesta conversa".
public enum ConnectionAdmissionEvidence: Equatable, Sendable { case notProven, provenInCurrentTurn }

public enum ConnectionsPresentation {
    // MARK: Managed accounts (Conectar apps)

    /// `accessUnconfirmed`: an access change of this account whose receipt was not read yet. `disconnectUnconfirmed`: a
    /// disconnect of this account with an open outcome. Both make only their own axis unknown.
    public static func managed(_ account: ConnectionAccount, accessUnconfirmed: Bool = false, disconnectUnconfirmed: Bool = false,
                               admission: ConnectionAdmissionEvidence = .notProven, portuguese: Bool) -> ConnectionRowFacts {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        let accountFact: ConnectionFact, accountAction: ConnectionAction?
        let usable: Bool?
        if disconnectUnconfirmed {
            accountFact = ConnectionFact(axis: .account, tone: .unknown, text: t("Desconexão não confirmada", "Disconnect not confirmed"))
            accountAction = .check; usable = nil
        } else {
            switch account.status {
            case .connected:
                accountFact = ConnectionFact(axis: .account, tone: .confirmed, text: account.identity.confirmation == .providerVerified
                    ? t("Conta conectada", "Account connected") : t("Conectada · conta não confirmada", "Connected · account not confirmed"))
                accountAction = nil; usable = true
            case .needsReconnect:
                accountFact = ConnectionFact(axis: .account, tone: .attention, text: t("Entre novamente para reconectar", "Sign in again to reconnect"))
                accountAction = .reconnect; usable = false
            case .identityMismatch:
                accountFact = ConnectionFact(axis: .account, tone: .problem, text: t("Outra conta apareceu; ela foi parada", "Another account appeared; it was stopped"))
                accountAction = .reconnect; usable = false
            case .disconnecting:
                accountFact = ConnectionFact(axis: .account, tone: .neutral, text: t("Desconectando…", "Disconnecting…"))
                accountAction = .check; usable = false
            case .disconnected:
                accountFact = ConnectionFact(axis: .account, tone: .neutral, text: t("Desconectada", "Disconnected"))
                accountAction = nil; usable = false
            case .replaced:
                accountFact = ConnectionFact(axis: .account, tone: .neutral, text: t("Substituída por outra conexão", "Replaced by another connection"))
                accountAction = nil; usable = false
            case .unknown:
                accountFact = ConnectionFact(axis: .account, tone: .unknown, text: t("Estado da conta não confirmado", "Account state not confirmed"))
                accountAction = .check; usable = nil
            }
        }
        let enabled = account.bots.filter { $0.access == .enabled }.count
        let partial = account.bots.filter { $0.access == .partial }.count
        let accessFact: ConnectionFact
        let granted: Bool?
        if accessUnconfirmed {
            accessFact = ConnectionFact(axis: .access, tone: .unknown, text: t("Mudança de acesso não confirmada", "Access change not confirmed"))
            granted = nil
        } else if enabled + partial == 0 {
            accessFact = ConnectionFact(axis: .access, tone: .neutral, text: t("Nenhum bot usa esta conta", "No bot uses this account"))
            granted = false
        } else if partial > 0 {
            accessFact = ConnectionFact(axis: .access, tone: .attention, text: portuguese
                ? "Acesso parcial · \(enabled + partial) \(enabled + partial == 1 ? "bot" : "bots")"
                : "Partial access · \(enabled + partial) \(enabled + partial == 1 ? "bot" : "bots")")
            granted = true
        } else {
            accessFact = ConnectionFact(axis: .access, tone: .confirmed, text: portuguese
                ? "Acesso liberado · \(enabled) \(enabled == 1 ? "bot" : "bots")"
                : "Access granted · \(enabled) \(enabled == 1 ? "bot" : "bots")")
            granted = true
        }
        let admissionFact = Self.admission(usable: usable, granted: granted, evidence: admission, portuguese: portuguese)
        let action = accountAction ?? (accessUnconfirmed ? .check : (granted == false && usable == true ? .chooseBots : nil))
        return ConnectionRowFacts(account: accountFact, access: accessFact, admission: admissionFact, action: action)
    }

    // MARK: Native MCP connections (Avançado)

    /// Native connections keep per-bot selections on the native MCP routes, which this row does not read; the access
    /// axis says where to see them instead of guessing a count.
    public static func native(server: McpServerSummary, credentials: McpCredentialStatus?, admission: ConnectionAdmissionEvidence = .notProven,
                              portuguese: Bool) -> ConnectionRowFacts {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        let matching = credentials.flatMap { $0.serverId == server.id && $0.auth == server.auth ? $0 : nil }
        let accountFact: ConnectionFact, action: ConnectionAction?
        var usable: Bool? = false
        if server.status == "unavailable_here" {
            accountFact = ConnectionFact(axis: .account, tone: .attention, text: t("Roda em outro computador", "Runs on another computer"))
            action = .openOnOtherComputer
        } else if server.auth != "none", matching == nil {
            accountFact = ConnectionFact(axis: .account, tone: .unknown, text: t("Login não consultado", "Sign-in not checked"))
            action = .check; usable = nil
        } else if let credentials = matching, credentials.state == "authorizing" {
            accountFact = ConnectionFact(axis: .account, tone: .neutral, text: t("Aguardando seu login", "Waiting for your sign-in"))
            action = .check
        } else if let credentials = matching, let error = credentials.lastError, !credentials.isReady,
                  let code = McpAuthenticationDiagnosticError.Code(rawValue: error) {
            let diagnosis = diagnostic(code, service: server.name, portuguese: portuguese)
            accountFact = ConnectionFact(axis: .account, tone: code == .oauthClientRequired || code == .oauthMetadataInvalid ? .problem : .attention,
                                         text: diagnosis.short)
            action = diagnosis.action
        } else if let credentials = matching, credentials.state == "unavailable" {
            accountFact = ConnectionFact(axis: .account, tone: .attention, text: t("Login indisponível neste host", "Sign-in unavailable on this host"))
            action = .viewDetails
        } else if let credentials = matching, !credentials.isReady {
            let broker = server.auth == "broker"
            accountFact = ConnectionFact(axis: .account, tone: .attention, text: broker
                ? t("Credenciais bloqueadas", "Credentials locked") : t("Entre na sua conta", "Sign in to your account"))
            action = broker ? .unlock : .signIn
        } else if server.auth == "none", server.status == "needs_auth" || server.diagnostic?.code == "needs_auth" {
            accountFact = ConnectionFact(axis: .account, tone: .attention, text: t("O serviço pediu login", "The service asked for sign-in"))
            action = .viewDetails
        } else if server.status == "failed" {
            accountFact = ConnectionFact(axis: .account, tone: .problem, text: t("Descoberta não concluída", "Discovery not completed"))
            action = .viewDetails
        } else if server.status == "ready" {
            accountFact = ConnectionFact(axis: .account, tone: .confirmed, text: server.auth == "none"
                ? t("Conectada · sem login", "Connected · no sign-in") : t("Conectada · conta não verificada", "Connected · account not verified"))
            action = nil; usable = true
        } else {
            accountFact = ConnectionFact(axis: .account, tone: .neutral, text: t("Conexão adicionada", "Connection added"))
            action = .viewTools
        }
        let accessFact = ConnectionFact(axis: .access, tone: .neutral, text: t("Acesso por bot: nos ajustes de cada bot", "Per-bot access: in each bot's settings"))
        let admissionFact: ConnectionFact
        if admission == .provenInCurrentTurn, usable == true {
            admissionFact = ConnectionFact(axis: .admission, tone: .confirmed, text: t("Disponível nesta conversa", "Available in this conversation"))
        } else if usable == true {
            admissionFact = ConnectionFact(axis: .admission, tone: .neutral, text: t("Bots com ferramentas salvas: próximo turno", "Bots with saved tools: next turn"))
        } else if usable == nil {
            admissionFact = ConnectionFact(axis: .admission, tone: .unknown, text: t("Não confirmado", "Not confirmed"))
        } else {
            admissionFact = ConnectionFact(axis: .admission, tone: .neutral, text: t("Não disponível", "Not available"))
        }
        return ConnectionRowFacts(account: accountFact, access: accessFact, admission: admissionFact, action: action)
    }

    private static func admission(usable: Bool?, granted: Bool?, evidence: ConnectionAdmissionEvidence, portuguese: Bool) -> ConnectionFact {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        if usable == nil || granted == nil {
            return ConnectionFact(axis: .admission, tone: .unknown, text: t("Não confirmado", "Not confirmed"))
        }
        guard usable == true, granted == true else {
            return ConnectionFact(axis: .admission, tone: .neutral, text: t("Não disponível", "Not available"))
        }
        if evidence == .provenInCurrentTurn {
            return ConnectionFact(axis: .admission, tone: .confirmed, text: t("Disponível nesta conversa", "Available in this conversation"))
        }
        return ConnectionFact(axis: .admission, tone: .neutral, text: t("Entra no próximo turno", "Enters on the next turn"))
    }

    // MARK: Sign-in diagnostics

    public struct Diagnosis: Equatable, Sendable {
        /// Row label (a few words).
        public let short: String
        /// One specific sentence for the detail; never an upstream message.
        public let sentence: String
        public let action: ConnectionAction
    }

    /// One sentence and one recovery verb per private authentication code. No code infers another login method: an API
    /// key is never suggested from an error.
    public static func diagnostic(_ code: McpAuthenticationDiagnosticError.Code, service: String, portuguese: Bool) -> Diagnosis {
        let name = service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? (portuguese ? "O serviço" : "The service") : service
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        switch code {
        case .custodyUnavailable:
            return Diagnosis(short: t("Cofre de chaves indisponível", "Key vault unavailable"),
                     sentence: t("O 1Password configurado para esta base não está disponível. Confira o cofre nas opções do host local e atualize.",
                               "The 1Password vault configured for this host is unavailable. Check it in the local host options and refresh."),
                     action: .viewDetails)
        case .credentialLocked:
            return Diagnosis(short: t("Credenciais bloqueadas", "Credentials locked"),
                     sentence: t("As credenciais desta conexão estão bloqueadas. Desbloqueie com o 1Password ou restaure a autorização.",
                               "This connection's credentials are locked. Unlock them with 1Password or restore the authorization."),
                     action: .unlock)
        case .credentialRefused:
            return Diagnosis(short: t("Chaves não entregues", "Keys not provided"),
                     sentence: t("O 1Password não entregou as chaves pedidas. Confira o acesso ao cofre e os campos necessários.",
                               "1Password did not provide the requested keys. Check vault access and the required fields."),
                     action: .viewDetails)
        case .oauthUnavailable:
            return Diagnosis(short: t("Login desativado neste host", "Sign-in turned off on this host"),
                     sentence: t("A autorização desta conexão não está ativa neste host. Ative-a nas opções do host local e atualize.",
                               "Authorization for this connection is not active on this host. Turn it on in the local host options and refresh."),
                     action: .viewDetails)
        case .oauthClientRequired:
            return Diagnosis(short: t("Exige Client ID", "Client ID required"),
                     sentence: t("\(name) não aceitou o cadastro automático do Dexter. Para entrar, informe um Client ID compatível: app nativo, PKCE e o redirect do Dexter.",
                               "\(name) did not accept Dexter's automatic registration. To sign in, enter a compatible Client ID: native app, PKCE and Dexter's redirect."),
                     action: .enterClientID)
        case .oauthMetadataInvalid:
            return Diagnosis(short: t("Login ainda não compatível", "Sign-in not yet compatible"),
                     sentence: t("\(name) não anuncia um login compatível (OAuth 2.1 com PKCE). Nada foi conectado.",
                               "\(name) does not announce a compatible sign-in (OAuth 2.1 with PKCE). Nothing was connected."),
                     action: .viewDetails)
        case .oauthFlowFailed:
            return Diagnosis(short: t("Login não preparado", "Sign-in not prepared"),
                     sentence: t("\(name) recusou a preparação do login. Nada foi conectado; você pode tentar de novo com um novo pedido.",
                               "\(name) refused to prepare the sign-in. Nothing was connected; you can try again with a new request."),
                     action: .signIn)
        case .oauthDenied:
            return Diagnosis(short: t("Login não concedido", "Sign-in not granted"),
                     sentence: t("O login não foi concedido em \(name). Nada foi conectado.",
                               "Sign-in was not granted at \(name). Nothing was connected."),
                     action: .signIn)
        case .oauthStateMismatch:
            return Diagnosis(short: t("Retorno do login descartado", "Sign-in return discarded"),
                     sentence: t("O retorno do login não correspondeu a este pedido e foi descartado. Confira o estado antes de entrar de novo.",
                               "The sign-in return did not match this request and was discarded. Check the state before signing in again."),
                     action: .check)
        case .oauthExpired:
            return Diagnosis(short: t("Prazo do login terminou", "Sign-in window ended"),
                     sentence: t("O prazo para concluir o login terminou. Comece um novo login.",
                               "The time to finish signing in ended. Start a new sign-in."),
                     action: .signIn)
        case .needsAuth:
            return Diagnosis(short: t("Entre na sua conta", "Sign in to your account"),
                     sentence: t("Entre na sua conta de \(name) para os bots poderem usar esta conexão.",
                               "Sign in to your \(name) account so bots can use this connection."),
                     action: .signIn)
        case .placementUnavailable:
            return Diagnosis(short: t("Roda em outro computador", "Runs on another computer"),
                     sentence: t("Esta conexão está configurada para outro computador. Abra-a no host onde ela roda.",
                               "This connection is configured for another computer. Open it on the host where it runs."),
                     action: .openOnOtherComputer)
        }
    }

    /// The same diagnosis from a `credentials.lastError` value; nil for values outside the closed set.
    public static func diagnostic(code: String, service: String, portuguese: Bool) -> Diagnosis? {
        McpAuthenticationDiagnosticError.Code(rawValue: code).map { diagnostic($0, service: service, portuguese: portuguese) }
    }

    /// Exactly what to ask the service for when it refuses automatic registration.
    public static func clientIDRequest(service: String, portuguese: Bool) -> String {
        portuguese
            ? "Peça a \(service) um Client ID público para app nativo, com PKCE e o endereço de retorno (redirect) que o Dexter mostra ao entrar. Cole aqui só o ID; nunca um segredo."
            : "Ask \(service) for a public Client ID for a native app, with PKCE and the return address (redirect) Dexter shows when signing in. Paste only the ID here; never a secret."
    }

    // MARK: Local processes and discovery

    /// Where the host runs a native connection (`runsOn`), in plain words. Unknown values are shown as they are.
    public static func placement(_ runsOn: String, portuguese: Bool) -> String {
        switch runsOn {
        case "owner_mac": portuguese ? "Roda no Mac do dono da base" : "Runs on the host owner's Mac"
        case "cloud": portuguese ? "Roda na base na nuvem" : "Runs on the cloud host"
        case "any": portuguese ? "Roda no host que atender a conexão" : "Runs on whichever host serves the connection"
        default: runsOn
        }
    }

    /// Where a native connection runs, from the host's executor report. "Respondeu esta leitura" is the most it says: the
    /// executor answered this read; it is never a claim that the upstream server or process is online.
    public static func executorLine(_ executor: McpServerExecutor?, runsOn: String, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        guard let executor else { return placement(runsOn, portuguese: portuguese) }
        let place = placement(executor.placement.rawValue, portuguese: portuguese)
        if executor.reachable == true {
            let name = executor.name ?? t("esta base", "this host")
            return t("\(place) · executor \(name) respondeu esta leitura (não indica se o serviço está no ar)",
                     "\(place) · executor \(name) answered this read (does not say whether the service is up)")
        }
        return t("\(place) · outro executor; o estado dele não foi informado por esta base",
                 "\(place) · another executor; this host did not report its state")
    }

    /// Review of a local process' executable and arguments, from `command-status`. `blocksDiscovery` when what would run
    /// differs from what was reviewed: recovery is restoring the reviewed program/arguments or removing and registering
    /// again, never discovering over the review.
    public struct CommandReview: Equatable, Sendable {
        public let tone: ConnectionFactTone
        public let headline: String
        public let detail: String
        public let blocksDiscovery: Bool
    }

    public static func commandReview(_ status: McpCommandStatus?, portuguese: Bool) -> CommandReview? {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        guard let status else {
            return CommandReview(tone: .unknown, headline: t("Revisão do programa não informada", "Program review not reported"),
                                 detail: t("Esta base não informou se o executável e os argumentos ainda são os revisados.",
                                           "This host did not report whether the executable and arguments are still the reviewed ones."),
                                 blocksDiscovery: false)
        }
        switch status.state {
        case .notStdio: return nil
        case .unreviewed:
            return CommandReview(tone: .attention, headline: t("Programa ainda sem revisão registrada", "Program has no recorded review yet"),
                                 detail: t("A base lê o executável agora, mas ainda não guardou uma revisão dele e dos argumentos.",
                                           "The host reads the executable now but has not stored a review of it and its arguments yet."),
                                 blocksDiscovery: false)
        case .unchanged:
            return CommandReview(tone: .confirmed, headline: t("Mesmo programa e argumentos da revisão", "Same program and arguments as reviewed"),
                                 detail: t("O executável e os argumentos lidos agora são os revisados. Isso não é assinatura nem sandbox.",
                                           "The executable and arguments read now are the reviewed ones. This is not a signature or a sandbox."),
                                 blocksDiscovery: false)
        case .changed:
            return CommandReview(tone: .problem, headline: t("O programa ou os argumentos mudaram desde a revisão", "The program or arguments changed since the review"),
                                 detail: t("Nada é iniciado. Restaure o executável e os argumentos revisados, ou remova esta conexão e cadastre de novo. Descobrir não substitui a revisão.",
                                           "Nothing is started. Restore the reviewed executable and arguments, or remove this connection and register it again. Discovering does not replace the review."),
                                 blocksDiscovery: true)
        case .unavailable:
            return CommandReview(tone: .unknown, headline: t("Programa não lido neste host", "Program not read on this host"),
                                 detail: t("Esta base não conseguiu ler o executável agora, ou a conexão roda em outro computador. Nada foi iniciado.",
                                           "This host could not read the executable now, or the connection runs on another computer. Nothing was started."),
                                 blocksDiscovery: false)
        }
    }

    /// Digest lines (reviewed vs current) for Detalhes técnicos; never argv, environment or script contents.
    public static func commandDigests(_ status: McpCommandStatus, portuguese: Bool) -> [String] {
        func line(_ label: String, _ digest: McpCommandStatus.Digest?) -> String? {
            guard let digest else { return nil }
            let size = digest.sizeBytes.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "?"
            return "\(label): \(digest.path) · SHA-256 \(digest.sha256.prefix(12))… · args \(digest.argsHash.prefix(12))… · \(size)"
        }
        return [line(portuguese ? "Revisado" : "Reviewed", status.reviewed), line(portuguese ? "Atual" : "Current", status.current)].compactMap { $0 }
    }

    /// The exact plan of "read the tools once after signing in" (HTTP only), shown beside its switch.
    public static func consentedDiscoveryPlan(server: McpServerSummary, portuguese: Bool) -> String {
        portuguese
            ? "Ligado: quando o login terminar, a base conecta uma vez a \(server.destination) com a credencial nova para ler a descrição e a lista de ferramentas. Nenhuma ferramenta é executada; o serviço percebe esse acesso. Vale só para esta conexão, nesta base, por 10 minutos; se a base, a conexão ou o pedido do bot mudar ou for parado, nada é lido. Uma leitura incerta não é repetida. Processos locais nunca são iniciados assim."
            : "On: when sign-in finishes, the host connects once to \(server.destination) with the new credential to read the description and the tool list. No tool is run; the service sees this access. It applies only to this connection, on this host, for 10 minutes; if the host, the connection or the bot's request changes or is stopped, nothing is read. An uncertain read is not repeated. Local processes are never started this way."
    }

    /// Why the consented read cannot be switched on, or nil when it can (an agreed instance pin exists).
    public static func consentedDiscoveryUnavailable(_ resolution: McpConsentedDiscoveryPlan.PinResolution, portuguese: Bool) -> String? {
        switch resolution {
        case .pin: return nil
        case .missing:
            return portuguese
                ? "Indisponível: esta base não informou a versão exata (pin) desta conexão. Depois do login, use Descobrir ferramentas…."
                : "Unavailable: this host did not report this connection's exact version (pin). After signing in, use Discover tools…."
        case .mismatch:
            return portuguese
                ? "Indisponível: a conexão mudou desde o pedido do bot (pins diferentes). Atualize e confira antes de continuar."
                : "Unavailable: the connection changed since the bot's request (different pins). Refresh and check before continuing."
        }
    }

    /// Shown before a local process is added or started: the effective boundary, with no promise of isolation.
    public static func stdioBoundary(portuguese: Bool) -> String {
        portuguese
            ? "Roda neste Mac com o seu usuário e as permissões dele. Pasta separada e ambiente limpo não são sandbox: o programa pode ler e alterar o que o seu usuário pode."
            : "Runs on this Mac as your user, with that user's permissions. A separate folder and a clean environment are not a sandbox: the program can read and change what your user can."
    }

    /// The exact plan a discovery confirmation covers. Discovery is network (HTTP, with this connection's credential) or
    /// code execution (local process); it never runs a tool.
    public static func discoveryPlan(server: McpServerSummary, portuguese: Bool) -> String {
        if server.transport == "stdio" {
            return portuguese
                ? "Inicia o programa “\(server.destination)” neste Mac para listar as ferramentas. " + stdioBoundary(portuguese: true) + " Nenhuma ferramenta é executada."
                : "Starts the program “\(server.destination)” on this Mac to list its tools. " + stdioBoundary(portuguese: false) + " No tool is run."
        }
        let credential = server.auth == "none"
        return portuguese
            ? "A base conecta a \(server.destination)\(credential ? ", sem login," : " com a credencial desta conexão") para listar as ferramentas. O serviço percebe esse acesso. Nenhuma ferramenta é executada."
            : "The host connects to \(server.destination)\(credential ? ", without sign-in," : " with this connection's credential") to list its tools. The service sees this access. No tool is run."
    }

    // MARK: Account changes

    /// Who loses access when this account is disconnected, from the account's own projection.
    public static func disconnectImpact(_ account: ConnectionAccount, botName: (String) -> String?, portuguese: Bool) -> String {
        let affected = account.bots.filter { $0.access != .disabled }.map { botName($0.botId) ?? $0.botId }
        let others = portuguese ? "Outras contas deste serviço não mudam." : "Other accounts of this service do not change."
        guard !affected.isEmpty else {
            return (portuguese ? "Nenhum bot usa esta conta. " : "No bot uses this account. ") + others
        }
        let list = affected.joined(separator: ", ")
        return portuguese
            ? "Perdem o acesso: \(list). Pedidos pendentes desta conta são bloqueados. A revogação no serviço é pedida, não confirmada. " + others
            : "These bots lose access: \(list). Pending requests on this account are blocked. Revocation at the service is requested, not confirmed. " + others
    }

    /// The outcome of a disconnect receipt, in plain words. "Requested" is never shown as confirmed.
    public static func disconnectOutcome(_ value: ConnectionUpstreamDisconnect?, portuguese: Bool) -> String {
        func t(_ pt: String, _ en: String) -> String { portuguese ? pt : en }
        guard let value else { return t("Desconectada nesta base.", "Disconnected on this host.") }
        let upstream: String
        switch value.upstream {
        case .deleted: upstream = t("a conexão foi apagada no provedor", "the connection was deleted at the provider")
        case .alreadyAbsent: upstream = t("o provedor já não tinha a conexão", "the provider no longer had the connection")
        case .notRequested: upstream = t("nada foi pedido ao provedor", "nothing was asked of the provider")
        case .unknown: upstream = t("o resultado no provedor não foi confirmado", "the outcome at the provider is not confirmed")
        }
        let revocation: String
        switch value.revocation {
        case .requested: revocation = t("a revogação do acesso foi pedida (não confirmada)", "access revocation was requested (not confirmed)")
        case .notRequested: revocation = t("nenhuma revogação foi pedida", "no revocation was requested")
        case .unknown: revocation = t("a revogação não foi confirmada", "revocation is not confirmed")
        }
        return portuguese ? "Desconectada nesta base; \(upstream); \(revocation)." : "Disconnected on this host; \(upstream); \(revocation)."
    }
}
