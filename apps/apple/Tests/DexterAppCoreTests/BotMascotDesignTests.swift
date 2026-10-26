import CoreGraphics
import DexterHostClient
import XCTest
@testable import DexterAppCore

final class BotMascotDesignTests: XCTestCase {
    private struct SplitMix64: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    func testClosedOptionTokensMatchTheCanonicalRecipe() {
        XCTAssertEqual(BotAvatarAppearance.Body.allCases.map(\.rawValue), ["round", "bean", "square", "capsule", "triangle", "hexagon", "cloud", "drop"])
        XCTAssertEqual(BotAvatarAppearance.Eyes.allCases.map(\.rawValue), ["oval", "tall", "sleepy", "tiny", "dots", "focused", "glance", "wide"])
        XCTAssertEqual(BotAvatarAppearance.Finish.allCases.map(\.rawValue), ["flat", "glass"])
        XCTAssertEqual(BotAvatarAppearance.Motion.allCases.map(\.rawValue), ["none", "subtle", "lively"])
        XCTAssertTrue(BotAvatarAppearance.dexterDefault.isValid)
        XCTAssertEqual(BotAvatarAppearance.dexterDefault.version, 1)
    }

    func testEveryOptionHasDistinctNamesInBothLanguages() {
        func check(_ labels: [(String, String)]) {
            for (pt, en) in labels { XCTAssertFalse(pt.isEmpty); XCTAssertFalse(en.isEmpty) }
            XCTAssertEqual(Set(labels.map(\.0)).count, labels.count)
            XCTAssertEqual(Set(labels.map(\.1)).count, labels.count)
        }
        check(BotAvatarAppearance.Body.allCases.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotAvatarAppearance.Eyes.allCases.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotAvatarAppearance.Finish.allCases.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotAvatarAppearance.Motion.allCases.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotMascotPalette.swatches.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotMascotPreset.all.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
        check(BotMascotActivity.allCases.map { ($0.label(portuguese: true), $0.label(portuguese: false)) })
    }

    func testColorParsingIsStrictAndCanonical() {
        XCTAssertEqual(BotMascotColor(hex: "#7c5cff")?.hex, "#7C5CFF")
        XCTAssertEqual(BotMascotColor(hex: "#00FF0a"), BotMascotColor(red: 0, green: 255, blue: 10))
        for invalid in ["", "#", "7C5CFF", "#7C5CF", "#7C5CFF0", " #7C5CFF", "#7C5CFG", "#７C5CFF", "#-12345"] {
            XCTAssertNil(BotMascotColor(hex: invalid), invalid)
        }
        XCTAssertEqual(BotMascotColor(unitRed: 1.4, green: -1, blue: .nan).hex, "#FF0000")
        XCTAssertEqual(BotMascotColor(unitRed: 0.5, green: 0.25, blue: 0.75).hex, "#8040BF")
        for value in stride(from: 0, through: 255, by: 17) {
            let color = BotMascotColor(red: UInt8(value), green: UInt8(255 - value), blue: UInt8(value / 2))
            XCTAssertEqual(BotMascotColor(hex: color.hex), color)
        }
    }

    func testDtoCanonicalizesEditedColors() {
        let edited = BotAvatarAppearance.dexterDefault.with(colorHex: "#a3e635")
        XCTAssertEqual(edited.colorHex, "#A3E635")
        XCTAssertTrue(edited.isValid)
        XCTAssertEqual(edited.motion, BotAvatarAppearance.dexterDefault.motion)
    }

    func testEyesAlwaysHaveReadableInk() {
        for swatch in BotMascotPalette.swatches {
            let color = BotMascotColor(hex: swatch.hex)!
            XCTAssertGreaterThanOrEqual(color.contrastRatio(with: color.ink), 3.6, swatch.id)
        }
        for r in stride(from: 0, through: 255, by: 15) {
            for g in stride(from: 0, through: 255, by: 15) {
                for b in stride(from: 0, through: 255, by: 15) {
                    let color = BotMascotColor(red: UInt8(r), green: UInt8(g), blue: UInt8(b))
                    XCTAssertGreaterThanOrEqual(color.contrastRatio(with: color.ink), 3.6, color.hex)
                }
            }
        }
    }

    func testEdgeOnlyWhereTheOutlineWouldDisappear() {
        let cloud = BotMascotColor(hex: "#E5E7EB")!, white = BotMascotColor.white, black = BotMascotColor(hex: "#101014")!
        XCTAssertTrue(cloud.needsEdge(darkAppearance: false))
        XCTAssertFalse(cloud.needsEdge(darkAppearance: true))
        XCTAssertTrue(white.needsEdge(darkAppearance: false))
        XCTAssertTrue(black.needsEdge(darkAppearance: true))
        XCTAssertFalse(black.needsEdge(darkAppearance: false))
        XCTAssertFalse(BotMascotColor(hex: "#7C5CFF")!.needsEdge(darkAppearance: false))
        XCTAssertFalse(BotMascotColor(hex: "#7C5CFF")!.needsEdge(darkAppearance: true))
        // Increased contrast asks for edges more often, never less.
        for swatch in BotMascotPalette.swatches {
            let color = BotMascotColor(hex: swatch.hex)!
            for dark in [false, true] where color.needsEdge(darkAppearance: dark) {
                XCTAssertTrue(color.needsEdge(darkAppearance: dark, increasedContrast: true))
            }
        }
    }

    func testPaletteAndPresetsAreCanonicalAndKeepMotion() {
        XCTAssertEqual(BotMascotPalette.swatches.count, 12)
        XCTAssertEqual(Set(BotMascotPalette.swatches.map(\.id)).count, 12)
        XCTAssertEqual(Set(BotMascotPalette.swatches.map(\.hex)).count, 12)
        for swatch in BotMascotPalette.swatches {
            XCTAssertEqual(BotMascotColor(hex: swatch.hex)?.hex, swatch.hex)
            XCTAssertEqual(BotMascotPalette.swatch(hex: swatch.hex.lowercased())?.id, swatch.id)
        }
        XCTAssertNil(BotMascotPalette.swatch(hex: "#123456"))
        XCTAssertEqual(Set(BotMascotPreset.all.map(\.id)).count, BotMascotPreset.all.count)
        let lively = BotAvatarAppearance.dexterDefault.with(motion: .lively)
        for preset in BotMascotPreset.all {
            let applied = preset.applied(to: lively)
            XCTAssertTrue(applied.isValid, preset.id)
            XCTAssertEqual(applied.motion, .lively, preset.id)
            XCTAssertTrue(preset.matches(applied))
            XCTAssertTrue(preset.matches(applied.with(motion: .none)))
            XCTAssertNotNil(BotMascotPalette.swatch(hex: preset.colorHex), preset.id)
        }
        XCTAssertTrue(BotMascotPreset.all[0].matches(.dexterDefault))
    }

    func testRandomAlwaysChangesTheLookAndKeepsMotion() {
        var generator = SplitMix64(state: 42)
        var current = BotAvatarAppearance.dexterDefault.with(motion: .none)
        var bodies = Set<BotAvatarAppearance.Body>(), eyes = Set<BotAvatarAppearance.Eyes>()
        for _ in 0..<400 {
            let next = BotMascotRandomizer.next(after: current, using: &generator)
            XCTAssertTrue(next.isValid)
            XCTAssertTrue(next.body != current.body || next.colorHex != current.colorHex)
            XCTAssertEqual(next.motion, .none)
            XCTAssertNotNil(BotMascotPalette.swatch(hex: next.colorHex))
            bodies.insert(next.body); eyes.insert(next.eyes)
            current = next
        }
        XCTAssertEqual(bodies.count, 8)
        XCTAssertEqual(eyes.count, 8)
        // Same seed, same sequence (deterministic for tests and reproducible bug reports).
        var a = SplitMix64(state: 7), b = SplitMix64(state: 7)
        XCTAssertEqual(BotMascotRandomizer.next(after: .dexterDefault, using: &a), BotMascotRandomizer.next(after: .dexterDefault, using: &b))
    }

    func testAccessibilityDescriptionNamesTheLook() {
        let recipe = BotAvatarAppearance(body: .hexagon, eyes: .sleepy, colorHex: "#38BDF8", finish: .flat, motion: .subtle)
        XCTAssertEqual(recipe.accessibilityDescription(portuguese: true), "Mascote: corpo Hexágono, olhos Sonolentos, cor Céu, acabamento Liso")
        XCTAssertEqual(recipe.accessibilityDescription(portuguese: false), "Mascot: Hexagon body, Sleepy eyes, Sky color, Flat finish")
        XCTAssertTrue(recipe.with(colorHex: "#123456").accessibilityDescription(portuguese: false).contains("#123456"))
    }

    // MARK: Geometry

    func testEyesAreSymmetricPixelAlignedAndReadableAtEverySize() {
        let sides: [Double] = [16, 18, 20, 22, 24, 28, 30, 32, 36, 40, 44, 56, 64, 84, 96, 128, 160]
        for scale in [1.0, 2.0, 3.0] {
            for side in sides {
                let snappedSide = (side * scale).rounded() / scale
                for body in BotAvatarAppearance.Body.allCases {
                    for eyes in BotAvatarAppearance.Eyes.allCases {
                        let recipe = BotAvatarAppearance(body: body, eyes: eyes, colorHex: "#7C5CFF", finish: .flat, motion: .none)
                        let layout = BotMascotGeometry.eyes(appearance: recipe, pose: .still(.idle), side: side, scale: scale)
                        let context = "\(body.rawValue)/\(eyes.rawValue) \(side)@\(scale)x"
                        XCTAssertEqual(layout.left.size, layout.right.size, context)
                        XCTAssertEqual(layout.left.minY, layout.right.minY, context)
                        for value in [layout.left.minX, layout.left.minY, layout.left.width, layout.left.height, layout.right.minX] {
                            XCTAssertEqual(Double(value) * scale, (Double(value) * scale).rounded(), accuracy: 1e-6, context)
                        }
                        XCTAssertGreaterThanOrEqual(Double(layout.left.width) * scale, 1.999, context)
                        XCTAssertGreaterThanOrEqual(Double(layout.left.height) * scale, 1.999, context)
                        // A gap of at least one device pixel between the eyes, both inside the canvas.
                        XCTAssertGreaterThanOrEqual(Double(layout.right.minX - layout.left.maxX) * scale, 0.999, context)
                        XCTAssertGreaterThanOrEqual(layout.left.minX, 0, context)
                        XCTAssertLessThanOrEqual(Double(layout.right.maxX), snappedSide, context)
                        XCTAssertGreaterThan(Double(layout.left.minY), snappedSide * 0.2, context)
                        XCTAssertLessThan(Double(layout.left.maxY), snappedSide * 0.85, context)
                        if eyes != .glance {
                            // Centered on the canvas within one device pixel.
                            XCTAssertEqual(Double(layout.left.minX + layout.right.maxX), snappedSide, accuracy: 1 / scale + 1e-6, context)
                        } else {
                            XCTAssertGreaterThan(Double(layout.left.minX + layout.right.maxX), snappedSide, context)
                        }
                    }
                }
            }
        }
    }

    func testBlinkKeepsAPixelLineAndHappyEyesAreStrokes() throws {
        var closed = BotMascotPose.still(.idle)
        closed.eyeOpen = 0
        let layout = BotMascotGeometry.eyes(appearance: .dexterDefault, pose: closed, side: 44, scale: 2)
        XCTAssertEqual(layout.left.height, 0.5, accuracy: 0.001, "one device pixel at 2x")
        XCTAssertNil(layout.leftCatchlight)
        let happy = BotMascotGeometry.eyes(appearance: .dexterDefault, pose: .still(.finished), side: 44, scale: 2)
        XCTAssertEqual(happy.shape, .arc)
        XCTAssertGreaterThanOrEqual(happy.strokeWidth, 0.75)
        let worried = BotMascotGeometry.eyes(appearance: .dexterDefault, pose: .still(.error), side: 44, scale: 2)
        let brows = try XCTUnwrap(worried.brows)
        XCTAssertLessThan(brows.left.1.y, brows.left.0.y, "inner end of the left brow is higher")
        XCTAssertLessThan(brows.right.0.y, brows.right.1.y, "inner end of the right brow is higher")
        XCTAssertEqual(brows.left.0.y, brows.right.1.y)
        XCTAssertNil(worried.leftCatchlight)
        XCTAssertNil(BotMascotGeometry.eyes(appearance: .dexterDefault, pose: .still(.error), side: 24, scale: 2).brows)
        // Dark eyes on the default violet; white eyes on dark bodies.
        XCTAssertEqual(BotAvatarAppearance.dexterDefault.color.ink, .darkInk)
        XCTAssertEqual(BotMascotColor(hex: "#4B5563")!.ink, .white)
        XCTAssertEqual(BotMascotColor(hex: "#1F2937")!.ink, .white)
        // Catchlights only where they can be seen.
        XCTAssertNotNil(BotMascotGeometry.eyes(appearance: .dexterDefault, pose: .still(.idle), side: 128, scale: 2).leftCatchlight)
        XCTAssertNil(BotMascotGeometry.eyes(appearance: .dexterDefault, pose: .still(.idle), side: 24, scale: 2).leftCatchlight)
    }
}
