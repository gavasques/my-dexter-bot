import Foundation
import CryptoKit

public enum BotExecutionOperation: String, Codable, CaseIterable, Sendable {
    case terminal, cli, filesWrite = "files_write", automation
    public var label: String {
        switch self { case .terminal: String(localized: "Terminal"); case .cli: String(localized: "CLI (GitHub e Python)"); case .filesWrite: String(localized: "Escrita de arquivos"); case .automation: String(localized: "Automações deste bot") }
    }
    var tool: String {
        switch self { case .terminal: "dexter.harness.terminal.run"; case .cli: "dexter.harness.cli.run"; case .filesWrite: "dexter.harness.files.write"; case .automation: "dexter.automations.run" }
    }
    var destination: String { self == .automation ? "dexter-automations" : "dexter-harness-owner-proposals" }
    public var scopeExplanation: String {
        switch self {
        case .terminal: String(localized: "Comandos bash, zsh, sh e bun deste bot, como usuário normal do host. O diretório de trabalho não é um sandbox do sistema operacional. Sem sudo ou root automático.")
        case .cli: String(localized: "GitHub CLI e Python detectados no host, com argumentos literais e usuário normal. Disponibilidade não confirma login; autenticação fica no CLI oficial e nos fluxos privados.")
        case .filesWrite: String(localized: "Escrita apenas na raiz de arquivos deste bot, sujeita aos limites e validações de caminhos do host. Isso não limita o alcance de uma shell autorizada.")
        case .automation: String(localized: "Executar automações próprias já cadastradas, dentro dos pins e limites atuais. Não permite criar acesso, selecionar MCP ou ampliar permissões.")
        }
    }
}
public struct BotExecutionGrant: Codable, Equatable, Sendable {
    public let botId: String, tool: String, destination: String, policy: String
    public let expiresAt: Int64?
    public let revision: Int
}
public struct BotExecutionAccessEntry: Codable, Equatable, Sendable, Identifiable {
    public let operation: BotExecutionOperation
    public let grant: BotExecutionGrant?
    public let provisional: Bool, enabled: Bool
    public var id: String { operation.rawValue }
    public var stateLabel: String {
        if provisional { return String(localized: "Provisório · aprovação por ação") }
        if enabled { return String(localized: "Habilitado") }
        if grant?.policy == "deny" { return String(localized: "Revogado") }
        if grant?.expiresAt != nil { return String(localized: "Expirado") }
        return String(localized: "Ainda não habilitado")
    }
}
public struct BotExecutionAccess: Codable, Equatable, Sendable {
    public static let scopeVersionValue = "d03.access.v1"
    public let hostId: String, botId: String, ownerId: String
    public let botRevision: Int
    public let scopeVersion: String, inventoryHash: String
    public let entries: [BotExecutionAccessEntry]
    public var isValid: Bool {
        approvalIdentityIsValid(hostId) && approvalIdentityIsValid(botId) && approvalIdentityIsValid(ownerId) && botRevision >= 0 && botRevision <= 9_007_199_254_740_991 &&
        scopeVersion == Self.scopeVersionValue && inventoryHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
        entries.map(\.operation) == BotExecutionOperation.allCases && entries.allSatisfy { entry in
            guard let grant = entry.grant else { return !entry.enabled && !entry.provisional }
            return grant.botId == botId && grant.tool == entry.operation.tool && grant.destination == entry.operation.destination &&
                ["ask", "allow", "deny"].contains(grant.policy) && grant.revision > 0 && (grant.expiresAt.map { $0 >= 0 } ?? true) &&
                (!entry.enabled || (grant.policy != "deny" && !entry.provisional))
        } && executionInventoryHash(self) == inventoryHash
    }
}
public struct PatchBotExecutionAccessInput: Codable, Equatable, Sendable {
    public let expectedHostId: String, clientRequestId: String
    public let expectedBotRevision: Int
    public let expectedInventoryHash: String, scopeVersion: String
    public let operation: BotExecutionOperation
    public let enabled: Bool
    public init(access: BotExecutionAccess, operation: BotExecutionOperation, enabled: Bool, clientRequestId: String) {
        expectedHostId = access.hostId; self.clientRequestId = clientRequestId; expectedBotRevision = access.botRevision
        expectedInventoryHash = access.inventoryHash; scopeVersion = access.scopeVersion; self.operation = operation; self.enabled = enabled
    }
    public var isValid: Bool {
        approvalIdentityIsValid(expectedHostId) && approvalIdentityIsValid(clientRequestId) && expectedBotRevision >= 0 && expectedBotRevision < 9_007_199_254_740_991 &&
        scopeVersion == BotExecutionAccess.scopeVersionValue && expectedInventoryHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
}
public struct BotExecutionAccessReceipt: Codable, Equatable, Sendable {
    public let id: String, clientRequestId: String, inputHash: String, hostId: String, botId: String, ownerId: String
    public let input: PatchBotExecutionAccessInput
    public let previous: BotExecutionAccess, access: BotExecutionAccess
    public let revocationEffects: BotApprovalPolicyRevocationEffects
    public let createdAt: Int64
    public func matches(botID: String, input expected: PatchBotExecutionAccessInput) -> Bool {
        guard approvalIdentityIsValid(id), createdAt >= 0, input == expected, input.isValid, previous.isValid, access.isValid,
              hostId == input.expectedHostId, clientRequestId == input.clientRequestId, botId == botID,
              previous.hostId == hostId, access.hostId == hostId, previous.ownerId == ownerId, access.ownerId == ownerId,
              previous.botId == botId, access.botId == botId, previous.botRevision == input.expectedBotRevision,
              access.botRevision == previous.botRevision, previous.inventoryHash == input.expectedInventoryHash,
              inputHash == executionRequestHash(botID: botId, ownerID: ownerId, input: input), revocationEffects.isValid else { return false }
        for before in previous.entries {
            guard let after = access.entries.first(where: { $0.operation == before.operation }) else { return false }
            if before.operation != input.operation { guard before == after else { return false }; continue }
            guard let grant = after.grant, !after.provisional, grant.revision == (before.grant?.revision ?? 0) + 1,
                  grant.policy == (input.enabled ? "ask" : "deny"), grant.expiresAt == before.grant?.expiresAt else { return false }
        }
        return true
    }
}
public struct ActionApprovalRequirement: Codable, Equatable, Sendable {
    public let reason: String
    public let policyRevision: Int
}
extension HostClient {
    public func botExecutionAccess(botID: String) async throws -> BotExecutionAccess {
        guard approvalIdentityIsValid(botID) else { throw HostClientError.invalidRequest }
        let value: BotExecutionAccess = try await request( "/v1/bots/\(botID)/execution-access")
        guard value.isValid, value.botId == botID else { throw HostClientError.contractMismatch }; return value
    }
    public func updateBotExecutionAccess(botID: String, input: PatchBotExecutionAccessInput) async throws -> BotExecutionAccessReceipt {
        guard approvalIdentityIsValid(botID), input.isValid else { throw HostClientError.invalidRequest }
        let receipt: BotExecutionAccessReceipt = try await request( "/v1/bots/\(botID)/execution-access", method: "PATCH", body: input)
        guard receipt.matches(botID: botID, input: input) else { throw HostClientError.contractMismatch }; return receipt
    }
    public func botExecutionAccessReceipt(botID: String, input: PatchBotExecutionAccessInput) async throws -> BotExecutionAccessReceipt {
        guard approvalIdentityIsValid(botID), input.isValid else { throw HostClientError.invalidRequest }
        let receipt: BotExecutionAccessReceipt = try await request( "/v1/bots/\(botID)/execution-access/receipts/\(input.clientRequestId)")
        guard receipt.matches(botID: botID, input: input) else { throw HostClientError.contractMismatch }; return receipt
    }
}
private func executionHash(_ value: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func executionInventoryHash(_ access: BotExecutionAccess) -> String? {
    let entries: [[String: Any]] = access.entries.map { entry in
        var value: [String: Any] = ["operation": entry.operation.rawValue, "provisional": entry.provisional]
        if let grant = entry.grant { value["grant"] = ["botId": grant.botId, "tool": grant.tool, "destination": grant.destination,
                                                     "policy": grant.policy, "revision": grant.revision, "expiresAt": grant.expiresAt.map { $0 as Any } ?? NSNull()] }
        else { value["grant"] = NSNull() }
        return value
    }
    return executionHash(["hostId": access.hostId, "botId": access.botId, "ownerId": access.ownerId, "botRevision": access.botRevision,
                          "scopeVersion": access.scopeVersion, "entries": entries])
}
private func executionRequestHash(botID: String, ownerID: String, input: PatchBotExecutionAccessInput) -> String? {
    executionHash(["botId": botID, "ownerId": ownerID, "expectedHostId": input.expectedHostId, "clientRequestId": input.clientRequestId,
                   "expectedBotRevision": input.expectedBotRevision, "expectedInventoryHash": input.expectedInventoryHash,
                   "scopeVersion": input.scopeVersion, "operation": input.operation.rawValue, "enabled": input.enabled])
}
