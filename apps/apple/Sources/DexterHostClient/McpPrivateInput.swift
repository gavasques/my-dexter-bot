import Foundation

// Private input asked by an MCP server during one running action (`packages/contracts/src/mcp-private-input.ts`, version 1).
// It stays inside that action's receipt: answering continues the same running action (a new protocol round with the
// host's own request id), never a new action and never a replay. Only primitive, non-secret forms are supported; URL
// mode, credentials, sampling and roots are not. The server's text is untrusted content shown as such.

public enum McpPrivateInputState: String, Codable, Equatable, Sendable {
    case pending, answered, declined, cancelled, expired, interrupted
}

public struct McpPrivateInput: Codable, Equatable, Sendable, Identifiable {
    public let version: Int
    public let id: String, actionId: String, requestHash: String, connectionId: String, botId: String, threadId: String
    public let revision: Int
    public let state: McpPrivateInputState
    public let requests: [String: JSONValue]
    public let createdAt: Int64, expiresAt: Int64
    public let responseHash: String?
    /// The owner request that answered it, once answered.
    public let clientRequestId: String?

    var isValid: Bool {
        version == 1 && [id, actionId, connectionId, botId, threadId].allSatisfy(connectionWorkflowIDIsValid) && connectionHashIsValid(requestHash)
            && revision >= 1 && revision <= 9_007_199_254_740_991 && (1...8).contains(requests.count)
            && requests.keys.allSatisfy(McpPrivateFormSafety.requestKey) && createdAt >= 0 && expiresAt >= createdAt
            && createdAt <= 9_007_199_254_740_991 && expiresAt <= 9_007_199_254_740_991
            && (responseHash.map(connectionHashIsValid) ?? true) && (clientRequestId.map(connectionWorkflowUUIDIsValid) ?? true)
    }

    /// The forms in a stable order, or nil when any request is outside the supported shape and cannot be answered.
    public var forms: [McpPrivateInputForm]? {
        guard (1...8).contains(requests.count), McpPrivateFormSafety.metadataIsSafe(.object(requests)),
              requests.keys.allSatisfy(McpPrivateFormSafety.requestKey) else { return nil }
        var result: [McpPrivateInputForm] = []
        for key in requests.keys.sorted() {
            guard let form = McpPrivateInputForm(key: key, request: requests[key]!) else { return nil }
            result.append(form)
        }
        return result
    }
}

/// One `elicitation/create` form request: a message from the server and flat primitive fields.
public struct McpPrivateInputForm: Equatable, Sendable, Identifiable {
    public struct Field: Equatable, Sendable, Identifiable {
        public enum Kind: Equatable, Sendable {
            case text(minLength: Int?, maxLength: Int?)
            case choice([String], names: [String]?)
            case number(integer: Bool, minimum: Double?, maximum: Double?)
            case boolean
        }
        public let name: String
        public let title: String?
        public let description: String?
        public let kind: Kind
        public let required: Bool
        public let defaultValue: JSONValue?
        // Original constraints stay data. Swift never compiles or executes a server regex/format.
        fileprivate let schema: [String: JSONValue]
        public var id: String { name }
    }
    public let key: String
    public let message: String
    public let fields: [Field]
    private let allowsAdditional: Bool
    public var id: String { key }

    init?(key: String, request: JSONValue) {
        guard McpPrivateFormSafety.requestKey(key), McpPrivateFormSafety.metadataIsSafe(request), case .object(let object) = request, Set(object.keys) == ["method", "params"], object["method"] == .string("elicitation/create"),
              case .object(let params)? = object["params"], Set(params.keys).isSubset(of: ["mode", "message", "requestedSchema", "_meta"]),
              params["mode"] == nil || params["mode"] == .string("form"),
              case .string(let message)? = params["message"], message.utf16.count <= 2_048, !McpPrivateFormSafety.solicitsCredentials(message),
              case .object(let schema)? = params["requestedSchema"], schema["type"] == .string("object"),
              Set(schema.keys).isSubset(of: ["type", "properties", "required", "title", "description", "$schema", "additionalProperties"]),
              case .object(let properties)? = schema["properties"], (0...16).contains(properties.count) else { return nil }
        // Only annotations the host supports are admitted; they are never displayed, executed or forwarded as answers.
        if let value = schema["$schema"] {
            guard case .string(let dialect) = value, McpPrivateFormSafety.dialects.contains(dialect) else { return nil }
        }
        guard McpPrivateFormSafety.textBytes(.object(schema)) <= 32_768 else { return nil }
        if let value = schema["additionalProperties"] { guard case .bool = value else { return nil } }
        for (name, max) in [("title", 256), ("description", 2_048)] {
            if let value = schema[name] {
                guard case .string(let text) = value, text.utf16.count <= max,
                      !McpPrivateFormSafety.sensitiveName(text), !McpPrivateFormSafety.solicitsCredentials(text) else { return nil }
            }
        }
        var required: Set<String> = []
        if let value = schema["required"] {
            guard case .array(let items) = value else { return nil }
            for item in items { guard case .string(let name) = item, properties[name] != nil, !required.contains(name) else { return nil }; required.insert(name) }
        }
        var fields: [Field] = []
        for name in properties.keys.sorted() {
            guard McpPrivateFormSafety.fieldName(name), case .object(let property)? = properties[name],
                  let field = Self.field(name, property, required: required.contains(name)) else { return nil }
            fields.append(field)
        }
        self.key = key; self.message = message; self.fields = fields
        self.allowsAdditional = schema["additionalProperties"] != .bool(false)
    }

