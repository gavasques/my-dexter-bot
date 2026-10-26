import DexterHostClient
import XCTest
@testable import DexterAppCore

final class BotAvatarAppearanceDraftTests: XCTestCase {
    private let saved = BotAvatarAppearance(body: .cloud, eyes: .sleepy, colorHex: "#E5E7EB", finish: .glass, motion: .subtle)
    private let edited = BotAvatarAppearance(body: .hexagon, eyes: .wide, colorHex: "#FB923C", finish: .flat, motion: .lively)

    func testPrecedenceIsImageThenMascotThenEmoji() {
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: true, appearance: saved, emoji: "🏡"), .image)
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: false, appearance: saved, emoji: "🏡"), .mascot(saved))
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: false, appearance: nil, emoji: "🏡"), .emoji("🏡"))
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: false, appearance: nil, emoji: ""), .fallback)
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: false, appearance: nil, emoji: nil), .fallback)
        let unsupported = BotAvatarAppearance(version: 2, body: .round, eyes: .oval, colorHex: "#7C5CFF", finish: .flat, motion: .none)
        XCTAssertEqual(BotAvatarShown.resolve(hasImage: false, appearance: unsupported, emoji: "🏡"), .emoji("🏡"))
    }

    func testLegacyBotStaysUntouchedUntilTheOwnerChooses() {
        var draft = BotAvatarAppearanceDraft(baseline: nil)
        XCTAssertFalse(draft.isSelected); XCTAssertFalse(draft.isDirty)
        XCTAssertEqual(draft.patch, .unchanged)
        XCTAssertEqual(draft.working, .dexterDefault)
        draft.edit(edited)
        XCTAssertFalse(draft.isDirty, "editing the working look alone does not choose the mascot")
        draft.select()
        XCTAssertEqual(draft.selected, edited)
        XCTAssertEqual(draft.patch, .set(edited))
        draft.clear()
        XCTAssertEqual(draft.patch, .unchanged, "no recipe before, none after: the field is omitted")
        draft.select()
        XCTAssertEqual(draft.selected, edited, "turning the mascot back on restores the last edit")
        draft.reset()
        XCTAssertEqual(draft, BotAvatarAppearanceDraft(baseline: nil))
    }

    func testSavedRecipeEditsClearsAndResets() {
        var draft = BotAvatarAppearanceDraft(baseline: saved)
        XCTAssertTrue(draft.isSelected); XCTAssertFalse(draft.isDirty); XCTAssertEqual(draft.patch, .unchanged)
        draft.edit(edited)
        XCTAssertEqual(draft.patch, .set(edited))
        draft.edit(saved)
        XCTAssertFalse(draft.isDirty)
        draft.clear()
        XCTAssertEqual(draft.patch, .clear)
        draft.reset()
        XCTAssertEqual(draft.selected, saved); XCTAssertEqual(draft.working, saved); XCTAssertFalse(draft.isDirty)
    }

    func testRebaseFollowsTheHostOrKeepsAnUnsavedChoice() {
        var draft = BotAvatarAppearanceDraft(baseline: nil)
        draft.select(edited)
        // Another section saved: the identity draft stays, its baseline follows the host.
        draft.rebase(nil, keepDraft: true)
        XCTAssertEqual(draft.selected, edited); XCTAssertTrue(draft.isDirty)
        // The profile itself saved (or a reload): the host's recipe wins.
        draft.rebase(edited, keepDraft: false)
        XCTAssertEqual(draft.baseline, edited); XCTAssertEqual(draft.selected, edited); XCTAssertFalse(draft.isDirty)
        // Nothing unsaved: keeping the draft still follows the confirmed value.
        draft.rebase(saved, keepDraft: true)
        XCTAssertEqual(draft.selected, saved); XCTAssertEqual(draft.working, saved)
        draft.rebase(nil, keepDraft: false)
        XCTAssertNil(draft.selected); XCTAssertEqual(draft.patch, .unchanged)
    }

    // MARK: One CAS for image and recipe

    private func fields(uploaded: String? = nil, removes: Bool = false, hasImage: Bool, _ draft: BotAvatarAppearanceDraft) -> BotAvatarPatchPlan.Fields {
        BotAvatarPatchPlan.fields(uploadedImageID: uploaded, removesImage: removes, baselineHasImage: hasImage, appearance: draft)
    }

    func testNothingChangedSendsNothing() {
        XCTAssertEqual(fields(hasImage: false, .init(baseline: nil)), .init(image: .unchanged, appearance: .unchanged))
        XCTAssertEqual(fields(hasImage: true, .init(baseline: nil)), .init(image: .unchanged, appearance: .unchanged))
        XCTAssertEqual(fields(hasImage: false, .init(baseline: saved)), .init(image: .unchanged, appearance: .unchanged))
        // Old data holding both: untouched until the owner chooses.
        XCTAssertEqual(fields(hasImage: true, .init(baseline: saved)), .init(image: .unchanged, appearance: .unchanged))
    }

    func testChoosingTheMascotClearsTheImageInTheSameCAS() {
        var draft = BotAvatarAppearanceDraft(baseline: nil)
        draft.select(edited)
        XCTAssertEqual(fields(removes: true, hasImage: true, draft), .init(image: .clear, appearance: .set(edited)))
        // Even if a caller forgot to mark the image removed, the recipe never ships under a stored image.
        XCTAssertEqual(fields(removes: false, hasImage: true, draft), .init(image: .clear, appearance: .set(edited)))
        XCTAssertEqual(fields(removes: true, hasImage: false, draft), .init(image: .unchanged, appearance: .set(edited)))
        // Re-selecting the saved recipe over an old image only clears the image.
        var both = BotAvatarAppearanceDraft(baseline: saved)
        both.select()
        XCTAssertEqual(fields(removes: true, hasImage: true, both), .init(image: .clear, appearance: .unchanged))
    }

    func testImportingAnImageClearsTheRecipeInTheSameCAS() {
        var draft = BotAvatarAppearanceDraft(baseline: saved)
        draft.clear()
        XCTAssertEqual(fields(uploaded: "img-1", hasImage: false, draft), .init(image: .set("img-1"), appearance: .clear))
        // Defensive: an uploaded image always wins and still clears a stored recipe.
        XCTAssertEqual(fields(uploaded: "img-1", hasImage: true, .init(baseline: saved)), .init(image: .set("img-1"), appearance: .clear))
        XCTAssertEqual(fields(uploaded: "img-1", hasImage: false, .init(baseline: nil)), .init(image: .set("img-1"), appearance: .unchanged))
    }

    func testRemovingOneSideLeavesTheOther() {
        var draft = BotAvatarAppearanceDraft(baseline: saved)
        draft.clear()
        XCTAssertEqual(fields(hasImage: false, draft), .init(image: .unchanged, appearance: .clear))
        XCTAssertEqual(fields(removes: true, hasImage: true, .init(baseline: nil)), .init(image: .clear, appearance: .unchanged))
        // A removed draft image that never reached the host sends nothing.
        XCTAssertEqual(fields(removes: true, hasImage: false, .init(baseline: nil)), .init(image: .unchanged, appearance: .unchanged))
    }

    // MARK: Choice and removal never drop an image the owner kept (review P2-1)

    /// Mirrors what the profile editor does with its image flags around the draft.
    private struct Editor {
        var draft: BotAvatarAppearanceDraft
        let storedImage: Bool
        var removedStoredImage = false
        var imageDraft = false
        var imageDraftSetAside = false

        mutating func chooseMascot(_ recipe: BotAvatarAppearance? = nil) {
            let displaced = BotAvatarAppearanceDraft.displacement(hasImageDraft: imageDraft, hasStoredImage: storedImage,
                                                                  storedImageAlreadyRemoved: removedStoredImage)
            if imageDraft { imageDraftSetAside = true; imageDraft = false }
            if storedImage { removedStoredImage = true }
            draft.select(recipe, displacing: displaced)
        }
        mutating func removeMascot() {
            let restore = draft.removeMascot()
            if restore.contains(.storedImage) { removedStoredImage = false }
            if restore.contains(.imageDraft), imageDraftSetAside { imageDraft = true }
            imageDraftSetAside = false
        }
        mutating func removeImage() { imageDraft = false; removedStoredImage = true; draft.forgetDisplacedImage(); imageDraftSetAside = false }
        mutating func importImage() { imageDraft = true; removedStoredImage = false; draft.clear(); imageDraftSetAside = false }
        func plan(uploaded: String? = nil) -> BotAvatarPatchPlan.Fields {
            BotAvatarPatchPlan.fields(uploadedImageID: imageDraft ? (uploaded ?? "img-new") : nil, removesImage: removedStoredImage,
                                      baselineHasImage: storedImage, appearance: draft)
        }
    }

    func testDisplacementCountsOnlyWhatTheChoiceSetAside() {
        XCTAssertEqual(BotAvatarAppearanceDraft.displacement(hasImageDraft: false, hasStoredImage: true, storedImageAlreadyRemoved: false), [.storedImage])
        XCTAssertEqual(BotAvatarAppearanceDraft.displacement(hasImageDraft: false, hasStoredImage: true, storedImageAlreadyRemoved: true), [])
        XCTAssertEqual(BotAvatarAppearanceDraft.displacement(hasImageDraft: true, hasStoredImage: true, storedImageAlreadyRemoved: false), [.storedImage, .imageDraft])
        XCTAssertEqual(BotAvatarAppearanceDraft.displacement(hasImageDraft: true, hasStoredImage: false, storedImageAlreadyRemoved: false), [.imageDraft])
        XCTAssertEqual(BotAvatarAppearanceDraft.displacement(hasImageDraft: false, hasStoredImage: false, storedImageAlreadyRemoved: false), [])
    }

    func testMascotThenRemoveMascotKeepsTheStoredImage() {
        var editor = Editor(draft: .init(baseline: nil), storedImage: true)
        editor.chooseMascot(edited)
        XCTAssertEqual(editor.plan(), .init(image: .clear, appearance: .set(edited)), "while chosen, one CAS swaps image for mascot")
        editor.removeMascot()
        XCTAssertFalse(editor.removedStoredImage)
        XCTAssertFalse(editor.draft.isDirty)
        // Saving only a name change now sends no avatar field at all: the PNG association stays.
        XCTAssertEqual(editor.plan(), .init(image: .unchanged, appearance: .unchanged))
    }

    func testMascotThenRemoveMascotGivesBackAnUnsavedImageDraft() {
        var editor = Editor(draft: .init(baseline: saved), storedImage: true)
        editor.importImage()
        XCTAssertEqual(editor.plan(uploaded: "img-2"), .init(image: .set("img-2"), appearance: .clear))
        editor.chooseMascot()
        XCTAssertFalse(editor.imageDraft)
        XCTAssertEqual(editor.draft.displaced, [.storedImage, .imageDraft])
        XCTAssertEqual(editor.plan(), .init(image: .clear, appearance: .unchanged), "the saved recipe is reselected; only the image goes")
        editor.removeMascot()
        XCTAssertTrue(editor.imageDraft, "the imported image draft is back")
        XCTAssertFalse(editor.removedStoredImage)
        XCTAssertEqual(editor.plan(uploaded: "img-2"), .init(image: .set("img-2"), appearance: .clear))
    }

    func testAnImageTheOwnerRemovedStaysRemoved() {
        var editor = Editor(draft: .init(baseline: nil), storedImage: true)
        editor.removeImage()
        editor.chooseMascot(edited)
        XCTAssertEqual(editor.draft.displaced, [])
        editor.removeMascot()
        XCTAssertTrue(editor.removedStoredImage, "the explicit removal is the owner's intent")
        XCTAssertEqual(editor.plan(), .init(image: .clear, appearance: .unchanged))
        // "Remover imagem" while a displacement exists also turns it into an explicit decision.
        var other = Editor(draft: .init(baseline: nil), storedImage: true)
        other.chooseMascot(edited)
        other.removeImage()
        other.removeMascot()
        XCTAssertTrue(other.removedStoredImage)
    }

    func testDisplacementEndsWithEveryExplicitOrConfirmedState() {
        var draft = BotAvatarAppearanceDraft(baseline: nil)
        draft.select(edited, displacing: [.storedImage])
        draft.select(displacing: [.imageDraft])
        XCTAssertEqual(draft.displaced, [.storedImage, .imageDraft], "re-opening keeps what the first choice set aside")
        draft.clear()
        XCTAssertEqual(draft.displaced, [], "an imported image is the owner's new choice")
        draft.select(edited, displacing: [.storedImage])
        draft.reset()
        XCTAssertEqual(draft.displaced, [], "Descartar")
        draft.select(edited, displacing: [.storedImage])
        draft.rebase(nil, keepDraft: true)
        XCTAssertEqual(draft.displaced, [.storedImage], "another section saved: the unsaved choice and its memory stay")
        draft.rebase(edited, keepDraft: false)
        XCTAssertEqual(draft.displaced, [], "the profile saved or reloaded")
        draft.select(saved, displacing: [.storedImage])
        XCTAssertEqual(draft.removeMascot(), [.storedImage])
        XCTAssertEqual(draft.removeMascot(), [], "nothing is given back twice")
    }

    // MARK: r3 — memory survives another section's save; image draft survives page switches (review R2 P2-A/P2-B)

    func testSavingAnotherSectionKeepsTheChoiceOverAStoredImageWithItsSavedRecipe() {
        // PNG and recipe stored together (valid host state); the mascot choice reselects the saved recipe (not dirty).
        var editor = Editor(draft: .init(baseline: saved), storedImage: true)
        editor.chooseMascot()
        XCTAssertFalse(editor.draft.isDirty)
        XCTAssertEqual(editor.draft.displaced, [.storedImage])
        // Model or Communication saved: the profile keeps its identity draft (removed image mark) and rebases.
        editor.draft.rebase(saved, keepDraft: true)
        XCTAssertEqual(editor.draft.displaced, [.storedImage], "the memory stays with the kept image mark")
        XCTAssertEqual(editor.plan(), .init(image: .clear, appearance: .unchanged), "still chosen: Save would swap to the mascot")
        editor.removeMascot()
        XCTAssertFalse(editor.removedStoredImage)
        XCTAssertEqual(editor.draft.selected, saved, "back to the recipe that was behind the PNG")
        XCTAssertFalse(editor.draft.isDirty)
        XCTAssertEqual(editor.plan(), .init(image: .unchanged, appearance: .unchanged), "undoing the choice changes nothing stored")
        // Without the other-section save the result is the same.
        var direct = Editor(draft: .init(baseline: saved), storedImage: true)
        direct.chooseMascot(edited)
        direct.removeMascot()
        XCTAssertEqual(direct.plan(), .init(image: .unchanged, appearance: .unchanged))
    }

    func testRebaseStillFollowsTheHostWhenNothingIsHeld() {
        var draft = BotAvatarAppearanceDraft(baseline: saved)
        draft.rebase(edited, keepDraft: true)
        XCTAssertEqual(draft.selected, edited, "no change and no memory: follow the confirmed recipe")
        draft.select(displacing: [.storedImage])
        draft.rebase(saved, keepDraft: false)
        XCTAssertEqual(draft.displaced, [])
        XCTAssertEqual(draft.selected, saved)
        XCTAssertEqual(draft.removeMascot(), [])
        XCTAssertNil(draft.selected, "a plain Remover mascote without displacement removes the recipe")
    }

    func testPatchWireShapeForMascotChoice() throws {
        var draft = BotAvatarAppearanceDraft(baseline: nil)
        draft.select(edited)
        let plan = fields(removes: true, hasImage: true, draft)
        let input = PatchBotInput(expectedRevision: 7, name: "Dexter", avatarImageId: plan.image, avatarAppearance: plan.appearance)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(input)) as? [String: Any])
        XCTAssertEqual(json["expectedRevision"] as? Int, 7)
        XCTAssertTrue(json["avatarImageId"] is NSNull)
        let appearance = try XCTUnwrap(json["avatarAppearance"] as? [String: Any])
        XCTAssertEqual(appearance as NSDictionary, ["version": 1, "body": "hexagon", "eyes": "wide", "colorHex": "#FB923C",
                                                    "finish": "flat", "motion": "lively"] as NSDictionary)
        let untouched = PatchBotInput(expectedRevision: 7, name: "Dexter", avatarImageId: .unchanged,
                                      avatarAppearance: BotAvatarAppearanceDraft(baseline: nil).patch)
        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(untouched)) as? [String: Any])
        XCTAssertNil(plain["avatarAppearance"]); XCTAssertNil(plain["avatarImageId"])
    }
}
