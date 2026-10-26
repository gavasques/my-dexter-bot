import Foundation
import XCTest
@testable import DexterHostClient

final class ApprovalPreferenceReceiptTests: XCTestCase {
    struct Fixture: Decodable {
        let bot: Bot
        let thread: HostThread
        let action: Action
        let input: DecideApprovalPreferenceInput
        let result: ApprovalPreferenceDecisionResult
        let modeInput: PatchThreadApprovalPolicyInput
        let modeReceipt: ApprovalPreferenceReceipt
        let effective: EffectiveApprovalPolicy
    }
    func testActualNodeReceiptsMatchSwiftHashAndIdentity() throws {
        let url = Bundle.module.url(forResource: "approval-preferences-r1", withExtension: "json") ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/approval-preferences-r1.json")
        let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertTrue(f.result.receipt.matches(botID: f.bot.id, ownerID: f.bot.ownerId, kind: "decision", targetID: f.action.id, input: f.input))
        XCTAssertTrue(f.modeReceipt.matches(botID: f.bot.id, ownerID: f.bot.ownerId, kind: "chat_mode", targetID: f.thread.id, input: f.modeInput))
        XCTAssertFalse(f.result.receipt.matches(botID: "other-bot", ownerID: f.bot.ownerId, kind: "decision", targetID: f.action.id, input: f.input))
        XCTAssertFalse(f.modeReceipt.matches(botID: f.bot.id, ownerID: f.bot.ownerId, kind: "chat_mode", targetID: "other-thread", input: f.modeInput))
        XCTAssertEqual(f.result.action.authorization?.source, .ownerType)
        XCTAssertTrue(f.effective.isValid)
        XCTAssertEqual(f.effective.mode, .acceptEdits)
        XCTAssertTrue(f.effective.effects.edits)
        XCTAssertFalse(f.effective.effects.commands)
        XCTAssertFalse(f.effective.effects.routine)
    }
}