    private static func field(_ name: String, _ p: [String: JSONValue], required: Bool) -> Field? {
        func text(_ key: String, max: Int) -> String?? {
            guard let value = p[key] else { return .some(nil) }
            guard case .string(let string) = value, string.utf16.count <= max,
                  !McpPrivateFormSafety.sensitiveName(string), !McpPrivateFormSafety.solicitsCredentials(string) else { return nil }
            return .some(string)
        }
        func number(_ key: String) -> Double?? {
            guard let value = p[key] else { return .some(nil) }
            guard let n = McpPrivateFormSafety.number(value) else { return nil }
            return .some(n)
        }
        guard case .string(let type)? = p["type"], let title = text("title", max: 256), let description = text("description", max: 2_048) else { return nil }
        let common: Set<String> = ["type", "title", "description", "default"]
        let kind: Field.Kind
        switch type {
        case "string":
            guard Set(p.keys).isSubset(of: common.union(["minLength", "maxLength", "format", "pattern", "enum", "enumNames", "oneOf", "const"])) else { return nil }
            func length(_ key: String) -> Int?? {
                guard let value = p[key] else { return .some(nil) }
                guard let n = McpPrivateFormSafety.number(value), n.rounded() == n, (0...10_000).contains(n) else { return nil }
                return .some(Int(n))
            }
            guard let minimum = length("minLength"), let maximum = length("maxLength"), minimum == nil || maximum == nil || minimum! <= maximum! else { return nil }
            if let format = p["format"] { guard case .string(let value) = format, ["email", "uri", "date", "date-time"].contains(value) else { return nil } }
            if let pattern = p["pattern"] { guard case .string(let value) = pattern, McpPrivateFormSafety.pattern(value) else { return nil } }
            guard ["enum", "oneOf", "const"].filter({ p[$0] != nil }).count <= 1 else { return nil }
            var options: [String]?, names: [String]?
            if let values = p["enum"] {
                guard case .array(let items) = values, (1...64).contains(items.count) else { return nil }
                options = items.compactMap { if case .string(let s) = $0, s.utf16.count <= 200 { s } else { nil } }
                guard options?.count == items.count, Set(options!.map { Data($0.utf8) }).count == items.count else { return nil }
            }
            if let raw = p["enumNames"] {
                guard let options, case .array(let labels) = raw, labels.count == options.count else { return nil }
                names = labels.compactMap { if case .string(let s) = $0, s.utf16.count <= 200, !McpPrivateFormSafety.sensitiveName(s), !McpPrivateFormSafety.solicitsCredentials(s) { s } else { nil } }
                guard names?.count == options.count else { return nil }
            }
            if let raw = p["oneOf"] {
                guard case .array(let items) = raw, (1...64).contains(items.count) else { return nil }
                var values: [String] = [], labels: [String] = []
                for item in items {
                    guard case .object(let branch) = item, Set(branch.keys) == ["const", "title"],
                          case .string(let value)? = branch["const"], value.utf16.count <= 200,
                          case .string(let label)? = branch["title"], label.utf16.count <= 200,
                          !McpPrivateFormSafety.sensitiveName(label), !McpPrivateFormSafety.solicitsCredentials(label) else { return nil }
                    values.append(value); labels.append(label)
                }
                guard Set(values.map { Data($0.utf8) }).count == values.count else { return nil }
                options = values; names = labels
            }
            if let raw = p["const"] {
                guard case .string(let value) = raw, value.utf16.count <= 200 else { return nil }
                options = [value]
            }
            kind = options.map { .choice($0, names: names) } ?? .text(minLength: minimum, maxLength: maximum)
        case "number", "integer":
            guard Set(p.keys).isSubset(of: common.union(["minimum", "maximum"])), let minimum = number("minimum"), let maximum = number("maximum"),
                  minimum == nil || maximum == nil || minimum! <= maximum! else { return nil }
            kind = .number(integer: type == "integer", minimum: minimum, maximum: maximum)
        case "boolean":
            guard Set(p.keys).isSubset(of: common) else { return nil }
            kind = .boolean
        default: return nil
        }
        let field = Field(name: name, title: title, description: description, kind: kind, required: required, defaultValue: p["default"], schema: p)
        if let value = p["default"], !Self.value(value, for: field) { return nil }
        return field
    }

