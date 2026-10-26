import DexterHostClient
import Foundation

/// Which avatar the host's persisted fields show: image, then mascot recipe, then emoji, then the engine icon.
public enum BotAvatarShown: Equatable, Sendable {
    case image
    case mascot(BotAvatarAppearance)
    case emoji(String)
    case fallback

    public static func resolve(hasImage: Bool, appearance: BotAvatarAppearance?, emoji: String?) -> BotAvatarShown {
        if hasImage { return .image }
        if let appearance, appearance.isValid { return .mascot(appearance) }
        if let emoji, !emoji.isEmpty { return .emoji(emoji) }
        return .fallback
    }
}

/// Image state an explicit mascot choice set aside, so "Remover mascote" can put back exactly that and nothing more.
public struct BotAvatarDisplacedImage: OptionSet, Equatable, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    /// The confirmed image was visible and became marked for removal only because the mascot was chosen.
    public static let storedImage = BotAvatarDisplacedImage(rawValue: 1)
    /// An unsaved image draft (import/generation) was dropped only because the mascot was chosen.
    public static let imageDraft = BotAvatarDisplacedImage(rawValue: 2)
}

/// The owner's mascot draft against the last confirmed profile. Pure and local: presets, "Aleatório" and resets only
/// change this value; the host changes only when the profile's Save sends the CAS PATCH built by `BotAvatarPatchPlan`.
public struct BotAvatarAppearanceDraft: Equatable, Sendable {
    /// Recipe confirmed by the host (nil: none stored, including legacy bots).
    public private(set) var baseline: BotAvatarAppearance?
    /// Recipe Save will persist (nil: no mascot).
    public private(set) var selected: BotAvatarAppearance?
    /// The creator's working look; kept while the mascot is off so turning it back on restores the last edit.
    public private(set) var working: BotAvatarAppearance
    /// What the current mascot choice set aside; empty after any explicit image decision, reset or host rebase.
    public private(set) var displaced: BotAvatarDisplacedImage = []
    /// Selection before the choice that displaced an image (e.g. a saved recipe hidden behind the PNG); "Remover mascote"
    /// returns to it, so undoing the choice changes nothing that was stored.
    private var selectionBeforeDisplacement: BotAvatarAppearance?

    public init(baseline: BotAvatarAppearance?) {
        self.baseline = baseline; selected = baseline; working = baseline ?? .dexterDefault
    }

    public var isSelected: Bool { selected != nil }
    public var isDirty: Bool { selected != baseline }

    /// What choosing the mascot sets aside: a visible confirmed image the owner had not removed, and an unsaved image draft.
    /// An image the owner already removed by hand is not displaced, so removing the mascot later keeps that intent.
    public static func displacement(hasImageDraft: Bool, hasStoredImage: Bool, storedImageAlreadyRemoved: Bool) -> BotAvatarDisplacedImage {
        var displaced: BotAvatarDisplacedImage = []
        if hasStoredImage, !storedImageAlreadyRemoved { displaced.insert(.storedImage) }
        if hasImageDraft { displaced.insert(.imageDraft) }
        return displaced
    }

    /// Explicit mascot choice; the caller also drops the image draft so Save clears the image in the same CAS.
    /// `displacing` records what that choice set aside (see `displacement`).
    public mutating func select(_ recipe: BotAvatarAppearance? = nil, displacing: BotAvatarDisplacedImage = []) {
        if let recipe { working = recipe }
        if displaced.isEmpty, !displacing.isEmpty { selectionBeforeDisplacement = selected }
        if selected == nil { displaced = displacing } else { displaced.formUnion(displacing) }
        selected = working
    }

    /// "Remover mascote": no mascot, and the image state the choice set aside is returned so the caller restores it
    /// (stored image no longer marked for removal, image draft back). Nothing else is restored.
    public mutating func removeMascot() -> BotAvatarDisplacedImage {
        let restore = displaced
        selected = restore.isEmpty ? nil : selectionBeforeDisplacement
        displaced = []; selectionBeforeDisplacement = nil
        return restore
    }

    /// The owner decided about the image explicitly ("Remover imagem"); a later "Remover mascote" no longer restores it.
    public mutating func forgetDisplacedImage() { displaced = []; selectionBeforeDisplacement = nil }

    /// A creator edit. It becomes the selection when the mascot is on.
    public mutating func edit(_ recipe: BotAvatarAppearance) {
        working = recipe
        if selected != nil { selected = recipe }
    }

    /// No mascot because an image was imported or generated: the recipe is cleared in the same CAS and nothing set aside
    /// comes back (the new image is the owner's explicit choice).
    public mutating func clear() { selected = nil; displaced = []; selectionBeforeDisplacement = nil }

    /// Back to the confirmed recipe.
    public mutating func reset() {
        selected = baseline; working = baseline ?? .dexterDefault; displaced = []; selectionBeforeDisplacement = nil
    }

    /// The host confirmed a new profile. `keepDraft` keeps an unsaved choice (another section was saved): a changed recipe,
    /// or a reselected saved recipe whose choice still holds what it set aside (the parent keeps the image marks too).
    public mutating func rebase(_ confirmed: BotAvatarAppearance?, keepDraft: Bool) {
        let keeps = keepDraft && (isDirty || !displaced.isEmpty)
        baseline = confirmed
        if !keeps { selected = confirmed; working = confirmed ?? working; displaced = []; selectionBeforeDisplacement = nil }
    }

    /// Omitted when unchanged (a legacy bot without a recipe stays without the field); explicit null to remove.
    public var patch: BotAvatarAppearancePatch {
        guard isDirty else { return .unchanged }
        return selected.map(BotAvatarAppearancePatch.set) ?? .clear
    }
}

/// Avatar fields of one profile Save. Image and recipe are mutually exclusive by the owner's last explicit choice,
/// and both changes always travel in the same PATCH (one CAS revision); the host never clears either on its own.
public enum BotAvatarPatchPlan {
    public struct Fields: Equatable, Sendable {
        public let image: AvatarImageIDPatch
        public let appearance: BotAvatarAppearancePatch
    }

    /// - Parameters:
    ///   - uploadedImageID: an image draft already uploaded for this Save (import or generation).
    ///   - removesImage: the owner removed the stored image (or chose the mascot, which removes it).
    ///   - baselineHasImage: the confirmed profile has an image.
    public static func fields(uploadedImageID: String?, removesImage: Bool, baselineHasImage: Bool,
                              appearance draft: BotAvatarAppearanceDraft) -> Fields {
        if let uploadedImageID {
            // Image import: the image wins and any stored recipe is cleared in the same CAS.
            return Fields(image: .set(uploadedImageID), appearance: draft.baseline == nil ? .unchanged : .clear)
        }
        if draft.isSelected, draft.isDirty || (removesImage && baselineHasImage) {
            // Explicit mascot: the recipe is set and a stored image is cleared in the same CAS.
            return Fields(image: baselineHasImage ? .clear : .unchanged, appearance: draft.isDirty ? draft.patch : .unchanged)
        }
        return Fields(image: removesImage && baselineHasImage ? .clear : .unchanged, appearance: draft.patch)
    }
}