    private static func value(_ value: JSONValue, for field: Field) -> Bool {
        guard McpPrivateFormSafety.scalar(value) else { return false }
        switch (field.kind, value) {
        case (.text, .string), (.choice, .string):
            guard case .string(let string) = value else { return false }
            let length = string.unicodeScalars.count
            if let min = field.schema["minLength"].flatMap(McpPrivateFormSafety.number), Double(length) < min { return false }
            if let max = field.schema["maxLength"].flatMap(McpPrivateFormSafety.number), Double(length) > max { return false }
            if case .choice(let options, _) = field.kind, !options.contains(where: { $0.utf8.elementsEqual(string.utf8) }) { return false }
            return true
        case (.number(let integer, let minimum, let maximum), _):
            guard let number = McpPrivateFormSafety.number(value), !integer || number.rounded() == number else { return false }
            return (minimum == nil || number >= minimum!) && (maximum == nil || number <= maximum!)
        case (.boolean, .bool): return true
        default: return false
        }
    }

    /// Local type/bounds checks only; the host validates the original format/pattern before consuming its private wait.
    /// Extra fields are admitted only when the original schema allows them, and remain bounded, safe primitives.
    /// No defaults or values are silently inserted into the owner's exact answer.
    public func content(_ values: [String: JSONValue]) -> [String: JSONValue]? {
        guard values.count <= 16, McpPrivateFormSafety.metadataIsSafe(.object(values)), McpPrivateFormSafety.textBytes(.object(values)) <= 32_768 else { return nil }
        let declared = Dictionary(uniqueKeysWithValues: fields.map { ($0.name, $0) })
        for (name, value) in values {
            guard McpPrivateFormSafety.fieldName(name) else { return nil }
            if let field = declared[name] { guard Self.value(value, for: field) else { return nil } }
            else if !allowsAdditional || !McpPrivateFormSafety.scalar(value) { return nil }
        }
        guard fields.allSatisfy({ !$0.required || values[$0.name] != nil }) else { return nil }
        return values
    }
}

/// Metadata remains opaque. This bounded local check refuses credential material and executable/principal fields;
/// the host is still the final authority with its private secret set and original schema validator.
private enum McpPrivateFormSafety {
    // ASCII field identifiers avoid Foundation Dictionary's canonical Unicode key equality; labels/values remain exact UTF-8.
    static func fieldName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 64 && name.utf8.allSatisfy { $0 <= 127 } && !forbiddenField(name)
    }
    static func requestKey(_ key: String) -> Bool {
        !["__proto__", "prototype", "constructor"].contains(key) && !key.isEmpty && key.utf8.count <= 128 && key.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || Array("_.:-".utf8).contains($0) }
    }
    static func number(_ value: JSONValue) -> Double? {
        let result: Double
        switch value { case .integer(let n): result = Double(n); case .number(let n): result = n; default: return nil }
        return result.isFinite && abs(result) <= 9_007_199_254_740_991 ? result : nil
    }
    static func scalar(_ value: JSONValue) -> Bool {
        switch value { case .string(let s): return s.utf16.count <= 10_000; case .bool: return true; default: return number(value) != nil }
    }
    static func textBytes(_ value: JSONValue) -> Int {
        switch value {
        case .string(let s): return s.utf8.count
        case .array(let items): return items.reduce(0) { $0 + textBytes($1) }
        case .object(let values): return values.reduce(0) { $0 + $1.key.utf8.count + textBytes($1.value) }
        default: return 0
        }
    }
    // Nonexecuting ASCII grammar, kept identical to isSupportedMcpPrivateFormPattern in connectors/mcp/private-input.ts.
    // Format/pattern matching belongs only to the host's original-schema validator.
    static func pattern(_ text: String) -> Bool {
        let p = Array(text.utf8)
        guard p.count <= 512, p.allSatisfy({ (32...126).contains($0) }) else { return false }
        let anchored = p.first == 94 && p.last == 36
        var i = anchored ? 1 : 0, cost = anchored ? 2 : 0, dotCost = 0
        let end = p.count - (anchored ? 1 : 0)
        struct Atom { let source: [UInt8], members: Set<UInt8>, literal: UInt8?, repeated: Bool }
        var atoms: [Atom] = []
        func digit(_ v: UInt8) -> Bool { (48...57).contains(v) }
        func classChar(_ v: UInt8) -> Bool { digit(v) || (65...90).contains(v) || (97...122).contains(v) || v == 32 || v == 95 }
        while i < end {
            let start = i, c = p[i]; i += 1
            var members: Set<UInt8> = [], literal: UInt8?
            if c == 92 {
                guard i < end else { return false }; let escaped = p[i]; i += 1
                if escaped == 100 || escaped == 119 {
                    guard anchored else { return false }
                    members = Set((escaped == 100 ? "0123456789" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_").utf8)
                } else if Array("/.*+?^$()[]{}|\\".utf8).contains(escaped) { literal = escaped; members.insert(escaped) }
                else { return false }
            } else if c == 91 {
                guard anchored, let close = p[i..<end].firstIndex(of: 93), close > i else { return false }
                let body = Array(p[i..<close]); var j = 0
                while j < body.count {
                    let v = body[j]; guard classChar(v) || v == 45 else { return false }
                    if j + 2 < body.count, body[j + 1] == 45 {
                        let last = body[j + 2]; guard classChar(last), v <= last else { return false }
                        for n in v...last { members.insert(n) }; j += 3
                    } else {
                        guard v != 45 || j == 0 || j == body.count - 1 else { return false }
                        members.insert(v); j += 1
                    }
                }
                i = close + 1
            } else if c == 46 {
                guard anchored else { return false }; members = Set(UInt8(32)...UInt8(126))
            } else {
                guard !Array("()|{}*+?[]^$".utf8).contains(c) else { return false }; literal = c; members.insert(c)
            }
            let source = Array(p[start..<i]); var expansion = 1, repeated = false
            if i < end, Array("*+?{".utf8).contains(p[i]) {
                guard anchored else { return false }; repeated = true; let q = p[i]; i += 1
                if q == 123 {
                    var lower = "", upper = ""
                    while i < end, digit(p[i]) { lower.append(Character(UnicodeScalar(p[i]))); i += 1 }
                    guard !lower.isEmpty else { return false }
                    if i < end, p[i] == 44 { i += 1; while i < end, digit(p[i]) { upper.append(Character(UnicodeScalar(p[i]))); i += 1 } }
                    else { upper = lower }
                    guard i < end, p[i] == 125, let min = Double(lower), let max = Double(upper.isEmpty ? lower : upper), min <= max, max <= 256 else { return false }
                    i += 1; expansion = Swift.max(1, Int(max))
                } else { expansion = q == 63 ? 1 : 2 }
            }
            cost += expansion; if source == [46] { dotCost += expansion }
            guard cost <= 256, dotCost <= 64 else { return false }
            atoms.append(Atom(source: source, members: members, literal: literal, repeated: repeated))
        }
        if let first = atoms.firstIndex(where: { $0.repeated }) {
            let repeated = atoms[first]
            for atom in atoms.dropFirst(first + 1) {
                if atom.source == repeated.source { continue }
                guard !atom.repeated, let literal = atom.literal, !repeated.members.contains(literal) else { return false }
            }
        }
        return true
    }
    static let dialects: Set<String> = ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"]
    static func normalized(_ value: String) -> String {
        value.decomposedStringWithCompatibilityMapping.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }
    static func sensitiveName(_ name: String) -> Bool {
        let key = normalized(name).filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return key.range(of: "password|passphrase|passwd|senha|apikey|clientsecret|credential|authorization|bearer|oauth|privatekey|accesskey|authkey|signingkey|encryptionkey|accesstoken|refreshtoken|idtoken|authtoken|sessiontoken|seedphrase|mnemonic", options: .regularExpression) != nil
            || key == "secret" || key.hasPrefix("secret") || key.hasSuffix("secret") || key == "token" || key.hasSuffix("token")
            || key.range(of: "token(?:value|secret|key|credential|auth|bearer|access|refresh)|secret(?:key|value|token|password|credential|phrase|confirmation)", options: .regularExpression) != nil
            || ["otp", "totp", "mfacode", "authcode", "authenticationcode", "authenticatorcode", "verificationcode", "recoverycode", "backupcode", "securityanswer", "pwd", "pin", "cvv", "cookie"].contains(key)
            || normalized(name).range(of: #"\b(?:pwd|pin|cvv|cookies?)\b"#, options: .regularExpression) != nil
            || key.range(of: #"^(?:pwd|pin|cvv|cookie)(?:confirmation|value|code|number|data|header|s)$"#, options: .regularExpression) != nil
    }
    static func forbiddenField(_ name: String) -> Bool {
        let key = normalized(name).filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return sensitiveName(name) || ["proto", "prototype", "constructor", "user", "userid", "entity", "entityid", "owner", "ownerid", "profile", "profileid", "bot", "botid", "account", "accountid", "connectedaccount", "connectedaccountid", "connection", "connectionid", "authconfigid", "tool", "tools", "toolslug", "toolname", "toolkit", "toolkitslug", "action", "actions", "slug", "app", "integrationid", "headers", "header", "auth", "session", "sessionid", "command", "cmd", "script", "code", "shell", "eval", "exec", "program", "querycode", "bash", "url", "uri", "endpoint", "host", "hostname", "domain", "webhook", "webhookurl", "path", "baseurl"].contains(key)
    }
    static func solicitsCredentials(_ text: String) -> Bool {
        let source = normalized(text) as NSString
        guard let verbs = try? NSRegularExpression(pattern: #"\b(?:enter|paste|provide|supply|type|input|upload|confirm|insira|cole|informe|forneca|digite|confirme)\b"#),
              let credentials = try? NSRegularExpression(pattern: #"\b(?:password|passphrase|passwd|pwd|pin|cvv|cookies?|senha|api[ _-]?key|chave[ _-]?(?:de[ _-]?)?api|client[ _-]?secret|(?:access|refresh|id|auth|session)[ _-]?token|bearer|oauth|credentials?|credenciais|secret|segredo|token(?![ _-]+(?:amount|count|budget|limit|cost|usage|quantity|length|type|kind|name|format|price|symbol|quantidade|valor)))\b"#) else { return true }
        for match in verbs.matches(in: source as String, range: NSRange(location: 0, length: source.length)) {
            let before = source.substring(to: match.range.location)
            if before.range(of: #"\b(?:not|never|nao)\s*$"#, options: .regularExpression) != nil { continue }
            let begin = NSMaxRange(match.range), count = min(120, source.length - begin)
            let tail = source.substring(with: NSRange(location: begin, length: count)).components(separatedBy: CharacterSet(charactersIn: ".!?;\n")).first ?? ""
            let tailText = tail as NSString
            for credential in credentials.matches(in: tail, range: NSRange(location: 0, length: tailText.length)) {
                let prefix = tailText.substring(to: credential.range.location)
                if prefix.range(of: #"\b(?:no|not|without|never|nao|sem|nenhuma?)\s*(?:a|an|any|your|sua?)?\s*$"#, options: .regularExpression) == nil { return true }
            }
        }
        return false
    }
    static func placeholder(_ value: String) -> Bool {
        let token = value.replacingOccurrences(of: #"^Bearer\s+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:sk-(?:proj-)?|sk_live_|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|AIza|glpat-)"#, with: "", options: .regularExpression)
        let names: Set<String> = ["YOUR_ACCESS_TOKEN_HERE", "YOUR_API_KEY", "YOUR_API_KEY_HERE", "YOUR_TOKEN", "YOUR_TOKEN_HERE", "YOUR_KEY", "YOUR_KEY_HERE", "YOUR_SECRET", "YOUR_SECRET_HERE", "example", "example-token", "example-key", "placeholder", "placeholder-token", "placeholder-key", "dummy", "dummy-token", "synthetic", "synthetic-token"]
        return token.range(of: #"^(?:x{8,}|X{8,})$"#, options: .regularExpression) != nil || names.contains(token)
    }
    static func metadataIsSafe(_ raw: JSONValue) -> Bool {
        var nodes = 0, bytes = 0
        func stringIsSafe(_ text: String) -> Bool {
            bytes += text.utf8.count
            guard bytes <= 256 * 1_024 else { return false }
            // Consume whole tokens once, with the same visibly synthetic placeholder exception as the host.
            if text.range(of: #"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"#, options: .regularExpression) != nil { return false }
            let source = text as NSString
            guard let credentials = try? NSRegularExpression(pattern: #"(?<![A-Za-z0-9_])(?:sk-(?:proj-)?|sk_live_|gh[pousr]_|github_pat_|AKIA|xox[baprs]-|AIza|glpat-)[A-Za-z0-9_-]{16,}|(?<![A-Za-z0-9_])Bearer\s+[A-Za-z0-9._~+/=-]{16,}"#),
                  let urls = try? NSRegularExpression(pattern: #"https?://[^\s<>\"']+"#) else { return false }
            for match in credentials.matches(in: text, range: NSRange(location: 0, length: source.length)) {
                if !placeholder(source.substring(with: match.range)) { return false }
            }
            guard let runs = try? NSRegularExpression(pattern: #"[A-Za-z0-9_-]+"#) else { return false }
            var previous: NSTextCheckingResult?, candidate: NSTextCheckingResult?
            for run in runs.matches(in: text, range: NSRange(location: 0, length: source.length)) {
                let token = source.substring(with: run.range)
                if let previous, let candidate, NSMaxRange(previous.range) + 1 == run.range.location,
                   source.character(at: run.range.location - 1) == 46, token.count >= 12 {
                    let pieces = [source.substring(with: candidate.range), source.substring(with: previous.range), token]
                    if !pieces.allSatisfy({ $0.range(of: #"^eyJ[xX]{12,}$|^[xX]{12,}$"#, options: .regularExpression) != nil }) { return false }
                }
                if let previous, NSMaxRange(previous.range) + 1 == run.range.location, source.character(at: run.range.location - 1) == 46, token.count >= 12,
                   source.substring(with: previous.range).range(of: #"(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]{12}"#, options: .regularExpression) != nil { candidate = previous }
                else { candidate = nil }
                previous = run
            }
            for match in urls.matches(in: text, range: NSRange(location: 0, length: source.length)) {
                guard let url = URLComponents(string: source.substring(with: match.range)) else { continue }
                if url.queryItems?.contains(where: { item in
                    let key = item.name.lowercased(), value = item.value ?? ""
                    if key.range(of: #"^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|passwd|pwd|senha|pin|cvv|cookie|authorization|client[_-]?secret|id[_-]?token)$"#, options: .regularExpression) != nil && !placeholder(value) { return true }
                    return key == "code" && value.count >= 24 && Set(value).count >= 8 && !placeholder(value)
                }) == true { return false }
            }
            return true
        }
        func visit(_ value: JSONValue, depth: Int) -> Bool {
            nodes += 1
            guard nodes <= 20_000, depth <= 24 else { return false }
            switch value {
            case .string(let s): return stringIsSafe(s)
            case .number(let n): return n.isFinite
            case .object(let values): return values.allSatisfy { !["__proto__", "prototype", "constructor"].contains($0.key) && stringIsSafe($0.key) && visit($0.value, depth: depth + 1) }
            case .array(let values): return values.allSatisfy { visit($0, depth: depth + 1) }
            default: return true
            }
        }
        return visit(raw, depth: 0)
    }
}

/// The owner's answer to every form of one input: accept with exact content per request key, decline or cancel.
public enum McpPrivateInputAnswer: Equatable, Sendable {
    case accept([String: [String: JSONValue]])
    case decline
    case cancel
}

public struct RespondMcpPrivateInputInput: Encodable, Equatable, Sendable {
    public let expectedHostID: String, clientRequestId: String
    public let expectedRevision: Int
    public let actionId: String, requestHash: String
    public let responses: [String: JSONValue]
    /// `approve_exact_input` whenever any response accepts: the owner reviewed these exact values for this action and
    /// revision. Absent for decline/cancel. Grants no new account, destination or tool.
    public let approval: String?
    public static let exactApproval = "approve_exact_input"

    /// Nil when the answer does not cover exactly this input's requests or its content fails the form.
    public init?(input: McpPrivateInput, hostID: String, answer: McpPrivateInputAnswer, clientRequestId: String = UUID().uuidString.lowercased()) {
        guard input.isValid, input.forms != nil else { return nil }
        var responses: [String: JSONValue] = [:]
        switch answer {
        case .accept(let contents):
            guard let forms = input.forms, Set(contents.keys) == Set(input.requests.keys) else { return nil }
            for form in forms {
                guard let raw = contents[form.key], let content = form.content(raw) else { return nil }
                responses[form.key] = .object(["action": .string("accept"), "content": .object(content)])
            }
        case .decline: for key in input.requests.keys { responses[key] = .object(["action": .string("decline")]) }
        case .cancel: for key in input.requests.keys { responses[key] = .object(["action": .string("cancel")]) }
        }
        expectedHostID = hostID; self.clientRequestId = clientRequestId; expectedRevision = input.revision
        actionId = input.actionId; requestHash = input.requestHash; self.responses = responses
        if case .accept = answer { approval = Self.exactApproval } else { approval = nil }
    }
    var isValid: Bool {
        connectionWorkflowIDIsValid(expectedHostID) && connectionWorkflowUUIDIsValid(clientRequestId) && expectedRevision >= 1
            && connectionWorkflowIDIsValid(actionId) && connectionHashIsValid(requestHash) && !responses.isEmpty
            && (approval == nil || approval == Self.exactApproval)
            && (approval != nil || !responses.values.contains { if case .object(let r) = $0 { r["action"] == .string("accept") } else { false } })
    }

    /// The exact values this answer sends, per form and field, for the review shown before Enviar.
    public var acceptedValues: [(form: String, field: String, value: JSONValue)] {
        responses.keys.sorted().flatMap { key -> [(form: String, field: String, value: JSONValue)] in
            guard case .object(let response)? = responses[key], case .object(let content)? = response["content"] else { return [] }
            return content.keys.sorted().map { (form: key, field: $0, value: content[$0]!) }
        }
    }
}

/// Valid siblings plus explicit incompleteness. A malformed row never becomes an actionable form or an empty-list claim.
public struct McpPrivateInputs: Decodable, Equatable, Sendable {
    public let requests: [McpPrivateInput]
    public let invalidRequestCount: Int
    public let quarantinedRequestCount: Int
    public let omittedRequestCount: Int
    public let incomplete: Bool
    private enum CodingKeys: String, CodingKey { case requests, invalidRequestCount, quarantinedRequestCount, omittedRequestCount, incomplete }
    private struct RowKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private struct Row: Decodable {
        let value: McpPrivateInput?
        init(from decoder: any Decoder) throws {
            // Decode each row directly; decoding a whole JSONValue array first would let one invalid UTF-16 string
            // fail the entire list before a sibling can be decoded. The containing array advances with superDecoder.
            let keys = try? decoder.container(keyedBy: RowKey.self).allKeys.map(\.stringValue)
            let allowed: Set<String> = ["version", "id", "actionId", "requestHash", "connectionId", "botId", "threadId", "revision", "state", "requests", "createdAt", "expiresAt", "responseHash", "clientRequestId"]
            guard let keys, Set(keys).isSubset(of: allowed) else { value = nil; return }
            let decoded = try? McpPrivateInput(from: decoder)
            value = decoded.flatMap { $0.isValid && $0.forms != nil ? $0 : nil }
        }
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func count(_ key: CodingKeys) throws -> Int {
            let n = try c.decodeIfPresent(Int.self, forKey: key) ?? 0
            guard (0...50_000).contains(n) else { throw HostClientError.contractMismatch }
            return n
        }
        var rows = try c.nestedUnkeyedContainer(forKey: .requests)
        var decoded: [McpPrivateInput] = [], invalid = 0, total = 0
        while !rows.isAtEnd {
            total += 1; guard total <= 500 else { throw HostClientError.contractMismatch }
            let row = try Row(from: rows.superDecoder())
            if let value = row.value { decoded.append(value) } else { invalid += 1 }
        }
        let counts = Dictionary(grouping: decoded, by: \.id).mapValues(\.count)
        requests = decoded.filter { counts[$0.id] == 1 }
        invalid += decoded.count - requests.count
        invalidRequestCount = try count(.invalidRequestCount) + invalid
        quarantinedRequestCount = try count(.quarantinedRequestCount)
        omittedRequestCount = try count(.omittedRequestCount)
        incomplete = (try c.decodeIfPresent(Bool.self, forKey: .incomplete) ?? false)
            || invalidRequestCount > 0 || quarantinedRequestCount > 0 || omittedRequestCount > 0
    }
}

/// A nonactionable metadata projection. Only an exact GET produces `McpPrivateInput` for the answer initializer.
public struct McpPrivateInputSummary: Codable, Equatable, Sendable, Identifiable {
    public let version: Int
    public let id: String, actionId: String, requestHash: String, connectionId: String, botId: String, threadId: String
    public let revision: Int
    public let state: McpPrivateInputState
    public let createdAt: Int64, expiresAt: Int64
    public let responseHash: String?, clientRequestId: String?
    public let detailState: String
    var isValid: Bool {
        version == 1 && detailState == "not_loaded" && [id,actionId,connectionId,botId,threadId].allSatisfy(connectionWorkflowIDIsValid)
            && connectionHashIsValid(requestHash) && revision > 0 && revision <= 9_007_199_254_740_991
            && createdAt >= 0 && expiresAt >= createdAt && expiresAt <= 9_007_199_254_740_991
            && (responseHash.map(connectionHashIsValid) ?? true) && (clientRequestId.map(connectionWorkflowUUIDIsValid) ?? true)
    }
}

public struct McpPrivateInputPage: Decodable, Sendable {
    public let summaries: [McpPrivateInputSummary]
    public let nextCursor: String?
    public let view: String
    public let retainedRequestCount, activeRequestCount, scannedRequestCount, invalidRequestCount: Int
    public let quarantinedRequestCount, omittedRequestCount, unverifiedRequestCount: Int
    public let incomplete: Bool
    /// Read compatibility for an older owner host only. New hosts never send form bodies in a list.
    public let legacyRequests: [McpPrivateInput]
    private enum CodingKeys: String, CodingKey { case version,summaries,nextCursor,view,retainedRequestCount,activeRequestCount,scannedRequestCount,invalidRequestCount,invalidCountScope,quarantinedRequestCount,omittedRequestCount,unverifiedRequestCount,incomplete }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy:CodingKeys.self)
        let version = try c.decodeIfPresent(Int.self,forKey:.version)
        guard version == 2 else {
            guard version == nil else { throw HostClientError.contractMismatch }
            let old = try McpPrivateInputs(from:decoder)
            legacyRequests = old.requests; summaries = []; nextCursor = nil; view = "active"
            retainedRequestCount = old.requests.count + old.omittedRequestCount; activeRequestCount = old.requests.count
            scannedRequestCount = old.requests.count + old.invalidRequestCount; invalidRequestCount = old.invalidRequestCount
            quarantinedRequestCount = old.quarantinedRequestCount; omittedRequestCount = old.omittedRequestCount
            unverifiedRequestCount = 0; incomplete = old.incomplete; return
        }
        legacyRequests = []
        func count(_ key:CodingKeys) throws -> Int {
            let value = try c.decode(Int.self,forKey:key)
            guard (0...9_007_199_254_740_991).contains(value) else { throw HostClientError.contractMismatch }; return value
        }
        view = try c.decode(String.self,forKey:.view)
        guard ["active","history"].contains(view), try c.decode(String.self,forKey:.invalidCountScope) == "page_envelopes" else { throw HostClientError.contractMismatch }
        nextCursor = try c.decodeIfPresent(String.self,forKey:.nextCursor)
        guard nextCursor.map(connectionWorkflowIDIsValid) ?? true else { throw HostClientError.contractMismatch }
        let rows = try c.decode([McpPrivateInputSummary].self,forKey:.summaries)
        guard rows.count <= 100, rows.allSatisfy(\.isValid), Set(rows.map(\.id)).count == rows.count else { throw HostClientError.contractMismatch }
        summaries = rows
        retainedRequestCount = try count(.retainedRequestCount); activeRequestCount = try count(.activeRequestCount)
        scannedRequestCount = try count(.scannedRequestCount); invalidRequestCount = try count(.invalidRequestCount)
        quarantinedRequestCount = try count(.quarantinedRequestCount); omittedRequestCount = try count(.omittedRequestCount)
        unverifiedRequestCount = try count(.unverifiedRequestCount)
        guard scannedRequestCount <= 100, summaries.count + invalidRequestCount == scannedRequestCount,
              unverifiedRequestCount == summaries.count, retainedRequestCount >= scannedRequestCount,
              omittedRequestCount == retainedRequestCount - scannedRequestCount else { throw HostClientError.contractMismatch }
        incomplete = try c.decode(Bool.self,forKey:.incomplete) || invalidRequestCount > 0 || quarantinedRequestCount > 0
    }
}

extension HostClient {
    /// Active live waits first; retained history is a separate keyset view. Pages are live reads, not snapshots.
    public func mcpPrivateInputPage(history: Bool = false, after: String? = nil) async throws -> McpPrivateInputPage {
        try requireConnections(.mcpRead)
        guard after.map(connectionWorkflowIDIsValid) ?? true else { throw HostClientError.invalidRequest }
        var query:[URLQueryItem] = []
        if history || after != nil { query = [URLQueryItem(name:"limit",value:"100"),URLQueryItem(name:"view",value:history ? "history" : "active")] }
        if let after { query.append(URLQueryItem(name:"after",value:after)) }
        let page:McpPrivateInputPage = try await request("/v1/mcp/input-requests",query:query,timeout:15,localAttachmentRequest:true)
        guard page.view == (history ? "history" : "active"),
              after.map({ cursor in page.summaries.allSatisfy { $0.id < cursor } && (page.nextCursor.map { $0 < cursor } ?? true) }) ?? true else { throw HostClientError.contractMismatch }
        return page
    }
    /// Open/recent inputs and explicit incompleteness. A malformed row is isolated; 503 means unavailable.
    public func mcpPrivateInputs() async throws -> McpPrivateInputs {
        try requireConnections(.mcpRead)
        return try await request("/v1/mcp/input-requests", timeout: 15, localAttachmentRequest: true)
    }
    /// GET of one input: the only reconciliation of an uncertain answer.
    public func mcpPrivateInput(id: String) async throws -> McpPrivateInput {
        try requireConnections(.mcpRead)
        guard connectionWorkflowIDIsValid(id) else { throw HostClientError.invalidRequest }
        let value: McpPrivateInput = try await request("/v1/mcp/input-requests/\(connectionPathSegment(id))", timeout: 15, localAttachmentRequest: true)
        guard value.isValid, value.forms != nil, value.id == id else { throw HostClientError.contractMismatch }
        return value
    }
    /// One POST of the owner's answer for the same running action. Any doubt is `mutationOutcomeUnknown`: read the input.
    public func respondMcpPrivateInput(id: String, _ input: RespondMcpPrivateInputInput) async throws -> McpPrivateInput {
        try requireConnections(.mcpManage)
        guard connectionWorkflowIDIsValid(id), input.isValid else { throw HostClientError.invalidRequest }
        let value: McpPrivateInput = try await connectionsMutation("/v1/mcp/input-requests/\(connectionPathSegment(id))/respond", method: "POST", body: input)
        guard value.isValid, value.id == id, value.clientRequestId == input.clientRequestId, value.revision > input.expectedRevision,
              value.actionId == input.actionId, value.requestHash == input.requestHash else { throw HostClientError.mutationOutcomeUnknown }
        return value
    }
}
